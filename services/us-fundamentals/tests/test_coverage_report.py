"""The coverage arithmetic — MONEY-979 T12.

Every assertion drives the REAL functions in ``app/report/coverage.py``. Nothing
restates the rule inline: a test that re-declares the arithmetic is a shadow
test and stays green when the source is deleted.

``tests/coverage_cases.json`` is the CROSS-LANGUAGE contract. The same file is
read by ``packages/core/__tests__/us-fundamentals/coverage-gate.test.ts``, which
drives the TypeScript ``judgeCoverage`` over the identical cases — so the two
implementations cannot drift without one side going red.

MUTATION-VERIFIED. Each ``MUTATION:`` note names the exact source edit applied,
confirmed to turn this file RED, and then reverted byte-identically.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.parsers.cusip_map_logic import TIER_ORDER, UNRESOLVED
from app.report.coverage import (
    US_COVERAGE_TARGET_YEARS,
    judge_coverage,
    statement_completeness,
    tier_breakdown,
)

CASES_FILE = Path(__file__).parent / "coverage_cases.json"
CONTRACT: dict[str, Any] = json.loads(CASES_FILE.read_text())
CASES: list[dict[str, Any]] = CONTRACT["cases"]

#: Percentages are doubles. Compared with a tolerance so a case with a repeating
#: fraction stays an arithmetic test rather than a formatting one.
TOLERANCE = 1e-9


def _judgement_keys() -> set[str]:
    return set(judge_coverage([]).keys())


# ── the shared contract ──────────────────────────────────────────────────────


class TestSharedContract:
    """The file both languages are pinned to must itself be non-trivial."""

    def test_contract_file_is_populated(self) -> None:
        # Without this, deleting the cases turns every parametrised assertion
        # below into a vacuous pass over an empty list — which is the exact
        # failure mode a shared fixture introduces.
        assert len(CASES) >= 8, f"expected >= 8 shared cases, found {len(CASES)}"
        names = [case["name"] for case in CASES]
        assert len(names) == len(set(names)), f"duplicate case names: {names}"

    def test_contract_records_the_target_year_count(self) -> None:
        # The bar lives in three places — this file, coverage.py and
        # repository-logic.ts. Pinning it here makes a change in one of them a
        # red test in the other two instead of a silently moved gate.
        assert CONTRACT["targetYears"] == US_COVERAGE_TARGET_YEARS

    def test_the_spac_case_is_present(self) -> None:
        # Named explicitly: it is the ONE case that dies if the denominator is
        # replaced by all filers, so it must not be quietly dropped.
        assert any(case["name"] == "spac_batch" for case in CASES)

    def test_every_case_pins_the_whole_judgement(self) -> None:
        # A case that omits a key would pass while that key was wrong.
        for case in CASES:
            assert set(case["expected"].keys()) == _judgement_keys(), (
                f"case {case['name']!r} does not pin every judgement field"
            )


# ── judge_coverage ───────────────────────────────────────────────────────────


class TestJudgeCoverage:
    @pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
    def test_shared_case(self, case: dict[str, Any]) -> None:
        """MUTATION: denominator `eligible` -> `total` in coverage.py — RED
        (spac_batch 100 -> 20).
        MUTATION: `100.0 if eligible == 0` -> `(eligible_covered / eligible)`
        unguarded — RED (ZeroDivisionError on `empty`).
        MUTATION: the ineligible branch's `held >= at_sec` -> `False` — RED
        (spac_batch overallPct 100 -> 20).
        MUTATION: `is True` -> truthiness — RED (dirty_inputs eligible 4 -> 5).
        """
        actual = judge_coverage(case["filers"])
        expected = case["expected"]

        for key in (
            "eligible",
            "eligibleCovered",
            "ineligible",
            "ineligibleWithAllAvailable",
            "filers",
        ):
            assert actual[key] == expected[key], f"{case['name']}.{key}"
        for key in ("pct", "overallPct"):
            assert abs(actual[key] - expected[key]) < TOLERANCE, f"{case['name']}.{key}"

    def test_empty_population_is_one_hundred_not_nan(self) -> None:
        """The guard stated as its own property, so it cannot be lost in a case list.

        A NaN here fails SILENTLY IN BOTH DIRECTIONS: `nan >= 95` is False and
        so is `nan < 95`, so a threshold check written either way reports the
        wrong thing without raising.
        """
        result = judge_coverage([])
        assert result["pct"] == 100.0
        assert result["overallPct"] == 100.0
        assert result["pct"] == result["pct"], "pct is NaN"
        assert result["eligible"] == 0, "the caller's only way to tell vacuous from measured"

    def test_an_ineligible_filer_never_enters_the_gate(self) -> None:
        """Ten SPACs holding nothing at all must not move `pct` by a single point."""
        eligible_only = [
            {"eligibleForCoverage": True, "fiscalYearsOnFile": 9, "statementYears": 9},
            {"eligibleForCoverage": True, "fiscalYearsOnFile": 9, "statementYears": 1},
        ]
        spacs = [
            {"eligibleForCoverage": False, "fiscalYearsOnFile": 2, "statementYears": 0}
            for _ in range(10)
        ]
        assert judge_coverage(eligible_only)["pct"] == judge_coverage(eligible_only + spacs)["pct"]
        # ...and they ARE visible, in the bucket built for them.
        with_spacs = judge_coverage(eligible_only + spacs)
        assert with_spacs["ineligible"] == 10
        assert with_spacs["ineligibleWithAllAvailable"] == 0
        assert with_spacs["overallPct"] < 100.0

    def test_non_finite_values_floor_to_zero(self) -> None:
        """Not expressible in JSON, so it is asserted here rather than in the shared file."""
        rows = [
            {"eligibleForCoverage": True, "fiscalYearsOnFile": 9, "statementYears": float("nan")},
            {"eligibleForCoverage": True, "fiscalYearsOnFile": 9, "statementYears": float("inf")},
        ]
        result = judge_coverage(rows)
        assert result["eligible"] == 2
        # inf would otherwise pass `>= 5` and count as covered on a value that
        # is not a measurement at all.
        assert result["eligibleCovered"] == 0
        assert result["pct"] == 0.0

    def test_string_forms_python_accepts_and_javascript_does_not(self) -> None:
        """`float("1_000")` is 1000 in Python and NaN in JS. Rejected, for parity.

        MUTATION: drop the `"_" in text` guard in `_finite` — RED.
        """
        underscored = judge_coverage(
            [{"eligibleForCoverage": True, "fiscalYearsOnFile": 9, "statementYears": "1_000"}]
        )
        assert underscored["eligibleCovered"] == 0

    def test_booleans_are_not_numbers(self) -> None:
        """`isinstance(True, int)` is True in Python; `typeof true` is not "number" in JS.

        Both rows below cross the `held >= at_sec` boundary in OPPOSITE
        directions depending on whether `True` scores 1 or scores nothing, which
        is what makes this falsifiable. The first draft asserted a case where
        both readings gave the same answer, stayed green under the mutation, and
        carried a comment claiming it did not — a comment about a bug is not
        protection from it.

        MUTATION: remove the `isinstance(value, bool)` early return in `_finite`
        — RED (both counts invert).
        """
        # held: True. With the guard it is NO VALUE -> 0, and 0 >= 1 is false,
        # so the filer is NOT satisfied. Read as 1 it would be 1 >= 1, satisfied.
        held_true = judge_coverage(
            [{"eligibleForCoverage": False, "fiscalYearsOnFile": 1, "statementYears": True}]
        )
        assert held_true["ineligibleWithAllAvailable"] == 0

        # at SEC: True. With the guard 0 >= 0 is satisfied. Read as 1 it would
        # be 0 >= 1, not satisfied.
        at_sec_true = judge_coverage(
            [{"eligibleForCoverage": False, "fiscalYearsOnFile": True, "statementYears": 0}]
        )
        assert at_sec_true["ineligibleWithAllAvailable"] == 1

    def test_missing_keys_are_absent_not_zero_shaped(self) -> None:
        """A row with no keys at all is ineligible with nothing held, and does not raise."""
        result = judge_coverage([{}])
        assert result == {
            "eligible": 0,
            "eligibleCovered": 0,
            "ineligible": 1,
            "ineligibleWithAllAvailable": 1,
            "pct": 100.0,
            "overallPct": 100.0,
            "filers": 1,
        }

    def test_accepts_a_generator(self) -> None:
        """The report streams a cursor into this; consuming it twice would halve the count."""
        rows = (
            {"eligibleForCoverage": True, "fiscalYearsOnFile": 9, "statementYears": 9}
            for _ in range(3)
        )
        assert judge_coverage(rows)["eligible"] == 3


# ── tier_breakdown ───────────────────────────────────────────────────────────


class TestTierBreakdown:
    def test_empty_population(self) -> None:
        result = tier_breakdown([])
        assert result["total"] == 0
        assert result["unresolved"] == 0
        assert result["unresolvedPct"] == 0.0
        assert result["resolvedPct"] == 100.0

    def test_every_known_tier_is_present_even_at_zero(self) -> None:
        """A tier that resolved nothing must read as 0, not be missing.

        "0 rows" and "this tier is absent from the output" are the same reading
        otherwise, and one of them means the tier never ran.

        MUTATION: seed `by_source` as `{}` instead of from TIER_ORDER — RED.
        """
        result = tier_breakdown([{"source": "SEC_13DG", "count": 4}])
        for tier in TIER_ORDER:
            assert tier in result["bySource"], f"{tier} missing from bySource"
        assert UNRESOLVED in result["bySource"]
        # TIINGO_FIGI is EXPECTED near zero — 13F `figi` is genuinely absent
        # (Berkshire omits it on all 89 rows of its 2026 filing, T4) — so the
        # zero has to be reportable rather than indistinguishable from silence.
        assert result["bySource"]["TIINGO_FIGI"] == 0

    def test_counts_and_shares(self) -> None:
        rows = [
            {"source": "SEC_13DG", "count": 50},
            {"source": "TIINGO_FIGI", "count": 0},
            {"source": "SEC_FTD", "count": 20},
            {"source": "OPENFIGI", "count": 5},
            {"source": UNRESOLVED, "count": 25},
        ]
        result = tier_breakdown(rows)
        assert result["total"] == 100
        assert result["resolved"] == 75
        assert result["unresolved"] == 25
        assert abs(result["unresolvedPct"] - 25.0) < TOLERANCE
        assert abs(result["resolvedPct"] - 75.0) < TOLERANCE

    def test_raw_rows_without_a_count_are_one_each(self) -> None:
        rows = [{"source": "SEC_13DG"}, {"source": "SEC_13DG"}, {"source": UNRESOLVED}]
        result = tier_breakdown(rows)
        assert result["total"] == 3
        assert result["bySource"]["SEC_13DG"] == 2

    def test_an_unrecognised_source_is_unknown_not_resolved(self) -> None:
        """A typo'd or renamed tier must not inflate the headline.

        MUTATION: test membership against the growing `by_source` instead of the
        frozen `known` — RED: the SECOND row of an unknown tier would count as
        resolved, so the headline would improve the more often the typo appears.
        """
        rows = [{"source": "BLOOMBERG"}, {"source": "BLOOMBERG"}, {"source": "SEC_FTD"}]
        result = tier_breakdown(rows)
        assert result["unknown"] == 2
        assert result["resolved"] == 1
        assert result["unknownSources"] == {"BLOOMBERG": 2}

    def test_a_blank_source_counts_as_unresolved(self) -> None:
        """Absent provenance is still an unresolved row — never a resolution."""
        result = tier_breakdown([{"source": None}, {"source": "   "}, {}])
        assert result["unresolved"] == 3
        assert result["resolved"] == 0
        assert result["bySource"][UNRESOLVED] == 3


# ── statement_completeness ───────────────────────────────────────────────────


class TestStatementCompleteness:
    def test_empty_population(self) -> None:
        result = statement_completeness([])
        assert result["filers"] == 0
        assert result["pct"] == 100.0
        assert result["rows"] == 0

    def test_distinct_years_never_a_row_count(self) -> None:
        """One fiscal year occupies several rows — the original plus every restatement.

        `@@unique([cik10, statementType, periodType, periodEnd, accession])`
        makes that legal and expected, so counting ROWS reports a heavily
        amended filer as holding more years than it holds — an error that only
        ever points UP, the direction that reads as success.

        MUTATION: count rows instead of distinct years (`counts[cik] += 1`) —
        RED: the amended filer below scores 6 years off 3.
        """
        rows = [
            {"cik10": "0000320193", "fiscalYear": 2024},
            {"cik10": "0000320193", "fiscalYear": 2024},
            {"cik10": "0000320193", "fiscalYear": 2024},
            {"cik10": "0000320193", "fiscalYear": 2023},
            {"cik10": "0000320193", "fiscalYear": 2022},
        ]
        result = statement_completeness(rows, min_years=5)
        assert result["yearsByFiler"]["0000320193"] == 3
        assert result["filersWithMin"] == 0
        assert result["rows"] == 5, "the duplication factor stays visible"

    def test_min_years_boundary(self) -> None:
        rows = [{"cik10": "A", "fiscalYear": y} for y in range(2020, 2025)]
        rows += [{"cik10": "B", "fiscalYear": y} for y in range(2021, 2025)]
        result = statement_completeness(rows, min_years=5)
        assert result["yearsByFiler"] == {"A": 5, "B": 4}
        assert result["filersWithMin"] == 1
        assert abs(result["pct"] - 50.0) < TOLERANCE

    def test_default_min_years_is_the_shared_target(self) -> None:
        rows = [{"cik10": "A", "fiscalYear": y} for y in range(2020, 2025)]
        assert statement_completeness(rows)["minYears"] == US_COVERAGE_TARGET_YEARS
        assert statement_completeness(rows)["filersWithMin"] == 1

    def test_unusable_rows_are_counted_not_silently_dropped(self) -> None:
        """A silent skip shrinks every denominator downstream and looks like an improvement.

        MUTATION: drop the `dropped` counter and `continue` silently — RED.
        """
        rows = [
            {"cik10": "A", "fiscalYear": 2024},
            {"cik10": "", "fiscalYear": 2024},
            {"cik10": "B", "fiscalYear": None},
            {"fiscalYear": 2024},
            {"cik10": "C"},
        ]
        result = statement_completeness(rows)
        assert result["rows"] == 5
        assert result["dropped"] == 4
        assert result["filers"] == 1

    def test_a_fiscal_year_as_a_string_is_the_same_year(self) -> None:
        rows = [{"cik10": "A", "fiscalYear": 2024}, {"cik10": "A", "fiscalYear": "2024"}]
        assert statement_completeness(rows)["yearsByFiler"]["A"] == 1

    def test_feeds_judge_coverage(self) -> None:
        """The two compose: distinct years in, a gate out. No third spelling in between."""
        rows = [{"cik10": "A", "fiscalYear": y} for y in range(2019, 2025)]
        rows += [{"cik10": "B", "fiscalYear": y} for y in range(2023, 2025)]
        years = statement_completeness(rows)["yearsByFiler"]
        judged = judge_coverage(
            [
                {"eligibleForCoverage": True, "fiscalYearsOnFile": 8, "statementYears": years["A"]},
                {"eligibleForCoverage": True, "fiscalYearsOnFile": 8, "statementYears": years["B"]},
            ]
        )
        assert judged["eligible"] == 2
        assert judged["eligibleCovered"] == 1
        assert abs(judged["pct"] - 50.0) < TOLERANCE
