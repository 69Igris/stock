"""``us_fundamentals`` has TWO writers on ONE unique key. Authority decides.

The per-filing XBRL parse and the ``companyfacts.zip`` fallback both derive
their rows from the same filing, so they produce the same ``accession`` and
collide on the whole unique key ``(cik10, statementType, periodType, periodEnd,
accession)``. ``mappingSource`` is deliberately NOT in that key.

Before :class:`AuthorityGuard`, the write was a blind ``$set`` and
``MAPPING_SOURCE_RANK`` was consulted only by ``recompute_is_latest`` — i.e.
AFTER the write, to choose which row carries a pointer. So the nightly bulk pass
overwrote the rich per-filing view with the poorer companyfacts one and the
dimensional segments were gone, with nothing left to reconcile against.

Every test here drives the REAL writer against the REAL in-memory collection
from ``test_store_writers`` (which enforces a real unique index), so a
regression in either half turns these red.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.store import writers
from app.store.writers import (
    MAPPING_COMPANYFACTS,
    MAPPING_FILING_XBRL,
    AuthorityGuard,
    bulk_upsert,
)
from tests.test_store_writers import FakeCollection

KEY = ("cik10", "statementType", "periodType", "periodEnd", "accession")
GUARD = AuthorityGuard(field="mappingSource", rank=writers.MAPPING_SOURCE_RANK)


class Row:
    """Minimal ``Row``: the protocol is just ``to_doc()``."""

    def __init__(self, **doc: Any) -> None:
        self._doc = doc

    def to_doc(self) -> dict[str, Any]:
        return dict(self._doc)


def _row(source: str, *, lines: int, segments: bool) -> Row:
    """One statement for Apple FY2025, as either writer would produce it."""
    return Row(
        cik10="0000320193",
        statementType="INCOME_STATEMENT",
        periodType="ANNUAL",
        periodEnd=datetime(2025, 9, 27, tzinfo=UTC),
        accession="0000320193-25-000073",
        mappingSource=source,
        standardized={"Revenue": 416_161_000_000},
        asReported=[{"concept": f"c{i}", "value": i} for i in range(lines)],
        hasSegments=segments,
        isLatest=False,
    )


def _collection() -> FakeCollection:
    target = FakeCollection("us_fundamentals")
    target.create_index([(field, 1) for field in KEY], unique=True)
    return target


def test_companyfacts_cannot_overwrite_a_filing_xbrl_row() -> None:
    """THE DEFECT. Rich row first, poor row second, same key."""
    target = _collection()
    bulk_upsert(
        target,
        [_row(MAPPING_FILING_XBRL, lines=44, segments=True)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    result = bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )

    assert len(target.documents) == 1, "the unique key must still hold one row"
    survivor = target.documents[0]
    assert survivor["mappingSource"] == MAPPING_FILING_XBRL
    assert len(survivor["asReported"]) == 44, "the rich per-filing parse was overwritten"
    assert survivor["hasSegments"] is True

    assert result.written == 0
    assert result.suppressed == 1, "a refusal must be COUNTED, not silent"


def test_filing_xbrl_does_overwrite_a_companyfacts_row() -> None:
    """The guard must not be a blanket freeze — the STRONGER source still wins."""
    target = _collection()
    bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    result = bulk_upsert(
        target,
        [_row(MAPPING_FILING_XBRL, lines=44, segments=True)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )

    survivor = target.documents[0]
    assert survivor["mappingSource"] == MAPPING_FILING_XBRL
    assert len(survivor["asReported"]) == 44
    assert result.written == 1
    assert result.suppressed == 0


def test_a_source_still_refreshes_its_own_row() -> None:
    """Equal rank is not "stronger", so a re-parse still corrects itself."""
    target = _collection()
    bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    result = bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=19, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )

    assert len(target.documents[0]["asReported"]) == 19
    assert result.written == 1
    assert result.suppressed == 0


def test_a_first_write_creates_and_is_never_counted_as_suppressed() -> None:
    """``suppressed`` must mean "a stronger source holds it", never "absent"."""
    target = _collection()
    result = bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    assert len(target.documents) == 1
    assert result.upserted == 1
    assert result.written == 1
    assert result.suppressed == 0


def test_an_absent_mapping_source_ranks_lowest_and_is_replaceable() -> None:
    """A legacy row predating the field must be reachable.

    Mongo's absent-vs-null trap: a ``{mappingSource: null}`` filter selects
    NOTHING when the attribute is absent, so a guard written that way would make
    every pre-existing row permanently unwritable. ``$nin`` matches absence.
    """
    target = _collection()
    legacy = _row(MAPPING_COMPANYFACTS, lines=3, segments=False).to_doc()
    legacy.pop("mappingSource")
    target.documents.append({**legacy, "_id": 999})

    result = bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    assert len(target.documents) == 1
    assert len(target.documents[0]["asReported"]) == 15
    assert result.suppressed == 0


def test_is_latest_stays_insert_only_under_the_guard() -> None:
    """The guarded path must keep the ``$setOnInsert`` contract.

    ``isLatest`` is owned by ``recompute_is_latest``; a re-write carrying the
    model default ``False`` would demote the current winner and leave the period
    with no latest row at all.
    """
    target = _collection()
    bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    target.documents[0]["isLatest"] = True

    bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=17, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=GUARD,
    )
    assert target.documents[0]["isLatest"] is True, "isLatest was demoted by a re-write"


def test_the_rank_table_is_what_decides_not_a_hardcoded_name() -> None:
    """Drive the REAL guard against an inverted rank and watch the answer flip.

    If the writer had FILING_XBRL hardcoded anywhere, this stays green while
    lying. It is the difference between testing the mechanism and testing a
    coincidence.
    """
    inverted = AuthorityGuard(
        field="mappingSource",
        rank={MAPPING_FILING_XBRL: 1, MAPPING_COMPANYFACTS: 2},
    )
    target = _collection()
    bulk_upsert(
        target,
        [_row(MAPPING_FILING_XBRL, lines=44, segments=True)],
        KEY,
        insert_only={"isLatest"},
        authority=inverted,
    )
    result = bulk_upsert(
        target,
        [_row(MAPPING_COMPANYFACTS, lines=15, segments=False)],
        KEY,
        insert_only={"isLatest"},
        authority=inverted,
    )

    assert target.documents[0]["mappingSource"] == MAPPING_COMPANYFACTS
    assert result.written == 1
    assert result.suppressed == 0


def test_stronger_than_is_pure_and_total() -> None:
    assert GUARD.stronger_than(MAPPING_FILING_XBRL) == []
    assert GUARD.stronger_than(MAPPING_COMPANYFACTS) == [MAPPING_FILING_XBRL]
    assert sorted(GUARD.stronger_than("SOMETHING_NEW")) == sorted(
        [MAPPING_COMPANYFACTS, MAPPING_FILING_XBRL]
    ), "an unknown source must rank LAST — it may fill a gap, never displace"
    assert GUARD.stronger_than(None) != []


# ── The guard must be WIRED, not merely available ───────────────────────────
#
# Everything above drives `bulk_upsert` with an explicit `authority=`. That
# proves the mechanism and proves nothing about whether the production writer
# uses it. This branch has already produced three separate "defined, exported,
# never called" defects, so the registration gets its own test.


def test_upsert_fundamentals_applies_the_guard_without_being_asked() -> None:
    """Drive the PRODUCTION writer. No `authority=` argument anywhere."""
    from datetime import date

    from tests.test_store_writers import FakeDatabase, _fundamentals

    db = FakeDatabase()
    target = db["us_fundamentals"]
    target.create_index([(field, 1) for field in KEY], unique=True)

    # SAME accession — the collision case. Two writers, one filing, one key.
    accession = "0000320193-25-000073"
    rich = _fundamentals(accession, filed=date(2025, 10, 30), mapping=MAPPING_FILING_XBRL)
    rich_doc = rich.to_doc()
    rich_doc["standardized"] = {"Revenue": 416_161_000_000, "GrossProfit": 1.0}
    poor = _fundamentals(accession, filed=date(2025, 10, 30), mapping=MAPPING_COMPANYFACTS)

    writers.upsert_fundamentals(db, [Row(**rich_doc)])
    result = writers.upsert_fundamentals(db, [poor])

    survivor = target.documents[0]
    assert survivor["mappingSource"] == MAPPING_FILING_XBRL, (
        "upsert_fundamentals did not apply the AuthorityGuard — the guard is "
        "defined but not wired into the production writer"
    )
    assert "GrossProfit" in survivor["standardized"]
    assert result.suppressed == 1


# ── One policy, both write paths ─────────────────────────────────────────────
#
# `us_fundamentals` is reached two ways: `upsert_fundamentals` (the bulk
# companyfacts fallback) and `MongoRowWriter.upsert_rows` (the per-filing parse,
# via dispatch). The second used to call `bulk_upsert` bare, so the
# AUTHORITATIVE writer had neither the authority guard nor `isLatest`
# insert-only protection while its twin had both. These tests exist so the two
# cannot drift apart again.


def test_the_parse_path_does_not_demote_is_latest() -> None:
    """THE DEFECT on the second path. A re-parse must not clear the pointer.

    The parser's row model carries `isLatest: False`. Without the policy that
    lands in `$set` and demotes the winner. Dispatch recomputes the pointer
    afterwards — but in a SEPARATE loop after ALL writes, so a crash or a throw
    in between leaves the period with no latest row at all.
    """
    from tests.test_store_writers import FakeDatabase

    db = FakeDatabase()
    target = db["us_fundamentals"]
    target.create_index([(field, 1) for field in KEY], unique=True)

    writer = writers.MongoRowWriter(db)
    doc = _row(MAPPING_FILING_XBRL, lines=44, segments=True).to_doc()
    writer.upsert_rows("fundamentals", [doc], key=KEY)
    target.documents[0]["isLatest"] = True  # recompute_is_latest promoted it

    writer.upsert_rows("fundamentals", [{**doc, "asReported": []}], key=KEY)
    assert target.documents[0]["isLatest"] is True, (
        "the parse path demoted isLatest — MongoRowWriter.upsert_rows is not "
        "honouring WritePolicy"
    )


def test_the_parse_path_is_authority_guarded_too() -> None:
    """A COMPANYFACTS row arriving through dispatch must not beat FILING_XBRL."""
    from tests.test_store_writers import FakeDatabase

    db = FakeDatabase()
    target = db["us_fundamentals"]
    target.create_index([(field, 1) for field in KEY], unique=True)

    writer = writers.MongoRowWriter(db)
    writer.upsert_rows(
        "fundamentals", [_row(MAPPING_FILING_XBRL, lines=44, segments=True).to_doc()], key=KEY
    )
    written = writer.upsert_rows(
        "fundamentals", [_row(MAPPING_COMPANYFACTS, lines=15, segments=False).to_doc()], key=KEY
    )

    assert len(target.documents[0]["asReported"]) == 44
    assert written == 0, "a suppressed row must not be reported as written"


def test_both_paths_resolve_the_SAME_policy_object() -> None:
    """Not "both are protected" — both read ONE declaration.

    Two paths that each hard-code their own protections agree until someone
    edits one of them. This asserts the shared lookup, so adding a protection in
    the table reaches both paths and cannot reach only one.
    """
    policy = writers.write_policy("fundamentals")
    assert policy.insert_only == frozenset({"isLatest"})
    assert policy.authority is not None
    assert policy.authority.field == "mappingSource"
    assert policy.authority.rank is writers.MAPPING_SOURCE_RANK

    # thirteen_f_filings: insert-only `tier`, owned by the evictor. No authority.
    tier_policy = writers.write_policy("thirteen_f_filings")
    assert tier_policy.insert_only == frozenset({"tier"})
    assert tier_policy.authority is None

    # Unknown collections must degrade, not raise: most have nothing to protect.
    assert writers.write_policy("insider_transactions") == writers.WritePolicy()


def test_filings_is_deliberately_absent_from_the_policy_table() -> None:
    """`status` is insert-only ONLY when the caller says so.

    A policy entry would silently override `status_on_insert_only=False`, which
    is how the nightly ledger is allowed to record a filing it has never seen
    without downgrading one a parser already advanced.
    """
    assert writers.write_policy("filings") == writers.WritePolicy()


def test_guarding_a_KEY_field_is_refused() -> None:
    """A guard on a key field would rewrite the key equality as a `$nin`.

    The update could then land on a different row entirely. This is a footgun
    rather than an observed bug — but `mappingSource` sits outside the unique
    key precisely because putting a discriminator IN the key makes one period
    two rows, so the next person to add a guard is being pulled toward exactly
    this mistake.
    """
    import pytest

    target = _collection()
    bad = AuthorityGuard(field="accession", rank={"x": 1})
    with pytest.raises(ValueError, match="part of the unique key"):
        bulk_upsert(
            target,
            [_row(MAPPING_FILING_XBRL, lines=1, segments=False)],
            KEY,
            authority=bad,
        )
    assert target.documents == [], "nothing may be written before the refusal"
