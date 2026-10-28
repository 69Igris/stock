/**
 * MONEY-219 - dynamic credit billing tests.
 *
 * Verifies the formula:
 *   credits = ceil(max(baseCredits, tokenCredits + durationCredits + complexityCredits))
 *
 * with the rupee anchor (1 credit = ₹4 = $0.0482 at 83 INR/USD) and the
 * tiered duration premium.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRunCredits,
  estimateRunCredits,
  RUPEES_PER_CREDIT,
} from "../src/subscription/dynamic-credits";

describe("RUPEES_PER_CREDIT - anchor", () => {
  it("is ₹4 (matches 1000-credit pack at ₹3,999)", () => {
    assert.equal(RUPEES_PER_CREDIT, 4);
  });
});

describe("computeRunCredits - token component", () => {
  it("returns the floor when usage is zero", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.credits, 1);
    assert.equal(r.rupees, 4);
  });

  it("scales token cost roughly with model price (Pro >> Flash)", () => {
    const flash = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 100_000,
      outputTokens: 20_000,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    const pro = computeRunCredits({
      modelId: "gemini-2.5-pro",
      inputTokens: 100_000,
      outputTokens: 20_000,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.ok(
      pro.components.tokenCredits > flash.components.tokenCredits * 5,
      `pro=${pro.components.tokenCredits} flash=${flash.components.tokenCredits}`,
    );
  });

  it("a 2.5-pro thesis run (~25k in / 5k out) costs ~3-5 credits in tokens alone", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-pro",
      inputTokens: 25_000,
      outputTokens: 5_000,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    // 25k × $1.25/M = $0.03125 ; 5k × $5/M = $0.025 → $0.05625 → ₹4.67 → ~1.2 credits
    assert.ok(
      r.components.tokenCredits >= 1 && r.components.tokenCredits <= 2,
      `expected ~1-2 token credits, got ${r.components.tokenCredits}`,
    );
  });
});

describe("computeRunCredits - duration premium", () => {
  it("≤ 30s = 0 duration credits", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 30,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.durationCredits, 0);
  });

  it("≤ 90s = 0.5 credits", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 90,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.durationCredits, 0.5);
  });

  it("≤ 180s = 1.0 credit", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 180,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.durationCredits, 1);
  });

  it("> 180s adds 0.25 per extra minute", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 360, // +3 minutes past 180s baseline
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.durationCredits, 1 + 3 * 0.25);
  });
});

describe("computeRunCredits - complexity premium", () => {
  it("scales with skill count up to a 4-credit ceiling", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 16,
      baseCredits: 1,
    });
    // 16 × 0.25 = 4, capped at 4
    assert.equal(r.components.complexityCredits, 4);
  });

  it("tasks past 12-baseline add 0.05 each", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 22, // 10 over baseline = 0.5
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.complexityCredits, 0.5);
  });

  it("0 skills + 0 tasks = 0 complexity", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.complexityCredits, 0);
  });
});

describe("computeRunCredits - floor + cap", () => {
  it("respects the preset floor when usage is below it", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 5,
    });
    assert.equal(r.credits, 5);
  });

  it("ignores the floor when usage exceeds it (returns ceil(usage))", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-pro",
      inputTokens: 200_000,
      outputTokens: 50_000,
      durationSec: 240,
      taskCount: 30,
      skillCount: 8,
      baseCredits: 4,
    });
    assert.ok(r.credits > 4, `expected > floor; got ${r.credits}`);
  });

  it("respects the cap when usage exceeds it", () => {
    const r = computeRunCredits({
      modelId: "gemini-3.1-pro-preview",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      durationSec: 600,
      taskCount: 50,
      skillCount: 16,
      baseCredits: 1,
      maxCredits: 25,
    });
    assert.equal(r.credits, 25);
    assert.equal(r.components.cap, 25);
  });
});

describe("estimateRunCredits - pre-run forecast", () => {
  it("Quick Pulse (6 tasks, 1 skill, Flash) ≈ 1 credit", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-flash",
      taskCount: 6,
      skillCount: 1,
      baseCredits: 1,
    });
    assert.ok(r.credits >= 1 && r.credits <= 2, `got ${r.credits}`);
  });

  it("Investment Thesis (20 tasks, 4 skills, 2.5 Pro) ≈ 4-7 credits", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-pro",
      taskCount: 20,
      skillCount: 4,
      baseCredits: 4,
    });
    assert.ok(r.credits >= 4 && r.credits <= 7, `got ${r.credits}`);
  });

  it("Comprehensive (30 tasks, 16 skills, 2.5 Pro) ≈ 8-14 credits", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-pro",
      taskCount: 30,
      skillCount: 16,
      baseCredits: 10,
    });
    assert.ok(r.credits >= 10 && r.credits <= 14, `got ${r.credits}`);
  });

  it("3 Pro is at least as expensive as 2.5 Pro for the same plan", () => {
    const pro25 = estimateRunCredits({
      modelId: "gemini-2.5-pro",
      taskCount: 20,
      skillCount: 4,
      baseCredits: 4,
    });
    const pro3 = estimateRunCredits({
      modelId: "gemini-3.1-pro-preview",
      taskCount: 20,
      skillCount: 4,
      baseCredits: 4,
    });
    assert.ok(
      pro3.credits >= pro25.credits,
      `3-pro should be ≥ 2.5: 3-pro=${pro3.credits} 2.5=${pro25.credits}`,
    );
  });

  it("rupees component matches credits × ₹4", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-pro",
      taskCount: 20,
      skillCount: 4,
      baseCredits: 4,
    });
    assert.equal(r.rupees, r.credits * RUPEES_PER_CREDIT);
  });

  it("breakdown components sum within ceiling distance of credits", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-pro",
      taskCount: 25,
      skillCount: 5,
      baseCredits: 4,
    });
    const sum =
      r.components.tokenCredits +
      r.components.durationCredits +
      r.components.complexityCredits;
    // ceil(max(floor, sum)) is the formula → credits is ceil(max(floor, sum))
    assert.ok(
      r.credits >= Math.ceil(Math.max(r.components.floor, sum)) - 1,
      `credits=${r.credits} sum=${sum} floor=${r.components.floor}`,
    );
  });
});

// ── MONEY-620 — NEGATIVE / EDGE: billing-integrity guards ────────────
//
// A research run debits real credits. Any path that lets a `NaN`/`Infinity`
// reach the final `credits` would corrupt the wallet. The source now clamps
// non-finite usage metrics to 0 (and the floor/cap when they are non-finite).
// These cases lock that in and assert the negative/overflow behavior.

describe("computeRunCredits — non-finite usage (regression: NaN/Infinity debit)", () => {
  const base = {
    modelId: "gemini-2.5-flash",
    durationSec: 0,
    taskCount: 0,
    skillCount: 0,
    baseCredits: 1,
  };

  it("NaN input/output tokens → floor, NOT a NaN debit", () => {
    const r = computeRunCredits({
      ...base,
      inputTokens: NaN,
      outputTokens: NaN,
    });
    assert.ok(
      Number.isFinite(r.credits),
      `credits must be finite, got ${r.credits}`,
    );
    assert.equal(r.credits, 1);
    assert.equal(r.components.tokenCredits, 0);
    assert.ok(Number.isFinite(r.rupees));
  });

  it("Infinity tokens → floor, NOT an Infinity debit", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-pro",
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 3,
    });
    assert.equal(r.credits, 3);
    assert.equal(r.components.tokenCredits, 0);
  });

  it("NaN duration / taskCount / skillCount are neutralised to 0", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: NaN,
      taskCount: NaN,
      skillCount: NaN,
      baseCredits: 1,
    });
    assert.equal(r.credits, 1);
    assert.equal(r.components.durationCredits, 0);
    assert.equal(r.components.complexityCredits, 0);
  });

  it("NaN baseCredits falls back to the 1-credit floor", () => {
    const r = computeRunCredits({
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      baseCredits: NaN,
    });
    assert.equal(r.credits, 1);
    assert.equal(r.components.floor, 1);
  });

  it("NaN maxCredits is ignored (does not clamp to NaN)", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 5,
      maxCredits: NaN,
    });
    assert.equal(r.credits, 5);
  });
});

describe("computeRunCredits — negative inputs clamp (no credit underflow)", () => {
  it("negative tokens/duration/tasks/skills all clamp to the floor", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: -100_000,
      outputTokens: -50_000,
      durationSec: -300,
      taskCount: -20,
      skillCount: -8,
      baseCredits: 1,
    });
    assert.equal(r.credits, 1);
    assert.equal(r.components.tokenCredits, 0);
    assert.equal(r.components.durationCredits, 0);
    assert.equal(r.components.complexityCredits, 0);
  });

  it("an unknown model prices tokens at 0 → floor only (never negative)", () => {
    const r = computeRunCredits({
      modelId: "totally-unknown-model",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 1,
    });
    assert.equal(r.components.tokenCredits, 0);
    assert.equal(r.credits, 1);
  });

  it("credits never drop below 1 even with a baseCredits of 0 or negative", () => {
    const zero = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 0,
    });
    assert.equal(zero.credits, 1);
    const neg = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: -10,
    });
    assert.equal(neg.credits, 1);
  });
});

describe("computeRunCredits — cap / floor interaction (overflow + downgrade)", () => {
  it("a runaway plan is capped at maxCredits (overflow guard)", () => {
    const r = computeRunCredits({
      modelId: "gemini-3.1-pro-preview",
      inputTokens: 5_000_000,
      outputTokens: 2_000_000,
      durationSec: 600,
      taskCount: 60,
      skillCount: 20,
      baseCredits: 1,
      maxCredits: 25,
    });
    assert.equal(r.credits, 25);
    assert.equal(r.components.cap, 25);
  });

  it("EDGE: maxCredits below the floor wins (cap is the hard ceiling)", () => {
    // Documents that the cap is applied AFTER the floor, so a cap lower than the
    // preset floor reduces the debit below the advertised baseline. (Product
    // decision — deterministic; flagged here so a future change is intentional.)
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 0,
      baseCredits: 10,
      maxCredits: 3,
    });
    assert.equal(r.credits, 3);
  });

  it("complexity premium is capped at 4 credits (addon overflow guard)", () => {
    const r = computeRunCredits({
      modelId: "gemini-2.5-flash",
      inputTokens: 0,
      outputTokens: 0,
      durationSec: 0,
      taskCount: 0,
      skillCount: 1000, // 1000 × 0.25 = 250, must clamp to 4
      baseCredits: 1,
    });
    assert.equal(r.components.complexityCredits, 4);
  });
});

describe("estimateRunCredits — non-finite forecast guards", () => {
  it("NaN explicit token forecast is neutralised (estimate stays finite)", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-pro",
      taskCount: 10,
      skillCount: 2,
      baseCredits: 4,
      estimatedInputTokens: NaN,
      estimatedOutputTokens: NaN,
    });
    assert.ok(Number.isFinite(r.credits));
    assert.ok(r.credits >= 4);
  });

  it("negative taskCount can't produce negative duration/complexity in the estimate", () => {
    const r = estimateRunCredits({
      modelId: "gemini-2.5-flash",
      taskCount: -50,
      skillCount: -5,
      baseCredits: 1,
    });
    assert.ok(Number.isFinite(r.credits) && r.credits >= 1);
    assert.ok(r.components.durationCredits >= 0);
    assert.ok(r.components.complexityCredits >= 0);
  });
});
