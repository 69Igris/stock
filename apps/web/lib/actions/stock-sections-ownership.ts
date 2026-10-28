"use server";

/**
 * Ownership sections for the stock page — MONEY-1204 (P14 / 14c.4, 14c.5, 14c.6).
 *
 *   14c.4  shareholding pattern (NSE primary, Tickertape fallback)
 *   14c.5  insider & promoter activity
 *   14c.6  bulk & block deals
 *
 * GLOBAL market data: no auth gate, no demo branch, no `revalidatePath` — the
 * same posture as `stock-tabs.ts`, because none of this is user-scoped.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why these are one-line wrappers instead of the usual inline read
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `stock-tabs.ts` predates `@usemoney/services` and carries its Prisma queries,
 * cache keys and TTLs inline; `stock-tabs.service.ts` is a hand-maintained PORT
 * of it for `apps/api`. That duplication is exactly the drift the standing
 * "keep apps/api in sync with the server actions" rule exists to police, and
 * MONEY-1062 spent a whole lane repairing what it had already cost.
 *
 * So the read lives ONCE, in `@usemoney/services`, and both callers use it:
 * this action for the web, `mountStockSection` for `/v1/stocks/:symbol/*`. The
 * house action policy is unchanged and still enforced — it just lives in the
 * service now:
 *
 *   - cache-first (`discover` / `_global`) before any DB work;
 *   - a missing row is `success: true` with an EMPTY envelope, never a 404;
 *   - failures and empties are never cached;
 *   - the caught error is logged and a short, non-leaking message is returned.
 *
 * Every payload is wrapped in the provenance envelope (`source` / `asOf` /
 * `empty` / `fallback`) so the section chrome can label WHERE a number came
 * from — load-bearing for 14c.4, where the panel silently swaps providers.
 */

import {
  getStockDealsSection,
  getStockInsiderSection,
  getStockOwnershipBreakdownSection,
  getStockShareholdingSection,
  type ServiceResult,
  type StockDealsSectionData,
  type StockInsiderSectionData,
  type StockOwnershipBreakdownData,
  type StockShareholdingSectionData,
  type WithProvenance,
} from "@usemoney/services";

export type {
  StockDealsSectionData,
  StockInsiderSectionData,
  StockOwnershipBreakdownData,
  StockShareholdingSectionData,
};

/**
 * Quarterly shareholding with QoQ deltas and a pledge trend.
 *
 * NSE (`shareholding_patterns`) is the preferred source; the Tickertape copy is
 * served ONLY when NSE has no row for the symbol, and the envelope comes back
 * with `fallback: true` so `SectionShell` renders the visible chip. An
 * unlabelled provider swap is a silent downgrade.
 */
export async function getStockShareholdingSectionAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<WithProvenance<StockShareholdingSectionData>>> {
  return getStockShareholdingSection(args);
}

/**
 * The institutional split — FII / DII / MF / insurance / banks / government /
 * retail — for the latest filed quarter, with its QoQ movement.
 *
 * Reads `shareholding_breakdown`, which is a DIFFERENT table from the one above
 * and answers a question that one cannot: `shareholding_patterns` has no
 * mutual-fund, insurance, banks, government or retail column at all. Same
 * symbol-only read and same exchange-preference dedupe, for the same reason —
 * an exchange predicate blanks a quarter only the other exchange filed.
 *
 * The five share-count columns are Prisma `BigInt`; the service converts them
 * to decimal strings at the read, because `JSON.stringify` throws on a BigInt
 * and this action would crash at the server/client boundary rather than render
 * a wrong number.
 */
export async function getStockOwnershipBreakdownAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<WithProvenance<StockOwnershipBreakdownData>>> {
  return getStockOwnershipBreakdownSection(args);
}

/**
 * Insider / promoter filings: month-grouped timeline + netted 90-day summary.
 *
 * `InsiderEvent.qty` is a Prisma `BigInt` and `JSON.stringify` THROWS on one —
 * a server action returning it crashes at the server/client boundary rather
 * than rendering wrong. The service coerces at the read; this action never sees
 * a BigInt.
 */
export async function getStockInsiderActivityAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<WithProvenance<StockInsiderSectionData>>> {
  return getStockInsiderSection(args);
}

/**
 * Disclosed bulk and block prints, with repeat counterparties surfaced.
 *
 * Same BigInt caveat as above for `InstitutionalDeal.qty`.
 */
export async function getStockDealsSectionAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<WithProvenance<StockDealsSectionData>>> {
  return getStockDealsSection(args);
}
