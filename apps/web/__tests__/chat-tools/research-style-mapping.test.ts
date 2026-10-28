import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResearchStyle } from "@usemoney/services/preferences";

/**
 * MONEY-221 - research-style → mode mapping contract.
 *
 * Exercises the REAL `mapStyleToMode` from `@/lib/chat/research-style` — the
 * single definition that `app/api/chat/route.ts` imports and calls. The helper
 * translates the user's saved research preference into the worker-facing `mode`
 * enum (`fast` | `advanced`). Six styles are routed:
 *
 *   - Auto: undefined → keep classifier-driven defaults so we don't override
 *     a user who hasn't expressed an opinion.
 *   - Quick → fast: same single-skill plan, ~30s, 1 credit.
 *   - Deep → advanced: full multi-skill plan (L2, ~17 tasks).
 *   - Comprehensive → advanced: L3 plan with governance + sentiment skills.
 *   - Advanced → advanced: L4 plan with quant + chart-pattern + scenarios.
 *   - Custom → advanced: planner trims to user-pinned skills.
 *
 * This is a tiny pure function but it's a routing-layer choice that decides
 * what every chat-triggered research run looks like. Pinning it stops a
 * future refactor from silently flipping Quick → advanced (paid surprise).
 */

import { mapStyleToMode } from "@/lib/chat/research-style";

describe("mapStyleToMode - research style routing", () => {
  it("maps Quick → fast (1-credit single-skill plan)", () => {
    assert.equal(mapStyleToMode("quick"), "fast");
  });

  it("maps Deep → advanced (full multi-skill plan)", () => {
    assert.equal(mapStyleToMode("deep"), "advanced");
  });

  it("maps Comprehensive (L3) → advanced (richer skill bundle than Deep)", () => {
    assert.equal(mapStyleToMode("comprehensive"), "advanced");
  });

  it("maps Advanced (L4) → advanced (institutional / quant skill bundle)", () => {
    assert.equal(mapStyleToMode("advanced"), "advanced");
  });

  it("maps Custom → advanced (planner trims to user-selected skills later)", () => {
    assert.equal(mapStyleToMode("custom"), "advanced");
  });

  it("maps Auto → undefined (preserves classifier-driven default)", () => {
    assert.equal(mapStyleToMode("auto"), undefined);
  });

  it("maps undefined / null prefs → undefined (Auto behaviour)", () => {
    assert.equal(mapStyleToMode(undefined), undefined);
  });

  it("never returns a value other than fast / advanced / undefined", () => {
    const values = (
      [
        "auto",
        "quick",
        "deep",
        "comprehensive",
        "advanced",
        "custom",
      ] as ResearchStyle[]
    ).map(mapStyleToMode);
    for (const v of values) {
      assert.ok(
        v === "fast" || v === "advanced" || v === undefined,
        `unexpected mode value: ${v}`
      );
    }
  });
});
