#!/usr/bin/env python3
"""Publish already-INDEXED XBRL financials filings to the parse topic — MONEY-1352.

    python scripts/enqueue_indexed_financials.py --ciks-from-active-stocks-without-fundamentals
    python scripts/enqueue_indexed_financials.py --forms 10-Q,20-F --from-fy 2023 --limit 200
    python scripts/enqueue_indexed_financials.py ... --apply     # publishes

Measured 2026-09-05: 584 of 7,112 CIK-bearing active US stocks have no
`us_fundamentals` row, and ~430 of them have XBRL FINANCIALS filings sitting
`INDEXED` and unparsed. `us_filings` rows reach a parser only through LIVE
DETECTION, which publishes as it discovers and never looks back — so a filing
indexed by a bulk walk, or one whose publish failed once, is parked forever with
no operator path to it. This is that path.

The selection rules live in `app/bulk/enqueue_logic.py` and are tested there.
This file is the I/O: read the rows, publish one message each, report.

WHAT IT DOES NOT DO. It does not write to `us_filings`. The status moves
INDEXED -> PARSED when the PARSER writes it (`dispatch.run_parse_job`), which is
the only place that knows whether the parse succeeded. Stamping DETECTED here
would claim in-flight for a message the topic may have rejected, and stamping it
after a failed publish would strand the filing in the one status that means
"someone is working on this".

Each message is the SAME payload live detection sends, from the same
`build_parse_message`, to the same base topic — a second spelling of the payload
here is a second thing to keep in agreement with the consumer.

`--apply` needs a TTY, like `purge_image_documents.py`. A dry run prints the
counts by form and by fiscal year and publishes NOTHING; publishing several
hundred messages that each cost a SEC fetch is a founder action.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from typing import Any

from app.bulk.backfill_logic import fiscal_year_of
from app.bulk.enqueue_logic import (
    ciks_without_fundamentals,
    indexed_financials_filter,
    passes_fiscal_floor,
)
from app.classify import TOPIC_BY_PARSE_CLASS
from app.db import get_database
from app.publish import Publisher, PublishError, build_parse_message
from app.store.collections import collection_name
from app.store.models import PARSE_CLASS_FINANCIALS

#: The Tiingo-side master. It is NOT one of the eleven collections this service
#: writes, so `collection_name` deliberately refuses to name it — this is a
#: READ across the seam and is spelled physically to say so.
US_INSTRUMENTS = "us_instruments"

#: Which rows in that master are in scope for the CIK difference. `cik` is
#: enriched by the nightly EDGAR join and is ABSENT on most rows, so the
#: `$type` test is what separates "no CIK" from "no such field" — `{"$ne": None}`
#: over a field a `db push` never created returns zero from both directions.
ACTIVE_STOCK_FILTER: dict[str, Any] = {
    "listingStatus": "ACTIVE",
    "assetType": "Stock",
    "cik": {"$type": "string"},
}


def _csv(value: str | None) -> list[str]:
    """`"a, b ,,c"` -> `["a", "b", "c"]`. Empty stays empty, never `[""]`."""
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ciks", help="comma-separated cik10 values to restrict to")
    parser.add_argument(
        "--ciks-from-active-stocks-without-fundamentals",
        action="store_true",
        help="restrict to active US stocks that have no us_fundamentals row at all",
    )
    parser.add_argument("--forms", help="comma-separated forms, e.g. 10-Q,20-F,40-F")
    parser.add_argument("--from-fy", type=int, help="fiscal-year floor (periodOfReport first)")
    parser.add_argument("--limit", type=int, help="publish at most this many filings")
    parser.add_argument("--apply", action="store_true", help="publish (default: count only)")
    args = parser.parse_args()

    database = get_database()
    if database is None:
        print("DATABASE_URL is unset or unreachable — nothing measured, nothing published")
        return 1

    ciks = _csv(args.ciks)
    if args.ciks_from_active_stocks_without_fundamentals:
        active = database[US_INSTRUMENTS].distinct("cik", ACTIVE_STOCK_FILTER)
        covered = database[collection_name("fundamentals")].distinct("cik10")
        uncovered = ciks_without_fundamentals(active, covered)
        print(
            f"{US_INSTRUMENTS}: {len(set(active))} active stocks with a CIK, "
            f"{len(set(covered))} CIKs already in {collection_name('fundamentals')} "
            f"-> {len(uncovered)} uncovered"
        )
        if not uncovered:
            print("nothing uncovered — no filings to enqueue")
            return 0
        # INTERSECTED, never replaced: an explicit --ciks is a narrowing, so
        # combining the two flags cannot silently widen the run to 584 filers.
        ciks = sorted(set(uncovered) & set(ciks)) if ciks else uncovered

    criteria = indexed_financials_filter(forms=_csv(args.forms), ciks=ciks)
    print(f"filter: {criteria}")
    if args.from_fy is not None:
        print(f"  + fiscal-year floor {args.from_fy} (applied in Python; the year is derived)")

    rows = [
        row
        for row in database[collection_name("filings")].find(
            criteria,
            {
                "accession": 1,
                "cik10": 1,
                "form": 1,
                "acceptedAt": 1,
                "periodOfReport": 1,
                "filedAt": 1,
            },
            # Oldest first, and ASC: a newest-first drain on a growing queue
            # pushes the oldest rows further down every cycle and never reaches
            # them (MONEY-1255). `_id` is the tiebreak so a repeat run of the
            # same --limit selects the same rows.
            sort=[("filedAt", 1), ("_id", 1)],
        )
        if passes_fiscal_floor(row, args.from_fy)
    ]
    if args.limit is not None:
        rows = rows[: max(0, args.limit)]

    by_form = Counter(str(row.get("form") or "?") for row in rows)
    by_year = Counter(
        str(fiscal_year_of(row.get("periodOfReport"), row.get("filedAt")) or "?") for row in rows
    )
    print(f"selected {len(rows)} filings")
    print(f"  by form: {dict(sorted(by_form.items()))}")
    print(f"  by fiscal year: {dict(sorted(by_year.items()))}")

    if not rows:
        return 0

    topic = TOPIC_BY_PARSE_CLASS[PARSE_CLASS_FINANCIALS]
    if not args.apply:
        print(f"DRY RUN — would publish {len(rows)} messages to {topic}-<env>. Nothing published.")
        return 0

    if not sys.stdin.isatty():
        print("REFUSING: --apply needs a TTY. Run it by hand.")
        return 3

    publisher = Publisher()
    failed = 0
    for row in rows:
        message = build_parse_message(
            accession=str(row["accession"]),
            cik10=str(row["cik10"]),
            form=str(row.get("form") or ""),
            parse_class=PARSE_CLASS_FINANCIALS,
            accepted_at=row.get("acceptedAt"),
        )
        try:
            publisher.publish(topic, message)
        except PublishError as err:
            # Named, and the loop CONTINUES: one rejected message must not
            # strand the remaining few hundred, and a silent stop would report
            # a smaller "published" with nothing saying why.
            failed += 1
            print(f"  publish failed for {row['accession']}: {err}")

    print(f"published {publisher.published} of {len(rows)} to {topic}-<env>; {failed} failed")
    return 0 if failed == 0 else 4


if __name__ == "__main__":
    raise SystemExit(main())
