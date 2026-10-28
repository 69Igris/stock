/**
 * Result-feedback validation tests (MONEY-587).
 *
 * Imports the REAL SubmitResultFeedbackSchema from the @usemoney/validation
 * barrel (de-shadowed). The schema is pure zod so the production symbol is
 * exercised directly — if the source contract changes (e.g. the
 * whitespace-collapse transform or a max-length), these assertions break.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubmitResultFeedbackSchema } from "@usemoney/validation";

describe("SubmitResultFeedbackSchema (MONEY-587)", () => {
  it("accepts a minimal valid up-vote", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "msg-1",
      rating: "UP",
    });
    assert.equal(r.success, true);
  });

  it("rejects an unknown surface", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "EMAIL",
      refId: "x",
      rating: "UP",
    });
    assert.equal(r.success, false);
  });

  it("rejects an empty refId", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "",
      rating: "DOWN",
    });
    assert.equal(r.success, false);
  });

  it("rejects an unknown rating", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "x",
      rating: "MEH",
    });
    assert.equal(r.success, false);
  });

  it("collapses a whitespace-only comment to undefined", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "ROAST",
      refId: "r1",
      rating: "DOWN",
      comment: "   ",
    });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.comment, undefined);
  });

  it("trims a real comment", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "RESEARCH",
      refId: "s1",
      rating: "DOWN",
      comment: "  inaccurate numbers  ",
    });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.comment, "inaccurate numbers");
  });

  it("rejects a comment over 1000 chars", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "x",
      rating: "DOWN",
      comment: "a".repeat(1001),
    });
    assert.equal(r.success, false);
  });

  it("rejects more than 8 reasons", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "x",
      rating: "DOWN",
      reasons: Array(9).fill("r"),
    });
    assert.equal(r.success, false);
  });

  it("carries the model/tier/intent/symbols provenance snapshot", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "x",
      rating: "UP",
      model: "gemini-2.5-pro",
      tier: "L3",
      intent: "deep_research",
      symbols: ["INFY", "TCS"],
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.model, "gemini-2.5-pro");
      assert.deepEqual(r.data.symbols, ["INFY", "TCS"]);
    }
  });

  it("rejects more than 24 symbols", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      surface: "CHAT",
      refId: "x",
      rating: "UP",
      symbols: Array(25).fill("SYM"),
    });
    assert.equal(r.success, false);
  });
});
