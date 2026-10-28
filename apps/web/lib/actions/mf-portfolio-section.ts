"use server";

/**
 * MF Portfolio tab — MONEY-1204 (P14 / 14d.1).
 *
 * Deliberately a thin delegation to `@usemoney/services`, not a second
 * implementation. The standing rule is that a web server action and its
 * `apps/api` mirror stay in sync; the cheapest way to honour that is for the web
 * side to CALL the service rather than re-derive the same reads, so the two
 * cannot drift.
 *
 * Global market data: no auth, no demo handling, no `revalidatePath` — matching
 * every other read in `stock-tabs.ts`. A fund's disclosed portfolio is not
 * user-scoped.
 */

import {
  getMfPortfolioSection,
  type MfPortfolioSectionData,
  type ServiceResult,
  type WithProvenance,
} from "@usemoney/services";

export async function getMfPortfolioSectionAction(args: {
  schemeCode: string;
}): Promise<ServiceResult<WithProvenance<MfPortfolioSectionData>>> {
  // Bounded before it reaches a query. The MF route param is an AMFI scheme
  // code (numeric in practice), so anything longer than this is not one.
  const schemeCode = String(args.schemeCode ?? "").trim();
  if (!schemeCode || schemeCode.length > 24) {
    return { success: false, error: "Invalid scheme code" };
  }
  return getMfPortfolioSection({ schemeCode });
}
