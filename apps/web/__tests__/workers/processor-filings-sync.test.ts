/**
 * Filings Sync Processor Tests (workers/src/processors/filings-sync.ts)
 * — DE-SHADOWED.
 *
 * Previously this file re-declared a full `processFilingsSync` copy AND inline
 * copies of `parsePubSubMessage` / `getMessageId` and asserted the copies —
 * a shadow that stayed green even if the real param defaults, the hot-tier
 * discovery WHERE clause, or the Pub/Sub parser regressed.
 *
 * Now:
 *   - param/discovery/WHERE assertions hit the REAL exports in
 *     `workers/src/processors/filings-sync-logic.ts` (which filings-sync.ts CALLS);
 *   - the symbol-loop is exercised via a thin harness using the SAME real
 *     `needsSymbolDiscovery` gate;
 *   - the route-handler tests use the REAL `parsePubSubMessage` / `getMessageId`
 *     from `workers/src/lib/message.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). filings-sync.ts CALLS these.
import {
  resolveFilingsSyncParams,
  needsSymbolDiscovery,
  buildFilingsDiscoveryWhere,
  computeHotTierCutoff,
  DEFAULT_FILINGS_BATCH_SIZE,
  DEFAULT_FILINGS_DELAY_MS,
  HOT_TIER_WINDOW_DAYS,
} from "../../../../workers/src/processors/filings-sync-logic";
// REAL Pub/Sub envelope parser used by the route handler.
import {
  parsePubSubMessage,
  getMessageId,
} from "../../../../workers/src/lib/message";

// ══════════════════════════════════════════════════════════════════════
// resolveFilingsSyncParams (real export)
// ══════════════════════════════════════════════════════════════════════

describe("resolveFilingsSyncParams (real export)", () => {
  it("defaults batchSize to 50", () => {
    assert.strictEqual(
      resolveFilingsSyncParams({}).batchSize,
      DEFAULT_FILINGS_BATCH_SIZE
    );
    assert.strictEqual(resolveFilingsSyncParams({}).batchSize, 50);
  });

  it("defaults delayMs to 1000", () => {
    assert.strictEqual(
      resolveFilingsSyncParams({}).delayMs,
      DEFAULT_FILINGS_DELAY_MS
    );
    assert.strictEqual(resolveFilingsSyncParams({}).delayMs, 1000);
  });

  it("uses a custom batchSize", () => {
    assert.strictEqual(
      resolveFilingsSyncParams({ batchSize: 10 }).batchSize,
      10
    );
  });

  it("uses a custom delayMs", () => {
    assert.strictEqual(
      resolveFilingsSyncParams({ delayMs: 2000 }).delayMs,
      2000
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// needsSymbolDiscovery (real export)
// ══════════════════════════════════════════════════════════════════════

describe("needsSymbolDiscovery (real export)", () => {
  it("is true when symbols is undefined", () => {
    assert.strictEqual(needsSymbolDiscovery(undefined), true);
  });

  it("is true when symbols is an empty array", () => {
    assert.strictEqual(needsSymbolDiscovery([]), true);
  });

  it("is false when symbols are provided", () => {
    assert.strictEqual(needsSymbolDiscovery(["RELIANCE"]), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Hot-tier discovery WHERE + cutoff (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("computeHotTierCutoff (real export)", () => {
  it("is exactly HOT_TIER_WINDOW_DAYS (30) before the supplied now", () => {
    const now = new Date("2026-06-08T00:00:00Z");
    const cutoff = computeHotTierCutoff(now);
    const diffDays = (now.getTime() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
    assert.strictEqual(diffDays, HOT_TIER_WINDOW_DAYS);
    assert.strictEqual(diffDays, 30);
  });
});

describe("buildFilingsDiscoveryWhere (real export)", () => {
  // MONEY-1215 — this pinned a selector that required `analysisCount > 0` AND
  // `lastAnalyzedAt >= cutoff`, and prod has **0** rows satisfying even the
  // first. `filings-sync-weekly-prod` is ENABLED (Sun 19:00) and its only
  // publisher sends `{}`, so every run discovered nothing and reported success.
  it("selects the supplied population OR the (currently dead) analysed set", () => {
    const cutoff = new Date("2026-05-09T00:00:00Z");
    const where = buildFilingsDiscoveryWhere(["INFY", "TCS"], cutoff);
    assert.strictEqual(where.isActive, true);
    assert.strictEqual(where.instrumentType, "EQUITY");
    assert.strictEqual(where.exchange, "NSE");
    assert.deepStrictEqual(where.OR[0], { symbol: { in: ["INFY", "TCS"] } });
    const analysed = where.OR[1] as {
      analysisCount: { gt: number };
      lastAnalyzedAt: { gte: Date };
    };
    assert.deepStrictEqual(analysed.analysisCount, { gt: 0 });
    assert.strictEqual(analysed.lastAnalyzedAt.gte.getTime(), cutoff.getTime());
  });

  it("[regression] an EMPTY population omits the symbol branch entirely", () => {
    // `{ in: [] }` matches NOTHING in Prisma — emitting it would leave the OR
    // satisfiable only by the dead analysed arm, i.e. back to selecting zero
    // behind a where-clause that looks fixed.
    const where = buildFilingsDiscoveryWhere(
      [],
      new Date("2026-05-09T00:00:00Z")
    );
    assert.strictEqual(where.OR.length, 1);
    assert.ok(!("symbol" in where.OR[0]!));
  });
});

// ══════════════════════════════════════════════════════════════════════
// Symbol-loop harness — mirrors processFilingsSync's fetch loop using the SAME
// real discovery gate (the real processor boots Prisma + NSE filings clients).
// ══════════════════════════════════════════════════════════════════════

interface FilingsDeps {
  discover: () => Promise<string[]>;
  fetchNSEFinancialResults: (symbol: string) => Promise<unknown[]>;
  fetchAnnualReports: (symbol: string) => Promise<unknown[]>;
  delay: (ms: number) => Promise<void>;
}

async function runFilingsSequence(
  data: { symbols?: string[]; batchSize?: number; delayMs?: number },
  deps: FilingsDeps
): Promise<{ processed: number; failed: number; discovered: boolean }> {
  const { delayMs } = resolveFilingsSyncParams(data);
  let symbols = data.symbols;
  let discovered = false;
  if (needsSymbolDiscovery(symbols)) {
    discovered = true;
    symbols = await deps.discover();
  }
  let processed = 0;
  let failed = 0;
  for (const symbol of symbols!) {
    try {
      await deps.fetchNSEFinancialResults(symbol);
      await deps.fetchAnnualReports(symbol);
      processed++;
      await deps.delay(delayMs);
    } catch {
      failed++;
    }
  }
  return { processed, failed, discovered };
}

function makeDeps(overrides: Partial<FilingsDeps> = {}): FilingsDeps {
  return {
    discover: async () => [],
    fetchNSEFinancialResults: async () => [],
    fetchAnnualReports: async () => [],
    delay: async () => {},
    ...overrides,
  };
}

describe("filings sync sequence (real discovery gate)", () => {
  it("uses provided symbols without discovery", async () => {
    const out = await runFilingsSequence(
      { symbols: ["RELIANCE", "TCS"] },
      makeDeps()
    );
    assert.strictEqual(out.discovered, false);
    assert.strictEqual(out.processed, 2);
  });

  it("fetches BOTH financial results and annual reports per symbol", async () => {
    const fin: string[] = [];
    const rep: string[] = [];
    await runFilingsSequence(
      { symbols: ["RELIANCE", "INFY"] },
      makeDeps({
        fetchNSEFinancialResults: async (s) => {
          fin.push(s);
          return [];
        },
        fetchAnnualReports: async (s) => {
          rep.push(s);
          return [];
        },
      })
    );
    assert.deepStrictEqual(fin, ["RELIANCE", "INFY"]);
    assert.deepStrictEqual(rep, ["RELIANCE", "INFY"]);
  });

  it("auto-discovers when no symbols are given", async () => {
    const out = await runFilingsSequence(
      {},
      makeDeps({ discover: async () => ["SBIN", "HDFC"] })
    );
    assert.strictEqual(out.discovered, true);
    assert.strictEqual(out.processed, 2);
  });

  it("continues after a per-symbol failure and counts it", async () => {
    const out = await runFilingsSequence(
      { symbols: ["OK1", "FAIL", "OK2"] },
      makeDeps({
        fetchNSEFinancialResults: async (s) => {
          if (s === "FAIL") throw new Error("NSE API error");
          return [];
        },
      })
    );
    assert.strictEqual(out.processed, 2);
    assert.strictEqual(out.failed, 1);
  });

  it("increments failed on an annual-reports error", async () => {
    const out = await runFilingsSequence(
      { symbols: ["A"] },
      makeDeps({
        fetchAnnualReports: async () => {
          throw new Error("Network error");
        },
      })
    );
    assert.strictEqual(out.failed, 1);
    assert.strictEqual(out.processed, 0);
  });

  it("does not delay after a failed symbol", async () => {
    let delays = 0;
    await runFilingsSequence(
      { symbols: ["A", "B"] },
      makeDeps({
        fetchNSEFinancialResults: async () => {
          throw new Error("fail");
        },
        delay: async () => void delays++,
      })
    );
    assert.strictEqual(delays, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Route handler — REAL parsePubSubMessage / getMessageId from lib/message.ts
// ══════════════════════════════════════════════════════════════════════

interface RouteResult {
  body: Record<string, unknown>;
  status: number;
}

async function handleFilingsSyncRoute(
  body: unknown,
  processor: (data: { symbols?: string[]; batchSize?: number }) => Promise<void>
): Promise<RouteResult> {
  try {
    const data = parsePubSubMessage<{ symbols?: string[]; batchSize?: number }>(
      body
    );
    getMessageId(body);
    await processor(data);
    return { body: { success: true }, status: 200 };
  } catch {
    return { body: { error: "Processing failed" }, status: 500 };
  }
}

function makeEnvelope(payload: unknown, messageId = "msg-001") {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
      messageId,
    },
  };
}

describe("filings sync route handler (real Pub/Sub parser)", () => {
  it("returns 200 { success: true } on success", async () => {
    const result = await handleFilingsSyncRoute(
      makeEnvelope({ symbols: ["RELIANCE"] }),
      async () => {}
    );
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { success: true });
  });

  it("returns 500 when the processor throws", async () => {
    const result = await handleFilingsSyncRoute(makeEnvelope({}), async () => {
      throw new Error("NSE down");
    });
    assert.strictEqual(result.status, 500);
    assert.deepStrictEqual(result.body, { error: "Processing failed" });
  });

  it("decodes symbols + batchSize from the real Pub/Sub envelope", async () => {
    let captured: { symbols?: string[]; batchSize?: number } | null = null;
    await handleFilingsSyncRoute(
      makeEnvelope({ symbols: ["TCS"], batchSize: 20 }),
      async (d) => {
        captured = d;
      }
    );
    assert.deepStrictEqual(captured!.symbols, ["TCS"]);
    assert.strictEqual(captured!.batchSize, 20);
  });

  it("parses a direct-JSON body (real parser's local-dev fallback)", async () => {
    let captured: { symbols?: string[] } | null = null;
    await handleFilingsSyncRoute({ symbols: ["INFY"] }, async (d) => {
      captured = d;
    });
    assert.deepStrictEqual(captured!.symbols, ["INFY"]);
  });

  it("never leaks internal error details", async () => {
    const result = await handleFilingsSyncRoute(makeEnvelope({}), async () => {
      throw new Error("SECRET: nse creds leaked");
    });
    assert.strictEqual(result.body.error, "Processing failed");
  });
});
