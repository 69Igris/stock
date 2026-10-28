/**
 * Paper Trading Service
 *
 * Handles paper (virtual) trading positions: create, close, delete, and price updates.
 * Source: apps/web/lib/actions/paper-trading.ts + apps/web/lib/db/paper.ts
 *
 * All paper P&L / portfolio math is delegated to the pure, finite-guarded
 * helpers in ./paper-logic so a corrupt sync row, or a non-finite value that
 * slips past a missing Zod gate (apps/api POST /v1/paper passes raw JSON), can
 * never poison the paper portfolio total ("₹NaN"), persist NaN/Infinity into a
 * Prisma Float, or throw RangeError on an Invalid-Date `.toISOString()`.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  finite,
  safeToIso,
  safeDate,
  currentValue as calcCurrentValue,
  markToMarket,
  realizedPnL as calcRealizedPnL,
  normalizeCreateValues,
  summarizePaperPortfolio,
} from "./paper-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface PaperTrade {
  id: string;
  symbol: string;
  assetType: string;
  segment: string;
  exchange: string;
  positionType: string;
  quantity: number;
  lotSize?: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  strikePrice?: number;
  optionType?: string;
  expiryDate?: string;
  status: string;
  exitPrice?: number;
  exitDate?: string;
  realizedPnL?: number;
  notes?: string;
  tags: string[];
  entryDate: string;
}

export interface PaperPortfolioSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: number;
  openPositions: number;
  closedPositions: number;
}

export interface PaperPortfolio {
  positions: PaperTrade[];
  summary: PaperPortfolioSummary;
}

export interface CreatePaperTradeInput {
  symbol: string;
  assetType?: string;
  segment?: string;
  exchange?: string;
  positionType?: string;
  quantity: number;
  lotSize?: number;
  averagePrice: number;
  investedValue: number;
  currentPrice?: number;
  currentValue?: number;
  unrealizedPnL?: number;
  pnlPercentage?: number;
  strikePrice?: number;
  optionType?: string;
  expiryDate?: string;
  notes?: string;
  tags?: string[];
  entryDate?: string;
}

export interface PaperPriceUpdate {
  positionId: string;
  currentPrice: number;
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get all paper positions + portfolio summary
 */
export async function getPaperPortfolio(
  userId: string,
): Promise<ServiceResult<PaperPortfolio>> {
  try {
    const positions = await prisma.paperPosition.findMany({
      where: { userId },
      orderBy: { entryDate: "desc" },
    });

    // Finite-guarded, OPEN-only portfolio totals (one corrupt row can no longer
    // poison the sum into NaN/Infinity; pnlPercentage never leaks Infinity).
    const summary = summarizePaperPortfolio(positions);

    const data: PaperPortfolio = {
      positions: positions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        assetType: p.assetType,
        segment: p.segment,
        exchange: p.exchange,
        positionType: p.positionType,
        quantity: finite(p.quantity),
        lotSize: p.lotSize || undefined,
        averagePrice: finite(p.averagePrice),
        investedValue: finite(p.investedValue),
        currentPrice: finite(p.currentPrice),
        currentValue: finite(p.currentValue),
        unrealizedPnL: finite(p.unrealizedPnL),
        pnlPercentage: finite(p.pnlPercentage),
        strikePrice: p.strikePrice || undefined,
        optionType: p.optionType || undefined,
        // safeToIso → undefined (never throws) for a corrupt/Invalid Date.
        expiryDate: safeToIso(p.expiryDate),
        status: p.status,
        exitPrice: p.exitPrice || undefined,
        exitDate: safeToIso(p.exitDate),
        realizedPnL: p.realizedPnL == null ? undefined : finite(p.realizedPnL),
        notes: p.notes || undefined,
        tags: p.tags,
        // entryDate is required; an Invalid stored date degrades to "now"
        // rather than throwing RangeError and 500-ing the whole portfolio.
        entryDate: safeToIso(p.entryDate) ?? new Date().toISOString(),
      })),
      summary,
    };

    return { success: true, data };
  } catch (error) {
    logger.error({ error, userId }, "Paper portfolio service error");
    return { success: false, error: "Failed to fetch paper portfolio" };
  }
}

/**
 * Create a new paper position
 */
export async function createPaperTrade(
  userId: string,
  trade: CreatePaperTradeInput,
): Promise<ServiceResult<PaperTrade>> {
  try {
    // Finite-guard every persisted numeric so a non-finite value reaching this
    // path WITHOUT the web Zod gate (apps/api POST /v1/paper passes raw JSON)
    // can never write NaN/Infinity into a Prisma Float and corrupt the row for
    // every future read. Behaviour-preserving for finite inputs (same defaults).
    const values = normalizeCreateValues(trade);
    // safeDate → undefined (never an Invalid Date) for a garbage date string;
    // entryDate falls back to "now" (matching the original `: new Date()`).
    const expiryDate = trade.expiryDate
      ? safeDate(trade.expiryDate)
      : undefined;
    const entryDate = trade.entryDate
      ? (safeDate(trade.entryDate) ?? new Date())
      : new Date();

    const position = await prisma.paperPosition.create({
      data: {
        userId,
        symbol: trade.symbol,
        assetType: trade.assetType || "STOCK",
        segment: trade.segment || "EQUITY",
        exchange: trade.exchange || "NSE",
        positionType: trade.positionType || "LONG",
        quantity: values.quantity,
        lotSize: trade.lotSize,
        averagePrice: values.averagePrice,
        investedValue: values.investedValue,
        currentPrice: values.currentPrice,
        currentValue: values.currentValue,
        unrealizedPnL: values.unrealizedPnL,
        pnlPercentage: values.pnlPercentage,
        strikePrice: trade.strikePrice,
        optionType: trade.optionType,
        expiryDate,
        status: "OPEN",
        notes: trade.notes,
        tags: trade.tags || [],
        entryDate,
      },
    });

    return {
      success: true,
      data: {
        id: position.id,
        symbol: position.symbol,
        assetType: position.assetType,
        segment: position.segment,
        exchange: position.exchange,
        positionType: position.positionType,
        quantity: finite(position.quantity),
        lotSize: position.lotSize || undefined,
        averagePrice: finite(position.averagePrice),
        investedValue: finite(position.investedValue),
        currentPrice: finite(position.currentPrice),
        currentValue: finite(position.currentValue),
        unrealizedPnL: finite(position.unrealizedPnL),
        pnlPercentage: finite(position.pnlPercentage),
        status: position.status,
        notes: position.notes || undefined,
        tags: position.tags,
        // Guarded write means this is always a valid Date; keep the safe read.
        entryDate: safeToIso(position.entryDate) ?? new Date().toISOString(),
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Create paper trade service error");
    return {
      success: false,
      error: "Failed to create paper trade",
      code: "INTERNAL",
    };
  }
}

/**
 * Close a paper position with P&L calculation
 */
export async function closePaperTrade(
  userId: string,
  positionId: string,
  exitPrice: number,
): Promise<ServiceResult<{ pnl: number }>> {
  try {
    // Reject a non-finite / non-positive exitPrice UP FRONT instead of coercing
    // it (the old `finite(exitPrice)` turned NaN/Infinity/undefined → 0, which
    // then PERSISTED the position CLOSED at ₹0 with a full fake loss and no way
    // to reopen). A real exit price is always a positive finite number; every web
    // caller is typed `exitPrice: number` (paper-trading.ts) and the API route
    // now zod-gates it, so this rejects only a raw/adversarial non-route caller.
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
      return {
        success: false,
        error: "Exit price must be a positive number",
        code: "INVALID_INPUT",
      };
    }

    // SECURITY (A01 IDOR): the read is scoped to the caller; status OPEN so an
    // already-closed position is rejected (not silently re-closed).
    const position = await prisma.paperPosition.findFirst({
      where: { id: positionId, userId, status: "OPEN" },
    });

    if (!position) {
      return {
        success: false,
        error: "Position not found or already closed",
        code: "NOT_FOUND",
      };
    }

    // Finite-guarded realized P&L: a corrupt exitPrice/averagePrice/quantity
    // (a non-web caller reading body.exitPrice raw, a poisoned row) can never
    // return NaN/Infinity — which would otherwise PERSIST as realizedPnL AND
    // hit `pnl.toLocaleString("en-IN")` ("₹NaN") in the web success toast.
    const exit = finite(exitPrice);
    const pnl = calcRealizedPnL(
      position.positionType,
      exit,
      position.averagePrice,
      position.quantity,
    );

    // SECURITY (A01 IDOR): scope the WRITE to { id, userId } too (defence in
    // depth — never update by bare id even after a scoped read).
    await prisma.paperPosition.updateMany({
      where: { id: positionId, userId },
      data: {
        status: "CLOSED",
        exitPrice: exit,
        exitDate: new Date(),
        realizedPnL: pnl,
        currentPrice: exit,
        currentValue: calcCurrentValue(exit, position.quantity),
        unrealizedPnL: 0,
      },
    });

    return { success: true, data: { pnl } };
  } catch (error) {
    logger.error(
      { error, userId, positionId },
      "Close paper trade service error",
    );
    return {
      success: false,
      error: "Failed to close paper trade",
      code: "INTERNAL",
    };
  }
}

/**
 * Delete a paper position
 */
export async function deletePaperTrade(
  userId: string,
  positionId: string,
): Promise<ServiceResult<void>> {
  try {
    // SECURITY (MONEY-594, A01 IDOR): scope the delete to the owning user.
    // Deleting by `id` alone let any authenticated caller remove another
    // user's paper position. `deleteMany` with the `userId` predicate matches
    // ZERO rows for a foreign id, and we surface count === 0 as not-found so a
    // cross-user delete is rejected rather than silently succeeding.
    const result = await prisma.paperPosition.deleteMany({
      where: { id: positionId, userId },
    });

    if (result.count === 0) {
      return { success: false, error: "Position not found", code: "NOT_FOUND" };
    }

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, positionId },
      "Delete paper trade service error",
    );
    return {
      success: false,
      error: "Failed to delete paper trade",
      code: "INTERNAL",
    };
  }
}

/**
 * Batch update current prices for open paper positions
 */
export async function updatePaperPrices(
  userId: string,
  updates: PaperPriceUpdate[],
): Promise<ServiceResult<void>> {
  try {
    if (updates.length === 0) return { success: true, data: undefined };

    // MONEY-710 — ONE read for every position, not one per update.
    //
    // This was a sequential `findFirst` + `updateMany` per update inside a
    // `for` loop: 2N round trips, serialised. It runs on every paper-trading
    // price refresh, so N is the size of the user's open book and the cost is
    // paid on a timer.
    //
    // The read stays scoped to `{ userId, status: "OPEN" }`, so the `in` list
    // cannot be used to read another user's positions or reopen a closed one —
    // an id the caller does not own simply does not come back.
    const ids = updates.map((u) => u.positionId);
    const positions = await prisma.paperPosition.findMany({
      where: { id: { in: ids }, userId, status: "OPEN" },
    });
    const byId = new Map(positions.map((p) => [p.id, p]));

    // Compute every write first; the maths is pure, so nothing here can fail
    // halfway and leave the loop half-applied.
    const writes = updates.flatMap((update) => {
      const position = byId.get(update.positionId);
      if (!position) return [];

      // Finite-guarded MTM bundle: a non-finite currentPrice (raw caller) or a
      // corrupt stored investedValue can never persist NaN/Infinity, and the
      // pnlPercentage never leaks Infinity (the old `investedValue > 0` gate
      // passed for Infinity).
      const mtm = markToMarket(
        position.positionType,
        update.currentPrice,
        position.quantity,
        position.investedValue,
      );

      return [
        {
          id: update.positionId,
          data: {
            currentPrice: finite(update.currentPrice),
            currentValue: mtm.currentValue,
            unrealizedPnL: mtm.unrealizedPnL,
            pnlPercentage: mtm.pnlPercentage,
          },
        },
      ];
    });

    // Each row gets DIFFERENT values, so this cannot collapse into a single
    // `updateMany` — Prisma/Mongo has no per-row bulk update. Issuing them
    // concurrently (bounded by chunk) is the win: N round trips in parallel
    // instead of 2N in series.
    //
    // SECURITY (A01 IDOR): each WRITE stays scoped to `{ id, userId }` —
    // defence in depth, never update by bare id even after a scoped read. That
    // property is why this is `updateMany` per row rather than `update`.
    const WRITE_CHUNK = 25;
    for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
      await Promise.all(
        writes.slice(i, i + WRITE_CHUNK).map((w) =>
          prisma.paperPosition.updateMany({
            where: { id: w.id, userId },
            data: w.data,
          }),
        ),
      );
    }

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId }, "Update paper prices service error");
    return { success: false, error: "Failed to update prices" };
  }
}
