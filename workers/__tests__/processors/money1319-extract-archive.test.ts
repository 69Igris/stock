/**
 * UNIT TEST — the extract lane opens an archive, and the writers stop lying
 * about what they stored (MONEY-1319).
 *
 * Two halves of one defect:
 *
 *   THE ROOT CAUSE. Four writers stamped a literal `application/pdf` on every
 *   object they uploaded, so 179 NSE ZIPs are recorded as PDFs. Because the
 *   media type is OURS and not the upstream's, no header rule could ever have
 *   caught it — the bytes are the only witness.
 *
 *   THE LANE. Those rows PASS `buildExtractQuery`, get selected every cycle and
 *   fail: 126 of the 179 are already `FAILED`, each having cost a Document AI
 *   round trip against ZIP bytes. Re-typing them to `application/zip` stops the
 *   waste and, on its own, loses the document — nothing could read the archive.
 *   `resolveExtractionSource` is what reads it.
 *
 * The archive fixtures are built with real `node:zlib` output, in both the
 * STORED and DEFLATE forms, because the STORED form is the one that hides a
 * `%PDF-1.x` header inside the sniffer's scan window.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  resolveExtractionSource,
  buildExtractQuery,
  EXTRACTABLE_DOC_MIME_TYPES,
} from "../../src/processors/stock-document-extract-logic";

/**
 * `repoRoot()`, not a hand-rolled three-`..` anchor off `import.meta.url`.
 *
 * Most cases below are SOURCE SCANS — they `read()` a worker file, or walk a
 * directory under this root, and assert about what they find. A hand-rolled
 * anchor always produces *a* directory, so the day this file moves a level the
 * root is silently wrong and every scan reads a tree that is not ours; a scan
 * that finds nothing reports every assertion green. The helper anchors
 * identically and then ASSERTS `yarn.lock` on the result, so that day fails
 * naming the reason instead of passing quietly (MONEY-1327).
 */
const REPO = repoRoot();
const read = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf-8");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface Member {
  name: string;
  bytes: Buffer;
  stored?: boolean;
}

function localHeader(m: Member): Buffer {
  const name = Buffer.from(m.name, "utf-8");
  const payload = m.stored ? m.bytes : deflateRawSync(m.bytes);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(m.stored ? 0 : 8, 8);
  head.writeUInt32LE(payload.length, 18);
  head.writeUInt32LE(m.bytes.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name, payload]);
}

function zip(...members: Member[]): Buffer {
  const end = Buffer.alloc(4);
  end.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([...members.map(localHeader), end]);
}

function pdf(size: number): Buffer {
  const head = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n");
  return Buffer.concat([
    head,
    Buffer.alloc(Math.max(0, size - head.length), "x"),
    Buffer.from("\n%%EOF\n"),
  ]);
}

const NSE_SIDECAR = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><Announcement><Symbol>AERON</Symbol></Announcement>',
  "utf-8",
);

/* -------------------------------------------------------------------------- */
/* resolveExtractionSource                                                     */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: resolveExtractionSource opens the archive", () => {
  it("a plain PDF reads from the GCS OBJECT, unchanged", () => {
    const body = pdf(3000);
    const src = resolveExtractionSource({
      body,
      storedMimeType: "application/pdf",
    });
    assert.ok(src);
    assert.equal(src.objectIsTheDocument, true, "the object IS the document");
    assert.equal(src.memberName, null);
    assert.equal(src.mimeType, "application/pdf");
    assert.equal(src.bytes, body, "the bytes must not be copied or altered");
  });

  it("an NSE bundle yields the FILING, not the XML sidecar", () => {
    // The real shape of stocks/AERON/announcement/AERON-announcement-2026.pdf:
    // a STORED PDF (whose own header therefore sits inside the sniffer's 1 KB
    // window) plus NSE's XML metadata file.
    const src = resolveExtractionSource({
      body: zip(
        { name: "RESIGNATION_LETTER_CCP_1.pdf", bytes: pdf(900), stored: true },
        { name: "ROID_9_WebXMLFile_2026.xml", bytes: NSE_SIDECAR },
      ),
      storedMimeType: "application/pdf",
    });
    assert.ok(src);
    assert.equal(src.memberName, "RESIGNATION_LETTER_CCP_1.pdf");
    assert.equal(src.mimeType, "application/pdf");
    assert.equal(src.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(
      src.objectIsTheDocument,
      false,
      "gcsPath names the ARCHIVE — pointing Document AI at it repeats the failure",
    );
    assert.match(src.why, /2 member/);
  });

  it("the row's MIS-TYPED column does not change the outcome", () => {
    // The container is re-derived from the bytes on purpose. Branching on
    // `storedMimeType` would open an archive only for rows a repair pass had
    // already corrected — the repair is the one-off; the lane has to be right
    // for every row that arrives after it.
    const archive = zip({ name: "f.pdf", bytes: pdf(1500) });
    for (const stored of [
      "application/pdf",
      "application/zip",
      "text/html",
      null,
      undefined,
    ]) {
      const src = resolveExtractionSource({
        body: archive,
        storedMimeType: stored,
      });
      assert.equal(src?.memberName, "f.pdf", `stored=${String(stored)}`);
      assert.equal(src?.objectIsTheDocument, false);
    }
  });

  it("an archive holding only a sidecar is null — FAIL WITHOUT a parse", () => {
    // Spending a Document AI call to discover there is nothing to read is the
    // exact waste this branch exists to stop.
    assert.equal(
      resolveExtractionSource({
        body: zip({ name: "ROID_1.xml", bytes: NSE_SIDECAR }),
        storedMimeType: "application/zip",
      }),
      null,
    );
  });

  it("a truncated archive is null rather than a throw", () => {
    const truncated = zip({ name: "f.pdf", bytes: pdf(4000) }).subarray(0, 40);
    assert.doesNotThrow(() =>
      resolveExtractionSource({
        body: truncated,
        storedMimeType: "application/zip",
      }),
    );
  });

  it("unidentifiable bytes still reach the extractor under the stored type", () => {
    // A DECLINE is not a verdict: refusing here would drop a document the
    // pdf-parse fallback might well have read.
    const opaque = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const src = resolveExtractionSource({
      body: opaque,
      storedMimeType: "application/pdf",
    });
    assert.ok(src);
    assert.equal(src.objectIsTheDocument, true);
    assert.equal(src.mimeType, "application/pdf");
  });
});

/* -------------------------------------------------------------------------- */
/* The query                                                                   */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: the extract query now selects archives", () => {
  it("buildExtractQuery reads the shared array and it carries application/zip", () => {
    // `now` is required since MONEY-1329; irrelevant to the mimeType arm.
    const where = buildExtractQuery({ now: new Date() }) as {
      mimeType: { in: string[] };
    };
    assert.deepEqual(where.mimeType, { in: [...EXTRACTABLE_DOC_MIME_TYPES] });
    assert.ok(where.mimeType.in.includes("application/zip"));
    assert.ok(where.mimeType.in.includes("application/pdf"));
  });
});

/* -------------------------------------------------------------------------- */
/* The WRITERS — asserted against their source, because the defect IS a literal */
/* -------------------------------------------------------------------------- */

/**
 * Every writer that uploads a downloaded body and upserts a `stock_documents`
 * row, with the symbol that does the upload.
 *
 * ALL FIVE ARE HERE NOW. `nse-announcements-sync.ts` sat outside this list for
 * one commit, excused as "owned by a concurrent change in this same session" —
 * an excuse with no expiry date on it, over the ONE writer that hits
 * `nsearchives`, the single upstream behind 100% of the 179 ZIPs-stored-as-PDFs
 * (7 of them `announcement` rows, i.e. this job's). The MONEY-1319 review
 * called that in: it is converted, and the half-converted special case below
 * this block is gone with it.
 */
const BYTE_TYPED_WRITERS: ReadonlyArray<[string, string]> = [
  ["workers/src/processors/annual-reports-sync.ts", "storeAnnualReport"],
  ["workers/src/processors/stock-document-sync.ts", "storeNSEFiling"],
  [
    "workers/src/processors/nse-announcements-sync.ts",
    "processNseAnnouncementsSync",
  ],
  [
    "packages/research/src/data-sources/stock-document-fetcher.ts",
    "fetchAndStoreFilings",
  ],
];

describe("MONEY-1319: the writers store the type the BYTES imply", () => {
  for (const [file, fn] of BYTE_TYPED_WRITERS) {
    it(`${file} derives its media type from the body (${fn})`, () => {
      const src = read(file);
      assert.match(
        src,
        /resolveStoredMimeType\(\{/,
        "the writer must call the byte-derived resolver",
      );
      assert.match(
        src,
        /mimeType: storedMimeType/,
        "the ROW's mimeType must be the resolved value, not a literal",
      );
    });

    it(`${file} has no hardcoded mimeType/contentType literal left`, () => {
      // The defect is literally a string literal, so this is the assertion that
      // matches its shape. A future writer that reintroduces
      // `mimeType: "application/pdf"` fails here.
      const src = read(file);
      assert.doesNotMatch(
        src.replace(/^\s*(\/\/|\*).*$/gm, ""),
        /mimeType:\s*"application\/pdf"/,
        "a literal media type is our own claim, not the upstream's",
      );
      assert.doesNotMatch(
        src.replace(/^\s*(\/\/|\*).*$/gm, ""),
        /(uploadToGCS|uploadToStorage)\([^)]*"application\/pdf"\s*\)/s,
        "the OBJECT's content type must come from the same resolved value",
      );
    });

    it(`${file} derives processingStatus from that same value`, () => {
      // A body no extractor can read is not queued for anything, and a
      // hardcoded PENDING beside a byte-derived mimeType is the two halves
      // disagreeing again.
      assert.match(read(file), /initialProcessingStatus\(storedMimeType\)/);
    });
  }

  it("EVERY writer that stores a downloaded body is in the list above", () => {
    // The list is a hand-written enumeration, so the failure it cannot see is
    // OMISSION — which is exactly how `nse-announcements-sync.ts` sat outside
    // it. This derives the population from the SOURCE instead: any file under
    // `workers/src/processors` or `packages/research/src/data-sources` that
    // upserts/creates a `stock_documents` row carrying a `mimeType` must be one
    // of the writers asserted above.
    const roots = [
      "workers/src/processors",
      "packages/research/src/data-sources",
    ];
    const listed = new Set(BYTE_TYPED_WRITERS.map(([f]) => f));
    const missed: string[] = [];

    for (const root of roots) {
      for (const name of readdirSync(path.join(REPO, root))) {
        if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
        const rel = `${root}/${name}`;
        const code = read(rel).replace(/^\s*(\/\/|\*).*$/gm, "");
        // A writer is a file that names the model AND writes the column.
        const writesRow =
          /prisma\.stockDocument\.(upsert|create)\(/.test(code) ||
          /\bstockDocument\.(upsert|create)\(/.test(code);
        if (!writesRow) continue;
        if (!/\bmimeType:/.test(code)) continue;
        if (listed.has(rel)) continue;
        // It writes a mimeType and is not in the list: the ONLY acceptable
        // reason is that the value is not a literal media type of ours.
        if (/mimeType:\s*"/.test(code)) missed.push(rel);
      }
    }

    assert.deepEqual(
      missed,
      [],
      `these writers stamp a literal media type and are not asserted above: ${missed.join(", ")}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The WIRING in the I/O seam                                                   */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: the extract worker uses the recovered bytes", () => {
  const src = read("workers/src/processors/stock-document-extract.ts");

  it("it calls the pure resolver rather than sniffing inline", () => {
    assert.match(src, /resolveExtractionSource\(\{/);
  });

  it("Document AI reads the OBJECT only when the object IS the document", () => {
    // `extractWithDocumentAi` takes a gs:// URI, so for an archive row it would
    // hand the processor the ZIP — the failure that left 126 rows FAILED.
    assert.match(
      src,
      /source\.objectIsTheDocument\s*\r?\n?\s*\?\s*await extractWithDocumentAi\(/,
    );
    assert.match(src, /:\s*await extractWithDocumentAiBytes\(source\.bytes,/);
  });

  it("pdf-parse reads source.bytes, never the raw object buffer", () => {
    // The subtle half: leaving `pdfParse(buf)` would make the fallback read the
    // ZIP even when Document AI read the member, so the row fails whenever the
    // processor is unprovisioned — which is the DEFAULT configuration.
    assert.match(src, /pdfParse\(source\.bytes\)/);
    assert.doesNotMatch(src, /pdfParse\(buf\)/);
  });
});
