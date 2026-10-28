"""``/jobs/edgar-evict`` — the 13F hot/cold evictor — MONEY-979 (T9).

Every quarter, every 13F filer restates its ENTIRE portfolio. ``us_13f_holdings``
therefore grows by the whole universe four times a year and never shrinks on its
own. This job keeps a HOT WINDOW in Mongo — the two most recent report periods,
plus whatever quarter is still arriving inside the statutory 45-day deadline —
archives everything older to one gzipped-JSONL object per ``(manager, period)``,
and deletes the archived rows.

## The ordering IS the job

For each hot filing outside the window, in this order and no other:

1. **read** the existing shard,
2. **merge** this filing's rows over it and **write** it back,
3. **RE-READ the shard from GCS**,
4. **delete only** the ``(accession, rowIndex)`` rows the re-read proves are
   present,
5. set ``tier="COLD"`` and ``coldPath`` on ``us_13f_filings``.

Steps 3 and 4 are the whole design. A delete keyed off the WRITE's return code is
how a quarter of holdings disappears with nothing to notice it:
``upload_from_string`` returning without raising says the request was accepted.
It does not say the object reads back, that it landed in the bucket this process
believes it is pointed at, or that a concurrent writer did not replace it a
millisecond later. Only reading it again says that, and only about the rows that
actually came back — which is why step 4 deletes an INTERSECTION and never the
set we meant to write.

Step 1 exists for a different reason and is just as load-bearing: a GCS put
REPLACES the object, and ONE shard holds every filing for a manager-quarter (the
original 13F-HR and each amendment share a key). Writing without reading destroys
the other filings' rows and the put still returns 200.

Step 5 runs ONLY when step 4 proved every row. A filing marked COLD tells the
TypeScript reader to stop looking in Mongo (``packages/core/src/us-fundamentals/
cold-holdings.ts``), so marking it while rows are still hot and unproven would
hide them from every reader while they sat in the table.

## Nothing is deleted unless ``EDGAR_EVICT_APPLY`` is literally ``"true"``

This is the only code path in the service that DELETES stored rows. Disarmed, the
run still does the real work — it selects the filings, reads their holdings and
reports exactly how many rows a drain would move — and writes nothing, touches
no GCS object and deletes nothing. A dry run that SKIPPED the work would report a
number that means nothing, which is how a drain gets sized wrong.

The flag is compared to the literal string by :func:`app.settings.evict_apply`.
``bool("false")`` is ``True``, which would arm the one configuration meant to
keep this job off.

## The 600 s ceiling

Every job here arrives over a Pub/Sub push subscription whose ack deadline is
600 s — Pub/Sub's maximum, and always the binding constraint (Cloud Run's own
request timeout is 3600 s). A handler that runs past it is not merely slow:
Pub/Sub REDELIVERS while the first copy is still running, and a second copy of
THIS job is two writers racing on one shard. The wall budget is 420 s checked
BETWEEN filings, so the true wall is ``budget + one filing``; when it is spent
and work remains, the run publishes its own successor, bounded at 20.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from app import settings
from app.evict_logic import (
    CHAIN_TOPIC,
    FAIL_ROWS_UNPROVEN,
    FAIL_SHARD_ABSENT,
    FAIL_STORAGE,
    FAIL_UNENCODABLE_ROW,
    FILING_PAGE_SIZE,
    MAX_CHAIN_DEPTH,
    RUN_TIME_BUDGET_MS,
    SKIP_DATABASE_UNAVAILABLE,
    SKIP_WRITE_DISARMED,
    STOP_BUDGET_SPENT,
    STOP_CURSOR_STUCK,
    STOP_DRAINED,
    STOP_STORAGE_UNAVAILABLE,
    TIER_COLD,
    Cursor,
    DeletePlan,
    HotWindow,
    as_day,
    budget_exhausted,
    chain_depth,
    chunk,
    cursor_for,
    cursor_from_payload,
    evictable_query,
    filing_projection,
    holding_to_shard_row,
    hot_window,
    in_flight_cutoff,
    next_chain_payload,
    plan_deletions,
    proven_row_keys,
    readable_by_reader,
    shard_row_key,
    should_chain,
    storage_failing,
)
from app.evict_logic import (
    Row as ShardRow,
)
from app.logging_setup import log_error
from app.publish import Publisher, PublishError
from app.sec.archive_logic import ShardEncodeError, thirteenf_shard_key
from app.store.outcome import report_job_outcome

logger = logging.getLogger("us-fundamentals.evict")

JOB_NAME = "edgar-evict"

#: Logical collections this job touches. Physical names come from
#: ``app/store/collections.py``, which is the file the TypeScript prod->QA sync
#: guard parses.
FILINGS_COLLECTION = "thirteen_f_filings"
HOLDINGS_COLLECTION = "thirteen_f_holdings"


# ── Seams ───────────────────────────────────────────────────────────────────


class EvictStore(Protocol):
    """Everything this job needs from MongoDB.

    A Protocol so a test can drive the REAL :func:`handle` against an in-memory
    store. :class:`MongoEvictStore` below is the production implementation and is
    exercised separately against a collection fake, so the shipped code is not
    shadowed by the in-memory one.
    """

    def all_periods(self) -> list[Any]: ...

    def in_flight_periods(self, cutoff: datetime) -> list[Any]: ...

    def evictable_filings(
        self, query: Mapping[str, Any], *, limit: int
    ) -> list[dict[str, Any]]: ...

    def holdings_for(self, accession: str) -> list[dict[str, Any]]: ...

    def delete_holdings(self, accession: str, row_indexes: Sequence[int]) -> int: ...

    def mark_cold(self, accession: str, cold_path: str) -> int: ...


class ArchivePort(Protocol):
    """The GCS half. :mod:`app.sec.archive` satisfies this structurally."""

    def merge_and_write_shard(
        self,
        key: str,
        incoming: Sequence[Mapping[str, Any]],
        key_fn: Callable[[Mapping[str, Any]], str],
    ) -> dict[str, int]: ...

    def read_shard(self, key: str) -> Any: ...


class MongoEvictStore:
    """The production store.

    Collection handles come through ``writers.collection`` so the physical name
    and the index-ensure both stay in one place; this module never spells a
    collection name itself.
    """

    def __init__(self, db: Any) -> None:
        self._db = db

    def _filings(self) -> Any:
        from app.store import writers

        return writers.collection(self._db, FILINGS_COLLECTION)

    def _holdings(self) -> Any:
        from app.store import writers

        return writers.collection(self._db, HOLDINGS_COLLECTION)

    def all_periods(self) -> list[Any]:
        return list(self._filings().distinct("periodOfReport"))

    def in_flight_periods(self, cutoff: datetime) -> list[Any]:
        return list(self._filings().distinct("periodOfReport", {"filedAt": {"$gte": cutoff}}))

    def evictable_filings(self, query: Mapping[str, Any], *, limit: int) -> list[dict[str, Any]]:
        cursor = (
            self._filings()
            .find(dict(query), filing_projection())
            # ASCENDING, and on a column that CHANGES across the population.
            # Ordering by something constant hands every run the same first page
            # forever (MONEY-1211); `desc` on a growing population is the same
            # defect pointing the other way (MONEY-1255).
            .sort([("periodOfReport", 1), ("accession", 1)])
            .limit(limit)
        )
        return list(cursor)

    def holdings_for(self, accession: str) -> list[dict[str, Any]]:
        return list(self._holdings().find({"accession": accession}))

    def delete_holdings(self, accession: str, row_indexes: Sequence[int]) -> int:
        if not row_indexes:
            return 0
        result = self._holdings().delete_many(
            {"accession": accession, "rowIndex": {"$in": list(row_indexes)}}
        )
        return int(getattr(result, "deleted_count", 0) or 0)

    def mark_cold(self, accession: str, cold_path: str) -> int:
        """``tier=COLD`` + ``coldPath``. UPDATE-ONLY — never creates the row.

        ``upsert=False`` on purpose: the row is created by the 13F parser, which
        knows the manager, the period and the form. An upsert here would mint a
        row missing every one of them, and those are REQUIRED in Prisma — so the
        partial row would not read as incomplete, it would make every Prisma
        query that touched it THROW.
        """
        result = self._filings().update_one(
            {"accession": accession},
            {
                "$set": {
                    "tier": TIER_COLD,
                    "coldPath": cold_path,
                    "updatedAt": datetime.now(UTC),
                }
            },
            upsert=False,
        )
        return int(getattr(result, "modified_count", 0) or 0)


# ── Run state ───────────────────────────────────────────────────────────────


@dataclass
class _RunStats:
    """What actually happened. Never what the run intended to happen."""

    #: Filings selected for eviction.
    selected: int = 0
    #: Filings marked COLD — the honest ``written`` number.
    evicted: int = 0
    #: Filings that could not be completed (unproven rows, a missing shard).
    failed: int = 0
    #: Filings whose GCS call raised. A reason no rows were considered, not a row.
    transport_failures: int = 0
    rows_archived: int = 0
    rows_deleted: int = 0
    rows_unproven: int = 0
    #: Archived rows the TypeScript reader would silently drop. See
    #: `readable_by_reader` — counted, never used as a gate.
    rows_unreadable: int = 0
    reasons: dict[str, int] = field(default_factory=dict)

    def count_reason(self, reason: str) -> None:
        self.reasons[reason] = self.reasons.get(reason, 0) + 1


@dataclass
class _FilingOutcome:
    """One filing's result, as the loop needs it."""

    ok: bool
    storage_error: bool = False
    reason: str | None = None
    cold_path: str | None = None
    rows: int = 0
    deleted: int = 0
    unproven: int = 0
    unreadable: int = 0


def _default_clock() -> datetime:
    return datetime.now(UTC)


# ── Handler ─────────────────────────────────────────────────────────────────


def handle(
    payload: Mapping[str, Any] | None = None,
    *,
    store: EvictStore | None = None,
    archive: ArchivePort | None = None,
    publisher: Publisher | None = None,
    clock: Callable[[], datetime] = _default_clock,
    monotonic: Callable[[], float] = time.monotonic,
    budget_ms: float = RUN_TIME_BUDGET_MS,
    max_chain_depth: int = MAX_CHAIN_DEPTH,
    page_size: int = FILING_PAGE_SIZE,
) -> dict[str, Any]:
    """Run one eviction pass. ALWAYS returns a dict; ``app/main.py`` sends it as 200.

    The keyword arguments are the test seam and are never passed in production —
    ``main.py`` calls ``handle(payload)`` positionally. Their defaults ARE the
    production wiring, so a test that injects fakes still drives THIS function
    and not a copy of it.

    Raises only for genuinely unexpected conditions, where a 500 and a Pub/Sub
    redelivery are the right answer and the dedupe middleware stops a second copy
    running concurrently. A missing ``DATABASE_URL`` is NOT one of them: it is
    configuration, it will not become true on redelivery, and five retries into a
    dead-letter would raise an alert about the consumer for a deployment problem.
    """
    body: dict[str, Any] = dict(payload) if isinstance(payload, Mapping) else {}
    depth = chain_depth(body)
    stats = _RunStats()
    skipped_reason: str | None = None
    started = monotonic()

    def elapsed_ms() -> float:
        return (monotonic() - started) * 1000.0

    # READ PER CALL, and compared to the literal string by `settings.evict_apply`.
    # A module-level read would freeze at import and a `bool()` would arm the one
    # configuration meant to keep this job off.
    armed = settings.evict_apply()
    if not armed:
        skipped_reason = SKIP_WRITE_DISARMED

    try:
        if store is None:
            from app.db import get_database

            database = get_database()
            if database is None:
                skipped_reason = SKIP_DATABASE_UNAVAILABLE
                return {
                    "job": JOB_NAME,
                    "success": False,
                    "applied": False,
                    "skippedReason": skipped_reason,
                    "detail": "DATABASE_URL is unset or names no database",
                }
            store = MongoEvictStore(database)

        if archive is None:
            from app.sec import archive as archive_module

            archive = archive_module  # type: ignore[assignment]

        now = clock()
        window = hot_window(
            store.all_periods(),
            store.in_flight_periods(in_flight_cutoff(now)),
        )
        after = cursor_from_payload(body)

        stop_reason, after, consecutive_storage_failures = _drain(
            store=store,
            archive=archive,
            window=window,
            after=after,
            armed=armed,
            stats=stats,
            elapsed_ms=elapsed_ms,
            budget_ms=budget_ms,
            page_size=page_size,
        )

        decision = should_chain(
            work_remains=stop_reason == STOP_BUDGET_SPENT,
            depth=depth,
            max_depth=max_chain_depth,
            storage_failing=storage_failing(consecutive_storage_failures),
        )
        chained = False
        chain_error: str | None = None
        if decision.chain:
            chained, chain_error = _publish_follow_up(
                body, depth=depth, after=after, publisher=publisher
            )

        return {
            "job": JOB_NAME,
            "success": True,
            "applied": armed,
            "skippedReason": skipped_reason,
            "stopReason": stop_reason,
            "hotWindow": {
                "newest": [day.isoformat() for day in window.newest],
                "inFlight": [day.isoformat() for day in window.in_flight],
                "periods": [day.isoformat() for day in window.periods],
            },
            "selected": stats.selected,
            "evicted": stats.evicted,
            "failed": stats.failed,
            "transportFailures": stats.transport_failures,
            "rows": {
                "archived": stats.rows_archived,
                "deleted": stats.rows_deleted,
                "unproven": stats.rows_unproven,
                "unreadableByReader": stats.rows_unreadable,
            },
            "reasons": dict(stats.reasons),
            "chain": {
                "depth": depth,
                "maxDepth": max_chain_depth,
                "published": chained,
                "reason": decision.reason,
                **({"error": chain_error} if chain_error else {}),
            },
            "cursor": (
                {"afterPeriod": after.period.isoformat(), "afterAccession": after.accession}
                if after is not None
                else None
            ),
            "elapsedMs": round(elapsed_ms(), 1),
        }
    finally:
        # In a `finally` so a raising run is still measured. A job that throws
        # before reporting is invisible in exactly the dimension this metric
        # exists to measure, and `selected > 0 and written == 0` is the signal
        # that separates a healthy run from one that found work and moved none.
        report_job_outcome(
            JOB_NAME,
            stats.selected,
            stats.evicted,
            stats.failed,
            stats.transport_failures,
            skipped_reason,
        )


# ── The drain ───────────────────────────────────────────────────────────────


def _drain(
    *,
    store: EvictStore,
    archive: ArchivePort,
    window: HotWindow,
    after: Cursor | None,
    armed: bool,
    stats: _RunStats,
    elapsed_ms: Callable[[], float],
    budget_ms: float,
    page_size: int,
) -> tuple[str, Cursor | None, int]:
    """Walk evictable filings oldest-first until drained, out of budget, or stuck.

    Returns ``(stopReason, cursor, consecutiveStorageFailures)``.

    The cursor advances past every filing ATTEMPTED, not every filing that
    succeeded. That is deliberate: a filing whose shard cannot be proven stays
    HOT and would otherwise sit at the head of every page inside this run and
    starve the rest of the drain. It is retried by the NEXT scheduled run, once,
    instead of by every chained run forever.
    """
    consecutive_storage_failures = 0
    stop_reason = STOP_DRAINED

    while True:
        page = store.evictable_filings(evictable_query(window, after), limit=page_size)
        if not page:
            return stop_reason, after, consecutive_storage_failures

        page_start = after
        for filing in page:
            # BETWEEN filings, so the true wall is `budget + one filing`.
            if budget_exhausted(elapsed_ms(), budget_ms):
                return STOP_BUDGET_SPENT, after, consecutive_storage_failures

            stats.selected += 1
            outcome = _evict_one(filing, store=store, archive=archive, armed=armed)

            stats.rows_archived += outcome.rows
            stats.rows_deleted += outcome.deleted
            stats.rows_unproven += outcome.unproven
            stats.rows_unreadable += outcome.unreadable
            if outcome.reason:
                stats.count_reason(outcome.reason)
            if outcome.ok:
                stats.evicted += 1
            elif outcome.storage_error:
                stats.transport_failures += 1
            elif armed:
                # A disarmed run is not a failed one: it planned, which is all it
                # was asked to do.
                stats.failed += 1

            # Advance PAST this filing whatever happened to it, so a chain and
            # the next page both make progress.
            moved = cursor_for(filing)
            if moved is not None:
                after = moved

            if outcome.storage_error:
                consecutive_storage_failures += 1
                if storage_failing(consecutive_storage_failures):
                    logger.error(
                        "[evict] %d consecutive GCS failures — stopping without chaining",
                        consecutive_storage_failures,
                    )
                    return STOP_STORAGE_UNAVAILABLE, after, consecutive_storage_failures
            else:
                consecutive_storage_failures = 0

        if after == page_start:
            # Nothing on this page carried a usable (period, accession) pair, so
            # the next query would return it again. Terminating on a NAMED reason
            # beats spinning for the full budget and then chaining twenty copies
            # of the spin.
            logger.error(
                "[evict] resume cursor did not advance across a page of %d — stopping", len(page)
            )
            return STOP_CURSOR_STUCK, after, consecutive_storage_failures

        if len(page) < page_size:
            return stop_reason, after, consecutive_storage_failures


def _evict_one(
    filing: Mapping[str, Any],
    *,
    store: EvictStore,
    archive: ArchivePort,
    armed: bool,
) -> _FilingOutcome:
    """Archive ONE filing's holdings and delete only what the shard gives back.

    Read the module docstring before changing the order of anything below it.
    """
    accession = str(filing.get("accession") or "").strip()
    manager = str(filing.get("managerCik10") or "").strip()
    period = filing.get("periodOfReport")
    if not accession or not manager:
        return _FilingOutcome(ok=False, reason="filing-missing-key-fields")

    try:
        # THE CROSS-LANGUAGE CONTRACT. `edgar/13f/{cik10}/{YYYY-MM-DD}` in UTC,
        # built by the SHARED key builder — never spelled here. The TypeScript
        # reader computes the same key with `buildThirteenFColdKey`, and a
        # mismatch does not fail: it 404s every archived quarter, silently and
        # forever, and reports COLD_SHARD_ABSENT.
        key = thirteenf_shard_key(manager, _period_for_key(period))
    except Exception as err:
        log_error(f"[evict] {accession}: cannot build a cold key", err)
        return _FilingOutcome(ok=False, reason="unbuildable-cold-key")

    manager_name = filing.get("managerName")
    try:
        rows = [_shard_row(document, manager_name) for document in store.holdings_for(accession)]
    except Exception as err:
        log_error(f"[evict] {accession}: a holding could not be archived", err)
        return _FilingOutcome(ok=False, reason="unarchivable-holding")

    unreadable = sum(1 for row in rows if not readable_by_reader(row))

    if not armed:
        # PLANNED, not written. No GCS object is touched and nothing is deleted;
        # the row count is real because the rows were really read.
        return _FilingOutcome(
            ok=False,
            reason=SKIP_WRITE_DISARMED,
            cold_path=key,
            rows=len(rows),
            unreadable=unreadable,
        )

    try:
        # 1 + 2. READ-MERGE-WRITE. One shard holds every filing for a
        # manager-quarter, and a put REPLACES; encoding only the rows this
        # filing happens to hold would destroy the others and still return 200.
        archive.merge_and_write_shard(key, rows, shard_row_key)
        # 3. RE-READ FROM GCS. Not the merge's return value, not the bytes we
        # sent — a second read, of the same key, through the same code path a
        # reader would use. This is the only evidence that survives a write that
        # was accepted but did not land.
        verified = archive.read_shard(key)
    except ShardEncodeError as err:
        # A ROW problem, not a bucket problem, and the two must not be reported
        # as one: a non-finite number or a value that is not JSON fails every
        # retry identically, whereas a storage failure is the thing worth
        # backing off from. Folding this into the branch below would trip the
        # consecutive-storage-failure abort after three bad filings and blame
        # GCS for a parser defect.
        log_error(f"[evict] {accession}: a holding could not be encoded into {key}", err)
        return _FilingOutcome(
            ok=False,
            reason=FAIL_UNENCODABLE_ROW,
            cold_path=key,
            rows=len(rows),
            unreadable=unreadable,
        )
    except Exception as err:
        # ZERO DELETIONS. The delete is textually and causally after the
        # re-read, inside this try, so a storage failure of any kind reaches
        # here having deleted nothing.
        log_error(f"[evict] {accession}: shard write/re-read failed at {key}", err)
        return _FilingOutcome(
            ok=False,
            storage_error=True,
            reason=FAIL_STORAGE,
            cold_path=key,
            rows=len(rows),
            unreadable=unreadable,
        )

    if verified is None:
        # The write said yes and the object is not there. Absence and
        # unreadability are different values here precisely so this case can be
        # named instead of read as an empty shard.
        logger.error("[evict] %s: shard %s is ABSENT immediately after a write", accession, key)
        return _FilingOutcome(
            ok=False,
            reason=FAIL_SHARD_ABSENT,
            cold_path=key,
            rows=len(rows),
            unproven=len(rows),
            unreadable=unreadable,
        )

    plan: DeletePlan = plan_deletions(rows, proven_row_keys(getattr(verified, "rows", []) or []))

    # 4. Delete ONLY the proven rows.
    deleted = 0
    for batch in chunk(plan.row_indexes):
        deleted += store.delete_holdings(accession, list(batch))

    if not plan.complete:
        # Rows were archived that the shard did not give back. They stay HOT and
        # the filing stays HOT, so the next run merges them in again and
        # re-proves them; the run converges instead of losing them.
        logger.error(
            "[evict] %s: %d of %d rows unproven at %s — filing stays HOT",
            accession,
            len(plan.missing),
            len(rows),
            key,
        )
        return _FilingOutcome(
            ok=False,
            reason=FAIL_ROWS_UNPROVEN,
            cold_path=key,
            rows=len(rows),
            deleted=deleted,
            unproven=len(plan.missing),
            unreadable=unreadable,
        )

    # 5. Only now. A filing marked COLD tells every reader to stop looking in
    # Mongo, so it must not be marked while an unproven row is still there.
    store.mark_cold(accession, key)
    return _FilingOutcome(
        ok=True,
        cold_path=key,
        rows=len(rows),
        deleted=deleted,
        unreadable=unreadable,
    )


def _period_for_key(period: Any) -> Any:
    """The value handed to :func:`thirteenf_shard_key`.

    ``as_day`` normalises pymongo's naive UTC ``datetime`` to a calendar day; the
    key builder then validates it. Passing the raw value through when it cannot
    be read is deliberate — the builder raises with a message naming the bad
    value, which is strictly more useful than this function inventing one.
    """
    return as_day(period) or period


def _shard_row(document: Mapping[str, Any], manager_name: Any) -> ShardRow:
    """One holding as a shard line, with the manager's NAME stamped on.

    ``managerName`` is the one field here that is not on ``UsThirteenFHolding``:
    it lives on ``us_13f_filings`` and the read model
    (``UsHoldingRow.managerName``) carries it denormalised. Stamping it keeps a
    cold row SELF-DESCRIBING — ``gsutil cat … | gunzip | head -1`` must produce a
    complete, identifiable holding (MONEY-1204) — and stops a cold read showing a
    null manager where a hot read shows a name.

    It is written only when the filing HAS one: an absent field keeps whatever a
    previous write stored, while an explicit null overwrites it (four tickets in
    this repo come from the opposite arrangement).
    """
    row = holding_to_shard_row(document)
    if isinstance(manager_name, str) and manager_name.strip():
        row.setdefault("managerName", manager_name)
    return row


# ── Chaining ────────────────────────────────────────────────────────────────


def _publish_follow_up(
    body: Mapping[str, Any],
    *,
    depth: int,
    after: Cursor | None,
    publisher: Publisher | None,
) -> tuple[bool, str | None]:
    """Publish this run's successor. Returns ``(published, error)``.

    A publish failure is REPORTED, not raised. The work this run did is already
    done and already durable; taking the route to 500 would have Pub/Sub
    redeliver a message whose filings are archived and deleted, and the dedupe
    lease is the only thing between that and a second pass over the same shards.
    The next scheduled run picks the drain up from the same place regardless —
    the cursor is an optimisation, not the state.
    """
    payload = next_chain_payload(body, depth=depth, after=after)
    try:
        target = publisher if publisher is not None else Publisher()
        target.publish(CHAIN_TOPIC, payload)
    except PublishError as err:
        log_error("[evict] could not publish the follow-up run", err)
        return False, type(err).__name__
    except Exception as err:  # pragma: no cover - defensive; Publisher wraps its own
        log_error("[evict] unexpected failure publishing the follow-up run", err)
        return False, type(err).__name__
    return True, None
