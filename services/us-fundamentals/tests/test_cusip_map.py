"""The four-tier CUSIP map — MONEY-979 T7.

13F reports positions by CUSIP and nothing else, and no official SEC file maps
one to a ticker. So resolution is layered, strongest first, and the property
that matters most is NEGATIVE: **a lower tier may never overwrite a higher
one**. ``UsCusipMap.source`` exists so a wrong mapping is traceable to the
mechanism that produced it, and a nightly OpenFIGI sweep silently replacing a
13D/G-sourced row would erase exactly that.

The second property is that "we could not determine" is its own value.
``SEC_FTD`` has no archive yet (T8 owns ``edgar-bulk-ftd``) and reports
``unavailable`` rather than zero hits; an unresolved CUSIP is a ROW with an
``attempts`` count rather than a silence, so the weekly retry has a population
and the coverage gate has a denominator.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from app.parsers import cusip_map
from app.parsers import cusip_map_logic as logic

APPLE = "037833100"
BERKSHIRE_B = "084670702"
EXPION = "30218B209"
NOW = datetime(2026, 8, 29, tzinfo=UTC)


class FakeSources:
    """In-memory stand-in for the Mongo reads. Records what each tier asked for."""

    def __init__(
        self,
        subjects: dict[str, dict[str, Any]] | None = None,
        figis: dict[str, str] | None = None,
        by_cik: dict[str, list[dict[str, Any]]] | None = None,
        by_figi: dict[str, dict[str, Any]] | None = None,
        by_symbol: dict[str, dict[str, Any]] | None = None,
        existing: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self._subjects = subjects or {}
        self._figis = figis or {}
        self._by_cik = by_cik or {}
        self._by_figi = by_figi or {}
        self._by_symbol = by_symbol or {}
        self._existing = existing or {}
        self.asked: list[tuple[str, list[str]]] = []

    def subject_ciks(self, cusips):
        self.asked.append(("subject_ciks", list(cusips)))
        return {c: self._subjects[c] for c in cusips if c in self._subjects}

    def figis(self, cusips):
        self.asked.append(("figis", list(cusips)))
        return {c: self._figis[c] for c in cusips if c in self._figis}

    def instruments_by_cik(self, ciks):
        return {c: self._by_cik[c] for c in ciks if c in self._by_cik}

    def instruments_by_figi(self, figis):
        return {f: self._by_figi[f] for f in figis if f in self._by_figi}

    def instruments_by_symbol(self, symbols):
        self.asked.append(("instruments_by_symbol", list(symbols)))
        return {s: self._by_symbol[s] for s in symbols if s in self._by_symbol}

    def existing(self, cusips):
        return {c: self._existing[c] for c in cusips if c in self._existing}


class FakeOpenFigi:
    def __init__(self, matches: dict[str, dict[str, Any]]) -> None:
        self.matches = matches
        self.asked: list[list[str]] = []

    def map_cusips(self, cusips):
        self.asked.append(list(cusips))
        return {c: self.matches[c] for c in cusips if c in self.matches}


class RecordingWriter:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.keys: list[tuple[str, ...]] = []

    def upsert_rows(self, collection, rows, *, key) -> int:
        assert collection == "cusip_map"
        self.rows.extend(dict(row) for row in rows)
        self.keys.append(tuple(key))
        return len(rows)


# ── precedence ──────────────────────────────────────────────────────────────


def test_the_tier_order_is_three_primary_sources_before_any_third_party() -> None:
    assert logic.TIER_ORDER == ("SEC_13DG", "TIINGO_FIGI", "SEC_FTD", "OPENFIGI")


@pytest.mark.parametrize(
    ("existing", "new", "allowed"),
    [
        (None, "OPENFIGI", True),
        ("UNRESOLVED", "OPENFIGI", True),
        ("SEC_13DG", "SEC_13DG", True),
        ("OPENFIGI", "SEC_FTD", True),
        ("OPENFIGI", "SEC_13DG", True),
        ("SEC_13DG", "TIINGO_FIGI", False),
        ("SEC_13DG", "OPENFIGI", False),
        ("SEC_FTD", "OPENFIGI", False),
        ("TIINGO_FIGI", "SEC_FTD", False),
    ],
)
def test_a_lower_tier_never_overwrites_a_higher_one(
    existing: str | None, new: str, allowed: bool
) -> None:
    """Equal ranks pass — that is the same tier re-resolving, which is a
    refresh. An UNRESOLVED row is replaceable by anything, which is what turns a
    recorded failure into a resolution instead of a duplicate."""
    assert logic.may_overwrite(existing, new) is allowed


def test_an_unknown_source_ranks_last() -> None:
    """A tier added later can fill a gap but can never displace a primary source
    just by existing — the same rule as ``FINANCIALS_AUTHORITY`` on the India
    side."""
    assert logic.tier_rank("SOMETHING_NEW") == len(logic.TIER_ORDER)
    assert logic.tier_rank(None) == len(logic.TIER_ORDER)
    assert logic.may_overwrite("OPENFIGI", "SOMETHING_NEW") is False


def test_plan_writes_drops_the_weaker_candidate_and_keeps_the_stronger() -> None:
    candidates = {
        APPLE: logic.resolution_row(APPLE, source="OPENFIGI", symbol="AAPL"),
        EXPION: logic.resolution_row(EXPION, source="SEC_13DG", cik10="0001894954"),
    }
    existing = {
        APPLE: {"cusip": APPLE, "source": "SEC_13DG", "symbol": "AAPL", "attempts": 0},
        EXPION: {"cusip": EXPION, "source": "OPENFIGI", "symbol": "XPON", "attempts": 2},
    }
    writes = {row["cusip"]: row for row in logic.plan_writes(candidates, existing)}
    assert APPLE not in writes
    assert writes[EXPION]["source"] == "SEC_13DG"


def test_attempts_accumulate_across_sweeps() -> None:
    """A CUSIP three tiers have now failed on is a different coverage story from
    one nobody has tried."""
    candidates = {APPLE: logic.resolution_row(APPLE, source=logic.UNRESOLVED, attempts=1)}
    existing = {APPLE: {"cusip": APPLE, "source": "UNRESOLVED", "attempts": 4}}
    writes = logic.plan_writes(candidates, existing)
    assert writes[0]["attempts"] == 5


# ── row shape ───────────────────────────────────────────────────────────────


def test_an_unresolved_row_carries_lastTriedAt_and_no_resolvedAt() -> None:
    """ "We asked and nobody knew" is a different stored state from "we never
    asked"."""
    row = logic.resolution_row(APPLE, source=logic.UNRESOLVED, attempts=1, last_tried_at=NOW)
    assert row["source"] == "UNRESOLVED"
    assert row["resolvedAt"] is None
    assert row["lastTriedAt"] == NOW
    assert row["confidence"] == 0.0
    assert row["attempts"] == 1


def test_a_tier_that_produced_nothing_is_recorded_as_unresolved() -> None:
    """A row claiming ``SEC_FTD`` with no symbol, no CIK and no FIGI would be a
    tier taking credit for an answer it did not give."""
    row = logic.resolution_row(APPLE, source="SEC_FTD")
    assert row["source"] == "UNRESOLVED"
    assert row["confidence"] == 0.0


def test_the_identifier_joined_tiers_are_full_confidence() -> None:
    """Confidence never PICKS between tiers — the order does that — it flags a
    row for review. OpenFIGI's ``exchCode: US`` is a venue match rather than an
    identifier match, so it is marked lower."""
    assert logic.resolution_row(APPLE, source="SEC_13DG", cik10="x")["confidence"] == 1.0
    assert logic.resolution_row(APPLE, source="OPENFIGI", symbol="AAPL")["confidence"] == 0.9


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("037833100", "037833100"),
        (" 037833100 ", "037833100"),
        ("30218b209", "30218B209"),
        ("0378331", None),
        ("", None),
        (None, None),
        ("037833100X", None),
        ("03783/100", None),
    ],
)
def test_a_cusip_is_nine_alphanumeric_characters(raw: str | None, expected: str | None) -> None:
    """Rejecting keeps ``us_cusip_map`` from accumulating rows keyed on
    truncated identifiers, each retried weekly forever and counted against
    coverage."""
    assert logic.normalise_cusip(raw) == expected


def test_distinct_cusips_normalises_dedupes_and_preserves_order() -> None:
    assert logic.distinct_cusips([" 037833100", "037833100", "bad", None, "30218B209"]) == [
        "037833100",
        "30218B209",
    ]


# ── the tiers, end to end ───────────────────────────────────────────────────


def test_tier_a_resolves_from_our_own_13dg_cover_pages() -> None:
    sources = FakeSources(
        subjects={EXPION: {"subjectCik10": "0001894954", "subjectName": "Expion Energy, Inc."}},
        by_cik={"0001894954": [{"symbol": "XPON", "cik": "0001894954"}]},
    )
    report = cusip_map.resolve_cusips([EXPION], sources=sources, now=NOW)
    row = report["resolutions"][EXPION]
    assert row["source"] == "SEC_13DG"
    assert row["symbol"] == "XPON"
    assert row["cik10"] == "0001894954"
    assert row["issuerName"] == "Expion Energy, Inc."
    assert report["byTier"]["SEC_13DG"] == 1


def test_tier_a_stores_the_cik_even_when_the_listing_is_ambiguous() -> None:
    """A CIK with several ACTIVE tickers cannot name one listing — BAC has 16 —
    so the symbol stays null while the CIK, which IS unambiguous, is kept."""
    sources = FakeSources(
        subjects={EXPION: {"subjectCik10": "0000070858", "subjectName": "Bank of America"}},
        by_cik={"0000070858": [{"symbol": "BAC"}, {"symbol": "BAC-PB"}]},
    )
    row = cusip_map.resolve_cusips([EXPION], sources=sources, now=NOW)["resolutions"][EXPION]
    assert row["source"] == "SEC_13DG"
    assert row["symbol"] is None
    assert row["cik10"] == "0000070858"


def test_tier_b_is_measured_weak_and_its_hit_rate_is_reported() -> None:
    """T4 measured the 13F ``figi`` column GENUINELY ABSENT — Berkshire omits it
    on all 89 rows of its 2026 filing. A tier that resolves nothing must be
    distinguishable from a tier that was never reached, so the report carries
    per-tier counts and rates even when they are zero."""
    sources = FakeSources(
        figis={APPLE: "BBG000B9XRY4"},
        by_figi={"BBG000B9XRY4": {"symbol": "AAPL", "cik": "0000320193"}},
    )
    report = cusip_map.resolve_cusips([APPLE, BERKSHIRE_B], sources=sources, now=NOW)

    assert report["resolutions"][APPLE]["source"] == "TIINGO_FIGI"
    assert report["resolutions"][APPLE]["compositeFigi"] == "BBG000B9XRY4"
    # The one with no `figi` filed falls through to UNRESOLVED, as most do.
    assert report["resolutions"][BERKSHIRE_B]["source"] == "UNRESOLVED"
    assert report["byTier"] == {"SEC_13DG": 0, "TIINGO_FIGI": 1, "SEC_FTD": 0, "OPENFIGI": 0}
    assert report["hitRate"]["TIINGO_FIGI"] == 0.5
    assert report["attempted"] == 2
    assert report["resolved"] == 1
    assert report["unresolved"] == 1


def test_tier_c_reports_unavailable_rather_than_zero_hits() -> None:
    """The Fails-to-Deliver archive is T8's job. A permanently un-provisioned
    tier must not read as a tier with poor coverage forever."""
    report = cusip_map.resolve_cusips([APPLE], sources=FakeSources(), now=NOW)
    assert report["ftd"] == "unavailable"
    assert report["byTier"]["SEC_FTD"] == 0


def test_tier_c_resolves_through_an_injected_lookup() -> None:
    sources = FakeSources(
        by_symbol={"AAPL": {"symbol": "AAPL", "cik": "0000320193", "openFIGIComposite": "BBG1"}}
    )
    report = cusip_map.resolve_cusips(
        [APPLE], sources=sources, ftd_lookup=lambda cusips: {APPLE: "AAPL"}, now=NOW
    )
    assert report["ftd"] == "queried"
    row = report["resolutions"][APPLE]
    assert row["source"] == "SEC_FTD"
    assert row["symbol"] == "AAPL"
    assert row["cik10"] == "0000320193"


def test_tier_d_normalises_openfigi_s_slash_before_joining() -> None:
    """OpenFIGI spells share classes with a SLASH (``BRK/B``) where our master
    uses a dash. Without the rewrite the tier resolves the FIGI and then fails
    to find the symbol, which reads as "OpenFIGI has no answer"."""
    sources = FakeSources(
        by_symbol={"BRK-B": {"symbol": "BRK-B", "cik": "0001067983"}},
    )
    figi = FakeOpenFigi(
        {
            BERKSHIRE_B: {
                "symbol": "BRK-B",
                "compositeFigi": "BBG000DWG505",
                "issuerName": "BERKSHIRE HATHAWAY INC-CL B",
            }
        }
    )
    report = cusip_map.resolve_cusips([BERKSHIRE_B], sources=sources, openfigi=figi, now=NOW)
    row = report["resolutions"][BERKSHIRE_B]
    assert row["source"] == "OPENFIGI"
    assert row["symbol"] == "BRK-B"
    assert row["cik10"] == "0001067983"
    assert row["compositeFigi"] == "BBG000DWG505"
    assert report["openfigi"] == "queried"


def test_tier_d_will_not_store_a_symbol_our_master_does_not_carry() -> None:
    """OpenFIGI knows tickers we do not list. A symbol no instrument row backs
    joins to nothing while looking resolved."""
    figi = FakeOpenFigi({APPLE: {"symbol": "AAPL", "compositeFigi": "BBG000B9XRY4"}})
    report = cusip_map.resolve_cusips([APPLE], sources=FakeSources(), openfigi=figi, now=NOW)
    row = report["resolutions"][APPLE]
    assert row["source"] == "OPENFIGI"
    assert row["symbol"] is None
    assert row["compositeFigi"] == "BBG000B9XRY4"


def test_each_tier_only_sees_what_the_ones_above_it_could_not_answer() -> None:
    sources = FakeSources(
        subjects={EXPION: {"subjectCik10": "0001894954", "subjectName": "Expion"}},
        by_cik={"0001894954": [{"symbol": "XPON"}]},
    )
    figi = FakeOpenFigi({})
    cusip_map.resolve_cusips([EXPION, APPLE], sources=sources, openfigi=figi, now=NOW)

    asked_for_figis = next(args for name, args in sources.asked if name == "figis")
    assert EXPION not in asked_for_figis
    assert asked_for_figis == [APPLE]
    assert figi.asked == [[APPLE]]


def test_everything_unresolved_is_still_a_row() -> None:
    """A CUSIP nobody could map, not recorded at all, is retried by every sweep
    forever and is invisible in the coverage number."""
    report = cusip_map.resolve_cusips([APPLE, BERKSHIRE_B], sources=FakeSources(), now=NOW)
    assert set(report["resolutions"]) == {APPLE, BERKSHIRE_B}
    for row in report["resolutions"].values():
        assert row["source"] == "UNRESOLVED"
        assert row["attempts"] == 1
        assert row["lastTriedAt"] == NOW


# ── writing ─────────────────────────────────────────────────────────────────


def test_nothing_is_written_unless_armed() -> None:
    class ExplodingWriter:
        def upsert_rows(self, *args: Any, **kwargs: Any) -> int:
            raise AssertionError("an unarmed sweep wrote rows")

    report = cusip_map.resolve_cusips(
        [APPLE], sources=FakeSources(), writer=ExplodingWriter(), apply=False, now=NOW
    )
    assert report["written"] == 0
    assert report["applied"] is False
    assert report["planned"] == 1


def test_an_armed_sweep_writes_on_the_cusip_key() -> None:
    writer = RecordingWriter()
    sources = FakeSources(
        subjects={EXPION: {"subjectCik10": "0001894954", "subjectName": "Expion"}},
        by_cik={"0001894954": [{"symbol": "XPON"}]},
    )
    report = cusip_map.resolve_cusips(
        [EXPION, APPLE], sources=sources, writer=writer, apply=True, now=NOW
    )
    assert report["written"] == 2
    assert writer.keys == [("cusip",)]
    stored = {row["cusip"]: row for row in writer.rows}
    assert stored[EXPION]["source"] == "SEC_13DG"
    assert stored[APPLE]["source"] == "UNRESOLVED"


def test_an_armed_sweep_still_refuses_to_demote_a_stronger_row() -> None:
    writer = RecordingWriter()
    sources = FakeSources(
        existing={APPLE: {"cusip": APPLE, "source": "SEC_13DG", "symbol": "AAPL", "attempts": 0}}
    )
    figi = FakeOpenFigi({APPLE: {"symbol": "AAPL", "compositeFigi": "BBG000B9XRY4"}})
    report = cusip_map.resolve_cusips(
        [APPLE], sources=sources, openfigi=figi, writer=writer, apply=True, now=NOW
    )
    assert report["planned"] == 0
    assert report["written"] == 0
    assert writer.rows == []


def test_an_empty_request_is_a_named_no_op() -> None:
    report = cusip_map.resolve_cusips([], sources=FakeSources(), now=NOW)
    assert report["attempted"] == 0
    assert report["resolutions"] == {}
    assert report["written"] == 0


def test_a_single_active_listing_resolves_and_two_do_not() -> None:
    assert cusip_map._one_symbol([{"symbol": "XPON"}]) == "XPON"
    assert cusip_map._one_symbol([{"symbol": "BAC"}, {"symbol": "BAC-PB"}]) is None
    assert cusip_map._one_symbol([]) is None
    # The same row twice is still one listing.
    assert cusip_map._one_symbol([{"symbol": "XPON"}, {"symbol": "XPON"}]) == "XPON"
