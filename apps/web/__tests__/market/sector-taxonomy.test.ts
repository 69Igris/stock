/**
 * Sector Taxonomy Tests
 *
 * Tests for the centralized NSE sector taxonomy including:
 * - Yahoo → NSE sector normalization
 * - Sector display config lookups
 * - getAllSectorNames utility
 * - NSE_SECTORS and YAHOO_TO_NSE_MAP constants
 *
 * De-shadowed: imports the REAL exports from @usemoney/core
 * (packages/core/src/market-data/instruments/sector-taxonomy.ts) instead
 * of re-implementing the maps + functions inline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NSE_SECTORS,
  YAHOO_TO_NSE_MAP,
  normalizeToNseSector,
  getSectorDisplayConfig,
  getAllSectorNames,
} from "@usemoney/core";

// ── Tests ────────────────────────────────────────────────────────

describe("Sector Taxonomy", () => {
  describe("NSE_SECTORS constant", () => {
    it("should have exactly 13 sectors", () => {
      // 13 since 2026-07-30 — Real Estate split out of Financial Services.
      assert.strictEqual(Object.keys(NSE_SECTORS).length, 13);
    });

    it("should have required fields for every sector", () => {
      for (const [name, config] of Object.entries(NSE_SECTORS)) {
        assert.ok(config.label, `${name} missing label`);
        assert.ok(config.color, `${name} missing color`);
        assert.ok(config.icon, `${name} missing icon`);
      }
    });

    it("should have valid hex colors", () => {
      const hexPattern = /^#[0-9a-fA-F]{6}$/;
      for (const [name, config] of Object.entries(NSE_SECTORS)) {
        assert.ok(
          hexPattern.test(config.color),
          `${name} has invalid color: ${config.color}`
        );
      }
    });

    it("should contain Information Technology sector", () => {
      assert.ok(NSE_SECTORS["Information Technology"]);
      assert.strictEqual(
        NSE_SECTORS["Information Technology"].label,
        "IT & Technology"
      );
    });

    it("should contain Financial Services sector", () => {
      assert.ok(NSE_SECTORS["Financial Services"]);
      assert.strictEqual(
        NSE_SECTORS["Financial Services"].label,
        "Banking & Finance"
      );
    });
  });

  describe("YAHOO_TO_NSE_MAP constant", () => {
    it("should map every Yahoo sector to a valid NSE sector", () => {
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
      assert.strictEqual(YAHOO_TO_NSE_MAP["Realty"], "Real Estate");
    });
  });

  describe("normalizeToNseSector", () => {
    it("should return direct NSE sector unchanged", () => {
      assert.strictEqual(normalizeToNseSector("Healthcare"), "Healthcare");
      assert.strictEqual(normalizeToNseSector("Energy"), "Energy");
      assert.strictEqual(normalizeToNseSector("FMCG"), "FMCG");
    });

    it("should map Yahoo GICS sectors to NSE sectors", () => {
      assert.strictEqual(
        normalizeToNseSector("Technology"),
        "Information Technology"
      );
      assert.strictEqual(
        normalizeToNseSector("Consumer Cyclical"),
        "Consumer Discretionary"
      );
      assert.strictEqual(
        normalizeToNseSector("Basic Materials"),
        "Commodities"
      );
      assert.strictEqual(normalizeToNseSector("Consumer Defensive"), "FMCG");
    });

    it("should map Communication Services to Telecommunication", () => {
      assert.strictEqual(
        normalizeToNseSector("Communication Services"),
        "Telecommunication"
      );
    });

    it("should normalise Real Estate and Realty to Real Estate", () => {
      assert.strictEqual(normalizeToNseSector("Real Estate"), "Real Estate");
      assert.strictEqual(normalizeToNseSector("Realty"), "Real Estate");
    });

    it("should return unknown sectors as-is", () => {
      assert.strictEqual(normalizeToNseSector("Aerospace"), "Aerospace");
      assert.strictEqual(
        normalizeToNseSector("Unknown Sector"),
        "Unknown Sector"
      );
    });

    it("should return empty string unchanged", () => {
      assert.strictEqual(normalizeToNseSector(""), "");
    });

    it("should handle Financial Services (exists in both maps)", () => {
      // "Financial Services" is both an NSE sector and a Yahoo sector
      assert.strictEqual(
        normalizeToNseSector("Financial Services"),
        "Financial Services"
      );
    });

    it("should handle Healthcare (exists in both maps)", () => {
      assert.strictEqual(normalizeToNseSector("Healthcare"), "Healthcare");
    });

    it("should handle all Yahoo sectors", () => {
      for (const [yahoo, expected] of Object.entries(YAHOO_TO_NSE_MAP)) {
        assert.strictEqual(
          normalizeToNseSector(yahoo),
          expected,
          `normalizeToNseSector("${yahoo}") should return "${expected}"`
        );
      }
    });
  });

  describe("getSectorDisplayConfig", () => {
    it("should return config for known NSE sector", () => {
      const config = getSectorDisplayConfig("Information Technology");
      assert.strictEqual(config.label, "IT & Technology");
      assert.strictEqual(config.color, "#3b82f6");
      assert.strictEqual(config.icon, "Cpu");
    });

    it("should return config for Yahoo sector (via normalization)", () => {
      const config = getSectorDisplayConfig("Technology");
      assert.strictEqual(config.label, "IT & Technology");
      assert.strictEqual(config.color, "#3b82f6");
    });

    it("should return config for Consumer Cyclical (via normalization)", () => {
      const config = getSectorDisplayConfig("Consumer Cyclical");
      assert.strictEqual(config.label, "Consumer Discretionary");
      assert.strictEqual(config.color, "#8b5cf6");
    });

    it("should return config for Basic Materials (maps to Commodities)", () => {
      const config = getSectorDisplayConfig("Basic Materials");
      assert.strictEqual(config.label, "Metals & Commodities");
      assert.strictEqual(config.icon, "Pickaxe");
    });

    it("should return fallback for unknown sector", () => {
      const config = getSectorDisplayConfig("Aerospace");
      assert.strictEqual(config.label, "Aerospace");
      assert.strictEqual(config.color, "#6b7280");
      assert.strictEqual(config.icon, "Circle");
    });

    it("should return fallback for empty string", () => {
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
          NSE_SECTORS[sectorName].label,
          `Config mismatch for "${sectorName}"`
        );
      }
    });
  });

  describe("getAllSectorNames", () => {
    it("should return 13 sector names", () => {
      const names = getAllSectorNames();
      assert.strictEqual(names.length, 13);
    });

    it("should include Information Technology", () => {
      const names = getAllSectorNames();
      assert.ok(names.includes("Information Technology"));
    });

    it("should include FMCG", () => {
      const names = getAllSectorNames();
      assert.ok(names.includes("FMCG"));
    });

    it("should include all NSE sector keys", () => {
      const names = getAllSectorNames();
      for (const key of Object.keys(NSE_SECTORS)) {
        assert.ok(names.includes(key), `Missing sector: ${key}`);
      }
    });

    it("should not include Yahoo-specific sector names", () => {
      const names = getAllSectorNames();
      // Yahoo GICS names that are NOT canonical NSE sectors must be absent.
      assert.ok(!names.includes("Technology"));
      assert.ok(!names.includes("Consumer Cyclical"));
      assert.ok(!names.includes("Basic Materials"));
      assert.ok(!names.includes("Consumer Defensive"));
    });
  });
});
