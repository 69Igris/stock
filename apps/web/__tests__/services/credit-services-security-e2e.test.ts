/**
 * MONEY-620 — credit + credit-reservation services SECURITY e2e (REAL fns).
 *
 * Drives the REAL exported functions of:
 *   - packages/services/src/credit.service.ts
 *       (checkCredits, consumeCredits, refundCredits, getCreditBalance)
 *   - packages/services/src/credit-reservation.service.ts
 *       (reserveCredits, commitCredits, refundReservationCredits,
 *        checkCreditAvailability)
 *
 * This is REAL MONEY + ACCESS CONTROL, so the assertions are adversarial:
 *   - IDOR: every balance read / deduct / refund / reservation Prisma call
 *     carries the caller's userId in its `where`.
 *   - DOUBLE-SPEND / negative balance: the deduct + reserve land via a
 *     CONDITIONAL `updateMany` (atomic `where … <= limit - cost`, `increment`),
 *     never a read-then-absolute-write; `count === 0` (lost race) is rejected,
 *     never granted.
 *   - non-finite: NaN/Infinity cost/amount can't corrupt the balance or pass
 *     the gate.
 *   - over-refund / committed-then-released / double-commit are rejected.
 *
 * Seam (the established `services-data-e2e.test.ts` pattern): inject a RECORDING
 * prisma + silent logger + analytics no-op at the module boundaries via
 * `require.cache` BEFORE requiring the `@usemoney/services` barrel. The
 * recording prisma is a Proxy that captures every `model.method(args)` and
 * returns a per-key queued result (FIFO), so the SAME query/write the service
 * builds is what we assert. No live Mongo / Redis. CWD must be `apps/web`.
 *
 * Source: packages/services/src/credit.service.ts + credit-reservation.service.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/**
 * Records every `model.method(args)` and returns the next queued result for
 * that exact key (FIFO). `updateMany` defaults to `{ count: 1 }` (the charge
 * landed) unless a `{ count: 0 }` is explicitly queued to simulate a lost race.
 * `$transaction([p1, p2, …])` awaits the (already-invoked) promises in order.
 */
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
    const key = `${model}.${method}`;
    const q = this.queues.get(key);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    if (method === "updateMany") return { count: 1 };
    if (method === "update" || method === "create") return {};
    return [];
  }

  readonly client: Record<string, unknown>;

  constructor() {
    const self = this;
    const modelProxy = (model: string) =>
      new Proxy(
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

    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, prop: string) {
          if (typeof prop !== "string") return undefined;
          if (prop === "then") return undefined;
          if (prop === "$transaction") {
            // Accept an array of (already-invoked) promises — the services pass
            // `[prisma.x.update(...), prisma.y.create(...)]`. Await them in
            // order and return their results, mirroring Prisma's batch API.
            return (ops: unknown) =>
              Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops);
          }
          if (!(prop in target)) target[prop] = modelProxy(prop);
          return target[prop];
        },
      }
    );
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

let activePrisma: RecordingPrisma = new RecordingPrisma();

/** Stable prisma stub forwarding to the swappable active recorder. */
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, prop: string) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      if (prop === "$transaction") {
        return (ops: unknown) =>
          (
            activePrisma.client as { $transaction: (o: unknown) => unknown }
          ).$transaction(ops);
      }
      if (!(prop in target)) {
        target[prop] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                (
                  activePrisma.client as Record<
                    string,
                    Record<string, (a?: unknown) => Promise<unknown>>
                  >
                )[prop]![method]!(args);
            },
          }
        );
      }
      return target[prop];
    },
  }
);

let servicesSingleton: CreditServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

/**
 * Install stubs + require the barrel once. We stub @usemoney/database (prisma),
 * @usemoney/logger, and `./analytics` (the fire-and-forget PostHog capture in
 * ensureSubscription) so a self-heal can't touch network. @usemoney/core stays
 * REAL (CREDIT_COSTS / getCreditCost / getPlanCredits are pure data).
 */
function installServices(): CreditServicesModule {
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
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());

  // Stub the analytics sibling so ensureSubscription's captureServiceEvent is a
  // no-op (it is otherwise gated on NEXT_PUBLIC_POSTHOG_KEY, but be explicit).
  const analyticsPath =
    require.resolve("../../../../packages/services/src/analytics");
  priorCacheEntries.push([analyticsPath, cache[analyticsPath]]);
  cache[analyticsPath] = {
    exports: { __esModule: true, captureServiceEvent: () => {} },
  };

  // Drop any already-loaded service modules so they re-bind to our stubs.
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as CreditServicesModule;
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

function reset(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

// ── structural types for the surface we drive ────────────────────────────────

interface ServiceOk<T> {
  success: true;
  data: T;
  message?: string;
}
interface ServiceErr {
  success: false;
  error: string;
  code?: string;
}
type Result<T> = ServiceOk<T> | ServiceErr;

interface CreditServicesModule {
  checkCredits: (
    userId: string,
    action: string
  ) => Promise<Result<{ allowed: boolean; remaining: number; cost: number }>>;
  consumeCredits: (
    userId: string,
    action: string,
    metadata?: { costOverride?: number }
  ) => Promise<
    Result<{ remaining: number; source: string; creditsUsed: number }>
  >;
  refundCredits: (
    userId: string,
    action: string,
    amount?: number
  ) => Promise<Result<{ refunded: number }>>;
  getCreditBalance: (
    userId: string
  ) => Promise<Result<{ plan: number; pack: number; total: number }>>;
  reserveCredits: (
    userId: string,
    credits: number,
    analysisType: string,
    sessionId?: string
  ) => Promise<Result<{ reservationId: string; creditsReserved: number }>>;
  commitCredits: (
    reservationId: string
  ) => Promise<Result<{ committed: number }>>;
  refundReservationCredits: (
    reservationId: string,
    completedSegments: number,
    totalSegments: number
  ) => Promise<Result<{ refunded: number }>>;
  checkCreditAvailability: (
    userId: string,
    creditsNeeded: number
  ) => Promise<Result<{ available: number; sufficient: boolean }>>;
}

function ok<T>(r: Result<T>): ServiceOk<T> {
  assert.equal(r.success, true, `expected success, got: ${JSON.stringify(r)}`);
  return r as ServiceOk<T>;
}
function err<T>(r: Result<T>): ServiceErr {
  assert.equal(r.success, false, `expected failure, got: ${JSON.stringify(r)}`);
  return r as ServiceErr;
}

/** A live subscription row for `findUnique({ where:{ userId } })`. */
function subRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "u",
    planId: "FREE",
    status: "ACTIVE",
    creditsUsed: 0,
    creditsLimit: 5,
    packCreditsUsed: 0,
    packCreditsLimit: 0,
    comprehensiveCreditsUsed: 0,
    comprehensiveCreditsLimit: 0,
    ...o,
  };
}

// ── consumeCredits ───────────────────────────────────────────────────────────

describe("MONEY-620 — consumeCredits (real fn): IDOR + atomic double-spend guard", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("charges plan credits via an ATOMIC guarded updateMany scoped to userId (not read-then-write)", async () => {
    // ensureSubscription.findUnique → existing healthy FREE sub.
    prisma.queue("subscription", "findUnique", subRow({ creditsLimit: 5 }));
    // consume loop findUnique → snapshot.
    prisma.queue("subscription", "findUnique", {
      creditsUsed: 0,
      creditsLimit: 5,
      packCreditsUsed: 0,
      packCreditsLimit: 0,
    });
    // plan charge updateMany → landed.
    prisma.queue("subscription", "updateMany", { count: 1 });

    const res = ok(await svc.consumeCredits("user-c1", "l2_research_fast")); // cost 1
    assert.equal(res.data.creditsUsed, 1);
    assert.equal(res.data.source, "plan");

    const upd = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      where: { userId: string; creditsUsed: { lte: number } };
      data: { creditsUsed: { increment: number } };
    };
    // IDOR: the charge is scoped to the caller.
    assert.equal(upd.where.userId, "user-c1");
    // Atomic guard: re-asserts creditsUsed <= limit - cost at write time …
    assert.equal(upd.where.creditsUsed.lte, 4); // 5 - 1
    // … and the debit is an atomic INCREMENT, never an absolute write.
    assert.equal(upd.data.creditsUsed.increment, 1);
  });

  it("rejects (INSUFFICIENT) without any updateMany when the balance can't cover the cost", async () => {
    prisma.queue(
      "subscription",
      "findUnique",
      subRow({ creditsUsed: 5, creditsLimit: 5 })
    );
    prisma.queue("subscription", "findUnique", {
      creditsUsed: 5,
      creditsLimit: 5,
      packCreditsUsed: 0,
      packCreditsLimit: 0,
    });
    const res = err(
      await svc.consumeCredits("user-c2", "l2_research_advanced")
    ); // cost 3
    assert.equal(res.code, "INSUFFICIENT_CREDITS");
    // Never attempted a debit.
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });

  it("retries on a lost race (updateMany count 0) then fails CLOSED — never grants without a debit", async () => {
    // Healthy sub, then 4 snapshot reads each followed by a count-0 charge.
    prisma.queue("subscription", "findUnique", subRow({ creditsLimit: 5 }));
    for (let i = 0; i < 4; i++) {
      prisma.queue("subscription", "findUnique", {
        creditsUsed: 0,
        creditsLimit: 5,
        packCreditsUsed: 0,
        packCreditsLimit: 0,
      });
      prisma.queue("subscription", "updateMany", { count: 0 }); // always lose
    }
    const res = err(await svc.consumeCredits("user-c3", "l2_research_fast"));
    assert.equal(res.code, "INSUFFICIENT_CREDITS");
    // It tried the bounded number of times and never granted.
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 4);
  });

  it("non-finite costOverride falls back to the catalogue cost (never debits NaN/Infinity)", async () => {
    prisma.queue("subscription", "findUnique", subRow({ creditsLimit: 5 }));
    prisma.queue("subscription", "findUnique", {
      creditsUsed: 0,
      creditsLimit: 5,
      packCreditsUsed: 0,
      packCreditsLimit: 0,
    });
    prisma.queue("subscription", "updateMany", { count: 1 });
    // costOverride NaN must be ignored → falls back to l2_research_fast = 1.
    const res = ok(
      await svc.consumeCredits("user-c4", "l2_research_fast", {
        costOverride: NaN,
      })
    );
    assert.equal(res.data.creditsUsed, 1);
    const upd = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      data: { creditsUsed: { increment: number } };
    };
    assert.ok(Number.isFinite(upd.data.creditsUsed.increment));
    assert.equal(upd.data.creditsUsed.increment, 1); // not NaN
  });

  it("a free (0-cost) action records usage but issues NO charge", async () => {
    // l1_flash = 0; consume short-circuits before any subscription read/charge.
    const res = ok(await svc.consumeCredits("user-c5", "l1_flash"));
    assert.equal(res.data.creditsUsed, 0);
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });

  it("blocks a non-ACTIVE subscription up front (no charge)", async () => {
    prisma.queue(
      "subscription",
      "findUnique",
      subRow({ status: "EXPIRED", planId: "PRO" })
    );
    const res = err(await svc.consumeCredits("user-c6", "l2_research_fast"));
    assert.match(res.error, /not active/i);
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });
});

// ── refundCredits ────────────────────────────────────────────────────────────

describe("MONEY-620 — refundCredits (real fn): NaN-corruption + over-refund + IDOR", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("refunds via a guarded atomic DECREMENT scoped to userId (no read-then-absolute-write)", async () => {
    prisma.queue(
      "subscription",
      "findUnique",
      subRow({ creditsUsed: 3, creditsLimit: 5 })
    );
    prisma.queue("subscription", "updateMany", { count: 1 });
    const res = ok(await svc.refundCredits("user-r1", "l2_research_advanced")); // cost 3
    assert.equal(res.data.refunded, 3);

    const upd = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      where: { userId: string; creditsUsed: { gte: number } };
      data: { creditsUsed: { decrement: number } };
    };
    assert.equal(upd.where.userId, "user-r1"); // IDOR
    assert.equal(upd.where.creditsUsed.gte, 3); // underflow guard
    assert.equal(upd.data.creditsUsed.decrement, 3); // atomic decrement
  });

  it("REJECTS a NaN amount and writes NOTHING (the live column-corruption bug)", async () => {
    prisma.queue("subscription", "findUnique", subRow({ creditsUsed: 3 }));
    const res = err(
      await svc.refundCredits("user-r2", "l2_research_fast", NaN)
    );
    assert.match(res.error, /invalid refund amount/i);
    // The corrupting `update`/`updateMany` never ran.
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
    assert.equal(prisma.callsFor("subscription", "update").length, 0);
  });

  it("REJECTS ±Infinity and negative refund amounts (no write)", async () => {
    for (const bad of [Infinity, -Infinity, -5]) {
      prisma = reset();
      prisma.queue("subscription", "findUnique", subRow({ creditsUsed: 3 }));
      const res = err(
        await svc.refundCredits("user-r3", "l2_research_fast", bad)
      );
      assert.match(res.error, /invalid refund amount/i);
      assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
    }
  });

  it("CLAMPS an over-large refund to actual usage — can't mint free credits", async () => {
    // user only used 2 plan credits; a caller asks to refund 9999.
    prisma.queue(
      "subscription",
      "findUnique",
      subRow({ creditsUsed: 2, packCreditsUsed: 0 })
    );
    prisma.queue("subscription", "updateMany", { count: 1 });
    const res = ok(await svc.refundCredits("user-r4", "ignored", 9999));
    assert.equal(res.data.refunded, 2); // never 9999
    const upd = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      data: { creditsUsed: { decrement: number } };
    };
    assert.equal(upd.data.creditsUsed.decrement, 2);
  });

  it("a 0-credit action is a no-op refund (no subscription read/write)", async () => {
    const res = ok(await svc.refundCredits("user-r5", "l1_flash")); // cost 0
    assert.equal(res.data.refunded, 0);
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });
});

// ── getCreditBalance + checkCredits ──────────────────────────────────────────

describe("MONEY-620 — getCreditBalance / checkCredits (real fn): IDOR + finite", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("reads the balance scoped to userId and never returns a NaN total on a corrupt row", async () => {
    prisma.queue(
      "subscription",
      "findUnique",
      subRow({ creditsUsed: NaN, creditsLimit: 5, packCreditsLimit: Infinity })
    );
    const res = ok(await svc.getCreditBalance("user-b1"));
    const find = prisma.callsFor("subscription", "findUnique")[0]!.args as {
      where: { userId: string };
    };
    assert.equal(find.where.userId, "user-b1"); // IDOR
    assert.ok(Number.isFinite(res.data.total));
    assert.ok(Number.isFinite(res.data.plan));
    assert.ok(Number.isFinite(res.data.pack));
  });

  it("checkCredits fails closed for an action whose (hypothetical) cost can't be afforded", async () => {
    // l3_comprehensive_stock = 10 credits; FREE sub has 5.
    prisma.queue("subscription", "findUnique", subRow({ creditsLimit: 5 }));
    const res = ok(await svc.checkCredits("user-b2", "l3_comprehensive_stock"));
    assert.equal(res.data.allowed, false);
    assert.equal(res.data.cost, 10);
  });

  it("checkCredits allows a 0-cost action without reading the subscription", async () => {
    const res = ok(await svc.checkCredits("user-b3", "l1_flash"));
    assert.equal(res.data.allowed, true);
    assert.equal(prisma.callsFor("subscription", "findUnique").length, 0);
  });
});

// ── reserveCredits ───────────────────────────────────────────────────────────

describe("MONEY-620 — reserveCredits (real fn): atomic guard + negative-reserve exploit", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("debits comprehensive credits via an ATOMIC guarded updateMany scoped to userId", async () => {
    prisma.queue("subscription", "findUnique", {
      comprehensiveCreditsUsed: 0,
      comprehensiveCreditsLimit: 20,
      planId: "PRO",
    });
    prisma.queue("subscription", "updateMany", { count: 1 }); // debit landed
    prisma.queue("creditReservation", "create", {});

    const res = ok(
      await svc.reserveCredits("user-rs1", 8, "comprehensive_stock", "sess-1")
    );
    assert.equal(res.data.creditsReserved, 8);

    const upd = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      where: { userId: string; comprehensiveCreditsUsed: { lte: number } };
      data: { comprehensiveCreditsUsed: { increment: number } };
    };
    assert.equal(upd.where.userId, "user-rs1"); // IDOR
    assert.equal(upd.where.comprehensiveCreditsUsed.lte, 12); // 20 - 8
    assert.equal(upd.data.comprehensiveCreditsUsed.increment, 8); // atomic increment

    // The reservation row is scoped to the same user.
    const create = prisma.callsFor("creditReservation", "create")[0]!.args as {
      data: { userId: string; creditsReserved: number; status: string };
    };
    assert.equal(create.data.userId, "user-rs1");
    assert.equal(create.data.creditsReserved, 8);
    assert.equal(create.data.status, "RESERVED");
  });

  it("rejects a lost race (updateMany count 0) as INSUFFICIENT — never creates a reservation", async () => {
    prisma.queue("subscription", "findUnique", {
      comprehensiveCreditsUsed: 0,
      comprehensiveCreditsLimit: 20,
      planId: "PRO",
    });
    prisma.queue("subscription", "updateMany", { count: 0 }); // lost race
    const res = err(
      await svc.reserveCredits("user-rs2", 8, "comprehensive_stock")
    );
    assert.equal(res.code, "INSUFFICIENT_CREDITS");
    assert.equal(prisma.callsFor("creditReservation", "create").length, 0);
  });

  it("EXPLOIT FIX: a NEGATIVE reserve is rejected and NEVER decrements used (no free credits)", async () => {
    prisma.queue("subscription", "findUnique", {
      comprehensiveCreditsUsed: 0,
      comprehensiveCreditsLimit: 20,
      planId: "PRO",
    });
    const res = err(
      await svc.reserveCredits("user-rs3", -5, "comprehensive_stock")
    );
    assert.match(res.error, /invalid credit amount/i);
    // No debit/increment, no reservation row created.
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
    assert.equal(prisma.callsFor("creditReservation", "create").length, 0);
  });

  it("rejects NaN / Infinity reserve amounts", async () => {
    for (const bad of [NaN, Infinity]) {
      prisma = reset();
      prisma.queue("subscription", "findUnique", {
        comprehensiveCreditsUsed: 0,
        comprehensiveCreditsLimit: 20,
        planId: "PRO",
      });
      const res = err(
        await svc.reserveCredits("user-rs4", bad, "comprehensive_stock")
      );
      assert.equal(res.success, false);
      assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
    }
  });

  it("rejects when requested credits exceed available", async () => {
    prisma.queue("subscription", "findUnique", {
      comprehensiveCreditsUsed: 18,
      comprehensiveCreditsLimit: 20, // only 2 available
      planId: "PRO",
    });
    const res = err(
      await svc.reserveCredits("user-rs5", 8, "comprehensive_stock")
    );
    assert.equal(res.code, "INSUFFICIENT_CREDITS");
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });
});

// ── commitCredits ────────────────────────────────────────────────────────────

describe("MONEY-620 — commitCredits (real fn): atomic single-commit", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("commits a RESERVED reservation via a status-guarded updateMany", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-x",
      status: "RESERVED",
      creditsReserved: 8,
      userId: "u",
    });
    prisma.queue("creditReservation", "updateMany", { count: 1 });
    const res = ok(await svc.commitCredits("res-x"));
    assert.equal(res.data.committed, 8);

    const upd = prisma.callsFor("creditReservation", "updateMany")[0]!.args as {
      where: { reservationId: string; status: { in: string[] } };
      data: { status: string };
    };
    assert.equal(upd.where.reservationId, "res-x");
    // Only an open reservation may flip — the guard blocks a double-commit.
    assert.deepEqual(upd.where.status.in, ["RESERVED", "ACTIVE"]);
    assert.equal(upd.data.status, "COMMITTED");
  });

  it("refuses to commit an already-COMMITTED reservation (no double-commit)", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-y",
      status: "COMMITTED",
      creditsReserved: 8,
      userId: "u",
    });
    const res = err(await svc.commitCredits("res-y"));
    assert.match(res.error, /cannot commit/i);
    assert.equal(prisma.callsFor("creditReservation", "updateMany").length, 0);
  });

  it("returns 'already settled' when the atomic flip loses the race (count 0)", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-z",
      status: "RESERVED",
      creditsReserved: 8,
      userId: "u",
    });
    prisma.queue("creditReservation", "updateMany", { count: 0 }); // someone else won
    const res = err(await svc.commitCredits("res-z"));
    assert.match(res.error, /already settled/i);
  });

  it("returns an error for a missing reservation", async () => {
    prisma.queue("creditReservation", "findUnique", null);
    const res = err(await svc.commitCredits("res-missing"));
    assert.match(res.error, /not found/i);
  });
});

// ── refundReservationCredits ─────────────────────────────────────────────────

describe("MONEY-620 — refundReservationCredits (real fn): committed-then-released + over-refund", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("refunds the unused proportion, claims the row atomically, then decrements (guarded, scoped)", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-r",
      status: "RESERVED",
      creditsReserved: 10,
      userId: "owner-1",
    });
    prisma.queue("creditReservation", "updateMany", { count: 1 }); // claim won
    prisma.queue("subscription", "updateMany", { count: 1 }); // decrement
    // completed 2/6 → refund floor(10 * 2/3) = 6.
    const res = ok(await svc.refundReservationCredits("res-r", 2, 6));
    assert.equal(res.data.refunded, 6);

    // The status claim is the lock: refundable → REFUNDED.
    const claim = prisma.callsFor("creditReservation", "updateMany")[0]!
      .args as {
      where: { reservationId: string; status: { notIn: string[] } };
      data: { status: string; creditsRefunded: number };
    };
    assert.equal(claim.where.reservationId, "res-r");
    assert.deepEqual(claim.where.status.notIn, ["REFUNDED", "COMMITTED"]);
    assert.equal(claim.data.status, "REFUNDED");
    assert.equal(claim.data.creditsRefunded, 6);

    // The credit return is scoped to the reservation OWNER (IDOR) and guarded.
    const dec = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      where: { userId: string; comprehensiveCreditsUsed: { gte: number } };
      data: { comprehensiveCreditsUsed: { decrement: number } };
    };
    assert.equal(dec.where.userId, "owner-1");
    assert.equal(dec.where.comprehensiveCreditsUsed.gte, 6);
    assert.equal(dec.data.comprehensiveCreditsUsed.decrement, 6);
  });

  it("EXPLOIT FIX: refuses to refund a COMMITTED reservation (committed-then-released → free credits)", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-committed",
      status: "COMMITTED",
      creditsReserved: 10,
      userId: "owner-2",
    });
    const res = err(await svc.refundReservationCredits("res-committed", 0, 6));
    assert.match(res.error, /cannot refund/i);
    // No claim, no decrement — the credits stay spent.
    assert.equal(prisma.callsFor("creditReservation", "updateMany").length, 0);
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });

  it("refuses to refund an already-REFUNDED reservation (no double-refund)", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-refunded",
      status: "REFUNDED",
      creditsReserved: 10,
      userId: "owner-3",
    });
    const res = err(await svc.refundReservationCredits("res-refunded", 0, 6));
    assert.match(res.error, /cannot refund/i);
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });

  it("EXPLOIT FIX: a NEGATIVE completedSegments can't over-refund (decrement <= reserved)", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-neg",
      status: "RESERVED",
      creditsReserved: 10,
      userId: "owner-4",
    });
    prisma.queue("creditReservation", "updateMany", { count: 1 });
    prisma.queue("subscription", "updateMany", { count: 1 });
    // negative completed → naive (1 - ratio) > 1 → refund > reserved; must clamp.
    const res = ok(await svc.refundReservationCredits("res-neg", -50, 6));
    assert.ok(
      res.data.refunded <= 10,
      `refund must be <= reserved, got ${res.data.refunded}`
    );
    assert.equal(res.data.refunded, 10); // clamped to full reservation
    const dec = prisma.callsFor("subscription", "updateMany")[0]!.args as {
      data: { comprehensiveCreditsUsed: { decrement: number } };
    };
    assert.ok(dec.data.comprehensiveCreditsUsed.decrement <= 10);
  });

  it("non-finite segment counts can't produce a NaN decrement", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-nan",
      status: "RESERVED",
      creditsReserved: 10,
      userId: "owner-5",
    });
    // completed NaN → refund clamps to a finite value. If it's >0 a claim+decrement
    // happen; queue them so the path completes.
    prisma.queue("creditReservation", "updateMany", { count: 1 });
    prisma.queue("subscription", "updateMany", { count: 1 });
    // commit fallback path (in case refund computes 0): queue an update for commit.
    prisma.queue("creditReservation", "updateMany", { count: 1 });
    const res = ok(await svc.refundReservationCredits("res-nan", NaN, 6));
    assert.ok(Number.isFinite(res.data.refunded));
  });

  it("commits (refund 0) when fully completed — no decrement", async () => {
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-full",
      status: "RESERVED",
      creditsReserved: 10,
      userId: "owner-6",
    });
    // completed 6/6 → refund 0 → service commits instead.
    prisma.queue("creditReservation", "findUnique", {
      reservationId: "res-full",
      status: "RESERVED",
      creditsReserved: 10,
      userId: "owner-6",
    });
    prisma.queue("creditReservation", "updateMany", { count: 1 }); // commit flip
    const res = ok(await svc.refundReservationCredits("res-full", 6, 6));
    assert.equal(res.data.refunded, 0);
    // No subscription decrement happened (nothing to refund).
    assert.equal(prisma.callsFor("subscription", "updateMany").length, 0);
  });
});

// ── checkCreditAvailability ──────────────────────────────────────────────────

describe("MONEY-620 — checkCreditAvailability (real fn): IDOR + finite", () => {
  let prisma: RecordingPrisma;
  let svc: CreditServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("scopes the read to userId and floors a corrupt available at a finite value", async () => {
    prisma.queue("subscription", "findUnique", {
      comprehensiveCreditsUsed: NaN,
      comprehensiveCreditsLimit: 20,
    });
    const res = ok(await svc.checkCreditAvailability("user-av1", 5));
    const find = prisma.callsFor("subscription", "findUnique")[0]!.args as {
      where: { userId: string };
    };
    assert.equal(find.where.userId, "user-av1"); // IDOR
    assert.ok(Number.isFinite(res.data.available));
  });

  it("a non-finite creditsNeeded is never 'sufficient' (fail closed)", async () => {
    prisma.queue("subscription", "findUnique", {
      comprehensiveCreditsUsed: 0,
      comprehensiveCreditsLimit: 1000000,
    });
    const res = ok(await svc.checkCreditAvailability("user-av2", NaN));
    assert.equal(res.data.sufficient, false);
  });

  // Restore the real module cache so the stubs never leak into a sibling suite.
  after(() => {
    uninstallServices();
  });
});
