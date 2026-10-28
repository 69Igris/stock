"""``/jobs/edgar-evict`` end to end — MONEY-979 (T9).

These drive the REAL :func:`app.jobs.evict.handle` — the same function
``app/main.py`` calls — with fakes injected through its keyword seam.

**The GCS half is not faked.** ``app.sec.archive`` is passed in as the archive
port with only ``read_bytes``/``write_bytes`` redirected at an in-memory bucket,
so every test below runs the SHIPPED ``merge_and_write_shard`` / ``read_shard``,
the shipped gzip-JSONL codec, the shipped magic-byte sniff and the shipped merge.
A fake that re-implemented the codec would keep passing after the real one was
deleted, and the one thing this job cannot afford is a test that agrees with
itself about what was archived.

The property every test here exists for: **rows are deleted only after a
SECOND read of the shard proves them present.** A delete keyed off the write's
return code is how a quarter of holdings disappears with nothing to notice it.
"""

from __future__ import annotations

import gzip
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.evict_logic import (
    CHAIN_AFTER_ACCESSION_KEY,
    CHAIN_AFTER_PERIOD_KEY,
    CHAIN_DEPTH_KEY,
    CHAIN_TOPIC,
    FAIL_ROWS_UNPROVEN,
    FAIL_SHARD_ABSENT,
    FAIL_STORAGE,
    SKIP_DATABASE_UNAVAILABLE,
    SKIP_WRITE_DISARMED,
    STOP_BUDGET_SPENT,
    STOP_CHAIN_DEPTH_REACHED,
    STOP_DRAINED,
    STOP_STORAGE_UNAVAILABLE,
)
from app.jobs import evict
from app.jobs.evict import JOB_NAME, MongoEvictStore, handle
from app.publish import PublishError
from app.sec import archive as archive_module
from app.store.outcome import JOB_METRIC_SELECTED, JOB_METRIC_WRITTEN

#: The EXACT key the already-merged TypeScript reader computes, copied from
#: `packages/core/__tests__/us-fundamentals/repository.test.ts:684`.
TS_EXPECTED_KEY = "edgar/13f/0001067983/2024-03-31"
BERKSHIRE = "0001067983"

Q1_2024 = datetime(2024, 3, 31)
Q2_2024 = datetime(2024, 6, 30)
Q3_2024 = datetime(2024, 9, 30)
Q4_2024 = datetime(2024, 12, 31)

NOW = datetime(2025, 3, 1, 12, 0, tzinfo=UTC)


# ── Fixtures for the two halves ─────────────────────────────────────────────


def _instant(value: Any) -> Any:
    """Stamp a naive datetime as UTC before comparing it.

    Models BSON, not Python. MongoDB stores every date as a UTC INSTANT and
    pymongo hands it back NAIVE (the client is not ``tz_aware``), while the query
    this job builds sends AWARE datetimes. On a real server both sides are the
    same instant; in Python a naive/aware ``>`` raises and a naive/aware ``==``
    is silently False. Normalising here makes the fake behave like the server
    rather than like the driver's return type.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return value


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    """The handful of operators :func:`evictable_query` actually emits."""
    for field, condition in query.items():
        if field == "$or":
            if not any(_matches(document, part) for part in condition):
                return False
            continue
        value = _instant(document.get(field))
        if isinstance(condition, dict) and any(str(k).startswith("$") for k in condition):
            for operator, operand in condition.items():
                if operator == "$ne" and value == _instant(operand):
                    return False
                if operator == "$nin" and value in [_instant(v) for v in operand]:
                    return False
                if operator == "$in" and value not in [_instant(v) for v in operand]:
                    return False
                if operator == "$gt" and not (value is not None and value > _instant(operand)):
                    return False
                if operator == "$gte" and not (value is not None and value >= _instant(operand)):
                    return False
        elif value != _instant(condition):
            return False
    return True


class FakeEvictStore:
    """An in-memory ``us_13f_filings`` + ``us_13f_holdings``.

    Records every query it was handed and every delete it was asked for, so
    "the disarmed run deleted nothing" is an assertion and not an inference.
    """

    def __init__(self, filings: list[dict[str, Any]], holdings: list[dict[str, Any]]) -> None:
        self.filings = [dict(f) for f in filings]
        self.holdings = [dict(h) for h in holdings]
        self.queries: list[dict[str, Any]] = []
        self.deletes: list[tuple[str, list[int]]] = []
        self.cold: list[tuple[str, str]] = []
        self.holdings_reads: list[str] = []

    def all_periods(self) -> list[Any]:
        return sorted({f["periodOfReport"] for f in self.filings})

    def in_flight_periods(self, cutoff: datetime) -> list[Any]:
        return sorted(
            {
                f["periodOfReport"]
                for f in self.filings
                if f.get("filedAt") is not None and _instant(f["filedAt"]) >= cutoff
            }
        )

    def evictable_filings(self, query: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
        self.queries.append(dict(query))
        selected = [f for f in self.filings if _matches(f, query)]
        selected.sort(key=lambda f: (_instant(f["periodOfReport"]), f.get("accession") or ""))
        return [dict(f) for f in selected[:limit]]

    def holdings_for(self, accession: str) -> list[dict[str, Any]]:
        self.holdings_reads.append(accession)
        return [dict(h) for h in self.holdings if h["accession"] == accession]

    def delete_holdings(self, accession: str, row_indexes) -> int:
        indexes = list(row_indexes)
        self.deletes.append((accession, indexes))
        before = len(self.holdings)
        self.holdings = [
            h
            for h in self.holdings
            if not (h["accession"] == accession and h["rowIndex"] in indexes)
        ]
        return before - len(self.holdings)

    def mark_cold(self, accession: str, cold_path: str) -> int:
        self.cold.append((accession, cold_path))
        for filing in self.filings:
            if filing["accession"] == accession:
                filing["tier"] = "COLD"
                filing["coldPath"] = cold_path
                return 1
        return 0


class FakeBucket:
    """An in-memory GCS. Real bytes, real keys, real 404 semantics.

    The corruption hooks model what actually goes wrong: a write that is accepted
    but lands short, an object that comes back damaged, and a bucket that refuses
    the read outright. Each one is applied AFTER the write returns successfully —
    which is precisely the window the re-read exists to close.
    """

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.reads: list[str] = []
        self.writes: list[str] = []
        #: Keep only the first N rows of whatever is written.
        self.truncate_to: int | None = None
        #: Replace the written bytes with something that is not a shard.
        self.corrupt_on_write = False
        #: Raise on every read.
        self.fail_reads = False
        #: Raise on every write.
        self.fail_writes = False

    def read_bytes(self, key: str) -> bytes | None:
        self.reads.append(key)
        if self.fail_reads:
            raise RuntimeError("GCS is unreachable")
        return self.objects.get(key)

    def write_bytes(self, key: str, data: bytes, *, content_type: str) -> None:
        self.writes.append(key)
        if self.fail_writes:
            raise RuntimeError("GCS refused the upload")
        assert content_type == "application/gzip"
        if self.corrupt_on_write:
            self.objects[key] = b"this is not a gzip member"
            return
        if self.truncate_to is not None:
            text = gzip.decompress(data).decode("utf-8")
            lines = [line for line in text.split("\n") if line.strip()]
            kept = "\n".join(lines[: self.truncate_to])
            self.objects[key] = gzip.compress(kept.encode("utf-8"), compresslevel=9, mtime=0)
            return
        self.objects[key] = data

    def lines(self, key: str) -> list[dict[str, Any]]:
        raw = gzip.decompress(self.objects[key]).decode("utf-8")
        return [json.loads(line) for line in raw.split("\n") if line.strip()]


@pytest.fixture
def bucket(monkeypatch) -> FakeBucket:
    """Redirect ONLY the two byte-level calls; everything above them is real."""
    fake = FakeBucket()
    monkeypatch.setattr(archive_module, "read_bytes", fake.read_bytes)
    monkeypatch.setattr(archive_module, "write_bytes", fake.write_bytes)
    return fake


class FakePublisher:
    """Records every follow-up. ``fail`` makes the publish raise as the real one does."""

    def __init__(self, fail: bool = False) -> None:
        self.messages: list[tuple[str, dict[str, Any]]] = []
        self._fail = fail

    def publish(self, topic: str, payload: dict[str, Any]) -> str:
        if self._fail:
            raise PublishError("topic is gone")
        self.messages.append((topic, dict(payload)))
        return f"msg-{len(self.messages)}"


def stepping_monotonic(step: float = 0.0, start: float = 0.0):
    """A monotonic clock that advances ``step`` SECONDS on every call.

    ``step=0`` (the default) means no test accidentally trips the budget.
    """
    state = {"t": start - step}

    def tick() -> float:
        state["t"] += step
        return state["t"]

    return tick


# ── Fixture data ────────────────────────────────────────────────────────────


def filing(
    accession: str,
    period: datetime = Q1_2024,
    *,
    tier: str | None = "HOT",
    filed_at: datetime | None = None,
    manager: str = BERKSHIRE,
    manager_name: str | None = "BERKSHIRE HATHAWAY INC",
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "accession": accession,
        "managerCik10": manager,
        "periodOfReport": period,
        "filedAt": filed_at or (period + timedelta(days=45)),
    }
    if tier is not None:
        document["tier"] = tier
    if manager_name is not None:
        document["managerName"] = manager_name
    return document


def holdings(accession: str, count: int, *, period: datetime = Q1_2024, **overrides):
    rows = []
    for index in range(count):
        row = {
            "_id": f"id-{accession}-{index}",
            "accession": accession,
            "rowIndex": index,
            "managerCik10": BERKSHIRE,
            "periodOfReport": period,
            "filedAt": period + timedelta(days=45),
            "cusip": f"03783310{index}",
            "issuerName": "APPLE INC",
            "titleOfClass": "COM",
            "valueUsd": 1000.0 + index,
            "shares": 10.0 + index,
            "sharesType": "SH",
            "investmentDiscretion": "SOLE",
            "votingSole": 10.0 + index,
            "symbol": "AAPL",
        }
        row.update(overrides)
        rows.append(row)
    return rows


def store_of(filings, holding_rows=()) -> FakeEvictStore:
    """A store whose hot window is held open by two NEWER quarters.

    Without them a table containing one quarter has that quarter as its newest
    period, so it is inside the window and nothing is ever evictable — which is
    correct behaviour and useless as a fixture. The guards are ordinary HOT
    filings at Q2 and Q3 2024 that every test expects to be left alone.
    """
    guards = [filing("GUARD-Q2", Q2_2024), filing("GUARD-Q3", Q3_2024)]
    return FakeEvictStore(filings=guards + list(filings), holdings=list(holding_rows))


def run(store, bucket_unused=None, **kwargs):
    """Call the REAL handler with the real archive module as its port."""
    kwargs.setdefault("archive", archive_module)
    kwargs.setdefault("clock", lambda: NOW)
    kwargs.setdefault("monotonic", stepping_monotonic())
    kwargs.setdefault("page_size", 50)
    payload = kwargs.pop("payload", {})
    return handle(payload, store=store, **kwargs)


@pytest.fixture
def armed(monkeypatch):
    monkeypatch.setenv("EDGAR_EVICT_APPLY", "true")


# ── 1. The hot window decides what is selected ──────────────────────────────


def test_the_window_is_the_two_newest_periods(bucket):
    """The steady state: two periods wide, and the two NEWEST.

    MUTATION this catches: narrowing ``HOT_PERIOD_COUNT`` to 1, which makes Q2
    evictable — the half of every QoQ comparison the product renders on the same
    screen.
    """
    store = FakeEvictStore(
        filings=[
            filing("A-2023Q4", datetime(2023, 12, 31)),
            filing("A-2024Q1", Q1_2024),
            filing("A-2024Q2", Q2_2024),
            filing("A-2024Q3", Q3_2024),
        ],
        holdings=[],
    )

    result = run(store)

    assert result["hotWindow"]["newest"] == ["2024-09-30", "2024-06-30"]
    assert result["hotWindow"]["inFlight"] == []
    assert result["selected"] == 2, "2023-Q4 and 2024-Q1 are outside the window"


def test_a_RECENT_filing_keeps_its_OLD_period_hot_on_top_of_the_two(bucket):
    """The in-flight leg, in the only shape that is not already implied.

    The two-newest rule is computed from DISTINCT periods, so a single early
    filer already puts a brand-new quarter in the window — that case needs no
    help. What it cannot cover is a filing that arrives for an OLDER period: an
    amendment restating 2024-Q1, filed 20 days ago. Without this leg it would be
    parsed and archived within hours of arriving, so the rows most likely to be
    read next would be the ones sent straight to GCS.

    MUTATION this catches: dropping the ``in_flight`` union, or intersecting
    instead of unioning — 2024-Q1 becomes evictable and `selected` goes to 2.
    """
    recent = NOW.replace(tzinfo=None) - timedelta(days=20)
    store = FakeEvictStore(
        filings=[
            filing("A-2023Q4", datetime(2023, 12, 31)),
            filing("A-2024Q1", Q1_2024),
            filing("A-2024Q1-AMENDMENT", Q1_2024, filed_at=recent),
            filing("A-2024Q2", Q2_2024),
            filing("A-2024Q3", Q3_2024),
        ],
        holdings=[],
    )

    result = run(store)

    assert result["hotWindow"]["newest"] == ["2024-09-30", "2024-06-30"]
    assert result["hotWindow"]["inFlight"] == ["2024-03-31"]
    assert result["hotWindow"]["periods"] == ["2024-09-30", "2024-06-30", "2024-03-31"]
    assert result["selected"] == 1, "only 2023-Q4 is outside a THREE-period window"


def test_a_filing_already_COLD_is_never_reselected(bucket):
    store = FakeEvictStore(
        filings=[
            filing("A", Q1_2024, tier="COLD"),
            filing("B", Q2_2024),
            filing("C", Q3_2024),
        ],
        holdings=[],
    )
    assert run(store)["selected"] == 0


def test_a_filing_with_NO_tier_field_at_all_is_still_selected(bucket):
    """``$ne: "COLD"`` matches an ABSENT field; ``$eq: "HOT"`` does not.

    A column added by a later ``db push`` is absent on every pre-existing row —
    the class behind four tickets in this repo. Skipping those rows would be
    silent and permanent.
    """
    store = FakeEvictStore(
        filings=[filing("A", Q1_2024, tier=None), filing("B", Q2_2024), filing("C", Q3_2024)],
        holdings=[],
    )
    assert run(store)["selected"] == 1


# ── 2. The armed happy path ─────────────────────────────────────────────────


def test_an_armed_run_archives_at_the_TYPESCRIPT_READERS_KEY_then_deletes(bucket, armed):
    """The whole job, and the key literal the other language expects.

    ``edgar/13f/0001067983/2024-03-31`` is read out of
    `packages/core/__tests__/us-fundamentals/repository.test.ts`, where the cold
    read asserts the key it `get`s. A mismatch does not fail anywhere: it 404s
    every archived quarter, silently and forever.
    """
    store = store_of([filing("A", Q1_2024)], holdings("A", 3))

    result = run(store)

    assert list(bucket.objects) == [TS_EXPECTED_KEY]
    assert result["selected"] == 1
    assert result["evicted"] == 1
    assert result["failed"] == 0
    assert result["rows"] == {
        "archived": 3,
        "deleted": 3,
        "unproven": 0,
        "unreadableByReader": 0,
    }
    assert store.deletes == [("A", [0, 1, 2])]
    assert store.cold == [("A", TS_EXPECTED_KEY)]
    assert store.holdings == [], "the hot rows are gone"
    assert result["stopReason"] == STOP_DRAINED


def test_the_archived_lines_carry_the_FULL_prisma_field_names(bucket, armed):
    """Not the candle codec's short keys, and not a projection down to fifteen.

    The shard is the only copy once the hot rows are deleted, so a writer that
    kept only what today's reader consumes would destroy the rest.
    """
    store = store_of([filing("A")], holdings("A", 1))
    run(store)

    (line,) = bucket.lines(TS_EXPECTED_KEY)
    assert line["accession"] == "A"
    assert line["rowIndex"] == 0
    assert line["managerCik10"] == BERKSHIRE
    assert line["cusip"] == "037833100"
    assert line["valueUsd"] == 1000.0
    assert line["shares"] == 10.0
    assert line["sharesType"] == "SH"
    assert line["symbol"] == "AAPL"
    # Not consumed by the TypeScript reader, and archived anyway.
    assert line["investmentDiscretion"] == "SOLE"
    assert line["votingSole"] == 10.0
    # Denormalised from `us_13f_filings`, so a cold row is self-describing.
    assert line["managerName"] == "BERKSHIRE HATHAWAY INC"
    assert "_id" not in line
    # An explicit Z: ECMA-262 reads an offset-less date-TIME as LOCAL time, and
    # `toISOString().slice(0, 10)` would then build the key for the wrong day.
    assert line["periodOfReport"] == "2024-03-31T00:00:00.000Z"
    assert line["filedAt"] == "2024-05-15T00:00:00.000Z"


def test_the_shard_is_MERGED_so_another_filings_rows_survive(bucket, armed):
    """A GCS put REPLACES the object, and one shard holds every filing for a
    manager-quarter — the original 13F-HR and each amendment share a key.

    MUTATION this catches: replacing ``merge_and_write_shard`` with a plain
    ``write_shard``. The put still returns 200 and the first filing's rows are
    gone from the only copy that exists.
    """
    store = store_of(
        [filing("A-ORIGINAL"), filing("B-AMENDMENT")],
        holdings("A-ORIGINAL", 2) + holdings("B-AMENDMENT", 2),
    )

    result = run(store)

    assert result["evicted"] == 2
    keys = {(line["accession"], line["rowIndex"]) for line in bucket.lines(TS_EXPECTED_KEY)}
    assert keys == {
        ("A-ORIGINAL", 0),
        ("A-ORIGINAL", 1),
        ("B-AMENDMENT", 0),
        ("B-AMENDMENT", 1),
    }
    assert len(bucket.objects) == 1, "both filings share ONE manager-quarter object"


def test_a_re_archived_row_REPLACES_rather_than_duplicating(bucket, armed):
    """The merge identity is the Prisma ``@@unique``, so a repair run converges."""
    store = store_of([filing("A")], holdings("A", 2))
    run(store)

    # A second run over the same filing, as if the first had crashed after the
    # write: the rows are back in the hot table and the filing is HOT again.
    store.filings[-1]["tier"] = "HOT"
    store.holdings = holdings("A", 2)
    run(store)

    assert len(bucket.lines(TS_EXPECTED_KEY)) == 2


# ── 3. The re-read GATES the delete ─────────────────────────────────────────


def test_a_SHORT_re_read_deletes_only_the_rows_it_proves(bucket, armed):
    """The write was accepted; the object landed with two of four rows.

    MUTATION this catches: deleting on the WRITE's success instead of on the
    re-read. Without the gate all four rows are deleted and two of them exist
    nowhere. It also catches removing the re-read entirely, which leaves the
    delete keyed on the intended set.
    """
    bucket.truncate_to = 2
    store = store_of([filing("A")], holdings("A", 4))

    result = run(store)

    assert store.deletes == [("A", [0, 1])], "only the two rows the shard gave back"
    assert {h["rowIndex"] for h in store.holdings} == {2, 3}, "the unproven rows stay HOT"
    assert store.cold == [], "the filing must NOT be marked COLD while rows are unproven"
    assert result["evicted"] == 0
    assert result["failed"] == 1
    assert result["rows"]["deleted"] == 2
    assert result["rows"]["unproven"] == 2
    assert result["reasons"] == {FAIL_ROWS_UNPROVEN: 1}


def test_a_FAILING_re_read_deletes_NOTHING(bucket, armed):
    """A bucket that refuses the read.

    The delete is textually and causally AFTER the re-read inside the same try,
    so a storage failure of any kind reaches the handler having deleted nothing.
    """
    store = store_of([filing("A")], holdings("A", 4))

    # The write lands; the read that follows it is refused.
    def write_then_break(key, data, *, content_type):
        bucket.objects[key] = data
        bucket.writes.append(key)
        bucket.fail_reads = True

    original_read = bucket.read_bytes

    def read(key):
        if bucket.fail_reads:
            raise RuntimeError("GCS is unreachable")
        return original_read(key)

    archive_module.write_bytes = write_then_break  # type: ignore[assignment]
    archive_module.read_bytes = read  # type: ignore[assignment]

    result = run(store)

    assert store.deletes == [], "ZERO deletions"
    assert len(store.holdings) == 4
    assert store.cold == []
    assert result["evicted"] == 0
    assert result["transportFailures"] == 1
    assert result["reasons"] == {FAIL_STORAGE: 1}


def test_a_CORRUPT_shard_deletes_NOTHING(bucket, armed):
    """A damaged gzip member must not read as an empty shard.

    ``decode_shard`` raises ``ShardCorruptError`` rather than returning zero
    rows, which is the difference between "the archive is unreadable" and "the
    manager held nothing" — and zero rows would let the eviction verify its
    archive against nothing and then delete what it was supposed to preserve.
    """
    bucket.corrupt_on_write = True
    store = store_of([filing("A")], holdings("A", 3))

    result = run(store)

    assert store.deletes == []
    assert store.cold == []
    assert result["transportFailures"] == 1
    assert result["reasons"] == {FAIL_STORAGE: 1}


def test_a_shard_that_is_ABSENT_after_a_successful_write_deletes_NOTHING(bucket, armed):
    """The write said yes and the object is not there.

    Named as its own reason instead of read as an empty shard, because absence
    and unreadability must never look alike.
    """
    store = store_of([filing("A")], holdings("A", 3))

    def write_nowhere(key, data, *, content_type):
        bucket.writes.append(key)

    archive_module.write_bytes = write_nowhere  # type: ignore[assignment]

    result = run(store)

    assert store.deletes == []
    assert store.cold == []
    assert result["rows"]["unproven"] == 3
    assert result["reasons"] == {FAIL_SHARD_ABSENT: 1}


def test_a_row_that_cannot_be_ENCODED_is_not_blamed_on_the_bucket(bucket, armed):
    """A NaN in ``valueUsd`` fails ``json.dumps(allow_nan=False)``.

    That is a ROW problem and it fails every retry identically, whereas a storage
    failure is the thing worth backing off from. Folding the two together would
    trip the consecutive-storage-failure abort after three bad filings and blame
    GCS for a parser defect — and would spend a ``transportFailures`` count,
    which the outcome module defines as "a reason no rows were considered", on
    something that is not.
    """
    rows = holdings("A", 2)
    rows[0]["valueUsd"] = float("nan")
    store = store_of([filing("A")], rows)

    result = run(store)

    assert result["reasons"] == {"row-not-encodable": 1}
    assert result["transportFailures"] == 0, "a bad row is not an upstream failure"
    assert result["failed"] == 1
    assert result["rows"]["unreadableByReader"] == 1, "NaN is also unreadable to the reader"
    assert store.deletes == []
    assert store.cold == []
    assert bucket.objects == {}


def test_a_FAILING_write_deletes_NOTHING(bucket, armed):
    bucket.fail_writes = True
    store = store_of([filing("A")], holdings("A", 3))

    result = run(store)

    assert store.deletes == []
    assert store.cold == []
    assert result["transportFailures"] == 1


def test_an_unproven_filing_CONVERGES_on_the_next_run(bucket, armed):
    """The remainder is merged in and re-proven, so the drain finishes."""
    bucket.truncate_to = 2
    store = store_of([filing("A")], holdings("A", 4))
    run(store)
    assert {h["rowIndex"] for h in store.holdings} == {2, 3}

    bucket.truncate_to = None
    result = run(store)

    assert store.holdings == []
    assert store.cold == [("A", TS_EXPECTED_KEY)]
    assert result["evicted"] == 1
    assert len(bucket.lines(TS_EXPECTED_KEY)) == 4


# ── 4. Disarmed ─────────────────────────────────────────────────────────────


def test_a_DISARMED_run_plans_and_deletes_NOTHING(bucket, monkeypatch):
    """``EDGAR_EVICT_APPLY`` absent. The run does the real work and writes none.

    MUTATION this catches: reading the flag with ``bool()``. ``bool("false")`` is
    ``True``, which arms the one configuration meant to keep this job off — so
    the "false" case below is the one that matters most.
    """
    store = store_of([filing("A")], holdings("A", 5))

    result = run(store)

    assert result["applied"] is False
    assert result["skippedReason"] == SKIP_WRITE_DISARMED
    assert result["selected"] == 1
    assert result["rows"]["archived"] == 5, "the plan is REAL: the rows were really read"
    assert result["cursor"] == {"afterPeriod": "2024-03-31", "afterAccession": "A"}
    assert store.deletes == [], "the delete function was called ZERO times"
    assert store.cold == []
    assert bucket.writes == [], "no GCS object is touched"
    assert bucket.objects == {}
    assert len(store.holdings) == 5


@pytest.mark.parametrize("value", ["false", "off", "0", "no", "TRUE ", "yes", ""])
def test_only_the_LITERAL_true_arms_the_delete(bucket, monkeypatch, value):
    """Every one of these is truthy to ``bool()`` except the empty string, and
    ``"TRUE "`` is the one a careless ``.lower()`` without ``.strip()`` would let
    through — ``settings.evict_apply`` strips AND lower-cases AND compares."""
    monkeypatch.setenv("EDGAR_EVICT_APPLY", value)
    store = store_of([filing("A")], holdings("A", 2))

    result = run(store)

    if value.strip().lower() == "true":
        assert result["applied"] is True
        assert store.deletes != []
    else:
        assert result["applied"] is False
        assert store.deletes == []
        assert bucket.writes == []


# ── 5. Budget and chaining ──────────────────────────────────────────────────


def test_the_budget_stops_BETWEEN_filings_and_publishes_a_follow_up(bucket, armed):
    """420 s against Pub/Sub's 600 s ack deadline.

    The clock advances 300 s per check: filing 1 is processed at 0 s, and the
    check before filing 2 sees 600 s and stops. The run must publish its own
    successor carrying ``chainDepth`` and the resume cursor.
    """
    store = store_of(
        [filing("A", Q1_2024), filing("B", datetime(2023, 12, 31))],
        holdings("A", 1) + holdings("B", 1, period=datetime(2023, 12, 31)),
    )
    publisher = FakePublisher()

    result = run(
        store,
        monotonic=stepping_monotonic(step=300.0),
        publisher=publisher,
        page_size=50,
    )

    assert result["stopReason"] == STOP_BUDGET_SPENT
    assert result["selected"] == 1, "the second filing was never started"
    topic, payload = publisher.messages[0]
    assert topic == CHAIN_TOPIC
    assert payload[CHAIN_DEPTH_KEY] == 1
    assert payload[CHAIN_AFTER_PERIOD_KEY] == "2023-12-31"
    assert payload[CHAIN_AFTER_ACCESSION_KEY] == "B"
    assert result["chain"]["published"] is True


def test_the_follow_up_RESUMES_where_the_first_run_stopped(bucket, armed):
    """Driving the two runs in sequence, the second must not redo the first.

    MUTATION this catches: dropping the cursor from the chain payload, or from
    the query. Without it the chained run is handed the same first page and the
    drain never advances past a filing it cannot complete.
    """
    store = store_of(
        [filing("A", datetime(2023, 12, 31)), filing("B", Q1_2024)],
        holdings("A", 1, period=datetime(2023, 12, 31)) + holdings("B", 1),
    )
    publisher = FakePublisher()

    first = run(store, monotonic=stepping_monotonic(step=300.0), publisher=publisher)
    assert first["selected"] == 1
    _, follow_up = publisher.messages[0]

    second = run(store, payload=follow_up)

    assert second["selected"] == 1
    assert second["chain"]["depth"] == 1
    assert store.cold == [
        ("A", "edgar/13f/0001067983/2023-12-31"),
        ("B", TS_EXPECTED_KEY),
    ]
    # The second run's query carried the boundary, so it never looked at A again.
    assert "$or" in store.queries[-1]


def test_the_chain_is_BOUNDED_at_twenty(bucket, armed):
    """MUTATION this catches: removing the ``depth >= max_depth`` check. A run
    whose budget is always spent would then republish forever."""
    store = store_of(
        [filing("A", Q1_2024), filing("B", datetime(2023, 12, 31))],
        holdings("A", 1) + holdings("B", 1, period=datetime(2023, 12, 31)),
    )
    publisher = FakePublisher()

    result = run(
        store,
        payload={CHAIN_DEPTH_KEY: 20},
        monotonic=stepping_monotonic(step=300.0),
        publisher=publisher,
    )

    assert result["stopReason"] == STOP_BUDGET_SPENT
    assert publisher.messages == [], "depth 20 is the last run"
    assert result["chain"] == {
        "depth": 20,
        "maxDepth": 20,
        "published": False,
        "reason": STOP_CHAIN_DEPTH_REACHED,
    }


def test_a_DRAINED_run_never_chains(bucket, armed):
    store = store_of([filing("A")], holdings("A", 1))
    publisher = FakePublisher()

    result = run(store, publisher=publisher)

    assert publisher.messages == []
    assert result["chain"]["reason"] == STOP_DRAINED


def test_a_failed_chain_publish_is_REPORTED_not_raised(bucket, armed):
    """The archived rows are already deleted and already durable. Taking the
    route to 500 would have Pub/Sub redeliver a message whose filings are done."""
    store = store_of(
        [filing("A", Q1_2024), filing("B", datetime(2023, 12, 31))],
        holdings("A", 1) + holdings("B", 1, period=datetime(2023, 12, 31)),
    )

    result = run(
        store,
        monotonic=stepping_monotonic(step=300.0),
        publisher=FakePublisher(fail=True),
    )

    assert result["success"] is True
    assert result["chain"]["published"] is False
    assert result["chain"]["error"] == "PublishError"
    assert store.cold == [("B", "edgar/13f/0001067983/2023-12-31")], (
        "the filing that WAS evicted before the budget ran out still stands"
    )


def test_three_consecutive_storage_failures_stop_the_run_WITHOUT_chaining(bucket, armed):
    """A dead bucket fails every filing identically; chaining 20 deep against it
    turns one broken run into twenty and twenty dead-letter candidates."""
    bucket.fail_writes = True
    store = store_of([filing(f"A{n}", Q1_2024 - timedelta(days=n)) for n in range(5)])
    publisher = FakePublisher()

    result = run(store, publisher=publisher)

    assert result["stopReason"] == STOP_STORAGE_UNAVAILABLE
    assert result["selected"] == 3, "stopped after the third consecutive failure"
    assert result["transportFailures"] == 3
    assert publisher.messages == []
    assert store.deletes == []


def test_paging_walks_past_the_page_size(bucket, armed):
    """The page is a page, not the control — the budget is the control."""
    store = store_of([filing(f"A{n}", Q1_2024 - timedelta(days=n)) for n in range(5)])

    result = run(store, page_size=2)

    assert result["selected"] == 5
    assert result["evicted"] == 5
    assert len(store.queries) >= 3


# ── 6. Reporting ────────────────────────────────────────────────────────────


def test_the_outcome_is_reported_from_a_FINALLY_even_when_the_store_throws(bucket, armed, statsd):
    """A job that raises before reporting is invisible in exactly the dimension
    the metric measures."""

    class Exploding(FakeEvictStore):
        def all_periods(self):
            raise RuntimeError("mongo is gone")

    with pytest.raises(RuntimeError):
        run(Exploding(filings=[], holdings=[]))

    assert JOB_METRIC_SELECTED in statsd.names()
    assert JOB_METRIC_WRITTEN in statsd.names()


def test_a_disarmed_run_reports_selected_greater_than_written(bucket, statsd):
    """``selected > 0 and written == 0`` is the zero-write signal, and a disarmed
    run is the one case where it is EXPECTED — which is why the skipped reason
    rides along on the same line."""
    store = store_of([filing("A")], holdings("A", 2))

    run(store)

    assert statsd.value_of(JOB_METRIC_SELECTED) == 1
    assert statsd.value_of(JOB_METRIC_WRITTEN) == 0


def test_an_armed_run_reports_the_filings_it_actually_evicted(bucket, armed, statsd):
    store = store_of([filing("A")], holdings("A", 2))

    run(store)

    assert statsd.value_of(JOB_METRIC_SELECTED) == 1
    assert statsd.value_of(JOB_METRIC_WRITTEN) == 1
    tags = next(t for _, name, _, t in statsd.calls if name == JOB_METRIC_WRITTEN)
    assert f"job:{JOB_NAME}" in tags


def test_rows_the_TYPESCRIPT_READER_would_drop_are_COUNTED_not_hidden(bucket, armed):
    """An empty ``cusip`` makes ``parseThirteenFShard`` drop the line silently.

    The row is archived anyway — the shard is lossless — but the gap between what
    is stored and what is readable must be visible in the outcome rather than
    assumed away.
    """
    rows = holdings("A", 3)
    rows[1]["cusip"] = ""
    store = store_of([filing("A")], rows)

    result = run(store)

    assert result["rows"]["archived"] == 3
    assert result["rows"]["unreadableByReader"] == 1
    assert len(bucket.lines(TS_EXPECTED_KEY)) == 3, "archived regardless"


# ── 7. Degenerate inputs ────────────────────────────────────────────────────


def test_no_database_is_a_NAMED_SKIP_and_never_a_raise(monkeypatch):
    """Configuration, not a transient. It will not become true on redelivery, and
    five retries into a dead-letter would raise an alert about the consumer for a
    deployment problem."""
    from app import db

    db.reset_for_tests()
    result = handle({})

    assert result["success"] is False
    assert result["skippedReason"] == SKIP_DATABASE_UNAVAILABLE


def test_a_filing_with_zero_holdings_archives_an_EMPTY_shard_and_goes_COLD(bucket, armed):
    """Honest: "this manager-quarter archived zero holdings". The alternative —
    leaving it HOT forever — would have the drain retry it every night."""
    store = store_of([filing("A")])

    result = run(store)

    assert result["evicted"] == 1
    assert store.cold == [("A", TS_EXPECTED_KEY)]
    assert bucket.lines(TS_EXPECTED_KEY) == []


def test_a_filing_with_an_unbuildable_key_is_named_and_never_archived(bucket, armed):
    """An unpadded CIK is a DIFFERENT prefix in the bucket, so half the archive
    would be written under each and neither would be complete. The key builder
    raises; this job names it."""
    store = store_of([filing("A", manager="320193")], holdings("A", 2))

    result = run(store)

    assert result["evicted"] == 0
    assert result["failed"] == 1
    assert result["reasons"] == {"unbuildable-cold-key": 1}
    assert bucket.writes == []
    assert store.deletes == []


def test_a_page_whose_cursor_cannot_advance_STOPS_instead_of_spinning(bucket, armed):
    """Every filing on the page is missing the pair the cursor is built from, so
    the next query would return the SAME page."""
    store = store_of([{"managerCik10": BERKSHIRE, "periodOfReport": Q1_2024}])

    result = run(store, page_size=1)

    assert result["stopReason"] == "cursor-stuck"


# ── 8. The PRODUCTION store ─────────────────────────────────────────────────
#
# `MongoEvictStore` is what actually ships; the in-memory fake above is not.
# These drive it against a collection fake that records the driver calls.


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs
        self.sort_spec = None
        self.limit_value = None

    def sort(self, spec):
        self.sort_spec = spec
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def __iter__(self):
        return iter(self.docs)


class FakeCollection:
    def __init__(self, docs=()):
        self.docs = list(docs)
        self.finds: list[tuple[dict, dict]] = []
        self.distincts: list[tuple[str, dict | None]] = []
        self.deletes: list[dict] = []
        self.updates: list[tuple[dict, dict, bool]] = []
        self.cursor: FakeCursor | None = None

    def distinct(self, field, filter=None):
        self.distincts.append((field, filter))
        return [d.get(field) for d in self.docs]

    def find(self, query, projection=None):
        self.finds.append((query, projection or {}))
        self.cursor = FakeCursor(self.docs)
        return self.cursor

    def delete_many(self, query):
        self.deletes.append(query)

        class _R:
            deleted_count = 2

        return _R()

    def update_one(self, query, update, upsert=False):
        self.updates.append((query, update, upsert))

        class _R:
            modified_count = 1

        return _R()


@pytest.fixture
def mongo_store(monkeypatch):
    from app.store import writers

    collections: dict[str, FakeCollection] = {
        "thirteen_f_filings": FakeCollection(
            [{"accession": "A", "periodOfReport": Q1_2024, "managerCik10": BERKSHIRE}]
        ),
        "thirteen_f_holdings": FakeCollection(),
    }
    monkeypatch.setattr(writers, "collection", lambda db, logical: collections[logical])
    return MongoEvictStore(object()), collections


def test_the_production_store_sorts_ASCENDING_on_a_column_that_MOVES(mongo_store):
    """Ordering by something CONSTANT across the population hands every run the
    same first page forever (MONEY-1211); ``desc`` on a growing population is the
    same defect pointing the other way (MONEY-1255)."""
    store, collections = mongo_store

    store.evictable_filings({"tier": {"$ne": "COLD"}}, limit=200)

    filings = collections["thirteen_f_filings"]
    assert filings.cursor is not None
    assert filings.cursor.sort_spec == [("periodOfReport", 1), ("accession", 1)]
    assert filings.cursor.limit_value == 200
    query, projection = filings.finds[0]
    assert query == {"tier": {"$ne": "COLD"}}
    assert projection["managerCik10"] == 1 and projection["periodOfReport"] == 1


def test_the_production_store_deletes_by_the_prisma_unique_key(mongo_store):
    store, collections = mongo_store

    deleted = store.delete_holdings("A", [3, 4])

    assert deleted == 2
    assert collections["thirteen_f_holdings"].deletes == [
        {"accession": "A", "rowIndex": {"$in": [3, 4]}}
    ]


def test_the_production_store_never_deletes_on_an_EMPTY_index_list(mongo_store):
    """``{"rowIndex": {"$in": []}}`` matches nothing, so this is safe either way —
    but issuing it would spend a round trip per filing and read, in the log, as a
    delete that happened."""
    store, collections = mongo_store

    assert store.delete_holdings("A", []) == 0
    assert collections["thirteen_f_holdings"].deletes == []


def test_marking_COLD_is_UPDATE_ONLY(mongo_store):
    """``upsert=False``: the row is created by the 13F parser, which knows the
    manager, the period and the form. An upsert here would mint a row missing
    every one of them, and those are REQUIRED in Prisma — so the partial row
    would make every Prisma query that touched it THROW."""
    store, collections = mongo_store

    assert store.mark_cold("A", TS_EXPECTED_KEY) == 1
    query, update, upsert = collections["thirteen_f_filings"].updates[0]
    assert query == {"accession": "A"}
    assert update["$set"]["tier"] == "COLD"
    assert update["$set"]["coldPath"] == TS_EXPECTED_KEY
    assert upsert is False


def test_the_production_store_asks_mongo_for_the_in_flight_periods(mongo_store):
    store, collections = mongo_store
    cutoff = datetime(2025, 1, 15, tzinfo=UTC)

    store.in_flight_periods(cutoff)

    assert collections["thirteen_f_filings"].distincts[-1] == (
        "periodOfReport",
        {"filedAt": {"$gte": cutoff}},
    )


def test_the_handler_is_reachable_through_its_module(bucket):
    """`app/main.py` resolves `app.jobs.evict` and calls `handle(payload)`
    positionally, so the production call shape must work with no keywords."""
    from app.main import JOB_HANDLERS

    assert JOB_HANDLERS["edgar-evict"] == "app.jobs.evict"
    assert callable(evict.handle)
    assert evict.JOB_NAME == "edgar-evict"
