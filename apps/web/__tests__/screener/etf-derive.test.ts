/**
 * MONEY-393 §6 - ETF derivation helpers used by the screener filters.
 *
 * Pure-function tests for `lib/screener/etf-derive.ts`:
 *   - extractEtfFundHouse: AMC name extraction (HDFC, ICICI Prudential, …)
 *   - deriveEtfCategory: name → category bucket (Large Cap / Banking / …)
 *   - deriveEtfAssetClass: name → equity / debt / hybrid / solution / other
 *   - ETF_FUND_HOUSE_OPTIONS + ETF_CATEGORY_OPTIONS shape contracts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEtfFundHouse,
  deriveEtfCategory,
  deriveEtfAssetClass,
  ETF_FUND_HOUSE_OPTIONS,
  ETF_CATEGORY_OPTIONS,
} from "@/lib/screener/etf-derive";

describe("MONEY-393 §6 - ETF derivation helpers", () => {
  it("[fund-house] HDFC prefix → Hdfc (titleCase normalizes acronyms)", () => {
    assert.equal(extractEtfFundHouse("HDFC Nifty 50 ETF"), "Hdfc");
  });

  it("[fund-house] ICICI PRUDENTIAL prefix → Icici Prudential (per titleCase helper)", () => {
    // The titleCase helper lowercases everything after the first letter
    // of each word, so the canonical "ICICI" acronym becomes "Icici".
    // Document this behavior - UI fund-house list options also use it
    // via ETF_FUND_HOUSE_OPTIONS.
    assert.equal(
      extractEtfFundHouse("ICICI Prudential Nifty 50 ETF"),
      "Icici Prudential"
    );
  });

  it("[fund-house] case-insensitive match", () => {
    assert.equal(
      extractEtfFundHouse("nippon india nifty 50 etf"),
      "Nippon India"
    );
  });

  it("[fund-house] unknown house with ' ETF' separator → first segment", () => {
    // Falls through to the " ETF" split fallback.
    const r = extractEtfFundHouse("MysteryHouse Custom Index ETF");
    assert.ok(r.includes("Mysteryhouse") || r === "Mysteryhouse Custom Index");
  });

  it("[fund-house] no recognizable prefix or ETF suffix → Other", () => {
    assert.equal(extractEtfFundHouse("Just A Random String"), "Other");
  });

  it("[fund-house] leading/trailing quotes stripped", () => {
    assert.equal(extractEtfFundHouse('"HDFC Nifty 50 ETF"'), "Hdfc");
  });

  it("[category] Nifty 50 / Sensex → Large Cap", () => {
    assert.equal(deriveEtfCategory("ICICI Nifty 50 ETF"), "Large Cap");
    assert.equal(deriveEtfCategory("HDFC Sensex ETF"), "Large Cap");
    assert.equal(deriveEtfCategory("Nippon Nifty Next 50 ETF"), "Large Cap");
  });

  it("[category] Midcap / Smallcap → Mid Cap / Small Cap", () => {
    assert.equal(deriveEtfCategory("Motilal Oswal Midcap ETF"), "Mid Cap");
    assert.equal(deriveEtfCategory("Nippon Smallcap ETF"), "Small Cap");
  });

  it("[category] Bank / Financial → Banking", () => {
    assert.equal(deriveEtfCategory("Kotak Bank ETF"), "Banking");
    assert.equal(deriveEtfCategory("ICICI Financial Services ETF"), "Banking");
  });

  it("[category] Gold / Silver → Commodity (highest priority)", () => {
    // Gold/Silver match BEFORE any other branch so a "Gold Bank" would
    // still come out as Commodity.
    assert.equal(deriveEtfCategory("Nippon Gold ETF"), "Commodity");
    assert.equal(deriveEtfCategory("HDFC Silver ETF"), "Commodity");
  });

  it("[category] Liquid / Overnight → Liquid", () => {
    assert.equal(deriveEtfCategory("DSP Liquid ETF"), "Liquid");
    assert.equal(deriveEtfCategory("ICICI Overnight ETF"), "Liquid");
  });

  it("[category] NASDAQ / S&P 500 → International", () => {
    assert.equal(
      deriveEtfCategory("Motilal Oswal NASDAQ 100 ETF"),
      "International"
    );
    assert.equal(deriveEtfCategory("Nippon S&P 500 ETF"), "International");
  });

  it("[category] no match → Other", () => {
    assert.equal(deriveEtfCategory("Foo Bar Index ETF"), "Other");
  });

  it("[asset-class] equity ETFs (Nifty/Sensex/sector) → equity", () => {
    assert.equal(deriveEtfAssetClass("ICICI Nifty 50 ETF"), "equity");
    assert.equal(deriveEtfAssetClass("HDFC Bank Nifty ETF"), "equity");
  });

  it("[asset-class] debt ETFs (GILT/BOND/SDL/Liquid) → debt", () => {
    assert.equal(deriveEtfAssetClass("DSP GILT ETF"), "debt");
    assert.equal(deriveEtfAssetClass("HDFC PSU Bond ETF"), "debt");
    assert.equal(deriveEtfAssetClass("DSP Liquid ETF"), "debt");
  });

  it("[asset-class] gold/silver → other", () => {
    assert.equal(deriveEtfAssetClass("Nippon Gold ETF"), "other");
    assert.equal(deriveEtfAssetClass("HDFC Silver ETF"), "other");
  });

  it("[asset-class] hybrid / balanced advantage → hybrid", () => {
    assert.equal(deriveEtfAssetClass("ICICI Balanced Advantage ETF"), "hybrid");
  });

  it("[asset-class] target maturity / retirement → solution", () => {
    assert.equal(
      deriveEtfAssetClass("Bharat Target Maturity 2027 ETF"),
      "solution"
    );
    assert.equal(deriveEtfAssetClass("DSP Retirement ETF"), "solution");
  });

  it("[options] fund-house options list is non-empty + title-cased", () => {
    assert.ok(ETF_FUND_HOUSE_OPTIONS.length >= 10);
    // All entries should be title-cased (first letter of each word
    // upper, rest lower), not SHOUTY UPPER like the internal const.
    for (const opt of ETF_FUND_HOUSE_OPTIONS) {
      assert.notEqual(
        opt,
        opt.toUpperCase(),
        `${opt} should not be all-caps in the UI list`
      );
    }
  });

  it("[options] category options list contains the core buckets", () => {
    const want = [
      "Large Cap",
      "Mid Cap",
      "Small Cap",
      "Banking",
      "Technology",
      "Commodity",
      "Debt",
      "Other",
    ];
    for (const c of want) {
      assert.ok(
        ETF_CATEGORY_OPTIONS.includes(c),
        `${c} must be a screener category option`
      );
    }
  });
});
