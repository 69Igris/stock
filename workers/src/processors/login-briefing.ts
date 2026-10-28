/**
 * Login Briefing Processor
 *
 * Generates a proactive portfolio briefing when a Premium user logs in:
 * 1. Fetches user's holdings
 * 2. Batch-fetches current prices
 * 3. Computes portfolio delta since last snapshot
 * 4. Detects significant movers (>5% change)
 * 5. Fetches top news for top holdings
 * 6. Generates a short summary with Gemini Flash
 * 7. Saves LoginBriefing + creates notification
 *
 * Cost: ~$0.01 per login (2-3 Gemini Flash calls)
 * No user credits consumed.
 */

import { prisma, Prisma } from "@usemoney/database";
import type { LoginBriefingMessage } from "@usemoney/types/pubsub";
import { createNotification } from "../lib/notifications";
import { getGeminiModel, generateWithTimeout } from "@usemoney/core";
import {
  type BriefingSection,
  type HoldingFlagRow,
  computePortfolioSummary,
  detectSignificantMovers,
  buildPortfolioSection,
  buildMoversSection,
  buildTopHoldingsSection,
  buildMarketFlowSection,
  buildVolatilitySection,
  buildHoldingFlagsSection,
  BRIEFING_FLAG_KINDS,
  MAX_BRIEFING_ROWS,
} from "./login-briefing-logic";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/**
 * MONEY-1204 (14e.4) — the market-context sections.
 *
 * THE CHEAPEST AGGREGATES ONLY: three reads of tables the data engine already
 * writes, all bounded (`take`), none per-symbol, none touching the network.
 * Every one is best-effort — a market-data hiccup must degrade the briefing to
 * the portfolio sections it always had, never fail it, so each read has its own
 * catch and a failure contributes no section at all rather than an empty one.
 * (An empty section and a failed fetch would otherwise be indistinguishable,
 * and "no FII flows today" is a claim about the market that a failed read has
 * no right to make.)
 *
 * `since` is the user's PREVIOUS completed briefing — the closest thing we hold
 * to "their last login"; `LoginBriefing` is written per login and the User model
 * carries no lastLoginAt.
 */
async function buildMarketContextSections(
  userId: string,
  briefingId: string,
  holdingSymbols: readonly string[],
): Promise<BriefingSection[]> {
  const sections: BriefingSection[] = [];

  // ── Day's FII / DII net (₹ crore, NOT rescaled) ──────────────────────────
  try {
    // A few rows, newest first; the pure builder picks the latest date out of
    // them (FII and DII share a date, so 4 covers two days of both).
    const flows = await prisma.institutionalFlow.findMany({
      orderBy: { date: "desc" },
      take: 4,
      select: { date: true, category: true, netValue: true },
    });
    const section = buildMarketFlowSection(flows);
    if (section) sections.push(section);
  } catch (e) {
    console.warn("[login-briefing] institutional flows unavailable", e);
  }

  // ── India VIX level + change ─────────────────────────────────────────────
  try {
    const vix = await prisma.indexClose.findMany({
      where: { indexSlug: "india-vix" },
      orderBy: { date: "desc" },
      take: 2,
      select: { date: true, close: true, prevClose: true },
    });
    const section = buildVolatilitySection(vix);
    if (section) sections.push(section);
  } catch (e) {
    console.warn("[login-briefing] india-vix unavailable", e);
  }

  // ── New StockFlag rows on the user's holdings since their last briefing ──
  try {
    if (holdingSymbols.length > 0) {
      const previous = await prisma.loginBriefing.findFirst({
        where: { userId, id: { not: briefingId }, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      // No prior briefing (first login) -> a 7-day window, so the section is
      // useful immediately instead of empty.
      const since =
        previous?.createdAt ?? new Date(Date.now() - 7 * 86_400_000);

      const rows: HoldingFlagRow[] = await prisma.stockFlag.findMany({
        where: {
          symbol: { in: [...holdingSymbols] },
          kind: { in: [...BRIEFING_FLAG_KINDS] },
          date: { gt: since },
        },
        orderBy: { date: "asc" },
        take: 200,
        select: { symbol: true, date: true, kind: true, value: true },
      });
      const section = buildHoldingFlagsSection(rows);
      if (section) sections.push(section);
    }
  } catch (e) {
    console.warn("[login-briefing] holding flags unavailable", e);
  }

  return sections;
}

/**
 * Entry point for the `login-briefing` job. The body lives in `runLoginBriefing`; this wrapper
 * tags every model call underneath it with `ml_app: briefing` (MONEY-1380).
 */
export async function processLoginBriefing(
  data: LoginBriefingMessage,
): Promise<void> {
  return llmWorkflow("briefing", "login-briefing", () =>
    runLoginBriefing(data),
  );
}

async function runLoginBriefing(data: LoginBriefingMessage): Promise<void> {
  const { userId, briefingId } = data;

  try {
    // 1. Mark as processing (inside try so a write failure is caught + logged)
    await prisma.loginBriefing.update({
      where: { id: briefingId },
      data: { status: "PROCESSING" },
    });

    // 2. Fetch user's holdings
    const holdings = await prisma.holding.findMany({
      where: { userId },
      select: {
        symbol: true,
        exchange: true,
        quantity: true,
        averagePrice: true,
        currentPrice: true,
        investedValue: true,
        currentValue: true,
        pnl: true,
        pnlPercentage: true,
      },
      orderBy: { currentValue: "desc" },
    });

    if (holdings.length === 0) {
      // No holdings - skip briefing
      await prisma.loginBriefing.update({
        where: { id: briefingId },
        data: { status: "SKIPPED" },
      });
      return;
    }

    // 3. Compute portfolio summary
    const { totalValue, totalPnl, totalPnlPercent } =
      computePortfolioSummary(holdings);

    // 4. Detect significant movers (>5% change)
    const significantMovers = detectSignificantMovers(holdings);

    // 5. Build sections
    const sections: BriefingSection[] = [];

    // Portfolio change section
    sections.push(
      buildPortfolioSection(holdings, {
        totalValue,
        totalInvested: totalValue - totalPnl,
        totalPnl,
        totalPnlPercent,
      }),
    );

    // Significant movers
    if (significantMovers.length > 0) {
      sections.push(buildMoversSection(significantMovers));
    }

    // Top holdings by value
    const topHoldings = holdings.slice(0, MAX_BRIEFING_ROWS);
    sections.push(buildTopHoldingsSection(topHoldings));

    // MONEY-1204 (14e.4) — market context: FII/DII net, India VIX, and any new
    // StockFlag rows on the user's own holdings. Best-effort by construction.
    sections.push(
      ...(await buildMarketContextSections(
        userId,
        briefingId,
        holdings.map((h) => h.symbol),
      )),
    );

    // 6. Generate summary with Gemini Flash
    let summary = `Your portfolio is worth ₹${totalValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })} across ${holdings.length} stocks.`;

    try {
      const model = getGeminiModel("fast");
      const summaryPrompt = `You are a portfolio briefing assistant. Generate a 2-3 sentence morning briefing for an Indian stock investor.

Portfolio: ₹${totalValue.toLocaleString("en-IN")} across ${holdings.length} stocks
Overall P&L: ${totalPnlPercent >= 0 ? "+" : ""}${totalPnlPercent.toFixed(1)}%
${significantMovers.length > 0 ? `Notable movers: ${significantMovers.map((h) => `${h.symbol} (${(h.pnlPercentage ?? 0) >= 0 ? "+" : ""}${(h.pnlPercentage ?? 0).toFixed(1)}%)`).join(", ")}` : "No significant movers today."}

Keep it concise, informative, and actionable. Use ₹ for currency. Do NOT give buy/sell advice.`;

      summary = await generateWithTimeout(model, summaryPrompt, 10_000, 1);
    } catch (e) {
      console.warn("[login-briefing] Flash summary failed, using fallback", e);
    }

    // 7. Save briefing
    await prisma.loginBriefing.update({
      where: { id: briefingId },
      data: {
        status: "COMPLETED",
        sections: sections as unknown as Prisma.InputJsonValue[],
        summary,
        portfolioValue: totalValue,
        dayChange: totalPnl,
        completedAt: new Date(),
      },
    });

    // 8. Create notification
    //
    // MONEY-1238 — its OWN catch, and that is not tidiness. The briefing row is
    // already `COMPLETED` two statements up; letting a notification failure fall
    // into the outer catch stamped `FAILED` straight over it, hiding a briefing
    // the user could otherwise read AND (see below) burning their 24h dedupe
    // window on a run that actually succeeded. The notification is a delivery
    // channel for a briefing that exists either way.
    try {
      await createNotification({
        userId,
        type: "LOGIN_BRIEFING",
        title: "Your Morning Briefing",
        message: summary.slice(0, 200),
        metadata: { briefingId },
      });
    } catch (e) {
      console.error(
        `[login-briefing] briefing ${briefingId} COMPLETED but its notification ` +
          `could not be created`,
        e,
      );
    }

    console.log(
      `[login-briefing] Briefing ${briefingId} completed for user ${userId}`,
    );
  } catch (error) {
    console.error(`[login-briefing] Failed for briefing ${briefingId}:`, error);

    try {
      await prisma.loginBriefing.update({
        where: { id: briefingId },
        data: {
          status: "FAILED",
        },
      });
    } catch (e) {
      console.error("[login-briefing] failed to write FAILED status", {
        briefingId,
        e,
      });
    }

    // MONEY-1238 — RE-THROW. `status: "FAILED"` had no reader anywhere: both
    // fetches filter `status: "COMPLETED"` (apps/web/lib/actions/briefing.ts:41
    // and packages/services/src/user.service.ts:773), and the only writer of new
    // rows — the Clerk `session.created` handler at
    // apps/web/app/api/webhooks/clerk/route.ts:523 — dedupes on
    // `{userId, createdAt >= now-24h}` with NO status clause. So one failed row
    // silently withheld a PAID feature for a full day, and the row that did it
    // was invisible to everything that could have said so.
    //
    // Throwing hands the route a 500, Pub/Sub redelivers, and the retry
    // reprocesses THIS SAME briefingId — which is the only repair available from
    // inside the worker, because the dedupe is keyed on the row's existence, not
    // on its status. Idempotent: every step updates the one row in place, and
    // the notification (the only side effect that could duplicate) is not
    // reached on this path. Bounded by --max-delivery-attempts=5 and the
    // dead-letter consumer.
    //
    // It does NOT close the hole for a PERMANENTLY failing briefing — that
    // needs `status: { notIn: ["FAILED"] }` on the clerk-route dedupe, which is
    // outside this change's file set.
    throw error;
  }
}
