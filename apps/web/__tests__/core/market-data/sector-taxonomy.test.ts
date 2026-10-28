/**
 * Sector Taxonomy Tests
 *
 * Exercises the REAL NSE sector taxonomy exported from
 * packages/core/src/market-data/instruments/sector-taxonomy.ts (via
 * `@usemoney/core/sector-taxonomy`): `NSE_SECTORS`, `YAHOO_TO_NSE_MAP`,
 * `normalizeToNseSector`, `getSectorDisplayConfig`, `getAllSectorNames`.
 * No inline reimplementation.
 *
 * Divergence the old shadow hid: its inline `YAHOO_TO_NSE_MAP` had only 11
 * entries and asserted `Object.keys === 11`. The REAL map has 28 (it also maps
 * many India-specific Yahoo sector names: Pharma→Healthcare, Power→Energy,
 * Banking/Insurance→Financial Services, Automobile/Textiles→Consumer
 * Discretionary, Metals/Cement/Chemicals→Commodities, etc.). Corrected below.
 *
 * Source: packages/core/src/market-data/instruments/sector-taxonomy.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NSE_SECTORS,
  YAHOO_TO_NSE_MAP,
  normalizeToNseSector,
  getSectorDisplayConfig,
  getAllSectorNames,
} from "@usemoney/core/sector-taxonomy";

// ── Tests ────────────────────────────────────────────────────────

describe("Sector Taxonomy (real @usemoney/core exports)", () => {
  // ────────────────────────────────────────────────────────────────
  // NSE_SECTORS constant
  // ────────────────────────────────────────────────────────────────
  describe("NSE_SECTORS constant", () => {
    it("should contain all 13 sectors", () => {
      // 13 since 2026-07-30: Real Estate was split out of Financial Services
      // (founder decision, MONEY-1093).
      assert.strictEqual(Object.keys(NSE_SECTORS).length, 13);
    });

    it("should have label, color, and icon for every sector", () => {
      for (const [name, config] of Object.entries(NSE_SECTORS)) {
        assert.ok(config.label, `${name} missing label`);
        assert.ok(config.color, `${name} missing color`);
        assert.ok(config.icon, `${name} missing icon`);
      }
    });

    it("should have valid hex color codes", () => {
      const hexPattern = /^#[0-9a-fA-F]{6}$/;
      for (const [name, config] of Object.entries(NSE_SECTORS)) {
        assert.ok(
          hexPattern.test(config.color),
          `${name} has invalid color: ${config.color}`
        );
      }
    });

    it("should contain Information Technology with correct label", () => {
      assert.ok(NSE_SECTORS["Information Technology"]);
      assert.strictEqual(
        NSE_SECTORS["Information Technology"]!.label,
        "IT & Technology"
      );
    });

    it("should contain Financial Services with correct label", () => {
      assert.ok(NSE_SECTORS["Financial Services"]);
      assert.strictEqual(
        NSE_SECTORS["Financial Services"]!.label,
        "Banking & Finance"
      );
    });

    it("should contain Healthcare with correct icon", () => {
      assert.strictEqual(NSE_SECTORS["Healthcare"]!.icon, "Heart");
    });

    it("should contain Energy with correct color", () => {
      assert.strictEqual(NSE_SECTORS["Energy"]!.color, "#f59e0b");
    });

    it("should contain Diversified as the catch-all sector", () => {
      assert.ok(NSE_SECTORS["Diversified"]);
      assert.strictEqual(NSE_SECTORS["Diversified"]!.label, "Diversified");
    });

    it("should have unique colors for each sector", () => {
      const colors = Object.values(NSE_SECTORS).map((c) => c.color);
      const uniqueColors = new Set(colors);
      assert.strictEqual(
        colors.length,
        uniqueColors.size,
        "All sectors should have unique colors"
      );
    });

    it("should have unique icons for each sector", () => {
      const icons = Object.values(NSE_SECTORS).map((c) => c.icon);
      const uniqueIcons = new Set(icons);
      assert.strictEqual(
        icons.length,
        uniqueIcons.size,
        "All sectors should have unique icons"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // YAHOO_TO_NSE_MAP constant
  // ────────────────────────────────────────────────────────────────
  describe("YAHOO_TO_NSE_MAP constant", () => {
    it("should have 31 Yahoo sector mappings (real map — shadow had 11)", () => {
      // A HARDCODED COUNT ON PURPOSE. It looks brittle and that is the point:
      // a count is exactly what catches an alias added — or removed — without
      // anyone noticing, which is the failure class this whole area keeps
      // hitting. Every bump must be a deliberate edit with a reason:
      //
      //   29  the "Realty" alias (MONEY-1093). That change went uncaught,
      //       because nothing under __tests__/core/ was being executed at the
      //       time — see the glob fix in apps/web/package.json.
      //   31  MONEY-1302 added "Media & Entertainment" -> Telecommunication and
      //       "Agriculture" -> FMCG, closing two of the three off-taxonomy
      //       values measured on prod. The third, "Other", is deliberately
      //       NOT mapped — 26 of its 29 rows are bonds.
      assert.strictEqual(Object.keys(YAHOO_TO_NSE_MAP).length, 31);
    });

    it("should map the India-specific Yahoo names the shadow omitted", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Pharma"], "Healthcare");
      assert.strictEqual(YAHOO_TO_NSE_MAP["Power"], "Energy");
      assert.strictEqual(YAHOO_TO_NSE_MAP["Banking"], "Financial Services");
      assert.strictEqual(YAHOO_TO_NSE_MAP["Insurance"], "Financial Services");
      assert.strictEqual(
        YAHOO_TO_NSE_MAP["Automobile"],
        "Consumer Discretionary"
      );
      assert.strictEqual(YAHOO_TO_NSE_MAP["Metals"], "Commodities");
      assert.strictEqual(YAHOO_TO_NSE_MAP["IT"], "Information Technology");
    });

    it("should map every Yahoo sector to a valid NSE sector key", () => {
      for (const [yahoo, nse] of Object.entries(YAHOO_TO_NSE_MAP)) {
        assert.ok(
          nse in NSE_SECTORS,
          `Yahoo sector "${yahoo}" maps to unknown NSE sector "${nse}"`
        );
      }
    });

    it("should map Technology to Information Technology", () => {
      assert.strictEqual(
        YAHOO_TO_NSE_MAP["Technology"],
        "Information Technology"
      );
    });

    it("should map Financial Services to Financial Services (identity)", () => {
      assert.strictEqual(
        YAHOO_TO_NSE_MAP["Financial Services"],
        "Financial Services"
      );
    });

    it("should map Consumer Cyclical to Consumer Discretionary", () => {
      assert.strictEqual(
        YAHOO_TO_NSE_MAP["Consumer Cyclical"],
        "Consumer Discretionary"
      );
    });

    it("should map Basic Materials to Commodities", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Basic Materials"], "Commodities");
    });

    it("should map Consumer Defensive to FMCG", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Consumer Defensive"], "FMCG");
    });

    it("should map Communication Services to Telecommunication", () => {
      assert.strictEqual(
        YAHOO_TO_NSE_MAP["Communication Services"],
        "Telecommunication"
      );
    });

    it("should map Real Estate to its own sector, not Financials", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Real Estate"], "Real Estate");
    });

    it('maps the "Realty" alias to the same place as "Real Estate"', () => {
      // NSE and the screener say "Realty"; Yahoo/GICS says "Real Estate". If
      // these ever diverge, one spelling becomes a bucket the sector filter
      // cannot reach — which is exactly what "Realty" used to be.
      assert.strictEqual(
        YAHOO_TO_NSE_MAP["Realty"],
        YAHOO_TO_NSE_MAP["Real Estate"]
      );
    });

    it("should map Healthcare to Healthcare (identity)", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Healthcare"], "Healthcare");
    });

    it("should map Energy to Energy (identity)", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Energy"], "Energy");
    });

    it("should map Industrials to Industrials (identity)", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Industrials"], "Industrials");
    });

    it("should map Utilities to Utilities (identity)", () => {
      assert.strictEqual(YAHOO_TO_NSE_MAP["Utilities"], "Utilities");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // normalizeToNseSector
  // ────────────────────────────────────────────────────────────────
  describe("normalizeToNseSector", () => {
    it("should return a direct NSE sector key unchanged", () => {
      assert.strictEqual(normalizeToNseSector("Healthcare"), "Healthcare");
      assert.strictEqual(normalizeToNseSector("Energy"), "Energy");
      assert.strictEqual(normalizeToNseSector("FMCG"), "FMCG");
      assert.strictEqual(normalizeToNseSector("Diversified"), "Diversified");
    });

    it("should map Technology to Information Technology", () => {
      assert.strictEqual(
        normalizeToNseSector("Technology"),
        "Information Technology"
      );
    });

    it("should map Consumer Cyclical to Consumer Discretionary", () => {
      assert.strictEqual(
        normalizeToNseSector("Consumer Cyclical"),
        "Consumer Discretionary"
      );
    });

    it("should map Basic Materials to Commodities", () => {
      assert.strictEqual(
        normalizeToNseSector("Basic Materials"),
        "Commodities"
      );
    });

    it("should map Consumer Defensive to FMCG", () => {
      assert.strictEqual(normalizeToNseSector("Consumer Defensive"), "FMCG");
    });

    it("should map Communication Services to Telecommunication", () => {
      assert.strictEqual(
        normalizeToNseSector("Communication Services"),
        "Telecommunication"
      );
    });

    it("should normalise Real Estate to its own sector", () => {
      assert.strictEqual(normalizeToNseSector("Real Estate"), "Real Estate");
      assert.strictEqual(normalizeToNseSector("Realty"), "Real Estate");
    });

    it("should return 'Diversified' unchanged (already an NSE sector)", () => {
      assert.strictEqual(normalizeToNseSector("Diversified"), "Diversified");
    });

    it("should return unknown sectors as-is (no mapping)", () => {
      assert.strictEqual(normalizeToNseSector("Aerospace"), "Aerospace");
      assert.strictEqual(
        normalizeToNseSector("Unknown Sector"),
        "Unknown Sector"
      );
      assert.strictEqual(normalizeToNseSector("Crypto"), "Crypto");
    });

    it("should return empty string unchanged for empty input", () => {
      assert.strictEqual(normalizeToNseSector(""), "");
    });

    it("should handle Financial Services (present in both maps, NSE match wins)", () => {
      assert.strictEqual(
        normalizeToNseSector("Financial Services"),
        "Financial Services"
      );
    });

    it("should handle all Yahoo sectors correctly", () => {
      for (const [yahoo, expected] of Object.entries(YAHOO_TO_NSE_MAP)) {
        assert.strictEqual(
          normalizeToNseSector(yahoo),
          expected,
          `normalizeToNseSector("${yahoo}") should return "${expected}"`
        );
      }
    });

    it("should be case-sensitive (not normalize lowercase variants)", () => {
      // The function does exact key lookups; lowercase should NOT match
      assert.strictEqual(normalizeToNseSector("technology"), "technology");
      assert.strictEqual(normalizeToNseSector("healthcare"), "healthcare");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // getSectorDisplayConfig
  // ────────────────────────────────────────────────────────────────
  describe("getSectorDisplayConfig", () => {
    it("should return config for a known NSE sector", () => {
      const config = getSectorDisplayConfig("Information Technology");
      assert.strictEqual(config.label, "IT & Technology");
      assert.strictEqual(config.color, "#3b82f6");
      assert.strictEqual(config.icon, "Cpu");
    });

    it("should return config for Financial Services", () => {
      const config = getSectorDisplayConfig("Financial Services");
      assert.strictEqual(config.label, "Banking & Finance");
      assert.strictEqual(config.color, "#10b981");
      assert.strictEqual(config.icon, "Landmark");
    });

    it("should return config for a Yahoo sector via normalization", () => {
      const config = getSectorDisplayConfig("Technology");
      assert.strictEqual(config.label, "IT & Technology");
      assert.strictEqual(config.color, "#3b82f6");
    });

    it("should return config for Consumer Cyclical via normalization", () => {
      const config = getSectorDisplayConfig("Consumer Cyclical");
      assert.strictEqual(config.label, "Consumer Discretionary");
      assert.strictEqual(config.color, "#8b5cf6");
    });

    it("should return config for Basic Materials (maps to Commodities)", () => {
      const config = getSectorDisplayConfig("Basic Materials");
      assert.strictEqual(config.label, "Metals & Commodities");
      assert.strictEqual(config.icon, "Pickaxe");
    });

    it("should return config for Communication Services (maps to Telecom)", () => {
      const config = getSectorDisplayConfig("Communication Services");
      assert.strictEqual(config.label, "Telecom & Media");
      assert.strictEqual(config.icon, "Radio");
    });

    it("should return config for Consumer Defensive (maps to FMCG)", () => {
      const config = getSectorDisplayConfig("Consumer Defensive");
      assert.strictEqual(config.label, "FMCG & Essentials");
      assert.strictEqual(config.color, "#22c55e");
    });

    it("should return fallback config for unknown sector", () => {
      const config = getSectorDisplayConfig("Aerospace");
      assert.strictEqual(config.label, "Aerospace");
      assert.strictEqual(config.color, "#6b7280");
      assert.strictEqual(config.icon, "Circle");
    });

    it("should return fallback config with original label for unrecognized input", () => {
      const config = getSectorDisplayConfig("Space Mining");
      assert.strictEqual(config.label, "Space Mining");
    });

    it("should return fallback config for empty string", () => {
      const config = getSectorDisplayConfig("");
      assert.strictEqual(config.label, "");
      assert.strictEqual(config.color, "#6b7280");
      assert.strictEqual(config.icon, "Circle");
    });

    it("should return correct config for all 12 NSE sectors", () => {
      for (const sectorName of Object.keys(NSE_SECTORS)) {
        const config = getSectorDisplayConfig(sectorName);
        assert.strictEqual(
          config.label,
          NSE_SECTORS[sectorName]!.label,
          `Config label mismatch for "${sectorName}"`
        );
        assert.strictEqual(
          config.color,
          NSE_SECTORS[sectorName]!.color,
          `Config color mismatch for "${sectorName}"`
        );
        assert.strictEqual(
          config.icon,
          NSE_SECTORS[sectorName]!.icon,
          `Config icon mismatch for "${sectorName}"`
        );
      }
    });

    it("gives Real Estate a config DISTINCT from Financial Services", () => {
      // The point of the split: two sectors that render identically are one
      // sector as far as a user reading the heatmap is concerned.
      const config = getSectorDisplayConfig("Real Estate");
      const fsConfig = getSectorDisplayConfig("Financial Services");
      assert.notStrictEqual(config.label, fsConfig.label);
      assert.notStrictEqual(config.color, fsConfig.color);
      assert.notStrictEqual(config.icon, fsConfig.icon);
    });

    it('resolves the "Realty" alias to the Real Estate config', () => {
      assert.deepStrictEqual(
        getSectorDisplayConfig("Realty"),
        getSectorDisplayConfig("Real Estate")
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // getAllSectorNames
  // ────────────────────────────────────────────────────────────────
  describe("getAllSectorNames", () => {
    it("should return exactly 13 sector names", () => {
      const names = getAllSectorNames();
      assert.strictEqual(names.length, 13);
    });

    it("should include Information Technology", () => {
      assert.ok(getAllSectorNames().includes("Information Technology"));
    });

    it("should include Financial Services", () => {
      assert.ok(getAllSectorNames().includes("Financial Services"));
    });

    it("should include Healthcare", () => {
      assert.ok(getAllSectorNames().includes("Healthcare"));
    });

    it("should include Energy", () => {
      assert.ok(getAllSectorNames().includes("Energy"));
    });

    it("should include FMCG", () => {
      assert.ok(getAllSectorNames().includes("FMCG"));
    });

    it("should include Diversified", () => {
      assert.ok(getAllSectorNames().includes("Diversified"));
    });

    it("should include all NSE sector keys", () => {
      const names = getAllSectorNames();
      for (const key of Object.keys(NSE_SECTORS)) {
        assert.ok(names.includes(key), `Missing sector: ${key}`);
      }
    });

    it("should NOT include Yahoo-specific sector names", () => {
      const names = getAllSectorNames();
      assert.ok(!names.includes("Technology"));
      assert.ok(!names.includes("Consumer Cyclical"));
      assert.ok(!names.includes("Basic Materials"));
      assert.ok(!names.includes("Consumer Defensive"));
      assert.ok(!names.includes("Communication Services"));
      // "Real Estate" is deliberately NOT in this list any more: as of
      // 2026-07-30 it is a canonical NSE_SECTORS name in its own right, not a
      // Yahoo-only alias awaiting translation. Its alias "Realty" is the one
      // that must stay out of the canonical set.
      assert.ok(!names.includes("Realty"));
    });

    it("should return the same keys as Object.keys(NSE_SECTORS)", () => {
      assert.deepStrictEqual(getAllSectorNames(), Object.keys(NSE_SECTORS));
    });
  });
});
