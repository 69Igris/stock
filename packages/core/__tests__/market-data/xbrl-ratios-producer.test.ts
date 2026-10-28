/**
 * `xbrl-ratios-producer` — what an NSE_XBRL write may and may not contain
 * (MONEY-1115 item 2).
 *
 * The stakes here are higher than on the financials side and the tests are
 * shaped by that: `StockRatios` is `@@unique([symbol, exchange])`, so a write
 * REPLACES the symbol's entire ratio set and re-stamps its `source`. There is no
 * period key to confine a mistake to one cell.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  planRatiosWrite,
  isPlanWorthWriting,
  XBRL_OWNED_RATIO_COLUMNS,
  XBRL_UNOWNED_RATIO_COLUMNS,
} from "../../src/market-data/xbrl-ratios-producer";
import {
  deriveExtendedRatios,
  EXTENDED_RATIO_COLUMNS,
  type ExtendedRatios,
} from "../../src/market-data/ratio-derivations";
import {
  parseXbrlFinancials,
  type XbrlFinancials,
} from "../../src/market-data/xbrl-financials-logic";
import { deriveRatios } from "../../src/market-data/xbrl-projection";
import {
  deriveShareCount,
  deriveValuation,
} from "../../src/market-data/xbrl-valuation";

const FULL = {
  netMargin: 12,
  operatingMargin: 18,
  roe: 15,
  roa: 8,
  // The denominator stamp that rides with roe/roa — MONEY-1250. Present here
  // because FULL means "the engine produced everything it can", and a plan that
  // wrote the two returns without saying which basis they used would be exactly
  // the undeclared mixture the column exists to prevent.
  returnBasis: "AVERAGE" as const,
  roce: 20,
  debtToEquity: 0.4,
  interestCoverage: 9,
  revenueGrowth: 11,
  earningsGrowth: 14,
  ebitdaMargin: 22,
  assetTurnover: 1.2,
};
const VAL = {
  pe: 20,
  pb: 3,
  evToEbitda: 12,
  dividendYield: 1.5,
  marketCap: 1_000_000,
  enterpriseValue: 1_050_000,
};

/**
 * The eight history/price-derived columns MONEY-1220 promoted out of UNOWNED.
 * They come from `ratio-derivations.ts`, not from a single filing, so the
 * producer takes them as a fourth argument.
 */
const EXTENDED: ExtendedRatios = {
  values: {
    currentRatio: 1.8,
    grossMargin: 0.42,
    revenueGrowth3Y: 0.11,
    revenueGrowth5Y: 0.09,
    earningsGrowth3Y: 0.14,
    earningsGrowth5Y: 0.12,
    pegRatio: 1.6,
    beta: 0.87,
  },
  unfilled: {},
};

describe("planRatiosWrite", () => {
  it("fills every owned column when the engine produced one", () => {
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", EXTENDED);
    for (const c of XBRL_OWNED_RATIO_COLUMNS) {
      assert.ok(p.set[c] !== undefined, `${c} should be set`);
    }
    assert.equal(p.unfilled.length, 0);
  });

  it("reports the DERIVATION's own reason when an extended column is null", () => {
    // Not a generic "no value": a run has to be able to say "gross margin is
    // null for 3,900 symbols because they are lenders", which is the difference
    // between a data gap and a correct refusal.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", {
      values: {},
      unfilled: {
        grossMargin: "lender-has-no-cogs",
        beta: "insufficient-observations",
      },
    });
    const reason = (c: string) =>
      p.unfilled.find((u) => u.column === c)?.reason;
    assert.equal(reason("grossMargin"), "lender-has-no-cogs");
    assert.equal(reason("beta"), "insufficient-observations");
  });

  it("still produces a valid plan when no extended bundle is supplied", () => {
    // A caller holding one filing and no history must not crash, and the eight
    // columns must still appear in the accounting rather than vanishing.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL");
    for (const c of EXTENDED_RATIO_COLUMNS) {
      assert.ok(!(c in p.set), `${c} written without inputs`);
      assert.ok(
        p.unfilled.some((u) => u.column === c),
        `${c} silently dropped from the accounting`,
      );
    }
  });

  it("NEVER writes a column XBRL cannot honestly derive", () => {
    const p = planRatiosWrite(FULL, VAL, "ANNUAL");
    for (const c of XBRL_UNOWNED_RATIO_COLUMNS) {
      assert.ok(
        !(c in p.set),
        `${c} must stay absent so the incumbent value survives — a lookalike ` +
          `under a NSE_XBRL stamp claims a filing that does not support it`,
      );
    }
  });

  it("the owned and unowned lists are DISJOINT", () => {
    const owned = new Set<string>(XBRL_OWNED_RATIO_COLUMNS);
    for (const c of XBRL_UNOWNED_RATIO_COLUMNS) {
      assert.ok(!owned.has(c), `${c} appears in both lists`);
    }
  });

  it("an absent ratio is OMITTED, never written as 0", () => {
    const p = planRatiosWrite({ netMargin: 12, roe: 15, roa: 8 }, {}, "ANNUAL");
    assert.equal(p.set.pe, undefined);
    assert.ok(
      !("pe" in p.set),
      "0 would read as 'this company has a P/E of zero'",
    );
    assert.ok(p.unfilled.some((u) => u.column === "pe"));
  });

  it("a genuine ZERO survives — it is data, not absence", () => {
    const p = planRatiosWrite({ ...FULL, debtToEquity: 0 }, VAL, "ANNUAL");
    assert.equal(p.set.debtToEquity, 0, "a debt-free company really has D/E 0");
  });

  it("every unfilled column carries a REASON", () => {
    const p = planRatiosWrite({}, {}, "ANNUAL");
    assert.equal(p.unfilled.length, XBRL_OWNED_RATIO_COLUMNS.length);
    for (const u of p.unfilled) {
      assert.ok(u.reason.length > 10, `${u.column} has no usable reason`);
    }
  });

  it("stores ebitdaMargin and assetTurnover — they have columns now", () => {
    // INVERTED, not deleted (MONEY-1220). This test used to assert both landed
    // in `computedButUnstorable` because `StockRatios` had no column for them.
    // The schema gained both, so the gap it was watching is closed and the
    // correct assertion is the opposite one. Keeping it inverted rather than
    // removing it means a schema revert shows up here as a failure.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", EXTENDED);
    assert.equal(p.set.ebitdaMargin, FULL.ebitdaMargin);
    assert.equal(p.set.assetTurnover, FULL.assetTurnover);
    assert.deepEqual(
      p.computedButUnstorable,
      [],
      "nothing should be unstorable now",
    );
  });

  it("keeps computedButUnstorable as the mechanism for the NEXT mismatch", () => {
    // The field is empty today. It must still EXIST, because the next ratio the
    // engine learns to compute will otherwise be dropped on the floor exactly
    // the way these two were for a release.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", EXTENDED);
    assert.ok(
      Array.isArray(p.computedButUnstorable),
      "the accounting channel was removed along with its contents",
    );
  });

  it("non-finite values are refused like absent ones", () => {
    const p = planRatiosWrite(
      { netMargin: NaN, roe: Infinity, roa: 8, operatingMargin: 5 } as never,
      {},
      "ANNUAL",
    );
    assert.ok(!("netMargin" in p.set));
    assert.ok(!("roe" in p.set));
    assert.equal(p.set.roa, 8);
  });
});

describe("isPlanWorthWriting — the guard on a whole-row replacement", () => {
  it("writes a full plan", () => {
    const v = isPlanWorthWriting(planRatiosWrite(FULL, VAL, "ANNUAL"));
    assert.equal(v.write, true);
  });

  it("REFUSES a plan with no profitability ratio, however many valuation fields", () => {
    // Fifteen valuation numbers derived from a market price, with no filing
    // behind them, is not a filing-sourced row.
    const v = isPlanWorthWriting(planRatiosWrite({}, VAL, "ANNUAL"));
    assert.equal(v.write, false);
    assert.match(v.reason, /profitability/);
  });

  it("REFUSES a thin plan that would replace a populated incumbent", () => {
    const v = isPlanWorthWriting(
      planRatiosWrite({ netMargin: 12 }, {}, "ANNUAL"),
    );
    assert.equal(v.write, false);
    assert.match(v.reason, /floor is 3/);
  });

  it("accepts the minimum honest plan", () => {
    const v = isPlanWorthWriting(
      planRatiosWrite({ netMargin: 12, roe: 15, roa: 8 }, {}, "ANNUAL"),
    );
    assert.equal(v.write, true);
  });
});

describe("planRatiosWrite is PERIOD-AWARE — review fix", () => {
  it("a QUARTERLY filing must not fill the annual-incumbent columns", () => {
    // `deriveRatios` states the hazard: "ROE/ROA on a QUARTERLY filing is a
    // quarterly return, NOT an annual one… The caller annualises if it wants
    // to, knowingly." This planner is that caller, so it has to be told.
    //
    // Measured, same symbol both sides: the GLAXO Q2-FY25 fixture derives
    // roce 20.1, while prod StockRatios.GLAXO holds the annual 57.25 (roe
    // 49.75). Writing the quarterly figure drops GLAXO, INFY (36.2 → ~9) and
    // CIPLA (21.6 → ~5) out of a "ROCE > 20%" screen — and it cannot be undone,
    // because NSE_XBRL OUTRANKS TICKERTAPE in FINANCIALS_AUTHORITY.
    const p = planRatiosWrite(FULL, VAL, "QUARTERLY");
    for (const col of [
      "roe",
      "roa",
      "roce",
      "revenueGrowth",
      "earningsGrowth",
    ]) {
      assert.ok(
        !(col in p.set),
        `${col} must not be written from a quarterly filing`,
      );
      assert.ok(
        p.unfilled.some((u) => u.column === col && /QUARTERLY/.test(u.reason)),
        `${col} must be refused WITH its reason, not silently dropped`,
      );
    }
  });

  it("margins ARE period-invariant and still fill on a quarterly filing", () => {
    // A 12% net margin is 12% whether a quarter or a year produced it. The
    // refusal is scoped to flow-over-stock ratios, not to quarterly data.
    const p = planRatiosWrite(FULL, VAL, "QUARTERLY");
    assert.equal(p.set.netMargin, FULL.netMargin);
    assert.equal(p.set.operatingMargin, FULL.operatingMargin);
  });

  it("ANNUAL fills everything", () => {
    const p = planRatiosWrite(FULL, VAL, "ANNUAL");
    assert.ok(p.set.roe !== undefined && p.set.roce !== undefined);
  });
});

describe("isPlanWorthWriting counts FILING-derived fields only — review fix", () => {
  it("REFUSES one margin plus five price-derived valuation fields", () => {
    // The exact shape the doc disclaims. An earlier floor of `total >= 3` with
    // `haveCore >= 1` admitted it: one filing number plus five price numbers
    // cleared the bar and re-stamped the row NSE_XBRL.
    const p = planRatiosWrite({ netMargin: 8.1 }, VAL, "ANNUAL");
    const v = isPlanWorthWriting(p);
    assert.equal(v.write, false);
    assert.match(v.reason, /filing-derived/);
    assert.match(v.reason, /valuation field\(s\)/);
  });

  it("accepts three FILING-derived fields with no valuation at all", () => {
    const v = isPlanWorthWriting(
      planRatiosWrite({ netMargin: 12, roe: 15, roa: 8 }, {}, "ANNUAL"),
    );
    assert.equal(v.write, true);
    assert.match(v.reason, /3 filing-derived/);
  });
});

describe("MONEY-1235 — pegRatio is period-dependent, like the growth it divides by", () => {
  /** `pegRatio` arrives via the EXTENDED bag, not `ratios` — see the signature. */
  const withPeg = { values: { pegRatio: 1.5 }, unfilled: {} } as ExtendedRatios;

  it("an ANNUAL filing writes it — the guard must not just delete the column", () => {
    // The control. Without this, "refused everywhere" would pass too, and the
    // test would be pinning a deletion rather than a period rule.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", withPeg);
    assert.equal(p.set.pegRatio, 1.5);
  });

  it("a QUARTERLY filing refuses pegRatio, exactly as it refuses earningsGrowth", () => {
    // THE INCONSISTENCY. `pegRatio` is P/E divided by `earningsGrowth` — the
    // number one line above it in PERIOD_DEPENDENT_COLUMNS. The plan already
    // declined to write that growth from a quarterly filing, because
    // quarter-on-quarter is a different measure from the annual incumbent and
    // nothing is stored to tell them apart, and then wrote a PEG built from it.
    // For a March-year-end filer that is every run from April until the Q1
    // result lands in August.
    const p = planRatiosWrite(FULL, VAL, "QUARTERLY", withPeg);
    assert.equal(
      p.set.pegRatio,
      undefined,
      "pegRatio must not be written from a refused growth figure",
    );
    const reason =
      p.unfilled.find((u) => u.column === "pegRatio")?.reason ?? "";
    assert.match(
      reason,
      /QUARTERLY filing/,
      `refused for the wrong reason: ${reason}`,
    );
    // And it is refused for the SAME reason as the growth it derives from.
    const growth =
      p.unfilled.find((u) => u.column === "earningsGrowth")?.reason ?? "";
    assert.equal(reason, growth);
  });
});

describe("MONEY-1239 — assetTurnover is a FLOW over a STOCK, like roe and roa", () => {
  it("an ANNUAL filing writes it — the guard must not just delete the column", () => {
    // The control. Without it, "refused everywhere" would pass too and this
    // would be pinning a deletion rather than a period rule.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL");
    assert.equal(p.set.assetTurnover, FULL.assetTurnover);
  });

  it("a QUARTERLY filing refuses it, exactly as it refuses roa", () => {
    // `assetTurnover` is `revenue / average totalAssets` — the same shape as
    // `roa` (`netIncome / totalAssets`), which sat in PERIOD_DEPENDENT_COLUMNS
    // while this one did not. The reachable case is the worst one: the filing
    // that carries a balance sheet on a non-annual period is the HALF-YEARLY,
    // which SEBI mandates one for and which the ratios job hands in as
    // "QUARTERLY" — so what lands is half a year of revenue over a full-year
    // asset base, in a column whose incumbent is the annual figure.
    const p = planRatiosWrite(FULL, VAL, "QUARTERLY");
    assert.equal(p.set.assetTurnover, undefined);
    assert.ok(!("assetTurnover" in p.set));
    const reason =
      p.unfilled.find((u) => u.column === "assetTurnover")?.reason ?? "";
    assert.match(
      reason,
      /QUARTERLY filing/,
      `refused for the wrong reason: ${reason}`,
    );
    // Refused for the SAME reason as the flow-over-stock ratio beside it.
    assert.equal(reason, p.unfilled.find((u) => u.column === "roa")?.reason);
  });

  it("ebitdaMargin, its neighbour in the same put() pair, still fills", () => {
    // Scope guard. Both columns arrived together in MONEY-1220 and are written
    // by adjacent lines; only one of them is period-dependent. A margin is two
    // flows from one period and is invariant.
    const p = planRatiosWrite(FULL, VAL, "QUARTERLY");
    assert.equal(p.set.ebitdaMargin, FULL.ebitdaMargin);
  });
});

describe("MONEY-1239 — beta is a PRICE regression and must not carry the filing floor", () => {
  /** One margin (core), one filing-derived field, and beta. */
  const thin = { netMargin: 12, ebitdaMargin: 22 };
  const withBeta = { values: { beta: 0.87 }, unfilled: {} } as ExtendedRatios;

  it("REFUSES two filing-derived fields propped up by beta", () => {
    // `beta` is an OLS slope of `DailyPrice.close` against an index over ~490
    // sessions. No filing input appears anywhere in it, so counting it toward a
    // FILING-provenance floor is the same category error the `VALUATION`
    // exclusion was introduced for — it just arrived through the door
    // MONEY-1220 opened when it promoted the column out of UNOWNED.
    const p = planRatiosWrite(thin, {}, "ANNUAL", withBeta);
    assert.equal(p.set.beta, 0.87, "beta must actually be in the plan");
    const v = isPlanWorthWriting(p);
    assert.equal(v.write, false);
    assert.match(v.reason, /only 2 filing-derived field\(s\)/);
  });

  it("the SAME count made up of real filing fields still writes", () => {
    // Guards the guard: proves the refusal is about beta's provenance and not
    // about the count, the core check, or the extended bag being present.
    const v = isPlanWorthWriting(
      planRatiosWrite({ ...thin, roa: 8 }, {}, "ANNUAL"),
    );
    assert.equal(v.write, true);
    assert.match(v.reason, /3 filing-derived/);
  });

  it("beta still WRITES when the row qualifies on its own merits", () => {
    // The exclusion is from the FLOOR, not from the plan. A row that clears the
    // bar on filing-derived fields keeps its beta.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", withBeta);
    assert.equal(isPlanWorthWriting(p).write, true);
    assert.equal(p.set.beta, 0.87);
  });
});

describe("MONEY-1239 — OWNED + UNOWNED must COVER StockRatios, not merely be disjoint", () => {
  /**
   * `XBRL_UNOWNED_RATIO_COLUMNS`' own docstring promises that "adding one to the
   * model without deciding its provenance is a visible omission rather than a
   * silent gap". Nothing enforced it: the suite checked the two lists were
   * DISJOINT, which a column present in NEITHER passes trivially. A `Float?`
   * added to `StockRatios` with no provenance decision would simply never be
   * written and never be accounted for — exactly the shape that left
   * `ebitdaMargin` and `assetTurnover` computed-but-unstorable for a release,
   * and `grossMargin`/`beta` parked in UNOWNED under a false claim that XBRL
   * could not supply them.
   *
   * Read from `schema.prisma` rather than restated, for the reason
   * `sync-relink-required.test.ts` gives about the same class of list: a
   * hardcoded copy has the shelf life of the note beside it.
   */
  const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
  const SCHEMA = readFileSync(
    join(ROOT, "packages", "database", "prisma", "schema.prisma"),
    "utf8",
  );

  /**
   * LINE comments first, THEN block comments — MONEY-1143. Reversed, a `//`
   * containing `*​/` closes a block early and the rest of the model is silently
   * dropped from the scan, which would make this test pass by seeing nothing.
   */
  function stripComments(s: string): string {
    const noLine = s
      .split("\n")
      .map((l) => l.replace(/(?<!:)\/\/.*$/, ""))
      .join("\n");
    return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  /** The `model StockRatios { … }` body, comments removed. */
  function modelBody(name: string): string {
    const start = SCHEMA.indexOf(`model ${name} {`);
    assert.notEqual(start, -1, `model ${name} not found in schema.prisma`);
    const end = SCHEMA.indexOf("\n}", start);
    assert.notEqual(end, -1, `model ${name} has no closing brace`);
    return stripComments(SCHEMA.slice(start, end));
  }

  const body = modelBody("StockRatios");
  const floatFields = [
    ...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s+Float\?/gm),
  ]
    .map((m) => m[1] as string)
    .sort();

  it("the scan actually found the model — a zero-field scan proves nothing", () => {
    // The vacuity guard. Every assertion below is over `floatFields`, so an
    // empty scan would make all of them pass while measuring nothing.
    assert.ok(
      floatFields.length >= 20,
      `only ${floatFields.length} Float? fields scanned off StockRatios`,
    );
    assert.ok(floatFields.includes("roe"), "roe missing from the scan");
    assert.ok(floatFields.includes("beta"), "beta missing from the scan");
  });

  it("every Float? column on the model is OWNED or explicitly UNOWNED", () => {
    const decided = new Set<string>([
      ...XBRL_OWNED_RATIO_COLUMNS,
      ...XBRL_UNOWNED_RATIO_COLUMNS,
    ]);
    const undecided = floatFields.filter((f) => !decided.has(f));
    assert.deepEqual(
      undecided,
      [],
      `StockRatios column(s) with no provenance decision: ${undecided.join(", ")}. ` +
        "Add each to XBRL_OWNED_RATIO_COLUMNS (with a derivation) or to " +
        "XBRL_UNOWNED_RATIO_COLUMNS (with the reason it cannot be derived).",
    );
  });

  it("neither list names a column the model does not have", () => {
    // The other direction: a rename or a dropped column leaves a name here that
    // `planRatiosWrite` would try to write into a field Prisma does not know.
    // `Float?` misses the model's STRING columns, so they are named here.
    // `recommendation` is sell-side opinion (UNOWNED); `returnBasis` is the
    // denominator stamp for roe/roa (OWNED, MONEY-1250). Both are real columns
    // on StockRatios — this list exists because the scan above is deliberately
    // typed, not because these are exceptions to the coverage rule.
    const onModel = new Set<string>([
      ...floatFields,
      "recommendation",
      "returnBasis",
    ]);
    const orphans = [
      ...XBRL_OWNED_RATIO_COLUMNS,
      ...XBRL_UNOWNED_RATIO_COLUMNS,
    ].filter((c) => !onModel.has(c));
    assert.deepEqual(
      orphans,
      [],
      `named here but not on StockRatios: ${orphans.join(", ")}`,
    );
  });

  it("the OWNED/UNOWNED split is 26 of 28 — the number the prose quotes", () => {
    // MONEY-1255. Twelve files across CLAUDE.md, AGENTS.md, workers/CLAUDE.md,
    // the switchover runbook, three source files and four tests all said "23 of
    // 25". That was true at MONEY-1220 and stopped being true the moment
    // `ebitdaMargin`, `assetTurnover` (MONEY-1220 itself) and `returnBasis`
    // (MONEY-1250) got columns — three additions, none of which prompted a
    // sweep, because nothing anywhere connected the sentence to the lists.
    //
    // The two tests above already prove the lists COVER the model and name
    // nothing off it. Neither can fail on a stale SENTENCE, which is a
    // different failure: a reader deciding what the switchover writes, from a
    // count that is three columns light and names the wrong denominator.
    //
    // So the literals live here, once, next to the schema scan that keeps them
    // honest. Changing the model's ratio columns now fails THIS assertion with
    // the new numbers in the message, and the fix is to update the prose and
    // this line together.
    assert.equal(
      XBRL_OWNED_RATIO_COLUMNS.length,
      26,
      `owned is now ${XBRL_OWNED_RATIO_COLUMNS.length}, not 26 — update the ` +
        `"26 of 28" sentence in CLAUDE.md, AGENTS.md, workers/CLAUDE.md, ` +
        `docs/reference/xbrl-switchover-runbook.md, workers/src/processors/` +
        `xbrl-ratios.ts, packages/core/src/market-data/{ratio-derivations,` +
        `xbrl-ratios-producer}.ts, packages/services/src/stock-tabs.service.ts, ` +
        `packages/research/src/data-sources/db-store.ts, apps/web/lib/actions/` +
        `stock-tabs.ts and schema.prisma's StockRatios doc-comment.`,
    );
    assert.equal(
      XBRL_UNOWNED_RATIO_COLUMNS.length,
      2,
      "unowned should be exactly targetPrice + recommendation",
    );
    assert.equal(
      XBRL_OWNED_RATIO_COLUMNS.length + XBRL_UNOWNED_RATIO_COLUMNS.length,
      28,
    );
    // Not a restatement of the arithmetic above: it pins WHICH two are unowned,
    // so a swap that keeps both counts at 26/2 — quietly dropping a derivable
    // column and promoting an unsourceable one — still fails.
    assert.deepEqual([...XBRL_UNOWNED_RATIO_COLUMNS].sort(), [
      "recommendation",
      "targetPrice",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — `computedButUnstorable` is DERIVED, not a stale literal        */
/* -------------------------------------------------------------------------- */

describe("computedButUnstorable", () => {
  it("reports the LENDER ratios the engine computes with nowhere to store them", () => {
    // `deriveRatios` passes through `grossNpaRatio`, `netNpaRatio` and
    // `cet1Ratio` — RBI Form-A figures disclosed by every bank — and
    // `StockRatios` has no column for any of them. The field was named for
    // `ebitdaMargin`/`assetTurnover`, both of which GOT columns in MONEY-1220,
    // after which the array was returned empty on every call and read by
    // nothing. A hand-maintained literal could never have grown these three.
    const p = planRatiosWrite(
      { ...FULL, grossNpaRatio: 2.1, netNpaRatio: 0.5, cet1Ratio: 16.4 },
      VAL,
      "ANNUAL",
      EXTENDED,
    );
    assert.deepEqual(
      p.computedButUnstorable.map((c) => c.name),
      ["grossNpaRatio", "netNpaRatio", "cet1Ratio"],
    );
    assert.deepEqual(
      p.computedButUnstorable.map((c) => c.value),
      [2.1, 0.5, 16.4],
    );
  });

  it("is EMPTY when every computed number has a column", () => {
    // Otherwise the signal is a constant, which is the same as no signal.
    const p = planRatiosWrite(FULL, VAL, "ANNUAL", EXTENDED);
    assert.deepEqual(p.computedButUnstorable, []);
  });

  it("ignores a non-finite value — an absence is not a storage gap", () => {
    const p = planRatiosWrite(
      { ...FULL, grossNpaRatio: Number.NaN, netNpaRatio: Infinity },
      VAL,
      "ANNUAL",
      EXTENDED,
    );
    assert.deepEqual(p.computedButUnstorable, []);
  });

  it("never names a column the plan actually SET", () => {
    // The two lists must be disjoint by construction: a number that landed in
    // `set` is storable by definition, and reporting it as unstorable would
    // make the counter unreadable.
    const p = planRatiosWrite(
      { ...FULL, grossNpaRatio: 2.1 },
      VAL,
      "ANNUAL",
      EXTENDED,
    );
    for (const c of p.computedButUnstorable) {
      assert.equal(
        (p.set as Record<string, number | undefined>)[c.name],
        undefined,
        `${c.name} is both set and reported unstorable`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1346 — the RatioInputs widening must not move a single digit          */
/* -------------------------------------------------------------------------- */

/**
 * A BYTE-IDENTICAL snapshot of one REAL filing's whole ratio pipeline.
 *
 * ## Why a snapshot, when this file otherwise asserts named quantities
 *
 * MONEY-1346 widened `projectFinancials`, `deriveRatios` and `deriveShareCount`
 * from `XbrlFinancials` to `RatioInputs`, and added a `reportedIncome` FALLBACK
 * inside two of them so a document-derived source can supply the operating-
 * profit and EBITDA lines an Indian filing does not publish as concepts. That
 * is a change to the path EVERY filer flows through, into a table
 * (`stock_ratios`) whose unique key carries no `source`, so a write replaces the
 * symbol's entire ratio set irreversibly.
 *
 * A per-field assertion would only catch the fields somebody thought to name.
 * The value captured here was produced by running the pipeline BEFORE the
 * refactor and diffing after — sha256 `b9d3046…` on both sides — so the
 * guarantee is "nothing moved", not "the fields we remembered did not move".
 *
 * The inputs are deliberately the same shape the ratios job builds: the parsed
 * GLAXO Q2-FY25 fixture, its own values re-dated a year back as the prior year
 * (which makes the averaged denominators equal the closing ones, so an
 * `AVERAGE`/`CLOSING` regression is visible in `returnBasis` rather than hidden
 * by arithmetic), and fixed price/TTM/dividend inputs.
 *
 * If this fails, do NOT re-baseline it. Every number below was produced by code
 * that shipped; a diff means the widening changed a published ratio.
 */
const GLAXO_BASELINE = {
  ratios: {
    netMargin: 24.86775661216939,
    operatingMargin: 30.207489625518726,
    debtToEquity: 0.0063356143933694,
    ebitdaMargin: 35.11224438778061,
    roce: 19.83539729538887,
    interestCoverage: 1238.0740740740741,
    roe: 14.850178543704393,
    roa: 6.667131356079881,
    returnBasis: "AVERAGE",
    assetTurnover: 0.26810345058698315,
    revenueGrowth: 0,
    earningsGrowth: 0,
  },
  shares: { shares: 169_410_000, basis: "paid-up" },
  valuation: {
    marketCap: 42352.5,
    pe: 41.666666666666664,
    pb: 25.290208161656697,
    enterpriseValue: 42314.01,
    evToEbitda: 30.224292857142856,
    dividendYield: 1.2,
  },
  planAnnualSet: {
    roe: 14.850178543704393,
    roa: 6.667131356079881,
    returnBasis: "AVERAGE",
    roce: 19.83539729538887,
    operatingMargin: 30.207489625518726,
    netMargin: 24.86775661216939,
    debtToEquity: 0.0063356143933694,
    interestCoverage: 1238.0740740740741,
    revenueGrowth: 0,
    earningsGrowth: 0,
    pe: 41.666666666666664,
    pb: 25.290208161656697,
    evToEbitda: 30.224292857142856,
    dividendYield: 1.2,
    marketCap: 42352.5,
    enterpriseValue: 42314.01,
    ebitdaMargin: 35.11224438778061,
    assetTurnover: 0.26810345058698315,
    currentRatio: 1.7653751315005817,
    grossMargin: 62.34088295585221,
  },
  planAnnualUnfilled: [
    { column: "revenueGrowth3Y", reason: "insufficient-history" },
    { column: "revenueGrowth5Y", reason: "insufficient-history" },
    { column: "earningsGrowth3Y", reason: "insufficient-history" },
    { column: "earningsGrowth5Y", reason: "insufficient-history" },
    { column: "pegRatio", reason: "non-positive-growth" },
    { column: "beta", reason: "no-input" },
  ],
  planQuarterlySet: {
    returnBasis: "AVERAGE",
    operatingMargin: 30.207489625518726,
    netMargin: 24.86775661216939,
    debtToEquity: 0.0063356143933694,
    interestCoverage: 1238.0740740740741,
    pe: 41.666666666666664,
    pb: 25.290208161656697,
    evToEbitda: 30.224292857142856,
    dividendYield: 1.2,
    marketCap: 42352.5,
    enterpriseValue: 42314.01,
    ebitdaMargin: 35.11224438778061,
    currentRatio: 1.7653751315005817,
    grossMargin: 62.34088295585221,
  },
} as const;

function glaxo(): XbrlFinancials {
  const xml = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "fixtures",
      "xbrl",
      "glaxo-q2fy25-standalone-indas-2020-03-31.xml",
    ),
    "utf8",
  );
  const parsed = parseXbrlFinancials(xml);
  assert.ok(parsed !== null, "premise: the GLAXO fixture must parse");
  return parsed;
}

/** The same filing re-dated one fiscal year back — the ratios job's prior. */
function priorYearOf(f: XbrlFinancials): XbrlFinancials {
  const back = (isoDate: string): string => {
    const d = new Date(isoDate);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };
  return {
    ...f,
    period: {
      ...f.period,
      start: back(f.period.start),
      end: back(f.period.end),
    },
  };
}

describe("MONEY-1346 — GLAXO identity across the RatioInputs widening", () => {
  const f = glaxo();
  const ratios = deriveRatios(f, priorYearOf(f));
  const shares = deriveShareCount(f);
  const valuation = deriveValuation({
    price: 2500,
    shares: shares?.shares,
    ttmEps: 60,
    ttmEbitda: 14_000_000_000,
    totalEquity: f.values.totalEquity,
    totalDebt: f.values.borrowings,
    totalCash: f.values.cashAndCashEquivalents,
    ttmDividendPerShare: 30,
  });
  const extended = deriveExtendedRatios({
    annuals: [
      { fyEndYear: 2025, revenue: 100, netIncome: 10 },
      { fyEndYear: 2022, revenue: 70, netIncome: 6 },
      { fyEndYear: 2020, revenue: 50, netIncome: 4 },
    ],
    latestAnnualIncome: {
      revenue: f.values.revenueFromOperations,
      costOfMaterialsConsumed: f.values.costOfMaterialsConsumed,
      purchasesOfStockInTrade: f.values.purchasesOfStockInTrade,
      changesInInventories: f.values.changesInInventories,
    },
    latestBalanceSheet: {
      currentAssets: f.values.currentAssets,
      currentLiabilities: f.values.currentLiabilities,
    },
    family: f.family,
    pe: valuation.pe,
    earningsGrowth: ratios.earningsGrowth,
  });

  it("deriveRatios is unchanged, every field", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(ratios)), GLAXO_BASELINE.ratios);
  });

  it("deriveShareCount is unchanged", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(shares)), GLAXO_BASELINE.shares);
  });

  it("deriveValuation is unchanged", () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(valuation)),
      GLAXO_BASELINE.valuation,
    );
  });

  it("the ANNUAL plan — set AND unfilled — is unchanged", () => {
    const p = planRatiosWrite(ratios, valuation, "ANNUAL", extended);
    assert.deepEqual(
      JSON.parse(JSON.stringify(p.set)),
      GLAXO_BASELINE.planAnnualSet,
    );
    // The refusal reasons are part of the contract: a widening that quietly
    // changed WHY a column is null would be invisible in `set` alone.
    assert.deepEqual(
      JSON.parse(JSON.stringify(p.unfilled)),
      GLAXO_BASELINE.planAnnualUnfilled,
    );
  });

  it("the QUARTERLY plan is unchanged, so the period guard still bites", () => {
    const p = planRatiosWrite(ratios, valuation, "QUARTERLY", extended);
    assert.deepEqual(
      JSON.parse(JSON.stringify(p.set)),
      GLAXO_BASELINE.planQuarterlySet,
    );
  });

  it("a real filing carries NO `reportedIncome`, so the fallback is unreachable", () => {
    // The safety argument for adding the fallback at all: `parseXbrlFinancials`
    // never emits the field, so no XBRL caller can take the new branch. Asserted
    // rather than reasoned about, because the branch sits inside a one-way-door
    // write path.
    assert.equal((f as { reportedIncome?: unknown }).reportedIncome, undefined);
  });
});
