"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import {
  getPaperPortfolio as getPaperPortfolioService,
  createPaperTrade as createPaperTradeService,
  closePaperTrade as closePaperTradeService,
  deletePaperTrade as deletePaperTradeService,
  updatePaperPrices as updatePaperPricesService,
} from "@usemoney/services";
import type {
  CreatePaperTradeInput,
  PaperPriceUpdate,
} from "@usemoney/services";

// Re-export types for consumers
export type {
  PaperTrade,
  PaperPortfolio,
  PaperPortfolioSummary,
  CreatePaperTradeInput,
  PaperPriceUpdate,
} from "@usemoney/services";

/**
 * Get all paper trading positions
 */
export async function getPaperPortfolioAction(): Promise<{
  success: boolean;
  data?: import("@usemoney/services").PaperPortfolio;
  error?: string;
}> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return getPaperPortfolioService(authUser.userId);
}

/**
 * Create a new paper trade
 */
export async function createPaperTradeAction(
  trade: CreatePaperTradeInput
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").PaperTrade;
  error?: string;
}> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return createPaperTradeService(authUser.userId, trade);
}

/**
 * Close a paper trade
 */
export async function closePaperTradeAction(
  positionId: string,
  exitPrice: number
): Promise<{ success: boolean; data?: { pnl: number }; error?: string }> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return closePaperTradeService(authUser.userId, positionId, exitPrice);
}

/**
 * Delete a paper trade
 */
export async function deletePaperTradeAction(
  positionId: string
): Promise<{ success: boolean; error?: string }> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return deletePaperTradeService(authUser.userId, positionId);
}

/**
 * Update paper trade prices (for syncing current prices)
 */
export async function updatePaperPricesAction(
  updates: PaperPriceUpdate[]
): Promise<{ success: boolean; error?: string }> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return updatePaperPricesService(authUser.userId, updates);
}
