/**
 * MONEY-543 - getRecentRoastSessions service tests.
 *
 * Covers the REAL `getRecentRoastSessions(userId)` exported from
 * `packages/services/src/roast.service.ts`, plus the pure
 * `buildRecentRoastSessionsQuery` it calls.
 *
 * The function is the chat ActionBlock reconcile path:
 *   - 24h window (createdAt >= now - 24h)
 *   - userId-scoped (CRITICAL — this is the IDOR guard)
 *   - newest-first (orderBy createdAt desc)
 *   - capped to 20
 *   - mixes ALL statuses (QUEUED, PROCESSING, COMPLETED, FAILED, etc.)
 *     because the consumer (ChatContext reconcile) chooses behavior per-status.
 *
 * Source: packages/services/src/roast.service.ts
 *
 * Strategy: drive the REAL service end-to-end via its injectable DB seam
 * (`RecentRoastSessionsFinder`). The injected finder is a thin in-memory
 * store that interprets the SAME `{ where, orderBy, take }` query object the
 * real `getRecentRoastSessions` builds — so the 24h `since` math, the query
 * build, the try/catch and the ServiceResult shaping are all real code; no
 * live DB, no inline reimplementation. `Date.now` is pinned per-test so the
 * 24h window is deterministic. The IDOR-critical `where` clause is also
 * asserted directly on the pure `buildRecentRoastSessionsQuery`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getRecentRoastSessions,
  buildRecentRoastSessionsQuery,
  RECENT_ROAST_TAKE,
  RECENT_ROAST_WINDOW_MS,
  type RecentRoastItem,
  type RecentRoastSessionsFinder,
  type RecentRoastSessionsQuery,
} from "@usemoney/services";

// ── In-memory store rows (a roast row carries its owner) ─────────────

interface StoredRoast extends RecentRoastItem {
  userId: string;
}

// ── Finder factory ───────────────────────────────────────────────────
// Interprets the REAL query object getRecentRoastSessions builds. It reads
// where.userId + where.createdAt.gte (i.e. the `since` the service computed)
// + orderBy + take FROM THE QUERY — it does not recompute any of them — so
// the assertions below verify the service produced the right query.

function makeFinder(rows: StoredRoast[]): RecentRoastSessionsFinder {
  return async (
    query: RecentRoastSessionsQuery,
  ): Promise<RecentRoastItem[]> => {
    const { userId } = query.where;
    const since = query.where.createdAt.gte;
    return rows
      .filter(
        (r) => r.userId === userId && r.createdAt.getTime() >= since.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.take)
      .map(
        ({
          sessionId,
          mode,
          broker,
          assetType,
          status,
          progress,
          currentStep,
          score,
          createdAt,
        }) => ({
          sessionId,
          mode,
          broker,
          assetType,
          status,
          progress,
          currentStep,
          score,
          createdAt,
        }),
      );
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeRoast(overrides: Partial<StoredRoast> = {}): StoredRoast {
  return {
    sessionId: "roast-001",
    userId: "user-001",
    mode: "overall",
    broker: null,
    assetType: "all",
    status: "COMPLETED",
    progress: 100,
    currentStep: null,
    score: 72,
    createdAt: new Date("2026-05-29T10:00:00Z"),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MONEY-543 - getRecentRoastSessions service", () => {
  let rows: StoredRoast[];
  // FIXED clock so the 24h window is deterministic across runs. The real
  // service reads `Date.now()`, so we pin it per-test and restore after.
  const NOW = new Date("2026-05-29T12:00:00Z");
  const realDateNow = Date.now;

  beforeEach(() => {
    rows = [];
    Date.now = () => NOW.getTime();
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  // ── newest-first + cap ────────────────────────────────────────

  describe("newest-first + cap", () => {
    it("returns sessions ordered by createdAt DESC (newest first)", async () => {
      rows.push(
        makeRoast({
          sessionId: "roast-old",
          createdAt: new Date("2026-05-29T08:00:00Z"),
        }),
        makeRoast({
          sessionId: "roast-mid",
          createdAt: new Date("2026-05-29T10:00:00Z"),
        }),
        makeRoast({
          sessionId: "roast-new",
          createdAt: new Date("2026-05-29T11:30:00Z"),
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.strictEqual(result.success, true);
      assert.ok(result.success && result.data);
      assert.deepStrictEqual(
        result.success && result.data.map((r) => r.sessionId),
        ["roast-new", "roast-mid", "roast-old"],
      );
    });

    it("caps results to 20 rows even when 25 exist", async () => {
      // Push 25 sessions, all within the 24h window.
      for (let i = 0; i < 25; i++) {
        rows.push(
          makeRoast({
            sessionId: `roast-${i.toString().padStart(2, "0")}`,
            // Use the index as a minute offset so order is deterministic
            createdAt: new Date(
              `2026-05-29T11:${i.toString().padStart(2, "0")}:00Z`,
            ),
          }),
        );
      }

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.strictEqual(result.success, true);
      assert.ok(result.success);
      assert.strictEqual(result.data.length, 20);
      // The 5 oldest (00..04) should be excluded — the 20 kept are 05..24.
      assert.strictEqual(result.data[0]!.sessionId, "roast-24");
      assert.strictEqual(result.data[19]!.sessionId, "roast-05");
    });

    it("returns ALL 20 results when exactly 20 sessions exist", async () => {
      for (let i = 0; i < 20; i++) {
        rows.push(
          makeRoast({
            sessionId: `r-${i}`,
            createdAt: new Date(
              `2026-05-29T11:${i.toString().padStart(2, "0")}:00Z`,
            ),
          }),
        );
      }
      const result = await getRecentRoastSessions("user-001", makeFinder(rows));
      assert.ok(result.success);
      assert.strictEqual(result.data.length, 20);
    });
  });

  // ── 24h window ────────────────────────────────────────────────

  describe("24h window filter", () => {
    it("includes sessions exactly at the 24h boundary (gte)", async () => {
      // Exactly 24h before NOW — `gte` should include this row.
      const boundary = new Date(NOW.getTime() - RECENT_ROAST_WINDOW_MS);
      rows.push(
        makeRoast({
          sessionId: "roast-boundary",
          createdAt: boundary,
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.ok(result.success);
      assert.strictEqual(result.data.length, 1);
      assert.strictEqual(result.data[0]!.sessionId, "roast-boundary");
    });

    it("excludes sessions older than 24h", async () => {
      rows.push(
        makeRoast({
          sessionId: "roast-25h-old",
          createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.strictEqual(result.success, true);
      assert.ok(result.success);
      assert.deepStrictEqual(result.data, []);
    });

    it("returns empty when all sessions are older than 24h", async () => {
      rows.push(
        makeRoast({
          sessionId: "old-1",
          createdAt: new Date("2026-05-27T10:00:00Z"),
        }),
        makeRoast({
          sessionId: "old-2",
          createdAt: new Date("2026-05-26T10:00:00Z"),
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));
      assert.ok(result.success);
      assert.deepStrictEqual(result.data, []);
    });

    it("returns empty for users with no roasts at all", async () => {
      const result = await getRecentRoastSessions(
        "user-with-nothing",
        makeFinder(rows),
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.success);
      assert.deepStrictEqual(result.data, []);
    });
  });

  // ── userId-scoping (IDOR guard) — CRITICAL ────────────────────

  describe("[IDOR guard] userId-scoping", () => {
    it("returns ONLY userA's roasts when querying as userA", async () => {
      rows.push(
        makeRoast({
          sessionId: "alice-roast",
          userId: "alice",
        }),
        makeRoast({
          sessionId: "bob-roast",
          userId: "bob",
        }),
      );

      const aliceResult = await getRecentRoastSessions(
        "alice",
        makeFinder(rows),
      );

      assert.strictEqual(aliceResult.success, true);
      assert.ok(aliceResult.success);
      assert.strictEqual(aliceResult.data.length, 1);
      assert.strictEqual(aliceResult.data[0]!.sessionId, "alice-roast");
    });

    it("[CRITICAL] userB's session does NOT appear in userA's results", async () => {
      // Bob has a roast running, Alice queries — Alice MUST NOT see it.
      rows.push(
        makeRoast({
          sessionId: "bob-secret-roast",
          userId: "bob",
        }),
      );

      const aliceResult = await getRecentRoastSessions(
        "alice",
        makeFinder(rows),
      );

      assert.strictEqual(aliceResult.success, true);
      assert.ok(aliceResult.success);
      assert.deepStrictEqual(
        aliceResult.data,
        [],
        "cross-user lookup must NOT leak the session",
      );
    });

    it("[CRITICAL] doesn't return ANY of another user's sessions even when querying user has many", async () => {
      // Alice has 3 of her own, Bob has 2. Alice queries → must see 3, not 5.
      rows.push(
        makeRoast({
          sessionId: "a-1",
          userId: "alice",
          createdAt: new Date("2026-05-29T11:00:00Z"),
        }),
        makeRoast({
          sessionId: "a-2",
          userId: "alice",
          createdAt: new Date("2026-05-29T10:00:00Z"),
        }),
        makeRoast({
          sessionId: "a-3",
          userId: "alice",
          createdAt: new Date("2026-05-29T09:00:00Z"),
        }),
        makeRoast({
          sessionId: "b-1",
          userId: "bob",
          createdAt: new Date("2026-05-29T11:30:00Z"),
        }),
        makeRoast({
          sessionId: "b-2",
          userId: "bob",
          createdAt: new Date("2026-05-29T10:30:00Z"),
        }),
      );

      const aliceResult = await getRecentRoastSessions(
        "alice",
        makeFinder(rows),
      );
      const bobResult = await getRecentRoastSessions("bob", makeFinder(rows));

      assert.ok(aliceResult.success && bobResult.success);
      assert.deepStrictEqual(
        aliceResult.data.map((r) => r.sessionId),
        ["a-1", "a-2", "a-3"],
        "Alice should see ONLY her sessions",
      );
      assert.deepStrictEqual(
        bobResult.data.map((r) => r.sessionId),
        ["b-1", "b-2"],
        "Bob should see ONLY his sessions",
      );
    });
  });

  // ── status mixing ─────────────────────────────────────────────

  describe("mixes statuses correctly", () => {
    it("includes QUEUED, PROCESSING/FETCHING_DATA, COMPLETED, FAILED — consumer filters", async () => {
      rows.push(
        makeRoast({
          sessionId: "queued",
          status: "QUEUED",
          progress: 0,
          createdAt: new Date("2026-05-29T11:30:00Z"),
        }),
        makeRoast({
          sessionId: "fetching",
          status: "FETCHING_DATA",
          progress: 10,
          createdAt: new Date("2026-05-29T11:00:00Z"),
        }),
        makeRoast({
          sessionId: "completed",
          status: "COMPLETED",
          progress: 100,
          score: 80,
          createdAt: new Date("2026-05-29T10:00:00Z"),
        }),
        makeRoast({
          sessionId: "failed",
          status: "FAILED",
          score: null,
          createdAt: new Date("2026-05-29T09:00:00Z"),
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.strictEqual(result.success, true);
      assert.ok(result.success);
      assert.strictEqual(result.data.length, 4);
      const statuses = result.data.map((r) => r.status);
      assert.deepStrictEqual(statuses, [
        "QUEUED",
        "FETCHING_DATA",
        "COMPLETED",
        "FAILED",
      ]);
    });

    it("preserves score=null for non-completed sessions and score=number for completed", async () => {
      rows.push(
        makeRoast({
          sessionId: "in-progress",
          status: "ANALYZING_STOCKS",
          score: null,
        }),
        makeRoast({
          sessionId: "done",
          status: "COMPLETED",
          score: 65,
          createdAt: new Date("2026-05-29T09:00:00Z"),
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.ok(result.success);
      const inProgress = result.data.find((r) => r.sessionId === "in-progress");
      const done = result.data.find((r) => r.sessionId === "done");
      assert.strictEqual(inProgress?.score, null);
      assert.strictEqual(done?.score, 65);
    });

    it("preserves mode/broker/assetType triple for chat reconcile to key on", async () => {
      rows.push(
        makeRoast({
          sessionId: "broker-zerodha-stocks",
          mode: "broker",
          broker: "ZERODHA",
          assetType: "stocks",
        }),
      );

      const result = await getRecentRoastSessions("user-001", makeFinder(rows));

      assert.ok(result.success);
      assert.strictEqual(result.data[0]!.mode, "broker");
      assert.strictEqual(result.data[0]!.broker, "ZERODHA");
      assert.strictEqual(result.data[0]!.assetType, "stocks");
    });
  });

  // ── error path ────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns a sanitized failure when the finder throws", async () => {
      const throwingFinder: RecentRoastSessionsFinder = async () => {
        throw new Error("db exploded");
      };

      const result = await getRecentRoastSessions("user-001", throwingFinder);

      assert.strictEqual(result.success, false);
      assert.ok(!result.success);
      assert.strictEqual(result.error, "Failed to get recent roast sessions");
    });
  });

  // ── pure query builder — IDOR contract (CRITICAL) ─────────────

  describe("buildRecentRoastSessionsQuery (IDOR query contract)", () => {
    it("[CRITICAL] always scopes the where to the given userId", () => {
      const since = new Date("2026-05-28T12:00:00Z");
      const q = buildRecentRoastSessionsQuery("alice", since);
      assert.strictEqual(q.where.userId, "alice");
    });

    it("[CRITICAL] bounds createdAt to the 24h window via gte: since", () => {
      const since = new Date("2026-05-28T12:00:00Z");
      const q = buildRecentRoastSessionsQuery("alice", since);
      assert.strictEqual(q.where.createdAt.gte.getTime(), since.getTime());
    });

    it("orders newest-first and caps at RECENT_ROAST_TAKE (20)", () => {
      const q = buildRecentRoastSessionsQuery("alice", new Date());
      assert.strictEqual(q.orderBy.createdAt, "desc");
      assert.strictEqual(q.take, RECENT_ROAST_TAKE);
      assert.strictEqual(q.take, 20);
    });

    it("selects exactly the reconcile fields (no result/errorMessage leak)", () => {
      const q = buildRecentRoastSessionsQuery("alice", new Date());
      assert.deepStrictEqual(Object.keys(q.select).sort(), [
        "assetType",
        "broker",
        "createdAt",
        "currentStep",
        "mode",
        "progress",
        "score",
        "sessionId",
        "status",
      ]);
    });
  });

  // ── source-level guard ────────────────────────────────────────

  describe("[source] @usemoney/services exports", () => {
    it("getRecentRoastSessions is exported as a function with userId arg", () => {
      assert.strictEqual(
        typeof getRecentRoastSessions,
        "function",
        "getRecentRoastSessions must be exported",
      );
      // Required arg: userId (the optional injectable finder doesn't count
      // toward .length). Guards against a refactor that renames/collapses it.
      assert.ok(
        getRecentRoastSessions.length >= 1,
        `getRecentRoastSessions arity >= 1, got ${getRecentRoastSessions.length}`,
      );
    });

    it("RECENT_ROAST_WINDOW_MS is exactly 24h", () => {
      assert.strictEqual(RECENT_ROAST_WINDOW_MS, 24 * 60 * 60 * 1000);
    });
  });
});
