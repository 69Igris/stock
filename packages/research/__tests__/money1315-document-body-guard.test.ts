/**
 * MONEY-1315 (B) — the BODY sniff, and the quarantine's absent-field arm.
 *
 * Every case here imports the REAL exports from
 * `packages/research/src/data-sources/document-body-guard.ts`. Nothing is
 * re-declared: the HTML predicate under test is `classifyArchivedObject` from
 * `@usemoney/storage`, reached through the real module, so a change to the
 * classifier moves these assertions rather than leaving them agreeing with a
 * stale copy.
 *
 * ## What the fixtures are
 *
 * The enveloped bytes are built to the MONEY-1169 shape measured on a real
 * corrupt prod object (`stocks/GOYALALUM/drhp/GOYALALUM-drhp-IPO.txt`): a
 * 36-char UUID boundary, a JSON metadata part carrying `cacheControl` and
 * `contentType`, a second boundary, the media part's own `Content-Type`, then
 * the payload. 40 of 40 sampled `text/html` rows on prod are enveloped and NONE
 * is bare, so an implementation that only handled the bare case would have
 * quarantined nothing while reporting a clean run.
 *
 * ## The control that matters most
 *
 * `envelope:ok` — an enveloped object whose payload is a REAL PDF. Those are
 * repairable in place from the bytes we already hold (`feed-repair.ts`), and
 * quarantining one would clear the `gcsPath` of a document that is still
 * recoverable, with no path back. A detector that cannot say "no" is not a
 * detector.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  sniffDocumentBody,
  mayStoreDocumentBody,
  classifyDocumentRow,
  DOCUMENT_SNIFF_HEAD_BYTES,
  HTML_QUARANTINE_STATUS,
  ABSENT_GCS_PATH,
} from "../src/data-sources/document-body-guard";

/* -------------------------------------------------------------------------- */
/* Fixtures — real byte shapes, not paraphrases                               */
/* -------------------------------------------------------------------------- */

/** The SEBI landing page Screener's DRHP link actually resolves to. */
const SEBI_HTML = Buffer.from(
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>SEBI | AAA Technologies Limited - Prospectus</title></head>` +
    `<body><div class="page">Draft offer documents</div></body></html>`,
  "utf-8",
);

/** A minimal but structurally real PDF. */
const REAL_PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"),
  Buffer.from("1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n", "latin1"),
  Buffer.alloc(4096, 0x20),
]);

/**
 * Wrap `payload` in the MONEY-1169 multipart envelope, exactly as the broken
 * uploader stored it — boundary, JSON metadata part, media part, closing
 * boundary with no trailing newline.
 */
function envelope(payload: Buffer, contentType: string): Buffer {
  const b = "--583642a9-133f-4945-b144-e5c132aa7089";
  const meta = JSON.stringify({
    cacheControl: "private, max-age=3600",
    contentType,
  });
  return Buffer.concat([
    Buffer.from(
      `${b}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n` +
        `${b}\r\nContent-Type: ${contentType}\r\n\r\n`,
      "latin1",
    ),
    payload,
    Buffer.from(`\r\n${b}--`, "latin1"),
  ]);
}

/** What the migration hands `sniffDocumentBody`: a ranged HEAD, not the object. */
function asHead(buf: Buffer): { size: number; head: Buffer } {
  return { size: buf.length, head: buf.subarray(0, DOCUMENT_SNIFF_HEAD_BYTES) };
}

const DRHP_KEY = "stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt";
const PDF_KEY =
  "stocks/RELIANCE/annual_report/RELIANCE-annual_report-FY2025.pdf";

/* -------------------------------------------------------------------------- */
/* sniffDocumentBody                                                          */
/* -------------------------------------------------------------------------- */

describe("sniffDocumentBody: HTML under a document key", () => {
  it("a BARE SEBI landing page is HTML", () => {
    const v = sniffDocumentBody({ key: DRHP_KEY, ...asHead(SEBI_HTML) });
    assert.strictEqual(v.html, true);
    assert.strictEqual(v.enveloped, false);
    assert.strictEqual(v.kind, "html");
  });

  it("an ENVELOPED SEBI landing page is HTML — the shape 100% of prod carries", () => {
    // `classifyArchivedObject` MUST check the envelope first (an enveloped
    // object's head is the boundary, so every type check below it misfires), so
    // it answers `envelope` and never `html` for this whole population. Peeling
    // and re-asking the SAME classifier is the only thing this module adds.
    const bytes = envelope(SEBI_HTML, "text/html; charset=UTF-8");
    const v = sniffDocumentBody({ key: DRHP_KEY, ...asHead(bytes) });
    assert.strictEqual(v.html, true, "an envelope must not hide the payload");
    assert.strictEqual(v.enveloped, true);
    assert.strictEqual(v.kind, "envelope:html");
  });

  it("CONTROL: a real PDF is NOT HTML", () => {
    const v = sniffDocumentBody({ key: PDF_KEY, ...asHead(REAL_PDF) });
    assert.strictEqual(v.html, false);
    assert.strictEqual(v.kind, "ok");
  });

  it("CONTROL: an ENVELOPED real PDF is NOT HTML — it is repairable, not junk", () => {
    // The expensive false positive. `feed-repair.ts` can recover this object
    // byte-for-byte from the bytes we already hold; quarantining it would clear
    // the gcsPath of a recoverable document with no path back.
    const bytes = envelope(REAL_PDF, "application/pdf");
    const v = sniffDocumentBody({ key: PDF_KEY, ...asHead(bytes) });
    assert.strictEqual(v.html, false, "an enveloped PDF must survive");
    assert.strictEqual(v.enveloped, true);
    assert.strictEqual(v.kind, "envelope:ok");
  });

  it("CONTROL: plain financial text is NOT HTML", () => {
    // 4,245 prod rows are `text/plain` READY — locally rendered financial
    // statements, not fetched. A rule that swept them up would blank a working
    // RAG corpus.
    const text = Buffer.from(
      "GICL - Annual Financial Statements\nIncome Statement (Annual):\nFY 2025: Revenue: 156.2\n",
      "utf-8",
    );
    const v = sniffDocumentBody({
      key: "stocks/GICL/financial_statement/GICL-financial_statement-annual-2026.txt",
      ...asHead(text),
    });
    assert.strictEqual(v.html, false);
  });

  it("an XML-stylesheet challenge page counts as HTML, via the shared predicate", () => {
    const v = sniffDocumentBody({
      key: DRHP_KEY,
      ...asHead(
        Buffer.from('<?xml-stylesheet type="text/xsl"?><err/>', "utf-8"),
      ),
    });
    assert.strictEqual(v.html, true);
  });

  it("the 2 KB head clears the envelope preamble with room to spare", () => {
    // The preamble measured on a real corrupt object is ~240 bytes. At
    // ARCHIVE_AUDIT_HEAD_BYTES (512) the payload window would be under 272
    // bytes — enough by coincidence rather than by design. This pins that
    // DOCUMENT_SNIFF_HEAD_BYTES leaves a full 512-byte window on the payload.
    const bytes = envelope(SEBI_HTML, "text/html; charset=UTF-8");
    const preamble = bytes.indexOf(SEBI_HTML);
    assert.ok(preamble > 0, "the fixture really has a preamble");
    assert.ok(
      DOCUMENT_SNIFF_HEAD_BYTES - preamble >= 512,
      `head budget leaves only ${DOCUMENT_SNIFF_HEAD_BYTES - preamble} payload bytes`,
    );
  });

  it("a malformed envelope claims NOTHING about its payload", () => {
    // Truncated so the media part's header separator is never found. Guessing
    // "probably HTML" here would quarantine a repairable data object.
    const truncated = Buffer.from(
      "--583642a9-133f-4945-b144-e5c132aa7089\r\nContent-Type: application/json\r\n",
      "latin1",
    );
    const v = sniffDocumentBody({ key: DRHP_KEY, ...asHead(truncated) });
    assert.strictEqual(v.html, false, "no payload recovered ⇒ no HTML claim");
  });
});

/* -------------------------------------------------------------------------- */
/* mayStoreDocumentBody — the write-time decision, as a pure function          */
/* -------------------------------------------------------------------------- */

describe("mayStoreDocumentBody: the write-time gate", () => {
  it("refuses an HTML body", () => {
    const d = mayStoreDocumentBody({ gcsPath: DRHP_KEY, body: SEBI_HTML });
    assert.strictEqual(d.store, false);
    assert.ok(d.reason.length > 0, "a refusal must say why");
  });

  it("refuses an HTML body under a .pdf key — the header cannot help here", () => {
    // The case `initialProcessingStatus` structurally cannot catch: three
    // writers HARDCODE `application/pdf` at the upload, so the media type it
    // would classify is one WE wrote.
    const d = mayStoreDocumentBody({ gcsPath: PDF_KEY, body: SEBI_HTML });
    assert.strictEqual(d.store, false);
  });

  it("CONTROL: stores a real PDF", () => {
    const d = mayStoreDocumentBody({ gcsPath: PDF_KEY, body: REAL_PDF });
    assert.strictEqual(d.store, true);
    assert.strictEqual(d.reason, "");
  });

  it("CONTROL: does NOT refuse a .pdf key whose bytes merely fail the magic check", () => {
    // `classifyArchivedObject` calls this `invalid`. Refusing it would be a
    // precise rule with no catch-all — its false positives are real documents
    // we would then never store. HTML is the measured failure; `invalid` is a
    // hypothesis.
    const odd = Buffer.concat([
      Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
      Buffer.alloc(2048, 7),
    ]);
    const d = mayStoreDocumentBody({ gcsPath: PDF_KEY, body: odd });
    assert.strictEqual(d.store, true, "narrow on purpose: HTML only");
  });
});

/* -------------------------------------------------------------------------- */
/* classifyDocumentRow — the quarantine selection, incl. the absent-field arm  */
/* -------------------------------------------------------------------------- */

describe("classifyDocumentRow: the quarantine selection", () => {
  it("a row whose object is HTML is SELECTED", () => {
    assert.strictEqual(
      classifyDocumentRow({
        gcsPath: DRHP_KEY,
        // MONEY-1321 — `sourceUrl` is now a REQUIRED input, because 520 of the
        // HTML-bodied rows are rating rationales the page ITSELF carries and
        // must never be cleared. A SEBI landing page is not one of them.
        sourceUrl: "https://www.sebi.gov.in/filings/public-issues/x.html",
        objectExists: true,
        bodyIsHtml: true,
      }),
      "html",
    );
  });

  it("CONTROL: a row whose object is a real PDF is NOT selected", () => {
    assert.strictEqual(
      classifyDocumentRow({
        gcsPath: PDF_KEY,
        sourceUrl: "https://nsearchives.nseindia.com/corporate/x.pdf",
        objectExists: true,
        bodyIsHtml: false,
      }),
      "ok",
    );
  });

  it("ABSENT-FIELD ARM: a row with NO gcsPath attribute is still REACHED", () => {
    // `prisma db push` creates INDEXES, never FIELDS, so a row written outside
    // Prisma can lack the attribute entirely — this branch's own history
    // includes 785,352 pymongo-written rows. The migration projects
    // `{ $ifNull: ["$gcsPath", null] }` instead of filtering on the field, so
    // such a row arrives here as `null` and MUST be classified rather than
    // dropped. A selection that filtered `gcsPath: { not: "" }` would match
    // ZERO of them, in BOTH directions, and report a complete-looking census
    // over a population it could not see (MONEY-1050/1205/1234/1235/1236).
    assert.strictEqual(
      classifyDocumentRow({
        gcsPath: null,
        sourceUrl: null,
        objectExists: false,
        bodyIsHtml: false,
      }),
      "alreadyQuarantined",
      "an absent gcsPath must be a VERDICT, never an exclusion",
    );
  });

  it("an already-quarantined row is idempotent — no GCS call, no rewrite", () => {
    assert.strictEqual(
      classifyDocumentRow({
        gcsPath: ABSENT_GCS_PATH,
        sourceUrl: null,
        objectExists: false,
        bodyIsHtml: false,
      }),
      "alreadyQuarantined",
    );
  });

  it("a gcsPath naming an object the bucket does not hold is its OWN class", () => {
    // Deliberately not folded into `html`: a missing object is a different
    // finding with a different remedy, and this migration does not write it.
    assert.strictEqual(
      classifyDocumentRow({
        gcsPath: PDF_KEY,
        sourceUrl: "https://nsearchives.nseindia.com/corporate/x.pdf",
        objectExists: false,
        bodyIsHtml: false,
      }),
      "objectMissing",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The migration's SELECTION SHAPE, asserted against its source                */
/* -------------------------------------------------------------------------- */

/**
 * The body of every `$match: { … }` stage, BRACE-BALANCED.
 *
 * A `/\$match:\s*\{([^}]*)/` capture stops at the first `}`, which for this
 * pipeline is the one closing `{ $oid: lastId }` — three characters into a
 * nested object and long before the stage ends. Every clause after that nested
 * object is invisible to the scan, so the guard below could not see the one
 * shape it exists to forbid: `$match: { _id: { $gt: x }, gcsPath: "" }`.
 *
 * Walks from the `{` tracking depth instead. On an UNBALANCED stage it hands
 * back the rest of the file rather than a truncated body — fail-LOUD, because
 * a parser that cannot find the end must not report "nothing to see here",
 * which is the same defect one layer up.
 */
function matchStageBodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\$match:\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    out.push(end < 0 ? src.slice(open + 1) : src.slice(open + 1, end));
  }
  return out;
}

describe("quarantine-html-stock-documents.ts: the selection cannot fall into the trap", () => {
  const SRC = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../scripts/migrations/quarantine-html-stock-documents.ts",
    ),
    "utf-8",
  );

  it("the scan pipeline projects gcsPath with $ifNull rather than matching on it", () => {
    assert.ok(
      SRC.includes('$ifNull: ["$gcsPath", null]'),
      "an absent gcsPath must survive projection as null",
    );
    assert.ok(
      SRC.includes('$ifNull: ["$processingStatus", null]'),
      "same for processingStatus",
    );
  });

  it("no $match names a possibly-absent field", () => {
    // The whole selection filters on `_id` and (optionally) `docType`, both
    // required and present on every row. A `$match` on gcsPath/mimeType/
    // processingStatus would silently drop rows whose attribute was never
    // created.
    const matches = matchStageBodies(SRC);
    assert.ok(
      matches.length >= 3,
      `the pipeline really does have $match stages (found ${matches.length}, ` +
        "want the resume, the docType narrowing and the verification)",
    );
    // THE premise, and the one the old extractor could never satisfy: a body
    // it walked is brace-BALANCED. `/\$match:\s*\{([^}]*)/` stops at the first
    // `}`, so the resume stage came back as `_id: { $gt: { $oid: lastId ` —
    // one `{` and no `}` — and every clause AFTER the nested object was
    // invisible. Verified: `$match: { _id: { $gt: x }, gcsPath: "" }`, the
    // exact shape forbidden below, scanned clean.
    for (const body of matches) {
      assert.equal(
        (body.match(/\{/g) ?? []).length,
        (body.match(/\}/g) ?? []).length,
        `extracted an unbalanced $match body — the walk stopped early: ${body}`,
      );
    }
    for (const body of matches) {
      for (const field of ["gcsPath", "mimeType", "processingStatus"]) {
        assert.ok(
          !body.includes(field),
          `$match must not filter on the possibly-absent "${field}": ${body}`,
        );
      }
    }
  });

  it("the verification uses $type, NOT the selection's own rule", () => {
    // A verify that re-runs the selection's predicate can only confirm the
    // selection's own blind spot — three sibling migrations printed a confident
    // zero for months that way (scripts/README.md, MONEY-1236).
    assert.ok(
      SRC.includes('$type: "$gcsPath"'),
      "the post-write check must be able to see an UNSET field",
    );
  });

  it("it is DRY RUN by default and --delete-objects is refused without --apply", () => {
    assert.ok(
      SRC.includes('const apply = has("--apply")'),
      "writing must be opt-in",
    );
    assert.ok(
      SRC.includes('has("--delete-objects") && !apply'),
      "a dry run must never be able to imply it deleted anything",
    );
  });

  it("deletion is refused on a NARROWED scan", () => {
    // Several rows can share one `gcsPath` — the path is derived from
    // symbol/docType/period and carries no exchange, so a dual-listed
    // company's NSE and BSE rows are the same object. A `--doc-type` or
    // `--limit` scan could classify one and never look at its sibling, leaving
    // a live row pointing at deleted bytes. `parseArgs` already refuses both
    // alongside `--apply`; this is the restatement at the irreversible act.
    assert.ok(
      SRC.includes("refusing to delete objects from a NARROWED scan"),
      "the delete path must re-check the narrowing it depends on",
    );
  });

  it("it writes the SHARED terminal state, not its own spelling of it", () => {
    assert.ok(SRC.includes("HTML_QUARANTINE_STATUS"));
    assert.ok(SRC.includes("ABSENT_GCS_PATH"));
    assert.strictEqual(HTML_QUARANTINE_STATUS, "UNSUPPORTED");
    assert.strictEqual(ABSENT_GCS_PATH, "");
  });

  it("it KEEPS sourceUrl / title / description — the useful part", () => {
    // The BSE-retention precedent: 7,234 rows carry `gcsPath: ""` with every
    // other column intact, because the metadata is what remains useful once the
    // PDF is gone. (One spelling, on `ABSENT_GCS_PATH`; the older 6,125 is
    // superseded rather than contradicted.)
    //
    // Three NEGATIVES need a premise, or they are satisfied by an empty
    // string. If `$set: {` ever stops matching, `indexOf` returns -1, the
    // slice comes back empty and all three pass while the write is
    // unexamined. Verified: renaming `$set` to `$setRenamed` in the migration
    // left this case green.
    const setAt = SRC.indexOf("$set: {");
    const endAt = SRC.indexOf("multi: true");
    assert.ok(setAt >= 0, "the update's $set block is gone");
    assert.ok(
      endAt > setAt,
      `could not bound the $set block ($set at ${setAt}, "multi: true" at ` +
        `${endAt}) — an unbounded slice makes the negatives below vacuous`,
    );
    const setBlock = SRC.slice(setAt, endAt);
    // …and the block really is the write, not some other object literal: these
    // are the columns the quarantine DOES set.
    for (const written of ["gcsPath", "processingStatus"]) {
      assert.ok(
        setBlock.includes(written),
        `the extracted $set block does not set "${written}" — wrong block`,
      );
    }
    for (const kept of ["sourceUrl", "title", "description"]) {
      assert.ok(!setBlock.includes(kept), `the write must not touch "${kept}"`);
    }
  });
});
