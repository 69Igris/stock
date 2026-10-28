/**
 * MONEY-393 §1 - Walkthrough sub-tour content tests.
 *
 * `__tests__/actions/walkthrough.test.ts` already covers the 8 top-
 * level tours (v1-core / v1-roast / v1-screener / v1-fire / v1-holdings
 * / v1-paper / v1-tradebook / v1-documents) at step-level + the full
 * 19-tour registry at integrity level. This split sister-file adds
 * step-level content tests for the 11 sub-tours that the original only
 * covered via `KNOWN_WALKTHROUGH_VERSIONS` / `TOUR_LIST`:
 *
 *   v1-holdings-funds, v1-holdings-positions,
 *   v1-paper-chat, v1-paper-terminal, v1-paper-positions, v1-paper-history,
 *   v1-screener-mf, v1-screener-etf,
 *   v1-tradebook-import, v1-tradebook-history, v1-tradebook-export
 *
 * Top-level `it()` (no `describe` wrapper) - keeps node:test
 * `--test-force-exit` from racing the queue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// MONEY-543 cycle 2 orphan cleanup: dropped `v1PaperChat`, `v1PaperTerminal`,
// `v1PaperPositions`, `v1PaperHistory` from the import — these sub-tours
// were removed when paper-trading was de-platformed. The four describe
// blocks that asserted against them are deleted below; remaining sub-tours
// (holdings / screener / tradebook) keep their existing tests.
import {
  v1HoldingsFunds,
  v1HoldingsPositions,
  v1ScreenerMf,
  v1ScreenerEtf,
  v1TradebookImport,
  v1TradebookHistory,
  v1TradebookExport,
} from "@/lib/walkthrough/tours";
import type { TourDefinition } from "@/components/walkthrough/types";

function stepIds(tour: TourDefinition): string[] {
  return tour.steps.map((s) => s.id).sort();
}

describe("MONEY-393 §1 - Walkthrough sub-tour content (11 tours)", () => {
  // ── Holdings sub-tabs ─────────────────────────────────────────────

  it("[walkthrough][holdings-funds] action-triggered + 3 steps (viz, filters, table)", () => {
    assert.equal(v1HoldingsFunds.version, "v1-holdings-funds");
    assert.equal(v1HoldingsFunds.trigger.kind, "action");
    if (v1HoldingsFunds.trigger.kind === "action") {
      assert.equal(
        v1HoldingsFunds.trigger.eventName,
        "walkthrough:holdings-funds-opened"
      );
    }
    assert.deepEqual(stepIds(v1HoldingsFunds), [
      "holdings-funds-filters",
      "holdings-funds-table",
      "holdings-funds-viz",
    ]);
  });

  it("[walkthrough][holdings-positions] action-triggered + 2 steps (filter, table)", () => {
    assert.equal(v1HoldingsPositions.version, "v1-holdings-positions");
    assert.equal(v1HoldingsPositions.trigger.kind, "action");
    assert.deepEqual(stepIds(v1HoldingsPositions), [
      "holdings-positions-filter",
      "holdings-positions-table",
    ]);
  });

  // ── Paper Trading sub-routes ──────────────────────────────────────
  // MONEY-543 cycle 2 orphan cleanup: removed the four paper-trading
  // sub-tour assertions (paper-chat, paper-terminal, paper-positions,
  // paper-history). Their tours were deleted when paper-trading was
  // de-platformed, so the exports no longer exist on
  // `lib/walkthrough/tours/index.ts`. Holdings + Screener + Tradebook
  // sub-tours remain below.

  // ── Screener sub-modes ────────────────────────────────────────────

  it("[walkthrough][screener-mf] action-triggered + 2 steps (filters, results)", () => {
    assert.equal(v1ScreenerMf.version, "v1-screener-mf");
    assert.equal(v1ScreenerMf.trigger.kind, "action");
    if (v1ScreenerMf.trigger.kind === "action") {
      assert.equal(
        v1ScreenerMf.trigger.eventName,
        "walkthrough:screener-mode-mf"
      );
    }
    assert.deepEqual(stepIds(v1ScreenerMf), [
      "screener-mf-filters",
      "screener-mf-results",
    ]);
  });

  it("[walkthrough][screener-etf] action-triggered + 2 steps (filters, results)", () => {
    assert.equal(v1ScreenerEtf.version, "v1-screener-etf");
    assert.equal(v1ScreenerEtf.trigger.kind, "action");
    assert.deepEqual(stepIds(v1ScreenerEtf), [
      "screener-etf-filters",
      "screener-etf-results",
    ]);
  });

  // ── Tradebook sub-routes ──────────────────────────────────────────

  it("[walkthrough][tradebook-import] route-exact + 3 steps (broker, drop, history)", () => {
    assert.equal(v1TradebookImport.version, "v1-tradebook-import");
    assert.equal(v1TradebookImport.trigger.kind, "route");
    if (v1TradebookImport.trigger.kind === "route") {
      assert.equal(v1TradebookImport.trigger.pathPrefix, "/tradebook/import");
      assert.equal(v1TradebookImport.trigger.exact, true);
    }
    assert.deepEqual(stepIds(v1TradebookImport), [
      "tradebook-import-broker",
      "tradebook-import-drop",
      "tradebook-import-history",
    ]);
  });

  it("[walkthrough][tradebook-history] route on /tradebook/import/history + 1 step", () => {
    assert.equal(v1TradebookHistory.version, "v1-tradebook-history");
    assert.equal(v1TradebookHistory.trigger.kind, "route");
    if (v1TradebookHistory.trigger.kind === "route") {
      assert.equal(
        v1TradebookHistory.trigger.pathPrefix,
        "/tradebook/import/history"
      );
    }
    assert.deepEqual(stepIds(v1TradebookHistory), ["tradebook-history-list"]);
  });

  it("[walkthrough][tradebook-export] route on /tradebook/export + 3 steps", () => {
    assert.equal(v1TradebookExport.version, "v1-tradebook-export");
    assert.equal(v1TradebookExport.trigger.kind, "route");
    if (v1TradebookExport.trigger.kind === "route") {
      assert.equal(v1TradebookExport.trigger.pathPrefix, "/tradebook/export");
    }
    assert.deepEqual(stepIds(v1TradebookExport), [
      "tradebook-export-action",
      "tradebook-export-filters",
      "tradebook-export-format",
    ]);
  });

  // ── Cross-tour invariants ─────────────────────────────────────────

  it("[walkthrough][invariants] every sub-tour has at least one step", () => {
    const subTours = [
      v1HoldingsFunds,
      v1HoldingsPositions,
      v1ScreenerMf,
      v1ScreenerEtf,
      v1TradebookImport,
      v1TradebookHistory,
      v1TradebookExport,
    ];
    for (const t of subTours) {
      assert.ok(
        t.steps.length >= 1,
        `${t.version} must have at least one step`
      );
    }
  });

  it("[walkthrough][invariants] every sub-tour step has a non-empty target selector", () => {
    const subTours = [
      v1HoldingsFunds,
      v1HoldingsPositions,
      v1ScreenerMf,
      v1ScreenerEtf,
      v1TradebookImport,
      v1TradebookHistory,
      v1TradebookExport,
    ];
    for (const t of subTours) {
      for (const s of t.steps) {
        assert.ok(
          typeof s.target === "string" && s.target.length > 0,
          `${t.version}#${s.id} must have a target selector`
        );
        assert.ok(
          s.headline.length > 0,
          `${t.version}#${s.id} must have a non-empty headline`
        );
      }
    }
  });

  it("[walkthrough][invariants] step ids within a tour are unique", () => {
    const subTours = [
      v1HoldingsFunds,
      v1HoldingsPositions,
      v1ScreenerMf,
      v1ScreenerEtf,
      v1TradebookImport,
      v1TradebookHistory,
      v1TradebookExport,
    ];
    for (const t of subTours) {
      const ids = t.steps.map((s) => s.id);
      assert.equal(
        new Set(ids).size,
        ids.length,
        `${t.version} has duplicate step ids: ${ids.join(", ")}`
      );
    }
  });
});
