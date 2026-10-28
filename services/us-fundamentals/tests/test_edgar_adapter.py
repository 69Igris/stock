"""Adapter tests against a corpus of REAL SEC filings.

Every fixture in `tests/fixtures/` is bytes SEC actually served, captured once
by `scripts/capture_fixtures.py` under our declared User-Agent and recorded in
`manifest.json` with its URL, sha256 and the reason it exists. Nothing here is
synthesised: a hand-written 13F would agree with whatever the parser happened
to do, which is the definition of a shadow test.

The numeric assertions are HAND-VERIFIED against the filings themselves, not
copied out of a first run. Apple's FY2025 figures were checked against the
rendered text of the 10-K in the same fixture — the income statement prints
"Total net sales $ 416,161" and "Net income $ 112,010" in millions, and XBRL
reports whole dollars, so the expected values are those numbers times 1e6.
"""

from __future__ import annotations

import binascii
import gzip
import json
import socket
from datetime import date, datetime
from pathlib import Path

import pytest

from app.sec.adapter_types import StatementSet
from app.sec.edgar_adapter import (
    TRANSACTION_CODES,
    eightk_from_bundle,
    facts_from_companyfacts_json,
    fiscal_years_with_annual_report,
    ownership_from_bundle,
    parse_current_filings_atom,
    parse_daily_index,
    parse_efts_response,
    parse_submissions_json,
    pdf_text,
    schedule13_from_bundle,
    statements_from_bundle,
    thirteenf_from_bundle,
)

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_bytes(name: str) -> bytes:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes())


def fixture_text(name: str) -> str:
    return fixture_bytes(name).decode("utf-8", "replace")


def fixture_json(name: str) -> dict:
    return json.loads(fixture_bytes(name))


# ── the getcurrent Atom feed ────────────────────────────────────────────────


def test_atom_100_entries_collapse_to_49_filings() -> None:
    """The role-duplication property, which is the whole reason to dedupe.

    Measured on this fixture: 100 `<entry>` elements, 49 distinct accessions.
    Both halves are asserted — the exact count so a parser regression that
    dropped entries would fail, and the INEQUALITY so the property itself
    ("entries outnumber filings") is stated rather than merely implied by a
    magic number. A detector that published one message per entry would fan out
    2.04x, and Pub/Sub would carry every duplicate to a parser.
    """
    raw = fixture_bytes("atom_getcurrent")
    entry_count = raw.count(b"<entry>")
    entries = parse_current_filings_atom(raw)

    assert entry_count == 100
    assert len(entries) == 49
    assert len(entries) < entry_count
    assert len({e.accession for e in entries}) == len(entries)


def test_atom_takes_accession_from_id_and_keeps_every_filer_role() -> None:
    """Roles are kept, not discarded — the issuer is a different company."""
    entries = {e.accession: e for e in parse_current_filings_atom(fixture_bytes("atom_getcurrent"))}
    entry = entries["0001214659-26-011109"]

    assert entry.form == "4"
    assert entry.cik10 == "0001211677"  # HANDLER RICHARD B, the reporting owner
    assert entry.filed_at == date(2026, 8, 28)
    # `<updated>` is 2026-08-28T21:53:58-04:00; stored in UTC because a naive
    # timestamp reaching Mongo is silently reinterpreted as local time.
    assert entry.accepted_at == datetime.fromisoformat("2026-08-29T01:53:58+00:00")
    assert entry.roles == (
        ("0001211677", "HANDLER RICHARD B", "Reporting"),
        ("0000096223", "Jefferies Financial Group Inc.", "Issuer"),
    )


# ── EFTS ────────────────────────────────────────────────────────────────────


def test_efts_keeps_ciks_as_an_array_and_reads_form_not_form_type() -> None:
    """`ciks` is an ARRAY; edgartools keeps only `[0]` and loses the issuer.

    There is also no `form_type` key anywhere in the response — the field is
    `form` — which is the kind of thing a parser written from documentation
    gets wrong and then reports as "no results".
    """
    payload = fixture_json("efts_8k_search")
    source_keys = set(payload["hits"]["hits"][0]["_source"])
    assert "form" in source_keys
    assert "form_type" not in source_keys

    hits = {h.accession: h for h in parse_efts_response(payload)}
    assert len(hits) == 100

    hit = hits["0001420720-26-000019"]
    assert hit.form == "8-K"
    assert hit.ciks == ("0001420720",)
    assert hit.file_date == date(2026, 8, 28)
    # Item 2.02 is the earnings release; 9.01 is the exhibit that carries it.
    assert hit.items == ("2.02", "9.01")


# ── daily index ─────────────────────────────────────────────────────────────


def test_daily_index_parses_the_undelimited_date_and_multiword_forms() -> None:
    """`form.idx` dates are `YYYYMMDD`, and a form type may contain a space.

    A pattern written for `YYYY-MM-DD` matches zero rows on every daily index
    ever published and fails SILENTLY — "no filings today" is indistinguishable
    from a market holiday. Splitting on single whitespace loses "SC 13G" and
    "1-A POS".
    """
    raw = fixture_bytes("daily_index_20220214").decode("latin-1")
    rows = parse_daily_index(raw)

    # EVERY body line parsed. A row this pattern cannot match is a filing that
    # silently never enters the ledger, so the count is asserted against the
    # file rather than against itself.
    body = raw.split("---", 1)[1].splitlines()[1:]
    assert len(rows) == len([ln for ln in body if ln.strip()]) == 19412

    forms = [r.form for r in rows]
    # 2022-02-14 was simultaneously the Q4-2021 13F deadline and the annual 13G
    # deadline, which is why one day's index can supply both populations.
    assert forms.count("13F-HR") == 1927
    assert forms.count("SC 13G") == 3428
    assert "SC 13G/A" in forms  # a multi-word form survived the split

    first = rows[0]
    assert first.form == "1-A"
    assert first.cik10 == "0001140586"
    assert first.accession == "0001683168-22-000961"
    assert first.path == "edgar/data/1140586/0001683168-22-000961.txt"


def test_daily_index_is_a_dissemination_day_not_a_filing_day() -> None:
    """Two properties a backfill that walks these files per day MUST know.

    1. ONE ROW PER FILER, exactly like the Atom feed's one-entry-per-role.
       19,412 rows are 11,870 filings; one co-registered S-3ASR occupies 16
       rows. A backfill that treats rows as filings fans out 1.6x and hands
       every co-registrant's copy to a parser.

    2. THE INDEX DAY IS NOT THE FILING DAY. 198 rows here (1.0%) carry an
       earlier `filed_at`, reaching back to 2021-05-21 — nine months. So a
       backfill must stamp `filedAt` from THE ROW, never from the date in the
       filename it just fetched. Doing the latter is silent: the row still
       lands, with a plausible date, in the wrong period.
    """
    rows = parse_daily_index(fixture_bytes("daily_index_20220214").decode("latin-1"))

    accessions = {r.accession for r in rows}
    assert len(rows) == 19412
    assert len(accessions) == 11870
    assert len(accessions) < len(rows)

    off_day = [r for r in rows if r.filed_at != date(2022, 2, 14)]
    assert len(off_day) == 198
    assert min(r.filed_at for r in rows) == date(2021, 5, 21)
    assert max(r.filed_at for r in rows) == date(2022, 2, 14)


# ── submissions ─────────────────────────────────────────────────────────────


def test_submissions_zips_parallel_arrays_and_counts_annual_years() -> None:
    filer, filings = parse_submissions_json(fixture_json("submissions_berkshire"))

    assert filer.cik10 == "0001067983"
    assert filer.name == "BERKSHIRE HATHAWAY INC"
    assert filer.sic == "6331"
    # `MMDD`, kept as a string: it is a recurring annual boundary, and turning
    # it into a date would invent a year.
    assert filer.fiscal_year_end == "1231"
    assert filer.state_of_inc == "DE"
    assert filer.tickers_as_filed == ("BRK-B", "BRK-A")
    # `filings.files[]` is RETURNED but never followed — this module does not
    # fetch. Its presence is what tells a caller older shards exist.
    assert len(filer.paging_files) == 1

    assert len(filings) == 1001
    assert all(f.cik10 == "0001067983" for f in filings)
    # A floor, not a total: only `recent` is counted, because the older shards
    # are behind the paging references above.
    assert filer.fiscal_years_on_file == 10


# ── companyfacts ────────────────────────────────────────────────────────────


def test_companyfacts_preserves_frame_which_the_library_drops() -> None:
    """`frame` is the single de-duplication signal SEC publishes.

    edgartools' `EntityFactsParser` reads `val/end/start/filed/fy/fp/form/accn`
    and drops `frame` entirely — the key appears nowhere in the package — which
    is the whole reason this adapter parses the raw JSON. Without it there is
    no way to ask "which of the six reported values for Q1 is the calendar-Q1
    one" except by re-deriving SEC's own alignment rule.
    """
    series = facts_from_companyfacts_json(fixture_json("companyfacts_aapl"))

    assert len(series) == 508
    assert sum(len(s.values) for s in series) == 25135
    assert {s.taxonomy for s in series} == {"dei", "us-gaap"}

    framed = [v for s in series for v in s.values if v.frame]
    assert len(framed) == 9802

    oldest = framed[0]
    assert oldest.frame == "CY2009Q2I"
    assert oldest.accn == "0001193125-09-153165"
    assert oldest.form == "10-Q"
    assert oldest.filed == date(2009, 7, 22)

    # Several values legitimately share one period: a later filing restates and
    # every 10-K carries prior-year comparatives. 117 reported values for one
    # concept is the shape, not corruption.
    revenue = [
        s
        for s in series
        if s.concept == "RevenueFromContractWithCustomerExcludingAssessedTax" and s.unit == "USD"
    ]
    assert len(revenue) == 1
    assert len(revenue[0].values) == 117


def test_short_history_filer_yields_what_exists_and_raises_nothing() -> None:
    """Decision 5: store everything, never fail.

    CoreWeave IPO'd in March 2025, so exactly ONE fiscal year has a 10-K behind
    it. A coverage gate reading "95% of filers have 5+ years" fails every
    quarter a batch of new listings arrives; a gate reading "95% of filers WHO
    HAVE 5+ YEARS AT SEC have 5+ years here" measures us instead of the market.
    That distinction is only expressible because this number is measured rather
    than assumed, and because a short history is not an exception path.
    """
    series = facts_from_companyfacts_json(fixture_json("companyfacts_short_history"))

    assert series, "a short-history filer must still yield its facts"
    assert series[0].cik10 == "0001769628"
    assert len(series) == 313
    assert sum(len(s.values) for s in series) == 2700
    assert fiscal_years_with_annual_report(series) == {2025}

    long_history = facts_from_companyfacts_json(fixture_json("companyfacts_aapl"))
    assert len(fiscal_years_with_annual_report(long_history)) == 17


# ── statements ──────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def aapl_statements() -> StatementSet:
    result = statements_from_bundle(fixture_text("tenk_bundle_aapl"))
    assert result is not None
    return result


def _entity_wide(lines, standard_concept: str):
    """The one non-dimensional line for a standard concept.

    Filtering on `not line.dimensions` is the point: Apple tags iPhone, Mac,
    iPad, Services and five geographic segments with the SAME us-gaap revenue
    concept, so a lookup that ignored dimensions would return a segment.
    """
    matches = [ln for ln in lines if ln.standard_concept == standard_concept and not ln.dimensions]
    assert len(matches) == 1, f"expected exactly one entity-wide {standard_concept}"
    return matches[0]


def test_aapl_fy2025_statement_values_match_the_filing(aapl_statements: StatementSet) -> None:
    """Hand-verified against the rendered text of this same 10-K.

    The filing prints these in MILLIONS ("Total net sales $ 416,161"); XBRL
    reports whole dollars, hence the 1e6. Each was confirmed to appear in the
    filing's own text before being written here — an expected value copied out
    of a first run only asserts that the code still does what it did.
    """
    statements = aapl_statements

    assert statements.period_end == date(2025, 9, 27)
    assert statements.period_start == date(2024, 9, 29)
    assert statements.fiscal_year == 2025
    assert statements.fiscal_period == "FY"
    assert statements.currency == "USD"
    # A 10-K presents two prior years as comparatives. Listed, not silently
    # merged into this period.
    assert statements.comparative_periods == ("2024-09-28 (FY)", "2023-09-30 (FY)")

    assert _entity_wide(statements.income, "Revenue").value == 416_161_000_000.0
    assert _entity_wide(statements.income, "NetIncome").value == 112_010_000_000.0
    assert _entity_wide(statements.income, "GrossProfit").value == 195_201_000_000.0
    assert _entity_wide(statements.balance, "Assets").value == 359_241_000_000.0
    assert (
        _entity_wide(statements.cashflow, "NetCashFromOperatingActivities").value
        == 111_482_000_000.0
    )

    # `standard_concept` is the normalisation; `concept` is what Apple actually
    # tagged. Both are stored because ~5% of tags fall outside the map and
    # extension concepts fall outside it by definition.
    assert (
        _entity_wide(statements.income, "Revenue").concept
        == "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax"
    )
    assert _entity_wide(statements.income, "Revenue").label == "Net sales"
    assert _entity_wide(statements.income, "Revenue").unit == "usd"


def test_balance_sheet_uses_instant_columns_and_income_uses_durations(
    aapl_statements: StatementSet,
) -> None:
    """The two column-label shapes must both resolve to this filing's period.

    A balance sheet's columns are instants (`2025-09-27`) and an income
    statement's are durations (`2025-09-27 (FY)`). Matching on the ISO prefix
    covers both; matching on equality would silently return an EMPTY balance
    sheet, which reads as "this filer published no balance sheet".
    """
    assert aapl_statements.balance
    assert aapl_statements.income
    assert aapl_statements.cashflow
    assert aapl_statements.equity
    assert len(aapl_statements.income) == 47
    assert len(aapl_statements.balance) == 79


def test_segment_rows_carry_dimensions_and_no_standard_concept(
    aapl_statements: StatementSet,
) -> None:
    """A NaN guard, and the reason it exists.

    pandas spells "no value" as `float('nan')`, which is TRUTHY. The obvious
    `str(x) if x else None` therefore yields the literal string "nan", and
    every one of Apple's segment rows would land in a standard bucket named
    "nan" — where any reader grouping by standard concept would sum iPhone,
    Mac, iPad and Services revenue into a second, plausible-looking total.
    """
    iphone = [ln for ln in aapl_statements.income if ln.label == "iPhone"]
    assert len(iphone) == 1
    assert iphone[0].value == 209_586_000_000.0
    assert iphone[0].dimensions == {"srt:ProductOrServiceAxis": "aapl_IPhoneMember"}
    assert iphone[0].standard_concept is None

    # The inverse: an entity-wide row has NO dimensions, not `{"nan": "nan"}`.
    assert _entity_wide(aapl_statements.income, "Revenue").dimensions == {}

    for line in aapl_statements.income + aapl_statements.balance:
        assert "nan" not in line.dimensions
        assert line.standard_concept != "nan"


def test_filing_without_xbrl_returns_none_rather_than_raising() -> None:
    """Most of EDGAR has no XBRL. That is an answer, not an error."""
    assert statements_from_bundle(fixture_text("form4_bundle")) is None


# ── ownership ───────────────────────────────────────────────────────────────


def test_form4_separates_holdings_from_transactions() -> None:
    """Holdings are kept with a flag, not dropped and not counted as trades.

    This filing is 1 transaction and 12 holdings. Dropping holdings would make
    it look like a one-line filing; counting them as trades would report 13
    insider transactions where one occurred.
    """
    cover, rows = ownership_from_bundle(fixture_text("form4_bundle"))

    assert cover.issuer_cik10 == "0000096223"
    assert cover.issuer_name == "Jefferies Financial Group Inc."
    assert cover.issuer_ticker == "JEF"
    assert cover.owner_cik10 == "0001211677"
    assert cover.owner_name == "HANDLER RICHARD B"
    assert cover.is_director is True
    assert cover.is_officer is True
    assert cover.officer_title == "CEO"
    assert cover.is_amendment is False

    assert len(rows) == 13
    assert sum(r.is_holding for r in rows) == 12

    transaction = rows[0]
    assert transaction.is_holding is False
    assert transaction.transaction_code == "A"
    assert transaction.acquired_disposed == "A"
    assert transaction.shares == 75531.0
    assert transaction.price == 53.09
    assert transaction.value == pytest.approx(75531.0 * 53.09)
    assert transaction.shares_owned_after == 12625397.0
    assert transaction.direct_indirect == "D"
    # Mandatory when ownership is indirect, FORBIDDEN when direct.
    assert transaction.nature_of_ownership is None
    assert len(transaction.footnotes) == 1
    assert transaction.footnotes[0].startswith("Acquisition of deferred shares")

    holding = rows[1]
    assert holding.is_holding is True
    # A holding has no code, no price and no acquired/disposed flag. These are
    # None rather than 0.0 — a zero price would read as a free transfer.
    assert holding.transaction_code is None
    assert holding.price is None
    assert holding.value is None
    assert holding.acquired_disposed is None
    assert holding.shares_owned_after == 287858.0
    assert holding.direct_indirect == "I"
    assert holding.nature_of_ownership == "By Reporting Person's 2012 Trust"


def test_form4_amendment_parses_derivative_rows() -> None:
    """The six derivative columns, and the amendment flag the library lacks.

    edgartools exposes no amendment flag on an Ownership object at all —
    `<documentType>` reads "4" even on a 4/A — so the flag comes from the SGML
    header's submission type.
    """
    cover, rows = ownership_from_bundle(fixture_text("form4_derivative_bundle"))

    assert cover.issuer_ticker == "MNPR"
    assert cover.owner_name == "Tsuchimoto Kim R"
    assert cover.form == "4/A"
    assert cover.is_amendment is True

    assert len(rows) == 11
    derivatives = [r for r in rows if r.is_derivative]
    assert len(derivatives) == 2

    option = derivatives[0]
    assert option.security_title == "Stock Option"
    assert option.transaction_code == "M"
    assert option.underlying_security == "Common Stock"
    assert option.underlying_shares == 2055.0
    assert option.exercise_price == 30.0
    assert option.expiration_date == date(2028, 8, 27)
    assert len(option.footnotes) == 2

    # `row_index` runs across the combined tables and is part of the storage
    # key, because a Form 4 legitimately reports two identical-looking lots.
    assert [r.row_index for r in rows] == list(range(11))


def test_code_meanings_come_from_secs_table_not_the_librarys() -> None:
    """SEC publishes 18 transaction codes. edgartools' table has 13 of them.

    `DESCRIPTIONS` in `edgar/ownership/models.py:86` is missing J, K, L, V and
    W, and a miss there does not raise — it returns the raw letter, so an
    unmapped code stores "L" as its own meaning and looks like data.

    K and V are asserted ABSENT here on purpose. Neither is a transaction code:
    K is what EDGAR appends to a DISPLAYED code when `equitySwapInvolved` is
    set, and V is the printed form's rendering of `transactionTimeliness`.
    Admitting either to this table would invent transaction types.
    """
    assert TRANSACTION_CODES["L"].startswith("Small acquisition")
    assert TRANSACTION_CODES["J"].startswith("Other acquisition or disposition")
    assert TRANSACTION_CODES["W"].startswith("Acquisition or disposition by will")
    assert "K" not in TRANSACTION_CODES
    assert "V" not in TRANSACTION_CODES

    from edgar.ownership.models import TransactionCode

    library_table = set(TransactionCode.DESCRIPTIONS)
    assert {"J", "L", "W"} - library_table == {"J", "L", "W"}
    assert {"J", "L", "W"} <= set(TRANSACTION_CODES)

    _, rows = ownership_from_bundle(fixture_text("form4_derivative_bundle"))
    sale = next(r for r in rows if r.transaction_code == "S")
    assert sale.code_meaning == "Open market or private sale of securities"


def test_equity_swap_is_a_flag_and_both_sec_spellings_are_false() -> None:
    """SEC spells the same boolean two ways across two filings of the same form.

    The Jefferies Form 4 carries `<equitySwapInvolved>false</...>` and the
    Monopar 4/A carries `<equitySwapInvolved>0</...>`. A truth test that
    accepted any non-empty string would read "0" and "false" as True and set
    the flag on every transaction in EDGAR.
    """
    assert b"<equitySwapInvolved>false</" in fixture_bytes("form4_bundle")
    assert b"<equitySwapInvolved>0</" in fixture_bytes("form4_derivative_bundle")

    for name in ("form4_bundle", "form4_derivative_bundle"):
        _, rows = ownership_from_bundle(fixture_text(name))
        assert all(r.equity_swap is False for r in rows)


def test_timeliness_empty_element_means_on_time_not_missing() -> None:
    """`<transactionTimeliness></...>` is ON TIME; only E and L are values.

    edgartools never parses this element — the word appears nowhere in the
    package — so it is parsed here. A late filing is a reportable compliance
    fact, so "on time" must not be stored as the same thing as "unknown".
    """
    assert b"<transactionTimeliness></transactionTimeliness>" in fixture_bytes("form4_bundle")
    _, rows = ownership_from_bundle(fixture_text("form4_bundle"))
    assert all(r.timeliness is None for r in rows)
    assert all(r.timeliness in (None, "E", "L") for r in rows)


# ── 13F ─────────────────────────────────────────────────────────────────────


def test_13f_values_are_returned_as_filed_and_never_normalised() -> None:
    """The unit rule's whole point, as one manager's two filings.

    Both fixtures are Berkshire Hathaway. The 2022 report was FILED before
    2023-01-03 and is denominated in thousands; the 2026 report was filed after
    and is in whole dollars. The two portfolios are worth almost the same
    ($296bn and $299bn), so the FILED numbers differ by three orders of
    magnitude for no economic reason at all.

    The adapter returns both exactly as filed. Applying Release 34-95148 is the
    writer's job, under `valueUnitRule`, and it keys on the FILING date — a
    2023-filed amendment of a 2022 quarter is in dollars while the original was
    in thousands.
    """
    pre_cover, pre_rows = thirteenf_from_bundle(fixture_text("13f_pre"))
    post_cover, post_rows = thirteenf_from_bundle(fixture_text("13f_post"))

    assert pre_cover.filed_at == date(2022, 11, 14)
    assert pre_cover.filed_at < date(2023, 1, 3)
    assert post_cover.filed_at == date(2026, 8, 14)
    assert post_cover.filed_at >= date(2023, 1, 3)

    # AS FILED, untouched.
    assert pre_cover.total_value_as_filed == 296_096_640.0
    assert post_cover.total_value_as_filed == 299_253_556_246.0
    ratio = post_cover.total_value_as_filed / pre_cover.total_value_as_filed
    assert 900 < ratio < 1100, "two ~$300bn portfolios, filed numbers 1000x apart"

    # Apple is in both, with the IDENTICAL share count, which isolates the unit
    # from any change in the position.
    pre_aapl = next(r for r in pre_rows if r.cusip == "037833100")
    post_aapl = next(r for r in post_rows if r.cusip == "037833100")
    assert pre_aapl.shares == post_aapl.shares == 692_000.0
    assert pre_aapl.value_as_filed == 95_634.0
    assert post_aapl.value_as_filed == 200_237_120.0
    # Implied price is the tell: $0.14/share is impossible, $289 is a price.
    assert pre_aapl.value_as_filed / pre_aapl.shares < 1
    assert post_aapl.value_as_filed / post_aapl.shares > 100


def test_13f_reports_the_library_verdict_without_applying_it() -> None:
    """edgartools' opinion is recorded so a disagreement is visible.

    The library infers the unit from implied price per share and would have
    MULTIPLIED the pre-2023 values by 1000 in place, inside
    `ThirteenF.infotable`. We record its verdict in a column and apply the
    official rule instead — a 1000x error here produces a plausible-looking
    portfolio rather than a crash, so silently resolving the two is the worst
    available outcome.
    """
    pre_cover, pre_rows = thirteenf_from_bundle(fixture_text("13f_pre"))
    post_cover, _ = thirteenf_from_bundle(fixture_text("13f_post"))

    assert pre_cover.library_unit_verdict == "THOUSANDS"
    assert post_cover.library_unit_verdict == "DOLLARS"

    # The verdict is reported, and the values are STILL as filed. If the
    # adapter had applied it, this Apple row would read 95_634_000.
    assert next(r for r in pre_rows if r.cusip == "037833100").value_as_filed == 95_634.0


def test_13f_manager_cik_comes_from_the_filing_not_the_cover_page() -> None:
    """The 13F cover page carries a NAME and an address, and no CIK at all.

    A name-keyed join would merge every "Capital Management LLC" in the
    country, so the manager CIK is taken from the filing's own SGML header.
    """
    cover, rows = thirteenf_from_bundle(fixture_text("13f_post"))

    assert cover.manager_cik10 == "0001067983"
    assert cover.manager_name == "Berkshire Hathaway Inc"
    assert cover.period_of_report == date(2026, 6, 30)
    assert cover.total_holdings == 89
    assert len(rows) == 89
    assert cover.other_managers_count == 14

    first = rows[0]
    assert first.cusip == "02005N100"
    assert first.issuer_name == "ALLY FINL INC"
    assert first.shares_type == "SH"
    assert first.investment_discretion == "DFND"
    assert first.other_managers == ("4",)
    assert first.voting_sole == 12_561_737.0

    # `figi` became available to filers in Jan 2023 and is OPTIONAL. Berkshire
    # omits it on every row, which is exactly why the CUSIP map needs three
    # more tiers behind it.
    assert all(r.figi is None for r in rows)


def test_13f_amendment_carries_its_type() -> None:
    """RESTATEMENT replaces holdings; NEW HOLDINGS adds to them.

    Applying the wrong one either doubles a portfolio or erases most of it, so
    the distinction has to survive parsing rather than be inferred later from
    row counts.
    """
    cover, rows = thirteenf_from_bundle(fixture_text("13f_amend"))

    assert cover.form == "13F-HR/A"
    assert cover.is_amendment is True
    assert cover.amendment_type == "NEW HOLDINGS"
    assert cover.amendment_number == 1
    assert cover.period_of_report == date(2025, 3, 31)
    assert len(rows) == 4
    assert rows[0].issuer_name == "D R HORTON INC"


# ── Schedules 13D / 13G ─────────────────────────────────────────────────────


def test_schedule_13d_after_the_xml_mandate_is_fully_structured() -> None:
    cover, rows = schedule13_from_bundle(fixture_text("schedule13d_bundle"))

    assert cover.schedule == "13D"
    assert cover.form == "SCHEDULE 13D"  # post-mandate spelling
    assert cover.has_structured_data is True
    assert cover.subject_cik10 == "0001894954"
    assert cover.subject_name == "Expion Energy, Inc."
    # A CUSIP and a CIK published together by the filer: the first and only
    # primary-source tier of the CUSIP map.
    assert cover.cusip == "30218B209"
    assert cover.event_date == date(2026, 8, 21)
    assert cover.purpose_text is not None
    assert "acquired for investment purposes" in cover.purpose_text

    assert len(rows) == 4
    assert rows[0].filer_name == "Five Narrow Lane, LP"
    assert rows[0].filer_cik10 == "0001927401"
    assert rows[0].percent_of_class == 9.99
    assert rows[0].sole_voting == 96317.0
    assert rows[0].shared_voting == 0.0
    assert rows[0].type_of_reporting_person == "OO"
    # A reporting person without a CIK is stored as None, never as a CIK of
    # ten zeroes.
    assert rows[1].filer_cik10 is None
    assert rows[2].shared_voting == 96137.0
    assert rows[2].sole_voting == 0.0


def test_legacy_schedule_13g_yields_identities_and_says_so() -> None:
    """Pre-mandate filings are HTML; `has_structured_data` is the difference.

    Without the flag, a null `percent_of_class` on a 2022 filing is
    indistinguishable from a real zero. The identities still come back, because
    the subject CIK is the input the CUSIP map's first tier needs.
    """
    cover, rows = schedule13_from_bundle(fixture_text("schedule13g_legacy"))

    assert cover.schedule == "13G"
    assert cover.form == "SC 13G"  # pre-mandate spelling
    assert cover.has_structured_data is False
    assert cover.subject_cik10 == "0001841734"
    assert cover.subject_name == "Glass Houses Acquisition Corp."
    assert cover.filed_at == date(2022, 2, 14)

    assert len(rows) == 1
    assert rows[0].filer_name == "11 Capital Partners LP"
    assert rows[0].filer_cik10 == "0001801172"
    # Not machine-readable, therefore None — NOT zero.
    assert rows[0].percent_of_class is None
    assert rows[0].shares_owned is None


# ── 8-K ─────────────────────────────────────────────────────────────────────


def test_eightk_maps_header_descriptions_to_item_numbers() -> None:
    """Items come from the SGML header, mapped through SEC's own item table.

    The header publishes DESCRIPTIONS ("Results of Operations and Financial
    Condition") while every consumer uses NUMBERS ("2.02"). `EightK.items`
    would answer this, but it walks `filing.html()` -> `filing.homepage` and
    issues a live SEC request even for a filing built from local bytes — which
    succeeds in development and fails exactly where egress is off.
    """
    raw = fixture_bytes("eightk_bundle")
    assert b"ITEM INFORMATION:\t\tResults of Operations and Financial Condition" in raw

    meta, docs = eightk_from_bundle(fixture_text("eightk_bundle"))

    assert meta.cik10 == "0001420720"
    assert meta.form == "8-K"
    assert meta.items == ("2.02", "9.01")
    assert meta.filed_at == date(2026, 8, 28)
    # `<ACCEPTANCE-DATETIME>` is stamped in US Eastern and normalised to UTC:
    # 08:30:48 EDT is 12:30:48 UTC. `filedAt` is a calendar day and cannot
    # measure latency — a filing accepted at 21:53 ET is dated the next day.
    assert meta.accepted_at == datetime.fromisoformat("2026-08-28T12:30:48+00:00")

    primary = next(d for d in docs if d.sequence == 1)
    assert primary.document_type == "8-K"
    assert primary.filename == "ibio-20260828x8k.htm"

    exhibit = next(d for d in docs if d.document_type == "EX-99.1")
    assert exhibit.sequence == 2
    assert exhibit.filename == "ibio-20260828xex99d1.htm"
    assert exhibit.text is not None
    assert "iBio Reports Fiscal Year 2026 Financial Results" in exhibit.text
    assert exhibit.text_bytes == len(exhibit.text.encode("utf-8"))
    assert exhibit.text_hash is not None and len(exhibit.text_hash) == 64

    # The XBRL linkbases are neither exhibits nor content.
    assert not any(d.document_type.startswith("EX-101") for d in docs)


# ── 8-K: PDF exhibits (MONEY-1350) ──────────────────────────────────────────


def _pdf(pages: list[list[str]]) -> bytes:
    """A minimal but VALID PDF, one content stream per page.

    Hand-built rather than produced by pypdf's writer, which cannot DRAW text —
    it can only copy or blank a page — so a writer-made fixture could only ever
    exercise the no-text-layer half. The bytes are a real PDF: `%PDF` header,
    object table, xref with true byte offsets and a trailer, so pypdf parses it
    through its normal path and not through its damaged-file recovery.

    A page with no lines yields a content stream that shows nothing, which is
    what a scanned exhibit looks like to a text extractor.
    """
    count = len(pages)
    streams = []
    for lines in pages:
        ops = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL"]
        for line in lines:
            ops.append(f"({line}) Tj")
            ops.append("T*")
        ops.append("ET")
        streams.append("\n".join(ops).encode("ascii"))

    page_ids = list(range(3, 3 + count))
    content_ids = list(range(3 + count, 3 + 2 * count))
    font_id = 3 + 2 * count
    kids = " ".join(f"{i} 0 R" for i in page_ids)

    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids.encode("ascii"), count),
    ]
    for content_id in content_ids:
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (font_id, content_id)
        )
    for stream in streams:
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    start_xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        start_xref,
    )
    return bytes(out)


def bundle_with_pdf(data: bytes, *, filename: str = "ibio-20260828xex99d2.pdf") -> str:
    """The REAL 8-K bundle with one extra PDF exhibit, uuencoded as EDGAR does.

    Spliced into the captured filing rather than hand-writing a whole SGML
    submission, so the walk under test is the one that runs in production: the
    same `Filing.from_sgml_text`, the same attachment list, the same uudecode
    that already carries the `-xbrl.zip` in this very fixture (`begin 644 ...`).
    """
    lines = [f"begin 644 {filename}"]
    for start in range(0, len(data), 45):
        lines.append(binascii.b2a_uu(data[start : start + 45]).decode("ascii").rstrip("\n"))
    lines += ["`", "end", ""]
    block = (
        "<DOCUMENT>\n<TYPE>EX-99.2\n<SEQUENCE>17\n"
        f"<FILENAME>{filename}\n<DESCRIPTION>EX-99.2\n<TEXT>\n"
        + "\n".join(lines)
        + "</TEXT>\n</DOCUMENT>\n"
    )
    return fixture_text("eightk_bundle").replace("</SEC-DOCUMENT>", block + "</SEC-DOCUMENT>")


def test_a_pdf_exhibit_yields_text_where_the_library_yields_none() -> None:
    """edgartools cannot render a PDF, so without this the exhibit is a
    PERMANENT gap — not a slow one.

    `Attachment.text()` answers None for any extension outside its text set, so
    9 of 5,377 prod rows (2026-09-05) carried `textPath: null` that no reparse
    would ever fill: 8 foreign-issuer 6-K exhibits and one 8-K. The control is
    asserted in the same test — the library really does return None for these
    bytes — because a fallback that fires when the primary path already worked
    proves nothing.
    """
    data = _pdf([["iBio Reports Fiscal Year 2026", "Revenue of 12,345"]])
    bundle = bundle_with_pdf(data)

    from edgar import Filing

    attachment = next(
        a for a in Filing.from_sgml_text(bundle).attachments if str(a.document).endswith(".pdf")
    )
    assert attachment.text() is None, "premise: the library would have rendered this after all"
    assert attachment.download()[:4] == b"%PDF"

    meta, docs = eightk_from_bundle(bundle)
    exhibit = next(d for d in docs if d.filename.endswith(".pdf"))

    assert exhibit.text is not None
    assert "iBio Reports Fiscal Year 2026" in exhibit.text
    assert "Revenue of 12,345" in exhibit.text
    assert exhibit.text_bytes == len(exhibit.text.encode("utf-8"))
    assert exhibit.text_hash is not None and len(exhibit.text_hash) == 64
    assert (meta.pdf_text_extracted, meta.pdf_no_text_layer) == (1, 0)


def test_a_pdf_with_no_text_layer_stays_a_gap_and_says_so() -> None:
    """A scanned exhibit has nothing to extract, and inventing an empty string
    would make it indistinguishable from one we simply have not tried.

    The row still lands with `text=None` — the visible, refillable gap — and the
    outcome carries the count, so "this filing had one fewer exhibit than we
    thought" and "one exhibit had no text layer" are not the same number.
    """
    meta, docs = eightk_from_bundle(bundle_with_pdf(_pdf([[]])))
    exhibit = next(d for d in docs if d.filename.endswith(".pdf"))

    assert (exhibit.text, exhibit.text_bytes, exhibit.text_hash) == (None, None, None)
    assert (meta.pdf_text_extracted, meta.pdf_no_text_layer) == (0, 1)


def test_a_pdf_is_recognised_by_its_BYTES_when_the_filename_does_not_say_pdf() -> None:
    """The extension is filer-supplied free text — the same reason the image
    refusal reads EDGAR's TYPE instead of the filename."""
    meta, docs = eightk_from_bundle(
        bundle_with_pdf(_pdf([["Exhibit 99.2 press release"]]), filename="ibio-ex99d2.dat")
    )
    exhibit = next(d for d in docs if d.filename.endswith(".dat"))

    assert exhibit.text is not None and "press release" in exhibit.text
    assert (meta.pdf_text_extracted, meta.pdf_no_text_layer) == (1, 0)


def test_page_boundaries_are_MARKED_not_silently_concatenated() -> None:
    """A table split across a page break otherwise reads as one continuous run
    of numbers, and nothing in the stored text says where the seam was."""
    text = pdf_text(_pdf([["first page total 100"], ["second page total 200"]]))

    assert text is not None
    assert "<!-- page 2 -->" in text
    assert text.index("first page total 100") < text.index("<!-- page 2 -->")
    assert text.index("<!-- page 2 -->") < text.index("second page total 200")
    assert "<!-- page 1 -->" not in text, "the first page follows no marker"


def test_unreadable_bytes_are_a_gap_and_never_an_exception() -> None:
    """A corrupt or encrypted PDF must not take the whole filing down with it.

    It counts as recovered-nothing, alongside the scanned case: both leave the
    exhibit a gap and the row records it the same way, so separating them would
    be two counters an operator could not act on differently.
    """
    assert pdf_text(b"%PDF-1.4\nnot actually a pdf") is None


# ── the property the whole design rests on ──────────────────────────────────


def test_no_adapter_function_touches_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every parser runs with sockets blocked.

    This is not belt-and-braces. Three edgartools entry points that LOOK pure
    reach sec.gov — `Ownership.parse_xml` fetches an Entity per reporting
    owner, `parse_infotable_xml` downloads a CUSIP-to-ticker map, and
    `EightK.items` walks to the filing homepage — and each was found by exactly
    this check rather than by reading the signatures. A fetch from here would
    also bypass the shared 9 req/s limiter that `app/sec/client.py` owns, which
    is how an IP gets blocked for ten minutes.
    """

    class BlockedSocket(socket.socket):
        def connect(self, *args, **kwargs):
            raise AssertionError(f"adapter attempted a network connection: {args!r}")

        def connect_ex(self, *args, **kwargs):
            raise AssertionError(f"adapter attempted a network connection: {args!r}")

    monkeypatch.setattr(socket, "socket", BlockedSocket)

    assert statements_from_bundle(fixture_text("tenk_bundle_aapl")) is not None
    assert ownership_from_bundle(fixture_text("form4_derivative_bundle"))[1]
    assert thirteenf_from_bundle(fixture_text("13f_post"))[1]
    assert schedule13_from_bundle(fixture_text("schedule13d_bundle"))[1]
    assert schedule13_from_bundle(fixture_text("schedule13g_legacy"))[1]
    assert eightk_from_bundle(fixture_text("eightk_bundle"))[1]
    # The PDF fallback calls `Attachment.download()`, whose `content`
    # property falls through to `download_file(self.url)` for an attachment
    # that did NOT come from SGML. Every one here does — this is what keeps
    # that true rather than the comment saying so.
    assert eightk_from_bundle(bundle_with_pdf(_pdf([["network-free"]])))[0].pdf_text_extracted == 1
    assert parse_current_filings_atom(fixture_bytes("atom_getcurrent"))
    assert parse_efts_response(fixture_json("efts_8k_search"))
    assert parse_daily_index(fixture_bytes("daily_index_20220214").decode("latin-1"))
    assert parse_submissions_json(fixture_json("submissions_berkshire"))[1]
    assert facts_from_companyfacts_json(fixture_json("companyfacts_aapl"))


def test_every_fixture_matches_its_recorded_sha256() -> None:
    """The corpus is the evidence. A silently edited fixture is a forged one."""
    import hashlib

    for name, entry in MANIFEST.items():
        raw = gzip.decompress((FIXTURES / entry["file"]).read_bytes())
        assert len(raw) == entry["bytes"], f"{name}: byte count drifted"
        assert hashlib.sha256(raw).hexdigest() == entry["sha256"], f"{name}: content changed"


# ── SEC puts NULLS inside its string arrays ─────────────────────────────────


def test_a_null_inside_exchanges_does_not_abort_the_run() -> None:
    """THE PROD FAILURE, 2026-08-29.

    A filer in `submissions.zip` carried `exchanges: [null]`. `UsFilerRow`
    declares `exchangesAsFiled: list[str]`, so pydantic refused the row and took
    the WHOLE bulk run down:

        ValidationError: exchangesAsFiled.0 — Input should be a valid string
        [input_value=None, input_type=NoneType]

    The strict model is not the defect — it is what surfaced this instead of
    letting `None` into a column every reader would then have to guard. The
    BOUNDARY drops the null so the strictness can stay.
    """
    from app.sec.edgar_adapter import _clean_str_tuple

    assert _clean_str_tuple([None]) == ()
    assert _clean_str_tuple(["NYSE", None, "Nasdaq"]) == ("NYSE", "Nasdaq")


def test_blanks_and_whitespace_are_dropped_too() -> None:
    from app.sec.edgar_adapter import _clean_str_tuple

    assert _clean_str_tuple(["", "  ", "NYSE"]) == ("NYSE",)
    assert _clean_str_tuple([" NYSE "]) == ("NYSE",)


def test_a_non_string_is_coerced_rather_than_raising() -> None:
    """A numeric ticker would fail the model the same way a null does."""
    from app.sec.edgar_adapter import _clean_str_tuple

    assert _clean_str_tuple([123]) == ("123",)


def test_a_missing_or_wrong_shaped_field_is_an_empty_tuple() -> None:
    from app.sec.edgar_adapter import _clean_str_tuple

    for bad in (None, "NYSE", {"a": 1}, 7):
        assert _clean_str_tuple(bad) == ()


def test_the_row_model_still_REFUSES_a_null_if_the_boundary_is_bypassed() -> None:
    """The guard that caught this must stay strict.

    If `exchangesAsFiled` were widened to `list[str | None]` the run would
    survive and the null would land in the column, which is worse: every reader
    would need a guard and none would know why.
    """
    import pytest as _pytest
    from pydantic import ValidationError as _ValidationError

    from app.store.models import UsFilerRow

    with _pytest.raises(_ValidationError):
        UsFilerRow(cik10="0000320193", name="Apple Inc.", exchangesAsFiled=[None])
