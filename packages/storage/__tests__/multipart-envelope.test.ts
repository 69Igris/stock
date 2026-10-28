/**
 * UNIT TEST — MONEY-1169 multipart-envelope detection + repair.
 *
 * The synthetic envelopes here are built to the EXACT wire format observed in
 * the corrupt production objects (verified by hexdump against
 * `feeds/NSE/sec-bhavdata-full/.../sec_bhavdata_full_07082026.csv` and
 * `feeds/NSE/cm-legacy/2006/11/cm14NOV2006bhav.csv.zip`):
 *
 *   --<uuid>\r\nContent-Type: application/json\r\n\r\n{meta}\r\n
 *   --<uuid>\r\nContent-Type: <media>\r\n\r\n<PAYLOAD>\r\n--<uuid>--
 *
 * with NO trailing newline after the finale. Getting the finale exactly right
 * matters: an off-by-two on the closing boundary either leaves `\r\n--uuid--`
 * glued to the payload (corrupting CSV row counts and zip EOCD offsets) or
 * eats the payload's real last bytes.
 *
 * Pure functions, Buffer-only — the ZIP case exists specifically to prove no
 * string round-trip mangles binary payloads.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isMultipartEnvelope,
  stripMultipartEnvelope,
} from "../src/multipart-envelope";

const BOUNDARY = "d027c256-931c-4f0e-99a6-bd37862c443e";

/** Build an envelope byte-identical in shape to the observed corruption. */
function envelope(
  payload: Buffer,
  mediaType: string,
  meta: Record<string, string> = {
    cacheControl: "private, max-age=3600",
    contentType: mediaType,
  },
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n` +
        `${JSON.stringify(meta)}\r\n` +
        `--${BOUNDARY}\r\nContent-Type: ${mediaType}\r\n\r\n`,
      "latin1",
    ),
    payload,
    Buffer.from(`\r\n--${BOUNDARY}--`, "latin1"),
  ]);
}

const CSV = Buffer.from(
  "SYMBOL, SERIES, DATE1, CLOSE_PRICE, DELIV_PER\n" +
    "RELIANCE, EQ, 07-Aug-2026, 2845.61, 45.63",
  "utf-8",
);

// A tiny but REAL binary payload: zip local-file-header magic + bytes that
// include \r\n and `--` sequences, the characters most likely to confuse a
// string-based or scan-based implementation.
const BINARY = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
  Buffer.from("--\r\n--not-a-boundary\r\n\r\n", "latin1"),
  Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x00]),
]);

describe("isMultipartEnvelope", () => {
  it("detects the observed corruption shape", () => {
    assert.equal(isMultipartEnvelope(envelope(CSV, "text/csv")), true);
  });

  it("rejects clean payloads, including hostile look-alikes", () => {
    assert.equal(isMultipartEnvelope(CSV), false);
    assert.equal(isMultipartEnvelope(BINARY), false);
    // Starts with -- and has a CRLF, but no Content-Type at the fixed offset.
    assert.equal(
      isMultipartEnvelope(
        Buffer.from(`--${BOUNDARY}\r\nX-Whatever: yes\r\n\r\nbody`, "latin1"),
      ),
      false,
    );
    // A CSV whose first cell happens to start with dashes.
    assert.equal(
      isMultipartEnvelope(Buffer.from("--adjusted, 1, 2\nrow, 3, 4", "utf-8")),
      false,
    );
    assert.equal(isMultipartEnvelope(Buffer.alloc(0)), false);
  });
});

describe("stripMultipartEnvelope", () => {
  it("returns null for a clean object — the caller must not touch it", () => {
    assert.equal(stripMultipartEnvelope(CSV), null);
    assert.equal(stripMultipartEnvelope(BINARY), null);
  });

  it("recovers a CSV payload byte-exactly, with the intended metadata", () => {
    const out = stripMultipartEnvelope(envelope(CSV, "text/csv"));
    assert.ok(out);
    assert.ok(out.payload.equals(CSV), "payload must be byte-identical");
    assert.equal(out.contentType, "text/csv");
    assert.equal(out.cacheControl, "private, max-age=3600");
    assert.equal(out.layers, 1);
  });

  it("recovers a BINARY payload byte-exactly — CRLFs and dashes inside survive", () => {
    const out = stripMultipartEnvelope(envelope(BINARY, "application/zip"));
    assert.ok(out);
    assert.ok(out.payload.equals(BINARY));
    assert.equal(
      out.payload[0],
      0x50,
      "zip magic must land at offset 0 after repair",
    );
  });

  it("tolerates a truncated write with no closing boundary", () => {
    const full = envelope(CSV, "text/csv");
    const truncated = full.subarray(0, full.length - (BOUNDARY.length + 6));
    const out = stripMultipartEnvelope(truncated);
    assert.ok(out, "a partial payload beats an envelope");
    assert.ok(
      CSV.subarray(0, out.payload.length).equals(out.payload),
      "recovered bytes must be a clean prefix of the payload",
    );
  });

  it("peels a hypothetical double wrap and reports layers", () => {
    const once = envelope(CSV, "text/csv");
    const twice = envelope(once, "text/csv");
    const out = stripMultipartEnvelope(twice);
    assert.ok(out);
    assert.ok(out.payload.equals(CSV));
    assert.equal(out.layers, 2);
  });

  it("survives metadata JSON that fails to parse", () => {
    const bad = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n` +
          `{not json at all\r\n` +
          `--${BOUNDARY}\r\nContent-Type: text/csv\r\n\r\n`,
        "latin1",
      ),
      CSV,
      Buffer.from(`\r\n--${BOUNDARY}--`, "latin1"),
    ]);
    const out = stripMultipartEnvelope(bad);
    assert.ok(out);
    assert.ok(out.payload.equals(CSV));
    assert.equal(out.contentType, "text/csv", "media header still wins");
  });
});
