/**
 * Trade Pairing Processor
 *
 * Processes trades using FIFO algorithm and creates PairedTradeView entries.
 * Mirrors the logic from apps/web/lib/pairing/service.ts but uses
 * @usemoney/database directly since workers run in a separate runtime.
 */

import type { PairingJobMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import { pairTradesFIFO } from "@usemoney/core/pairing";
import { clearTradeCache } from "@usemoney/core";
import crypto from "crypto";
import { createNotification } from "../lib/notifications";
import {
  derivePairingPrice,
  deriveEffectiveIsin,
  corpActionFilterFromTrades,
  toCorporateActionInput,
} from "./pairing-logic";

export async function processPairing(data: PairingJobMessage): Promise<void> {
  const { jobId, userId, batchId: inputBatchId } = data;
  const batchId = inputBatchId || crypto.randomUUID();

  console.log(
    `Processing pairing job ${jobId} for user ${userId}${inputBatchId ? ` (batch: ${inputBatchId})` : ""}`
  );

  // Update job status to PROCESSING
  await prisma.backgroundJob.updateMany({
    where: { jobId },
    data: { status: "PROCESSING", startedAt: new Date() },
  });

  try {
    // 1. Fetch ALL the user's trades. MONEY-839: pairing is worker-only now and
    // does a FULL re-pair (matching the web's old forceRepair:true) — FIFO needs
    // the COMPLETE per-symbol history so a newly-synced sell pairs against older
    // buys. A needsRepairing-only batch would mis-pair incrementally (and drop
    // existing paired views for the symbol).
    const where: Record<string, unknown> = { userId };

    const trades = await prisma.trade.findMany({
      where,
      orderBy: [{ tradeDate: "asc" }, { tradeTime: "asc" }],
    });

    if (trades.length === 0) {
      console.log(`Pairing job ${jobId}: no trades need pairing`);
      await prisma.backgroundJob.updateMany({
        where: { jobId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          progress: 100,
          result: {
            success: true,
            tradesProcessed: 0,
            openPositions: 0,
            closedPositions: 0,
          },
        },
      });
      return;
    }

    // 2. Convert trades to pairing algorithm input format.
    // Price + ISIN derivation are the same pure transforms the web service
    // performs; they live in `pairing-logic.ts` so the production path and the
    // unit tests run the SAME code (no shadow). `derivePairingPrice` also
    // guarantees a finite price (NaN/Infinity stored price or tradeValue/qty
    // ratio is treated as missing) so a non-finite value never poisons
    // realizedPnL/totalRealizedPnL. The core `pairTradesFIFO` additionally
    // filters non-finite quantities and resolves Invalid Dates to the epoch
    // sentinel, keeping the FIFO comparator deterministic.
    const tradeInputs = trades.map((t) => ({
      id: t.id,
      userId: t.userId,
      symbol: t.symbol,
      isin: deriveEffectiveIsin(t),
      exchange: t.exchange,
      segment: t.segment,
      broker: t.broker,
      brokerUserId: t.brokerUserId,
      tradeType: t.tradeType,
      positionType: t.positionType,
      productType: t.productType,
      quantity: t.quantity,
      price: derivePairingPrice(t),
      tradeDate: t.tradeDate,
      tradeTime: t.tradeTime,
      sourceType: t.sourceType,
      segmentLabel: null,
      productTypeLabel: null,
    }));

    // 2b. MONEY-840: fetch the corporate actions (SPLIT/BONUS/…) relevant to
    // this trade set and feed them to the FIFO engine for cost-basis
    // adjustment. Filter by the SAME symbols + effective ISINs the trades use
    // (corpActionFilterFromTrades reuses deriveEffectiveIsin), so a 1:5 split
    // restates the pre-split BUY lots into post-split units and a post-split
    // SELL pairs at the right cost basis (and open lots reconcile vs Holdings).
    // Best-effort: a corp-action fetch failure must not block pairing — pairing
    // then simply runs unadjusted, exactly as before this feature.
    const { symbols: caSymbols, isins: caIsins } =
      corpActionFilterFromTrades(trades);
    let corporateActions: ReturnType<typeof toCorporateActionInput>[] = [];
    try {
      const caRows = await prisma.corporateAction.findMany({
        where: {
          OR: [
            { symbol: { in: caSymbols } },
            ...(caIsins.length > 0 ? [{ isin: { in: caIsins } }] : []),
          ],
        },
      });
      corporateActions = caRows.map(toCorporateActionInput);
    } catch (caErr) {
      console.warn(
        `Pairing job ${jobId}: corporate-action fetch failed, pairing without cost-basis adjustment:`,
        caErr
      );
    }

    // 3. Run the FIFO pairing algorithm (with corporate-action cost-basis adj.)
    const result = pairTradesFIFO(tradeInputs, corporateActions);

    // 4. Get unique symbols and ISINs to clear old views. Reuse the same
    // `deriveEffectiveIsin` so the delete-set ISINs match the pairing-input
    // ISINs exactly (an MF holding renamed mid-history nets off correctly).
    const symbols = Array.from(new Set(trades.map((t) => t.symbol)));
    const isins = Array.from(
      new Set(
        trades.map((t) => deriveEffectiveIsin(t)).filter(Boolean)
      )
    ) as string[];

    // 5-7. Delete old views, insert new views, and mark trades as paired
    // Wrapped in a transaction to prevent race conditions
    const tradeIds = trades.map((t) => t.id);
    const pairedViewData = result.pairedViews.map((view) => ({
      userId: view.userId,
      sourceTradeIds: view.sourceTradeIds,
      entryTradeId: view.entryTradeId,
      exitTradeId: view.exitTradeId,
      symbol: view.symbol,
      isin: view.isin,
      exchange: view.exchange,
      segment: view.segment,
      broker: view.broker,
      brokerUserId: view.brokerUserId,
      entryDate: view.entryDate,
      entryPrice: view.entryPrice,
      entryQuantity: view.entryQuantity,
      exitDate: view.exitDate,
      exitPrice: view.exitPrice,
      quantity: view.quantity,
      realizedPnL: view.realizedPnL,
      pnlPercentage: view.pnlPercentage,
      status: view.status,
      positionType: view.positionType,
      productType: view.productType,
      sourceType: view.sourceType,
      tradeType: view.tradeType,
      segmentLabel: view.segmentLabel,
      productTypeLabel: view.productTypeLabel,
      pairingBatchId: batchId,
    }));

    await prisma.$transaction([
      prisma.pairedTradeView.deleteMany({
        where: {
          userId,
          OR: [
            { symbol: { in: symbols } },
            ...(isins.length > 0 ? [{ isin: { in: isins } }] : []),
          ],
        },
      }),
      ...(pairedViewData.length > 0
        ? [prisma.pairedTradeView.createMany({ data: pairedViewData })]
        : []),
      prisma.trade.updateMany({
        where: { id: { in: tradeIds } },
        data: { needsRepairing: false },
      }),
    ]);

    console.log(
      `Pairing job ${jobId} completed: ${trades.length} trades processed, ${result.pairedViews.length} paired views created`
    );

    // Update job status to COMPLETED
    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        progress: 100,
        result: {
          success: true,
          tradesProcessed: trades.length,
          pairedViewsCreated: result.pairedViews.length,
          openPositions: result.stats.openPositions,
          closedPositions: result.stats.closedPositions,
          partialPositions: result.stats.partialPositions,
          totalRealizedPnL: result.stats.totalRealizedPnL,
        },
      },
    });

    // Invalidate trade/dashboard cache so users see paired results
    await clearTradeCache(userId).catch((err) =>
      console.warn(`Cache invalidation failed for user ${userId}:`, err)
    );

    // Create notification
    await createNotification({
      userId,
      type: "PAIRING_COMPLETE",
      title: "Trade Pairing Complete",
      message: `Processed ${trades.length} trades, created ${result.pairedViews.length} paired views.`,
      metadata: { jobId, link: "/tradebook" },
    });
  } catch (error) {
    console.error(`Pairing job ${jobId} failed:`, error);

    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage:
          error instanceof Error ? error.message : "Unknown error",
      },
    });

    throw error;
  }
}
