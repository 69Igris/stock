"""Every field Prisma fills CLIENT-SIDE, the Python writer must fill itself.

MONEY-1317. `ingestedAt DateTime @default(now())` and `updatedAt DateTime
@updatedAt` are REQUIRED with no database default, and Prisma applies both in
its own client. This service writes through pymongo, so unless a row builder
emits them the column is simply absent — and a required-but-absent field makes
every Prisma read of that row THROW:

    PrismaClientKnownRequestError  P2032
    Error converting field "ingestedAt" of expected non-nullable type

Measured on prod 2026-09-01, that was 785,352 rows across SEVEN collections,
`us_fundamentals` among them — the one with a live reader
(`getStatements`), which therefore failed per-symbol, intermittently, for the
1.9% of rows the dict path wrote.

## Why the existing parity test did not catch it

`schema-parity.test.ts` compares `schema.prisma` against `models.py`, and
`models.py` DOES declare the timestamps with `default_factory=utc_now`. Parity
was green the whole time. But `upsert_filing_documents` — the typed path — has
zero callers: the live path builds plain dicts and wraps them in `_DocRow`,
whose `to_doc` passes the dict through untouched.

**The guard compared two declarations while a third, undeclared writer did the
actual writing.** So this one asserts on what a builder RETURNS, not on what a
model declares.

## The rule

A field must be present in the row when it is, in `schema.prisma`:

  * REQUIRED (no trailing `?`), and
  * carries a value Prisma supplies client-side — `@default(...)` or
    `@updatedAt`

`@id` / `@db.ObjectId` are excluded: Mongo generates `_id` itself.

Note the rule already covers fields the writers get RIGHT — `extractionStatus`
(`@default("PENDING")`) and `source` (`@default("SEC_EDGAR")`) are both
client-side defaults that the builders set explicitly. That they pass is the
evidence the rule is the right one, not an over-fit to the bug.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Mapping, Sequence

_SCHEMA = (
    Path(__file__).resolve().parents[3] / "packages" / "database" / "prisma" / "schema.prisma"
)

_FIELD = re.compile(
    r"^\s{2}(?P<name>[A-Za-z_][\w]*)\s+(?P<type>[A-Za-z]+)(?P<optional>\?)?(?P<attrs>[^\n]*)$"
)


def client_side_required_fields(model: str) -> set[str]:
    """Fields `model` declares REQUIRED with a Prisma-side default.

    Parsed from `schema.prisma` rather than listed here, so a new required
    field with a default is covered on the day it is added — which is the only
    version of this guard that keeps working.
    """
    src = _SCHEMA.read_text(encoding="utf-8")
    start = src.find(f"\nmodel {model} {{")
    assert start != -1, f"model {model} not found in schema.prisma"
    end = src.index("\n}", start)
    out: set[str] = set()
    for line in src[start:end].split("\n"):
        m = _FIELD.match(line)
        if not m:
            continue
        attrs = m.group("attrs")
        if m.group("optional") or "@id" in attrs or "@db.ObjectId" in attrs:
            continue
        if "@default(" in attrs or "@updatedAt" in attrs:
            out.add(m.group("name"))
    assert out, f"parsed no client-side-default fields out of model {model} — regex drifted"
    return out


def assert_stored_docs_carry_client_side_defaults(
    rows: Sequence[Mapping[str, Any]], model: str
) -> None:
    """Every STORED document must carry every field Prisma would have filled in.

    Asserted on what the WRITER put in the database, never on what a row builder
    returned. That distinction is the whole point: a parse is a pure function of
    the filing's bytes and must stay deterministic (two suites assert exactly
    that), so the timestamps are added by `bulk_upsert`, and the only honest
    place to check them is after the write.
    """
    required = client_side_required_fields(model)
    assert rows, f"no documents to check for {model} — nothing was written"
    for i, row in enumerate(rows):
        missing = sorted(f for f in required if f not in row)
        assert not missing, (
            f"{model} stored document {i} omits {missing}. Prisma declares these REQUIRED with a "
            f"client-side default, and pymongo does not apply Prisma defaults — so the "
            f"column is ABSENT and every Prisma read of this row raises P2032 "
            f"(MONEY-1317: 785,352 rows across 7 collections). Add them in the row "
            f"builder; `INSERT_ONLY_ALWAYS` already routes ingestedAt to $setOnInsert."
        )
