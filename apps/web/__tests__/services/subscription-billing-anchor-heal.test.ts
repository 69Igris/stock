/**
 * Billing-anchor self-heal + derived RENEWS fallback — MONEY-764 round 2.
 *
 * Background (QA reality, 2026-06-12): EVERY paid subscription row had
 * `nextBillingDate: null` — `subscription.*` webhooks never processed before
 * the MONEY-765 envelope/claim fixes, and the legacy callback granted plans
 * with `endDate = startDate + 30d` and no anchor. Two user-visible failures:
 *
 *   1. Billing renders "RENEWS —" forever;
 *   2. the stale +30d endDate eventually LAPSES, and the grace-expiry check
 *      collapses an ACTIVE, genuinely auto-renewing PREMIUM row to FREE.
 *
 * The fix is a read-time reconcile against Dodo placed BEFORE the grace
 * check in `getSubscription`: recover the Dodo subscription id (from the row
 * or recent completed payments), persist the authoritative
 * `next_billing_date`, and clear the stale endDate — plus a pure derived
 * display fallback so an active recurring plan never renders "RENEWS —"
 * even when Dodo is unreachable.
 *
 * LIVE-SERVICE tests drive the REAL `getSubscription` through the
 * established require.cache seam (recording prisma + silent logger), with
 * the REAL `@usemoney/core` overlaid ONLY at the two Dodo seams
 * (`dodoClient`, `isDodoConfigured`) — PLAN_CONFIG / resolvePlanId / the
 * entitlement logic all stay the real source (no shadows).
 *
 * Source under test:
 *   - packages/services/src/subscription.service.ts (anchor heal + mapping)
 *   - packages/services/src/subscription-logic.ts   (deriveNextBillingDate)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── PURE logic: deriveNextBillingDate ───────────────────────────────────────
import { deriveNextBillingDate } from "../../../../packages/services/src/subscription-logic";

describe("deriveNextBillingDate (pure)", () => {
  const now = new Date("2026-06-12T00:00:00.000Z");

  it("annual: rolls the start forward to the next future anniversary", () => {
    const d = deriveNextBillingDate(
      "PREMIUM",
      "annual",
      new Date("2026-05-23T10:00:00.000Z"),
      now
    );
    assert.equal(d?.toISOString(), "2027-05-23T10:00:00.000Z");
  });

  it("monthly: rolls across multiple elapsed periods", () => {
    const d = deriveNextBillingDate(
      "PREMIUM",
      "monthly",
      new Date("2026-03-10T15:25:00.000Z"),
      now
    );
    assert.equal(d?.toISOString(), "2026-07-10T15:25:00.000Z");
  });

  it("a future-dated start is already the next billing date", () => {
    const start = new Date("2026-07-01T00:00:00.000Z");
    const d = deriveNextBillingDate("PREMIUM", "monthly", start, now);
    assert.equal(d?.toISOString(), start.toISOString());
  });

  it("accepts ISO-string starts", () => {
    const d = deriveNextBillingDate(
      "PREMIUM",
      "annual",
      "2025-06-01T00:00:00.000Z",
      now
    );
    assert.equal(d?.toISOString(), "2027-06-01T00:00:00.000Z");
  });

  it("non-recurring plans derive nothing (FREE, lifetime PRO, packs)", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(deriveNextBillingDate("FREE", "monthly", start, now), null);
    assert.equal(deriveNextBillingDate("PRO", null, start, now), null);
    assert.equal(
      deriveNextBillingDate("QUERY_PACK", "monthly", start, now),
      null
    );
  });

  it("a recurring plan with an UNKNOWN period derives nothing (no guessing)", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(deriveNextBillingDate("PREMIUM", null, start, now), null);
    assert.equal(deriveNextBillingDate("PREMIUM", "weekly", start, now), null);
  });

  it("invalid/garbage starts derive nothing", () => {
    assert.equal(deriveNextBillingDate("PREMIUM", "annual", null, now), null);
    assert.equal(
      deriveNextBillingDate("PREMIUM", "annual", "not-a-date", now),
      null
    );
    assert.equal(
      deriveNextBillingDate("PREMIUM", "annual", new Date(NaN), now),
      null
    );
  });

  it("bounded roll-forward: a corrupt ancient monthly start caps out to null", () => {
    // 1900 → 2026 is >1200 monthly periods; the bound must stop the spin and
    // fail closed rather than loop or return a past date.
    assert.equal(
      deriveNextBillingDate(
        "PREMIUM",
        "monthly",
        new Date("1900-01-01T00:00:00.000Z"),
        now
      ),
      null
    );
  });

  it("never mutates the caller's start Date", () => {
    const start = new Date("2026-05-23T00:00:00.000Z");
    deriveNextBillingDate("PREMIUM", "annual", start, now);
    assert.equal(start.toISOString(), "2026-05-23T00:00:00.000Z");
  });
});

// ════════════════════════════════════════════════════════════════════
// LIVE SERVICE — recording prisma + Dodo overlay via require.cache
// ════════════════════════════════════════════════════════════════════

interface SubRow {
  id: string;
  userId: string;
  planId: string;
  status: string;
  billingPeriod: string | null;
  startDate: Date;
  endDate: Date | null;
  aiQueriesUsed: number;
  aiQueriesLimit: number;
  aiQueriesResetAt: Date | null;
  fastQueriesUsed: number | null;
  fastQueriesLimit: number | null;
  advancedQueriesUsed: number | null;
  advancedQueriesLimit: number | null;
  queryPackActive: boolean | null;
  queryPackFastQueriesUsed: number | null;
  queryPackFastQueriesLimit: number | null;
  queryPackAdvancedQueriesUsed: number | null;
  queryPackAdvancedQueriesLimit: number | null;
  queryPackStartDate: Date | null;
  queryPackEndDate: Date | null;
  creditsUsed: number | null;
  creditsLimit: number | null;
  creditsResetAt: Date | null;
  packCreditsUsed: number | null;
  packCreditsLimit: number | null;
  proEntitlementType: string | null;
  proEntitlementStartDate: Date | null;
  proEntitlementEndDate: Date | null;
  nextBillingDate: Date | null;
  dodoSubscriptionId: string | null;
  scheduledPlanId: string | null;
  scheduledBillingPeriod: string | null;
  scheduledEffectiveAt: Date | null;
  cancelledAt: Date | null;
  addons: string[];
}

function makeRow(over: Partial<SubRow> & { userId: string }): SubRow {
  return {
    id: `sub-${over.userId}`,
    planId: "FREE",
    status: "ACTIVE",
    billingPeriod: null,
    startDate: new Date("2026-05-10T00:00:00.000Z"),
    endDate: null,
    aiQueriesUsed: 0,
    aiQueriesLimit: 0,
    aiQueriesResetAt: null,
    fastQueriesUsed: 0,
    fastQueriesLimit: 0,
    advancedQueriesUsed: 0,
    advancedQueriesLimit: 0,
    queryPackActive: false,
    queryPackFastQueriesUsed: 0,
    queryPackFastQueriesLimit: 0,
    queryPackAdvancedQueriesUsed: 0,
    queryPackAdvancedQueriesLimit: 0,
    queryPackStartDate: null,
    queryPackEndDate: null,
    creditsUsed: 0,
    creditsLimit: 500,
    creditsResetAt: null,
    packCreditsUsed: 0,
    packCreditsLimit: 0,
    proEntitlementType: null,
    proEntitlementStartDate: null,
    proEntitlementEndDate: null,
    nextBillingDate: null,
    dodoSubscriptionId: null,
    scheduledPlanId: null,
    scheduledBillingPeriod: null,
    scheduledEffectiveAt: null,
    cancelledAt: null,
    addons: [],
    ...over,
  };
}

interface PaymentRow {
  id: string;
  userId: string;
  status: string;
  dodoPaymentId: string | null;
  createdAt: Date;
}

interface Recorder {
  store: Map<string, SubRow>;
  payments: PaymentRow[];
  updateArgs: Array<{ userId: string; data: Record<string, unknown> }>;
}

function makePrismaStub(rec: Recorder) {
  return {
    subscription: {
      findUnique: async (args: { where: { userId: string } }) => {
        const r = rec.store.get(args.where.userId);
        return r ? { ...r } : null;
      },
      create: async (args: { data: SubRow & { userId: string } }) => {
        const row = makeRow({ ...args.data, userId: args.data.userId });
        rec.store.set(row.userId, row);
        return { ...row };
      },
      update: async (args: {
        where: { userId: string };
        data: Record<string, unknown>;
      }) => {
        rec.updateArgs.push({ userId: args.where.userId, data: args.data });
        const existing = rec.store.get(args.where.userId);
        if (!existing) throw new Error("no row to update");
        const merged = { ...existing, ...args.data } as SubRow;
        rec.store.set(args.where.userId, merged);
        return { ...merged };
      },
    },
    payment: {
      findMany: async (args: {
        where: { userId: string; status: string };
        take: number;
      }) =>
        rec.payments
          .filter(
            (p) =>
              p.userId === args.where.userId && p.status === args.where.status
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take)
          .map((p) => ({ dodoPaymentId: p.dodoPaymentId })),
    },
  };
}

// Recording Dodo double — overlayed onto the REAL core exports.
interface DodoStubConfig {
  payments: Record<string, { subscription_id?: string | null }>;
  subscriptions: Record<
    string,
    { status?: string; next_billing_date?: string | null }
  >;
  throwOnSubscriptionRetrieve?: boolean;
}

interface DodoCalls {
  paymentRetrieves: string[];
  subscriptionRetrieves: string[];
}

function makeDodoStub(cfg: DodoStubConfig, calls: DodoCalls) {
  return {
    payments: {
      retrieve: async (id: string) => {
        calls.paymentRetrieves.push(id);
        return cfg.payments[id] ?? null;
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        calls.subscriptionRetrieves.push(id);
        if (cfg.throwOnSubscriptionRetrieve) {
          throw new Error("dodo unreachable");
        }
        return cfg.subscriptions[id] ?? null;
      },
      update: async () => ({}),
    },
  };
}

type ServiceModule =
  typeof import("../../../../packages/services/src/subscription.service");

const dbPath = require.resolve("@usemoney/database");
const logPath = require.resolve("@usemoney/logger");
const corePath = require.resolve("@usemoney/core");
const svcPath =
  require.resolve("../../../../packages/services/src/subscription.service");
const logicPath =
  require.resolve("../../../../packages/services/src/subscription-logic");

function cacheMap(): Record<string, unknown> {
  return (require as unknown as { cache: Record<string, unknown> }).cache;
}

/**
 * Inject the recording prisma + silent logger, overlay the REAL core's Dodo
 * seams, then (re)require the REAL service so it binds to the doubles.
 */
function loadServiceWith(
  rec: Recorder,
  dodo: ReturnType<typeof makeDodoStub>,
  opts: { dodoConfigured?: boolean } = {}
): ServiceModule {
  const cache = cacheMap();
  // Load the real core FIRST so the overlay spreads real PLAN_CONFIG etc.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realCore = require("@usemoney/core") as Record<string, unknown>;
  delete cache[svcPath];
  delete cache[logicPath];
  delete cache[dbPath];
  delete cache[logPath];
  delete cache[corePath];
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: makePrismaStub(rec),
      PlanType: {},
      Prisma: {},
    },
  };
  cache[logPath] = {
    exports: {
      __esModule: true,
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  cache[corePath] = {
    exports: {
      ...realCore,
      dodoClient: dodo,
      isDodoConfigured: () => opts.dodoConfigured !== false,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../../packages/services/src/subscription.service") as ServiceModule;
}

function anchorUpdates(rec: Recorder) {
  return rec.updateArgs.filter((u) => "dodoSubscriptionId" in u.data);
}

describe("getSubscription (LIVE) — billing-anchor self-heal", () => {
  let rec: Recorder;
  let calls: DodoCalls;

  beforeEach(() => {
    rec = { store: new Map(), payments: [], updateArgs: [] };
    calls = { paymentRetrieves: [], subscriptionRetrieves: [] };
  });

  const FUTURE = "2027-05-10T00:00:00.000Z";
  const PAST = new Date("2026-06-09T00:00:00.000Z"); // legacy +30d, lapsed

  it("anchors from the stored dodoSubscriptionId and clears the stale endDate", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PREMIUM",
        billingPeriod: "monthly",
        endDate: PAST,
        dodoSubscriptionId: "sub_x",
      })
    );
    const svc = loadServiceWith(
      rec,
      makeDodoStub(
        {
          payments: {},
          subscriptions: {
            sub_x: { status: "active", next_billing_date: FUTURE },
          },
        },
        calls
      )
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    // The landmine pin: the lapsed legacy endDate must NOT collapse a
    // Dodo-confirmed auto-renewing PREMIUM to FREE.
    assert.equal(res.data?.planId, "PREMIUM");
    assert.equal(res.data?.status, "ACTIVE");
    assert.equal(res.data?.nextBillingDate, FUTURE);
    const heals = anchorUpdates(rec);
    assert.equal(heals.length, 1);
    assert.equal(heals[0]?.data.dodoSubscriptionId, "sub_x");
    assert.equal(
      (heals[0]?.data.nextBillingDate as Date).toISOString(),
      FUTURE
    );
    assert.equal(heals[0]?.data.endDate, null);
    // The id was already on the row — no payment archaeology.
    assert.deepEqual(calls.paymentRetrieves, []);
  });

  it("recovers the subscription id from recent payments (packs skipped)", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PREMIUM",
        billingPeriod: "monthly",
        endDate: PAST,
        dodoSubscriptionId: null,
      })
    );
    rec.payments = [
      // newest first after sort: a pack (one-time → no subscription_id),
      // then the real subscription payment.
      {
        id: "p-pack",
        userId: "u1",
        status: "COMPLETED",
        dodoPaymentId: "pay_pack",
        createdAt: new Date("2026-06-11T00:00:00.000Z"),
      },
      {
        id: "p-null",
        userId: "u1",
        status: "COMPLETED",
        dodoPaymentId: null, // legacy row without an id — skipped in code
        createdAt: new Date("2026-06-10T00:00:00.000Z"),
      },
      {
        id: "p-sub",
        userId: "u1",
        status: "COMPLETED",
        dodoPaymentId: "pay_sub",
        createdAt: new Date("2026-05-10T00:00:00.000Z"),
      },
    ];
    const svc = loadServiceWith(
      rec,
      makeDodoStub(
        {
          payments: {
            pay_pack: { subscription_id: null },
            pay_sub: { subscription_id: "sub_y" },
          },
          subscriptions: {
            sub_y: { status: "active", next_billing_date: FUTURE },
          },
        },
        calls
      )
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    assert.equal(res.data?.planId, "PREMIUM");
    assert.equal(res.data?.nextBillingDate, FUTURE);
    assert.deepEqual(calls.paymentRetrieves, ["pay_pack", "pay_sub"]);
    assert.equal(anchorUpdates(rec)[0]?.data.dodoSubscriptionId, "sub_y");
  });

  it("a Dodo-side cancelled subscription does NOT anchor — lapsed rows still collapse", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PREMIUM",
        billingPeriod: "monthly",
        endDate: PAST,
        dodoSubscriptionId: "sub_x",
      })
    );
    const svc = loadServiceWith(
      rec,
      makeDodoStub(
        {
          payments: {},
          subscriptions: {
            sub_x: { status: "cancelled", next_billing_date: null },
          },
        },
        calls
      )
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    // No anchor write, so the grace-expiry policy proceeds as before: the
    // heal must not become an entitlement backdoor for genuinely lapsed subs.
    assert.equal(anchorUpdates(rec).length, 0);
    assert.equal(res.data?.planId, "FREE");
  });

  it("a Dodo outage is non-fatal and the payload falls back to the DERIVED renewal", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PREMIUM",
        billingPeriod: "monthly",
        startDate: new Date("2026-05-10T00:00:00.000Z"),
        endDate: null, // healthy row, just unanchored
        dodoSubscriptionId: "sub_x",
      })
    );
    const svc = loadServiceWith(
      rec,
      makeDodoStub(
        { payments: {}, subscriptions: {}, throwOnSubscriptionRetrieve: true },
        calls
      )
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    assert.equal(res.data?.planId, "PREMIUM");
    // Derived display fallback — never "—" for an active recurring plan…
    assert.equal(typeof res.data?.nextBillingDate, "string");
    assert.ok(new Date(res.data!.nextBillingDate!) > new Date());
    // …but nothing was persisted (DB stays Dodo-authoritative).
    assert.equal(anchorUpdates(rec).length, 0);
    assert.equal(rec.store.get("u1")?.nextBillingDate, null);
  });

  it("skips Dodo entirely when not configured (derived fallback only)", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PREMIUM",
        billingPeriod: "annual",
        startDate: new Date("2026-05-23T00:00:00.000Z"),
        dodoSubscriptionId: "sub_x",
      })
    );
    const svc = loadServiceWith(
      rec,
      makeDodoStub({ payments: {}, subscriptions: {} }, calls),
      { dodoConfigured: false }
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    assert.deepEqual(calls.subscriptionRetrieves, []);
    assert.equal(res.data?.nextBillingDate, "2027-05-23T00:00:00.000Z");
    assert.equal(anchorUpdates(rec).length, 0);
  });

  it("an already-anchored row never re-runs the heal", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PREMIUM",
        billingPeriod: "monthly",
        nextBillingDate: new Date(FUTURE),
        dodoSubscriptionId: "sub_x",
      })
    );
    const svc = loadServiceWith(
      rec,
      makeDodoStub({ payments: {}, subscriptions: {} }, calls)
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    assert.deepEqual(calls.subscriptionRetrieves, []);
    assert.equal(res.data?.nextBillingDate, FUTURE);
  });

  it("lifetime PRO neither heals nor derives (no recurring cycle)", async () => {
    rec.store.set(
      "u1",
      makeRow({
        userId: "u1",
        planId: "PRO",
        billingPeriod: null,
        creditsLimit: 50,
      })
    );
    const svc = loadServiceWith(
      rec,
      makeDodoStub({ payments: {}, subscriptions: {} }, calls)
    );
    const res = await svc.getSubscription("u1");
    assert.equal(res.success, true);
    assert.deepEqual(calls.subscriptionRetrieves, []);
    assert.equal(res.data?.planId, "PRO");
    assert.equal(res.data?.nextBillingDate, null);
  });
});
