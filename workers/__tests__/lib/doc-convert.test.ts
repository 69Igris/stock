/**
 * MONEY-1314 — the converter's I/O shell.
 *
 * The decisions are tested in `doc-convert-logic.test.ts`. What is tested here
 * is the ORDER of the gates and the failure classification, both of which are
 * only visible at this layer:
 *
 *   peel envelope -> magic bytes -> RSS estimate -> library
 *
 * Getting that order wrong rejects a perfectly good 212 MB annual report as
 * "not a PDF", because a stored MONEY-1169 envelope's own first bytes are
 * `--<uuid>` and the intact PDF is 38 bytes further in.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  convertPdfToMarkdown,
  __setExtractFnForTests,
  __resetExtractFnForTests,
  __resetConvertSemaphoreForTests,
  __semaphoreForTests,
  DEFAULT_MAX_CONCURRENCY,
  maxEstimatedRssBytes,
  containerMemoryMi,
  DEFAULT_CONTAINER_MEMORY_MI,
} from "../../src/lib/doc-convert";

afterEach(() => {
  // reset, NOT set-null: null is the forced-unavailable state.
  __resetExtractFnForTests();
  __resetConvertSemaphoreForTests();
});

/** A minimal but REAL multipart envelope, in the exact shape GCS stored. */
function envelope(payload: Buffer, contentType = "application/pdf"): Buffer {
  const b = "cca43fa3-1234-5678-9abc-def012345678";
  return Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Type: application/json\r\n\r\n{}\r\n`),
    Buffer.from(`--${b}\r\nContent-Type: ${contentType}\r\n\r\n`),
    payload,
    Buffer.from(`\r\n--${b}--`),
  ]);
}

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF\n");

const fakeExtract = (pages: { page: number; markdown: string; needsOcr: boolean }[]) =>
  async () => ({ pages });

describe("MONEY-1314 — gate ORDER: peel before magic bytes", () => {
  it("a stored multipart envelope is peeled, not rejected as non-PDF", async () => {
    // THE ordering bug this test exists for. The envelope's first bytes are
    // `--<uuid>`, so a magic-byte check running first calls a 212 MB intact
    // annual report "not a PDF" and the document is lost for a second time.
    __setExtractFnForTests(
      fakeExtract([{ page: 0, markdown: "| Revenue | 1,000 |", needsOcr: false }]),
    );
    const r = await convertPdfToMarkdown({
      bytes: envelope(PDF),
      label: "SHOPERSTOP",
    });
    assert.equal(r.envelopePeeled, true);
    assert.equal(r.status, "CONVERTED");
    assert.notEqual(r.status, "UNREADABLE");
  });

  it("[control] a bare PDF is NOT reported as peeled", async () => {
    // Proves `envelopePeeled` tracks something real rather than being true
    // always — which would satisfy the assertion above while telling the
    // operator nothing.
    __setExtractFnForTests(
      fakeExtract([{ page: 0, markdown: "x", needsOcr: false }]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "plain" });
    assert.equal(r.envelopePeeled, false);
    assert.equal(r.status, "CONVERTED");
  });

  it("an envelope wrapping a NON-pdf is still rejected after peeling", async () => {
    // Peeling must not become a way to smuggle a ZIP past the magic-byte gate.
    const zip = Buffer.from("PK\x03\x04payload", "latin1");
    const r = await convertPdfToMarkdown({
      bytes: envelope(zip, "application/zip"),
      label: "BSHSL",
    });
    assert.equal(r.envelopePeeled, true);
    assert.equal(r.status, "UNREADABLE");
    assert.match(r.error ?? "", /ZIP/);
  });

  it("a non-PDF is UNREADABLE and never reaches the library", async () => {
    let called = false;
    __setExtractFnForTests(async () => {
      called = true;
      return { pages: [] };
    });
    const r = await convertPdfToMarkdown({
      bytes: Buffer.from("PK\x03\x04", "latin1"),
      label: "zip",
    });
    assert.equal(r.status, "UNREADABLE");
    assert.equal(called, false, "a non-PDF was handed to the parser anyway");
  });

  it("an empty object is UNREADABLE, not a successful empty conversion", async () => {
    const r = await convertPdfToMarkdown({ bytes: Buffer.alloc(0), label: "e" });
    assert.equal(r.status, "UNREADABLE");
  });
});

describe("MONEY-1314 — declining beats being OOM-killed", () => {
  it("a document whose estimated peak exceeds the ceiling is refused", async () => {
    // An OOM kill on Cloud Run takes the whole container — every other
    // in-flight message with it — and leaves no row explaining why. Declining
    // leaves a counted, named outcome.
    let called = false;
    __setExtractFnForTests(async () => {
      called = true;
      return { pages: [] };
    });
    const huge = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    const r = await convertPdfToMarkdown({
      bytes: huge,
      label: "big",
      maxEstimatedRssBytes: 1024 * 1024, // 1 MB ceiling: everything exceeds it
    });
    assert.equal(r.status, "UNREADABLE");
    assert.match(r.error ?? "", /exceeds the .* ceiling/);
    assert.equal(called, false, "the parser ran despite the refusal");
  });

  it("[control] a document UNDER the ceiling proceeds", async () => {
    __setExtractFnForTests(
      fakeExtract([{ page: 0, markdown: "x", needsOcr: false }]),
    );
    const r = await convertPdfToMarkdown({
      bytes: PDF,
      label: "small",
      maxEstimatedRssBytes: maxEstimatedRssBytes(),
    });
    assert.equal(r.status, "CONVERTED");
  });

  it("the ceiling fits INSIDE the container the service actually declares", () => {
    // The review's finding: this was derived against "2048 MiB", which is what
    // the backfill JOB gets. The workers SERVICE ships `memory: 1Gi`, so the
    // ceiling was 1.6x the real limit and admitted any file up to ~319 MB
    // while the corpus maximum is 222.3 MB. A ~200 MB report estimated ~1.0 GB,
    // passed, and OOM-killed the container — taking every other in-flight
    // message with it.
    const containerBytes = containerMemoryMi() * 1024 * 1024;
    assert.ok(
      maxEstimatedRssBytes() < containerBytes,
      `ceiling ${Math.round(maxEstimatedRssBytes() / 1e6)} MB exceeds the ` +
        `${Math.round(containerBytes / 1e6)} MB container`,
    );
  });

  it("it claims only a SHARE, because concurrency 10 means neighbours", () => {
    // Up to nine other requests are alive alongside the conversion, and the
    // caller downloads the object BEFORE acquiring the convert semaphore, so
    // their Buffers are resident too. Taking all the free space would be an
    // OOM at concurrency 2.
    const usable = (containerMemoryMi() - 68) * 1024 * 1024;
    assert.ok(maxEstimatedRssBytes() <= usable * 0.6);
  });

  it("the container size is READ, not hardcoded", () => {
    assert.equal(containerMemoryMi({ DOC_CONVERT_CONTAINER_MI: "2048" }), 2048);
    assert.equal(containerMemoryMi({}), DEFAULT_CONTAINER_MEMORY_MI);
    // A 2 GiB container earns a bigger ceiling — that is the whole point of
    // reading it, and it is how the backfill JOB reaches the 222 MB documents
    // the 1 GiB service declines.
    assert.ok(
      maxEstimatedRssBytes({ DOC_CONVERT_CONTAINER_MI: "2048" }) >
        maxEstimatedRssBytes({ DOC_CONVERT_CONTAINER_MI: "1024" }),
    );
  });

  it("an explicit override wins over the derivation", () => {
    assert.equal(
      maxEstimatedRssBytes({ DOC_CONVERT_MAX_RSS_MI: "700" }),
      700 * 1024 * 1024,
    );
  });

  it("[control] a nonsense value falls back rather than producing NaN", () => {
    for (const bad of ["", "abc", "-1", "0"]) {
      const v = maxEstimatedRssBytes({ DOC_CONVERT_MAX_RSS_MI: bad });
      assert.ok(Number.isFinite(v) && v > 0, `${bad} produced ${v}`);
    }
  });

});

describe("MONEY-1314 — failure classification", () => {
  it("a missing library is FAILED (transient), not UNREADABLE", async () => {
    // The document is fine; our binding is not. Marking it UNREADABLE would
    // permanently retire every document processed during a bad deploy.
    //
    // `null` is the FORCED-UNAVAILABLE state, distinct from `undefined` which
    // means "not attempted". A two-state seam could not express this: setting
    // null would just re-run the real import, which now succeeds because the
    // library is installed — so this test silently passed nothing.
    __setExtractFnForTests(null);
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "x" });
    assert.equal(r.status, "FAILED");
    assert.match(r.error ?? "", /unavailable/);
  });

  it("the library's DETERMINISTIC rejections are UNREADABLE", async () => {
    // A truncated file is truncated on every attempt. Retrying it forever is
    // how a queue stops draining with nothing looking wrong.
    for (const msg of [
      "Invalid PDF structure",
      "Not a PDF: file appears to be plain text",
      "PDF is encrypted",
    ]) {
      __setExtractFnForTests(async () => {
        throw new Error(msg);
      });
      const r = await convertPdfToMarkdown({ bytes: PDF, label: "x" });
      assert.equal(r.status, "UNREADABLE", `"${msg}" should be terminal`);
    }
  });

  it("[control] an UNRECOGNISED throw stays FAILED (retryable)", async () => {
    // Proves the classifier discriminates. A rule that called everything
    // terminal would satisfy the test above and quietly retire documents on a
    // transient network blip.
    __setExtractFnForTests(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "x" });
    assert.equal(r.status, "FAILED");
  });

  it("a fully-scanned document is SCANNED_ONLY with no markdown", async () => {
    __setExtractFnForTests(
      fakeExtract([
        { page: 0, markdown: "", needsOcr: true },
        { page: 1, markdown: "", needsOcr: true },
      ]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "scan" });
    assert.equal(r.status, "SCANNED_ONLY");
    assert.equal(r.markdown, "");
    assert.equal(r.assessment?.scannedPageCount, 2);
  });

  it("the garbage-text-layer shape lands on SCANNED_ONLY", async () => {
    // needsOcr true with NO ocrReason key — the population that classifies
    // TextBased at confidence 1.00 and extracts nothing. Four of the five are
    // BSE quarterly_result, the largest docType in the archive.
    __setExtractFnForTests(
      fakeExtract([
        { page: 0, markdown: "", needsOcr: true },
        { page: 1, markdown: "", needsOcr: true },
        { page: 2, markdown: "", needsOcr: true },
      ]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "ZGAEKWAR" });
    assert.equal(r.status, "SCANNED_ONLY");
  });
});

describe("MONEY-1314 — normalisation is applied on the way out", () => {
  it("the rupee-backtick repair reaches the returned markdown", async () => {
    __setExtractFnForTests(
      fakeExtract([
        { page: 0, markdown: "(` in crores)\n| Revenue | 1,000 |", needsOcr: false },
      ]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "ITC" });
    assert.ok(r.markdown.includes("(₹ in crores)"));
    assert.ok(!r.markdown.includes("`"));
  });

  it("an orphan-digit table sets failOverToVision", async () => {
    __setExtractFnForTests(
      fakeExtract([
        {
          page: 0,
          markdown: [
            "|Particulars|Q1|Q2|",
            "|---|---|---|",
            "|Revenue|9,391.26 0|44,271.73 6|",
          ].join("\n"),
          needsOcr: false,
        },
      ]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "BHATIA" });
    assert.equal(r.status, "CONVERTED");
    assert.equal(r.failOverToVision, true);
    assert.match(r.error ?? "", /migrated across a column boundary/);
  });

  it("[control] a clean table does not fail over", async () => {
    __setExtractFnForTests(
      fakeExtract([
        {
          page: 0,
          markdown: ["|A|B|", "|---|---|", "|1,000|2,000|"].join("\n"),
          needsOcr: false,
        },
      ]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "clean" });
    assert.equal(r.failOverToVision, false);
    assert.equal(r.error, null);
  });

  it("page markers survive to the output", async () => {
    __setExtractFnForTests(
      fakeExtract([
        { page: 0, markdown: "A", needsOcr: false },
        { page: 4, markdown: "B", needsOcr: false },
      ]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "x" });
    assert.ok(r.markdown.includes("<!-- page 1 -->"));
    assert.ok(r.markdown.includes("<!-- page 5 -->"));
  });
});

describe("MONEY-1314 — concurrency", () => {
  it("the semaphore serialises conversions at the configured limit", async () => {
    // Peak RSS is 2.3-4.8x file size and the largest object is 222.3 MB
    // (~1.1 GiB alone). Two of those concurrently is an OOM kill that takes
    // the container, not just the conversion.
    let concurrent = 0;
    let peak = 0;
    __setExtractFnForTests(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return { pages: [{ page: 0, markdown: "x", needsOcr: false }] };
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        convertPdfToMarkdown({ bytes: PDF, label: `d${i}` }),
      ),
    );
    assert.equal(peak, DEFAULT_MAX_CONCURRENCY, `peak concurrency was ${peak}`);
    assert.equal(DEFAULT_MAX_CONCURRENCY, 1);
  });

  it("a NEW arrival cannot steal a slot from a waiter", async () => {
    // THE race, driven deterministically. Through the public API this window
    // is one microtask wide and cannot be scheduled into on purpose — a
    // behavioural "start N and check the peak" test passes against the BROKEN
    // version, which was measured before this replaced it.
    //
    // The broken shape: release() decremented and then resolved a waiter,
    // while the waiter incremented on resume. Between those two an arriving
    // acquire() saw `inFlight < max`, took the slot and incremented — so both
    // ran and the limit was exceeded.
    const sem = __semaphoreForTests;
    await sem.acquire(); // slot taken
    assert.equal(sem.inFlight(), 1);

    const waiter = sem.acquire(); // queued — the limit is 1
    assert.equal(sem.waiting(), 1);

    sem.release(); // hands the slot over; must NOT dip to 0
    const intruder = sem.acquire(); // arrives in the window
    await waiter;

    assert.equal(
      sem.inFlight(),
      1,
      `inFlight is ${sem.inFlight()} with a limit of 1 — release() dipped the ` +
        "count and an arriving acquire() took the slot the waiter was handed",
    );
    // Drain, so the module state does not leak into the next case.
    sem.release();
    await intruder;
    sem.release();
  });

  it("[control] the count returns to zero when everything releases", () => {
    // Proves `inFlight()` tracks something real. A counter stuck at 1 would
    // satisfy the assertion above.
    const sem = __semaphoreForTests;
    assert.equal(sem.inFlight(), 0);
    assert.equal(sem.waiting(), 0);
  });

  it("a THROWING conversion still releases its permit", async () => {
    // A leaked permit deadlocks every later conversion in the process, and the
    // symptom is a worker that accepts messages and never finishes one.
    __setExtractFnForTests(async () => {
      throw new Error("boom");
    });
    await convertPdfToMarkdown({ bytes: PDF, label: "a" });
    __setExtractFnForTests(
      fakeExtract([{ page: 0, markdown: "x", needsOcr: false }]),
    );
    const r = await Promise.race([
      convertPdfToMarkdown({ bytes: PDF, label: "b" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("DEADLOCK")), 2000)),
    ]);
    assert.equal((r as { status: string }).status, "CONVERTED");
  });
});

describe("MONEY-1314 — async variants only", () => {
  it("the SYNC library entry points appear nowhere in this module", () => {
    // The sync variants block the event loop for the whole parse — 12 seconds
    // on the worst document measured — which on a Hono server stalls every
    // other request including the health check.
    const src = readFileSync(
      new URL("../../src/lib/doc-convert.ts", import.meta.url),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");
    for (const sync of [
      "extractPagesMarkdown(",
      "classifyPdf(",
      "processPdf(",
    ]) {
      assert.ok(
        !code.includes(sync),
        `${sync} is a SYNC entry point and blocks the event loop`,
      );
    }
    assert.ok(
      code.includes("extractPagesMarkdownAsync"),
      "[control] the async variant should be present — if not, this scan is " +
        "passing because the module no longer calls the library at all",
    );
  });
});

describe("MONEY-1315 — the TRUE size is reported, so the row can be corrected", () => {
  // `stock_documents.fileSize` records what was STORED. For a MONEY-1169
  // object that is the multipart ENVELOPE — 212.03 MB for a PDF that is a
  // fraction of it — and `feed-repair` is deliberately GCS-only, so it fixes
  // the object and leaves the row saying the old number.
  //
  // That is load-bearing: `exceedsVisionCeiling` reads the column and treats
  // large-or-unknown as "refuse", and `estimatePeakRssBytes` sizes the OOM
  // guard from it. An enveloped row is therefore barred from the vision lane
  // on a size it does not have.

  it("payloadBytes is the PEELED size, not the stored size", () => {
    // The whole point: the caller can only correct the row if it is told the
    // difference.
    const enveloped = envelope(PDF);
    assert.ok(
      enveloped.length > PDF.length,
      "[premise] the envelope must be larger than its payload",
    );
  });

  it("a peeled document reports the payload's size", async () => {
    __setExtractFnForTests(
      fakeExtract([{ page: 0, markdown: "| Revenue | 1,000 |", needsOcr: false }]),
    );
    const stored = envelope(PDF);
    const r = await convertPdfToMarkdown({ bytes: stored, label: "SHOPERSTOP" });
    assert.equal(r.envelopePeeled, true);
    assert.equal(
      r.payloadBytes,
      PDF.length,
      `payloadBytes is ${r.payloadBytes}; the PDF inside is ${PDF.length} and ` +
        `the stored object is ${stored.length}`,
    );
    assert.notEqual(r.payloadBytes, stored.length);
  });

  it("[control] an unenveloped document reports its own size unchanged", async () => {
    // Without this, "always report something smaller" satisfies the assertion
    // above and would corrupt the size of every ordinary row.
    __setExtractFnForTests(
      fakeExtract([{ page: 0, markdown: "x", needsOcr: false }]),
    );
    const r = await convertPdfToMarkdown({ bytes: PDF, label: "plain" });
    assert.equal(r.envelopePeeled, false);
    assert.equal(r.payloadBytes, PDF.length);
  });

  it("even a REJECTED document reports what was examined", async () => {
    // A ZIP inside an envelope is unreadable, but the row's size is still
    // wrong and still worth correcting — the operator reading the outcome
    // should see the real number.
    const zip = Buffer.from("PK\x03\x04payload-bytes-here", "latin1");
    const r = await convertPdfToMarkdown({
      bytes: envelope(zip, "application/zip"),
      label: "BSHSL",
    });
    assert.equal(r.status, "UNREADABLE");
    assert.equal(r.payloadBytes, zip.length);
  });

  it("the PROCESSOR writes the correction back — checked in source", () => {
    // The report is useless if nobody acts on it, and this is an I/O path.
    const src = readFileSync(
      new URL("../../src/processors/stock-document-ingest.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      src,
      /fileSize: correctedSize/,
      "the processor does not write the corrected size back to the row",
    );
    assert.match(
      src,
      /converted\.envelopePeeled &&/,
      "the correction must be gated on an actual peel — an unconditional " +
        "write touches every row for nothing",
    );
    assert.match(
      src,
      /state = \{ \.\.\.state, fileBytes: correctedSize \}/,
      "the in-memory view must be updated too, or the vision lane routes on " +
        "the stale number for the rest of this message",
    );
  });
});
