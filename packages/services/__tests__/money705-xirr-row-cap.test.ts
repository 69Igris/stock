/**
 * MONEY-705 — the XIRR trade-book read is bounded, WITHOUT changing the metric.
 *
 * `getPortfolioReturns` reads the user's ENTIRE lifetime trade book and runs
 * Newton-Raphson XIRR over it. That read had no `take` at all, so a pathological
 * book was an unbounded allocation on a serverless instance.
 *
 * The two "obvious" bounds are both wrong and are deliberately NOT implemented:
 *   - a DATE FLOOR would silently redefine a money-weighted return that is, by
 *     definition, measured since inception;
 *   - `take` with `orderBy tradeDate asc` would drop the NEWEST trades — the
 *     worst possible truncation.
 *
 * What ships instead is a REFUSAL: fetch `cap + 1`, and if more than `cap` came
 * back, return the module's existing honest-"—" result
 * (`EMPTY_PORTFOLIO_RETURNS`, all-null) plus a warning. A wrong number is never
 * emitted, and at or under the cap the result is bit-identical to the uncapped
 * read — the only change to the query is the `take`.
 *
 * `Date` is frozen for the comparison cases so the reference computation and the
 * service's own `new Date()` mark-to-market close land on the SAME instant; the
 * solver takes the closing flow's date, so without freezing they would differ in
 * the far decimals and "bit-identical" could not be asserted at all.
 *
 * Source: packages/services/src/dashboard.service.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@usemoney/database";
import { cacheClient } from "@usemoney/core";
import { calcXirr, calcCagr } from "@usemoney/core/calc";
import { dbLogger } from "@usemoney/logger";
import { getPortfolioReturns } from "../src/dashboard.service";
import {
  computePortfolioReturns,
  EMPTY_PORTFOLIO_RETURNS,
} from "../src/dashboard-logic";

/** Must match XIRR_MAX_TRADES in dashboard.service.ts. */
const CAP = 50_000;

let uidCounter = 0;
function uid(label: string): string {
  uidCounter += 1;
  return `m705-xirr-${label}-${uidCounter}`;
}

// ── Frozen clock ───────────────────────────────────────────────────
// Only `new Date()` / `Date.now()` are frozen. The cache client captured the
// original `Date.now` at module load (`let nowFn = Date.now`), so TTL maths is
// untouched by this.
const FIXED_MS = new Date("2026-08-04T12:00:00.000Z").getTime();
const RealDate = Date;

function freezeDate(): () => void {
  class FrozenDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(FIXED_MS);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      return FIXED_MS;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

// ── Prisma fakes ───────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;
type PrismaLike = Record<string, AnyRecord>;
const MODELS = ["trade", "holding", "mutualFund", "position"] as const;

interface TradeRow {
  tradeType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  tradeDate: Date;
}

/** A real, valued cashflow row. */
function realTrade(
  tradeType: "BUY" | "SELL",
  isoDate: string,
  quantity: number,
  price: number,
): TradeRow {
  return {
    tradeType,
    quantity,
    price,
    tradeValue: quantity * price,
    tradeDate: new RealDate(isoDate),
  };
}

/**
 * A zero-VALUE row. `buildReturnsCashFlows` drops it (`value > 0` gate), so it
 * costs the solver nothing — but it still COUNTS toward `trades.length`, which
 * is exactly what the cap inspects. This is what keeps the 50k-row cases fast.
 */
function padTrade(): TradeRow {
  return {
    tradeType: "BUY",
    quantity: 0,
    price: 0,
    tradeValue: 0,
    tradeDate: new RealDate("2024-01-01T00:00:00.000Z"),
  };
}

/** A book of exactly `total` rows whose first two carry the real cashflows. */
function bookOf(total: number): TradeRow[] {
  const rows: TradeRow[] = [
    realTrade("BUY", "2023-08-04T00:00:00.000Z", 10, 100),
    realTrade("SELL", "2025-08-04T00:00:00.000Z", 5, 150),
  ];
  for (let i = rows.length; i < total; i++) rows.push(padTrade());
  return rows;
}

const HOLDINGS = [{ currentValue: 900 }];

describe("MONEY-705 — XIRR row cap (bounded read, unchanged metric)", () => {
  let saved: Map<string, unknown>;
  let takeSeen: number | undefined;
  let findManyArgs: AnyRecord | undefined;
  let warnings: unknown[][];
  const realWarn = dbLogger.warn.bind(dbLogger);

  function installTradeFake(rowsFor: (take: number) => TradeRow[]): void {
    (prisma as unknown as PrismaLike).trade = {
      findMany: async (args: unknown) => {
        findManyArgs = args as AnyRecord;
        takeSeen = (args as { take?: number }).take;
        return rowsFor(takeSeen ?? 0);
      },
    };
    (prisma as unknown as PrismaLike).holding = {
      findMany: async () => HOLDINGS,
    };
    (prisma as unknown as PrismaLike).mutualFund = { findMany: async () => [] };
    (prisma as unknown as PrismaLike).position = { findMany: async () => [] };
  }

  beforeEach(async () => {
    saved = new Map();
    for (const m of MODELS) saved.set(m, (prisma as unknown as PrismaLike)[m]);
    takeSeen = undefined;
    findManyArgs = undefined;
    warnings = [];
    (dbLogger as unknown as { warn: (...a: unknown[]) => void }).warn = (
      ...a: unknown[]
    ) => {
      warnings.push(a);
    };
    await cacheClient.clearMemory();
  });

  afterEach(async () => {
    for (const [m, v] of saved) {
      (prisma as unknown as PrismaLike)[m] = v as AnyRecord;
    }
    (dbLogger as unknown as { warn: unknown }).warn = realWarn;
    globalThis.Date = RealDate;
    await cacheClient.clearMemory();
  });

  // ==================================================================
  // The read is bounded, and bounded the RIGHT way
  // ==================================================================

  describe("query shape", () => {
    it("asks for exactly CAP + 1 rows — the extra row is the detector", async () => {
      installTradeFake(() => bookOf(3));
      await getPortfolioReturns(uid("take"));
      assert.equal(takeSeen, CAP + 1);
    });

    it("keeps orderBy tradeDate ASC and the 5-field projection (no date floor)", async () => {
      installTradeFake(() => bookOf(3));
      await getPortfolioReturns(uid("shape"));

      // A `gte` on tradeDate here would silently redefine the metric.
      assert.deepEqual(Object.keys(findManyArgs?.where as AnyRecord), [
        "userId",
      ]);
      assert.deepEqual(findManyArgs?.orderBy, { tradeDate: "asc" });
      assert.deepEqual(findManyArgs?.select, {
        tradeType: true,
        quantity: true,
        price: true,
        tradeValue: true,
        tradeDate: true,
      });
    });
  });

  // ==================================================================
  // UNDER the cap → bit-identical to the uncapped computation
  // ==================================================================

  describe("at or under the cap", () => {
    it("returns EXACTLY what computePortfolioReturns produces for the same rows", async () => {
      const unfreeze = freezeDate();
      try {
        const rows = bookOf(3);
        installTradeFake(() => rows);

        const expected = computePortfolioReturns(
          {
            trades: rows,
            holdings: HOLDINGS,
            mutualFunds: [],
            positions: [],
          },
          new Date(),
          { calcXirr, calcCagr },
        );

        const result = await getPortfolioReturns(uid("identical"));
        assert.ok(result.success);
        assert.deepEqual(result.success ? result.data : null, expected);

        // Sanity: the fixture really does produce numbers, so "deep equal" is
        // not quietly comparing two all-null results.
        assert.equal(typeof expected.xirrPct, "number");
        assert.equal(typeof expected.cagrPct, "number");
        assert.equal(expected.firstInvestmentDate, "2023-08-04");
      } finally {
        unfreeze();
      }
    });

    it("computes a real number at EXACTLY the cap (50,000 rows)", async () => {
      const unfreeze = freezeDate();
      try {
        installTradeFake(() => bookOf(CAP));

        const result = await getPortfolioReturns(uid("at-cap"));
        assert.ok(result.success);
        const data = result.success ? result.data : null;
        assert.equal(data?.firstInvestmentDate, "2023-08-04");
        assert.equal(typeof data?.xirrPct, "number");
        assert.equal(typeof data?.cagrPct, "number");
        assert.equal(warnings.length, 0, "at the cap nothing is refused");
      } finally {
        unfreeze();
      }
    });

    it("still returns the honest dash for a user with NO trades (unchanged)", async () => {
      installTradeFake(() => []);
      const result = await getPortfolioReturns(uid("empty"));
      assert.ok(result.success);
      assert.deepEqual(
        result.success ? result.data : null,
        EMPTY_PORTFOLIO_RETURNS,
      );
      assert.equal(warnings.length, 0, "an empty book is not a cap breach");
    });
  });

  // ==================================================================
  // OVER the cap → honest dash + a warning, NEVER a computed number
  // ==================================================================

  describe("over the cap", () => {
    it("returns the all-null honest dash, not a truncated figure", async () => {
      const unfreeze = freezeDate();
      try {
        // CAP + 1 rows: identical cashflows to the at-cap case above, which DID
        // yield real numbers — so a non-null result here could only come from
        // computing on a book we know is incomplete.
        installTradeFake(() => bookOf(CAP + 1));

        const result = await getPortfolioReturns(uid("over-cap"));
        assert.ok(result.success);
        const data = result.success ? result.data : null;
        assert.deepEqual(data, EMPTY_PORTFOLIO_RETURNS);
        assert.equal(data?.xirrPct, null);
        assert.equal(data?.cagrPct, null);
        assert.equal(data?.firstInvestmentDate, null);
        assert.equal(data?.holdingPeriodYears, null);
      } finally {
        unfreeze();
      }
    });

    it("logs a warning naming the cap so it can be raised deliberately", async () => {
      installTradeFake(() => bookOf(CAP + 1));
      await getPortfolioReturns(uid("over-cap-warn"));

      assert.equal(warnings.length, 1);
      const [context, message] = warnings[0] as [
        Record<string, unknown>,
        string,
      ];
      assert.equal(context.cap, CAP);
      assert.match(String(message), /cap/i);
      assert.match(String(message), /null metrics/i);
    });

    it("is a REFUSAL, not a silent success — it never fails the request", async () => {
      installTradeFake(() => bookOf(CAP + 1));
      const result = await getPortfolioReturns(uid("over-cap-shape"));
      // The surface renders "—"; it does not error out.
      assert.equal(result.success, true);
    });
  });
});
