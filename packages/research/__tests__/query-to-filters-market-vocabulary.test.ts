/**
 * MONEY-1204 (P14 / 14e.1) — the AI filter-builder's market-structure
 * vocabulary.
 *
 * The failure this file exists to prevent is SILENT: a phrase that maps to a
 * field id the screener engine does not know is dropped by
 * `runFundamentalScreen` with a `console.warn`, and the screen runs on
 * everything else. The user gets stocks back, none of them filtered on what
 * they asked for. That is exactly what "FII holding above 20" was doing before
 * this ticket — `fiiHolding` is in no registry at all.
 *
 * So the first test is a CROSS-CHECK against the registry itself, not against a
 * hand-written list of ids: every market-structure field id this parser can
 * emit must exist in `MARKET_FIELDS`, and every field in `MARKET_FIELDS` must
 * have at least one phrase that reaches it.
 *
 * Source: packages/research/src/tools/query-to-filters.ts
 *         packages/core/src/screener/market-fields-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseQueryToFilters } from "../src/tools/query-to-filters";
import {
  MARKET_FIELDS,
  isMarketStructure,
} from "@usemoney/core/screener/engine";

/**
 * One natural-language phrase per registered market-structure field.
 *
 * Keyed by field id and checked for EXHAUSTIVENESS below, so adding a field to
 * the registry without giving the agent a way to ask for it fails here rather
 * than shipping a field nobody can reach.
 */
const PHRASE_PER_FIELD: Record<string, string> = {
  deliveryPct: "stocks with delivery above 70",
  deliveryPct20dAvg: "20 day average delivery above 55",
  asmFlag: "stocks under ASM",
  gsmFlag: "names under GSM",
  priceBandFlag: "stocks hitting a price band",
  foBanFlag: "securities in ban list today",
  pledgedPct: "pledged shares above 20",
  pledgedPctQoqDelta: "rising promoter pledge",
  fiiPct: "fii holding above 20",
  fiiPctQoqDelta: "fii stake increasing",
  diiPct: "dii holding above 12",
  diiPctQoqDelta: "dii holding reducing",
  indexMember: "companies that are part of the nifty 50",
  pcrOi: "pcr above 1.2",
  futOiChange: "futures open interest rising",
  mwplUtilisation: "mwpl above 85",
  bondYield: "bond yield above 8",
  bondPrice: "bond price below 95",
  bondCoupon: "coupon rate above 7.5",
};

describe("market-structure vocabulary ↔ registry", () => {
  it("covers EVERY registered field — a field with no phrase is unreachable", () => {
    const registered = MARKET_FIELDS.map((f) => f.id).sort();
    const phrased = Object.keys(PHRASE_PER_FIELD).sort();
    assert.deepEqual(phrased, registered);
  });

  it("every phrase reaches its field, and the engine recognises the id", () => {
    for (const [field, phrase] of Object.entries(PHRASE_PER_FIELD)) {
      const parsed = parseQueryToFilters(phrase);
      const hit = parsed.filters.find((f) => f.field === field);
      assert.ok(hit, `"${phrase}" did not produce a ${field} filter`);
      // The cross-check that matters: an emitted id the engine does not know is
      // dropped at screen time with no user-visible symptom.
      assert.equal(isMarketStructure(hit!.field), true, field);
      assert.equal(
        typeof hit!.value === "number" && Number.isFinite(hit!.value),
        true,
        `${field} produced a non-finite value`,
      );
    }
  });

  it("never emits a market-structure id that is not in the registry", () => {
    const probes = [
      ...Object.values(PHRASE_PER_FIELD),
      "exclude ASM stocks",
      "not under GSM",
      "stocks outside the F&O ban",
      "zero promoter pledge",
      "high delivery stocks",
      "index constituents",
      "PE below 15 and ROE above 20 with delivery above 60",
    ];
    for (const q of probes) {
      for (const f of parseQueryToFilters(q).filters) {
        // Every field is either a known market field or belongs to one of the
        // pre-existing classes; what must never happen is a market-SOUNDING id
        // that no registry holds.
        if (
          f.field.startsWith("delivery") ||
          f.field.startsWith("bond") ||
          f.field.endsWith("Flag") ||
          f.field.startsWith("pledged") ||
          f.field === "indexMember" ||
          f.field === "pcrOi" ||
          f.field === "futOiChange" ||
          f.field === "mwplUtilisation" ||
          f.field === "fiiPct" ||
          f.field === "diiPct" ||
          f.field.endsWith("QoqDelta")
        ) {
          assert.equal(isMarketStructure(f.field), true, `${q} → ${f.field}`);
        }
      }
    }
  });
});

describe("boolean phrasings carry the RIGHT polarity", () => {
  const polarity: Array<[string, string, number]> = [
    ["stocks under ASM", "asmFlag", 1],
    ["exclude ASM stocks", "asmFlag", 0],
    ["avoid stocks under ASM", "asmFlag", 0],
    ["names under GSM", "gsmFlag", 1],
    ["not under GSM", "gsmFlag", 0],
    ["securities in ban list today", "foBanFlag", 1],
    ["stocks outside the F&O ban", "foBanFlag", 0],
    ["stocks hitting a price band", "priceBandFlag", 1],
    ["index constituents", "indexMember", 1],
  ];

  for (const [phrase, field, expected] of polarity) {
    it(`"${phrase}" → ${field} = ${expected}`, () => {
      const filters = parseQueryToFilters(phrase).filters.filter(
        (f) => f.field === field,
      );
      // Exactly ONE filter per field: the negation and the bare mention both
      // match the same text, and emitting both would AND a constraint with its
      // own opposite — a screen that can never return anything.
      assert.equal(filters.length, 1, `expected exactly one ${field} filter`);
      assert.equal(filters[0]!.operator, "eq");
      assert.equal(filters[0]!.value, expected);
    });
  }
});

describe("nested phrasings do not double-emit", () => {
  it("'20 day average delivery above 55' does not ALSO emit a raw deliveryPct", () => {
    const filters = parseQueryToFilters(
      "20 day average delivery above 55",
    ).filters;
    assert.deepEqual(
      filters.map((f) => f.field),
      ["deliveryPct20dAvg"],
    );
    // The general pattern's text ("delivery above 55") is genuinely inside the
    // specific one; emitting both would AND a same-day threshold onto a 20-day
    // average the user never asked for.
  });

  it("still emits the raw field when no average was named", () => {
    const filters = parseQueryToFilters("delivery above 55").filters;
    assert.deepEqual(
      filters.map((f) => f.field),
      ["deliveryPct"],
    );
  });
});

describe("indexMember carries its operand", () => {
  it("names the index slug so the filter can be evaluated", () => {
    const f = parseQueryToFilters(
      "companies that are part of the nifty 50",
    ).filters.find((x) => x.field === "indexMember");
    assert.ok(f);
    assert.equal(f!.operand, "nifty50");
  });

  it("omits the operand when no index was named — 'in any index'", () => {
    const f = parseQueryToFilters("index constituents").filters.find(
      (x) => x.field === "indexMember",
    );
    assert.ok(f);
    assert.equal(f!.operand, undefined);
  });
});

describe("the retargeted FII/DII patterns", () => {
  it("emit fiiPct / diiPct, which the engine can actually run", () => {
    // Before MONEY-1204 these emitted `fiiHolding` / `diiHolding`, ids that
    // exist in NO registry — so `runFundamentalScreen` logged
    // "dropping unsupported fundamental filter field" and screened on nothing.
    const fii = parseQueryToFilters("fii holding above 20").filters;
    assert.deepEqual(fii, [{ field: "fiiPct", operator: "gt", value: 20 }]);
    assert.equal(isMarketStructure("fiiPct"), true);
    assert.equal(isMarketStructure("fiiHolding"), false);

    const dii = parseQueryToFilters("dii holding above 12").filters;
    assert.deepEqual(dii, [{ field: "diiPct", operator: "gt", value: 12 }]);
  });
});

describe("market-structure filters coexist with the existing classes", () => {
  it("a mixed query yields fundamental + technical + market filters together", () => {
    const parsed = parseQueryToFilters(
      "PE below 15 and RSI below 30 with delivery above 60 excluding ASM stocks",
    );
    const byField = new Map(parsed.filters.map((f) => [f.field, f]));
    assert.equal(byField.get("pe")?.value, 15);
    assert.equal(byField.get("rsi_14")?.value, 30);
    assert.equal(byField.get("deliveryPct")?.value, 60);
    assert.equal(byField.get("asmFlag")?.value, 0);
  });

  it("leaves an unrelated query untouched", () => {
    const parsed = parseQueryToFilters("golden cross stocks");
    assert.equal(parsed.strategy, "golden_cross");
    assert.equal(
      parsed.filters.some((f) => isMarketStructure(f.field)),
      false,
    );
  });
});
