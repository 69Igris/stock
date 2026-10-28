/**
 * Scheduled-plan-changes PURE-SEAM tests — MONEY-482 / MONEY-1062 (W1-B).
 *
 * `packages/services` runs its suite as ESM, so the pure, Prisma-free seams are
 * asserted here and the `applyScheduledChanges` service behaviour (FREE cancel /
 * no-Dodo-sub flip / missing-product skip / Dodo changePlan / error isolation)
 * is contract-tested from the CJS side in
 * apps/web/__tests__/api/scheduled-plan-changes-service.test.ts.
 *
 * (The `isScheduledChangeDue` describe block was removed with the function —
 * it was a test-only shadow of the cron's Prisma `where`; the real selection
 * is asserted against the service's `findMany` args in the CJS contract test.)
 *
 * Source: packages/services/src/scheduled-plan-changes-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRebaseFields } from "../src/scheduled-plan-changes-logic";

describe("buildRebaseFields (pure rebase math)", () => {
  const now = new Date("2026-07-10T00:00:00Z").getTime();
  const THIRTY_D = 30 * 24 * 60 * 60 * 1000;

  it("PRO: legacy aiQueriesLimit from WEBHOOK_PLANS, real limits from PLAN_CONFIG", () => {
    const f = buildRebaseFields(
      { aiQueries: 10 },
      { fastQueries: 20, advancedQueries: 5, credits: 50 },
      now,
    );
    assert.equal(f.aiQueriesLimit, 10);
    assert.equal(f.fastQueriesLimit, 20);
    assert.equal(f.advancedQueriesLimit, 5);
    assert.equal(f.creditsLimit, 50);
    assert.equal(f.aiQueriesUsed, 0);
    assert.equal(f.fastQueriesUsed, 0);
    assert.equal(f.advancedQueriesUsed, 0);
    assert.equal(f.creditsUsed, 0);
    assert.equal(f.aiQueriesResetAt.getTime(), now + THIRTY_D);
    assert.equal(f.creditsResetAt.getTime(), now + THIRTY_D);
  });

  it("PREMIUM: unlimited fast (-1), 200 advanced, 200 credits", () => {
    const f = buildRebaseFields(
      { aiQueries: -1 },
      { fastQueries: -1, advancedQueries: 200, credits: 200 },
      now,
    );
    assert.equal(f.aiQueriesLimit, -1);
    assert.equal(f.fastQueriesLimit, -1);
    assert.equal(f.advancedQueriesLimit, 200);
    assert.equal(f.creditsLimit, 200);
  });

  it("FREE / missing config → 0 limits, credits default 5 (matches cron's ?? fallbacks)", () => {
    const free = buildRebaseFields(
      { aiQueries: 0 },
      { fastQueries: 0, advancedQueries: 0, credits: 5 },
      now,
    );
    assert.equal(free.creditsLimit, 5);
    // Unknown target: both configs undefined.
    const unknown = buildRebaseFields(undefined, undefined, now);
    assert.equal(unknown.aiQueriesLimit, 0);
    assert.equal(unknown.fastQueriesLimit, 0);
    assert.equal(unknown.advancedQueriesLimit, 0);
    assert.equal(unknown.creditsLimit, 5);
  });
});
