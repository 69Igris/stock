"""Forms 3/4/5 -> ``us_insider_transactions`` — MONEY-979 T7.

Both fixtures are real filings. Jefferies' Form 4 is one grant plus twelve
indirect HOLDINGS, which is what makes it the right fixture: a parser that
stored only transactions would report this filing as a single row and look
entirely healthy. Monopar's 4/A carries the derivative half — option exercises
with an underlying security, a strike and an expiry — and, incidentally, two
rows whose value is a REAL zero, which is the other half of the gift rule.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

from app.parsers import ownership_logic
from app.parsers.dispatch import parse_and_store
from app.sec.edgar_adapter import TRANSACTION_CODES, ownership_from_bundle

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_text(name: str) -> str:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


JEFFERIES = "0001214659-26-011109"
MONOPAR = "0001683168-26-006586"


def jefferies_rows() -> list[dict]:
    cover, rows = ownership_from_bundle(fixture_text("form4_bundle"))
    return ownership_logic.build_rows(
        cover,
        rows,
        accession=JEFFERIES,
        filed_at=date(2026, 8, 28),
        accepted_at=datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC),
        symbol="JEF",
        parser_version="test",
    )


# ── transactions AND holdings ───────────────────────────────────────────────


def test_holdings_are_stored_beside_transactions() -> None:
    """13 rows: one grant and twelve indirect holdings.

    Form 3 is holdings almost entirely, so a parser that dropped them would
    make an initial statement of ownership look like a filing with nothing in
    it — and counting them as trades would overstate insider activity by twelve
    to one on this filing alone.
    """
    rows = jefferies_rows()
    assert len(rows) == 13
    assert sum(1 for row in rows if row["isHolding"]) == 12
    assert sum(1 for row in rows if not row["isHolding"]) == 1

    holding = rows[1]
    assert holding["transactionCode"] is None
    assert holding["acquiredDisposed"] is None
    assert holding["shares"] is None
    assert holding["sharesOwnedAfter"] == 287858.0
    assert holding["directIndirect"] == "I"
    # MANDATORY when ownership is indirect, per SEC's own rule.
    assert holding["natureOfOwnership"] == "By Reporting Person's 2012 Trust"


def test_the_grant_row_carries_the_hand_checked_economics() -> None:
    """75,531 shares at $53.09 = $4,009,940.79, from the filing itself."""
    row = jefferies_rows()[0]
    assert row["transactionCode"] == "A"
    assert row["codeMeaning"] == TRANSACTION_CODES["A"]
    assert row["acquiredDisposed"] == "A"
    assert row["shares"] == 75531.0
    assert row["price"] == 53.09
    assert row["value"] == 75531.0 * 53.09
    assert row["sharesOwnedAfter"] == 12625397.0
    assert row["footnotes"] and "dividend reinvestment" in row["footnotes"][0]


# ── the value rule ──────────────────────────────────────────────────────────


def test_a_gift_with_no_price_stores_value_None_not_zero() -> None:
    """Code G has no price. A stored ``0`` reads as a free transfer of NOTHING.

    The row is a real ``OwnershipRow`` built to the shape a gift actually takes
    — shares present, price absent, so the adapter's ``shares x price when both
    exist`` rule already produced ``None`` — and the assertion is that the
    writer PASSES IT THROUGH. ``row.value or 0.0`` is the one-character version
    of this bug and turns this test red.
    """
    cover, rows = ownership_from_bundle(fixture_text("form4_bundle"))
    gift = replace(
        rows[0],
        transaction_code="G",
        code_meaning=TRANSACTION_CODES["G"],
        shares=500.0,
        price=None,
        value=None,
    )
    built = ownership_logic.build_rows(
        cover,
        [gift],
        accession=JEFFERIES,
        filed_at=date(2026, 8, 28),
        accepted_at=None,
        symbol="JEF",
        parser_version="test",
    )
    assert built[0]["transactionCode"] == "G"
    assert built[0]["shares"] == 500.0
    assert built[0]["price"] is None
    assert built[0]["value"] is None


def test_a_real_zero_survives_as_zero() -> None:
    """The other half of the same rule, and the reason ``or None`` is wrong too.

    Monopar's option exercises are priced at 0.00 — the strike is paid through
    the derivative, not in cash — so their value IS zero. A parser that mapped
    falsy to ``None`` would erase a fact the filing states.
    """
    cover, rows = ownership_from_bundle(fixture_text("form4_derivative_bundle"))
    built = ownership_logic.build_rows(
        cover,
        rows,
        accession=MONOPAR,
        filed_at=date(2026, 8, 27),
        accepted_at=None,
        symbol="MNPR",
        parser_version="test",
    )
    exercises = [row for row in built if row["isDerivative"] and row["price"] == 0.0]
    assert exercises, "fixture no longer carries a zero-priced derivative row"
    for row in exercises:
        assert row["value"] == 0.0
        assert row["value"] is not None


# ── K and V are not codes ───────────────────────────────────────────────────


def test_the_code_table_holds_no_K_and_no_V() -> None:
    """``K`` is EDGAR appending ``<equitySwapInvolved>``; ``V`` is
    ``<transactionTimeliness>``. Neither is a transaction type, and folding
    either back into the code column invents transactions that never happened."""
    assert "K" not in TRANSACTION_CODES
    assert "V" not in TRANSACTION_CODES
    for row in jefferies_rows():
        assert row["transactionCode"] in (None, *TRANSACTION_CODES)
        assert row["timeliness"] in (None, "E", "L")
        assert isinstance(row["equitySwap"], bool)


def test_an_equity_swap_is_a_flag_and_leaves_the_code_alone() -> None:
    cover, rows = ownership_from_bundle(fixture_text("form4_bundle"))
    swapped = replace(rows[0], equity_swap=True)
    built = ownership_logic.build_rows(
        cover,
        [swapped],
        accession=JEFFERIES,
        filed_at=date(2026, 8, 28),
        accepted_at=None,
        symbol="JEF",
        parser_version="test",
    )
    assert built[0]["equitySwap"] is True
    assert built[0]["transactionCode"] == "A"
    assert "K" not in (built[0]["transactionCode"] or "")


# ── derivative columns ──────────────────────────────────────────────────────


def test_derivative_rows_carry_the_underlying_and_the_strike() -> None:
    cover, rows = ownership_from_bundle(fixture_text("form4_derivative_bundle"))
    built = ownership_logic.build_rows(
        cover,
        rows,
        accession=MONOPAR,
        filed_at=date(2026, 8, 27),
        accepted_at=None,
        symbol="MNPR",
        parser_version="test",
    )
    options = [row for row in built if row["securityTitle"] == "Stock Option"]
    assert len(options) == 2
    first = options[0]
    assert first["isDerivative"] is True
    assert first["underlyingSecurity"] == "Common Stock"
    assert first["underlyingShares"] == 2055.0
    assert first["exercisePrice"] == 30.0
    assert first["expirationDate"] == datetime(2028, 8, 27, tzinfo=UTC)
    assert first["isAmendment"] is True
    assert cover.form == "4/A"


# ── symbol resolution ───────────────────────────────────────────────────────


def test_sec_spells_share_classes_with_a_slash_and_we_do_not() -> None:
    assert ownership_logic.normalise_symbol("BRK/B") == "BRK-B"
    assert ownership_logic.normalise_symbol("BRK.B") == "BRK-B"
    assert ownership_logic.normalise_symbol(" brk/b ") == "BRK-B"
    assert ownership_logic.normalise_symbol("") is None
    assert ownership_logic.normalise_symbol(None) is None


def test_the_issuer_ticker_picks_its_listing_out_of_a_multi_ticker_cik() -> None:
    """BAC has 16 tickers on one CIK; the filer names the one it means."""
    candidates = [{"symbol": "BRK-A"}, {"symbol": "BRK-B"}]
    assert ownership_logic.resolve_symbol("BRK/B", candidates) == "BRK-B"


def test_a_single_active_listing_needs_no_ticker() -> None:
    assert ownership_logic.resolve_symbol(None, [{"symbol": "JEF"}]) == "JEF"


def test_an_ambiguous_cik_resolves_to_None_rather_than_a_guess() -> None:
    """A wrong symbol attaches one company's insider activity to another, and
    nothing downstream can tell it from a right one. The null is recoverable —
    the CIK is on every row."""
    candidates = [{"symbol": "BAC"}, {"symbol": "BAC-PB"}, {"symbol": "BAC-PK"}]
    assert ownership_logic.resolve_symbol(None, candidates) is None
    assert ownership_logic.resolve_symbol("NOT-LISTED", candidates) is None


def test_no_active_listing_is_a_null_symbol_not_a_failure() -> None:
    assert ownership_logic.resolve_symbol("JEF", []) is None


# ── storage shape ───────────────────────────────────────────────────────────


def test_every_date_is_a_timezone_aware_datetime() -> None:
    """BSON HAS NO DATE TYPE. pymongo raises ``InvalidDocument`` on a bare
    ``datetime.date``, and a naive datetime is worse — it is accepted and then
    silently reinterpreted as local time by whatever reads it next."""
    for row in jefferies_rows():
        for field in (
            "filedAt",
            "reportingPeriod",
            "acceptedAt",
            "transactionDate",
            "exerciseDate",
            "expirationDate",
        ):
            value = row[field]
            if value is None:
                continue
            assert isinstance(value, datetime), field
            assert not isinstance(value, date) or isinstance(value, datetime)
            assert value.tzinfo is not None, field


def test_row_index_is_the_key_and_never_collapses_duplicate_economics() -> None:
    """A Form 4 legitimately reports the same security, code, date, share count
    and price twice — two lots, two footnotes. Any "natural" key over the
    economics would silently merge them."""
    rows = jefferies_rows()
    assert [row["rowIndex"] for row in rows] == list(range(13))
    assert len({(row["accession"], row["rowIndex"]) for row in rows}) == 13


def test_provenance_is_on_every_row() -> None:
    for row in jefferies_rows():
        assert row["source"] == "SEC_EDGAR"
        assert row["parserVersion"] == "test"
        assert row["accession"] == JEFFERIES
        assert row["issuerCik10"] == "0000096223"
        assert row["ownerCik10"] == "0001211677"


def test_the_transaction_holding_split_is_counted() -> None:
    _, rows = ownership_from_bundle(fixture_text("form4_bundle"))
    assert ownership_logic.count_holdings(rows) == (1, 12)


# ── through the seam ────────────────────────────────────────────────────────


def test_through_dispatch_the_rows_land_in_one_collection_on_one_key() -> None:
    from tests.test_dispatch import RecordingWriter, StubLookups

    writer = RecordingWriter()
    outcome = parse_and_store(
        JEFFERIES,
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        form="4",
        writer=writer,
        lookups=StubLookups(instruments={"0000096223": [{"symbol": "JEF"}]}),
        apply=True,
    )
    assert outcome["rows"] == {"insider_transactions": 13}
    collection, rows, key = writer.upserts[0]
    assert collection == "insider_transactions"
    assert key == ("accession", "rowIndex")
    assert all(row["symbol"] == "JEF" for row in rows)


def test_parsing_twice_produces_identical_rows() -> None:
    """Idempotence at the row level: the same bytes must upsert to the same
    documents, or a reparse doubles a table keyed on (accession, rowIndex)."""
    assert jefferies_rows() == jefferies_rows()

