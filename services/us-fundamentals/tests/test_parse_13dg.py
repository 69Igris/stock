"""Schedules 13D/13G -> ``us_beneficial_ownership`` — MONEY-979 T7.

Two real filings, chosen because they are on opposite sides of the 2024-12-18
XML mandate and therefore produce structurally different rows from the same
parser:

``schedule13d_expion``  a 2026 ``SCHEDULE 13D`` — structured XML, four reporting
                        persons, percent and voting/dispositive splits present.
``schedule13g_legacy``  a 2022 ``SC 13G`` — HTML only. Identities survive;
                        every number is null.

WITHOUT ``hasStructuredData`` THOSE TWO ARE INDISTINGUISHABLE once stored: a
null ``percentOfClass`` on the 2022 filing would read as a real zero, and a
holder with a genuine 0.0% stake and a holder whose stake we could not machine-
read would look identical to every consumer.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.parsers import schedule13_logic as logic
from app.parsers.dispatch import parse_and_store
from app.sec.edgar_adapter import schedule13_from_bundle

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_text(name: str) -> str:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


STRUCTURED_ACCESSION = "0001903596-26-000330"
LEGACY_ACCESSION = "0000905718-22-000346"


def rows_for(fixture: str, accession: str, symbol: str | None = None) -> list[dict]:
    cover, rows = schedule13_from_bundle(fixture_text(fixture))
    return logic.build_rows(cover, rows, accession=accession, symbol=symbol, parser_version="test")


# ── one row per reporting person ────────────────────────────────────────────


def test_a_filing_by_four_entities_is_four_rows() -> None:
    """Four positions with four different voting and dispositive breakdowns.
    Collapsing them to one loses the structure that makes a 13D readable."""
    rows = rows_for("schedule13d_bundle", STRUCTURED_ACCESSION)
    assert len(rows) == 4
    assert [row["rowIndex"] for row in rows] == [0, 1, 2, 3]
    assert [row["filerName"] for row in rows] == [
        "Five Narrow Lane, LP",
        "Five Narrow Lane General Partner, LLC",
        "Joseph Hammer",
        "Arie Rabinowitz",
    ]
    # The two individuals hold through the partnership: SHARED power, not sole.
    assert rows[0]["soleVoting"] == 96317.0 and rows[0]["sharedVoting"] == 0.0
    assert rows[2]["soleVoting"] == 0.0 and rows[2]["sharedVoting"] == 96137.0
    assert rows[2]["typeOfReportingPerson"] == "IN"
    assert rows[0]["typeOfReportingPerson"] == "OO"


def test_the_structured_filing_carries_real_numbers() -> None:
    rows = rows_for("schedule13d_bundle", STRUCTURED_ACCESSION)
    for row in rows:
        assert row["hasStructuredData"] is True
        assert row["percentOfClass"] == 9.99
        assert row["schedule"] == "13D"
        assert row["form"] == "SCHEDULE 13D"
    assert rows[0]["sharesOwned"] == 96317.0
    assert rows[0]["subjectCik10"] == "0001894954"
    assert rows[0]["subjectName"] == "Expion Energy, Inc."
    assert rows[0]["cusip"] == "30218B209"
    assert rows[0]["eventDate"] == datetime(2026, 8, 21, tzinfo=UTC)
    assert rows[0]["filedAt"] == datetime(2026, 8, 28, tzinfo=UTC)
    # Item 4 — the reason the stake exists, and the only field a 13G
    # structurally cannot have.
    assert "investment purposes" in rows[0]["purposeText"]


# ── the flag ────────────────────────────────────────────────────────────────


def test_a_legacy_filing_stores_identities_with_the_flag_FALSE() -> None:
    """A null percent here means "not machine-readable", not "zero".

    Hard-coding ``hasStructuredData`` True — the obvious simplification once
    every recent filing has it — turns this row into a claim that 11 Capital
    Partners reported a 0% stake, which the filing does not say.
    """
    rows = rows_for("schedule13g_legacy", LEGACY_ACCESSION)
    assert len(rows) == 1
    row = rows[0]
    assert row["hasStructuredData"] is False
    assert row["schedule"] == "13G"
    # As filed. The spelling changed with the mandate and a classifier that
    # knows only one of them silently drops half of history.
    assert row["form"] == "SC 13G"
    assert row["subjectCik10"] == "0001841734"
    assert row["subjectName"] == "Glass Houses Acquisition Corp."
    assert row["filerCik10"] == "0001801172"
    assert row["filerName"] == "11 Capital Partners LP"
    assert row["percentOfClass"] is None
    assert row["sharesOwned"] is None
    assert row["soleVoting"] is None
    assert row["sharedDispositive"] is None
    assert row["filedAt"] == datetime(2022, 2, 14, tzinfo=UTC)


@pytest.mark.parametrize(
    ("filed", "expected"),
    [
        (date(2024, 12, 17), False),
        (date(2024, 12, 18), True),
        (date(2026, 8, 28), True),
        (None, False),
    ],
)
def test_the_mandate_boundary_is_2024_12_18_inclusive(filed: date | None, expected: bool) -> None:
    assert logic.expects_structured_data(filed) is expected


def test_expected_versus_actual_separates_two_identical_looking_rows() -> None:
    """ "Old filing, HTML by law" and "recent filing whose XML we failed to read"
    produce the same nulls and need opposite responses."""
    legacy_cover, _ = schedule13_from_bundle(fixture_text("schedule13g_legacy"))
    assert legacy_cover.has_structured_data is False
    assert logic.expects_structured_data(legacy_cover.filed_at) is False

    # The same filing dated after the mandate: still unstructured, but now that
    # is a DEFECT rather than the law, and the two flags disagree.
    modern = replace(legacy_cover, filed_at=date(2026, 1, 5))
    assert modern.has_structured_data is False
    assert logic.expects_structured_data(modern.filed_at) is True


def test_the_outcome_reports_both_flags() -> None:
    outcome = parse_and_store(
        LEGACY_ACCESSION,
        fixture_text("schedule13g_legacy"),
        parse_class="SCHEDULE13",
        cik10="0001841734",
        form="SC 13G",
    )
    assert outcome["detail"]["hasStructuredData"] is False
    assert outcome["detail"]["structuredDataExpected"] is False
    assert outcome["detail"]["reportingPersons"] == 1


# ── tier (a) of the CUSIP map ───────────────────────────────────────────────


def test_a_structured_cover_page_seeds_the_cusip_map() -> None:
    """CUSIP and subject CIK, published together by the filer. The first and
    only strictly primary-source tier."""
    cover, _ = schedule13_from_bundle(fixture_text("schedule13d_bundle"))
    assert logic.cusip_seed(cover) == {
        "cusip": "30218B209",
        "cik10": "0001894954",
        "issuerName": "Expion Energy, Inc.",
    }


def test_a_legacy_cover_page_seeds_nothing_rather_than_a_blank() -> None:
    """Pre-mandate HTML has no machine-readable CUSIP. A row keyed on ``""``
    would be retried weekly forever and counted against coverage."""
    cover, _ = schedule13_from_bundle(fixture_text("schedule13g_legacy"))
    assert cover.cusip is None
    assert logic.cusip_seed(cover) is None


def test_a_cusip_without_a_subject_cik_is_not_a_pair() -> None:
    cover, _ = schedule13_from_bundle(fixture_text("schedule13d_bundle"))
    assert logic.cusip_seed(replace(cover, subject_cik10="")) is None


# ── storage shape ───────────────────────────────────────────────────────────


def test_the_filing_date_is_never_invented() -> None:
    """``filedAt`` is not nullable in the schema. A filing whose header carried
    neither date is a parse failure, not a row stamped with today."""
    cover, rows = schedule13_from_bundle(fixture_text("schedule13d_bundle"))
    with pytest.raises(ValueError, match="refusing to invent one"):
        logic.build_rows(
            replace(cover, filed_at=None),
            rows,
            accession=STRUCTURED_ACCESSION,
            parser_version="test",
        )


def test_provenance_and_symbol_land_on_every_row() -> None:
    rows = rows_for("schedule13d_bundle", STRUCTURED_ACCESSION, symbol="XPON")
    for row in rows:
        assert row["source"] == "SEC_EDGAR"
        assert row["parserVersion"] == "test"
        assert row["accession"] == STRUCTURED_ACCESSION
        assert row["symbol"] == "XPON"
        assert isinstance(row["filedAt"], datetime)
        assert row["filedAt"].tzinfo is not None


def test_both_form_spellings_are_covered_by_the_constant() -> None:
    """The live feed emits ``SCHEDULE 13D`` since the mandate; the whole of
    history before it is ``SC 13D``."""
    assert "SC 13D" in logic.SCHEDULE13_FORMS
    assert "SCHEDULE 13D" in logic.SCHEDULE13_FORMS
    assert "SC 13G/A" in logic.SCHEDULE13_FORMS
    assert "SCHEDULE 13G/A" in logic.SCHEDULE13_FORMS


def test_through_dispatch_one_collection_on_the_accession_row_key() -> None:
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    outcome = parse_and_store(
        STRUCTURED_ACCESSION,
        fixture_text("schedule13d_bundle"),
        parse_class="SCHEDULE13",
        cik10="0001894954",
        form="SCHEDULE 13D",
        writer=writer,
        apply=True,
    )
    assert outcome["rows"] == {"beneficial_ownership": 4}
    collection, _, key = writer.upserts[0]
    assert collection == "beneficial_ownership"
    assert key == ("accession", "rowIndex")


def test_parsing_twice_produces_identical_rows() -> None:
    assert rows_for("schedule13d_bundle", STRUCTURED_ACCESSION) == rows_for(
        "schedule13d_bundle", STRUCTURED_ACCESSION
    )

