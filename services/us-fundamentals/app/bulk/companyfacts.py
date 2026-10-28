"""``companyfacts.zip`` -> cold fact shards + ``us_company_facts`` + ``us_fundamentals``.

    python -m app.bulk.companyfacts [--day YYYY-MM-DD] [--force]

Three legs per changed member, in this order, because each is a superset of the
next and the cheapest one to lose is the last:

(a) **Cold shard** ``edgar/facts/{cik10}/{taxonomy}`` — EVERY taxonomy, EVERY
    unit, EVERY value, **including ``frame``**. edgartools' own parser drops
    ``frame`` (the key appears nowhere in the package), and ``frame``
    (``CY2024Q1I``) is SEC's own statement of which fact best fits a calendar
    period — the single de-duplication signal SEC publishes. Once it has been
    parsed away it is unrecoverable without re-downloading 1.31 GiB.
(b) **Hot subset** ``us_company_facts`` — one document per (taxonomy, concept,
    unit) carrying the whole ``values[]`` history, for the concepts a statement
    read actually touches.
(c) **Fallback statements** ``us_fundamentals`` with ``mappingSource:
    "COMPANYFACTS"``, for filers in our listing universe only. These LOSE to
    ``FILING_XBRL`` rows for the same period by declared authority — see
    ``app.store.writers.MAPPING_SOURCE_RANK`` — because `companyfacts.zip`
    carries no dimensional facts and no company extension concepts at all.

## The trap in SEC's own ``fy`` / ``fp``

They describe the FILING a fact appeared in, NOT the fact's own period. Measured,
from the AAPL fixture:

    {"end": "2008-09-27", "val": 5520000000, "accn": "0001193125-09-153165",
     "fy": 2009, "fp": "Q3", "form": "10-Q", "filed": "2009-07-22"}

That is Apple's **2008 fiscal-year-end** accounts payable, carried as a
comparative inside a **2009 Q3** 10-Q. A derivation that took ``fp`` as the
fact's period would file it as Q3 2009 — a real number, a plausible label, and
wrong by three quarters and a year. So the period is derived from ``start`` /
``end`` and from the filer's own fiscal-year-end month, and anything that cannot
be derived is SKIPPED and COUNTED rather than guessed.

## Malformed members

``filersSkipped += 1`` with a named reason, and the batch continues. One filer
whose JSON SEC truncated must not cost the other 14,999 — and the count has to be
visible, because a run that skipped 9,000 members and reported success is the
failure shape this whole service is built to make impossible.
"""

from __future__ import annotations

from app.logging_setup import install_logging

# Installed HERE, at module scope, and NOT inside `main()` — which is where all
# five of these jobs used to call it. `logging_setup` requires it to be the
# first statement for a reason a later call cannot recover: a record emitted
# while the imports below run (an `edgar` warning, a `pymongo` or `ddtrace`
# startup line) reaches Python's lastResort stderr handler with no filter
# attached, and boot-time failures are exactly the ones that still have
# credentials on them. `tests/test_logging_install_sites.py` enforces the
# placement for every entry point so a sixth job cannot regress it.
install_logging()

import argparse  # noqa: E402
import logging  # noqa: E402
import re  # noqa: E402
from collections import Counter  # noqa: E402
from collections.abc import Callable, Iterable, Sequence  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from datetime import UTC, date, datetime  # noqa: E402
from typing import IO, Any  # noqa: E402

from app import db as db_module  # noqa: E402
from app import settings  # noqa: E402
from app.bulk.common import install_sec_limiter  # noqa: E402
from app.logging_setup import log_error  # noqa: E402
from app.sec import archive  # noqa: E402
from app.sec.adapter_types import CompanyFactSeries, CompanyFactValue  # noqa: E402
from app.sec.archive_logic import ArchiveKeyError, facts_shard_key  # noqa: E402
from app.sec.client import SecClient  # noqa: E402
from app.sec.edgar_adapter import (  # noqa: E402
    PARSER_VERSION,
    facts_from_companyfacts_json,
    fiscal_years_with_annual_report,
    json_loads,
)
from app.sec.edgar_adapter import (  # noqa: E402
    cik10 as normalise_cik,
)
from app.sec.errors import SecEgressDisabled, SecError  # noqa: E402
from app.sec.standardize import standardize_concepts  # noqa: E402
from app.store import writers  # noqa: E402
from app.store.models import (  # noqa: E402
    MAPPING_COMPANYFACTS,
    PERIOD_ANNUAL,
    PERIOD_QUARTERLY,
    STATEMENT_BALANCE_SHEET,
    STATEMENT_CASH_FLOW,
    STATEMENT_INCOME,
    UsCompanyFactRow,
    UsEdgarCursorRow,
    UsFundamentalsRow,
    utc_now,
)
from app.store.outcome import report_job_outcome  # noqa: E402
from app.store.writers import WriteResult  # noqa: E402

from .common import (  # noqa: E402
    BULK_URLS,
    CURSOR_KEYS,
    FEED_COMPANYFACTS,
    JOB_KEYS,
    JOB_NAMES,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_NOT_YET_PUBLISHED,
    STATUS_WRITE_DISARMED,
    BulkRunResult,
    CheckpointEntry,
    RunBudget,
    budget_seconds,
    check_upstream,
    load_member_checkpoints,
    load_universe,
    member_unchanged,
    open_zip_archive,
    sha256_hex,
    stamp_unchanged,
    stream_zip_to_gcs,
    upgrade_checkpoint_stamps,
    write_checkpoints,
)

logger = logging.getLogger("us-fundamentals.bulk.companyfacts")

#: Bumped when the mapping rules below change, so a reparse is identifiable.
MAPPING_VERSION = "companyfacts/1"

#: ``CIK0000320193.json``. Anchored and exactly ten digits — see the note on the
#: submissions job's pattern.
_MEMBER_RE = re.compile(r"^CIK(\d{10})\.json$", re.IGNORECASE)

#: Taxonomies whose concepts can appear on a primary statement.
STATEMENT_TAXONOMIES = frozenset({"us-gaap", "ifrs-full"})

#: Forms whose facts we file as statements. Facts SEC carries from an 8-K or a
#: proxy are real, but they are not a statement and pretending otherwise creates
#: a period the filer never reported.
FINANCIAL_FORMS = frozenset(
    {"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"}
)

#: Concept -> which statement it belongs to.
#:
#: DELIBERATELY SMALL. `concept_mappings.json` (edgartools' ~95-concept standard
#: map) is not read here because this module may not ``import edgar`` — that is
#: the adapter's exclusive privilege, enforced by a repo-wide grep test — and a
#: COMPANYFACTS row is a FALLBACK that loses to the per-filing parse anyway. The
#: cold shard always holds EVERY concept, so a name missing from this table costs
#: a slower read, never a lost fact. Widen it by editing this dict and bumping
#: :data:`MAPPING_VERSION`.
STATEMENT_CONCEPTS: dict[str, str] = {
    # ── Income ──
    "Revenues": STATEMENT_INCOME,
    "RevenueFromContractWithCustomerExcludingAssessedTax": STATEMENT_INCOME,
    "RevenueFromContractWithCustomerIncludingAssessedTax": STATEMENT_INCOME,
    "SalesRevenueNet": STATEMENT_INCOME,
    "CostOfRevenue": STATEMENT_INCOME,
    "CostOfGoodsAndServicesSold": STATEMENT_INCOME,
    "GrossProfit": STATEMENT_INCOME,
    "OperatingExpenses": STATEMENT_INCOME,
    "ResearchAndDevelopmentExpense": STATEMENT_INCOME,
    "SellingGeneralAndAdministrativeExpense": STATEMENT_INCOME,
    "OperatingIncomeLoss": STATEMENT_INCOME,
    "NonoperatingIncomeExpense": STATEMENT_INCOME,
    "InterestExpense": STATEMENT_INCOME,
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest": STATEMENT_INCOME,
    "IncomeTaxExpenseBenefit": STATEMENT_INCOME,
    "NetIncomeLoss": STATEMENT_INCOME,
    "EarningsPerShareBasic": STATEMENT_INCOME,
    "EarningsPerShareDiluted": STATEMENT_INCOME,
    "WeightedAverageNumberOfSharesOutstandingBasic": STATEMENT_INCOME,
    "WeightedAverageNumberOfDilutedSharesOutstanding": STATEMENT_INCOME,
    # ── Balance sheet ──
    "CashAndCashEquivalentsAtCarryingValue": STATEMENT_BALANCE_SHEET,
    "ShortTermInvestments": STATEMENT_BALANCE_SHEET,
    "AccountsReceivableNetCurrent": STATEMENT_BALANCE_SHEET,
    "InventoryNet": STATEMENT_BALANCE_SHEET,
    "AssetsCurrent": STATEMENT_BALANCE_SHEET,
    "PropertyPlantAndEquipmentNet": STATEMENT_BALANCE_SHEET,
    "Goodwill": STATEMENT_BALANCE_SHEET,
    "IntangibleAssetsNetExcludingGoodwill": STATEMENT_BALANCE_SHEET,
    "Assets": STATEMENT_BALANCE_SHEET,
    "AccountsPayableCurrent": STATEMENT_BALANCE_SHEET,
    "LiabilitiesCurrent": STATEMENT_BALANCE_SHEET,
    "LongTermDebtNoncurrent": STATEMENT_BALANCE_SHEET,
    "Liabilities": STATEMENT_BALANCE_SHEET,
    "CommonStockValue": STATEMENT_BALANCE_SHEET,
    "RetainedEarningsAccumulatedDeficit": STATEMENT_BALANCE_SHEET,
    "StockholdersEquity": STATEMENT_BALANCE_SHEET,
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest": STATEMENT_BALANCE_SHEET,
    "LiabilitiesAndStockholdersEquity": STATEMENT_BALANCE_SHEET,
    # ── Cash flow ──
    "NetCashProvidedByUsedInOperatingActivities": STATEMENT_CASH_FLOW,
    "NetCashProvidedByUsedInInvestingActivities": STATEMENT_CASH_FLOW,
    "NetCashProvidedByUsedInFinancingActivities": STATEMENT_CASH_FLOW,
    "DepreciationDepletionAndAmortization": STATEMENT_CASH_FLOW,
    "ShareBasedCompensation": STATEMENT_CASH_FLOW,
    "PaymentsToAcquirePropertyPlantAndEquipment": STATEMENT_CASH_FLOW,
    "PaymentsOfDividendsCommonStock": STATEMENT_CASH_FLOW,
    "PaymentsForRepurchaseOfCommonStock": STATEMENT_CASH_FLOW,
}

#: The two ``dei`` counters every equity screen wants and no statement carries.
DEI_HOT_CONCEPTS = frozenset({"EntityCommonStockSharesOutstanding", "EntityPublicFloat"})


#: ``(taxonomy, concept)`` pairs kept in the hot table.
def is_hot_concept(taxonomy: str, concept: str) -> bool:
    """Whether a concept earns a row in ``us_company_facts``. PURE."""
    if taxonomy in STATEMENT_TAXONOMIES:
        return concept in STATEMENT_CONCEPTS
    return taxonomy == "dei" and concept in DEI_HOT_CONCEPTS


#: Day spans that count as a fiscal YEAR and a fiscal QUARTER.
#:
#: Wide enough for 52/53-week retail calendars (364 or 371 days a year, 91 or 98
#: a quarter) and narrow enough to exclude the six- and nine-month YTD durations
#: a 10-Q also reports. Those YTD figures are the reason the bands exist: stored
#: as "Q2" and "Q3" they are 2x and 3x the real quarter, they look entirely
#: normal, and every growth rate computed from them is wrong.
ANNUAL_SPAN_DAYS = (330, 400)
QUARTER_SPAN_DAYS = (80, 100)

#: Fiscal-quarter label by months elapsed since the fiscal year end.
QUARTER_BY_MONTH_OFFSET: dict[int, tuple[str, str]] = {
    0: (PERIOD_ANNUAL, "FY"),
    3: (PERIOD_QUARTERLY, "Q1"),
    6: (PERIOD_QUARTERLY, "Q2"),
    9: (PERIOD_QUARTERLY, "Q3"),
}

#: A group with fewer mapped concepts than this is not a statement, it is a
#: fragment — one comparative line carried into an unrelated filing. Storing it
#: would create a period that reads as "we have this filer's income statement"
#: while holding a single number.
MIN_CONCEPTS_PER_STATEMENT = 3


# ── Pure derivation ─────────────────────────────────────────────────────────


def fiscal_year_end_month(series: Iterable[CompanyFactSeries]) -> int | None:
    """The month a filer's fiscal year ends in, derived from its OWN facts. PURE.

    Taken from the annual-length durations the filer reported, by majority. It is
    derived rather than read off ``UsFiler.fiscalYearEnd`` so this job does not
    depend on the submissions job having run first — and so a filer that changed
    its fiscal year end shows up as a disagreement here instead of being labelled
    against a boundary it no longer uses.

    ``None`` when the filer has no annual duration at all, in which case no
    quarterly label can be derived either and those rows are skipped.
    """
    months: Counter[int] = Counter()
    for entry in series:
        for value in entry.values:
            if value.start is None:
                continue
            span = (value.end - value.start).days
            if ANNUAL_SPAN_DAYS[0] <= span <= ANNUAL_SPAN_DAYS[1]:
                months[value.end.month] += 1
    if not months:
        return None
    # Ties broken by the LOWER month number so the answer cannot depend on
    # Counter's insertion order.
    best = max(months.values())
    return min(month for month, count in months.items() if count == best)


def classify_period(
    value: CompanyFactValue, *, fiscal_end_month: int | None
) -> tuple[str, str] | None:
    """``(periodType, fiscalPeriod)`` for one fact, or ``None`` if underivable. PURE.

    A DURATION is classified by its span: a fiscal year is ``FY``; a fiscal
    quarter takes its label from how far its end sits from the fiscal year end.
    An INSTANT — every balance-sheet fact — has no span, so the same month offset
    decides both halves.

    Returning ``None`` is the honest answer for a six-month YTD figure, a
    transition period, or a filer whose fiscal calendar cannot be established.
    The caller counts those; it does not invent a label for them.
    """
    if value.start is not None:
        span = (value.end - value.start).days
        if ANNUAL_SPAN_DAYS[0] <= span <= ANNUAL_SPAN_DAYS[1]:
            return (PERIOD_ANNUAL, "FY")
        if not (QUARTER_SPAN_DAYS[0] <= span <= QUARTER_SPAN_DAYS[1]):
            return None
    if fiscal_end_month is None:
        return None
    offset = (value.end.month - fiscal_end_month) % 12
    resolved = QUARTER_BY_MONTH_OFFSET.get(offset)
    if resolved is None:
        return None
    if value.start is not None and resolved[0] == PERIOD_ANNUAL:
        # A quarter-length duration that lands on the fiscal year end is the
        # FOURTH QUARTER, not the year. Only the annual span above may claim FY.
        return (PERIOD_QUARTERLY, "Q4")
    return resolved


@dataclass(frozen=True, slots=True)
class _GroupKey:
    accession: str
    statement_type: str
    period_start: date | None
    period_end: date


def derive_fundamentals_rows(
    series: Sequence[CompanyFactSeries],
    *,
    cik10: str,
    symbol: str | None = None,
    now: datetime | None = None,
) -> tuple[list[UsFundamentalsRow], dict[str, int]]:
    """Entity-wide facts -> point-in-time statement rows. PURE.

    Returns the rows and a counter dict (``factsConsidered`` / ``factsSkipped`` /
    ``groupsDropped``) so the job reports what it could NOT derive alongside what
    it could. A derivation that silently discards two thirds of its input and
    reports only its output is indistinguishable from one that had less input.
    """
    stamp = now or utc_now()
    fiscal_end_month = fiscal_year_end_month(series)
    counters = {
        "factsConsidered": 0,
        "factsSkipped": 0,
        "groupsDropped": 0,
        "conceptsUnmapped": 0,
        "conceptsCollided": 0,
        "groupsUnstandardizable": 0,
    }

    grouped: dict[tuple[str, str, str | None, str], dict[str, Any]] = {}
    for entry in series:
        if entry.taxonomy not in STATEMENT_TAXONOMIES:
            continue
        statement_type = STATEMENT_CONCEPTS.get(entry.concept)
        if statement_type is None:
            continue
        for value in entry.values:
            if value.form not in FINANCIAL_FORMS:
                continue
            counters["factsConsidered"] += 1
            classified = classify_period(value, fiscal_end_month=fiscal_end_month)
            if classified is None:
                counters["factsSkipped"] += 1
                continue
            period_type, fiscal_period = classified
            # The start is spelled "" when absent, never None: one accession can
            # legitimately carry BOTH an instant and a duration for the same
            # statement type (a concept a filer tagged the other way round), and
            # sorting a mixed None/str tuple raises TypeError — which would cost
            # the whole member, not the one odd fact.
            key = (
                value.accn,
                statement_type,
                value.start.isoformat() if value.start else "",
                value.end.isoformat(),
            )
            bucket = grouped.setdefault(
                key,
                {
                    "periodType": period_type,
                    "fiscalPeriod": fiscal_period,
                    "periodStart": value.start,
                    "periodEnd": value.end,
                    "form": value.form,
                    "filed": value.filed,
                    "standardized": {},
                    "asReported": [],
                },
            )
            if entry.concept in bucket["standardized"]:
                # One concept, one unit-family, one period, one accession: SEC
                # publishes this once. A repeat means two units (USD and shares
                # for the same tag); the first wins and the second is counted
                # rather than overwriting a number of a different kind.
                counters["factsSkipped"] += 1
                continue
            bucket["standardized"][entry.concept] = value.val
            bucket["asReported"].append(
                {
                    "concept": entry.concept,
                    "label": entry.label,
                    "value": value.val,
                    "unit": entry.unit,
                }
            )

    rows: list[UsFundamentalsRow] = []
    for (accession, statement_type, _start, _end), bucket in sorted(grouped.items()):
        if len(bucket["standardized"]) < MIN_CONCEPTS_PER_STATEMENT:
            counters["groupsDropped"] += 1
            continue
        period_end: date = bucket["periodEnd"]
        # STANDARDIZE THE KEYS. `bucket["standardized"]` has accumulated RAW
        # us-gaap tags, which is the vocabulary `companyfacts.zip` speaks. The
        # per-filing parser stores edgartools' `standard_tags` in this same
        # column, and the reader has ONE table — so a raw-tag row was half
        # unreadable (13 of the reader's 26 concepts, including the entire cash
        # flow statement, equity and working capital). It read as a thin filer,
        # not as a bug.
        #
        # The GROUP GATE above deliberately still counts RAW concepts. Gating on
        # the standardized count would drop groups this job has always kept,
        # turning a correctness fix into a silent coverage regression.
        standardized_view, unmapped, collisions = standardize_concepts(bucket["standardized"])
        counters["conceptsUnmapped"] += unmapped
        counters["conceptsCollided"] += collisions
        if not standardized_view:
            # Every concept was an extension or otherwise unmapped. `asReported`
            # would survive but nothing could read the statement, so storing it
            # would add a row that renders blank.
            counters["groupsUnstandardizable"] += 1
            continue
        rows.append(
            UsFundamentalsRow(
                cik10=cik10,
                symbol=symbol,
                statementType=statement_type,
                periodType=bucket["periodType"],
                periodStart=bucket["periodStart"],
                periodEnd=period_end,
                # The CALENDAR year of `periodEnd`, stated as a convention.
                # SEC's own `fy` describes the FILING a fact appeared in, not the
                # fact's period — see the module docstring's measured example.
                fiscalYear=period_end.year,
                fiscalPeriod=bucket["fiscalPeriod"],
                accession=accession,
                form=bucket["form"],
                filedAt=bucket["filed"],
                isAmendment=bucket["form"].endswith("/A"),
                mappingSource=MAPPING_COMPANYFACTS,
                mappingVersion=MAPPING_VERSION,
                parserVersion=PARSER_VERSION,
                standardized=dict(sorted(standardized_view.items())),
                asReported=sorted(bucket["asReported"], key=lambda item: item["concept"]),
                ingestedAt=stamp,
                updatedAt=stamp,
            )
        )
    return rows, counters


def _value_doc(value: CompanyFactValue) -> dict[str, Any]:
    """One ``values[]`` entry / one shard line. ``None`` keys are OMITTED.

    Dates are ISO STRINGS, not BSON dates: this rides inside a Prisma ``Json``
    column and inside a gz-JSONL shard, and both want a plain, portable scalar.
    ``frame`` is carried whenever SEC published one.
    """
    doc: dict[str, Any] = {
        "end": value.end.isoformat(),
        "val": value.val,
        "accn": value.accn,
        "form": value.form,
        "filed": value.filed.isoformat(),
    }
    if value.start is not None:
        doc["start"] = value.start.isoformat()
    if value.fy is not None:
        doc["fy"] = value.fy
    if value.fp:
        doc["fp"] = value.fp
    if value.frame:
        doc["frame"] = value.frame
    return doc


def shard_rows(series: Sequence[CompanyFactSeries]) -> dict[str, list[dict[str, Any]]]:
    """``{taxonomy: [row, ...]}`` for the cold shards. PURE, and LOSSLESS.

    Every taxonomy, every unit, every value, ``frame`` included. ``taxonomy``
    itself is not repeated on the row because it is the shard key.
    """
    by_taxonomy: dict[str, list[dict[str, Any]]] = {}
    for entry in series:
        for value in entry.values:
            row = _value_doc(value)
            row["concept"] = entry.concept
            row["unit"] = entry.unit
            if entry.label:
                row["label"] = entry.label
            by_taxonomy.setdefault(entry.taxonomy, []).append(row)
    return by_taxonomy


def shard_row_key(row: dict[str, Any]) -> str:
    """Identity of one shard line. ``val`` is EXCLUDED, deliberately.

    Merge-on-write makes the incoming row win, so leaving ``val`` out means SEC
    correcting a number REPLACES the old line. Including it would keep both and
    the shard would hold two contradictory values for one fact with nothing to
    choose between them.
    """
    return "|".join(
        str(row.get(field) or "")
        for field in (
            "concept",
            "unit",
            "start",
            "end",
            "accn",
            "fy",
            "fp",
            "form",
            "filed",
            "frame",
        )
    )


def build_company_fact_rows(
    series: Sequence[CompanyFactSeries], *, now: datetime | None = None
) -> list[UsCompanyFactRow]:
    """The hot subset, one row per ``(cik10, taxonomy, concept, unit)``. PURE."""
    stamp = now or utc_now()
    rows: list[UsCompanyFactRow] = []
    for entry in series:
        if not is_hot_concept(entry.taxonomy, entry.concept):
            continue
        if not entry.values:
            continue
        # The adapter already sorts by (end, filed); re-stating it here would be
        # a second copy of one rule, so the assertion lives in the test instead.
        rows.append(
            UsCompanyFactRow(
                cik10=entry.cik10,
                taxonomy=entry.taxonomy,
                concept=entry.concept,
                unit=entry.unit,
                label=entry.label,
                values=[_value_doc(value) for value in entry.values],
                lastFiledAt=max(value.filed for value in entry.values),
                ingestedAt=stamp,
                updatedAt=stamp,
            )
        )
    return rows


# ── The job ─────────────────────────────────────────────────────────────────


def run(
    *,
    db: Any,
    client: Any,
    day: date | None = None,
    force: bool = False,
    apply_writes: bool | None = None,
    budget: RunBudget | None = None,
    opener: Callable[[str], IO[bytes]] | None = None,
    archive_key: str | None = None,
) -> BulkRunResult:
    """One full pass. Every collaborator is injectable so a test drives THIS code."""
    feed = FEED_COMPANYFACTS
    job_key = JOB_KEYS[feed]
    clock = budget or RunBudget(budget_seconds(feed))
    applying = settings.parse_apply() if apply_writes is None else apply_writes

    counters = {
        "membersTotal": 0,
        "membersIgnored": 0,
        "membersSkipped": 0,
        "filersSkipped": 0,
        "shardsWritten": 0,
        "shardRows": 0,
        "hotFacts": 0,
        "statementRows": 0,
        "statementsSuppressed": 0,
        "conceptsUnmapped": 0,
        "conceptsCollided": 0,
        "groupsUnstandardizable": 0,
        "factsSkipped": 0,
        "groupsDropped": 0,
    }
    totals = WriteResult()
    selected = 0

    decision = check_upstream(client, BULK_URLS[feed], CURSOR_KEYS[feed], db=db, force=force)
    if not decision.should_process:
        return BulkRunResult(
            status=STATUS_NOT_YET_PUBLISHED,
            skipped_reason=STATUS_NOT_YET_PUBLISHED,
            counters=counters,
        )

    if archive_key is None:
        stream = stream_zip_to_gcs(client, feed, day=day or datetime.now(UTC).date())
        key = str(stream.get("key") or "")
    else:
        key = archive_key

    checkpoints = load_member_checkpoints(db, job_key)
    universe = load_universe(db)
    finished: list[CheckpointEntry] = []
    upgrades: dict[str, str] = {}
    status = STATUS_COMPLETED

    with open_zip_archive(key, opener=opener) as zip_archive:
        names = zip_archive.names()
        members = [
            (match.group(1), name)
            for name in names
            if (match := _MEMBER_RE.match(name.rsplit("/", 1)[-1]))
        ]
        counters["membersTotal"] = len(members)
        counters["membersIgnored"] = len(names) - len(members)

        for cik, name in members:
            if clock.exhausted():
                status = STATUS_BUDGET_EXHAUSTED
                logger.info(
                    "[companyfacts] budget exhausted after %.0fs; %d of %d members done",
                    clock.elapsed(),
                    selected + counters["membersSkipped"],
                    len(members),
                )
                break

            previous = checkpoints.get(cik)
            # BEFORE any read — the same MONEY-1283 defect this job shared with
            # `submissions`: a member is decompressed straight out of a live GCS
            # object, so hashing it to discover it was already done charges a
            # network round trip to the run budget for work that is finished.
            # The stamp comes from the central directory `zipfile` already holds
            # in memory, so recognising it costs nothing.
            stamp = zip_archive.member_stamp(name)
            if previous is not None and stamp_unchanged(previous.stamp, stamp):
                counters["membersSkipped"] += 1
                continue

            try:
                blob = zip_archive.member(name).read()
            except Exception as err:
                counters["filersSkipped"] += 1
                log_error(f"[companyfacts] {cik}: member unreadable", err)
                continue

            digest = sha256_hex(blob)
            if member_unchanged(previous.sha256 if previous else None, digest):
                counters["membersSkipped"] += 1
                # The digest agrees but the stamp did not, so the stored stamp is
                # ABSENT (a pre-MONEY-1283 checkpoint — which is all of them on
                # prod today) or in an older stamp FORMAT. Either way the cheap
                # key on that row cannot recognise these bytes, so record the one
                # that can. Upgraded in place, `stamp` only, so the rows/bytes of
                # the run that did the work survive.
                if applying and previous is not None:
                    upgrades[cik] = stamp
                    if len(upgrades) >= writers.DEFAULT_CHUNK:
                        upgrade_checkpoint_stamps(db, job_key, upgrades)
                        upgrades = {}
                continue

            selected += 1
            try:
                payload = json_loads(blob)
                series = facts_from_companyfacts_json(payload)
            except Exception as err:
                counters["filersSkipped"] += 1
                _record_failure(db, job_key, cik, err, applying=applying)
                log_error(f"[companyfacts] {cik}: malformed member, skipped", err)
                continue

            resolved_cik = normalise_cik(payload.get("cik")) or cik
            entity_name = str(payload.get("entityName") or "").strip()
            try:
                written = _write_member(
                    db,
                    cik=resolved_cik,
                    entity_name=entity_name,
                    series=series,
                    universe=universe,
                    counters=counters,
                    applying=applying,
                )
            except Exception as err:
                # ONE filer must never end the walk. The parse above has had this
                # containment since it shipped; the WRITE did not, and sat
                # outside the try — so an out-of-range `val` raised
                # OverflowError straight out of the loop and killed the first
                # production run at 4,500 of 20,290 members (MONEY-1284).
                #
                # `_bson_safe_val` now sanitises that specific value at the
                # boundary. This is the containment that makes the NEXT thing
                # SEC files cost one filer rather than the whole walk, which is
                # the same lesson MONEY-1276 taught with a null inside
                # `exchanges`. The checkpoint written here is ERROR, never DONE,
                # so the member is retried rather than silently skipped forever.
                counters["filersSkipped"] += 1
                _record_failure(db, job_key, cik, err, applying=applying)
                log_error(f"[companyfacts] {cik}: write failed, skipped", err)
                continue
            totals = totals + written

            if not applying:
                continue
            finished.append(
                # `stamp` beside `detail`, never instead of it: the cheap key is
                # only trustworthy because this run verified the digest too.
                CheckpointEntry(
                    item_key=cik,
                    detail=digest,
                    rows=written.written,
                    bytes=len(blob),
                    stamp=stamp,
                )
            )
            if len(finished) >= writers.DEFAULT_CHUNK:
                write_checkpoints(db, job_key, finished)
                finished = []

    if applying and finished:
        write_checkpoints(db, job_key, finished)
    if applying and upgrades:
        upgrade_checkpoint_stamps(db, job_key, upgrades)

    if applying:
        if status == STATUS_COMPLETED:
            writers.upsert_cursor(
                db,
                UsEdgarCursorRow(
                    key=CURSOR_KEYS[feed],
                    lastRunAt=utc_now(),
                    meta={
                        **decision.meta(),
                        "parserVersion": PARSER_VERSION,
                        "mappingVersion": MAPPING_VERSION,
                    },
                ),
            )
    elif status == STATUS_COMPLETED:
        status = STATUS_WRITE_DISARMED

    return BulkRunResult(
        status=status,
        selected=selected,
        written=totals.written,
        failed=counters["filersSkipped"] + totals.failed,
        skipped_reason=STATUS_WRITE_DISARMED if not applying else None,
        counters=counters,
    )


def _write_member(
    db: Any,
    *,
    cik: str,
    entity_name: str,
    series: Sequence[CompanyFactSeries],
    universe: Any,
    counters: dict[str, int],
    applying: bool,
) -> WriteResult:
    """The three legs for one filer. Counters are bumped AFTER the call they count."""
    total = WriteResult()

    # (a) Cold shard — everything, including `frame`.
    for taxonomy, rows in sorted(shard_rows(series).items()):
        if not applying:
            continue
        try:
            outcome = archive.merge_and_write_shard(
                facts_shard_key(cik, taxonomy), rows, shard_row_key
            )
        except ArchiveKeyError as err:
            # A taxonomy that is not a usable key segment. Counted, never fatal:
            # the other taxonomies of this filer are still archivable.
            log_error(f"[companyfacts] {cik}: taxonomy {taxonomy!r} is not a key segment", err)
            continue
        counters["shardsWritten"] += 1
        counters["shardRows"] += int(outcome.get("merged", 0))

    # (b) Hot subset.
    hot_rows = build_company_fact_rows(series)
    if applying and hot_rows:
        total = total + writers.upsert_company_facts(db, hot_rows)
        counters["hotFacts"] += len(hot_rows)

    # (c) Fallback statements, in-universe filers only.
    if universe.contains(cik):
        statement_rows, derived = derive_fundamentals_rows(
            series, cik10=cik, symbol=universe.symbol_for(cik)
        )
        counters["factsSkipped"] += derived["factsSkipped"]
        counters["groupsDropped"] += derived["groupsDropped"]
        counters["conceptsUnmapped"] += derived["conceptsUnmapped"]
        counters["conceptsCollided"] += derived["conceptsCollided"]
        counters["groupsUnstandardizable"] += derived["groupsUnstandardizable"]
        if applying and statement_rows:
            written = writers.upsert_fundamentals(db, statement_rows)
            total = total + written
            counters["statementRows"] += len(statement_rows)
            # Rows a stronger source (FILING_XBRL) already holds. In the steady
            # state most nights this is the MAJORITY of what this leg produces,
            # and that is correct behaviour, not a shortfall — the per-filing
            # parser got there first with the richer view. Counted so the number
            # is visible rather than inferred from a gap between two others.
            counters["statementsSuppressed"] += written.suppressed
            for group in {
                (row.statementType, row.periodType, row.periodEnd) for row in statement_rows
            }:
                writers.recompute_is_latest(db, cik, group[0], group[1], group[2])

    # (d) The coverage denominator, raised and never lowered.
    if applying:
        years = fiscal_years_with_annual_report(list(series))
        writers.bump_filer_coverage(
            db,
            cik,
            name=entity_name or cik,
            fiscal_years_on_file=len(years),
            # Decision 5: fewer than five years is NOT a failure. A 2025 IPO with
            # one fiscal year on file stores that one year and is reported as
            # ineligible, which is what keeps the coverage gate a measurement of
            # US rather than of the market.
            eligible_for_coverage=len(years) >= 5,
        )
    return total


def _record_failure(db: Any, job_key: str, cik: str, err: BaseException, *, applying: bool) -> None:
    """An ERROR checkpoint for triage. ``load_checkpoints`` never returns it."""
    if not applying:
        return
    write_checkpoints(
        db, job_key, [CheckpointEntry(item_key=cik, detail=type(err).__name__, status="ERROR")]
    )


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(prog="python -m app.bulk.companyfacts")
    parser.add_argument("--day", help="Archive day (YYYY-MM-DD). Defaults to today, UTC.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Process the file even when its validators say it has not changed.",
    )
    args = parser.parse_args(argv)
    day = date.fromisoformat(args.day) if args.day else datetime.now(UTC).date()

    job = JOB_NAMES[FEED_COMPANYFACTS]
    result = BulkRunResult(status=STATUS_FAILED, skipped_reason="DID_NOT_RUN")
    try:
        database = db_module.get_database()
        if database is None:
            raise RuntimeError("DATABASE_URL is not set; refusing to run with nowhere to write")
        # A Cloud Run JOB is its own process and does not share the service's
        # lifespan, so it installs its own shared 9 req/s budget. Without this
        # the first fetch raises LimiterUnavailable, which the handler below
        # classifies as a deterministic upstream refusal — a clean-looking run
        # that fetched nothing.
        install_sec_limiter()
        with SecClient.from_settings() as client:
            result = run(db=database, client=client, day=day, force=args.force)
    except SecEgressDisabled as err:
        result = BulkRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason="SEC_EGRESS_DISABLED"
        )
        log_error("[companyfacts] SEC egress is disabled in this environment", err)
    except SecError as err:
        result = BulkRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason=type(err).__name__
        )
        log_error("[companyfacts] upstream failure", err)
    except Exception as err:
        result = BulkRunResult(status=STATUS_FAILED, skipped_reason=type(err).__name__)
        log_error("[companyfacts] run failed", err)
    finally:
        report_job_outcome(
            job,
            selected=result.selected,
            written=result.written,
            failed=result.failed,
            transport_failures=result.transport_failures,
            skipped_reason=result.skipped_reason or result.status,
        )
        logger.info("[companyfacts] %s %s", result.status, result.counters)
    return result.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
