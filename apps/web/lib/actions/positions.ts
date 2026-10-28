"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import {
  getPositions as getPositionsService,
  getClosedTodayPositions as getClosedTodayService,
  type PositionItem,
  type PositionSummary,
  type PositionFilters,
  type ClosedTodayPosition,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";
import { demoPositions } from "@/lib/demo/data";
import { prisma } from "@/lib/prisma";
import { clearUserCache } from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { Prisma } from "@prisma/client";

// Re-export types for consumers
export type {
  PositionItem,
  PositionSummary,
  PositionFilters,
  ClosedTodayPosition,
} from "@usemoney/services";
// Backward compat alias
export type Position = PositionItem;

/**
 * Get open positions with caching
 */
export async function getPositionsAction(
  filters: PositionFilters = {}
): Promise<
  ActionResponse<{ positions: PositionItem[]; summary: PositionSummary }>
> {
  // Demo mode
  if (await isDemoSession()) {
    let filteredPositions = [...demoPositions] as unknown as PositionItem[];

    if (filters.symbol) {
      filteredPositions = filteredPositions.filter((p) =>
        p.symbol.toLowerCase().includes(filters.symbol!.toLowerCase())
      );
    }
    if (filters.broker && filters.broker !== "all") {
      filteredPositions = filteredPositions.filter(
        (p) => p.brokerName === filters.broker
      );
    }
    if (filters.segment && filters.segment !== "all") {
      filteredPositions = filteredPositions.filter(
        (p) => p.segment === filters.segment
      );
    }

    filteredPositions = filteredPositions.map((p) => {
      const priceChange = Math.random() * 0.04 - 0.01;
      const currentPrice = p.entryPrice * (1 + priceChange);
      const unrealizedPnL =
        p.positionType === "LONG"
          ? (currentPrice - p.entryPrice) * p.quantity
          : (p.entryPrice - currentPrice) * p.quantity;
      return { ...p, currentPrice, unrealizedPnL };
    });

    const totalInvested = filteredPositions.reduce(
      (sum, p) => sum + p.quantity * p.entryPrice,
      0
    );
    const totalUnrealizedPnL = filteredPositions.reduce(
      (sum, p) => sum + p.unrealizedPnL,
      0
    );

    return {
      success: true,
      data: {
        positions: filteredPositions,
        summary: {
          totalPositions: filteredPositions.length,
          totalInvested,
          unrealizedPnL: totalUnrealizedPnL,
          longPositions: filteredPositions.filter(
            (p) => p.positionType === "LONG"
          ).length,
          shortPositions: filteredPositions.filter(
            (p) => p.positionType === "SHORT"
          ).length,
        },
      },
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getPositionsService(authUser.userId, filters);
}

/**
 * Add a manual (off-broker) open position.
 * Creates a Position record directly in the DB so it shows up on the
 * Holdings > Positions tab. The position is tagged with no broker so it
 * displays as "Manual". Mirrors the pattern in addManualHoldingAction.
 */
export async function addManualPositionAction(data: {
  symbol: string;
  exchange: string;
  segment: string;
  productType: string;
  positionType: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  currentPrice?: number;
}): Promise<ActionResponse<{ positionId: string }>> {
  try {
    if (await isDemoSession()) {
      return {
        success: false,
        error: "Demo mode: Sign up to add positions!",
      };
    }

    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const { userId } = authUser;
    const price = data.currentPrice ?? data.entryPrice;
    const upperSymbol = data.symbol.toUpperCase();
    const netQty =
      data.positionType === "SHORT" ? -data.quantity : data.quantity;
    const buyQty = data.positionType === "LONG" ? data.quantity : 0;
    const sellQty = data.positionType === "SHORT" ? data.quantity : 0;
    const buyValue = buyQty * data.entryPrice;
    const sellValue = sellQty * data.entryPrice;
    const unrealizedPnl =
      data.positionType === "LONG"
        ? (price - data.entryPrice) * data.quantity
        : (data.entryPrice - price) * data.quantity;
    const pnlPct =
      data.entryPrice > 0
        ? (unrealizedPnl / (data.entryPrice * data.quantity)) * 100
        : 0;

    const posData: Prisma.PositionCreateInput = {
      user: { connect: { id: userId } },
      symbol: upperSymbol,
      exchange: data.exchange,
      segment: data.segment,
      productType: data.productType,
      positionType: data.productType === "MIS" ? "DAY" : "NET",
      buyQuantity: buyQty,
      sellQuantity: sellQty,
      netQuantity: netQty,
      buyPrice: data.positionType === "LONG" ? data.entryPrice : 0,
      sellPrice: data.positionType === "SHORT" ? data.entryPrice : 0,
      averagePrice: data.entryPrice,
      lastPrice: price,
      buyValue,
      sellValue,
      netValue: netQty * price,
      realizedPnl: 0,
      unrealizedPnl,
      totalPnl: unrealizedPnl,
      pnlPercentage: pnlPct,
      tradeDate: new Date(),
      segmentLabel: data.segment.includes("FO")
        ? "Futures & Options"
        : "Equity",
      productTypeLabel:
        data.productType === "MIS"
          ? "Intraday"
          : data.productType === "NRML"
            ? "Carry Forward"
            : "Cash & Carry",
    };

    const position = await prisma.position.create({ data: posData });

    await clearUserCache(userId, ["positions", "holdings", "dashboard"]);
    revalidatePath("/holdings");
    revalidatePath("/dashboard");

    return { success: true, data: { positionId: position.id } };
  } catch (error) {
    logger.error(
      { error, action: "addManualPositionAction" },
      "Add manual position error"
    );
    return {
      success: false,
      error: "Failed to add position. Please try again.",
    };
  }
}

/**
 * Get positions closed today (intraday squared-off positions)
 */
export async function getClosedTodayPositionsAction(): Promise<
  ActionResponse<ClosedTodayPosition[]>
> {
  if (await isDemoSession()) {
    return { success: true, data: [] };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getClosedTodayService(authUser.userId);
}
