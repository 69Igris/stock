#!/usr/bin/env python3
"""What `standardized._collisions` has been recording — READ ONLY. MONEY-1354.

    python scripts/report_collisions.py            # prints a table
    python scripts/report_collisions.py --limit 50 # widest 50 rows of it

This script WRITES NOTHING. There is no `--apply`, and there is nothing for one
to do: the marker it reads has been stored on every colliding statement since the
parser shipped and has never once been read. Measured on prod 2026-09-05,
`standardized._collisions` is present on 4,250 CASH_FLOW and 3,553 BALANCE_SHEET
`isLatest` rows in `us_fundamentals`.

## What a collision is

`financials_logic.standardize` maps many raw us-gaap tags onto one standard
concept — 130 tags collapse into `Revenue`, 58 into `CashAndMarketableSecurities`
— and LAST WINS, because a statement lists components before the total that sums
them. Measured on Apple's FY2025 cash flow, `NetCashFromInvestingActivities`
appears twice: once from `PaymentsForProceedsFromOtherInvestingActivities`
(-1,480,000,000, a component) and once from
`NetCashProvidedByUsedInInvestingActivities` (15,195,000,000, the actual total).
First-wins would store the component.

Only collisions whose values DIFFER are recorded; an identical repeat is not one.

## What this report is for, and what it is NOT

It answers one question: is last-wins picking the same tag over and over for one
concept, or is it arbitrary? A concept where one pair dominates AND the winner is
consistently the larger magnitude is a candidate for an explicit rule in
`standardize`. Everything else is presentation order doing its job.

DO NOT add a rule from this output alone. A rule needs a FIXTURE TEST that
reproduces the collision on a real filing, because the reason last-wins works is
a property of how filers present statements, and a table of counts cannot show
that. Reporting is the whole deliverable; guessing a rule from a majority is how
`AdmissionsRevenue` beats `Revenues`.

`--limit` bounds the PRINTED table only; the counts are over every matching row.
"""

from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Iterable, Mapping
from typing import Any

from app.db import get_database
from app.store.collections import collection_name

#: `isLatest` rows carrying the marker. `$exists` rather than `{"$ne": None}`:
#: the field is ABSENT on a statement with no collision, and `$ne: null` returns
#: zero from both directions over an absent field (MONEY-1050 / 1234 / 1235).
COLLISION_FILTER: dict[str, Any] = {
    "isLatest": True,
    "standardized._collisions": {"$exists": True},
}


def summarise_collisions(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """One entry per (statementType, standard concept, colliding tag set).

    PURE, so the arithmetic below is testable without a database.

    `winnerLargest` counts the rows where the value last-wins KEPT had the
    largest magnitude of the collision. Magnitude, not value, because a cash-flow
    component is routinely negative where its total is positive — comparing the
    signed numbers would report "the winner was smaller" for exactly the Apple
    case that motivates last-wins.

    Ties count as the winner being largest: `>=`, not `>`. Two entries of equal
    magnitude and opposite sign differ in value, so they ARE a recorded
    collision, and calling that a loss would inflate the "last-wins looks wrong"
    signal this report exists to measure.
    """
    tally: Counter[tuple[str, str, tuple[str, ...]]] = Counter()
    winner_largest: Counter[tuple[str, str, tuple[str, ...]]] = Counter()
    winners: dict[tuple[str, str, tuple[str, ...]], Counter[str]] = {}

    for row in rows:
        statement = str(row.get("statementType") or "?")
        collisions = (row.get("standardized") or {}).get("_collisions") or {}
        for concept, entries in collisions.items():
            if not entries:
                continue
            values = [_float(entry.get("value")) for entry in entries]
            if any(value is None for value in values):
                continue
            magnitudes = [abs(value) for value in values if value is not None]
            tags = tuple(sorted({str(entry.get("concept") or "?") for entry in entries}))
            key = (statement, str(concept), tags)
            tally[key] += 1
            winners.setdefault(key, Counter())[str(entries[-1].get("concept") or "?")] += 1
            if magnitudes[-1] >= max(magnitudes):
                winner_largest[key] += 1

    return [
        {
            "statementType": statement,
            "concept": concept,
            "tags": list(tags),
            "rows": count,
            "winnerLargest": winner_largest[(statement, concept, tags)],
            "winners": dict(winners[(statement, concept, tags)].most_common()),
        }
        for (statement, concept, tags), count in tally.most_common()
    ]


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=40, help="rows of the table to print")
    args = parser.parse_args()

    database = get_database()
    if database is None:
        print("DATABASE_URL is unset or unreachable — nothing measured")
        return 1

    name = collection_name("fundamentals")
    rows = list(
        database[name].find(COLLISION_FILTER, {"statementType": 1, "standardized._collisions": 1})
    )
    summary = summarise_collisions(rows)

    by_statement = Counter(str(row.get("statementType") or "?") for row in rows)
    print(f"{name}: {len(rows)} isLatest rows carry standardized._collisions")
    print(f"  by statement: {dict(sorted(by_statement.items()))}")
    print(f"  {len(summary)} distinct (statement, concept, tag set) combinations")
    print()
    print(f"{'rows':>6}  {'largest':>7}  statement / concept / winner <- colliding tags")
    for entry in summary[: max(0, args.limit)]:
        share = f"{entry['winnerLargest'] / entry['rows']:.0%}"
        winner = next(iter(entry["winners"]), "?")
        losers = [tag for tag in entry["tags"] if tag != winner]
        print(
            f"{entry['rows']:>6}  {share:>7}  {entry['statementType']}.{entry['concept']}: "
            f"{winner} <- {', '.join(losers) or '(same tag, differing values)'}"
        )
        if len(entry["winners"]) > 1:
            # A concept whose WINNER varies is the opposite of a rule candidate:
            # there is no single tag to prefer.
            print(f"{'':>17}winner varies: {entry['winners']}")
    if len(summary) > args.limit:
        print(f"... {len(summary) - args.limit} more; raise --limit to see them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
