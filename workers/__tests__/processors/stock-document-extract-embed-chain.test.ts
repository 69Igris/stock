/**
 * The embed chain must fire even when there is NOTHING to extract — MONEY-1238.
 *
 * Source: workers/src/processors/stock-document-extract.ts
 *
 * ## The defect
 *
 * `processStockDocumentExtract` opened with
 *
 *     if (documents.length === 0) { logger.info("No PENDING PDF…"); return; }
 *
 * and published the `STOCK_DOCUMENT_EMBED` chain job 165 lines further down,
 * under a comment that claimed it published "unconditionally" precisely so the
 * text-only sync's documents would still get embedded. The early return made
 * that claim false for the commonest case:
 *
 *   - `buildExtractQuery` selects PENDING **application/pdf** rows only, so a
 *     weekday on which the text-only sync wrote `READY, isEmbedded:false`
 *     Tickertape/Screener documents and no new PDF landed hits `length === 0`.
 *   - This publish is the ONLY trigger the embed job has. Verified against the
 *     repo: `scripts/ops/setup-scheduler.sh` has entries for
 *     `stock-document-sync-*` and `stock-document-extract-daily` and NONE for
 *     `stock-document-embed`; the one other publisher, `stock-document-sync`,
 *     publishes the EXTRACT topic.
 *
 * So a skipped publish was not a delayed embed — it was a day on which the RAG
 * corpus ingested nothing, silently, while the run logged success.
 *
 * ## Why these tests drive the REAL processor
 *
 * The bug is control flow in the I/O shell. A pure-logic test cannot see it —
 * there is no pure function to extract from "a `return` is above a publish" —
 * and a string/structural assertion would go green the moment somebody moved a
 * comment. So the real `processStockDocumentExtract` is executed here against
 * two seams that already exist in production code:
 *
 *   - `__setPubSubClientForTests` (packages/pubsub/src/client.ts) — the
 *     documented ESM injection point for a fake PubSub.
 *   - the Prisma delegate methods, replaced by plain property assignment, the
 *     same technique `workers/__tests__/lib/notifications.test.ts` uses.
 *
 * No network, no Mongo, no GCS: the non-empty case makes the very first write
 * of the loop body throw, which routes the document into the processor's own
 * per-document catch before it can reach for a GCS object.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "@usemoney/database";
import { __setPubSubClientForTests } from "@usemoney/pubsub/client";
import type { PubSub } from "@google-cloud/pubsub";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";

import { processStockDocumentExtract } from "../../src/processors/stock-document-extract";

// ── recorded effects ────────────────────────────────────────────────────────

interface Published {
  topic: string;
  json: unknown;
}

let published: Published[] = [];
/** Ordered trace of side effects, so "publish ran LAST" is assertable. */
let trace: string[] = [];
let publishShouldThrow = false;

function fakePubSub(): PubSub {
  return {
    topic(name: string) {
      return {
        async publishMessage(message: { json?: unknown }) {
          trace.push("publish");
          if (publishShouldThrow) throw new Error("pubsub is down");
          published.push({ topic: name, json: message.json });
          return "fake-message-id";
        },
      };
    },
  } as unknown as PubSub;
}

// ── Prisma delegate doubles ─────────────────────────────────────────────────
// The Prisma delegate's methods are writable value properties, so they are
// saved and restored by hand (node:test's mock.method cannot patch them).

type FindMany = typeof prisma.stockDocument.findMany;
type Update = typeof prisma.stockDocument.update;

let originalFindMany: FindMany;
let originalUpdate: Update;

/** Rows the fake `findMany` returns. */
let rows: unknown[] = [];

const EMBED_TOPIC = getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_EMBED);

before(() => {
  originalFindMany = prisma.stockDocument.findMany;
  originalUpdate = prisma.stockDocument.update;

  prisma.stockDocument.findMany = (async () => rows) as unknown as FindMany;
  // Every write in the loop body throws. The FIRST one is the "mark
  // PROCESSING" update, so a document never reaches downloadFromGCS /
  // Document AI — the run stays entirely in-process.
  prisma.stockDocument.update = (async () => {
    trace.push("update");
    throw new Error("db write refused (test double)");
  }) as unknown as Update;
});

after(() => {
  prisma.stockDocument.findMany = originalFindMany;
  prisma.stockDocument.update = originalUpdate;
  __setPubSubClientForTests(null);
});

beforeEach(() => {
  published = [];
  trace = [];
  publishShouldThrow = false;
  rows = [];
  __setPubSubClientForTests(fakePubSub());
});

const PDF_ROW = {
  id: "doc-1",
  symbol: "RELIANCE",
  gcsPath: "stocks/RELIANCE/annual_report/fy2025.pdf",
  mimeType: "application/pdf",
  docType: "annual_report",
  period: "FY2025",
  sourceUrl: null,
};

describe("stock-document-extract chains the embed pass (MONEY-1238)", () => {
  it("publishes exactly ONE embed job when there are ZERO pending PDFs", async () => {
    rows = [];

    await processStockDocumentExtract({});

    // The whole point of the ticket. Before the fix this was 0: the early
    // return fired 165 lines above the publish, so on a day the text-only sync
    // produced READY documents and no PDF arrived, embed never ran and the RAG
    // corpus silently stopped ingesting.
    assert.equal(
      published.length,
      1,
      "zero pending PDFs must STILL chain the embed pass — this publish is the " +
        "embed job's only trigger (no Cloud Scheduler entry exists for it)",
    );
    assert.equal(published[0].topic, EMBED_TOPIC);
    assert.deepEqual(published[0].json, { batchSize: 500 });
  });

  it("publishes exactly ONE embed job when documents WERE processed", async () => {
    rows = [PDF_ROW];

    await processStockDocumentExtract({});

    assert.equal(
      published.length,
      1,
      "the non-empty path must publish once — not zero (regression) and not " +
        "twice (a hoist that forgot to remove the tail call)",
    );
    assert.equal(published[0].topic, EMBED_TOPIC);
    assert.deepEqual(published[0].json, { batchSize: 500 });
  });

  it("publishes AFTER the documents are processed, never before", async () => {
    rows = [PDF_ROW];

    await processStockDocumentExtract({});

    // Ordering is load-bearing and is why the fix is a `finally` rather than
    // moving the publish above the early return: embed must see the rows this
    // run just marked READY. Publishing first would defer every document
    // extracted in this run to tomorrow's pass.
    assert.ok(trace.includes("update"), "the loop body must have run");
    assert.equal(
      trace[trace.length - 1],
      "publish",
      `embed must be published after extraction, got trace [${trace.join(", ")}]`,
    );
    assert.equal(trace.filter((t) => t === "publish").length, 1);
  });

  it("a Pub/Sub failure does not fail the extraction run", async () => {
    rows = [];
    publishShouldThrow = true;

    await assert.doesNotReject(() => processStockDocumentExtract({}));
    assert.equal(published.length, 0);
    assert.equal(trace.filter((t) => t === "publish").length, 1);
  });

  it("still chains embed when a `symbols` filter matches nothing", async () => {
    // The filtered call is the same zero-row shape a caller reaches by asking
    // for symbols that have no PENDING PDFs; it must not be a quiet no-op
    // either, because the embed queue is global rather than per-symbol.
    rows = [];

    await processStockDocumentExtract({ symbols: ["NOSUCHSYMBOL"] });

    assert.equal(published.length, 1);
    assert.deepEqual(published[0].json, { batchSize: 500 });
  });
});

describe("the embed job has no OTHER trigger (MONEY-1238 premise)", () => {
  it("setup-scheduler.sh has no stock-document-embed entry", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const path = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts",
      "ops",
      "setup-scheduler.sh",
    );
    // Strip LINE comments BEFORE block comments (repo guard, MONEY-1143): a
    // `#`-commented job row must not be read as a live schedule.
    const src = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.replace(/^\s*#.*$/, ""))
      .join("\n");

    assert.ok(
      src.includes("stock-document-extract-daily"),
      "sanity: the extract schedule must be found, or this assertion is vacuous",
    );
    assert.ok(
      !src.includes("stock-document-embed"),
      "A Cloud Scheduler entry for stock-document-embed now exists. That is " +
        "fine — but it changes the blast radius of the chain in " +
        "stock-document-extract.ts, whose comment says that publish is the " +
        "job's ONLY trigger. Update the comment with the new fact.",
    );
  });
});
