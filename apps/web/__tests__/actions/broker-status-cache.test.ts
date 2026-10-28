/**
 * MONEY-1124 — broker market-data status cache resolver (REAL source).
 *
 * Drives the ACTUAL exported `resolveBrokerMarketDataStatus` + helpers from
 * `@/lib/actions/broker-status-logic` — the module the `"use server"` action in
 * `lib/actions/broker-status.ts` delegates to. All I/O (Prisma, Clerk, Redis)
 * arrives through injected ports, so this is pure: no DB, no cache, no timers,
 * and the clock is injected so the expiry boundary is deterministic.
 *
 * The end-to-end wiring (that the ACTION really reads through the cache, and
 * really keys the broker entry on the internal user id) is asserted in
 * __tests__/actions/broker-status.test.ts against the real action.
 *
 * Source: apps/web/lib/actions/broker-status-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BROKER_CONNECTIONS_CACHE_IDENTIFIER,
  BROKER_STATUS_CACHE_TTL_SECONDS,
  BROKER_USER_CACHE_IDENTIFIER,
  NO_BROKER_STATUS,
  deriveBrokerMarketDataStatus,
  resolveBrokerMarketDataStatus,
  snapshotExpiryMs,
  toConnectionSnapshots,
  type BrokerConnectionSnapshot,
  type BrokerStatusPorts,
} from "@/lib/actions/broker-status-logic";

const NOW = 1_770_000_000_000;
const REAUTH = "https://kite.zerodha.com/connect/login?api_key=env-key&v=3";

interface Recorder {
  findUserId: number;
  findConnections: number;
  userWrites: Array<{ id: string | null }>;
  connectionWrites: BrokerConnectionSnapshot[][];
}

interface PortOverrides {
  userCache?: Map<string, { id: string | null }>;
  connCache?: Map<string, BrokerConnectionSnapshot[]>;
  userId?: string | null;
  connections?: Array<{ status: string; tokenExpiry: Date | string | null }>;
  findUserIdThrows?: Error;
  findConnectionsThrows?: Error;
  now?: number;
}

function makePorts(o: PortOverrides = {}): {
  ports: BrokerStatusPorts;
  rec: Recorder;
} {
  const userCache = o.userCache ?? new Map<string, { id: string | null }>();
  const connCache =
    o.connCache ?? new Map<string, BrokerConnectionSnapshot[]>();
  const rec: Recorder = {
    findUserId: 0,
    findConnections: 0,
    userWrites: [],
    connectionWrites: [],
  };

  const ports: BrokerStatusPorts = {
    readUserIdCache: async (clerkUserId) => userCache.get(clerkUserId) ?? null,
    writeUserIdCache: async (clerkUserId, value) => {
      rec.userWrites.push(value);
      userCache.set(clerkUserId, value);
    },
    findUserId: async () => {
      rec.findUserId += 1;
      if (o.findUserIdThrows) throw o.findUserIdThrows;
      return o.userId === undefined ? "internal-1" : o.userId;
    },
    readConnectionsCache: async (userId) => connCache.get(userId) ?? null,
    writeConnectionsCache: async (userId, snapshots) => {
      rec.connectionWrites.push(snapshots);
      connCache.set(userId, snapshots);
    },
    findConnections: async () => {
      rec.findConnections += 1;
      if (o.findConnectionsThrows) throw o.findConnectionsThrows;
      return o.connections ?? [];
    },
    reauthUrl: () => REAUTH,
    now: () => o.now ?? NOW,
  };

  return { ports, rec };
}

const future = () => new Date(NOW + 24 * 60 * 60 * 1000);
const past = () => new Date(NOW - 24 * 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════
describe("MONEY-1124 — broker-status cache resolver (real source)", () => {
  describe("cache behaviour", () => {
    it("a warm cache resolves the status with ZERO DB calls", async () => {
      const { ports, rec } = makePorts({
        userCache: new Map([["clerk_1", { id: "internal-1" }]]),
        connCache: new Map([
          [
            "internal-1",
            [{ status: "CONNECTED", tokenExpiry: future().toISOString() }],
          ],
        ]),
      });

      const status = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.equal(status.status, "active");
      assert.equal(rec.findUserId, 0);
      assert.equal(rec.findConnections, 0);
    });

    it("a cold cache queries once and writes both entries", async () => {
      const { ports, rec } = makePorts({
        connections: [{ status: "CONNECTED", tokenExpiry: future() }],
      });

      const status = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.equal(status.status, "active");
      assert.equal(rec.findUserId, 1);
      assert.equal(rec.findConnections, 1);
      assert.deepEqual(rec.userWrites, [{ id: "internal-1" }]);
      assert.equal(rec.connectionWrites.length, 1);
    });

    it("the second call inside the window re-queries NOTHING", async () => {
      const { ports, rec } = makePorts({
        connections: [{ status: "CONNECTED", tokenExpiry: future() }],
      });

      const first = await resolveBrokerMarketDataStatus("clerk_1", ports);
      const second = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.deepEqual(second, first);
      assert.equal(rec.findUserId, 1, "user lookup ran exactly once");
      assert.equal(
        rec.findConnections,
        1,
        "connection lookup ran exactly once"
      );
    });

    it("`{ id: null }` is a NEGATIVE cache entry, not a miss", async () => {
      const { ports, rec } = makePorts({
        userCache: new Map([["clerk_1", { id: null }]]),
      });

      const status = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.deepEqual(status, NO_BROKER_STATUS);
      assert.equal(
        rec.findUserId,
        0,
        "a cached 'no such user' must not re-query"
      );
    });

    it("an empty cached connection list is honoured (not retried as a miss)", async () => {
      const { ports, rec } = makePorts({
        userCache: new Map([["clerk_1", { id: "internal-1" }]]),
        connCache: new Map([["internal-1", []]]),
      });

      const status = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.deepEqual(status, NO_BROKER_STATUS);
      assert.equal(rec.findConnections, 0);
    });
  });

  describe("freshness / safety direction", () => {
    it("expiry is judged against the LIVE clock even when the rows came from cache", async () => {
      const expiry = new Date(NOW + 30_000).toISOString();
      const connCache = new Map([
        ["internal-1", [{ status: "CONNECTED", tokenExpiry: expiry }]],
      ]);
      const userCache = new Map([["clerk_1", { id: "internal-1" }]]);

      const before = await resolveBrokerMarketDataStatus(
        "clerk_1",
        makePorts({ userCache, connCache, now: NOW }).ports
      );
      assert.equal(before.status, "active");

      // Same cached rows, clock moved past the token expiry.
      const after = await resolveBrokerMarketDataStatus(
        "clerk_1",
        makePorts({ userCache, connCache, now: NOW + 60_000 }).ports
      );
      assert.equal(
        after.status,
        "needs_reauth",
        "a token lapsing inside the cache window must flip immediately"
      );
    });

    it("a DB failure degrades to 'none' (the direction that SHOWS the delayed note)", async () => {
      const { ports, rec } = makePorts({
        findUserIdThrows: new Error("db down"),
      });

      const status = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.deepEqual(status, NO_BROKER_STATUS);
      assert.deepEqual(
        rec.userWrites,
        [],
        "a failed read must not poison the cache"
      );
    });

    it("a connection-query failure degrades to 'none' and writes no connection entry", async () => {
      const { ports, rec } = makePorts({
        findConnectionsThrows: new Error("db down"),
      });

      const status = await resolveBrokerMarketDataStatus("clerk_1", ports);

      assert.deepEqual(status, NO_BROKER_STATUS);
      assert.deepEqual(rec.connectionWrites, []);
    });

    it("no clerk id → 'none' with no cache or DB access at all", async () => {
      const { ports, rec } = makePorts();
      const status = await resolveBrokerMarketDataStatus(null, ports);

      assert.deepEqual(status, NO_BROKER_STATUS);
      assert.equal(rec.findUserId, 0);
      assert.equal(rec.findConnections, 0);
    });
  });

  describe("deriveBrokerMarketDataStatus (MONEY-837 any-healthy rule)", () => {
    it("CONNECTED + future expiry → active, and never leaks a reauthUrl", () => {
      const out = deriveBrokerMarketDataStatus(
        [{ status: "CONNECTED", tokenExpiry: future().toISOString() }],
        NOW,
        REAUTH
      );
      assert.equal(out.status, "active");
      assert.equal(out.reauthUrl, null);
    });

    it("one healthy connection suppresses the banner for a stale sibling", () => {
      const out = deriveBrokerMarketDataStatus(
        [
          { status: "CONNECTED", tokenExpiry: past().toISOString() },
          { status: "CONNECTED", tokenExpiry: future().toISOString() },
        ],
        NOW,
        REAUTH
      );
      assert.equal(out.status, "active");
    });

    it("DISCONNECTED + future expiry → needs_reauth (status gate, not just expiry)", () => {
      const out = deriveBrokerMarketDataStatus(
        [{ status: "DISCONNECTED", tokenExpiry: future().toISOString() }],
        NOW,
        REAUTH
      );
      assert.equal(out.status, "needs_reauth");
      assert.equal(out.reauthUrl, REAUTH);
    });

    it("null expiry → needs_reauth", () => {
      const out = deriveBrokerMarketDataStatus(
        [{ status: "CONNECTED", tokenExpiry: null }],
        NOW,
        REAUTH
      );
      assert.equal(out.status, "needs_reauth");
    });

    it("no connections → the shared NO_BROKER_STATUS", () => {
      assert.deepEqual(
        deriveBrokerMarketDataStatus([], NOW, REAUTH),
        NO_BROKER_STATUS
      );
    });

    it("an unconfigured api key yields a null reauthUrl, not a broken link", () => {
      const out = deriveBrokerMarketDataStatus(
        [{ status: "CONNECTED", tokenExpiry: past().toISOString() }],
        NOW,
        null
      );
      assert.equal(out.status, "needs_reauth");
      assert.equal(out.reauthUrl, null);
    });
  });

  describe("snapshot serialisation", () => {
    it("converts Date / string / null expiries into a JSON-safe shape", () => {
      const snaps = toConnectionSnapshots([
        { status: "CONNECTED", tokenExpiry: new Date(NOW) },
        { status: "CONNECTED", tokenExpiry: new Date(NOW).toISOString() },
        { status: "CONNECTED", tokenExpiry: null },
      ]);
      assert.equal(snaps[0]!.tokenExpiry, new Date(NOW).toISOString());
      assert.equal(snaps[1]!.tokenExpiry, new Date(NOW).toISOString());
      assert.equal(snaps[2]!.tokenExpiry, null);
    });

    it("snapshotExpiryMs rejects an unparseable expiry rather than trusting it", () => {
      assert.equal(
        snapshotExpiryMs({ status: "CONNECTED", tokenExpiry: "not-a-date" }),
        null
      );
      assert.equal(
        snapshotExpiryMs({ status: "CONNECTED", tokenExpiry: null }),
        null
      );
      assert.equal(
        snapshotExpiryMs({
          status: "CONNECTED",
          tokenExpiry: new Date(NOW).toISOString(),
        }),
        NOW
      );
    });

    it("an unparseable expiry can never read as 'active'", () => {
      const out = deriveBrokerMarketDataStatus(
        [{ status: "CONNECTED", tokenExpiry: "garbage" }],
        NOW,
        REAUTH
      );
      assert.equal(out.status, "needs_reauth");
    });
  });

  describe("constants", () => {
    it("TTL is 60s — the window /api/market/broker-status already grants the browser", () => {
      assert.equal(BROKER_STATUS_CACHE_TTL_SECONDS, 60);
    });

    it("cache identifiers are distinct and stable", () => {
      assert.equal(BROKER_USER_CACHE_IDENTIFIER, "market-data-user-id");
      assert.equal(
        BROKER_CONNECTIONS_CACHE_IDENTIFIER,
        "market-data-connections"
      );
      assert.notEqual(
        BROKER_USER_CACHE_IDENTIFIER,
        BROKER_CONNECTIONS_CACHE_IDENTIFIER
      );
    });
  });
});
