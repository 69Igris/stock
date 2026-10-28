/**
 * Corporate-actions writer — real handler, stubbed network + prisma (MONEY-797 · C3b,
 * MONEY-806).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * `getCorporateActionsHistoryAction` does a DB-first read-through that, on an
 * empty DB, warms up from a live NSE fetch (bounded by a wall-clock budget) and
 * PERSISTS the classified rows via a pre-filter findMany (against the existing
 * `@@unique([symbol, exchange, actionType, exDate])` keys) + ONE createMany of
 * the rows not already stored — instead of N sequential findFirst+update/create
 * (MONEY-806; MongoDB Prisma createMany has no skipDuplicates). That
 * writer is the risky bit and is asserted here against the REAL action — the
 * whole NSE pipeline runs (session + `parseCorporateActions` + the
 * `buildCorporateActionCreateManyPayload` builder + the createMany writer);
 * only `globalThis.fetch` (network) and prisma
 * (`@usemoney/database`) are stubbed, plus the cache (`@usemoney/core`) is a
 * no-op so we always hit the warm path.
 *
 *   - SINGLE createMany: the warm-up issues exactly ONE write call with the rows
 *     not already stored (the pre-filter findMany dedupes against existing keys).
 *   - NULL exDate: AGM/OTHER actions with no ex-date persist without throwing.
 *   - INVALID/garbage date: a bad ex/record date never reaches Prisma as an
 *     Invalid Date (→ no RangeError/500); it lands as null.
 *   - WRITE failure isolation: a `createMany` that throws is swallowed so the
 *     warm-up never 500s (the next read still serves whatever persisted).
 *
 * Source: apps/web/lib/actions/stock-tabs.ts (warmCorporateActions +
 *         getCorporateActionsHistoryAction)
 * Runs under `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * NOTE on the network stub: the action does `await import("@usemoney/research")`,
 * and under tsx a dynamic import of a workspace PACKAGE cannot be intercepted
 * via require.cache (separate ESM registry). So we drive the REAL fetcher and
 * stub the wire instead — which also exercises the real parser/date-sanitiser.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── module-cache seam (prisma + cache + market status) ───────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}
const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ACTION_REL = "../../lib/actions/stock-tabs";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

// ── prisma recorder ──────────────────────────────────────────────────────────

interface Harness {
  instrumentRow: { id: string } | null;
  /** When true, the single `createMany` write rejects (failure-isolation case). */
  createManyThrows?: boolean;
  storedRows: Array<Record<string, unknown>>;
  createManyCalls: Array<{
    data: Array<Record<string, unknown>>;
    skipDuplicates?: boolean;
  }>;
}

let h: Harness;

function freshHarness(): Harness {
  return {
    instrumentRow: { id: "inst-1" },
    storedRows: [],
    createManyCalls: [],
  };
}

function makePrisma() {
  return {
    instrumentMapping: { findFirst: () => Promise.resolve(h.instrumentRow) },
    corporateAction: {
      createMany: (args: {
        data: Array<Record<string, unknown>>;
        skipDuplicates?: boolean;
      }) => {
        h.createManyCalls.push({
          data: args.data,
          skipDuplicates: args.skipDuplicates,
        });
        if (h.createManyThrows) {
          return Promise.reject(new Error("E11000 duplicate key"));
        }
        for (const row of args.data) h.storedRows.push(row);
        return Promise.resolve({ count: args.data.length });
      },
      findMany: () => Promise.resolve(h.storedRows),
    },
  };
}

// ── network stub (getSession + corporate-actions API) ────────────────────────

/** Raw NSE corporate-action rows (the `corporates-corporateActions` shape).
 *  `subject` → details/classification, `exDate`/`recDate` → dates. */
let nseRows: Array<{ subject: string; exDate?: string; recDate?: string }> = [];

const realFetch = globalThis.fetch;
function installFetchStub(): void {
  // ky uses the global fetch. The base URL request seeds the session cookie;
  // the /api/corporates-corporateActions request returns our rows as JSON.
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === "string"
        ? input
        : ((input as { url?: string })?.url ?? input)
    );
    if (url.includes("/api/corporates-corporateActions")) {
      return new Response(JSON.stringify(nseRows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // getSession() base-URL hit — hand back a cookie so the session resolves.
    return new Response("ok", {
      status: 200,
      headers: { "set-cookie": "nseappid=test; Path=/" },
    });
  }) as typeof fetch;
}

interface StockTabsModule {
  getCorporateActionsHistoryAction: (
    symbol: string,
    exchange: string
  ) => Promise<
    | { success: true; data: { actions: unknown[] } }
    | { success: false; error: string }
  >;
}

function loadAction(): StockTabsModule {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const corePath = require.resolve("@usemoney/core");
  for (const p of [dbPath, corePath]) snapshotOnce(p);

  const prisma = makePrisma();
  cache[dbPath] = { exports: { __esModule: true, prisma, default: prisma } };
  cache[corePath] = {
    exports: {
      __esModule: true,
      getCached: () => Promise.resolve(undefined),
      setCached: () => Promise.resolve(undefined),
      getNseMarketStatus: () => ({ isLive: false }),
    },
  };

  delete cache[require.resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as StockTabsModule;
}

// ════════════════════════════════════════════════════════════════════════════

describe("corporate-actions writer — single createMany round-trip", () => {
  beforeEach(() => {
    h = freshHarness();
    installFetchStub();
  });
  after(() => {
    globalThis.fetch = realFetch;
    restoreCache();
  });

  it("persists a new tuple via pre-dedup + ONE createMany (no skipDuplicates on Mongo)", async () => {
    nseRows = [
      {
        subject: "Dividend - Rs 24 Per Share",
        exDate: "10-Mar-2026",
        recDate: "12-Mar-2026",
      },
    ];
    const { getCorporateActionsHistoryAction } = loadAction();
    const res = await getCorporateActionsHistoryAction("TCS", "NSE");

    assert.equal(res.success, true);
    assert.equal(
      h.createManyCalls.length,
      1,
      "exactly one write round-trip for the warm-up"
    );
    const call = h.createManyCalls[0]!;
    // MongoDB Prisma createMany has NO skipDuplicates — dedupe is done by the
    // pre-filter findMany against existing keys (MONEY-779), so the write must
    // NOT carry skipDuplicates.
    assert.equal(
      call.skipDuplicates,
      undefined,
      "no skipDuplicates on a Mongo createMany"
    );
    assert.equal(call.data.length, 1);
    const created = call.data[0]!;
    assert.equal(created.type, "DIVIDEND");
    assert.equal(created.exchange, "NSE");
    assert.ok(
      created.exDate instanceof Date,
      "valid exDate persisted as a Date"
    );
  });

  it("batches multiple rows into a SINGLE createMany (no per-row chatter)", async () => {
    nseRows = [
      { subject: "Dividend - Rs 5", exDate: "10-Mar-2026" },
      { subject: "Bonus 1:1", exDate: "11-Mar-2026" },
      { subject: "Stock Split", exDate: "12-Mar-2026" },
    ];
    const { getCorporateActionsHistoryAction } = loadAction();
    const res = await getCorporateActionsHistoryAction("MIXED", "NSE");
    assert.equal(res.success, true);
    assert.equal(h.createManyCalls.length, 1, "still exactly one write call");
    assert.equal(h.createManyCalls[0]!.data.length, 3, "all rows in one batch");
  });
});

describe("corporate-actions writer — null / garbage date safety", () => {
  beforeEach(() => {
    h = freshHarness();
    installFetchStub();
  });
  after(() => {
    globalThis.fetch = realFetch;
    restoreCache();
  });

  it("DROPS a null-exDate row (main's schema requires exDate) — no write, no throw", async () => {
    nseRows = [{ subject: "Annual General Meeting" }]; // no exDate/recDate
    const { getCorporateActionsHistoryAction } = loadAction();
    const res = await getCorporateActionsHistoryAction("INFY", "NSE");
    assert.equal(res.success, true);
    assert.equal(
      h.createManyCalls.length,
      0,
      "a dateless row can't be persisted (exDate required) — nothing written"
    );
  });

  it("a garbage exDate is dropped — never reaches Prisma as an Invalid Date (no 500)", async () => {
    nseRows = [
      { subject: "Bonus 1:1", exDate: "not-a-real-date", recDate: "also-bad" },
    ];
    const { getCorporateActionsHistoryAction } = loadAction();
    const res = await getCorporateActionsHistoryAction("WIPRO", "NSE");
    assert.equal(res.success, true, "must not 500 on a garbage date");
    // The Invalid-Date row is dropped (exDate required) rather than written, so
    // no Invalid Date can ever reach the Mongo serialisation boundary.
    assert.equal(
      h.createManyCalls.length,
      0,
      "garbage-exDate row not persisted"
    );
  });
});

describe("corporate-actions writer — failure isolation & empties", () => {
  beforeEach(() => {
    h = freshHarness();
    installFetchStub();
  });
  after(() => {
    globalThis.fetch = realFetch;
    restoreCache();
  });

  it("a createMany that throws is swallowed — the action never 500s", async () => {
    nseRows = [
      { subject: "Dividend - Rs 5", exDate: "10-Mar-2026" },
      { subject: "Bonus 1:1", exDate: "11-Mar-2026" },
    ];
    h.createManyThrows = true; // the single write rejects
    const { getCorporateActionsHistoryAction } = loadAction();
    const res = await getCorporateActionsHistoryAction("MIXED", "NSE");
    assert.equal(res.success, true, "write failure never aborts the warm-up");
    assert.equal(h.createManyCalls.length, 1, "exactly one write attempt");
  });

  it("an empty NSE fetch yields an empty (not errored) result, no write", async () => {
    nseRows = [];
    const { getCorporateActionsHistoryAction } = loadAction();
    const res = await getCorporateActionsHistoryAction("EMPTY", "NSE");
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.actions, []);
    assert.equal(h.createManyCalls.length, 0, "no write on an empty fetch");
  });

  it("keys each create row on (symbol, exchange, type, exDate)", async () => {
    nseRows = [{ subject: "Dividend - Rs 24", exDate: "10-Mar-2026" }];
    const { getCorporateActionsHistoryAction } = loadAction();
    await getCorporateActionsHistoryAction("TCS", "NSE");
    const row = h.createManyCalls[0]!.data[0]!;
    assert.equal(row.exchange, "NSE");
    assert.equal(row.type, "DIVIDEND");
    assert.ok(
      typeof row.symbol === "string" && (row.symbol as string).length > 0
    );
    assert.ok(row.exDate instanceof Date);
  });
});

describe("corporate-actions writer — the values are the nightly's parse (MONEY-1535)", () => {
  beforeEach(() => {
    h = freshHarness();
    installFetchStub();
  });
  after(() => {
    globalThis.fetch = realFetch;
    restoreCache();
  });

  // THE DEFECT: the warm-up re-classified each subject with a second parser
  // whose value is a ratio's NUMERATOR and stored it as `ratio`, the post:pre
  // multiplier `price-adjust` divides a price history by. "Bonus 1:1" stored
  // 1 (adjusts nothing) and a Rs 10 -> Rs 2 split stored 10 (divides by 10,
  // not 5).
  //
  // Mutation: builder `ratio: r.oldFaceValue ?? (r.ratio === null ? null :
  // r.ratio - 1)` (the numerator, for both inputs) -> RED on both ratios.
  // Mutation: builder `dividendPerShare: null` -> RED on the dividend.
  it("stores the multiplier the adjustment divides by, never a numerator", async () => {
    nseRows = [
      { subject: "Bonus 1:1", exDate: "11-Mar-2026" },
      {
        subject:
          "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share",
        exDate: "12-Mar-2026",
      },
      { subject: "Dividend - Rs 24 Per Share", exDate: "10-Mar-2026" },
    ];
    const { getCorporateActionsHistoryAction } = loadAction();
    await getCorporateActionsHistoryAction("MIXED", "NSE");
    const byType = new Map(
      h.createManyCalls[0]!.data.map((r) => [String(r.type), r])
    );
    assert.equal(byType.get("BONUS")!.ratio, 2, "1:1 bonus doubles the shares");
    assert.equal(byType.get("SPLIT")!.ratio, 5, "Rs 10 -> Rs 2 is a 5x split");
    assert.equal(byType.get("SPLIT")!.oldFaceValue, 10);
    assert.equal(byType.get("SPLIT")!.newFaceValue, 2);
    assert.equal(byType.get("DIVIDEND")!.dividendPerShare, 24);
    // MONEY-1530 through the real action: a calendar day at UTC midnight.
    assert.equal(
      (byType.get("BONUS")!.exDate as Date).toISOString(),
      "2026-03-11T00:00:00.000Z"
    );
  });
});
