/**
 * Walkthrough Action Logic Tests
 *
 * Pure-logic unit tests for the constants and tour registry behind
 * the walkthrough server actions (MONEY-387). The DB/auth integration
 * itself follows the same getAuthenticatedUser + prisma.user.update
 * shape used by every other action in this codebase, so we focus
 * tests on the version-management invariants that are unique here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_WALKTHROUGH_VERSION,
  getActionEventNames,
  getTourByVersion,
  isKnownWalkthroughVersion,
  TOUR_LIST,
  TOUR_REGISTRY,
  v1Core,
  v1Documents,
  v1Fire,
  v1Holdings,
  v1Roast,
  v1Screener,
  v1Tradebook,
} from "@/lib/walkthrough/tours";
import { v1CoreStepsStockSageFirst } from "@/lib/walkthrough/tours/v1-core";

describe("CURRENT_WALKTHROUGH_VERSION", () => {
  it("is v1-core for the initial launch", () => {
    assert.equal(CURRENT_WALKTHROUGH_VERSION, "v1-core");
  });

  it("matches the tour registered in TOUR_REGISTRY", () => {
    assert.ok(TOUR_REGISTRY[CURRENT_WALKTHROUGH_VERSION]);
  });
});

describe("Tour registry", () => {
  it("returns the tour for a known version", () => {
    const tour = getTourByVersion("v1-core");
    assert.ok(tour);
    assert.equal(tour.version, "v1-core");
  });

  it("returns null for an unknown version", () => {
    const tour = getTourByVersion("v99-imaginary");
    assert.equal(tour, null);
  });
});

describe("v1-core tour content", () => {
  it("has exactly 11 steps", () => {
    // MONEY-543 added "default-page" (10→11); the MONEY-550 walkthrough fix
    // removed the orphaned "paper" nav step (Paper Trading de-platformed from
    // the sidebar nav; nav-paper no longer exists in the DOM), back to 10.
    // MONEY-543 (dashboard walkthrough fix) then added the "dashboard"
    // overview step (10→11) so the tour explicitly tours the dashboard page.
    assert.equal(v1Core.steps.length, 11);
  });

  it("includes the AI Assistant for investment step", () => {
    const step = v1Core.steps.find((s) => s.id === "ai-assistant");
    assert.ok(step);
    assert.equal(step.headline, "AI Assistant for investment");
  });

  it("includes the chat + icon (Research options) step", () => {
    const step = v1Core.steps.find((s) => s.id === "chat-plus");
    assert.ok(step);
    assert.equal(step.target, '[data-walkthrough="chat-plus-icon"]');
  });

  it("includes the broker showcase step pointing to /brokers", () => {
    const step = v1Core.steps.find((s) => s.id === "brokers");
    assert.ok(step);
    assert.equal(step.target, '[data-walkthrough="nav-brokers"]');
  });

  it("includes the holdings (all brokers live) step", () => {
    const step = v1Core.steps.find((s) => s.id === "holdings");
    assert.ok(step);
    assert.equal(step.target, '[data-walkthrough="nav-holdings"]');
    assert.equal(step.headline, "All holdings, live");
  });

  it("orders holdings → roast → brokers (your data → verdict → add more), then screener", () => {
    const holdingsIdx = v1Core.steps.findIndex((s) => s.id === "holdings");
    const roastIdx = v1Core.steps.findIndex((s) => s.id === "roast");
    const brokerIdx = v1Core.steps.findIndex((s) => s.id === "brokers");
    const screenerIdx = v1Core.steps.findIndex((s) => s.id === "screener");
    assert.ok(holdingsIdx < roastIdx, "holdings before roast");
    assert.ok(roastIdx < brokerIdx, "roast before brokers");
    // "paper" step removed (Paper Trading de-platformed); screener now follows.
    assert.ok(brokerIdx < screenerIdx, "brokers before screener");
  });

  it("includes the FIRE calculator step", () => {
    const step = v1Core.steps.find((s) => s.id === "fire");
    assert.ok(step);
    assert.equal(step.target, '[data-walkthrough="nav-fire"]');
    assert.equal(step.requiresMobileSidebar, true);
  });

  it("includes the screener step", () => {
    const step = v1Core.steps.find((s) => s.id === "screener");
    assert.ok(step);
    assert.equal(step.target, '[data-walkthrough="nav-screener"]');
  });

  it("includes the dashboard overview step that navigates to /dashboard", () => {
    const step = v1Core.steps.find((s) => s.id === "dashboard");
    assert.ok(step);
    assert.equal(step.target, '[data-walkthrough="dashboard-overview"]');
    assert.equal(step.navigateTo, "/dashboard");
  });

  it("defaults to a dashboard-first ordering (welcome → dashboard → chat → nav)", () => {
    // MONEY (walkthrough adaptive): the default v1-core ordering leads with the
    // dashboard overview, then the StockSage chat steps, then the sidebar nav.
    const welcomeIdx = v1Core.steps.findIndex((s) => s.id === "welcome");
    const dashboardIdx = v1Core.steps.findIndex((s) => s.id === "dashboard");
    const aiIdx = v1Core.steps.findIndex((s) => s.id === "ai-assistant");
    const chatPlusIdx = v1Core.steps.findIndex((s) => s.id === "chat-plus");
    const holdingsIdx = v1Core.steps.findIndex((s) => s.id === "holdings");
    assert.ok(welcomeIdx < dashboardIdx, "welcome before dashboard");
    assert.ok(dashboardIdx < aiIdx, "dashboard before ai-assistant");
    assert.ok(aiIdx < chatPlusIdx, "ai-assistant before chat-plus");
    assert.ok(chatPlusIdx < holdingsIdx, "chat steps before nav items");
  });

  it("exposes a StockSage-first ordering for chat-default users", () => {
    // When the user's default landing page is StockSage chat, the provider
    // swaps in v1CoreStepsStockSageFirst: welcome → chat → dashboard → nav.
    const welcomeIdx = v1CoreStepsStockSageFirst.findIndex(
      (s) => s.id === "welcome"
    );
    const aiIdx = v1CoreStepsStockSageFirst.findIndex(
      (s) => s.id === "ai-assistant"
    );
    const chatPlusIdx = v1CoreStepsStockSageFirst.findIndex(
      (s) => s.id === "chat-plus"
    );
    const dashboardIdx = v1CoreStepsStockSageFirst.findIndex(
      (s) => s.id === "dashboard"
    );
    const holdingsIdx = v1CoreStepsStockSageFirst.findIndex(
      (s) => s.id === "holdings"
    );
    assert.ok(welcomeIdx < aiIdx, "welcome before chat");
    assert.ok(aiIdx < chatPlusIdx, "ai-assistant before chat-plus");
    assert.ok(chatPlusIdx < dashboardIdx, "chat steps before dashboard");
    assert.ok(dashboardIdx < holdingsIdx, "dashboard before nav items");
  });

  it("both orderings contain the same set of steps", () => {
    // The adaptive swap only reorders the intro — no step is added or dropped.
    const defaultIds = v1Core.steps.map((s) => s.id).sort();
    const stockSageIds = v1CoreStepsStockSageFirst.map((s) => s.id).sort();
    assert.deepEqual(defaultIds, stockSageIds);
    assert.equal(v1CoreStepsStockSageFirst.length, v1Core.steps.length);
  });

  it("highlights the default-landing choice (Dashboard vs StockSage)", () => {
    // The default-page step teaches the user they can pick their home base —
    // the same preference the tour adapts its ordering to. It must stay in the
    // tour and name both options explicitly.
    const step = v1Core.steps.find((s) => s.id === "default-page");
    assert.ok(step, "default-page step present");
    assert.equal(step.target, '[data-walkthrough="user-menu-trigger"]');
    assert.match(step.headline, /home base/i);
    assert.match(step.body, /Dashboard/);
    assert.match(step.body, /StockSage/);
    assert.match(step.body, /Settings/);
  });

  it("navigates the chat steps to the StockSage chat view", () => {
    // ai-assistant + chat-plus anchor the StockSage composer, which only
    // renders on /stocksage — both must declare that navigateTo so
    // the tour doesn't auto-skip them when fired on the /dashboard overview.
    for (const id of ["ai-assistant", "chat-plus"]) {
      const step = v1Core.steps.find((s) => s.id === id);
      assert.ok(step);
      assert.equal(step.navigateTo, "/stocksage");
    }
  });

  it("leaves in-place steps without a navigateTo", () => {
    // Sidebar-nav + welcome/finish steps anchor elements present on the
    // current shell — they must not declare navigateTo (no spurious push).
    for (const id of ["welcome", "holdings", "fire", "finish"]) {
      const step = v1Core.steps.find((s) => s.id === id);
      assert.ok(step);
      assert.equal(step.navigateTo, undefined);
    }
  });

  it("targets sidebar logo, chat input, plus icon, and nav items", () => {
    const targets = v1Core.steps.map((s) => s.target);
    assert.ok(targets.includes('[data-walkthrough="sidebar-logo"]'));
    assert.ok(targets.includes('[data-walkthrough="dashboard-chat-input"]'));
    assert.ok(targets.includes('[data-walkthrough="chat-plus-icon"]'));
    assert.ok(targets.includes('[data-walkthrough="nav-brokers"]'));
    assert.ok(targets.includes('[data-walkthrough="nav-holdings"]'));
    assert.ok(targets.includes('[data-walkthrough="nav-roast"]'));
    // nav-paper removed: Paper Trading de-platformed from the sidebar nav
    // (2026-05-28); the v1-paper tour family is commented out of the registry.
    assert.ok(targets.includes('[data-walkthrough="nav-screener"]'));
    assert.ok(targets.includes('[data-walkthrough="nav-fire"]'));
    assert.ok(targets.includes('[data-walkthrough="user-menu-trigger"]'));
  });

  it("flags sidebar-nav steps with requiresMobileSidebar", () => {
    const requireSidebar = v1Core.steps
      .filter((s) => s.requiresMobileSidebar === true)
      .map((s) => s.id);
    assert.deepEqual(requireSidebar.sort(), [
      "brokers",
      "fire",
      "holdings",
      "roast",
      "screener",
    ]);
  });

  it("does NOT flag non-sidebar steps", () => {
    const ids = ["welcome", "ai-assistant", "chat-plus", "dashboard", "finish"];
    for (const id of ids) {
      const step = v1Core.steps.find((s) => s.id === id);
      assert.ok(step);
      assert.notEqual(step.requiresMobileSidebar, true);
    }
  });

  it("uses unique step ids", () => {
    const ids = v1Core.steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("uses placement values from the documented set", () => {
    const allowed = new Set(["top", "right", "bottom", "left"]);
    for (const step of v1Core.steps) {
      assert.ok(
        allowed.has(step.placement),
        `bad placement: ${step.placement}`
      );
    }
  });

  it("keeps body copy short enough for popover layout (<200 chars)", () => {
    for (const step of v1Core.steps) {
      assert.ok(
        step.body.length < 200,
        `body too long for step ${step.id}: ${step.body.length}`
      );
    }
  });
});

describe("Idempotent append semantics", () => {
  /**
   * Mirrors the in-action guard: if walkthroughVersionsSeen already
   * contains the version, no update is performed. We test the same
   * shape of logic here so the contract is documented.
   */
  function simulateMarkSeen(seen: string[], version: string): string[] {
    if (seen.includes(version)) return seen;
    return [...seen, version];
  }

  it("appends a new version", () => {
    assert.deepEqual(simulateMarkSeen([], "v1-core"), ["v1-core"]);
  });

  it("is a no-op when the version is already present", () => {
    assert.deepEqual(simulateMarkSeen(["v1-core"], "v1-core"), ["v1-core"]);
  });

  it("preserves prior versions when adding a new one", () => {
    assert.deepEqual(simulateMarkSeen(["v1-core"], "v2-roast"), [
      "v1-core",
      "v2-roast",
    ]);
  });
});

describe("isKnownWalkthroughVersion", () => {
  it("accepts all v1 versions in the registry", () => {
    // MONEY-543 cycle 2: paper-trading sub-tours (v1-paper / v1-paper-chat /
    // v1-paper-terminal / v1-paper-positions / v1-paper-history) removed
    // along with the underlying product surface.
    const versions = [
      "v1-core",
      "v1-roast",
      "v1-screener",
      "v1-screener-mf",
      "v1-screener-etf",
      "v1-fire",
      "v1-holdings",
      "v1-holdings-funds",
      "v1-holdings-positions",
      "v1-tradebook",
      "v1-tradebook-import",
      "v1-tradebook-history",
      "v1-tradebook-export",
      "v1-documents",
    ];
    for (const v of versions) {
      assert.equal(isKnownWalkthroughVersion(v), true, v);
    }
  });

  it("rejects v1-paper-analytics (removed - sub-route just redirects)", () => {
    assert.equal(isKnownWalkthroughVersion("v1-paper-analytics"), false);
  });

  it("rejects unknown versions", () => {
    assert.equal(isKnownWalkthroughVersion(""), false);
    assert.equal(isKnownWalkthroughVersion("nope"), false);
    assert.equal(isKnownWalkthroughVersion("v2-future"), false);
  });
});

describe("v1-roast tour content", () => {
  it("has an action trigger with the documented event name", () => {
    assert.equal(v1Roast.trigger.kind, "action");
    if (v1Roast.trigger.kind === "action") {
      assert.equal(v1Roast.trigger.eventName, "walkthrough:roast-result-shown");
    }
  });

  it("has at least one step pointing at the roast UI", () => {
    assert.ok(v1Roast.steps.length >= 1);
    const targets = v1Roast.steps.map((s) => s.target);
    assert.ok(targets.includes('[data-walkthrough="roast-score"]'));
  });
});

describe("v1-screener tour content", () => {
  it("is route-triggered on /discover/screener", () => {
    assert.equal(v1Screener.trigger.kind, "route");
    if (v1Screener.trigger.kind === "route") {
      assert.equal(v1Screener.trigger.pathPrefix, "/discover/screener");
    }
  });

  it("covers modes, filters, panel, results, and replay CTA", () => {
    const targets = v1Screener.steps.map((s) => s.target);
    assert.ok(targets.includes('[data-walkthrough="screener-modes"]'));
    assert.ok(targets.includes('[data-walkthrough="screener-filters"]'));
    assert.ok(targets.includes('[data-walkthrough="screener-panel"]'));
    assert.ok(targets.includes('[data-walkthrough="screener-results"]'));
    assert.ok(targets.includes('[data-walkthrough="screener-take-tour"]'));
  });
});

describe("v1-fire tour content", () => {
  it("is route-triggered on /fire", () => {
    assert.equal(v1Fire.trigger.kind, "route");
    if (v1Fire.trigger.kind === "route") {
      assert.equal(v1Fire.trigger.pathPrefix, "/fire");
    }
  });

  it("covers scenario bar, life, money, chart, what-if (save dropped - desktop-only UI)", () => {
    const ids = v1Fire.steps.map((s) => s.id).sort();
    assert.deepEqual(ids, [
      "fire-chart",
      "fire-life",
      "fire-money",
      "fire-name",
      "fire-whatif",
    ]);
  });
});

describe("v1-documents tour content", () => {
  it("is route-triggered on /documents", () => {
    assert.equal(v1Documents.trigger.kind, "route");
    if (v1Documents.trigger.kind === "route") {
      assert.equal(v1Documents.trigger.pathPrefix, "/documents");
    }
  });

  it("covers upload CTA, filters, grid, drop zone", () => {
    const ids = v1Documents.steps.map((s) => s.id).sort();
    assert.deepEqual(ids, [
      "documents-filters",
      "documents-grid",
      "documents-upload",
      "documents-upload-zone",
    ]);
  });
});

describe("exact-match route triggers", () => {
  // MONEY-543 cycle 2 orphan cleanup: the v1-paper assertion was removed
  // when paper-trading was de-platformed (no v1Paper export from
  // lib/walkthrough/tours/index.ts). v1-tradebook keeps the same
  // exact-match invariant — that's the surviving sentinel.
  it("v1-tradebook is exact-match so sub-routes don't trigger it", () => {
    assert.equal(v1Tradebook.trigger.kind, "route");
    if (v1Tradebook.trigger.kind === "route") {
      assert.equal(v1Tradebook.trigger.exact, true);
    }
  });
});

describe("v1-holdings tour content", () => {
  it("is route-triggered on /holdings", () => {
    assert.equal(v1Holdings.trigger.kind, "route");
    if (v1Holdings.trigger.kind === "route") {
      assert.equal(v1Holdings.trigger.pathPrefix, "/holdings");
    }
  });

  it("covers KPIs, tabs, viz, filters, table", () => {
    const ids = v1Holdings.steps.map((s) => s.id).sort();
    assert.deepEqual(ids, [
      "holdings-filters",
      "holdings-kpis",
      "holdings-table",
      "holdings-tabs",
      "holdings-viz",
    ]);
  });
});

// MONEY-543 cycle 2 orphan cleanup: removed `describe("v1-paper tour content")`.
// Paper-trading was de-platformed and `v1Paper` no longer exists in
// `lib/walkthrough/tours/index.ts`. The exact-match invariant for v1-paper
// was also removed from the "exact-match route triggers" suite above.

describe("v1-tradebook tour content", () => {
  it("is route-triggered on /tradebook", () => {
    assert.equal(v1Tradebook.trigger.kind, "route");
    if (v1Tradebook.trigger.kind === "route") {
      assert.equal(v1Tradebook.trigger.pathPrefix, "/tradebook");
    }
  });

  it("covers KPIs, sub-nav tabs, range, side filter, table, add-trade", () => {
    const ids = v1Tradebook.steps.map((s) => s.id).sort();
    assert.deepEqual(ids, [
      "tradebook-add",
      "tradebook-kpis",
      "tradebook-range",
      "tradebook-side",
      "tradebook-table",
      "tradebook-tabs",
    ]);
  });
});

describe("Tour registry", () => {
  // MONEY-543 cycle 2 orphan cleanup: the test originally asserted 19 tours
  // including the five paper-trading variants. After paper-trading was
  // de-platformed the registry shrank to 14. The four sub-tour assertions
  // (paper-chat / paper-terminal / paper-positions / paper-history) in
  // walkthrough-subtours.test.ts were removed in the same cycle.
  it("exposes fourteen v1 tours via TOUR_LIST (paper-trading de-platformed)", () => {
    const versions = TOUR_LIST.map((t) => t.version).sort();
    assert.deepEqual(versions, [
      "v1-core",
      "v1-documents",
      "v1-fire",
      "v1-holdings",
      "v1-holdings-funds",
      "v1-holdings-positions",
      "v1-roast",
      "v1-screener",
      "v1-screener-etf",
      "v1-screener-mf",
      "v1-tradebook",
      "v1-tradebook-export",
      "v1-tradebook-history",
      "v1-tradebook-import",
    ]);
  });

  it("nine tours are route-triggered, five are action-triggered, zero manual", () => {
    // MONEY-543 cycle 2: route count dropped from 14 → 9 because the five
    // paper-trading tours (all route-triggered) were removed.
    const route = TOUR_LIST.filter((t) => t.trigger.kind === "route");
    const action = TOUR_LIST.filter((t) => t.trigger.kind === "action");
    const manual = TOUR_LIST.filter((t) => t.trigger.kind === "manual");
    assert.equal(route.length, 9);
    assert.equal(action.length, 5);
    assert.equal(manual.length, 0);
  });

  it("action triggers cover roast + holdings tab opens + screener mode switches", () => {
    const names = getActionEventNames();
    assert.ok(names.includes("walkthrough:roast-result-shown"));
    assert.ok(names.includes("walkthrough:holdings-funds-opened"));
    assert.ok(names.includes("walkthrough:holdings-positions-opened"));
    assert.ok(names.includes("walkthrough:screener-mode-mf"));
    assert.ok(names.includes("walkthrough:screener-mode-etf"));
  });

  it("collects action event names for the provider's listener setup", () => {
    const names = getActionEventNames();
    assert.ok(names.includes("walkthrough:roast-result-shown"));
    assert.equal(names.length, 5);
  });

  it("registers a tour for every page bundle in MONEY-387 v1.4", () => {
    // MONEY-543 cycle 2: five /paper-trading/* prefixes removed.
    const pathPrefixes = TOUR_LIST.filter((t) => t.trigger.kind === "route")
      .map((t) => {
        if (t.trigger.kind !== "route") return "";
        return t.trigger.pathPrefix;
      })
      .sort();
    assert.deepEqual(pathPrefixes, [
      "/dashboard",
      "/discover/screener",
      "/documents",
      "/fire",
      "/holdings",
      "/tradebook",
      "/tradebook/export",
      "/tradebook/import",
      "/tradebook/import/history",
    ]);
  });
});

describe("Reset semantics", () => {
  function simulateReset(seen: string[], version: string): string[] {
    return seen.filter((v) => v !== version);
  }

  it("removes the target version", () => {
    assert.deepEqual(simulateReset(["v1-core"], "v1-core"), []);
  });

  it("preserves other versions", () => {
    assert.deepEqual(simulateReset(["v1-core", "v2-roast"], "v1-core"), [
      "v2-roast",
    ]);
  });

  it("is a no-op when the version is not present", () => {
    assert.deepEqual(simulateReset(["v2-roast"], "v1-core"), ["v2-roast"]);
  });
});
