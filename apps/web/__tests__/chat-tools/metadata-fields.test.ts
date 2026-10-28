/**
 * Metadata Fields Tests (lib/chat-tools/metadata-fields.ts)
 *
 * Tests for:
 *   - All known Yahoo Finance metadata fields are in the set
 *   - Financial fields are NOT in the set
 *   - Set size consistency
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): assert the REAL exported set, not a copy.
import { METADATA_FIELDS } from "@/lib/chat-tools/metadata-fields";

// ── Tests ──────────────────────────────────────────────────────────

describe("METADATA_FIELDS", () => {
  it("should have at least 30 metadata fields", () => {
    assert.ok(METADATA_FIELDS.size >= 30);
  });

  it("should include all core Yahoo identifiers", () => {
    const coreFields = [
      "priceHint",
      "quoteType",
      "symbol",
      "exchange",
      "market",
      "uuid",
    ];
    for (const field of coreFields) {
      assert.ok(METADATA_FIELDS.has(field), `Missing: ${field}`);
    }
  });

  it("should include name fields", () => {
    assert.ok(METADATA_FIELDS.has("shortName"));
    assert.ok(METADATA_FIELDS.has("longName"));
  });

  it("should include timezone fields", () => {
    assert.ok(METADATA_FIELDS.has("exchangeTimezoneName"));
    assert.ok(METADATA_FIELDS.has("exchangeTimezoneShortName"));
    assert.ok(METADATA_FIELDS.has("gmtOffSetMilliseconds"));
  });

  it("should include market state fields", () => {
    assert.ok(METADATA_FIELDS.has("marketState"));
    assert.ok(METADATA_FIELDS.has("tradeable"));
    assert.ok(METADATA_FIELDS.has("hasPrePostMarketData"));
  });

  it("should NOT include financial data fields", () => {
    const financialFields = [
      "totalRevenue",
      "netIncome",
      "ebitda",
      "profitMargins",
      "operatingMargins",
      "grossProfit",
      "freeCashflow",
      "totalDebt",
      "returnOnEquity",
      "earningsGrowth",
      "regularMarketPrice",
      "regularMarketChange",
    ];
    for (const field of financialFields) {
      assert.ok(!METADATA_FIELDS.has(field), `Should NOT include: ${field}`);
    }
  });

  it("should include maxAge (formatting-only field)", () => {
    assert.ok(METADATA_FIELDS.has("maxAge"));
  });

  it("should include currency fields", () => {
    assert.ok(METADATA_FIELDS.has("financialCurrency"));
    assert.ok(METADATA_FIELDS.has("currency"));
  });
});
