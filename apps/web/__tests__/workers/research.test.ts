/**
 * Research Processor Tests (workers/src/processors/research.ts) — DE-SHADOWED.
 *
 * Previously this file re-declared inline copies of `parseEnvInt`, the mode
 * defaulting, `getConfigForMode` (+ FAST_CONFIG / DEEP_CONFIG), `buildAnalysisLink`
 * and a whole `processResearch`, and asserted the copies. That was a SHADOW —
 * and it had DRIFTED: the inline `buildAnalysisLink` produced
 * `/analysis?sessionId=X&symbol=Y`, but the REAL processor links to
 * `/analysis/{sessionId}` (path, no symbol). A green shadow was "verifying" a
 * link format the app never emits.
 *
 * The pure helpers now live in `workers/src/processors/research-logic.ts` and the
 * processor imports + CALLS them; the mode config is the REAL `getConfigForMode`
 * from @usemoney/research. This test asserts those real units.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). research.ts CALLS these.
import {
  resolveResearchMode,
  toAgentResearchMode,
  parseEnvInt,
  computeResearchHardCeiling,
  shouldNotifyResearch,
  buildResearchCompleteNotification,
  RESEARCH_HARD_CEILING_MS,
  RESEARCH_CEILING_BUFFER_MS,
  type ResearchNotification,
} from "../../../../workers/src/processors/research-logic";
// REAL mode config the processor uses.
import { getConfigForMode } from "@usemoney/research";

// ══════════════════════════════════════════════════════════════════════
// resolveResearchMode (real export)
// ══════════════════════════════════════════════════════════════════════

describe("resolveResearchMode (real export)", () => {
  it("defaults to fast", () => {
    assert.strictEqual(resolveResearchMode(undefined), "fast");
    assert.strictEqual(resolveResearchMode(""), "fast");
  });

  it("returns deep for 'advanced' — the value publishers actually emit", () => {
    // MONEY-1159. THE regression. `mapStyleToMode` converts the UI style to
    // "advanced" before publishing, and nothing in the repo has ever published
    // "deep" — so this case falling through to "fast" meant every advanced run
    // got FAST_AGENT_CONFIG (120s), a 180s processor ceiling, and was killed at
    // a quarter of its budget while looking like an ordinary timeout.
    //
    // This suite had no case for "advanced" at all, which is why nothing caught
    // it: the absent assertion was the bug, not a wrong one.
    assert.strictEqual(resolveResearchMode("advanced"), "deep");
  });

  it("still returns deep for the legacy 'deep' label", () => {
    // Kept accepted so a message already in the subscription when this deploys
    // resolves to the mode it was published for.
    assert.strictEqual(resolveResearchMode("deep"), "deep");
  });

  it("treats any other value as fast", () => {
    assert.strictEqual(resolveResearchMode("weird"), "fast");
  });
});

// ══════════════════════════════════════════════════════════════════════
// MONEY-1159: the published mode must reach a ceiling that fits the agent
// ══════════════════════════════════════════════════════════════════════

describe("an advanced job gets a ceiling that does not undercut the agent", () => {
  // Asserting `resolveResearchMode("advanced") === "deep"` alone would not have
  // caught this bug's damage — the mapping is only interesting because of what
  // it feeds. This walks the REAL chain the processor walks, so a regression
  // anywhere along it fails here rather than showing up in prod as a timeout.
  it("advanced → 480s budget → 540s ceiling, not 180s", () => {
    const mode = resolveResearchMode("advanced");
    const agentMode = toAgentResearchMode(mode);
    const config = getConfigForMode(agentMode);
    const ceiling = computeResearchHardCeiling(config.totalTimeoutMs);

    assert.strictEqual(agentMode, "advanced");
    assert.strictEqual(config.totalTimeoutMs, 480_000);
    assert.strictEqual(ceiling, 540_000);

    // The precise failure. The agent reconfigures itself to 480s at run() time,
    // so a 180s processor ceiling made that reconfiguration meaningless: the
    // Promise.race killed the run before the agent could use its own budget.
    assert.ok(
      ceiling > config.totalTimeoutMs,
      "the processor ceiling must exceed the agent's own budget, or the " +
        "agent's config is decorative"
    );
    assert.notStrictEqual(
      ceiling,
      180_000,
      "180s is the FAST-config ceiling — an advanced job landing here means " +
        "the mode fell through to fast again (MONEY-1159)"
    );
  });

  it("a fast job still gets the fast budget — the fix is not a blanket raise", () => {
    // Guards the other direction: raising everything to 540s would waste
    // worker capacity on quick jobs and hide genuinely stuck fast runs.
    const config = getConfigForMode(
      toAgentResearchMode(resolveResearchMode("fast"))
    );
    assert.strictEqual(config.totalTimeoutMs, 120_000);
    assert.strictEqual(
      computeResearchHardCeiling(config.totalTimeoutMs),
      180_000
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// getConfigForMode (REAL @usemoney/research export)
// ══════════════════════════════════════════════════════════════════════

describe("getConfigForMode (real @usemoney/research export)", () => {
  it("returns a fast config with skipValidation enabled and a finite timeout", () => {
    const cfg = getConfigForMode("fast");
    assert.strictEqual(cfg.skipValidation, true);
    assert.ok(cfg.maxSteps > 0);
    assert.ok(cfg.totalTimeoutMs > 0);
  });

  it("returns a longer-running, validated config for the advanced mode", () => {
    const fast = getConfigForMode("fast");
    const advanced = getConfigForMode("advanced");
    // Advanced does not skip validation (the key is absent → falsy).
    assert.ok(!advanced.skipValidation);
    // Advanced gets a strictly larger total time budget than fast.
    assert.ok(advanced.totalTimeoutMs > fast.totalTimeoutMs);
  });
});

// ══════════════════════════════════════════════════════════════════════
// parseEnvInt (real export)
// ══════════════════════════════════════════════════════════════════════

describe("parseEnvInt (real export)", () => {
  it("returns the fallback when the key is absent", () => {
    assert.strictEqual(parseEnvInt("MISSING", 42, {}), 42);
  });

  it("parses a numeric env value", () => {
    assert.strictEqual(parseEnvInt("K", 42, { K: "100" }), 100);
  });

  it("returns the fallback for a non-numeric env value (NaN guard)", () => {
    assert.strictEqual(parseEnvInt("K", 42, { K: "abc" }), 42);
  });

  it("returns the fallback for an empty env value", () => {
    assert.strictEqual(parseEnvInt("K", 42, { K: "" }), 42);
  });
});

// ══════════════════════════════════════════════════════════════════════
// computeResearchHardCeiling (real export)
// ══════════════════════════════════════════════════════════════════════

describe("computeResearchHardCeiling (real export)", () => {
  it("adds the buffer to a normal total timeout", () => {
    assert.strictEqual(
      computeResearchHardCeiling(120_000),
      120_000 + RESEARCH_CEILING_BUFFER_MS
    );
  });

  it("caps at RESEARCH_HARD_CEILING_MS (540s)", () => {
    assert.strictEqual(RESEARCH_HARD_CEILING_MS, 540_000);
    assert.strictEqual(computeResearchHardCeiling(600_000), 540_000);
  });

  it("collapses a non-finite total to the ceiling", () => {
    assert.strictEqual(computeResearchHardCeiling(Number.NaN), 540_000);
    assert.strictEqual(
      computeResearchHardCeiling(Number.POSITIVE_INFINITY),
      540_000
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldNotifyResearch (real export)
// ══════════════════════════════════════════════════════════════════════

describe("shouldNotifyResearch (real export)", () => {
  it("is true for a non-empty userId", () => {
    assert.strictEqual(shouldNotifyResearch("user-1"), true);
  });

  it("is false for empty / null / undefined", () => {
    assert.strictEqual(shouldNotifyResearch(""), false);
    assert.strictEqual(shouldNotifyResearch(null), false);
    assert.strictEqual(shouldNotifyResearch(undefined), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildResearchCompleteNotification (real export) — fixes the drifted link
// ══════════════════════════════════════════════════════════════════════

describe("buildResearchCompleteNotification (real export)", () => {
  it("links to the REAL path /analysis/{sessionId} (not a query string)", () => {
    const n: ResearchNotification = buildResearchCompleteNotification(
      "u",
      "ses-9",
      "TCS outlook"
    );
    assert.strictEqual(n.metadata.link, "/analysis/ses-9");
    // The drifted shadow used `/analysis?sessionId=...&symbol=...`; assert not.
    assert.ok(!n.metadata.link.includes("?"));
    assert.ok(!n.metadata.link.includes("symbol="));
  });

  it("builds the completion payload with the query in the message", () => {
    const n = buildResearchCompleteNotification("user-42", "s-1", "Reliance");
    assert.strictEqual(n.userId, "user-42");
    assert.strictEqual(n.type, "RESEARCH_COMPLETE");
    assert.strictEqual(n.title, "Research Complete");
    assert.strictEqual(n.message, 'Research on "Reliance" is ready to view.');
    assert.strictEqual(n.metadata.sessionId, "s-1");
  });
});
