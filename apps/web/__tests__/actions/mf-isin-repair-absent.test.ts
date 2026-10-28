/**
 * MONEY-1236 — `populateMFISINAction` selects "no ISIN yet" in BOTH shapes.
 *
 * ## What was actually wrong, at its measured size
 *
 * All three repair strategies selected their work with `isin: null`. Prisma's
 * MongoDB connector compiles that to an equality against a STORED null, so a
 * document whose `isin` key is ABSENT is invisible to it; only
 * `{ isSet: false }` (or a raw `$exists: false`) reaches it.
 *
 * Measured on PROD 2026-08-21, `trades`:
 *
 *     total                36,933
 *     isin explicit null   12,987   <- `{ isin: null }` DOES select these
 *     isin ABSENT              28   (0.1%)  <- the invisible ones
 *     isin set             23,918
 *     source = "SYNCED"         0
 *
 * This is deliberately NOT written up as a high-impact bug. The repair was
 * already reaching 12,987 of the 13,015 rows that need it; the fix makes the
 * remaining 28 visible and puts the selector in the shape the other MONEY-1236
 * sites use. The ticket's claim that it "operates on an empty set" is wrong,
 * and the companion claim about synced trades is vacuous rather than damaging —
 * there are no synced trades on prod at all.
 *
 * The regression that would actually hurt is the opposite one: "fixing" the
 * selector in a way that drops the 12,987 explicit nulls. That is pinned here
 * as its own case.
 *
 * The REAL exported action runs; its boundaries are injected via `require.cache`
 * (the `broker-connection.test.ts` seam) and the Prisma double matches with
 * MONGO's rule, so an absent key really is absent. CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/broker-connection.ts (populateMFISINAction)
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

function notClause(clause: unknown): clause is { not: unknown } {
  return (
    typeof clause === "object" &&
    clause !== null &&
    "not" in (clause as Record<string, unknown>)
  );
}

function startsWithClause(clause: unknown): clause is { startsWith: string } {
  return (
    typeof clause === "object" &&
    clause !== null &&
    "startsWith" in (clause as Record<string, unknown>)
  );
}

/**
 * One field predicate with MongoDB's semantics:
 *
 *   `{ f: null }`             present-and-null ONLY (never an absent key)
 *   `{ f: { isSet: false } }` absent key ONLY
 *   `{ f: { not: null } }`    present-and-non-null ONLY — on Mongo a missing
 *                             field compares EQUAL to null, so `$ne: null`
 *                             excludes it, which is what the reference-trade
 *                             query wants and why it is left unchanged.
 */
function fieldMatches(row: Row, key: string, clause: unknown): boolean {
  const present =
    Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined;
  if (isSetClause(clause)) return clause.isSet === present;
  if (notClause(clause)) {
    if (clause.not === null) return present && row[key] !== null;
    return !present || row[key] !== clause.not;
  }
  if (startsWithClause(clause)) {
    return (
      present &&
      typeof row[key] === "string" &&
      (row[key] as string).startsWith(clause.startsWith)
    );
  }
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

interface StoredTrade extends Row {
  id: string;
  userId: string;
  segment: string;
  symbol: string;
  /** Absent on purpose in the fixtures that model the 28 prod rows. */
  isin?: string | null;
  tradingSymbol?: string | null;
}

interface RecordedCall {
  model: string;
  method: string;
  args: { where?: Row; data?: Row };
}

class FakePrisma {
  readonly calls: RecordedCall[] = [];
  constructor(readonly trades: StoredTrade[] = []) {}

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }

  get client(): Record<string, unknown> {
    const self = this;
    const model = (name: string) => ({
      findMany: (args: { where: Row; select?: Row }) => {
        self.calls.push({ model: name, method: "findMany", args });
        if (name !== "trade") return Promise.resolve([]);
        return Promise.resolve(
          self.trades.filter((t) => whereMatches(t, args.where))
        );
      },
      findFirst: (args: { where: Row }) => {
        self.calls.push({ model: name, method: "findFirst", args });
        return Promise.resolve(null);
      },
      update: (args: { where: Row; data: Row }) => {
        self.calls.push({ model: name, method: "update", args });
        const row = self.trades.find((t) => t.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return Promise.resolve(row ?? {});
      },
      count: () => Promise.resolve(0),
    });
    return new Proxy(
      {},
      {
        get(target: Record<string, unknown>, prop: string) {
          if (typeof prop !== "string") return undefined;
          if (!(prop in target)) target[prop] = model(prop);
          return target[prop];
        },
      }
    );
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
  clerkUserId: string | null;
  isDemo: boolean;
  revalidated: string[];
}

interface ActionModule {
  populateMFISINAction: () => Promise<{
    success: boolean;
    updated: number;
    paired?: number;
    error?: string;
  }>;
}

const ACTION_REL = "../../lib/actions/broker-connection";

function loadAction(h: Harness): ActionModule {
  const cache = moduleCache();
  const resolve = (p: string) => require.resolve(p);

  cache[resolve("@clerk/nextjs/server")] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.clerkUserId }),
      currentUser: () => Promise.resolve(null),
    },
  };
  cache[resolve("@/lib/prisma")] = {
    exports: {
      __esModule: true,
      prisma: h.prisma.client,
      default: h.prisma.client,
    },
  };
  cache[resolve("@/lib/db/user")] = {
    exports: {
      __esModule: true,
      getOrCreateDbUser: () =>
        Promise.resolve(
          h.clerkUserId ? { id: "user-1", email: "mf@example.com" } : null
        ),
    },
  };
  cache[resolve("@/lib/auth")] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () =>
        Promise.resolve(h.clerkUserId ? { userId: "user-1" } : null),
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
    exports: { __esModule: true, demoBrokerConnections: [] },
  };
  cache[resolve("@usemoney/security/encryption")] = {
    exports: {
      __esModule: true,
      encryption: {
        decrypt: () => ({ accessToken: "t" }),
        encrypt: () => ({ encrypted: "x", iv: "y", authTag: "z" }),
      },
    },
  };
  cache[resolve("@usemoney/core/brokers/oauth-state")] = {
    exports: {
      __esModule: true,
      generateOAuthState: async () => "state",
      verifyOAuthState: async () => true,
      storeReauthIntent: async () => {},
      consumeReauthIntent: async () => null,
    },
  };
  cache[resolve("@usemoney/core")] = {
    exports: new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getBrokerConfig")
            return () => ({ name: "Broker", envKeys: { apiKey: "K" } });
          if (k === "getBrokerEnvKeys") return () => ({ apiKey: "K" });
          if (k === "getCached") return async () => null;
          return async () => {};
        },
      }
    ),
  };
  cache[resolve("@/lib/brokers/clients")] = {
    exports: {
      __esModule: true,
      createBrokerClient: () => ({}),
      ZerodhaClient: class {},
      UpstoxClient: class {},
      FyersClient: class {},
      IciciClient: class {},
      HdfcClient: class {},
      InteractiveBrokersClient: class {},
    },
  };
  cache[resolve("@/lib/brokers/oauth-url")] = {
    exports: {
      __esModule: true,
      buildBrokerOAuthUrl: () => ({ success: true }),
    },
  };
  cache[resolve("@/lib/subscription/access")] = {
    exports: {
      __esModule: true,
      getSubscriptionAccess: async () => ({ planId: "PRO" }),
    },
  };
  cache[resolve("@/lib/brokers/failure-log")] = {
    exports: { __esModule: true, recordBrokerFailure: () => {} },
  };
  cache[resolve("@/lib/brokers/known-errors")] = {
    exports: { __esModule: true, mapKnownBrokerError: () => null },
  };
  cache[resolve("@/lib/db/notifications")] = {
    exports: { __esModule: true, createNotification: async () => {} },
  };
  cache[resolve("@usemoney/services")] = {
    exports: {
      __esModule: true,
      getBrokerConnections: async () => ({ success: true, data: [] }),
      deleteBrokerConnection: async () => ({ success: true }),
      syncHistoricalTradebook: async () => ({ success: true }),
      persistBrokerConnection: async () => ({ success: true }),
      diagnoseMFPairing: async () => ({}),
      // Strategy 3/4 matching is contract-tested in @usemoney/services
      // (broker-diagnostics-logic). This suite is about the SELECTORS, so the
      // matcher is stubbed to "no match" and the reference set is left empty.
      buildIsinMap: () => ({}),
      matchIsinForTrade: () => null,
    },
  };
  cache[resolve("@usemoney/email")] = {
    exports: {
      __esModule: true,
      sendEmail: async () => ({ success: true }),
      getEffectivePreferences: () => ({}),
      shouldSendEmail: () => false,
      buildUnsubscribeUrl: () => "https://usemoney.ai/unsub",
    },
  };
  cache[resolve("@usemoney/email/templates")] = {
    exports: {
      __esModule: true,
      BrokerConnectedEmail: () => null,
      BrokerDisconnectedEmail: () => null,
    },
  };
  cache[resolve("@usemoney/pubsub/publish")] = {
    exports: {
      __esModule: true,
      publishSyncJob: async () => ({ jobId: "job-1" }),
      publishPairingJob: async () => ({ jobId: "job-2" }),
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

function baseHarness(trades: StoredTrade[]): Harness {
  return {
    prisma: new FakePrisma(trades),
    clerkUserId: "clerk_abc",
    isDemo: false,
    revalidated: [],
  };
}

/** The 28-row prod shape: the `isin` KEY is absent, not null. */
const ISIN_ABSENT: StoredTrade = {
  id: "t-absent",
  userId: "user-1",
  segment: "MF",
  symbol: "SOME FUND - DIRECT GROWTH",
  tradingSymbol: "INF204K01XX9",
};

/** The 12,987-row prod shape: an explicit stored null. */
const ISIN_EXPLICIT_NULL: StoredTrade = {
  id: "t-null",
  userId: "user-1",
  segment: "MF",
  symbol: "OTHER FUND - DIRECT GROWTH",
  tradingSymbol: "INF109K01Z48",
  isin: null,
};

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-1236 [meta] — the double models MONGO, not JavaScript", () => {
  it("`{ isin: null }` alone misses an ABSENT key but keeps the stored null", () => {
    assert.equal(whereMatches(ISIN_ABSENT, { isin: null }), false);
    assert.equal(whereMatches(ISIN_EXPLICIT_NULL, { isin: null }), true);
  });

  it("the OR selects both empty shapes and skips a populated ISIN", () => {
    const or = { OR: [{ isin: null }, { isin: { isSet: false } }] };
    assert.equal(whereMatches(ISIN_ABSENT, or), true);
    assert.equal(whereMatches(ISIN_EXPLICIT_NULL, or), true);
    assert.equal(whereMatches({ ...ISIN_ABSENT, isin: "INF1" }, or), false);
  });

  it("`{ not: null }` excludes BOTH empty shapes — the reference query", () => {
    // Left unchanged on purpose: a row with no `isin` key is not a reference
    // row, and `$ne: null` already excludes it on Mongo.
    const ref = { isin: { not: null } };
    assert.equal(whereMatches(ISIN_ABSENT, ref), false);
    assert.equal(whereMatches(ISIN_EXPLICIT_NULL, ref), false);
    assert.equal(whereMatches({ ...ISIN_ABSENT, isin: "INF1" }, ref), true);
  });
});

describe("MONEY-1236 — populateMFISINAction repairs both empty shapes", () => {
  let h: Harness;

  afterEach(() => {
    clearActionCache();
  });

  it("[regression] repairs a trade whose `isin` key is ABSENT (28 prod rows)", async () => {
    h = baseHarness([{ ...ISIN_ABSENT }]);
    const action = loadAction(h);
    const res = await action.populateMFISINAction();

    assert.equal(res.success, true);
    assert.equal(res.updated, 1, "the absent-key trade must be selected");
    const update = h.prisma.callsFor("trade", "update")[0];
    assert.equal(update.args.where?.id, "t-absent");
    assert.equal(update.args.data?.isin, "INF204K01XX9");
    assert.equal(update.args.data?.needsRepairing, true);
  });

  it("still repairs the EXPLICIT-null trades (12,987 prod rows kept)", async () => {
    // The failure mode of a careless fix: swapping `null` for `isSet:false`
    // instead of OR-ing them, which would trade 28 rows for 12,987.
    h = baseHarness([{ ...ISIN_EXPLICIT_NULL }]);
    const action = loadAction(h);
    const res = await action.populateMFISINAction();

    assert.equal(res.updated, 1);
    assert.equal(
      h.prisma.callsFor("trade", "update")[0].args.data?.isin,
      "INF109K01Z48"
    );
  });

  it("both shapes in one run, and a populated ISIN is left alone", async () => {
    h = baseHarness([
      { ...ISIN_ABSENT },
      { ...ISIN_EXPLICIT_NULL },
      {
        id: "t-done",
        userId: "user-1",
        segment: "MF",
        symbol: "DONE FUND",
        tradingSymbol: "INF999K01AA1",
        isin: "INF999K01AA1",
      },
    ]);
    const action = loadAction(h);
    const res = await action.populateMFISINAction();

    assert.equal(res.updated, 2);
    const touched = h.prisma
      .callsFor("trade", "update")
      .map((c) => c.args.where?.id);
    assert.deepEqual(touched.sort(), ["t-absent", "t-null"]);
  });

  it("all THREE selectors carry the isSet arm; the reference query does not", async () => {
    h = baseHarness([]);
    const action = loadAction(h);
    await action.populateMFISINAction();

    const wheres = h.prisma
      .callsFor("trade", "findMany")
      .map((c) => c.args.where as Row);
    assert.equal(wheres.length, 4, "3 repair selectors + 1 reference query");

    const OR_SHAPE = [{ isin: null }, { isin: { isSet: false } }];
    for (const [i, where] of wheres.slice(0, 3).entries()) {
      assert.deepEqual(where.OR, OR_SHAPE, `strategy ${i + 1} selector`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(where, "isin"),
        false,
        `strategy ${i + 1} must not ALSO carry a top-level isin filter`
      );
      assert.equal(where.userId, "user-1", "IDOR: scoped to the caller");
      assert.equal(where.segment, "MF");
    }
    assert.deepEqual(
      wheres[3].isin,
      { not: null },
      "the reference query stays `not: null` — it must EXCLUDE absent rows"
    );
  });

  it("demo mode short-circuits before any DB read", async () => {
    h = baseHarness([{ ...ISIN_ABSENT }]);
    h.isDemo = true;
    const action = loadAction(h);
    const res = await action.populateMFISINAction();

    assert.equal(res.success, false);
    assert.equal(res.updated, 0);
    assert.equal(h.prisma.calls.length, 0);
  });
});

describe("MONEY-1236 — the selectors in the source, not just in a copy", () => {
  const SRC = join(
    __dirname,
    "..",
    "..",
    "lib",
    "actions",
    "broker-connection.ts"
  );

  /**
   * MONEY-1143: LINE comments first, BLOCK comments second — a `//` line that
   * contains `/*` makes a block-first stripper eat the file, and an absence
   * assertion over eaten text passes while proving nothing.
   */
  function stripComments(src: string): string {
    return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  const stripped = stripComments(readFileSync(SRC, "utf8"));

  it("[meta] stripComments cannot swallow the code under scan", () => {
    const fixture = [
      "const a = 1;",
      "// a line comment mentioning /* which opens nothing",
      "const keep = { isin: { isSet: false } };",
      "/* a real block */",
    ].join("\n");
    const out = stripComments(fixture);
    assert.match(out, /isSet: false/);
    assert.doesNotMatch(out, /a real block/);
    assert.doesNotMatch(out, /a line comment/);
  });

  it("exactly three repair selectors carry the isSet:false arm", () => {
    const hits = stripped.match(
      /OR: \[\{ isin: null \}, \{ isin: \{ isSet: false \} \}\]/g
    );
    assert.equal(
      hits?.length,
      3,
      "strategies 1, 2 and 3 must all select both empty shapes"
    );
  });

  it("[absence] no bare `isin: null` selector survives", () => {
    assert.doesNotMatch(
      stripped,
      /\bisin: null,/,
      "a flat `isin: null,` is the pre-fix shape — it cannot see the 28 " +
        "absent-key trades on prod"
    );
  });

  it("the reference query still uses `not: null` (absent rows excluded)", () => {
    assert.match(stripped, /isin: \{ not: null \}/);
  });
});
