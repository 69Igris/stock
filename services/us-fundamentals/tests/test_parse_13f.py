"""13F -> ``us_13f_filings`` + ``us_13f_holdings`` — MONEY-979 T7.

THE UNIT RULE IS THE POINT OF THIS FILE, and the fixture pair is the sharpest
test available for it: the SAME MANAGER, Berkshire Hathaway, filing the same
kind of report either side of SEC Release 34-95148.

    2022-11-14   total value as filed        296,096,640   (THOUSANDS)
    2026-08-14   total value as filed    299,253,556,246   (DOLLARS)

Those two numbers differ by a factor of 1,011. After the rule they differ by
1.01 — Berkshire's portfolio grew by 1% across four years, which is the answer a
human would recognise. Apple appears in BOTH filings at an identical 692,000
shares under the same other-manager combination, so the share side is a control:
if the parser had drifted, that number would move too.

A 1000x error here does not crash anything. It produces a plausible-looking
portfolio, which is why the assertion is an ORDER-OF-MAGNITUDE comparison
between the two normalised totals rather than two independent "it parsed"
checks that would both pass with one of them wrong.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.parsers import thirteenf_logic as logic
from app.parsers.dispatch import parse_and_store
from app.sec.edgar_adapter import thirteenf_from_bundle

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_text(name: str) -> str:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


PRE_ACCESSION = "0000950123-22-012275"
POST_ACCESSION = "0001193125-26-352200"
AMEND_ACCESSION = "0000950123-25-008361"
APPLE_CUSIP = "037833100"


# ── the rule ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("filed", "rule"),
    [
        (date(2022, 11, 14), "THOUSANDS"),
        (date(2023, 1, 2), "THOUSANDS"),
        # Release 34-95148 applies to reports filed ON this date as well as
        # after it. `>` instead of `>=` puts one day of filings out by 1000x.
        (date(2023, 1, 3), "DOLLARS"),
        (date(2026, 8, 14), "DOLLARS"),
    ],
)
def test_the_cutover_is_2023_01_03_inclusive(filed: date, rule: str) -> None:
    assert logic.value_unit_rule(filed) == rule


def test_the_rule_is_keyed_on_the_FILING_date_not_the_period() -> None:
    """A 2023-filed amendment of a 2022 quarter is in DOLLARS.

    This is the whole reason the constant is compared against ``filed_at``.
    Berkshire's real September-2022 cover page is reused with only its FILING
    date moved past the cutover — the period stays 2022-09-30 — so a rule
    written against ``periodOfReport`` multiplies a dollars filing by 1000 and
    this test goes red.
    """
    cover, rows = thirteenf_from_bundle(fixture_text("13f_pre"))
    assert cover.period_of_report == date(2022, 9, 30)

    as_filed_2022 = logic.build_filing_row(cover, accession=PRE_ACCESSION, parser_version="test")
    refiled_2023 = logic.build_filing_row(
        replace(cover, filed_at=date(2023, 3, 1)),
        accession=PRE_ACCESSION,
        parser_version="test",
    )

    assert as_filed_2022["valueUnitRule"] == "THOUSANDS"
    assert refiled_2023["valueUnitRule"] == "DOLLARS"
    assert refiled_2023["periodOfReport"] == datetime(2022, 9, 30, tzinfo=UTC)
    assert as_filed_2022["totalValueUsd"] == refiled_2023["totalValueUsd"] * 1000

    # THE HOLDING ROWS ARE A SEPARATE CODE PATH and need the same assertion.
    # Both fixtures have their period and their filing date on the SAME side of
    # the cutover, so a holding-row rule written against `periodOfReport` agrees
    # with the correct one on every fixture we own and only diverges on the
    # amendment case this test constructs.
    apple = [row for row in rows if row.cusip == APPLE_CUSIP][:1]
    as_filed = logic.build_holding_rows(
        cover, apple, accession=PRE_ACCESSION, parser_version="test"
    )[0]
    refiled = logic.build_holding_rows(
        replace(cover, filed_at=date(2023, 3, 1)),
        apple,
        accession=PRE_ACCESSION,
        parser_version="test",
    )[0]
    assert as_filed["valueUsd"] == refiled["valueUsd"] * 1000
    assert as_filed["periodOfReport"] == refiled["periodOfReport"]


def test_the_two_berkshire_filings_agree_after_the_rule() -> None:
    """296,096,640 (thousands) and 299,253,556,246 (dollars) are ~$300bn each."""
    pre_cover, _ = thirteenf_from_bundle(fixture_text("13f_pre"))
    post_cover, _ = thirteenf_from_bundle(fixture_text("13f_post"))

    assert pre_cover.total_value_as_filed == 296_096_640
    assert post_cover.total_value_as_filed == 299_253_556_246

    pre = logic.build_filing_row(pre_cover, accession=PRE_ACCESSION, parser_version="test")
    post = logic.build_filing_row(post_cover, accession=POST_ACCESSION, parser_version="test")

    assert pre["totalValueUsd"] == 296_096_640_000.0
    assert post["totalValueUsd"] == 299_253_556_246.0
    # The property, not the two numbers: one order of magnitude apart at most.
    # A rule that fires on the wrong side puts them 1,011x apart.
    ratio = max(pre["totalValueUsd"], post["totalValueUsd"]) / min(
        pre["totalValueUsd"], post["totalValueUsd"]
    )
    assert ratio < 10, f"the two filings are {ratio:,.0f}x apart — the unit rule did not fire"
    assert 200e9 < pre["totalValueUsd"] < 500e9
    assert 200e9 < post["totalValueUsd"] < 500e9


def test_apple_is_the_control_and_its_share_count_does_not_move() -> None:
    """Identical 692,000 shares in both filings, under other-manager ``4``."""
    pre_cover, pre_rows = thirteenf_from_bundle(fixture_text("13f_pre"))
    post_cover, post_rows = thirteenf_from_bundle(fixture_text("13f_post"))

    pre_apple = [
        row for row in pre_rows if row.cusip == APPLE_CUSIP and row.other_managers == ("4",)
    ]
    post_apple = [
        row for row in post_rows if row.cusip == APPLE_CUSIP and row.other_managers == ("4",)
    ]
    assert len(pre_apple) == len(post_apple) == 1
    assert pre_apple[0].shares == post_apple[0].shares == 692_000.0

    pre_built = logic.build_holding_rows(
        pre_cover, pre_apple, accession=PRE_ACCESSION, parser_version="test"
    )[0]
    post_built = logic.build_holding_rows(
        post_cover, post_apple, accession=POST_ACCESSION, parser_version="test"
    )[0]
    # 95,634 thousands, hand-checked against the filed table.
    assert pre_built["valueUsd"] == 95_634_000.0
    assert post_built["valueUsd"] == 200_237_120.0
    # Same position, four years apart, at plausible prices per share.
    assert 100 < pre_built["valueUsd"] / pre_built["shares"] < 200
    assert 200 < post_built["valueUsd"] / post_built["shares"] < 400


def test_the_library_verdict_is_recorded_beside_ours_never_instead_of_it() -> None:
    """edgartools infers the unit from implied price per share — a different
    mechanism. Storing both is what makes a disagreement a column instead of a
    silence."""
    for fixture, accession, rule in (
        ("13f_pre", PRE_ACCESSION, "THOUSANDS"),
        ("13f_post", POST_ACCESSION, "DOLLARS"),
    ):
        cover, _ = thirteenf_from_bundle(fixture_text(fixture))
        row = logic.build_filing_row(cover, accession=accession, parser_version="test")
        assert row["valueUnitRule"] == rule
        assert row["libraryUnitVerdict"] == rule
        assert logic.unit_rule_disagrees(rule, cover.library_unit_verdict) is False


def test_a_disagreement_is_reported_and_a_missing_opinion_is_not() -> None:
    assert logic.unit_rule_disagrees("DOLLARS", "THOUSANDS") is True
    assert logic.unit_rule_disagrees("THOUSANDS", "DOLLARS") is True
    # "No opinion" is not "the opposite opinion": the library declines on an
    # empty table, and folding the two together fires the counter on every NT.
    assert logic.unit_rule_disagrees("DOLLARS", None) is False


def test_the_disagreement_reaches_the_parse_outcome() -> None:
    cover, _ = thirteenf_from_bundle(fixture_text("13f_post"))
    outcome = parse_and_store(
        POST_ACCESSION,
        fixture_text("13f_post"),
        parse_class="THIRTEENF",
        cik10="0001067983",
        form="13F-HR",
    )
    assert outcome["detail"]["unitRuleDisagreement"] is False
    assert outcome["detail"]["valueUnitRule"] == "DOLLARS"
    assert outcome["detail"]["libraryUnitVerdict"] == cover.library_unit_verdict


# ── 13F-NT ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("form", "report_type", "notice"),
    [
        ("13F-NT", None, True),
        ("13F-NT/A", None, True),
        ("13f-nt", None, True),
        ("13F-HR", None, False),
        ("13F-HR/A", None, False),
        (None, "13F NOTICE", True),
        ("13F-HR", "13F HOLDINGS REPORT", False),
        (None, None, False),
    ],
)
def test_a_notice_is_recognised_from_either_spelling(
    form: str | None, report_type: str | None, notice: bool
) -> None:
    assert logic.is_notice(form, report_type) is notice


def test_a_13F_NT_is_UNSUPPORTED_and_never_FAILED() -> None:
    """It has no information table BY DESIGN. FAILED means we could not read a
    filing we should have been able to read, and a queue of NTs marked FAILED is
    a permanently red parser with nothing wrong with it."""
    from tests.test_dispatch import ExplodingWriter

    outcome = parse_and_store(
        POST_ACCESSION,
        fixture_text("13f_post"),
        parse_class="THIRTEENF",
        cik10="0001067983",
        form="13F-NT",
        writer=ExplodingWriter(),
    )
    assert outcome["status"] == "UNSUPPORTED"
    assert outcome["failed"] == 0
    assert outcome["written"] == 0
    assert outcome["rows"] == {}


# ── amendments ──────────────────────────────────────────────────────────────


def test_the_real_amendment_is_a_union_and_supersedes_nothing() -> None:
    """``NEW HOLDINGS`` ADDS to the original. Treating it as a restatement would
    erase the rest of the quarter."""
    cover, rows = thirteenf_from_bundle(fixture_text("13f_amend"))
    assert cover.is_amendment is True
    assert cover.amendment_type == "NEW HOLDINGS"
    assert logic.amendment_effect(cover) == "NEW_HOLDINGS"
    assert logic.supersede_filter(cover, AMEND_ACCESSION) is None
    assert len(rows) == 4


def test_a_restatement_supersedes_the_original_within_one_manager_and_period() -> None:
    """The filter is scoped, excludes this filing's own rows, and is bounded by
    ``filedAt`` so it can never remove holdings filed AFTER it."""
    cover, _ = thirteenf_from_bundle(fixture_text("13f_amend"))
    restatement = replace(cover, amendment_type="RESTATEMENT")
    assert logic.amendment_effect(restatement) == "RESTATEMENT"

    where = logic.supersede_filter(restatement, AMEND_ACCESSION)
    assert where == {
        "managerCik10": "0001067983",
        "periodOfReport": datetime(2025, 3, 31, tzinfo=UTC),
        "accession": {"$ne": AMEND_ACCESSION},
        "filedAt": {"$lte": datetime(2025, 8, 14, tzinfo=UTC)},
    }


def test_an_amendment_that_did_not_say_what_it_is_deletes_nothing() -> None:
    """``UNKNOWN`` is a real answer. Treating a missing element as a restatement
    would delete a quarter of holdings on the strength of an absence."""
    cover, _ = thirteenf_from_bundle(fixture_text("13f_amend"))
    silent = replace(cover, amendment_type=None)
    assert logic.amendment_effect(silent) == "UNKNOWN"
    assert logic.supersede_filter(silent, AMEND_ACCESSION) is None


def test_an_original_is_never_an_amendment() -> None:
    cover, _ = thirteenf_from_bundle(fixture_text("13f_post"))
    assert logic.amendment_effect(cover) == "ORIGINAL"
    assert logic.supersede_filter(cover, POST_ACCESSION) is None


def test_a_restatement_reaches_the_writer_as_a_delete_when_armed() -> None:
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    outcome = parse_and_store(
        AMEND_ACCESSION,
        fixture_text("13f_amend").replace(
            "<amendmentType>NEW HOLDINGS", "<amendmentType>RESTATEMENT"
        ),
        parse_class="THIRTEENF",
        cik10="0001067983",
        form="13F-HR/A",
        writer=writer,
        apply=True,
    )
    assert outcome["detail"]["amendmentEffect"] == "RESTATEMENT"
    assert outcome["supersedeApplied"] is True
    assert writer.deletes and writer.deletes[0][0] == "thirteen_f_holdings"
    # The delete runs BEFORE the amendment's own rows land, so the two can never
    # race to remove what was just written.
    assert writer.calls.index("delete_rows") < writer.calls.index("upsert_rows")


def test_a_writer_without_delete_rows_reports_the_skip_rather_than_pretending() -> None:
    class WriterWithoutDelete:
        def __init__(self) -> None:
            self.rows = 0

        def upsert_rows(self, collection, rows, *, key) -> int:
            self.rows += len(rows)
            return len(rows)

        def set_filing_status(self, accession, **kwargs) -> None:
            return None

        def recompute_is_latest(self, **kwargs) -> int:
            return 0

    outcome = parse_and_store(
        AMEND_ACCESSION,
        fixture_text("13f_amend").replace(
            "<amendmentType>NEW HOLDINGS", "<amendmentType>RESTATEMENT"
        ),
        parse_class="THIRTEENF",
        cik10="0001067983",
        form="13F-HR/A",
        writer=WriterWithoutDelete(),
        apply=True,
    )
    assert outcome["supersedeApplied"] is False
    assert "delete_rows" in outcome["supersedeSkippedReason"]


# ── manager identity and row shape ──────────────────────────────────────────


def test_the_manager_cik_comes_from_the_filing_not_the_cover_page() -> None:
    """The 13F cover carries only a NAME and an address. A name-keyed join would
    merge every "Capital Management LLC" in the country."""
    cover, rows = thirteenf_from_bundle(fixture_text("13f_post"))
    assert cover.manager_cik10 == "0001067983"
    assert cover.manager_name == "Berkshire Hathaway Inc"
    built = logic.build_holding_rows(cover, rows, accession=POST_ACCESSION, parser_version="test")
    assert {row["managerCik10"] for row in built} == {"0001067983"}


def test_holdings_carry_provenance_and_an_honest_unresolved_symbol() -> None:
    cover, rows = thirteenf_from_bundle(fixture_text("13f_post"))
    built = logic.build_holding_rows(cover, rows, accession=POST_ACCESSION, parser_version="test")
    assert len(built) == 89
    for row in built:
        assert row["source"] == "SEC_EDGAR"
        assert row["parserVersion"] == "test"
        assert row["accession"] == POST_ACCESSION
        assert row["sharesType"] in {"SH", "PRN"}
        # Nothing in the map yet: visibly unresolved, not a company with no
        # ticker.
        assert row["symbol"] is None
        assert row["resolvedBy"] is None


def test_a_cusip_map_hit_stamps_the_symbol_and_the_tier_that_answered() -> None:
    cover, rows = thirteenf_from_bundle(fixture_text("13f_post"))
    built = logic.build_holding_rows(
        cover,
        rows,
        accession=POST_ACCESSION,
        parser_version="test",
        cusip_hits={APPLE_CUSIP: {"symbol": "AAPL", "cik10": "0000320193", "source": "SEC_13DG"}},
    )
    apple = [row for row in built if row["cusip"] == APPLE_CUSIP]
    assert apple and all(row["symbol"] == "AAPL" for row in apple)
    assert all(row["resolvedBy"] == "SEC_13DG" for row in apple)
    assert all(row["issuerCik10"] == "0000320193" for row in apple)


def test_a_map_row_with_no_symbol_does_not_claim_a_tier_resolved_it() -> None:
    """An ``UNRESOLVED`` row exists so the sweep can retry it. Reading it as a
    resolution would stamp ``resolvedBy`` on a holding with no ticker."""
    cover, rows = thirteenf_from_bundle(fixture_text("13f_post"))
    built = logic.build_holding_rows(
        cover,
        rows,
        accession=POST_ACCESSION,
        parser_version="test",
        cusip_hits={APPLE_CUSIP: {"symbol": None, "cik10": None, "source": "UNRESOLVED"}},
    )
    apple = [row for row in built if row["cusip"] == APPLE_CUSIP]
    assert apple and all(row["resolvedBy"] is None for row in apple)


def test_the_filing_row_starts_HOT_with_no_cold_path() -> None:
    """Nothing here ever writes COLD. The evictor (T9) archives the period,
    RE-READS the shard, and only then moves the tier."""
    cover, _ = thirteenf_from_bundle(fixture_text("13f_post"))
    row = logic.build_filing_row(cover, accession=POST_ACCESSION, parser_version="test")
    assert row["tier"] == "HOT"
    assert row["coldPath"] is None


def test_through_dispatch_both_collections_are_written_on_their_own_keys() -> None:
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    outcome = parse_and_store(
        POST_ACCESSION,
        fixture_text("13f_post"),
        parse_class="THIRTEENF",
        cik10="0001067983",
        form="13F-HR",
        writer=writer,
        apply=True,
    )
    assert outcome["rows"] == {"thirteen_f_filings": 1, "thirteen_f_holdings": 89}
    assert outcome["written"] == 90
    keys = {collection: key for collection, _, key in writer.upserts}
    assert keys["thirteen_f_filings"] == ("accession",)
    assert keys["thirteen_f_holdings"] == ("accession", "rowIndex")
