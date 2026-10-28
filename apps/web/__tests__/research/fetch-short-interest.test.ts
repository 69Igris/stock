/**
 * fetch_short_interest tool tests (MONEY-543)
 *
 * Tests packages/research/src/tools/fetch-short-interest.ts
 *
 * The tool intentionally degrades for Indian equities: NSE publishes no
 * single-stock short interest, and the research NSE client exposes no SLB /
 * F&O ban-list / open-interest method. So the expected, correct outcome is
 * { success: true, data: { available: false, ... reason ... } } — NOT
 * success:false. success:false is reserved for genuinely malformed input
 * (empty symbol) or a thrown runtime exception.
 *
 * Determinism: the underlying NSE `getTradeInfo` probe is wrapped in a
 * try/catch inside the tool and its result NEVER changes the degraded shape
 * (only the `note` wording). We additionally stub `globalThis.fetch` so the
 * suite never performs live network IO — the stub rejects, the client's
 * internal retry/catch swallows it, and the tool degrades exactly as it would
 * offline. No randomness is relied upon.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { fetchShortInterestTool } from "../../../../packages/research/src/tools/fetch-short-interest";

// ── Network isolation ──────────────────────────────────────────────
// Replace global fetch with a deterministic rejecting stub so the singleton
// NseClient never hits the wire. The tool catches the failure and degrades.
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    throw new Error("network disabled in unit test");
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

type ShortInterestData = {
  available: boolean;
  symbol: string;
  reason?: string;
  shortInterestPercent?: number;
  hasShortInterest?: boolean;
  note?: string;
  flags?: string[];
};

const NO_SOURCE_REASON =
  "NSE does not publish single-stock short interest; SLB/OI proxy unavailable";

async function run(args: Record<string, unknown>) {
  return fetchShortInterestTool.execute(args);
}

// ── 1. Tool metadata / shape ────────────────────────────────────────

test("tool exposes expected static metadata", () => {
  assert.equal(fetchShortInterestTool.name, "fetch_short_interest");
  assert.equal(fetchShortInterestTool.category, "data");
  assert.equal(typeof fetchShortInterestTool.description, "string");
  assert.ok(fetchShortInterestTool.description.length > 0);
  assert.equal(typeof fetchShortInterestTool.execute, "function");
  // symbol is a required string param
  assert.equal(fetchShortInterestTool.parameters.symbol!.required, true);
  assert.equal(fetchShortInterestTool.parameters.symbol!.type, "string");
  // 24h cache TTL on the degraded result
  assert.equal(fetchShortInterestTool.cacheTTL, 86400);
});

// ── 2. Happy path: representative input degrades cleanly ────────────

test("happy path: returns success with available:false degraded shape and typed fields", async () => {
  const r = await run({ symbol: "RELIANCE" });
  assert.equal(r.success, true);
  assert.ok(r.data, "expected data payload");
  const data = r.data as ShortInterestData;

  // available:false is the correct, expected degradation (not success:false)
  assert.equal(data.available, false);
  assert.equal(data.hasShortInterest, false);

  // key fields present + correct types
  assert.equal(typeof data.symbol, "string");
  assert.equal(typeof data.reason, "string");
  assert.equal(typeof data.note, "string");
  assert.ok(Array.isArray(data.flags));
  // observation-only flags — never advice; degraded path emits none
  assert.equal(data.flags!.length, 0);
  // no fabricated short-interest number when unavailable
  assert.equal(data.shortInterestPercent, undefined);
});

// ── 3. Known-value assertions ───────────────────────────────────────

test("known value: RELIANCE → exact degraded payload", async () => {
  const r = await run({ symbol: "RELIANCE" });
  assert.equal(r.success, true);
  const data = r.data as ShortInterestData;

  assert.equal(data.available, false);
  assert.equal(data.symbol, "RELIANCE");
  assert.equal(data.reason, NO_SOURCE_REASON);
  assert.equal(data.hasShortInterest, false);
  assert.equal(typeof data.note, "string");
  assert.ok(data.note!.length > 0);
  assert.deepEqual(data.flags, []);
});

test("known value: TCS.NS normalizes symbol to TCS, same degraded shape", async () => {
  const r = await run({ symbol: "TCS.NS" });
  assert.equal(r.success, true);
  const data = r.data as ShortInterestData;

  assert.equal(data.symbol, "TCS"); // .NS suffix stripped, uppercased
  assert.equal(data.available, false);
  assert.equal(data.reason, NO_SOURCE_REASON);
  assert.equal(data.hasShortInterest, false);
  assert.deepEqual(data.flags, []);
});

test("known value: empty symbol → success:false with 'symbol is required'", async () => {
  const r = await run({ symbol: "" });
  assert.equal(r.success, false);
  assert.equal(r.error, "symbol is required");
  assert.equal(r.data, undefined);
});

// ── 4. Graceful degradation contract ────────────────────────────────

test("graceful degradation: always degrades to available:false with a reason (not success:false)", async () => {
  const r = await run({ symbol: "INFY" });
  // The degraded path is a SUCCESS — the synthesizer renders "—", not an error.
  assert.equal(r.success, true);
  const data = r.data as ShortInterestData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(data.reason!.length > 0);
  assert.equal(data.reason, NO_SOURCE_REASON);
});

test("degraded reason is honest about SLB/OI proxy unavailability", async () => {
  const r = await run({ symbol: "HDFCBANK" });
  const data = r.data as ShortInterestData;
  // The note must reference what India does/doesn't publish (SLB / OI / ban list).
  const note = data.note ?? "";
  assert.ok(
    /SLB|open interest|ban list|short interest/i.test(note),
    `note should explain NSE/SLB/OI context, got: ${note}`
  );
});

// ── 5. Edge cases — must not throw ──────────────────────────────────

test("edge: lowercase symbol is uppercased", async () => {
  const r = await run({ symbol: "reliance" });
  assert.equal(r.success, true);
  const data = r.data as ShortInterestData;
  assert.equal(data.symbol, "RELIANCE");
  assert.equal(data.available, false);
});

test("edge: .BO suffix stripped (case-insensitive)", async () => {
  const r = await run({ symbol: "tcs.bo" });
  assert.equal(r.success, true);
  const data = r.data as ShortInterestData;
  assert.equal(data.symbol, "TCS");
  assert.equal(data.available, false);
});

test("edge: non-string / missing symbol coerces to empty → success:false", async () => {
  const noArg = await run({});
  assert.equal(noArg.success, false);
  assert.equal(noArg.error, "symbol is required");

  const numeric = await run({ symbol: 123 as unknown as string });
  assert.equal(numeric.success, false);
  assert.equal(numeric.error, "symbol is required");
});

test("edge: clearly-unknown symbol still resolves to ToolOutput without throwing (no live IO failure)", async () => {
  // Network is stubbed to reject; the tool must swallow that and degrade.
  const r = await fetchShortInterestTool.execute({ symbol: "ZZZNOTAREALSYM" });
  assert.equal(typeof r, "object");
  assert.ok(r !== null);
  assert.equal(r.success, true);
  const data = r.data as ShortInterestData;
  assert.equal(data.available, false);
  assert.equal(data.symbol, "ZZZNOTAREALSYM");
  assert.equal(data.hasShortInterest, false);
});
