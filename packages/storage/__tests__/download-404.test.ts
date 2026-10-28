/**
 * MONEY-979 — a missing BUCKET must never read as a missing OBJECT.
 *
 * `downloadFile` maps `error.code === 404` to `null` and rethrows the rest.
 * `null` is the word its callers act on: the 13F cold-store port
 * (`packages/core/src/us-fundamentals/cold-holdings.ts`) turns it into `absent`
 * — "this quarter is genuinely not archived" — and renders an empty portfolio.
 *
 * GCS answers **404 for a nonexistent bucket too**, with the same `code`. So a
 * misspelled, deleted or rotated `GCP_STORAGE_BUCKET` made every cold read
 * report `absent`: no throw, no `COLD_SHARD_READ_FAILED`, no log line, and a
 * diagnosis (`COLD_SHARD_ABSENT`) that names the object rather than the bucket.
 * Every manager holds nothing, and nothing about it looks wrong. That is
 * MONEY-941 (`listFiles` failing open to `[]`) one layer down, in the same
 * package.
 *
 * ## The measurements this file is built on
 *
 * Against the LIVE API, 2026-08-29:
 *
 *   GET /storage/v1/b/<no-such-bucket>/o/foo?alt=media
 *     -> HTTP 404  "The specified bucket does not exist."
 *   GET /storage/v1/b/gcp-public-data-landsat/o/<no-such-object>?alt=media
 *     -> HTTP 404  "No such object: gcp-public-data-landsat/<no-such-object>"
 *
 * Against `@google-cloud/storage` 7.18 (the installed version), both arrive as
 * an `ApiError` with `code === 404`, `instanceof Error === true` and
 * `"code" in error === true` — every condition the old guard tested. The
 * discriminating text lives in `.message`, which the `catch` discarded.
 *
 * The last case drives the REAL library against a local 404 server rather than
 * trusting the transcription above, because a test that asserts only against
 * constants someone typed cannot notice the library changing its error shape —
 * which is precisely how the guard it protects would silently revert.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Storage } from "@google-cloud/storage";

import { isBucketNotFound } from "../src/index";

/** The shape `@google-cloud/storage` hands back: an Error carrying `code`. */
function apiError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

/** The live plain-text bodies, verbatim. */
const BUCKET_404 = "The specified bucket does not exist.";
const OBJECT_404 =
  "No such object: stockbook-prod/edgar/13f/0001067983/2026-06-30";

describe("isBucketNotFound — 404 is two different answers (MONEY-979)", () => {
  it("recognises the live bucket-not-found body", () => {
    assert.equal(isBucketNotFound(apiError(404, BUCKET_404)), true);
  });

  it("recognises it inside the JSON envelope the SDK puts in `.message`", () => {
    // On the media path the SDK stores the raw response body as the message,
    // so the discriminating phrase arrives wrapped rather than bare.
    const body = JSON.stringify({
      error: {
        code: 404,
        message: BUCKET_404,
        errors: [{ domain: "global", reason: "notFound", message: BUCKET_404 }],
      },
    });
    assert.equal(isBucketNotFound(apiError(404, body)), true);
  });

  it("recognises the XML API's NoSuchBucket spelling", () => {
    assert.equal(
      isBucketNotFound(
        apiError(404, "<Error><Code>NoSuchBucket</Code></Error>"),
      ),
      true,
    );
  });

  it("does NOT fire on a missing OBJECT — that must still return null", () => {
    // The direction that matters for the common case. Treating an ordinary
    // absent object as a configuration failure would turn every un-archived
    // quarter into a thrown error.
    assert.equal(isBucketNotFound(apiError(404, OBJECT_404)), false);
  });

  it("does not fire on a non-404, on a codeless error, or on a non-Error", () => {
    assert.equal(isBucketNotFound(apiError(403, BUCKET_404)), false);
    assert.equal(isBucketNotFound(new Error(BUCKET_404)), false);
    assert.equal(isBucketNotFound(BUCKET_404), false);
    assert.equal(isBucketNotFound(null), false);
    assert.equal(isBucketNotFound(undefined), false);
  });

  it("[premise] the installed SDK really does produce ONE shape for both", async () => {
    // Without this the four cases above are assertions about a string someone
    // transcribed. This asks the library. If `code` ever stops being 404, or
    // the message stops carrying the body, the fix above is inert and this is
    // the only thing that would say so.
    const bodyFor = (message: string): string =>
      JSON.stringify({
        error: {
          code: 404,
          message,
          errors: [{ domain: "global", reason: "notFound", message }],
        },
      });

    let mode = OBJECT_404;
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(bodyFor(mode));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );

    try {
      const { port } = server.address() as AddressInfo;
      const storage = new Storage({
        apiEndpoint: `http://127.0.0.1:${port}`,
        projectId: "probe",
        // A custom endpoint with auth disabled: no credentials, no network.
        useAuthWithCustomEndpoint: false,
        retryOptions: { maxRetries: 0, autoRetry: false },
      });

      const download = async (): Promise<unknown> => {
        try {
          await storage.bucket("probe-bucket").file("probe-object").download();
          return null;
        } catch (err) {
          return err;
        }
      };

      const objectErr = (await download()) as Error & { code?: number };
      assert.ok(objectErr instanceof Error, "the SDK must throw an Error");
      assert.equal(
        objectErr.code,
        404,
        "a missing object no longer surfaces as code 404 — downloadFile's " +
          "whole null-vs-throw split is keyed on that",
      );
      assert.equal(
        isBucketNotFound(objectErr),
        false,
        "a missing OBJECT must keep returning null",
      );

      mode = BUCKET_404;
      const bucketErr = (await download()) as Error & { code?: number };
      assert.equal(
        bucketErr.code,
        404,
        "PREMISE OF THE WHOLE FINDING: a missing bucket is a 404, " +
          "indistinguishable from a missing object by status alone",
      );
      assert.equal(
        isBucketNotFound(bucketErr),
        true,
        "the SDK stopped carrying the response body in `.message`, so the " +
          "only discriminator is gone and downloadFile is silently back to " +
          "reporting a missing bucket as an absent object",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
