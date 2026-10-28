/**
 * The evict route must not silently DROP a rule it does not recognise —
 * MONEY-1373.
 *
 * ## The defect this pins, which shipped and was caught by a type error
 *
 * `EVICT_RULES` in `candle-evict-logic.ts` is the source of truth for which
 * eviction rules exist. Two other places restate it: `CandleEvictMessage.rule`
 * in `@usemoney/types/pubsub`, and the ROUTE's narrowing of the inbound
 * payload, which used to read `raw.rule === "LOADED" || raw.rule === "WINDOW"`.
 *
 * Adding `WINDOW_INTRADAY` to the array and to the type would still have left
 * the route dropping it. And a dropped `rule` is not an error — it is an
 * ABSENT field, so `resolveRuleScope` falls back to `EVICT_RULES[0]`, the
 * chained `WINDOW_INTRADAY` link re-runs `LOADED`, and `judgeEvictRun` reports
 * a healthy run because `LOADED` deleted rows. The intraday population is never
 * touched, on a schedule that never fails: the MONEY-1211 / MONEY-1255 shape,
 * where a job runs on time, exits 0, and does nothing it was added for.
 *
 * A type error caught it this once, only because the union was widened in the
 * same change. Nothing would catch a rule added to the array alone, so this
 * suite compares the three statements against each other by READING THEM.
 *
 * ## Why a source scan rather than driving the Hono route
 *
 * The route module imports the processor, which imports Prisma and the GCS cold
 * store. Booting that to assert a narrowing would need a database for a fact
 * that is textual. The scan is exact about what it reads and says so out loud
 * when it reads nothing — the vacuity guard every scan in this repo carries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EVICT_RULES } from "../../src/processors/candle-evict-logic";
import { INTRADAY_TIMEFRAMES } from "@usemoney/core/market-data/candles";

// CWD is `workers` when this suite runs.
const ROUTE = join("src", "routes", "candle-evict.ts");
const PUBSUB_TYPES = join("..", "packages", "types", "src", "pubsub.ts");

const routeSrc = readFileSync(ROUTE, "utf8");
const typesSrc = readFileSync(PUBSUB_TYPES, "utf8");

/** The `rule?: "A" | "B";` declaration on `CandleEvictMessage`. */
function declaredRuleUnion(src: string): string[] {
  const anchor = src.indexOf("interface CandleEvictMessage");
  assert.ok(anchor > 0, "CandleEvictMessage is not declared in pubsub.ts");
  const slice = src.slice(anchor, anchor + 6000);
  const m = /\n\s*rule\?:\s*([^;]+);/.exec(slice);
  assert.ok(m, "CandleEvictMessage has no `rule?:` member");
  return [...m[1]!.matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]!);
}

describe("MONEY-1373 — the three statements of EVICT_RULES agree", () => {
  it("[meta] every file this suite compares was actually read", () => {
    // A scan that silently reads nothing is a scan that passes forever. Both
    // sources are non-trivial and the array is real.
    assert.ok(
      routeSrc.length > 500,
      `route source is ${routeSrc.length} bytes`,
    );
    assert.ok(
      typesSrc.length > 500,
      `pubsub types are ${typesSrc.length} bytes`,
    );
    assert.ok(
      EVICT_RULES.length >= 3,
      `EVICT_RULES has ${EVICT_RULES.length} members`,
    );
  });

  it("the message TYPE admits every rule the array declares", () => {
    const declared = declaredRuleUnion(typesSrc);
    assert.deepEqual(
      [...declared].sort(),
      [...EVICT_RULES].sort(),
      "CandleEvictMessage.rule and EVICT_RULES disagree. A rule the type " +
        "rejects cannot be published; a rule the type admits and the array " +
        "does not is a value nothing handles.",
    );
  });

  it("the ROUTE derives its narrowing from the array instead of re-listing it", () => {
    // The durable fix. A hand-written list here is what made the drop possible,
    // and a list that happens to be correct today is one rule away from being
    // wrong again.
    assert.match(
      routeSrc,
      /EVICT_RULES[\s\S]{0,80}?\.includes\(\s*raw\.rule\s*\)/,
      "the route no longer derives its rule narrowing from EVICT_RULES",
    );
    assert.ok(
      routeSrc.includes("EVICT_RULES"),
      "the route does not import EVICT_RULES at all",
    );
  });

  it("REGRESSION: the route does not hand-list the rule literals", () => {
    // The exact shape that shipped: `raw.rule === "LOADED" || raw.rule === "WINDOW"`.
    assert.doesNotMatch(
      routeSrc,
      /raw\.rule\s*===\s*"[A-Z_]+"\s*\|\|\s*raw\.rule\s*===\s*"[A-Z_]+"/,
      "the route is hand-listing rule literals again — a rule added to " +
        "EVICT_RULES would be dropped here, fall back to EVICT_RULES[0], and " +
        "the run would report ok while the new rule never executed.",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1373 — the LEAF shape
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The route's `narrowUnit` RULE BODY, executed for real.
 *
 * Compiled from the route's own source rather than imported, because importing
 * the route drags in the processor, Prisma and the GCS cold store — a database
 * for a fact that is textual. Executing the text is stronger than a regex over
 * it: a regex proves the words are present, this proves the rule BEHAVES.
 *
 * It slices from the FIRST GUARD to the RETURN rather than from the `function`
 * keyword, and that is not arbitrary — the first version cut from the signature
 * and stripped two exact type annotations, which prettier then reflowed across
 * three lines and the extraction silently stopped compiling the real rule. Both
 * anchors here are statements, so formatting cannot move them apart.
 */
const RULE_BODY = (() => {
  const first = routeSrc.indexOf('if (typeof value !== "object"');
  const tail = "return { symbol, timeframe };";
  const end = routeSrc.indexOf(tail, first);
  assert.ok(
    first > 0,
    "the route no longer opens narrowUnit with a type guard",
  );
  assert.ok(end > first, "the route no longer ends narrowUnit with the unit");
  // The one TypeScript construct the body carries.
  return routeSrc
    .slice(first, end + tail.length)
    .replace(/ as Record<string, unknown>/, "");
})();

const narrowUnit = new Function(
  "INTRADAY_TIMEFRAMES",
  "value",
  RULE_BODY,
) as unknown as (
  set: ReadonlySet<string>,
  value: unknown,
) => { symbol: string; timeframe: string } | null;

/** The rule, bound to core's real intraday set. */
const narrow = (v: unknown): { symbol: string; timeframe: string } | null =>
  narrowUnit(INTRADAY_TIMEFRAMES, v);

describe("MONEY-1373 — the route narrows `unit` to an INTRADAY unit", () => {
  it("[meta] the helper compiled and is not a stub", () => {
    // The vacuity guard. If the extraction silently produced a function that
    // returns null for everything, every REFUSAL case below would pass for the
    // wrong reason.
    assert.deepEqual(narrow({ symbol: "AAPL", timeframe: "M1" }), {
      symbol: "AAPL",
      timeframe: "M1",
    });
  });

  it("accepts EVERY timeframe core calls intraday", () => {
    // Read from `INTRADAY_TIMEFRAMES` rather than hand-listed, for the same
    // reason `rule` is read from `EVICT_RULES`: a timeframe added to the set
    // and missed here is silently DROPPED, and a dropped field is not an error.
    for (const tf of INTRADAY_TIMEFRAMES) {
      assert.deepEqual(
        narrow({ symbol: "AAPL", timeframe: tf }),
        { symbol: "AAPL", timeframe: tf },
        `${tf} is intraday and must be accepted`,
      );
    }
  });

  it('DROPS `{symbol:"AAPL",timeframe:"D1"}` entirely', () => {
    // The D1 population is 20.16M rows over 14,098 symbols, and one "unit" of
    // it is a decade of a symbol's history — a single message that would read
    // every daily shard the symbol has. Dropping the whole object is what makes
    // this safe: with no `unit` the message is an ordinary WINDOW_INTRADAY
    // PLAN, which selects the intraday population and publishes real leaves.
    assert.equal(narrow({ symbol: "AAPL", timeframe: "D1" }), null);
    assert.equal(narrow({ symbol: "AAPL", timeframe: "W1" }), null);
  });

  it("is ALL-OR-NOTHING — a half-formed unit never reaches the processor", () => {
    // A `{symbol: "", timeframe: "M1"}` is truthy, so forwarding it would send
    // the run down the leaf branch to select every `symbol: ""` row.
    assert.equal(narrow({ symbol: "", timeframe: "M1" }), null);
    assert.equal(narrow({ symbol: "   ", timeframe: "M1" }), null);
    assert.equal(narrow({ timeframe: "M1" }), null);
    assert.equal(narrow({ symbol: "AAPL" }), null);
    assert.equal(narrow({ symbol: 42, timeframe: "M1" }), null);
    assert.equal(narrow({ symbol: "AAPL", timeframe: 1 }), null);
    assert.equal(narrow(null), null);
    assert.equal(narrow("AAPL/M1"), null);
    assert.equal(narrow(undefined), null);
  });

  it("the route reads the SET rather than re-listing the timeframes", () => {
    assert.match(
      routeSrc,
      /INTRADAY_TIMEFRAMES\.has\(\s*timeframe\s*\)/,
      "the route no longer derives its timeframe narrowing from core's set",
    );
    assert.doesNotMatch(
      routeSrc,
      /timeframe\s*===\s*"[A-Z0-9]+"\s*\|\|\s*timeframe\s*===\s*"[A-Z0-9]+"/,
      "the route is hand-listing timeframe literals",
    );
  });

  it("the message TYPE declares `unit`, or the field is inert on arrival", () => {
    // MONEY-1235: `createMissing` was declared on a message type, documented as
    // the opt-in for a write path, and forwarded by nobody. Here the inverse
    // would bite — a route that narrows a field the type does not carry cannot
    // compile, and a type that carries one the route drops is a leaf that
    // silently becomes a PLAN and re-fans-out the whole universe.
    const anchor = typesSrc.indexOf("interface CandleEvictMessage");
    const slice = typesSrc.slice(anchor, anchor + 12000);
    assert.match(
      slice,
      /\n\s*unit\?:\s*\{\s*symbol:\s*string;\s*timeframe:\s*string\s*\};/,
    );
    assert.ok(routeSrc.includes("...(unit ? { unit } : {})"));
  });
});
