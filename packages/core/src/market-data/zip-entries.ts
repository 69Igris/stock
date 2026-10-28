/**
 * ZIP member reader — the ONE hand-rolled unzip for multi-member archives.
 *
 * Lifted out of `commodity-eod-logic.ts` by MONEY-1319 without a byte of the
 * parse changing. It moved because a SECOND consumer arrived that has nothing
 * to do with commodities: 179 `stock_documents` objects on prod are NSE ZIPs
 * stored under a `.pdf` key, and the extract lane has to open them. Reaching
 * that walker through the NCDEX bhavcopy parser would have made every document
 * worker import a commodity CSV module — or, far worse, grown a fourth copy of
 * a ZIP parse this repo already has three of (`bhavcopy.ts#unzipSingleEntry`,
 * `mf-portfolio-logic.ts#unzipFirstEntry`, and this one).
 *
 * `commodity-eod-logic.ts` re-exports both symbols, so every existing importer
 * — including `market-data/index.ts` and the commodity test suite — keeps
 * working through the path it already uses.
 *
 * STORED (0) and DEFLATE (8) only, which is everything the Indian exchanges,
 * the AMCs and NSE's filing archive emit. No dependency beyond `node:zlib`.
 *
 * PURE LEAF: `node:zlib` and nothing else. No I/O, no clock. Import by SUBPATH
 * (`@usemoney/core/market-data/zip-entries`), never through the market-data
 * barrel.
 */

import { inflateRawSync } from "node:zlib";

/** One member of a ZIP archive. */
export interface ZipEntry {
  name: string;
  /** Raw bytes. Decode when you know what the member is — see module header. */
  bytes: Buffer;
}

/**
 * Largest DECOMPRESSED size a single member may reach. 64 MiB.
 *
 * ## Why this exists — a 611 KB archive expanded to 1.2 GB of RSS
 *
 * MONEY-1319 pointed this walker at UNTRUSTED EXCHANGE BYTES: it is reached by
 * `stock-document-extract` on every cycle, over objects `nsearchives` served.
 * `inflateRawSync` with no `maxOutputLength` will happily materialise whatever
 * the compressed stream expands to, and a deflate stream of NULs expands ~1000x
 * — measured at 611 KB in, 1.2 GB resident. In a 1 GiB Cloud Run container that
 * is an OOM kill, which takes every other in-flight message with it, and
 * Pub/Sub then REDELIVERS the same document: a poison pill that loops, five
 * delivery attempts at a time, until the dead-letter queue catches it.
 *
 * ## Why 64 MiB and not something smaller
 *
 * A bound that refuses a real document is a data-loss bug wearing a safety
 * jacket, so it is sized above every consumer that could ever want the member:
 * `gemini-pdf.ts`'s `MAX_PDF_BYTES` is 50 MiB and
 * `stock-document-extract.ts`'s `MAX_FETCH_BYTES` is 25 MiB. A member larger
 * than 64 MiB has nowhere to go. The largest ZIP member measured on prod is
 * ACCELYA's 1.75 MB annual report, so the bound is ~36x the observed worst
 * case and ~19x below the RSS that killed the container.
 */
export const MAX_ZIP_MEMBER_BYTES = 64 * 1024 * 1024;

/**
 * Largest TOTAL decompressed size across all of an archive's members. 128 MiB.
 *
 * A per-member bound alone does not close the hole, because this walker
 * inflates EVERY member before a caller selects one: twenty 60 MiB members each
 * pass the per-member test and together are 1.2 GB. The running total is
 * checked as the walk proceeds, so a bomb is refused at the member that crosses
 * the line rather than after the last one is materialised.
 *
 * 2x the per-member bound, because the archives this repo actually opens are a
 * document plus a small sidecar (NSE) or two CSVs (NCDEX) — never a corpus.
 */
export const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;

/** Caller-supplied bounds. Both default to the constants above. */
export interface UnzipLimits {
  /** Per-member decompressed ceiling, in bytes. */
  maxMemberBytes?: number;
  /** Whole-archive decompressed ceiling, in bytes. */
  maxTotalBytes?: number;
}

/**
 * Walk every local file header in a ZIP and return its members.
 *
 * Why this exists alongside `unzipSingleEntry` in `bhavcopy.ts`: that one
 * reads only the FIRST member, which its own comment justifies with "the NSE
 * file is always exactly one entry". NCDEX archives carry TWO (the UDiFF CSV
 * and a legacy `FO_*.csv`), so selecting the right one requires reading names.
 * It also returns UTF-8, which is a lossy choice to make before the caller
 * knows what a member is; this returns Buffer and leaves decoding to them.
 *
 * No new dependency — the same `node:zlib` `inflateRawSync`, STORED and
 * DEFLATE only, which is everything Indian exchanges emit.
 *
 * Returns `null` rather than throwing when the bytes are not a ZIP or use a
 * method we do not implement. The callers here are parsers whose contract is
 * already "`null` means these are not the bytes you think"; making one of
 * several failure modes throw instead would just relocate the same decision
 * into a try/catch at every call site.
 *
 * ## BOUNDED — see {@link MAX_ZIP_MEMBER_BYTES} / {@link MAX_ZIP_TOTAL_BYTES}
 *
 * A zip bomb is refused, and a REFUSAL is `null` like every other "these are
 * not the bytes you think" outcome. Two independent checks, because either one
 * alone is defeatable:
 *
 *   - the local header's DECLARED `uncompressedSize` is refused BEFORE any
 *     inflate, so an honestly-declared bomb costs nothing at all;
 *   - `maxOutputLength` on the inflate itself catches a header that LIES (a
 *     bit-3 data descriptor legitimately declares 0, and ZIP64 declares
 *     0xFFFFFFFF), by throwing `ERR_BUFFER_TOO_LARGE` into the `catch` that was
 *     already here.
 */
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;

/**
 * The compressed size the CENTRAL DIRECTORY declares for the member whose local
 * header sits at `localOffset`, or `null` when the archive has no usable one.
 *
 * ## Why this exists — a forward scan is a GUESS, and it is wrong ~1 file in 5,900
 *
 * A member with general-purpose bit 3 set carries `compressedSize: 0` in its
 * LOCAL header; the real size trails the data in a descriptor. Both readers in
 * this repo coped by scanning forward for the next `PK\x07\x08` / `PK\x01\x02`
 * signature — and those four bytes occur BY CHANCE inside DEFLATE output.
 *
 * Measured twice, on two different feeds:
 *
 *   MONEY-1405  ICICI's 25,378,416-byte, 147-member monthly zip — the scan
 *               truncated member one and 146 workbooks read as "not a workbook".
 *   MONEY-1483  `feeds/NSE/fo-legacy/2017/03/fo15MAR2017bhav.csv.zip` — true
 *               compressed size 365,837, forward scan returned 300,039 on a
 *               signature at offset 300,088. Truncated by 65,798 bytes, so
 *               `inflateRawSync` threw "incomplete or truncated stream" and
 *               `feed-parse-prod` exited 1 every night. `unzip -t` reports no
 *               errors and the CRC matches: the BYTES ARE PERFECT.
 *
 * At ~5,940 archived NSE legacy files of ~370 KB, ~2.2 GB is scanned and a
 * 4-byte collision is expected roughly ONCE. Exactly one was observed. This is
 * a recurring rate, not a freak.
 *
 * ## Why the answer is still allowed to be `null`
 *
 * A TRUNCATED archive has no central directory at all, and must still be
 * recognisable rather than crash the caller — so this reports "cannot say" and
 * leaves the fallback to the caller, which is the same split
 * `mf-portfolio-logic.ts` arrived at independently.
 *
 * NOTE the offsets: a central-directory record's own `extraLen` may DIFFER from
 * the local header's, so a caller must take the SIZE from here and compute the
 * data offset from the LOCAL header's two length fields. Mixing them silently
 * shifts the data window.
 */
export function centralDirectoryCompressedSize(
  buf: Buffer,
  localOffset: number,
): number | null {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;

  // The EOCD is the last record in a well-formed zip, at most 22 + 65535 bytes
  // from the end (the trailing comment is length-capped), so a bounded backward
  // scan is both cheap and exact.
  let eocd = -1;
  const floor = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 20 > buf.length) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length) return null;
    if (buf.readUInt32LE(offset) !== ZIP_CENTRAL_SIG) return null;

    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const memberLocalOffset = buf.readUInt32LE(offset + 42);

    if (memberLocalOffset === localOffset) {
      // ZIP64 parks the real value in the extra field and leaves this sentinel.
      // Reporting 0xFFFFFFFF as a size would slice the whole buffer.
      return compressedSize === 0xffffffff ? null : compressedSize;
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

export function unzipEntries(
  buf: Buffer,
  limits: UnzipLimits = {},
): ZipEntry[] | null {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return null;
  if (buf.readUInt32LE(0) !== 0x04034b50) return null;

  const maxMemberBytes = limits.maxMemberBytes ?? MAX_ZIP_MEMBER_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;

  const entries: ZipEntry[] = [];
  let inflatedTotal = 0;
  let offset = 0;

  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    let compressedSize = buf.readUInt32LE(offset + 18);
    const declaredSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > buf.length) return null;

    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf-8");

    // Bit 3: sizes live in a trailing data descriptor, not the local header.
    // ASK THE CENTRAL DIRECTORY FIRST — it states the size outright, where the
    // forward scan below only guesses at it and is measurably wrong about 1
    // file in 5,900 (see `centralDirectoryCompressedSize`).
    //
    // The scan survives as the fallback for the one case the central directory
    // cannot serve: a TRUNCATED archive, which has no central directory at all.
    // Both NCDEX fixtures set flags=0x2 (compression hint only), so neither
    // path is the happy path here.
    if ((flags & 0x08) !== 0 && compressedSize === 0) {
      const declared = centralDirectoryCompressedSize(buf, offset);
      if (declared !== null) {
        compressedSize = declared;
      } else {
        let end = buf.length;
        for (let i = dataStart; i + 4 <= buf.length; i++) {
          const sig = buf.readUInt32LE(i);
          if (sig === 0x08074b50 || sig === 0x02014b50 || sig === 0x04034b50) {
            end = i;
            break;
          }
        }
        compressedSize = end - dataStart;
      }
    }

    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) return null;
    const compressed = buf.subarray(dataStart, dataEnd);

    // REFUSE BEFORE INFLATING when the archive declares the bomb itself.
    // 0xFFFFFFFF is ZIP64's "look in the extra field" sentinel and 0 is what a
    // bit-3 data descriptor leaves here, so neither is a real size claim —
    // those fall through to `maxOutputLength` below, which is why both checks
    // exist. A STORED member is already fully resident in `buf`, so its size is
    // bounded by the object we were handed and needs no ceiling of its own; it
    // still counts toward the running total.
    if (
      method === 8 &&
      declaredSize !== 0 &&
      declaredSize !== 0xffffffff &&
      declaredSize > maxMemberBytes
    ) {
      return null;
    }

    if (method === 0) {
      entries.push({ name, bytes: Buffer.from(compressed) });
      inflatedTotal += compressed.length;
    } else if (method === 8) {
      try {
        // The remaining total is part of the ceiling, so the member that
        // CROSSES the whole-archive line is refused rather than materialised
        // and then measured — this walker inflates every member before a caller
        // selects one, so measuring afterwards is measuring the thing that
        // already OOM-killed the container.
        const headroom = maxTotalBytes - inflatedTotal;
        if (headroom < 1) return null;
        const bytes = inflateRawSync(compressed, {
          // Node rejects a `maxOutputLength` below 1 with ERR_OUT_OF_RANGE, so
          // the floor is a range requirement rather than a policy choice — the
          // "no headroom left" case is already handled above.
          maxOutputLength: Math.max(1, Math.min(maxMemberBytes, headroom)),
        });
        entries.push({ name, bytes });
        inflatedTotal += bytes.length;
      } catch {
        return null;
      }
    } else {
      return null;
    }

    if (inflatedTotal > maxTotalBytes) return null;

    offset = dataEnd;
    // A data descriptor (PK\x07\x08 + 3 words, or 3 words bare) sits between
    // members when bit 3 is set. Step over it so the next signature lines up.
    if ((flags & 0x08) !== 0) {
      if (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x08074b50) {
        offset += 16;
      } else {
        offset += 12;
      }
    }
  }

  return entries.length > 0 ? entries : null;
}
