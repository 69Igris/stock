"""10-K/10-Q/20-F/40-F -> ``us_fundamentals``. PURE — no I/O, no clock.

Two views of the same filing, stored side by side and for different reasons:

``standardized``  keyed by edgartools' standard concept names, which is what a
                  cross-company query needs — ~95 concepts distilled from 2,923
                  tags.
``asReported``    concept + label + value + unit + dimensions, exactly as the
                  filer tagged it. Roughly 5% of tags fall outside the standard
                  map and company EXTENSION concepts fall outside it by
                  definition, so this is the only place a segment breakdown
                  exists at all — ``companyfacts.zip`` carries no dimensional
                  facts whatsoever. It is also the audit trail: a standardized
                  number nobody can trace back to a filed label is a number
                  nobody can defend.

``mappingSource: "FILING_XBRL"``, which OUTRANKS the ``COMPANYFACTS`` rows T5
writes for the same period — the per-filing instance is the richer document and
the bulk file is the backfill.

REVENUE AND OPERATING CASH FLOW ARE CHAINS, NOT CONCEPTS. There is no single tag
that means "revenue" across US GAAP:

* ``SalesRevenueNet`` was DEPRECATED 2018-01-31;
* ``RevenueFromContractWithCustomerExcludingAssessedTax`` (ASC 606) dominates
  from FY2018;
* ``Revenues`` remains the sanctioned total for banks, insurers and mixed
  filers, and is not going away.

and for cash flow, ``NetCashProvidedByUsedInOperatingActivitiesContinuingOperations``
is misused as the total often enough that SEC issued a data-quality reminder
(2021-05-25) — so the TOTAL line is preferred and the continuing-operations line
is the fallback, not the other way round.

WHICH LINK FIRED IS STORED, in ``standardized["_fallbacks"]``. The chain is
PROVENANCE first and a value producer second: where the library already
standardised a number, the chain records which tag it came from and whether the
two agree; it fills the key only when the library left it EMPTY, and where they
disagree it records both and CHANGES NOTHING. Silently overriding would make
``standardized`` neither the library's view nor ours, and the pin on
``mappingVersion`` would stop meaning anything.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import date, datetime
from typing import Any

from app.parsers import SOURCE, as_datetime
from app.sec.adapter_types import StatementLine, StatementSet

#: Bumped when the rules in THIS file change, so a reparse is identifiable and
#: a bad mapping is re-runnable rather than indistinguishable from the truth.
#: Distinct from ``parserVersion`` (which pins edgartools): the library can move
#: without our rules moving, and vice versa.
MAPPING_VERSION = "us-fundamentals/mapping/1"

#: The per-filing XBRL instance. Outranks T5's ``COMPANYFACTS`` rows.
MAPPING_SOURCE = "FILING_XBRL"

#: ``UsFundamentals.statementType`` -> the attribute on :class:`StatementSet`.
#:
#: There are THREE. ``StatementSet.equity`` is parsed by the adapter and has no
#: statement type in the schema, so it is not written — counted instead, under
#: ``equityLinesSkipped``. Inventing a fourth enum value would put rows in a
#: table whose own documentation says they cannot exist, and every reader
#: filtering on the three would silently ignore them anyway.
STATEMENT_TYPES: tuple[tuple[str, str], ...] = (
    ("INCOME", "income"),
    ("BALANCE_SHEET", "balance"),
    ("CASH_FLOW", "cashflow"),
)

FINANCIALS_FORMS: frozenset[str] = frozenset(
    {"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"}
)

#: Ordered most-modern-first. See the module docstring for why each is here.
REVENUE_CHAIN: tuple[str, ...] = (
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet",
)

#: The TOTAL line first. The continuing-operations line is the fallback because
#: filers tag it as the total — SEC said so in as many words.
OPERATING_CASH_FLOW_CHAIN: tuple[str, ...] = (
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
)

#: Standard-concept key -> (statement attribute, chain). Both targets are named
#: with the library's OWN standard concept, so a chain fills a gap in the same
#: namespace rather than shadowing it with a second spelling of one number.
FALLBACK_CHAINS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Revenue", "INCOME", REVENUE_CHAIN),
    ("NetCashFromOperatingActivities", "CASH_FLOW", OPERATING_CASH_FLOW_CHAIN),
)


def local_name(concept: str) -> str:
    """``us-gaap_GrossProfit`` -> ``GrossProfit``; ``us-gaap:X`` -> ``X``.

    Both separators, because the adapter emits ``_`` on concepts and ``:`` on
    dimension axes and one function should not care which it was handed. XBRL
    element names are camelCase with no separator of their own, so splitting on
    the FIRST one is unambiguous.
    """
    for sep in ("_", ":"):
        if sep in concept:
            return concept.split(sep, 1)[1]
    return concept


def period_type(fiscal_period: str | None) -> str:
    """``ANNUAL`` for FY, ``QUARTERLY`` otherwise.

    A 10-K's Q4 is NOT derived here. That is the ratio engine's job
    (MONEY-981): deriving it at parse time would store a computed number in a
    table whose entire contract is "as filed".
    """
    return "ANNUAL" if (fiscal_period or "").strip().upper() == "FY" else "QUARTERLY"


def is_entity_wide(line: StatementLine) -> bool:
    """A line about the whole company: not abstract, not dimensional, has a value.

    ``standardized`` is built from these ONLY. A dimensional row carries
    ``standard_concept is None`` anyway, but the check is explicit because
    "iPhone revenue" arriving in a field named ``Revenue`` is a whole-company
    number that is wrong by two thirds, and it would look entirely normal.
    """
    return not line.is_abstract and not line.dimensions and line.value is not None


def standardize(
    lines: Sequence[StatementLine],
) -> tuple[dict[str, float], dict[str, list[dict[str, Any]]]]:
    """``({standardConcept: value}, {standardConcept: [collisions]})``.

    LAST WINS on a repeated standard concept, and the reason is presentation
    order: a statement lists components before the total that sums them, so the
    later line is the one a reader means. Measured on Apple's FY2025 cash flow,
    ``NetCashFromInvestingActivities`` appears twice — once from
    ``PaymentsForProceedsFromOtherInvestingActivities`` (-1,480,000,000, a
    component the library maps optimistically) and once from
    ``NetCashProvidedByUsedInInvestingActivities`` (15,195,000,000, the actual
    total). First-wins would store the component. ``CashAndCashEquivalents``
    behaves the same way: beginning-of-period first, end-of-period last.

    Every collision with a DIFFERENT value is returned so the choice is
    auditable rather than silent. Identical repeats are not collisions.
    """
    values: dict[str, float] = {}
    seen: dict[str, list[dict[str, Any]]] = {}

    for line in lines:
        if not is_entity_wide(line) or not line.standard_concept:
            continue
        value = float(line.value) if line.value is not None else None
        if value is None:
            continue
        key = line.standard_concept
        seen.setdefault(key, []).append({"concept": line.concept, "value": value})
        values[key] = value

    collisions = {
        key: entries
        for key, entries in seen.items()
        if len({entry["value"] for entry in entries}) > 1
    }
    return values, collisions


def as_reported(lines: Sequence[StatementLine]) -> list[dict[str, Any]]:
    """Every line the filer tagged, dimensional rows included.

    Abstract rows and rows with no value for THIS period are dropped: they are
    presentation scaffolding and empty columns, and storing them would put tens
    of thousands of ``value: null`` entries in a Json column whose readers all
    start by filtering them out. ``dimensions`` is omitted entirely when empty
    rather than stored as ``{}``, so an entity-wide line is one key shorter and
    a reader can test presence.
    """
    rows: list[dict[str, Any]] = []
    for line in lines:
        if line.is_abstract or line.value is None:
            continue
        row: dict[str, Any] = {
            "concept": line.concept,
            "label": line.label,
            "value": float(line.value),
            "unit": line.unit,
        }
        if line.standard_concept:
            row["standardConcept"] = line.standard_concept
        if line.dimensions:
            row["dimensions"] = dict(line.dimensions)
        rows.append(row)
    return rows


def apply_fallbacks(
    statement_type: str,
    lines: Sequence[StatementLine],
    standardized: dict[str, float],
) -> dict[str, dict[str, Any]]:
    """Run the chains for ``statement_type``; MUTATE ``standardized`` only to FILL.

    Returns the ``_fallbacks`` record, one entry per chain that applies to this
    statement. Outcomes:

    ``filled``      the library produced nothing for the target and the chain
                    did — this is the only case where a value is written.
    ``agreed``      both produced the same number. Recorded because knowing
                    WHICH tag a revenue came from is the difference between
                    comparing two companies and comparing two accounting
                    policies.
    ``disagreed``   both produced numbers and they differ. BOTH are recorded and
                    the library's is kept; see the module docstring.
    ``absent``      no concept in the chain appears in this filing at all.
    """
    by_local: dict[str, float] = {}
    for line in lines:
        if not is_entity_wide(line) or line.value is None:
            continue
        # Last wins, for the same presentation-order reason as `standardize`.
        by_local[local_name(line.concept)] = float(line.value)

    record: dict[str, dict[str, Any]] = {}
    for target, applies_to, chain in FALLBACK_CHAINS:
        if applies_to != statement_type:
            continue
        hit_rank, hit_concept, hit_value = None, None, None
        for rank, concept in enumerate(chain):
            if concept in by_local:
                hit_rank, hit_concept, hit_value = rank, concept, by_local[concept]
                break

        existing = standardized.get(target)
        if hit_concept is None:
            record[target] = {"outcome": "absent", "hasStandardized": existing is not None}
            continue
        entry: dict[str, Any] = {
            "concept": hit_concept,
            "rank": hit_rank,
            "chainLength": len(chain),
        }
        if existing is None:
            standardized[target] = hit_value
            entry["outcome"] = "filled"
            entry["value"] = hit_value
        elif existing == hit_value:
            entry["outcome"] = "agreed"
        else:
            entry["outcome"] = "disagreed"
            entry["chainValue"] = hit_value
            entry["standardizedValue"] = existing
        record[target] = entry
    return record


def build_rows(
    statements: StatementSet,
    *,
    accession: str,
    cik10: str,
    form: str,
    filed_at: date | datetime,
    symbol: str | None = None,
    parser_version: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """``(rows, report)`` — up to three ``us_fundamentals`` documents.

    A statement the filing does not present yields NO ROW. A bank's 10-Q
    legitimately omits a statement of equity and a shell company's 10-K can omit
    more; writing an empty row would claim we hold a statement that consists of
    nothing, which reads identically to a parse that failed halfway. The count
    is in ``report["absent"]`` instead.

    ``isLatest`` is written FALSE. It is a POINTER, not a property of the row —
    exactly one row per (cik10, statementType, periodType, periodEnd) may carry
    it — so only a query over the whole group can decide, and that is
    ``recompute_is_latest``'s job, called immediately after the write. A parser
    that guessed True from insertion order would give a restated period two
    latest rows.
    """
    filed = as_datetime(filed_at)
    if filed is None:
        raise ValueError(f"{accession}: statements have no filing date; refusing to invent one")

    period_end = as_datetime(statements.period_end)
    kind = period_type(statements.fiscal_period)
    is_amendment = form.strip().upper().endswith("/A")

    rows: list[dict[str, Any]] = []
    absent: list[str] = []
    collisions_report: dict[str, Any] = {}
    fallbacks_report: dict[str, Any] = {}

    for statement_type, attribute in STATEMENT_TYPES:
        lines: tuple[StatementLine, ...] = getattr(statements, attribute)
        if not lines:
            absent.append(statement_type)
            continue

        standardized, collisions = standardize(lines)
        fallbacks = apply_fallbacks(statement_type, lines, standardized)
        payload: dict[str, Any] = dict(standardized)
        payload["_fallbacks"] = fallbacks
        if collisions:
            payload["_collisions"] = collisions
            collisions_report[statement_type] = sorted(collisions)
        fallbacks_report[statement_type] = fallbacks

        rows.append(
            {
                "cik10": cik10,
                "symbol": symbol,
                "statementType": statement_type,
                "periodType": kind,
                "periodStart": as_datetime(statements.period_start),
                "periodEnd": period_end,
                "fiscalYear": statements.fiscal_year,
                "fiscalPeriod": statements.fiscal_period,
                "accession": accession,
                "form": form,
                "filedAt": filed,
                "isAmendment": is_amendment,
                "isLatest": False,
                "currency": statements.currency,
                "standardized": payload,
                "asReported": as_reported(lines),
                "mappingSource": MAPPING_SOURCE,
                "mappingVersion": MAPPING_VERSION,
                "parserVersion": parser_version,
                "source": SOURCE,
            }
        )

    report = {
        "absent": absent,
        "equityLinesSkipped": len(statements.equity),
        "comparativePeriods": list(statements.comparative_periods),
        "collisions": collisions_report,
        "fallbacks": fallbacks_report,
    }
    return rows, report


def latest_groups(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """The distinct (cik10, statementType, periodType, periodEnd) tuples written.

    Handed to ``recompute_is_latest`` so the pointer is recomputed once per
    affected group instead of once per row.
    """
    seen: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in rows:
        key = (row["cik10"], row["statementType"], row["periodType"], row["periodEnd"])
        seen.setdefault(
            key,
            # KEYWORD-ARGUMENT names, not the Prisma column names the rows use.
            # These dicts are splatted straight into `recompute_is_latest`, so
            # they have to match the protocol's signature; returning the column
            # spelling would raise TypeError at the one call site, on every
            # armed run, having already written the rows.
            {
                "cik10": row["cik10"],
                "statement_type": row["statementType"],
                "period_type": row["periodType"],
                "period_end": row["periodEnd"],
            },
        )
    return list(seen.values())
