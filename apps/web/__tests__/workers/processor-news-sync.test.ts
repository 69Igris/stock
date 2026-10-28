/**
 * News Sync Processor Tests (workers/src/processors/news-sync.ts) — DE-SHADOWED.
 *
 * Previously this file re-declared a full `processNewsSync` copy AND inline
 * copies of `parsePubSubMessage` / `getMessageId` and asserted the copies —
 * a shadow that stayed green even if the real param defaults, the discovery
 * WHERE clause, or the Pub/Sub parser regressed.
 *
 * Now:
 *   - param/discovery/WHERE assertions hit the REAL exports in
 *     `workers/src/processors/news-sync-logic.ts` (which news-sync.ts CALLS);
 *   - the symbol-loop is exercised via a thin harness using the SAME real
 *     `needsSymbolDiscovery` gate;
 *   - the route-handler tests use the REAL `parsePubSubMessage` / `getMessageId`
 *     from `workers/src/lib/message.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). news-sync.ts CALLS these.
import {
  resolveNewsSyncParams,
  needsSymbolDiscovery,
  buildNewsDiscoveryWhere,
  DEFAULT_NEWS_LIMIT,
  DEFAULT_NEWS_DELAY_MS,
  NEWS_PER_SYMBOL,
} from "../../../../workers/src/processors/news-sync-logic";
// REAL Pub/Sub envelope parser used by the route handler.
import {
  parsePubSubMessage,
  getMessageId,
} from "../../../../workers/src/lib/message";

// ══════════════════════════════════════════════════════════════════════
// resolveNewsSyncParams (real export)
// ══════════════════════════════════════════════════════════════════════

describe("resolveNewsSyncParams (real export)", () => {
  it("defaults limit to 50", () => {
    assert.strictEqual(resolveNewsSyncParams({}).limit, DEFAULT_NEWS_LIMIT);
    assert.strictEqual(resolveNewsSyncParams({}).limit, 50);
  });

  it("defaults delayMs to 500", () => {
    assert.strictEqual(
      resolveNewsSyncParams({}).delayMs,
      DEFAULT_NEWS_DELAY_MS
    );
    assert.strictEqual(resolveNewsSyncParams({}).delayMs, 500);
  });

  it("uses a custom limit", () => {
    assert.strictEqual(resolveNewsSyncParams({ limit: 25 }).limit, 25);
  });

  it("uses a custom delayMs", () => {
    assert.strictEqual(resolveNewsSyncParams({ delayMs: 1000 }).delayMs, 1000);
  });

  it("falls back to the default for limit 0 (|| semantics)", () => {
    assert.strictEqual(resolveNewsSyncParams({ limit: 0 }).limit, 50);
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
// buildNewsDiscoveryWhere (real export)
// ══════════════════════════════════════════════════════════════════════

describe("buildNewsDiscoveryWhere (real export)", () => {
  // MONEY-1215 — this used to assert `analysisCount: { gt: 0 }` as the ONLY
  // predicate, and thereby pinned a selector that matched **0 of 10,444**
  // active NSE equities on prod. `news-sync-market-hours-prod` fires 4x every
  // weekday with an empty payload, so discovery is the only path: every run
  // logged "Syncing news for 0 symbols" and reported success. `stock_news`
  // held 31 rows, newest 2026-04-16, and those came from on-demand web fetches.
  it("selects the supplied population OR the (currently dead) analysed set", () => {
    assert.deepStrictEqual(buildNewsDiscoveryWhere(["INFY", "TCS"]), {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
      OR: [{ symbol: { in: ["INFY", "TCS"] } }, { analysisCount: { gt: 0 } }],
    });
  });

  it("[regression] an EMPTY population omits the symbol branch entirely", () => {
    // `{ in: [] }` matches NOTHING in Prisma. Emitting it would leave the OR
    // satisfiable only by the dead `analysisCount` arm — i.e. straight back to
    // selecting zero, with a where-clause that looks like it was fixed.
    assert.deepStrictEqual(buildNewsDiscoveryWhere([]), {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
      OR: [{ analysisCount: { gt: 0 } }],
    });
  });

  it("keeps analysisCount as a branch — dead today, correct when StockSage writes it", () => {
    const w = buildNewsDiscoveryWhere(["INFY"]);
    assert.ok(
      w.OR.some((b) => "analysisCount" in b),
      "the analysed set must survive as an OR arm, not be replaced"
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Symbol-loop harness — mirrors processNewsSync's fetch loop using the SAME
// real discovery gate (the real processor boots Prisma + the research store).
// ══════════════════════════════════════════════════════════════════════

interface NewsDeps {
  discover: () => Promise<string[]>;
  getOrFetchNews: (symbol: string, count: number) => Promise<void>;
  delay: (ms: number) => Promise<void>;
}

async function runNewsSequence(
  data: { symbols?: string[]; limit?: number; delayMs?: number },
  deps: NewsDeps
): Promise<{ processed: number; failed: number; discovered: boolean }> {
  const { delayMs } = resolveNewsSyncParams(data);
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
      await deps.getOrFetchNews(symbol, NEWS_PER_SYMBOL);
      processed++;
      await deps.delay(delayMs);
    } catch {
      failed++;
    }
  }
  return { processed, failed, discovered };
}

function makeDeps(overrides: Partial<NewsDeps> = {}): NewsDeps {
  return {
    discover: async () => [],
    getOrFetchNews: async () => {},
    delay: async () => {},
    ...overrides,
  };
}

describe("news sync sequence (real discovery gate)", () => {
  it("uses provided symbols without discovery", async () => {
    const fetched: string[] = [];
    const out = await runNewsSequence(
      { symbols: ["RELIANCE", "TCS", "INFY"] },
      makeDeps({ getOrFetchNews: async (s) => void fetched.push(s) })
    );
    assert.strictEqual(out.discovered, false);
    assert.deepStrictEqual(fetched, ["RELIANCE", "TCS", "INFY"]);
    assert.strictEqual(out.processed, 3);
  });

  it("auto-discovers when no symbols are given", async () => {
    const out = await runNewsSequence(
      {},
      makeDeps({ discover: async () => ["HDFC", "ICICI"] })
    );
    assert.strictEqual(out.discovered, true);
    assert.strictEqual(out.processed, 2);
  });

  it("fetches NEWS_PER_SYMBOL (10) headlines per symbol", async () => {
    const counts: number[] = [];
    await runNewsSequence(
      { symbols: ["RELIANCE"] },
      makeDeps({ getOrFetchNews: async (_s, c) => void counts.push(c) })
    );
    assert.deepStrictEqual(counts, [10]);
    assert.strictEqual(NEWS_PER_SYMBOL, 10);
  });

  it("continues after a per-symbol failure and counts it", async () => {
    const out = await runNewsSequence(
      { symbols: ["OK1", "FAIL", "OK2"] },
      makeDeps({
        getOrFetchNews: async (s) => {
          if (s === "FAIL") throw new Error("API error");
        },
      })
    );
    assert.strictEqual(out.processed, 2);
    assert.strictEqual(out.failed, 1);
  });

  it("does not delay after a failed symbol", async () => {
    let delays = 0;
    await runNewsSequence(
      { symbols: ["A", "B"] },
      makeDeps({
        getOrFetchNews: async () => {
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

/** Mirrors routes/news-sync.ts: parse → process → 200/500, error sanitized. */
async function handleNewsSyncRoute(
  body: unknown,
  processor: (data: { symbols?: string[]; limit?: number }) => Promise<void>
): Promise<RouteResult> {
  try {
    const data = parsePubSubMessage<{ symbols?: string[]; limit?: number }>(
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

describe("news sync route handler (real Pub/Sub parser)", () => {
  it("returns 200 { success: true } on success", async () => {
    const result = await handleNewsSyncRoute(
      makeEnvelope({ symbols: ["RELIANCE"] }),
      async () => {}
    );
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { success: true });
  });

  it("returns 500 when the processor throws", async () => {
    const result = await handleNewsSyncRoute(makeEnvelope({}), async () => {
      throw new Error("Crashed");
    });
    assert.strictEqual(result.status, 500);
    assert.deepStrictEqual(result.body, { error: "Processing failed" });
  });

  it("decodes symbols + limit from the real Pub/Sub envelope", async () => {
    let captured: { symbols?: string[]; limit?: number } | null = null;
    await handleNewsSyncRoute(
      makeEnvelope({ symbols: ["TCS"], limit: 10 }),
      async (d) => {
        captured = d;
      }
    );
    assert.deepStrictEqual(captured!.symbols, ["TCS"]);
    assert.strictEqual(captured!.limit, 10);
  });

  it("parses a direct-JSON body (real parser's local-dev fallback)", async () => {
    let captured: { symbols?: string[] } | null = null;
    await handleNewsSyncRoute({ symbols: ["INFY"] }, async (d) => {
      captured = d;
    });
    assert.deepStrictEqual(captured!.symbols, ["INFY"]);
  });

  it("never leaks internal error details", async () => {
    const result = await handleNewsSyncRoute(makeEnvelope({}), async () => {
      throw new Error("INTERNAL: db crashed");
    });
    assert.strictEqual(result.body.error, "Processing failed");
  });
});
