/**
 * Screener SUGGESTED chips + "+ Add filter" (MONEY-1246 / MONEY-1247).
 *
 * Two defects shipped together in the filter sidebar:
 *
 *   MONEY-1246 — "+ Add filter" and every chip were wired to EMPTY callbacks
 *   (`onAddFilter={() => undefined}`, `onPick={() => {}}`). The Add-filter
 *   case was the worse of the two: FilterSidebar already guards it with
 *   `disabled={!onAddFilter}`, and an empty arrow function is TRUTHY, so
 *   passing one DEFEATED the component's own guard and rendered the button
 *   fully enabled instead of correctly greyed out. Omitting the prop would
 *   already have been honest.
 *
 *   MONEY-1247 — all six chips (pe, roe, mcap, rev, de, div) named filters the
 *   sidebar was ALREADY rendering a card for, so the section could never
 *   suggest anything new. The list is a constant and was never compared
 *   against what the user had actually set.
 *
 * These cases pin the selection rule and the active-id derivation. The React
 * rendering is not exercised here — what matters, and what silently regressed,
 * is WHICH chips are offered.
 *
 * Sources:
 *   apps/web/components/screener/SuggestedChips.tsx
 *   apps/web/app/discover/screener/stocks-mode.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The REAL exported rules the component and the sidebar run — not copies.
// An earlier draft of this file re-implemented both helpers locally; breaking
// the shipped filter left it green, which is the shadow-test trap this repo
// forbids. Mutation now fails these cases as it should.
import {
  SUGGESTED_FILTERS,
  remainingSuggestions,
  deriveActiveFilterIds,
  SUGGESTED_ETF_FILTERS,
  remainingEtfSuggestions,
  deriveActiveEtfFilterIds,
  deriveActiveMfChips,
  deriveActiveEtfChips,
  type SuggestableFilterState,
} from "../../components/screener/suggested-filters-logic";

const remainingChips = (activeIds: readonly string[]): string[] =>
  remainingSuggestions(activeIds).map((s) => s.id);

const deriveActiveIds = (f: SuggestableFilterState): string[] =>
  deriveActiveFilterIds(f);

describe("suggested chips — never suggest what is already applied", () => {
  it("offers everything when no filter is set", () => {
    assert.deepEqual(remainingChips([]), [
      "pe",
      "roe",
      "mcap",
      "rev",
      "de",
      "div",
    ]);
  });

  it("[regression] hides a chip once its filter is active", () => {
    // The shipped bug: all six showed unconditionally while the sidebar
    // rendered a card for each, so SUGGESTED only ever offered duplicates.
    const remaining = remainingChips(["pe", "roe"]);
    assert.ok(!remaining.includes("pe"));
    assert.ok(!remaining.includes("roe"));
    assert.deepEqual(remaining, ["mcap", "rev", "de", "div"]);
  });

  it("[regression] offers nothing when every metric is in use", () => {
    // The component returns null here rather than rendering an empty
    // "SUGGESTED" heading, which would read as a broken section.
    const all = SUGGESTED_FILTERS.map((s) => s.id);
    assert.deepEqual(remainingChips(all), []);
  });
});

describe("active-filter derivation matches each card's own rule", () => {
  it("an empty filter set marks nothing active", () => {
    assert.deepEqual(deriveActiveIds({}), []);
  });

  it("[regression] a MIN-only bound still counts as active", () => {
    // Chips keyed off "both bounds set" would keep suggesting a metric the
    // user had already filtered on — the duplicate bug in a subtler form.
    assert.deepEqual(deriveActiveIds({ minPe: 10 }), ["pe"]);
    assert.deepEqual(deriveActiveIds({ maxRoe: 40 }), ["roe"]);
  });

  it("market cap counts via bucket OR either bound", () => {
    assert.deepEqual(deriveActiveIds({ marketCapBucket: "LARGE" }), ["mcap"]);
    assert.deepEqual(deriveActiveIds({ minMarketCap: 20000 }), ["mcap"]);
    assert.deepEqual(deriveActiveIds({ maxMarketCap: 90000 }), ["mcap"]);
  });

  it("zero is a real bound, not an absent one", () => {
    // `!= null` and not a truthiness check: a min of 0 is a deliberate
    // filter, and treating it as unset would re-suggest a metric in use.
    assert.deepEqual(deriveActiveIds({ minDividendYield: 0 }), ["div"]);
    assert.deepEqual(deriveActiveIds({ minDebtToEquity: 0 }), ["de"]);
  });

  it("a fully filtered screen leaves no suggestions", () => {
    const filters = {
      marketCapBucket: "LARGE",
      minPe: 5,
      minRoe: 15,
      minRevenueGrowth: 10,
      maxDebtToEquity: 1,
      minDividendYield: 2,
    };
    assert.deepEqual(remainingChips(deriveActiveIds(filters)), []);
  });
});

/**
 * ETF parity (MONEY-1248).
 *
 * ETF mode uses FundFilterSidebar, a different component from the stocks
 * sidebar, so it never had the picker or the chips at all. It shares
 * `remainingSuggestions`' rule but needs its own metric set — and the set is
 * the load-bearing part here, because three of the ETF sliders are COMMENTED
 * OUT under TODO(MONEY-367) while their filter fields are still live in the
 * type. Suggesting one of those would scroll the user to a control that does
 * not exist: the same dead end MONEY-1246 fixed, reintroduced from the other
 * direction.
 */
describe("ETF suggestions — only offer filters that are actually rendered", () => {
  it("[regression] never offers the sliders MONEY-367 commented out", () => {
    const ids = SUGGESTED_ETF_FILTERS.map((s) => s.id);
    // Max expense / Min 1Y return / Min AUM have no UI today.
    assert.ok(
      !ids.includes("expense" as never),
      "expense slider is not rendered"
    );
    assert.ok(
      !ids.includes("returns1y" as never),
      "1Y return slider is not rendered"
    );
    assert.ok(!ids.includes("aum" as never), "AUM slider is not rendered");
  });

  it("offers the five ETF filters the sidebar does render", () => {
    assert.deepEqual(
      SUGGESTED_ETF_FILTERS.map((s) => s.id),
      ["amc", "category", "assetClass", "theme", "exchange"]
    );
  });

  it("hides an ETF chip once its filter is set", () => {
    const active = deriveActiveEtfFilterIds({ amcName: "Nippon" });
    assert.deepEqual(active, ["amc"]);
    const remaining = remainingEtfSuggestions(active).map((s) => s.id);
    assert.ok(!remaining.includes("amc"));
    assert.equal(remaining.length, 4);
  });

  it("[regression] an EMPTY STRING is not an active filter", () => {
    // `theme` is a free-text input. A stray "" from a controlled input would
    // otherwise hide a chip the user can still use.
    assert.deepEqual(deriveActiveEtfFilterIds({ theme: "" }), []);
    assert.deepEqual(deriveActiveEtfFilterIds({ amcName: "" }), []);
    assert.deepEqual(deriveActiveEtfFilterIds({ theme: "Gold" }), ["theme"]);
  });

  it("numeric ETF bounds still derive, ready for MONEY-367", () => {
    // The derivation already handles the sparse-data fields, so reviving the
    // sliders only means adding their ids back to SUGGESTED_ETF_FILTERS.
    assert.deepEqual(deriveActiveEtfFilterIds({ minAum: 0 }), ["aum"]);
    assert.deepEqual(deriveActiveEtfFilterIds({ maxExpenseRatio: 0 }), [
      "expense",
    ]);
  });

  it("all five set leaves nothing to suggest", () => {
    const active = deriveActiveEtfFilterIds({
      amcName: "Nippon",
      category: "Banking",
      assetClass: "Equity",
      theme: "Gold",
      exchange: "NSE",
    });
    assert.deepEqual(remainingEtfSuggestions(active), []);
  });
});

/**
 * Active-filter chips (MONEY-1251).
 *
 * The bug these exist for: Ask Screener can set 17 MF fields while the sidebar
 * renders 3 controls, so a chat-applied `minReturns5Y` or `plan` narrowed the
 * results while appearing NOWHERE — visible only as the result count moving,
 * and removable only via "Reset all".
 *
 * The chips are derived from the filter STATE rather than from which controls
 * exist, which is the whole point: a field with no editor must still show.
 */
describe("active-filter chips — nothing the chat sets may hide", () => {
  it("[regression] surfaces a field that has NO sidebar control", () => {
    // minReturns5Y has no editor (its slider is commented out under
    // MONEY-367) yet the chat can set it. Before this, it filtered invisibly.
    const chips = deriveActiveMfChips({ minReturns5Y: 12 });
    assert.equal(chips.length, 1);
    assert.match(chips[0].label, /5Y return/);
    assert.deepEqual(chips[0].keys, ["minReturns5Y"]);
  });

  it("[regression] surfaces plan and fundType, also control-less", () => {
    const chips = deriveActiveMfChips({ plan: "DIRECT", fundType: "equity" });
    const labels = chips.map((c) => c.label);
    assert.ok(labels.some((l) => l.includes("DIRECT")));
    assert.ok(labels.some((l) => l.includes("equity")));
  });

  it("a two-sided range is ONE chip clearing BOTH bounds", () => {
    // Two chips would let a user remove half a range and leave a filter
    // still narrowing results with nothing shown for it.
    const chips = deriveActiveMfChips({ minReturns1Y: 10, maxReturns1Y: 30 });
    assert.equal(chips.length, 1);
    assert.deepEqual(chips[0].keys, ["minReturns1Y", "maxReturns1Y"]);
    assert.match(chips[0].label, /10%–30%/);
  });

  it("a one-sided range reads as an inequality", () => {
    assert.match(deriveActiveMfChips({ minAum: 1e9 })[0].label, /≥/);
    assert.match(deriveActiveMfChips({ maxExpenseRatio: 1 })[0].label, /≤/);
  });

  it("AUM renders in crore, the unit funds are discussed in", () => {
    // Stored in rupees; 1e9 paise-free rupees = ₹100 Cr.
    assert.match(
      deriveActiveMfChips({ minAum: 1_000_000_000 })[0].label,
      /₹100 Cr/
    );
  });

  it("[regression] an empty string is not a chip", () => {
    // A controlled input can leave "" behind. A chip for it would be
    // unremovable in any meaningful sense.
    assert.deepEqual(deriveActiveMfChips({ category: "" }), []);
    assert.deepEqual(deriveActiveEtfChips({ theme: "" }), []);
  });

  it("[regression] zero is a real bound and DOES get a chip", () => {
    const chips = deriveActiveMfChips({ minReturns3Y: 0 });
    assert.equal(chips.length, 1);
    assert.match(chips[0].label, /3Y return ≥ 0%/);
  });

  it("no filters means no chips at all", () => {
    assert.deepEqual(deriveActiveMfChips({}), []);
    assert.deepEqual(deriveActiveEtfChips({}), []);
  });

  it("amcAny summarises rather than one chip per AMC", () => {
    const one = deriveActiveMfChips({ amcAny: ["HDFC"] });
    assert.match(one[0].label, /HDFC/);
    const many = deriveActiveMfChips({ amcAny: ["HDFC", "SBI", "Axis"] });
    assert.equal(many.length, 1);
    assert.match(many[0].label, /3 selected/);
  });

  it("the screenshot case: category + 5Y return both show", () => {
    // "Best 5Y-return flexi cap funds" set both; only the category was
    // visible before.
    const chips = deriveActiveMfChips({
      category: "Flexi Cap",
      minReturns5Y: 15,
    });
    assert.equal(chips.length, 2);
    const labels = chips.map((c) => c.label).join(" | ");
    assert.match(labels, /Flexi Cap/);
    assert.match(labels, /5Y return/);
  });

  it("ETF chips cover its control-less fields too", () => {
    const chips = deriveActiveEtfChips({ minAum: 5e8, maxExpenseRatio: 0.5 });
    assert.equal(chips.length, 2);
    assert.ok(chips.every((c) => c.keys.length >= 1));
  });
});
