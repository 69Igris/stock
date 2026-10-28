/**
 * MONEY-798 (P3c) — RAG enqueue + coverage PURE helpers — REAL imports.
 *
 * `enqueueDocumentForRag` itself is best-effort I/O (prisma upsert, never-throw,
 * DATABASE_URL-gated) so it's covered at the seam like the other never-throw
 * processors; these tests assert the REAL exported PURE pieces it's built from
 * (`packages/research/src/data-sources/rag-enqueue.ts`):
 *   - buildEnqueueKey         → the idempotency identity (canonical symbol +
 *                               default exchange/period) that the unique-key
 *                               upsert dedupes on. Same filing → same key.
 *   - initialProcessingStatus → READY when inline text is given (embed picks it
 *                               up), else PENDING (extract → embed chain).
 *   - computeCoverage         → embedded/total → integer pct, clamped, 0-safe.
 *   - isDatabaseConfigured    → the never-throw env gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildEnqueueKey,
  initialProcessingStatus,
  computeCoverage,
  isDatabaseConfigured,
  sanitizePathSegment,
  enqueueDocumentForRag,
  getRagCoverage,
  type EnqueuePrismaClient,
} from "../src/data-sources/rag-enqueue";

describe("buildEnqueueKey — idempotency identity", () => {
  it("canonicalises the symbol (strips exchange/series suffix, upper-cases)", () => {
    assert.deepEqual(
      buildEnqueueKey({ symbol: "reliance.ns", docType: "corporate_filing" }),
      {
        symbol: "RELIANCE",
        exchange: "NSE",
        docType: "corporate_filing",
        period: "latest",
      },
    );
    // NSE & BSE for the same company collapse to the same symbol key.
    assert.equal(
      buildEnqueueKey({ symbol: "TCS.BO", docType: "annual_report" }).symbol,
      "TCS",
    );
    assert.equal(
      buildEnqueueKey({ symbol: "INFY-EQ", docType: "annual_report" }).symbol,
      "INFY",
    );
  });

  it("is STABLE: the same filing re-discovered yields a byte-identical key", () => {
    const a = buildEnqueueKey({
      symbol: "HDFCBANK",
      docType: "corporate_filing",
      exchange: "NSE",
      period: "Q3-2024",
    });
    const b = buildEnqueueKey({
      symbol: "hdfcbank.ns",
      docType: "corporate_filing",
      exchange: "nse",
      period: "Q3-2024",
    });
    assert.deepEqual(a, b);
  });

  it("defaults exchange to NSE and period to a stable bucket", () => {
    const k = buildEnqueueKey({ symbol: "WIPRO", docType: "press_release" });
    assert.equal(k.exchange, "NSE");
    assert.equal(k.period, "latest");
  });

  it("upper-cases an explicit exchange and trims a blank period to the default", () => {
    const k = buildEnqueueKey({
      symbol: "WIPRO",
      docType: "press_release",
      exchange: "bse",
      period: "   ",
    });
    assert.equal(k.exchange, "BSE");
    assert.equal(k.period, "latest");
  });
});

describe("initialProcessingStatus", () => {
  it("READY when inline text is supplied (embed worker chunks it)", () => {
    assert.equal(initialProcessingStatus("some extracted text"), "READY");
  });

  it("PENDING with no/blank text (extract worker fetches + OCRs the PDF)", () => {
    assert.equal(initialProcessingStatus(undefined), "PENDING");
    assert.equal(initialProcessingStatus(""), "PENDING");
    assert.equal(initialProcessingStatus("   "), "PENDING");
  });
});

describe("computeCoverage — corpus health %", () => {
  it("computes embedded/total as an integer percentage", () => {
    assert.deepEqual(computeCoverage({ total: 4, embedded: 1, pending: 2 }), {
      total: 4,
      embedded: 1,
      pending: 2,
      pct: 25,
    });
  });

  it("returns 0% (not NaN) for an empty corpus", () => {
    assert.deepEqual(computeCoverage({ total: 0, embedded: 0, pending: 0 }), {
      total: 0,
      embedded: 0,
      pending: 0,
      pct: 0,
    });
  });

  it("rounds to the nearest integer", () => {
    assert.equal(
      computeCoverage({ total: 3, embedded: 1, pending: 2 }).pct,
      33,
    );
    assert.equal(
      computeCoverage({ total: 3, embedded: 2, pending: 1 }).pct,
      67,
    );
  });

  it("is 100% when all docs are embedded", () => {
    assert.equal(
      computeCoverage({ total: 7, embedded: 7, pending: 0 }).pct,
      100,
    );
  });

  it("clamps negative/garbage counts to non-negative integers", () => {
    const c = computeCoverage({ total: -5, embedded: -1, pending: -3 });
    assert.deepEqual(c, { total: 0, embedded: 0, pending: 0, pct: 0 });
  });

  it("truncates fractional counts", () => {
    const c = computeCoverage({ total: 4.9, embedded: 2.9, pending: 1.1 });
    assert.equal(c.total, 4);
    assert.equal(c.embedded, 2);
    assert.equal(c.pct, 50);
  });
});

describe("isDatabaseConfigured — never-throw env gate", () => {
  it("reflects the presence of DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      assert.equal(isDatabaseConfigured(), false);
      process.env.DATABASE_URL = "mongodb+srv://example";
      assert.equal(isDatabaseConfigured(), true);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

// ── sanitizePathSegment (SECURITY) ──────────────────────────────────────────

describe("sanitizePathSegment — placeholder gcsPath can't escape the prefix", () => {
  it("strips slashes and collapses `..` traversal tokens", () => {
    // `/`→`-`, then any run of dots collapses to a single dot → no `..`, no `/`.
    assert.equal(sanitizePathSegment("../../etc"), ".-.-etc");
    assert.ok(!sanitizePathSegment("../../etc").includes(".."));
    assert.ok(!sanitizePathSegment("a/b/c").includes("/"));
  });

  it("keeps safe ticker/period chars", () => {
    assert.equal(sanitizePathSegment("Q3-2024"), "Q3-2024");
    assert.equal(sanitizePathSegment("FY2024-25"), "FY2024-25");
    assert.equal(sanitizePathSegment("M&M"), "M&M");
  });

  it("degrades an all-unsafe / empty segment to a stable token", () => {
    assert.equal(sanitizePathSegment("///"), "unknown");
    assert.equal(sanitizePathSegment("..."), "unknown");
    assert.equal(sanitizePathSegment(""), "unknown");
  });
});

// ── enqueueDocumentForRag — idempotency / no-demote (injected prisma) ────────

type StockDocRow = {
  id: string;
  isEmbedded: boolean;
  processingStatus: string;
} | null;

interface SpyDb extends EnqueuePrismaClient {
  calls: {
    findFirst: number;
    findUnique: number;
    update: Array<Record<string, unknown>>;
    create: Array<Record<string, unknown>>;
    count: number;
  };
}

function spyDb(opts: {
  instrument?: { id: string } | null;
  existing?: StockDocRow;
  counts?: number[]; // total, embedded, pending (in call order)
}): SpyDb {
  const calls = {
    findFirst: 0,
    findUnique: 0,
    update: [] as Array<Record<string, unknown>>,
    create: [] as Array<Record<string, unknown>>,
    count: 0,
  };
  const counts = opts.counts ?? [];
  return {
    calls,
    instrumentMapping: {
      findFirst: async () => {
        calls.findFirst++;
        return opts.instrument === undefined
          ? { id: "inst-1" }
          : opts.instrument;
      },
    },
    stockDocument: {
      findUnique: async () => {
        calls.findUnique++;
        return opts.existing ?? null;
      },
      update: async (a: { data: Record<string, unknown> }) => {
        calls.update.push(a.data);
        return {};
      },
      create: async (a: { data: Record<string, unknown> }) => {
        calls.create.push(a.data);
        return {};
      },
      count: async () => counts[calls.count++] ?? 0,
    },
  };
}

/** Run `fn` with DATABASE_URL set so the DB path is exercised, then restore. */
async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "mongodb+srv://example";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
}

describe("enqueueDocumentForRag — idempotency + no-demote", () => {
  it("no-ops entirely when the DB isn't configured (best-effort)", async () => {
    const db = spyDb({});
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await enqueueDocumentForRag(
        { symbol: "RELIANCE", docType: "corporate_filing", sourceUrl: "u" },
        db,
      );
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
    assert.equal(db.calls.findFirst, 0);
    assert.equal(db.calls.create.length, 0);
  });

  it("creates a PENDING row (sourceUrl, no text) for a new known instrument", async () => {
    const db = spyDb({ existing: null });
    await withDb(() =>
      enqueueDocumentForRag(
        {
          symbol: "RELIANCE",
          docType: "corporate_filing",
          sourceUrl: "https://nse/x.pdf",
        },
        db,
      ),
    );
    assert.equal(db.calls.create.length, 1);
    const row = db.calls.create[0];
    assert.equal(row.symbol, "RELIANCE");
    assert.equal(row.processingStatus, "PENDING");
    // The placeholder gcsPath is prefix-locked + traversal-free.
    assert.ok(String(row.gcsPath).startsWith("stocks/RELIANCE/"));
  });

  it("creates a READY row when inline text is supplied", async () => {
    const db = spyDb({ existing: null });
    await withDb(() =>
      enqueueDocumentForRag(
        {
          symbol: "TCS",
          docType: "press_release",
          textContent: "extracted body",
        },
        db,
      ),
    );
    assert.equal(db.calls.create.length, 1);
    assert.equal(db.calls.create[0].processingStatus, "READY");
  });

  it("NO-DEMOTE: an already-READY/embedded row is never touched", async () => {
    const db = spyDb({
      existing: { id: "doc-9", isEmbedded: true, processingStatus: "READY" },
    });
    await withDb(() =>
      enqueueDocumentForRag(
        { symbol: "INFY", docType: "annual_report", textContent: "new text" },
        db,
      ),
    );
    // Existing READY/embedded → no update (no reset of textContent/isEmbedded),
    // no create. The healthy row is left exactly as-is.
    assert.equal(db.calls.update.length, 0);
    assert.equal(db.calls.create.length, 0);
  });

  it("fills a PENDING row with newly-discovered text (PENDING → READY)", async () => {
    const db = spyDb({
      existing: { id: "doc-2", isEmbedded: false, processingStatus: "PENDING" },
    });
    await withDb(() =>
      enqueueDocumentForRag(
        {
          symbol: "WIPRO",
          docType: "annual_report",
          textContent: "now we have text",
        },
        db,
      ),
    );
    assert.equal(db.calls.update.length, 1);
    const data = db.calls.update[0];
    assert.equal(data.processingStatus, "READY");
    assert.equal(data.textContent, "now we have text");
    assert.equal(data.isEmbedded, false); // queued for (re-)embed
  });

  it("does NOT create when the symbol is not a known instrument", async () => {
    const db = spyDb({ instrument: null, existing: null });
    await withDb(() =>
      enqueueDocumentForRag(
        { symbol: "NOTREAL", docType: "press_release", sourceUrl: "u" },
        db,
      ),
    );
    assert.equal(db.calls.create.length, 0);
  });

  it("never throws when the prisma upsert blows up (best-effort)", async () => {
    const db: EnqueuePrismaClient = {
      instrumentMapping: { findFirst: async () => ({ id: "i" }) },
      stockDocument: {
        findUnique: async () => {
          throw new Error("db down");
        },
        update: async () => ({}),
        create: async () => ({}),
        count: async () => 0,
      },
    };
    await withDb(() =>
      enqueueDocumentForRag(
        { symbol: "RELIANCE", docType: "annual_report", sourceUrl: "u" },
        db,
      ),
    );
    // (no assertion needed — reaching here means it didn't throw)
    assert.ok(true);
  });
});

describe("getRagCoverage — counts → coverage (injected prisma)", () => {
  it("aggregates total/embedded/pending into a coverage snapshot", async () => {
    const db = spyDb({ counts: [4, 1, 2] }); // total, embedded, pending
    const cov = await withDb(() => getRagCoverage("reliance.ns", "NSE", db));
    assert.deepEqual(cov, { total: 4, embedded: 1, pending: 2, pct: 25 });
  });

  it("returns a zeroed snapshot (no throw) when the DB isn't configured", async () => {
    const db = spyDb({ counts: [9, 9, 0] });
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const cov = await getRagCoverage("INFY", undefined, db);
      assert.deepEqual(cov, { total: 0, embedded: 0, pending: 0, pct: 0 });
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
    assert.equal(db.calls.count, 0);
  });

  it("returns a zeroed snapshot on a count error (best-effort)", async () => {
    const db: EnqueuePrismaClient = {
      instrumentMapping: { findFirst: async () => null },
      stockDocument: {
        findUnique: async () => null,
        update: async () => ({}),
        create: async () => ({}),
        count: async () => {
          throw new Error("count failed");
        },
      },
    };
    const cov = await withDb(() => getRagCoverage("TCS", undefined, db));
    assert.deepEqual(cov, { total: 0, embedded: 0, pending: 0, pct: 0 });
  });
});
