/**
 * Admin audit ledger — pure builder tests (MONEY-867).
 *
 * Covers `buildAdminAuditEntry` from src/admin-audit-logic.ts (no Prisma deps).
 * The prisma write (recordAdminAction) is best-effort and exercised via its
 * admin-action consumer tests in apps/admin / apps/web.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAdminAuditEntry } from "../src/admin-audit-logic";

describe("buildAdminAuditEntry (MONEY-867)", () => {
  it("passes through actor/action/targetType and defaults targetId to null", () => {
    const e = buildAdminAuditEntry({
      actorEmail: "admin@usemoney.ai",
      action: "coupon.create",
      targetType: "Coupon",
    });
    assert.strictEqual(e.actorEmail, "admin@usemoney.ai");
    assert.strictEqual(e.action, "coupon.create");
    assert.strictEqual(e.targetType, "Coupon");
    assert.strictEqual(e.targetId, null);
    assert.ok(!("diff" in e), "diff key should be absent when not supplied");
  });

  it("keeps a provided targetId", () => {
    const e = buildAdminAuditEntry({
      actorEmail: "a@b.com",
      action: "user.softDelete",
      targetType: "User",
      targetId: "u_123",
    });
    assert.strictEqual(e.targetId, "u_123");
  });

  it("omits diff when null or undefined (never store raw null in a Json? column)", () => {
    const u = buildAdminAuditEntry({
      actorEmail: "a",
      action: "x",
      targetType: "Y",
      diff: undefined,
    });
    assert.ok(!("diff" in u));
    const n = buildAdminAuditEntry({
      actorEmail: "a",
      action: "x",
      targetType: "Y",
      diff: null,
    });
    assert.ok(!("diff" in n));
  });

  it("includes a provided diff object", () => {
    const e = buildAdminAuditEntry({
      actorEmail: "a",
      action: "subscription.switchPlan",
      targetType: "Subscription",
      targetId: "u_1",
      diff: { from: "FREE", to: "PRO" },
    });
    assert.deepStrictEqual(e.diff, { from: "FREE", to: "PRO" });
  });

  it("preserves falsy-but-present diff values (0, false, empty string)", () => {
    assert.strictEqual(
      buildAdminAuditEntry({
        actorEmail: "a",
        action: "x",
        targetType: "Y",
        diff: 0,
      }).diff,
      0,
    );
    assert.strictEqual(
      buildAdminAuditEntry({
        actorEmail: "a",
        action: "x",
        targetType: "Y",
        diff: false,
      }).diff,
      false,
    );
    assert.strictEqual(
      buildAdminAuditEntry({
        actorEmail: "a",
        action: "x",
        targetType: "Y",
        diff: "",
      }).diff,
      "",
    );
  });
});
