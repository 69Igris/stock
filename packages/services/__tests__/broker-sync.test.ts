/**
 * broker-sync.service pure guards (MONEY-837 rich-unify) — REAL exports.
 *
 * Covers the side-effect-free guards that gate the shared broker-sync
 * orchestrator. `buildConnectionWhere`'s wildcard branch is a cross-user data
 * hazard (get it wrong and a user-scoped job leaks into all users, or nobody
 * syncs), so it is the single source asserted here. The persist + orchestrator
 * functions are Prisma/client-bound and are covered end-to-end by the web
 * broker-sync action test + the worker processor test once wired.
 *
 * Source: packages/services/src/broker-sync.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isConnectionTokenExpired,
  is403Error,
  buildConnectionWhere,
  // MONEY-1379 — the Zerodha-only default set + the empty-shard rule
  SYNC_ENABLED_BROKERS,
  isScheduledShard,
  NO_CONNECTIONS_ERROR,
  classifyConnectionForSync,
  buildSyncEmailCounts,
  historicalConnectionsWithErrors,
  DEFAULT_SYNC_DATA_TYPES,
  // MONEY-1062 async sync triggers
  resolveHistoricalSyncDays,
  startBrokerSync,
  startHistoricalSync,
  startAllBrokerSyncs,
  type StartSyncDeps,
  type SyncConnectionResult,
  type HistoricalTradesPerConnection,
} from "../src/broker-sync.service";

describe("broker-sync.service — pure guards", () => {
  describe("isConnectionTokenExpired", () => {
    const now = new Date("2026-06-16T12:00:00Z");

    it("treats null/undefined expiry as NOT expired (unknown ≠ dead)", () => {
      assert.equal(isConnectionTokenExpired(null, now), false);
      assert.equal(isConnectionTokenExpired(undefined, now), false);
    });

    it("a future expiry is not expired", () => {
      assert.equal(
        isConnectionTokenExpired(new Date("2026-06-16T18:00:00Z"), now),
        false,
      );
    });

    it("a past expiry is expired (Date and ISO string)", () => {
      assert.equal(
        isConnectionTokenExpired(new Date("2026-06-16T06:00:00Z"), now),
        true,
      );
      assert.equal(isConnectionTokenExpired("2026-06-16T06:00:00Z", now), true);
    });
  });

  describe("is403Error", () => {
    it("matches 403 / Forbidden messages", () => {
      assert.equal(is403Error(new Error("Request failed: 403")), true);
      assert.equal(is403Error(new Error("Forbidden")), true);
    });

    it("does not match other errors / non-errors", () => {
      assert.equal(is403Error(new Error("500 Internal Server Error")), false);
      assert.equal(is403Error("timeout"), false);
      assert.equal(is403Error(null), false);
      assert.equal(is403Error(undefined), false);
    });
  });

  describe("buildConnectionWhere", () => {
    // MONEY-1379: the syncable-broker set is applied to a SCHEDULED SHARD and
    // nothing else, so only the `syncBucket` expectations below gained a
    // `broker` key. A call with no bucket is not the scheduler and is left
    // exactly as it was.
    const DEFAULT_BROKER = { in: [...SYNC_ENABLED_BROKERS] };

    it("scopes to a single user", () => {
      assert.deepEqual(buildConnectionWhere("u1"), { userId: "u1" });
    });

    it("wildcard '*' omits userId entirely (all users — scheduled bulk)", () => {
      assert.deepEqual(buildConnectionWhere("*"), {});
      // crucially: NO userId key, not userId:"*"
      assert.ok(!("userId" in buildConnectionWhere("*")));
    });

    it("narrows by connectionId and broker", () => {
      assert.deepEqual(buildConnectionWhere("u1", "c1"), {
        userId: "u1",
        id: "c1",
      });
      assert.deepEqual(buildConnectionWhere("u1", undefined, "ZERODHA"), {
        userId: "u1",
        broker: "ZERODHA",
      });
      assert.deepEqual(buildConnectionWhere("u1", "c1", "ZERODHA"), {
        userId: "u1",
        id: "c1",
        broker: "ZERODHA",
      });
    });

    it("wildcard + broker filters all users by that broker (no userId)", () => {
      assert.deepEqual(buildConnectionWhere("*", undefined, "ZERODHA"), {
        broker: "ZERODHA",
      });
    });

    // MONEY-841: a per-shard scheduled sync narrows to one bucket across users.
    it("wildcard + syncBucket scopes to one shard (all users in that bucket)", () => {
      assert.deepEqual(buildConnectionWhere("*", undefined, undefined, 12), {
        syncBucket: 12,
        broker: DEFAULT_BROKER,
      });
    });

    it("syncBucket 0 is a valid shard (not dropped as falsy)", () => {
      assert.deepEqual(buildConnectionWhere("*", undefined, undefined, 0), {
        syncBucket: 0,
        broker: DEFAULT_BROKER,
      });
    });

    it("omits syncBucket when undefined or NaN", () => {
      assert.ok(!("syncBucket" in buildConnectionWhere("*")));
      assert.ok(
        !("syncBucket" in buildConnectionWhere("*", undefined, undefined, NaN)),
      );
    });

    // ── MONEY-1379: the Zerodha-only default set ──────────────────────────

    it("an EXPLICIT broker always wins over the default set", () => {
      // The rule narrows what a scheduled sync SELECTS. It must not silently
      // rewrite a caller that asked about one named broker — that caller would
      // get "nothing connected" for a connection it can see.
      assert.strictEqual(
        buildConnectionWhere("u1", undefined, "UPSTOX", 4).broker,
        "UPSTOX",
      );
      assert.strictEqual(
        buildConnectionWhere("*", undefined, "DHAN", 0).broker,
        "DHAN",
      );
    });

    it("a call with NO shard is not the scheduler, and is left alone", () => {
      // The narrower half of the rule, and the one that keeps it honest. A
      // direct service call — a user syncing everything they have connected —
      // is not the cron's fan-out and must not be silently narrowed; a user
      // whose only connection is an Upstox one would otherwise be told
      // "Broker not connected" about something visible on their brokers page.
      for (const w of [
        buildConnectionWhere("u1"),
        buildConnectionWhere("*"),
        buildConnectionWhere("u1", "c1"),
        buildConnectionWhere("*", undefined, undefined, NaN),
      ])
        assert.ok(
          !("broker" in w),
          `a non-shard selection must not carry a broker filter: ${JSON.stringify(w)}`,
        );
    });

    it("the default set is exactly Zerodha's two connectors", () => {
      // Pinned by VALUE, not by length. Founder decision 2026-09-11: broker
      // sync is Zerodha-only for now, both connectors. Widening it is a
      // deliberate one-line edit that must show up as a failing test first,
      // because a wider set costs real Pub/Sub deliveries against brokers
      // nothing can sync.
      assert.deepEqual(
        [...SYNC_ENABLED_BROKERS],
        ["ZERODHA", "ZERODHA_CONNECT"],
      );
    });

    it("the default set is applied as an `in` clause, not a bare string", () => {
      // A bare `where.broker = "ZERODHA,ZERODHA_CONNECT"` matches nothing and
      // would read as "no connections" forever — the exact silent-empty shape
      // this ticket exists to remove.
      const w = buildConnectionWhere("*", undefined, undefined, 7);
      assert.ok(
        typeof w.broker === "object" && w.broker !== null,
        "the default must be an object clause",
      );
      assert.deepEqual(w.broker, { in: ["ZERODHA", "ZERODHA_CONNECT"] });
    });
  });

  describe("isScheduledShard — what an EMPTY selection means", () => {
    // The one predicate deciding whether "nothing matched" is a failure a user
    // must see, or the ordinary state of 58 of 64 fan-out leaves.

    it("an integer bucket is a shard — INCLUDING bucket 0", () => {
      assert.strictEqual(isScheduledShard(0), true);
      assert.strictEqual(isScheduledShard(3), true);
      assert.strictEqual(isScheduledShard(63), true);
    });

    it("bucket 0 is the case a truthiness check gets wrong", () => {
      // `if (syncBucket)` would call bucket 0 a user sync and resurrect the
      // 500-per-empty-shard bug for 1/64th of every fan-out — the rarest and
      // least reproducible version of it. This assertion is the guard.
      assert.notStrictEqual(
        isScheduledShard(0),
        Boolean(0),
        "isScheduledShard(0) must NOT agree with truthiness",
      );
    });

    it("no bucket at all is a user-scoped sync", () => {
      assert.strictEqual(isScheduledShard(undefined), false);
      assert.strictEqual(isScheduledShard(), false);
    });

    it("a non-integer bucket is not a shard", () => {
      // NaN reaches here from a malformed message; treating it as a shard
      // would turn a genuine "you have nothing connected" into a silent 200.
      assert.strictEqual(isScheduledShard(NaN), false);
      assert.strictEqual(isScheduledShard(1.5), false);
    });
  });

  describe("NO_CONNECTIONS_ERROR — one spelling", () => {
    it("is the exact text apps/web maps to 'Broker not connected'", () => {
      // apps/web/lib/actions/broker-connection.ts compares against this
      // constant. If the text changes, a user sees the raw internal string.
      assert.strictEqual(NO_CONNECTIONS_ERROR, "No broker connections found");
    });

    it("the web action imports the constant instead of re-typing it", () => {
      const src = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../apps/web/lib/actions/broker-connection.ts",
        ),
        "utf8",
      );
      assert.match(
        src,
        /NO_CONNECTIONS_ERROR/,
        "the web action must import the constant",
      );
      assert.doesNotMatch(
        src,
        /=== "No broker connections found"/,
        "a re-typed literal is the drift this constant exists to prevent",
      );
    });
  });

  describe("DEFAULT_SYNC_DATA_TYPES", () => {
    it("is holdings + positions + trades + mutualFunds (MONEY-837: MFs sync by default)", () => {
      assert.deepEqual(
        [...DEFAULT_SYNC_DATA_TYPES],
        ["holdings", "positions", "trades", "mutualFunds"],
      );
    });
  });

  describe("classifyConnectionForSync (MONEY-838 shared skip decision)", () => {
    const healthy = {
      broker: "ZERODHA",
      encryptedCreds: "enc",
      iv: "iv",
      authTag: "tag",
      tokenExpiry: new Date("2026-06-16T18:00:00Z"),
      status: "CONNECTED",
    };
    const now = new Date("2026-06-16T12:00:00Z");

    it("ZERODHA_CONNECT → skip connect-token-only, no reauth", () => {
      assert.deepEqual(
        classifyConnectionForSync(
          { ...healthy, broker: "ZERODHA_CONNECT" },
          now,
        ),
        { action: "skip", reason: "connect-token-only", markReauth: false },
      );
    });

    it("missing creds → skip no-credentials (any of encryptedCreds/iv/authTag null)", () => {
      assert.deepEqual(
        classifyConnectionForSync({ ...healthy, encryptedCreds: null }, now),
        { action: "skip", reason: "no-credentials", markReauth: false },
      );
      assert.equal(
        classifyConnectionForSync({ ...healthy, iv: null }, now).reason,
        "no-credentials",
      );
      assert.equal(
        classifyConnectionForSync({ ...healthy, authTag: null }, now).reason,
        "no-credentials",
      );
    });

    it("expired token while CONNECTED → skip token-expired + markReauth", () => {
      assert.deepEqual(
        classifyConnectionForSync(
          { ...healthy, tokenExpiry: new Date("2026-06-16T06:00:00Z") },
          now,
        ),
        { action: "skip", reason: "token-expired", markReauth: true },
      );
    });

    it("expired token but already NEEDS_REAUTH → skip token-expired, no re-mark", () => {
      assert.deepEqual(
        classifyConnectionForSync(
          {
            ...healthy,
            status: "NEEDS_REAUTH",
            tokenExpiry: new Date("2026-06-16T06:00:00Z"),
          },
          now,
        ),
        { action: "skip", reason: "token-expired", markReauth: false },
      );
    });

    it("healthy live-token connection → sync", () => {
      assert.deepEqual(classifyConnectionForSync(healthy, now), {
        action: "sync",
      });
    });

    it("null tokenExpiry (unknown ≠ dead) → sync", () => {
      assert.deepEqual(
        classifyConnectionForSync({ ...healthy, tokenExpiry: null }, now),
        { action: "sync" },
      );
    });

    it("ZERODHA_CONNECT precedence: skipped as connect-token-only even with no creds", () => {
      assert.equal(
        classifyConnectionForSync(
          { ...healthy, broker: "ZERODHA_CONNECT", encryptedCreds: null },
          now,
        ).reason,
        "connect-token-only",
      );
    });
  });

  // MONEY-848: pure helpers that feed the worker's "Sync Complete" email +
  // the historical-error surfacing. The email gate itself (syncEmail &&
  // !historicalEmail) lives in the worker; these are the testable inputs to it.
  describe("buildSyncEmailCounts (MONEY-848 sync-complete email counts)", () => {
    const conn = (
      synced: SyncConnectionResult["synced"],
      errors: SyncConnectionResult["errors"] = {},
    ): SyncConnectionResult => ({
      broker: "ZERODHA",
      synced,
      authFailed: false,
      skipped: false,
      errors,
    });

    it("sums per-type counts across connections", () => {
      const counts = buildSyncEmailCounts([
        conn({ holdings: 3, positions: 1, trades: 10, mutualFunds: 2 }),
        conn({ holdings: 2, positions: 0, trades: 5, mutualFunds: 1 }),
      ]);
      assert.deepEqual(counts, {
        holdings: 5,
        positions: 1,
        trades: 15,
        mutualFunds: 3,
        mutualFundsError: false,
      });
    });

    it("missing per-type counts default to 0 (a type that errored stays absent)", () => {
      // trades errored → never folded in (stays 0); others present.
      const counts = buildSyncEmailCounts([
        conn({ holdings: 4 }, { trades: "timeout" }),
      ]);
      assert.equal(counts.holdings, 4);
      assert.equal(counts.positions, 0);
      assert.equal(counts.trades, 0);
      assert.equal(counts.mutualFunds, 0);
    });

    it("flags mutualFundsError when ANY connection's MF fetch errored", () => {
      const counts = buildSyncEmailCounts([
        conn({ holdings: 1, mutualFunds: 0 }, { mutualFunds: "403 Forbidden" }),
      ]);
      // distinguishes "couldn't read funds" from a genuine 0
      assert.equal(counts.mutualFundsError, true);
      assert.equal(counts.mutualFunds, 0);
    });

    it("no MF error → mutualFundsError false even when count is 0", () => {
      const counts = buildSyncEmailCounts([
        conn({ holdings: 1, mutualFunds: 0 }),
      ]);
      assert.equal(counts.mutualFundsError, false);
    });

    it("empty perConnection → all zero, no error", () => {
      assert.deepEqual(buildSyncEmailCounts([]), {
        holdings: 0,
        positions: 0,
        trades: 0,
        mutualFunds: 0,
        mutualFundsError: false,
      });
    });
  });

  describe("historicalConnectionsWithErrors (MONEY-848 surface swallowed errors)", () => {
    const row = (
      over: Partial<HistoricalTradesPerConnection>,
    ): HistoricalTradesPerConnection => ({
      broker: "ZERODHA",
      brokerUserId: null,
      synced: 0,
      ...over,
    });

    it("returns only genuinely-errored connections", () => {
      const errored = row({ error: "persist failed", brokerUserId: "AB1234" });
      const result = historicalConnectionsWithErrors([
        row({ synced: 100 }), // success
        errored, // real error
      ]);
      assert.deepEqual(result, [errored]);
    });

    it("EXCLUDES benign skips (connect-only / no-creds / token-expired carry skipped:true)", () => {
      // syncHistoricalTradebook marks a skipped connection skipped:true and puts
      // the reason in `error` for non-connect skips — those must NOT be surfaced
      // as failures (they're expected, not actionable re-auth errors here).
      const result = historicalConnectionsWithErrors([
        row({ skipped: true, error: "token-expired" }),
        row({ skipped: true }), // connect-token-only (no error)
      ]);
      assert.deepEqual(result, []);
    });

    it("a real error on one account + a healthy + a skipped → only the real error", () => {
      const realErr = row({
        error: "ZERODHA API Error: 500",
        brokerUserId: "X",
      });
      const result = historicalConnectionsWithErrors([
        row({ synced: 5, brokerUserId: "Y" }),
        realErr,
        row({ skipped: true, error: "token-expired", brokerUserId: "Z" }),
      ]);
      assert.deepEqual(result, [realErr]);
    });

    it("empty input → empty", () => {
      assert.deepEqual(historicalConnectionsWithErrors([]), []);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // MONEY-841 — source guards on syncBrokerConnections (no take cap +
  // syncBucket threaded into the where-clause). The fn is Prisma-bound (can't
  // run in a pure test), so we statically assert the two scaling-critical
  // properties on the real source so a future edit can't silently reintroduce
  // the cap or drop the shard filter.
  // ══════════════════════════════════════════════════════════════════════

  describe("syncBrokerConnections source guards (MONEY-841)", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../src/broker-sync.service.ts",
      ),
      "utf-8",
    );

    // ── MONEY-1379 ────────────────────────────────────────────────────────
    // These two are guarded at the SOURCE rather than by calling the function,
    // because both branches sit behind a live `prisma.brokerConnection.findMany`
    // and this suite has no database. The behaviour they gate is pure and IS
    // called directly above (`isScheduledShard`); what remains to check is that
    // each empty branch actually consults it, and that the historical selection
    // is sharded at all — the field whose ABSENCE was a 64x amplification.

    it("BOTH empty-selection branches ask isScheduledShard before failing", () => {
      const guarded =
        src.match(/isScheduledShard\(params\.syncBucket\)/g) ?? [];
      assert.strictEqual(
        guarded.length,
        2,
        "syncBrokerConnections and syncHistoricalTradebook must EACH treat an " +
          "empty shard as success; one of them still fails the whole leaf",
      );
      // And neither may answer with the error constant unconditionally.
      const errorReturns =
        src.match(
          /return \{ success: false, error: NO_CONNECTIONS_ERROR \}/g,
        ) ?? [];
      assert.strictEqual(errorReturns.length, 2);
    });

    it("syncHistoricalTradebook shards its own selection", () => {
      // Without `params.syncBucket` here, a shard leaf backfilled EVERY
      // connection on the platform: connectionCount x 64 slow Console calls on
      // the weekly cron. It was invisible only because the day-sync's throw
      // aborted the leaf first on the empty shards.
      const hist = src.slice(
        src.indexOf("export async function syncHistoricalTradebook"),
      );
      const call = hist.slice(hist.indexOf("buildConnectionWhere("));
      const args = call.slice(0, call.indexOf(");"));
      assert.match(
        args,
        /params\.syncBucket/,
        "syncHistoricalTradebook's buildConnectionWhere must receive the bucket",
      );
    });

    it("the connection findMany carries NO `take` cap (the ~5k cliff is gone)", () => {
      // findMany on brokerConnection must select the whole (already-bounded)
      // slice. A `take:` on that query would silently drop connections.
      // (`\s`/`[^}]` already cross newlines, so no dotAll `s` flag is needed.)
      assert.ok(
        !/brokerConnection\.findMany\(\{\s*where[^}]*take/.test(src),
        "brokerConnection.findMany must not have a take cap",
      );
      assert.ok(
        !/take:\s*5000/.test(src),
        "the legacy take:5000 cap must not exist",
      );
    });

    it("threads params.syncBucket into buildConnectionWhere", () => {
      assert.ok(
        /buildConnectionWhere\(\s*params\.userId,\s*params\.connectionId,\s*params\.broker,\s*params\.syncBucket,?\s*\)/.test(
          src,
        ),
        "syncBrokerConnections must pass params.syncBucket to buildConnectionWhere",
      );
    });
  });
});

// ── Async sync-job triggers (MONEY-1062) — real fns, injected prisma ──────────
//
// The trigger half of broker sync (verify the owned/ACTIVE connection + create
// the pollable BackgroundJob row) runs against a fake prisma via the `deps` seam
// (this suite is ESM — no require.cache injection). The PUBLISH is a route-layer
// seam asserted in apps/api parity-p2a-contract.test.ts; here we pin the
// gate + bookkeeping: the G3 invariant is that a failed gate creates NO row.

interface DbCall {
  where?: unknown;
  select?: unknown;
  data?: unknown;
}

function fakeDb(opts: {
  connection?: {
    id: string;
    userId: string;
    broker: string;
    status: string;
  } | null;
  connections?: Array<{ id: string; broker: string }>;
  createThrows?: boolean;
  findThrows?: boolean;
}): { prisma: StartSyncDeps["prisma"]; created: DbCall[]; finds: DbCall[] } {
  const created: DbCall[] = [];
  const finds: DbCall[] = [];
  const prisma = {
    brokerConnection: {
      findUnique: async (args: DbCall) => {
        finds.push(args);
        if (opts.findThrows) throw new Error("Mongo down");
        return opts.connection ?? null;
      },
      findMany: async (args: DbCall) => {
        finds.push(args);
        if (opts.findThrows) throw new Error("Mongo down");
        return opts.connections ?? [];
      },
    },
    backgroundJob: {
      create: async (args: DbCall) => {
        if (opts.createThrows) throw new Error("insert failed");
        created.push(args);
        return args.data;
      },
    },
  } as unknown as StartSyncDeps["prisma"];
  return { prisma, created, finds };
}

const CONNECTED = {
  id: "conn_1",
  userId: "user_1",
  broker: "ZERODHA",
  status: "CONNECTED",
};

describe("resolveHistoricalSyncDays", () => {
  it("passes a valid positive value through (number or numeric string)", () => {
    assert.equal(resolveHistoricalSyncDays(30), 30);
    assert.equal(resolveHistoricalSyncDays("365"), 365);
  });

  it("falls back for negative / zero / empty / garbage (the MONEY-846 bug class)", () => {
    // Number("-5") === -5 is truthy — the old `|| 3650` let it through.
    assert.equal(resolveHistoricalSyncDays(-5), 3650);
    assert.equal(resolveHistoricalSyncDays(0), 3650);
    assert.equal(resolveHistoricalSyncDays(""), 3650);
    assert.equal(resolveHistoricalSyncDays("abc"), 3650);
    assert.equal(resolveHistoricalSyncDays("bad", 100), 100); // custom fallback
  });
});

describe("startBrokerSync — verify + track (real fn, injected prisma)", () => {
  it("verifies an owned CONNECTED connection, creates a BROKER_SYNC row, returns jobId + broker", async () => {
    const { prisma, created } = fakeDb({ connection: CONNECTED });
    const res = await startBrokerSync("user_1", "conn_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.broker, "ZERODHA");
      assert.ok(res.data.jobId.length > 0);
      assert.equal(created.length, 1);
      const data = created[0]!.data as Record<string, unknown>;
      assert.equal(data.jobType, "BROKER_SYNC");
      assert.equal(data.status, "PENDING");
      assert.equal(data.userId, "user_1");
      assert.equal(data.jobId, res.data.jobId);
    }
  });

  it("a missing connection → NOT_FOUND and NO row created", async () => {
    const { prisma, created } = fakeDb({ connection: null });
    const res = await startBrokerSync("user_1", "ghost", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_FOUND");
    assert.equal(created.length, 0);
  });

  it("a FOREIGN connection (userId mismatch) → NOT_FOUND, NO row (IDOR guard)", async () => {
    const { prisma, created } = fakeDb({
      connection: { ...CONNECTED, userId: "someone_else" },
    });
    const res = await startBrokerSync("user_1", "conn_1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_FOUND");
    assert.equal(created.length, 0);
  });

  it("ZERODHA_CONNECT → code-less failure (route → 400), NO row", async () => {
    const { prisma, created } = fakeDb({
      connection: { ...CONNECTED, broker: "ZERODHA_CONNECT" },
    });
    const res = await startBrokerSync("user_1", "conn_1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.code, undefined);
      assert.match(res.error, /does not sync/i);
    }
    assert.equal(created.length, 0);
  });

  it("a non-CONNECTED status (NEEDS_REAUTH) → code-less failure, NO row", async () => {
    const { prisma, created } = fakeDb({
      connection: { ...CONNECTED, status: "NEEDS_REAUTH" },
    });
    const res = await startBrokerSync("user_1", "conn_1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, undefined);
    assert.equal(created.length, 0);
  });

  it("a thrown query fails closed to INTERNAL", async () => {
    const { prisma } = fakeDb({ findThrows: true });
    const res = await startBrokerSync("user_1", "conn_1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
  });

  it("a best-effort row-create failure does NOT block the trigger (still success)", async () => {
    const { prisma } = fakeDb({ connection: CONNECTED, createThrows: true });
    const res = await startBrokerSync("user_1", "conn_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.ok(res.data.jobId.length > 0);
  });
});

describe("startHistoricalSync — verify + track + resolve window", () => {
  it("returns the resolved historicalDays for an explicit positive days", async () => {
    const { prisma, created } = fakeDb({ connection: CONNECTED });
    const res = await startHistoricalSync(
      "user_1",
      "conn_1",
      { days: 30 },
      { prisma },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.historicalDays, 30);
      assert.equal(res.data.broker, "ZERODHA");
    }
    assert.equal(created.length, 1);
  });

  it("an invalid days (negative) clamps to the default window (env-independent)", async () => {
    const { prisma } = fakeDb({ connection: CONNECTED });
    const res = await startHistoricalSync(
      "user_1",
      "conn_1",
      { days: -5 },
      { prisma },
    );
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.historicalDays, 3650);
  });

  it("omitted days resolves the env/default window (3650 when env unset)", async () => {
    const prev = process.env.BROKER_HISTORICAL_SYNC_DAYS;
    delete process.env.BROKER_HISTORICAL_SYNC_DAYS;
    try {
      const { prisma } = fakeDb({ connection: CONNECTED });
      const res = await startHistoricalSync("user_1", "conn_1", {}, { prisma });
      assert.equal(res.success, true);
      if (res.success) assert.equal(res.data.historicalDays, 3650);
    } finally {
      if (prev !== undefined) process.env.BROKER_HISTORICAL_SYNC_DAYS = prev;
    }
  });

  it("a failed gate short-circuits (NOT_FOUND) with NO row", async () => {
    const { prisma, created } = fakeDb({ connection: null });
    const res = await startHistoricalSync(
      "user_1",
      "ghost",
      { days: 30 },
      { prisma },
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_FOUND");
    assert.equal(created.length, 0);
  });
});

describe("startAllBrokerSyncs — fan-out", () => {
  it("creates one row per connection and returns a distinct job per connection", async () => {
    const { prisma, created } = fakeDb({
      connections: [
        { id: "c1", broker: "ZERODHA" },
        { id: "c2", broker: "UPSTOX" },
      ],
    });
    const res = await startAllBrokerSyncs("user_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.jobs.length, 2);
      assert.equal(res.data.jobs[0]!.connectionId, "c1");
      assert.equal(res.data.jobs[1]!.broker, "UPSTOX");
      assert.notEqual(res.data.jobs[0]!.jobId, res.data.jobs[1]!.jobId);
    }
    assert.equal(created.length, 2);
  });

  it("zero connections → an empty jobs list (success, NOT an error), no rows", async () => {
    const { prisma, created } = fakeDb({ connections: [] });
    const res = await startAllBrokerSyncs("user_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.jobs, []);
    assert.equal(created.length, 0);
  });

  it("filters the query to non-ZERODHA_CONNECT + CONNECTED connections", async () => {
    const { prisma, finds } = fakeDb({ connections: [] });
    await startAllBrokerSyncs("user_1", { prisma });
    const where = (finds[0]!.where ?? {}) as Record<string, unknown>;
    assert.equal(where.userId, "user_1");
    assert.equal(where.status, "CONNECTED");
    assert.deepEqual(where.broker, { not: "ZERODHA_CONNECT" });
  });

  it("a thrown query fails closed to INTERNAL", async () => {
    const { prisma } = fakeDb({ findThrows: true });
    const res = await startAllBrokerSyncs("user_1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MONEY-712 — connections sync with BOUNDED concurrency
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The loop was strictly sequential: a user with four brokers waited for the sum
 * of four round-trip-heavy syncs, and the wildcard "*" scheduled batch walked
 * every connection on the platform in series.
 *
 * Two properties matter more than the speedup, and both are easy to lose:
 *
 *   1. BOUNDED, not `Promise.all`. The "*" batch can carry thousands of
 *      connections (MONEY-841 removed the ~5k cliff). Unbounded, this trades a
 *      slow sync for a rate-limited — or banned — broker API key.
 *   2. The MONEY-846 per-connection error boundary. It was load-bearing when
 *      an uncaught throw aborted the whole loop; it is MORE load-bearing now
 *      that connections share a window, because a rejecting task would take its
 *      siblings with it.
 *
 * Asserted against the source: driving the real function needs decrypt +
 * broker clients + Prisma, which this suite's other cases already avoid.
 */
describe("MONEY-712 — bounded concurrent connection sync", () => {
  const SRC = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "broker-sync.service.ts",
    ),
    "utf8",
  );
  /** LINE before BLOCK — MONEY-1143. */
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  /**
   * NOTE ON SCOPE. These are WIRING assertions only. The concurrency BOUND
   * itself is asserted behaviourally in `concurrency-logic.test.ts`, by
   * observing peak in-flight count.
   *
   * That split exists because the first version of this block tried to guard
   * the bound with source regexes, and a review mutated the service to
   * `chunkSize = connections.length` — full unbounded fan-out — with all 51
   * tests still green. A regex cannot see concurrency. So the windowing moved
   * into a pure helper that CAN be observed, and what is left here is only
   * "the service actually uses it".
   */
  it("[regression] declares a small, explicit concurrency ceiling", () => {
    const m = /SYNC_CONNECTION_CONCURRENCY = (\d+)/.exec(CODE);
    assert.ok(m, "the ceiling must be a named constant, not an inline literal");
    const n = Number(m[1]);
    assert.ok(n >= 1, "a ceiling below 1 would stall the sync");
    assert.ok(
      n <= 10,
      `${n} is not a ceiling for a path that can carry thousands of ` +
        `connections — guessing high costs a rate-limited or banned API key`,
    );
  });

  it("[regression] routes through the bounded helper, not a bare Promise.all", () => {
    assert.match(
      CODE,
      /mapWithConcurrency\(\s*connections,\s*SYNC_CONNECTION_CONCURRENCY/,
      "the connection fan-out must go through the bounded helper",
    );
    assert.doesNotMatch(
      CODE,
      /Promise\.all\(\s*connections\.map/,
      "unbounded fan-out over every connection stampedes the brokers' APIs",
    );
  });

  it("[regression] a failing connection cannot reject its window", () => {
    // `mapWithConcurrency` deliberately does NOT catch, so the per-connection
    // boundary has to live inside the task. If it moved out, one bad connection
    // would reject the whole map and take its in-flight siblings with it — the
    // MONEY-846 catastrophe with a wider blast radius.
    const idx = CODE.indexOf("mapWithConcurrency(");
    assert.ok(idx > -1, "could not locate the fan-out");
    const task = CODE.slice(idx, idx + 1200);
    assert.match(
      task,
      /try\s*\{[\s\S]{0,400}?catch/,
      "the per-connection try/catch must be INSIDE the mapped task",
    );
    assert.match(
      task,
      /connectionError:/,
      "a caught failure must still resolve to a result carrying connectionError",
    );
  });
});
