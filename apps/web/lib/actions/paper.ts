"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@/lib/auth";
import * as paperDb from "@/lib/db/paper";
import {
  getOrCreatePaperPortfolio,
  resetPortfolio,
} from "@/lib/db/paper-portfolio";
import { createPaperOrder, getPaperOrders } from "@/lib/db/paper-order";
import { PlaceOrderSchema, type ActionResponse } from "@usemoney/validation";
import { dbLogger as logger } from "@usemoney/logger";
import { isDemoSession } from "@/lib/demo/session";
import {
  demoPaperPositions,
  demoPaperSummary,
  demoPaperPerformance,
  demoPaperDashboardStats,
} from "@/lib/demo/data";

/**
 * Get all paper positions
 */
export async function getPaperPositionsAction(
  filters: { status?: string; assetType?: string } = {}
): Promise<
  ActionResponse<{
    positions: paperDb.PaperPosition[];
    summary: paperDb.PaperPortfolioSummary;
  }>
> {
  try {
    if (await isDemoSession()) {
      let filteredPositions = [...demoPaperPositions];

      if (filters.status) {
        filteredPositions = filteredPositions.filter(
          (p) => p.status === filters.status
        );
      }
      if (filters.assetType) {
        filteredPositions = filteredPositions.filter(
          (p) => p.assetType === filters.assetType
        );
      }

      return {
        success: true,
        data: { positions: filteredPositions, summary: demoPaperSummary },
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const result = await paperDb.getPaperPositions(authUser.userId, filters);
    return { success: true, data: result };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "getPaperPositionsAction error:",
      error
    );
    return { success: false, error: "Failed to fetch positions" };
  }
}

/**
 * Create a new paper position
 */
export async function createPaperPositionAction(
  data: paperDb.PaperPositionInput
): Promise<ActionResponse<paperDb.PaperPosition>> {
  try {
    if (await isDemoSession()) {
      return {
        success: false,
        error: "Demo mode: Sign up for a free account to create paper trades!",
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const position = await paperDb.createPaperPosition(authUser.userId, data);

    revalidatePath("/paper-trading");
    revalidatePath("/holdings");

    return {
      success: true,
      data: position,
      message: "Paper position created!",
    };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "createPaperPositionAction error:",
      error
    );
    return { success: false, error: "Failed to create position" };
  }
}

/**
 * Update paper position price
 */
export async function updatePaperPriceAction(
  positionId: string,
  currentPrice: number,
  currentNifty?: number
): Promise<ActionResponse<void>> {
  try {
    if (await isDemoSession()) {
      return { success: true }; // Acknowledge in demo mode
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const updated = await paperDb.updatePaperPositionPrice(
      authUser.userId,
      positionId,
      currentPrice,
      currentNifty
    );

    if (!updated) {
      return { success: false, error: "Position not found" };
    }

    revalidatePath("/paper-trading");
    revalidatePath("/holdings");

    return { success: true };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "updatePaperPriceAction error:",
      error
    );
    return { success: false, error: "Failed to update price" };
  }
}

/**
 * Close a paper position
 */
export async function closePaperPositionAction(
  positionId: string,
  exitPrice: number,
  currentNifty?: number
): Promise<ActionResponse<{ pnl: number }>> {
  try {
    if (await isDemoSession()) {
      return {
        success: false,
        error: "Demo mode: Sign up for a free account!",
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const result = await paperDb.closePaperPosition(
      authUser.userId,
      positionId,
      exitPrice,
      currentNifty
    );

    if (!result?.success) {
      return { success: false, error: "Position not found or already closed" };
    }

    revalidatePath("/paper-trading");
    revalidatePath("/holdings");

    return {
      success: true,
      data: { pnl: result.pnl },
      message: `Position closed! P&L: ₹${result.pnl.toLocaleString("en-IN")}`,
    };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "closePaperPositionAction error:",
      error
    );
    return { success: false, error: "Failed to close position" };
  }
}

/**
 * Delete a paper position
 */
export async function deletePaperPositionAction(
  positionId: string
): Promise<ActionResponse<void>> {
  try {
    if (await isDemoSession()) {
      return {
        success: false,
        error: "Demo mode: Sign up for a free account!",
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const deleted = await paperDb.deletePaperPosition(
      authUser.userId,
      positionId
    );

    if (!deleted) {
      return { success: false, error: "Position not found" };
    }

    revalidatePath("/paper-trading");
    revalidatePath("/holdings");

    return { success: true, message: "Position deleted!" };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "deletePaperPositionAction error:",
      error
    );
    return { success: false, error: "Failed to delete position" };
  }
}

/**
 * Get paper trading performance
 */
export async function getPaperPerformanceAction(): Promise<
  ActionResponse<{
    totalTrades: number;
    closedTrades: number;
    winners: number;
    losers: number;
    winRate: number;
    totalRealizedPnL: number;
    totalBenchmarkPnL: number;
    totalAlpha: number;
    bestTrade: { symbol: string; pnl: number } | null;
    worstTrade: { symbol: string; pnl: number } | null;
  }>
> {
  try {
    if (await isDemoSession()) {
      return { success: true, data: demoPaperPerformance };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const performance = await paperDb.getPaperPerformance(authUser.userId);
    return { success: true, data: performance };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "getPaperPerformanceAction error:",
      error
    );
    return { success: false, error: "Failed to fetch performance" };
  }
}

/**
 * Get or create paper portfolio
 */
export async function getOrCreatePortfolioAction(): Promise<
  ActionResponse<{ id: string; initialCapital: number; cash: number }>
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const portfolio = await getOrCreatePaperPortfolio(authUser.userId);
    return {
      success: true,
      data: {
        id: portfolio.id,
        initialCapital: portfolio.initialCapital,
        cash: portfolio.cash,
      },
    };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "getOrCreatePortfolioAction error"
    );
    return { success: false, error: "Failed to get portfolio" };
  }
}

/**
 * Place a paper order (main order action)
 */
export async function placeOrderAction(
  input: unknown
): Promise<ActionResponse<{ orderId: string; executedPrice: number }>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    // Validate input
    const parsed = PlaceOrderSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.errors[0]?.message || "Invalid input",
      };
    }
    const data = parsed.data;

    // Get or create portfolio
    const portfolio = await getOrCreatePaperPortfolio(authUser.userId);

    // For MARKET orders, use the provided price as executed price
    const executedPrice = data.price || 0;
    if (executedPrice <= 0) {
      return { success: false, error: "Price is required for order execution" };
    }

    const totalCost = executedPrice * data.quantity;

    // Validate sufficient cash for BUY orders
    if (data.side === "BUY" && totalCost > portfolio.cash) {
      return {
        success: false,
        error: `Insufficient cash. Available: ₹${portfolio.cash.toLocaleString("en-IN")}, Required: ₹${totalCost.toLocaleString("en-IN")}`,
      };
    }

    // Create order record
    const order = await createPaperOrder(authUser.userId, portfolio.id, {
      symbol: data.symbol,
      name: data.name,
      exchange: data.exchange,
      instrumentType: data.instrumentType,
      side: data.side,
      orderType: data.orderType,
      quantity: data.quantity,
      price: data.price,
      executedPrice,
      stopLoss: data.stopLoss,
      target: data.target,
      strategy: data.strategy,
      optionType: data.optionType,
      strikePrice: data.strikePrice,
      expiry: data.expiry,
      lotSize: data.lotSize,
    });

    // Update or average position
    await paperDb.updateOrAveragePosition(authUser.userId, portfolio.id, {
      symbol: data.symbol,
      name: data.name,
      exchange: data.exchange,
      instrumentType: data.instrumentType,
      side: data.side,
      quantity: data.quantity,
      price: executedPrice,
      stopLoss: data.stopLoss,
      target: data.target,
      strategy: data.strategy,
      optionType: data.optionType,
      strikePrice: data.strikePrice,
      expiry: data.expiry,
      lotSize: data.lotSize,
    });

    // Update cash: BUY reduces cash, SELL adds cash
    const cashChange = data.side === "BUY" ? -totalCost : totalCost;
    await getOrCreatePaperPortfolio(authUser.userId); // ensure exists
    const { updatePortfolioCash } = await import("@/lib/db/paper-portfolio");
    await updatePortfolioCash(portfolio.id, cashChange);

    revalidatePath("/paper-trading");

    return {
      success: true,
      data: { orderId: order.id, executedPrice },
      message: `${data.side} order executed for ${data.symbol} at ₹${executedPrice.toLocaleString("en-IN")}`,
    };
  } catch (error) {
    logger.error({ error, action: "paperAction" }, "placeOrderAction error");
    return { success: false, error: "Failed to place order" };
  }
}

/**
 * Get recent orders
 */
export async function getOrdersAction(
  limit?: number
): Promise<ActionResponse<Array<Record<string, unknown>>>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const orders = await getPaperOrders(authUser.userId, {
      limit: limit || 50,
    });
    return {
      success: true,
      data: orders as unknown as Array<Record<string, unknown>>,
    };
  } catch (error) {
    logger.error({ error, action: "paperAction" }, "getOrdersAction error");
    return { success: false, error: "Failed to fetch orders" };
  }
}

/**
 * Get paper dashboard stats (portfolio + positions + performance)
 */
export async function getPaperDashboardStatsAction(): Promise<
  ActionResponse<{
    portfolio: { id: string; initialCapital: number; cash: number };
    positions: {
      open: number;
      closed: number;
      totalInvested: number;
      totalCurrentValue: number;
      totalPnl: number;
      totalPnlPercentage: number;
      dayPnl: number;
    };
    performance: {
      winRate: number;
      totalTrades: number;
      winners: number;
      losers: number;
      avgWin: number;
      avgLoss: number;
      bestTrade: number;
      worstTrade: number;
    };
  }>
> {
  try {
    if (await isDemoSession()) {
      return { success: true, data: demoPaperDashboardStats };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const portfolio = await getOrCreatePaperPortfolio(authUser.userId);
    const stats = await paperDb.getPaperDashboardStats(authUser.userId);

    return {
      success: true,
      data: {
        portfolio: {
          id: portfolio.id,
          initialCapital: portfolio.initialCapital,
          cash: portfolio.cash,
        },
        ...stats,
      },
    };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "getPaperDashboardStatsAction error"
    );
    return { success: false, error: "Failed to fetch dashboard stats" };
  }
}

/**
 * Reset paper portfolio
 */
export async function resetPortfolioAction(): Promise<ActionResponse<void>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    await resetPortfolio(authUser.userId);

    revalidatePath("/paper-trading");
    return { success: true, message: "Portfolio reset to initial state" };
  } catch (error) {
    logger.error(
      { error, action: "paperAction" },
      "resetPortfolioAction error"
    );
    return { success: false, error: "Failed to reset portfolio" };
  }
}
