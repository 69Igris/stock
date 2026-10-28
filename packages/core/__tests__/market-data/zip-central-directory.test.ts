/**
 * A forward scan for the next `PK` signature is a GUESS about where a member's
 * compressed data ends, and it is wrong whenever those four bytes occur inside
 * the data itself. MONEY-1483.
 *
 * ## What these cases actually do
 *
 * They BUILD a zip whose payload contains the data-descriptor signature
 * `PK\x07\x08`, with general-purpose bit 3 set so the local header declares
 * `compressedSize: 0` — the exact shape of
 * `feeds/NSE/fo-legacy/2017/03/fo15MAR2017bhav.csv.zip`, whose real compressed
 * size is 365,837 and whose forward scan returned 300,039 (truncated by 65,798
 * bytes, `inflateRawSync` threw "incomplete or truncated stream"). `unzip -t`
 * reports no errors on that file and its CRC matches: the bytes are perfect and
 * our reader could not read them.
 *
 * So these are not "does the function exist" scans. Each one FAILS against the
 * forward-scan implementation and passes against the central-directory one —
 * `forwardScanSize` below is the OLD algorithm, kept so the test can show the
 * two disagreeing on the same bytes rather than merely asserting the new one.
 *
 * The collision is not a freak: ~5,940 archived NSE legacy files of ~370 KB is
 * ~2.2 GB scanned, where one 4-byte collision is expected. Exactly one was
 * observed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

import { centralDirectoryCompressedSize } from "../../src/market-data/zip-entries";
import { unzipSingleEntry } from "../../src/market-data/bhavcopy";

const DATA_DESCRIPTOR_SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const NAME = Buffer.from("payload.csv", "utf8");

/**
 * Build a single-entry zip with bit 3 SET — sizes zeroed in the local header,
 * stated in a trailing data descriptor and in the central directory.
 *
 * `method` 0 stores `payload` verbatim; 8 deflates it. Level 0 is deliberate
 * for the deflate case: it emits STORED deflate blocks, so the payload's bytes
 * (including any `PK\x07\x08` inside it) survive verbatim into the compressed
 * stream. That makes the collision DETERMINISTIC rather than depending on what
 * a compressor happens to emit.
 */
function zipWithBit3(payload: Buffer, method: 0 | 8): Buffer {
  const compressed =
    method === 0 ? payload : deflateRawSync(payload, { level: 0 });
  const crc = crc32(payload);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x08, 6); // GP flags: bit 3
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14); // crc      — 0, it is in the descriptor
  local.writeUInt32LE(0, 18); // csize    — 0, "ask the descriptor"
  local.writeUInt32LE(0, 22); // usize    — 0
  local.writeUInt16LE(NAME.length, 26);
  local.writeUInt16LE(0, 28);

  const descriptor = Buffer.alloc(16);
  DATA_DESCRIPTOR_SIG.copy(descriptor, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(payload.length, 12);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x08, 8); // same GP flags
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20); // THE TRUTH
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(NAME.length, 28);
  central.writeUInt16LE(0, 30); // extraLen — deliberately 0 here
  central.writeUInt16LE(0, 32);
  central.writeUInt32LE(0, 42); // local header offset

  const centralStart =
    local.length + NAME.length + compressed.length + descriptor.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + NAME.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([
    local,
    NAME,
    compressed,
    descriptor,
    central,
    NAME,
    eocd,
  ]);
}

/**
 * The OLD algorithm, verbatim, so the two can be shown disagreeing on one
 * buffer. If this ever agrees with the central directory on the colliding
 * payload, the fixture stopped reproducing the bug and the case is vacuous —
 * which `it("the fixture really does collide")` below exists to catch.
 */
function forwardScanSize(buf: Buffer, dataStart: number): number {
  let end = buf.length;
  for (let i = dataStart; i + 4 <= buf.length; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x08074b50 || sig === 0x02014b50) {
      end = i;
      break;
    }
  }
  return end - dataStart;
}

/** A payload carrying the descriptor signature in its middle. */
function collidingPayload(): Buffer {
  return Buffer.concat([
    Buffer.from("symbol,series,open,close\n".repeat(40), "utf8"),
    DATA_DESCRIPTOR_SIG, // <- the landmine
    Buffer.from("\nTAIL,EQ,1,2\n".repeat(40), "utf8"),
  ]);
}

const DATA_START = 30 + NAME.length;

describe("MONEY-1483 — a forward scan truncates on a payload-borne PK signature", () => {
  it("the fixture really does collide (anti-vacuity)", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 0);

    const scanned = forwardScanSize(zip, DATA_START);
    assert.ok(
      scanned < payload.length,
      "fixture no longer reproduces the bug: the forward scan found the true " +
        `end (${scanned} of ${payload.length}). Every case below would then ` +
        "pass against the broken implementation too.",
    );
  });

  it("the central directory states the size the scan gets wrong", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 0);

    assert.equal(centralDirectoryCompressedSize(zip, 0), payload.length);
    assert.notEqual(forwardScanSize(zip, DATA_START), payload.length);
  });

  it("STORED: the member round-trips instead of being cut short", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 0);

    assert.equal(unzipSingleEntry(zip), payload.toString("utf8"));
  });

  it("DEFLATE: inflating the scanned slice throws; the declared slice does not", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 8);

    // This is the production symptom — "incomplete or truncated stream".
    const scanned = forwardScanSize(zip, DATA_START);
    assert.throws(() =>
      inflateRawSync(zip.subarray(DATA_START, DATA_START + scanned)),
    );

    assert.equal(unzipSingleEntry(zip), payload.toString("utf8"));
  });

  it("a TRUNCATED archive has no central directory, and says so rather than guessing", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 0);
    // Lop off the central directory + EOCD.
    const truncated = zip.subarray(0, DATA_START + payload.length + 16);

    assert.equal(centralDirectoryCompressedSize(truncated, 0), null);
  });

  it("ZIP64's 0xFFFFFFFF sentinel is refused, not returned as a size", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 0);
    const centralStart = DATA_START + payload.length + 16; /* descriptor */
    zip.writeUInt32LE(0xffffffff, centralStart + 20);

    assert.equal(
      centralDirectoryCompressedSize(zip, 0),
      null,
      "0xFFFFFFFF means 'look in the ZIP64 extra field', not 4 GiB — " +
        "returning it would slice the entire buffer",
    );
  });

  it("a member whose local offset is not in the directory is not guessed at", () => {
    const payload = collidingPayload();
    const zip = zipWithBit3(payload, 0);

    assert.equal(centralDirectoryCompressedSize(zip, 999_999), null);
  });
});
