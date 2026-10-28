/**
 * MF NAV propagation service (MONEY-1074).
 *
 * User `MutualFund` rows store `currentNav` only at creation (falling back to
 * `averageNav`, so unrealizedGain is 0 forever) and nothing ever refreshes it —
 * the `mf-sync` worker writes ONLY the `MutualFundMaster` AMFI NAV feed. So the
 * dashboard's MF value/return never moved. This job walks user MF rows in
 * batches, joins each to its `MutualFundMaster` (by schemeCode, then ISIN —
 * exactly like getMutualFunds' category join), and writes the fresh NAV-derived
 * `currentNav` / `currentValue` / `unrealizedGain` via the pure `buildMfNavPatch`
 * decision (which never zeroes a row on a missing/bad master NAV and is a
 * fixpoint, so a re-run over already-propagated rows is a no-op).
 *
 * Cache note: dashboard/MF caches (5-min TTL) may be stale until they expire.
 * The nightly cadence makes that acceptable; there is deliberately no per-user
 * invalidation fan-out here.
 *
 * Runs on BOTH envs (it reads only our own DB — no rate-limited upstream), so it
 * is NOT in the scheduler's PROD_ONLY_JOBS. QA MF-master freshness is bounded by
 * the weekly sync-prod-to-qa master copy.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import { buildMfNavPatch, type MfNavPatch } from "./mutualfunds-logic";

const DEFAULT_BATCH_SIZE = 500;
/** Bounded concurrency for the independent per-row updates within a batch. */
const UPDATE_CONCURRENCY = 20;

export interface MfNavPropagationStats {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Propagate MutualFundMaster NAVs into user MutualFund rows.
 *
 * @param batchSize rows per keyset page (default 500). Bounded, id-keyset cursor
 *                  — no deep offset paging — so it terminates in total-rows/size
 *                  pages regardless of DB size.
 */
export async function propagateMfNavToUserFunds(
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ServiceResult<MfNavPropagationStats>> {
  const size =
    Number.isFinite(batchSize) && batchSize > 0
      ? Math.floor(batchSize)
      : DEFAULT_BATCH_SIZE;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let cursorId: string | undefined;

  try {
    for (;;) {
      const funds = await prisma.mutualFund.findMany({
        take: size,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
        orderBy: { id: "asc" },
        select: {
          id: true,
          schemeCode: true,
          isin: true,
          units: true,
          investedAmount: true,
          investedValue: true,
          currentNav: true,
          currentValue: true,
        },
      });
      if (funds.length === 0) break;
      scanned += funds.length;
      cursorId = funds[funds.length - 1]!.id;

      // Batch master lookup by schemeCode + ISIN (growth/dividend), mirroring
      // getMutualFunds' category join (schemeCode preferred, ISIN fallback).
      const schemeCodes = new Set<string>();
      const isins = new Set<string>();
      for (const f of funds) {
        const sc = f.schemeCode?.trim();
        if (sc) schemeCodes.add(sc);
        const isin = f.isin?.trim();
        if (isin) isins.add(isin);
      }
      const orClauses: Array<Record<string, { in: string[] }>> = [];
      if (schemeCodes.size > 0)
        orClauses.push({ schemeCode: { in: [...schemeCodes] } });
      if (isins.size > 0) {
        orClauses.push({ isinGrowth: { in: [...isins] } });
        orClauses.push({ isinDividend: { in: [...isins] } });
      }
      const masters =
        orClauses.length > 0
          ? await prisma.mutualFundMaster.findMany({
              where: { OR: orClauses },
              select: {
                schemeCode: true,
                isinGrowth: true,
                isinDividend: true,
                nav: true,
                navDate: true,
              },
            })
          : [];

      type MasterNav = { nav: number; navDate: Date };
      const bySchemeCode = new Map<string, MasterNav>();
      const byIsin = new Map<string, MasterNav>();
      for (const m of masters) {
        const rec: MasterNav = { nav: m.nav, navDate: m.navDate };
        const sc = m.schemeCode?.trim();
        if (sc && !bySchemeCode.has(sc)) bySchemeCode.set(sc, rec);
        const ig = m.isinGrowth?.trim();
        if (ig && !byIsin.has(ig)) byIsin.set(ig, rec);
        const id = m.isinDividend?.trim();
        if (id && !byIsin.has(id)) byIsin.set(id, rec);
      }

      const pending: Array<{ id: string; patch: MfNavPatch }> = [];
      for (const f of funds) {
        const sc = f.schemeCode?.trim();
        const isin = f.isin?.trim();
        const master =
          (sc ? bySchemeCode.get(sc) : undefined) ??
          (isin ? byIsin.get(isin) : undefined);
        const patch = buildMfNavPatch(
          f,
          master?.nav ?? null,
          master?.navDate ?? null,
        );
        if (patch) pending.push({ id: f.id, patch });
        else skipped += 1;
      }

      // Apply in bounded-concurrency chunks; a single row failure never aborts
      // the batch (logged + counted as skipped).
      for (let i = 0; i < pending.length; i += UPDATE_CONCURRENCY) {
        const chunk = pending.slice(i, i + UPDATE_CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map((u) =>
            prisma.mutualFund.update({
              where: { id: u.id },
              data: {
                currentNav: u.patch.currentNav,
                currentValue: u.patch.currentValue,
                unrealizedGain: u.patch.unrealizedGain,
                lastNavDate: u.patch.lastNavDate ?? undefined,
                lastUpdated: new Date(),
              },
            }),
          ),
        );
        for (const r of results) {
          if (r.status === "fulfilled") {
            updated += 1;
          } else {
            skipped += 1;
            logger.error(
              { err: r.reason },
              "propagateMfNavToUserFunds: row update failed",
            );
          }
        }
      }

      // A short final page means we've drained the table.
      if (funds.length < size) break;
    }

    logger.info(
      { scanned, updated, skipped },
      "propagateMfNavToUserFunds: completed",
    );
    return { success: true, data: { scanned, updated, skipped } };
  } catch (error) {
    logger.error(
      { error, scanned, updated, skipped },
      "propagateMfNavToUserFunds error",
    );
    return { success: false, error: "Failed to propagate MF NAV" };
  }
}
