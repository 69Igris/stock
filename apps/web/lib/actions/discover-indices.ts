"use server";

/**
 * Index & ETF Discovery Server Actions
 *
 * getIndicesAction is a thin wrapper over @usemoney/services.
 * getInstrumentsBySymbolsAction and getETFsAction have no service counterpart
 * yet, so they retain direct DB queries.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { getIndices as getIndicesService } from "@usemoney/services";
import {
  FUND_INSTRUMENT_TYPES,
  INDIA_DISCOVER_EXCHANGES,
} from "@usemoney/core/market-data/instruments/types";

// ============== TYPES ==============

export interface IndexData {
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  price: number;
  change: number;
  changePercent: number;
}

export interface ETFData {
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  aum: number | null;
}

// ============== ACTIONS ==============

/**
 * Get instruments (ETF or INDEX) by symbols or yahooSymbols with live prices.
 * Used to enrich search results with full data.
 * NOTE: No service counterpart yet - retains direct DB queries.
 */
export async function getInstrumentsBySymbolsAction(
  symbols: string[],
  instrumentType: "ETF" | "INDEX",
  yahooSymbols?: string[]
): Promise<{
  success: boolean;
  data?: (ETFData | IndexData)[];
  error?: string;
}> {
  if ((!symbols.length && !yahooSymbols?.length) || symbols.length > 50) {
    return { success: true, data: [] };
  }

  try {
    const orConditions: Record<string, unknown>[] = [];
    if (symbols.length > 0) {
      orConditions.push({ symbol: { in: symbols } });
    }
    if (yahooSymbols && yahooSymbols.length > 0) {
      orConditions.push({ yahooSymbol: { in: yahooSymbols } });
    }

    const instruments = await prisma.instrumentMapping.findMany({
      where: {
        OR: orConditions,
        isActive: true,
        instrumentType,
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
      },
    });

    const instIds = instruments.map((i) => i.id);
    const quotes = await prisma.latestQuote.findMany({
      where: {
        instrumentId: { in: instIds },
        previousClose: { gt: 0 },
      },
    });
    const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

    const results = instruments
      .filter((inst) => quoteMap.has(inst.id))
      .map((inst) => {
        const q = quoteMap.get(inst.id)!;
        return {
          symbol: inst.symbol,
          name: inst.name,
          exchange: inst.exchange,
          yahooSymbol: inst.yahooSymbol,
          price: q.price,
          change: q.change ?? 0,
          changePercent: q.changePercent ?? 0,
          ...(instrumentType === "ETF"
            ? {
                volume: q.volume ?? null,
                returns1Y: null,
                returns3Y: null,
                returns5Y: null,
                aum: null,
              }
            : {}),
        };
      });

    return { success: true, data: results };
  } catch (error) {
    console.error(`Failed to fetch ${instrumentType}s by symbols:`, error);
    return { success: false, error: `Failed to load ${instrumentType} data` };
  }
}

/**
 * Get major indices with live prices.
 * Thin wrapper over @usemoney/services.
 */
export async function getIndicesAction(): Promise<{
  success: boolean;
  data?: IndexData[];
  error?: string;
}> {
  return getIndicesService();
}

/**
 * Get ETFs with live prices.
 * NOTE: No service counterpart yet - retains direct DB queries.
 */
export async function getETFsAction(options?: {
  limit?: number;
  sortBy?: "symbol" | "changePercent" | "volume";
}): Promise<{
  success: boolean;
  data?: ETFData[];
  error?: string;
}> {
  const { limit = 30, sortBy = "symbol" } = options ?? {};

  try {
    const filters = { limit, sortBy };
    const cached = await getCached<ETFData[]>(
      "discover",
      "_global",
      "etfs",
      filters
    );
    if (cached) {
      return { success: true, data: cached };
    }

    const instruments = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        // MONEY-1085 follow-up: include the exchange-traded trusts.
        // MONEY-1263 — scope to Indian venues. MONEY-980 moved US securities
        // out to `us_instruments`, so the "~7,600 US ETFs flood this page"
        // reason this clause shipped with no longer applies. The clause STAYS:
        // it is independently correct (SUPPORTED_EXCHANGES also admits
        // NFO/BFO/MCX, which do not belong on an equity discover surface) and
        // it is a standing guard against this table being shared again. See
        // INDIA_DISCOVER_EXCHANGES for the full reasoning.
        // Scoped by EXCHANGE, not `market`: that attribute is ABSENT on every
        // pre-existing India row, so `{market: "IN"}` matches ZERO.
        exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
        instrumentType: { in: [...FUND_INSTRUMENT_TYPES] },
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
        isin: true,
      },
      orderBy: sortBy === "symbol" ? { symbol: "asc" } : undefined,
    });

    const etfIds = instruments.map((i) => i.id);
    const quotes = await prisma.latestQuote.findMany({
      where: {
        instrumentId: { in: etfIds },
        previousClose: { gt: 0 },
      },
    });
    const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

    const isins = instruments.map((i) => i.isin).filter(Boolean) as string[];
    const isinSet = new Set(isins);
    const mfData =
      isins.length > 0
        ? (
            await prisma.mutualFundMaster.findMany({
              select: {
                isinGrowth: true,
                isinDividend: true,
                returns1Y: true,
                returns3Y: true,
                returns5Y: true,
                aum: true,
              },
            })
          ).filter(
            (mf) =>
              (mf.isinGrowth && isinSet.has(mf.isinGrowth)) ||
              (mf.isinDividend && isinSet.has(mf.isinDividend))
          )
        : [];
    const returnsMap = new Map<
      string,
      {
        returns1Y: number | null;
        returns3Y: number | null;
        returns5Y: number | null;
        aum: number | null;
      }
    >();
    for (const mf of mfData) {
      const data = {
        returns1Y: mf.returns1Y,
        returns3Y: mf.returns3Y,
        returns5Y: mf.returns5Y,
        aum: mf.aum,
      };
      if (mf.isinGrowth) returnsMap.set(mf.isinGrowth, data);
      if (mf.isinDividend) returnsMap.set(mf.isinDividend, data);
    }

    let etfs: ETFData[] = instruments
      .filter((inst) => quoteMap.has(inst.id))
      .map((inst) => {
        const q = quoteMap.get(inst.id)!;
        const returns = inst.isin ? returnsMap.get(inst.isin) : undefined;
        return {
          symbol: inst.symbol,
          name: inst.name,
          exchange: inst.exchange,
          yahooSymbol: inst.yahooSymbol,
          price: q.price,
          change: q.change ?? 0,
          changePercent: q.changePercent ?? 0,
          volume: q.volume,
          returns1Y: returns?.returns1Y ?? null,
          returns3Y: returns?.returns3Y ?? null,
          returns5Y: returns?.returns5Y ?? null,
          aum: returns?.aum ?? null,
        };
      });

    if (sortBy === "changePercent") {
      etfs.sort(
        (a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)
      );
    } else if (sortBy === "volume") {
      etfs.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
    }

    await setCached("discover", "_global", "etfs", etfs, filters);

    return { success: true, data: etfs };
  } catch (error) {
    console.error("Failed to fetch ETFs:", error);
    return { success: false, error: "Failed to load ETFs" };
  }
}
