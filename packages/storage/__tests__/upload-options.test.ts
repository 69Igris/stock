/**
 * CONTRACT TEST — MONEY-1169. The two upload options that caused three months
 * of silent object corruption must never regress.
 *
 * History, so the assertions read as more than pedantry:
 *
 * - `resumable: false` forced every write onto the multipart wire format,
 *   which the workers image corrupts (node-fetch major-version overlay under
 *   the SDK's transport). It guarded against a v5-era configstore bug that
 *   storage v7 does not have.
 * - `validation: false` silenced the CRC32C check that was CORRECTLY failing
 *   with "the uploaded data did not match the data from the server" — that
 *   message was this corruption being detected at write time, misread as
 *   spurious.
 *
 * These tests pin the PURE option builder rather than mocking GCS, because
 * this bug taught us exactly how little a mocked upload proves: every local
 * probe of the broken path passed. The real proof of the write path lives in
 * Cloud Run; what a unit test CAN hold is "nobody quietly reintroduces the
 * two poison options".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildStreamOptions } from "../src/index";

describe("buildStreamOptions — the MONEY-1169 contract", () => {
  const opts = buildStreamOptions("text/csv", "private, max-age=3600", {
    contentType: "text/csv",
    uploadedBy: "user_1",
  });

  it("stays on the resumable path — no multipart body exists to mis-frame", () => {
    assert.equal(opts.resumable, true);
  });

  it("never disables CRC32C validation — corruption must THROW, not store", () => {
    assert.equal(
      "validation" in opts,
      false,
      "validation must be OMITTED so the SDK default (crc32c) applies; " +
        "passing validation:false re-silences the exact alarm that caught " +
        "the MONEY-1169 corruption",
    );
  });

  it("carries contentType and cacheControl the way the writer intends", () => {
    assert.equal(opts.contentType, "text/csv");
    assert.equal(opts.metadata.cacheControl, "private, max-age=3600");
    assert.equal(opts.metadata.uploadedBy, "user_1");
  });
});
