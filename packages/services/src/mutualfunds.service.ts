/**
 * Mutual Funds Service
 *
 * Handles mutual fund queries and CRUD operations.
 * Source: apps/web/lib/actions/mutualfunds.ts + apps/web/lib/db/mutualfunds.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { MutualFundFormInput } from "@usemoney/validation";
import type { ServiceResult } from "./types";
import {
  buildMutualFundWhere,
  calculateMfSummary,
  deriveMutualFundCreateFields,
  sanitizeMutualFundNumerics,
  type MutualFundSummary,
  type MutualFundFilters,
} from "./mutualfunds-logic";
import { keysetPageById, type ListPageParams } from "./trades-logic";

export type { MutualFundSummary, MutualFundFilters };

// ── Types ──────────────────────────────────────────────────────────

export interface MutualFundItem {
  id: string;
  userId: string;
  schemeName: string;
  schemeCode: string | null;
  isin: string | null;
  amcName: string | null;
  folioNumber: string | null;
  category: string | null;
  subCategory: string | null;
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number;
  xirr: number;
  sipActive: boolean;
  sipAmount: number | null;
  sipDate: number | null;
  brokerName: string | null;
  broker: string | null;
  brokerUserId: string | null;
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Mutual funds query result. `nextCursorId` is present ONLY when the caller
 * passed a `limit` (cursor pagination); absent on the unbounded default path so
 * existing callers see the unchanged `{ funds, summary }` shape.
 */
export interface MutualFundsResult {
  funds: MutualFundItem[];
  summary: MutualFundSummary;
  nextCursorId?: string | null;
}

// ── Service Functions ──────────────────────────────────────────────

export async function getMutualFunds(
  userId: string,
  filters: MutualFundFilters = {},
  page?: ListPageParams,
): Promise<ServiceResult<MutualFundsResult>> {
  try {
    // userId-scoped (IDOR guard): the where-clause ALWAYS carries userId, so a
    // search/category filter can never widen the read to another user's funds.
    const where = buildMutualFundWhere(userId, filters);

    const funds = await prisma.mutualFund.findMany({
      where,
      select: {
        id: true,
        userId: true,
        schemeName: true,
        schemeCode: true,
        isin: true,
        amcName: true,
        folioNumber: true,
        category: true,
        units: true,
        averageNav: true,
        currentNav: true,
        investedAmount: true,
        currentValue: true,
        unrealizedGain: true,
        xirr: true,
        sipActive: true,
        sipAmount: true,
        sipDate: true,
        brokerName: true,
        broker: true,
        brokerUserId: true,
        lastUpdated: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Enrich funds missing `category` from MutualFundMaster (MONEY-849).
    // `normalizeZerodhaMutualFund` never sets `category` (Kite /mf/holdings has
    // none), so every synced fund stores `category: null` → the holdings MF tab
    // "BY CATEGORY" donut buckets them all to "Other" and "All categories" is
    // empty. MutualFundMaster.category IS populated (required; e.g. "ELSS",
    // "Small Cap", derived by detectCategory). This is a read-time join that
    // mirrors getHoldings' InstrumentMapping sector fallback
    // (holdings.service.ts): ONE batched findMany over the union of join keys,
    // a lookup map, then an in-place patch — no N+1. The stored row is never
    // mutated; only the in-memory result objects are enriched.
    const needsCategory = funds.filter((f) => !f.category);
    if (needsCategory.length > 0) {
      // Synced Zerodha MFs carry `isin` (set from Kite's tradingsymbol, an ISIN
      // like INF277K01QO1) but a null `schemeCode`; the master keys ISIN as
      // `isinGrowth`/`isinDividend` and `schemeCode` is the AMFI numeric code.
      // So we join on BOTH families: schemeCode (manual/other-broker rows that
      // set it) AND isin → isinGrowth/isinDividend (the Zerodha-sync case).
      const keys = collectMfMasterLookupKeys(needsCategory);
      if (keys.schemeCodes.length > 0 || keys.isins.length > 0) {
        const orClauses: Array<Record<string, { in: string[] }>> = [];
        if (keys.schemeCodes.length > 0)
          orClauses.push({ schemeCode: { in: keys.schemeCodes } });
        if (keys.isins.length > 0) {
          orClauses.push({ isinGrowth: { in: keys.isins } });
          orClauses.push({ isinDividend: { in: keys.isins } });
        }
        const masters = await prisma.mutualFundMaster.findMany({
          where: { OR: orClauses },
          select: {
            schemeCode: true,
            isinGrowth: true,
            isinDividend: true,
            category: true,
            subCategory: true,
          },
        });
        patchMfCategoriesFromMasters(needsCategory, masters);
      }
    }

    // Sanitise every stored numeric field on each row so a corrupt broker-sync
    // value (NaN/Infinity in units/NAV/invested/current/gain/xirr) can never
    // reach the holdings UI's .toFixed()/.toLocaleString()/Math.round().
    // `subCategory` is not a stored MutualFund column — it only ever arrives via
    // the master join above — so default it to `null` here to keep the returned
    // shape honest (every MutualFundItem has the key, never `undefined`).
    const sanitizedFunds = funds.map((f) => ({
      ...sanitizeMutualFundNumerics(f),
      subCategory:
        (f as typeof f & { subCategory?: string | null }).subCategory ?? null,
    })) as MutualFundItem[];

    // Portfolio summary — every addend is finite-guarded and pnlPercentage is
    // never the literal string "NaN"/"Infinity" (divide-by-zero clamped to "0").
    // Computed over the FULL fund set BEFORE any pagination so the totals reflect
    // the whole portfolio regardless of the page returned.
    const summary = calculateMfSummary(sanitizedFunds);

    const result: MutualFundsResult = { funds: sanitizedFunds, summary };

    if (page && page.limit !== undefined) {
      const { page: funds, nextCursorId } = keysetPageById(
        result.funds,
        page.limit,
        page.cursorId,
      );
      return { success: true, data: { ...result, funds, nextCursorId } };
    }

    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, userId }, "Mutual funds service error");
    return { success: false, error: "Failed to fetch mutual funds" };
  }
}

export async function createMutualFund(
  userId: string,
  data: MutualFundFormInput,
): Promise<ServiceResult<MutualFundItem>> {
  try {
    // currentNav falls back to averageNav; all products finite-guarded so a
    // non-finite input can't persist a NaN/Infinity invested/current/gain.
    const { currentNav, investedAmount, currentValue, unrealizedGain } =
      deriveMutualFundCreateFields(data);

    const fund = await prisma.mutualFund.create({
      data: {
        userId,
        schemeName: data.schemeName,
        schemeCode: data.schemeCode,
        amcName: data.amcName,
        folioNumber: data.folioNumber || `MF${Date.now()}`,
        category: data.category,
        units: data.units,
        averageNav: data.averageNav,
        currentNav,
        investedAmount,
        currentValue,
        unrealizedGain,
        xirr: 0,
        sipActive: data.sipActive,
        sipAmount: data.sipAmount,
        sipDate: data.sipDate,
        brokerName: data.brokerName,
      },
    });

    return {
      success: true,
      // `subCategory` is not a stored MutualFund column (it only ever arrives via
      // the MutualFundMaster join in `getMutualFunds`), so a freshly-created fund
      // carries `null` — keeps the returned shape consistent with MutualFundItem.
      data: { ...fund, subCategory: null } as MutualFundItem,
      message: "Mutual fund added successfully!",
    };
  } catch (error) {
    logger.error({ error, userId }, "Create mutual fund service error");
    return { success: false, error: "Failed to create mutual fund" };
  }
}

export async function deleteMutualFund(
  userId: string,
  fundId: string,
): Promise<ServiceResult<void>> {
  try {
    const fund = await prisma.mutualFund.findFirst({
      where: { id: fundId, userId },
      select: { broker: true, brokerName: true },
    });

    if (!fund) {
      return { success: false, error: "Mutual fund not found" };
    }

    if (
      (fund.broker && fund.broker !== "MANUAL") ||
      (fund.brokerName && fund.brokerName !== "manual")
    ) {
      return {
        success: false,
        error:
          "Cannot delete broker-synced mutual funds. Only manual entries can be deleted.",
      };
    }

    const result = await prisma.mutualFund.deleteMany({
      where: { id: fundId, userId },
    });

    if (result.count === 0) {
      return {
        success: false,
        error: "Mutual fund not found or already deleted",
      };
    }

    return {
      success: true,
      data: undefined,
      message: "Mutual fund deleted successfully!",
    };
  } catch (error) {
    logger.error({ error, userId, fundId }, "Delete mutual fund service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to delete mutual fund",
      code: "INTERNAL",
    };
  }
}

// ── Category read-time join helpers (MONEY-849) ────────────────────
//
// Pure, Prisma-free helpers backing the `getMutualFunds` category enrichment.
// Kept exported (not inlined) so the join's key-collection and patch logic can
// be unit-tested directly under the (ESM) services `__tests__` without a Prisma
// double — the same "extract → export → assert real" precedent used for the
// finite-guarded math in `./mutualfunds-logic.ts`.

/** A MF row, as far as the category join cares: its two candidate join keys. */
export interface MfCategoryJoinRow {
  schemeCode?: string | null;
  isin?: string | null;
  category?: string | null;
  subCategory?: string | null;
}

/** A MutualFundMaster row, as far as the category join cares. */
export interface MfMasterCategoryRow {
  schemeCode?: string | null;
  isinGrowth?: string | null;
  isinDividend?: string | null;
  category?: string | null;
  subCategory?: string | null;
}

/** The de-duplicated join keys for the batched MutualFundMaster lookup. */
export interface MfMasterLookupKeys {
  schemeCodes: string[];
  isins: string[];
}

/**
 * Collect the distinct, non-empty join keys from the MF rows that still need a
 * category, for ONE batched `MutualFundMaster.findMany` (no N+1).
 *
 * Two key families because a synced Zerodha fund has a null `schemeCode` but a
 * populated `isin` (Kite sets it from `tradingsymbol`, which is an ISIN), while
 * manual / other-broker rows may instead carry a `schemeCode`:
 *   - `schemeCodes` → matched against `MutualFundMaster.schemeCode`
 *   - `isins`       → matched against `MutualFundMaster.isinGrowth` / `isinDividend`
 *
 * Whitespace-only / empty strings are dropped (a `{ in: [""] }` clause would
 * spuriously match blank master keys); each list is de-duplicated.
 */
export function collectMfMasterLookupKeys(
  rows: MfCategoryJoinRow[],
): MfMasterLookupKeys {
  const schemeCodes = new Set<string>();
  const isins = new Set<string>();
  for (const r of rows) {
    const sc = r.schemeCode?.trim();
    if (sc) schemeCodes.add(sc);
    const isin = r.isin?.trim();
    if (isin) isins.add(isin);
  }
  return { schemeCodes: [...schemeCodes], isins: [...isins] };
}

/**
 * Patch `category` (and `subCategory`, when the master supplies one) into the
 * given MF rows IN PLACE from their matching `MutualFundMaster`.
 *
 * Mirrors the structure of `getHoldings`' sector fallback (holdings.service.ts):
 * build a lookup map keyed by every join key the master exposes, then patch each
 * row by the first key that hits. Only rows whose `category` is still empty are
 * touched, so an already-categorised row is never overwritten (idempotent +
 * safe to call after a partial fill). A row with no master match keeps its
 * existing (null/empty) category — the UI then buckets it under "Other".
 *
 * `schemeCode` is preferred over ISIN as the match key (it is the master's
 * unique key); ISIN (growth, then dividend) is the fallback for the
 * Zerodha-sync case where `schemeCode` is null. Empty master keys are not
 * indexed so they can never match an empty row key.
 */
export function patchMfCategoriesFromMasters(
  rows: MfCategoryJoinRow[],
  masters: MfMasterCategoryRow[],
): void {
  if (rows.length === 0 || masters.length === 0) return;

  const bySchemeCode = new Map<string, MfMasterCategoryRow>();
  const byIsin = new Map<string, MfMasterCategoryRow>();
  for (const m of masters) {
    // Only index masters that actually carry a category — a master with a null
    // category is useless here and would just shadow a later usable hit.
    if (!m.category) continue;
    const sc = m.schemeCode?.trim();
    if (sc && !bySchemeCode.has(sc)) bySchemeCode.set(sc, m);
    const ig = m.isinGrowth?.trim();
    if (ig && !byIsin.has(ig)) byIsin.set(ig, m);
    const id = m.isinDividend?.trim();
    if (id && !byIsin.has(id)) byIsin.set(id, m);
  }

  for (const row of rows) {
    if (row.category) continue; // never overwrite an existing category
    const sc = row.schemeCode?.trim();
    const isin = row.isin?.trim();
    const match =
      (sc ? bySchemeCode.get(sc) : undefined) ??
      (isin ? byIsin.get(isin) : undefined);
    if (!match) continue;
    row.category = match.category ?? null;
    // Only fill subCategory from the master when the row hasn't got one and the
    // master actually has one (don't clobber a row value with null).
    if (!row.subCategory && match.subCategory) {
      row.subCategory = match.subCategory;
    }
  }
}
