/**
 * Integration test helper utilities.
 *
 * Provides factory functions for creating and cleaning up test data
 * in the QA database. All test users are created with a recognisable
 * prefix so they can be identified and purged if cleanup is missed.
 *
 * Usage:
 *   import { createTestUser, cleanupTestUser } from "../helpers.js";
 */

import { db } from "./setup.js";
import type { PlanType } from "@prisma/client";

const TEST_USER_PREFIX = "test_integration_";

// ───────────────────────── User helpers ─────────────────────────

/**
 * Creates a test user with a unique email based on timestamp + random suffix.
 * The email is prefixed so test data is easy to identify.
 */
export async function createTestUser(
  overrides: {
    name?: string;
    email?: string;
  } = {},
) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const email =
    overrides.email ?? `${TEST_USER_PREFIX}${ts}_${rand}@test.usemoney.ai`;

  return db.user.create({
    data: {
      email,
      name: overrides.name ?? `Integration Test User ${ts}`,
      isActive: true,
    },
  });
}

/**
 * Deletes a test user and all related data (cascading via Prisma relations).
 * Silently succeeds if the user has already been deleted.
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  // Delete related records first (Prisma MongoDB doesn't cascade automatically)
  await Promise.allSettled([
    db.holding.deleteMany({ where: { userId } }),
    db.trade.deleteMany({ where: { userId } }),
    db.position.deleteMany({ where: { userId } }),
    db.mutualFund.deleteMany({ where: { userId } }),
    db.subscription.deleteMany({ where: { userId } }),
    db.paperPosition.deleteMany({ where: { userId } }),
    db.fireScenario.deleteMany({ where: { userId } }),
    db.chatHistory.deleteMany({ where: { userId } }),
    db.brokerConnection.deleteMany({ where: { userId } }),
    db.payment.deleteMany({ where: { userId } }),
    db.watchList.deleteMany({ where: { userId } }),
    db.userDocument.deleteMany({ where: { userId } }),
    db.portfolioRoast.deleteMany({ where: { userId } }),
  ]);

  // Finally delete the user
  await db.user.deleteMany({ where: { id: userId } });
}

// ───────────────────────── Holding helpers ─────────────────────────

/**
 * Creates a test holding with sensible defaults.
 * Override any field via the `overrides` parameter.
 */
export async function createTestHolding(
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  const defaults = {
    symbol: "RELIANCE",
    tradingSymbol: "RELIANCE",
    name: "Reliance Industries Ltd",
    isin: "INE002A01018",
    exchange: "NSE",
    quantity: 10,
    averagePrice: 2500,
    currentPrice: 2600,
    investedValue: 25000,
    currentValue: 26000,
    unrealizedPnL: 1000,
    pnlPercentage: 4.0,
    dayChange: 50,
    dayChangePercentage: 1.96,
  };

  return db.holding.create({
    data: {
      userId,
      ...defaults,
      ...(overrides as Record<string, unknown>),
    } as Parameters<typeof db.holding.create>[0]["data"],
  });
}

// ───────────────────────── Trade helpers ─────────────────────────

/**
 * Creates a test trade with sensible defaults.
 * Override any field via the `overrides` parameter.
 */
export async function createTestTrade(
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  const defaults = {
    symbol: "RELIANCE",
    tradingSymbol: "RELIANCE",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 10,
    price: 2500,
    tradeValue: 25000,
    tradeDate: new Date(),
    sourceType: "MANUAL" as const,
  };

  return db.trade.create({
    data: {
      userId,
      ...defaults,
      ...(overrides as Record<string, unknown>),
    } as Parameters<typeof db.trade.create>[0]["data"],
  });
}

// ───────────────────────── Subscription helpers ─────────────────────────

/**
 * Creates a test subscription for a user.
 */
export async function createTestSubscription(
  userId: string,
  tier: PlanType = "FREE",
) {
  return db.subscription.create({
    data: {
      userId,
      planId: tier,
      status: "ACTIVE",
      startDate: new Date(),
      fastQueriesUsed: 0,
      fastQueriesLimit: tier === "FREE" ? 5 : 100,
      advancedQueriesUsed: 0,
      advancedQueriesLimit: tier === "FREE" ? 0 : 50,
    },
  });
}

// ───────────────────────── Polling / wait helpers ─────────────────────────

/**
 * Polls `fn` until it returns a truthy value, or throws after `timeoutMs`.
 * Useful for waiting on eventually-consistent state (Pub/Sub processing, etc.).
 *
 * @param fn        - async function that returns a truthy value when the condition is met
 * @param timeoutMs - maximum wait time (default 10 000 ms)
 * @param intervalMs - poll interval (default 500 ms)
 */
export async function waitForCondition<T>(
  fn: () => Promise<T>,
  timeoutMs = 10_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `waitForCondition timed out after ${timeoutMs}ms`,
  );
}
