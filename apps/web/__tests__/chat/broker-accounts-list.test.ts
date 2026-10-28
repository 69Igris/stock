/**
 * BrokerAccountsList - status classification + filter helpers (MONEY-231 Phase G).
 *
 * The shared component (apps/web/components/chat/brokers/BrokerAccountsList.tsx)
 * is used both by the "+" popover Connectors view AND the @ picker Brokers tab.
 * Both surfaces depend on:
 *   1. correct `status` derivation from BrokerConnection (active|expired|never)
 *   2. case-insensitive filter matching against label OR nickname
 *   3. group-by-platform partitioning preserving brand color/logo
 *
 * These pure helpers are inlined here so the test stays React-free.
 *
 * Backfilled in Wave 0.5 of the MONEY-196 bundle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Types (mirror BrokerAccountsList.tsx) ──────────────────────────

interface BrokerConnection {
  id: string;
  broker: string;
  brokerUserId: string;
  accountName?: string | null;
  needsReauth: boolean;
  isExpired: boolean;
  lastSync: Date | null;
}

interface BrokerAccountRow {
  id: string;
  platform: string;
  brokerType: string;
  platformLabel: string;
  nickname: string;
  status: "active" | "expired" | "never";
}

// De-shadowed (MONEY-620): import the REAL helpers, now extracted into the
// React-free broker-accounts-logic.ts and CALLED by BrokerAccountsList's
// row-builder (status/nickname) and its filter useMemo, so they aren't dead.
import {
  deriveBrokerStatus as deriveStatus,
  deriveBrokerNickname as deriveNickname,
  filterBrokerRows as applyFilter,
  groupByPlatform,
} from "@/components/chat/brokers/broker-accounts-logic";

// ── Tests ──────────────────────────────────────────────────────────

describe("BrokerAccountsList - status derivation", () => {
  it("returns expired when needsReauth is true", () => {
    const b = {
      needsReauth: true,
      isExpired: false,
      lastSync: new Date(),
    };
    assert.strictEqual(deriveStatus(b), "expired");
  });

  it("returns expired when isExpired is true (lastSync ignored)", () => {
    const b = {
      needsReauth: false,
      isExpired: true,
      lastSync: new Date(),
    };
    assert.strictEqual(deriveStatus(b), "expired");
  });

  it("returns never when no lastSync and no expiry flags", () => {
    const b = {
      needsReauth: false,
      isExpired: false,
      lastSync: null,
    };
    assert.strictEqual(deriveStatus(b), "never");
  });

  it("returns active when synced and not expired", () => {
    const b = {
      needsReauth: false,
      isExpired: false,
      lastSync: new Date(),
    };
    assert.strictEqual(deriveStatus(b), "active");
  });

  it("expired wins over never (both lastSync null and needsReauth)", () => {
    const b = {
      needsReauth: true,
      isExpired: false,
      lastSync: null,
    };
    assert.strictEqual(deriveStatus(b), "expired");
  });
});

describe("BrokerAccountsList - nickname derivation", () => {
  it("uses accountName when set", () => {
    assert.strictEqual(
      deriveNickname({ accountName: "Long-term", brokerUserId: "ZK1234" }),
      "Long-term"
    );
  });

  it("trims whitespace from accountName", () => {
    assert.strictEqual(
      deriveNickname({
        accountName: "  Family account  ",
        brokerUserId: "ZK1234",
      }),
      "Family account"
    );
  });

  it("falls back to brokerUserId when accountName is empty/null", () => {
    assert.strictEqual(
      deriveNickname({ accountName: null, brokerUserId: "ZK1234" }),
      "ZK1234"
    );
    assert.strictEqual(
      deriveNickname({ accountName: "", brokerUserId: "ZK1234" }),
      "ZK1234"
    );
    assert.strictEqual(
      deriveNickname({ accountName: "   ", brokerUserId: "ZK1234" }),
      "ZK1234"
    );
  });

  it('falls back to "Account" when both are empty', () => {
    assert.strictEqual(
      deriveNickname({ accountName: null, brokerUserId: "" }),
      "Account"
    );
  });
});

describe("BrokerAccountsList - filter logic", () => {
  const rows = [
    { platformLabel: "Zerodha", nickname: "Long-term" },
    { platformLabel: "Upstox", nickname: "Trading" },
    { platformLabel: "Angel One", nickname: "ZK1234" },
    { platformLabel: "Groww", nickname: "Family account" },
  ];

  it("returns full list when query is empty", () => {
    assert.deepStrictEqual(applyFilter(rows, ""), rows);
    assert.deepStrictEqual(applyFilter(rows, undefined), rows);
    assert.deepStrictEqual(applyFilter(rows, "   "), rows);
  });

  it("matches against platform label (case-insensitive)", () => {
    const filtered = applyFilter(rows, "ZERO");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0]!.platformLabel, "Zerodha");
  });

  it("matches against nickname", () => {
    const filtered = applyFilter(rows, "long-term");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0]!.nickname, "Long-term");
  });

  it("matches across both fields with OR semantics", () => {
    const filtered = applyFilter(rows, "family");
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0]!.platformLabel, "Groww");
  });

  it("returns empty list when no match", () => {
    assert.deepStrictEqual(applyFilter(rows, "xyz123"), []);
  });
});

describe("BrokerAccountsList - group by platform", () => {
  it("groups multiple accounts under the same platform", () => {
    const rows = [
      { id: "1", platform: "zerodha" },
      { id: "2", platform: "zerodha" },
      { id: "3", platform: "upstox" },
    ];
    const groups = groupByPlatform(rows);
    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get("zerodha")!.length, 2);
    assert.strictEqual(groups.get("upstox")!.length, 1);
  });

  it("preserves insertion order within each group", () => {
    const rows = [
      { id: "a", platform: "zerodha" },
      { id: "b", platform: "zerodha" },
      { id: "c", platform: "zerodha" },
    ];
    const z = groupByPlatform(rows).get("zerodha")!;
    assert.deepStrictEqual(
      z.map((r) => r.id),
      ["a", "b", "c"]
    );
  });

  it("returns an empty map for empty input", () => {
    assert.strictEqual(groupByPlatform([]).size, 0);
  });
});

// ── Integration: full row pipeline (BrokerConnection -> BrokerAccountRow) ──

describe("BrokerAccountsList - end-to-end row mapping", () => {
  it("maps a happy-path connection", () => {
    const conn: BrokerConnection = {
      id: "abc",
      broker: "ZERODHA",
      brokerUserId: "ZK1234",
      accountName: "Long-term",
      needsReauth: false,
      isExpired: false,
      lastSync: new Date(),
    };
    const row: BrokerAccountRow = {
      id: conn.id,
      platform: conn.broker.toLowerCase(),
      brokerType: conn.broker,
      platformLabel: "Zerodha",
      nickname: deriveNickname(conn),
      status: deriveStatus(conn),
    };
    assert.strictEqual(row.platform, "zerodha");
    assert.strictEqual(row.status, "active");
    assert.strictEqual(row.nickname, "Long-term");
  });

  it("maps an expired connection that never synced", () => {
    const conn: BrokerConnection = {
      id: "xyz",
      broker: "UPSTOX",
      brokerUserId: "U123",
      accountName: null,
      needsReauth: true,
      isExpired: false,
      lastSync: null,
    };
    const row: BrokerAccountRow = {
      id: conn.id,
      platform: conn.broker.toLowerCase(),
      brokerType: conn.broker,
      platformLabel: "Upstox",
      nickname: deriveNickname(conn),
      status: deriveStatus(conn),
    };
    assert.strictEqual(row.status, "expired");
    assert.strictEqual(row.nickname, "U123");
  });
});
