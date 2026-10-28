/**
 * Governance Flags Aggregator Tool Tests
 * (packages/research/src/tools/compute-governance-flags.ts)
 *
 * PURE compute tool — no network/db/io, fully deterministic.
 *
 * Coverage:
 *   - Tool metadata sanity (name / category / execute)
 *   - Happy path (success:true, available:true, field presence + types)
 *   - Known-value numeric assertion (runtime-verified expected values:
 *       pledging 60% > 50 → 1 red; promoter holding 20% < 26 → 1 amber;
 *       promoter stake fell 2% QoQ → 1 amber; score 70 − 25 − 16 = 29 → "F")
 *   - Graceful degradation: NO governance inputs → success:true + available:false
 *     with reason "No governance inputs supplied" (NOT success:false)
 *   - Severity buckets: green (clean pledging / strong holding / inst inflow),
 *     amber (related-party, low float, board/auditor change, dilution),
 *     red (heavy pledging)
 *   - corporateActions accepted as raw array AND { data: [] } wrapper
 *   - Edge cases: empty / zero / negative / short series / missing optional
 *     fields — must not throw and must keep success:true
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeGovernanceFlagsTool } from "../../../../packages/research/src/tools/compute-governance-flags";

// ── Shape of result.data (mirrors GovernanceFlagsResult) ─────────────
type GovernanceFlagSeverity = "red" | "amber" | "green";

interface GovernanceFlag {
  severity: GovernanceFlagSeverity;
  category: string;
  message: string;
  source: string;
}

interface GovernanceFlagsResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  governanceScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  redCount: number;
  amberCount: number;
  greenCount: number;
  flags: GovernanceFlag[];
  inputsUsed: string[];
}

async function run(args: Record<string, unknown>) {
  return computeGovernanceFlagsTool.execute(args);
}

function asData(r: {
  success: boolean;
  data?: unknown;
}): GovernanceFlagsResult {
  assert.ok(r.data, "expected data on tool output");
  return r.data as GovernanceFlagsResult;
}

function hasCategory(d: GovernanceFlagsResult, category: string): boolean {
  return d.flags.some((f) => f.category === category);
}

function severityOf(
  d: GovernanceFlagsResult,
  category: string
): GovernanceFlagSeverity | undefined {
  return d.flags.find((f) => f.category === category)?.severity;
}

// ── 1. Tool metadata sanity ──────────────────────────────────────────
test("tool is wired with name + category + execute", () => {
  assert.equal(computeGovernanceFlagsTool.name, "compute_governance_flags");
  assert.equal(computeGovernanceFlagsTool.category, "computation");
  assert.equal(typeof computeGovernanceFlagsTool.execute, "function");
});

// ── 2. Happy path: success:true, available:true, typed fields ────────
test("happy path returns success:true, available:true with typed fields", async () => {
  const r = await run({
    symbol: "infy",
    shareholding: {
      promoter: { current: 55, change: 1.5 },
      fii: { change: 1 },
      dii: { change: 0.8 },
      public: { current: 25 },
    },
    promoterPledging: { pledgedPercent: 0, promoterHolding: 55 },
  });

  assert.equal(r.success, true);
  const d = asData(r);

  assert.equal(d.available, true);
  // symbol is upper-cased by the tool
  assert.equal(d.symbol, "INFY");

  // field presence + types
  assert.equal(typeof d.governanceScore, "number");
  assert.ok(Number.isFinite(d.governanceScore));
  assert.ok(d.governanceScore >= 0 && d.governanceScore <= 100);
  assert.ok(["A", "B", "C", "D", "F"].includes(d.grade));
  assert.equal(typeof d.redCount, "number");
  assert.equal(typeof d.amberCount, "number");
  assert.equal(typeof d.greenCount, "number");
  assert.ok(Array.isArray(d.flags));
  assert.ok(Array.isArray(d.inputsUsed));

  // counts agree with the flags array
  assert.equal(d.redCount, d.flags.filter((f) => f.severity === "red").length);
  assert.equal(
    d.amberCount,
    d.flags.filter((f) => f.severity === "amber").length
  );
  assert.equal(
    d.greenCount,
    d.flags.filter((f) => f.severity === "green").length
  );

  // every flag is well-formed
  for (const f of d.flags) {
    assert.ok(["red", "amber", "green"].includes(f.severity));
    assert.equal(typeof f.category, "string");
    assert.ok(f.message.length > 0);
    assert.ok(f.source.length > 0);
  }

  // inputsUsed reflects supplied inputs
  assert.ok(d.inputsUsed.includes("shareholding"));
  assert.ok(d.inputsUsed.includes("promoterPledging"));
});

// ── 3. KNOWN-VALUE numeric assertion (runtime-verified) ──────────────
test("known-value: heavy pledging + low holding + falling stake → score 29, grade F", async () => {
  const r = await run({
    promoterPledging: { pledgedPercent: 60, promoterHolding: 20 },
    shareholding: {
      promoter: { current: 20, change: -2 },
      fii: { change: 0 },
      dii: { change: 0 },
    },
  });

  assert.equal(r.success, true);
  const d = asData(r);

  assert.equal(d.available, true);
  // 1 red (pledging 60% > 50), 2 amber (holding <26; stake fell 2% QoQ), 0 green
  assert.equal(d.redCount, 1);
  assert.equal(d.amberCount, 2);
  assert.equal(d.greenCount, 0);

  // Score = 70 − 1×25 − 2×8 + 0×5 = 29 (exact integer — tight tolerance)
  assert.equal(d.governanceScore, 29);
  assert.equal(d.grade, "F");

  // categories that produced the flags
  assert.equal(severityOf(d, "promoter_pledging"), "red");
  assert.equal(severityOf(d, "promoter_holding"), "amber");
  assert.equal(severityOf(d, "promoter_trend"), "amber");
  // instFlow == 0 → no institutional_flow flag
  assert.equal(hasCategory(d, "institutional_flow"), false);
});

// ── 4. Graceful degradation: NO inputs → available:false, success:true ─
test("no governance inputs → success:true, available:false, reason string", async () => {
  const r = await run({});

  // success stays true — available:false is the graceful-degradation signal
  assert.equal(r.success, true);
  const d = asData(r);

  assert.equal(d.available, false);
  assert.equal(d.reason, "No governance inputs supplied");
  assert.deepEqual(d.inputsUsed, []);
  assert.equal(d.flags.length, 0);
  assert.equal(d.redCount, 0);
  assert.equal(d.amberCount, 0);
  assert.equal(d.greenCount, 0);
  assert.equal(d.grade, "F");
});

test("only a symbol (no governance inputs) still degrades to available:false", async () => {
  const r = await run({ symbol: "tcs" });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, false);
  assert.equal(d.reason, "No governance inputs supplied");
  // symbol still carried through, upper-cased
  assert.equal(d.symbol, "TCS");
});

test("empty corporateActions array + empty objects → available:false", async () => {
  // Non-record / empty values do not count as supplied governance inputs.
  const r = await run({
    corporateActions: [],
    shareholding: undefined,
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, false);
  assert.equal(d.reason, "No governance inputs supplied");
});

// ── 5. Green-path signals ────────────────────────────────────────────
test("clean book → green flags raise score, grade trends high", async () => {
  const r = await run({
    promoterPledging: { pledgedPercent: 0, promoterHolding: 62 },
    shareholding: {
      promoter: { current: 62, change: 0.5 },
      fii: { change: 0.4 },
      dii: { change: 0.4 },
    },
    relatedParty: { present: false },
  });

  assert.equal(r.success, true);
  const d = asData(r);

  assert.equal(d.available, true);
  // No pledging → green; holding 62% ≥ 50 → green; instFlow 0.8 > 0.5 → green;
  // stake rose → green; related-party clean → green
  assert.equal(severityOf(d, "promoter_pledging"), "green");
  assert.equal(severityOf(d, "promoter_holding"), "green");
  assert.equal(severityOf(d, "institutional_flow"), "green");
  assert.equal(severityOf(d, "promoter_trend"), "green");
  assert.equal(severityOf(d, "related_party"), "green");
  assert.equal(d.redCount, 0);
  assert.ok(d.greenCount >= 5);
  // greens push the score above the baseline 70
  assert.ok(d.governanceScore > 70);
  assert.ok(["A", "B"].includes(d.grade));
});

// ── 6. Amber-path signals (related-party, float, board, dilution) ────
test("material related-party transactions raise an amber related_party flag", async () => {
  const r = await run({
    relatedParty: { materialityPercent: 18 },
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.equal(severityOf(d, "related_party"), "amber");
  assert.ok(d.amberCount >= 1);
});

test("low public float + board/auditor change → amber flags", async () => {
  const r = await run({
    shareholding: {
      promoter: { current: 80, change: 0 },
      public: { current: 8 },
    },
    corporateActions: {
      data: [
        { purpose: "Resignation of Auditor", exDate: "2026-03-01" },
        { purpose: "Dividend", exDate: "2026-02-01" },
      ],
    },
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  // low float < 15
  assert.equal(severityOf(d, "public_float"), "amber");
  // board/auditor pattern matched once
  assert.equal(severityOf(d, "board_audit"), "amber");
  assert.equal(
    d.flags.filter((f) => f.category === "board_audit").length,
    1,
    "only one board/audit flag is surfaced"
  );
  // corporateActions wrapped in { data: [] } is recognised as a supplied input
  assert.ok(d.inputsUsed.includes("corporateActions"));
});

test("rising share count history flags equity dilution (amber)", async () => {
  const r = await run({
    promoterHolding: {
      current: 40,
      shareCountHistory: [100, 110, 130], // +30% over the window (>20)
    },
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.equal(severityOf(d, "equity_dilution"), "amber");
});

// ── 7. corporateActions accepted as a RAW ARRAY ──────────────────────
test("corporateActions passed as a raw array is parsed (board_audit detected)", async () => {
  const r = await run({
    corporateActions: [
      { details: "Appointment of new Managing Director", date: "2026-01-15" },
    ],
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.ok(d.inputsUsed.includes("corporateActions"));
  assert.equal(severityOf(d, "board_audit"), "amber");
});

// ── 8. Edge cases — must not throw, must keep success:true ───────────
test("negative pledging (treated as 'no pledging' branch) does not throw", async () => {
  // pledgedPercent <= 0 falls into the green 'No promoter pledging' branch.
  const r = await run({
    promoterPledging: { pledgedPercent: -5, promoterHolding: 55 },
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.equal(severityOf(d, "promoter_pledging"), "green");
});

test("short / malformed share-count history is ignored, no dilution flag", async () => {
  const r = await run({
    // single-element history (< 2) → no dilution computation
    promoterHolding: { current: 40, shareCountHistory: [100] },
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  assert.equal(hasCategory(d, "equity_dilution"), false);
});

test("string-encoded numerics + missing optional fields are coerced/ignored", async () => {
  const r = await run({
    // numbers arriving as strings (e.g. from scraped sources) must coerce
    promoterPledging: { pledgedPercent: "45" },
    shareholding: {
      promoter: { change: "-1.5" },
      // fii/dii absent → no institutional flow flag
    },
  });
  assert.equal(r.success, true);
  const d = asData(r);
  assert.equal(d.available, true);
  // "45" → >30 amber pledging
  assert.equal(severityOf(d, "promoter_pledging"), "amber");
  // "-1.5" → stake fell QoQ, amber trend
  assert.equal(severityOf(d, "promoter_trend"), "amber");
  // no fii/dii → no institutional_flow flag
  assert.equal(hasCategory(d, "institutional_flow"), false);
  assert.ok(Number.isFinite(d.governanceScore));
});

test("zero / empty-object inputs do not throw and score stays bounded", async () => {
  const r = await run({
    promoterPledging: {},
    promoterHolding: {},
    shareholding: {},
    relatedParty: {},
  });
  assert.equal(r.success, true);
  const d = asData(r);
  // empty objects ARE records, so they count as supplied inputs → available:true
  assert.equal(d.available, true);
  assert.ok(d.governanceScore >= 0 && d.governanceScore <= 100);
  // relatedParty present but empty → defaults to clean green
  assert.equal(severityOf(d, "related_party"), "green");
});
