/**
 * The F&O tab's visibility rule — MONEY-1204 (P14 / 14c.3).
 *
 * ## What shipped
 *
 * `StockDerivativesTab` self-gates: it returns null for a cash-only name. It
 * also exposes `onFnoResolved(isFno)` precisely so the parent can drop the TAB
 * as well as the panel. Nothing passed it. So on a non-F&O stock the user
 * clicked a live "F&O" tab, watched the derivatives skeleton, and landed on an
 * empty `<div className="mb-6">` — while `StockSectionTabs.tsx` carried a
 * comment asserting the opposite.
 *
 * ## Why this file tests functions rather than source text
 *
 * `stock-tabs-split.test.ts` pins the WIRING by reading the page source, which
 * is the only option for JSX inside a client component. The DECISION, though,
 * is ordinary logic, and the two things it has to get right are behavioural:
 *
 *   1. UNKNOWN is a third state. Collapsed to a boolean, "not resolved yet"
 *      becomes "not an F&O name" (or the reverse) and the tab flashes in or out
 *      on every single page load.
 *   2. A tab that disappears must never strand the reader standing on it —
 *      including the deep link `?tab=derivatives`, which selects the tab before
 *      anything is known about the symbol.
 *
 * Source: apps/web/components/stock/StockSectionTabs.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFnoTabVisible,
  tabAfterFnoHidden,
  visibleStockTabs,
  STOCK_TAB_DEFS,
  type FnoTabState,
  type StockTab,
} from "@/components/stock/StockSectionTabs";

/**
 * Every tab that is NOT "derivatives".
 *
 * MONEY-1205 added "events" here at the same time it added the tab. Omitting it
 * would have failed NOTHING — every loop below simply iterates this array, so a
 * missing entry does not red a test, it just stops testing the new tab. That is
 * a silent coverage hole rather than a broken test, which is the harder kind to
 * notice, so the list is pinned against the real union immediately below.
 */
const NON_DERIVATIVE_TABS: StockTab[] = [
  "summary",
  "financials",
  "peers",
  "ownership",
  "events",
  "actions",
  "news",
];

describe("MONEY-1205 — the tab list under test is the real tab list", () => {
  it("[regression] covers every non-derivatives tab in the registry", () => {
    // Without this, adding an eighth tab and forgetting to list it above
    // leaves every assertion in this file silently untested for that tab —
    // no failure, just less coverage than the file claims.
    const registry = STOCK_TAB_DEFS.map((t) => t.id).filter(
      (id) => id !== "derivatives"
    );
    assert.deepEqual(
      [...NON_DERIVATIVE_TABS].sort(),
      [...registry].sort(),
      "NON_DERIVATIVE_TABS has drifted from STOCK_TAB_DEFS"
    );
  });

  it("[regression] does not include derivatives itself", () => {
    // Several assertions below mean the opposite thing for the F&O tab —
    // `isFnoTabVisible("unknown", "derivatives")` is deliberately TRUE.
    assert.ok(!NON_DERIVATIVE_TABS.includes("derivatives" as StockTab));
  });
});

describe("MONEY-1204 — isFnoTabVisible is tri-state", () => {
  it('"yes" shows the tab from whatever tab you are on', () => {
    for (const active of [...NON_DERIVATIVE_TABS, "derivatives" as StockTab]) {
      assert.equal(
        isFnoTabVisible("yes", active),
        true,
        `resolved F&O must show the tab (active=${active})`
      );
    }
  });

  it('"no" hides it from every tab — the whole point of the gate', () => {
    for (const active of NON_DERIVATIVE_TABS) {
      assert.equal(isFnoTabVisible("no", active), false);
    }
  });

  it('[regression] "unknown" is NOT treated as "yes"', () => {
    // Treating the pre-answer state as "this stock has derivatives" is the
    // shipped bug in miniature: every cash-only stock renders the tab and then
    // yanks it away a moment later.
    for (const active of NON_DERIVATIVE_TABS) {
      assert.equal(
        isFnoTabVisible("unknown", active),
        false,
        `unknown must not assert coverage (active=${active})`
      );
    }
  });

  it('[regression] "unknown" is NOT treated as "no" either, on a deep link', () => {
    // `?tab=derivatives` SELECTS the tab. Hiding it while the answer is still
    // in flight renders a strip with no selected tab in it — a broken page,
    // and a worse one than the empty panel the gate exists to prevent.
    assert.equal(isFnoTabVisible("unknown", "derivatives"), true);
  });

  it("the answer never depends on the active tab once it is known", () => {
    // Otherwise the tab's presence would change as the reader moves around,
    // which is a different bug wearing the same clothes.
    const resolved: FnoTabState[] = ["yes", "no"];
    for (const state of resolved) {
      const answers = new Set(
        [...NON_DERIVATIVE_TABS, "derivatives" as StockTab].map((t) =>
          isFnoTabVisible(state, t)
        )
      );
      assert.equal(answers.size, 1, `"${state}" must be tab-independent`);
    }
  });
});

describe("MONEY-1204 — visibleStockTabs filters one entry and nothing else", () => {
  it("drops ONLY derivatives, and only when resolved to no", () => {
    const hidden = visibleStockTabs(STOCK_TAB_DEFS, "no", "summary");
    assert.equal(
      hidden.some((t) => t.id === "derivatives"),
      false,
      "the F&O tab must be gone"
    );
    assert.equal(
      hidden.length,
      STOCK_TAB_DEFS.length - 1,
      "no other tab may be affected"
    );
    // Order is the strip's information architecture; filtering must not stir it.
    assert.deepEqual(
      hidden.map((t) => t.id),
      STOCK_TAB_DEFS.filter((t) => t.id !== "derivatives").map((t) => t.id)
    );
  });

  it("keeps the full strip once F&O is confirmed", () => {
    assert.deepEqual(
      visibleStockTabs(STOCK_TAB_DEFS, "yes", "summary").map((t) => t.id),
      STOCK_TAB_DEFS.map((t) => t.id)
    );
  });

  it("[regression] applies to ANY registry, not just STOCK_TAB_DEFS", () => {
    // There are two lists — this one and the page's own `PF_STOCK_TABS`, which
    // carries different labels and a different icon prop. A rule that only
    // understands one of them is a rule the other silently lacks, which is how
    // the "actions" tab once existed in one list and not the other.
    const pageLike = [
      { id: "summary" as StockTab, label: "Overview" },
      { id: "derivatives" as StockTab, label: "F&O" },
      { id: "news" as StockTab, label: "News" },
    ];
    assert.deepEqual(
      visibleStockTabs(pageLike, "no", "summary").map((t) => t.label),
      ["Overview", "News"]
    );
    // Generic, so the caller keeps its own element type (`label` survives).
    assert.equal(visibleStockTabs(pageLike, "yes", "summary")[1]?.label, "F&O");
  });
});

describe("MONEY-1204 — tabAfterFnoHidden never strands the reader", () => {
  it("moves a reader who is standing on the tab being removed", () => {
    assert.equal(tabAfterFnoHidden("derivatives"), "summary");
  });

  it("[regression] leaves every other tab alone", () => {
    // "Always go to summary" would yank a reader off the Financials tab they
    // were reading, just because the stock turned out to be cash-only.
    for (const active of NON_DERIVATIVE_TABS) {
      assert.equal(
        tabAfterFnoHidden(active),
        null,
        `must be a no-op from ${active}`
      );
    }
  });

  it("the destination is a tab that actually exists", () => {
    const next = tabAfterFnoHidden("derivatives");
    assert.ok(next, "expected a destination");
    assert.ok(
      STOCK_TAB_DEFS.some((t) => t.id === next),
      "moving the user to a tab that is not in the strip is not a rescue"
    );
    assert.notEqual(
      next,
      "derivatives",
      "the destination must not be the tab being hidden"
    );
  });
});
