/**
 * The realtime arm flag — MONEY-1314.
 *
 * Three properties, each of which has already cost this repo a release
 * somewhere else:
 *
 *   - absent must not equal set (MF_METADATA_PROVIDER, MONEY-1214)
 *   - the comparison is to the LITERAL string, never Boolean() — Boolean("false")
 *     is true, which arms the one configuration meant to keep it off
 *   - the mime test is a SUBSTRING, because `application/pdf;charset=UTF-8`
 *     made 1,211 rows unreachable through an exact match (MONEY-1255)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isRealtimeIngestArmed,
  shouldPublishIngest,
  DOC_INGEST_REALTIME_ENV,
} from "../../src/lib/doc-ingest-publish";

const armed = { [DOC_INGEST_REALTIME_ENV]: "true" };

describe("MONEY-1314 — the arm flag", () => {
  it("only the literal string \"true\" arms it", () => {
    assert.equal(isRealtimeIngestArmed({ [DOC_INGEST_REALTIME_ENV]: "true" }), true);
  });

  it("every other value — including \"false\" — leaves it OFF", () => {
    // Boolean("false") is TRUE. A Boolean() cast here would arm the lane in
    // the exact configuration written to keep it disarmed.
    for (const v of ["false", "FALSE", "True", "TRUE", "1", "yes", "", " ", "off"]) {
      assert.equal(
        isRealtimeIngestArmed({ [DOC_INGEST_REALTIME_ENV]: v }),
        false,
        `"${v}" armed the lane`,
      );
    }
  });

  it("ABSENT is off, and is a distinct state from explicitly-false", () => {
    assert.equal(isRealtimeIngestArmed({}), false);
    // Both are off — the point is that a spec must still SET it, so an
    // operator can tell "nobody decided" from "somebody decided no". That is
    // enforced in the cloudbuild specs, not here; this pins the runtime half.
    assert.equal(isRealtimeIngestArmed({ [DOC_INGEST_REALTIME_ENV]: "false" }), false);
  });
});

describe("MONEY-1314 — what gets announced", () => {
  const pdf = { mimeType: "application/pdf", gcsPath: "stocks/X/a.pdf" };

  it("a PDF is announced when armed", () => {
    assert.equal(shouldPublishIngest({ ...pdf, env: armed }), true);
  });

  it("[control] the SAME document is not announced when disarmed", () => {
    // Without this the gate could be returning true unconditionally.
    assert.equal(shouldPublishIngest({ ...pdf, env: {} }), false);
  });

  it("a parameterised content-type still counts as a PDF", () => {
    // MONEY-1255: `application/pdf;charset=UTF-8` is what the raw response
    // header actually stores, and an exact match made 1,211 rows permanently
    // unreachable. That defect must not be rebuilt one lane over.
    for (const m of [
      "application/pdf;charset=UTF-8",
      "application/pdf; charset=utf-8",
      "APPLICATION/PDF",
    ]) {
      assert.equal(
        shouldPublishIngest({ mimeType: m, gcsPath: "x.pdf", env: armed }),
        true,
        `${m} was not recognised as a PDF`,
      );
    }
  });

  it("non-PDFs are NOT announced even when armed", () => {
    // The lane's first act on one is to mark it UNREADABLE, so publishing
    // spends a message and a delivery to write a status the writer knows.
    for (const m of ["text/plain", "application/json", "text/html", null, ""]) {
      assert.equal(
        shouldPublishIngest({ mimeType: m, gcsPath: "x", env: armed }),
        false,
        `${m} was announced`,
      );
    }
  });

  it("a row with no stored object is NOT announced", () => {
    // ~7,234 BSE rows carry gcsPath "" because the attachment is gone
    // upstream. There is nothing to fetch.
    for (const p of ["", "   ", null, undefined]) {
      assert.equal(
        shouldPublishIngest({ mimeType: "application/pdf", gcsPath: p, env: armed }),
        false,
      );
    }
  });
});
