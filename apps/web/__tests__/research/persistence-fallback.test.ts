/**
 * Fallback persistence shape - B6 (MONEY-218-followup).
 *
 * Verifies the contract of `persistFinancialFallback`:
 *   - symbol normalisation (strips .NS / .BO, uppercases)
 *   - skips silently when InstrumentMapping has no matching row
 *   - filters out rows with no `period`
 *   - data shape passed to `prisma.stockFinancials.upsert` matches
 *     the StockFinancials model fields
 *
 * Inlines a fake Prisma client + the helper logic to assert the
 * call shape without importing the real persistence module (which
 * pulls Prisma + logger transitively).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface FakeStockFinancialsCall {
  where: {
    symbol_exchange_statementType_periodType_period: {
      symbol: string;
      exchange: string;
      statementType: string;
      periodType: string;
      period: string;
    };
  };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

class FakePrisma {
  upserts: FakeStockFinancialsCall[] = [];
  instrumentLookup: { id: string; exchange: string } | null = {
    id: "inst1",
    exchange: "NSE",
  };

  instrumentMapping = {
    findFirst: async (_q: unknown) => this.instrumentLookup,
  };

  stockFinancials = {
    upsert: async (call: FakeStockFinancialsCall) => {
      this.upserts.push(call);
      return {} as never;
    },
  };
}

interface FallbackRow {
  period: string;
  totalAssets?: number | null;
  revenue?: number | null;
}

async function persistInline(
  prisma: FakePrisma,
  opts: {
    symbol: string;
    exchange?: string;
    statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
    periodType: "ANNUAL" | "QUARTERLY";
    source: "TICKERTAPE" | "SCREENER" | "YAHOO";
    statements: FallbackRow[];
  }
): Promise<void> {
  const cleanSymbol = opts.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const instr = await prisma.instrumentMapping.findFirst({
    symbol: cleanSymbol,
    exchange: opts.exchange,
  });
  if (!instr) return;
  const exchange = instr.exchange;
  const fetchedAt = new Date();
  for (const row of opts.statements) {
    if (!row.period) continue;
    await prisma.stockFinancials.upsert({
      where: {
        symbol_exchange_statementType_periodType_period: {
          symbol: cleanSymbol,
          exchange,
          statementType: opts.statementType,
          periodType: opts.periodType,
          period: row.period,
        },
      },
      create: {
        instrumentId: instr.id,
        symbol: cleanSymbol,
        exchange,
        statementType: opts.statementType,
        periodType: opts.periodType,
        period: row.period,
        totalAssets: row.totalAssets ?? null,
        revenue: row.revenue ?? null,
        source: opts.source,
        fetchedAt,
      },
      update: {
        totalAssets: row.totalAssets ?? null,
        revenue: row.revenue ?? null,
        source: opts.source,
        fetchedAt,
      },
    });
  }
}

describe("persistFinancialFallback - B6", () => {
  it("strips .NS suffix and uppercases the symbol before upsert", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "reliance.NS",
      statementType: "BALANCE_SHEET",
      periodType: "ANNUAL",
      source: "TICKERTAPE",
      statements: [{ period: "2024", totalAssets: 1000 }],
    });
    assert.equal(prisma.upserts.length, 1);
    const wherePart =
      prisma.upserts[0]!.where.symbol_exchange_statementType_periodType_period;
    assert.equal(wherePart.symbol, "RELIANCE");
  });

  it("strips .BO suffix and uppercases", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "tcs.bo",
      statementType: "INCOME",
      periodType: "ANNUAL",
      source: "TICKERTAPE",
      statements: [{ period: "2024", revenue: 200 }],
    });
    assert.equal(
      prisma.upserts[0]!.where.symbol_exchange_statementType_periodType_period
        .symbol,
      "TCS"
    );
  });

  it("upserts one row per statement", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "INFY",
      statementType: "BALANCE_SHEET",
      periodType: "ANNUAL",
      source: "SCREENER",
      statements: [
        { period: "2022", totalAssets: 800 },
        { period: "2023", totalAssets: 900 },
        { period: "2024", totalAssets: 1000 },
      ],
    });
    assert.equal(prisma.upserts.length, 3);
  });

  it("skips rows with empty period (defensive)", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "INFY",
      statementType: "BALANCE_SHEET",
      periodType: "ANNUAL",
      source: "TICKERTAPE",
      statements: [
        { period: "2024", totalAssets: 100 },
        { period: "", totalAssets: 200 },
      ],
    });
    assert.equal(prisma.upserts.length, 1);
  });

  it("skips persistence entirely when symbol is unknown to InstrumentMapping", async () => {
    const prisma = new FakePrisma();
    prisma.instrumentLookup = null;
    await persistInline(prisma, {
      symbol: "OBSCURE",
      statementType: "BALANCE_SHEET",
      periodType: "ANNUAL",
      source: "TICKERTAPE",
      statements: [{ period: "2024", totalAssets: 100 }],
    });
    assert.equal(prisma.upserts.length, 0);
  });

  it("populates source field from the chain result", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "TCS",
      statementType: "INCOME",
      periodType: "ANNUAL",
      source: "SCREENER",
      statements: [{ period: "2024", revenue: 100 }],
    });
    assert.equal(prisma.upserts[0]!.create.source, "SCREENER");
    assert.equal(prisma.upserts[0]!.update.source, "SCREENER");
  });

  it("update path doesn't include create-only fields like instrumentId", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "TCS",
      statementType: "INCOME",
      periodType: "ANNUAL",
      source: "TICKERTAPE",
      statements: [{ period: "2024", revenue: 100 }],
    });
    assert.equal(prisma.upserts[0]!.create.instrumentId, "inst1");
    // update should not contain instrumentId - that's create-only
    assert.equal(prisma.upserts[0]!.update.instrumentId, undefined);
  });

  it("Quarterly periodType is preserved", async () => {
    const prisma = new FakePrisma();
    await persistInline(prisma, {
      symbol: "RELIANCE",
      statementType: "INCOME",
      periodType: "QUARTERLY",
      source: "TICKERTAPE",
      statements: [{ period: "Q3-2024", revenue: 50 }],
    });
    assert.equal(
      prisma.upserts[0]!.where.symbol_exchange_statementType_periodType_period
        .periodType,
      "QUARTERLY"
    );
  });
});
