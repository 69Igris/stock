"""The eleven MongoDB collections this service writes — MONEY-979.

## This file is PARSED, not imported, by a TypeScript test

``packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts`` reads
this file as TEXT and treats every value as a collection prod writes and QA
receives by copy. That guard is the reason the dict below is a PLAIN LITERAL
with one ``"key": "value",`` per line and no computation of any kind:

* no f-strings, no ``+``, no comprehension, no ``.format()``;
* no name built from a prefix constant;
* no conditional entries.

A regex parser cannot evaluate Python. The moment one entry is computed, the
TypeScript side reads a partial list, silently passes, and the missing
collection is never checked against ``REFERENCE_COLLECTIONS`` — which is exactly
the class of drift the guard exists to catch. If a future refactor wants
computed names, it has to change the TypeScript parser IN THE SAME COMMIT.

## Why the names are duplicated from ``schema.prisma``

They are not a second SOURCE, they are a second SPELLING, and the parity test in
T11 makes the two fail together. Prisma owns the schema; Python writes through
pymongo and therefore needs the physical ``@@map`` name, which Prisma does not
export to anything a Python process can read.
"""

from __future__ import annotations

#: Logical name -> physical MongoDB collection name.
#:
#: Every value is the ``@@map`` of a model in the
#: ``US FUNDAMENTALS — SEC EDGAR (MONEY-979)`` block at the end of
#: ``packages/database/prisma/schema.prisma``.
COLLECTIONS: dict[str, str] = {
    "filers": "us_filers",
    "filings": "us_filings",
    "fundamentals": "us_fundamentals",
    "company_facts": "us_company_facts",
    "insider_transactions": "us_insider_transactions",
    "thirteen_f_filings": "us_13f_filings",
    "thirteen_f_holdings": "us_13f_holdings",
    "beneficial_ownership": "us_beneficial_ownership",
    "filing_documents": "us_filing_documents",
    "cusip_map": "us_cusip_map",
    "edgar_cursor": "us_edgar_cursor",
}


def collection_name(logical: str) -> str:
    """Physical name for a logical collection. Raises on an unknown key.

    Raising is deliberate. Returning the logical name unchanged would create a
    NEW collection named e.g. ``fundamentals`` on the first write — a table that
    is not in the schema, not in the prod->QA sync, and not in any index, which
    nothing would notice until a reader came up empty.
    """
    try:
        return COLLECTIONS[logical]
    except KeyError as err:
        raise KeyError(
            f"unknown logical collection {logical!r}; known: {sorted(COLLECTIONS)}"
        ) from err
