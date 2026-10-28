/**
 * MONEY-1315 (B) — the writer must not store an HTML page as a document.
 *
 * ## The defect, measured
 *
 * Screener's Documents section links a DRHP to SEBI's HTML *landing page* for
 * the issue rather than to the prospectus PDF —
 * `https://www.sebi.gov.in/filings/public-issues/mar-2018/advitiya-trade-india-limited_38237.html`
 * — and the rating-agency links behave the same way. SEBI answers 200 with an
 * honest `text/html; charset=UTF-8`. On prod 2026-08-31, over 88,607
 * `stock_documents` rows:
 *
 *     mimeType     status        rows    docType         source
 *     text/html    UNSUPPORTED   1,580   credit_rating   841  SCREENER
 *                                        drhp            608  SCREENER
 *
 * `initialProcessingStatus` (MONEY-1255) DID fire — all 1,580 are correctly
 * `UNSUPPORTED`. What it never did was stop the WRITE: `inferExtension` took
 * the `text/` branch, named the object `.txt`, and `uploadToGCS` stored the web
 * page. Every one of those rows still carries a `gcsPath`, and `gcsPath` is the
 * column every reader takes as proof the bytes are there.
 *
 * ## What these cases pin
 *
 * Each drives the REAL exported `processStockDocumentSync` against injected
 * fakes — the `deps` defaults ARE the production path, so what runs here is
 * what the scheduler runs. Nothing opens a socket, a Pub/Sub client or a
 * database handle, and every sleep is injected, so there is nothing to orphan.
 *
 * The third case is the one a header-based guard structurally cannot reach: the
 * same landing page served under `application/pdf`. `normalizeDocMimeType`
 * would call that a PDF, `initialProcessingStatus` would say PENDING, and the
 * row would join the 44,912-deep extraction queue claiming a document that is a
 * web page. Only the BODY can answer it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processStockDocumentSync } from "../../src/processors/stock-document-sync";
import { describeSyncShortfall } from "../../src/processors/stock-document-sync-logic";
import type { StockDocumentSyncMessage } from "@usemoney/types/pubsub";

/* -------------------------------------------------------------------------- */
/* Byte fixtures                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The SEBI landing page, at a REALISTIC SIZE.
 *
 * The padding is load-bearing, not decoration. `MIN_DOC_BUFFER_BYTES` is 500
 * and both download paths reject anything smaller as junk BEFORE any guard
 * runs, so a terse fixture is refused by the size floor and every assertion
 * below would pass against a writer with no guard at all — the fixture would be
 * proving the wrong thing. The measured prod rows are 7,853–8,292 bytes
 * (`fileSize` on `stocks/GOYALALUM/drhp/…`, `stocks/AXITA/drhp/…`), so this is
 * built to ~8 KB.
 */
const SEBI_HTML = Buffer.from(
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>SEBI | AAA Technologies Limited - Prospectus</title></head>` +
    `<body><div class="page">Draft offer documents</div>` +
    `<div class="filler">${"SEBI filings navigation. ".repeat(320)}</div>` +
    `</body></html>`,
  "utf-8",
);

const REAL_PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"),
  Buffer.from("1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n", "latin1"),
  Buffer.alloc(4096, 0x20),
]);

/** The MONEY-1169 multipart envelope, as the broken uploader stored it. */
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

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const noSleep = async (): Promise<void> => {};

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const l = console.log;
  const w = console.warn;
  const e = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
    console.warn = w;
    console.error = e;
  }
}

interface Upsert {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** `instrument_mappings` + `stock_documents`, minimal but faithful. */
function makeDb(existingDoc: Record<string, unknown> | null = null) {
  const upserts: Upsert[] = [];
  const row = {
    id: "inst-1",
    symbol: "AAATECH",
    name: "AAA Technologies Ltd",
    exchange: "NSE",
    isin: "INE01AB01011",
    tickertapeSid: null,
  };
  return {
    upserts,
    instrumentMapping: {
      findMany: async () => [{ symbol: row.symbol, exchange: row.exchange }],
      findFirst: async () => ({
        id: row.id,
        exchange: row.exchange,
        tickertapeSid: row.tickertapeSid,
        name: row.name,
        isin: row.isin,
      }),
      update: async () => row,
      updateMany: async () => ({ count: 1 }),
    },
    stockDocument: {
      findUnique: async () => existingDoc,
      upsert: async (args: Upsert) => {
        upserts.push(args);
        return { id: "doc-1", ...args.create };
      },
    },
  };
}

/** A screener page carrying exactly one DRHP link — the measured shape. */
function pageWithDrhp() {
  return {
    symbol: "AAATECH",
    profitAndLoss: null,
    quarterlyResults: null,
    balanceSheet: null,
    cashFlows: null,
    ratios: null,
    compoundedGrowth: "",
    compoundedGrowthData: {
      salesGrowth: {},
      profitGrowth: {},
      stockPriceCagr: {},
      returnOnEquity: {},
    },
    shareholding: [],
    peers: [],
    documents: [
      {
        type: "drhp",
        title: "AAATECH DRHP",
        url: "https://www.sebi.gov.in/filings/public-issues/mar-2018/advitiya-trade-india-limited_38237.html",
        period: "IPO",
      },
    ],
    corporateActions: [],
    fullText: "",
  };
}

/**
 * The same page with NO documents, so the NSE cases below cannot be satisfied
 * by the Screener arm.
 *
 * Load-bearing rather than tidy: `runWith` drives BOTH legs, so an NSE case
 * that reused `pageWithDrhp()` would see `htmlRefusals: 2` and could be made to
 * pass by either arm. The whole point of these cases is that the NSE arm is
 * separately wired — every existing case in this file stubs
 * `fetchNSEFinancialResults: async () => []`, so a wiring defect at
 * `storeNSEFiling`'s guard would not have been caught by any of them.
 */
function pageWithNoDocuments(): ReturnType<typeof pageWithDrhp> {
  return { ...pageWithDrhp(), documents: [] };
}

/** One NSE quarterly-results filing carrying a PDF attachment. */
function nseFiling() {
  return {
    symbol: "AAATECH",
    title: "AAATECH Financial Results Q1 2026",
    description: "Un-audited financial results for the quarter ended June 2026",
    attachmentUrl: "/corporate/AAATECH_30062026_results.pdf",
    filingDate: new Date("2026-07-15T00:00:00Z"),
    category: "Financial Results",
  };
}

/**
 * Drive one full run whose only reachable document is an NSE FILING, served
 * with `body`.
 *
 * The NSE arm hardcodes `application/pdf` at the upload, so there is no
 * `contentType` parameter here on purpose: the header this leg stores is one WE
 * write, never one NSE claimed, which is exactly why nothing header-based could
 * have caught an interstitial page on this path.
 */
async function runNseWith(args: {
  body: Buffer;
  existingDoc?: Record<string, unknown> | null;
  forceRefresh?: boolean;
}) {
  const db = makeDb(args.existingDoc ?? null);
  const uploads: Array<{ path: string; bytes: number; type: string }> = [];

  const result = await quiet(() =>
    processStockDocumentSync(
      {
        batchSize: 1,
        ...(args.forceRefresh ? { forceRefresh: true } : {}),
      } as StockDocumentSyncMessage,
      {
        prisma: db as never,
        getOrFetchFinancials: async () => null,
        fetchNSEFinancialResults: (async () => [nseFiling()]) as never,
        fetchCategorizedAnnouncements: async () => [],
        fetchBseScripMaster: async () => [],
        scrapeScreenerFullPage: (async () =>
          pageWithNoDocuments() as never) as never,
        httpGet: (() => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => args.body,
          headers: { get: () => "application/pdf" },
        })) as never,
        uploadToGCS: (async (path: string, buf: Buffer, type: string) => {
          uploads.push({ path, bytes: buf.length, type });
        }) as never,
        publishExtractJob: async () => {},
        publishNextBatch: async () => {},
        sleep: noSleep,
      },
    ),
  );

  return { result, uploads, upserts: db.upserts };
}

/**
 * Drive one full run whose only reachable document is the DRHP link, served
 * with `body` under `contentType`. Returns the run result plus everything the
 * run tried to upload.
 */
async function runWith(args: {
  body: Buffer;
  contentType: string;
  existingDoc?: Record<string, unknown> | null;
  forceRefresh?: boolean;
}) {
  const db = makeDb(args.existingDoc ?? null);
  const uploads: Array<{ path: string; bytes: number; type: string }> = [];

  const result = await quiet(() =>
    processStockDocumentSync(
      {
        batchSize: 1,
        ...(args.forceRefresh ? { forceRefresh: true } : {}),
      } as StockDocumentSyncMessage,
      {
        prisma: db as never,
        getOrFetchFinancials: async () => null,
        fetchNSEFinancialResults: async () => [],
        fetchCategorizedAnnouncements: async () => [],
        fetchBseScripMaster: async () => [],
        scrapeScreenerFullPage: (async () => pageWithDrhp() as never) as never,
        httpGet: (() => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => args.body,
          headers: { get: () => args.contentType },
        })) as never,
        uploadToGCS: (async (path: string, buf: Buffer, type: string) => {
          uploads.push({ path, bytes: buf.length, type });
        }) as never,
        publishExtractJob: async () => {},
        publishNextBatch: async () => {},
        sleep: noSleep,
      },
    ),
  );

  return { result, uploads, upserts: db.upserts };
}

/* -------------------------------------------------------------------------- */

describe("stock-document-sync: an HTML body is REFUSED, whatever the header says", () => {
  it("the fixture clears the size floor — otherwise these cases prove nothing", () => {
    // `MIN_DOC_BUFFER_BYTES` is 500 and rejects smaller bodies before any
    // guard runs. A fixture under it would make every refusal assertion below
    // pass against a writer with NO guard, which is the vacuous-test shape.
    assert.ok(
      SEBI_HTML.length > 500,
      `fixture is ${SEBI_HTML.length} bytes; the size floor would refuse it first`,
    );
    assert.ok(REAL_PDF.length > 500);
  });

  it("REGRESSION: an HTML body with an HONEST text/html header is not stored", async () => {
    // The 1,580 prod rows. The old code named the object `.txt`, marked the row
    // UNSUPPORTED — and uploaded the web page anyway.
    const { result, uploads, upserts } = await runWith({
      body: SEBI_HTML,
      contentType: "text/html; charset=UTF-8",
    });

    assert.deepStrictEqual(uploads, [], "nothing may reach GCS");
    assert.strictEqual(result.wrote.screener, 0, "it is not a write");
    assert.strictEqual(
      result.transportFailures,
      0,
      "the fetch SUCCEEDED — calling it a transport failure would be a lie " +
        "that also triggers the wrong alarm",
    );
  });

  it("the refusal is COUNTED in the run outcome, not a silent skip", async () => {
    // A `return 0` with no counter is how a source whose links have all rotted
    // into landing pages reads exactly like a source with nothing new to give.
    const { result } = await runWith({
      body: SEBI_HTML,
      contentType: "text/html; charset=UTF-8",
    });
    assert.strictEqual(result.htmlRefusals, 1);
  });

  it("REGRESSION: a LYING application/pdf header is ALSO refused", async () => {
    // The case the header-based guard structurally cannot reach.
    // `normalizeDocMimeType("application/pdf")` → a PDF; `inferExtension` → a
    // `.pdf` object name; `initialProcessingStatus` → PENDING. Every existing
    // check passes and the row joins the extraction queue claiming a document
    // that is a web page. Only the body can answer it.
    const { result, uploads } = await runWith({
      body: SEBI_HTML,
      contentType: "application/pdf",
    });
    assert.deepStrictEqual(uploads, [], "the header must not be believed");
    assert.strictEqual(result.htmlRefusals, 1);
  });

  it("an ENVELOPED HTML body is refused too", async () => {
    // Belt and braces at the write: the MONEY-1169 corruption is applied
    // downstream of here, but an upstream that ever served this shape must not
    // slip past a check that only understands bare bytes.
    const { result, uploads } = await runWith({
      body: envelope(SEBI_HTML, "text/html; charset=UTF-8"),
      contentType: "text/html; charset=UTF-8",
    });
    assert.deepStrictEqual(uploads, []);
    assert.strictEqual(result.htmlRefusals, 1);
  });

  it("CONTROL: a real PDF IS stored — the guard can say yes", async () => {
    // Without this, every assertion above is also satisfied by a guard that
    // refuses everything.
    const { result, uploads, upserts } = await runWith({
      body: REAL_PDF,
      contentType: "application/pdf",
    });

    assert.strictEqual(uploads.length, 1, "the document reached GCS");
    assert.strictEqual(
      uploads[0]!.path,
      "stocks/AAATECH/drhp/AAATECH-drhp-IPO.pdf",
    );
    assert.strictEqual(uploads[0]!.bytes, REAL_PDF.length);
    assert.strictEqual(result.htmlRefusals, 0);
    assert.strictEqual(result.wrote.screener, 1);
    assert.strictEqual(
      upserts[0]!.create.processingStatus,
      "PENDING",
      "a real PDF is still queued for extraction",
    );
  });
});

describe("stock-document-sync: a refused row ends TERMINAL and HONEST", () => {
  it('the row carries gcsPath "" and a terminal status, never PENDING', async () => {
    const { upserts } = await runWith({
      body: SEBI_HTML,
      contentType: "text/html; charset=UTF-8",
    });

    assert.strictEqual(upserts.length, 1, "the refusal still records a row");
    const create = upserts[0]!.create;
    assert.strictEqual(
      create.gcsPath,
      "",
      'the repo\'s "the bytes are not there" convention — every reader skips ' +
        'it by name via gcsPath: { notIn: [""] }',
    );
    assert.strictEqual(create.processingStatus, "UNSUPPORTED");
    assert.strictEqual(create.fileSize, 0);
  });

  it("it KEEPS sourceUrl and title — the useful part, per the BSE precedent", async () => {
    const { upserts } = await runWith({
      body: SEBI_HTML,
      contentType: "text/html; charset=UTF-8",
    });
    const create = upserts[0]!.create;
    assert.strictEqual(
      create.sourceUrl,
      "https://www.sebi.gov.in/filings/public-issues/mar-2018/advitiya-trade-india-limited_38237.html",
    );
    assert.strictEqual(create.title, "AAATECH DRHP");
    assert.strictEqual(create.docType, "drhp");
    assert.strictEqual(create.period, "IPO");
  });

  it("a refusal NEVER displaces a document we already hold", async () => {
    // Under `forceRefresh` a real PDF stored last month sits under the key and
    // today's fetch hits a transient challenge page. Clobbering gcsPath to ""
    // there would destroy a good document with nothing to recover it from, so
    // the UPDATE arm is deliberately empty.
    const { upserts, result } = await runWith({
      body: SEBI_HTML,
      contentType: "text/html; charset=UTF-8",
      // `forceRefresh` is what carries the run PAST the freshness check and
      // into the download; without it the existing row short-circuits and the
      // guard is never reached, so this case would pass vacuously.
      forceRefresh: true,
      existingDoc: {
        id: "old",
        gcsPath: "stocks/AAATECH/drhp/AAATECH-drhp-IPO.pdf",
      },
    });
    assert.strictEqual(result.htmlRefusals, 1, "the guard really did run");
    assert.strictEqual(upserts.length, 1);
    assert.deepStrictEqual(
      upserts[0]!.update,
      {},
      "the existing row must win; the refusal is counted, not applied",
    );
  });
});

describe("stock-document-sync: the NSE arm is guarded too", () => {
  // WHY THIS BLOCK EXISTS. Every case above stubs
  // `fetchNSEFinancialResults: async () => []`, so the NSE download path never
  // executed in this file at all — a guard deleted from `storeNSEFiling` would
  // have left the whole suite green. The Screener arm was the one that produced
  // the 1,573 measured rows, but it is the NSE arm that a header can never
  // reach: it HARDCODES `application/pdf` at the upload, so the media type
  // `initialProcessingStatus` would classify is one we wrote ourselves.

  it("[premise] the NSE arm actually runs — otherwise these cases are vacuous", async () => {
    // Without this, a change that gates the NSE leg off (a docTypes filter, a
    // budget, a legs resolution) would make every assertion below pass over a
    // path that never executed, which is the exact shape this block is fixing.
    const { result, uploads } = await runNseWith({ body: REAL_PDF });
    assert.strictEqual(
      result.wrote.nse,
      1,
      "the NSE leg did not reach a write",
    );
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0]!.type, "application/pdf");
  });

  it("REGRESSION: an NSE challenge page is REFUSED, not stored as a PENDING PDF", async () => {
    const { result, uploads } = await runNseWith({ body: SEBI_HTML });

    assert.deepStrictEqual(uploads, [], "nothing may reach GCS");
    assert.strictEqual(result.wrote.nse, 0, "it is not a write");
    assert.strictEqual(result.htmlRefusals, 1, "the refusal is COUNTED");
    assert.strictEqual(
      result.transportFailures,
      0,
      "the fetch SUCCEEDED — a 200 carrying HTML is not a transport failure, " +
        "and calling it one triggers the wrong alarm",
    );
  });

  it("the refused NSE row is TERMINAL and keeps its citation", async () => {
    const { upserts } = await runNseWith({ body: SEBI_HTML });

    assert.strictEqual(upserts.length, 1, "the refusal still records a row");
    const create = upserts[0]!.create;
    assert.strictEqual(create.sourceType, "NSE", "the NSE arm, not Screener");
    assert.strictEqual(create.gcsPath, "");
    assert.strictEqual(create.processingStatus, "UNSUPPORTED");
    assert.strictEqual(create.fileSize, 0);
    assert.strictEqual(
      create.sourceUrl,
      "/corporate/AAATECH_30062026_results.pdf",
      "the citation still resolves — the BSE-retention precedent",
    );
    assert.strictEqual(create.title, "AAATECH Financial Results Q1 2026");
    assert.strictEqual(create.docType, "quarterly_result");
  });

  it("an ENVELOPED HTML body is refused on the NSE arm too", async () => {
    const { result, uploads } = await runNseWith({
      body: envelope(SEBI_HTML, "application/pdf"),
    });
    assert.deepStrictEqual(uploads, []);
    assert.strictEqual(result.htmlRefusals, 1);
  });

  it("CONTROL: a real NSE PDF is stored PENDING — the guard can say yes", async () => {
    const { result, upserts } = await runNseWith({ body: REAL_PDF });
    assert.strictEqual(result.htmlRefusals, 0);
    assert.strictEqual(upserts[0]!.create.processingStatus, "PENDING");
    assert.strictEqual(upserts[0]!.create.gcsPath !== "", true);
  });
});

describe("describeSyncShortfall: the refusal reaches the job outcome", () => {
  const base = {
    selected: 10,
    written: 0,
    skippedFresh: 0,
    legs: { tickertape: false, nse: false, screener: true },
    wrote: { tickertape: 0, nse: 0, screener: 0 },
    transportFailures: 0,
    noNseListing: 0,
  };

  it("names the refusals when there were any", () => {
    const reason = describeSyncShortfall({ ...base, htmlRefusals: 12 });
    assert.ok(reason, "a run that wrote nothing must produce a reason");
    assert.match(reason, /12 download\(s\) refused as HTML pages/);
  });

  it("stays SILENT at zero — a clause on every run is noise nobody reads", () => {
    const reason = describeSyncShortfall({ ...base, htmlRefusals: 0 });
    assert.ok(reason);
    assert.doesNotMatch(reason, /refused as HTML/);
  });

  it("is OPTIONAL — every existing caller stays correct without it", () => {
    const reason = describeSyncShortfall(base);
    assert.ok(reason);
    assert.doesNotMatch(reason, /refused as HTML/);
  });
});
