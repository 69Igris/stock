"""PURE decisions for the 13F hot/cold evictor — MONEY-979 (T9).

No GCS, no Mongo, no clock, no network. :mod:`app.jobs.evict` is the I/O half and
imports everything here, so a test drives the REAL rules rather than a re-declared
copy of them.

## What the evictor is for, and the one way it can go catastrophically wrong

``us_13f_holdings`` grows without bound: every quarter every 13F filer restates
its ENTIRE portfolio, so a manager's rows are re-filed in full four times a year
forever. The hot table keeps a window — the two most recent report periods — and
everything older is archived to one gzipped-JSONL object per ``(manager,
period)`` and DELETED from Mongo.

The archive is therefore the ONLY remaining copy. That makes the ordering inside
:func:`app.jobs.evict.evict_one` the entire point of this job:

    read the shard -> merge -> write -> **RE-READ** -> delete only what the
    re-read proves is there -> mark the filing COLD

A delete keyed off the WRITE's return code is how a quarter of holdings
disappears with nothing to notice it. ``blob.upload_from_string`` returning
without raising says the request was accepted; it does not say the object can be
read back, that it landed in the bucket this process thinks it is pointed at, or
that a concurrent writer did not replace it a millisecond later. The re-read is
the only evidence that survives all three, and this module exists so that
"proven" is a value a test can hold, compare and mutate rather than a comment.

## Two more properties that are decisions, not details

**Merge-on-write.** A GCS put REPLACES the object, and ONE shard holds every
filing for a manager-quarter — the original 13F-HR and each amendment share a
key. A writer that encoded only the rows it happens to hold would destroy the
others and the put would still return 200. :func:`shard_row_key` is the merge
identity, and it is the SAME ``(accession, rowIndex)`` pair that is the Prisma
``@@unique`` on ``us_13f_holdings``.

**Absent is not COLD.** The evictable filter is ``tier != "COLD"``, never
``tier == "HOT"``. In Mongo a field added by a later ``db push`` is ABSENT on
existing rows, and ``{"tier": "HOT"}`` would skip every one of them silently and
forever (MONEY-1050 / -1234 / -1235 / -1236, four tickets in this repo from the
same shape). ``$ne`` matches an absent field, so an untiered filing is treated as
hot — which is the safe direction: it gets archived, proven and then deleted,
rather than accumulating unseen.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any, NamedTuple

from app.publish import iso_timestamp

# ── Types ───────────────────────────────────────────────────────────────────

#: One shard line, before it is serialised. Same alias the archive codec uses.
Row = dict[str, Any]


class EvictRowError(ValueError):
    """A holding could not be turned into a shard row that can be keyed."""


# ── Constants ───────────────────────────────────────────────────────────────

#: Report periods that stay in Mongo. TWO, because every read this serves is a
#: comparison: ``getTopHolders`` renders a quarter next to the one before it for
#: the QoQ delta, so a one-period window would push the second half of the most
#: common read into GCS on every request.
HOT_PERIOD_COUNT = 2

#: A 13F is due 45 days after the quarter ends (17 CFR 240.13f-1), and managers
#: file across the whole of that window. Any period with a filing inside the last
#: 45 days is kept hot ON TOP of the two newest.
#:
#: What this leg actually protects, derived rather than assumed: the two-newest
#: rule is computed from DISTINCT periods, so a single early filer already puts a
#: brand-new quarter into the window — "the newest quarter is still arriving" is
#: covered by ``keep`` alone and does NOT need this. The case ``keep`` cannot
#: cover is a filing that arrives for an OLDER period: a 13F-HR/A restating an
#: earlier quarter, or a late filer catching up. Without this leg such a filing is
#: parsed and then archived within hours of arriving — so the rows a reader is
#: most likely to ask for next are exactly the ones that went straight to GCS.
IN_FLIGHT_DAYS = 45

#: Wall-clock budget for one handler invocation, in MILLISECONDS, checked
#: BETWEEN filings — so the true wall is ``budget + one filing``. Pub/Sub's push
#: ack deadline is 600 s and it is the binding constraint (Cloud Run's own
#: request timeout is 3600 s); overrunning it makes Pub/Sub REDELIVER while the
#: first copy is still running, and a second copy of THIS job is two writers
#: racing on one shard. 420 s leaves 180 s for one pathological filing (a GCS
#: read + merge + write + re-read of a large manager) plus the chain publish and
#: the outcome report. Same number as ``stock-document-extract`` and
#: ``mf-nav-backfill``.
RUN_TIME_BUDGET_MS = 420_000

#: Follow-up messages one triggered run may publish. Bounds the drain: 20 chained
#: runs of 420 s is ~2.3 h of work from one nightly trigger, and an unbounded
#: chain against a bucket that is failing every write would republish forever.
MAX_CHAIN_DEPTH = 20

#: Filings fetched per query. A page, NOT the control — the control is the wall
#: budget, checked between filings, because per-filing cost is a GCS round trip
#: and is not something a row count can express (the ``stock-document-extract``
#: lesson).
FILING_PAGE_SIZE = 200

#: ``rowIndex`` values per ``delete_many``. A large index manager files thousands
#: of positions and a single ``$in`` of every one of them is a query document
#: that grows with the filing.
DELETE_CHUNK = 500

#: Consecutive filings whose GCS write or re-read raised, after which the run
#: stops and does NOT chain. A dead bucket fails every filing identically, and
#: chaining 20 deep against it turns one broken run into 20 broken runs and 20
#: dead-letter candidates.
MAX_CONSECUTIVE_STORAGE_FAILURES = 3

TIER_HOT = "HOT"
TIER_COLD = "COLD"

#: ``us_13f_filings`` fields the run reads. The projection is built FROM this
#: tuple rather than hand-written beside it: a hardcoded ``select`` that had
#: drifted from the code consuming it is what made "we never asked for the
#: column" print as "the vendor has no value" in the F3 reconcile.
FILING_FIELDS: tuple[str, ...] = (
    "accession",
    "managerCik10",
    "managerName",
    "periodOfReport",
    "filedAt",
    "tier",
    "coldPath",
)

# Named outcomes. Strings, because they are read off a log line and a metric tag
# by a human at 3am, not compared to an enum.
SKIP_WRITE_DISARMED = "WRITE_DISARMED"
SKIP_DATABASE_UNAVAILABLE = "DATABASE_UNAVAILABLE"

STOP_DRAINED = "drained"
STOP_BUDGET_SPENT = "budget-spent"
STOP_CHAIN_DEPTH_REACHED = "chain-depth-reached"
STOP_STORAGE_UNAVAILABLE = "storage-unavailable"
#: A whole page was processed and the resume cursor did not move — every filing
#: on it was missing the ``(periodOfReport, accession)`` pair the cursor is built
#: from. The next query would return the SAME page, so the loop stops instead of
#: spinning for the full 420 s and then chaining twenty copies of the spin.
STOP_CURSOR_STUCK = "cursor-stuck"

FAIL_SHARD_ABSENT = "shard-absent-after-write"
FAIL_UNENCODABLE_ROW = "row-not-encodable"
FAIL_ROWS_UNPROVEN = "rows-unproven"
FAIL_STORAGE = "storage-error"

#: Key under which a chained message carries its depth. Deliberately NOT a
#: Pub/Sub attribute: ``app.publish`` publishes ``{json}`` with no attributes and
#: ``app.envelope`` reads ``message.data`` only, so a depth smuggled into an
#: attribute would decode to nothing and every chained run would believe it was
#: the first — the bound would silently not exist.
CHAIN_DEPTH_KEY = "chainDepth"
CHAIN_AFTER_PERIOD_KEY = "afterPeriod"
CHAIN_AFTER_ACCESSION_KEY = "afterAccession"

#: The topic a follow-up is published to. Equals the route base name.
CHAIN_TOPIC = "edgar-evict"


# ── Dates ───────────────────────────────────────────────────────────────────


def as_day(value: Any) -> date | None:
    """A ``periodOfReport`` as a UTC CALENDAR DAY, or ``None`` if unusable.

    pymongo hands back naive :class:`datetime` in UTC (the client is not
    ``tz_aware``), Prisma stores a UTC midnight, and a hand-written payload may
    carry the ISO string. All three mean the same day and all three must produce
    the same shard key — a period that resolved to a different day per caller
    would write one quarter to two objects, each holding half the manager.

    ``datetime`` is tested BEFORE ``date`` because ``datetime`` subclasses
    ``date``; the obvious order truncates nothing here but reads as if it might,
    and that ordering has already cost this service once (``models._coerce``).
    """
    if isinstance(value, datetime):
        stamped = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return stamped.astimezone(UTC).date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return as_day(datetime.fromisoformat(text.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def as_utc_midnight(day: date) -> datetime:
    """``date`` -> the ``datetime`` MongoDB actually stores.

    Load-bearing for the query, not cosmetic. ``periodOfReport`` is a BSON date,
    and BSON has no date-without-time type: ``{"periodOfReport": {"$nin":
    [date(2026, 6, 30)]}}`` compares a Python ``date`` against a stored
    ``datetime`` and matches NOTHING, so the hot window would exclude nothing and
    the newest quarter would be evicted the day it arrived.
    """
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def in_flight_cutoff(now: datetime, days: int = IN_FLIGHT_DAYS) -> datetime:
    """The instant before which a filing no longer counts as "still arriving"."""
    stamped = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    return stamped.astimezone(UTC) - timedelta(days=days)


# ── The hot window ──────────────────────────────────────────────────────────


class HotWindow(NamedTuple):
    """Which report periods stay in Mongo, and WHY each one of them does.

    The two halves are reported separately because they answer different
    questions when the drain looks wrong: ``newest`` is the steady-state window
    and moves once a quarter; ``in_flight`` is the deadline rule and is empty for
    most of the year. A single merged set would make "the window is three
    periods wide today" read as a bug.
    """

    newest: tuple[date, ...]
    in_flight: tuple[date, ...]
    periods: tuple[date, ...]

    def __contains__(self, period: object) -> bool:
        day = as_day(period)
        return day is not None and day in self.periods


def hot_window(
    all_periods: Iterable[Any],
    in_flight_periods: Iterable[Any] = (),
    *,
    keep: int = HOT_PERIOD_COUNT,
) -> HotWindow:
    """The periods that must NOT be archived.

    ``keep`` newest report periods across the whole table, UNION every period
    that still has filings arriving. The union is not an optimisation: ``keep``
    names the current quarters, and ``in_flight`` names any OLDER period that a
    late filing or an amendment has just touched — see :data:`IN_FLIGHT_DAYS` for
    why the second is not implied by the first.

    Unparseable periods are dropped rather than raising: this set is a GUARD, and
    a guard that throws on one bad row stops protecting the good ones. A period
    that cannot be read also cannot be matched by the query, so dropping it costs
    the filing carrying it nothing — it simply is not selected.
    """
    parsed = sorted({day for day in (as_day(value) for value in all_periods) if day is not None})
    newest = tuple(reversed(parsed[-keep:])) if keep > 0 else ()
    flight = tuple(
        sorted(
            {day for day in (as_day(value) for value in in_flight_periods) if day is not None},
            reverse=True,
        )
    )
    union = tuple(sorted(set(newest) | set(flight), reverse=True))
    return HotWindow(newest=newest, in_flight=flight, periods=union)


# ── The selection query ─────────────────────────────────────────────────────


class Cursor(NamedTuple):
    """Where a chained run resumes. ``(periodOfReport, accession)``, both ASC."""

    period: date
    accession: str


def evictable_query(window: HotWindow, after: Cursor | None = None) -> dict[str, Any]:
    """The ``us_13f_filings`` filter for "hot, and older than the window".

    Two things here are the difference between a drain that runs and one that
    reports success nightly having moved nothing:

    ``tier: {"$ne": "COLD"}`` and not ``{"$eq": "HOT"}`` — see the module
    docstring. ``$ne`` also matches an ABSENT field, which is the safe direction.

    The compound cursor is what makes a CHAIN advance. A budget-truncated run
    that re-issued the same query would hand the next run the same first page:
    ordering by a column that does not change across the population is how a job
    wrote the same 100 rows nightly and never reached the other 681 (MONEY-1211),
    and ``desc`` on a growing population is the same defect pointing the other
    way (MONEY-1255). Successful evictions leave the population — ``tier``
    becomes COLD — but FAILURES do not, so without the cursor one unarchivable
    filing would sit at the head of every page and starve the whole drain.
    """
    query: dict[str, Any] = {"tier": {"$ne": TIER_COLD}}
    if window.periods:
        query["periodOfReport"] = {"$nin": [as_utc_midnight(day) for day in window.periods]}
    if after is not None:
        boundary = as_utc_midnight(after.period)
        query["$or"] = [
            {"periodOfReport": {"$gt": boundary}},
            {"periodOfReport": boundary, "accession": {"$gt": after.accession}},
        ]
    return query


def filing_projection() -> dict[str, int]:
    """The projection, built from :data:`FILING_FIELDS` so the two cannot drift."""
    return {field: 1 for field in FILING_FIELDS}


def cursor_for(filing: Mapping[str, Any]) -> Cursor | None:
    """The resume point AFTER this filing, or ``None`` if it cannot be built."""
    period = as_day(filing.get("periodOfReport"))
    accession = str(filing.get("accession") or "")
    if period is None or not accession:
        return None
    return Cursor(period=period, accession=accession)


# ── Shard rows ──────────────────────────────────────────────────────────────

#: Dropped from every archived row. ``_id`` is MongoDB's own handle: it is not a
#: Prisma field, it does not survive ``json.dumps`` (an ``ObjectId`` is not JSON)
#: and a restore would mint a new one anyway.
DROPPED_HOLDING_FIELDS: frozenset[str] = frozenset({"_id"})

#: Fields the TypeScript reader REQUIRES on a line. A line missing any of them is
#: dropped by ``parseThirteenFShard`` in ``packages/core/src/us-fundamentals/
#: cold-holdings.ts`` — silently, one line at a time.
TS_REQUIRED_STRING_FIELDS: tuple[str, ...] = ("cusip", "accession", "managerCik10")
TS_REQUIRED_DATE_FIELDS: tuple[str, ...] = ("periodOfReport", "filedAt")
TS_REQUIRED_NUMBER_FIELDS: tuple[str, ...] = ("valueUsd", "shares")


def _iso(value: datetime | date) -> str:
    """``2024-03-31T00:00:00.000Z`` — what ``JSON.stringify(new Date())`` gives.

    The ``Z`` is not decoration. The reader parses these with ``new Date(...)``,
    and ECMA-262 reads a date-TIME string with no offset as LOCAL time: a bare
    ``2024-03-31T00:00:00`` becomes 2024-03-30T18:30:00Z for a reader running in
    IST, whose ``toISOString().slice(0, 10)`` then builds the key for the WRONG
    DAY. One character, one quarter 404ing forever.

    ``iso_timestamp`` is imported from :mod:`app.publish` rather than re-derived
    here, so the service has exactly one definition of that rendering.
    """
    moment = (
        value
        if isinstance(value, datetime)
        else datetime(value.year, value.month, value.day, tzinfo=UTC)
    )
    rendered = iso_timestamp(moment)
    if rendered is None:  # pragma: no cover - iso_timestamp answers None only for None
        raise EvictRowError(f"could not render {value!r} as an ISO-8601 instant")
    return rendered


def _jsonable(value: Any) -> Any:
    """One document value in a shape ``json.dumps`` accepts, recursively."""
    if isinstance(value, (datetime, date)):
        return _iso(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return value


def holding_to_shard_row(document: Mapping[str, Any]) -> Row:
    """One ``us_13f_holdings`` document -> one JSONL line object.

    LOSSLESS except for ``_id``. Every other field is carried through under its
    PRISMA NAME, including the ones the TypeScript reader does not read
    (``investmentDiscretion``, ``votingSole``, ``otherManagers``, ``resolvedBy``,
    ``parserVersion`` …). The shard becomes the only copy the moment the hot rows
    are deleted, so a writer that projected down to the fifteen fields today's
    reader happens to consume would destroy the rest — quietly, and only
    discoverably years later when something needs them.

    Raises when ``accession`` or ``rowIndex`` is unusable: those two ARE the
    merge identity and the delete key, so a row that cannot be keyed cannot be
    proven and must never be archived-then-deleted.
    """
    accession = str(document.get("accession") or "").strip()
    if not accession:
        raise EvictRowError("holding has no accession; it cannot be keyed or proven")
    index = _as_int(document.get("rowIndex"))
    if index is None:
        raise EvictRowError(f"holding {accession} has a non-integer rowIndex; it cannot be keyed")

    row: Row = {}
    for key, value in document.items():
        if key in DROPPED_HOLDING_FIELDS:
            continue
        row[str(key)] = _jsonable(value)
    row["accession"] = accession
    row["rowIndex"] = index
    return row


def _as_int(value: Any) -> int | None:
    """An integer, or ``None``. ``bool`` is rejected — ``True`` is not row 1."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _is_finite_number(value: Any) -> bool:
    """Mirrors the reader's ``finite()``: a number, or a NON-EMPTY numeric string.

    NOT ``float(x)``. ``float(None)`` raises but ``Number(null)`` is ``0`` on the
    other side, and it is the other side's rule that decides whether a line
    survives — so this predicate is written against THAT rule, not against
    Python's.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    if isinstance(value, str) and value.strip():
        try:
            return math.isfinite(float(value))
        except ValueError:
            return False
    return False


def readable_by_reader(row: Mapping[str, Any]) -> bool:
    """Would ``parseThirteenFShard`` keep this line, or silently drop it?

    Reported as a COUNT rather than enforced as a gate. The row is archived
    either way — the shard is lossless and ``gsutil cat | gunzip`` still finds
    it — but a row the reader drops is invisible in the product, and the
    difference between "this manager held 40 positions" and "39" is exactly the
    kind of quiet shortfall this codebase keeps rediscovering. Counting it makes
    a producer/consumer disagreement (an empty ``cusip``, a ``valueUsd`` the
    parser could not compute) visible in the job outcome instead of assumed away.
    """
    for field in TS_REQUIRED_STRING_FIELDS:
        value = row.get(field)
        if not isinstance(value, str) or value == "":
            return False
    for field in TS_REQUIRED_DATE_FIELDS:
        if as_day(row.get(field)) is None:
            return False
    return all(_is_finite_number(row.get(field)) for field in TS_REQUIRED_NUMBER_FIELDS)


def shard_row_key(row: Mapping[str, Any]) -> str:
    """The merge identity: ``{accession}|{rowIndex:08d}``.

    The SAME pair as the Prisma ``@@unique`` on ``us_13f_holdings``, so a re-run
    that re-archives a row replaces it instead of duplicating it, and so an
    amendment merged into an existing shard collides with exactly the rows it
    restates.

    Zero-padded because :func:`app.sec.archive_logic.serialize_shard` sorts on
    this string: unpadded, row 10 would sort before row 2 and the same SET of
    rows would produce different bytes depending on how many rows there were.

    A row that cannot be keyed gets a content-derived key instead of a shared
    fallback. It can only arrive from a corrupt existing shard (this writer
    refuses to build one — see :func:`holding_to_shard_row`), and two such rows
    sharing one key would silently collapse to one during the merge: a repair
    that DESTROYS a row is worse than a repair that preserves an odd one.
    """
    accession = row.get("accession")
    index = _as_int(row.get("rowIndex"))
    if isinstance(accession, str) and accession and index is not None:
        return f"{accession}|{index:08d}"
    digest = hashlib.sha256(
        json.dumps(row, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"\x00unkeyed|{digest}"


# ── The delete plan ─────────────────────────────────────────────────────────


def proven_row_keys(rows: Iterable[Mapping[str, Any]]) -> set[str]:
    """Merge keys the RE-READ of the shard proves are stored.

    Derived from what came BACK out of GCS, never from what was sent to it. That
    is the whole contract: ``upload_from_string`` returning without raising says
    the request was accepted, not that the bytes are readable at that key.
    """
    return {shard_row_key(row) for row in rows}


class DeletePlan(NamedTuple):
    """Which hot rows may be deleted, and what is still unaccounted for."""

    #: ``rowIndex`` values whose line the re-read found. Safe to delete.
    row_indexes: tuple[int, ...]
    #: Merge keys that were archived but did NOT come back. Never deleted.
    missing: tuple[str, ...]

    @property
    def complete(self) -> bool:
        """Every intended row is proven. The ONLY state in which a filing goes COLD."""
        return not self.missing


def plan_deletions(intended: Sequence[Mapping[str, Any]], proven: set[str]) -> DeletePlan:
    """Intersect what we archived with what the shard gave back.

    The intersection, never the intended set. A shard that came back with fewer
    rows than were written is not a reason to delete the rest and hope: those
    rows stay hot, the filing stays HOT, and the next run merges them in again
    and re-proves them. The run converges instead of losing them.

    ``missing`` is returned rather than logged and dropped, because "the shard
    is short by 400 rows" and "the shard is fine" must not report the same
    number anywhere.
    """
    deletable: list[int] = []
    missing: list[str] = []
    for row in intended:
        key = shard_row_key(row)
        index = _as_int(row.get("rowIndex"))
        if key in proven and index is not None:
            deletable.append(index)
        else:
            missing.append(key)
    return DeletePlan(row_indexes=tuple(sorted(set(deletable))), missing=tuple(sorted(missing)))


def chunk(items: Sequence[Any], size: int = DELETE_CHUNK) -> Iterator[Sequence[Any]]:
    """Fixed-size slices. ``size`` is floored at 1 so a zero can never spin."""
    step = max(1, size)
    for start in range(0, len(items), step):
        yield items[start : start + step]


# ── Budget and chaining ─────────────────────────────────────────────────────


def budget_exhausted(elapsed_ms: float, budget_ms: float = RUN_TIME_BUDGET_MS) -> bool:
    """Checked BETWEEN filings, so the real wall is ``budget + one filing``."""
    return elapsed_ms >= budget_ms


def chain_depth(payload: Mapping[str, Any] | None) -> int:
    """How many follow-ups preceded this run. Absent, negative or junk -> 0.

    Coerced rather than trusted: the depth arrives over Pub/Sub, and a value that
    failed to parse must read as "first run" (which is bounded by
    :data:`MAX_CHAIN_DEPTH` from zero) and never as a number that skips the bound.
    """
    if not isinstance(payload, Mapping):
        return 0
    depth = _as_int(payload.get(CHAIN_DEPTH_KEY))
    return depth if depth is not None and depth > 0 else 0


class ChainDecision(NamedTuple):
    """Publish a follow-up, or stop with a NAMED reason."""

    chain: bool
    reason: str


def should_chain(
    *,
    work_remains: bool,
    depth: int,
    max_depth: int = MAX_CHAIN_DEPTH,
    storage_failing: bool = False,
) -> ChainDecision:
    """Whether this run publishes its own successor.

    Order is load-bearing. ``storage_failing`` is tested FIRST because chaining
    into a dead bucket manufactures 20 identical failures and 20 dead-letter
    candidates out of one; ``work_remains`` next, so a run that simply finished
    reports ``drained`` and not ``chain-depth-reached``; the bound last, so
    hitting it is reported as itself and an operator can tell "the drain is
    larger than 20 runs" from "the drain is done".
    """
    if storage_failing:
        return ChainDecision(False, STOP_STORAGE_UNAVAILABLE)
    if not work_remains:
        return ChainDecision(False, STOP_DRAINED)
    if depth >= max_depth:
        return ChainDecision(False, STOP_CHAIN_DEPTH_REACHED)
    return ChainDecision(True, STOP_BUDGET_SPENT)


def next_chain_payload(
    payload: Mapping[str, Any] | None,
    *,
    depth: int,
    after: Cursor | None,
) -> dict[str, Any]:
    """The follow-up message. Carries the incremented depth and the resume point.

    The caller's own payload is copied through so an operator who triggered the
    run with an override does not lose it at the first chain boundary — the
    depth and the cursor are the only keys this function owns.
    """
    body: dict[str, Any] = dict(payload or {})
    body[CHAIN_DEPTH_KEY] = depth + 1
    if after is not None:
        body[CHAIN_AFTER_PERIOD_KEY] = after.period.isoformat()
        body[CHAIN_AFTER_ACCESSION_KEY] = after.accession
    else:
        body.pop(CHAIN_AFTER_PERIOD_KEY, None)
        body.pop(CHAIN_AFTER_ACCESSION_KEY, None)
    return body


def cursor_from_payload(payload: Mapping[str, Any] | None) -> Cursor | None:
    """The resume point a chained message carries, or ``None`` for a fresh run.

    A half-specified cursor (a period with no accession) is ``None``, not a
    partial filter: resuming from an unbounded boundary would silently re-walk or
    skip a page depending on which half survived.
    """
    if not isinstance(payload, Mapping):
        return None
    period = as_day(payload.get(CHAIN_AFTER_PERIOD_KEY))
    accession = str(payload.get(CHAIN_AFTER_ACCESSION_KEY) or "").strip()
    if period is None or not accession:
        return None
    return Cursor(period=period, accession=accession)


def storage_failing(consecutive: int, limit: int = MAX_CONSECUTIVE_STORAGE_FAILURES) -> bool:
    """``limit`` filings in a row whose GCS call raised. The bucket, not the data."""
    return consecutive >= max(1, limit)
