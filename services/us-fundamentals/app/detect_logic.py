"""Every DECISION the detection loop makes, with no I/O and no clock — MONEY-979.

``app/jobs/detect.py`` owns the sockets, the database and the Pub/Sub client.
This module owns the answers: which filings on a page are new, when to stop
walking, where the cursor may safely move to, how fresh a filing is, which date
range the hourly EFTS sweep should ask for, which quarterly index files prove a
filing absent, and how many unresolved CUSIPs one sweep may visit. Time is
always a PARAMETER — nothing here calls ``datetime.now()`` — so a test drives
the real implementation at an exact instant instead of re-declaring the
arithmetic beside it.

Five modes share this module because they share one route, one topic and one
disarm flag: the minutely Atom walk, the hourly EFTS reconcile, the weekly
full-index reconcile (the only thing that can set
``us_filings.status = "WITHDRAWN"``), the nightly CUSIP sweep and the one-off
event backfill (MONEY-1532).

## The three properties this module exists to hold

**1. Entries are not filings.** A ``getcurrent`` page of 100 Atom entries is
about 49 filings: SEC emits one entry per filer ROLE (Reporting / Issuer /
Subject / Filed by). ``parse_current_filings_atom`` collapses that within a
page; this module collapses it ACROSS pages, because the feed is a rolling
window that shifts between two HTTP requests and page 2 routinely repeats part
of page 1. Without the second dedupe the same Form 4 is published twice.

**2. The cursor may never move past a filing we did not hand off.** The cursor
is where the NEXT walk stops, so anything older than it is never looked at
again. Advancing it before the publish succeeds does not lose a retry — it
loses the filing, permanently and silently, and nothing downstream can tell the
difference between "never filed" and "we skipped it". :func:`next_cursor`
therefore places the cursor STRICTLY OLDER than every failure in the run, and
the fan-out stops at the first failure so that the untried remainder is left
un-inserted and gets re-walked whole.

**3. Latency is measured from ``acceptedAt``.** ``filedAt`` is a calendar DAY
assigned by EDGAR, and a filing accepted after the evening cutoff is dated the
NEXT business day — so ``now - filedAt`` is negative most evenings and is not a
measurement of anything this service controls. When ``acceptedAt`` is absent
(EFTS carries ``file_date`` only) the answer is ``None``, never a number
derived from the other column.

## Why the US-Eastern conversion is hand-rolled here

EFTS filters on ``file_date``, which is an EDGAR **Eastern** calendar day, while
this process runs on UTC. At 02:00 UTC the Eastern date is the PREVIOUS day, so
a UTC-derived window asks for a date that does not exist yet and returns zero
hits — every night, with no error. The conversion is therefore mandatory, and it
is written out (rather than taken from :mod:`zoneinfo`) because ``zoneinfo``
resolves ``America/New_York`` from the operating system's tz database, which is
not guaranteed to be present in a ``python:3.12-slim`` layer; a missing tzdb
raises at the first hourly reconcile and not at deploy time. The US rule has
been fixed since 2007 and is expressed against UTC instants, which also sidesteps
the ambiguous local hour at each transition. ``tests/test_detect_logic.py``
cross-checks it against :mod:`zoneinfo` wherever the tz database IS available.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, timezone
from typing import Any

from app import classify
from app.sec.adapter_types import CurrentFilingEntry, DailyIndexRow, EftsHit

# ── Walk shape ──────────────────────────────────────────────────────────────

#: Entries requested per ``getcurrent`` page. SEC's maximum for this endpoint.
PAGE_SIZE = 100

#: Pages one run may walk. At the 16:00-18:00 ET peak a 100-entry page spans
#: minutes; after hours it spans about two hours. 20 pages is therefore hours of
#: feed on a quiet evening and roughly half an hour at the peak — enough to
#: recover from a handful of missed minutely runs, and bounded so a cursor that
#: has rolled out of the rolling window cannot turn one run into an unbounded
#: crawl. What the page cap does NOT cover is caught by the hourly EFTS pass and
#: the nightly ``submissions.zip`` ledger.
MAX_PAGES = 20

#: Wall-clock budget for one handler invocation, checked BETWEEN pages — so the
#: true wall is ``budget + one page fetch``. Pub/Sub's push ack deadline is
#: 600 s and it is the binding constraint (Cloud Run's own request timeout is
#: 3600 s); overrunning it makes Pub/Sub REDELIVER while the first copy is still
#: running. 420 s leaves 180 s for one pathological page plus the fan-out and
#: the outcome report, and matches ``stock-document-extract`` and
#: ``mf-nav-backfill``.
RUN_TIME_BUDGET_SECONDS = 420.0

#: How far back the hourly EFTS reconcile looks. Two hours against an hourly
#: schedule means every filing is offered to the sweep twice, so one missed run
#: costs nothing. EFTS filters by DATE, so the effective window is always at
#: least a whole Eastern day — the lookback decides how many days, not how many
#: hours.
EFTS_LOOKBACK_MINUTES = 120

#: Hits per EFTS page. ``from`` steps by this amount.
EFTS_PAGE_SIZE = 100

#: EFTS exposes a 10,000-hit window per query; 100 pages of 100 is exactly that
#: ceiling, so this cap is the API's and not a guess.
EFTS_MAX_PAGES = 100


# ── Named stop reasons ──────────────────────────────────────────────────────
#
# EVERY exit from the page walk carries one of these, and they are emitted in
# the job outcome. "Why did it stop" must never be something a reader has to
# infer from a page count: `page-cap` (we are behind and should look again),
# `budget-spent` (we ran out of time), `cursor-reached` and `nothing-new` (we
# are caught up) are four different operational situations, and two of them are
# healthy. Collapsing them into "the walk ended" is how a job that has silently
# stopped keeping up looks exactly like one that has nothing to do.

#: We saw the filing the last run stopped at. Caught up. Healthy.
STOP_CURSOR_REACHED = "cursor-reached"

#: The last page contributed no filing we had not already collected in this
#: walk — an empty page, or the rolling window repeating itself. Caught up.
STOP_NOTHING_NEW = "nothing-new"

#: The wall budget ran out. We are BEHIND; the next scheduled run continues from
#: the same cursor.
STOP_BUDGET_SPENT = "budget-spent"

#: :data:`MAX_PAGES` pages walked without reaching the cursor. We are behind by
#: more than one run can cover.
STOP_PAGE_CAP = "page-cap"

#: A publish failed, so the fan-out stopped rather than stranding a further
#: N rows behind a broken transport.
STOP_PUBLISH_FAILED = "publish-failed"

#: Every stop reason the walk itself can produce.
WALK_STOP_REASONS: tuple[str, ...] = (
    STOP_CURSOR_REACHED,
    STOP_NOTHING_NEW,
    STOP_BUDGET_SPENT,
    STOP_PAGE_CAP,
)


# ── Types ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class DetectCursor:
    """Where the last run stopped. Persisted as one ``us_edgar_cursor`` row.

    Both halves are load-bearing. ``last_accession`` is the exact filing to stop
    at; ``last_accepted_at`` is the fallback for when that accession has rolled
    out of the rolling ``getcurrent`` window, which is the normal state of
    affairs after any outage longer than the window.
    """

    last_accession: str | None
    last_accepted_at: datetime | None


@dataclass(frozen=True, slots=True)
class PageWalkPlan:
    """What a walk over the pages fetched SO FAR has established.

    Recomputed from the accumulated pages after each fetch. That is deliberately
    a total function of the pages rather than an accumulator the caller mutates:
    a walk that is re-planned from scratch cannot drift out of step with the
    pages it has, and re-running it costs one pass over at most 20 x ~49 items.
    """

    new_entries: tuple[CurrentFilingEntry, ...]
    pages_consumed: int
    #: Every entry examined, INCLUDING the one that matched the cursor.
    entries_seen: int
    #: Entries dropped because their accession had already been collected.
    repeats_collapsed: int
    #: New entries contributed by each consumed page, in order.
    new_per_page: tuple[int, ...]
    cursor_reached: bool

    @property
    def new_on_last_page(self) -> int:
        return self.new_per_page[-1] if self.new_per_page else 0


@dataclass(frozen=True, slots=True)
class WalkDecision:
    """Fetch another page, or stop with a name for why.

    ``stop_reason`` is ``None`` if and only if ``should_fetch_more`` is True. A
    decision that stops always names itself.
    """

    should_fetch_more: bool
    stop_reason: str | None


@dataclass(frozen=True, slots=True)
class FanOutResult:
    """One filing's outcome, in FEED ORDER (newest first).

    ``published`` is True both when we published the message and when the insert
    hit an existing row (another run already owns that filing, so nothing is
    outstanding). It is False only when work remains that this run did not
    complete — which is what keeps the cursor behind it.
    """

    accession: str
    accepted_at: datetime
    published: bool


@dataclass(frozen=True, slots=True)
class EftsReconcilePlan:
    """Which EFTS hits the live detection loop never stored."""

    missing: tuple[EftsHit, ...]
    hits_seen: int
    repeats_collapsed: int
    already_known: int


# ── The page walk ───────────────────────────────────────────────────────────


def is_cursor_boundary(entry: CurrentFilingEntry, cursor: DetectCursor | None) -> bool:
    """True when this entry is where the walk should stop.

    Two independent tests, and the second is not redundant. Matching the
    ACCESSION is exact and is what happens on every healthy run. Matching on
    acceptance time strictly OLDER than the cursor's covers the case the first
    test cannot: after an outage longer than the rolling window, the cursor's
    accession is simply no longer in the feed, and without the timestamp test
    the walk would run to the page cap every minute forever.

    STRICTLY older, never "older or equal": several filings share an acceptance
    second, and treating equality as the boundary would drop the ones that
    happen to sort after the cursor. Re-considering a filing costs one insert
    that fails on the unique index; skipping one loses it.
    """
    if cursor is None:
        return False
    if cursor.last_accession and entry.accession == cursor.last_accession:
        return True
    if cursor.last_accepted_at is not None and entry.accepted_at is not None:
        return as_utc(entry.accepted_at) < as_utc(cursor.last_accepted_at)
    return False


def plan_page_walk(
    pages: Sequence[Sequence[CurrentFilingEntry]],
    cursor: DetectCursor | None,
    max_pages: int = MAX_PAGES,
) -> PageWalkPlan:
    """Which filings on the pages fetched so far are NEW, and did we reach the cursor.

    ``pages`` is a sequence of PAGES, each already deduped within itself by
    ``parse_current_filings_atom``. The cross-page dedupe here is the one that
    matters in production: the ``getcurrent`` window shifts between the two HTTP
    requests that fetch page 1 and page 2, so the tail of one page reappears at
    the head of the next. Publishing that overlap twice is not merely wasteful —
    it doubles every 13F holdings table for the length of the overlap until the
    parser's idempotent upsert catches it.

    The walk stops INSIDE a page at the cursor boundary; entries after it on
    that page are older than the cursor and were handled by an earlier run.
    """
    new_entries: list[CurrentFilingEntry] = []
    new_per_page: list[int] = []
    seen: set[str] = set()
    entries_seen = 0
    repeats_collapsed = 0
    pages_consumed = 0
    cursor_reached = False

    for page in pages:
        if pages_consumed >= max_pages:
            break
        pages_consumed += 1
        new_on_this_page = 0
        for entry in page:
            entries_seen += 1
            if is_cursor_boundary(entry, cursor):
                cursor_reached = True
                break
            if entry.accession in seen:
                repeats_collapsed += 1
                continue
            seen.add(entry.accession)
            new_entries.append(entry)
            new_on_this_page += 1
        new_per_page.append(new_on_this_page)
        if cursor_reached:
            break

    return PageWalkPlan(
        new_entries=tuple(new_entries),
        pages_consumed=pages_consumed,
        entries_seen=entries_seen,
        repeats_collapsed=repeats_collapsed,
        new_per_page=tuple(new_per_page),
        cursor_reached=cursor_reached,
    )


def should_chain(
    *,
    pages_fetched: int,
    max_pages: int,
    cursor_reached: bool,
    new_on_last_page: int,
    elapsed_seconds: float,
    budget_seconds: float,
) -> WalkDecision:
    """Fetch the next ``getcurrent`` page, or stop with a NAMED reason.

    "Chain" here means "fetch the next page of the same walk". This job
    deliberately does NOT publish a follow-up ``edgar-detect`` message when it
    stops early, unlike ``stock-document-extract``: it is triggered every
    minute, so a self-chain would run concurrently with the next scheduled
    trigger and the two copies would race on one cursor row. The schedule IS
    the chain here; the pinned cursor is what makes the next run resume.

    Order of checks is load-bearing. The two HEALTHY exits are tested first, so
    that a run which is genuinely caught up is never reported as
    ``budget-spent`` merely because it also happened to be slow — the difference
    decides whether an operator investigates. Between the two unhealthy exits,
    the budget is tested before the page cap because it is the one that can
    strand a partially-walked page.
    """
    if cursor_reached:
        return WalkDecision(False, STOP_CURSOR_REACHED)
    # An empty page and a page that repeats what we already hold are the same
    # fact — the rolling window has nothing further for us.
    if new_on_last_page <= 0:
        return WalkDecision(False, STOP_NOTHING_NEW)
    if elapsed_seconds >= budget_seconds:
        return WalkDecision(False, STOP_BUDGET_SPENT)
    if pages_fetched >= max_pages:
        return WalkDecision(False, STOP_PAGE_CAP)
    return WalkDecision(True, None)


# ── The cursor ──────────────────────────────────────────────────────────────


def next_cursor(
    results: Sequence[FanOutResult],
    previous: DetectCursor | None,
) -> DetectCursor | None:
    """Where the cursor may safely move to, given what this run actually handed off.

    ``results`` is in FEED ORDER, newest first. The cursor is placed on the
    NEWEST filing that is strictly OLDER than every failure, so that the next
    walk re-reaches every filing this run did not complete. With no failures
    that is simply the newest result; with a failure at index *k* it is index
    *k+1*; with a failure on the last result — or with every result failed —
    the cursor does NOT move.

    Returning ``previous`` unchanged is a real answer and the safe one. A run
    that advanced the cursor on a failure would not lose a retry, it would lose
    the filing: the next walk stops at the new cursor, everything older is never
    looked at again, and ``us_filings`` simply has a hole that nothing reports.

    The cursor is also never moved BACKWARDS. Nothing in the current walk should
    produce that, but a cursor that goes backwards re-walks the same window on
    every run forever, and "impossible" is not a guard.
    """
    if not results:
        return previous

    last_failure = -1
    for index, result in enumerate(results):
        if not result.published:
            last_failure = index

    for result in results[last_failure + 1 :]:
        if not result.published:
            # Unreachable by construction (nothing after the LAST failure can be
            # a failure); kept so the function stays total if `results` is ever
            # handed to it unordered.
            continue
        if (
            previous is not None
            and previous.last_accepted_at is not None
            and as_utc(result.accepted_at) < as_utc(previous.last_accepted_at)
        ):
            return previous
        return DetectCursor(last_accession=result.accession, last_accepted_at=result.accepted_at)

    return previous


# ── Latency ─────────────────────────────────────────────────────────────────


def detect_latency_seconds(accepted_at: datetime | None, now: datetime) -> float | None:
    """Seconds between SEC ACCEPTING a filing and this run storing it.

    ``None`` when ``accepted_at`` is absent — which is a real and frequent case,
    not a defensive branch: EFTS carries ``file_date`` (a day) and no acceptance
    timestamp at all, so every filing recovered by the hourly reconcile has
    nothing to measure. Substituting ``filedAt`` there would emit a latency
    measured in hours for filings the loop never actually saw late, and would
    quietly poison the p95 that the whole 5-minute acceptance gate is read from.

    Negative values are returned UNCLAMPED. A negative latency means the clock
    is wrong or the caller passed the wrong column, and clamping to zero would
    hide exactly the defect this metric exists to expose.
    """
    if accepted_at is None:
        return None
    return (as_utc(now) - as_utc(accepted_at)).total_seconds()


# ── EFTS reconcile ──────────────────────────────────────────────────────────

#: EFTS ``forms=`` values per parse class. These are ROOT forms: asking for
#: ``8-K`` returns ``8-K/A`` as well (measured on the captured fixture — 95
#: ``8-K`` and 5 ``8-K/A`` for a single ``forms=8-K`` query), so the amendment
#: spellings are deliberately absent rather than forgotten.
#:
#: The 13D/13G entries use the LEGACY spelling because ``root_forms`` was never
#: re-spelled by the 2024-12-18 XML mandate — the modern ``SCHEDULE 13D`` form
#: string still has ``SC 13D`` as its root form. Sending the modern spelling
#: here returns zero hits and no error.
EFTS_FORMS_BY_PARSE_CLASS: dict[str, tuple[str, ...]] = {
    classify.OWNERSHIP: ("3", "4", "5"),
    classify.THIRTEENF: ("13F-HR",),
    classify.SCHEDULE13: ("SC 13D", "SC 13G"),
    classify.EIGHTK: ("8-K", "6-K"),
    classify.FINANCIALS: ("10-K", "10-Q", "20-F", "40-F"),
}


def efts_primary_cik10(hit: EftsHit) -> str:
    """The filer a reconciled ``us_filings`` row is attributed to.

    ``ciks`` is an ARRAY — a Form 4 carries the reporting owner and the issuer —
    and ``us_filings`` has one ``cik10`` column. The FIRST entry is SEC's own
    primary filer, matching the primary chosen from the first Atom entry for the
    same accession, so a filing detected live and the same filing recovered by
    the reconcile agree on their ``cik10`` instead of racing to overwrite each
    other with different values.
    """
    return hit.ciks[0] if hit.ciks else ""


def plan_efts_reconcile(
    hits: Sequence[EftsHit],
    known_accessions: Collection[str],
) -> EftsReconcilePlan:
    """Which EFTS hits are not already in ``us_filings``.

    ``already_known`` and the eventual insert count are two DIFFERENT numbers
    and both are reported. This function measures what was missing when the page
    was read; the insert measures what was still missing a moment later. When
    they disagree, the live loop stored the filing in between — which is the
    reconcile doing nothing because the loop is healthy, and it should read that
    way rather than as a write that vanished.
    """
    known = set(known_accessions)
    missing: list[EftsHit] = []
    seen: set[str] = set()
    repeats_collapsed = 0
    hits_seen = 0

    for hit in hits:
        hits_seen += 1
        if not hit.accession:
            continue
        if hit.accession in seen:
            repeats_collapsed += 1
            continue
        seen.add(hit.accession)
        if hit.accession in known:
            continue
        missing.append(hit)

    return EftsReconcilePlan(
        missing=tuple(missing),
        hits_seen=hits_seen,
        repeats_collapsed=repeats_collapsed,
        already_known=len(seen) - len(missing),
    )


# ── US Eastern, the EDGAR calendar ──────────────────────────────────────────

_ET_STANDARD = timezone(timedelta(hours=-5), "EST")
_ET_DAYLIGHT = timezone(timedelta(hours=-4), "EDT")

#: ``date.weekday()`` for Sunday.
_SUNDAY = 6


def _nth_weekday(year: int, month: int, weekday: int, ordinal: int) -> date:
    """The ``ordinal``-th ``weekday`` of a month (1-based)."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (ordinal - 1))


def eastern_offset(moment: datetime) -> timezone:
    """EST or EDT for a UTC instant, under the US rule fixed since 2007.

    Both boundaries are expressed as UTC INSTANTS — 02:00 EST is 07:00 UTC on
    the second Sunday of March, 02:00 EDT is 06:00 UTC on the first Sunday of
    November — which is what makes this exact. Written in local time it would
    have to name an hour that occurs twice in November and not at all in March.
    """
    instant = as_utc(moment)
    year = instant.year
    dst_start = datetime.combine(_nth_weekday(year, 3, _SUNDAY, 2), time(7, 0), UTC)
    dst_end = datetime.combine(_nth_weekday(year, 11, _SUNDAY, 1), time(6, 0), UTC)
    return _ET_DAYLIGHT if dst_start <= instant < dst_end else _ET_STANDARD


def to_eastern(moment: datetime) -> datetime:
    """A UTC instant as the wall clock at SEC's headquarters."""
    instant = as_utc(moment)
    return instant.astimezone(eastern_offset(instant))


def efts_window(now: datetime, lookback_minutes: int = EFTS_LOOKBACK_MINUTES) -> tuple[date, date]:
    """``(startdt, enddt)`` for an EFTS query, as EASTERN calendar days.

    EFTS filters on ``file_date``, which is EDGAR's Eastern day, and offers no
    time-of-day filter at all — so a "last two hours" sweep is expressed as one
    or two whole Eastern days and is expected to re-offer filings the loop
    already has (:func:`plan_efts_reconcile` discards those).

    Converting through Eastern is not a nicety. Between 00:00 and ~05:00 UTC the
    Eastern date is the PREVIOUS day; a window built from the UTC date would ask
    for a day EDGAR has not reached yet, return zero hits, and report a
    perfectly successful reconcile that examined nothing — every single night.
    """
    if lookback_minutes < 0:
        raise ValueError(f"lookback_minutes must be >= 0, got {lookback_minutes}")
    end = to_eastern(now)
    start = to_eastern(as_utc(now) - timedelta(minutes=lookback_minutes))
    return start.date(), end.date()


# ── Shared helpers ──────────────────────────────────────────────────────────


def as_utc(moment: datetime) -> datetime:
    """A timezone-aware UTC datetime.

    A NAIVE input is interpreted as UTC rather than as local time. Everything in
    this service stores and passes aware UTC datetimes (the adapter normalises
    the Atom ``<updated>`` offset), so a naive value here is a bug upstream —
    but interpreting it as the container's local time would silently shift every
    latency sample by the container's offset, and a container's offset is not a
    thing anyone checks.
    """
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def coerce_positive_int(
    value: Any,
    *,
    default: int,
    minimum: int = 1,
    maximum: int | None = None,
) -> int:
    """A bounded integer out of a Pub/Sub payload field.

    A message is JSON from a scheduler row a human typed, so every field is
    hostile until proven otherwise: ``"20"``, ``true``, ``null``, ``-1`` and
    ``1_000_000`` all arrive through the same door. ``bool`` is rejected BEFORE
    ``int`` because ``isinstance(True, int)`` is True in Python, and a payload
    of ``{"limit": true}`` would otherwise become a batch of ONE — a rotation
    that advances one row a night and reads as healthy.
    """
    resolved = default if isinstance(value, bool) or not isinstance(value, int) else value
    if resolved < minimum:
        resolved = default
    if maximum is not None and resolved > maximum:
        resolved = maximum
    return resolved


# ── The weekly full-index reconcile ─────────────────────────────────────────
#
# DAILY INDEX FILES ARE NEVER CORRECTED. `edgar_adapter.parse_daily_index` and
# `adapter_types.DailyIndexRow` both say so, and both point at the same remedy:
# a post-acceptance deletion reaches only the Saturday full-index REBUILD. Until
# something reads that rebuild, `us_filings.status` declares a `WITHDRAWN` value
# that no code path can ever set, and a filing SEC removed stays in our ledger,
# parsed, forever.
#
# THE DIRECTION OF THE DIFF IS THE WHOLE THING. Two sets, two subtractions, two
# completely different operational facts:
#
#   stored - index   a filing WE hold that the rebuild no longer lists.
#                    That is a WITHDRAWAL.
#   index - stored   a filing the rebuild lists that we never stored.
#                    That is a DETECTION GAP — the minutely walk and the hourly
#                    EFTS sweep both missed it.
#
# Conflating them marks real filings withdrawn, which is unrecoverable in
# practice: the accession is already in `us_filings`, so the detector's
# insert-is-the-claim protocol will never re-detect it.

#: The quarterly rebuild. Same pipe-less fixed-column format as a DAILY
#: ``form.idx`` — verified by parsing both through ``parse_daily_index``, which
#: skips the preamble on the ``-----`` rule line rather than on a line count and
#: therefore does not care that the quarterly header says "Master Index" where
#: the daily one says "Daily Index".
FULL_INDEX_URL = "https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{quarter}/form.idx"

#: How many EASTERN calendar days of ``filedAt`` one reconcile judges.
#:
#: A window rather than a whole quarter, and the reason is MEASURED: a quarterly
#: ``form.idx`` is ~1.2M rows (63 dissemination days x 19,412 rows in the
#: captured 2022-02-14 daily file), and holding that many ``DailyIndexRow``
#: objects costs ~800 MB — measured at 127 MB per 194,120 rows. The service is
#: 2Gi at containerConcurrency 4. The FILE is still streamed whole (deletions
#: are absences, so there is nothing to filter on the index side); it is the
#: STORED population and the gap set that this bounds.
FULL_INDEX_WINDOW_DAYS = 14

#: Ceiling on ``windowDays`` from a message. 92 days is one quarter, which is
#: the most a single index file can answer for anyway.
FULL_INDEX_MAX_WINDOW_DAYS = 92

#: Days of settle between the newest filing this reconcile will judge and now.
#:
#: The rebuild happens WEEKLY (Saturday, early morning ET). A filing accepted
#: after the most recent rebuild is absent from the index for a completely
#: innocent reason, and marking it withdrawn would be the reconcile inventing
#: the very corruption it exists to find. Three days covers a Saturday run
#: judging up to Wednesday, and any rebuild lag shorter than a weekend.
FULL_INDEX_SETTLE_DAYS = 3

#: Quarterly index files one run may fetch. See :func:`quarters_between`: a
#: filing is disseminated on or AFTER the day it is dated, by up to nine months
#: (198 of 19,412 rows in the captured daily index, oldest 2021-05-21 in a
#: 2022-02-14 file), so proving a filing absent means checking every quarter
#: from its filing date to today. Four covers a year; beyond that the run says
#: its evidence is INCOMPLETE and marks nothing.
FULL_INDEX_MAX_QUARTERS = 4

#: Detection-gap accessions carried in the job outcome. The COUNT is exact; the
#: list is a sample, because a cold database makes every filing in the window a
#: gap and a 165,000-element JSON body helps nobody.
FULL_INDEX_GAP_SAMPLE = 50

#: Withdrawals that are always plausible without reference to the denominator.
#: Real withdrawals are rare and few; this floor keeps the share test below from
#: refusing a legitimate handful in a thin window.
FULL_INDEX_WITHDRAWAL_FLOOR = 25

#: Above the floor, the share of the window's stored filings that may be marked
#: withdrawn in one run. A reconcile that concludes 40% of a quarter vanished
#: has diffed the wrong quarter, or read a truncated file, or been handed an
#: empty index by a 200 with no body — and the correct response to any of those
#: is to write NOTHING and say so, not to apply the verdict.
FULL_INDEX_MAX_WITHDRAWAL_SHARE = 0.02

#: The evidence was incomplete — a quarter cap, a spent budget, a short read —
#: so no withdrawal verdict was applied. Distinct from "nothing was withdrawn".
STOP_EVIDENCE_INCOMPLETE = "index-evidence-incomplete"

#: The diff proposed an implausible share of the window. Nothing was written.
STOP_WITHDRAWAL_SHARE_IMPLAUSIBLE = "withdrawal-share-implausible"

#: The run planned honestly and wrote nothing because ``EDGAR_PARSE_APPLY`` is
#: not ``"true"``. The SAME LITERAL as ``evict_logic.SKIP_WRITE_DISARMED`` and
#: ``bulk.common.STATUS_WRITE_DISARMED``, deliberately: one Datadog query has to
#: span every disarmed job in this service, and three spellings of one state is
#: how a monitor silently covers two thirds of its population.
SKIP_WRITE_DISARMED = "WRITE_DISARMED"


@dataclass(frozen=True, slots=True)
class Quarter:
    """One EDGAR full-index quarter. ``quarter`` is 1-4."""

    year: int
    quarter: int

    def __post_init__(self) -> None:
        if not 1 <= self.quarter <= 4:
            raise ValueError(f"quarter must be 1-4, got {self.quarter}")

    @property
    def label(self) -> str:
        return f"{self.year}Q{self.quarter}"

    @property
    def start(self) -> date:
        return date(self.year, (self.quarter - 1) * 3 + 1, 1)

    @property
    def end(self) -> date:
        """The LAST day of the quarter, inclusive."""
        return self.following.start - timedelta(days=1)

    @property
    def following(self) -> Quarter:
        if self.quarter == 4:
            return Quarter(self.year + 1, 1)
        return Quarter(self.year, self.quarter + 1)

    @property
    def url(self) -> str:
        return FULL_INDEX_URL.format(year=self.year, quarter=self.quarter)


def quarter_of(day: date) -> Quarter:
    """The full-index quarter a calendar day belongs to."""
    return Quarter(day.year, (day.month - 1) // 3 + 1)


def quarters_between(
    start: date,
    end: date,
    cap: int = FULL_INDEX_MAX_QUARTERS,
) -> tuple[tuple[Quarter, ...], bool]:
    """Every quarter from ``start``'s to ``end``'s, and whether ``cap`` truncated it.

    The range runs FORWARD from the window into the present, which is the only
    direction dissemination can travel: EDGAR stamps a filing with the date it
    was filed and lists it in the index of the quarter it was DISSEMINATED in,
    and dissemination is never earlier than filing. So a filing dated inside the
    window can appear in the window's own quarter or in any LATER one, and
    checking only the window's quarter is exactly how a nine-month-late
    dissemination gets marked withdrawn.

    ``truncated`` is returned rather than raised because it is not an error — it
    is the reason the caller must not apply a withdrawal verdict, and it belongs
    in the job outcome next to the numbers it invalidates.
    """
    if cap < 1:
        raise ValueError(f"cap must be >= 1, got {cap}")
    if end < start:
        raise ValueError(f"end {end} is before start {start}")

    quarters: list[Quarter] = []
    current = quarter_of(start)
    last = quarter_of(end)
    while True:
        quarters.append(current)
        if current == last or len(quarters) >= cap:
            break
        current = current.following
    return tuple(quarters), quarters[-1] != last


def full_index_window(
    now: datetime,
    *,
    window_days: int = FULL_INDEX_WINDOW_DAYS,
    settle_days: int = FULL_INDEX_SETTLE_DAYS,
    end_date: date | None = None,
) -> tuple[date, date]:
    """``(startDate, endDate)`` of EASTERN ``filedAt`` days this run may judge.

    EDGAR assigns filing dates on its own Eastern clock, so the window is
    computed in Eastern and not UTC — the same reason :func:`efts_window` exists.
    Between 00:00 and ~05:00 UTC the two disagree by a day, and a UTC-derived
    window would judge a day EDGAR has not finished.

    ``end_date`` lets a message reconcile a HISTORICAL window, and it is CLAMPED
    rather than trusted: a caller may look further back but never closer to now
    than the settle boundary. Without the clamp, ``{"endDate": "<today>"}``
    would ask this job to mark every filing accepted since the last rebuild as
    withdrawn.
    """
    if window_days < 1:
        raise ValueError(f"window_days must be >= 1, got {window_days}")
    if settle_days < 0:
        raise ValueError(f"settle_days must be >= 0, got {settle_days}")

    latest = to_eastern(now).date() - timedelta(days=settle_days)
    end = latest if end_date is None else min(end_date, latest)
    return end - timedelta(days=window_days - 1), end


@dataclass(frozen=True, slots=True)
class FullIndexPlan:
    """What one pass over the fetched index files established.

    ``withdrawn`` and ``detection_gaps`` are the two subtractions, kept apart on
    purpose. ``detection_gap_count`` is exact even when ``detection_gaps`` is a
    truncated sample.
    """

    withdrawn: tuple[str, ...]
    detection_gaps: tuple[str, ...]
    detection_gap_count: int
    index_rows_seen: int
    index_accessions_in_window: int
    stored_in_window: int


def plan_full_index_reconcile(
    *,
    index_rows: Iterable[DailyIndexRow],
    stored_accessions: Collection[str],
    window_start: date,
    window_end: date,
    gap_sample: int = FULL_INDEX_GAP_SAMPLE,
) -> FullIndexPlan:
    """Diff what we hold against what the rebuild lists. ONE pass, no I/O.

    ``index_rows`` is an ITERABLE and is consumed exactly once, so the caller can
    hand it a generator that fetches and parses a quarter at a time and never
    materialises 1.2M rows. Nothing here holds a row after reading it.

    Both directions are computed in the same pass and neither is derived from
    the other:

    * a stored accession is discarded from ``remaining`` the moment ANY fetched
      quarter lists it, so what is left over is genuinely absent from every
      index we looked at;
    * an index accession is a gap only when its ROW's ``filed_at`` falls inside
      the window AND we do not hold it. The row's date, never the file's — the
      index day is not the filing day for 1% of rows, and a filing dated outside
      the window is simply not this window's business.
    """
    stored = set(stored_accessions)
    remaining = set(stored)
    gaps: set[str] = set()
    in_window: set[str] = set()
    rows_seen = 0

    for row in index_rows:
        rows_seen += 1
        accession = row.accession
        if not accession:
            continue
        # WITHDRAWAL side: presence anywhere in any fetched quarter clears it.
        remaining.discard(accession)
        if not (window_start <= row.filed_at <= window_end):
            continue
        in_window.add(accession)
        # DETECTION-GAP side: tested against the ORIGINAL stored set, never
        # against `remaining` — which is being emptied as we go, so testing
        # against it would report every filing we successfully hold as a gap.
        if accession not in stored:
            gaps.add(accession)

    return FullIndexPlan(
        withdrawn=tuple(sorted(remaining)),
        detection_gaps=tuple(sorted(gaps)[: max(gap_sample, 0)]),
        detection_gap_count=len(gaps),
        index_rows_seen=rows_seen,
        index_accessions_in_window=len(in_window),
        stored_in_window=len(stored),
    )


def withdrawal_is_plausible(
    withdrawn: int,
    stored: int,
    *,
    floor: int = FULL_INDEX_WITHDRAWAL_FLOOR,
    max_share: float = FULL_INDEX_MAX_WITHDRAWAL_SHARE,
) -> bool:
    """Whether a withdrawal count is small enough to be believed and applied.

    This is a SANITY gate on a destructive verdict, not a statistic. Every way
    this reconcile can be wrong — the wrong quarter fetched, a truncated body, a
    200 with an empty index, a window that does not overlap the file — produces
    the same symptom: nearly everything we hold looks absent. Refusing above a
    share is the difference between a bad run that writes nothing and a bad run
    that marks a quarter of the ledger withdrawn.

    Note it does NOT fail open on a small denominator. ``stored == 0`` makes
    ``withdrawn`` zero by construction, so the floor is the only branch a thin
    window can reach, and it is bounded.
    """
    if withdrawn <= floor:
        return True
    if stored <= 0:
        return False
    return withdrawn / stored <= max_share


# ── The CUSIP sweep ─────────────────────────────────────────────────────────
#
# `us_cusip_map` rows carry `source: "UNRESOLVED"` and an `attempts` count, and
# `cusip_map_logic`'s docstring says such a row "is retried weekly". Nothing
# performed that retry, so an unresolved CUSIP stayed unresolved forever and
# every 13F holding for it stayed symbol-less.

#: CUSIPs one sweep visits. Sized against the slowest tier: OpenFIGI takes 100
#: jobs per request at 25 requests / 6 s with a key, so 500 CUSIPs is 5 requests
#: and about a second of pacing. The other three tiers are Mongo reads and a GCS
#: object. Nowhere near the 420 s budget, and small enough that a bad sweep
#: costs 500 rows rather than the table.
CUSIP_SWEEP_BATCH = 500

#: Ceiling on ``limit`` from a message. Unkeyed OpenFIGI is 10 jobs per request
#: at 25 per MINUTE, so 5,000 CUSIPs would be 500 requests and 20 minutes of
#: pacing — past the 600 s ack deadline, which means a redelivery running a
#: second copy of the same sweep.
CUSIP_SWEEP_MAX_BATCH = 2000


def sweep_batch_size(
    requested: Any,
    *,
    default: int = CUSIP_SWEEP_BATCH,
    maximum: int = CUSIP_SWEEP_MAX_BATCH,
) -> int:
    """How many UNRESOLVED rows one sweep visits, from an untrusted payload."""
    return coerce_positive_int(requested, default=default, maximum=maximum)


# ── The event backfill (MONEY-1532) ─────────────────────────────────────────
#
# The live path emits one `InstrumentEvent` per filing it CLAIMS, from
# `handle`'s `finally`, fail-soft — and the claim is consumed whether or not the
# emit lands, so a filing claimed while the transport was down keeps its
# `us_filings` row and never gets its event (MONEY-1520: 100% of them, from the
# day C1 shipped). The event is a projection keyed on the accession, so the row
# is enough to rebuild it; this is the window of rows a rebuild may read.

#: The oldest ``detectedAt`` a backfill may re-emit, in days — the REFUSAL
#: bound. A backfilled event's ``observedAt`` IS its ``detectedAt``, so this
#: bounds how far back in point-in-time a run reaches, and it is kept inside the
#: SERVING retention: MONEY-1521's ``EVENT_RETENTION_DAYS`` (90,
#: ``packages/lake/src/events-logic.ts``). Under MONEY-1521 ``publishEvents``
#: writes no ``expiresAt`` at all (``events.service.ts``); the lake sink is its
#: only writer, at ``observed_at + 90d`` and only after silver holds the row
#: (``appendThenStamp``). So a re-emitted event is never born expired, and one
#: older than 90 days would only be sunk and then deleted within a minute —
#: never lost, merely serving no reader. That is why this is 90 and not the 30
#: the at-write TTL forced; the runbook deploys the workers BEFORE a backfill
#: runs. ``tests/test_event_backfill.py`` fails if TypeScript ever declares a
#: serving retention shorter than this.
EVENT_BACKFILL_MAX_AGE_DAYS = 90

#: How far INSIDE the refusal bound a run with no ``since`` starts, in days.
#: A run reports ``resumeFrom`` — a row of its own window — and the operator
#: re-sends it as ``since``. Were the default window the whole bound, a
#: ``resumeFrom`` near its start would already sit below the floor by the time
#: the next message arrived, because the floor moves with ``now``, and the
#: resume would be refused. One day covers re-sending by hand the same day, the
#: runbook's cadence; a resume older than that is a genuinely stale request, and
#: re-running with no ``since`` is free (the event id is deterministic).
EVENT_BACKFILL_RESUME_GRACE_DAYS = 1


def event_backfill_window(now: datetime, since: Any) -> tuple[datetime, datetime]:
    """``(start, end)`` of the ``detectedAt`` instants one backfill run re-emits.

    ``end`` is ``now``: a run re-emits what was claimed BEFORE it started, and a
    row claimed while it runs is the live path's to emit.

    ``since`` is from a message a human typed, so it is REFUSED rather than
    repaired — ``ValueError`` names the reason and the handler reports it as a
    named skip. Absent means the serving window less
    :data:`EVENT_BACKFILL_RESUME_GRACE_DAYS`, so that the run's own
    ``resumeFrom`` is still accepted as ``since`` a day later. Present, it must
    be an ISO-8601 string (naive is UTC, the rule this module follows
    everywhere). Older than the serving window, or not before ``now``, is
    refused and never clamped: clamping a 120-day request to 90 would report a
    clean run over a window nobody asked for.
    """
    now = as_utc(now)
    floor = now - timedelta(days=EVENT_BACKFILL_MAX_AGE_DAYS)
    if since is None:
        return floor + timedelta(days=EVENT_BACKFILL_RESUME_GRACE_DAYS), now
    if not isinstance(since, str) or not since.strip():
        raise ValueError(f"since must be an ISO-8601 string, got {since!r}")
    try:
        start = as_utc(datetime.fromisoformat(since.strip()))
    except ValueError:
        raise ValueError(f"since is not ISO-8601: {since!r}") from None
    if start < floor:
        raise ValueError(
            f"since {start.isoformat()} is older than the {EVENT_BACKFILL_MAX_AGE_DAYS}-day "
            f"serving window (floor {floor.isoformat()}); see EVENT_BACKFILL_MAX_AGE_DAYS"
        )
    if start >= now:
        raise ValueError(f"since {start.isoformat()} is not before now {now.isoformat()}")
    return start, now
