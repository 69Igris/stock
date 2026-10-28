/**
 * MONEY-620 — user.service IDOR + mass-assignment + currency allow-list, on the
 * LIVE service.
 *
 * Drives the REAL exported user-service functions from `@usemoney/services`
 * (`packages/services/src/user.service.ts`) — the user-facing identity/settings
 * path — through a RECORDING prisma double injected at the `@usemoney/database`
 * / `@usemoney/core` / `@usemoney/logger` module boundary via `require.cache`.
 * This is the proven seam from `holdings-poison-live.test.ts` /
 * `mutualfunds-data-e2e.test.ts`. No inline reimplementation: the SAME code that
 * ships builds the query / patch that we assert (no shadow), and no live Mongo /
 * Redis is ever touched (pure, exits clean).
 *
 * What this PINS on the LIVE service:
 *   1. IDOR — EVERY read/update WHERE is scoped to the caller's `userId`
 *      (`getUserProfile`, `getCurrencyPreference`, `updateCurrencyPreference`,
 *      `updateUserSettings`, `getOnboardingState`, `getUserById`,
 *      `getAccountTrialInfo`). An attacker can never name a victim's row — the
 *      only id the service ever writes is the caller's own.
 *   2. MASS-ASSIGNMENT — `updateUserSettings` strips privileged keys
 *      (plan/role/credits/isActive/clerkId/email/id/…) so the `data` that
 *      reaches `prisma.user.update` contains ONLY { name?, preferredCurrency? }.
 *   3. CURRENCY ALLOW-LIST — `updateCurrencyPreference` REJECTS a garbage code
 *      BEFORE any DB write (no `user.update` call at all); a valid code persists.
 *      A garbage STORED value is normalised to "INR" on read.
 *   4. INVALID-DATE — a corrupt `createdAt`/`updatedAt` never throws on
 *      `.toISOString()` (profile + trial degrade gracefully).
 *   5. BEHAVIOUR-PRESERVING — clean data yields the prior shapes/values.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/user.service.ts + ./user-logic.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;

  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    const err = self.failures.get(`${model}.${method}`);
                    if (err) return Promise.reject(err);
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── module-boundary injection ───────────────────────────────────────────────

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

interface CoreCacheRecorder {
  setCachedCalls: Array<{ namespace: string; userId: string; subkey: string }>;
  cacheHit?: unknown;
}
function freshCoreRecorder(): CoreCacheRecorder {
  return { setCachedCalls: [] };
}

let activePrisma: RecordingPrisma = new RecordingPrisma();
let activeCore: CoreCacheRecorder = freshCoreRecorder();

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined;
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") {
          return async () => {
            const hit = activeCore.cacheHit;
            activeCore.cacheHit = undefined;
            return hit ?? null;
          };
        }
        if (k === "setCached") {
          return async (namespace: string, userId: string, subkey: string) => {
            activeCore.setCachedCalls.push({ namespace, userId, subkey });
          };
        }
        return async () => {};
      },
    }
  );
}

// ── service module surface under test ───────────────────────────────────────

type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string };

interface UserProfileShape {
  id: string;
  email: string;
  name: string | null;
  preferredCurrency: string;
  createdAt: string | null;
  updatedAt: string | null;
}
interface OnboardingShape {
  seenVersions: string[];
  hasAcceptedTerms: boolean;
  hasSeenCurrentWalkthrough: boolean;
  isOnboarded: boolean;
}

interface ServicesModule {
  getUserById: (userId: string) => Promise<Result<{ id: string }>>;
  getUserProfile: (userId: string) => Promise<Result<UserProfileShape>>;
  getCurrencyPreference: (
    userId: string
  ) => Promise<Result<{ currency: string }>>;
  updateCurrencyPreference: (
    userId: string,
    currency: string
  ) => Promise<Result<{ currency: string }>>;
  updateUserSettings: (
    userId: string,
    patch: unknown
  ) => Promise<Result<UserProfileShape>>;
  getOnboardingState: (
    userId: string,
    currentVersion: string
  ) => Promise<Result<OnboardingShape>>;
  getAccountTrialInfo: (
    userId: string
  ) => Promise<Result<{ remainingDays: number; isTrialActive: boolean }>>;
}

let servicesSingleton: ServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): ServicesModule {
  if (servicesSingleton) return servicesSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("-logic.ts") ||
        key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as ServicesModule;
  return servicesSingleton;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

function reset(): { prisma: RecordingPrisma; core: CoreCacheRecorder } {
  activePrisma = new RecordingPrisma();
  activeCore = freshCoreRecorder();
  return { prisma: activePrisma, core: activeCore };
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

/** A complete Prisma User row (clean defaults) with the selected fields. */
function dbUser(
  overrides: Partial<{
    id: string;
    email: string;
    name: string | null;
    preferredCurrency: string;
    createdAt: Date;
    updatedAt: Date;
    walkthroughVersionsSeen: string[];
    termsAcceptedAt: Date | null;
  }> = {}
) {
  return {
    id: "owner",
    email: "owner@test.com",
    name: "Owner",
    preferredCurrency: "INR",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
    walkthroughVersionsSeen: [],
    termsAcceptedAt: null,
    ...overrides,
  };
}

// ===========================================================================
// IDOR — every read/update is scoped to the caller's userId
// ===========================================================================

describe("MONEY-620 — user.service IDOR scope (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("getUserProfile scopes findUnique to the caller's id (attacker cannot read a victim)", async () => {
    prisma.queue("user", "findUnique", dbUser({ id: "attacker-or-owner" }));
    await svc.getUserProfile("attacker-or-owner");
    const args = prisma.callsFor("user", "findUnique")[0]!.args as {
      where: { id: string };
    };
    assert.strictEqual(args.where.id, "attacker-or-owner");
  });

  it("getCurrencyPreference scopes findUnique to the caller's id", async () => {
    prisma.queue("user", "findUnique", { preferredCurrency: "USD" });
    await svc.getCurrencyPreference("uX");
    const args = prisma.callsFor("user", "findUnique")[0]!.args as {
      where: { id: string };
    };
    assert.strictEqual(args.where.id, "uX");
  });

  it("updateCurrencyPreference scopes update WHERE to the caller's id ONLY", async () => {
    prisma.queue("user", "update", { preferredCurrency: "USD" });
    await svc.updateCurrencyPreference("victim-tries-other", "USD");
    const calls = prisma.callsFor("user", "update");
    assert.strictEqual(calls.length, 1);
    const args = calls[0]!.args as { where: { id: string }; data: unknown };
    // The only id the service writes is the caller's own — no client-supplied
    // target id is ever honoured.
    assert.deepStrictEqual(args.where, { id: "victim-tries-other" });
  });

  it("updateUserSettings scopes update WHERE to the caller's id ONLY", async () => {
    prisma.queue("user", "update", dbUser({ id: "caller", name: "New" }));
    await svc.updateUserSettings("caller", { name: "New" });
    const args = prisma.callsFor("user", "update")[0]!.args as {
      where: { id: string };
    };
    assert.deepStrictEqual(args.where, { id: "caller" });
  });

  it("getOnboardingState scopes findUnique to the caller's id", async () => {
    prisma.queue(
      "user",
      "findUnique",
      dbUser({ walkthroughVersionsSeen: ["v1"], termsAcceptedAt: new Date() })
    );
    await svc.getOnboardingState("uZ", "v1");
    const args = prisma.callsFor("user", "findUnique")[0]!.args as {
      where: { id: string };
    };
    assert.strictEqual(args.where.id, "uZ");
  });

  it("getAccountTrialInfo scopes findUnique to the caller's id", async () => {
    prisma.queue("user", "findUnique", { createdAt: new Date() });
    await svc.getAccountTrialInfo("uT");
    const args = prisma.callsFor("user", "findUnique")[0]!.args as {
      where: { id: string };
    };
    assert.strictEqual(args.where.id, "uT");
  });
});

// ===========================================================================
// MASS-ASSIGNMENT — updateUserSettings strips privileged keys before the write
// ===========================================================================

describe("MONEY-620 — user.service mass-assignment guard (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("[SECURITY] plan/role/credits/isActive/clerkId/email/id NEVER reach prisma.user.update data", async () => {
    prisma.queue("user", "update", dbUser({ name: "Mallory" }));
    const res = await svc.updateUserSettings("attacker", {
      name: "Mallory",
      plan: "PRO",
      planId: "PRO",
      role: "admin",
      isAdmin: true,
      credits: 999999,
      creditsLimit: 999999,
      isActive: true,
      clerkId: "user_victim",
      email: "attacker@evil.com",
      id: "victim-id",
      termsAcceptedAt: new Date(0),
      subscription: { planId: "PRO" },
    });
    assert.strictEqual(res.success, true);

    const calls = prisma.callsFor("user", "update");
    assert.strictEqual(calls.length, 1, "exactly one update");
    const data = (calls[0]!.args as { data: Record<string, unknown> }).data;

    // ONLY the whitelisted display name survives.
    assert.deepStrictEqual(data, { name: "Mallory" });
    // Provable absence of every escalation field.
    for (const k of [
      "plan",
      "planId",
      "role",
      "isAdmin",
      "credits",
      "creditsLimit",
      "isActive",
      "clerkId",
      "email",
      "id",
      "termsAcceptedAt",
      "subscription",
    ]) {
      assert.strictEqual(k in data, false, `${k} must NOT be in update data`);
    }
  });

  it("[SECURITY] a present-but-invalid preferredCurrency in a bulk patch is stripped (garbage never persists)", async () => {
    prisma.queue("user", "update", dbUser({ name: "Legit" }));
    await svc.updateUserSettings("u1", {
      name: "Legit",
      preferredCurrency: "BTC", // garbage
    });
    const data = (
      prisma.callsFor("user", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.deepStrictEqual(data, { name: "Legit" });
    assert.strictEqual("preferredCurrency" in data, false);
  });

  it("a legit { name, preferredCurrency } patch is written verbatim (behaviour-preserving)", async () => {
    prisma.queue(
      "user",
      "update",
      dbUser({ name: "Deep", preferredCurrency: "USD" })
    );
    const res = ok(
      await svc.updateUserSettings("u2", {
        name: "  Deep  ", // trimmed
        preferredCurrency: "USD",
      })
    );
    const data = (
      prisma.callsFor("user", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.deepStrictEqual(data, { name: "Deep", preferredCurrency: "USD" });
    assert.strictEqual(res.data.preferredCurrency, "USD");
  });

  it("[SECURITY] a patch with ONLY privileged keys issues NO update (empty patch → no-op) and returns the profile", async () => {
    // No update is queued; the no-op path calls getUserProfile → findUnique.
    prisma.queue("user", "findUnique", dbUser({ id: "u3", name: "Unchanged" }));
    const res = ok(
      await svc.updateUserSettings("u3", {
        plan: "PRO",
        role: "admin",
        creditsLimit: 1e9,
      })
    );
    // Critically: NOT a single user.update was issued.
    assert.strictEqual(
      prisma.callsFor("user", "update").length,
      0,
      "no DB write for an all-privileged patch"
    );
    assert.strictEqual(res.data.name, "Unchanged");
    // It read the profile back (scoped) instead.
    assert.strictEqual(
      (
        prisma.callsFor("user", "findUnique")[0]!.args as {
          where: { id: string };
        }
      ).where.id,
      "u3"
    );
  });

  it("a non-object patch (string/null/array) issues NO update and returns the profile", async () => {
    prisma.queue("user", "findUnique", dbUser({ id: "u4" }));
    const res = ok(await svc.updateUserSettings("u4", "name=pwned"));
    assert.strictEqual(prisma.callsFor("user", "update").length, 0);
    assert.strictEqual(res.data.id, "u4");
  });
});

// ===========================================================================
// CURRENCY ALLOW-LIST — update rejects garbage before any write
// ===========================================================================

describe("MONEY-620 — user.service currency allow-list (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("[SECURITY] updateCurrencyPreference REJECTS garbage BEFORE touching the DB (no update call)", async () => {
    for (const bad of ["BTC", "inr", " INR ", "'; DROP", ""]) {
      ({ prisma } = reset());
      const res = await svc.updateCurrencyPreference("u1", bad);
      assert.strictEqual(res.success, false, `${JSON.stringify(bad)} rejected`);
      assert.strictEqual(
        prisma.callsFor("user", "update").length,
        0,
        `no DB write for invalid currency ${JSON.stringify(bad)}`
      );
    }
  });

  it("updateCurrencyPreference persists a VALID code and echoes it back", async () => {
    prisma.queue("user", "update", { preferredCurrency: "EUR" });
    const res = ok(await svc.updateCurrencyPreference("u2", "EUR"));
    const data = (
      prisma.callsFor("user", "update")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.deepStrictEqual(data, { preferredCurrency: "EUR" });
    assert.strictEqual(res.data.currency, "EUR");
  });

  it("[SECURITY] getCurrencyPreference normalises a garbage STORED value to INR (never echoes garbage)", async () => {
    prisma.queue("user", "findUnique", { preferredCurrency: "DOGE" });
    const res = ok(await svc.getCurrencyPreference("u3"));
    assert.strictEqual(res.data.currency, "INR");
  });

  it("getCurrencyPreference returns a valid stored value verbatim", async () => {
    prisma.queue("user", "findUnique", { preferredCurrency: "GBP" });
    const res = ok(await svc.getCurrencyPreference("u4"));
    assert.strictEqual(res.data.currency, "GBP");
  });
});

// ===========================================================================
// INVALID-DATE + behaviour-preserving + not-found + error sanitisation
// ===========================================================================

describe("MONEY-620 — user.service profile/trial/onboarding (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("getUserProfile maps a clean row (currency + ISO dates), behaviour-preserving", async () => {
    prisma.queue(
      "user",
      "findUnique",
      dbUser({
        id: "u1",
        email: "deep@test.com",
        name: "Deep",
        preferredCurrency: "USD",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-02-01T00:00:00Z"),
      })
    );
    const res = ok(await svc.getUserProfile("u1"));
    assert.deepStrictEqual(res.data, {
      id: "u1",
      email: "deep@test.com",
      name: "Deep",
      preferredCurrency: "USD",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("[EDGE] getUserProfile with a corrupt createdAt/updatedAt → null dates, NO throw", async () => {
    prisma.queue(
      "user",
      "findUnique",
      dbUser({
        createdAt: new Date("garbage"),
        updatedAt: new Date("also-bad"),
        preferredCurrency: "BTC", // also garbage → normalised
      })
    );
    let res!: { success: true; data: UserProfileShape };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getUserProfile("u2"));
    });
    assert.strictEqual(res.data.createdAt, null);
    assert.strictEqual(res.data.updatedAt, null);
    assert.strictEqual(res.data.preferredCurrency, "INR");
  });

  it("[EDGE] getAccountTrialInfo with a corrupt createdAt fails CLOSED (expired) without throwing", async () => {
    prisma.queue("user", "findUnique", { createdAt: new Date("nonsense") });
    let res!: {
      success: true;
      data: { remainingDays: number; isTrialActive: boolean };
    };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getAccountTrialInfo("u3"));
    });
    assert.strictEqual(res.data.remainingDays, 0);
    assert.strictEqual(res.data.isTrialActive, false);
  });

  it("getAccountTrialInfo computes + caches a fresh result for a new account", async () => {
    const { prisma: p, core } = reset();
    p.queue("user", "findUnique", { createdAt: new Date() });
    const res = ok(await svc.getAccountTrialInfo("u3b"));
    assert.strictEqual(res.data.isTrialActive, true);
    assert.strictEqual(res.data.remainingDays, 30);
    assert.ok(
      core.setCachedCalls.some(
        (c) =>
          c.namespace === "user" &&
          c.userId === "u3b" &&
          // MONEY-1062 Round-C (C3#1): subkey moved "trial" → "trial-v2" to stop
          // colliding with the (dead) web getAccountTrialInfoAction twin, which
          // writes a different shape/math under the same Redis key.
          c.subkey === "trial-v2"
      ),
      "trial result is cached under the caller's id"
    );
  });

  it("getOnboardingState derives + dedupes seen versions and the terms gate", async () => {
    prisma.queue(
      "user",
      "findUnique",
      dbUser({
        walkthroughVersionsSeen: ["v1-core", "v1-core", "v2-roast"],
        termsAcceptedAt: new Date("2026-01-01Z"),
      })
    );
    const res = ok(await svc.getOnboardingState("u4", "v2-roast"));
    assert.deepStrictEqual(res.data.seenVersions, ["v1-core", "v2-roast"]);
    assert.strictEqual(res.data.hasAcceptedTerms, true);
    assert.strictEqual(res.data.hasSeenCurrentWalkthrough, true);
    assert.strictEqual(res.data.isOnboarded, true);
  });

  it("getOnboardingState: brand-new user (no terms, no tours) → not onboarded", async () => {
    prisma.queue(
      "user",
      "findUnique",
      dbUser({ walkthroughVersionsSeen: [], termsAcceptedAt: null })
    );
    const res = ok(await svc.getOnboardingState("u5", "v2-roast"));
    assert.strictEqual(res.data.isOnboarded, false);
    assert.strictEqual(res.data.hasAcceptedTerms, false);
  });

  it("each read returns 'User not found' when the (scoped) row is missing", async () => {
    // findUnique defaults to null in the recorder → not-found branch.
    for (const call of [
      () => svc.getUserProfile("missing"),
      () => svc.getCurrencyPreference("missing"),
      () => svc.getOnboardingState("missing", "v1"),
      () => svc.getAccountTrialInfo("missing"),
      () => svc.getUserById("missing"),
    ]) {
      ({ prisma } = reset());
      const res = await call();
      assert.strictEqual(res.success, false);
      assert.match(
        (res as { success: false; error: string }).error,
        /not found|fetch/i
      );
    }
  });

  it("a raw DB error never leaks; returns a sanitized message", async () => {
    ({ prisma } = reset());
    prisma.fail(
      "user",
      "findUnique",
      new Error("E11000 duplicate key error on internal.users")
    );
    const res = await svc.getUserProfile("u6");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Failed to fetch user profile"
    );
  });

  it("updateCurrencyPreference: a DB throw is sanitized (no raw Mongo error leak)", async () => {
    ({ prisma } = reset());
    prisma.fail("user", "update", new Error("E11000 boom internal"));
    const res = await svc.updateCurrencyPreference("u7", "USD");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Failed to update currency preference"
    );
  });
});
