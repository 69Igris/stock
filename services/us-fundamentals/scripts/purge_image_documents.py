#!/usr/bin/env python3
"""Delete the image rows MONEY-1324 stopped writing — RUN BY HAND, ONCE PER ENV.

    python scripts/purge_image_documents.py            # count + sample, deletes NOTHING
    python scripts/purge_image_documents.py --apply    # deletes

`app/parsers/eightk_logic.py` no longer enqueues an attachment EDGAR types
`GRAPHIC`, and the reasoning is in its module docstring. This script clears what
the parser wrote before that: measured on prod 2026-09-01, 1,847 of the 3,054
rows in `us_filing_documents` were GRAPHIC and NONE carried a `textPath`.

DELETED rather than restamped `UNSUPPORTED`, for the same three reasons the
parser refuses them — the row holds nothing but identity, the fact is
re-derivable from the permanently archived submission bundle at zero SEC
requests, and a hashless row is re-emitted by every reparse. Leaving them
stamped would also mean every future reader had to remember to exclude them,
which is a convention rather than a fix.

TWO GUARDS, and neither is decoration:

* The deny set is IMPORTED from the parser, never restated. A purge that deletes
  a type the parser still writes puts the two into a nightly fight nobody sees.
* `textPath: null` is in the delete filter, and a row that HAS one aborts the
  run. Zero of 1,847 had one; if that is no longer true then something writes
  text for images and the measurement this whole change rests on has moved.
  In Mongo `{"textPath": None}` matches null AND ABSENT — the inclusive
  direction of the trap that has now cost MONEY-1050, 1234 and 1235. The
  dangerous spelling is the other one: `{"$ne": None}` over a field a `db push`
  never created returns zero from BOTH sides.

`--apply` needs a TTY, like `reclassify`/`resector` on the TypeScript side. An
irreversible delete against production is a founder action, not something a
wrapper script or an agent can arrive at by accident. Refusing prints the exact
filter, so a headless operator has the equivalent one-liner.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from app.db import get_database
from app.parsers.eightk_logic import BINARY_MEDIA_TYPES
from app.store.collections import collection_name

DOC_TYPES = sorted(BINARY_MEDIA_TYPES)
#: Only rows with NO text pointer. See the module docstring on the null match.
DELETE_FILTER: dict[str, Any] = {"documentType": {"$in": DOC_TYPES}, "textPath": None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="delete (default: count only)")
    args = parser.parse_args()

    database = get_database()
    if database is None:
        print("DATABASE_URL is unset or unreachable — nothing measured, nothing deleted")
        return 1

    documents = database[collection_name("filing_documents")]
    total = documents.count_documents({})
    matched = documents.count_documents({"documentType": {"$in": DOC_TYPES}})
    with_text = matched - documents.count_documents(DELETE_FILTER)

    share = f"{matched / total:.1%}" if total else "n/a"
    print(f"{collection_name('filing_documents')}: {total} rows, {matched} {DOC_TYPES} ({share})")
    for row in documents.find({"documentType": {"$in": DOC_TYPES}}, limit=3):
        print(f"  e.g. {row.get('accession')} seq {row.get('sequence')} {row.get('filename')}")

    if with_text:
        print(
            f"REFUSING: {with_text} of them carry a textPath. Zero did when this was "
            "measured, so an image now has extracted text and the argument for "
            "deleting these no longer holds. Investigate before re-running."
        )
        return 2

    if not args.apply:
        print(f"DRY RUN — would delete {matched}. Re-run with --apply.")
        print(f"  filter: {DELETE_FILTER}")
        return 0

    if not sys.stdin.isatty():
        print("REFUSING: --apply needs a TTY. Run it by hand, or delete with:")
        print(f"  db.{collection_name('filing_documents')}.deleteMany({DELETE_FILTER})")
        return 3

    deleted = documents.delete_many(DELETE_FILTER).deleted_count
    print(f"DELETED {deleted} rows; {documents.count_documents({})} remain.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
