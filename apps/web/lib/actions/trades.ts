"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@/lib/auth";
import { dbLogger as logger } from "@usemoney/logger";
import {
  TradeFormSchema,
  ClosePositionSchema,
  TradeFilterSchema,
  type ActionResponse,
  type TradeFilterInput,
} from "@usemoney/validation";
import {
  getTrades as getTradesService,
  getAvailableFYs as getAvailableFYsService,
  createTrade as createTradeService,
  updateTrade as updateTradeService,
  deleteTrade as deleteTradeService,
  closePosition as closePositionService,
  availableFinancialYears,
  type TradeItem,
  type TradeStats,
  type FinancialYearOption,
} from "@usemoney/services";
import { clearTradeCache, clearPositionCache } from "@usemoney/core";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";
import { isDemoSession } from "@/lib/demo/session";
import { demoTrades } from "@/lib/demo/data";

// Re-export types for consumers
export type {
  TradeItem,
  TradeStats,
  FinancialYearOption,
} from "@usemoney/services";
// Backward compat alias
export type Trade = TradeItem;

/**
 * Get trades with filtering and pagination
 */
export async function getTradesAction(
  filters: TradeFilterInput
): Promise<
  ActionResponse<{ trades: TradeItem[]; total: number; stats: TradeStats }>
> {
  try {
    const validatedFilters = TradeFilterSchema.parse(filters);

    // Demo mode
    if (await isDemoSession()) {
      let filteredTrades = [...demoTrades];

      if (validatedFilters.symbol) {
        filteredTrades = filteredTrades.filter((t) =>
          t.symbol
            .toLowerCase()
            .includes(validatedFilters.symbol!.toLowerCase())
        );
      }
      if (validatedFilters.broker && validatedFilters.broker !== "all") {
        filteredTrades = filteredTrades.filter(
          (t) => t.brokerName === validatedFilters.broker
        );
      }
      if (validatedFilters.segment && validatedFilters.segment !== "all") {
        filteredTrades = filteredTrades.filter(
          (t) => t.segment === validatedFilters.segment
        );
      }
      if (validatedFilters.tradeType && validatedFilters.tradeType !== "all") {
        filteredTrades = filteredTrades.filter(
          (t) => t.tradeType === validatedFilters.tradeType
        );
      }

      filteredTrades.sort(
        (a, b) =>
          new Date(b.tradeDate).getTime() - new Date(a.tradeDate).getTime()
      );

      const total = filteredTrades.length;
      const paginatedTrades = filteredTrades.slice(
        validatedFilters.skip,
        validatedFilters.skip + validatedFilters.limit
      );

      const closedTrades = filteredTrades.filter((t) => t.status === "CLOSED");
      const winners = closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
      const totalPnL = closedTrades.reduce(
        (sum, t) => sum + (t.realizedPnL || 0),
        0
      );

      return {
        success: true,
        data: {
          trades: paginatedTrades,
          total,
          stats: {
            totalPnL,
            winRate:
              closedTrades.length > 0
                ? Math.round((winners.length / closedTrades.length) * 100)
                : 0,
            winners: winners.length,
            losers: closedTrades.length - winners.length,
            // closedCount powers the client win-rate sub-line (MONEY-846); the
            // demo path builds stats inline, so mirror the service's field.
            closedCount: closedTrades.length,
            totalTrades: total,
            // MONEY-1257: derived from `filteredTrades` (the WHOLE filtered
            // set), never `paginatedTrades` — counting the page here would
            // reproduce the exact mismatch in demo mode, where it is most
            // visible because demo data is small and the numbers are easy to
            // check by eye.
            buyCount: filteredTrades.filter((t) => t.tradeType === "BUY")
              .length,
            sellCount: filteredTrades.filter((t) => t.tradeType === "SELL")
              .length,
          },
        },
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    return getTradesService(authUser.userId, validatedFilters);
  } catch (error: unknown) {
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to fetch trades"),
    };
  }
}

/**
 * Return the Indian financial years the user's trades span (newest first) to
 * populate the Tradebook FY dropdown (MONEY-847). Demo mode derives the list
 * from the static demo trades so the dropdown still renders in the walkthrough.
 */
export async function getAvailableFYsAction(): Promise<
  ActionResponse<{ fys: FinancialYearOption[] }>
> {
  try {
    if (await isDemoSession()) {
      const times = demoTrades
        .map((t) => new Date(t.tradeDate).getTime())
        .filter((n) => Number.isFinite(n));
      if (times.length === 0) {
        return { success: true, data: { fys: [] } };
      }
      return {
        success: true,
        data: {
          fys: availableFinancialYears(
            new Date(Math.min(...times)),
            new Date(Math.max(...times))
          ),
        },
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    return getAvailableFYsService(authUser.userId);
  } catch (error: unknown) {
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to load financial years"),
    };
  }
}

/**
 * Create a new trade
 */
export async function createTradeAction(
  formData: unknown
): Promise<ActionResponse<TradeItem>> {
  try {
    if (await isDemoSession()) {
      return {
        success: false,
        error: "Demo mode: Sign up for a free account to add trades!",
      };
    }

    const parseResult = TradeFormSchema.safeParse(formData);
    if (!parseResult.success) {
      const firstError =
        parseResult.error.errors[0]?.message || "Invalid trade data";
      return { success: false, error: firstError };
    }

    const validated = parseResult.data;
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const result = await createTradeService(authUser.userId, validated);

    if (result?.success) {
      // MONEY-866: bust the Redis/L1 data cache (trades + dashboard), not just
      // the Next ISR cache — otherwise the new trade is invisible until TTL.
      await clearTradeCache(authUser.userId);
      revalidatePath("/tradebook");
      revalidatePath("/positions");
      revalidatePath("/holdings");
      revalidatePath("/dashboard");
    }

    return result;
  } catch (error) {
    logger.error({ error, action: "createTradeAction" }, "Create trade error");
    return {
      success: false,
      error: "Failed to create trade. Please try again.",
    };
  }
}

/**
 * Update an existing trade
 */
export async function updateTradeAction(
  tradeId: string,
  formData: unknown
): Promise<ActionResponse<{ updated: number }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to modify trades!",
    };
  }

  const validated = TradeFormSchema.partial().parse(formData);
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await updateTradeService(authUser.userId, tradeId, validated);

  if (result?.success) {
    await clearTradeCache(authUser.userId);
    revalidatePath("/tradebook");
    revalidatePath("/positions");
    revalidatePath("/holdings");
  }

  return result;
}

/**
 * Delete a trade (only manual entries)
 */
export async function deleteTradeAction(
  tradeId: string
): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to delete trades!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await deleteTradeService(authUser.userId, tradeId);

  if (result?.success) {
    await clearTradeCache(authUser.userId);
    revalidatePath("/tradebook");
    revalidatePath("/positions");
    revalidatePath("/holdings");
  }

  return result;
}

/**
 * Close an open position
 */
export async function closePositionAction(
  positionId: string,
  exitPrice: number
): Promise<ActionResponse<{ pnl: number }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to close positions!",
    };
  }

  const validated = ClosePositionSchema.parse({ positionId, exitPrice });
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await closePositionService(authUser.userId, validated);

  if (result?.success) {
    // Closing a position writes a trade AND mutates positions → bust both.
    await clearTradeCache(authUser.userId);
    await clearPositionCache(authUser.userId);
    revalidatePath("/tradebook");
    revalidatePath("/positions");
    revalidatePath("/holdings");
    revalidatePath("/dashboard");
  }

  return result;
}
