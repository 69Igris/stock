"""``companyfacts.zip`` -> cold shards + hot facts + fallback statements — MONEY-979.

Every derivation assertion is driven from the REAL committed fixtures. The two
that matter most are opposites on purpose: Apple has seventeen fiscal years and a
September year end, CoreWeave has ONE fiscal year and a December one — the
short-history filer that decision 5 exists for.
"""

from __future__ import annotations

import gzip
import json
from datetime import date, datetime
from typing import Any

import pytest

from app.bulk import companyfacts
from app.bulk.common import (
    STATUS_COMPLETED,
    STATUS_NOT_YET_PUBLISHED,
    STATUS_WRITE_DISARMED,
    CheckpointEntry,
    load_checkpoints,
    open_zip_archive,
    sha256_hex,
    write_checkpoints,
    zip_from_bytes,
)
from app.sec import archive
from app.sec.adapter_types import CompanyFactSeries, CompanyFactValue
from app.sec.archive_logic import decode_shard, facts_shard_key
from app.sec.edgar_adapter import (
    _bson_safe_val,
    facts_from_companyfacts_json,
    fiscal_years_with_annual_report,
)
from app.store import writers
from app.store.models import (
    MAPPING_COMPANYFACTS,
    MAPPING_FILING_XBRL,
    UsFundamentalsRow,
)

from .test_bulk_common import (
    FIXTURES,
    FakeSecClient,
    counting_opener,
    fixture_bytes,
    make_zip,
    open_and_list_reads,
    record_member_reads,
)
from .test_store_writers import FakeDatabase

AAPL_CIK = "0000320193"
CORE_CIK = "0001769628"
MALFORMED = b'{"cik": "0000000009", "facts": '


@pytest.fixture
def db() -> FakeDatabase:
    writers.reset_index_cache()
    return FakeDatabase()


@pytest.fixture
def gcs(monkeypatch: pytest.MonkeyPatch) -> dict[str, bytes]:
    """An in-memory bucket. The REAL shard codec still runs on top of it."""
    store: dict[str, bytes] = {}

    def read_bytes(key: str) -> bytes | None:
        return store.get(key)

    def write_bytes(key: str, data: bytes, *, content_type: str) -> None:
        assert content_type == "application/gzip"
        store[key] = data

    monkeypatch.setattr(archive, "read_bytes", read_bytes)
    monkeypatch.setattr(archive, "write_bytes", write_bytes)
    return store


def load_series(name: str) -> list[CompanyFactSeries]:
    return facts_from_companyfacts_json(json.loads(fixture_bytes(name)))


def minimal_member(cik: str) -> bytes:
    return json.dumps(
        {
            "cik": cik,
            "entityName": "Tiny Co",
            "facts": {
                "us-gaap": {
                    "Assets": {
                        "label": "Assets",
                        "units": {
                            "USD": [
                                {
                                    "end": "2024-12-31",
                                    "val": 1,
                                    "accn": "0000000011-25-000001",
                                    "fy": 2024,
                                    "fp": "FY",
                                    "form": "10-K",
                                    "filed": "2025-02-01",
                                }
                            ]
                        },
                    }
                }
            },
        }
    ).encode()


def build_archive(*, extra: dict[str, bytes] | None = None) -> dict[str, bytes]:
    members = {
        f"CIK{CORE_CIK}.json": fixture_bytes("companyfacts_coreweave.json.gz"),
        "CIK0000000011.json": minimal_member("0000000011"),
        "CIK0000000009.json": MALFORMED,
    }
    members.update(extra or {})
    return members


def run_job(db: FakeDatabase, members: dict[str, bytes], **kwargs: Any) -> Any:
    return companyfacts.run(
        db=db,
        client=FakeSecClient(),
        opener=zip_from_bytes(make_zip(members)),
        archive_key="edgar/bulk/companyfacts/2026-08-29/companyfacts.zip",
        apply_writes=kwargs.pop("apply_writes", True),
        **kwargs,
    )


def _value(**kwargs: Any) -> CompanyFactValue:
    base: dict[str, Any] = {
        "end": date(2024, 12, 31),
        "val": 1.0,
        "accn": "0000000011-25-000001",
        "fy": 2024,
        "fp": "FY",
        "form": "10-K",
        "filed": date(2025, 2, 1),
        "start": None,
        "frame": None,
    }
    base.update(kwargs)
    return CompanyFactValue(**base)


# ── Period derivation ───────────────────────────────────────────────────────


def test_fiscal_year_end_month_is_derived_from_the_filers_own_annual_durations() -> None:
    assert companyfacts.fiscal_year_end_month(load_series("companyfacts_aapl.json.gz")) == 9
    assert companyfacts.fiscal_year_end_month(load_series("companyfacts_coreweave.json.gz")) == 12


def test_a_filer_with_no_annual_duration_yields_no_fiscal_year_end() -> None:
    series = [
        CompanyFactSeries(
            cik10=CORE_CIK,
            taxonomy="us-gaap",
            concept="Assets",
            unit="USD",
            label="Assets",
            description=None,
            values=(_value(),),
        )
    ]
    assert companyfacts.fiscal_year_end_month(series) is None


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        # A fiscal YEAR, including a 52/53-week one.
        (date(2023, 10, 1), date(2024, 9, 28), ("ANNUAL", "FY")),
        (date(2023, 9, 25), date(2024, 9, 28), ("ANNUAL", "FY")),
        # A fiscal QUARTER, labelled from its distance to the September year end.
        (date(2023, 10, 1), date(2023, 12, 30), ("QUARTERLY", "Q1")),
        (date(2023, 12, 31), date(2024, 3, 30), ("QUARTERLY", "Q2")),
        (date(2024, 3, 31), date(2024, 6, 29), ("QUARTERLY", "Q3")),
        (date(2024, 6, 30), date(2024, 9, 28), ("QUARTERLY", "Q4")),
        # SIX and NINE month YTD durations: a 10-Q reports these beside the
        # quarter, and storing them as Q2/Q3 makes every growth rate wrong.
        (date(2023, 10, 1), date(2024, 3, 30), None),
        (date(2023, 10, 1), date(2024, 6, 29), None),
        # A stub period from an IPO or a fiscal-year change.
        (date(2024, 1, 1), date(2024, 2, 15), None),
    ],
)
def test_classify_period_duration_table(
    start: date, end: date, expected: tuple[str, str] | None
) -> None:
    assert (
        companyfacts.classify_period(_value(start=start, end=end), fiscal_end_month=9) == expected
    )


@pytest.mark.parametrize(
    ("end", "expected"),
    [
        # An INSTANT — every balance-sheet fact. The year-end instant IS the
        # annual balance sheet; there is no separate "Q4 balance sheet".
        (date(2024, 9, 28), ("ANNUAL", "FY")),
        (date(2023, 12, 30), ("QUARTERLY", "Q1")),
        (date(2024, 3, 30), ("QUARTERLY", "Q2")),
        (date(2024, 6, 29), ("QUARTERLY", "Q3")),
        # A cover-page date that is not a period boundary at all.
        (date(2024, 8, 1), None),
    ],
)
def test_classify_period_instant_table(end: date, expected: tuple[str, str] | None) -> None:
    assert companyfacts.classify_period(_value(end=end), fiscal_end_month=9) == expected


def test_nothing_is_classified_when_the_fiscal_calendar_is_unknown() -> None:
    assert companyfacts.classify_period(_value(), fiscal_end_month=None) is None
    # ... except an annual DURATION, whose own span is the evidence.
    assert companyfacts.classify_period(
        _value(start=date(2023, 1, 1), end=date(2023, 12, 31)), fiscal_end_month=None
    ) == ("ANNUAL", "FY")


def test_the_period_never_comes_from_secs_own_fy_and_fp() -> None:
    """The measured trap, asserted on the real AAPL fixture.

    ``{"end": "2008-09-27", "fy": 2009, "fp": "Q3", "form": "10-Q"}`` is Apple's
    2008 fiscal-YEAR-end balance, carried as a comparative inside a 2009 Q3
    10-Q. Anything that read ``fp`` would file it as Q3 2009.
    """
    payload = json.loads(fixture_bytes("companyfacts_aapl.json.gz"))
    entries = payload["facts"]["us-gaap"]["AccountsPayable"]["units"]["USD"]
    trap = next(e for e in entries if e["end"] == "2008-09-27" and e["fp"] == "Q3")
    assert trap["fy"] == 2009 and trap["form"] == "10-Q"

    rows, _ = companyfacts.derive_fundamentals_rows(
        load_series("companyfacts_aapl.json.gz"), cik10=AAPL_CIK, symbol="AAPL"
    )
    same_accession = [
        r for r in rows if r.accession == trap["accn"] and r.periodEnd == date(2008, 9, 27)
    ]
    assert same_accession, "the 2008 year-end period must be stored under its OWN period"
    for row in same_accession:
        assert row.periodType == "ANNUAL"
        assert row.fiscalPeriod == "FY"
        assert row.fiscalYear == 2008


def test_derived_rows_are_marked_companyfacts_and_carry_provenance() -> None:
    rows, counters = companyfacts.derive_fundamentals_rows(
        load_series("companyfacts_coreweave.json.gz"), cik10=CORE_CIK, symbol="CRWV"
    )
    assert rows
    assert counters["factsSkipped"] > 0, "what could NOT be derived must be counted"
    for row in rows:
        assert row.mappingSource == MAPPING_COMPANYFACTS
        assert row.mappingVersion == companyfacts.MAPPING_VERSION
        assert row.parserVersion
        assert row.currency == "USD"
        assert row.symbol == "CRWV"
        assert len(row.standardized) >= companyfacts.MIN_CONCEPTS_PER_STATEMENT
        assert row.form in companyfacts.FINANCIAL_FORMS


def test_a_fragment_of_a_statement_is_dropped_rather_than_stored_as_one() -> None:
    series = [
        CompanyFactSeries(
            cik10=CORE_CIK,
            taxonomy="us-gaap",
            concept="Assets",
            unit="USD",
            label="Assets",
            description=None,
            values=(
                _value(start=date(2024, 1, 1), end=date(2024, 12, 31)),
                _value(end=date(2024, 12, 31)),
            ),
        )
    ]
    rows, counters = companyfacts.derive_fundamentals_rows(series, cik10=CORE_CIK)
    assert rows == []
    assert counters["groupsDropped"] >= 1


def test_facts_from_a_non_financial_form_never_become_a_statement() -> None:
    series = load_series("companyfacts_coreweave.json.gz")
    forms = {v.form for entry in series for v in entry.values}
    assert "DEF 14A" in forms, "the fixture must actually contain a non-financial form"
    rows, _ = companyfacts.derive_fundamentals_rows(series, cik10=CORE_CIK)
    assert all(row.form != "DEF 14A" for row in rows)


# ── The cold shard ──────────────────────────────────────────────────────────


def test_the_cold_shard_keeps_frame_and_every_taxonomy() -> None:
    series = load_series("companyfacts_aapl.json.gz")
    rows = companyfacts.shard_rows(series)
    assert set(rows) == {"us-gaap", "dei"}
    framed = sum(1 for taxonomy in rows.values() for row in taxonomy if "frame" in row)
    # Measured on this exact fixture. `frame` is SEC's own de-duplication signal
    # and edgartools' parser drops it; losing it costs a 1.31 GiB re-download.
    assert framed == 9802


def test_a_shard_round_trips_through_the_real_codec_with_frame_intact(
    gcs: dict[str, bytes],
) -> None:
    series = load_series("companyfacts_coreweave.json.gz")
    taxonomy_rows = companyfacts.shard_rows(series)["us-gaap"]
    key = facts_shard_key(CORE_CIK, "us-gaap")
    outcome = archive.merge_and_write_shard(key, taxonomy_rows, companyfacts.shard_row_key)
    assert outcome["merged"] == len(taxonomy_rows)

    decoded = decode_shard(gcs[key])
    assert decoded.dropped == 0
    assert len(decoded.rows) == len(taxonomy_rows)
    framed_in = {r["frame"] for r in taxonomy_rows if r.get("frame")}
    framed_out = {r["frame"] for r in decoded.rows if r.get("frame")}
    assert framed_in and framed_out == framed_in


def test_a_second_shard_write_merges_rather_than_replacing(gcs: dict[str, bytes]) -> None:
    key = facts_shard_key(CORE_CIK, "us-gaap")
    first = [
        {
            "concept": "Assets",
            "unit": "USD",
            "end": "2024-12-31",
            "val": 1,
            "accn": "a",
            "form": "10-K",
            "filed": "2025-02-01",
        }
    ]
    second = [
        {
            "concept": "Liabilities",
            "unit": "USD",
            "end": "2024-12-31",
            "val": 2,
            "accn": "a",
            "form": "10-K",
            "filed": "2025-02-01",
        }
    ]
    archive.merge_and_write_shard(key, first, companyfacts.shard_row_key)
    outcome = archive.merge_and_write_shard(key, second, companyfacts.shard_row_key)
    assert outcome["existing"] == 1
    assert outcome["merged"] == 2


def test_a_corrected_value_replaces_its_line_because_val_is_not_in_the_key() -> None:
    row = {
        "concept": "Assets",
        "unit": "USD",
        "end": "2024-12-31",
        "val": 1,
        "accn": "a",
        "form": "10-K",
        "filed": "2025-02-01",
    }
    corrected = {**row, "val": 2}
    assert companyfacts.shard_row_key(row) == companyfacts.shard_row_key(corrected)


def test_shard_row_keys_are_unique_across_a_whole_real_filer() -> None:
    for name in ("companyfacts_aapl.json.gz", "companyfacts_coreweave.json.gz"):
        rows = companyfacts.shard_rows(load_series(name))
        for taxonomy, taxonomy_rows in rows.items():
            keys = {companyfacts.shard_row_key(row) for row in taxonomy_rows}
            assert len(keys) == len(taxonomy_rows), f"{name}/{taxonomy} collapses rows"


# ── The hot subset ──────────────────────────────────────────────────────────


def test_the_hot_subset_is_exactly_the_statement_concepts_plus_the_dei_counters() -> None:
    assert companyfacts.is_hot_concept("us-gaap", "Assets")
    assert companyfacts.is_hot_concept("dei", "EntityCommonStockSharesOutstanding")
    assert companyfacts.is_hot_concept("dei", "EntityPublicFloat")
    assert not companyfacts.is_hot_concept("dei", "DocumentType")
    assert not companyfacts.is_hot_concept("ecd", "Assets")
    assert not companyfacts.is_hot_concept("us-gaap", "SomeCompanyExtensionConcept")


def test_hot_rows_carry_the_whole_series_ascending_by_end_then_filed() -> None:
    rows = companyfacts.build_company_fact_rows(load_series("companyfacts_aapl.json.gz"))
    assets = next(r for r in rows if r.concept == "Assets" and r.unit == "USD")
    order = [(v["end"], v["filed"]) for v in assets.values]
    assert order == sorted(order)
    assert assets.lastFiledAt == max(date.fromisoformat(v["filed"]) for v in assets.values)
    assert any("frame" in v for v in assets.values)


def test_a_value_entry_omits_the_keys_sec_did_not_publish() -> None:
    rows = companyfacts.build_company_fact_rows(
        [
            CompanyFactSeries(
                cik10=CORE_CIK,
                taxonomy="us-gaap",
                concept="Assets",
                unit="USD",
                label=None,
                description=None,
                values=(_value(fy=None, fp=None, frame=None),),
            )
        ]
    )
    entry = rows[0].values[0]
    assert set(entry) == {"end", "val", "accn", "form", "filed"}


# ── Coverage ────────────────────────────────────────────────────────────────


def test_the_short_history_filer_yields_exactly_the_years_it_has_and_is_ineligible(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    series = load_series("companyfacts_coreweave.json.gz")
    assert fiscal_years_with_annual_report(series) == {2025}

    run_job(db, build_archive())
    filer = db["us_filers"].find_one({"cik10": CORE_CIK})
    assert filer is not None
    assert filer["fiscalYearsOnFile"] == 1
    assert filer["eligibleForCoverage"] is False
    assert filer["name"] == "CoreWeave, Inc."


def test_a_seventeen_year_filer_is_eligible(db: FakeDatabase, gcs: dict[str, bytes]) -> None:
    run_job(db, {f"CIK{AAPL_CIK}.json": fixture_bytes("companyfacts_aapl.json.gz")})
    filer = db["us_filers"].find_one({"cik10": AAPL_CIK})
    assert filer is not None
    assert filer["fiscalYearsOnFile"] == 17
    assert filer["eligibleForCoverage"] is True


# ── The run ─────────────────────────────────────────────────────────────────


def test_a_full_pass_writes_all_three_legs(db: FakeDatabase, gcs: dict[str, bytes]) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": CORE_CIK,
            "symbol": "CRWV",
            "assetType": "Stock",
            "listingStatus": "ACTIVE",
        }
    )
    result = run_job(db, build_archive())
    assert result.status == STATUS_COMPLETED
    assert result.exit_code == 0
    # (a) cold shards, one per taxonomy
    assert facts_shard_key(CORE_CIK, "us-gaap") in gcs
    assert facts_shard_key(CORE_CIK, "ecd") in gcs
    # (b) hot subset
    assert db["us_company_facts"].count_documents({"cik10": CORE_CIK}) > 0
    # (c) fallback statements, for the in-universe filer only
    assert db["us_fundamentals"].count_documents({"cik10": CORE_CIK}) > 0
    assert db["us_fundamentals"].count_documents({"cik10": "0000000011"}) == 0
    assert db["us_company_facts"].count_documents({"cik10": "0000000011"}) == 1


def test_exactly_one_derived_row_per_period_group_is_latest(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": CORE_CIK,
            "symbol": "CRWV",
            "assetType": "Stock",
            "listingStatus": "ACTIVE",
        }
    )
    run_job(db, build_archive())
    groups: dict[tuple[Any, ...], int] = {}
    for row in db["us_fundamentals"].find({"cik10": CORE_CIK}):
        if row.get("isLatest"):
            key = (row["statementType"], row["periodType"], row["periodEnd"])
            groups[key] = groups.get(key, 0) + 1
    assert groups
    assert set(groups.values()) == {1}


def test_a_filing_xbrl_row_displaces_a_derived_one_for_the_same_period(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": CORE_CIK,
            "symbol": "CRWV",
            "assetType": "Stock",
            "listingStatus": "ACTIVE",
        }
    )
    run_job(db, build_archive())
    derived = next(r for r in db["us_fundamentals"].find({"cik10": CORE_CIK}) if r.get("isLatest"))
    period_end = derived["periodEnd"]

    # T7's per-filing parse lands LATER in wall-clock terms but is filed EARLIER.
    writers.upsert_fundamentals(
        db,
        [
            UsFundamentalsRow(
                cik10=CORE_CIK,
                statementType=derived["statementType"],
                periodType=derived["periodType"],
                periodEnd=period_end,
                fiscalYear=period_end.year,
                fiscalPeriod=derived["fiscalPeriod"],
                accession="0001769628-00-000001",
                form="10-K",
                filedAt=date(2000, 1, 1),
                mappingSource=MAPPING_FILING_XBRL,
                mappingVersion="filing/1",
                parserVersion="test",
                standardized={"Assets": 1.0},
            )
        ],
    )
    writers.recompute_is_latest(
        db, CORE_CIK, derived["statementType"], derived["periodType"], period_end
    )
    winners = [
        row["accession"]
        for row in db["us_fundamentals"].find(
            {"cik10": CORE_CIK, "statementType": derived["statementType"], "periodEnd": period_end}
        )
        if row.get("isLatest")
    ]
    assert winners == ["0001769628-00-000001"]


def test_a_malformed_member_is_counted_and_the_batch_continues(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    result = run_job(db, build_archive())
    assert result.counters["filersSkipped"] == 1
    assert result.failed >= 1
    assert db["us_company_facts"].count_documents({"cik10": CORE_CIK}) > 0
    assert "0000000009" not in load_checkpoints(db, "edgar-companyfacts")


def test_an_unchanged_member_is_skipped(db: FakeDatabase, gcs: dict[str, bytes]) -> None:
    members = build_archive()
    write_checkpoints(
        db,
        "edgar-companyfacts",
        [CheckpointEntry(item_key="0000000011", detail=sha256_hex(members["CIK0000000011.json"]))],
    )
    result = run_job(db, members)
    assert result.counters["membersSkipped"] == 1
    assert db["us_company_facts"].count_documents({"cik10": "0000000011"}) == 0
    assert result.selected == 2


def test_the_run_is_idempotent(db: FakeDatabase, gcs: dict[str, bytes]) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": CORE_CIK,
            "symbol": "CRWV",
            "assetType": "Stock",
            "listingStatus": "ACTIVE",
        }
    )
    members = build_archive()
    run_job(db, members)
    before = {name: collection.count_documents({}) for name, collection in db.collections.items()}
    shard_bytes = dict(gcs)
    second = run_job(db, members, force=True)
    after = {name: collection.count_documents({}) for name, collection in db.collections.items()}
    assert after == before
    assert gcs == shard_bytes, "a re-write of identical rows must produce identical bytes"
    assert second.counters["membersSkipped"] == 2
    assert second.selected == 1  # the malformed member is retried, never checkpointed DONE


def test_not_yet_published_is_distinguishable_from_both_success_and_failure(
    db: FakeDatabase,
) -> None:
    from app.store.models import UsEdgarCursorRow

    writers.upsert_cursor(db, UsEdgarCursorRow(key="bulk:companyfacts", meta={"etag": '"abc"'}))
    result = companyfacts.run(
        db=db,
        client=FakeSecClient(),
        opener=zip_from_bytes(make_zip(build_archive())),
        archive_key="k",
        apply_writes=True,
    )
    assert result.status == STATUS_NOT_YET_PUBLISHED
    assert result.skipped_reason == STATUS_NOT_YET_PUBLISHED
    assert result.exit_code == 0
    assert result.status != STATUS_COMPLETED
    assert db["us_company_facts"].count_documents({}) == 0


def test_a_disarmed_run_writes_no_shard_no_row_and_no_checkpoint(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    result = run_job(db, build_archive(), apply_writes=False)
    assert result.status == STATUS_WRITE_DISARMED
    assert result.written == 0
    assert gcs == {}
    assert db["us_company_facts"].count_documents({}) == 0
    assert load_checkpoints(db, "edgar-companyfacts") == {}
    assert writers.read_cursor(db, "bulk:companyfacts") is None


def test_a_completed_run_stamps_the_watermark_with_the_mapping_version(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    run_job(db, build_archive())
    cursor = writers.read_cursor(db, "bulk:companyfacts")
    assert cursor is not None
    assert cursor["meta"]["etag"] == '"abc"'
    assert cursor["meta"]["mappingVersion"] == companyfacts.MAPPING_VERSION
    assert isinstance(cursor["lastRunAt"], datetime)


def test_the_measured_numbers_above_are_about_the_committed_fixtures() -> None:
    # The framed-value count and the 17-vs-1 fiscal years are facts about SPECIFIC
    # bytes. A regenerated fixture would keep every assertion green while making
    # the numbers describe data nobody has seen, so the manifest's sha256 is
    # checked against the file on disk.
    import hashlib

    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    for entry_key in ("companyfacts_aapl", "companyfacts_short_history"):
        entry = manifest[entry_key]
        with gzip.open(FIXTURES / entry["file"]) as handle:
            raw = handle.read()
        assert hashlib.sha256(raw).hexdigest() == entry["sha256"], entry["file"]
        assert len(raw) == entry["bytes"]


def test_an_instant_and_a_duration_under_one_accession_do_not_crash_the_member() -> None:
    # Regression: the group key mixed None and str, so `sorted` raised TypeError
    # and the whole filer was skipped for one oddly tagged fact.
    series = [
        CompanyFactSeries(
            cik10=CORE_CIK,
            taxonomy="us-gaap",
            concept="Assets",
            unit="USD",
            label="Assets",
            description=None,
            values=(
                _value(start=date(2024, 1, 1), end=date(2024, 12, 31)),
                _value(end=date(2024, 12, 31)),
            ),
        ),
        CompanyFactSeries(
            cik10=CORE_CIK,
            taxonomy="us-gaap",
            concept="Liabilities",
            unit="USD",
            label="Liabilities",
            description=None,
            values=(
                _value(start=date(2024, 1, 1), end=date(2024, 12, 31)),
                _value(end=date(2024, 12, 31)),
            ),
        ),
        CompanyFactSeries(
            cik10=CORE_CIK,
            taxonomy="us-gaap",
            concept="Goodwill",
            unit="USD",
            label="Goodwill",
            description=None,
            values=(
                _value(start=date(2024, 1, 1), end=date(2024, 12, 31)),
                _value(end=date(2024, 12, 31)),
            ),
        ),
    ]
    rows, _ = companyfacts.derive_fundamentals_rows(series, cik10=CORE_CIK)
    assert {(row.periodType, row.periodStart) for row in rows} == {
        ("ANNUAL", date(2024, 1, 1)),
        ("ANNUAL", None),
    }


# ── MONEY-1284: one filer's `val` must not be able to end the walk ──────────
#
# The first production companyfacts run died at 09:52Z on 2026-08-30 with
# `OverflowError: MongoDB can only handle up to 8-byte ints`, having banked
# 4,500 of 20,290 members. Two separate defects, and the second is the one that
# turned a bad value into an outage:
#
#   1. SEC ships `val` AS FILED and some filers file a number that does not fit
#      in eight bytes. `_value_doc` puts it straight into a Prisma `Json`
#      column, so pymongo raises.
#   2. The per-member `try` covered only `json_loads` + parse. `_write_member`
#      sat OUTSIDE it, so the raise escaped the loop. Every retry then died at
#      the same CIK, because the walk is deterministic.
#
# Both are tested here. The containment test matters more than the sanitiser
# test: the sanitiser fixes the value we have SEEN, the containment bounds the
# cost of the one we have not.


def _huge_val_member(cik: str, val: int) -> bytes:
    """A member whose only fact carries an integer beyond BSON's int64 range."""
    return json.dumps(
        {
            "cik": cik,
            "entityName": "Overflow Co",
            "facts": {
                "us-gaap": {
                    "Assets": {
                        "label": "Assets",
                        "units": {
                            "USD": [
                                {
                                    "end": "2024-12-31",
                                    "val": val,
                                    "accn": "0000000012-25-000001",
                                    "fy": 2024,
                                    "fp": "FY",
                                    "form": "10-K",
                                    "filed": "2025-02-01",
                                }
                            ]
                        },
                    }
                }
            },
        }
    ).encode()


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (12345, 12345),  # in range, untouched
        (2**63 - 1, 2**63 - 1),  # the ceiling itself is fine
        (2**63, float(2**63)),  # one past it becomes a float
        (10**19, float(10**19)),  # the shape SEC actually filed
        (-(2**63), -(2**63)),  # the floor is fine
        (-(2**63) - 1, float(-(2**63) - 1)),
        (1.5, 1.5),  # ordinary float untouched
        ("n/a", "n/a"),  # SEC's string vals pass through
        (True, True),  # bool is an int in Python; must not become 1.0
    ],
)
def test_bson_safe_val_table(value: object, expected: object) -> None:
    result = _bson_safe_val(value)
    assert result == expected
    assert type(result) is type(expected)


def test_nan_and_infinity_are_not_values() -> None:
    # Matches `_float`, which already refuses NaN. The caller skips a None val,
    # so these drop out rather than being stored as a number that is not one.
    assert _bson_safe_val(float("nan")) is None
    assert _bson_safe_val(float("inf")) is None
    assert _bson_safe_val(float("-inf")) is None


def test_an_out_of_range_val_is_stored_rather_than_killing_the_run(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    members = build_archive(extra={"CIK0000000012.json": _huge_val_member("0000000012", 10**19)})

    result = run_job(db, members)

    assert result.status == STATUS_COMPLETED, "one absurd filing must not fail the walk"
    # WHAT THIS FIXTURE CANNOT SEE: `FakeDatabase` is an in-memory dict and does
    # not encode BSON, so it can never raise pymongo's OverflowError. Reverting
    # the sanitiser therefore reddens the type assertion below, NOT a raise —
    # the test pins the COERCION, which is the fix. The raise path is covered by
    # `test_a_write_that_raises_costs_ONE_filer_not_the_run`, which injects the
    # exception directly rather than hoping a fake reproduces it.
    # The offending filer is WRITTEN, not dropped: a reader seeing 1e19 learns
    # the filer filed 1e19, whereas a missing fact is indistinguishable from a
    # fact SEC never published.
    stored = db["us_company_facts"].documents
    row = next(r for r in stored if r.get("cik10") == "0000000012")
    value = row["values"][0]["val"] if isinstance(row.get("values"), list) else None
    assert isinstance(value, float), f"out-of-range int must be stored as a float, got {value!r}"
    assert value == float(10**19)
    assert "0000000012" in load_checkpoints(db, "edgar-companyfacts")
    # and the members after it in the walk still landed
    assert db["us_company_facts"].count_documents({"cik10": CORE_CIK}) > 0


def test_a_write_that_raises_costs_ONE_filer_not_the_run(
    db: FakeDatabase, gcs: dict[str, bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The containment, driven independently of the sanitiser: whatever SEC files
    # next, a write that throws must skip one member and continue.
    real = companyfacts._write_member

    def exploding(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("cik") == "0000000011":
            raise OverflowError("MongoDB can only handle up to 8-byte ints")
        return real(*args, **kwargs)

    monkeypatch.setattr(companyfacts, "_write_member", exploding)

    result = run_job(db, build_archive())

    assert result.status == STATUS_COMPLETED
    assert result.counters["filersSkipped"] >= 1
    # ERROR, never DONE — `load_checkpoints` returns DONE only, so the member is
    # retried on the next run instead of being silently skipped forever.
    assert "0000000011" not in load_checkpoints(db, "edgar-companyfacts")
    # the walk continued past it
    assert db["us_company_facts"].count_documents({"cik10": CORE_CIK}) > 0


# ── Resume cost — MONEY-1283 ────────────────────────────────────────────────
#
# `bulk-submissions` measured the defect and this job shares its exact shape:
# the member loop READ every member out of the archive and hashed it BEFORE it
# could tell the member was already finished. A member is decompressed straight
# out of a live GCS object, so each of those reads is a network round trip
# charged to the same RunBudget as real work — 1,691 skips/min on prod, which is
# a resume that costs O(members already done).
#
# These assertions COUNT READS, never elapsed time. The fixture archive is a few
# KB in RAM where the production one is 1.41 GB over the wire, so a timing
# assertion passes trivially here while production stays network-bound — the
# exact gap that let this file stay green through the whole defect. The count is
# the same number in both places.


def tiny_member(cik: str, revision: str) -> bytes:
    """`minimal_member` with a field that can be moved to change the member's CRC."""
    payload = json.loads(minimal_member(cik))
    payload["entityName"] = f"Tiny Co {revision}"
    return json.dumps(payload).encode()


def tiny_archive(count: int, *, changed: frozenset[int] = frozenset()) -> dict[str, bytes]:
    return {
        f"CIK{index:010d}.json": tiny_member(f"{index:010d}", "v2" if index in changed else "v1")
        for index in range(1, count + 1)
    }


def run_counting(db: FakeDatabase, members: dict[str, bytes], **kwargs: Any) -> tuple[Any, Any]:
    """`(result, stream)` — the run, and the tape of every read it made."""
    opener, stream = counting_opener(make_zip(members))
    result = companyfacts.run(
        db=db,
        client=FakeSecClient(),
        opener=opener,
        archive_key="edgar/bulk/companyfacts/2026-08-29/companyfacts.zip",
        apply_writes=kwargs.pop("apply_writes", True),
        **kwargs,
    )
    return result, stream


def test_a_resume_reads_only_the_members_that_are_not_already_checkpointed(
    db: FakeDatabase, gcs: dict[str, bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE load-bearing one. 90% already done must cost 10% of the reads.

    Two of twenty members changed between the runs, so exactly two may be
    decompressed. Before the fix the count was TWENTY — the loop hashed every
    member to discover eighteen of them were finished.

    Asserted by NAME, so a skip that read the WRONG members fails as loudly as
    one that read too many.
    """
    members = tiny_archive(20)
    first = run_counting(db, members)[0]
    assert first.selected == 20, "the first run has nothing to skip"

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, tiny_archive(20, changed=frozenset({3, 17})), force=True)

    assert reads == ["CIK0000000003.json", "CIK0000000017.json"]
    assert result.counters["membersSkipped"] == 18
    assert result.selected == 2


def test_a_fully_converged_resume_pulls_nothing_off_the_stream_after_opening_it(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    """The same claim one layer lower, against a MEASURED ceiling.

    `record_member_reads` counts calls to our own `ZipMember.read`; this counts
    reads on the STREAM, which is what actually costs a GCS request. The ceiling
    is re-derived from the same bytes by `open_and_list_reads` rather than
    written as a literal, so it cannot be a number that merely happens to match.
    """
    members = tiny_archive(12)
    body = make_zip(members)
    run_counting(db, members)

    result, stream = run_counting(db, members, force=True)

    assert result.counters["membersSkipped"] == 12
    assert result.selected == 0
    assert len(stream.reads) == open_and_list_reads(body), (
        "a converged run must spend reads on the central directory and nothing else"
    )


def test_a_legacy_checkpoint_with_no_stamp_is_read_once_and_then_upgraded_in_place(
    db: FakeDatabase, gcs: dict[str, bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every checkpoint on prod today has a digest and no stamp.

    The fix has to converge from that state with no migration and without ever
    trusting a field nothing wrote: the member is read once, its sha256 decides
    the skip exactly as before, and only then is the stamp recorded — so the
    SECOND run gets it free. `rows`/`bytes` belong to the run that did the work
    and must survive the upgrade.
    """
    members = tiny_archive(3)
    with open_zip_archive("k", opener=zip_from_bytes(make_zip(members))) as archive:
        expected_stamp = archive.member_stamp("CIK0000000001.json")

    write_checkpoints(
        db,
        "edgar-companyfacts",
        [
            CheckpointEntry(
                item_key="0000000001",
                detail=sha256_hex(members["CIK0000000001.json"]),
                rows=7,
                bytes=123,
            )
        ],
    )
    assert "stamp" not in db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, members)

    assert reads.count("CIK0000000001.json") == 1, "a legacy member is read exactly once"
    assert result.counters["membersSkipped"] == 1
    assert db["us_company_facts"].count_documents({"cik10": "0000000001"}) == 0

    upgraded = db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})
    assert upgraded["stamp"] == expected_stamp
    assert (upgraded["rows"], upgraded["bytes"]) == (7, 123)

    reads.clear()
    run_counting(db, members, force=True)
    assert "CIK0000000001.json" not in reads


def test_a_stamp_in_an_older_FORMAT_is_rewritten_rather_than_re_read_every_night(
    db: FakeDatabase, gcs: dict[str, bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stamp carries no version tag, so a format change must self-heal.

    Only true if the upgrade fires on a stamp that DISAGREES and not merely on
    one that is absent. Fire it on absence alone and a member whose digest still
    matches is read on every run for the rest of the job's life — the per-member
    network read MONEY-1283 removed, reintroduced by a future edit to the stamp
    format and invisible because nothing errors.

    Asserted separately in BOTH walkers on purpose: this branch is one rule
    written twice, and a fix applied to one copy is exactly how the two drift.
    """
    members = tiny_archive(2)
    with open_zip_archive("k", opener=zip_from_bytes(make_zip(members))) as archive:
        current = archive.member_stamp("CIK0000000001.json")

    write_checkpoints(
        db,
        "edgar-companyfacts",
        [
            CheckpointEntry(
                item_key="0000000001",
                detail=sha256_hex(members["CIK0000000001.json"]),
                stamp="v0/an-older-stamp-format",
            )
        ],
    )

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, members)

    assert reads.count("CIK0000000001.json") == 1
    assert result.counters["membersSkipped"] == 1
    assert db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})["stamp"] == current

    reads.clear()
    run_counting(db, members, force=True)
    assert "CIK0000000001.json" not in reads, "the stale format was rewritten, not re-read"


def test_a_member_whose_bytes_changed_is_read_and_reprocessed_never_skipped(
    db: FakeDatabase, gcs: dict[str, bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The stamp is a NEGATIVE filter only: it may defer work, never decide that
    # work is unnecessary.
    members = tiny_archive(2)
    run_counting(db, members)

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, tiny_archive(2, changed=frozenset({2})), force=True)

    assert reads == ["CIK0000000002.json"]
    assert result.selected == 1
    assert result.counters["membersSkipped"] == 1


def test_a_disarmed_run_upgrades_no_stamp_because_it_writes_nothing(
    db: FakeDatabase, gcs: dict[str, bytes]
) -> None:
    # `EDGAR_PARSE_APPLY=false` reads, parses and counts, and touches no row —
    # the legacy upgrade included. Stamping from a run that wrote nothing is the
    # same MONEY-1235 shape as checkpointing an unwritten member.
    members = tiny_archive(2)
    write_checkpoints(
        db,
        "edgar-companyfacts",
        [CheckpointEntry(item_key="0000000001", detail=sha256_hex(members["CIK0000000001.json"]))],
    )
    result, _ = run_counting(db, members, apply_writes=False)

    assert result.status == STATUS_WRITE_DISARMED
    assert "stamp" not in db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})
