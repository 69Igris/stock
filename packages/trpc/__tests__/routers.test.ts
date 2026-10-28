/**
 * tRPC router NOT_IMPLEMENTED contract (MONEY-1062).
 *
 * Every procedure in this package is an unimplemented stub that throws
 * `NOT_IMPLEMENTED` instead of returning fabricated data. This locks in the
 * money-path safety property that the previously-dangerous mutations —
 * `trades.create` (returned `{ id: "", ...input }`) and `trades.delete`
 * (returned `{ success: true }` while deleting nothing) — now FAIL LOUDLY, and
 * that the `protectedProcedure` auth gate is still intact.
 *
 * Drives the REAL router via an in-process caller (no HTTP, no network, no
 * timers — nothing to orphan).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";

import { appRouter } from "../src/routers";
import { createCallerFactory } from "../src/server/trpc";
import { notImplemented } from "../src/routers/not-implemented";

const createCaller = createCallerFactory(appRouter);

// Authenticated context: userId = resolved Mongo _id, clerkUserId = Clerk sub.
const authed = createCaller({ userId: "mongo_1", clerkUserId: "clerk_1" });

async function expectNotImplemented(
  fn: () => Promise<unknown>,
  routeHint: string,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof TRPCError, "expected a TRPCError");
    assert.equal(err.code, "NOT_IMPLEMENTED");
    assert.ok(
      err.message.includes(routeHint),
      `message should name "${routeHint}", got: ${err.message}`,
    );
    return true;
  });
}

describe("notImplemented helper", () => {
  it("throws a NOT_IMPLEMENTED TRPCError naming the REST route", () => {
    assert.throws(
      () => notImplemented("GET /v1/dashboard"),
      (err: unknown) => {
        assert.ok(err instanceof TRPCError);
        assert.equal(err.code, "NOT_IMPLEMENTED");
        assert.ok(err.message.includes("GET /v1/dashboard"));
        return true;
      },
    );
  });
});

describe("tRPC procedures all throw NOT_IMPLEMENTED (MONEY-1062)", () => {
  it("dashboard.summary throws (was hardcoded zeros)", async () => {
    await expectNotImplemented(
      () => authed.dashboard.summary(),
      "GET /v1/dashboard",
    );
  });

  it("trades.create throws instead of fabricating { id: '', ...input }", async () => {
    await expectNotImplemented(
      () =>
        authed.trades.create({
          symbol: "RELIANCE",
          tradingSymbol: "RELIANCE",
          exchange: "NSE",
          tradeType: "BUY",
          productType: "CNC",
          quantity: 1,
          price: 100,
          tradeDate: new Date(),
        }),
      "POST /v1/trades",
    );
  });

  it("trades.delete throws instead of returning { success: true }", async () => {
    await expectNotImplemented(
      () => authed.trades.delete({ id: "t1" }),
      "DELETE /v1/trades/:id",
    );
  });

  it("holdings.list throws", async () => {
    await expectNotImplemented(
      () => authed.holdings.list({}),
      "GET /v1/holdings",
    );
  });

  it("positions.summary throws", async () => {
    await expectNotImplemented(
      () => authed.positions.summary(),
      "GET /v1/positions/summary",
    );
  });
});

describe("protectedProcedure auth gate is intact", () => {
  it("an unauthenticated caller throws UNAUTHORIZED (not NOT_IMPLEMENTED)", async () => {
    const anon = createCaller({});
    await assert.rejects(
      () => anon.dashboard.summary(),
      (err: unknown) => {
        assert.ok(err instanceof TRPCError);
        assert.equal(err.code, "UNAUTHORIZED");
        return true;
      },
    );
  });
});
