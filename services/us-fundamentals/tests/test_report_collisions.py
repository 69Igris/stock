"""Reading `standardized._collisions` for the first time — MONEY-1354.

The marker has been written on every colliding statement since the parser
shipped (4,250 CASH_FLOW and 3,553 BALANCE_SHEET `isLatest` rows on prod,
2026-09-05) and nothing had ever read it. `scripts/report_collisions.py` reports;
it changes no mapping rule, because a rule needs a fixture test on a real filing
and a table of counts cannot supply one.

What IS worth testing is the arithmetic, because the one number an operator
would act on — "did last-wins keep the larger magnitude?" — is exactly the one a
sign error inverts while the table still looks plausible.
"""

from __future__ import annotations

from scripts.report_collisions import COLLISION_FILTER, summarise_collisions


def row(statement: str, concept: str, entries: list[tuple[str, float]]) -> dict:
    return {
        "statementType": statement,
        "standardized": {
            "_collisions": {concept: [{"concept": tag, "value": value} for tag, value in entries]}
        },
    }


APPLE_CASH_FLOW = [
    ("PaymentsForProceedsFromOtherInvestingActivities", -1_480_000_000.0),
    ("NetCashProvidedByUsedInInvestingActivities", 15_195_000_000.0),
]


def test_the_winner_is_the_LAST_entry_because_that_is_what_standardize_keeps() -> None:
    """Measured on Apple's FY2025 cash flow: a component is listed before the
    total that sums it, so last-wins keeps the total."""
    [entry] = summarise_collisions(
        [row("CASH_FLOW", "NetCashFromInvestingActivities", APPLE_CASH_FLOW)]
    )

    assert entry["winners"] == {"NetCashProvidedByUsedInInvestingActivities": 1}
    assert entry["rows"] == 1
    assert entry["winnerLargest"] == 1


def test_MAGNITUDE_not_signed_value_decides_whether_the_winner_was_larger() -> None:
    """A cash-flow component is routinely negative where its total is positive.

    Comparing signed numbers would report "the winner was smaller" for exactly
    the Apple case that motivates last-wins — the table would say last-wins is
    picking the wrong value in the one case it is known to be right.
    """
    negative_total = [("SomeComponent", 100.0), ("SomeTotal", -900.0)]
    [entry] = summarise_collisions([row("CASH_FLOW", "Concept", negative_total)])

    assert entry["winnerLargest"] == 1, "abs(-900) > abs(100); the sign is not the question"


def test_a_winner_that_is_genuinely_smaller_is_counted_as_such() -> None:
    """The control. A counter that always increments passes every test above."""
    [entry] = summarise_collisions([row("INCOME", "Revenue", [("Big", 900.0), ("Small", 10.0)])])

    assert entry["rows"] == 1
    assert entry["winnerLargest"] == 0


def test_a_TIE_in_magnitude_counts_as_the_winner_being_largest() -> None:
    """Equal magnitude and opposite sign IS a recorded collision — the values
    differ — and calling it a loss would inflate the "last-wins looks wrong"
    signal this report exists to measure."""
    [entry] = summarise_collisions([row("BALANCE_SHEET", "Cash", [("A", -5.0), ("B", 5.0)])])

    assert entry["winnerLargest"] == 1


def test_rows_are_grouped_by_statement_concept_and_tag_set_and_counted() -> None:
    """The grouping is what turns 7,803 markers into a shortlist. One concept
    colliding between the SAME two tags 100 times is a rule candidate; 100
    different tag pairs are presentation order doing its job."""
    rows = [row("CASH_FLOW", "NetCashFromInvestingActivities", APPLE_CASH_FLOW) for _ in range(3)]
    rows.append(row("INCOME", "Revenue", [("AdmissionsRevenue", 1.0), ("Revenues", 2.0)]))
    summary = summarise_collisions(rows)

    assert [(entry["statementType"], entry["concept"], entry["rows"]) for entry in summary] == [
        ("CASH_FLOW", "NetCashFromInvestingActivities", 3),
        ("INCOME", "Revenue", 1),
    ]
    assert summary[0]["tags"] == sorted(tag for tag, _ in APPLE_CASH_FLOW)


def test_a_concept_whose_WINNER_VARIES_is_reported_as_varying() -> None:
    """The opposite of a rule candidate: there is no single tag to prefer, and a
    report that showed only the majority winner would hide that."""
    rows = [
        row("INCOME", "Revenue", [("Revenues", 1.0), ("AdmissionsRevenue", 2.0)]),
        row("INCOME", "Revenue", [("AdmissionsRevenue", 2.0), ("Revenues", 1.0)]),
    ]
    [entry] = summarise_collisions(rows)

    assert entry["winners"] == {"AdmissionsRevenue": 1, "Revenues": 1}


def test_a_non_numeric_or_empty_collision_is_skipped_rather_than_crashing() -> None:
    """The marker is a Json column written by a parser that has changed twice.

    A report that raises on one malformed entry reports nothing about the other
    7,802 — and this script's only job is to report.
    """
    summary = summarise_collisions(
        [
            row("INCOME", "Revenue", []),
            row("INCOME", "Revenue", [("A", "not a number"), ("B", 2.0)]),  # type: ignore[list-item]
            {"statementType": "INCOME", "standardized": {}},
            {"statementType": "INCOME"},
        ]
    )

    assert summary == []


def test_the_query_asks_EXISTS_and_never_not_null() -> None:
    """The field is ABSENT on a statement with no collision, and `$ne: null`
    over an absent field returns zero from both directions."""
    assert COLLISION_FILTER == {
        "isLatest": True,
        "standardized._collisions": {"$exists": True},
    }
