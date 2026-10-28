"""10-K/10-Q/20-F/40-F -> ``us_fundamentals`` — MONEY-979 T7.

The fixture is Apple's real FY2025 10-K. Its numbers are HAND-VERIFIED against
the rendered statements inside the same bundle: the income statement prints
"Total net sales $ 416,161" and "Net income $ 112,010" in MILLIONS, and XBRL
reports whole dollars, so the expected values are those figures times 1e6.

Two things this file pins that a first-run snapshot would not:

* THE FALLBACK CHAINS. Apple tags revenue with ASC 606's
  ``RevenueFromContractWithCustomerExcludingAssessedTax`` — rank 0 — so the real
  filing only proves the chain AGREES. The links further down are driven with
  statement lines shaped like the filers that need them: a bank tagging only
  ``Revenues``, and a filer tagging only
  ``...OperatingActivitiesContinuingOperations``, which SEC issued a
  data-quality reminder about precisely because it is used as the total.
* SEGMENTS ARE NOT THE COMPANY. Apple's income statement carries fifteen
  dimensional revenue rows — iPhone, Mac, iPad, Services, the Americas, China.
  ``standardized`` must contain the 416,161,000,000 entity-wide figure and none
  of them; "iPhone revenue" landing in a field named ``Revenue`` is a
  whole-company number wrong by two thirds that looks entirely normal.
"""

from __future__ import annotations

import gzip
import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.parsers import financials_logic as logic
from app.parsers.dispatch import parse_and_store
from app.sec.adapter_types import StatementLine, StatementSet
from app.sec.edgar_adapter import statements_from_bundle

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_text(name: str) -> str:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


ACCESSION = "0000320193-25-000079"
CIK = "0000320193"
FILED = date(2025, 10, 31)

# Hand-verified against the 10-K's own rendered statements.
APPLE_REVENUE = 416_161_000_000.0
APPLE_NET_INCOME = 112_010_000_000.0
APPLE_GROSS_PROFIT = 195_201_000_000.0
APPLE_OPERATING_CASH_FLOW = 111_482_000_000.0


def apple_rows() -> tuple[list[dict], dict]:
    statements = statements_from_bundle(fixture_text("tenk_bundle_aapl"))
    assert statements is not None
    return logic.build_rows(
        statements,
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        symbol="AAPL",
        parser_version="test",
    )


def row_of(rows: list[dict], statement_type: str) -> dict:
    return next(row for row in rows if row["statementType"] == statement_type)


def line(
    concept: str,
    value: float | None,
    *,
    standard: str | None = None,
    label: str = "",
    dimensions: dict[str, str] | None = None,
    abstract: bool = False,
) -> StatementLine:
    return StatementLine(
        concept=concept,
        label=label or concept,
        standard_concept=standard,
        value=value,
        unit="usd",
        dimensions=dimensions or {},
        is_abstract=abstract,
    )


def statement_set(**kwargs) -> StatementSet:
    base = {
        "income": (),
        "balance": (),
        "cashflow": (),
        "equity": (),
        "period_start": date(2024, 1, 1),
        "period_end": date(2024, 12, 31),
        "fiscal_year": 2024,
        "fiscal_period": "FY",
    }
    base.update(kwargs)
    return StatementSet(**base)  # type: ignore[arg-type]


# ── the three statements ────────────────────────────────────────────────────


def test_apple_yields_three_rows_with_hand_verified_numbers() -> None:
    rows, report = apple_rows()
    assert [row["statementType"] for row in rows] == ["INCOME", "BALANCE_SHEET", "CASH_FLOW"]
    assert report["absent"] == []

    income = row_of(rows, "INCOME")["standardized"]
    assert income["Revenue"] == APPLE_REVENUE
    assert income["NetIncome"] == APPLE_NET_INCOME
    assert income["GrossProfit"] == APPLE_GROSS_PROFIT
    # Gross profit is revenue minus cost of sales, from the filing's own lines.
    assert income["Revenue"] - income["CostOfGoodsAndServicesSold"] == APPLE_GROSS_PROFIT

    cash = row_of(rows, "CASH_FLOW")["standardized"]
    assert cash["NetCashFromOperatingActivities"] == APPLE_OPERATING_CASH_FLOW


def test_the_period_is_annual_and_stamped_from_the_document_not_the_cover() -> None:
    """``document_period_end_date``, never ``reporting_end_date`` — on this
    filing the latter is 2025-10-17, the cover-page share-count date, five weeks
    after the fiscal year actually ended."""
    rows, _ = apple_rows()
    for row in rows:
        assert row["periodEnd"] == datetime(2025, 9, 27, tzinfo=UTC)
        assert row["periodStart"] == datetime(2024, 9, 29, tzinfo=UTC)
        assert row["fiscalYear"] == 2025
        assert row["fiscalPeriod"] == "FY"
        assert row["periodType"] == "ANNUAL"
        assert row["filedAt"] == datetime(2025, 10, 31, tzinfo=UTC)


@pytest.mark.parametrize(
    ("fiscal_period", "kind"),
    [
        ("FY", "ANNUAL"),
        ("Q1", "QUARTERLY"),
        ("Q4", "QUARTERLY"),
        ("", "QUARTERLY"),
        (None, "QUARTERLY"),
    ],
)
def test_period_type_is_annual_only_for_FY(fiscal_period: str | None, kind: str) -> None:
    assert logic.period_type(fiscal_period) == kind


def test_a_statement_the_filing_does_not_present_is_absent_not_empty() -> None:
    """A bank's 10-Q legitimately omits a statement. An empty row would claim we
    hold a statement consisting of nothing, which reads exactly like a parse
    that failed halfway."""
    rows, report = logic.build_rows(
        statement_set(income=(line("us-gaap_Revenues", 100.0, standard="Revenue"),)),
        accession=ACCESSION,
        cik10=CIK,
        form="10-Q",
        filed_at=FILED,
        parser_version="test",
    )
    assert [row["statementType"] for row in rows] == ["INCOME"]
    assert report["absent"] == ["BALANCE_SHEET", "CASH_FLOW"]


def test_equity_is_parsed_counted_and_deliberately_not_stored() -> None:
    """``statementType`` has three values. A fourth would put rows in a table
    whose own documentation says they cannot exist."""
    rows, report = apple_rows()
    assert report["equityLinesSkipped"] == 25
    assert "EQUITY" not in {row["statementType"] for row in rows}
    assert [name for name, _ in logic.STATEMENT_TYPES] == [
        "INCOME",
        "BALANCE_SHEET",
        "CASH_FLOW",
    ]


# ── segments ────────────────────────────────────────────────────────────────


def test_segments_stay_out_of_standardized_and_land_in_asReported() -> None:
    rows, _ = apple_rows()
    income = row_of(rows, "INCOME")
    assert income["standardized"]["Revenue"] == APPLE_REVENUE

    dimensional = [row for row in income["asReported"] if row.get("dimensions")]
    assert len(dimensional) >= 15
    iphone = [
        row
        for row in dimensional
        if row["dimensions"].get("srt:ProductOrServiceAxis") == "aapl_IPhoneMember"
    ]
    assert iphone and iphone[0]["value"] == 209_586_000_000.0
    # The segment breakdown exists ONLY here: `companyfacts.zip` carries no
    # dimensional facts at all.
    assert all(row["value"] != APPLE_REVENUE for row in dimensional)


def test_entity_wide_is_not_abstract_not_dimensional_and_has_a_value() -> None:
    assert logic.is_entity_wide(line("us-gaap_Revenues", 1.0, standard="Revenue")) is True
    assert logic.is_entity_wide(line("us-gaap_Revenues", None, standard="Revenue")) is False
    assert logic.is_entity_wide(line("us-gaap_X", 1.0, abstract=True)) is False
    assert (
        logic.is_entity_wide(line("us-gaap_Revenues", 1.0, dimensions={"axis": "member"})) is False
    )


def test_asReported_drops_scaffolding_and_omits_an_empty_dimensions_key() -> None:
    rows, _ = apple_rows()
    for row in rows:
        for entry in row["asReported"]:
            assert entry["value"] is not None
            assert "dimensions" not in entry or entry["dimensions"]
    # Abstract headers carry no value and are not stored.
    assert all(
        entry["concept"] != "us-gaap_OperatingExpensesAbstract"
        for entry in row_of(rows, "INCOME")["asReported"]
    )


# ── the fallback chains ─────────────────────────────────────────────────────


def test_the_chain_that_fired_is_named_on_the_real_filing() -> None:
    rows, _ = apple_rows()
    revenue = row_of(rows, "INCOME")["standardized"]["_fallbacks"]["Revenue"]
    assert revenue["concept"] == "RevenueFromContractWithCustomerExcludingAssessedTax"
    assert revenue["rank"] == 0
    assert revenue["outcome"] == "agreed"

    ocf = row_of(rows, "CASH_FLOW")["standardized"]["_fallbacks"]["NetCashFromOperatingActivities"]
    assert ocf["concept"] == "NetCashProvidedByUsedInOperatingActivities"
    assert ocf["rank"] == 0
    assert ocf["outcome"] == "agreed"


def test_a_bank_tagging_only_Revenues_falls_through_to_rank_two() -> None:
    """``Revenues`` remains the sanctioned total for banks, insurers and mixed
    filers. The chain records that the number came from there."""
    rows, _ = logic.build_rows(
        statement_set(income=(line("us-gaap_Revenues", 8_000_000.0),)),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )
    fired = rows[0]["standardized"]["_fallbacks"]["Revenue"]
    assert fired["outcome"] == "filled"
    assert fired["concept"] == "Revenues"
    assert fired["rank"] == 2
    assert rows[0]["standardized"]["Revenue"] == 8_000_000.0


def test_a_pre_2018_filer_falls_through_to_the_deprecated_tag() -> None:
    """``SalesRevenueNet`` was deprecated 2018-01-31 and is still the only
    revenue tag on every filing before it."""
    rows, _ = logic.build_rows(
        statement_set(income=(line("us-gaap_SalesRevenueNet", 500.0),)),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )
    fired = rows[0]["standardized"]["_fallbacks"]["Revenue"]
    assert fired["concept"] == "SalesRevenueNet"
    assert fired["rank"] == 3


def test_the_modern_tag_beats_the_deprecated_one_when_both_are_present() -> None:
    rows, _ = logic.build_rows(
        statement_set(
            income=(
                line("us-gaap_SalesRevenueNet", 500.0),
                line("us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax", 900.0),
            )
        ),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )
    assert rows[0]["standardized"]["Revenue"] == 900.0
    assert rows[0]["standardized"]["_fallbacks"]["Revenue"]["rank"] == 0


def test_the_operating_cash_flow_total_beats_the_continuing_operations_line() -> None:
    """SEC issued a data-quality reminder (2021-05-25) because filers tag the
    continuing-operations element as the total. The TOTAL line wins; the other
    is the fallback."""
    both = logic.build_rows(
        statement_set(
            cashflow=(
                line(
                    "us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", 70.0
                ),
                line("us-gaap_NetCashProvidedByUsedInOperatingActivities", 100.0),
            )
        ),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )[0][0]["standardized"]
    assert both["NetCashFromOperatingActivities"] == 100.0
    assert both["_fallbacks"]["NetCashFromOperatingActivities"]["rank"] == 0

    only_continuing = logic.build_rows(
        statement_set(
            cashflow=(
                line(
                    "us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", 70.0
                ),
            )
        ),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )[0][0]["standardized"]
    assert only_continuing["NetCashFromOperatingActivities"] == 70.0
    fired = only_continuing["_fallbacks"]["NetCashFromOperatingActivities"]
    assert fired["rank"] == 1
    assert fired["outcome"] == "filled"


def test_a_disagreement_is_recorded_and_changes_nothing() -> None:
    """The chain is PROVENANCE first. Silently overriding the library's number
    would make ``standardized`` neither its view nor ours, and the pin on
    ``mappingVersion`` would stop meaning anything."""
    rows, _ = logic.build_rows(
        statement_set(
            income=(
                # The library standardised a DIFFERENT tag as Revenue...
                line("us-gaap_SalesRevenueGoodsNet", 111.0, standard="Revenue"),
                # ...while the chain's top-ranked concept says something else.
                line("us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax", 222.0),
            )
        ),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )
    standardized = rows[0]["standardized"]
    fired = standardized["_fallbacks"]["Revenue"]
    assert fired["outcome"] == "disagreed"
    assert fired["chainValue"] == 222.0
    assert fired["standardizedValue"] == 111.0
    assert standardized["Revenue"] == 111.0


def test_a_filing_with_no_revenue_tag_at_all_records_absent() -> None:
    """ "No concept in the chain appears here" is its own outcome. Silence would
    be indistinguishable from a chain nobody ran."""
    rows, _ = logic.build_rows(
        statement_set(
            income=(line("us-gaap_OperatingIncomeLoss", 5.0, standard="OperatingIncomeLoss"),)
        ),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )
    fired = rows[0]["standardized"]["_fallbacks"]["Revenue"]
    assert fired == {"outcome": "absent", "hasStandardized": False}


def test_a_chain_only_applies_to_its_own_statement() -> None:
    """A revenue tag appearing in a cash-flow statement must not create a
    ``Revenue`` key there."""
    rows, _ = logic.build_rows(
        statement_set(cashflow=(line("us-gaap_Revenues", 10.0),)),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K",
        filed_at=FILED,
        parser_version="test",
    )
    assert "Revenue" not in rows[0]["standardized"]
    assert "Revenue" not in rows[0]["standardized"]["_fallbacks"]


@pytest.mark.parametrize(
    ("concept", "expected"),
    [
        ("us-gaap_GrossProfit", "GrossProfit"),
        ("us-gaap:StatementBusinessSegmentsAxis", "StatementBusinessSegmentsAxis"),
        ("aapl_IPhoneMember", "IPhoneMember"),
        ("Revenues", "Revenues"),
    ],
)
def test_local_name_strips_either_separator(concept: str, expected: str) -> None:
    assert logic.local_name(concept) == expected


# ── collisions ──────────────────────────────────────────────────────────────


def test_the_last_line_wins_because_a_total_follows_its_components() -> None:
    """Measured on Apple's FY2025 cash flow: ``NetCashFromInvestingActivities``
    is produced twice, first from a component the library maps optimistically
    (-1,480,000,000) and then from the real total (15,195,000,000). First-wins
    stores the component."""
    rows, report = apple_rows()
    cash = row_of(rows, "CASH_FLOW")["standardized"]
    assert cash["NetCashFromInvestingActivities"] == 15_195_000_000.0
    assert cash["NetCashFromFinancingActivities"] == -120_686_000_000.0
    # Beginning-of-period cash first, end-of-period last.
    assert cash["CashAndCashEquivalents"] == 35_934_000_000.0

    collided = cash["_collisions"]["NetCashFromInvestingActivities"]
    assert [entry["value"] for entry in collided] == [-1_480_000_000.0, 15_195_000_000.0]
    assert "NetCashFromInvestingActivities" in report["collisions"]["CASH_FLOW"]


def test_an_identical_repeat_is_not_a_collision() -> None:
    values, collisions = logic.standardize(
        (
            line("us-gaap_A", 5.0, standard="Same"),
            line("us-gaap_B", 5.0, standard="Same"),
        )
    )
    assert values["Same"] == 5.0
    assert collisions == {}


# ── the isLatest pointer ────────────────────────────────────────────────────


def test_isLatest_is_written_false_and_recomputed_per_group() -> None:
    """``isLatest`` is a POINTER, not a property of the row: exactly one row per
    (cik10, statementType, periodType, periodEnd) may carry it, so only a query
    over the whole group can decide. A parser that guessed True from insertion
    order would give a restated period two latest rows."""
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    outcome = parse_and_store(
        ACCESSION,
        fixture_text("tenk_bundle_aapl"),
        parse_class="FINANCIALS",
        cik10=CIK,
        form="10-K",
        writer=writer,
        apply=True,
    )
    assert all(row["isLatest"] is False for row in writer.rows_for("fundamentals"))
    assert outcome["isLatestGroups"] == 3
    assert outcome["isLatestRecomputed"] == 3
    assert [call["statementType"] for call in writer.recomputes] == [
        "INCOME",
        "BALANCE_SHEET",
        "CASH_FLOW",
    ]
    assert {call["periodEnd"] for call in writer.recomputes} == {datetime(2025, 9, 27, tzinfo=UTC)}
    # Recomputed AFTER the rows land: recomputing first would point at a group
    # that does not yet contain this filing.
    assert writer.calls.index("upsert_rows") < writer.calls.index("recompute_is_latest")


def test_latest_groups_are_deduplicated() -> None:
    rows, _ = apple_rows()
    groups = logic.latest_groups(rows + rows)
    assert len(groups) == 3
    assert {group["cik10"] for group in groups} == {CIK}
    # Splatted into `recompute_is_latest`, so the keys are its KEYWORD names.
    assert set(groups[0]) == {"cik10", "statement_type", "period_type", "period_end"}


# ── provenance ──────────────────────────────────────────────────────────────


def test_filing_xbrl_outranks_companyfacts_and_says_so_in_the_row() -> None:
    rows, _ = apple_rows()
    for row in rows:
        assert row["mappingSource"] == "FILING_XBRL"
        assert row["mappingVersion"] == logic.MAPPING_VERSION
        assert row["parserVersion"] == "test"
        assert row["source"] == "SEC_EDGAR"
        assert row["accession"] == ACCESSION
        assert row["cik10"] == CIK
        assert row["symbol"] == "AAPL"
        assert row["currency"] == "USD"
        assert row["isAmendment"] is False


def test_an_amendment_is_flagged_from_the_form() -> None:
    rows, _ = logic.build_rows(
        statement_set(income=(line("us-gaap_Revenues", 1.0),)),
        accession=ACCESSION,
        cik10=CIK,
        form="10-K/A",
        filed_at=FILED,
        parser_version="test",
    )
    assert rows[0]["isAmendment"] is True


def test_the_filing_date_is_never_invented() -> None:
    with pytest.raises(ValueError, match="refusing to invent one"):
        logic.build_rows(
            statement_set(income=(line("us-gaap_Revenues", 1.0),)),
            accession=ACCESSION,
            cik10=CIK,
            form="10-K",
            filed_at=None,  # type: ignore[arg-type]
            parser_version="test",
        )


def test_a_filing_with_no_xbrl_is_UNSUPPORTED_not_FAILED() -> None:
    """Most of EDGAR has no XBRL instance. A queue of those marked FAILED is a
    permanently red parser with nothing wrong with it."""
    from tests.test_dispatch import ExplodingWriter

    outcome = parse_and_store(
        "0001214659-26-011109",
        fixture_text_form4(),
        parse_class="FINANCIALS",
        cik10="0000096223",
        form="4",
        writer=ExplodingWriter(),
    )
    assert outcome["status"] == "UNSUPPORTED"
    assert outcome["failed"] == 0
    assert "no XBRL" in outcome["detail"]["reason"]


def fixture_text_form4() -> str:
    return gzip.decompress((FIXTURES / MANIFEST["form4_bundle"]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


def test_through_dispatch_the_unique_key_matches_the_schema() -> None:
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    outcome = parse_and_store(
        ACCESSION,
        fixture_text("tenk_bundle_aapl"),
        parse_class="FINANCIALS",
        cik10=CIK,
        form="10-K",
        writer=writer,
        apply=True,
    )
    assert outcome["rows"] == {"fundamentals": 3}
    collection, _, key = writer.upserts[0]
    assert collection == "fundamentals"
    # `accession` IS in the key: a restatement is a second true statement about
    # the same period, not a correction that overwrites the first.
    assert key == ("cik10", "statementType", "periodType", "periodEnd", "accession")

