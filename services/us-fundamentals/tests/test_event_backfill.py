"""``{"mode": "event-backfill"}`` — MONEY-1532.

The detect loop emits one ``InstrumentEvent`` per filing it CLAIMS, fail-soft,
and the claim is consumed whether or not the emit lands. So every filing claimed
while ``us-filing-events-{env}`` did not exist kept its ``us_filings`` row and
lost its event — prod ``instrument_events`` held ZERO ``SEC_EDGAR`` rows against
2,184 claims since 2026-09-22 — and no re-run of the walk re-claims anything.
This mode rebuilds the events from the rows.

Every case drives the REAL :func:`app.jobs.detect.handle` (or the real pure
window function, or the real Mongo store's query) with fakes on the seams.
"""

from __future__ import annotations

import re
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from bson import ObjectId

from app.detect_logic import (
    EVENT_BACKFILL_MAX_AGE_DAYS,
    EVENT_BACKFILL_RESUME_GRACE_DAYS,
    STOP_BUDGET_SPENT,
    STOP_PUBLISH_FAILED,
    event_backfill_window,
)
from app.events import EVENTS_TOPIC, MAX_FILINGS_PER_REQUEST, build_requests
from app.jobs.detect import (
    CLAIM_ID_SLACK,
    CURSOR_KEY_EVENT_BACKFILL,
    MODE_EVENT_BACKFILL,
    MODES,
    SKIP_BACKFILL_WINDOW,
    SKIP_FLAG_OFF,
    MongoFilingStore,
    handle,
)
from app.publish import PublishError, iso_timestamp
from app.store.outcome import JOB_METRIC_FAILED, JOB_METRIC_SELECTED, JOB_METRIC_WRITTEN

NOW = datetime(2026, 9, 23, 6, 0, tzinfo=UTC)
SINCE = "2026-09-22T00:00:00Z"
SINCE_AT = datetime(2026, 9, 22, tzinfo=UTC)


def _row(index: int, detected: datetime) -> dict[str, Any]:
    """A ``us_filings`` row AS PYMONGO RETURNS IT: every datetime NAIVE UTC."""
    naive = detected.astimezone(UTC).replace(tzinfo=None)
    return {
        "accession": f"0000320193-26-{index:06d}",
        "cik10": "0000320193",
        "form": "8-K" if index % 2 else "144",
        "items": ["2.02"] if index % 2 else [],
        "acceptedAt": naive - timedelta(seconds=40),
        "filedAt": naive.replace(hour=0, minute=0, second=0, microsecond=0),
        "detectedAt": naive,
    }


def _rows(count: int, start: datetime = SINCE_AT) -> list[dict[str, Any]]:
    return [_row(i, start + timedelta(seconds=i)) for i in range(count)]


# ── Fakes ───────────────────────────────────────────────────────────────────


class FakeStore:
    """The ``filings_detected_between`` window over an in-memory ``us_filings``.

    Every OTHER method of the protocol refuses: the backfill claims nothing,
    marks nothing and withdraws nothing, and a fake that quietly allowed it
    would hide a backfill that started writing the ledger.
    """

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.windows: list[tuple[datetime, datetime]] = []
        self.cursor_writes: list[tuple[str, Any, dict[str, Any] | None]] = []

    def filings_detected_between(self, start: datetime, end: datetime):
        self.windows.append((start, end))
        inside = [r for r in self.rows if start <= r["detectedAt"].replace(tzinfo=UTC) < end]
        return iter(sorted(inside, key=lambda r: r["detectedAt"]))

    def claim_filing(self, document: dict[str, Any]) -> bool:
        raise AssertionError("the event backfill must never claim a filing")

    def mark_publish_failed(self, accession: str, error: str) -> None:
        raise AssertionError("the event backfill must never mark a filing")

    def known_accessions(self, accessions: Any) -> set[str]:
        raise AssertionError("the event backfill must never reconcile")

    def accessions_filed_between(self, start: Any, end: Any) -> list[str]:
        raise AssertionError("the event backfill must never read the full-index window")

    def mark_withdrawn(self, accessions: Any, *, now: datetime) -> int:
        raise AssertionError("the event backfill must never mark a filing withdrawn")

    def read_cursor(self, key: str) -> dict[str, Any] | None:
        return None

    def write_cursor(self, key, *, cursor, last_run_at, meta=None) -> None:
        self.cursor_writes.append((key, cursor, meta))


class FakePublisher:
    """Records publishes; fails from the Nth call when asked to."""

    def __init__(self, fail_from: int | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._fail_from = fail_from

    def publish(self, base_topic: str, payload: dict[str, Any]) -> str:
        if self._fail_from is not None and len(self.calls) + 1 >= self._fail_from:
            raise PublishError(
                "publish to projects/p/topics/us-filing-events-prod failed: NotFound"
            )
        self.calls.append((base_topic, payload))
        return f"msg-{len(self.calls)}"

    def batches(self) -> list[list[dict[str, Any]]]:
        return [payload["filings"] for topic, payload in self.calls if topic == EVENTS_TOPIC]


class NoSecClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get(self, url: str, *, timeout: float | None = None) -> bytes:
        self.calls.append(url)
        raise AssertionError(f"the event backfill reached sec.gov: {url}")

    def close(self) -> None:
        pass


@pytest.fixture
def armed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDGAR_DETECT", "on")
    monkeypatch.setenv("PUBSUB_ENV", "prod")


def _backfill(
    store: FakeStore,
    publisher: FakePublisher,
    *,
    since: Any = SINCE,
    monotonic: Any = lambda: 0.0,
    now: datetime = NOW,
    **kwargs: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"mode": MODE_EVENT_BACKFILL}
    if since is not None:
        payload["since"] = since
    return handle(
        payload,
        store=store,
        publisher=publisher,
        clock=lambda: now,
        monotonic=monotonic,
        **kwargs,
    )


# ── The window (pure) ───────────────────────────────────────────────────────


def test_absent_since_means_the_serving_window_less_the_resume_grace() -> None:
    assert event_backfill_window(NOW, None) == (
        NOW - timedelta(days=EVENT_BACKFILL_MAX_AGE_DAYS - EVENT_BACKFILL_RESUME_GRACE_DAYS),
        NOW,
    )


def test_the_default_window_start_stays_resumable_for_the_grace_and_no_longer() -> None:
    """The floor moves with `now`. A default run's first row is re-sendable as
    `since` for the grace; past it the request is genuinely old and refused."""
    start, _ = event_backfill_window(NOW, None)
    later = NOW + timedelta(days=EVENT_BACKFILL_RESUME_GRACE_DAYS)
    assert event_backfill_window(later, start.isoformat())[0] == start
    with pytest.raises(ValueError, match="serving window"):
        event_backfill_window(later + timedelta(seconds=1), start.isoformat())


#: Where TypeScript has declared the serving copy's retention: `EVENT_TTL_DAYS`
#: (30, stamped at write) before MONEY-1521, `EVENT_RETENTION_DAYS` (90, stamped
#: by the lake sink) after it.
_RETENTION_SOURCES = (
    "packages/lake/src/events-logic.ts",
    "packages/services/src/events.service.ts",
)


def test_the_bound_never_reaches_past_the_serving_retention() -> None:
    """Re-read from the TypeScript that declares it rather than restated: a
    backfilled event's observedAt is its detectedAt, so reaching past the
    serving retention writes events that are expired on arrival (the at-write
    TTL) or serve no reader (the sink-stamped one)."""
    root = Path(__file__).resolve().parents[3]
    declared = [
        int(days)
        for rel in _RETENTION_SOURCES
        if (root / rel).exists()
        for days in re.findall(
            r"export const EVENT_(?:RETENTION|TTL)_DAYS = (\d+);", (root / rel).read_text()
        )
    ]
    assert declared, (
        "no serving retention is declared where TypeScript used to declare it — "
        "re-derive EVENT_BACKFILL_MAX_AGE_DAYS before trusting the window"
    )
    assert min(declared) >= EVENT_BACKFILL_MAX_AGE_DAYS


@pytest.mark.parametrize(
    "since",
    [
        "2026-09-22T00:00:00Z",
        "2026-09-22T00:00:00+00:00",
        "2026-09-22T05:30:00+05:30",
        "2026-09-22",
    ],
)
def test_an_explicit_since_is_honoured_in_utc(since: str) -> None:
    assert event_backfill_window(NOW, since) == (SINCE_AT, NOW)


def test_a_naive_since_is_utc_never_local_time(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pinned to a non-UTC zone: on a UTC host (CI, Cloud Run) local time IS
    # UTC, and a local-time reading would pass this test for the wrong reason.
    monkeypatch.setenv("TZ", "Asia/Kolkata")
    time.tzset()
    try:
        assert event_backfill_window(NOW, "2026-09-22T00:00:00")[0] == SINCE_AT
    finally:
        monkeypatch.undo()
        time.tzset()


def test_a_since_older_than_the_serving_window_is_refused_not_clamped() -> None:
    """Clamping would report a clean run over a window nobody asked for."""
    floor = NOW - timedelta(days=EVENT_BACKFILL_MAX_AGE_DAYS)
    assert event_backfill_window(NOW, floor.isoformat())[0] == floor
    with pytest.raises(ValueError, match="serving window"):
        event_backfill_window(NOW, (floor - timedelta(seconds=1)).isoformat())


@pytest.mark.parametrize("since", [NOW.isoformat(), (NOW + timedelta(days=1)).isoformat()])
def test_a_since_that_is_not_in_the_past_is_refused(since: str) -> None:
    with pytest.raises(ValueError, match="not before now"):
        event_backfill_window(NOW, since)


@pytest.mark.parametrize("since", ["yesterday", "", "   ", 1_758_499_200, True, ["2026-09-22"]])
def test_an_unparseable_or_non_string_since_is_refused(since: Any) -> None:
    with pytest.raises(ValueError):
        event_backfill_window(NOW, since)


# ── The job ─────────────────────────────────────────────────────────────────


def test_the_route_accepts_the_mode_by_the_name_the_runbook_publishes() -> None:
    # The literal, not the constant: the runbook's `gcloud pubsub topics
    # publish` line spells it, and a renamed constant would pass while that
    # command answered `unknown-mode` for ever.
    assert "event-backfill" in MODES
    assert MODE_EVENT_BACKFILL == "event-backfill"


def test_every_row_in_the_window_is_re_emitted_through_the_live_payload_builder(
    armed: None, statsd
) -> None:
    rows = _rows(3)
    store = FakeStore(rows)
    publisher = FakePublisher()

    result = _backfill(store, publisher)

    assert store.windows == [(SINCE_AT, NOW)]
    # ONE message, to the events topic, and byte-for-byte what the live path's
    # own builder makes of these rows — the two paths cannot disagree.
    assert publisher.calls == [(EVENTS_TOPIC, build_requests(rows)[0])]
    [batch] = publisher.batches()
    assert [f["accession"] for f in batch] == [r["accession"] for r in rows]
    # observedAt is the CLAIM instant, not today: a backfilled filing must not
    # arrive as new.
    assert [f["observedAt"] for f in batch] == [iso_timestamp(r["detectedAt"]) for r in rows]
    assert result["skipped"] is False
    assert result["stopReason"] is None
    assert (result["selected"], result["written"], result["failed"]) == (3, 3, 0)
    assert result["window"] == {"start": iso_timestamp(SINCE_AT), "end": iso_timestamp(NOW)}
    assert result["resumeFrom"] is None


def test_a_large_window_is_one_message_per_route_ceiling(armed: None, statsd) -> None:
    rows = _rows(2 * MAX_FILINGS_PER_REQUEST + 1)
    publisher = FakePublisher()

    result = _backfill(FakeStore(rows), publisher)

    assert [len(b) for b in publisher.batches()] == [500, 500, 1]
    assert [f["accession"] for b in publisher.batches() for f in b] == [
        r["accession"] for r in rows
    ]
    assert (result["selected"], result["written"]) == (1001, 1001)


def test_it_opens_no_sec_socket_and_needs_no_edgar_identity(
    armed: None, statsd, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ordering proof: the branch sits BEFORE `SecClient.from_settings`, which
    needs EDGAR_IDENTITY and would answer `EDGAR_IDENTITY-missing`."""
    monkeypatch.delenv("EDGAR_IDENTITY", raising=False)
    result = _backfill(FakeStore(_rows(2)), FakePublisher())
    assert result["skipped"] is False
    assert result["written"] == 2

    client = NoSecClient()
    _backfill(FakeStore(_rows(2)), FakePublisher(), sec_client=client)
    assert client.calls == []


def test_the_budget_stops_between_messages_and_the_resume_point_leaves_no_gap(
    armed: None, statsd
) -> None:
    rows = _rows(2 * MAX_FILINGS_PER_REQUEST + 1)
    # `started` reads 0; the check before message 1 reads 0 (go), the check
    # before message 2 reads past the budget (stop). Every later read too.
    reads = iter([0.0, 0.0])
    first = FakePublisher()

    result = _backfill(FakeStore(rows), first, monotonic=lambda: next(reads, 1_000.0))

    assert result["stopReason"] == STOP_BUDGET_SPENT
    assert (result["selected"], result["written"]) == (500, 500)
    assert result["resumeFrom"] == iso_timestamp(rows[500]["detectedAt"])

    # The operator's next message is `since = resumeFrom`. Together the two runs
    # must cover every row — a resume point one row late is a silent gap.
    second = FakePublisher()
    again = _backfill(FakeStore(rows), second, since=result["resumeFrom"])
    sent = [f["accession"] for p in (first, second) for b in p.batches() for f in b]
    assert sorted(set(sent)) == sorted(r["accession"] for r in rows)
    assert again["stopReason"] is None


def test_a_DEFAULT_runs_resume_point_is_accepted_when_re_sent_later(armed: None, statsd) -> None:
    """The runbook's shape: no `since`, a budget stop, `resumeFrom` re-sent an
    hour later. With the default window reaching the whole bound, its first
    rows sat just above the floor — and an hour later the floor had passed
    them, so the resume was refused and the tail of the window was never sent."""
    start, _ = event_backfill_window(NOW, None)
    rows = _rows(2 * MAX_FILINGS_PER_REQUEST + 1, start=start)
    reads = iter([0.0, 0.0])
    first = FakePublisher()

    result = _backfill(FakeStore(rows), first, since=None, monotonic=lambda: next(reads, 1e3))
    assert result["stopReason"] == STOP_BUDGET_SPENT

    second = FakePublisher()
    later = NOW + timedelta(hours=1)
    again = _backfill(FakeStore(rows), second, since=result["resumeFrom"], now=later)

    assert again["skipped"] is False, again.get("detail")
    sent = [f["accession"] for p in (first, second) for b in p.batches() for f in b]
    assert sorted(set(sent)) == sorted(r["accession"] for r in rows)


def test_a_failed_publish_stops_the_walk_is_counted_and_names_the_resume_point(
    armed: None, statsd
) -> None:
    rows = _rows(2 * MAX_FILINGS_PER_REQUEST + 1)
    publisher = FakePublisher(fail_from=2)

    result = _backfill(FakeStore(rows), publisher)

    # Message 1 landed, message 2 failed, message 3 was never attempted: the walk
    # is ORDERED, so stopping keeps `resumeFrom` an exact restart point.
    assert [len(b) for b in publisher.batches()] == [500]
    assert result["stopReason"] == STOP_PUBLISH_FAILED
    assert (result["selected"], result["written"], result["failed"]) == (1000, 500, 500)
    assert result["resumeFrom"] == iso_timestamp(rows[500]["detectedAt"])
    # And the failure is in the METRIC, not only in a log line (MONEY-1520).
    assert statsd.value_of(JOB_METRIC_FAILED) == 500


def test_the_outcome_reaches_the_job_metrics(armed: None, statsd) -> None:
    _backfill(FakeStore(_rows(3)), FakePublisher())
    assert statsd.value_of(JOB_METRIC_SELECTED) == 3
    assert statsd.value_of(JOB_METRIC_WRITTEN) == 3
    assert statsd.value_of(JOB_METRIC_FAILED) == 0


def test_the_events_are_emitted_once_and_never_again_by_the_finally(armed: None, statsd) -> None:
    """`handle`'s `finally` re-emits `stats.claimed_documents`. The backfill must
    not put its rows there, or every one would be published twice."""
    publisher = FakePublisher()
    _backfill(FakeStore(_rows(3)), publisher)
    assert len(publisher.calls) == 1


def test_a_refused_window_is_a_named_skip_that_reads_and_publishes_nothing(
    armed: None, statsd
) -> None:
    store = FakeStore(_rows(3))
    publisher = FakePublisher()

    result = _backfill(store, publisher, since="2026-05-01T00:00:00Z")

    assert result["skipped"] is True
    assert result["skippedReason"] == SKIP_BACKFILL_WINDOW
    assert "serving window" in result["detail"]
    assert store.windows == []
    assert publisher.calls == []


def test_the_flag_off_skips_before_anything_is_read(statsd, monkeypatch) -> None:
    """QA ships EDGAR_DETECT=off and never runs the live path, so it has no lost
    events to re-derive — the same gate as every other mode of this route."""
    monkeypatch.setenv("EDGAR_DETECT", "off")
    store = FakeStore(_rows(3))
    publisher = FakePublisher()

    result = _backfill(store, publisher)

    assert result["skippedReason"] == SKIP_FLAG_OFF
    assert store.windows == []
    assert publisher.calls == []


def test_the_cursor_row_records_the_window_and_the_resume_point(armed: None, statsd) -> None:
    store = FakeStore(_rows(2 * MAX_FILINGS_PER_REQUEST + 1))
    _backfill(store, FakePublisher(fail_from=2))

    [(key, cursor, meta)] = store.cursor_writes
    assert key == CURSOR_KEY_EVENT_BACKFILL
    assert cursor is None
    assert meta["lastMode"] == MODE_EVENT_BACKFILL
    assert meta["lastStopReason"] == STOP_PUBLISH_FAILED
    assert (meta["windowStart"], meta["windowEnd"]) == (SINCE_AT, NOW)
    assert (meta["selected"], meta["sent"], meta["failed"]) == (1000, 500, 500)
    assert meta["resumeFrom"] == store.rows[500]["detectedAt"]


# ── The production query ────────────────────────────────────────────────────


class _Cursor:
    def __init__(self, log: dict[str, Any]) -> None:
        self.log = log

    def sort(self, key: str, direction: int) -> _Cursor:
        self.log["sort"] = (key, direction)
        return self

    def hint(self, index: Any) -> _Cursor:
        self.log["hint"] = index
        return self

    def __iter__(self):
        return iter(())


class _Collection:
    def __init__(self) -> None:
        self.log: dict[str, Any] = {}

    def create_index(self, keys, unique: bool = False) -> str:
        return "ix"

    def find(self, filter: dict[str, Any], projection: dict[str, Any]) -> _Cursor:
        self.log.update(filter=filter, projection=projection)
        return _Cursor(self.log)


class _Database(dict):
    def __missing__(self, key: str) -> _Collection:
        self[key] = _Collection()
        return self[key]


def _query(start: datetime, end: datetime) -> dict[str, Any]:
    from app.store import writers

    writers.reset_index_cache()
    database = _Database()
    list(MongoFilingStore(database).filings_detected_between(start, end))
    return database["us_filings"].log


def test_the_query_is_bounded_on_the_always_present_id_index() -> None:
    """`us_filings` is 18.8M rows with NO `detectedAt` index: the bare predicate
    is a 6.5 GB collection scan. The `_id` range + hint is what the database can
    serve (measured: 2,323 keys for the ticket's 2,184-row window, 5 ms)."""
    end = NOW
    log = _query(SINCE_AT, end)

    assert log["filter"]["_id"] == {
        "$gte": ObjectId.from_datetime(SINCE_AT - CLAIM_ID_SLACK),
        "$lt": ObjectId.from_datetime(end + CLAIM_ID_SLACK),
    }
    assert log["hint"] == [("_id", 1)]
    # detectedAt is the WHOLE selection — no form and no status filter, because
    # the live path emitted every claimed row (59% of them `OTHER`/NO_PARSER).
    assert log["filter"]["detectedAt"] == {"$gte": SINCE_AT, "$lt": end}
    assert set(log["filter"]) == {"_id", "detectedAt"}
    # Ordered on the column the window is defined on, so `resumeFrom` is exact.
    assert log["sort"] == ("detectedAt", 1)
    # Every field the payload builder reads, and the ObjectId left behind.
    assert {k for k, v in log["projection"].items() if v} == {
        "accession",
        "cik10",
        "form",
        "items",
        "acceptedAt",
        "filedAt",
        "detectedAt",
    }
    assert log["projection"]["_id"] == 0


def _minted(at: datetime, *, highest: bool) -> ObjectId:
    """An ObjectId minted at ``at`` — the LOWEST or HIGHEST one that second allows."""
    tail = b"\xff" * 8 if highest else b"\x00" * 8
    return ObjectId(int(at.timestamp()).to_bytes(4, "big") + tail)


def test_a_claim_at_either_edge_of_the_window_falls_inside_the_id_bounds() -> None:
    """The slack is what keeps the edges: an ObjectId keeps whole seconds and is
    minted a few ms AFTER `detectedAt` (measured -999..+4 ms), so a claim at the
    last millisecond of the window can carry the NEXT second's ObjectId."""
    start = datetime(2026, 9, 22, 0, 0, 0, 500_000, tzinfo=UTC)
    end = datetime(2026, 9, 23, 6, 0, 0, 998_000, tzinfo=UTC)
    bounds = _query(start, end)["filter"]["_id"]

    first = _minted(start, highest=False)
    last = _minted(end - timedelta(milliseconds=1) + timedelta(milliseconds=4), highest=True)
    assert bounds["$gte"] <= first < bounds["$lt"]
    assert bounds["$gte"] <= last < bounds["$lt"]
