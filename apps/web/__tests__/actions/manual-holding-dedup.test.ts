/**
 * MONEY-1236 — a manual holding must MERGE, not duplicate.
 *
 * ## The defect
 *
 * `addManualHoldingAction` writes a manual holding with `brokerName: "manual"`
 * and NO `broker` key at all, then looks the same row up again with
 * `{ broker: null }`. On Prisma's MongoDB connector those are two different
 * things: `{ f: null }` is an equality against a STORED null and never reaches
 * a document whose key is absent — only `{ f: { isSet: false } }` (or a raw
 * `$exists: false`) does. Writer and reader disagreed, so the dedup lookup
 * could not see a single row this action had ever written.
 *
 * Measured on PROD 2026-08-21, `holdings`:
 *
 *     total                                     99
 *     broker ABSENT                             16   (16.2%)
 *     broker explicit null                       0
 *     broker set                                83
 *     of the absent 16: brokerName = "manual"   16    <- all of them
 *
 * ## What is actually pinned here
 *
 * The REAL exported action runs, against a Prisma double whose matcher models
 * MONGO'S rule rather than JavaScript's — an absent key does NOT match
 * `{ f: null }`. That is the whole point: a double that treats absent and null
 * alike would report this action as healthy both before and after the fix, and
 * a source-text assertion on its own passes on a hand-copied filter that has
 * since drifted. So both layers are here, plus a `[meta]` block that pins the
 * double's own semantics.
 *
 * Boundaries (auth, prisma, demo session, cache, next/cache, logger) are
 * injected at the module boundary via `require.cache` — the proven
 * `broker-connection.test.ts` seam. CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/holdings.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── the Mongo matching rule, modelled ───────────────────────────────────────

type Row = Record<string, unknown>;

function isSetClause(clause: unknown): clause is { isSet: boolean } {
  return (
    typeof clause === "object" &&
    clause !== null &&
    "isSet" in (clause as Record<string, unknown>)
  );
}

/**
 * One field predicate, with MongoDB's semantics — NOT JavaScript's:
 *
 *   `{ f: null }`             matches ONLY a key that is present and null
 *   `{ f: { isSet: false } }` matches ONLY a key that is ABSENT
 *   `{ f: "X" }`              matches ONLY a present key equal to "X"
 *
 * A JS-shaped double (`row.f == null`) collapses the first two, which is
 * exactly the collapse that made this bug invisible for the life of the
 * feature.
 */
function fieldMatches(row: Row, key: string, clause: unknown): boolean {
  const present =
    Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined;
  if (isSetClause(clause)) return clause.isSet === present;
  if (clause === null) return present && row[key] === null;
  return present && row[key] === clause;
}

function whereMatches(row: Row, where: Row): boolean {
  for (const [key, clause] of Object.entries(where)) {
    if (key === "OR") {
      const arms = clause as Row[];
      if (!arms.some((arm) => whereMatches(row, arm))) return false;
      continue;
    }
    if (!fieldMatches(row, key, clause)) return false;
  }
  return true;
}

// ── prisma double ───────────────────────────────────────────────────────────

interface StoredHolding extends Row {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  quantity: number;
  investedValue: number;
  averagePrice: number;
}

interface RecordedCall {
  model: string;
  method: string;
  args: { where?: Row; data?: Row };
}

class FakePrisma {
  readonly calls: RecordedCall[] = [];
  constructor(readonly holdings: StoredHolding[] = []) {}

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }

  private record(model: string, method: string, args: RecordedCall["args"]) {
    this.calls.push({ model, method, args });
  }

  get client(): Record<string, unknown> {
    const self = this;
    return {
      holding: {
        findFirst: (args: { where: Row }) => {
          self.record("holding", "findFirst", args);
          return Promise.resolve(
            self.holdings.find((h) => whereMatches(h, args.where)) ?? null
          );
        },
        update: (args: { where: Row; data: Row }) => {
          self.record("holding", "update", args);
          const row = self.holdings.find((h) => h.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return Promise.resolve(row ?? { id: String(args.where.id) });
        },
        create: (args: { data: Row }) => {
          self.record("holding", "create", args);
          const row = {
            id: `created-${self.holdings.length + 1}`,
            ...args.data,
          } as StoredHolding;
          self.holdings.push(row);
          return Promise.resolve(row);
        },
      },
      trade: {
        create: (args: { data: Row }) => {
          self.record("trade", "create", args);
          return Promise.resolve({ id: "trade-1" });
        },
      },
    };
  }
}

// ── boundary injection ──────────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};
function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

interface Harness {
  prisma: FakePrisma;
  userId: string | null;
  isDemo: boolean;
  revalidated: string[];
  cacheCleared: Array<{ userId: string; modules: string[] }>;
}

interface ActionModule {
  addManualHoldingAction: (data: {
    symbol: string;
    name?: string;
    exchange: string;
    quantity: number;
    averagePrice: number;
    currentPrice?: number;
    sector?: string;
  }) => Promise<{ success: boolean; data?: { holdingId: string } }>;
}

const ACTION_REL = "../../lib/actions/holdings";

function loadAction(h: Harness): ActionModule {
  const cache = moduleCache();
  const resolve = (p: string) => require.resolve(p);

  cache[resolve("@/lib/prisma")] = {
    exports: {
      __esModule: true,
      prisma: h.prisma.client,
      default: h.prisma.client,
    },
  };
  cache[resolve("@/lib/auth")] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () =>
        Promise.resolve(h.userId ? { userId: h.userId } : null),
    },
  };
  cache[resolve("@/lib/demo/session")] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo),
      COOKIE_NAME: "sb_demo",
    },
  };
  cache[resolve("@/lib/demo/data")] = {
    exports: { __esModule: true, demoHoldings: [] },
  };
  cache[resolve("@usemoney/core")] = {
    exports: {
      __esModule: true,
      clearUserCache: (userId: string, modules: string[]) => {
        h.cacheCleared.push({ userId, modules });
        return Promise.resolve();
      },
    },
  };
  cache[resolve("@usemoney/services")] = {
    exports: {
      __esModule: true,
      getHoldings: async () => ({ success: true, data: null }),
      deleteHolding: async () => ({ success: true }),
    },
  };
  cache[resolve("next/cache")] = {
    exports: {
      __esModule: true,
      revalidatePath: (p: string) => {
        h.revalidated.push(p);
      },
      revalidateTag: () => {},
    },
  };
  cache[resolve("@usemoney/logger")] = { exports: makeLoggerStub() };

  delete cache[resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ActionModule;
}

function clearActionCache(): void {
  delete moduleCache()[require.resolve(ACTION_REL)];
}

/** The 16-row prod shape: `brokerName: "manual"`, `broker` KEY ABSENT. */
function manualRowBrokerAbsent(): StoredHolding {
  return {
    id: "hold-manual",
    userId: "user-1",
    symbol: "TATAMOTORS",
    exchange: "NSE",
    brokerName: "manual",
    quantity: 10,
    averagePrice: 100,
    investedValue: 1000,
  };
}

const ADD = {
  symbol: "tatamotors",
  exchange: "NSE",
  quantity: 5,
  averagePrice: 120,
};

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-1236 [meta] — the double models MONGO, not JavaScript", () => {
  const absent: Row = { id: "a" };
  const explicitNull: Row = { id: "b", broker: null };
  const owned: Row = { id: "c", broker: "ZERODHA" };
  const OR_FILTER: Row = {
    OR: [{ broker: null }, { broker: { isSet: false } }],
  };

  it("`{ broker: null }` alone does NOT match an ABSENT key", () => {
    // If this ever flips, every behavioural assertion below becomes vacuous:
    // the pre-fix filter would "work" in the double and the fix would look
    // like a no-op refactor.
    assert.equal(whereMatches(absent, { broker: null }), false);
    assert.equal(whereMatches(explicitNull, { broker: null }), true);
  });

  it("`{ isSet: false }` matches ONLY the absent key", () => {
    assert.equal(whereMatches(absent, { broker: { isSet: false } }), true);
    assert.equal(
      whereMatches(explicitNull, { broker: { isSet: false } }),
      false
    );
    assert.equal(whereMatches(owned, { broker: { isSet: false } }), false);
  });

  it("the OR covers both empty shapes and neither covers a real broker", () => {
    assert.equal(whereMatches(absent, OR_FILTER), true);
    assert.equal(whereMatches(explicitNull, OR_FILTER), true);
    assert.equal(whereMatches(owned, OR_FILTER), false);
  });
});

describe("MONEY-1236 — re-adding a manual symbol merges instead of duplicating", () => {
  let h: Harness;

  beforeEach(() => {
    h = {
      prisma: new FakePrisma([manualRowBrokerAbsent()]),
      userId: "user-1",
      isDemo: false,
      revalidated: [],
      cacheCleared: [],
    };
  });

  afterEach(() => {
    clearActionCache();
  });

  it("[regression] finds the row it wrote itself, whose `broker` key is ABSENT", async () => {
    const action = loadAction(h);
    const res = await action.addManualHoldingAction(ADD);

    assert.equal(res.success, true);
    assert.equal(
      h.prisma.callsFor("holding", "create").length,
      0,
      "a second add of the same symbol must not CREATE a duplicate row"
    );
    const updates = h.prisma.callsFor("holding", "update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].args.where?.id, "hold-manual");
    assert.equal(res.data?.holdingId, "hold-manual");
  });

  it("the merged row carries the SUMMED quantity and invested value", async () => {
    // 10 @ 100 (1,000) + 5 @ 120 (600) => 15 units, 1,600 invested, avg 106.67.
    const action = loadAction(h);
    await action.addManualHoldingAction(ADD);

    const data = h.prisma.callsFor("holding", "update")[0].args.data as Row;
    assert.equal(data.quantity, 15);
    assert.equal(data.investedValue, 1600);
    assert.equal(
      Math.round((data.averagePrice as number) * 100) / 100,
      106.67,
      "the merge must re-derive the average, not keep the old one"
    );
  });

  it("still merges when `broker` is an EXPLICIT null (the other empty shape)", async () => {
    // 0 rows on prod today, but a different writer or a backfill can stamp it,
    // and the OR must not have traded one shape for the other.
    h.prisma = new FakePrisma([{ ...manualRowBrokerAbsent(), broker: null }]);
    const action = loadAction(h);
    await action.addManualHoldingAction(ADD);

    assert.equal(h.prisma.callsFor("holding", "create").length, 0);
    assert.equal(h.prisma.callsFor("holding", "update").length, 1);
  });

  it("never merges a manual add into a BROKER-owned holding", async () => {
    // The dedup is deliberately scoped to manual rows: a synced Zerodha
    // position must not absorb a hand-typed one (its quantity is overwritten
    // by the next sync, so the manual units would silently vanish).
    h.prisma = new FakePrisma([
      { ...manualRowBrokerAbsent(), broker: "ZERODHA", brokerName: "zerodha" },
    ]);
    const action = loadAction(h);
    await action.addManualHoldingAction(ADD);

    assert.equal(h.prisma.callsFor("holding", "update").length, 0);
    assert.equal(h.prisma.callsFor("holding", "create").length, 1);
  });

  it("a first-time symbol still creates, with `broker` deliberately unset", async () => {
    h.prisma = new FakePrisma([]);
    const action = loadAction(h);
    await action.addManualHoldingAction(ADD);

    const created = h.prisma.callsFor("holding", "create")[0].args.data as Row;
    assert.equal(created.brokerName, "manual");
    assert.equal(
      Object.prototype.hasOwnProperty.call(created, "broker"),
      false,
      "the create still omits `broker` — which is exactly why the lookup " +
        "needs the isSet arm rather than the create needing a null"
    );
  });

  it("the dedup lookup is scoped to the caller's own userId", async () => {
    const action = loadAction(h);
    await action.addManualHoldingAction(ADD);
    const where = h.prisma.callsFor("holding", "findFirst")[0].args
      .where as Row;
    assert.equal(where.userId, "user-1");
    assert.equal(where.symbol, "TATAMOTORS", "symbol is upper-cased first");
    assert.equal(where.exchange, "NSE");
  });

  it("sends BOTH empty-shape arms to Prisma", async () => {
    const action = loadAction(h);
    await action.addManualHoldingAction(ADD);
    const where = h.prisma.callsFor("holding", "findFirst")[0].args
      .where as Row;
    assert.deepEqual(where.OR, [
      { broker: null },
      { broker: { isSet: false } },
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "broker"),
      false,
      "a leftover top-level `broker` would AND with the OR and re-break it"
    );
  });
});

describe("MONEY-1236 — the filter in the source, not just in a copy", () => {
  const SRC = join(__dirname, "..", "..", "lib", "actions", "holdings.ts");

  /**
   * MONEY-1143: LINE comments first, BLOCK comments second. A `//` line that
   * contains `/*` makes a block-first stripper swallow everything up to the
   * next close marker, and an absence assertion over swallowed text passes
   * while proving nothing.
   */
  function stripComments(src: string): string {
    return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  const stripped = stripComments(readFileSync(SRC, "utf8"));

  it("[meta] stripComments cannot swallow the code under scan", () => {
    const fixture = [
      "const a = 1;",
      "// a line comment mentioning /* which opens nothing",
      "const keep = { broker: { isSet: false } };",
      "/* a real block */",
    ].join("\n");
    const out = stripComments(fixture);
    assert.match(out, /isSet: false/);
    assert.doesNotMatch(out, /a real block/);
    assert.doesNotMatch(out, /a line comment/);
  });

  it("the dedup predicate comes from the SHARED module", () => {
    // The arms themselves are pinned where they are now defined —
    // `manualHoldingWhere` in holdings-dedup-logic.ts, covered by
    // __tests__/actions/holdings-dedup-logic.test.ts. What this file has to
    // assert is that the ACTION still routes through it, because an inline copy
    // is exactly how the two call sites drifted apart the first time.
    assert.match(
      stripped,
      /manualHoldingWhere\(/,
      "addManualHoldingAction must call the shared predicate"
    );
    assert.match(
      stripped,
      /holdings-dedup-logic/,
      "the shared module must actually be imported"
    );
  });

  it("[absence] no inline re-implementation of the predicate remains", () => {
    assert.doesNotMatch(
      stripped,
      /OR:\s*\[\s*\{\s*broker:\s*null\s*\}/,
      "a hand-copied OR here is how the gate and the writer drift apart"
    );
    assert.doesNotMatch(
      stripped,
      /exchange: data\.exchange,\s*broker: null,/,
      "a flat `broker: null` next to the exchange filter is the pre-fix " +
        "shape — it matches 0 of the 16 manual rows on prod"
    );
  });

  it("[absence] no inline re-implementation of the merge arithmetic remains", () => {
    // The inline copy's `averagePrice: newInvested / newQty` had no
    // zero-quantity guard, and the repaired dedup made it reachable.
    assert.doesNotMatch(
      stripped,
      /averagePrice:\s*new(?:Invested|Total)\s*\/\s*new(?:Qty|Quantity)/,
      "the merge must come from mergeManualHolding(), which guards the divisor"
    );
    assert.match(stripped, /mergeManualHolding\(/);
  });
});
