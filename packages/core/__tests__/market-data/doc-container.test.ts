/**
 * UNIT TEST — document container sniffing (MONEY-1319).
 *
 * The load-bearing cases, in order of what they protect:
 *
 *   1. **A ZIP is a container, not a verdict.** All 179 non-`%PDF` `.pdf` keys
 *      on prod are ZIPs from `nsearchives.nseindia.com`, and every one holds a
 *      real document (`ACCELYA-annual_report-FY2023.pdf` → a 1,752,887-byte
 *      `AR_23907_ACCELYA_…pdf`). The plan for them must be `retype`, never
 *      anything that clears the row — the enrichment pipeline never revisits a
 *      cleared row, so a false "not a document" loses 172 annual reports with
 *      no path back.
 *   2. **`%PDF` is not always at offset 0.** `ANIKINDS-annual_report-FY2011`
 *      begins with a newline. A strict offset-0 magic test — which is what the
 *      archive audit uses, correctly, for a different question — calls that
 *      readable annual report invalid.
 *   3. **All-NUL is its own finding.** Six annual reports are 11–20 MB of NUL
 *      with no `%PDF` in the first megabyte. That is `refetch`, and collapsing
 *      it into `unknown` would hide the only class here that cannot be
 *      recovered from the bytes we hold.
 *   4. **Ordering of the frame-sync test.** The MPEG rule matches `0xFF` plus
 *      three set bits and will swallow arbitrary binary. Every structured
 *      format must be decided before it; this file fails if that order is
 *      reversed.
 *
 * The byte patterns are not invented: each reproduces the leading bytes dumped
 * from the named prod object on 2026-09-02.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sniffDocumentContainer,
  planContainerRepair,
  mimeTypeForContainer,
  PDF_HEADER_SCAN_BYTES,
  type DocumentContainer,
} from "../../src/market-data/doc-container";

const buf = (s: string): Buffer => Buffer.from(s, "latin1");
const bytes = (...b: number[]): Buffer => Buffer.from(b);

describe("sniffDocumentContainer — PDFs", () => {
  it("recognises %PDF at offset 0", () => {
    assert.equal(sniffDocumentContainer(buf("%PDF-1.7\n1 0 obj")), "pdf");
  });

  it("recognises %PDF at a NON-ZERO offset (ANIKINDS-annual_report-FY2011)", () => {
    // Verbatim leading bytes from prod: 0a 25 50 44 46 2d 31 2e 36 …
    const head = Buffer.concat([
      bytes(0x0a),
      buf("%PDF-1.6\r%\xe2\xe3\xcf\xd3\r\n294 0 obj"),
    ]);
    assert.equal(sniffDocumentContainer(head), "pdf");
  });

  it("finds %PDF anywhere inside the scan window", () => {
    const head = Buffer.concat([
      Buffer.alloc(PDF_HEADER_SCAN_BYTES - 16, 0x20),
      buf("%PDF-1.4"),
    ]);
    assert.equal(sniffDocumentContainer(head), "pdf");
  });

  it("does NOT find a %PDF that begins beyond the scan window", () => {
    const head = Buffer.concat([
      Buffer.alloc(PDF_HEADER_SCAN_BYTES + 8, 0x20),
      buf("%PDF-1.4"),
    ]);
    assert.notEqual(sniffDocumentContainer(head), "pdf");
  });
});

describe("sniffDocumentContainer — ZIP", () => {
  it("recognises an NSE annual-report bundle (ACCELYA)", () => {
    // PK\x03\x04 then the local header, then the first entry name.
    const head = Buffer.concat([
      bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00),
      buf("AR_23907_ACCELYA_2022_2023_22092023182015.pdf"),
    ]);
    assert.equal(sniffDocumentContainer(head), "zip");
  });

  it("recognises an NSE announcement bundle (AERON)", () => {
    const head = Buffer.concat([
      bytes(0x50, 0x4b, 0x03, 0x04),
      buf("RESIGNATION_LETTER_CCP_1.pdf"),
    ]);
    assert.equal(sniffDocumentContainer(head), "zip");
  });

  it("recognises an empty archive and a spanned archive", () => {
    assert.equal(
      sniffDocumentContainer(bytes(0x50, 0x4b, 0x05, 0x06, 0)),
      "zip",
    );
    assert.equal(
      sniffDocumentContainer(bytes(0x50, 0x4b, 0x07, 0x08, 0)),
      "zip",
    );
  });

  it("does not call a bare 'PK' prefix a zip", () => {
    assert.notEqual(sniffDocumentContainer(buf("PKG-INFO: something")), "zip");
  });
});

describe("sniffDocumentContainer — audio, html, zeroed, empty", () => {
  it("recognises an ID3-tagged MP3", () => {
    assert.equal(
      sniffDocumentContainer(
        Buffer.concat([buf("ID3"), bytes(0x03, 0x00, 0x00)]),
      ),
      "audio",
    );
  });

  it("recognises a bare MPEG frame sync", () => {
    assert.equal(
      sniffDocumentContainer(bytes(0xff, 0xfb, 0x90, 0x00)),
      "audio",
    );
  });

  it("recognises the BSE/Akamai 'Access Denied' page", () => {
    assert.equal(
      sniffDocumentContainer(
        buf("<HTML><HEAD> <TITLE>Access Denied</TITLE> </HEAD><BODY>"),
      ),
      "html",
    );
  });

  it("recognises a doctype-led page with leading whitespace", () => {
    assert.equal(
      sniffDocumentContainer(buf("\n  <!DOCTYPE html><html>")),
      "html",
    );
  });

  it("recognises a page behind a real UTF-8 BOM (EF BB BF), not a literal U+FEFF", () => {
    // The BOM must be skipped at the BYTE level: decoded as latin1 it renders
    // as `ï»¿`, so a regex written with a literal U+FEFF strips nothing.
    const head = Buffer.concat([
      bytes(0xef, 0xbb, 0xbf),
      buf("<!DOCTYPE html><html>"),
    ]);
    assert.equal(sniffDocumentContainer(head), "html");
  });

  it("reports an all-NUL head as `zeroed`, distinct from `unknown`", () => {
    assert.equal(sniffDocumentContainer(Buffer.alloc(4096, 0)), "zeroed");
  });

  it("reports zero bytes as `empty`, distinct from `zeroed`", () => {
    assert.equal(sniffDocumentContainer(Buffer.alloc(0)), "empty");
  });

  it("reports unrecognised binary as `unknown`, not as audio", () => {
    assert.equal(
      sniffDocumentContainer(bytes(0x01, 0x02, 0x03, 0x04, 0x05)),
      "unknown",
    );
  });
});

describe("sniffDocumentContainer — the cost of the widened PDF scan", () => {
  // Scanning a 1 KB window instead of offset 0 is what makes ANIKINDS
  // readable. These pin the price of that: four ASCII bytes occurring by
  // chance inside binary must NOT be read as a PDF header.
  it("requires the version digit — a bare '%PDF' is not a header", () => {
    assert.notEqual(
      sniffDocumentContainer(buf("some text mentioning %PDF here")),
      "pdf",
    );
  });

  it("an MP3 whose ID3 text happens to contain '%PDF' is still audio", () => {
    const head = Buffer.concat([
      buf("ID3"),
      bytes(0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21),
      buf("COMM converted from %PDF by a tool"),
    ]);
    assert.equal(sniffDocumentContainer(head), "audio");
  });

  it("accepts both PDF generations (%PDF-1.x and %PDF-2.x)", () => {
    assert.equal(sniffDocumentContainer(buf("%PDF-1.4\n")), "pdf");
    assert.equal(sniffDocumentContainer(buf("%PDF-2.0\n")), "pdf");
  });

  it("real prod audio leading bytes are classified as audio", () => {
    // Verbatim first bytes from prod 2026-09-02.
    assert.equal(
      sniffDocumentContainer(bytes(0xff, 0xe3, 0x28, 0xc4, 0x00, 0x19)),
      "audio",
    ); // GESHIP
    assert.equal(
      sniffDocumentContainer(bytes(0xff, 0xfb, 0x90, 0xc4, 0x00, 0x00)),
      "audio",
    ); // PREMEXPLN
  });
});

describe("sniffDocumentContainer — offset-0 magics beat the PDF window scan", () => {
  // REGRESSION, MONEY-1319. Found by running the repair script against prod,
  // not by review: 38 unit tests were green while this was wrong.
  //
  // stocks/AERON/announcement/AERON-announcement-2026.pdf is a ZIP whose first
  // entry (RESIGNATION_LETTER_CCP_1.pdf) is STORED rather than deflated, so the
  // contained PDF's own header sits ~40 bytes into the object — inside the scan
  // window. With the window scan first it was reported `pdf`, and the repair
  // plan proposed overwriting a CORRECT `application/zip` with
  // `application/pdf`. A magic at offset 0 describes the whole object; a token
  // found in a window does not.
  it("a ZIP containing a STORED pdf is a zip, not a pdf (AERON)", () => {
    const head = Buffer.concat([
      bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00),
      buf("RESIGNATION_LETTER_CCP_1.pdf"),
      buf("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n1 0 obj"),
    ]);
    assert.equal(sniffDocumentContainer(head), "zip");
  });

  it("an ID3 tag whose payload contains a real PDF header is still audio", () => {
    const head = Buffer.concat([
      buf("ID3"),
      bytes(0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40),
      buf("TIT2 recording of %PDF-1.4 walkthrough"),
    ]);
    assert.equal(sniffDocumentContainer(head), "audio");
  });

  it("a bare PDF is still detected once the container magics decline", () => {
    assert.equal(sniffDocumentContainer(buf("%PDF-1.7\n1 0 obj")), "pdf");
  });
});

describe("sniffDocumentContainer — `zeroed` is decided before `unknown`", () => {
  it("an all-NUL head is `zeroed`, never `unknown`", () => {
    assert.equal(sniffDocumentContainer(Buffer.alloc(64, 0)), "zeroed");
  });

  it("a head that is mostly but not entirely NUL is `unknown`, not `zeroed`", () => {
    const head = Buffer.alloc(64, 0);
    head[63] = 0x7f;
    assert.equal(sniffDocumentContainer(head), "unknown");
  });
});

describe("mimeTypeForContainer", () => {
  const cases: ReadonlyArray<[DocumentContainer, string]> = [
    ["pdf", "application/pdf"],
    ["zip", "application/zip"],
    ["audio", "audio/mpeg"],
    ["html", "text/html"],
    ["zeroed", "application/octet-stream"],
    ["unknown", "application/octet-stream"],
    ["empty", "application/octet-stream"],
  ];
  for (const [container, mime] of cases) {
    it(`${container} → ${mime}`, () => {
      assert.equal(mimeTypeForContainer(container), mime);
    });
  }
});

describe("planContainerRepair", () => {
  it("RETYPES the 172 NSE annual reports — never clears them", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/pdf",
      container: "zip",
    });
    assert.equal(plan.action, "retype");
    assert.equal(plan.mimeType, "application/zip");
    assert.match(plan.reason, /bytes are zip/);
  });

  it("leaves an honestly-typed zip alone (the 7 announcements)", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/zip",
      container: "zip",
    });
    assert.equal(plan.action, "none");
  });

  it("retypes an audio recording stored as a pdf", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/pdf",
      container: "audio",
    });
    assert.equal(plan.action, "retype");
    assert.equal(plan.mimeType, "audio/mpeg");
  });

  it("calls the all-NUL annual reports `refetch`, and does not retype them", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/pdf",
      container: "zeroed",
    });
    assert.equal(plan.action, "refetch");
    // The column must NOT be rewritten to octet-stream — the row still wants
    // to be a PDF; it is the bytes that are missing.
    assert.equal(plan.mimeType, "application/pdf");
  });

  it("calls a zero-length object `refetch`", () => {
    assert.equal(
      planContainerRepair({
        storedMimeType: "application/pdf",
        container: "empty",
      }).action,
      "refetch",
    );
  });

  it("defers HTML to the MONEY-1315 body guard rather than issuing a verdict", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/pdf",
      container: "html",
    });
    assert.equal(plan.action, "none");
  });

  it("defers `unknown` rather than guessing", () => {
    assert.equal(
      planContainerRepair({
        storedMimeType: "application/pdf",
        container: "unknown",
      }).action,
      "none",
    );
  });

  it("normalises the stored type before comparing, so a parameterised pdf is `none`", () => {
    const plan = planContainerRepair({
      storedMimeType: "application/pdf;charset=UTF-8",
      container: "pdf",
    });
    assert.equal(plan.action, "none");
  });

  it("treats an absent stored type as the schema default rather than throwing", () => {
    assert.equal(
      planContainerRepair({ storedMimeType: null, container: "pdf" }).action,
      "none",
    );
    assert.equal(
      planContainerRepair({ storedMimeType: undefined, container: "zip" })
        .action,
      "retype",
    );
  });
});
