"""Writers — MONEY-979.

## Why there is a hand-written fake here and not ``mongomock``

``mongomock`` 4.3.0 (the latest release) is INCOMPATIBLE with the pinned
``pymongo`` in this service's venv: ``pymongo>=4.8`` resolves to 4.17, whose
``UpdateOne._add_to_bulk`` passes a ``sort=`` keyword that mongomock's
``BulkOperationBuilder.add_update`` does not accept, so **every**
``collection.bulk_write`` raises ``TypeError`` before reaching any Mongo
semantics. ``bulk_write`` is the one API under test, so mongomock would have
tested nothing at all. Measured 2026-08-29; recorded here rather than in a
commit message so the next person does not re-install it.

:class:`FakeCollection` is therefore a real, if small, implementation: it applies
``$set`` / ``$setOnInsert`` / ``$max`` with MongoDB's semantics, distinguishes
MATCHED from MODIFIED by comparing the document before and after, and enforces a
REAL unique index — raising the driver's own :class:`BulkWriteError` with a
``writeErrors`` list. Those are exactly the behaviours the writers' correctness
argument rests on; a mock that accepted everything would test the opposite.
"""

from __future__ import annotations

import copy
import json
from datetime import UTC, date, datetime
from typing import Any

import pytest
from pymongo.errors import BulkWriteError

from app.store import writers
from app.store.models import (
    MAPPING_COMPANYFACTS,
    MAPPING_FILING_XBRL,
    STATEMENT_INCOME,
    UsEdgarCursorRow,
    UsFilerRow,
    UsFilingRow,
    UsFundamentalsRow,
)

from tests._row_contract import assert_stored_docs_carry_client_side_defaults

# ── A small, honest MongoDB ─────────────────────────────────────────────────


def _matches(document: dict[str, Any], criteria: dict[str, Any]) -> bool:
    for field, expected in criteria.items():
        actual = document.get(field)
        if isinstance(expected, dict):
            for operator, operand in expected.items():
                if operator == "$ne" and actual == operand:
                    return False
                if operator == "$in" and actual not in operand:
                    return False
                # `$nin` matches an ABSENT field too — that is the property the
                # AuthorityGuard depends on, so the fake must reproduce it
                # rather than silently ignoring an operator it does not know.
                if operator == "$nin" and actual in operand:
                    return False
                if operator == "$exists" and (field in document) != bool(operand):
                    return False
                if operator == "$type":
                    kinds = {"string": str, "int": int, "bool": bool, "double": float}
                    if not isinstance(actual, kinds.get(operand, object)):
                        return False
        elif actual != expected:
            return False
    return True


class FakeCollection:
    """In-memory collection with real ``$set``/``$setOnInsert``/``$max`` and a real unique index."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.documents: list[dict[str, Any]] = []
        self.indexes: list[tuple[tuple[str, ...], bool]] = []
        self.index_calls: list[tuple[tuple[str, ...], bool]] = []
        self._next_id = 1

    # -- indexes --
    def create_index(self, keys: Any, unique: bool = False, **_: Any) -> str:
        fields = tuple(field for field, _direction in keys)
        self.index_calls.append((fields, unique))
        if (fields, unique) not in self.indexes:
            self.indexes.append((fields, unique))
        return "_".join(fields)

    def _unique_conflict(self, candidate: dict[str, Any]) -> tuple[str, ...] | None:
        for fields, unique in self.indexes:
            if not unique:
                continue
            key = tuple(candidate.get(field) for field in fields)
            for existing in self.documents:
                if existing is candidate:
                    continue
                if tuple(existing.get(field) for field in fields) == key:
                    return fields
        return None

    # -- reads --
    def find(
        self, criteria: dict[str, Any], projection: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        found = [copy.deepcopy(d) for d in self.documents if _matches(d, criteria)]
        if projection:
            keep = set(projection) | {"_id"}
            found = [{k: v for k, v in d.items() if k in keep} for d in found]
        return found

    def find_one(
        self, criteria: dict[str, Any], projection: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        rows = self.find(criteria, projection)
        return rows[0] if rows else None

    def count_documents(self, criteria: dict[str, Any]) -> int:
        return len(self.find(criteria))

    # -- writes --
    def _apply(self, document: dict[str, Any], update: dict[str, Any], *, inserting: bool) -> None:
        for field, value in (update.get("$set") or {}).items():
            document[field] = value
        for field, value in (update.get("$max") or {}).items():
            current = document.get(field)
            if current is None or value > current:
                document[field] = value
        if inserting:
            for field, value in (update.get("$setOnInsert") or {}).items():
                document.setdefault(field, value)

    def bulk_write(self, operations: list[Any], ordered: bool = True) -> Any:
        matched = upserted = modified = 0
        errors: list[dict[str, Any]] = []
        for index, operation in enumerate(operations):
            criteria = operation._filter
            update = operation._doc
            upsert = bool(operation._upsert)
            target = next((d for d in self.documents if _matches(d, criteria)), None)
            if target is not None:
                before = copy.deepcopy(target)
                self._apply(target, update, inserting=False)
                matched += 1
                if target != before:
                    modified += 1
                continue
            if not upsert:
                continue
            document: dict[str, Any] = {
                field: value for field, value in criteria.items() if not isinstance(value, dict)
            }
            self._apply(document, update, inserting=True)
            document["_id"] = self._next_id
            self._next_id += 1
            conflict = self._unique_conflict(document)
            if conflict is not None:
                errors.append({"index": index, "code": 11000, "errmsg": f"E11000 {conflict}"})
                continue
            self.documents.append(document)
            upserted += 1
        if errors:
            raise BulkWriteError(
                {
                    "writeErrors": errors,
                    "nMatched": matched,
                    "nUpserted": upserted,
                    "nModified": modified,
                }
            )
        return type(
            "BulkResult",
            (),
            {"matched_count": matched, "upserted_count": upserted, "modified_count": modified},
        )()

    def update_many(self, criteria: dict[str, Any], update: dict[str, Any]) -> Any:
        modified = 0
        for document in self.documents:
            if not _matches(document, criteria):
                continue
            before = copy.deepcopy(document)
            self._apply(document, update, inserting=False)
            if document != before:
                modified += 1
        return type("R", (), {"modified_count": modified})()

    def update_one(
        self, criteria: dict[str, Any], update: dict[str, Any], upsert: bool = False
    ) -> Any:
        for document in self.documents:
            if not _matches(document, criteria):
                continue
            before = copy.deepcopy(document)
            self._apply(document, update, inserting=False)
            return type("R", (), {"modified_count": 1 if document != before else 0})()
        return type("R", (), {"modified_count": 0})()


class FakeDatabase:
    """``db[name]`` over :class:`FakeCollection`, created on demand."""

    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection(name)
        return self.collections[name]

    def names(self) -> list[str]:
        return sorted(self.collections)


@pytest.fixture
def db() -> FakeDatabase:
    writers.reset_index_cache()
    return FakeDatabase()


# ── Helpers ─────────────────────────────────────────────────────────────────


def _fundamentals(
    accession: str,
    *,
    filed: date,
    form: str = "10-K",
    mapping: str = MAPPING_FILING_XBRL,
    amendment: bool = False,
    period_end: date = date(2024, 12, 31),
) -> UsFundamentalsRow:
    return UsFundamentalsRow(
        cik10="0000320193",
        statementType=STATEMENT_INCOME,
        periodType="ANNUAL",
        periodEnd=period_end,
        fiscalYear=period_end.year,
        fiscalPeriod="FY",
        accession=accession,
        form=form,
        filedAt=filed,
        isAmendment=amendment,
        mappingSource=mapping,
        mappingVersion="test/1",
        parserVersion="test",
        standardized={"Revenues": 1.0},
    )


# ── Idempotency ─────────────────────────────────────────────────────────────


def test_upsert_is_idempotent_same_document_count_and_no_duplicate_key(db: FakeDatabase) -> None:
    rows = [
        UsFilerRow(cik10="0000320193", name="Apple Inc."),
        UsFilerRow(cik10="0001067983", name="BRK"),
    ]
    first = writers.upsert_filers(db, rows)
    second = writers.upsert_filers(db, rows)
    assert first.upserted == 2
    assert first.failed == 0 and second.failed == 0
    # A second run over identical rows must not create rows and must not raise a
    # duplicate key: the upsert MATCHES the existing document instead.
    assert second.upserted == 0
    assert second.matched == 2
    assert db["us_filers"].count_documents({}) == 2


def test_second_run_touches_the_row_and_reports_written_zero_when_nothing_changed(
    db: FakeDatabase,
) -> None:
    stamp = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)
    row = UsFilerRow(cik10="0000320193", name="Apple Inc.", ingestedAt=stamp, updatedAt=stamp)
    writers.upsert_filers(db, [row])
    again = writers.upsert_filers(db, [row])
    assert again.matched == 1
    assert again.modified == 0
    assert again.written == 0


def test_ingested_at_is_set_on_insert_and_never_moved(db: FakeDatabase) -> None:
    first_stamp = datetime(2026, 1, 1, tzinfo=UTC)
    later_stamp = datetime(2026, 8, 29, tzinfo=UTC)
    writers.upsert_filers(
        db,
        [
            UsFilerRow(
                cik10="0000320193", name="Apple", ingestedAt=first_stamp, updatedAt=first_stamp
            )
        ],
    )
    writers.upsert_filers(
        db,
        [
            UsFilerRow(
                cik10="0000320193", name="Apple Inc.", ingestedAt=later_stamp, updatedAt=later_stamp
            )
        ],
    )
    stored = db["us_filers"].find_one({"cik10": "0000320193"})
    assert stored is not None
    assert stored["ingestedAt"] == first_stamp, "ingestedAt must be $setOnInsert, not $set"
    assert stored["updatedAt"] == later_stamp
    assert stored["name"] == "Apple Inc."


def test_unknown_fields_are_absent_not_null(db: FakeDatabase) -> None:
    writers.upsert_filers(db, [UsFilerRow(cik10="0000320193", name="Apple")])
    stored = db["us_filers"].find_one({"cik10": "0000320193"})
    assert stored is not None
    for field in ("sic", "sicDescription", "fiscalYearEnd", "entityType", "stateOfInc"):
        assert field not in stored, f"{field} was written as an explicit null"
    # And the empty-but-known values ARE written: an empty list is an answer.
    assert stored["formerNames"] == []
    assert stored["tickersAsFiled"] == []


def test_a_later_run_that_learned_nothing_does_not_erase_what_an_earlier_one_knew(
    db: FakeDatabase,
) -> None:
    writers.upsert_filers(db, [UsFilerRow(cik10="0000320193", name="Apple", sic="3571")])
    writers.upsert_filers(db, [UsFilerRow(cik10="0000320193", name="Apple")])
    stored = db["us_filers"].find_one({"cik10": "0000320193"})
    assert stored is not None
    assert stored["sic"] == "3571"


def test_missing_key_field_raises_rather_than_upserting_onto_some_other_row(
    db: FakeDatabase,
) -> None:
    row = UsFilerRow(cik10="0000320193", name="Apple")
    with pytest.raises(ValueError, match="key field"):
        writers.bulk_upsert(db["us_filers"], [row], ("cik10", "sic"))


def test_a_duplicate_key_is_counted_and_the_rest_of_the_chunk_still_lands(db: FakeDatabase) -> None:
    # A filter WIDER than the unique index: two rows miss each other's filter,
    # both try to insert, and the second collides. That is the shape a racing
    # second process produces, and `ordered=False` must let the rest through.
    target = db["us_filers"]
    target.create_index([("cik10", 1)], unique=True)
    rows = [
        UsFilerRow(cik10="0000320193", name="Apple Inc."),
        UsFilerRow(cik10="0000320193", name="Apple Computer, Inc."),
        UsFilerRow(cik10="0001067983", name="BRK"),
    ]
    result = writers.bulk_upsert(target, rows, ("cik10", "name"))
    assert result.failed == 1, "the colliding operation must be COUNTED"
    assert result.upserted == 2, "the other operations must still have landed"
    assert target.count_documents({}) == 2


# ── us_filings status ───────────────────────────────────────────────────────


def _filing(accession: str, status: str) -> UsFilingRow:
    return UsFilingRow(
        accession=accession,
        cik10="0000320193",
        form="10-K",
        filedAt=date(2026, 1, 5),
        parseClass="FINANCIALS",
        status=status,
    )


def test_the_ledger_never_downgrades_a_parsed_filing(db: FakeDatabase) -> None:
    writers.upsert_filings(db, [_filing("0000320193-26-000001", "DETECTED")])
    writers.mark_filing_status(db, "0000320193-26-000001", "PARSED", parser_version="v1")
    # The nightly ledger runs and sees the same filing with its own INDEXED view.
    writers.upsert_filings(db, [_filing("0000320193-26-000001", "INDEXED")])
    stored = db["us_filings"].find_one({"accession": "0000320193-26-000001"})
    assert stored is not None
    assert stored["status"] == "PARSED"
    assert stored["parserVersion"] == "v1"


def test_the_ledger_records_indexed_for_a_filing_no_detector_saw(db: FakeDatabase) -> None:
    writers.upsert_filings(db, [_filing("0000320193-26-000009", "INDEXED")])
    stored = db["us_filings"].find_one({"accession": "0000320193-26-000009"})
    assert stored is not None
    assert stored["status"] == "INDEXED"


def test_mark_filing_status_never_creates_a_partial_row(db: FakeDatabase) -> None:
    result = writers.mark_filing_status(db, "0000320193-26-777777", "PARSED")
    assert result.upserted == 0
    assert db["us_filings"].count_documents({}) == 0


# ── isLatest ────────────────────────────────────────────────────────────────


def test_exactly_one_row_per_group_is_latest_and_the_newest_filing_wins(db: FakeDatabase) -> None:
    rows = [
        _fundamentals("0000320193-25-000001", filed=date(2025, 2, 1)),
        _fundamentals("0000320193-26-000002", filed=date(2026, 2, 1)),
        _fundamentals("0000320193-24-000003", filed=date(2024, 2, 1)),
    ]
    writers.upsert_fundamentals(db, rows)
    outcome = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert outcome.candidates == 3
    assert outcome.winner == "0000320193-26-000002"
    stored = db["us_fundamentals"].find({})
    assert sum(1 for row in stored if row.get("isLatest")) == 1


def test_is_latest_is_order_independent(db: FakeDatabase) -> None:
    rows = [
        _fundamentals("0000320193-25-000001", filed=date(2025, 2, 1)),
        _fundamentals("0000320193-26-000002", filed=date(2026, 2, 1)),
        _fundamentals("0000320193-24-000003", filed=date(2024, 2, 1)),
        _fundamentals("0000320193-26-000004", filed=date(2026, 2, 1), form="10-Q"),
    ]
    winners = set()
    for order in ([0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]):
        writers.reset_index_cache()
        fresh = FakeDatabase()
        writers.upsert_fundamentals(fresh, [rows[i] for i in order])
        outcome = writers.recompute_is_latest(
            fresh, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
        )
        winners.add(outcome.winner)
        assert sum(1 for row in fresh["us_fundamentals"].find({}) if row.get("isLatest")) == 1
    assert winners == {"0000320193-26-000002"}, "the winner must not depend on insertion order"


def test_a_ten_k_beats_a_ten_q_filed_the_same_day(db: FakeDatabase) -> None:
    writers.upsert_fundamentals(
        db,
        [
            _fundamentals("0000320193-26-000010", filed=date(2026, 2, 1), form="10-Q"),
            _fundamentals("0000320193-26-000011", filed=date(2026, 2, 1), form="10-K"),
        ],
    )
    outcome = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert outcome.winner == "0000320193-26-000011"


def test_a_non_amendment_beats_an_amendment_filed_at_the_same_instant(db: FakeDatabase) -> None:
    writers.upsert_fundamentals(
        db,
        [
            _fundamentals("0000320193-26-000020", filed=date(2026, 2, 1), amendment=True),
            _fundamentals("0000320193-26-000021", filed=date(2026, 2, 1), amendment=False),
        ],
    )
    outcome = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert outcome.winner == "0000320193-26-000021"


def test_a_companyfacts_row_loses_to_a_filing_xbrl_row_for_the_same_period(
    db: FakeDatabase,
) -> None:
    # The COMPANYFACTS row is even filed LATER — it is a comparative carried into
    # a later 10-K — and it still loses, because authority outranks recency here.
    writers.upsert_fundamentals(
        db,
        [
            _fundamentals(
                "0000320193-25-000030", filed=date(2025, 2, 1), mapping=MAPPING_FILING_XBRL
            ),
            _fundamentals(
                "0000320193-26-000031", filed=date(2026, 2, 1), mapping=MAPPING_COMPANYFACTS
            ),
        ],
    )
    outcome = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert outcome.winner == "0000320193-25-000030"
    stored = {row["accession"]: row.get("isLatest") for row in db["us_fundamentals"].find({})}
    assert stored == {"0000320193-25-000030": True, "0000320193-26-000031": False}


def test_an_unknown_mapping_source_ranks_last(db: FakeDatabase) -> None:
    writers.upsert_fundamentals(
        db,
        [
            _fundamentals(
                "0000320193-20-000040", filed=date(2020, 2, 1), mapping=MAPPING_COMPANYFACTS
            ),
            _fundamentals("0000320193-26-000041", filed=date(2026, 2, 1), mapping="SOME_NEW_FEED"),
        ],
    )
    outcome = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert outcome.winner == "0000320193-20-000040"


def test_recompute_is_re_runnable_and_the_second_pass_changes_nothing(db: FakeDatabase) -> None:
    writers.upsert_fundamentals(
        db,
        [
            _fundamentals("0000320193-25-000050", filed=date(2025, 2, 1)),
            _fundamentals("0000320193-26-000051", filed=date(2026, 2, 1)),
        ],
    )
    first = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    second = writers.recompute_is_latest(
        db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert first.promoted + first.demoted > 0
    assert (second.promoted, second.demoted) == (0, 0)
    assert second.winner == first.winner


def test_recompute_on_an_empty_group_reports_nothing_rather_than_guessing(db: FakeDatabase) -> None:
    outcome = writers.recompute_is_latest(
        db, "0000000000", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31)
    )
    assert outcome == writers.IsLatestResult()


def test_a_re_upsert_does_not_demote_the_current_winner(db: FakeDatabase) -> None:
    rows = [
        _fundamentals("0000320193-25-000060", filed=date(2025, 2, 1)),
        _fundamentals("0000320193-26-000061", filed=date(2026, 2, 1)),
    ]
    writers.upsert_fundamentals(db, rows)
    writers.recompute_is_latest(db, "0000320193", STATEMENT_INCOME, "ANNUAL", date(2024, 12, 31))
    writers.upsert_fundamentals(db, rows)
    latest = [row["accession"] for row in db["us_fundamentals"].find({}) if row.get("isLatest")]
    assert latest == ["0000320193-26-000061"], "isLatest must be $setOnInsert, not $set"


def test_the_is_latest_projection_asks_for_every_field_the_rank_reads() -> None:
    # A projection that had drifted from the ranking function would make "we
    # never asked for the column" read as "the row has no value there".
    document = {field: None for field in writers.IS_LATEST_FIELDS}
    assert writers.latest_rank(document) == (0, float("-inf"), 1, 1, "")


# ── Coverage counters ───────────────────────────────────────────────────────


def test_coverage_counters_only_ever_rise(db: FakeDatabase) -> None:
    writers.bump_filer_coverage(
        db, "0000320193", name="Apple", fiscal_years_on_file=17, eligible_for_coverage=True
    )
    writers.bump_filer_coverage(
        db, "0000320193", name="Apple", fiscal_years_on_file=3, eligible_for_coverage=False
    )
    stored = db["us_filers"].find_one({"cik10": "0000320193"})
    assert stored is not None
    assert stored["fiscalYearsOnFile"] == 17
    assert stored["eligibleForCoverage"] is True


def test_coverage_counters_create_a_filer_row_the_submissions_job_has_not_seen(
    db: FakeDatabase,
) -> None:
    writers.bump_filer_coverage(
        db,
        "0001769628",
        name="CoreWeave, Inc.",
        fiscal_years_on_file=1,
        eligible_for_coverage=False,
    )
    stored = db["us_filers"].find_one({"cik10": "0001769628"})
    assert stored is not None
    assert stored["name"] == "CoreWeave, Inc."
    assert stored["fiscalYearsOnFile"] == 1
    assert stored["eligibleForCoverage"] is False
    assert stored["inUniverse"] is False


# ── Indexes and cursors ─────────────────────────────────────────────────────


def test_the_unique_index_is_ensured_before_the_first_write(db: FakeDatabase) -> None:
    writers.upsert_filings(db, [_filing("0000320193-26-000100", "INDEXED")])
    unique = [fields for fields, is_unique in db["us_filings"].indexes if is_unique]
    assert ("accession",) in unique


def test_indexes_are_ensured_once_per_process(db: FakeDatabase) -> None:
    writers.upsert_filers(db, [UsFilerRow(cik10="0000320193", name="Apple")])
    writers.upsert_filers(db, [UsFilerRow(cik10="0001067983", name="BRK")])
    assert len(db["us_filers"].index_calls) == len(writers.INDEX_SPECS["filers"])


def test_an_index_failure_is_logged_and_never_fatal(db: FakeDatabase) -> None:
    from pymongo.errors import OperationFailure

    def explode(*_args: Any, **_kwargs: Any) -> None:
        raise OperationFailure("IndexOptionsConflict", 85)

    db["us_filers"].create_index = explode  # type: ignore[method-assign]
    writers.upsert_filers(db, [UsFilerRow(cik10="0000320193", name="Apple")])
    assert db["us_filers"].count_documents({}) == 1


def test_cursor_round_trips_and_created_at_is_insert_only(db: FakeDatabase) -> None:
    created = datetime(2026, 1, 1, tzinfo=UTC)
    writers.upsert_cursor(
        db, UsEdgarCursorRow(key="bulk:submissions", createdAt=created, meta={"etag": "a"})
    )
    writers.upsert_cursor(
        db,
        UsEdgarCursorRow(
            key="bulk:submissions", createdAt=datetime(2026, 8, 29, tzinfo=UTC), meta={"etag": "b"}
        ),
    )
    stored = writers.read_cursor(db, "bulk:submissions")
    assert stored is not None
    assert stored["createdAt"] == created
    assert stored["meta"] == {"etag": "b"}
    assert writers.read_cursor(db, "never-run") is None


def test_every_stored_document_is_json_encodable_without_a_null(db: FakeDatabase) -> None:
    writers.upsert_filers(db, [UsFilerRow(cik10="0000320193", name="Apple")])
    writers.upsert_filings(db, [_filing("0000320193-26-000200", "INDEXED")])
    for collection in db.collections.values():
        for document in collection.documents:
            encoded = json.dumps(document, default=str)
            assert ": null" not in encoded and ":null" not in encoded


# ── MONEY-1317: the dict path, which nothing exercised ──────────────────────


def test_a_plain_dict_row_is_stored_with_the_timestamps_prisma_requires(
    db: FakeDatabase,
) -> None:
    """The path that produced 785,352 unreadable rows, and had no test.

    `MongoRowWriter.upsert_rows` wraps plain dicts in `_DocRow`, whose `to_doc`
    passes them through untouched — unlike the typed `models.py` rows, which
    declare `default_factory=utc_now`. Every parser writes through this path;
    `upsert_filing_documents`, the typed one, has zero callers.

    So `ingestedAt`/`updatedAt` were simply absent, and because they are
    REQUIRED in schema.prisma with only a CLIENT-SIDE default, every Prisma read
    raised P2032. `schema-parity.test.ts` stayed green throughout: it compares
    schema.prisma to models.py, and models.py was never the writer.
    """
    writer = writers.MongoRowWriter(db)
    writer.upsert_rows(
        "filing_documents",
        [
            {
                "accession": "0001420720-26-000019",
                "sequence": 2,
                "cik10": "0001420720",
                "form": "8-K",
                "filedAt": datetime(2026, 8, 28, tzinfo=UTC),
                "items": ["2.02", "9.01"],
                "documentType": "EX-99.1",
                "filename": "ex99d1.htm",
                "extractionStatus": "PENDING",
                "source": "SEC_EDGAR",
                "parserVersion": "test",
            }
        ],
        key=("accession", "sequence"),
    )
    stored = list(db["us_filing_documents"].find({}))
    assert_stored_docs_carry_client_side_defaults(stored, "UsFilingDocument")


def test_a_dict_row_that_declares_its_own_timestamps_keeps_them(
    db: FakeDatabase,
) -> None:
    """FILL, never OVERRIDE — and the control for the case above.

    Without this, a writer that stamped unconditionally would satisfy the
    previous test while breaking the two contracts one screen up: an explicit
    `updatedAt` must survive, and a re-run of an identical row must report
    `modified == 0`. A first version of this fix did exactly that.
    """
    mine = datetime(2020, 1, 1, tzinfo=UTC)
    writer = writers.MongoRowWriter(db)
    row = {
        "accession": "0000000000-00-000000",
        "sequence": 1,
        "cik10": "0000000000",
        "form": "8-K",
        "filedAt": mine,
        "items": [],
        "documentType": "8-K",
        "filename": "f.htm",
        "extractionStatus": "PENDING",
        "source": "SEC_EDGAR",
        "parserVersion": "test",
        "ingestedAt": mine,
        "updatedAt": mine,
    }
    writer.upsert_rows("filing_documents", [row], key=("accession", "sequence"))
    stored = db["us_filing_documents"].find_one({"sequence": 1})
    assert stored is not None
    assert stored["ingestedAt"] == mine
    assert stored["updatedAt"] == mine, "the writer overrode a timestamp the row declared"


def test_the_authority_guarded_path_stamps_too(db: FakeDatabase) -> None:
    """`us_fundamentals` writes through `_bulk_upsert_guarded`, not `bulk_upsert`.

    A `WritePolicy` with an `authority` (`mappingSource`) routes the whole write
    down a SECOND document-building path. Stamping only the first one leaves
    `us_fundamentals` broken — and that is the collection with a live reader
    (`getStatements`) and 21,725 affected rows on prod, so it is the one that
    matters most.

    Added because a mutation that stamped only `bulk_upsert` SURVIVED the suite:
    nothing exercised the guarded path with a plain dict row.
    """
    writer = writers.MongoRowWriter(db)
    writer.upsert_rows(
        "fundamentals",
        [
            {
                "cik10": "0000320193",
                "accession": "0000320193-25-000079",
                "statementType": STATEMENT_INCOME,
                "periodType": "ANNUAL",
                "periodEnd": datetime(2025, 9, 27, tzinfo=UTC),
                "form": "10-K",
                "filedAt": datetime(2025, 10, 31, tzinfo=UTC),
                "standardized": {"Revenue": 416161000000.0},
                "mappingSource": MAPPING_FILING_XBRL,
                "source": "SEC_EDGAR",
                "parserVersion": "test",
                "currency": "USD",
                "isAmendment": False,
                "isLatest": True,
            }
        ],
        key=("cik10", "statementType", "periodType", "periodEnd", "accession"),
    )
    stored = list(db["us_fundamentals"].find({}))
    assert stored, "the guarded path wrote nothing — the fixture key is wrong"
    assert_stored_docs_carry_client_side_defaults(stored, "UsFundamentals")


# ── MONEY-1317 round 2: the fill must not land in `$set` ─────────────────────
#
# The fix above stamped `updatedAt` into the document, and `INSERT_ONLY_ALWAYS`
# holds only `ingestedAt`/`createdAt` — so the stamp went to `$set`, with a
# fresh `utc_now()` on every run. `write_operations` derives `modified` from
# pymongo's `modified_count`, which counts documents whose VALUES changed, so a
# re-parse of an unchanged filing began reporting `modified == N` where it had
# reported 0. That is the number `MongoRowWriter.upsert_rows` returns and the
# zero-write monitor reads: it could no longer reach zero, in the one direction
# a monitor cannot alarm on.
#
# None of the tests one screen up can see it. Every one of them constructs a row
# — typed or dict — carrying an EXPLICIT `updatedAt`, so the writer's fill never
# fires. The fixture supplied the very thing under test, on the exact path
# (plain dicts, no timestamps) that caused MONEY-1317 in the first place. These
# pass no timestamps at all.


class _Clock:
    """A clock the test moves by hand, substituted for ``writers.utc_now``.

    Two real ``bulk_upsert`` calls are microseconds apart, so a refreshed
    ``updatedAt`` WOULD differ — but by an amount that reads as jitter and would
    make the assertion an inequality against noise. Moving the clock a year
    between runs makes "the writer refreshed it" an equality against a known
    instant, and impossible to mistake for anything else.
    """

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now


FIRST_RUN = datetime(2026, 1, 1, tzinfo=UTC)
SECOND_RUN = datetime(2027, 1, 1, tzinfo=UTC)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    ticking = _Clock(FIRST_RUN)
    monkeypatch.setattr(writers, "utc_now", ticking)
    return ticking


def _parsed_document(**overrides: Any) -> dict[str, Any]:
    """A ``us_filing_documents`` row exactly as a parser emits one.

    Deliberately carries NO ``ingestedAt`` and NO ``updatedAt``. That is not a
    convenience — it is the shape under test. A parse is a pure function of the
    filing's bytes (two suites assert exactly that), so no ``build_rows``
    function may stamp a clock, and the writer is the only thing that can.
    """
    row: dict[str, Any] = {
        "accession": "0001420720-26-000019",
        "sequence": 2,
        "cik10": "0001420720",
        "form": "8-K",
        "filedAt": datetime(2026, 8, 28, tzinfo=UTC),
        "items": ["2.02", "9.01"],
        "documentType": "EX-99.1",
        "filename": "ex99d1.htm",
        "extractionStatus": "PENDING",
        "source": "SEC_EDGAR",
        "parserVersion": "test",
    }
    row.update(overrides)
    return row


def _parsed_statement(**overrides: Any) -> dict[str, Any]:
    """A ``us_fundamentals`` row as the per-filing parse emits one — no timestamps.

    ``mappingSource`` is FILING_XBRL, the STRONGEST rank, so the
    :class:`AuthorityGuard` lets every write through and the test measures the
    timestamp behaviour rather than a suppression.
    """
    row: dict[str, Any] = {
        "cik10": "0000320193",
        "accession": "0000320193-25-000079",
        "statementType": STATEMENT_INCOME,
        "periodType": "ANNUAL",
        "periodEnd": datetime(2025, 9, 27, tzinfo=UTC),
        "form": "10-K",
        "filedAt": datetime(2025, 10, 31, tzinfo=UTC),
        "standardized": {"Revenue": 416161000000.0},
        "mappingSource": MAPPING_FILING_XBRL,
        "source": "SEC_EDGAR",
        "parserVersion": "test",
        "currency": "USD",
        "isAmendment": False,
        "isLatest": True,
    }
    row.update(overrides)
    return row


_DOCUMENT_KEY = ("accession", "sequence")
_STATEMENT_KEY = ("cik10", "statementType", "periodType", "periodEnd", "accession")


def test_a_writer_stamped_updated_at_is_stored_and_then_never_moves(
    db: FakeDatabase, clock: _Clock
) -> None:
    """The P2032 fix and the idempotence contract, in one row, at once.

    The field must be PRESENT (absent is what made every Prisma read of these
    rows throw), and it must not be rewritten by a run that learned nothing —
    routing the fill through `$setOnInsert` is what satisfies both.
    """
    writer = writers.MongoRowWriter(db)
    writer.upsert_rows("filing_documents", [_parsed_document()], key=_DOCUMENT_KEY)
    stored = db["us_filing_documents"].find_one({"sequence": 2})
    assert stored is not None
    assert stored["updatedAt"] == FIRST_RUN, "the writer did not stamp updatedAt at all"
    assert stored["ingestedAt"] == FIRST_RUN

    clock.now = SECOND_RUN
    writer.upsert_rows("filing_documents", [_parsed_document()], key=_DOCUMENT_KEY)
    stored = db["us_filing_documents"].find_one({"sequence": 2})
    assert stored is not None
    assert stored["updatedAt"] == FIRST_RUN, (
        "a writer-invented updatedAt reached $set, so a re-parse that learned "
        "nothing rewrote it — and rewrote every row it touched"
    )
    assert stored["ingestedAt"] == FIRST_RUN


def test_a_reparse_of_an_unchanged_dict_row_reports_written_zero(
    db: FakeDatabase, clock: _Clock
) -> None:
    """The contract `MongoRowWriter.upsert_rows` states in its own comment.

    "A re-parse that changes nothing matches every row and modifies none, and
    reporting that as 'wrote N' would make an idempotent no-op indistinguishable
    from real work — the number a zero-write monitor reads." With a fresh
    timestamp in `$set` that sentence was false for every parser row, and
    `EDGAR_PARSE_APPLY=true` ships ARMED on prod.
    """
    writer = writers.MongoRowWriter(db)
    first = writer.upsert_rows("filing_documents", [_parsed_document()], key=_DOCUMENT_KEY)
    clock.now = SECOND_RUN
    second = writer.upsert_rows("filing_documents", [_parsed_document()], key=_DOCUMENT_KEY)
    assert first == 1, "the first write must count as one written row"
    assert second == 0, (
        "an identical re-parse reported a write; a zero-write monitor can no "
        "longer distinguish a converged run from real work"
    )


def test_a_changed_dict_row_still_reports_a_write(db: FakeDatabase, clock: _Clock) -> None:
    """The other half of the signal, and the reason `second == 0` is not vacuous.

    A test that only asserts zero is satisfied by a writer that reports zero
    always — including one that stopped writing.
    """
    writer = writers.MongoRowWriter(db)
    writer.upsert_rows("filing_documents", [_parsed_document()], key=_DOCUMENT_KEY)
    clock.now = SECOND_RUN
    changed = writer.upsert_rows(
        "filing_documents",
        [_parsed_document(extractionStatus="EXTRACTED")],
        key=_DOCUMENT_KEY,
    )
    assert changed == 1
    stored = db["us_filing_documents"].find_one({"sequence": 2})
    assert stored is not None
    assert stored["extractionStatus"] == "EXTRACTED"


def test_a_dict_row_that_owns_its_updated_at_still_has_it_refreshed(
    db: FakeDatabase, clock: _Clock
) -> None:
    """The CONTROL: the fix must not freeze the field for callers that declare it.

    `app/bulk/*` and `app/jobs/*` build typed rows with an explicit
    `updatedAt=stamp` and MEAN it to move — that is Prisma's `@updatedAt`
    semantics, and a cursor row frozen at its first insert stops answering "when
    did this job last run". So `updatedAt` must stay OUT of
    `INSERT_ONLY_ALWAYS`; only the value the writer invented is insert-only.
    """
    writer = writers.MongoRowWriter(db)
    writer.upsert_rows(
        "filing_documents", [_parsed_document(updatedAt=FIRST_RUN)], key=_DOCUMENT_KEY
    )
    written = writer.upsert_rows(
        "filing_documents",
        [_parsed_document(updatedAt=SECOND_RUN, extractionStatus="EXTRACTED")],
        key=_DOCUMENT_KEY,
    )
    stored = db["us_filing_documents"].find_one({"sequence": 2})
    assert stored is not None
    assert stored["updatedAt"] == SECOND_RUN, (
        "a declared updatedAt was routed to $setOnInsert and ignored — "
        "updatedAt must not be in INSERT_ONLY_ALWAYS unconditionally"
    )
    assert written == 1


def test_the_guarded_path_stamps_updated_at_once_and_reports_written_zero_on_a_reparse(
    db: FakeDatabase, clock: _Clock
) -> None:
    """`us_fundamentals` builds its `$set` in a SECOND place — `_bulk_upsert_guarded`.

    A `WritePolicy` with an `authority` routes the whole write down that path,
    which assembles `setter` on its own line. The first version of the
    MONEY-1317 fix survived the suite on this path for exactly that reason, so
    the timestamp behaviour is asserted here separately rather than inferred
    from `bulk_upsert`. This is also the collection that matters most: it has a
    live reader (`getStatements`).
    """
    writer = writers.MongoRowWriter(db)
    first = writer.upsert_rows("fundamentals", [_parsed_statement()], key=_STATEMENT_KEY)
    stored = db["us_fundamentals"].find_one({"accession": "0000320193-25-000079"})
    assert stored is not None
    assert stored["updatedAt"] == FIRST_RUN

    clock.now = SECOND_RUN
    second = writer.upsert_rows("fundamentals", [_parsed_statement()], key=_STATEMENT_KEY)
    stored = db["us_fundamentals"].find_one({"accession": "0000320193-25-000079"})
    assert stored is not None
    assert stored["updatedAt"] == FIRST_RUN, "the guarded $set refreshed a timestamp it invented"
    assert first == 1
    assert second == 0, "an unchanged re-parse of a statement reported a write"


def test_the_guarded_path_still_refreshes_an_updated_at_the_row_declares(
    db: FakeDatabase, clock: _Clock
) -> None:
    """The guarded path's control — same reasoning as the unguarded one."""
    writer = writers.MongoRowWriter(db)
    writer.upsert_rows("fundamentals", [_parsed_statement(updatedAt=FIRST_RUN)], key=_STATEMENT_KEY)
    written = writer.upsert_rows(
        "fundamentals",
        [_parsed_statement(updatedAt=SECOND_RUN, currency="EUR")],
        key=_STATEMENT_KEY,
    )
    stored = db["us_fundamentals"].find_one({"accession": "0000320193-25-000079"})
    assert stored is not None
    assert stored["updatedAt"] == SECOND_RUN
    assert stored["currency"] == "EUR"
    assert written == 1
