/**
 * UNIT TEST — opening the 179 stored ZIPs, and storing the type the BYTES imply
 * (MONEY-1319).
 *
 * The load-bearing cases, in order of what they protect:
 *
 *   1. **ZIP-BEFORE-PDF IS THE WHOLE THING.** A stored (uncompressed) ZIP
 *      member puts the contained PDF's own `%PDF-1.x` header inside the 1 KB
 *      window `sniffDocumentContainer` scans — measured on
 *      `stocks/AERON/announcement/AERON-announcement-2026.pdf`, about 40 bytes
 *      in. If the PDF window scan were tested before the offset-0 magics, that
 *      archive reports `pdf`, the extract lane never opens it, and the repair
 *      script proposes re-typing an honestly-labelled `application/zip` row to
 *      `application/pdf`. MUTATION: move the `%PDF-` scan above the ZIP magics
 *      and both the sniff case and every `openDocumentZip` case here go RED.
 *   2. **THE SIDECAR.** NSE bundles an XML metadata file beside the filing, so
 *      `entries[0]` is not the document. Selection is by BYTES — the member's
 *      own container — never by name or position. The XML-first fixture is the
 *      one that kills "take the first entry".
 *   3. **THE HEADER LIES IN BOTH DIRECTIONS.** 13 prod rows disagree with their
 *      bytes: 3 say `application/pdf` over an HTML page, 10 say `text/html`
 *      over something that is not HTML. `resolveStoredMimeType` is asserted in
 *      both directions, because a rule that only handled one would look like it
 *      worked.
 *   4. **A DECLINE IS NOT A VERDICT.** Bytes the sniffer cannot identify must
 *      fall back to the upstream's header, not to `application/octet-stream` —
 *      that value is not in `EXTRACTABLE_DOC_MIME_TYPES`, so it would silently
 *      remove a readable document from the extraction queue.
 *   5. **A RE-TYPE ALONE LOSES THE DOCUMENT.** 126 of the 179 rows are already
 *      `FAILED`, and `FAILED` is only re-selected under `force`. Correcting the
 *      column without re-queueing takes them out of the wasteful loop AND the
 *      useful one.
 *
 * The ZIP fixtures are built here rather than committed, so both the STORED and
 * the DEFLATE paths are exercised with real `node:zlib` output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import {
  sniffDocumentContainer,
  resolveStoredMimeType,
  planContainerRepair,
} from "../../src/market-data/doc-container";
import {
  openDocumentZip,
  selectZipDocumentMember,
} from "../../src/market-data/doc-zip";
import { mimeTypeForContainer } from "../../src/market-data/doc-container";
import {
  unzipEntries,
  MAX_ZIP_MEMBER_BYTES,
  MAX_ZIP_TOTAL_BYTES,
} from "../../src/market-data/zip-entries";
import {
  EXTRACTABLE_DOC_MIME_TYPES,
  isExtractableDocMimeType,
  initialProcessingStatus,
  CANONICAL_PDF_MIME_TYPE,
  ZIP_MIME_TYPE,
} from "../../src/market-data/doc-mime";

/* -------------------------------------------------------------------------- */
/* Fixture builders — real archives, not hand-waved buffers                    */
/* -------------------------------------------------------------------------- */

interface Member {
  name: string;
  bytes: Buffer;
  /** STORED (0) leaves the payload verbatim — the case that proves the ordering. */
  stored?: boolean;
}

function localHeader(m: Member): Buffer {
  const name = Buffer.from(m.name, "utf-8");
  const payload = m.stored ? m.bytes : deflateRawSync(m.bytes);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags — sizes are in THIS header
  head.writeUInt16LE(m.stored ? 0 : 8, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt32LE(0, 14); // crc32 — not validated by the walker
  head.writeUInt32LE(payload.length, 18);
  head.writeUInt32LE(m.bytes.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name, payload]);
}

/** A ZIP with the members in the given order, terminated by a CD signature. */
function zip(...members: Member[]): Buffer {
  const end = Buffer.alloc(4);
  end.writeUInt32LE(0x02014b50, 0); // central directory — ends the walk
  return Buffer.concat([...members.map(localHeader), end]);
}

/** A PDF of roughly `size` bytes, with a real `%PDF-1.7` header. */
function pdf(size: number, tag = "x"): Buffer {
  const head = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n");
  const body = Buffer.alloc(Math.max(0, size - head.length), tag);
  return Buffer.concat([head, body, Buffer.from("\n%%EOF\n")]);
}

/** NSE's announcement sidecar, verbatim in shape. */
const NSE_XML_SIDECAR = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>\n<Announcement><Symbol>AERON</Symbol></Announcement>\n`,
  "utf-8",
);

/* -------------------------------------------------------------------------- */
/* 1. The ordering                                                             */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: a STORED PDF member hides a %PDF header inside the scan window", () => {
  // Reproduces stocks/AERON/announcement/AERON-announcement-2026.pdf.
  const aeron = zip(
    { name: "RESIGNATION_LETTER_CCP_1.pdf", bytes: pdf(600), stored: true },
    { name: "ROID_112233_WebXMLFile_20260101.xml", bytes: NSE_XML_SIDECAR },
  );

  it("the contained %PDF-1.x header really IS inside the 1 KB window", () => {
    // Without this, the ordering assertion below would pass for the wrong
    // reason — a fixture whose PDF header sits past byte 1024 cannot be
    // mis-sniffed no matter what order the tests are in.
    const at = aeron.subarray(0, 1024).toString("latin1").indexOf("%PDF-");
    assert.ok(
      at > 0 && at < 1024,
      `fixture must carry %PDF- inside the window (found at ${at})`,
    );
  });

  it("the archive is still classified `zip`, not `pdf`", () => {
    // MUTATION: hoist the `%PDF-\\d` scan above the ZIP magics in
    // sniffDocumentContainer and this goes RED.
    assert.equal(sniffDocumentContainer(aeron), "zip");
  });

  it("openDocumentZip selects the PDF and NOT the XML sidecar", () => {
    const member = openDocumentZip(aeron);
    assert.ok(member, "the archive must yield a document");
    assert.equal(member.name, "RESIGNATION_LETTER_CCP_1.pdf");
    assert.equal(member.memberCount, 2);
    assert.equal(member.mimeType, CANONICAL_PDF_MIME_TYPE);
    assert.equal(member.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The sidecar, and why position cannot be the rule                         */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: member selection is by BYTES, never by position or name", () => {
  it("the SIDECAR FIRST still yields the PDF", () => {
    // MUTATION: replace the scan in selectZipDocumentMember with
    // `entries[0]` and this goes RED while the sidecar-second case above
    // stays green — which is precisely why this fixture exists.
    const archive = zip(
      { name: "ROID_1_WebXMLFile.xml", bytes: NSE_XML_SIDECAR },
      { name: "RESIGNATION_LETTER_CCP_1.pdf", bytes: pdf(900) },
    );
    const member = openDocumentZip(archive);
    assert.equal(member?.name, "RESIGNATION_LETTER_CCP_1.pdf");
  });

  it("a member NAMED .pdf whose bytes are XML is not eligible", () => {
    // The trap one layer in: an upstream that names its sidecar `.pdf` breaks
    // every name-keyed rule silently, in the direction that stores the wrong
    // document.
    const archive = zip(
      { name: "metadata.pdf", bytes: NSE_XML_SIDECAR },
      { name: "AR_23907_ACCELYA_2022_2023.bin", bytes: pdf(4000) },
    );
    const member = openDocumentZip(archive);
    assert.equal(member?.name, "AR_23907_ACCELYA_2022_2023.bin");
  });

  it("the LARGEST PDF wins — the cover letter is not the filing", () => {
    const archive = zip(
      { name: "cover-letter.pdf", bytes: pdf(300) },
      { name: "annual-report.pdf", bytes: pdf(9000) },
      { name: "ack-slip.pdf", bytes: pdf(200) },
    );
    assert.equal(openDocumentZip(archive)?.name, "annual-report.pdf");
  });

  it("equal sizes tie-break on NAME, so a re-run extracts the same text", () => {
    const a = pdf(1500, "a");
    const b = pdf(1500, "b");
    assert.equal(a.length, b.length, "fixture sizes must match");
    assert.equal(
      openDocumentZip(
        zip({ name: "b.pdf", bytes: b }, { name: "a.pdf", bytes: a }),
      )?.name,
      "a.pdf",
    );
    assert.equal(
      openDocumentZip(
        zip({ name: "a.pdf", bytes: a }, { name: "b.pdf", bytes: b }),
      )?.name,
      "a.pdf",
      "selection must not depend on archive ordering",
    );
  });

  it("macOS resource forks and directory entries are never candidates", () => {
    const archive = zip(
      { name: "__MACOSX/._report.pdf", bytes: pdf(50_000) },
      { name: "reports/", bytes: Buffer.alloc(0) },
      { name: ".DS_Store", bytes: pdf(40_000) },
      { name: "reports/report.pdf", bytes: pdf(1200) },
    );
    assert.equal(openDocumentZip(archive)?.name, "reports/report.pdf");
  });

  it("an archive with NO document member is null, never a guess", () => {
    const archive = zip(
      { name: "ROID_1_WebXMLFile.xml", bytes: NSE_XML_SIDECAR },
      { name: "notes.txt", bytes: Buffer.from("no document here", "utf-8") },
    );
    assert.equal(openDocumentZip(archive), null);
  });

  it("a nested ZIP is not unwrapped — it is simply not eligible", () => {
    const inner = zip({ name: "real.pdf", bytes: pdf(800) });
    const outer = zip({ name: "bundle.zip", bytes: inner });
    assert.equal(openDocumentZip(outer), null);
  });

  it("bytes that are not a ZIP at all yield null", () => {
    assert.equal(openDocumentZip(pdf(2000)), null);
    assert.equal(openDocumentZip(Buffer.alloc(0)), null);
    assert.equal(openDocumentZip(Buffer.from("not a zip", "utf-8")), null);
  });

  it("selectZipDocumentMember is the pure half and agrees with openDocumentZip", () => {
    const archive = zip(
      { name: "ROID_1_WebXMLFile.xml", bytes: NSE_XML_SIDECAR },
      { name: "filing.pdf", bytes: pdf(2400) },
    );
    const entries = unzipEntries(archive);
    assert.ok(entries);
    assert.equal(
      selectZipDocumentMember(entries)?.name,
      openDocumentZip(archive)?.name,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. resolveStoredMimeType — the header lies in BOTH directions               */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: the stored mimeType comes from the BYTES", () => {
  it("header says PDF, bytes are a ZIP -> application/zip", () => {
    // The exact shape that produced 172 mis-typed rows: NSE serves a bundle and
    // the writer stamped `application/pdf` regardless.
    assert.equal(
      resolveStoredMimeType({
        body: zip({ name: "f.pdf", bytes: pdf(1000) }),
        contentType: "application/pdf",
      }),
      ZIP_MIME_TYPE,
    );
  });

  it("header says text/html, bytes ARE a PDF -> application/pdf", () => {
    // The other ten prod rows. A header-keyed rule CONDEMNS these — it would
    // blank the gcsPath of ten documents we actually hold.
    assert.equal(
      resolveStoredMimeType({
        body: pdf(2000),
        contentType: "text/html; charset=UTF-8",
      }),
      CANONICAL_PDF_MIME_TYPE,
    );
  });

  it("header says PDF, bytes are an HTML page -> text/html", () => {
    assert.equal(
      resolveStoredMimeType({
        body: Buffer.from(
          "<!DOCTYPE html><html><head><title>Access Denied</title></head></html>",
          "utf-8",
        ),
        contentType: "application/pdf",
      }),
      "text/html",
    );
  });

  it("a parameterised PDF header over a PDF still normalises", () => {
    assert.equal(
      resolveStoredMimeType({
        body: pdf(1200),
        contentType: "application/pdf;charset=UTF-8",
      }),
      CANONICAL_PDF_MIME_TYPE,
      "MONEY-1255: the stored value must be one the extract query can match",
    );
  });

  it("UNIDENTIFIABLE bytes fall back to the HEADER, not to octet-stream", () => {
    // Narrowing a loose rule with no catch-all shrinks coverage:
    // `application/octet-stream` is not extractable, so this row would leave
    // the queue with nothing said about it.
    const opaque = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    assert.equal(sniffDocumentContainer(opaque), "unknown");
    assert.equal(
      resolveStoredMimeType({ body: opaque, contentType: "application/pdf" }),
      CANONICAL_PDF_MIME_TYPE,
    );
    assert.equal(
      resolveStoredMimeType({
        body: opaque,
        contentType: "text/plain",
        undecidable: "trust-header",
      }),
      "text/plain",
      "the OPT-IN policy still lets an honest header decide — this is " +
        "`storeScreenerDoc`'s pre-existing MONEY-1255 behaviour",
    );
  });

  /* ---------------------------------------------------------------------- */
  /* M8 — an uncorroborated header may REFINE but never CONDEMN              */
  /* ---------------------------------------------------------------------- */

  it("DEFAULT: a non-extractable header over undecidable bytes does NOT condemn", () => {
    // The MONEY-1319 review finding. Three of the four converted writers pass a
    // REAL header, and all three previously hardcoded `application/pdf` +
    // `PENDING`. Under a plain header fallback, a body the 1 KB sniff cannot
    // classify plus a `text/plain` / `application/octet-stream` header lands
    // the row in TERMINAL `UNSUPPORTED` — which nothing re-selects
    // (`planContainerRepair` says `none` for `unknown`, `force` re-opens only
    // FAILED). Prod holds 4,367 `text/plain`, 1,666 `text/html` and 1,622
    // `application/json` rows, so non-PDF headers demonstrably occur.
    const opaque = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    assert.equal(sniffDocumentContainer(opaque), "unknown", "CEILING");

    for (const header of [
      "text/plain",
      "text/html; charset=UTF-8",
      "application/json",
      "application/octet-stream",
    ]) {
      const mime = resolveStoredMimeType({ body: opaque, contentType: header });
      assert.equal(
        mime,
        CANONICAL_PDF_MIME_TYPE,
        `${header} must not decide the type over bytes nobody identified`,
      );
      assert.equal(
        initialProcessingStatus(mime),
        "PENDING",
        `${header} must not move the row to a terminal status`,
      );
      // ...and the OPT-IN is what the one leg that means it asks for.
      assert.equal(
        initialProcessingStatus(
          resolveStoredMimeType({
            body: opaque,
            contentType: header,
            undecidable: "trust-header",
          }),
        ),
        "UNSUPPORTED",
        "CONTROL: the opposite policy DOES condemn, so the default is doing work",
      );
    }
  });

  it("DEFAULT: an EXTRACTABLE header over undecidable bytes is still honoured", () => {
    // Refine, do not condemn. An upstream that says `application/zip` over
    // bytes we could not classify is telling us something useful, and the
    // extract lane can act on it — so it is kept. Only a type that would take
    // the row OUT of the queue is refused.
    const opaque = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    assert.equal(
      resolveStoredMimeType({ body: opaque, contentType: ZIP_MIME_TYPE }),
      ZIP_MIME_TYPE,
    );
    assert.equal(
      resolveStoredMimeType({
        body: opaque,
        contentType: "application/pdf;charset=UTF-8",
      }),
      CANONICAL_PDF_MIME_TYPE,
    );
  });

  it("a POSITIVE identification ignores the policy entirely", () => {
    // The asymmetry: the policy governs only the DECLINE. Bytes that say what
    // they are win under both settings, in both directions.
    const cases: ReadonlyArray<[Buffer, string]> = [
      [pdf(2000), CANONICAL_PDF_MIME_TYPE],
      [zip({ name: "a.pdf", bytes: pdf(500) }), ZIP_MIME_TYPE],
      [
        Buffer.from("<!DOCTYPE html><html><head></head></html>", "utf-8"),
        "text/html",
      ],
    ];
    for (const [body, expected] of cases) {
      for (const undecidable of ["stay-queued", "trust-header"] as const) {
        assert.equal(
          resolveStoredMimeType({
            body,
            contentType: "application/octet-stream",
            undecidable,
          }),
          expected,
        );
      }
    }
  });

  it("with NO header the two policies are indistinguishable", () => {
    // Which is what makes the migration script (`resolveStoredMimeType({body})`)
    // provably unaffected by the choice, and what the docblock's "no-op"
    // sentence can honestly claim.
    const opaque = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]);
    for (const undecidable of ["stay-queued", "trust-header"] as const) {
      assert.equal(
        resolveStoredMimeType({ body: opaque, undecidable }),
        CANONICAL_PDF_MIME_TYPE,
      );
      assert.equal(
        resolveStoredMimeType({ body: opaque, contentType: "", undecidable }),
        CANONICAL_PDF_MIME_TYPE,
      );
    }
  });

  it("unidentifiable bytes with NO header reproduce the old literal exactly", () => {
    // The writers' previous behaviour was `mimeType: "application/pdf"`. For
    // bytes nobody can identify this function must be a NO-OP on that, or the
    // change is not "bytes decide", it is "coverage shrinks".
    const opaque = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]);
    assert.equal(
      resolveStoredMimeType({ body: opaque }),
      CANONICAL_PDF_MIME_TYPE,
    );
    assert.equal(
      resolveStoredMimeType({ body: opaque, contentType: null }),
      CANONICAL_PDF_MIME_TYPE,
    );
  });

  it("every value it can produce for a real document is one the query matches", () => {
    for (const body of [pdf(1000), zip({ name: "a.pdf", bytes: pdf(500) })]) {
      const mime = resolveStoredMimeType({ body });
      assert.ok(
        isExtractableDocMimeType(mime),
        `${mime} must be selectable by buildExtractQuery`,
      );
      assert.equal(initialProcessingStatus(mime), "PENDING");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The queue: a ZIP is extractable now, and only now                        */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: application/zip joined EXTRACTABLE_DOC_MIME_TYPES", () => {
  it("both a PDF and a ZIP are selectable", () => {
    assert.ok(EXTRACTABLE_DOC_MIME_TYPES.includes(CANONICAL_PDF_MIME_TYPE));
    assert.ok(EXTRACTABLE_DOC_MIME_TYPES.includes(ZIP_MIME_TYPE));
  });

  it("a freshly-stored ZIP is created PENDING, not UNSUPPORTED", () => {
    assert.equal(initialProcessingStatus(ZIP_MIME_TYPE), "PENDING");
  });

  it("HTML and audio are still terminal", () => {
    assert.equal(initialProcessingStatus("text/html"), "UNSUPPORTED");
    assert.equal(initialProcessingStatus("audio/mpeg"), "UNSUPPORTED");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The repair plan re-queues, or the re-type loses the document             */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319: planContainerRepair re-queues a re-typed row", () => {
  it("a FAILED row re-typed to application/zip returns to PENDING", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/pdf",
      container: "zip",
      storedProcessingStatus: "FAILED",
    });
    assert.equal(plan.action, "retype");
    assert.equal(plan.mimeType, ZIP_MIME_TYPE);
    assert.equal(
      plan.processingStatus,
      "PENDING",
      "126 of 179 rows are FAILED, and FAILED is only re-selected under force",
    );
  });

  it("an UNSUPPORTED row re-typed to a readable container is re-queued too", () => {
    assert.equal(
      planContainerRepair({
        storedMimeType: "text/html",
        container: "pdf",
        storedProcessingStatus: "UNSUPPORTED",
      }).processingStatus,
      "PENDING",
    );
  });

  it("READY is NEVER disturbed — the row already has its text", () => {
    assert.equal(
      planContainerRepair({
        storedMimeType: "application/pdf",
        container: "zip",
        storedProcessingStatus: "READY",
      }).processingStatus,
      null,
    );
  });

  it("PROCESSING is NEVER disturbed — another run has claimed it", () => {
    assert.equal(
      planContainerRepair({
        storedMimeType: "application/pdf",
        container: "zip",
        storedProcessingStatus: "PROCESSING",
      }).processingStatus,
      null,
    );
  });

  it("a correctly-typed FAILED PDF is NOT re-queued — nothing changed", () => {
    // THE 5,356-ROW FINDING. The first version of this rule re-queued every
    // correctly-typed `application/pdf` row sitting FAILED — 5,356 over
    // `--doc-type annual_report` alone on the prod dry run. Those failed on
    // their own merits (a scanned image, an encrypted PDF, a truncated
    // download); nothing about them changed, so re-queueing feeds the lane
    // thousands of guaranteed failures per cycle.
    const plan = planContainerRepair({
      storedMimeType: "application/pdf",
      container: "pdf",
      storedProcessingStatus: "FAILED",
    });
    assert.equal(plan.action, "none");
    assert.equal(plan.processingStatus, null);
  });

  it("a correctly-typed UNSUPPORTED ZIP IS re-queued — readability changed", () => {
    // 13 prod rows are honestly `application/zip` and terminally
    // `UNSUPPORTED`, which was the CORRECT verdict while nothing could open an
    // archive. Unzip support alone does not move them: no query selects a
    // terminal row, so the capability would arrive and they would stay put.
    const plan = planContainerRepair({
      storedMimeType: "application/zip",
      container: "zip",
      storedProcessingStatus: "UNSUPPORTED",
    });
    assert.equal(plan.action, "requeue");
    assert.equal(plan.mimeType, ZIP_MIME_TYPE, "the column is already right");
    assert.equal(plan.processingStatus, "PENDING");
  });

  it("an already-PENDING row is never rewritten to PENDING", () => {
    // A write that changes nothing still inflates the run's report, and this
    // one would have covered ~44,000 rows.
    for (const container of ["pdf", "zip"] as const) {
      assert.equal(
        planContainerRepair({
          storedMimeType: mimeTypeForContainer(container),
          container,
          storedProcessingStatus: "PENDING",
        }).processingStatus,
        null,
      );
    }
  });

  it("a re-type onto a type the lane CANNOT read does not re-queue", () => {
    assert.equal(
      planContainerRepair({
        storedMimeType: "application/pdf",
        container: "audio",
        storedProcessingStatus: "FAILED",
      }).processingStatus,
      null,
    );
  });

  it("a caller that does not KNOW the status must not move the row", () => {
    // Omitting the argument means "do not re-queue". The one status a guess
    // could silently destroy is READY.
    assert.equal(
      planContainerRepair({
        storedMimeType: "application/pdf",
        container: "zip",
      }).processingStatus,
      null,
    );
  });

  it("refetch and none carry no status change", () => {
    for (const container of ["zeroed", "empty", "html", "unknown"] as const) {
      assert.equal(
        planContainerRepair({
          storedMimeType: "application/pdf",
          container,
          storedProcessingStatus: "FAILED",
        }).processingStatus,
        null,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. M2 — the inflate is BOUNDED. A 611 KB archive expanded to 1.2 GB of RSS  */
/* -------------------------------------------------------------------------- */

/**
 * A local header whose DECLARED uncompressed size is whatever you say it is.
 *
 * The walker has two independent bounds and only a fixture that can lie
 * separates them: an honest declaration is refused BEFORE any inflate, and a
 * declaration of 0 (what a data descriptor leaves, and what a hostile archive
 * writes) has to be caught by `maxOutputLength` on the inflate itself.
 */
function memberWithDeclaredSize(
  name: string,
  payload: Buffer,
  declaredSize: number,
): Buffer {
  const nameBuf = Buffer.from(name, "utf-8");
  const deflated = deflateRawSync(payload);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6); // flags 0 — sizes are in THIS header
  head.writeUInt16LE(8, 8); // DEFLATE
  head.writeUInt32LE(deflated.length, 18);
  head.writeUInt32LE(declaredSize, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf, deflated]);
}

function archiveOf(...members: Buffer[]): Buffer {
  const end = Buffer.alloc(4);
  end.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([...members, end]);
}

describe("MONEY-1319 M2: unzipEntries refuses a bomb rather than inflating it", () => {
  it("an HONESTLY declared oversize member is refused BEFORE the inflate", () => {
    // The payload is a tiny, perfectly valid deflate stream — so WITHOUT the
    // declared-size pre-check this archive parses fine and returns one entry.
    // That is what makes this fixture a discriminator rather than a
    // coincidence: it can only fail for the reason under test.
    const archive = archiveOf(
      memberWithDeclaredSize("huge.bin", pdf(500), MAX_ZIP_MEMBER_BYTES + 1),
    );
    assert.equal(
      unzipEntries(archive),
      null,
      "a member declaring more than the per-member ceiling must be refused",
    );

    // CONTROL: the same archive declaring a size UNDER the ceiling is accepted,
    // so the refusal is the declaration and not the fixture's shape.
    const ok = archiveOf(
      memberWithDeclaredSize("fine.bin", pdf(500), MAX_ZIP_MEMBER_BYTES - 1),
    );
    const entries = unzipEntries(ok);
    assert.ok(entries, "CONTROL: an under-ceiling declaration must parse");
    assert.equal(entries.length, 1);
  });

  it("a LYING header is caught by maxOutputLength on the inflate", () => {
    // `declaredSize: 0` is exactly what a bit-3 data descriptor leaves behind,
    // so the pre-check above cannot act on it — this is the second, independent
    // bound, and it is the one that stops the measured 611 KB -> 1.2 GB case.
    const bomb = Buffer.alloc(64 * 1024, 0); // deflates to a few hundred bytes
    const archive = archiveOf(memberWithDeclaredSize("liar.bin", bomb, 0));

    assert.ok(
      deflateRawSync(bomb).length < 1024,
      "CEILING: the fixture must actually be a high-ratio stream, or this " +
        "test is asserting nothing about expansion",
    );
    assert.equal(
      unzipEntries(archive, { maxMemberBytes: 1024 }),
      null,
      "the inflate must stop at the ceiling, not after materialising 64 KB",
    );

    // CONTROL: the identical archive under a ceiling that FITS is accepted, so
    // the refusal is the bound and not the lie.
    const entries = unzipEntries(archive, { maxMemberBytes: 128 * 1024 });
    assert.ok(entries);
    assert.equal(entries[0]!.bytes.length, bomb.length);
  });

  it("MANY members under the per-member bound are refused on the TOTAL", () => {
    // The hole a per-member bound alone leaves, and the reason the total exists:
    // this walker inflates EVERY member before a caller selects one, so twenty
    // members each individually acceptable are still 1.2 GB together.
    const member = (n: number): Buffer =>
      memberWithDeclaredSize(`m${n}.bin`, Buffer.alloc(4096, 0x41), 4096);
    const archive = archiveOf(member(1), member(2), member(3));

    assert.equal(
      unzipEntries(archive, { maxMemberBytes: 8192, maxTotalBytes: 10_000 }),
      null,
      "3 x 4 KB is 12 KB — over the whole-archive ceiling, under the member one",
    );

    const entries = unzipEntries(archive, {
      maxMemberBytes: 8192,
      maxTotalBytes: 16_384,
    });
    assert.ok(entries, "CONTROL: the same members fit under a larger total");
    assert.equal(entries.length, 3);
  });

  it("the DOCUMENT lane refuses a bomb too — openDocumentZip returns null", () => {
    // The bound has to hold at the entry point `stock-document-extract`
    // actually calls, on the DEFAULT limits, or it is a property of a test-only
    // argument. A declared-oversize member reaches that verdict with a few
    // hundred bytes of fixture.
    const archive = archiveOf(
      memberWithDeclaredSize("ar.pdf", pdf(800), MAX_ZIP_MEMBER_BYTES + 1),
    );
    assert.equal(openDocumentZip(archive), null);

    // CONTROL: a real NSE bundle is still opened under the same defaults — the
    // bound must not be a refusal of ordinary documents wearing a safety jacket.
    const real = zip(
      { name: "AR_23907_ACCELYA_2023.pdf", bytes: pdf(4000) },
      { name: "ROID_1_WebXMLFile.xml", bytes: NSE_XML_SIDECAR },
    );
    const member = openDocumentZip(real);
    assert.ok(member);
    assert.equal(member.name, "AR_23907_ACCELYA_2023.pdf");
  });

  it("the defaults sit ABOVE every consumer and BELOW the OOM", () => {
    // A bound that refuses a real document is a data-loss bug. The largest
    // thing any consumer will take is `gemini-pdf.ts`'s MAX_PDF_BYTES (50 MiB);
    // the largest ZIP member measured on prod is ACCELYA's 1.75 MB.
    assert.ok(
      MAX_ZIP_MEMBER_BYTES >= 50 * 1024 * 1024,
      "below 50 MiB the bound would refuse members a reader would have taken",
    );
    assert.ok(
      MAX_ZIP_TOTAL_BYTES >= MAX_ZIP_MEMBER_BYTES,
      "a total below the per-member bound makes the per-member one unreachable",
    );
    assert.ok(
      MAX_ZIP_TOTAL_BYTES < 1024 * 1024 * 1024,
      "the measured OOM was 1.2 GB resident in a 1 GiB container — a ceiling " +
        "at or above that protects nothing",
    );
  });

  it("still returns null for the non-bomb failures it always did", () => {
    // CONTROL for the whole section: the new bounds must not have turned an
    // ordinary "these are not the bytes you think" into something else.
    assert.equal(unzipEntries(Buffer.from("not a zip at all")), null);
    assert.equal(unzipEntries(Buffer.alloc(0)), null);
    assert.equal(unzipEntries(Buffer.from("PK\x03\x04")), null);
  });
});
