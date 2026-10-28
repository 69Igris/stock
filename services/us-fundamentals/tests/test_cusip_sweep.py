"""``{"mode": "cusip-sweep"}`` — the weekly retry that never ran. MONEY-979 T17.

``cusip_map_logic``'s docstring says an UNRESOLVED row "is retried weekly" and
``cusip_map.resolve_cusips`` returns "everything the sweep learned". There was no
sweep. A row was written once by whichever 13F parse first met the CUSIP,
``attempts`` counted to one forever, and every 13F holding of that issuer stayed
symbol-less — a state the schema was designed to make recoverable and nothing
recovered from.

## The two properties that decide whether a rotation actually rotates

**ASCENDING on ``lastTriedAt``.** ``desc`` on a growing population is not
"newest first, oldest later" — it is "oldest NEVER". Every 13F parsed tonight
adds UNRESOLVED rows that push the existing ones further down, so a
newest-first sweep re-visits the same head every night while the tail is never
reached. That is MONEY-1255 exactly: 36,001 documents and roughly two years to
drain at the observed rate, with no error and no alert.

**Every VISITED row is stamped, not every RESOLVED one.** If only the winners
got a fresh ``lastTriedAt``, the losers would keep the oldest timestamp in the
table, be selected again next run, and be selected again every run after that —
a sweep permanently chewing on the same 500 failures while the rest of the table
is never reached. Identical to a healthy sweep in every metric except coverage.

Both are asserted against the REAL query and the REAL resolver rather than a
re-declared copy: ``CusipSources.unresolved`` runs against a collection fake that
records the sort it was handed, and the stamping test drives ``sweep_unresolved``
straight through ``resolve_cusips`` and ``plan_writes``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from app.detect_logic import (
    CUSIP_SWEEP_BATCH,
    CUSIP_SWEEP_MAX_BATCH,
    SKIP_WRITE_DISARMED,
    sweep_batch_size,
)
from app.jobs import detect
from app.jobs.detect import MODE_CUSIP_SWEEP, handle
from app.parsers import cusip_map
from app.parsers.cusip_map import UNRESOLVED_SORT, CusipSources, NullCusipSources, sweep_unresolved
from app.parsers.cusip_map_logic import UNRESOLVED

APPLE = "037833100"
BERKSHIRE_B = "084670702"
EXPION = "30218B209"
NOW = datetime(2026, 8, 29, tzinfo=UTC)
LONG_AGO = datetime(2026, 1, 1, tzinfo=UTC)


# ── Fakes ───────────────────────────────────────────────────────────────────


class RecordingCursor:
    """Records the sort spec and the limit the real query asked for."""

    def __init__(self, rows: list[dict[str, Any]], calls: dict[str, Any]) -> None:
        self._rows = rows
        self._calls = calls

    def sort(self, spec: Any) -> RecordingCursor:
        self._calls["sort"] = spec
        # A real cursor sorts; so does this one, so the ORDER the caller
        # receives is the order the spec asks for rather than insertion order.
        for field, direction in reversed(list(spec)):
            self._rows.sort(
                key=lambda row: (row.get(field) is not None, row.get(field)),
                reverse=direction < 0,
            )
        return self

    def limit(self, count: int) -> RecordingCursor:
        self._calls["limit"] = count
        self._rows = self._rows[:count]
        return self

    def __iter__(self) -> Any:
        return iter(self._rows)


class RecordingCollection:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []
        self.calls: dict[str, Any] = {}

    def find(self, query: dict[str, Any], projection: dict[str, Any]) -> RecordingCursor:
        self.calls["query"] = query
        self.calls["projection"] = projection
        return RecordingCursor(list(self.rows), self.calls)


class FakeDb:
    def __init__(self, collections: dict[str, RecordingCollection]) -> None:
        self._collections = collections

    def __getitem__(self, name: str) -> RecordingCollection:
        return self._collections.setdefault(name, RecordingCollection())


class FakeSources:
    """The sweep's DB seam. Records the population it was asked for."""

    def __init__(
        self,
        unresolved_rows: list[str] | None = None,
        subjects: dict[str, dict[str, Any]] | None = None,
        by_cik: dict[str, list[dict[str, Any]]] | None = None,
        existing: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self._unresolved = unresolved_rows or []
        self._subjects = subjects or {}
        self._by_cik = by_cik or {}
        self._existing = existing or {}
        self.limits: list[int] = []

    def unresolved(self, limit: int) -> list[str]:
        self.limits.append(limit)
        return list(self._unresolved[:limit])

    def subject_ciks(self, cusips: Any) -> dict[str, dict[str, Any]]:
        return {c: self._subjects[c] for c in cusips if c in self._subjects}

    def figis(self, cusips: Any) -> dict[str, str]:
        return {}

    def instruments_by_cik(self, ciks: Any) -> dict[str, list[dict[str, Any]]]:
        return {c: self._by_cik[c] for c in ciks if c in self._by_cik}

    def instruments_by_figi(self, figis: Any) -> dict[str, dict[str, Any]]:
        return {}

    def instruments_by_symbol(self, symbols: Any) -> dict[str, dict[str, Any]]:
        return {}

    def existing(self, cusips: Any) -> dict[str, dict[str, Any]]:
        return {c: self._existing[c] for c in cusips if c in self._existing}


class FakeOpenFigi:
    def __init__(self, matches: dict[str, dict[str, Any]] | None = None) -> None:
        self.matches = matches or {}
        self.asked: list[list[str]] = []
        self.closed = False

    def map_cusips(self, cusips: Any) -> dict[str, dict[str, Any]]:
        self.asked.append(list(cusips))
        return {c: self.matches[c] for c in cusips if c in self.matches}

    def close(self) -> None:
        self.closed = True


class RecordingWriter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[dict[str, Any]], tuple[str, ...]]] = []

    def upsert_rows(self, collection: str, rows: Any, *, key: Any) -> int:
        materialised = [dict(row) for row in rows]
        self.calls.append((collection, materialised, tuple(key)))
        return len(materialised)

    @property
    def rows(self) -> list[dict[str, Any]]:
        return [row for _, rows, _ in self.calls for row in rows]


class FakeStore:
    """Only the cursor half of the FilingStore protocol is reached by this mode."""

    def __init__(self) -> None:
        self.cursor_writes: list[tuple[str, Any, dict[str, Any] | None]] = []

    def claim_filing(self, document: dict[str, Any]) -> bool:
        raise AssertionError("the CUSIP sweep must never claim a filing")

    def mark_publish_failed(self, accession: str, error: str) -> None:
        raise AssertionError("the CUSIP sweep must never publish")

    def known_accessions(self, accessions: Any) -> set[str]:
        return set()

    def accessions_filed_between(self, start: Any, end: Any) -> list[str]:
        raise AssertionError("the CUSIP sweep must never read the filing window")

    def mark_withdrawn(self, accessions: Any, *, now: datetime) -> int:
        raise AssertionError("the CUSIP sweep must never mark a filing withdrawn")

    def read_cursor(self, key: str) -> dict[str, Any] | None:
        return None

    def write_cursor(self, key, *, cursor, last_run_at, meta=None) -> None:
        self.cursor_writes.append((key, cursor, meta))


class FakeSecClient:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.closed = False

    def get(self, url: str, *, timeout: float | None = None) -> bytes:
        self.calls.append(url)
        raise AssertionError(f"the CUSIP sweep reached sec.gov: {url}")

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def armed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "on")
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "true")


@pytest.fixture
def disarmed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "on")
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "false")


#: Distinguishes "the caller did not say" from "the caller said None", because
#: ``None`` is a MEANINGFUL value for both injected tiers — it is the documented
#: "tier unavailable" state.
_UNSET = object()


def run_sweep(
    *,
    sources: Any,
    openfigi: Any = _UNSET,
    writer: Any = None,
    ftd_lookup: Any = _UNSET,
    store: FakeStore | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"mode": MODE_CUSIP_SWEEP}
    body.update(payload or {})
    return handle(
        body,
        store=store or FakeStore(),
        sec_client=FakeSecClient(),
        cusip_sources=sources,
        openfigi=FakeOpenFigi() if openfigi is _UNSET else openfigi,
        ftd_lookup=(lambda cusips: {}) if ftd_lookup is _UNSET else ftd_lookup,
        cusip_writer=writer,
        clock=lambda: NOW,
        monotonic=lambda: 0.0,
    )


# ── The rotation ────────────────────────────────────────────────────────────


def test_the_sort_is_ASCENDING_on_lastTriedAt() -> None:
    # Stated as a literal so that flipping the constant is a diff a reviewer
    # sees, not an inference from behaviour three files away.
    assert UNRESOLVED_SORT == (("lastTriedAt", 1), ("cusip", 1))
    field, direction = UNRESOLVED_SORT[0]
    assert direction == 1, (
        "desc on a GROWING population never reaches the oldest rows — the sweep "
        "would re-visit the same head nightly while the tail is never selected"
    )
    assert field == "lastTriedAt"


def test_the_real_query_sorts_oldest_first_and_asks_for_UNRESOLVED_positively() -> None:
    collection = RecordingCollection(
        [
            {"cusip": BERKSHIRE_B, "lastTriedAt": NOW},
            {"cusip": APPLE, "lastTriedAt": LONG_AGO},
            {"cusip": EXPION},  # never tried: the field is ABSENT, not null
        ]
    )
    sources = CusipSources(FakeDb({"us_cusip_map": collection}))

    picked = sources.unresolved(10)

    assert collection.calls["sort"] == [("lastTriedAt", 1), ("cusip", 1)]
    assert collection.calls["limit"] == 10
    # A row NOBODY has tried has no `lastTriedAt` attribute at all, and MongoDB
    # sorts a missing field FIRST ascending — which is exactly the order wanted.
    assert picked == [EXPION, APPLE, BERKSHIRE_B]


def test_the_selection_filters_POSITIVELY_on_source_not_on_a_null_symbol() -> None:
    collection = RecordingCollection([{"cusip": APPLE}])
    CusipSources(FakeDb({"us_cusip_map": collection})).unresolved(5)

    # `{"symbol": None}` is the obvious way to ask "which rows have no ticker"
    # and returns ZERO here: `to_doc()` omits null fields, so an unresolved row
    # has no `symbol` ATTRIBUTE and neither `{"symbol": None}` nor
    # `{"symbol": {"$ne": None}}` matches it (MONEY-1050 / 1234 / 1235).
    assert collection.calls["query"] == {"source": UNRESOLVED}
    assert "symbol" not in collection.calls["query"]


def test_a_nonpositive_limit_issues_no_query_at_all() -> None:
    collection = RecordingCollection([{"cusip": APPLE}])
    assert CusipSources(FakeDb({"us_cusip_map": collection})).unresolved(0) == []
    assert collection.calls == {}


def test_the_null_sources_report_an_empty_population_rather_than_raising() -> None:
    assert NullCusipSources().unresolved(500) == []


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        (None, CUSIP_SWEEP_BATCH),
        (0, CUSIP_SWEEP_BATCH),
        (-1, CUSIP_SWEEP_BATCH),
        ("250", CUSIP_SWEEP_BATCH),
        (True, CUSIP_SWEEP_BATCH),
        (250, 250),
        (10**6, CUSIP_SWEEP_MAX_BATCH),
    ],
)
def test_the_batch_size_from_a_message_is_bounded(requested: Any, expected: int) -> None:
    assert sweep_batch_size(requested) == expected


# ── Stamping ────────────────────────────────────────────────────────────────


def _three_cusip_sources() -> FakeSources:
    """APPLE resolves through SEC_13DG; the other two resolve through nothing."""
    return FakeSources(
        unresolved_rows=[APPLE, BERKSHIRE_B, EXPION],
        subjects={APPLE: {"subjectCik10": "0000320193", "subjectName": "Apple Inc."}},
        by_cik={"0000320193": [{"cik": "0000320193", "symbol": "AAPL"}]},
        existing={
            APPLE: {"cusip": APPLE, "source": UNRESOLVED, "attempts": 2},
            BERKSHIRE_B: {"cusip": BERKSHIRE_B, "source": UNRESOLVED, "attempts": 2},
            EXPION: {"cusip": EXPION, "source": UNRESOLVED, "attempts": 2},
        },
    )


def test_every_VISITED_row_is_stamped_including_the_ones_that_failed() -> None:
    writer = RecordingWriter()

    report = sweep_unresolved(
        sources=_three_cusip_sources(),
        limit=500,
        openfigi=FakeOpenFigi(),
        writer=writer,
        apply=True,
        now=NOW,
    )

    by_cusip = {row["cusip"]: row for row in writer.rows}
    assert set(by_cusip) == {APPLE, BERKSHIRE_B, EXPION}

    # The winner: resolved, and its rotation marker moved.
    assert by_cusip[APPLE]["source"] == "SEC_13DG"
    assert by_cusip[APPLE]["symbol"] == "AAPL"
    assert by_cusip[APPLE]["lastTriedAt"] == NOW

    # The LOSERS. This is the property: they are written, their marker moves,
    # and `attempts` accumulates on top of what was stored. Stamping only the
    # winner would leave these two holding the oldest `lastTriedAt` in the
    # table, re-selected by every future run, starving everything behind them.
    for cusip in (BERKSHIRE_B, EXPION):
        assert by_cusip[cusip]["source"] == UNRESOLVED
        assert by_cusip[cusip]["lastTriedAt"] == NOW
        assert by_cusip[cusip]["attempts"] == 3
        assert by_cusip[cusip]["resolvedAt"] is None

    assert report["selected"] == 3
    assert report["written"] == 3


def test_a_DISARMED_sweep_resolves_honestly_and_calls_the_writer_ZERO_times(
    disarmed: None,
) -> None:
    writer = RecordingWriter()

    result = run_sweep(sources=_three_cusip_sources(), writer=writer)

    # It did the work...
    assert result["selected"] == 3
    assert result["resolved"] == 1
    assert result["planned"] == 3
    # ...and touched nothing, under a NAMED reason.
    assert result["written"] == 0
    assert result["applied"] is False
    assert result["skippedReason"] == SKIP_WRITE_DISARMED
    assert writer.calls == []


def test_the_disarm_reason_reaches_the_JOB_OUTCOME(
    disarmed: None, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("WARNING", logger="us-fundamentals.job-outcome"):
        run_sweep(sources=_three_cusip_sources(), writer=RecordingWriter())
    outcome = [r for r in caplog.records if r.name == "us-fundamentals.job-outcome"]
    assert outcome, "the job outcome was never reported"
    assert SKIP_WRITE_DISARMED in outcome[-1].getMessage()
    assert "no reason reported" not in outcome[-1].getMessage()


def test_the_write_goes_to_the_cusip_map_on_its_own_unique_key() -> None:
    writer = RecordingWriter()
    sweep_unresolved(
        sources=_three_cusip_sources(),
        limit=500,
        openfigi=FakeOpenFigi(),
        writer=writer,
        apply=True,
        now=NOW,
    )
    collection, _rows, key = writer.calls[0]
    assert collection == cusip_map.CUSIP_COLLECTION
    assert key == cusip_map.CUSIP_KEY


def test_an_empty_population_reports_zero_and_never_touches_a_tier() -> None:
    writer = RecordingWriter()
    openfigi = FakeOpenFigi()

    report = sweep_unresolved(
        sources=FakeSources(unresolved_rows=[]),
        limit=500,
        openfigi=openfigi,
        writer=writer,
        apply=True,
        now=NOW,
    )

    assert report["selected"] == 0
    assert report["attempted"] == 0
    assert writer.calls == []
    # A tier that is never ASKED must not read as a tier that found nothing.
    assert openfigi.asked == []
    assert report["openfigi"] == "idle"


# ── The job ─────────────────────────────────────────────────────────────────


def test_the_sweep_issues_ZERO_sec_gov_requests(armed: None) -> None:
    client = FakeSecClient()
    result = handle(
        {"mode": MODE_CUSIP_SWEEP},
        store=FakeStore(),
        sec_client=client,
        cusip_sources=_three_cusip_sources(),
        openfigi=FakeOpenFigi(),
        ftd_lookup=lambda cusips: {},
        cusip_writer=RecordingWriter(),
        clock=lambda: NOW,
        monotonic=lambda: 0.0,
    )
    # This is what lets a nightly sweep sit beside a MINUTELY detect loop: the
    # shared 9 req/s fair-access allowance is untouched. `FakeSecClient.get`
    # raises, so a single request would fail the run rather than the assertion.
    assert client.calls == []
    assert result["selected"] == 3


def test_the_sweep_runs_with_NO_EDGAR_IDENTITY_because_it_needs_no_sec_client(
    armed: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Ordering proof, not a convenience: building `SecClient` requires
    # EDGAR_IDENTITY and would answer SKIP_IDENTITY_MISSING. If the sweep branch
    # were placed AFTER the client construction, an unset identity would skip a
    # job that never opens a socket.
    monkeypatch.delenv("EDGAR_IDENTITY", raising=False)
    result = handle(
        {"mode": MODE_CUSIP_SWEEP},
        store=FakeStore(),
        cusip_sources=_three_cusip_sources(),
        openfigi=FakeOpenFigi(),
        ftd_lookup=lambda cusips: {},
        cusip_writer=RecordingWriter(),
        clock=lambda: NOW,
        monotonic=lambda: 0.0,
    )
    assert result["skipped"] is False
    assert result["selected"] == 3


def test_the_per_tier_hit_counts_are_REPORTED_rather_than_assumed(armed: None) -> None:
    # TIINGO_FIGI was planned as a cheap early tier and MEASURED nearly empty:
    # the 13F `figi` column has been optional since EDGAR Release 22.4.1 and
    # Berkshire omits it on all 89 rows of its 2026 filing. A tier that resolves
    # nothing looks exactly like a tier that was never reached, so every run
    # emits the counts.
    result = run_sweep(sources=_three_cusip_sources(), writer=RecordingWriter())

    assert result["byTier"] == {
        "SEC_13DG": 1,
        "TIINGO_FIGI": 0,
        "SEC_FTD": 0,
        "OPENFIGI": 0,
    }
    assert result["hitRate"]["SEC_13DG"] == pytest.approx(1 / 3)
    assert result["attempted"] == 3
    assert result["resolved"] == 1
    assert result["unresolved"] == 2


def test_an_unprovisioned_FTD_tier_reports_unavailable_not_zero_hits(armed: None) -> None:
    # A third value, distinct from "tried and found nothing". Collapsing the two
    # would let a permanently un-provisioned tier read as a tier with poor
    # coverage forever.
    result = run_sweep(sources=_three_cusip_sources(), writer=RecordingWriter(), ftd_lookup=None)
    assert result["ftd"] == "unavailable"

    queried = run_sweep(
        sources=_three_cusip_sources(),
        writer=RecordingWriter(),
        ftd_lookup=lambda cusips: {},
    )
    assert queried["ftd"] == "queried"


def test_the_message_may_narrow_the_batch_but_never_past_the_ceiling(armed: None) -> None:
    sources = FakeSources(unresolved_rows=[APPLE, BERKSHIRE_B, EXPION])

    run_sweep(sources=sources, writer=RecordingWriter(), payload={"limit": 2})
    assert sources.limits[-1] == 2

    run_sweep(sources=sources, writer=RecordingWriter(), payload={"limit": 10**9})
    assert sources.limits[-1] == CUSIP_SWEEP_MAX_BATCH

    run_sweep(sources=sources, writer=RecordingWriter())
    assert sources.limits[-1] == CUSIP_SWEEP_BATCH


def test_the_cursor_row_records_the_rotation_for_forensics(armed: None) -> None:
    store = FakeStore()
    run_sweep(sources=_three_cusip_sources(), writer=RecordingWriter(), store=store)

    key, cursor, meta = store.cursor_writes[-1]
    assert key == detect.CURSOR_KEY_CUSIP_SWEEP
    # No position: this mode shares `us_edgar_cursor` with the Atom walk, whose
    # `lastAccession` must never be touched by a different job.
    assert cursor is None
    assert meta["selected"] == 3
    assert meta["resolved"] == 1
    assert meta["byTier"]["SEC_13DG"] == 1


def test_the_flag_off_skips_before_the_population_is_even_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "off")
    sources = _three_cusip_sources()

    result = run_sweep(sources=sources, writer=RecordingWriter())

    assert result["skipped"] is True
    assert sources.limits == []


def test_an_owned_openfigi_client_is_CLOSED_even_when_the_sweep_raises(
    armed: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The client owns an httpx connection pool. A leaked one is the leaked-timer
    # class: the process keeps a socket open and the test suite stops exiting.
    openfigi = FakeOpenFigi()
    monkeypatch.setattr(detect, "_resolve_ftd_lookup", lambda: None)
    monkeypatch.setattr("app.openfigi.OpenFigiClient", lambda *a, **k: openfigi)

    def explode(**_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("resolver blew up")

    monkeypatch.setattr(cusip_map, "sweep_unresolved", explode)

    with pytest.raises(RuntimeError):
        handle(
            {"mode": MODE_CUSIP_SWEEP},
            store=FakeStore(),
            cusip_sources=_three_cusip_sources(),
            cusip_writer=RecordingWriter(),
            clock=lambda: NOW,
            monotonic=lambda: 0.0,
        )
    assert openfigi.closed is True
