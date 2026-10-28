"""The collection map is a CONTRACT with three other things — MONEY-979.

1. ``packages/database/prisma/schema.prisma`` — every value is an ``@@map``.
2. ``scripts/ops/sync-prod-to-qa.sh`` — every value must be a REFERENCE_COLLECTION.
3. ``packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts`` — which
   READS THIS FILE AS TEXT.

(3) is why the parseability assertions below are not pedantry: a regex parser
cannot evaluate Python, so the first computed entry makes the TypeScript side
read a partial list, pass silently, and stop checking the collection it missed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.store.collections import COLLECTIONS, collection_name

SOURCE = Path(__file__).resolve().parents[1] / "app" / "store" / "collections.py"

EXPECTED = {
    "us_filers",
    "us_filings",
    "us_fundamentals",
    "us_company_facts",
    "us_insider_transactions",
    "us_13f_filings",
    "us_13f_holdings",
    "us_beneficial_ownership",
    "us_filing_documents",
    "us_cusip_map",
    "us_edgar_cursor",
}


def test_there_are_exactly_eleven_collections() -> None:
    assert len(COLLECTIONS) == 11


def test_the_names_are_exactly_the_eleven_prisma_maps() -> None:
    assert set(COLLECTIONS.values()) == EXPECTED


@pytest.mark.parametrize("name", sorted(COLLECTIONS.values()))
def test_every_collection_name_is_snake_case(name: str) -> None:
    """A capital letter or a dash here creates a SECOND collection on first
    write — not in the schema, not in the sync, not in any index — which nothing
    notices until a reader comes up empty."""
    assert re.fullmatch(r"^[a-z0-9_]+$", name), name


def test_every_collection_name_is_unique() -> None:
    assert len(set(COLLECTIONS.values())) == len(COLLECTIONS)


def test_every_collection_is_namespaced_us_() -> None:
    """The prefix is what lets the TypeScript guard and the QA sync select this
    service's tables without a hand-maintained second list."""
    for name in COLLECTIONS.values():
        assert name.startswith("us_"), name


def test_collection_name_raises_on_an_unknown_logical_key() -> None:
    """Returning the logical name unchanged would create a table that is in no
    schema and no sync."""
    assert collection_name("fundamentals") == "us_fundamentals"
    with pytest.raises(KeyError):
        collection_name("not_a_collection")


# ── The file must stay MACHINE-PARSEABLE ────────────────────────────────────


def test_the_dict_is_a_plain_literal_a_regex_parser_can_read() -> None:
    """Simulates what the TypeScript guard does: read the file, regex the pairs.

    If this ever finds fewer than eleven pairs while `COLLECTIONS` has eleven,
    the TypeScript guard is ALREADY reading a partial list and passing.
    """
    text = SOURCE.read_text(encoding="utf-8")
    body = text.split("COLLECTIONS: dict[str, str] = {", 1)[1].split("}", 1)[0]
    pairs = re.findall(r'^\s*"([a-z0-9_]+)":\s*"([a-z0-9_]+)",\s*$', body, re.MULTILINE)

    assert len(pairs) == 11
    assert {value for _, value in pairs} == EXPECTED
    assert dict(pairs) == COLLECTIONS


def test_no_entry_is_computed() -> None:
    """No f-string, concatenation, comprehension or `.format()` inside the dict."""
    text = SOURCE.read_text(encoding="utf-8")
    body = text.split("COLLECTIONS: dict[str, str] = {", 1)[1].split("}", 1)[0]
    for forbidden in ('f"', "f'", " + ", ".format(", " for ", " if "):
        assert forbidden not in body, f"{forbidden!r} makes the dict unparseable by the TS guard"
