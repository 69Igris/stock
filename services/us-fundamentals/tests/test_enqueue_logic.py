"""Selecting INDEXED filings for a re-publish — MONEY-1352.

The selection is the whole feature. `scripts/enqueue_indexed_financials.py` does
nothing but read rows, publish one message each and print counts, so a defect
can only live in what it SELECTS — and every rule here has a failure mode that
exits 0 having published a clean, confident, wrong number of messages.
"""

from __future__ import annotations

from datetime import date, datetime

from app.bulk.enqueue_logic import (
    ciks_without_fundamentals,
    indexed_financials_filter,
    passes_fiscal_floor,
)
from app.store.models import PARSE_CLASS_FINANCIALS, STATUS_INDEXED

# ── the filter ──────────────────────────────────────────────────────────────


def test_the_filter_selects_only_XBRL_FINANCIALS_filings_nobody_has_parsed() -> None:
    """All three clauses, named individually, because each drops a different set.

    Without `isXbrl` the run also publishes the 11 non-XBRL 10-Ks, which cost a
    SEC fetch each to reach a verdict already in the row and come back stamped
    UNSUPPORTED — losing the fact that they are still waiting for a parser that
    could read them. Without the status it re-publishes DETECTED filings that
    are already in flight, and PARSED ones that are done.
    """
    criteria = indexed_financials_filter()

    assert criteria == {
        "parseClass": PARSE_CLASS_FINANCIALS,
        "status": STATUS_INDEXED,
        "isXbrl": True,
    }
    assert criteria["isXbrl"] is True
    assert criteria["status"] == "INDEXED"


def test_forms_and_ciks_narrow_the_filter_when_given() -> None:
    criteria = indexed_financials_filter(forms=["10-Q", "20-F"], ciks=["0001708055"])

    assert criteria["form"] == {"$in": ["10-Q", "20-F"]}
    assert criteria["cik10"] == {"$in": ["0001708055"]}


def test_an_EMPTY_form_or_cik_list_is_OMITTED_and_never_an_empty_in() -> None:
    """`{"$in": []}` matches NOTHING.

    An operator who passes `--forms ""` would otherwise get a run that selects
    zero filings, publishes zero messages and exits 0 — indistinguishable from a
    converged queue, which is the failure this repo has paid for repeatedly.
    """
    criteria = indexed_financials_filter(forms=[], ciks=[])

    assert "form" not in criteria
    assert "cik10" not in criteria
    assert criteria == indexed_financials_filter()


# ── the fiscal-year floor ───────────────────────────────────────────────────


def test_the_floor_reads_periodOfReport_before_filedAt() -> None:
    """A 10-K is filed two to three months AFTER the year it reports on.

    An FY2022 annual report filed in Feb 2023 is INSIDE a `--from-fy 2023`
    window if the filing date is used, and OUTSIDE it if the period is — so the
    two answers differ on exactly the rows an operator is trying to select.
    """
    row = {"periodOfReport": date(2022, 12, 31), "filedAt": date(2023, 2, 15)}

    assert passes_fiscal_floor(row, 2023) is False
    assert passes_fiscal_floor(row, 2022) is True


def test_filedAt_is_the_fallback_and_the_datetime_pymongo_returns_is_accepted() -> None:
    """pymongo hands back a `datetime` for a BSON date, so the fallback has to
    take one — every real `filedAt` reaching this function is one."""
    assert passes_fiscal_floor({"filedAt": datetime(2024, 5, 1, 13, 30)}, 2024) is True
    assert passes_fiscal_floor({"filedAt": datetime(2024, 5, 1, 13, 30)}, 2025) is False


def test_a_MALFORMED_date_is_undatable_rather_than_an_exception() -> None:
    """`us_filings` is written by several jobs, and a `filedAt` that arrived as
    a STRING would raise `AttributeError` inside the one function that decides
    what to publish — one malformed row taking down a run of several hundred.

    Undatable, so the floor refuses it: a row whose year cannot be determined
    must not be swept in on the strength of not knowing.
    """
    assert passes_fiscal_floor({"filedAt": "2024-05-01", "periodOfReport": 20240501}, 2000) is False
    assert passes_fiscal_floor({"filedAt": "2024-05-01"}, None) is True


def test_a_row_with_no_dates_at_all_never_passes_a_floor() -> None:
    """`None` is not "recent". A filing whose year cannot be determined must not
    be swept into a windowed run on the strength of not knowing."""
    assert passes_fiscal_floor({}, 2020) is False
    assert passes_fiscal_floor({"periodOfReport": None, "filedAt": None}, 1900) is False


def test_no_floor_passes_everything_including_the_undatable_row() -> None:
    """The flag is optional, and its absence must not become a silent filter."""
    assert passes_fiscal_floor({}, None) is True
    assert passes_fiscal_floor({"filedAt": date(1994, 1, 1)}, None) is True


# ── the CIK difference ──────────────────────────────────────────────────────


def test_the_difference_is_active_stocks_minus_the_ones_already_covered() -> None:
    """Measured 2026-09-05: 584 of 7,112 CIK-bearing active US stocks have no
    `us_fundamentals` row at all. This is that subtraction."""
    uncovered = ciks_without_fundamentals(
        ["0001708055", "0000320193", "0001045810"], ["0000320193"]
    )

    assert uncovered == ["0001045810", "0001708055"]


def test_the_difference_is_SORTED_and_deduped_so_a_limited_run_is_reproducible() -> None:
    """An unordered difference hands `--limit` a different few hundred filers on
    every run, and two operators comparing notes get two answers to one
    question."""
    first = ciks_without_fundamentals(["0000000003", "0000000001", "0000000003"], [])
    second = ciks_without_fundamentals(["0000000001", "0000000003"], [])

    assert first == second == ["0000000001", "0000000003"]


def test_blanks_and_whitespace_on_either_side_do_not_become_a_phantom_cik() -> None:
    """A stray `""` in a `distinct()` result would otherwise be published as a
    filer, and a padded `" 0000320193"` would look uncovered forever."""
    assert ciks_without_fundamentals(["", "  ", " 0000320193 "], ["0000320193"]) == []
    assert ciks_without_fundamentals(["0000320193"], ["", None]) == ["0000320193"]


def test_covered_ciks_are_subtracted_even_when_they_are_not_in_the_active_set() -> None:
    """The control: a difference that ignored its right-hand side would pass
    every test above that only adds to the left."""
    assert ciks_without_fundamentals(["0000320193"], ["0000320193", "0009999999"]) == []
