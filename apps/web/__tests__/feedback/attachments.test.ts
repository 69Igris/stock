/**
 * Feedback attachment rules — MONEY-764 (upload + store workflow).
 *
 * `validateFeedbackImage` is shared by the upload server action AND the
 * composer's client-side pre-check, so one contract gates both ends.
 * `filterOwnedImagePaths` is the IDOR guard: submit/reply accept
 * caller-supplied GCS paths and the thread view MINTS SIGNED URLS for
 * whatever persisted — a forged path (another user's upload, learning
 * content, traversal) must never reach the DB.
 *
 * Source: apps/web/lib/feedback/attachments.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFeedbackImage,
  filterOwnedImagePaths,
  feedbackImagePath,
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_MAX_IMAGES,
} from "@/lib/feedback/attachments";

describe("validateFeedbackImage", () => {
  it("accepts png/jpeg/webp within the size cap, mapping extensions", () => {
    assert.deepEqual(validateFeedbackImage({ type: "image/png", size: 1024 }), {
      ok: true,
      ext: "png",
    });
    assert.deepEqual(
      validateFeedbackImage({ type: "image/jpeg", size: 1024 }),
      { ok: true, ext: "jpg" }
    );
    assert.deepEqual(
      validateFeedbackImage({
        type: "image/webp",
        size: FEEDBACK_IMAGE_MAX_BYTES,
      }),
      { ok: true, ext: "webp" }
    );
  });

  it("rejects unsupported types (svg/gif/pdf/empty)", () => {
    for (const type of ["image/svg+xml", "image/gif", "application/pdf", ""]) {
      const res = validateFeedbackImage({ type, size: 1024 });
      assert.equal(res.ok, false, type);
    }
  });

  it("rejects oversized and degenerate sizes", () => {
    assert.equal(
      validateFeedbackImage({
        type: "image/png",
        size: FEEDBACK_IMAGE_MAX_BYTES + 1,
      }).ok,
      false
    );
    assert.equal(
      validateFeedbackImage({ type: "image/png", size: 0 }).ok,
      false
    );
    assert.equal(
      validateFeedbackImage({ type: "image/png", size: Number.NaN }).ok,
      false
    );
  });
});

describe("feedbackImagePath", () => {
  it("lays out under the owner's feedback prefix", () => {
    assert.equal(
      feedbackImagePath("u1", "png", "uuid-1"),
      "feedback/u1/uuid-1.png"
    );
  });
});

describe("filterOwnedImagePaths (IDOR guard)", () => {
  const me = "user_me";
  const mine = (n: string) => `feedback/${me}/${n}.png`;

  it("keeps only the caller's own feedback uploads", () => {
    assert.deepEqual(
      filterOwnedImagePaths(
        [
          mine("a"),
          "feedback/user_other/stolen.png", // someone else's upload
          "learning/course-1/lesson.mp4", // arbitrary bucket object
          "stocks/RELIANCE/annual/2025.pdf",
          mine("b"),
        ],
        me
      ),
      [mine("a"), mine("b")]
    );
  });

  it("drops traversal and oversized paths inside the owned prefix", () => {
    assert.deepEqual(
      filterOwnedImagePaths(
        [
          `feedback/${me}/../user_other/x.png`,
          mine("ok"),
          mine("x".repeat(300)),
        ],
        me
      ),
      [mine("ok")]
    );
  });

  it("drops non-strings, dedupes, and caps at the max", () => {
    const paths = [
      42,
      null,
      mine("a"),
      mine("a"), // duplicate
      mine("b"),
      mine("c"),
      mine("d"), // over the cap
    ];
    const out = filterOwnedImagePaths(paths, me);
    assert.deepEqual(out, [mine("a"), mine("b"), mine("c")]);
    assert.equal(out.length, FEEDBACK_MAX_IMAGES);
  });

  it("non-array input / empty userId yield empty (fail closed)", () => {
    assert.deepEqual(filterOwnedImagePaths("feedback/u/x.png", me), []);
    assert.deepEqual(filterOwnedImagePaths(null, me), []);
    assert.deepEqual(filterOwnedImagePaths([mine("a")], ""), []);
  });

  it("an empty-prefix forgery cannot slip through", () => {
    // A path that merely CONTAINS the prefix but doesn't start with it.
    assert.deepEqual(
      filterOwnedImagePaths([`evil/feedback/${me}/x.png`], me),
      []
    );
  });
});
