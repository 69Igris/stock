"""``{"mode": "full-index"}`` — the weekly reconcile that can set WITHDRAWN. MONEY-979 T17.

Two files in this service state, in prose, that DAILY index files are never
corrected and that a post-acceptance deletion reaches only SEC's Saturday
full-index rebuild (``edgar_adapter.parse_daily_index``,
``adapter_types.DailyIndexRow``). Nothing read that rebuild, so
``us_filings.status`` declared a ``WITHDRAWN`` value that no code path could
set. These tests drive the reader.

## What they are actually guarding

**The direction of the diff.** Two subtractions over the same two sets mean
opposite things, and swapping them is a one-character edit that produces
plausible-looking output:

    stored - index    a filing WE hold that the rebuild dropped  -> WITHDRAWAL
    index - stored    a filing the rebuild lists that we lack    -> DETECTION GAP

Marking a detection gap withdrawn is unrecoverable in practice: the accession is
already in ``us_filings``, so the detector's insert-is-the-claim protocol will
never re-detect it. Every assertion about one is paired with an assertion about
the other, so an inversion cannot pass half the suite.

**That an incomplete read never produces a verdict.** A truncated fetch, a spent
budget or a capped quarter list makes every unvisited stored accession look
absent. Each of those is asserted to write ZERO rows rather than to write a
plausible-looking wrong number.

## The fixture

``form_20220214.idx.gz`` is a DAILY index (19,412 rows, 11,870 accessions, 198
of them back-dated as far as 2021-05-21). The quarterly file has the same
columns and the same ``-----`` rule line under a different preamble, so the
quarterly header used here is CONSTRUCTED rather than captured — nothing new is
fetched from SEC, and the reuse of ``parse_daily_index`` is asserted against the
real bytes rather than assumed.
"""

from __future__ import annotations

import gzip
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app import detect_logic as logic
from app.detect_logic import (
    FULL_INDEX_MAX_WINDOW_DAYS,
    FULL_INDEX_SETTLE_DAYS,
    FULL_INDEX_WINDOW_DAYS,
    SKIP_WRITE_DISARMED,
    STOP_EVIDENCE_INCOMPLETE,
    STOP_WITHDRAWAL_SHARE_IMPLAUSIBLE,
    Quarter,
    coerce_positive_int,
    full_index_window,
    plan_full_index_reconcile,
    quarter_of,
    quarters_between,
    withdrawal_is_plausible,
)
from app.jobs import detect
from app.jobs.detect import (
    MODE_FULL_INDEX,
    SKIP_FLAG_OFF,
    SKIP_UNKNOWN_MODE,
    STOP_TRANSPORT_ERROR,
    MongoFilingStore,
    handle,
)
from app.sec.adapter_types import DailyIndexRow
from app.sec.edgar_adapter import parse_daily_index
from app.sec.errors import SecTransportError
from app.store.models import STATUS_NO_PARSER, STATUS_WITHDRAWN
from app.store.outcome import JOB_METRIC_SELECTED, JOB_METRIC_WRITTEN

FIXTURES = Path(__file__).parent / "fixtures"

#: 2022-02-20 07:00 ET. Window = [2022-02-04, 2022-02-17] with the 3-day settle,
#: which contains the captured index's 2022-02-14 rows and sits inside 2022Q1.
NOW = datetime(2022, 2, 20, 12, 0, tzinfo=UTC)
WINDOW_DAY = date(2022, 2, 14)


# ── Building an index body ──────────────────────────────────────────────────

#: The quarterly preamble. Differs from the daily one only in two prose lines;
#: `parse_daily_index` skips both because it keys on the `---` rule line and not
#: on a line count.
QUARTER_HEADER = "\n".join(
    [
        "Description:           Master Index of EDGAR Dissemination Feed by Form Type",
        "Last Data Received:    March 31, 2022",
        "Comments:              webmaster@sec.gov",
        "Anonymous FTP:         ftp://ftp.sec.gov/edgar/",
        " ",
        " ",
        "Form Type   Company Name                                                  CIK",
        "      Date Filed  File Name",
        "-" * 141,
    ]
)


def index_row(accession: str, filed: date, *, form: str = "8-K", cik: str = "1140586") -> str:
    return (
        f"{form:<12}{'ACME CORP':<62}{cik:<12}"
        f"{filed.strftime('%Y%m%d')}    edgar/data/{int(cik)}/{accession}.txt"
    )


def index_body(rows: list[tuple[str, date]]) -> bytes:
    lines = [QUARTER_HEADER]
    lines.extend(index_row(accession, filed) for accession, filed in rows)
    return ("\n".join(lines) + "\n").encode()


def daily_fixture_text() -> str:
    return gzip.decompress((FIXTURES / "form_20220214.idx.gz").read_bytes()).decode(
        "utf-8", "replace"
    )


# ── Fakes ───────────────────────────────────────────────────────────────────


class FakeSecClient:
    """Serves one body per URL and records every request."""

    def __init__(self, bodies: dict[str, Any]) -> None:
        self._bodies = bodies
        self.calls: list[str] = []
        self.closed = False

    def get(self, url: str, *, timeout: float | None = None) -> bytes:
        self.calls.append(url)
        body = self._bodies.get(url, b"")
        if isinstance(body, Exception):
            raise body
        return body

    def close(self) -> None:
        self.closed = True


class FakeStore:
    """``us_filings`` + ``us_edgar_cursor``, with the two new reconcile methods."""

    def __init__(self, filings: dict[str, date] | None = None) -> None:
        #: accession -> filedAt for rows NOT already withdrawn.
        self.filings: dict[str, date] = dict(filings or {})
        self.withdrawn: list[str] = []
        self.withdraw_calls: list[list[str]] = []
        self.window_queries: list[tuple[date, date]] = []
        self.cursors: dict[str, dict[str, Any]] = {}
        self.cursor_writes: list[tuple[str, Any, dict[str, Any] | None]] = []

    # -- reconcile seam --
    def accessions_filed_between(self, start: date, end: date) -> list[str]:
        self.window_queries.append((start, end))
        return sorted(a for a, filed in self.filings.items() if start <= filed <= end)

    def mark_withdrawn(self, accessions: Any, *, now: datetime) -> int:
        batch = [a for a in accessions if a]
        self.withdraw_calls.append(list(batch))
        self.withdrawn.extend(batch)
        return len(batch)

    # -- the rest of the protocol, unused by this mode --
    def claim_filing(self, document: dict[str, Any]) -> bool:
        raise AssertionError("the full-index reconcile must never claim a filing")

    def mark_publish_failed(self, accession: str, error: str) -> None:
        raise AssertionError("the full-index reconcile must never publish")

    def known_accessions(self, accessions: Any) -> set[str]:
        return set()

    def read_cursor(self, key: str) -> dict[str, Any] | None:
        return self.cursors.get(key)

    def write_cursor(self, key, *, cursor, last_run_at, meta=None) -> None:
        self.cursor_writes.append((key, cursor, meta))
        self.cursors.setdefault(key, {"key": key})["meta"] = meta


def run_full_index(
    *,
    store: FakeStore,
    client: FakeSecClient,
    payload: dict[str, Any] | None = None,
    now: datetime = NOW,
    budget_seconds: float = 420.0,
) -> dict[str, Any]:
    body = {"mode": MODE_FULL_INDEX}
    body.update(payload or {})
    return handle(
        body,
        store=store,
        sec_client=client,
        clock=lambda: now,
        monotonic=lambda: 0.0,
        budget_seconds=budget_seconds,
    )


@pytest.fixture
def armed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "on")
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "true")


@pytest.fixture
def disarmed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "on")
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "false")


# ── Quarter arithmetic ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("day", "expected"),
    [
        (date(2026, 1, 1), Quarter(2026, 1)),
        (date(2026, 3, 31), Quarter(2026, 1)),
        (date(2026, 4, 1), Quarter(2026, 2)),
        (date(2026, 9, 30), Quarter(2026, 3)),
        (date(2026, 10, 1), Quarter(2026, 4)),
        (date(2026, 12, 31), Quarter(2026, 4)),
    ],
)
def test_quarter_of_puts_every_boundary_day_in_the_right_quarter(
    day: date, expected: Quarter
) -> None:
    assert quarter_of(day) == expected


def test_a_quarter_knows_its_own_span_and_its_url() -> None:
    q = Quarter(2022, 1)
    assert q.start == date(2022, 1, 1)
    assert q.end == date(2022, 3, 31)
    assert q.label == "2022Q1"
    assert q.url == "https://www.sec.gov/Archives/edgar/full-index/2022/QTR1/form.idx"
    # The year rolls over on Q4, which is the one arithmetic that cannot be
    # derived from the month number alone.
    assert Quarter(2022, 4).following == Quarter(2023, 1)
    assert Quarter(2022, 4).end == date(2022, 12, 31)


def test_a_quarter_outside_one_to_four_is_refused_rather_than_stored() -> None:
    with pytest.raises(ValueError):
        Quarter(2026, 5)


def test_quarters_run_FORWARD_from_the_window_because_dissemination_is_never_early() -> None:
    # A filing dated inside the window can be disseminated in the window's own
    # quarter or in any LATER one — 198 rows of the captured daily index are
    # back-dated, the oldest by nine months. Checking only the window's quarter
    # is exactly how a late dissemination gets marked withdrawn.
    quarters, truncated = quarters_between(date(2021, 5, 21), date(2022, 2, 14), cap=8)
    assert [q.label for q in quarters] == [
        "2021Q2",
        "2021Q3",
        "2021Q4",
        "2022Q1",
    ]
    assert truncated is False


def test_the_quarter_cap_REPORTS_truncation_rather_than_silently_shortening() -> None:
    quarters, truncated = quarters_between(date(2021, 5, 21), date(2026, 8, 29), cap=4)
    assert len(quarters) == 4
    # The caller refuses to mark anything when this is True. A cap that returned
    # a short list with no flag would make every un-checked quarter's filings
    # look absent.
    assert truncated is True


def test_a_single_quarter_window_fetches_exactly_one_file() -> None:
    quarters, truncated = quarters_between(date(2022, 2, 4), date(2022, 2, 20))
    assert [q.label for q in quarters] == ["2022Q1"]
    assert truncated is False


# ── The window ──────────────────────────────────────────────────────────────


def test_the_window_is_EASTERN_and_ends_a_settle_period_before_now() -> None:
    start, end = full_index_window(NOW)
    assert (
        end
        == date(2022, 2, 17)
        == logic.to_eastern(NOW).date() - timedelta(days=FULL_INDEX_SETTLE_DAYS)
    )
    assert start == end - timedelta(days=FULL_INDEX_WINDOW_DAYS - 1)


def test_the_window_uses_the_EASTERN_day_not_the_UTC_one() -> None:
    # 02:00 UTC is the previous Eastern day. A UTC-derived window would judge a
    # day EDGAR has not finished, every night, with no error.
    at_two_utc = datetime(2022, 2, 20, 2, 0, tzinfo=UTC)
    _, end = full_index_window(at_two_utc, settle_days=0)
    assert end == date(2022, 2, 19)


def test_an_endDate_may_look_BACK_but_is_clamped_to_the_settle_boundary() -> None:
    # Looking further back is legitimate — a historical reconcile.
    start, end = full_index_window(NOW, end_date=date(2022, 1, 31))
    assert end == date(2022, 1, 31)
    assert start == date(2022, 1, 18)

    # Asking to judge filings that have not settled is not. Without the clamp,
    # `{"endDate": "<today>"}` would ask this job to mark everything accepted
    # since the last weekly rebuild as withdrawn.
    _, clamped = full_index_window(NOW, end_date=date(2022, 2, 20))
    assert clamped == date(2022, 2, 17)


# ── The diff, in both directions ────────────────────────────────────────────


def test_a_filing_WE_hold_that_the_index_lacks_is_a_WITHDRAWAL() -> None:
    plan = plan_full_index_reconcile(
        index_rows=[DailyIndexRow("8-K", "ACME", "0000000001", WINDOW_DAY, "A-1", "p")],
        stored_accessions=["A-1", "GONE-1"],
        window_start=date(2022, 2, 4),
        window_end=date(2022, 2, 17),
    )
    assert plan.withdrawn == ("GONE-1",)
    assert plan.detection_gap_count == 0


def test_a_filing_THE_INDEX_lists_that_we_lack_is_a_DETECTION_GAP_and_is_NOT_withdrawn() -> None:
    plan = plan_full_index_reconcile(
        index_rows=[
            DailyIndexRow("8-K", "ACME", "0000000001", WINDOW_DAY, "A-1", "p"),
            DailyIndexRow("8-K", "ACME", "0000000001", WINDOW_DAY, "MISSED-1", "p"),
        ],
        stored_accessions=["A-1"],
        window_start=date(2022, 2, 4),
        window_end=date(2022, 2, 17),
    )
    # The whole point: the two sets are disjoint answers, not one number.
    assert plan.detection_gaps == ("MISSED-1",)
    assert plan.detection_gap_count == 1
    assert plan.withdrawn == ()


def test_presence_in_ANY_fetched_quarter_clears_a_withdrawal_even_outside_the_window() -> None:
    # The back-dated case, which is 1% of a real daily index: a filing dated
    # inside the window whose index row sits in a LATER quarter and therefore
    # carries a filed_at the window still contains. Presence is presence.
    plan = plan_full_index_reconcile(
        index_rows=[DailyIndexRow("8-K", "ACME", "0000000001", date(2021, 5, 21), "LATE-1", "p")],
        stored_accessions=["LATE-1"],
        window_start=date(2022, 2, 4),
        window_end=date(2022, 2, 17),
    )
    assert plan.withdrawn == ()
    # ...and it is NOT a gap either: its row is outside the window, so this
    # window has nothing to say about it.
    assert plan.detection_gap_count == 0
    assert plan.index_accessions_in_window == 0


def test_the_gap_LIST_is_a_sample_while_the_gap_COUNT_stays_exact() -> None:
    rows = [
        DailyIndexRow("8-K", "ACME", "0000000001", WINDOW_DAY, f"MISS-{i:03d}", "p")
        for i in range(120)
    ]
    plan = plan_full_index_reconcile(
        index_rows=rows,
        stored_accessions=[],
        window_start=date(2022, 2, 4),
        window_end=date(2022, 2, 17),
        gap_sample=10,
    )
    assert len(plan.detection_gaps) == 10
    assert plan.detection_gap_count == 120


def test_one_accession_on_many_rows_is_one_filing_not_many() -> None:
    # A form.idx carries ONE ROW PER FILER: 19,412 rows collapse to 11,870
    # accessions in the captured file, and a co-registered S-3ASR occupies
    # sixteen. Counting rows as filings would inflate every number here.
    rows = [
        DailyIndexRow("S-3ASR", "CO", f"000000000{i}", WINDOW_DAY, "SHARED-1", "p")
        for i in range(1, 6)
    ]
    plan = plan_full_index_reconcile(
        index_rows=rows,
        stored_accessions=[],
        window_start=date(2022, 2, 4),
        window_end=date(2022, 2, 17),
    )
    assert plan.index_rows_seen == 5
    assert plan.index_accessions_in_window == 1
    assert plan.detection_gap_count == 1


# ── The plausibility gate ───────────────────────────────────────────────────


def test_a_handful_of_withdrawals_is_always_plausible() -> None:
    assert withdrawal_is_plausible(1, 4) is True
    assert withdrawal_is_plausible(25, 25) is True


def test_an_implausible_SHARE_is_refused_rather_than_applied() -> None:
    # Every way this reconcile can be wrong — the wrong quarter, a truncated
    # body, a 200 with an empty index — has one symptom: nearly everything we
    # hold looks absent.
    assert withdrawal_is_plausible(5_000, 10_000) is False
    assert withdrawal_is_plausible(200, 100_000) is True


def test_the_gate_does_NOT_fail_open_on_a_missing_denominator() -> None:
    assert withdrawal_is_plausible(5_000, 0) is False


# ── Payload coercion ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, FULL_INDEX_WINDOW_DAYS),
        ("30", FULL_INDEX_WINDOW_DAYS),
        (0, FULL_INDEX_WINDOW_DAYS),
        (-5, FULL_INDEX_WINDOW_DAYS),
        (30, 30),
        (10_000, FULL_INDEX_MAX_WINDOW_DAYS),
    ],
)
def test_windowDays_from_a_message_is_bounded(value: Any, expected: int) -> None:
    assert detect.sweep_window_days(value) == expected


def test_a_boolean_is_rejected_before_int_because_True_is_an_int_in_python() -> None:
    # `{"limit": true}` would otherwise become a batch of ONE — a rotation that
    # advances one row a night and reads as perfectly healthy.
    assert coerce_positive_int(True, default=500) == 500
    assert coerce_positive_int(False, default=500) == 500


@pytest.mark.parametrize("value", [None, "", "not-a-date", "2022-13-45", 20220214])
def test_an_unparseable_endDate_is_ignored_rather_than_raising(value: Any) -> None:
    assert detect._payload_date(value) is None


def test_a_wellformed_endDate_is_read() -> None:
    assert detect._payload_date(" 2022-01-31 ") == date(2022, 1, 31)


# ── parse_daily_index is reused VERBATIM ────────────────────────────────────


def test_the_quarterly_header_parses_through_the_DAILY_parser_unchanged() -> None:
    # The reuse claim, asserted rather than assumed. The parser skips its
    # preamble on the first `---` line, not on a line count, so a quarterly file
    # differs from a daily one only in prose it already ignores.
    body = index_body([("0001683168-22-000961", WINDOW_DAY)])
    rows = parse_daily_index(body.decode())
    assert [(r.accession, r.filed_at, r.form) for r in rows] == [
        ("0001683168-22-000961", WINDOW_DAY, "8-K")
    ]


def test_chunked_parsing_yields_EXACTLY_the_rows_a_whole_file_parse_does() -> None:
    # A quarterly form.idx is ~1.2M rows and ~800MB of DailyIndexRow objects,
    # measured; the service is 2Gi at concurrency 4. So the body is walked in
    # line chunks — but only if the chunked read is the SAME read.
    text = daily_fixture_text()
    whole = parse_daily_index(text)
    chunked: list[DailyIndexRow] = []
    for chunk in detect._index_line_chunks(text.encode(), 500):
        chunked.extend(parse_daily_index(chunk))
    assert len(whole) == 19_412
    assert chunked == whole


def test_a_chunk_size_larger_than_the_file_still_yields_the_whole_file() -> None:
    text = daily_fixture_text()
    chunks = list(detect._index_line_chunks(text.encode(), 10_000_000))
    assert len(chunks) == 1
    assert len(parse_daily_index(chunks[0])) == 19_412


def test_a_nonpositive_chunk_size_raises_instead_of_looping_forever() -> None:
    with pytest.raises(ValueError):
        list(detect._index_line_chunks(b"x\n", 0))


# ── The job ─────────────────────────────────────────────────────────────────


def _one_quarter(rows: list[tuple[str, date]]) -> FakeSecClient:
    return FakeSecClient({Quarter(2022, 1).url: index_body(rows)})


def test_an_ARMED_run_marks_the_vanished_filing_WITHDRAWN(armed: None) -> None:
    store = FakeStore({"KEPT-1": WINDOW_DAY, "GONE-1": WINDOW_DAY})
    client = _one_quarter([("KEPT-1", WINDOW_DAY)])

    result = run_full_index(store=store, client=client)

    assert result["mode"] == MODE_FULL_INDEX
    assert result["withdrawn"] == 1
    assert result["written"] == 1
    assert result["applied"] is True
    assert store.withdrawn == ["GONE-1"]
    # The one filing the index still lists is untouched.
    assert "KEPT-1" not in store.withdrawn


def test_a_DETECTION_GAP_is_counted_and_never_marked(armed: None) -> None:
    store = FakeStore({"KEPT-1": WINDOW_DAY})
    client = _one_quarter([("KEPT-1", WINDOW_DAY), ("MISSED-1", WINDOW_DAY)])

    result = run_full_index(store=store, client=client)

    assert result["detectionGaps"] == 1
    assert result["detectionGapSample"] == ["MISSED-1"]
    assert result["withdrawn"] == 0
    assert result["written"] == 0
    # Nothing was marked, and nothing was published either — the fake store
    # raises on both, so reaching here is the assertion.
    assert store.withdraw_calls == []


def test_a_DISARMED_run_plans_honestly_and_calls_the_writer_ZERO_times(disarmed: None) -> None:
    store = FakeStore({"KEPT-1": WINDOW_DAY, "GONE-1": WINDOW_DAY})
    client = _one_quarter([("KEPT-1", WINDOW_DAY)])

    result = run_full_index(store=store, client=client)

    # It found the withdrawal...
    assert result["withdrawn"] == 1
    assert result["selected"] == 1
    # ...and wrote nothing, under a NAMED reason rather than as a silent zero.
    assert result["written"] == 0
    assert result["applied"] is False
    assert result["skippedReason"] == SKIP_WRITE_DISARMED
    assert store.withdraw_calls == []
    assert store.withdrawn == []


def test_the_disarm_reason_reaches_the_JOB_OUTCOME_not_only_the_response(
    disarmed: None, caplog: pytest.LogCaptureFixture
) -> None:
    # `report_job_outcome` runs in a `finally` in `handle`, so a mode function
    # that returned the reason in its dict without ALSO assigning it into
    # `handle`'s local would report `selected 1, wrote 0` with "no reason
    # reported" — which is the zero-write ALARM, weekly, for a job that is
    # working exactly as configured.
    store = FakeStore({"GONE-1": WINDOW_DAY})
    with caplog.at_level("WARNING", logger="us-fundamentals.job-outcome"):
        run_full_index(store=store, client=_one_quarter([]))
    outcome = [r for r in caplog.records if r.name == "us-fundamentals.job-outcome"]
    assert outcome, "the job outcome was never reported"
    assert SKIP_WRITE_DISARMED in outcome[-1].getMessage()
    assert "no reason reported" not in outcome[-1].getMessage()


def test_SELECTED_counts_withdrawal_candidates_not_the_window_population(
    armed: None, statsd: Any
) -> None:
    # A healthy week reads a million index rows and finds nothing withdrawn.
    # Reporting the population as `selected` would make every healthy run look
    # like "selected 1,000,000, wrote 0" — the zero-write alarm, weekly.
    store = FakeStore({f"KEPT-{i}": WINDOW_DAY for i in range(50)})
    client = _one_quarter([(f"KEPT-{i}", WINDOW_DAY) for i in range(50)])

    result = run_full_index(store=store, client=client)

    assert result["storedInWindow"] == 50
    assert result["selected"] == 0
    assert statsd.value_of(JOB_METRIC_SELECTED) == 0
    assert statsd.value_of(JOB_METRIC_WRITTEN) == 0


def test_an_IMPLAUSIBLE_share_writes_nothing_and_names_why(armed: None) -> None:
    # An empty index body is exactly what a 200 with no content looks like, and
    # it makes the whole window read as withdrawn.
    store = FakeStore({f"KEPT-{i}": WINDOW_DAY for i in range(200)})
    client = _one_quarter([])

    result = run_full_index(store=store, client=client)

    assert result["withdrawn"] == 200
    assert result["written"] == 0
    assert result["withdrawalPlausible"] is False
    assert result["stopReason"] == STOP_WITHDRAWAL_SHARE_IMPLAUSIBLE
    assert store.withdraw_calls == []


def test_a_TRUNCATED_quarter_list_refuses_the_verdict(armed: None) -> None:
    # A historical window whose quarters exceed the cap: the un-fetched quarters
    # could hold every one of these filings, so the evidence does not support a
    # verdict and the run says so instead of guessing.
    store = FakeStore({"GONE-1": date(2021, 5, 21)})
    bodies = {Quarter(2021, q).url: index_body([]) for q in (2, 3, 4)}
    bodies[Quarter(2022, 1).url] = index_body([])
    client = FakeSecClient(bodies)

    result = run_full_index(
        store=store,
        client=client,
        payload={"endDate": "2021-05-25", "windowDays": 7},
        now=datetime(2026, 8, 29, 12, 0, tzinfo=UTC),
    )

    assert result["quartersTruncated"] is True
    assert result["evidenceComplete"] is False
    assert result["stopReason"] == STOP_EVIDENCE_INCOMPLETE
    assert result["withdrawn"] == 1
    assert result["written"] == 0
    assert store.withdraw_calls == []


def test_a_SPENT_budget_refuses_the_verdict_rather_than_judging_a_partial_read(
    armed: None,
) -> None:
    store = FakeStore({"GONE-1": WINDOW_DAY})
    client = _one_quarter([])

    result = run_full_index(store=store, client=client, budget_seconds=0.0)

    assert client.calls == []
    assert result["evidenceComplete"] is False
    assert result["written"] == 0
    assert store.withdraw_calls == []


def test_a_TRANSPORT_failure_mid_fetch_writes_nothing_and_is_counted(armed: None) -> None:
    store = FakeStore({"GONE-1": WINDOW_DAY})
    client = FakeSecClient({Quarter(2022, 1).url: SecTransportError("connection reset")})

    result = run_full_index(store=store, client=client)

    assert result["stopReason"] == STOP_TRANSPORT_ERROR
    assert result["transportFailures"] == 1
    assert result["evidenceComplete"] is False
    assert result["written"] == 0
    assert store.withdraw_calls == []


def test_the_run_fetches_exactly_the_quarters_the_window_needs(armed: None) -> None:
    store = FakeStore({"KEPT-1": WINDOW_DAY})
    client = _one_quarter([("KEPT-1", WINDOW_DAY)])

    result = run_full_index(store=store, client=client)

    assert client.calls == ["https://www.sec.gov/Archives/edgar/full-index/2022/QTR1/form.idx"]
    assert result["quarters"] == ["2022Q1"]
    assert result["quartersFetched"] == 1
    assert store.window_queries == [(date(2022, 2, 4), date(2022, 2, 17))]


def test_the_cursor_row_records_the_window_and_the_two_counts(armed: None) -> None:
    store = FakeStore({"KEPT-1": WINDOW_DAY, "GONE-1": WINDOW_DAY})
    client = _one_quarter([("KEPT-1", WINDOW_DAY), ("MISSED-1", WINDOW_DAY)])

    run_full_index(store=store, client=client)

    key, cursor, meta = store.cursor_writes[-1]
    assert key == detect.CURSOR_KEY_FULL_INDEX
    # The position is NEVER written by this mode — it shares a collection with
    # the Atom walk, whose `lastAccession` must not be touched.
    assert cursor is None
    assert meta["windowStart"] == "2022-02-04"
    assert meta["quarters"] == ["2022Q1"]
    assert meta["withdrawn"] == 1
    assert meta["detectionGaps"] == 1


def test_the_flag_off_skips_before_any_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "off")
    store = FakeStore({"GONE-1": WINDOW_DAY})
    client = _one_quarter([])

    result = run_full_index(store=store, client=client)

    assert result["skipped"] is True
    assert result["skippedReason"] == SKIP_FLAG_OFF
    assert client.calls == []
    assert store.withdraw_calls == []


def test_an_unknown_mode_is_a_NAMED_skip_and_never_the_atom_walk(armed: None) -> None:
    store = FakeStore()
    client = FakeSecClient({})
    result = handle(
        {"mode": "full_index"},  # underscore, not hyphen
        store=store,
        sec_client=client,
        clock=lambda: NOW,
        monotonic=lambda: 0.0,
    )
    assert result["skipped"] is True
    assert result["skippedReason"].startswith(SKIP_UNKNOWN_MODE)
    assert client.calls == []


def test_the_real_captured_index_drives_the_job_end_to_end(armed: None) -> None:
    # Not a synthetic body: 19,412 real rows collapsing to 11,870 accessions,
    # through the real chunked reader and the real parser.
    text = daily_fixture_text()
    real = parse_daily_index(text)
    window_start, window_end = full_index_window(NOW)
    # Derived from the real rows rather than written as a constant: the file
    # carries 198 BACK-DATED rows (oldest 2021-05-21), 38 of which land inside
    # this window, so "accessions filed on 2022-02-14" and "accessions in the
    # window" are two different numbers and hard-coding either invites the
    # wrong one.
    in_window = {r.accession for r in real if window_start <= r.filed_at <= window_end}
    stored = sorted(in_window)[:100]
    store = FakeStore({accession: WINDOW_DAY for accession in stored})
    store.filings["GONE-1"] = WINDOW_DAY
    client = FakeSecClient({Quarter(2022, 1).url: text.encode()})

    result = run_full_index(store=store, client=client)

    assert result["indexRowsSeen"] == 19_412
    assert result["storedInWindow"] == 101
    assert result["indexAccessionsInWindow"] == len(in_window)
    # ONE withdrawal — the accession the index has never heard of — out of 101
    # stored rows, which is under the plausibility floor and so is applied.
    assert result["withdrawn"] == 1
    assert store.withdrawn == ["GONE-1"]
    assert result["detectionGaps"] == len(in_window) - 100


# ── The production store ────────────────────────────────────────────────────


class RecordingCollection:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []
        self.finds: list[tuple[dict[str, Any], dict[str, Any]]] = []
        self.updates: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []

    def find(self, query: dict[str, Any], projection: dict[str, Any]) -> list[dict[str, Any]]:
        self.finds.append((query, projection))
        return self.rows

    def update_many(self, query: dict[str, Any], update: dict[str, Any], **kwargs: Any) -> Any:
        self.updates.append((query, update, kwargs))
        return type("Result", (), {"modified_count": len(query["accession"]["$in"])})()


@pytest.fixture
def collection(monkeypatch: pytest.MonkeyPatch) -> RecordingCollection:
    fake = RecordingCollection()
    monkeypatch.setattr(detect.writers, "collection", lambda _db, _logical: fake)
    return fake


def test_the_window_query_uses_UTC_MIDNIGHT_bounds_and_skips_already_withdrawn_rows(
    collection: RecordingCollection,
) -> None:
    collection.rows = [{"accession": "A-1"}, {"accession": None}]
    store = MongoFilingStore(object())

    assert store.accessions_filed_between(date(2022, 2, 4), date(2022, 2, 17)) == ["A-1"]

    query, projection = collection.finds[0]
    # `filedAt` is a DATE column stored as UTC midnight by `models._coerce`; a
    # `date` object would be encoded differently by the driver.
    assert query["filedAt"] == {
        "$gte": datetime(2022, 2, 4, tzinfo=UTC),
        "$lte": datetime(2022, 2, 17, tzinfo=UTC),
    }
    # Without this, a filing stays a "fresh" withdrawal every week forever and
    # `written` reports the same rows until nobody reads the number.
    assert query["status"] == {"$ne": STATUS_WITHDRAWN}
    assert projection == {"accession": 1}


def test_a_terminal_no_parser_row_is_still_part_of_the_stored_window(
    collection: RecordingCollection,
) -> None:
    """MONEY-1303 — TERMINAL is not ABSENT, and this reconcile is where that bites.

    The weekly diff marks ``WITHDRAWN`` everything we hold that SEC's quarterly
    rebuild no longer lists. A ``NO_PARSER`` row is a filing SEC still lists —
    we simply chose not to parse it — so dropping it from the stored population
    would make the rebuild look like it had deleted every Form 144, 425 and S-1
    we ever saw, and the run would try to withdraw all of them.

    The query excludes exactly one status, by ``$ne``, rather than selecting an
    allow-list of in-flight ones. That is what makes a NEW status safe here by
    construction — narrowing it to ``{status: {"$in": [DETECTED, PARSED, …]}}``
    is the tempting change this case exists to fail.
    """
    collection.rows = [{"accession": "A-1"}]
    store = MongoFilingStore(object())
    store.accessions_filed_between(date(2022, 2, 4), date(2022, 2, 17))

    query, _ = collection.finds[0]
    assert query["status"] == {"$ne": STATUS_WITHDRAWN}
    assert STATUS_NO_PARSER != STATUS_WITHDRAWN
    # Stated as the filter's OWN semantics rather than as a second opinion about
    # them: a `$ne` on one value admits every other value, including one that
    # did not exist when the query was written.
    assert list(query["status"]) == ["$ne"], "the exclusion is no longer a single $ne"


def test_marking_withdrawn_is_CHUNKED_and_never_an_upsert(
    collection: RecordingCollection,
) -> None:
    store = MongoFilingStore(object())
    accessions = [f"A-{i:05d}" for i in range(2_500)]

    modified = store.mark_withdrawn(accessions, now=NOW)

    assert modified == 2_500
    assert [len(q["accession"]["$in"]) for q, _, _ in collection.updates] == [1000, 1000, 500]
    for query, update, kwargs in collection.updates:
        assert update == {"$set": {"status": STATUS_WITHDRAWN, "updatedAt": NOW}}
        # An upsert here would CREATE a row carrying only accession/status —
        # and form/filedAt/parseClass are REQUIRED in Prisma, so that row would
        # make every Prisma query touching it THROW rather than read as partial.
        assert "upsert" not in kwargs
        assert set(query) == {"accession"}


def test_marking_an_empty_list_issues_no_write_at_all(collection: RecordingCollection) -> None:
    assert MongoFilingStore(object()).mark_withdrawn([], now=NOW) == 0
    assert collection.updates == []
