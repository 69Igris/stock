/**
 * fetch_promoter_holding tool tests (MONEY-543)
 *
 * Tests packages/research/src/tools/fetch-promoter-holding.ts
 *
 * The tool fetches promoter shareholding % via the unified shareholding chain
 * (Tickertape → Screener.in → NSE) and classifies the QoQ trend, emitting
 * OBSERVATION/FLAG strings only (no buy/sell guidance).
 *
 * Degradation contract (the load-bearing invariant): the tool NEVER surfaces
 * "data unavailable" via success:false. Instead it returns
 *   { success:true, data:{ available:false, reason, symbol, flags:[] } }
 * when the symbol is empty/non-string, when the chain resolves null/empty, or
 * when no row carries a parseable promoter %. success:false is reserved for a
 * genuine thrown runtime exception inside the chain.
 *
 * ── Determinism ────────────────────────────────────────────────────
 * To assert KNOWN VALUES through the REAL tool we must control what the
 * shareholding chain returns. We do that with node:test's `mock.module`,
 * intercepting `../data-sources/index` so `fetchShareholdingChain` resolves to
 * a deterministic in-memory series — NO network IO, NO randomness.
 *
 * `mock.module` requires the `--experimental-test-module-mocks` flag. Run with:
 *
 *   node --import tsx --experimental-test-module-mocks --test \
 *     apps/web/__tests__/research/fetch-promoter-holding.test.ts
 *
 * The plain `yarn test` runner does NOT pass that flag. So we feature-detect
 * `mock.module`: when it is unavailable, the data-injecting cases SKIP cleanly
 * (no crash, no live network) while the static-metadata and empty-symbol cases
 * — which need no injected data — always run. This keeps the file green under
 * both runners.
 */

import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

import { fetchPromoterHoldingTool } from "../../../../packages/research/src/tools/fetch-promoter-holding";

// ── Module-mock feature detection ───────────────────────────────────
const HAS_MODULE_MOCK =
  typeof (mock as unknown as { module?: unknown }).module === "function";

const DATA_SOURCES_INDEX =
  "../../../../packages/research/src/data-sources/index";

// The chain output the mocked module will return. Swapped per-test via these
// mutable closures so we only register one `mock.module` (re-mocking the same
// specifier throws ERR_INVALID_STATE).
type ChainRow = Record<string, unknown>;
let chainImpl: (symbol: string) => Promise<unknown> = async () => null;

function setChain(value: ChainRow[] | null): void {
  chainImpl = async () => value;
}
function setChainThrows(message: string): void {
  chainImpl = async () => {
    throw new Error(message);
  };
}

before(() => {
  if (!HAS_MODULE_MOCK) return;
  mock.module(DATA_SOURCES_INDEX, {
    namedExports: {
      fetchShareholdingChain: async (symbol: string) => chainImpl(symbol),
    },
  });
});

type PromoterData = {
  available: boolean;
  reason?: string;
  symbol: string;
  promoterPercent?: number;
  previousQuarter?: number;
  change?: number;
  trend?: "increasing" | "stable" | "decreasing";
  pledgedPercent?: number;
  series?: Array<{ quarter: string; promoterPercent: number }>;
  flags: string[];
};

// Re-import the tool AFTER the mock is registered so its `fetchShareholdingChain`
// binding resolves to the mocked module. When module mocking is unavailable the
// data-dependent tests are skipped before this is ever called.
async function loadMockedTool() {
  const mod =
    await import("../../../../packages/research/src/tools/fetch-promoter-holding");
  return mod.fetchPromoterHoldingTool;
}

const FLOAT_TOLERANCE = 1e-9;

// ════════════════════════════════════════════════════════════════════
// 1. Static metadata + happy-path shape (no injected data needed for meta)
// ════════════════════════════════════════════════════════════════════

test("tool exposes expected static metadata", () => {
  assert.equal(fetchPromoterHoldingTool.name, "fetch_promoter_holding");
  assert.equal(fetchPromoterHoldingTool.category, "data");
  assert.equal(typeof fetchPromoterHoldingTool.description, "string");
  assert.ok(fetchPromoterHoldingTool.description.length > 0);
  assert.equal(typeof fetchPromoterHoldingTool.execute, "function");
  // symbol is a required string param
  assert.equal(fetchPromoterHoldingTool.parameters.symbol!.required, true);
  assert.equal(fetchPromoterHoldingTool.parameters.symbol!.type, "string");
  // 24h cache TTL — shareholding patterns change quarterly
  assert.equal(fetchPromoterHoldingTool.cacheTTL, 86400);
});

test(
  "happy path: representative series → available:true with typed fields present",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([
      { quarter: "Q4FY24", promoter: 62.0 },
      { quarter: "Q1FY25", promoter: 62.0 },
      { quarter: "Q2FY25", promoter: 62.5 },
    ]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "RELIANCE" });

    assert.equal(r.success, true);
    assert.ok(r.data, "expected data payload");
    const data = r.data as PromoterData;

    // Available + correct primitive types on every key field.
    assert.equal(data.available, true);
    assert.equal(typeof data.symbol, "string");
    assert.equal(data.symbol, "RELIANCE");
    assert.equal(typeof data.promoterPercent, "number");
    assert.equal(typeof data.previousQuarter, "number");
    assert.equal(typeof data.change, "number");
    assert.equal(typeof data.trend, "string");
    assert.ok(Array.isArray(data.series));
    assert.equal(data.series!.length, 3);
    assert.ok(Array.isArray(data.flags));
    // latest = 62.5, previous = 62.0, +0.5pp → increasing
    assert.ok(Math.abs(data.promoterPercent! - 62.5) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.previousQuarter! - 62.0) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.change! - 0.5) < FLOAT_TOLERANCE);
    assert.equal(data.trend, "increasing");
    // every series point is well-formed
    for (const point of data.series!) {
      assert.equal(typeof point.quarter, "string");
      assert.equal(typeof point.promoterPercent, "number");
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// 2. KNOWN-VALUE numeric assertion (the pinned fixture)
//    series oldest→newest: [Q4FY24:55.0, Q1FY25:54.5, Q2FY25:50.2]
//    → promoterPercent=50.2, previousQuarter=54.5, change=-4.3,
//      trend="decreasing", plus QoQ-decrease flag AND
//      3-consecutive-quarter-decline flag (each step ≥0.5pp).
// ════════════════════════════════════════════════════════════════════

test(
  "known value: declining 3-quarter series → exact numbers + both decline flags",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([
      { quarter: "Q4FY24", promoter: 55.0 },
      { quarter: "Q1FY25", promoter: 54.5 },
      { quarter: "Q2FY25", promoter: 50.2 },
    ]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "TESTCO" });

    assert.equal(r.success, true);
    const data = r.data as PromoterData;

    assert.equal(data.available, true);
    assert.equal(data.symbol, "TESTCO");

    // Tight float tolerances on every numeric field.
    assert.ok(Math.abs(data.promoterPercent! - 50.2) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.previousQuarter! - 54.5) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.change! - -4.3) < FLOAT_TOLERANCE);
    assert.equal(data.trend, "decreasing");

    // Series preserved oldest → newest, rounded to 2dp.
    assert.deepEqual(data.series, [
      { quarter: "Q4FY24", promoterPercent: 55.0 },
      { quarter: "Q1FY25", promoterPercent: 54.5 },
      { quarter: "Q2FY25", promoterPercent: 50.2 },
    ]);

    // Flag 1: QoQ-decrease governance signal (latest delta ≤ -0.5pp).
    const hasQoqFlag = data.flags.some(
      (f) => /decreased/i.test(f) && /QoQ/i.test(f) && /governance/i.test(f)
    );
    assert.ok(
      hasQoqFlag,
      `expected QoQ-decrease flag, got: ${JSON.stringify(data.flags)}`
    );

    // Flag 2: 3-consecutive-quarter decline (55.0→54.5 and 54.5→50.2, each ≥0.5pp).
    const has3QFlag = data.flags.some((f) =>
      /declined for 3 consecutive quarters/i.test(f)
    );
    assert.ok(
      has3QFlag,
      `expected 3-quarter-decline flag, got: ${JSON.stringify(data.flags)}`
    );
  }
);

test(
  "known value: 2-quarter increase → trend increasing, single +0.5pp delta, no flags",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([
      { quarter: "Q1FY25", promoter: 40.0 },
      { quarter: "Q2FY25", promoter: 42.5 },
    ]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "UPCO" });

    const data = r.data as PromoterData;
    assert.equal(data.available, true);
    assert.ok(Math.abs(data.promoterPercent! - 42.5) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.previousQuarter! - 40.0) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.change! - 2.5) < FLOAT_TOLERANCE);
    assert.equal(data.trend, "increasing");
    // No decrease flag, 42.5% ≥ 25% so no low-stake flag → empty.
    assert.deepEqual(data.flags, []);
  }
);

test(
  "known value: stable dead-band (+0.3pp < 0.5pp) → trend stable, no flags",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([
      { quarter: "Q1FY25", promoter: 50.0 },
      { quarter: "Q2FY25", promoter: 50.3 },
    ]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "FLATCO" });

    const data = r.data as PromoterData;
    assert.equal(data.trend, "stable");
    assert.ok(Math.abs(data.change! - 0.3) < FLOAT_TOLERANCE);
    assert.deepEqual(data.flags, []);
  }
);

test(
  "known value: pledged % extracted from raw row; low-promoter flag below 25%",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([{ quarter: "Q1FY25", promoter: 18.0, pledgedPercent: 12.34 }]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "PLEDGECO" });

    const data = r.data as PromoterData;
    assert.equal(data.available, true);
    assert.ok(Math.abs(data.promoterPercent! - 18.0) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.pledgedPercent! - 12.34) < FLOAT_TOLERANCE);
    // 18% < 25% → low-promoter-holding flag present.
    assert.ok(
      data.flags.some((f) => /Low promoter holding/i.test(f)),
      `expected low-promoter flag, got: ${JSON.stringify(data.flags)}`
    );
  }
);

// ════════════════════════════════════════════════════════════════════
// 3. Graceful degradation: success:true + available:false (NOT success:false)
// ════════════════════════════════════════════════════════════════════

test("degradation: empty symbol → success:true, available:false, reason set", async () => {
  // No injected data needed — guarded before the chain is ever consulted, so
  // this runs under the plain runner too.
  const r = await fetchPromoterHoldingTool.execute({ symbol: "" });
  assert.equal(r.success, true);
  assert.ok(r.data, "expected data payload");
  const data = r.data as PromoterData;
  assert.equal(data.available, false);
  assert.equal(data.symbol, "");
  assert.equal(typeof data.reason, "string");
  assert.ok(data.reason!.length > 0);
  assert.deepEqual(data.flags, []);
  // never a fabricated number when unavailable
  assert.equal(data.promoterPercent, undefined);
});

test("degradation: non-string / missing symbol → success:true, available:false", async () => {
  const missing = await fetchPromoterHoldingTool.execute({});
  assert.equal(missing.success, true);
  assert.equal((missing.data as PromoterData).available, false);

  const numeric = await fetchPromoterHoldingTool.execute({
    symbol: 123 as unknown as string,
  });
  assert.equal(numeric.success, true);
  assert.equal((numeric.data as PromoterData).available, false);
});

test(
  "degradation: chain resolves null (no source) → success:true, available:false, reason",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain(null);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "NOSOURCE" });

    // NOT success:false — the synthesizer renders "—", never an error.
    assert.equal(r.success, true);
    const data = r.data as PromoterData;
    assert.equal(data.available, false);
    assert.equal(data.symbol, "NOSOURCE");
    assert.equal(typeof data.reason, "string");
    assert.ok(/No shareholding data resolved/i.test(data.reason!));
    assert.deepEqual(data.flags, []);
  }
);

test(
  "degradation: rows carry no parseable promoter % → success:true, available:false",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([
      { quarter: "Q1FY25", fii: 30.0 },
      { quarter: "Q2FY25", dii: 12.0 },
    ]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "NOPCT" });

    assert.equal(r.success, true);
    const data = r.data as PromoterData;
    assert.equal(data.available, false);
    assert.ok(/no promoter percentage/i.test(data.reason!));
    assert.deepEqual(data.flags, []);
  }
);

test(
  "degradation: genuine thrown exception → success:false with error string",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChainThrows("upstream blew up");
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "BOOMCO" });

    // Only a genuine runtime exception yields success:false.
    assert.equal(r.success, false);
    assert.equal(typeof r.error, "string");
    assert.ok(/upstream blew up/.test(r.error!));
    assert.equal(r.data, undefined);
    // restore for any later case sharing the closure
    setChain(null);
  }
);

// ════════════════════════════════════════════════════════════════════
// 4. Edge cases — must not throw
// ════════════════════════════════════════════════════════════════════

test(
  "edge: single-quarter series → no previous/change/trend, empty flags, available:true",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([{ quarter: "Q2FY25", promoter: 60.0 }]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "SOLO" });

    const data = r.data as PromoterData;
    assert.equal(data.available, true);
    assert.ok(Math.abs(data.promoterPercent! - 60.0) < FLOAT_TOLERANCE);
    assert.equal(data.previousQuarter, undefined);
    assert.equal(data.change, undefined);
    assert.equal(data.trend, undefined);
    assert.deepEqual(data.flags, []);
  }
);

test(
  "edge: zero promoter % both quarters → stable, low-stake flag, no throw",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([
      { quarter: "Q1FY25", promoter: 0 },
      { quarter: "Q2FY25", promoter: 0 },
    ]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "ZEROCO" });

    const data = r.data as PromoterData;
    assert.equal(data.available, true);
    assert.equal(data.promoterPercent, 0);
    assert.equal(data.change, 0);
    assert.equal(data.trend, "stable");
    assert.ok(data.flags.some((f) => /Low promoter holding/i.test(f)));
  }
);

test(
  "edge: string-formatted % values + missing quarter labels are coerced and synthesized",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([{ promoter: "55.5%" }, { promoter: "54.0" }]);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "STRCO" });

    const data = r.data as PromoterData;
    assert.equal(data.available, true);
    // "55.5%" / "54.0" coerced to numbers via toNum.
    assert.ok(Math.abs(data.promoterPercent! - 54.0) < FLOAT_TOLERANCE);
    assert.ok(Math.abs(data.previousQuarter! - 55.5) < FLOAT_TOLERANCE);
    // missing quarter labels synthesized as Q1, Q2 …
    assert.equal(data.series![0]!.quarter, "Q1");
    assert.equal(data.series![1]!.quarter, "Q2");
  }
);

test(
  "edge: .NS / .BO suffix stripped and symbol uppercased",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    setChain([{ quarter: "Q1FY25", promoter: 50.0 }]);
    const tool = await loadMockedTool();

    const ns = await tool.execute({ symbol: "reliance.ns" });
    assert.equal((ns.data as PromoterData).symbol, "RELIANCE");

    const bo = await tool.execute({ symbol: "tcs.BO" });
    assert.equal((bo.data as PromoterData).symbol, "TCS");
  }
);

// ════════════════════════════════════════════════════════════════════
// 5. The data tool resolves to a ToolOutput without throwing (no live IO fail)
// ════════════════════════════════════════════════════════════════════

test(
  "data tool: clearly-unknown symbol resolves to a ToolOutput (degraded) without throwing",
  { skip: !HAS_MODULE_MOCK && "requires --experimental-test-module-mocks" },
  async () => {
    // Mocked chain returns null for any symbol → deterministic degraded shape,
    // no live network. Asserts we always get a well-formed ToolOutput.
    setChain(null);
    const tool = await loadMockedTool();
    const r = await tool.execute({ symbol: "ZZZNOTAREALSYM" });

    assert.equal(typeof r, "object");
    assert.ok(r !== null);
    assert.equal(typeof r.success, "boolean");
    assert.equal(r.success, true);
    const data = r.data as PromoterData;
    assert.equal(data.available, false);
    assert.equal(data.symbol, "ZZZNOTAREALSYM");
    assert.ok(Array.isArray(data.flags));
  }
);
