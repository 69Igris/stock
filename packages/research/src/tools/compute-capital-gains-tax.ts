/**
 * Capital Gains Tax Computation (India)
 *
 * Budget 2024 rates:
 * - STCG (equity, ≤365d): 20% under s111A
 * - LTCG (equity, >365d): 12.5% above ₹1.25L under s112A
 * - F&O: Business income (flagged, not computed)
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { CapitalGainsTaxResult } from "../types";

// Budget 2024 tax rates - update when rates change
const STCG_RATE = 0.2; // s111A
const LTCG_RATE = 0.125; // s112A
const LTCG_EXEMPTION = 125000; // ₹1.25 lakh

interface TradeInput {
  symbol: string;
  buyDate: string;
  sellDate: string;
  /**
   * Full ISO instant of the exit (MONEY-620). When present, the FY-window filter
   * keys off this exact instant against the IST-anchored UTC window — the SAME
   * instant the service's Prisma `exitDate` window already filtered — so the two
   * filters agree bit-for-bit at the Apr-1/Mar-31 IST seam. When absent (callers
   * that only supply a `YYYY-MM-DD` `sellDate`), the filter falls back to an
   * IST-calendar-date string comparison (see `isSellWithinFy`).
   */
  sellTimestamp?: string;
  buyValue: number;
  sellValue: number;
  segment?: string; // "EQ" | "FO" | "MF"
}

/**
 * India Standard Time offset from UTC, in milliseconds (UTC+5:30, no DST).
 *
 * DUPLICATED — single source of truth is `IST_OFFSET_MS` in
 * `@usemoney/services` `tax-logic.ts`. `@usemoney/research` sits BELOW services
 * in the dependency graph and cannot import from it, so the constant and the
 * window arithmetic below are replicated here; a cross-package test
 * (`compute-capital-gains-tax.test.ts`) asserts this window is bit-for-bit equal
 * to the service's `fyWindowUtc` for the same FY label.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // 5h30m

/**
 * The precise UTC instant bounds of an Indian FY, anchored to IST (Apr 1 00:00
 * IST → Mar 31 23:59:59.999 IST). MUST match `fyWindowUtc` in
 * `@usemoney/services` `tax-logic.ts` exactly. Returns NaN-bearing Dates only if
 * `fyStart` is non-numeric; callers validate `fy` upstream.
 */
function fyWindowUtc(fyStart: number): { gte: Date; lte: Date } {
  return {
    gte: new Date(Date.UTC(fyStart, 3, 1, 0, 0, 0, 0) - IST_OFFSET_MS),
    lte: new Date(
      Date.UTC(fyStart + 1, 2, 31, 23, 59, 59, 999) - IST_OFFSET_MS,
    ),
  };
}

/**
 * Is a trade's exit inside the IST FY window?
 *
 * Production path: when `sellTimestamp` (the full exit instant) is present, the
 * trade is classified by comparing that instant to the IST-anchored UTC window
 * — identical to the service's Prisma `exitDate` filter, so a trade at the
 * Apr-1/Mar-31 IST seam lands in the same FY on both paths (MONEY-620).
 *
 * Fallback path: when only the date-only `sellDate` (`YYYY-MM-DD`) is available,
 * the calendar date is taken AS the IST calendar date and lexically compared to
 * the FY's `YYYY-04-01` / `YYYY-03-31` IST bounds. (A bare date carries no
 * time-of-day, so its IST calendar date is the date itself — there is nothing to
 * shift.) This preserves the existing date-only behaviour for callers that pass
 * only `sellDate`.
 */
function isSellWithinFy(
  trade: TradeInput,
  fyStart: number,
  fyStartDate: string,
  fyEndDate: string,
): boolean {
  if (trade.sellTimestamp) {
    const t = new Date(trade.sellTimestamp).getTime();
    if (Number.isFinite(t)) {
      const { gte, lte } = fyWindowUtc(fyStart);
      return t >= gte.getTime() && t <= lte.getTime();
    }
    // Unparseable timestamp → fall through to the date-only comparison.
  }
  return trade.sellDate >= fyStartDate && trade.sellDate <= fyEndDate;
}

function daysBetween(d1: string, d2: string): number {
  // Returns NaN when either date is unparseable (getTime() → NaN). Callers
  // MUST treat a non-finite result as "cannot classify" — never let it fall
  // through to a comparison, because `NaN <= 365` is false and would silently
  // bucket an undated trade as LTCG.
  return Math.floor(
    (new Date(d2).getTime() - new Date(d1).getTime()) / (1000 * 60 * 60 * 24),
  );
}

/** Coerce a non-finite money value (NaN / ±Infinity / undefined) to 0. */
function finiteOr0(n: number | undefined): number {
  return Number.isFinite(n) ? (n as number) : 0;
}

export const computeCapitalGainsTaxTool: ResearchToolDef = {
  name: "compute_capital_gains_tax",
  description:
    "Compute Indian capital gains tax (STCG/LTCG) from closed trades for a financial year",
  category: "computation",
  parameters: {
    trades: {
      type: "array",
      description:
        "Array of closed trades { symbol, buyDate, sellDate, buyValue, sellValue, segment? }",
      required: true,
    },
    fy: {
      type: "string",
      description: "Financial year e.g. '2025-26'",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const trades = params.trades as TradeInput[] | undefined;
    const fy = params.fy as string;

    if (!trades || !fy) {
      return { success: false, error: "trades array and fy are required" };
    }

    try {
      // Parse FY dates. The IST-anchored UTC window (`fyWindowUtc`) is used for
      // trades that carry a full `sellTimestamp`; the `YYYY-MM-DD` bounds are the
      // fallback for date-only `sellDate` inputs. Both live in `isSellWithinFy`.
      const fyStart = parseInt(fy.split("-")[0]!, 10);
      const fyStartDate = `${fyStart}-04-01`;
      const fyEndDate = `${fyStart + 1}-03-31`;

      // Filter trades within FY (by exit instant when available, else exit date).
      const fyTrades = trades.filter((t) =>
        isSellWithinFy(t, fyStart, fyStartDate, fyEndDate),
      );

      const equity = {
        stcg: { gains: 0, losses: 0, net: 0, tax: 0 },
        ltcg: {
          gains: 0,
          losses: 0,
          net: 0,
          exemption: LTCG_EXEMPTION,
          taxable: 0,
          tax: 0,
        },
      };
      const fno = { profits: 0, losses: 0, net: 0, note: "" };

      const tradeDetails: CapitalGainsTaxResult["trades"] = [];

      for (const trade of fyTrades) {
        const holdingDays = daysBetween(trade.buyDate, trade.sellDate);
        // Sanitize money inputs: a single NaN/±Infinity buy/sell value would
        // otherwise poison `gain` → losses → net → tax → totalTax (rendered as
        // a corrupt `null`/NaN figure to the user). Treat non-finite as 0.
        const buyValue = finiteOr0(trade.buyValue);
        const sellValue = finiteOr0(trade.sellValue);
        const gain = sellValue - buyValue;
        // A trade we cannot date (unparseable buy/sell date → NaN holdingDays)
        // is excluded entirely rather than misclassified as long-term.
        if (!Number.isFinite(holdingDays)) {
          continue;
        }
        const isFnO =
          trade.segment === "FO" ||
          trade.segment === "FUT" ||
          trade.segment === "OPT";

        if (isFnO) {
          if (gain > 0) fno.profits += gain;
          else fno.losses += Math.abs(gain);

          tradeDetails.push({
            symbol: trade.symbol,
            buyDate: trade.buyDate,
            sellDate: trade.sellDate,
            holdingDays,
            buyValue,
            sellValue,
            gain,
            type: "F&O",
          });
        } else if (holdingDays <= 365) {
          // STCG
          if (gain > 0) equity.stcg.gains += gain;
          else equity.stcg.losses += Math.abs(gain);

          tradeDetails.push({
            symbol: trade.symbol,
            buyDate: trade.buyDate,
            sellDate: trade.sellDate,
            holdingDays,
            buyValue,
            sellValue,
            gain,
            type: "STCG",
          });
        } else {
          // LTCG
          if (gain > 0) equity.ltcg.gains += gain;
          else equity.ltcg.losses += Math.abs(gain);

          tradeDetails.push({
            symbol: trade.symbol,
            buyDate: trade.buyDate,
            sellDate: trade.sellDate,
            holdingDays,
            buyValue,
            sellValue,
            gain,
            type: "LTCG",
          });
        }
      }

      // Set-off: LTCG losses can offset LTCG gains only
      // STCG losses can offset both STCG and LTCG gains
      equity.stcg.net = equity.stcg.gains - equity.stcg.losses;
      equity.ltcg.net = equity.ltcg.gains - equity.ltcg.losses;

      // If STCG has net loss, set-off against a net LTCG GAIN only.
      // A short-term loss can be set off against long-term *gains* — never
      // against a long-term *loss*. Guarding on `ltcg.net > 0` is essential:
      // when LTCG is itself a net loss, `Math.min(|stcgLoss|, ltcgNet)` returns
      // the negative `ltcgNet`, which then *inflates* both legs in the wrong
      // direction (e.g. a -50 STCG / -60 LTCG pair corrupted to -110 / 0).
      if (equity.stcg.net < 0 && equity.ltcg.net > 0) {
        const setOff = Math.min(Math.abs(equity.stcg.net), equity.ltcg.net);
        equity.ltcg.net -= setOff;
        equity.stcg.net += setOff;
      }

      // Compute taxes
      equity.stcg.tax = Math.max(0, Math.round(equity.stcg.net * STCG_RATE));
      equity.ltcg.taxable = Math.max(0, equity.ltcg.net - LTCG_EXEMPTION);
      equity.ltcg.tax = Math.round(equity.ltcg.taxable * LTCG_RATE);

      fno.net = fno.profits - fno.losses;
      fno.note =
        "F&O income is treated as business income under Indian tax law. Consult a qualified Chartered Accountant for proper computation including expenses, depreciation, and applicable slab rates.";

      const totalTax = equity.stcg.tax + equity.ltcg.tax;
      const totalGains = equity.stcg.net + equity.ltcg.net;
      const effectiveRate = totalGains > 0 ? totalTax / totalGains : 0;

      const result: CapitalGainsTaxResult = {
        fy,
        equity,
        fno,
        totalTax,
        effectiveRate: Math.round(effectiveRate * 10000) / 10000,
        trades: tradeDetails.sort(
          (a, b) =>
            new Date(b.sellDate).getTime() - new Date(a.sellDate).getTime(),
        ),
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Capital gains tax computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
