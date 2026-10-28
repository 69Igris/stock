"use server";

/**
 * Discover Page Server Actions
 *
 * Thin wrappers over @usemoney/services discover functions.
 * All stocks are pre-loaded so the client can filter by sector, sort, etc.
 * without extra round-trips.
 */

import {
  getDiscoverData as getDiscoverDataService,
  getStocksBySector as getStocksBySectorService,
  richSearchInstruments as richSearchInstrumentsService,
} from "@usemoney/services";

// Re-export types for consumers
export type {
  DiscoverStock,
  DiscoverData,
  RichSearchResult,
  RichSearchStockResult,
  RichSearchMfResult,
} from "@usemoney/services";

// ============== ACTIONS ==============

export async function getDiscoverDataAction(): Promise<{
  success: boolean;
  data?: import("@usemoney/services").DiscoverData;
  error?: string;
}> {
  return getDiscoverDataService();
}

export async function getStocksBySectorAction(
  sector: string,
  options: {
    limit?: number;
    sortBy?: "name" | "changePercent" | "marketCap";
  } = {}
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").DiscoverStock[];
  error?: string;
}> {
  return getStocksBySectorService(sector, options);
}

/**
 * Rich instrument search for the chat composer popover (MONEY-219 step 3).
 * Returns sector + market cap + price for stocks/ETFs and category + AUM
 * + 1Y returns + risk for MFs. Used by InstrumentsView so the picker no
 * longer renders mock data.
 */
export async function richSearchInstrumentsAction(opts: {
  query: string;
  kind: "stocks" | "mfs" | "etfs";
  limit?: number;
}): Promise<{
  success: boolean;
  data?: import("@usemoney/services").RichSearchResult;
  error?: string;
}> {
  return richSearchInstrumentsService(opts);
}
