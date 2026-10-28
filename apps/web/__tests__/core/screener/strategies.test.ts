/**
 * Screener Strategies Tests — REAL source (de-shadowed for MONEY-620).
 *
 * Tests for the pre-built strategy library in:
 *   packages/core/src/screener/strategies.ts
 *
 * This suite USED to re-declare every strategy array, `findStrategy`,
 * `listStrategiesByCategory`, the `strategy()` helper and the field sets inline
 * and assert the copies — the header claimed it tested the real source but
 * never imported it (a shadow). It now imports the REAL `ALL_STRATEGIES` /
 * `FUNDAMENTAL_STRATEGIES` / `TECHNICAL_STRATEGIES` / `COMBINED_STRATEGIES` /
 * `findStrategy` / `listStrategiesByCategory` from
 * `@usemoney/core/screener/strategies`, and the real `FUNDAMENTAL_FIELDS` /
 * `TECHNICAL_FIELDS` from `@usemoney/core/screener/engine`, so a drift between
 * the strategy definitions and the field taxonomy (e.g. a typo'd filter field
 * that would be silently dropped at screen time) actually FAILS here.
 *
 * Covers (all against the genuine exports):
 * - ALL_STRATEGIES composition, required fields, source: "builtin", unique IDs
 * - findStrategy by exact ID, exact name (case-insensitive), partial name,
 *   empty-string + whitespace + garbage edge cases
 * - listStrategiesByCategory with/without filter, nonexistent category
 * - per-array counts + that every filter field is a real fundamental/technical
 *   column (the load-bearing check the shadow could never enforce)
 * - between-filter bound validity across the WHOLE real library
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FUNDAMENTAL_STRATEGIES,
  TECHNICAL_STRATEGIES,
  COMBINED_STRATEGIES,
  ALL_STRATEGIES,
  findStrategy,
  listStrategiesByCategory,
} from "@usemoney/core/screener/strategies";
import {
  FUNDAMENTAL_FIELDS,
  TECHNICAL_FIELDS,
} from "@usemoney/core/screener/engine";

// Derived from the REAL field sets (was an inline copy before the de-shadow).
const ALL_VALID_FIELDS = new Set([...FUNDAMENTAL_FIELDS, ...TECHNICAL_FIELDS]);

describe("Screener Strategies (real source)", () => {
  // ── ALL_STRATEGIES composition ──────────────────────────────────
  describe("ALL_STRATEGIES composition", () => {
    it("should contain all fundamental strategies", () => {
      for (const s of FUNDAMENTAL_STRATEGIES) {
        assert.ok(ALL_STRATEGIES.includes(s), `missing "${s.id}"`);
      }
    });

    it("should contain all technical strategies", () => {
      for (const s of TECHNICAL_STRATEGIES) {
        assert.ok(ALL_STRATEGIES.includes(s), `missing "${s.id}"`);
      }
    });

    it("should contain all combined strategies", () => {
      for (const s of COMBINED_STRATEGIES) {
        assert.ok(ALL_STRATEGIES.includes(s), `missing "${s.id}"`);
      }
    });

    it("should have length equal to sum of all 3 arrays", () => {
      assert.equal(
        ALL_STRATEGIES.length,
        FUNDAMENTAL_STRATEGIES.length +
          TECHNICAL_STRATEGIES.length +
          COMBINED_STRATEGIES.length
      );
    });

    it("should have exactly 28 strategies total", () => {
      assert.equal(ALL_STRATEGIES.length, 28);
    });
  });

  // ── Required fields ─────────────────────────────────────────────
  describe("Required fields on every strategy", () => {
    it("non-empty id / name / description / category and >=1 filter", () => {
      for (const s of ALL_STRATEGIES) {
        assert.ok(s.id.length > 0, "id");
        assert.ok(s.name.length > 0, `name for ${s.id}`);
        assert.ok(s.description.length > 0, `description for ${s.id}`);
        assert.ok(s.category.length > 0, `category for ${s.id}`);
        assert.ok(s.filters.length > 0, `filters for ${s.id}`);
      }
    });
  });

  describe("Source field", () => {
    it("every strategy has source 'builtin'", () => {
      for (const s of ALL_STRATEGIES) {
        assert.equal(s.source, "builtin", `source for ${s.id}`);
      }
    });
  });

  // ── Unique IDs ──────────────────────────────────────────────────
  describe("No duplicate strategy IDs", () => {
    it("all IDs are unique across the library", () => {
      const ids = ALL_STRATEGIES.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length);
    });

    it("no ID collisions across the three arrays", () => {
      const fund = new Set(FUNDAMENTAL_STRATEGIES.map((s) => s.id));
      const tech = new Set(TECHNICAL_STRATEGIES.map((s) => s.id));
      for (const s of TECHNICAL_STRATEGIES) {
        assert.ok(!fund.has(s.id), `tech "${s.id}" collides with fundamental`);
      }
      for (const s of COMBINED_STRATEGIES) {
        assert.ok(
          !fund.has(s.id),
          `combined "${s.id}" collides with fundamental`
        );
        assert.ok(
          !tech.has(s.id),
          `combined "${s.id}" collides with technical`
        );
      }
    });
  });

  // ── findStrategy ────────────────────────────────────────────────
  describe("findStrategy", () => {
    it("finds by exact ID (fundamental / technical / combined)", () => {
      assert.equal(findStrategy("value_investing")?.id, "value_investing");
      assert.equal(findStrategy("golden_cross")?.id, "golden_cross");
      assert.equal(findStrategy("buffett_style")?.id, "buffett_style");
    });

    it("finds by exact name, case-insensitive", () => {
      assert.equal(findStrategy("value investing")?.id, "value_investing");
      assert.equal(findStrategy("VALUE INVESTING")?.id, "value_investing");
      assert.equal(findStrategy("Golden Cross")?.id, "golden_cross");
    });

    it("finds by partial name (first match wins)", () => {
      assert.equal(findStrategy("dividend")?.id, "dividend_aristocrats");
      assert.equal(findStrategy("momentum")?.id, "momentum");
      assert.equal(findStrategy("bollinger")?.id, "bollinger_squeeze");
      assert.equal(findStrategy("buffett")?.id, "buffett_style");
    });

    it("prefers an ID match over a name match", () => {
      assert.equal(findStrategy("garp")?.id, "garp");
    });

    it("returns undefined for a nonexistent strategy", () => {
      assert.equal(findStrategy("nonexistent_strategy_xyz"), undefined);
    });

    // ── EDGE cases (new) ──
    it('EDGE: empty string matches the FIRST strategy ("".includes is always true)', () => {
      // Documents a real footgun: a blank query is NOT 'no match', it silently
      // returns ALL_STRATEGIES[0]. Worth knowing for any caller that passes
      // unvalidated user input straight into findStrategy.
      assert.equal(findStrategy("")?.id, ALL_STRATEGIES[0]!.id);
    });

    it("EDGE: a whitespace-only query also matches the first (includes(' ') only if a name has a space)", () => {
      // A single space IS contained in most multi-word names, so it resolves to
      // the first strategy whose lowercased name includes a space.
      const r = findStrategy(" ");
      assert.ok(
        r,
        "space query should still resolve to a spaced-name strategy"
      );
      assert.ok(r!.name.toLowerCase().includes(" "));
    });

    it("EDGE: garbage / symbols / uppercase-with-spaces don't throw and miss cleanly", () => {
      assert.equal(findStrategy("@@@###"), undefined);
      assert.equal(findStrategy("   no-such-thing   "), undefined);
      assert.equal(findStrategy("a".repeat(500)), undefined);
    });

    it("EDGE: mixed-case partial still matches via lowercased includes", () => {
      assert.equal(findStrategy("ArIsToCrAtS")?.id, "dividend_aristocrats");
    });
  });

  // ── listStrategiesByCategory ────────────────────────────────────
  describe("listStrategiesByCategory", () => {
    it("returns ALL strategies when category is omitted/undefined", () => {
      assert.equal(listStrategiesByCategory().length, ALL_STRATEGIES.length);
      assert.equal(
        listStrategiesByCategory(undefined).length,
        ALL_STRATEGIES.length
      );
    });

    it("filters by category and every result matches", () => {
      for (const cat of ["value", "growth", "quality", "bullish", "combined"]) {
        const result = listStrategiesByCategory(cat);
        assert.ok(result.length > 0, `no strategies for ${cat}`);
        for (const s of result) assert.equal(s.category, cat);
      }
    });

    it("category counts match the real library", () => {
      assert.equal(listStrategiesByCategory("value").length, 3);
      assert.equal(listStrategiesByCategory("quality").length, 4);
      assert.equal(listStrategiesByCategory("bullish").length, 3);
    });

    it("is case-insensitive for the category", () => {
      const lower = listStrategiesByCategory("value").length;
      assert.equal(listStrategiesByCategory("VALUE").length, lower);
      assert.equal(listStrategiesByCategory("Value").length, lower);
    });

    it("EDGE: nonexistent / empty / whitespace category → empty array", () => {
      assert.equal(listStrategiesByCategory("nonexistent_category").length, 0);
      assert.equal(listStrategiesByCategory("").length, ALL_STRATEGIES.length); // "" is falsy → returns all
      assert.equal(listStrategiesByCategory("   ").length, 0); // truthy but matches nothing
    });
  });

  // ── Per-array shape + the load-bearing field-validity checks ────
  describe("FUNDAMENTAL_STRATEGIES", () => {
    it("has exactly 10 strategies covering the core categories", () => {
      assert.equal(FUNDAMENTAL_STRATEGIES.length, 10);
      const cats = new Set(FUNDAMENTAL_STRATEGIES.map((s) => s.category));
      for (const c of ["value", "dividend", "growth", "quality"]) {
        assert.ok(cats.has(c), `missing category ${c}`);
      }
    });

    it("REAL CHECK: every fundamental filter field is a known fundamental column", () => {
      for (const s of FUNDAMENTAL_STRATEGIES) {
        for (const f of s.filters) {
          assert.ok(
            FUNDAMENTAL_FIELDS.has(f.field),
            `Strategy "${s.id}" filter "${f.field}" is not a fundamental column`
          );
        }
      }
    });
  });

  describe("TECHNICAL_STRATEGIES", () => {
    it("has exactly 12 strategies covering the core categories", () => {
      assert.equal(TECHNICAL_STRATEGIES.length, 12);
      const cats = new Set(TECHNICAL_STRATEGIES.map((s) => s.category));
      for (const c of [
        "bullish",
        "bearish",
        "momentum",
        "volume",
        "volatility",
        "reversal",
      ]) {
        assert.ok(cats.has(c), `missing category ${c}`);
      }
    });

    it("REAL CHECK: every technical filter field is a known technical column", () => {
      for (const s of TECHNICAL_STRATEGIES) {
        for (const f of s.filters) {
          assert.ok(
            TECHNICAL_FIELDS.has(f.field),
            `Strategy "${s.id}" filter "${f.field}" is not a technical column`
          );
        }
      }
    });
  });

  describe("COMBINED_STRATEGIES", () => {
    it("has exactly 6 strategies all in the 'combined' category", () => {
      assert.equal(COMBINED_STRATEGIES.length, 6);
      for (const s of COMBINED_STRATEGIES) assert.equal(s.category, "combined");
    });

    it("every combined strategy mixes >=1 fundamental and >=1 technical filter", () => {
      for (const s of COMBINED_STRATEGIES) {
        assert.ok(
          s.filters.some((f) => FUNDAMENTAL_FIELDS.has(f.field)),
          `${s.id} has no fundamental filter`
        );
        assert.ok(
          s.filters.some((f) => TECHNICAL_FIELDS.has(f.field)),
          `${s.id} has no technical filter`
        );
      }
    });
  });

  // ── Filter validity across the WHOLE real library ───────────────
  describe("Filter field + operator validity (whole library)", () => {
    it("every filter field is a known fundamental/technical column", () => {
      for (const s of ALL_STRATEGIES) {
        for (const f of s.filters) {
          assert.ok(
            ALL_VALID_FIELDS.has(f.field),
            `Strategy "${s.id}" has unknown field "${f.field}"`
          );
        }
      }
    });

    it("every operator is in the allowed set", () => {
      const ops = new Set([
        "gt",
        "gte",
        "lt",
        "lte",
        "eq",
        "between",
        "cross_above",
        "cross_below",
      ]);
      for (const s of ALL_STRATEGIES) {
        for (const f of s.filters) {
          assert.ok(
            ops.has(f.operator),
            `bad operator "${f.operator}" in ${s.id}`
          );
        }
      }
    });

    it("between filters carry a [min<=max] numeric tuple; others carry a number", () => {
      for (const s of ALL_STRATEGIES) {
        for (const f of s.filters) {
          if (f.operator === "between") {
            assert.ok(Array.isArray(f.value), `${s.id} between not array`);
            const [min, max] = f.value as [number, number];
            assert.equal(typeof min, "number");
            assert.equal(typeof max, "number");
            assert.ok(min <= max, `${s.id} between min>${max}`);
          } else {
            assert.equal(
              typeof f.value,
              "number",
              `${s.id} ${f.field} not numeric`
            );
          }
        }
      }
    });
  });

  // ── Specific strategy assertions (against the real definitions) ──
  describe("Specific strategy definitions", () => {
    it("Value Investing: PE<15, PB<2, ROE>15, D/E<1", () => {
      const s = FUNDAMENTAL_STRATEGIES.find((x) => x.id === "value_investing")!;
      assert.equal(s.filters.length, 4);
      const by = (field: string) => s.filters.find((f) => f.field === field)!;
      assert.equal(by("pe").operator, "lt");
      assert.equal(by("pe").value, 15);
      assert.equal(by("pb").value, 2);
      assert.equal(by("roe").operator, "gt");
      assert.equal(by("roe").value, 15);
      assert.equal(by("debtToEquity").value, 1);
    });

    it("Golden Cross: single golden_cross eq 1, bullish", () => {
      const s = TECHNICAL_STRATEGIES.find((x) => x.id === "golden_cross")!;
      assert.equal(s.filters.length, 1);
      assert.equal(s.filters[0]!.field, "golden_cross");
      assert.equal(s.filters[0]!.operator, "eq");
      assert.equal(s.filters[0]!.value, 1);
      assert.equal(s.category, "bullish");
    });

    it("Buffett Style: 4 filters incl. ROE>20 + price_above_sma200 eq 1", () => {
      const s = COMBINED_STRATEGIES.find((x) => x.id === "buffett_style")!;
      assert.equal(s.filters.length, 4);
      const roe = s.filters.find((f) => f.field === "roe")!;
      assert.equal(roe.operator, "gt");
      assert.equal(roe.value, 20);
      const tech = s.filters.find((f) => f.field === "price_above_sma200")!;
      assert.equal(tech.operator, "eq");
      assert.equal(tech.value, 1);
    });

    it("Small Cap Gems: marketCap between [500, 5000]", () => {
      const s = FUNDAMENTAL_STRATEGIES.find((x) => x.id === "small_cap_gems")!;
      const mc = s.filters.find((f) => f.field === "marketCap")!;
      assert.equal(mc.operator, "between");
      assert.deepEqual(mc.value, [500, 5000]);
    });
  });
});
