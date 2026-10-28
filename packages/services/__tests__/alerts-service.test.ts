/**
 * alerts.service + alerts-logic — REAL exports, injected prisma (MONEY-402/408).
 *
 * Pins the IDOR + allow-list contract:
 *   - list/create/update/delete are all scoped to the caller's userId,
 *   - update confirms ownership via findFirst BEFORE the write (a Prisma
 *     `update` would silently no-op on a foreign id) → foreign id = not-found,
 *   - delete is a scoped `deleteMany` (count 0 → not-found, no cross-user
 *     oracle),
 *   - an invalid kind is rejected before any DB write,
 *   - channels default to ["IN_APP"], cooldown defaults to 60m,
 *   - a thrown query fails closed to a sanitised error.
 *
 * Source: packages/services/src/alerts.service.ts + alerts-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isValidKind,
  isValidStatus,
  sanitizeChannels,
  normalizeCooldown,
  buildAlertUpdatePatch,
} from "../src/alerts-logic";
import {
  listAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  type AlertsServiceDeps,
} from "../src/alerts.service";

// ── pure logic ───────────────────────────────────────────────────────────────

describe("alerts-logic validation", () => {
  it("kind + status allow-lists", () => {
    assert.equal(isValidKind("PRICE"), true);
    assert.equal(isValidKind("HACK"), false);
    assert.equal(isValidStatus("ACTIVE"), true);
    assert.equal(isValidStatus("nope"), false);
  });

  it("sanitizeChannels drops junk and defaults to IN_APP", () => {
    assert.deepEqual(sanitizeChannels(["EMAIL", "SMS" as never]), ["EMAIL"]);
    assert.deepEqual(sanitizeChannels([]), ["IN_APP"]);
    assert.deepEqual(sanitizeChannels(undefined), ["IN_APP"]);
  });

  it("normalizeCooldown defaults non-positive/absent to 60m", () => {
    assert.equal(normalizeCooldown(15), 15);
    assert.equal(normalizeCooldown(0), 60);
    assert.equal(normalizeCooldown(undefined), 60);
    assert.equal(normalizeCooldown(Number.NaN), 60);
  });

  it("buildAlertUpdatePatch is sparse and drops an invalid status", () => {
    assert.deepEqual(buildAlertUpdatePatch({}), {});
    assert.deepEqual(buildAlertUpdatePatch({ status: "bogus" as never }), {});
    const patch = buildAlertUpdatePatch({
      status: "PAUSED",
      notifyChannels: ["PUSH"],
    });
    assert.equal(patch.status, "PAUSED");
    assert.deepEqual(patch.notifyChannels, ["PUSH"]);
  });
});

// ── service (injected prisma) ────────────────────────────────────────────────

interface Call {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  select?: unknown;
  orderBy?: unknown;
}
function fake(delegates: Record<string, (args: Call) => unknown>): {
  prisma: AlertsServiceDeps["prisma"];
  calls: Record<string, Call[]>;
} {
  const calls: Record<string, Call[]> = {};
  const db: Record<string, Record<string, (a: Call) => unknown>> = {};
  for (const key of Object.keys(delegates)) {
    const [model, method] = key.split(".");
    db[model] ??= {};
    db[model][method] = async (args: Call) => {
      (calls[key] ??= []).push(args);
      return delegates[key](args);
    };
  }
  return { prisma: db as unknown as AlertsServiceDeps["prisma"], calls };
}

describe("alerts.service listAlerts", () => {
  it("scopes the WHERE to the caller and maps rows", async () => {
    const { prisma, calls } = fake({
      "alert.findMany": () => [
        {
          id: "a1",
          kind: "PRICE",
          symbol: "TCS",
          conditions: { thresholdPrice: 100 },
          notifyChannels: ["IN_APP"],
          status: "ACTIVE",
          lastFiredAt: null,
          cooldownMinutes: 60,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const res = await listAlerts("u1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data[0]?.symbol, "TCS");
    assert.deepEqual(calls["alert.findMany"]?.[0]?.where, { userId: "u1" });
  });
});

describe("alerts.service createAlert", () => {
  it("rejects an invalid kind before any DB write", async () => {
    let created = false;
    const { prisma } = fake({
      "alert.create": () => {
        created = true;
        return { id: "x" };
      },
    });
    const res = await createAlert(
      "u1",
      { kind: "HACK" as never, conditions: {} },
      { prisma },
    );
    assert.equal(res.success, false);
    assert.equal(created, false);
  });

  it("defaults channels to IN_APP and cooldown to 60 on create", async () => {
    const { prisma, calls } = fake({
      "alert.create": () => ({ id: "a1" }),
    });
    const res = await createAlert(
      "u1",
      { kind: "PRICE", conditions: { thresholdPrice: 100 } },
      { prisma },
    );
    assert.equal(res.success, true);
    const data = calls["alert.create"]?.[0]?.data;
    assert.equal(data?.userId, "u1");
    assert.deepEqual(data?.notifyChannels, ["IN_APP"]);
    assert.equal(data?.cooldownMinutes, 60);
  });
});

describe("alerts.service updateAlert", () => {
  it("returns not-found for a foreign id and never updates", async () => {
    let updated = false;
    const { prisma } = fake({
      "alert.findFirst": () => null, // not owned
      "alert.update": () => {
        updated = true;
        return {};
      },
    });
    const res = await updateAlert(
      "attacker",
      "victims_alert",
      { status: "PAUSED" },
      { prisma },
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Alert not found");
    assert.equal(updated, false);
  });

  it("confirms ownership then applies the patch", async () => {
    const { prisma, calls } = fake({
      "alert.findFirst": () => ({ id: "a1" }),
      "alert.update": () => ({ id: "a1" }),
    });
    const res = await updateAlert("u1", "a1", { status: "PAUSED" }, { prisma });
    assert.equal(res.success, true);
    assert.deepEqual(calls["alert.findFirst"]?.[0]?.where, {
      id: "a1",
      userId: "u1",
    });
    assert.equal(
      (calls["alert.update"]?.[0]?.data as Record<string, unknown>)?.status,
      "PAUSED",
    );
  });
});

describe("alerts.service deleteAlert", () => {
  it("scopes deleteMany to id+userId; count 0 → not-found", async () => {
    const { prisma, calls } = fake({
      "alert.deleteMany": () => ({ count: 0 }),
    });
    const res = await deleteAlert("attacker", "victims_alert", { prisma });
    assert.equal(res.success, false);
    assert.deepEqual(calls["alert.deleteMany"]?.[0]?.where, {
      id: "victims_alert",
      userId: "attacker",
    });
  });

  it("succeeds when a row was deleted", async () => {
    const { prisma } = fake({ "alert.deleteMany": () => ({ count: 1 }) });
    const res = await deleteAlert("u1", "a1", { prisma });
    assert.equal(res.success, true);
  });

  it("fails closed with a sanitised error when the query throws", async () => {
    const { prisma } = fake({
      "alert.deleteMany": () => {
        throw new Error("Mongo down");
      },
    });
    const res = await deleteAlert("u1", "a1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Failed to delete alert");
  });
});
