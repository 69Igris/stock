import { test } from "node:test";
import assert from "node:assert/strict";

import { computePortfolioBetaDriftTool } from "../../../../packages/research/src/tools/compute-portfolio-beta-drift";

// MONEY-543 - compute-portfolio-beta-drift pure-function tests.
// Tool is a PURE compute tool (no network/db/io); all inputs read from params,
// so every case below is fully deterministic.

interface ContributionRow {
  symbol: string;
  value: number;
  weight: number;
  beta: number;
  contribution: number;
}

interface CandidateImpact {
  candidateBeta: number;
  candidateValue: number;
  candidateWeight: number;
  newPortfolioBeta: number;
  betaShift: number;
  newDrift: number;
}

interface BetaDriftData {
  available: boolean;
  reason?: string;
  symbol?: string;
  portfolioBeta: number;
  targetBeta: number;
  drift: number;
  driftLevel: "aligned" | "minor" | "moderate" | "large";
  totalValue: number;
  betaCoverage: number;
  holdingsCount: number;
  contributions: ContributionRow[];
  candidateImpact?: CandidateImpact;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computePortfolioBetaDriftTool.execute(args);
}

const CLOSE = 1e-9;

// ── 1. Happy path: shape + types ───────────────────────────────────────────
test("happy path returns success + available with all key fields typed", async () => {
  const r = await run({
    holdings: [
      { symbol: "RELIANCE", value: 60000, beta: 1.2 },
      { symbol: "TCS", value: 40000, beta: 0.8 },
    ],
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;

  assert.equal(data.available, true);
  assert.equal(typeof data.portfolioBeta, "number");
  assert.equal(typeof data.targetBeta, "number");
  assert.equal(typeof data.drift, "number");
  assert.equal(typeof data.totalValue, "number");
  assert.equal(typeof data.betaCoverage, "number");
  assert.equal(typeof data.holdingsCount, "number");
  assert.ok(
    ["aligned", "minor", "moderate", "large"].includes(data.driftLevel)
  );
  assert.ok(Array.isArray(data.contributions));
  assert.ok(Array.isArray(data.flags));
  // available-path must NOT carry a reason
  assert.equal(data.reason, undefined);
  // every contribution row carries the documented numeric fields
  for (const c of data.contributions) {
    assert.equal(typeof c.symbol, "string");
    assert.equal(typeof c.value, "number");
    assert.equal(typeof c.weight, "number");
    assert.equal(typeof c.beta, "number");
    assert.equal(typeof c.contribution, "number");
  }
});

// ── 2. KNOWN-VALUE numeric assertion ────────────────────────────────────────
test("known-value: 60k@1.2 + 40k@0.8 -> beta 1.04, drift +0.04, aligned", async () => {
  const r = await run({
    holdings: [
      { symbol: "RELIANCE", value: 60000, beta: 1.2 },
      { symbol: "TCS", value: 40000, beta: 0.8 },
    ],
    // targetBeta default 1.0
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;

  assert.equal(data.available, true);
  assert.equal(data.targetBeta, 1.0);
  assert.ok(
    Math.abs(data.portfolioBeta - 1.04) < CLOSE,
    `beta ${data.portfolioBeta}`
  );
  assert.ok(Math.abs(data.drift - 0.04) < CLOSE, `drift ${data.drift}`);
  assert.equal(data.driftLevel, "aligned");
  assert.equal(data.totalValue, 100000);
  assert.equal(data.betaCoverage, 2);
  assert.equal(data.holdingsCount, 2);

  // Contributions sorted descending by |contribution|: RELIANCE then TCS.
  assert.equal(data.contributions.length, 2);
  const rel = data.contributions.find((c) => c.symbol === "RELIANCE");
  const tcs = data.contributions.find((c) => c.symbol === "TCS");
  assert.ok(rel && tcs);
  assert.ok(Math.abs(rel!.weight - 0.6) < CLOSE, `rel weight ${rel!.weight}`);
  assert.ok(Math.abs(rel!.beta - 1.2) < CLOSE);
  assert.ok(
    Math.abs(rel!.contribution - 0.72) < CLOSE,
    `rel contrib ${rel!.contribution}`
  );
  assert.ok(Math.abs(tcs!.weight - 0.4) < CLOSE, `tcs weight ${tcs!.weight}`);
  assert.ok(Math.abs(tcs!.beta - 0.8) < CLOSE);
  assert.ok(
    Math.abs(tcs!.contribution - 0.32) < CLOSE,
    `tcs contrib ${tcs!.contribution}`
  );

  // Sum of contributions == portfolioBeta (1.04).
  const sum = data.contributions.reduce((s, c) => s + c.contribution, 0);
  assert.ok(Math.abs(sum - 1.04) < CLOSE, `contrib sum ${sum}`);

  // Descending |contribution| ordering: RELIANCE (0.72) first.
  assert.equal(data.contributions[0].symbol, "RELIANCE");
  assert.equal(data.contributions[1].symbol, "TCS");
});

test("known-value: candidate 50k@2.0 -> newBeta 1.36, betaShift +0.32, weight 0.3333", async () => {
  const r = await run({
    holdings: [
      { symbol: "RELIANCE", value: 60000, beta: 1.2 },
      { symbol: "TCS", value: 40000, beta: 0.8 },
    ],
    candidate: { value: 50000, beta: 2.0 },
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;

  assert.ok(data.candidateImpact, "candidateImpact present");
  const ci = data.candidateImpact!;
  assert.ok(Math.abs(ci.candidateBeta - 2.0) < CLOSE);
  assert.equal(ci.candidateValue, 50000);
  // (100000 * 1.04 + 50000 * 2.0) / 150000 = 204000 / 150000 = 1.36
  assert.ok(
    Math.abs(ci.newPortfolioBeta - 1.36) < CLOSE,
    `newBeta ${ci.newPortfolioBeta}`
  );
  // 1.36 - 1.04 = 0.32
  assert.ok(Math.abs(ci.betaShift - 0.32) < CLOSE, `betaShift ${ci.betaShift}`);
  // newDrift = 1.36 - 1.0 = 0.36
  assert.ok(Math.abs(ci.newDrift - 0.36) < CLOSE, `newDrift ${ci.newDrift}`);
  // candidateWeight = 50000 / 150000 = 0.3333 (rounded 4dp)
  assert.ok(
    Math.abs(ci.candidateWeight - 0.3333) < CLOSE,
    `weight ${ci.candidateWeight}`
  );
});

test("respects explicit targetBeta when measuring drift", async () => {
  const r = await run({
    holdings: [
      { symbol: "RELIANCE", value: 60000, beta: 1.2 },
      { symbol: "TCS", value: 40000, beta: 0.8 },
    ],
    targetBeta: 0.5,
  });

  const data = r.data as BetaDriftData;
  assert.equal(data.targetBeta, 0.5);
  // portfolioBeta 1.04 - 0.5 = 0.54 -> "large"
  assert.ok(Math.abs(data.drift - 0.54) < CLOSE, `drift ${data.drift}`);
  assert.equal(data.driftLevel, "large");
});

// ── 3. Graceful degradation (success:true, available:false) ─────────────────
test("degrades: missing holdings -> available false, reason set", async () => {
  const r = await run({ symbol: "infy" });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.equal(data.reason, "no portfolio context");
  // symbol is echoed, normalised upper-case
  assert.equal(data.symbol, "INFY");
});

test("degrades: empty holdings array -> available false", async () => {
  const r = await run({ holdings: [] });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
  assert.deepEqual(data.contributions, []);
});

test("degrades: total holdings value <= 0 -> available false", async () => {
  const r = await run({
    holdings: [
      { symbol: "A", value: 0, beta: 1.1 },
      { symbol: "B", value: -500, beta: 0.9 },
    ],
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
  assert.equal(data.totalValue, 0);
  // holdingsCount still reflects supplied rows
  assert.equal(data.holdingsCount, 2);
});

test("degrades: values present but no usable beta -> available false", async () => {
  const r = await run({
    holdings: [
      { symbol: "A", value: 60000 },
      { symbol: "B", value: 40000, beta: "not-a-number" },
    ],
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
  // total value was computable even though no beta
  assert.equal(data.totalValue, 100000);
  assert.equal(data.betaCoverage, 0);
  assert.equal(data.holdingsCount, 2);
});

// ── 4. Edge cases: must not throw, sensible output ──────────────────────────
test("edge: partial beta coverage weights only the covered slice + flags coverage", async () => {
  const r = await run({
    holdings: [
      { symbol: "COVERED", value: 50000, beta: 1.5 },
      { symbol: "NOBETA", value: 50000 }, // no beta -> excluded from beta weighting
    ],
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, true);
  // Portfolio beta is over the covered slice only -> 1.5 (single covered holding).
  assert.ok(
    Math.abs(data.portfolioBeta - 1.5) < CLOSE,
    `beta ${data.portfolioBeta}`
  );
  assert.equal(data.betaCoverage, 1);
  assert.equal(data.holdingsCount, 2);
  assert.equal(data.totalValue, 100000);
  assert.equal(data.contributions.length, 1);
  // A coverage flag should be emitted since covered < 99% of value.
  assert.ok(
    data.flags.some((f) => f.toLowerCase().includes("coverage")),
    `expected coverage flag, got ${JSON.stringify(data.flags)}`
  );
});

test("edge: string-numeric values + betas are coerced, candidate string coerced", async () => {
  const r = await run({
    holdings: [
      { symbol: "X", value: "60000", beta: "1.2" },
      { symbol: "Y", value: "40000", beta: "0.8" },
    ],
    candidate: { value: "50000", beta: "2.0" },
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, true);
  assert.ok(
    Math.abs(data.portfolioBeta - 1.04) < CLOSE,
    `beta ${data.portfolioBeta}`
  );
  assert.ok(data.candidateImpact);
  assert.ok(Math.abs(data.candidateImpact!.newPortfolioBeta - 1.36) < CLOSE);
});

test("edge: single-holding portfolio with default target -> aligned/large by beta", async () => {
  const r = await run({
    holdings: [{ symbol: "ONLY", value: 100000, beta: 1.0 }],
  });

  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, true);
  assert.ok(Math.abs(data.portfolioBeta - 1.0) < CLOSE);
  assert.ok(Math.abs(data.drift - 0.0) < CLOSE);
  assert.equal(data.driftLevel, "aligned");
  assert.equal(data.contributions.length, 1);
  assert.ok(Math.abs(data.contributions[0].weight - 1.0) < CLOSE);
  assert.ok(Math.abs(data.contributions[0].contribution - 1.0) < CLOSE);
});

test("edge: invalid candidate (zero/negative/NaN) is ignored, no candidateImpact", async () => {
  const zero = (
    await run({
      holdings: [{ symbol: "A", value: 100000, beta: 1.0 }],
      candidate: { value: 0, beta: 2.0 },
    })
  ).data as BetaDriftData;
  assert.equal(zero.available, true);
  assert.equal(zero.candidateImpact, undefined);

  const neg = (
    await run({
      holdings: [{ symbol: "A", value: 100000, beta: 1.0 }],
      candidate: { value: -5000, beta: 2.0 },
    })
  ).data as BetaDriftData;
  assert.equal(neg.candidateImpact, undefined);

  const noBeta = (
    await run({
      holdings: [{ symbol: "A", value: 100000, beta: 1.0 }],
      candidate: { value: 50000 },
    })
  ).data as BetaDriftData;
  assert.equal(noBeta.candidateImpact, undefined);
});

test("edge: malformed / odd inputs must not throw", async () => {
  // holdings not an array -> treated as missing -> graceful degrade
  const notArray = await run({ holdings: "oops" as unknown });
  assert.equal(notArray.success, true);
  assert.equal((notArray.data as BetaDriftData).available, false);

  // holdings with non-object members + missing symbols -> coerced/ignored, no throw
  const messy = await run({
    holdings: [
      { value: 50000, beta: 1.1 }, // missing symbol -> UNKNOWN
      { symbol: "", value: 50000, beta: 0.9 }, // empty symbol -> UNKNOWN
    ],
  });
  assert.equal(messy.success, true);
  const messyData = messy.data as BetaDriftData;
  assert.equal(messyData.available, true);
  // both rows valued + with beta
  assert.equal(messyData.betaCoverage, 2);
  for (const c of messyData.contributions) {
    assert.equal(c.symbol, "UNKNOWN");
  }

  // negative beta is a valid finite number (defensive / inverse-correlated asset)
  const negBeta = await run({
    holdings: [{ symbol: "INV", value: 100000, beta: -0.5 }],
  });
  assert.equal(negBeta.success, true);
  const negData = negBeta.data as BetaDriftData;
  assert.equal(negData.available, true);
  assert.ok(Math.abs(negData.portfolioBeta - -0.5) < CLOSE);
  // drift = -0.5 - 1.0 = -1.5 -> large
  assert.equal(negData.driftLevel, "large");
});

test("edge: no args at all -> graceful degrade, never throws", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as BetaDriftData;
  assert.equal(data.available, false);
  assert.equal(data.reason, "no portfolio context");
  assert.equal(data.targetBeta, 1.0);
});
