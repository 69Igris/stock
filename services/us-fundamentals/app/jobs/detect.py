"""``/jobs/edgar-detect`` — the loop that notices a filing exists — MONEY-979.

Five modes on one route and one topic. The first two are the same job asked at
two cadences; the other three are maintenance passes over the ledger, and they
are here rather than on routes of their own for a reason that is structural:
``setup-pubsub.sh`` builds each push endpoint as ``${SERVICE_URL}/jobs/${TOPIC}``,
so a new topic costs a new route, a new subscription, a new ``PUBSUB_TOPICS``
entry and a new dead-letter path — four places to get right for two schedules
that share this job's store, its cursor collection and its disarm flag.

* default (minutely) — walk ``browse-edgar?action=getcurrent`` newest-first
  until the cursor, classify each filing, claim it in ``us_filings``, publish it
  to its parser topic, advance the cursor, record how stale it was.
* ``{"mode": "efts"}`` (hourly) — sweep ``efts.sec.gov`` by date range per form
  class and store anything the live walk never saw. The rolling Atom window is
  the fast path and it is lossy; this is the net under it, and the nightly
  ``submissions.zip`` ledger is the net under that.
* ``{"mode": "full-index"}`` (Saturday) — diff a window of ``us_filings``
  against SEC's quarterly full-index REBUILD, which is the only artefact that
  reflects post-acceptance deletions. Marks the vanished ones ``WITHDRAWN`` and
  counts — separately — the ones the rebuild lists that we never stored.
* ``{"mode": "cusip-sweep"}`` (nightly) — re-run the four-tier CUSIP resolver
  over the least-recently-tried ``UNRESOLVED`` rows in ``us_cusip_map``. Touches
  sec.gov ZERO times: three tiers are Mongo reads, one is a GCS object, and
  OpenFIGI is a separate host behind its own pacer.
* ``{"mode": "event-backfill", "since": "<ISO>"}`` (one-off, MONEY-1532) —
  re-emit the ``InstrumentEvent`` of every filing a detector CLAIMED since
  ``since``, from ``us_filings`` alone. Touches sec.gov ZERO times. It exists
  because the claim is consumed whether or not the emit lands: every filing
  claimed while ``us-filing-events-{env}`` was missing kept its row and lost its
  event, and no re-run of the walk will ever re-claim it.

## The ordering that makes the fan-out exactly-once-ish

``us_filings.accession`` is UNIQUE, and the insert is the CLAIM. The sequence is
route -> insert -> publish -> advance cursor, and every step is deliberate:

* **route before insert.** ``topic_for`` is what decides whether a parser is
  coming, so it decides the STATUS the row is created with — ``DETECTED`` when a
  message is about to go out, ``NO_PARSER`` when the class is routed nowhere.
  The insert is the only write this job makes to a claimed row, so a status
  decided afterwards would either cost a second round trip per filing or leave
  the row claiming a parser that will never arrive. It did the latter until
  MONEY-1303: every ``OTHER`` filing was stored ``DETECTED`` for good, which
  made a permanently-unparseable row and a genuinely stalled parse queue the
  same query.

* **insert before publish.** A duplicate-key error is how a second detector — a
  redelivery, an overlapping minutely run, the hourly reconcile — learns the
  filing is already someone else's. It skips rather than republishing. Publishing
  first would fan the same 13F out twice on every overlap.
* **stop the fan-out at the FIRST publish failure.** The alternative is to carry
  on and strand a row per remaining filing, because a claimed row whose message
  never went out is not retried by anything in this job. Stopping leaves the
  remainder UN-inserted, so the next run re-walks them cleanly, and leaves
  exactly one row marked ``status: FAILED`` with :data:`PUBLISH_FAILED_PREFIX`
  in ``error`` for a human or the nightly ledger to re-drive.
* **advance the cursor last, and only past filings that were handed off.**
  ``next_cursor`` puts it strictly older than every failure. A cursor advanced
  before the publish does not lose a retry, it loses the filing.

## Why a rate block is carried in the cursor and not in a sleep

``SecClient`` answers a rate block by sleeping SEC's documented 600 s and then
re-raising. That is right for a batch job and wrong here: Pub/Sub's push ack
deadline is 600 s, so a handler that sleeps it out guarantees a REDELIVERY, and
the redelivered copy would go straight back to SEC. So this job injects a sleep
that does not sleep, and instead writes ``meta.blockedUntil`` onto its cursor
row; the next run reads it and skips with a named reason. The cooldown then
spans runs — which is the only place it can do any good, since the block is
measured at SEC's edge across the whole fleet and one process going quiet for
ten minutes while the schedule fires nine more times achieves nothing.

## What this job does NOT do

It never DELETES. The 13F evictor is the only path in this service that removes
stored rows, and keeping that true is what makes ``EDGAR_EVICT_APPLY`` a
meaningful arm. So a publish failure is marked, not rolled back — and a
withdrawn filing is STAMPED, not removed, which is also what lets a mistaken
withdrawal be undone by hand.

The full-index mode does not fan the gaps it finds out to the parsers either.
Publishing them would make one job both the reconciler and a second detector,
racing the minutely walk on the same claim; and the gap population is already
covered by the nightly ``submissions.zip`` ledger, which is the authoritative
third net. This pass exists to MEASURE that the first two nets are working, so
it counts and reports rather than quietly papering over the count.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from itertools import batched
from typing import Any, Protocol
from urllib.parse import urlencode

from bson import ObjectId
from pymongo import ASCENDING
from pymongo.errors import DuplicateKeyError

from app import settings
from app.classify import classify_form, topic_for
from app.detect_logic import (
    CUSIP_SWEEP_BATCH,
    EFTS_FORMS_BY_PARSE_CLASS,
    EFTS_LOOKBACK_MINUTES,
    EFTS_MAX_PAGES,
    EFTS_PAGE_SIZE,
    FULL_INDEX_GAP_SAMPLE,
    FULL_INDEX_MAX_QUARTERS,
    FULL_INDEX_MAX_WINDOW_DAYS,
    FULL_INDEX_SETTLE_DAYS,
    FULL_INDEX_WINDOW_DAYS,
    MAX_PAGES,
    PAGE_SIZE,
    RUN_TIME_BUDGET_SECONDS,
    SKIP_WRITE_DISARMED,
    STOP_BUDGET_SPENT,
    STOP_EVIDENCE_INCOMPLETE,
    STOP_PUBLISH_FAILED,
    STOP_WITHDRAWAL_SHARE_IMPLAUSIBLE,
    DetectCursor,
    FanOutResult,
    Quarter,
    coerce_positive_int,
    detect_latency_seconds,
    efts_primary_cik10,
    efts_window,
    event_backfill_window,
    full_index_window,
    next_cursor,
    plan_efts_reconcile,
    plan_full_index_reconcile,
    plan_page_walk,
    quarters_between,
    should_chain,
    sweep_batch_size,
    to_eastern,
    withdrawal_is_plausible,
)
from app.events import EVENTS_TOPIC, MAX_FILINGS_PER_REQUEST, EmitResult, build_requests
from app.publish import Publisher, PublishError, build_parse_message, iso_timestamp
from app.sec.adapter_types import CurrentFilingEntry, DailyIndexRow, EftsHit
from app.sec.client import SecClient
from app.sec.edgar_adapter import (
    json_loads,
    parse_current_filings_atom,
    parse_daily_index,
    parse_efts_response,
)
from app.sec.errors import (
    SecEgressDisabled,
    SecError,
    SecIdentityRejected,
    SecRateLimited,
    SecTransportError,
)
from app.store import models, writers
from app.store.models import UsEdgarCursorRow, UsFilingRow
from app.store.outcome import record_latency, report_job_outcome

logger = logging.getLogger("us-fundamentals.detect")

#: Name reported to Datadog and printed in the outcome line. Equals the topic
#: base name and the route path.
JOB_NAME = "edgar-detect"

MODE_ATOM = "atom"
MODE_EFTS = "efts"
MODE_FULL_INDEX = "full-index"
MODE_CUSIP_SWEEP = "cusip-sweep"
MODE_EVENT_BACKFILL = "event-backfill"

#: Every mode this route accepts. Anything else is a NAMED skip rather than a
#: silent default: a scheduler row with a typo'd mode must not quietly run the
#: minutely Atom walk on a weekly trigger.
MODES: tuple[str, ...] = (
    MODE_ATOM,
    MODE_EFTS,
    MODE_FULL_INDEX,
    MODE_CUSIP_SWEEP,
    MODE_EVENT_BACKFILL,
)

#: ``us_edgar_cursor.key`` for each mode. One row each, because the modes have
#: independent positions and independent cooldowns — a block the minutely walk
#: hit must not make the hourly reconcile look healthy by borrowing its state.
CURSOR_KEY_ATOM = "getcurrent"
CURSOR_KEY_EFTS = "efts"
CURSOR_KEY_FULL_INDEX = "full-index"
CURSOR_KEY_CUSIP_SWEEP = "cusip-sweep"
CURSOR_KEY_EVENT_BACKFILL = "event-backfill"

CURSOR_KEYS: dict[str, str] = {
    MODE_ATOM: CURSOR_KEY_ATOM,
    MODE_EFTS: CURSOR_KEY_EFTS,
    MODE_FULL_INDEX: CURSOR_KEY_FULL_INDEX,
    MODE_CUSIP_SWEEP: CURSOR_KEY_CUSIP_SWEEP,
    MODE_EVENT_BACKFILL: CURSOR_KEY_EVENT_BACKFILL,
}

#: The Atom feed. ``type=`` is IGNORED server-side on a single page, so it is not
#: sent; classification happens here instead. There is no ``rel=next`` link
#: either — paging is ``start`` stepping by ``count``.
GETCURRENT_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar"
    "?action=getcurrent&count={count}&start={start}&output=atom"
)

EFTS_URL = "https://efts.sec.gov/LATEST/search-index"

#: A quarterly ``form.idx`` is ~185 MB of text (63 dissemination days x the
#: 2.93 MB measured on the captured 2022-02-14 daily file). Parsing it in one
#: call costs ~800 MB of ``DailyIndexRow`` objects — measured at 127 MB per
#: 194,120 rows — which does not fit a 2Gi container running four requests.
#:
#: So the body is walked in line CHUNKS and each chunk is handed to the SAME
#: ``parse_daily_index`` the daily files go through, reused verbatim rather than
#: re-implemented. That reuse works because the parser skips its preamble on the
#: first line beginning ``---`` rather than on a line count, so
#: :data:`INDEX_CHUNK_PREFIX` in front of a chunk is all it needs; header lines
#: caught in the first chunk simply fail the row regex and are dropped, exactly
#: as they are in a whole-file parse.
FULL_INDEX_CHUNK_LINES = 20_000
INDEX_CHUNK_PREFIX = "---\n"

#: A quarterly index is two orders of magnitude larger than an Atom page, and
#: ``SecClient``'s 30 s default is sized for the latter.
FULL_INDEX_TIMEOUT_SECONDS = 300.0

#: Accessions per ``update_many`` when stamping WITHDRAWN. An unbounded ``$in``
#: is a single 16 MB-limited BSON document and roughly 165,000 accessions would
#: not fit one.
WITHDRAW_CHUNK = 1000

#: SEC's documented remedy for a rate block: ten minutes below the threshold.
BLOCK_COOLDOWN_SECONDS = 600.0

#: Prefix on ``us_filings.error`` for a row that was claimed but never fanned
#: out. Named so the recovery query is exact:
#: ``{status: "FAILED", parsedAt: null, error: /^publish-failed/}``.
PUBLISH_FAILED_PREFIX = "publish-failed: "

#: How far a claimed row's ``_id`` may sit from its ``detectedAt``, as used by
#: :meth:`MongoFilingStore.filings_detected_between`. The claim stamps
#: ``detectedAt`` and pymongo mints the ObjectId inside the ``insert_one`` that
#: follows, in the same process on the same clock. Measured on prod 2026-09-23
#: over all 42,071 Atom-claimed rows — selected through the ``acceptedAt`` index,
#: so the measurement does not assume its own answer — the gap is -999 ms to
#: +4 ms (the ObjectId keeps whole seconds). An hour is margin for a slow first
#: insert, and costs only the unclaimed rows inserted in it.
CLAIM_ID_SLACK = timedelta(hours=1)

#: The ``us_filings`` fields :func:`app.events.build_filing_payload` reads.
EVENT_BACKFILL_PROJECTION: dict[str, int] = {
    "_id": 0,
    "accession": 1,
    "cik10": 1,
    "form": 1,
    "items": 1,
    "acceptedAt": 1,
    "filedAt": 1,
    "detectedAt": 1,
}

#: ``us_filings.status``. Aliased from ``app.store.models`` rather than spelled
#: again: the parsers stamp the same column and a second copy of the vocabulary
#: is how one writer's "PARSED" becomes another's "parsed".
STATUS_DETECTED = models.STATUS_DETECTED
STATUS_FAILED = models.STATUS_FAILED
STATUS_NO_PARSER = models.STATUS_NO_PARSER
STATUS_WITHDRAWN = models.STATUS_WITHDRAWN

#: Named skips. Each is a distinct operational situation and none of them is a
#: failure — which is precisely why they are reported through
#: ``skipped_reason`` rather than as a zero-write success (a job that writes
#: nothing because it was told not to run must not look like a job that writes
#: nothing because its upstream is dark).
SKIP_FLAG_OFF = "EDGAR_DETECT-not-on"
SKIP_IDENTITY_MISSING = "EDGAR_IDENTITY-missing"
SKIP_DATABASE_UNAVAILABLE = "database-unavailable"
SKIP_COOLDOWN = "sec-block-cooldown"
SKIP_UNKNOWN_MODE = "unknown-mode"
#: An ``event-backfill`` message whose ``since`` was refused — unparseable,
#: older than the serving window, or not in the past. The reason rides in ``detail``.
SKIP_BACKFILL_WINDOW = "event-backfill-window-refused"

#: Stop reasons that come from the SEC client rather than from the walk.
STOP_EGRESS_DISABLED = "sec-egress-disabled"
STOP_IDENTITY_REJECTED = "sec-identity-rejected"
STOP_RATE_LIMITED = "sec-rate-limited"
STOP_TRANSPORT_ERROR = "sec-transport-error"
STOP_SEC_ERROR = "sec-error"


# ── The store seam ──────────────────────────────────────────────────────────


class FilingStore(Protocol):
    """Everything this job needs from MongoDB.

    A PROTOCOL rather than a direct pymongo dependency, so the fan-out ordering
    — claim, publish, mark, advance — is driven end to end by a test with a fake
    that has real unique-index semantics.
    """

    def claim_filing(self, document: dict[str, Any]) -> bool:
        """Insert if absent. ``True`` when THIS call created the row."""

    def mark_publish_failed(self, accession: str, error: str) -> None: ...

    def known_accessions(self, accessions: Sequence[str]) -> set[str]: ...

    def accessions_filed_between(self, start: date, end: date) -> list[str]:
        """Accessions with ``filedAt`` in ``[start, end]``, EXCLUDING WITHDRAWN ones."""

    def mark_withdrawn(self, accessions: Sequence[str], *, now: datetime) -> int:
        """Stamp ``status = WITHDRAWN``. UPDATE-ONLY. Returns rows modified."""

    def filings_detected_between(self, start: datetime, end: datetime) -> Iterable[dict[str, Any]]:
        """Rows a detector CLAIMED with ``detectedAt`` in ``[start, end)``, oldest first."""

    def read_cursor(self, key: str) -> dict[str, Any] | None: ...

    def write_cursor(
        self,
        key: str,
        *,
        cursor: DetectCursor | None,
        last_run_at: datetime,
        meta: dict[str, Any] | None = None,
    ) -> None: ...


class MongoFilingStore:
    """The production :class:`FilingStore`, over ``app.store.writers``.

    Three of the five operations are ``writers``' own functions, and the fourth
    borrows its collection handle from ``writers.collection`` — which ensures
    the UNIQUE index on ``accession`` before returning. That is not tidiness:
    the claim below IS the unique index, so on a fresh cluster where nobody has
    run ``prisma db push`` yet, an unindexed collection would accept every
    insert, ``claim_filing`` would answer ``True`` for a filing another run
    already owns, and detection would fan the same filing out repeatedly with
    nothing reporting it.

    ``claim_filing`` is the one operation NOT delegated, because
    ``writers.upsert_filings`` cannot express it and must not be bent into it:

    * an upsert cannot report "someone else already owns this row", which is the
      only signal that stops a second detector republishing;
    * ``bulk_upsert`` routes everything but ``status``/``detectedAt`` through
      ``$set``, so upserting a detection row over an existing one would BLANK a
      parser's ``rawPath``, ``parserVersion`` and ``parsedAt`` with the nulls a
      detector legitimately has.
    """

    def __init__(self, database: Any) -> None:
        self._db = database

    def claim_filing(self, document: dict[str, Any]) -> bool:
        """``True`` when we inserted, ``False`` when the accession already existed.

        Catching the driver's duplicate-key error is not error handling here —
        it IS the concurrency protocol, and it is the only step in the fan-out
        that two runs can race on safely.
        """
        try:
            writers.collection(self._db, "filings").insert_one(document)
        except DuplicateKeyError:
            return False
        return True

    def mark_publish_failed(self, accession: str, error: str) -> None:
        # UPDATE-ONLY (`upsert=False` inside `mark_filing_status`). The row was
        # created by the claim a moment ago; an upsert here could create a
        # partial row with no `form`/`filedAt`/`parseClass`, all of which are
        # REQUIRED in Prisma — so it would not read as incomplete, it would make
        # every Prisma query that touched it throw.
        writers.mark_filing_status(self._db, accession, STATUS_FAILED, error=error)

    def known_accessions(self, accessions: Sequence[str]) -> set[str]:
        wanted = [value for value in accessions if value]
        if not wanted:
            return set()
        rows = writers.collection(self._db, "filings").find(
            {"accession": {"$in": wanted}}, {"accession": 1}
        )
        return {row["accession"] for row in rows if row.get("accession")}

    def accessions_filed_between(self, start: date, end: date) -> list[str]:
        """The full-index reconcile's stored population for one window.

        ``filedAt`` is a DATE column stored as UTC midnight — ``models._coerce``
        is the single place that conversion happens, and the bounds are built
        the same way here rather than by passing ``date`` objects the driver
        would encode differently.

        Rows already ``WITHDRAWN`` are excluded, so a filing stays marked once
        instead of being re-counted as a fresh withdrawal by every weekly run —
        which would make ``written`` report the same rows forever and hide the
        moment real withdrawals stop arriving. ``status`` is REQUIRED and
        written by every path that creates one of these rows, so ``$ne`` is safe
        on it; it would not be on a nullable column, where absent is not null.
        """
        first = datetime(start.year, start.month, start.day, tzinfo=UTC)
        last = datetime(end.year, end.month, end.day, tzinfo=UTC)
        rows = writers.collection(self._db, "filings").find(
            {
                "filedAt": {"$gte": first, "$lte": last},
                "status": {"$ne": STATUS_WITHDRAWN},
            },
            {"accession": 1},
        )
        return [row["accession"] for row in rows if row.get("accession")]

    def mark_withdrawn(self, accessions: Sequence[str], *, now: datetime) -> int:
        """``update_many``, chunked, NEVER an upsert.

        ``upsert=True`` here would create a row carrying only ``accession``,
        ``status`` and ``updatedAt`` for any accession that had meanwhile been
        deleted — and ``form`` / ``filedAt`` / ``parseClass`` are REQUIRED in
        Prisma, so that row would not read as incomplete, it would make every
        Prisma query touching it THROW.

        ``update_many`` rather than a loop of ``mark_filing_status`` calls
        because the population can be thousands and each of those is a separate
        round trip; the trade is that this does not stamp ``error``, which a
        withdrawal has nothing to say about anyway.
        """
        wanted = [value for value in accessions if value]
        if not wanted:
            return 0
        target = writers.collection(self._db, "filings")
        modified = 0
        for index in range(0, len(wanted), WITHDRAW_CHUNK):
            batch = wanted[index : index + WITHDRAW_CHUNK]
            result = target.update_many(
                {"accession": {"$in": batch}},
                {"$set": {"status": STATUS_WITHDRAWN, "updatedAt": now}},
            )
            modified += int(getattr(result, "modified_count", 0) or 0)
        return modified

    def filings_detected_between(self, start: datetime, end: datetime) -> Iterable[dict[str, Any]]:
        """The ``event-backfill`` population, oldest ``detectedAt`` first.

        ## ``detectedAt`` IS THE WHOLE SELECTION, AND IT IS EXACT

        Only :func:`_fan_out`'s claim writes ``detectedAt`` (grep: no other
        writer in either language). The two other paths that CREATE rows — the
        ``submissions.zip`` ledger and the ownership backfill — leave it absent,
        and ``upsert_filings`` makes it insert-only so neither can restate it.
        So "has a ``detectedAt``" is exactly "a detector claimed it", which is
        exactly what the live path emits for — every form, every status. No
        ``form`` / ``status`` filter, on purpose: 21,441 of 36,459 claims since
        2026-09-01 were ``OTHER`` (stored ``NO_PARSER``) and the live path emitted
        every one of them. Full-index and cusip-sweep never claim, so they never
        emitted anything to mirror.

        ## WHY IT IS ALSO BOUNDED ON ``_id``

        ``us_filings`` is 18.8M rows / 6.5 GB (prod, 2026-09-23) and has NO index
        on ``detectedAt``, so the bare predicate is a collection scan. The claim
        mints its ObjectId in the same process within milliseconds of stamping
        ``detectedAt`` (:data:`CLAIM_ID_SLACK`), so an ``_id`` range padded by
        that slack contains every claimed row of the window, and the ALWAYS-
        present ``_id_`` index serves it. Measured over the ticket's window
        (``detectedAt >= 2026-09-22``): 2,323 keys examined, 2,184 returned —
        the ticket's own count — in 5 ms, against 18.8M for the scan.

        ``hint`` rather than trust: with no ``detectedAt`` index the planner's
        only alternative is that scan, and a hint makes the plan a fact of this
        code rather than of the planner's cache. The sort is in memory over the
        window alone (bounded by ``EVENT_BACKFILL_MAX_AGE_DAYS``: ~42k rows today).
        """
        return (
            writers.collection(self._db, "filings")
            .find(
                {
                    "_id": {
                        "$gte": ObjectId.from_datetime(start - CLAIM_ID_SLACK),
                        "$lt": ObjectId.from_datetime(end + CLAIM_ID_SLACK),
                    },
                    "detectedAt": {"$gte": start, "$lt": end},
                },
                EVENT_BACKFILL_PROJECTION,
            )
            .sort("detectedAt", ASCENDING)
            .hint([("_id", ASCENDING)])
        )

    def read_cursor(self, key: str) -> dict[str, Any] | None:
        return writers.read_cursor(self._db, key)

    def write_cursor(
        self,
        key: str,
        *,
        cursor: DetectCursor | None,
        last_run_at: datetime,
        meta: dict[str, Any] | None = None,
    ) -> None:
        """Record the run, and the position only when there IS a new position.

        ``Row.to_doc()`` omits ``None`` fields, so a ``cursor`` of ``None``
        leaves ``lastAccession`` / ``lastAcceptedAt`` out of the ``$set``
        entirely and the stored position survives. That is load-bearing rather
        than incidental: ``next_cursor`` returns ``None`` on a run that may not
        advance, and writing that through as a null would reset detection to the
        start of the rolling feed.
        """
        writers.upsert_cursor(
            self._db,
            UsEdgarCursorRow(
                key=key,
                lastAccession=cursor.last_accession if cursor else None,
                lastAcceptedAt=cursor.last_accepted_at if cursor else None,
                lastRunAt=last_run_at,
                meta=meta,
                createdAt=last_run_at,
                updatedAt=last_run_at,
            ),
        )


# ── Run bookkeeping ─────────────────────────────────────────────────────────


@dataclass
class _RunStats:
    """Counters. Every one of them is incremented AFTER the call it counts.

    ``stock-document-sync`` incremented per-source counters BEFORE the call, so
    a source that 403-ed on every request still reported a full-looking number
    and hid an egress block for five months (MONEY-1255).
    """

    selected: int = 0
    written: int = 0
    failed: int = 0
    transport_failures: int = 0
    duplicates: int = 0
    published: int = 0
    #: Rows stored :data:`STATUS_NO_PARSER` — claimed, and deliberately routed
    #: nowhere. Counted rather than left to be inferred from
    #: ``written - published``: that subtraction is also what a stopped fan-out
    #: looks like, and the two must not read the same.
    no_parser: int = 0
    pages_fetched: int = 0
    entries_seen: int = 0
    repeats_collapsed: int = 0
    hits_seen: int = 0
    reconciled_missing: int = 0
    index_rows_seen: int = 0
    quarters_fetched: int = 0
    #: MONEY-1507 (C1) — the `us_filings` documents this run actually CLAIMED,
    #: for one batched publish to `us-filing-events-{env}` after the walk.
    #:
    #: Collected rather than emitted inline, and the difference is the whole
    #: point: the fan-out's job is to claim and publish before the Atom window
    #: rolls, and an HTTP call per filing would put an unbounded number of
    #: network round trips inside a budget that is already 420s of a 600s ack
    #: deadline. A DUPLICATE claim is deliberately NOT collected — another run
    #: owns that filing and has already emitted it, and the event id is
    #: deterministic anyway, so a second emission would be a redundant upsert.
    claimed_documents: list[dict[str, Any]] = field(default_factory=list)
    by_class: dict[str, int] = field(default_factory=dict)
    latencies: list[float] = field(default_factory=list)

    def count_class(self, parse_class: str) -> None:
        self.by_class[parse_class] = self.by_class.get(parse_class, 0) + 1

    def latency_summary(self) -> dict[str, Any]:
        if not self.latencies:
            return {"count": 0, "min": None, "max": None}
        return {
            "count": len(self.latencies),
            "min": round(min(self.latencies), 3),
            "max": round(max(self.latencies), 3),
        }


def _default_clock() -> datetime:
    return datetime.now(UTC)


def _suppressed_sleep(seconds: float) -> None:
    """The ``sleep`` injected into :class:`SecClient`. It does not sleep.

    ``SecClient`` sleeps SEC's documented 600 s cooldown before re-raising a
    rate block, which is correct in a Cloud Run JOB and fatal in a push handler:
    600 s IS the Pub/Sub ack deadline, so the sleep guarantees a redelivery that
    goes straight back to the blocked host. The cooldown is not skipped — it is
    MOVED, onto the cursor row, where it spans runs instead of one handler.
    """
    logger.warning(
        "[detect] suppressing a %.0fs in-handler SEC cooldown; carried on the cursor instead",
        seconds,
    )


def _emit_events(publisher: Publisher, documents: Sequence[dict[str, Any]]) -> EmitResult:
    """Publish this run's claimed filings to ``us-filing-events-{env}``. NEVER raises.

    ## THE CALL SITE LIVES HERE, AND THAT IS LOAD-BEARING

    `topic-publisher-coverage.test.ts` credits a Python topic only when a real
    ``x.publish(...)`` call site **inside a `jobs/` module** has a first argument
    that resolves to it. That is not an accident of the scan: its previous two
    versions were satisfied by `app/classify.py`, a MAPPING TABLE that issues no
    publish, so deleting the actual fan-out left every `edgar-parse-*` topic
    credited and the suite green. Keeping this loop in `app/events.py` — a
    module `jobs/` merely imports — would put `us-filing-events` back in exactly
    that blind spot, one ticket after a transport failed silently for hours.

    ## WHY IT IS NOT FAIL-HARD, AND WHY THAT IS NOT THE OLD BUG

    The detect loop's product is the CLAIM. An events outage must not stop a
    walk whose Atom window rolls in minutes and whose misses are unrecoverable —
    which is the same reason `_fan_out` stops at the first PARSE publish failure
    rather than raising. What MONEY-1520 changed is that the count now reaches
    `stats.failed`, so the run reports it.

    Unlike the parse leg there is nothing to mark on the row and nothing to
    re-walk: the event is a DERIVED PROJECTION of the `us_filings` row, keyed on
    an id that is `sha1(source + NUL + accession)`. The claim is consumed either
    way and a repeat claim is never re-emitted, so nothing in the WALK recovers a
    dropped event; `{"mode": "event-backfill"}` does (MONEY-1532), re-deriving it
    from the row onto the identical id — through this same function, so the two
    paths cannot disagree about a payload. This paragraph said "a backfill
    re-derives any dropped event" for two releases before one existed.

    Every message is attempted even after one fails. The parse leg stops on
    purpose (a second message for a filing whose first may still be in flight is
    how one 13F becomes two parses); here the messages are disjoint batches of
    DIFFERENT filings, so stopping would drop filings the next failure never
    touched.
    """
    if not documents:
        return EmitResult(skipped_reason="no-filings")
    bodies = build_requests(documents)
    if not bodies:
        # Every document was undescribable — no accession or no CIK. A real
        # state with a real cause, and one that a bare zero would hide behind
        # "quiet minute" (MONEY-1278).
        return EmitResult(skipped_reason="no-describable-filings")

    sent = 0
    failed = 0
    reason: str | None = None
    for body in bodies:
        count = len(body["filings"])
        try:
            publisher.publish(EVENTS_TOPIC, body)
            sent += count
        except PublishError as err:
            # `PublishError`'s message is built by `app.publish` from the topic
            # PATH and the inner exception's TYPE, so it is safe to log whole —
            # and the topic path is the one detail worth having, because the
            # failure this replaced was a message reaching the wrong
            # destination.
            failed += count
            reason = reason or "publish-failed"
            logger.error("[events] publish failed for %d filings: %s", count, err)
        except Exception as err:  # fail-soft by contract
            # TYPE only, never the exception: `PublisherClient()` resolves
            # Application Default Credentials on first use and google-auth puts
            # the whole request, credentials included, into its own `str()`.
            failed += count
            reason = reason or f"publish-{type(err).__name__}"
            logger.error("[events] publish raised %s for %d filings", type(err).__name__, count)
    return EmitResult(sent=sent, failed=failed, skipped_reason=reason)


# ── Handler ─────────────────────────────────────────────────────────────────


def handle(
    payload: dict[str, Any] | None = None,
    *,
    store: FilingStore | None = None,
    sec_client: SecClient | None = None,
    publisher: Publisher | None = None,
    cusip_sources: Any | None = None,
    openfigi: Any | None = None,
    ftd_lookup: Any | None = None,
    cusip_writer: Any | None = None,
    clock: Callable[[], datetime] = _default_clock,
    monotonic: Callable[[], float] = time.monotonic,
    budget_seconds: float = RUN_TIME_BUDGET_SECONDS,
    max_pages: int = MAX_PAGES,
) -> dict[str, Any]:
    """Run one detection pass. ALWAYS returns a dict; ``app/main.py`` sends it as 200.

    The keyword arguments are the test seam and are never passed in production —
    ``main.py`` calls ``handle(payload)`` positionally. Their defaults ARE the
    production wiring, so a test that injects fakes still drives this function
    and not a copy of it. ``cusip_sources`` / ``openfigi`` / ``ftd_lookup`` /
    ``cusip_writer`` are the ``cusip-sweep`` mode's four seams and are ignored by
    every other mode.

    Raises only for genuinely unexpected conditions (a Mongo outage, a bug),
    where a 500 and a Pub/Sub redelivery are the right answer and the dedupe
    middleware stops a second copy running concurrently. Every SEC failure class
    is handled, named and returned as a 200: a redelivery into a rate block or
    an identity rejection makes both of them worse.
    """
    payload = payload if isinstance(payload, dict) else {}
    mode = str(payload.get("mode") or MODE_ATOM).strip().lower()

    stats = _RunStats()
    skipped_reason: str | None = None
    started = monotonic()
    owns_client = sec_client is None

    def elapsed() -> float:
        return monotonic() - started

    try:
        if not settings.detect_enabled():
            skipped_reason = SKIP_FLAG_OFF
            return _skipped(
                mode,
                skipped_reason,
                elapsed(),
                flag=settings.flag_state("EDGAR_DETECT"),
            )

        if mode not in MODES:
            skipped_reason = f"{SKIP_UNKNOWN_MODE}:{mode}"
            return _skipped(mode, skipped_reason, elapsed())

        if store is None:
            from app.db import get_database

            database = get_database()
            if database is None:
                skipped_reason = SKIP_DATABASE_UNAVAILABLE
                raise RuntimeError(
                    "no Mongo database available; detection cannot claim filings and must not "
                    "publish work it has not recorded"
                )
            store = MongoFilingStore(database)

        now = clock()
        cursor_doc = store.read_cursor(CURSOR_KEYS[mode])

        blocked_until, block_reason = _cooldown(cursor_doc, now)
        if blocked_until is not None:
            skipped_reason = SKIP_COOLDOWN
            return _skipped(
                mode,
                skipped_reason,
                elapsed(),
                blockedUntil=iso_timestamp(blocked_until),
                blockReason=block_reason,
            )

        # BEFORE the SEC client, because this mode never opens a socket to
        # sec.gov and building one requires EDGAR_IDENTITY. Ordering it after
        # would make an unset identity skip a job that does not need it.
        if mode == MODE_CUSIP_SWEEP:
            outcome = _run_cusip_sweep(
                store=store,
                stats=stats,
                payload=payload,
                sources=cusip_sources,
                openfigi=openfigi,
                ftd_lookup=ftd_lookup,
                writer=cusip_writer,
                clock=clock,
                elapsed=elapsed,
            )
            skipped_reason = outcome.get("skippedReason")
            return outcome

        # Same reason: it reads `us_filings` and publishes, and never needs
        # EDGAR_IDENTITY or a socket to sec.gov.
        if mode == MODE_EVENT_BACKFILL:
            if publisher is None:
                publisher = Publisher()
            outcome = _run_event_backfill(
                store=store,
                publisher=publisher,
                stats=stats,
                payload=payload,
                now=now,
                clock=clock,
                elapsed=elapsed,
                budget_seconds=budget_seconds,
            )
            skipped_reason = outcome.get("skippedReason")
            return outcome

        if sec_client is None:
            try:
                sec_client = SecClient.from_settings(sleep=_suppressed_sleep)
            except ValueError:
                skipped_reason = SKIP_IDENTITY_MISSING
                return _skipped(mode, skipped_reason, elapsed())

        # Also before the Publisher: the full-index reconcile fans nothing out,
        # and `Publisher()` resolves GCP_PROJECT_ID on first use.
        if mode == MODE_FULL_INDEX:
            outcome = _run_full_index(
                store=store,
                sec_client=sec_client,
                stats=stats,
                payload=payload,
                clock=clock,
                elapsed=elapsed,
                budget_seconds=budget_seconds,
            )
            skipped_reason = outcome.get("skippedReason")
            return outcome

        if publisher is None:
            publisher = Publisher()

        if mode == MODE_ATOM:
            return _run_atom(
                store=store,
                sec_client=sec_client,
                publisher=publisher,
                stats=stats,
                cursor_doc=cursor_doc,
                clock=clock,
                elapsed=elapsed,
                budget_seconds=budget_seconds,
                max_pages=max_pages,
            )
        return _run_efts(
            store=store,
            sec_client=sec_client,
            publisher=publisher,
            stats=stats,
            clock=clock,
            elapsed=elapsed,
            budget_seconds=budget_seconds,
        )
    finally:
        # MONEY-1507 (C1) — emit the claimed filings as InstrumentEvents.
        #
        # In the `finally` so a run that raised mid-walk still tells the product
        # about the filings it DID claim; those rows exist in `us_filings`
        # either way and a re-run will not re-claim them. (An emit that fails
        # here is recovered by `{"mode": "event-backfill"}`, never by a re-walk.)
        #
        # BEFORE `report_job_outcome`, so the emission's own failure is visible
        # in the same log line AND in the same METRIC rather than in a run that
        # already reported. Fail-soft by contract: `_emit_events` never raises,
        # so nothing here can turn a successful detection into a 500.
        if stats.claimed_documents:
            if publisher is None:
                publisher = Publisher()
            emit = _emit_events(publisher, stats.claimed_documents)
            # MONEY-1520 — FOLD THE FAILURE INTO THE OUTCOME.
            #
            # This line is the fix for the half of the bug that let it run for
            # hours unnoticed. Before it, `[events] workers answered 404 for 3
            # filings` fired at ERROR every minute while the very next line read
            # `[job-outcome] {"selected":3,"written":3,"failed":0}` — and
            # `failed` is the dimension the metric carries, so nothing could
            # alert. A filing whose event did not land IS a failed row, in the
            # same units `_fan_out` already counts a failed parse publish in.
            stats.failed += emit.failed
            logger.info(
                "[detect] events sent=%d failed=%d%s",
                emit.sent,
                emit.failed,
                f" reason={emit.skipped_reason}" if emit.skipped_reason else "",
            )

        # In a `finally` so a raising run is still measured. A job that throws
        # before reporting is a job whose failure is invisible in exactly the
        # dimension the outcome exists to measure.
        report_job_outcome(
            JOB_NAME,
            stats.selected,
            stats.written,
            stats.failed,
            stats.transport_failures,
            skipped_reason,
        )
        if owns_client and sec_client is not None:
            sec_client.close()


# ── Mode: the getcurrent walk ───────────────────────────────────────────────


def _run_atom(
    *,
    store: FilingStore,
    sec_client: SecClient,
    publisher: Publisher,
    stats: _RunStats,
    cursor_doc: dict[str, Any] | None,
    clock: Callable[[], datetime],
    elapsed: Callable[[], float],
    budget_seconds: float,
    max_pages: int,
) -> dict[str, Any]:
    cursor = _cursor_from_doc(cursor_doc)
    pages: list[list[CurrentFilingEntry]] = []
    stop_reason: str | None = None
    block_for: float | None = None

    plan = plan_page_walk(pages, cursor, max_pages)
    while True:
        if elapsed() >= budget_seconds:
            stop_reason = STOP_BUDGET_SPENT
            break
        url = GETCURRENT_URL.format(count=PAGE_SIZE, start=len(pages) * PAGE_SIZE)
        try:
            body = sec_client.get(url)
        except SecError as err:
            stop_reason, block_for, counted = _classify_sec_stop(err)
            if counted:
                stats.transport_failures += 1
            break
        pages.append(parse_current_filings_atom(body))
        stats.pages_fetched = len(pages)

        plan = plan_page_walk(pages, cursor, max_pages)
        decision = should_chain(
            pages_fetched=len(pages),
            max_pages=max_pages,
            cursor_reached=plan.cursor_reached,
            new_on_last_page=plan.new_on_last_page,
            elapsed_seconds=elapsed(),
            budget_seconds=budget_seconds,
        )
        if not decision.should_fetch_more:
            stop_reason = decision.stop_reason
            break

    stats.entries_seen = plan.entries_seen
    stats.repeats_collapsed = plan.repeats_collapsed
    stats.selected = len(plan.new_entries)

    results, fan_out_stop = _fan_out(
        entries=plan.new_entries,
        store=store,
        publisher=publisher,
        stats=stats,
        clock=clock,
        mode=MODE_ATOM,
    )
    if fan_out_stop is not None:
        stop_reason = fan_out_stop

    advanced = next_cursor(results, cursor)
    now = clock()
    store.write_cursor(
        CURSOR_KEY_ATOM,
        cursor=advanced,
        last_run_at=now,
        meta=_meta(stop_reason, MODE_ATOM, now, block_for),
    )

    return {
        "job": JOB_NAME,
        "mode": MODE_ATOM,
        "skipped": False,
        "skippedReason": None,
        "stopReason": stop_reason,
        "selected": stats.selected,
        "written": stats.written,
        "failed": stats.failed,
        "transportFailures": stats.transport_failures,
        "duplicates": stats.duplicates,
        "published": stats.published,
        "noParser": stats.no_parser,
        "pagesFetched": stats.pages_fetched,
        "entriesSeen": stats.entries_seen,
        "repeatsCollapsed": stats.repeats_collapsed,
        "cursorReached": plan.cursor_reached,
        "cursorAdvanced": advanced is not None and advanced != cursor,
        "cursor": _cursor_json(advanced),
        "byClass": dict(stats.by_class),
        "latencySeconds": stats.latency_summary(),
        "elapsedSeconds": round(elapsed(), 3),
    }


# ── Mode: the EFTS reconcile ────────────────────────────────────────────────


def _run_efts(
    *,
    store: FilingStore,
    sec_client: SecClient,
    publisher: Publisher,
    stats: _RunStats,
    clock: Callable[[], datetime],
    elapsed: Callable[[], float],
    budget_seconds: float,
) -> dict[str, Any]:
    now = clock()
    start_date, end_date = efts_window(now, EFTS_LOOKBACK_MINUTES)
    stop_reason: str | None = None
    block_for: float | None = None
    per_class: dict[str, int] = {}

    for parse_class, forms in EFTS_FORMS_BY_PARSE_CLASS.items():
        if stop_reason is not None:
            break
        page = 0
        while page < EFTS_MAX_PAGES:
            if elapsed() >= budget_seconds:
                stop_reason = STOP_BUDGET_SPENT
                break
            url = _efts_url(forms, start_date, end_date, page * EFTS_PAGE_SIZE)
            try:
                body = sec_client.get(url)
            except SecError as err:
                stop_reason, block_for, counted = _classify_sec_stop(err)
                if counted:
                    stats.transport_failures += 1
                break
            hits = parse_efts_response(json_loads(body))
            stats.hits_seen += len(hits)

            reconcile = plan_efts_reconcile(
                hits, store.known_accessions([hit.accession for hit in hits])
            )
            stats.reconciled_missing += len(reconcile.missing)
            per_class[parse_class] = per_class.get(parse_class, 0) + len(reconcile.missing)

            _, fan_out_stop = _fan_out(
                entries=reconcile.missing,
                store=store,
                publisher=publisher,
                stats=stats,
                clock=clock,
                mode=MODE_EFTS,
            )
            if fan_out_stop is not None:
                stop_reason = fan_out_stop
                break

            # A short page is the LAST page. EFTS returns at most `size` hits, so
            # fewer than a full page means the result set is exhausted — there is
            # no total to compare against that survives the 10,000-hit window.
            if len(hits) < EFTS_PAGE_SIZE:
                break
            page += 1

    # `selected` is what the sweep found MISSING, not how many hits it read. A
    # healthy hour reads thousands of hits and finds nothing missing, and that
    # must not read as "selected 3000, wrote 0" — which is the zero-write alarm.
    stats.selected = stats.reconciled_missing

    now = clock()
    store.write_cursor(
        CURSOR_KEY_EFTS,
        cursor=None,
        last_run_at=now,
        meta={
            **_meta(stop_reason, MODE_EFTS, now, block_for),
            "windowStart": start_date.isoformat(),
            "windowEnd": end_date.isoformat(),
        },
    )

    return {
        "job": JOB_NAME,
        "mode": MODE_EFTS,
        "skipped": False,
        "skippedReason": None,
        "stopReason": stop_reason,
        "selected": stats.selected,
        "written": stats.written,
        "failed": stats.failed,
        "transportFailures": stats.transport_failures,
        "duplicates": stats.duplicates,
        "published": stats.published,
        "noParser": stats.no_parser,
        "hitsSeen": stats.hits_seen,
        "reconciledMissing": stats.reconciled_missing,
        "reconciledByClass": per_class,
        "byClass": dict(stats.by_class),
        "window": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "latencySeconds": stats.latency_summary(),
        "elapsedSeconds": round(elapsed(), 3),
    }


def _efts_url(forms: Sequence[str], start: date, end: date, offset: int) -> str:
    """One EFTS page.

    ``q`` is deliberately omitted: it is optional, and when it is absent the
    server filters to ``sequence=1`` and returns ONE hit per filing rather than
    one per document. Sending a query term would multiply the same filing across
    its exhibits.
    """
    params = {
        "forms": ",".join(forms),
        "dateRange": "custom",
        "startdt": start.isoformat(),
        "enddt": end.isoformat(),
        "from": str(offset),
    }
    return f"{EFTS_URL}?{urlencode(params)}"


# ── Mode: the weekly full-index reconcile ───────────────────────────────────


@dataclass
class _IndexFetchState:
    """Whether the index stream ran to completion. Read AFTER the fold.

    A generator cannot return a value to a ``for`` loop, and this run's whole
    correctness argument is "everything we hold that the index does not list is
    withdrawn" — which is false the moment the stream stopped early. So the
    stream records why it stopped, on an object the caller still holds, and the
    caller refuses to write when it did.
    """

    complete: bool = True
    stop_reason: str | None = None


def _run_full_index(
    *,
    store: FilingStore,
    sec_client: SecClient,
    stats: _RunStats,
    payload: dict[str, Any],
    clock: Callable[[], datetime],
    elapsed: Callable[[], float],
    budget_seconds: float,
) -> dict[str, Any]:
    """Diff a window of ``us_filings`` against SEC's quarterly index rebuild."""
    now = clock()
    window_days = sweep_window_days(payload.get("windowDays"))
    end_override = _payload_date(payload.get("endDate"))
    start, end = full_index_window(
        now,
        window_days=window_days,
        settle_days=FULL_INDEX_SETTLE_DAYS,
        end_date=end_override,
    )
    quarters, truncated = quarters_between(start, to_eastern(now).date(), FULL_INDEX_MAX_QUARTERS)

    stored = store.accessions_filed_between(start, end)
    state = _IndexFetchState()
    block_for: float | None = None

    try:
        plan = plan_full_index_reconcile(
            index_rows=_index_row_stream(
                sec_client=sec_client,
                quarters=quarters,
                stats=stats,
                state=state,
                elapsed=elapsed,
                budget_seconds=budget_seconds,
            ),
            stored_accessions=stored,
            window_start=start,
            window_end=end,
            gap_sample=FULL_INDEX_GAP_SAMPLE,
        )
    except SecError as err:
        state.stop_reason, block_for, counted = _classify_sec_stop(err)
        state.complete = False
        if counted:
            stats.transport_failures += 1
        # The partial fold is DISCARDED rather than salvaged. Half an index
        # proves nothing about absence, and a plan built from it would report a
        # withdrawal count that is simply "everything the fetch did not reach".
        # Re-planned over an empty stored set so `withdrawn` is empty and
        # `selected` is 0 — the run made no claim, and `transportFailures > 0`
        # with `written == 0` is the outcome line that says so.
        plan = plan_full_index_reconcile(
            index_rows=(),
            stored_accessions=(),
            window_start=start,
            window_end=end,
        )

    stats.index_rows_seen = plan.index_rows_seen
    # SELECTED is the withdrawal candidates, not the window's population. A
    # healthy week reads a million index rows and finds nothing withdrawn, and
    # that must not read as "selected 1,000,000, wrote 0" — which is exactly the
    # zero-write alarm. Same reasoning as the EFTS pass's `reconciled_missing`.
    stats.selected = len(plan.withdrawn)

    stop_reason = state.stop_reason
    evidence_complete = state.complete and not truncated
    if evidence_complete is False and stop_reason is None:
        stop_reason = STOP_EVIDENCE_INCOMPLETE

    plausible = withdrawal_is_plausible(len(plan.withdrawn), plan.stored_in_window)
    if not plausible:
        stop_reason = STOP_WITHDRAWAL_SHARE_IMPLAUSIBLE
        logger.error(
            "[detect] refusing to mark %s of %s window filings WITHDRAWN — a share that "
            "large means the diff, not the ledger, is wrong",
            len(plan.withdrawn),
            plan.stored_in_window,
        )

    armed = settings.parse_apply()
    skipped_reason = None if armed else SKIP_WRITE_DISARMED
    marked = 0
    if armed and evidence_complete and plausible and plan.withdrawn:
        marked = store.mark_withdrawn(plan.withdrawn, now=clock())
    stats.written = marked

    now = clock()
    store.write_cursor(
        CURSOR_KEY_FULL_INDEX,
        cursor=None,
        last_run_at=now,
        meta={
            **_meta(stop_reason, MODE_FULL_INDEX, now, block_for),
            "windowStart": start.isoformat(),
            "windowEnd": end.isoformat(),
            "quarters": [quarter.label for quarter in quarters],
            "withdrawn": len(plan.withdrawn),
            "detectionGaps": plan.detection_gap_count,
        },
    )

    return {
        "job": JOB_NAME,
        "mode": MODE_FULL_INDEX,
        "skipped": False,
        "skippedReason": skipped_reason,
        "stopReason": stop_reason,
        "selected": stats.selected,
        "written": marked,
        "failed": stats.failed,
        "transportFailures": stats.transport_failures,
        "applied": bool(armed and evidence_complete and plausible),
        "evidenceComplete": evidence_complete,
        "withdrawalPlausible": plausible,
        "quartersFetched": stats.quarters_fetched,
        "quartersTruncated": truncated,
        "quarters": [quarter.label for quarter in quarters],
        "indexRowsSeen": plan.index_rows_seen,
        "indexAccessionsInWindow": plan.index_accessions_in_window,
        # From the QUERY, not from the plan: on the SEC-failure path the plan is
        # deliberately re-built over an empty stored set, and reporting 0 there
        # would say we read no filings when we read the whole window.
        "storedInWindow": len(stored),
        "withdrawn": len(plan.withdrawn),
        # BOTH numbers, and never one derived from the other. A filing we hold
        # that the rebuild dropped is a WITHDRAWAL; one the rebuild lists that we
        # never stored is a DETECTION GAP and means the minutely walk and the
        # hourly EFTS sweep both missed it.
        "detectionGaps": plan.detection_gap_count,
        "detectionGapSample": list(plan.detection_gaps),
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "elapsedSeconds": round(elapsed(), 3),
    }


def _index_row_stream(
    *,
    sec_client: SecClient,
    quarters: Sequence[Quarter],
    stats: _RunStats,
    state: _IndexFetchState,
    elapsed: Callable[[], float],
    budget_seconds: float,
) -> Iterator[DailyIndexRow]:
    """Every row of every quarterly index, one chunk at a time. Never a whole file.

    The budget is checked BETWEEN quarters, so the true wall is
    ``budget + one index fetch and parse`` — about 10 s of parse for a quarter
    on the measured rate. Running out is recorded on ``state`` rather than
    silently ending the stream: a truncated read makes every unvisited stored
    accession look absent, which is the diff's one catastrophic failure mode.
    """
    for quarter in quarters:
        if elapsed() >= budget_seconds:
            state.complete = False
            state.stop_reason = STOP_BUDGET_SPENT
            return
        body = sec_client.get(quarter.url, timeout=FULL_INDEX_TIMEOUT_SECONDS)
        stats.quarters_fetched += 1
        for chunk in _index_line_chunks(body, FULL_INDEX_CHUNK_LINES):
            yield from parse_daily_index(chunk)


def _index_line_chunks(body: bytes, lines_per_chunk: int) -> Iterator[str]:
    """``body`` as decoded line-chunks, each parseable by ``parse_daily_index``.

    Walks with ``bytes.find`` rather than ``body.split(b"\\n")``: splitting a
    185 MB index materialises 1.2M small ``bytes`` objects at once, which is the
    allocation this whole arrangement exists to avoid.

    Every chunk is prefixed with the rule line the parser keys its header skip
    on, INCLUDING the first — the real preamble lines that ride along in chunk
    one do not match the row regex and are dropped, exactly as in a whole-file
    parse.
    """
    if lines_per_chunk < 1:
        raise ValueError(f"lines_per_chunk must be >= 1, got {lines_per_chunk}")
    length = len(body)
    position = 0
    chunk_start = 0
    lines = 0
    while position < length:
        newline = body.find(b"\n", position)
        position = length if newline == -1 else newline + 1
        lines += 1
        if lines >= lines_per_chunk:
            yield INDEX_CHUNK_PREFIX + body[chunk_start:position].decode("utf-8", "replace")
            chunk_start = position
            lines = 0
    if chunk_start < length:
        yield INDEX_CHUNK_PREFIX + body[chunk_start:length].decode("utf-8", "replace")


def _payload_date(value: Any) -> date | None:
    """``"YYYY-MM-DD"`` from a message, or ``None``. Never raises on rubbish."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        logger.warning("[detect] ignoring unparseable endDate %r", value)
        return None


def sweep_window_days(value: Any) -> int:
    """``windowDays`` from a message, clamped to the one-quarter ceiling."""
    return coerce_positive_int(
        value, default=FULL_INDEX_WINDOW_DAYS, maximum=FULL_INDEX_MAX_WINDOW_DAYS
    )


# ── Mode: the nightly CUSIP sweep ───────────────────────────────────────────


def _run_cusip_sweep(
    *,
    store: FilingStore,
    stats: _RunStats,
    payload: dict[str, Any],
    sources: Any | None,
    openfigi: Any | None,
    ftd_lookup: Any | None,
    writer: Any | None,
    clock: Callable[[], datetime],
    elapsed: Callable[[], float],
) -> dict[str, Any]:
    """Retry the four-tier resolver over the least-recently-tried UNRESOLVED rows.

    ## Why this spends none of SEC's budget

    Three tiers are Mongo reads of collections we already own (13D/G cover
    pages, the 13F ``figi`` column, ``us_instruments``); ``SEC_FTD`` reads one
    already-archived GCS object that ``edgar-bulk-ftd`` put there; ``OPENFIGI``
    talks to ``api.openfigi.com``, which carries its own pacer sized from its
    own published ceilings and is forbidden by ``app/openfigi.py`` from touching
    ``app.sec.limiter``. So this mode can run nightly beside the minutely
    detection loop without moving the 9 req/s shared allowance at all.
    """
    from app.parsers.cusip_map import sweep_unresolved

    limit = sweep_batch_size(payload.get("limit"), default=CUSIP_SWEEP_BATCH)
    armed = settings.parse_apply()
    owned_openfigi = None

    if sources is None:
        from app.parsers.cusip_map import resolve_sources

        sources = resolve_sources()
    if openfigi is None:
        from app.openfigi import OpenFigiClient

        openfigi = owned_openfigi = OpenFigiClient()
    if ftd_lookup is None:
        ftd_lookup = _resolve_ftd_lookup()

    try:
        report = sweep_unresolved(
            sources=sources,
            limit=limit,
            openfigi=openfigi,
            ftd_lookup=ftd_lookup,
            writer=writer,
            apply=armed,
            now=clock(),
        )
    finally:
        if owned_openfigi is not None:
            owned_openfigi.close()

    stats.selected = int(report.get("selected") or 0)
    stats.written = int(report.get("written") or 0)

    now = clock()
    store.write_cursor(
        CURSOR_KEY_CUSIP_SWEEP,
        cursor=None,
        last_run_at=now,
        meta={
            **_meta(None, MODE_CUSIP_SWEEP, now, None),
            "limit": limit,
            "selected": stats.selected,
            "resolved": int(report.get("resolved") or 0),
            "byTier": dict(report.get("byTier") or {}),
        },
    )

    return {
        "job": JOB_NAME,
        "mode": MODE_CUSIP_SWEEP,
        "skipped": False,
        "skippedReason": None if armed else SKIP_WRITE_DISARMED,
        "stopReason": None,
        "selected": stats.selected,
        "written": stats.written,
        "failed": stats.failed,
        "transportFailures": stats.transport_failures,
        "applied": bool(armed),
        "limit": limit,
        "attempted": int(report.get("attempted") or 0),
        "resolved": int(report.get("resolved") or 0),
        "unresolved": int(report.get("unresolved") or 0),
        # REPORTED, never assumed. `TIINGO_FIGI` was planned as a cheap early
        # tier and measured nearly empty (Berkshire omits `figi` on all 89 rows
        # of its 2026 filing), and a tier that resolves nothing looks exactly
        # like a tier that was never reached.
        "byTier": dict(report.get("byTier") or {}),
        "hitRate": dict(report.get("hitRate") or {}),
        "planned": int(report.get("planned") or 0),
        "ftd": report.get("ftd"),
        "openfigi": report.get("openfigi"),
        "elapsedSeconds": round(elapsed(), 3),
    }


def _resolve_ftd_lookup() -> Any | None:
    """The ``SEC_FTD`` tier's lookup, or ``None`` when nothing is archived yet.

    ``None`` is a real answer and is reported as ``ftd: "unavailable"`` — a
    third value distinct from "tried and found nothing". An always-empty
    callable would collapse the two and let a permanently un-provisioned tier
    read as a tier with poor coverage forever.

    Only ``ArchiveUnavailable`` is swallowed, because that one means the bucket
    is not configured for this environment — a deployment fact, not a failure.
    A GCS error propagates: the sweep returning 500 and being redelivered is the
    right answer to storage being down, and pretending the tier is merely absent
    would hide it.
    """
    from app.db import get_database

    database = get_database()
    if database is None:
        return None
    from app.bulk.ftd import make_ftd_lookup
    from app.sec.archive import ArchiveUnavailable

    try:
        return make_ftd_lookup(database)
    except ArchiveUnavailable:
        logger.warning("[detect] SEC_FTD tier unavailable: no archive bucket configured")
        return None


# ── Mode: the one-off event backfill (MONEY-1532) ───────────────────────────


def _run_event_backfill(
    *,
    store: FilingStore,
    publisher: Publisher,
    stats: _RunStats,
    payload: dict[str, Any],
    now: datetime,
    clock: Callable[[], datetime],
    elapsed: Callable[[], float],
    budget_seconds: float,
) -> dict[str, Any]:
    """Re-emit the event of every filing a detector claimed in the window.

    ## THE LIVE PATH'S FUNCTION, ONE MESSAGE AT A TIME

    Each chunk of :data:`MAX_FILINGS_PER_REQUEST` rows goes through
    :func:`_emit_events` — the live emission's own function, so one
    ``build_requests`` builds both and the payload cannot fork — which makes
    exactly one message per chunk. The budget is checked BEFORE each, so the
    wall is ``budget + one publish``.

    ## IT STOPS AT THE FIRST FAILED MESSAGE, AND SAYS WHERE TO RESUME

    The live emit attempts every message, because each carries a different
    run's filings. This walk is ORDERED by ``detectedAt``, so stopping at the
    first failure makes that message's first ``detectedAt`` an exact restart
    point, reported as ``resumeFrom``: the next message is
    ``{"mode": "event-backfill", "since": <resumeFrom>}``. Carrying on past a
    failure would leave holes that only a full re-run could find. A budget stop
    reports the same field. ``since`` is inclusive, so a boundary row is re-sent
    rather than skipped — a duplicate is free (the event id is deterministic), a
    gap is not.

    Nothing here writes ``us_filings`` and nothing is gated on
    ``EDGAR_PARSE_APPLY``: the live path publishes unarmed too.
    ``EDGAR_DETECT`` gates it, as it gates every mode of this route.
    """
    try:
        start, end = event_backfill_window(now, payload.get("since"))
    except ValueError as err:
        return _skipped(MODE_EVENT_BACKFILL, SKIP_BACKFILL_WINDOW, elapsed(), detail=str(err))

    stop_reason: str | None = None
    resume_from: datetime | None = None
    for chunk in batched(store.filings_detected_between(start, end), MAX_FILINGS_PER_REQUEST):
        if elapsed() >= budget_seconds:
            stop_reason, resume_from = STOP_BUDGET_SPENT, chunk[0].get("detectedAt")
            break
        emit = _emit_events(publisher, chunk)
        stats.selected += len(chunk)
        stats.written += emit.sent
        stats.failed += emit.failed
        if emit.failed:
            stop_reason, resume_from = STOP_PUBLISH_FAILED, chunk[0].get("detectedAt")
            break

    window = {"start": iso_timestamp(start), "end": iso_timestamp(end)}
    resume = iso_timestamp(resume_from) if isinstance(resume_from, datetime) else None
    logger.info(
        "[detect] event-backfill window=%s..%s selected=%d sent=%d failed=%d stop=%s resumeFrom=%s",
        window["start"],
        window["end"],
        stats.selected,
        stats.written,
        stats.failed,
        stop_reason,
        resume,
    )

    finished = clock()
    store.write_cursor(
        CURSOR_KEY_EVENT_BACKFILL,
        cursor=None,
        last_run_at=finished,
        meta={
            **_meta(stop_reason, MODE_EVENT_BACKFILL, finished, None),
            "windowStart": start,
            "windowEnd": end,
            "selected": stats.selected,
            "sent": stats.written,
            "failed": stats.failed,
            "resumeFrom": resume_from,
        },
    )

    return {
        "job": JOB_NAME,
        "mode": MODE_EVENT_BACKFILL,
        "skipped": False,
        "skippedReason": None,
        "stopReason": stop_reason,
        "selected": stats.selected,
        # For this mode, `written` is the events Pub/Sub ACCEPTED. The workers'
        # upsert is the next hop and logs its own `upserted` / `failed`.
        "written": stats.written,
        "failed": stats.failed,
        "transportFailures": stats.transport_failures,
        "window": window,
        "resumeFrom": resume,
        "elapsedSeconds": round(elapsed(), 3),
    }


# ── Shared fan-out ──────────────────────────────────────────────────────────


def _fan_out(
    *,
    entries: Sequence[CurrentFilingEntry | EftsHit],
    store: FilingStore,
    publisher: Publisher,
    stats: _RunStats,
    clock: Callable[[], datetime],
    mode: str,
) -> tuple[list[FanOutResult], str | None]:
    """Claim each filing, then publish it. Stops at the first publish failure.

    Returns the per-filing results in the order given (newest first for the Atom
    walk) plus a stop reason, or ``None`` when every filing was handed off.
    """
    results: list[FanOutResult] = []

    for entry in entries:
        observed_at = clock()
        accession = entry.accession
        form = entry.form
        accepted_at = getattr(entry, "accepted_at", None)
        parse_class = classify_form(form)

        # BEFORE the claim, because the topic decides the STATUS the row is
        # inserted with, and the insert is the only write this job makes to it.
        # Deciding afterwards would mean either a second round trip per filing
        # or — worse — a row that is DETECTED for as long as nothing corrects
        # it, which is the defect this ordering exists to remove.
        #
        # It also moves `topic_for`'s KeyError for an unknown parse class ahead
        # of the claim, so a class our own code invented is never recorded at
        # all rather than recorded and then abandoned mid-fan-out.
        topic = topic_for(parse_class)
        status = STATUS_DETECTED if topic is not None else STATUS_NO_PARSER
        document = _filing_document(entry, parse_class, observed_at, status=status)

        claimed = store.claim_filing(document)
        if not claimed:
            # Another run owns this filing. Nothing is outstanding, so the cursor
            # may pass it — but we do NOT republish. A second message for a
            # filing whose first message may still be in flight is how one
            # 13F becomes two parses of the same holdings table.
            stats.duplicates += 1
            results.append(_result(accession, accepted_at, observed_at, published=True))
            continue
        stats.written += 1
        stats.count_class(parse_class)
        stats.claimed_documents.append(document)

        latency = detect_latency_seconds(accepted_at, observed_at)
        if latency is not None:
            record_latency(latency, tags={"form_class": parse_class, "mode": mode})
            stats.latencies.append(latency)

        if topic is None:
            # OTHER: recorded as a ledger row, routed nowhere. Not a failure and
            # not a gap — `{parseClass: "OTHER"}` is the query that finds every
            # form we have chosen not to parse.
            #
            # The row was inserted TERMINAL (`NO_PARSER`), not `DETECTED`. Until
            # MONEY-1303 it was DETECTED, and since nothing ever advances it,
            # `DETECTED` meant both "awaiting a parser" and "will never be
            # parsed" — 933 rows on prod that a genuinely backed-up parse topic
            # would have been indistinguishable from.
            stats.no_parser += 1
            results.append(_result(accession, accepted_at, observed_at, published=True))
            continue

        message = build_parse_message(
            accession=accession,
            cik10=document["cik10"],
            form=form,
            parse_class=parse_class,
            accepted_at=accepted_at,
        )
        try:
            publisher.publish(topic, message)
        except PublishError as err:
            stats.failed += 1
            store.mark_publish_failed(accession, f"{PUBLISH_FAILED_PREFIX}{err}")
            results.append(_result(accession, accepted_at, observed_at, published=False))
            logger.error(
                "[detect] publish failed for %s; stopping the fan-out so the remainder is "
                "re-walked rather than stranded",
                accession,
            )
            return results, STOP_PUBLISH_FAILED
        stats.published += 1
        results.append(_result(accession, accepted_at, observed_at, published=True))

    return results, None


def _result(
    accession: str,
    accepted_at: datetime | None,
    observed_at: datetime,
    *,
    published: bool,
) -> FanOutResult:
    """A cursor-candidate for one filing.

    An EFTS hit has no acceptance timestamp, and the cursor it would produce is
    never used (the reconcile does not own the ``getcurrent`` position), so the
    observation time stands in rather than a fabricated acceptance.
    """
    return FanOutResult(
        accession=accession,
        accepted_at=accepted_at if accepted_at is not None else observed_at,
        published=published,
    )


def _filing_document(
    entry: CurrentFilingEntry | EftsHit,
    parse_class: str,
    observed_at: datetime,
    *,
    status: str = STATUS_DETECTED,
) -> dict[str, Any]:
    """The ``us_filings`` row, built through the SHARED row model.

    ``UsFilingRow`` rather than a dict literal, because ``us_filings`` is written
    by three paths — this detector, the nightly ``submissions.zip`` ledger and
    the parsers' status stamps — and a hand-written field list here would be a
    SECOND spelling of one collection's shape. Two independent notions of a
    collection's shape is exactly how MONEY-1234/1235 happened, and the model is
    the half that ``schema-parity.test.ts`` grades against ``schema.prisma``.

    The model's ``to_doc()`` OMITS null fields, so ``parsedAt`` and friends are
    ABSENT on a freshly detected row rather than null. Readers must therefore
    filter POSITIVELY — ``{status: "DETECTED"}``, ``{parseClass: "EIGHTK"}``,
    both always present — and never ``{parsedAt: null}``, which in Mongo matches
    neither absent nor set values reliably (MONEY-1050 / 1234 / 1235).

    ``status`` is a PARAMETER rather than a constant, because the caller has
    already resolved the filing's topic and therefore already knows whether this
    row is in flight (``DETECTED``) or terminal (``NO_PARSER``). Defaulting to
    ``DETECTED`` keeps the routed path — the overwhelming majority — spelled
    exactly as before.
    """
    accepted_at = getattr(entry, "accepted_at", None)
    items = getattr(entry, "items", ()) or ()
    if isinstance(entry, EftsHit):
        cik10 = efts_primary_cik10(entry)
        filed_at: date = entry.file_date
        size_bytes = None
        period = entry.period_ending
    else:
        cik10 = entry.cik10
        filed_at = _filed_at(entry)
        size_bytes = entry.size_bytes
        period = None

    return UsFilingRow(
        accession=entry.accession,
        cik10=cik10,
        form=entry.form,
        filedAt=filed_at,
        acceptedAt=accepted_at,
        periodOfReport=period,
        items=list(items),
        sizeBytes=size_bytes,
        parseClass=parse_class,
        status=status,
        detectedAt=observed_at,
        ingestedAt=observed_at,
        updatedAt=observed_at,
    ).to_doc()


def _filed_at(entry: CurrentFilingEntry) -> date:
    """``filedAt`` for an Atom entry. NOT NULLABLE in the schema, so it has a floor.

    The Atom summary carries ``Filed: YYYY-MM-DD``. When it does not, the
    acceptance instant's EASTERN calendar day is used — EDGAR assigns filing
    dates on its own Eastern clock, so the UTC date would be a day ahead for
    every filing accepted after 20:00 ET, which is most of the evening peak.

    Returned as a ``date``; ``UsFilingRow``'s coercion is the single place a
    date-only column becomes UTC midnight.
    """
    if entry.filed_at is not None:
        return entry.filed_at
    return to_eastern(entry.accepted_at).date()


# ── Cursor + cooldown plumbing ──────────────────────────────────────────────


def _cursor_from_doc(doc: dict[str, Any] | None) -> DetectCursor | None:
    if not doc:
        return None
    accession = doc.get("lastAccession")
    accepted_at = doc.get("lastAcceptedAt")
    if not accession and accepted_at is None:
        return None
    return DetectCursor(
        last_accession=accession if isinstance(accession, str) and accession else None,
        last_accepted_at=_as_aware(accepted_at),
    )


def _cursor_json(cursor: DetectCursor | None) -> dict[str, Any] | None:
    if cursor is None:
        return None
    return {
        "lastAccession": cursor.last_accession,
        "lastAcceptedAt": iso_timestamp(cursor.last_accepted_at),
    }


def _cooldown(doc: dict[str, Any] | None, now: datetime) -> tuple[datetime | None, str | None]:
    """``(blockedUntil, reason)`` while a cooldown is still running, else ``(None, None)``.

    An EXPIRED cooldown reads as no cooldown; the field is left on the row for
    forensics and overwritten by the next successful run.
    """
    meta = (doc or {}).get("meta") or {}
    if not isinstance(meta, dict):
        return None, None
    blocked_until = _as_aware(meta.get("blockedUntil"))
    if blocked_until is None:
        return None, None
    if blocked_until <= _as_aware(now):
        return None, None
    reason = meta.get("blockReason")
    return blocked_until, reason if isinstance(reason, str) else None


def _meta(
    stop_reason: str | None,
    mode: str,
    now: datetime,
    block_for: float | None,
) -> dict[str, Any]:
    """The whole ``meta`` document, rewritten every run.

    Rewritten rather than merged so a cleared block clears itself: a run that
    completes without hitting SEC's ceiling writes ``blockedUntil: None``, and
    there is no path where a stale cooldown outlives the condition that set it.
    """
    blocked_until = None if block_for is None else _as_aware(now) + timedelta(seconds=block_for)
    return {
        "lastStopReason": stop_reason,
        "lastMode": mode,
        "blockedUntil": blocked_until,
        "blockReason": stop_reason if block_for is not None else None,
    }


def _classify_sec_stop(err: SecError) -> tuple[str, float | None, bool]:
    """``(stopReason, cooldownSeconds, countAsTransportFailure)`` for a SEC failure.

    Three different answers, because the three failures need three different
    responses. An egress-disabled environment never opened a socket, so counting
    it as a transport failure would report an upstream problem where there is
    only a flag. A rate block and an identity rejection both need the fleet to
    go quiet — the first because SEC is measuring us, the second because every
    further request fails identically and each one lengthens the block.
    """
    if isinstance(err, SecEgressDisabled):
        return STOP_EGRESS_DISABLED, None, False
    if isinstance(err, SecIdentityRejected):
        return STOP_IDENTITY_REJECTED, BLOCK_COOLDOWN_SECONDS, True
    if isinstance(err, SecRateLimited):
        cooldown = max(BLOCK_COOLDOWN_SECONDS, err.retry_after or 0.0)
        return STOP_RATE_LIMITED, cooldown, True
    if isinstance(err, SecTransportError):
        return STOP_TRANSPORT_ERROR, None, True
    return STOP_SEC_ERROR, None, True


def _as_aware(value: Any) -> datetime | None:
    """A stored timestamp as an aware UTC datetime; anything else is ``None``.

    pymongo hands back NAIVE datetimes (BSON stores UTC without a zone), so a
    comparison against an aware ``now`` would raise ``TypeError`` — inside a
    cooldown check, on the one code path that only runs while SEC is already
    blocking us.
    """
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _skipped(mode: str, reason: str, elapsed_seconds: float, **extra: Any) -> dict[str, Any]:
    """A run that deliberately did nothing, said so, and is not a failure."""
    logger.info("[detect] skipped mode=%s reason=%s", mode, reason)
    return {
        "job": JOB_NAME,
        "mode": mode,
        "skipped": True,
        "skippedReason": reason,
        "stopReason": None,
        "selected": 0,
        "written": 0,
        "failed": 0,
        "transportFailures": 0,
        "elapsedSeconds": round(elapsed_seconds, 3),
        **extra,
    }
