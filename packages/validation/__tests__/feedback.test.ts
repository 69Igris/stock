/**
 * Negative / edge-case coverage for the REAL exported feedback Zod schemas.
 *
 * Source: packages/validation/src/feedback.ts
 *
 * Imports & exercises the actual schemas (no shadow). Covers the title/
 * description length floors+caps on CreateFeedback, the images array cap, the
 * paginated FeedbackFilter bounds, and the per-result SubmitResultFeedback
 * schema including its whitespace-collapsing `comment` transform.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CreateFeedbackSchema,
  FeedbackFilterSchema,
  AddFeedbackReplySchema,
  SubmitResultFeedbackSchema,
} from "../src/feedback.ts";

describe("CreateFeedbackSchema (real export)", () => {
  const valid = {
    type: "BUG",
    title: "Login button broken",
    description: "The login button does nothing when clicked on mobile.",
  };

  it("accepts a valid feedback payload", () => {
    assert.equal(CreateFeedbackSchema.safeParse(valid).success, true);
  });

  it("rejects an out-of-enum type", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({ ...valid, type: "PRAISE" }).success,
      false,
    );
  });

  it("rejects a title below the 5-char floor", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({ ...valid, title: "hi" }).success,
      false,
    );
  });

  it("rejects a title above the 200-char cap", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({ ...valid, title: "A".repeat(201) })
        .success,
      false,
    );
  });

  it("rejects a description below the 10-char floor", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({ ...valid, description: "short" })
        .success,
      false,
    );
  });

  it("rejects a description above the 2000-char cap", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({
        ...valid,
        description: "A".repeat(2001),
      }).success,
      false,
    );
  });

  it("rejects more than 5 images", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({
        ...valid,
        images: ["a", "b", "c", "d", "e", "f"],
      }).success,
      false,
    );
  });

  it("accepts exactly 5 images (boundary)", () => {
    assert.equal(
      CreateFeedbackSchema.safeParse({
        ...valid,
        images: ["a", "b", "c", "d", "e"],
      }).success,
      true,
    );
  });

  it("rejects a missing required field (description absent)", () => {
    const { description: _omit, ...rest } = valid;
    void _omit;
    assert.equal(CreateFeedbackSchema.safeParse(rest).success, false);
  });
});

describe("FeedbackFilterSchema (real export)", () => {
  it("applies skip/limit defaults", () => {
    const r = FeedbackFilterSchema.safeParse({});
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.skip, 0);
    assert.equal(r.data.limit, 10);
  });

  it("rejects limit above 50", () => {
    assert.equal(FeedbackFilterSchema.safeParse({ limit: 51 }).success, false);
  });

  it("rejects limit below 1", () => {
    assert.equal(FeedbackFilterSchema.safeParse({ limit: 0 }).success, false);
  });

  it("rejects negative skip", () => {
    assert.equal(FeedbackFilterSchema.safeParse({ skip: -1 }).success, false);
  });

  it("rejects an out-of-enum status", () => {
    assert.equal(
      FeedbackFilterSchema.safeParse({ status: "ARCHIVED" }).success,
      false,
    );
  });
});

describe("AddFeedbackReplySchema (real export)", () => {
  it("accepts a valid reply", () => {
    assert.equal(
      AddFeedbackReplySchema.safeParse({
        feedbackId: "fb_1",
        message: "Thanks, looking into it.",
      }).success,
      true,
    );
  });

  it("rejects empty feedbackId", () => {
    assert.equal(
      AddFeedbackReplySchema.safeParse({ feedbackId: "", message: "hi" })
        .success,
      false,
    );
  });

  it("rejects empty message", () => {
    assert.equal(
      AddFeedbackReplySchema.safeParse({ feedbackId: "fb_1", message: "" })
        .success,
      false,
    );
  });

  it("rejects a message above the 2000-char cap", () => {
    assert.equal(
      AddFeedbackReplySchema.safeParse({
        feedbackId: "fb_1",
        message: "A".repeat(2001),
      }).success,
      false,
    );
  });
});

describe("SubmitResultFeedbackSchema (real export)", () => {
  const valid = { surface: "CHAT", refId: "msg_1", rating: "UP" };

  it("accepts a minimal valid rating", () => {
    assert.equal(SubmitResultFeedbackSchema.safeParse(valid).success, true);
  });

  it("rejects an out-of-enum surface", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({ ...valid, surface: "EMAIL" })
        .success,
      false,
    );
  });

  it("rejects an out-of-enum rating", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({ ...valid, rating: "MEH" }).success,
      false,
    );
  });

  it("rejects empty refId", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({ ...valid, refId: "" }).success,
      false,
    );
  });

  it("rejects an oversized refId (> 120 chars)", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({
        ...valid,
        refId: "A".repeat(121),
      }).success,
      false,
    );
  });

  it("rejects a comment above the 1000-char cap", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({
        ...valid,
        comment: "A".repeat(1001),
      }).success,
      false,
    );
  });

  it("collapses a whitespace-only comment to undefined (transform)", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      ...valid,
      comment: "   \n\t ",
    });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.comment, undefined);
  });

  it("trims a non-empty comment (transform)", () => {
    const r = SubmitResultFeedbackSchema.safeParse({
      ...valid,
      comment: "  hallucinated a number  ",
    });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.comment, "hallucinated a number");
  });

  it("rejects more than 8 reasons", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({
        ...valid,
        reasons: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      }).success,
      false,
    );
  });

  it("rejects more than 24 symbols", () => {
    assert.equal(
      SubmitResultFeedbackSchema.safeParse({
        ...valid,
        symbols: Array.from({ length: 25 }, (_v, i) => `S${i}`),
      }).success,
      false,
    );
  });
});
