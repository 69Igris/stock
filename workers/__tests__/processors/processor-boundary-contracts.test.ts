/**
 * UNIT TEST — the processor boundary contracts MONEY-1157 relied on.
 *
 * The MONEY-1157 pass fixed `tsc --noEmit` in `workers/` without changing
 * runtime behaviour. Three of those fixes are only behaviour-preserving BECAUSE
 * of an invariant in a pure helper, and none of those invariants had a test.
 * Each `describe` below pins the one that makes its fix safe, so a later change
 * to the helper cannot silently turn a type-only fix into a behaviour change.
 *
 * Every symbol here is the REAL export the processor calls — no shadows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { needsSymbolDiscovery as newsNeedsDiscovery } from "../../src/processors/news-sync-logic";
import { needsSymbolDiscovery as filingsNeedsDiscovery } from "../../src/processors/filings-sync-logic";
import {
  resolveResearchMode,
  toAgentResearchMode,
} from "../../src/processors/research-logic";
import {
  resolveRoastTimeouts,
  DEFAULT_ROAST_STEP_TIMEOUT_MS,
  DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
} from "../../src/processors/roast-logic";
import { getConfigForMode } from "@usemoney/research/types";

// ══════════════════════════════════════════════════════════════════════
// news-sync / filings-sync: `let symbols = data.symbols` → `?? []`
// ══════════════════════════════════════════════════════════════════════

describe("needsSymbolDiscovery treats undefined and [] identically", () => {
  // Both processors seeded `symbols` from `data.symbols`, which is optional, so
  // `symbols.length` was a possible-undefined read (TS18048). The fix seeds with
  // `data.symbols ?? []`. That is only runtime-identical because discovery fires
  // for `[]` exactly as it fires for `undefined` — if that ever stopped being
  // true, an unspecified payload would skip discovery and the job would
  // silently process ZERO symbols while still logging "Complete".
  //
  // This is the live shape: the scheduler publishes `{}` for BOTH jobs
  // (`news-sync-market-hours` / `filings-sync-weekly` in
  // scripts/ops/setup-scheduler.sh), so auto-discovery is the PRIMARY path.
  for (const [name, fn] of [
    ["news-sync", newsNeedsDiscovery],
    ["filings-sync", filingsNeedsDiscovery],
  ] as const) {
    it(`${name}: undefined ≡ [] — the '?? []' seed cannot change the branch`, () => {
      assert.equal(fn(undefined), true);
      assert.equal(fn([]), true);
      assert.equal(fn(undefined), fn([]));
    });

    it(`${name}: a non-empty list still suppresses discovery`, () => {
      assert.equal(fn(["RELIANCE"]), false);
      assert.equal(fn(["RELIANCE", "TCS"]), false);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// research: worker mode label → the agent's canonical ResearchMode
// ══════════════════════════════════════════════════════════════════════

describe("toAgentResearchMode bridges two genuinely different unions", () => {
  // The worker's `ResearchMode` is "fast" | "deep"; @usemoney/research's is
  // "fast" | "advanced". They are NOT the same type under two names, so the
  // worker cannot simply import the canonical one — hence an explicit,
  // tested boundary instead of a cast.

  it("maps the worker labels onto the agent's union", () => {
    assert.equal(toAgentResearchMode("fast"), "fast");
    assert.equal(toAgentResearchMode("deep"), "advanced");
  });

  it("selects the SAME agent config the un-translated value did", () => {
    // The behaviour-preservation argument, asserted rather than reasoned about:
    // getConfigForMode is `mode === "fast" ? FAST : ADVANCED`, so "deep" and
    // "advanced" pick the same config object. Translating at the boundary
    // therefore cannot change which config the processor derives its timeouts
    // from.
    assert.equal(
      getConfigForMode(toAgentResearchMode("fast")),
      getConfigForMode("fast"),
    );
    assert.equal(
      getConfigForMode(toAgentResearchMode("deep")),
      getConfigForMode("advanced"),
    );
  });

  it("every real payload mode resolves to the mode it was published as", () => {
    // MONEY-1159 — FIXED. This case previously read "every real payload mode
    // still resolves to fast — the known open bug" and pinned exactly that,
    // deliberately, so the divergence stayed visible instead of implied. Its
    // own comment said it should go red and be updated when the runtime fix
    // landed. This is that update.
    //
    // What was wrong: `ResearchJobMessage.mode` is "fast" | "advanced", and the
    // UI style "deep" is mapped to "advanced" BEFORE publish
    // (apps/web/lib/chat/research-style.ts#mapStyleToMode). `resolveResearchMode`
    // recognised only "deep", so every advanced run collapsed to the FAST
    // config — 120s, and a 180s processor hard ceiling — while the agent
    // reconfigured itself to 480s internally and was then killed by the
    // processor's Promise.race at 180s.
    assert.equal(resolveResearchMode(undefined), "fast");
    assert.equal(resolveResearchMode("fast"), "fast");
    assert.equal(resolveResearchMode("advanced"), "deep");
  });

  it("an advanced payload reaches the ADVANCED config, not FAST", () => {
    // The consequence, asserted end-to-end across the boundary. The mapping
    // above is only worth anything because of which config it selects: a
    // regression that reverted `resolveResearchMode` would show up here as
    // advanced research silently getting the 120s budget again.
    assert.equal(
      getConfigForMode(toAgentResearchMode(resolveResearchMode("advanced"))),
      getConfigForMode("advanced"),
    );
    assert.equal(
      getConfigForMode(toAgentResearchMode(resolveResearchMode("fast"))),
      getConfigForMode("fast"),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// roast: process.env → the two keys resolveRoastTimeouts actually reads
// ══════════════════════════════════════════════════════════════════════

describe("resolveRoastTimeouts reads ONLY its two declared keys", () => {
  // `roast.ts` used to pass the whole `process.env`, which tsc rejected
  // (TS2559 — a weak options type sharing no property name with ProcessEnv).
  // The call site now picks the two keys out. That is runtime-identical only if
  // the helper never reads anything else off the object it is handed.

  it("picking the two keys equals passing an env with unrelated extras", () => {
    const picked = resolveRoastTimeouts({
      ROAST_STEP_TIMEOUT_MS: "1000",
      ROAST_TOTAL_TIMEOUT_MS: "2000",
    });
    const withNoise = resolveRoastTimeouts({
      ROAST_STEP_TIMEOUT_MS: "1000",
      ROAST_TOTAL_TIMEOUT_MS: "2000",
      NODE_ENV: "production",
      DATABASE_URL: "mongodb+srv://example",
      TZ: "Asia/Kolkata",
    } as Parameters<typeof resolveRoastTimeouts>[0]);
    assert.deepEqual(picked, withNoise);
  });

  it("an absent key still falls back to the safe default", () => {
    // The picking spreads `undefined` for an unset var, exactly as reading it
    // off process.env did.
    assert.deepEqual(
      resolveRoastTimeouts({
        ROAST_STEP_TIMEOUT_MS: undefined,
        ROAST_TOTAL_TIMEOUT_MS: undefined,
      }),
      {
        stepTimeoutMs: DEFAULT_ROAST_STEP_TIMEOUT_MS,
        totalTimeoutMs: DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
      },
    );
    assert.deepEqual(resolveRoastTimeouts({}), {
      stepTimeoutMs: DEFAULT_ROAST_STEP_TIMEOUT_MS,
      totalTimeoutMs: DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
    });
  });

  it("keeps the MONEY-620 NaN guard intact through the picked object", () => {
    // A misconfigured value must never reach the agent's setTimeout as NaN/0
    // (it would fire immediately and every roast would instantly "time out").
    assert.deepEqual(
      resolveRoastTimeouts({
        ROAST_STEP_TIMEOUT_MS: "abc",
        ROAST_TOTAL_TIMEOUT_MS: "0",
      }),
      {
        stepTimeoutMs: DEFAULT_ROAST_STEP_TIMEOUT_MS,
        totalTimeoutMs: DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
      },
    );
  });
});
