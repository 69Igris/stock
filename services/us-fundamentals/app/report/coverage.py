"""Coverage arithmetic — MONEY-979 T12. PURE: no I/O, no clock, no network.

Three functions, each total over plain dicts:

``judge_coverage``          the release GATE — how much of the eligible universe
                            we hold five fiscal years of.
``tier_breakdown``          how the CUSIP map was resolved, per tier, with the
                            unresolved share.
``statement_completeness``  DISTINCT fiscal years per filer, which is what
                            ``judge_coverage`` needs as ``statementYears``.

## Why this file exists at all, given the TypeScript already does it

``judgeCoverage`` in ``packages/core/src/us-fundamentals/repository-logic.ts``
is the same gate, and ``scripts/data/edgar-coverage-report.ts`` calls THAT one.
This is deliberately a SECOND implementation, not a port of convenience:

* the Python service is the only process that will ever hold the rows at
  ingest time, and a gate it cannot evaluate is a gate that only runs where the
  data has already landed;
* two implementations pinned to ONE recorded contract
  (``tests/coverage_cases.json``) cannot drift without a test going red, and
  ``packages/core/__tests__/us-fundamentals/coverage-gate.test.ts`` drives the
  TypeScript over the very same cases.

Two languages computing one gate is exactly how they drift — so the cases are
shared, hand-authored, and asserted from both sides.

## The numeric-coercion contract, and the two places it does NOT hold

``_finite`` mirrors ``finite()`` in ``repository-logic.ts`` value for value:
a real finite number, or a non-blank string that parses to one; everything else
(``None``, ``""``, ``[]``, ``True``) is *no value*, never ``0``. The distinction
is load-bearing — "this filer has no statement years recorded" and "this filer
has zero statement years" read identically once the first collapses into the
second, and only one of them is a bug.

``bool`` is rejected explicitly. In Python ``isinstance(True, int)`` is True, so
without the guard ``eligibleForCoverage: True`` handed to a numeric field would
score as ``1``; in TypeScript ``typeof true`` is ``"boolean"`` and yields
``null``. That asymmetry is a real one, so it is closed here rather than
documented.

Two string forms that Python's ``float()`` accepts and JavaScript's ``Number()``
does not:

* ``"1_000"`` — Python reads 1000, JS reads ``NaN``. Rejected here explicitly.
* ``"0x10"``  — Python raises, JS reads 16. Rejected by both, in opposite ways;
  no guard needed, but do not "fix" it into agreement in the JS direction.

Neither can arrive from Mongo (these columns are ``Int``), so the guard is a
belt on a value that already wears braces. It is here because the alternative is
a comment claiming parity that nothing checks.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any

from app.parsers.cusip_map_logic import TIER_ORDER, UNRESOLVED

#: How many fiscal years of statements a filer must hold to count as COVERED.
#:
#: Must equal ``US_COVERAGE_TARGET_YEARS`` in ``repository-logic.ts``. The
#: shared contract file records it too, so a change on one side alone turns the
#: gate test red instead of quietly moving the bar.
US_COVERAGE_TARGET_YEARS = 5


def _finite(value: Any) -> float | None:
    """A finite number, or ``None``. See the module docstring for the contract."""
    # Before the int/float test: `isinstance(True, int)` is True in Python.
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        try:
            as_float = float(value)
        except OverflowError:
            # An int larger than a float can hold. Not representable, therefore
            # not a number we can compare — never silently clamped to a maximum.
            return None
        return as_float if math.isfinite(as_float) else None
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        text = value.strip()
        if text == "" or "_" in text:
            return None
        try:
            parsed = float(text)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def _count_or_one(row: Mapping[str, Any]) -> int:
    """``row["count"]`` when present and countable, else 1.

    Lets one function serve both a raw row list and a pre-aggregated
    ``groupBy``/``$group`` result, which is the difference between the report
    reading 30 million CUSIP rows and reading five.
    """
    if "count" not in row:
        return 1
    value = _finite(row.get("count"))
    if value is None:
        return 0
    return max(0, int(value))


def judge_coverage(filers: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The coverage gate. Mirrors ``judgeCoverage`` in ``repository-logic.ts``.

    Each input row carries three keys, spelled as the Prisma columns are:

    ``eligibleForCoverage``  ``UsFiler.eligibleForCoverage`` — the filer has 5+
                             fiscal years of 10-K/20-F/40-F AT SEC.
    ``fiscalYearsOnFile``    how many SEC has.
    ``statementYears``       how many DISTINCT fiscal years we hold statements
                             for (see :func:`statement_completeness`).

    ## Why the denominator is ELIGIBLE filers and not all of them

    A gate reading "95% of filers have 5+ years" FAILS EVERY QUARTER A BATCH OF
    SPACS LISTS. A company that IPO'd last year cannot have five years of
    filings and no amount of engineering will give it any, so that gate measures
    the MARKET. "95% of the filers who have 5+ years at SEC have 5+ years here"
    measures US, which is the only thing a release can act on.

    An ineligible filer is SATISFIED when it holds every year it has, and it is
    reported in ``ineligibleWithAllAvailable`` — never dragged into ``pct``.
    ``overallPct`` counts both buckets so that "the ineligible ones are fine
    too" is MEASURED rather than assumed: an ineligible filer missing years
    shows up there and nowhere else.

    ## Empty populations score 100, not 0 and not NaN

    There is nothing in the gate's population to fail, so the gate is vacuously
    satisfied. The other two answers are both worse: 0 fails a release for a
    market condition, and a NaN fails SILENTLY IN BOTH DIRECTIONS — ``nan >=
    95`` is False and so is ``nan < 95``, so a threshold written either way
    reports the wrong thing without raising.

    A caller that must distinguish "vacuously satisfied" from "measured at 100%"
    reads ``eligible``, which is 0 in exactly the first case. The ops report does
    precisely that and prints NO_DATA rather than a 100 nobody earned.
    """
    eligible = 0
    eligible_covered = 0
    ineligible = 0
    ineligible_with_all_available = 0

    for row in filers:
        held = max(0.0, _finite(row.get("statementYears")) or 0.0)
        at_sec = max(0.0, _finite(row.get("fiscalYearsOnFile")) or 0.0)
        # `is True`, not truthiness: `eligibleForCoverage: 1` is NOT a boolean
        # true, and `repository-logic.ts` tests `=== true` for the same reason.
        # A column read back as a string "true" is a schema problem to fix at
        # the writer, not a value to be generous about at the gate.
        if row.get("eligibleForCoverage") is True:
            eligible += 1
            if held >= US_COVERAGE_TARGET_YEARS:
                eligible_covered += 1
        else:
            ineligible += 1
            # "All the years it has". An ineligible filer with 2 fiscal years at
            # SEC and 2 here is complete. One SEC shows zero years for is
            # complete by the same rule — there is nothing to fetch.
            if held >= at_sec:
                ineligible_with_all_available += 1

    total = eligible + ineligible
    satisfied = eligible_covered + ineligible_with_all_available

    return {
        "eligible": eligible,
        "eligibleCovered": eligible_covered,
        "ineligible": ineligible,
        "ineligibleWithAllAvailable": ineligible_with_all_available,
        "pct": 100.0 if eligible == 0 else (eligible_covered / eligible) * 100.0,
        "overallPct": 100.0 if total == 0 else (satisfied / total) * 100.0,
        "filers": total,
    }


def tier_breakdown(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """CUSIP-map resolution per tier, with the unresolved share.

    Each row carries ``source`` and optionally ``count`` (see
    :func:`_count_or_one`), so a pre-aggregated group-by and a raw row list both
    work.

    ## Every known tier appears, including the ones that resolved nothing

    ``bySource`` is seeded with all of :data:`TIER_ORDER` plus ``UNRESOLVED`` at
    zero. A tier that resolved nothing must be VISIBLE as a zero, because "0
    rows" and "this tier is not in the output" are the same reading otherwise —
    and one of them means the tier never ran.

    That matters most for ``TIINGO_FIGI``, which is EXPECTED to be near zero and
    is not evidence of a broken tier: the 13F ``figi`` column has been optional
    since EDGAR Release 22.4.1 and Berkshire omits it on all 89 rows of its 2026
    filing (measured, T4). Reported rather than assumed.

    ## An unrecognised source is UNKNOWN, never RESOLVED

    ``resolved`` counts only rows whose source is a tier we know. A row carrying
    some other string is counted in ``unknown`` and named in ``unknownSources``.
    Folding it into ``resolved`` would let a typo'd or renamed tier inflate the
    headline; folding it into ``unresolved`` would report a mapping we hold as
    one we do not.

    Empty population: ``resolvedPct`` 100, ``unresolvedPct`` 0, on the same
    reasoning as :func:`judge_coverage`. The caller distinguishes it by
    ``total == 0``.
    """
    # Frozen BEFORE the loop, and tested against instead of `by_source`.
    # `by_source` grows as unknown sources arrive, so membership in it would
    # class the SECOND row of an unrecognised tier as resolved while the first
    # was unknown — a bug whose symptom is a headline that improves the more
    # often the typo appears.
    known: frozenset[str] = frozenset(TIER_ORDER)

    by_source: dict[str, int] = dict.fromkeys(TIER_ORDER, 0)
    by_source[UNRESOLVED] = 0
    unknown_sources: dict[str, int] = {}

    total = 0
    resolved = 0
    unresolved = 0
    unknown = 0

    for row in rows:
        n = _count_or_one(row)
        if n == 0:
            continue
        raw = row.get("source")
        source = raw.strip() if isinstance(raw, str) else ""
        total += n
        if source in known:
            by_source[source] += n
            resolved += n
        elif source in {UNRESOLVED, ""}:
            # A blank/absent source is an UNRESOLVED row that was written
            # without one. Same fact, worse provenance — counted here so it
            # cannot pass as a resolution.
            by_source[UNRESOLVED] += n
            unresolved += n
        else:
            unknown_sources[source] = unknown_sources.get(source, 0) + n
            by_source[source] = by_source.get(source, 0) + n
            unknown += n

    return {
        "total": total,
        "resolved": resolved,
        "unresolved": unresolved,
        "unknown": unknown,
        "bySource": by_source,
        "unknownSources": dict(sorted(unknown_sources.items())),
        "resolvedPct": 100.0 if total == 0 else (resolved / total) * 100.0,
        "unresolvedPct": 0.0 if total == 0 else (unresolved / total) * 100.0,
    }


def statement_completeness(
    rows: Iterable[Mapping[str, Any]],
    min_years: int = US_COVERAGE_TARGET_YEARS,
) -> dict[str, Any]:
    """DISTINCT fiscal years per filer, from ``(cik10, fiscalYear)`` rows.

    ## Distinct years, never a row count

    One fiscal year legitimately occupies SEVERAL rows in ``us_fundamentals``:
    the original filing plus every restatement, each keyed by its own accession
    because ``@@unique([cik10, statementType, periodType, periodEnd,
    accession])`` says so. Counting rows would report a heavily amended filer as
    holding more years than it holds, and that error only ever points UP — the
    direction that reads as success.

    ``rows`` and ``years`` are both returned so the duplication factor is
    visible: ``rows`` far above the summed year counts is amendment history, not
    coverage.

    ## Unusable rows are counted, never dropped in silence

    A row with no usable ``cik10`` or no parseable ``fiscalYear`` lands in
    ``dropped``. A silent skip here would shrink the denominator of every number
    downstream and look like an improvement.

    Empty population scores ``pct`` 100, matching :func:`judge_coverage`.
    """
    years_by_filer: dict[str, set[int]] = {}
    consumed = 0
    dropped = 0

    for row in rows:
        consumed += 1
        raw_cik = row.get("cik10")
        cik = raw_cik.strip() if isinstance(raw_cik, str) else ""
        fiscal_year = _finite(row.get("fiscalYear"))
        if cik == "" or fiscal_year is None:
            dropped += 1
            continue
        years_by_filer.setdefault(cik, set()).add(int(fiscal_year))

    counts = {cik: len(years) for cik, years in years_by_filer.items()}
    filers = len(counts)
    with_min = sum(1 for n in counts.values() if n >= min_years)

    return {
        "minYears": min_years,
        "filers": filers,
        "yearsByFiler": dict(sorted(counts.items())),
        "filersWithMin": with_min,
        "pct": 100.0 if filers == 0 else (with_min / filers) * 100.0,
        "rows": consumed,
        "dropped": dropped,
    }
