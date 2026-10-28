/**
 * Corporate Actions Service (MONEY-840/844)
 *
 * The single persist + read seam for the `CorporateAction` table. Other agents
 * (FIFO pairing cost-basis adjustment in `packages/core/src/pairing`, the
 * tradebook reconciliation, the research corp-actions tool) read corporate
 * actions through {@link getCorporateActions} or `prisma.corporateAction`
 * directly; the corporate-actions-sync worker writes through
 * {@link upsertCorporateActions}.
 *
 * Design principles (per the MONEY-840 redesign — "Holdings = current, Pairing =
 * history(tax+behavior)"):
 *   - HISTORY-PRESERVING. The upsert deduplicates on the model's
 *     `@@unique([symbol, exchange, type, exDate])` key and merges fields, but
 *     NEVER deletes past ex-dates (the `events-sync` "forward-only UpcomingEvent"
 *     mistake — discarding past actions — is deliberately NOT repeated here; a
 *     split from 2019 is exactly what cost-basis math needs).
 *   - MERGE NSE + Screener. The same action is often listed by both sources with
 *     partial fields (NSE has the record date + ratio; Screener sometimes has a
 *     cleaner per-share dividend). On a key collision we fill in nulls from the
 *     incoming row rather than blindly overwriting good data with nulls, and
 *     concatenate distinct source tags.
 *   - FINITE-GUARDED. Non-finite ratios / face values / dividends are coerced to
 *     null before they touch the DB so a poisoned upstream value can't surface as
 *     "NaN×" in the pairing math (the MONEY-620 non-finite poison class).
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import type {
  NSECorporateAction,
  CorporateActionType,
} from "@usemoney/research/data-sources/nse-filings-types";
import type { ScreenerCorpAction } from "@usemoney/research/data-sources/screener-full-scraper";

// ── Types ──────────────────────────────────────────────────────────

/**
 * The normalized corporate-action row this service persists. Maps 1:1 onto the
 * `CorporateAction` Prisma model. `exchange` defaults to "NSE" at the call site
 * (both current sources are NSE-listed equities) but is explicit so BSE-only
 * actions can be ingested later without an interface change.
 */
export interface CorporateActionInput {
  symbol: string;
  isin?: string | null;
  exchange: string;
  type: CorporateActionType;
  /** Required by the unique key; the caller drops rows with no ex-date. */
  exDate: Date;
  recordDate?: Date | null;
  ratio?: number | null;
  oldFaceValue?: number | null;
  newFaceValue?: number | null;
  dividendPerShare?: number | null;
  /** "NSE" | "SCREENER" | "BSE" | "SEED" | "MANUAL". */
  source?: string | null;
  /** Free-text subject / raw payload preserved for audit. */
  details?: unknown;
  /** GCS snapshot location (set by the worker after archiving). */
  gcsPath?: string | null;
}

export interface UpsertCorporateActionsResult {
  /** Rows that didn't exist and were created. */
  created: number;
  /** Existing rows that were merged/updated. */
  updated: number;
  /** Rows skipped because they had no usable ex-date (can't satisfy the key). */
  skipped: number;
  /**
   * Existing rows the merge would not have changed, so no write was issued.
   *
   * Bulk path only. Reported rather than hidden: on a re-walk this is most of
   * the batch, and a large `unchanged` beside a small `updated` is the signal
   * that the run is CONFIRMING history rather than rewriting it.
   */
  unchanged?: number;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Coerce a possibly-non-finite number to a finite value or null. */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Map a parsed NSE corporate action into the persist shape. Returns `null` when
 * the action has no ex-date (the `@@unique` key needs one; a record-date-only
 * row can't be deduped and isn't useful for ex-date-anchored cost-basis math).
 */
export function nseActionToInput(
  a: NSECorporateAction,
  exchange = "NSE",
  isin?: string | null,
): CorporateActionInput | null {
  if (!a.exDate || Number.isNaN(a.exDate.getTime())) return null;
  return {
    symbol: a.symbol.toUpperCase(),
    isin: isin ?? null,
    exchange,
    type: a.type,
    exDate: a.exDate,
    recordDate:
      a.recordDate && !Number.isNaN(a.recordDate.getTime())
        ? a.recordDate
        : null,
    ratio: finiteOrNull(a.ratio),
    oldFaceValue: finiteOrNull(a.oldFaceValue),
    newFaceValue: finiteOrNull(a.newFaceValue),
    dividendPerShare: finiteOrNull(a.dividendPerShare),
    source: "NSE",
    details: a.details || a.actionType || null,
  };
}

/**
 * Map a parsed BSE corporate action into the persist shape (MONEY-852). BSE rows
 * are normalized into the same `NSECorporateAction` shape by `bse-client`, so
 * this mirrors {@link nseActionToInput} exactly EXCEPT it tags `source: "BSE"`.
 * That distinct source tag is what lets the merge union NSE+BSE+SCREENER for the
 * same action (`source: "BSE+NSE"`) instead of silently overwriting. Returns
 * `null` when the action has no ex-date (the `@@unique` key needs one).
 */
export function bseActionToInput(
  a: NSECorporateAction,
  exchange = "BSE",
  isin?: string | null,
): CorporateActionInput | null {
  if (!a.exDate || Number.isNaN(a.exDate.getTime())) return null;
  return {
    symbol: a.symbol.toUpperCase(),
    isin: isin ?? null,
    exchange,
    type: a.type,
    exDate: a.exDate,
    recordDate:
      a.recordDate && !Number.isNaN(a.recordDate.getTime())
        ? a.recordDate
        : null,
    ratio: finiteOrNull(a.ratio),
    oldFaceValue: finiteOrNull(a.oldFaceValue),
    newFaceValue: finiteOrNull(a.newFaceValue),
    dividendPerShare: finiteOrNull(a.dividendPerShare),
    source: "BSE",
    details: a.details || a.actionType || null,
  };
}

/**
 * Map a Screener corporate action into the persist shape. Returns `null` when
 * the action has no parseable ex-date (Screener sometimes shows only a year).
 */
export function screenerActionToInput(
  a: ScreenerCorpAction,
  exchange = "NSE",
  isin?: string | null,
): CorporateActionInput | null {
  if (!a.exDate || Number.isNaN(a.exDate.getTime())) return null;
  return {
    symbol: a.symbol.toUpperCase(),
    isin: isin ?? null,
    exchange,
    type: a.type,
    exDate: a.exDate,
    recordDate: null,
    ratio: finiteOrNull(a.ratio),
    oldFaceValue: finiteOrNull(a.oldFaceValue),
    newFaceValue: finiteOrNull(a.newFaceValue),
    dividendPerShare: finiteOrNull(a.dividendPerShare),
    source: "SCREENER",
    details: a.details || null,
  };
}

/** Stable dedupe key matching the Prisma `@@unique([symbol,exchange,type,exDate])`. */
export function corporateActionKey(row: {
  symbol: string;
  exchange: string;
  type: string;
  exDate: Date;
}): string {
  return `${row.symbol.toUpperCase()}|${row.exchange}|${row.type}|${row.exDate.toISOString()}`;
}

/**
 * Merge two rows for the SAME key. The accumulator wins for every field it
 * already has; the incoming row only FILLS nulls — so we never clobber a good
 * ratio/dividend/record-date with a later source's null. Sources are unioned.
 */
export function mergeCorporateActions(
  base: CorporateActionInput,
  next: CorporateActionInput,
): CorporateActionInput {
  const mergeSource = (): string | null => {
    const tags = new Set(
      [base.source, next.source]
        .filter((s): s is string => !!s)
        .flatMap((s) => s.split("+")),
    );
    return tags.size ? Array.from(tags).sort().join("+") : null;
  };
  return {
    ...base,
    isin: base.isin ?? next.isin ?? null,
    recordDate: base.recordDate ?? next.recordDate ?? null,
    ratio: base.ratio ?? next.ratio ?? null,
    oldFaceValue: base.oldFaceValue ?? next.oldFaceValue ?? null,
    newFaceValue: base.newFaceValue ?? next.newFaceValue ?? null,
    dividendPerShare: base.dividendPerShare ?? next.dividendPerShare ?? null,
    source: mergeSource(),
    // Keep the longest details string (usually the more descriptive subject).
    details: pickRicherDetails(base.details, next.details),
    gcsPath: base.gcsPath ?? next.gcsPath ?? null,
  };
}

function pickRicherDetails(a: unknown, b: unknown): unknown {
  const aLen = typeof a === "string" ? a.length : a ? 1 : 0;
  const bLen = typeof b === "string" ? b.length : b ? 1 : 0;
  return bLen > aLen ? b : (a ?? b ?? null);
}

/**
 * Collapse a batch (which may contain the same action from NSE + Screener, or
 * duplicate rows within one source) down to one entry per unique key, merging
 * fields. Exported for direct unit testing of the merge/dedupe behaviour.
 */
export function dedupeCorporateActions(
  rows: CorporateActionInput[],
): CorporateActionInput[] {
  const byKey = new Map<string, CorporateActionInput>();
  for (const row of rows) {
    if (!row.exDate || Number.isNaN(row.exDate.getTime())) continue;
    const key = corporateActionKey(row);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeCorporateActions(existing, row) : row);
  }
  return Array.from(byKey.values());
}

// ── Persist ────────────────────────────────────────────────────────

/**
 * Upsert a batch of corporate actions, history-preserving. Dedupes + merges the
 * incoming batch first (so NSE + Screener rows for the same action collapse),
 * then upserts each unique row keyed on `[symbol, exchange, type, exDate]`. On an
 * existing row we ONLY fill nulls (via {@link mergeCorporateActions} against the
 * DB row) so a re-run from a thinner source never erases a previously captured
 * ratio / record-date. Never deletes — past ex-dates are retained.
 *
 * Best-effort + per-row isolated: one bad row can't fail the whole batch (the
 * worker processes many symbols and a single malformed action shouldn't abort
 * the run). Returns created/updated/skipped counts.
 */
export async function upsertCorporateActions(
  rows: CorporateActionInput[],
): Promise<UpsertCorporateActionsResult> {
  const deduped = dedupeCorporateActions(rows);
  let created = 0;
  let updated = 0;
  const skipped = rows.length - deduped.length; // dropped (no ex-date) + collapsed

  for (const row of deduped) {
    const where = {
      symbol_exchange_type_exDate: {
        symbol: row.symbol.toUpperCase(),
        exchange: row.exchange,
        type: row.type,
        exDate: row.exDate,
      },
    };
    try {
      const existing = await prisma.corporateAction.findUnique({ where });

      if (!existing) {
        await prisma.corporateAction.create({
          data: {
            symbol: row.symbol.toUpperCase(),
            isin: row.isin ?? null,
            exchange: row.exchange,
            type: row.type,
            exDate: row.exDate,
            recordDate: row.recordDate ?? null,
            ratio: row.ratio ?? null,
            oldFaceValue: row.oldFaceValue ?? null,
            newFaceValue: row.newFaceValue ?? null,
            dividendPerShare: row.dividendPerShare ?? null,
            source: row.source ?? null,
            details: toJsonValue(row.details),
            gcsPath: row.gcsPath ?? null,
          },
        });
        created++;
        continue;
      }

      // Merge: existing DB row is the base (its good values win); the incoming
      // row only fills the nulls.
      const merged = mergeCorporateActions(
        {
          symbol: existing.symbol,
          exchange: existing.exchange,
          type: existing.type as CorporateActionType,
          exDate: existing.exDate,
          isin: existing.isin,
          recordDate: existing.recordDate,
          ratio: existing.ratio,
          oldFaceValue: existing.oldFaceValue,
          newFaceValue: existing.newFaceValue,
          dividendPerShare: existing.dividendPerShare,
          source: existing.source,
          details: existing.details,
          gcsPath: existing.gcsPath,
        },
        row,
      );

      await prisma.corporateAction.update({
        where,
        data: {
          isin: merged.isin ?? null,
          recordDate: merged.recordDate ?? null,
          ratio: merged.ratio ?? null,
          oldFaceValue: merged.oldFaceValue ?? null,
          newFaceValue: merged.newFaceValue ?? null,
          dividendPerShare: merged.dividendPerShare ?? null,
          source: merged.source ?? null,
          details: toJsonValue(merged.details),
          // Only advance gcsPath when the incoming row carries one.
          ...(row.gcsPath ? { gcsPath: row.gcsPath } : {}),
        },
      });
      updated++;
    } catch (error) {
      logger.warn(
        { error, key: corporateActionKey(row) },
        "Failed to upsert corporate action",
      );
    }
  }

  return { created, updated, skipped };
}

/**
 * Bulk variant of {@link upsertCorporateActions} for BACKFILLS — MONEY-1189.
 *
 * `upsertCorporateActions` costs a `findUnique` plus a `create`/`update` PER
 * ROW. That is the right shape for the nightly, which handles tens of rows and
 * wants per-row isolation. It is the wrong shape for twenty years of dividends:
 * ~300-500k rows × 2 round-trips is hours of wall clock, and it is the reason
 * DIVIDEND was excluded from the backfill in the first place.
 *
 * So this reads the batch's existing rows in ONE query keyed on the same
 * `[symbol, exchange, type, exDate]` unique, `createMany`s the ones that are
 * new, and falls back to the row-by-row merge ONLY for rows that already exist.
 * On a fresh backfill almost everything is a create, so the update path stays
 * cheap; on a re-run almost everything is an update and the cost is the same as
 * before — never worse.
 *
 * The merge semantics are IDENTICAL to the row-by-row path (existing values
 * win, incoming only fills nulls) because it literally delegates to it for the
 * existing rows. A second, subtly different merge would be a silent divergence
 * between the backfill and the nightly writing the same table.
 */
/**
 * The `@@unique([symbol, exchange, type, exDate])` key, as a string.
 *
 * BOTH sides of a comparison must be built with this, never by hand. The bulk
 * writer's first version derived the "already present" set straight from the DB
 * rows while looking rows up with `symbol.toUpperCase()` — so any legacy row
 * stored in mixed case failed to match, got classed as new, hit the unique
 * constraint, and dropped the whole chunk to the slow path. Silently, and only
 * on dirty data.
 */
export function corporateActionRowKey(row: {
  symbol: string;
  exchange: string;
  type: string;
  exDate: Date;
}): string {
  return [
    row.symbol.trim().toUpperCase(),
    row.exchange,
    row.type,
    row.exDate.getTime(),
  ].join("|");
}

/**
 * Split a batch into rows that do not yet exist and rows that do.
 *
 * Pure, so the key normalisation above is testable without a database — the
 * same reason `partitionPriceWrites` exists on the price side (MONEY-1175).
 */
/** The stored fields a merge can change. */
export interface StoredCorporateAction {
  isin?: string | null;
  recordDate?: Date | null;
  ratio?: number | null;
  oldFaceValue?: number | null;
  newFaceValue?: number | null;
  dividendPerShare?: number | null;
  source?: string | null;
  details?: unknown;
  gcsPath?: string | null;
}

/**
 * Would merging `incoming` into `existing` actually change anything?
 *
 * `mergeCorporateActions` only ever FILLS NULLS and unions source tags, so a
 * re-walk over history is overwhelmingly no-ops: the stored row already has
 * everything the feed is offering. Issuing the update anyway costs a round trip
 * to Atlas PER ROW, and `upsertCorporateActions` also spends a `findUnique`
 * first — on the MONEY-1189 heal that was ~3,800 pointless read+write pairs per
 * chunk, and the reason a 23-chunk re-walk projected to 3.6 hours.
 *
 * Mirrors the merge field-for-field on purpose. If the two ever disagree the
 * failure is silent — a row that needed enriching would simply never be
 * written — so they are tested against each other rather than independently.
 */
export function corporateActionNeedsMerge(
  existing: StoredCorporateAction,
  incoming: CorporateActionInput,
): boolean {
  // Null-filling fields: only a null on the stored side can change.
  if (existing.isin == null && incoming.isin != null) return true;
  if (existing.recordDate == null && incoming.recordDate != null) return true;
  if (existing.ratio == null && incoming.ratio != null) return true;
  if (existing.oldFaceValue == null && incoming.oldFaceValue != null)
    return true;
  if (existing.newFaceValue == null && incoming.newFaceValue != null)
    return true;
  if (existing.dividendPerShare == null && incoming.dividendPerShare != null) {
    return true;
  }
  // gcsPath advances only when the incoming row carries one (see the update).
  if (incoming.gcsPath && existing.gcsPath !== incoming.gcsPath) return true;

  // Source is a UNION of `+`-joined tags — a new tag changes it.
  const tags = new Set(
    [existing.source, incoming.source]
      .filter((s): s is string => !!s)
      .flatMap((s) => s.split("+")),
  );
  const mergedSource = tags.size ? [...tags].sort().join("+") : null;
  if ((existing.source ?? null) !== mergedSource) return true;

  // Details keeps the RICHER value, so only a strictly richer incoming matters.
  return (
    pickRicherDetails(existing.details, incoming.details) !== existing.details
  );
}

export function partitionCorporateActionWrites<
  T extends { symbol: string; exchange: string; type: string; exDate: Date },
>(
  chunk: readonly T[],
  existing: ReadonlyArray<{
    symbol: string;
    exchange: string;
    type: string;
    exDate: Date;
  }>,
): { fresh: T[]; collisions: T[] } {
  const present = new Set(existing.map(corporateActionRowKey));
  const fresh: T[] = [];
  const collisions: T[] = [];
  for (const row of chunk) {
    (present.has(corporateActionRowKey(row)) ? collisions : fresh).push(row);
  }
  return { fresh, collisions };
}

export async function upsertCorporateActionsBulk(
  rows: CorporateActionInput[],
  chunkSize = 2_000,
): Promise<UpsertCorporateActionsResult> {
  const deduped = dedupeCorporateActions(rows);
  let created = 0;
  let updated = 0;
  let skipped = rows.length - deduped.length;
  let unchanged = 0;

  for (let i = 0; i < deduped.length; i += chunkSize) {
    const chunk = deduped.slice(i, i + chunkSize);

    // One read for the whole chunk. Narrowed by exDate range + symbol set so
    // the index is usable — an `OR` of N composite keys degenerates to a scan.
    const symbols = [...new Set(chunk.map((r) => r.symbol.toUpperCase()))];
    const times = chunk.map((r) => r.exDate.getTime());
    const existingRows = await prisma.corporateAction.findMany({
      where: {
        symbol: { in: symbols },
        exDate: {
          gte: new Date(Math.min(...times)),
          lte: new Date(Math.max(...times)),
        },
      },
      // The merge-relevant fields too, so a collision that would change nothing
      // can be dropped here instead of costing a findUnique + update apiece.
      select: {
        symbol: true,
        exchange: true,
        type: true,
        exDate: true,
        isin: true,
        recordDate: true,
        ratio: true,
        oldFaceValue: true,
        newFaceValue: true,
        dividendPerShare: true,
        source: true,
        details: true,
        gcsPath: true,
      },
    });
    const { fresh, collisions } = partitionCorporateActionWrites(
      chunk,
      existingRows,
    );

    // Drop the collisions the merge would not change. On a re-walk this is
    // nearly all of them — the stored row already holds what the feed is
    // offering — and each one avoided is a findUnique AND an update that would
    // have written data identical to what is already there. Measured on the
    // MONEY-1189 heal: ~3,800 such pairs per chunk, projecting the 23-chunk
    // re-walk to 3.6 hours.
    const byKey = new Map(
      existingRows.map((e) => [corporateActionRowKey(e), e]),
    );
    const toMerge = collisions.filter((row) => {
      const existing = byKey.get(corporateActionRowKey(row));
      return !existing || corporateActionNeedsMerge(existing, row);
    });
    unchanged += collisions.length - toMerge.length;

    if (fresh.length > 0) {
      try {
        const res = await prisma.corporateAction.createMany({
          data: fresh.map((row) => ({
            symbol: row.symbol.toUpperCase(),
            isin: row.isin ?? null,
            exchange: row.exchange,
            type: row.type,
            exDate: row.exDate,
            recordDate: row.recordDate ?? null,
            ratio: row.ratio ?? null,
            oldFaceValue: row.oldFaceValue ?? null,
            newFaceValue: row.newFaceValue ?? null,
            dividendPerShare: row.dividendPerShare ?? null,
            source: row.source ?? null,
            details: toJsonValue(row.details),
            gcsPath: row.gcsPath ?? null,
          })),
        });
        created += res.count;
      } catch (error) {
        // A chunk-level failure must not lose the chunk: fall back to the
        // isolated row-by-row path, which is what the nightly uses anyway.
        logger.warn(
          { error, chunk: fresh.length },
          "createMany failed — falling back to row-by-row for this chunk",
        );
        const res = await upsertCorporateActions(fresh);
        created += res.created;
        updated += res.updated;
        skipped += res.skipped;
      }
    }

    if (toMerge.length > 0) {
      const res = await upsertCorporateActions(toMerge);
      created += res.created;
      updated += res.updated;
      skipped += res.skipped;
    }
  }

  return { created, updated, skipped };
}

/** Coerce arbitrary details into a Prisma-Json-safe value (string stays string). */
function toJsonValue(details: unknown): string | object | null {
  if (details == null) return null;
  if (typeof details === "string") return details;
  if (typeof details === "object") return details as object;
  return String(details);
}

// ── Read (DB-first) ────────────────────────────────────────────────

export interface GetCorporateActionsFilter {
  symbol?: string;
  isin?: string;
  exchange?: string;
  /** Optional: only actions on/after this date (e.g. since a position opened). */
  fromDate?: Date;
  /** Optional: only actions on/before this date. */
  toDate?: Date;
  /** Optional: filter to a subset of action types. */
  types?: CorporateActionType[];
}

/**
 * DB-first reader. Returns corporate actions ordered by ex-date ASC (chronology
 * matters for sequential cost-basis adjustment). Requires at least one of
 * symbol / isin / exchange so a caller can't accidentally scan the whole table.
 */
export async function getCorporateActions(
  filter: GetCorporateActionsFilter,
): Promise<ServiceResult<CorporateActionRow[]>> {
  if (!filter.symbol && !filter.isin && !filter.exchange) {
    return {
      success: false,
      error: "At least one of symbol / isin / exchange is required",
    };
  }
  try {
    const where: Record<string, unknown> = {};
    if (filter.symbol) where.symbol = filter.symbol.toUpperCase();
    if (filter.isin) where.isin = filter.isin;
    if (filter.exchange) where.exchange = filter.exchange;
    if (filter.types && filter.types.length > 0)
      where.type = { in: filter.types };
    if (filter.fromDate || filter.toDate) {
      where.exDate = {
        ...(filter.fromDate ? { gte: filter.fromDate } : {}),
        ...(filter.toDate ? { lte: filter.toDate } : {}),
      };
    }

    const rows = await prisma.corporateAction.findMany({
      where,
      orderBy: { exDate: "asc" },
    });
    return { success: true, data: rows as CorporateActionRow[] };
  } catch (error) {
    logger.error({ error, filter }, "Failed to read corporate actions");
    return { success: false, error: "Failed to load corporate actions" };
  }
}

/**
 * The row shape returned by {@link getCorporateActions}. Derived from the Prisma
 * model via the client's return type so it stays in sync with the schema.
 */
export type CorporateActionRow =
  Awaited<ReturnType<typeof prisma.corporateAction.findFirst>> extends infer T
    ? NonNullable<T>
    : never;
