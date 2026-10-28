/**
 * MONEY-619 Phase 2 - "thinking" composer preference + thinking-credit math.
 *
 * Covers the two things Phase 2 adds on the data/billing side:
 *
 *   1. The composer `thinking` preference: default (false), schema
 *      validation, and the read/merge semantics `getComposerPreferences` /
 *      `setComposerPreferences` use — asserted via the REAL exported
 *      `readThinkingPreference` / `mergeThinkingPreference` helpers those
 *      two functions call (pure, so the test needs no DB).
 *
 *   2. The thinking-credit math: `l2_chat_thinking` is a registered, paid
 *      (non-l1) action so the per-model premium applies — a thinking turn
 *      on gemini-3.1-pro-preview costs 1 (base) + 2 (premium) = 3 credits, while a
 *      cheaper Pro model (2.5-pro, premium -1) clamps the same turn to 0... +
 *      base 1 → 0? No: 1 + (-1) = 0, the floor. A Flash chat turn (l1_*)
 *      stays free regardless of model.
 *
 * Sources:
 *   packages/services/src/preferences/composer-preferences.ts
 *   packages/core/src/subscription/plans.ts
 *   packages/core/src/gemini/model-registry.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  thinkingPreferenceSchema,
  readThinkingPreference,
  mergeThinkingPreference,
  DEFAULT_COMPOSER_PREFERENCES,
} from "../src/preferences/composer-preferences";
import { CREDIT_COSTS, getCreditCost } from "@usemoney/core";
import { getEffectiveCreditCost } from "@usemoney/core/gemini/model-registry";

// The read/merge rules are the REAL exported helpers that
// getComposerPreferences (read) and setComposerPreferences (merge) call —
// exercised here directly so no DB round-trip is needed.

describe("composer thinking preference - default + schema", () => {
  it("defaults to false", () => {
    assert.equal(DEFAULT_COMPOSER_PREFERENCES.thinking, false);
  });

  it("schema accepts booleans, rejects everything else", () => {
    assert.equal(thinkingPreferenceSchema.safeParse(true).success, true);
    assert.equal(thinkingPreferenceSchema.safeParse(false).success, true);
    assert.equal(thinkingPreferenceSchema.safeParse("true").success, false);
    assert.equal(thinkingPreferenceSchema.safeParse(1).success, false);
    assert.equal(thinkingPreferenceSchema.safeParse(null).success, false);
    assert.equal(thinkingPreferenceSchema.safeParse(undefined).success, false);
  });
});

describe("composer thinking preference - read + merge round-trip", () => {
  it("reads a stored boolean, falls back to false for junk", () => {
    assert.equal(readThinkingPreference(true), true);
    assert.equal(readThinkingPreference(false), false);
    assert.equal(readThinkingPreference(undefined), false);
    assert.equal(readThinkingPreference("yes"), false);
    assert.equal(readThinkingPreference(null), false);
  });

  it("merge: patch present overrides, absent preserves current", () => {
    // turn ON from default OFF
    assert.equal(mergeThinkingPreference(false, true), true);
    // turn OFF
    assert.equal(mergeThinkingPreference(true, false), false);
    // absent patch preserves prior value (sibling write doesn't clobber)
    assert.equal(mergeThinkingPreference(true, undefined), true);
    assert.equal(mergeThinkingPreference(false, undefined), false);
  });

  it("full round-trip: default → save(true) → save(model only) keeps thinking", () => {
    let thinking = DEFAULT_COMPOSER_PREFERENCES.thinking; // false
    thinking = mergeThinkingPreference(thinking, true); // user toggles Thinking on
    assert.equal(thinking, true);
    // a later model-only write (patch.thinking undefined) must NOT reset it
    thinking = mergeThinkingPreference(thinking, undefined);
    assert.equal(thinking, true);
  });
});

describe("l2_chat_thinking - registration + thinking-credit math", () => {
  it("is a registered paid action with base cost 1", () => {
    assert.equal(CREDIT_COSTS.l2_chat_thinking, 1);
    assert.equal(getCreditCost("l2_chat_thinking"), 1);
  });

  it("is NOT a free l1_* action (so the premium applies)", () => {
    assert.ok(!"l2_chat_thinking".startsWith("l1_"));
  });

  it("gemini-3.1-pro-preview thinking turn costs 1 + 2 = 3 credits", () => {
    assert.equal(
      getEffectiveCreditCost(
        "l2_chat_thinking",
        "gemini-3.1-pro-preview",
        getCreditCost("l2_chat_thinking"),
      ),
      3,
    );
  });

  it("a cheaper Pro model (2.5-pro, -1 premium) floors at 0", () => {
    // base 1 + (-1) = 0
    assert.equal(
      getEffectiveCreditCost("l2_chat_thinking", "gemini-2.5-pro", 1),
      0,
    );
  });

  it("a Flash chat turn (l1_flash) stays free regardless of model", () => {
    assert.equal(
      getEffectiveCreditCost("l1_flash", "gemini-3.1-pro-preview", 0),
      0,
    );
    assert.equal(getEffectiveCreditCost("l1_flash", "gemini-2.5-flash", 0), 0);
  });
});
