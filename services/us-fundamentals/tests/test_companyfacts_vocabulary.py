"""``us_fundamentals.standardized`` must speak ONE vocabulary, from either writer.

The column is read by exactly one table on the TypeScript side
(`US_CONCEPT_TO_STATEMENT_FIELD`). Two writers fill it:

* the per-filing parse stores ``standard_concept`` — edgartools' ``standard_tags``
* the ``companyfacts.zip`` fallback stored ``entry.concept`` — RAW us-gaap tags

Measured before the fix: 13 of the reader's 26 concepts are spellable as raw
us-gaap tags, so HALF of every companyfacts-sourced statement was unreadable —
the whole cash-flow statement, equity, and working capital. It looked like a
thin filer, not a bug. Companyfacts is the fallback for periods no per-filing
parse reached, i.e. exactly the historical periods the backfill exists to serve.

These tests assert the MEMBERSHIP property across the seam: every key a writer
produces must exist in the vocabulary the reader indexes by. That is the same
invariant `packages/core/__tests__/us-fundamentals/concept-vocabulary.test.ts`
enforces from the other side.
"""

from __future__ import annotations

import json
from pathlib import Path

from edgar.xbrl import standardization

from app.bulk import companyfacts
from app.sec.standardize import standard_tag_for, standardize_concepts
from tests.test_bulk_companyfacts import load_series

AAPL = "companyfacts_aapl.json.gz"
AAPL_CIK = "0000320193"


def _standard_tag_universe() -> set[str]:
    payload = json.loads(
        (Path(standardization.__file__).parent / "gaap_mappings.json").read_bytes()
    )
    return {t for v in payload.values() for t in (v.get("standard_tags") or [])}


def test_every_standardized_key_is_a_real_standard_tag() -> None:
    """THE CROSS-SEAM INVARIANT. A key outside this set can never be read."""
    universe = _standard_tag_universe()
    assert len(universe) > 200, "premise: the universe must be populated"

    rows, _ = companyfacts.derive_fundamentals_rows(
        load_series(AAPL), cik10=AAPL_CIK, symbol="AAPL"
    )
    assert rows, "premise: the fixture must produce rows"

    strays: set[str] = set()
    for row in rows:
        strays |= {k for k in row.standardized if k not in universe}
    assert strays == set(), (
        f"these keys are not standard tags and no reader can index them: {sorted(strays)[:10]}"
    )


def test_raw_us_gaap_tags_do_not_reach_the_standardized_view() -> None:
    """Named, so the assertion states the defect rather than a property."""
    rows, _ = companyfacts.derive_fundamentals_rows(
        load_series(AAPL), cik10=AAPL_CIK, symbol="AAPL"
    )
    balance = max(
        (r for r in rows if r.statementType == "BALANCE_SHEET" and r.periodType == "ANNUAL"),
        key=lambda r: r.periodEnd,
    )
    for raw in [
        "AssetsCurrent",
        "LiabilitiesCurrent",
        "StockholdersEquity",
        "AccountsPayableCurrent",
        "InventoryNet",
        "AccountsReceivableNetCurrent",
    ]:
        assert raw not in balance.standardized, f"raw us-gaap tag {raw} leaked into standardized"

    for standard in [
        "CurrentAssetsTotal",
        "CurrentLiabilitiesTotal",
        "AllEquityBalance",
        "TradePayables",
        "Inventories",
        "TradeReceivables",
    ]:
        assert standard in balance.standardized, f"{standard} missing — the map did not fire"


def test_as_reported_keeps_the_RAW_concept() -> None:
    """"As reported" means as reported. Only the standardized view is mapped."""
    rows, _ = companyfacts.derive_fundamentals_rows(
        load_series(AAPL), cik10=AAPL_CIK, symbol="AAPL"
    )
    balance = max(
        (r for r in rows if r.statementType == "BALANCE_SHEET" and r.periodType == "ANNUAL"),
        key=lambda r: r.periodEnd,
    )
    concepts = {a["concept"] for a in balance.asReported}
    assert "AssetsCurrent" in concepts, "asReported must preserve what the filer actually tagged"
    assert "AccountsPayableCurrent" in concepts


def test_the_mapping_and_collisions_are_counted_not_silent() -> None:
    _, counters = companyfacts.derive_fundamentals_rows(
        load_series(AAPL), cik10=AAPL_CIK, symbol="AAPL"
    )
    for key in ("conceptsUnmapped", "conceptsCollided", "groupsUnstandardizable"):
        assert key in counters, f"{key} must be reported"
    assert counters["conceptsCollided"] >= 0


# ── the mapper itself ────────────────────────────────────────────────────────


def test_standard_tag_for_maps_the_concepts_the_reader_needs() -> None:
    assert standard_tag_for("NetIncomeLoss") == "NetIncome"
    assert standard_tag_for("StockholdersEquity") == "AllEquityBalance"
    assert standard_tag_for("AssetsCurrent") == "CurrentAssetsTotal"
    assert standard_tag_for("NetCashProvidedByUsedInOperatingActivities") == (
        "NetCashFromOperatingActivities"
    )
    assert standard_tag_for("PaymentsToAcquirePropertyPlantAndEquipment") == "CapitalExpenses"


def test_an_extension_concept_is_unmapped_rather_than_guessed() -> None:
    assert standard_tag_for("aapl:SomethingSpecific") is None
    assert standard_tag_for("") is None


def test_standardize_concepts_counts_unmapped_and_collisions() -> None:
    out, unmapped, collisions = standardize_concepts(
        {
            "Assets": 1.0,
            "aapl:Nonsense": 2.0,
            "Revenues": 3.0,
            "RevenueFromContractWithCustomerExcludingAssessedTax": 4.0,
        }
    )
    assert out["Assets"] == 1.0
    assert unmapped == 1, "the extension concept must be counted, not silently dropped"
    assert collisions == 1, "two tags competing for `Revenue` is a COLLISION, counted"
    assert "Revenue" in out


def test_standardize_concepts_is_deterministic_across_orderings() -> None:
    """Collision resolution must not depend on dict insertion order."""
    a, _, _ = standardize_concepts({"Revenues": 1.0, "SalesRevenueNet": 2.0})
    b, _, _ = standardize_concepts({"SalesRevenueNet": 2.0, "Revenues": 1.0})
    assert a == b, "the same facts in a different order produced a different statement"


# ── collision resolution ─────────────────────────────────────────────────────
#
# The buckets are WIDE — 130 us-gaap tags collapse into `Revenue`, 58 into
# `CashAndMarketableSecurities` — and filers routinely tag several. So a rule is
# unavoidable, and an arbitrary one silently decides reported numbers.
#
# These three cases are the ones that caught the first implementation, which
# took the alphabetically-first concept. Determinism is not correctness.


def test_collisions_are_resolved_by_upstream_confidence_not_alphabetically() -> None:
    revenue, _, collisions = standardize_concepts(
        {"AdmissionsRevenue": 1.0, "Revenues": 999.0}
    )
    assert revenue["Revenue"] == 999.0, (
        "alphabetical-first picks AdmissionsRevenue over Revenues"
    )
    assert collisions == 1

    cash, _, _ = standardize_concepts(
        {"AssetBackedSecuritiesAtCarryingValue": 1.0, "CashAndCashEquivalentsAtCarryingValue": 888.0}
    )
    assert cash["CashAndMarketableSecurities"] == 888.0, (
        "alphabetical-first reports asset-backed securities as cash"
    )

    income, _, _ = standardize_concepts(
        {"IncomeLossAttributableToParent": 1.0, "NetIncomeLoss": 777.0}
    )
    assert income["NetIncome"] == 777.0, (
        "NetIncomeLoss has confidence 1.0 and is used by 86% of filers"
    )


def test_the_winner_does_not_depend_on_which_concept_arrived_first() -> None:
    """Order-independence is necessary but NOT sufficient — see the test above.

    Both orderings must give the same answer AND that answer must be the
    high-confidence tag. The original implementation passed this test and still
    reported admissions revenue as revenue.
    """
    forward, _, _ = standardize_concepts({"AdmissionsRevenue": 1.0, "Revenues": 999.0})
    reverse, _, _ = standardize_concepts({"Revenues": 999.0, "AdmissionsRevenue": 1.0})
    assert forward == reverse
    assert forward["Revenue"] == 999.0


def test_every_losing_candidate_is_counted() -> None:
    _, _, collisions = standardize_concepts(
        {"AdmissionsRevenue": 1.0, "Revenues": 2.0, "FranchisorRevenue": 3.0}
    )
    assert collisions >= 2, "each displaced candidate must be counted, not just the first"


# ── the rank's INTERNAL ordering, pinned element by element ──────────────────
#
# A round-2 review showed the "resolved by upstream confidence" tests could not
# tell confidence from occurrence_rate from is_total: reordering the tuple, or
# zeroing either float out of it, left the whole suite green. Only the collapse
# to alphabetical-first-wins was caught. The dimension the fix was ABOUT was the
# one nothing pinned.
#
# These drive the real `standardize_concepts` against a SYNTHETIC index, so each
# element is isolated. Using real tags would couple the assertion to whichever
# pair of statistics `gaap_mappings.json` happens to ship this release.


def _fake_index(monkeypatch, entries: dict[str, tuple[str, tuple]]) -> None:
    from app.sec import standardize as mod

    mod._concept_index.cache_clear()
    monkeypatch.setattr(mod, "_concept_index", lambda: entries)


def test_confidence_outranks_occurrence(monkeypatch) -> None:
    """A more CONFIDENT tag wins even when it is rarer."""
    _fake_index(
        monkeypatch,
        {
            "Rare": ("Bucket", (0, 1.0, 0.01, 1, "Rare")),
            "Common": ("Bucket", (0, 0.5, 0.99, 1, "Common")),
        },
    )
    out, _, collisions = standardize_concepts({"Rare": 111.0, "Common": 222.0})
    assert out["Bucket"] == 111.0, "occurrence_rate outranked confidence"
    assert collisions == 1


def test_occurrence_breaks_a_confidence_tie(monkeypatch) -> None:
    _fake_index(
        monkeypatch,
        {
            "Widespread": ("Bucket", (0, 1.0, 0.90, 1, "Widespread")),
            "Niche": ("Bucket", (0, 1.0, 0.02, 1, "Niche")),
        },
    )
    out, _, _ = standardize_concepts({"Widespread": 111.0, "Niche": 222.0})
    assert out["Bucket"] == 111.0, "occurrence_rate is not being consulted"


def test_is_total_breaks_a_confidence_and_occurrence_tie(monkeypatch) -> None:
    _fake_index(
        monkeypatch,
        {
            "AComponent": ("Bucket", (0, 1.0, 0.5, 0, "AComponent")),
            "ZTotal": ("Bucket", (0, 1.0, 0.5, 1, "ZTotal")),
        },
    )
    out, _, _ = standardize_concepts({"AComponent": 111.0, "ZTotal": 222.0})
    assert out["Bucket"] == 222.0, (
        "is_total is not being consulted — and the loser sorts FIRST "
        "alphabetically, so this is not an accident of naming"
    )


def test_canonical_leads_every_statistic(monkeypatch) -> None:
    """The canonical feeder wins even when it loses on all three numbers."""
    from app.sec import standardize as mod

    _fake_index(
        monkeypatch,
        {
            "Popular": ("Bucket", (0, 1.0, 0.99, 1, "Popular")),
            "TheTotal": ("Bucket", (1, 0.1, 0.01, 0, "TheTotal")),
        },
    )
    monkeypatch.setitem(mod.CANONICAL_FEEDER, "Bucket", "TheTotal")
    out, _, _ = standardize_concepts({"Popular": 111.0, "TheTotal": 222.0})
    assert out["Bucket"] == 222.0, "is_canonical does not lead the rank"


# ── the two measured buckets where popularity picks a COMPONENT ──────────────


def test_sga_prefers_the_total_over_the_general_and_admin_component() -> None:
    """`GeneralAndAdministrativeExpense` is used by 53% of filers against 29%
    for the SG&A total, and upstream flags BOTH as totals — so neither
    occurrence_rate nor is_total can decide it."""
    out, _, collisions = standardize_concepts(
        {
            "GeneralAndAdministrativeExpense": 111.0,
            "SellingGeneralAndAdministrativeExpense": 999.0,
        }
    )
    assert out["SellingGeneralAndAdminExpenses"] == 999.0, (
        "a filer tagging both lines got G&A, the component, as its SG&A"
    )
    assert collisions == 1


def test_revenue_prefers_the_total_over_the_asc606_subtotal() -> None:
    """`Revenues` is the total; the ASC-606 tag excludes non-contract revenue,
    which is material for a bank or an insurer."""
    out, _, _ = standardize_concepts(
        {
            "RevenueFromContractWithCustomerExcludingAssessedTax": 111.0,
            "Revenues": 999.0,
        }
    )
    assert out["Revenue"] == 999.0, "the ASC-606 subtotal was reported as revenue"


def test_the_canonical_list_stays_short_and_every_entry_is_reachable() -> None:
    """It is a measured exception list, not a general override mechanism."""
    from app.sec.standardize import CANONICAL_FEEDER, standard_tag_for

    assert len(CANONICAL_FEEDER) <= 5, (
        "this list is growing into a hand-maintained mapping table, which will "
        "rot against a file upstream regenerates every release"
    )
    for bucket, concept in CANONICAL_FEEDER.items():
        assert standard_tag_for(concept) == bucket, (
            f"{concept} does not actually map to {bucket} — the override is dead"
        )


# ── the counters are REAL numbers, not `key in counters` ─────────────────────


def test_the_derived_counters_carry_measured_values_not_zeroes() -> None:
    """A counter that is never incremented reports a credible, permanent zero.

    The previous assertion was `key in counters` and `>= 0`, a tautology: setting
    every increment to `+= 0` left the suite green. These are the measured values
    for the Apple fixture.
    """
    _, counters = companyfacts.derive_fundamentals_rows(
        load_series(AAPL), cik10=AAPL_CIK, symbol="AAPL"
    )
    assert counters["factsConsidered"] > 6_000, counters
    assert counters["factsSkipped"] > 1_000, counters
    assert counters["conceptsCollided"] > 0, (
        "Apple tags several concepts that share a bucket; a zero here means the "
        "collision counter is not being incremented"
    )
    assert counters["conceptsUnmapped"] == 0, counters
    assert counters["groupsUnstandardizable"] == 0, counters


def test_an_unmapped_concept_is_counted_on_a_real_derivation() -> None:
    """`conceptsUnmapped == 0` on Apple is a property of Apple, not proof."""
    out, unmapped, _ = standardize_concepts({"Assets": 1.0, "xyz:Invented": 2.0})
    assert unmapped == 1
    assert "Assets" in out and len(out) == 1


# ── the rank must be BUILT correctly, not merely used correctly ──────────────
#
# The synthetic-index tests above pin how `standardize_concepts` USES a rank.
# They say nothing about how `_concept_index` BUILDS one — mutating its
# construction (zeroing confidence, reordering the tuple, `tags[0]` -> `tags[-1]`)
# left every one of them green, because they replace the index wholesale.
#
# Isolating a unit and then testing only the isolated half is how a seam passes
# from both sides while the join is wrong. These drive the REAL index.


def _real_rank(concept: str):
    from app.sec.standardize import _concept_index

    _concept_index.cache_clear()
    return _concept_index()[concept]


def test_the_real_index_builds_the_rank_in_the_declared_order() -> None:
    from app.sec.standardize import ConceptRank  # noqa: F401

    bucket, rank = _real_rank("Revenues")
    assert bucket == "Revenue"
    is_canonical, confidence, occurrence, is_total, name = rank
    assert is_canonical == 1, "Revenues is the declared canonical feeder for Revenue"
    assert confidence == 1.0, "confidence is not being read from the mapping file"
    assert 0.30 < occurrence < 0.40, f"occurrence_rate not read (got {occurrence})"
    assert is_total == 1, "is_total is not being read"
    assert name == "Revenues", "the lexical tie-breaker must be the concept name"


def test_a_non_canonical_concept_leads_with_zero() -> None:
    _, rank = _real_rank("RevenueFromContractWithCustomerExcludingAssessedTax")
    assert rank[0] == 0, "only a declared CANONICAL_FEEDER entry may lead with 1"
    assert rank[1] == 1.0
    assert 0.35 < rank[2] < 0.42


def test_the_real_index_takes_the_FIRST_standard_tag() -> None:
    """`tags[0]`, matching edgartools' own ordering — pinned against `tags[-1]`."""
    import json
    from pathlib import Path

    from edgar.xbrl import standardization

    from app.sec.standardize import _concept_index

    payload = json.loads(
        (Path(standardization.__file__).parent / "gaap_mappings.json").read_bytes()
    )
    multi = {
        concept: tags
        for concept, entry in payload.items()
        if len(tags := (entry.get("standard_tags") or [])) > 1 and tags[0] != tags[-1]
    }
    assert len(multi) > 50, f"premise: expected many multi-tag concepts, got {len(multi)}"

    _concept_index.cache_clear()
    index = _concept_index()
    wrong = [c for c, tags in multi.items() if index[c][0] != tags[0]]
    assert wrong == [], f"these did not take the FIRST standard tag: {wrong[:5]}"


def test_confidence_and_occurrence_are_distinct_fields_in_the_real_index() -> None:
    """Zeroing either one out of the construction must be visible.

    Uses a concept whose two statistics differ, so a mutation that collapses one
    into the other, or drops it, cannot pass by coincidence.
    """
    _, rank = _real_rank("NetIncomeLoss")
    assert rank[1] == 1.0, "confidence"
    assert 0.80 < rank[2] < 0.92, f"occurrence_rate (got {rank[2]})"
    assert rank[1] != rank[2], "the two statistics must not be the same value"


# ── the counters must REACH the job outcome ─────────────────────────────────
#
# A round-2 review showed all four new counters were wired correctly and NONE
# was pinned: setting every increment to `+= 0`, or deleting `_write_member`'s
# forwarding of all three derived counters outright, left 53 cases green. The
# only assertion was `key in counters` and `>= 0` — a tautology.
#
# It matters most for `statementsSuppressed`, whose own comment says "in the
# steady state most nights this is the MAJORITY of what this leg produces". A
# stuck 0 there reads as "the authority guard is not firing" and nothing would
# have caught it.


class _UniverseStub:
    """The two methods `_write_member` calls. In-universe, so leg (c) runs."""

    def contains(self, _cik: str) -> bool:
        return True

    def symbol_for(self, _cik: str) -> str:
        return "AAPL"


def _job_counters() -> dict[str, int]:
    return {
        "factsSkipped": 0,
        "groupsDropped": 0,
        "conceptsUnmapped": 0,
        "conceptsCollided": 0,
        "groupsUnstandardizable": 0,
        "statementRows": 0,
        "statementsSuppressed": 0,
        "shardsWritten": 0,
        "shardRows": 0,
        "hotFacts": 0,
    }


def test_write_member_forwards_the_derived_counters_to_the_job() -> None:
    """`applying=False` skips every write leg and exercises exactly the forwarding."""
    counters = _job_counters()
    companyfacts._write_member(
        db=None,
        cik=AAPL_CIK,
        entity_name="Apple Inc.",
        series=load_series(AAPL),
        universe=_UniverseStub(),
        counters=counters,
        applying=False,
    )
    assert counters["factsSkipped"] > 1_000, counters
    assert counters["groupsDropped"] > 0, counters
    assert counters["conceptsCollided"] > 0, (
        "the collision counter never reached the job outcome"
    )
    for key in ("conceptsUnmapped", "groupsUnstandardizable"):
        assert key in counters, f"{key} was dropped between derive and the job"


def test_a_group_whose_concepts_are_ALL_unmapped_is_dropped_and_counted() -> None:
    """The drop is real behaviour, not a comment.

    Storing such a group would add a row that renders blank: `asReported`
    survives but `standardized` is empty, so no reader can index it. Both
    fixtures reach zero here, so it is exercised by forcing the condition.
    """
    from app.bulk import companyfacts as cf

    original = cf.standardize_concepts
    try:
        cf.standardize_concepts = lambda values: ({}, len(values), 0)  # type: ignore[assignment]
        rows, counters = cf.derive_fundamentals_rows(
            load_series(AAPL), cik10=AAPL_CIK, symbol="AAPL"
        )
    finally:
        cf.standardize_concepts = original  # type: ignore[assignment]

    assert rows == [], "a group with no standardizable concept must not be stored"
    assert counters["groupsUnstandardizable"] > 0, (
        "the drop happened but was not counted — a silent coverage loss"
    )
    assert counters["conceptsUnmapped"] > 0
