import { test } from "node:test";
import assert from "node:assert/strict";

import { computeWorkingCapitalDragTool } from "../../../../packages/research/src/tools/compute-working-capital-drag";

// MONEY-498 - compute-working-capital-drag pure-compute tests.
//
// The tool is a PURE compute: DSO / DIO / DPO, cash conversion cycle (CCC),
// net working capital + intensity, YoY WC swing, trend classification, score,
// and observation flags. All assertions below are deterministic - the tool
// uses no randomness, clocks, or I/O.

interface WorkingCapitalDragResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  dso: number | null;
  dio: number | null;
  dpo: number | null;
  cashConversionCycle: number | null;
  netWorkingCapital: number | null;
  nwcToRevenue: number | null;
  changeInWorkingCapital: number | null;
  changeInWCToRevenue: number | null;
  cashImpact: "absorbed" | "released" | "neutral" | null;
  cccTrend: "improving" | "stable" | "lengthening" | "unknown";
  score: number;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computeWorkingCapitalDragTool.execute(args);
}

// Small helper: assert success + available, then hand back the typed payload.
function expectAvailable(
  r: Awaited<ReturnType<typeof run>>
): WorkingCapitalDragResult {
  assert.equal(r.success, true);
  const data = r.data as WorkingCapitalDragResult;
  assert.equal(data.available, true);
  return data;
}

// ── 1. Tool metadata sanity ──────────────────────────────────────────

test("tool exposes expected name + category + execute", () => {
  assert.equal(
    computeWorkingCapitalDragTool.name,
    "compute_working_capital_drag"
  );
  assert.equal(computeWorkingCapitalDragTool.category, "computation");
  assert.equal(typeof computeWorkingCapitalDragTool.execute, "function");
});

// ── 2. Happy path: representative inputs, fields present + typed ──────

test("happy path returns success + available with correctly typed fields", async () => {
  const r = await run({
    symbol: "ACME",
    revenue: 5000,
    costOfRevenue: 3000,
    receivables: 800,
    inventory: 600,
    payables: 400,
  });
  const data = expectAvailable(r);

  assert.equal(data.symbol, "ACME");
  assert.equal(typeof data.dso, "number");
  assert.equal(typeof data.dio, "number");
  assert.equal(typeof data.dpo, "number");
  assert.equal(typeof data.cashConversionCycle, "number");
  assert.equal(typeof data.netWorkingCapital, "number");
  assert.equal(typeof data.nwcToRevenue, "number");
  assert.equal(typeof data.score, "number");
  assert.ok(
    data.score >= 0 && data.score <= 100,
    `score in range, got ${data.score}`
  );
  assert.equal(typeof data.cccTrend, "string");
  assert.ok(Array.isArray(data.flags));
  // No prior / no history supplied -> YoY + trend fields stay null/unknown.
  assert.equal(data.changeInWorkingCapital, null);
  assert.equal(data.changeInWCToRevenue, null);
  assert.equal(data.cashImpact, null);
  assert.equal(data.cccTrend, "unknown");
});

// ── 3. KNOWN-VALUE numeric assertion ─────────────────────────────────

test("known-value: revenue 1000 / cogs 600 / R200 I150 P100", async () => {
  const r = await run({
    revenue: 1000,
    costOfRevenue: 600,
    receivables: 200,
    inventory: 150,
    payables: 100,
  });
  const data = expectAvailable(r);

  // DSO = 200/1000 * 365 = 73.0
  assert.ok(Math.abs((data.dso ?? NaN) - 73.0) < 1e-9, `dso ${data.dso}`);
  // DIO = 150/600 * 365 = 91.25 -> 91.3 (1dp)
  assert.ok(Math.abs((data.dio ?? NaN) - 91.3) < 1e-9, `dio ${data.dio}`);
  // DPO = 100/600 * 365 = 60.833.. -> 60.8 (1dp)
  assert.ok(Math.abs((data.dpo ?? NaN) - 60.8) < 1e-9, `dpo ${data.dpo}`);
  // CCC = 73.0 + 91.3 - 60.8 = 103.5
  assert.ok(
    Math.abs((data.cashConversionCycle ?? NaN) - 103.5) < 1e-9,
    `ccc ${data.cashConversionCycle}`
  );
  // NWC = 200 + 150 - 100 = 250
  assert.ok(
    Math.abs((data.netWorkingCapital ?? NaN) - 250) < 1e-9,
    `nwc ${data.netWorkingCapital}`
  );
  // NWC / revenue = 250/1000 = 0.25
  assert.ok(
    Math.abs((data.nwcToRevenue ?? NaN) - 0.25) < 1e-9,
    `nwcToRevenue ${data.nwcToRevenue}`
  );
  // score: base 50; CCC 103.5 in (90,120] -> -10; nwcToRevenue 0.25 in (0.2,0.3] -> -3 => 37
  assert.equal(data.score, 37);
  assert.equal(data.cccTrend, "unknown");
  assert.deepEqual(data.flags, []);
});

// ── 4. Graceful degradation: available:false (NOT success:false) ─────

test("graceful: no revenue and no WC components -> available:false with reason", async () => {
  const r = await run({ symbol: "EMPTY" });
  // Still a successful tool run - it just reports the data is unavailable.
  assert.equal(r.success, true);
  const data = r.data as WorkingCapitalDragResult;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok((data.reason ?? "").length > 0);
  assert.equal(data.symbol, "EMPTY");
  assert.equal(data.dso, null);
  assert.equal(data.cashConversionCycle, null);
  assert.equal(data.score, 0);
  assert.equal(data.cccTrend, "unknown");
  assert.deepEqual(data.flags, []);
});

test("graceful: revenue <= 0 and no WC components -> available:false", async () => {
  const r = await run({ revenue: 0 });
  assert.equal(r.success, true);
  const data = r.data as WorkingCapitalDragResult;
  assert.equal(data.available, false);
});

test("graceful: WC component present but no revenue -> still available:true", async () => {
  // revenue is missing/<=0 but a balance-sheet component exists, so the tool
  // must NOT degrade - it computes NWC even though days metrics need revenue.
  const r = await run({ receivables: 100, inventory: 50, payables: 30 });
  const data = expectAvailable(r);
  // NWC = 100 + 50 - 30 = 120
  assert.ok(Math.abs((data.netWorkingCapital ?? NaN) - 120) < 1e-9);
  // No revenue -> DSO null; cogs falls back to (null) revenue so DIO/DPO null.
  assert.equal(data.dso, null);
  assert.equal(data.dio, null);
  assert.equal(data.dpo, null);
  assert.equal(data.nwcToRevenue, null);
});

// ── 5. Edge cases that must NOT throw ────────────────────────────────

test("empty params object does not throw and returns success", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as WorkingCapitalDragResult;
  assert.equal(data.available, false);
});

test("negative payables only (negative NWC) -> favorable flag, no throw", async () => {
  const r = await run({ revenue: 1000, payables: 500 });
  const data = expectAvailable(r);
  // NWC = 0 + 0 - 500 = -500 ; nwcToRevenue = -0.5 (< 0)
  assert.ok(Math.abs((data.netWorkingCapital ?? NaN) + 500) < 1e-9);
  assert.ok((data.nwcToRevenue ?? 0) < 0);
  assert.ok(
    data.flags.some((f) =>
      f.toLowerCase().includes("negative net working capital")
    ),
    `expected negative-NWC flag, got ${JSON.stringify(data.flags)}`
  );
});

test("non-numeric / garbage inputs are coerced to null, no throw", async () => {
  const r = await run({
    revenue: "not-a-number",
    receivables: 200,
    inventory: null,
    payables: undefined,
  });
  const data = expectAvailable(r);
  // revenue coerces to null -> dso null; receivables present -> NWC = 200.
  assert.equal(data.dso, null);
  assert.ok(Math.abs((data.netWorkingCapital ?? NaN) - 200) < 1e-9);
});

test("short history series (< 3 periods) leaves cccTrend unknown, no throw", async () => {
  const r = await run({
    revenue: 1000,
    costOfRevenue: 600,
    receivables: 200,
    inventory: 150,
    payables: 100,
    historicalReceivables: [180, 200],
    historicalInventory: [140, 150],
    historicalPayables: [90, 100],
    historicalRevenue: [900, 1000],
    historicalCostOfRevenue: [560, 600],
  });
  const data = expectAvailable(r);
  // Only 2 periods -> not enough to classify the CCC trend.
  assert.equal(data.cccTrend, "unknown");
});

test("lengthening CCC over >=3 periods sets cccTrend=lengthening + flag", async () => {
  // Receivables grow each year while revenue/cogs are flat -> DSO climbs,
  // so the cash conversion cycle lengthens by well over the 10% threshold.
  const r = await run({
    revenue: 1000,
    costOfRevenue: 600,
    receivables: 400,
    inventory: 150,
    payables: 100,
    historicalReceivables: [100, 250, 400],
    historicalInventory: [150, 150, 150],
    historicalPayables: [100, 100, 100],
    historicalRevenue: [1000, 1000, 1000],
    historicalCostOfRevenue: [600, 600, 600],
  });
  const data = expectAvailable(r);
  assert.equal(data.cccTrend, "lengthening");
  assert.ok(
    data.flags.some((f) => f.toLowerCase().includes("lengthening")),
    `expected lengthening flag, got ${JSON.stringify(data.flags)}`
  );
});

test("YoY working-capital growth sets cashImpact=absorbed with flag", async () => {
  const r = await run({
    revenue: 1000,
    costOfRevenue: 600,
    receivables: 300,
    inventory: 150,
    payables: 100,
    priorReceivables: 100,
    priorInventory: 150,
    priorPayables: 100,
  });
  const data = expectAvailable(r);
  // current NWC = 350, prior NWC = 150 -> changeInWC = +200 (cash absorbed).
  assert.ok(Math.abs((data.changeInWorkingCapital ?? NaN) - 200) < 1e-9);
  assert.equal(data.cashImpact, "absorbed");
  assert.ok(
    data.flags.some((f) => f.toLowerCase().includes("working capital")),
    `expected WC absorption flag, got ${JSON.stringify(data.flags)}`
  );
});

test("declining WC sets cashImpact=released", async () => {
  const r = await run({
    revenue: 1000,
    costOfRevenue: 600,
    receivables: 100,
    inventory: 50,
    payables: 100,
    priorReceivables: 300,
    priorInventory: 150,
    priorPayables: 100,
  });
  const data = expectAvailable(r);
  // current NWC = 50, prior NWC = 350 -> change = -300 -> cash released.
  assert.equal(data.cashImpact, "released");
  assert.ok((data.changeInWorkingCapital ?? 0) < 0);
});
