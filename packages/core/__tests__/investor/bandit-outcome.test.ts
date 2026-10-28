/**
 * Outcome-bandit runtime loop — pure helper checks (MONEY-800, B6).
 *
 * Pins the two PURE helpers the runtime loop hangs on:
 *
 *   1. `variantStyleDirective` — the bounded, SEBI-safe "explanation style"
 *      directive the chat prompt injects for the selected arm. It must be
 *      deterministic, style-ONLY (never a buy/sell/hold directive), and empty
 *      for the default/unknown arm so the prompt is unchanged when there is no
 *      signal yet.
 *   2. `recordVariantOutcome` — the metadata patch the feedback action persists
 *      to record one 👍/👎 outcome against the arm that produced the answer.
 *      Deterministic, merges over existing metadata, and drops cleanly when
 *      there is no arm to attribute.
 *
 * No I/O, no `Math.random`. `recordVariantOutcome` lives in the prisma-backed
 * `bandit-select` module, but the function itself is pure — importing the module
 * does not open a DB connection (Prisma is lazy), mirroring `capture.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPLANATION_VARIANTS,
  DEFAULT_VARIANT_ID,
  variantStyleDirective,
} from "../../src/investor/bandit";
import { recordVariantOutcome } from "../../src/investor/bandit-select";

/** Words that would make a framing directive cross into regulated advice. */
const FORBIDDEN = /\b(buy|sell|hold|recommend|target price|invest in)\b/i;

describe("variantStyleDirective", () => {
  it("is deterministic per arm id", () => {
    for (const v of EXPLANATION_VARIANTS) {
      assert.equal(
        variantStyleDirective(v.id),
        variantStyleDirective(v.id),
        `directive for ${v.id} must be stable`,
      );
    }
  });

  it("returns a non-empty directive for concise + visual framings", () => {
    assert.ok(variantStyleDirective("concise").length > 0);
    assert.ok(variantStyleDirective("visual").length > 0);
  });

  it("returns '' for the default arm and any unknown id (prompt unchanged)", () => {
    assert.equal(variantStyleDirective(DEFAULT_VARIANT_ID), "");
    assert.equal(variantStyleDirective(undefined), "");
    assert.equal(variantStyleDirective("not-a-real-arm"), "");
    assert.equal(variantStyleDirective(""), "");
  });

  it("never emits buy/sell/hold/recommendation language (SEBI)", () => {
    for (const v of EXPLANATION_VARIANTS) {
      assert.equal(
        FORBIDDEN.test(variantStyleDirective(v.id)),
        false,
        `directive for ${v.id} must be style-only`,
      );
    }
  });
});

describe("recordVariantOutcome", () => {
  it("stamps variantId + the binary outcome from the rating", () => {
    assert.deepEqual(recordVariantOutcome("concise", "UP"), {
      variantId: "concise",
      outcome: "UP",
    });
    assert.deepEqual(recordVariantOutcome("detailed", "DOWN"), {
      variantId: "detailed",
      outcome: "DOWN",
    });
  });

  it("is deterministic for the same inputs", () => {
    assert.deepEqual(
      recordVariantOutcome("visual", "UP"),
      recordVariantOutcome("visual", "UP"),
    );
  });

  it("merges over existing metadata without clobbering unrelated keys", () => {
    const out = recordVariantOutcome("concise", "UP", {
      requestId: "abc",
      variantId: "stale",
      outcome: "DOWN",
    });
    assert.deepEqual(out, {
      requestId: "abc",
      variantId: "concise",
      outcome: "UP",
    });
  });

  it("returns undefined when there is no arm to attribute", () => {
    assert.equal(recordVariantOutcome(undefined, "UP"), undefined);
    assert.equal(recordVariantOutcome("", "DOWN"), undefined);
    assert.equal(recordVariantOutcome("   ", "UP"), undefined);
  });

  it("ignores non-object existing metadata rather than throwing", () => {
    assert.deepEqual(recordVariantOutcome("visual", "DOWN", "garbage"), {
      variantId: "visual",
      outcome: "DOWN",
    });
    assert.deepEqual(recordVariantOutcome("visual", "UP", ["a", "b"]), {
      variantId: "visual",
      outcome: "UP",
    });
  });
});
