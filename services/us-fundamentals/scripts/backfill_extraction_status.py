#!/usr/bin/env python3
"""Decide `extractionStatus` on the rows written before MONEY-1351 — ONCE PER ENV.

    python scripts/backfill_extraction_status.py            # counts + filters, writes NOTHING
    python scripts/backfill_extraction_status.py --apply    # updates

`app/parsers/eightk_logic.py` now stamps READY or FAILED at write time. This
script clears what the parser wrote before that: measured on prod 2026-09-05,
`extractionStatus` was `PENDING` on 100% of 5,377 `us_filing_documents` rows
while 3,296 of them already held text. One value across a whole population
measures nothing, and the question the column exists to answer — how much of the
queue is actually consumable — was unanswerable from it.

## The two filters, and why each is spelled the way it is

The parser decides on THE TEXT it just extracted. This script has no text; it has
only the stored row, whose evidence is `textPath`. The two discriminators are
different by necessity and agree in production, because the only writer that
assigns a path is the one that had text to write there.

* READY is `{"textPath": {"$type": "string"}}` — POSITIVE evidence that the row
  points at an object. NOT `{"$ne": None}`: over a field a `db push` never
  created, `$ne: null` returns zero from BOTH directions, which is the trap that
  has now cost MONEY-1050, 1234 and 1235. `$type` asks the question that is
  actually meant — "is there a string here" — and answers it the same way
  whether the field is null or absent.
* FAILED is `{"textPath": None, ...}`. In Mongo that matches null AND ABSENT,
  which is the INCLUSIVE direction of the same trap and is exactly what is wanted
  here: a row with no pointer, however it came to have none.

Images are EXCLUDED from FAILED rather than stamped. `scripts/purge_image_documents.py`
deletes them, and an env where that has not run yet must not have 1,847 GRAPHIC
rows restamped from "never processed" to "extraction failed" — a permanent claim
that we tried, over documents that were never enqueued and never will be. The
deny set is IMPORTED from the parser, never restated, for the same reason the
purge imports it: two copies of one rule fight where nobody is looking.

`extractionStatus` itself is deliberately NOT in either filter. Narrowing to
`{"extractionStatus": "PENDING"}` would look tidier and would miss every row
where the field is absent; both filters are idempotent, so a second run rewrites
the same value rather than needing the guard.

`--apply` needs a TTY, like `purge_image_documents.py` and like
`reclassify`/`resector` on the TypeScript side. Refusing prints the exact
filters, so a headless operator has the equivalent one-liners.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from app.db import get_database
from app.parsers.eightk_logic import (
    BINARY_MEDIA_TYPES,
    EXTRACTION_FAILED,
    EXTRACTION_READY,
)
from app.store.collections import collection_name

#: Types the parser refuses to enqueue at all. Imported, never restated.
BINARY_TYPES = sorted(BINARY_MEDIA_TYPES)


def backfill_plan() -> list[tuple[str, dict[str, Any]]]:
    """``[(status, filter)]`` — PURE, so the spellings above are testable.

    Ordered READY first only for readability of the printed plan; the two
    filters are DISJOINT (a `textPath` cannot be both a string and null), so
    neither run order nor a repeat changes the outcome.
    """
    return [
        (EXTRACTION_READY, {"textPath": {"$type": "string"}}),
        (
            EXTRACTION_FAILED,
            {"textPath": None, "documentType": {"$nin": BINARY_TYPES}},
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="update (default: count only)")
    args = parser.parse_args()

    database = get_database()
    if database is None:
        print("DATABASE_URL is unset or unreachable — nothing measured, nothing written")
        return 1

    name = collection_name("filing_documents")
    documents = database[name]
    total = documents.count_documents({})
    plan = backfill_plan()
    counts = [(status, criteria, documents.count_documents(criteria)) for status, criteria in plan]

    print(f"{name}: {total} rows")
    for status, criteria, matched in counts:
        share = f"{matched / total:.1%}" if total else "n/a"
        print(f"  -> {status:<6} {matched} ({share})   filter: {criteria}")
    untouched = total - sum(matched for _, _, matched in counts)
    print(f"  -> left alone: {untouched} (images, and anything neither filter claims)")

    if not args.apply:
        print("DRY RUN — nothing written. Re-run with --apply.")
        return 0

    if not sys.stdin.isatty():
        print("REFUSING: --apply needs a TTY. Run it by hand, or update with:")
        for status, criteria, _ in counts:
            print(f'  db.{name}.updateMany({criteria}, {{$set: {{extractionStatus: "{status}"}}}})')
        return 3

    for status, criteria, _ in counts:
        result = documents.update_many(criteria, {"$set": {"extractionStatus": status}})
        print(f"{status}: matched {result.matched_count}, modified {result.modified_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
