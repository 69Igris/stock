/**
 * Sector Enrichment — Pure Logic
 *
 * Pure, side-effect-free helpers used by `sector-enrichment.ts` to partition
 * instruments, decide per-instrument enrichment outcomes, and group pending
 * DB updates. Extracted so the exact classification/decision pipeline that
 * production runs can be unit-tested without a database or network.
 *
 * `sector-enrichment.ts` imports and calls these — no parallel copies.
 */

import { isUnfetchableYahooSymbol } from "./types";
import { toWritableNseSector } from "./sector-taxonomy";

/** Sentinel value for instruments that Yahoo Finance cannot resolve. */
export const SECTOR_SKIPPED = "N/A";

export interface EnrichableInstrument {
  id: string;
  symbol: string;
  exchange: string;
  yahooSymbol: string;
}

/** A (symbol, exchange) pair — the natural key for an InstrumentMapping lookup. */
export interface SymbolKey {
  symbol: string;
  exchange: string;
}

/**
 * De-duplicate + bound a set of (symbol, exchange) keys for an on-demand
 * sector-enrichment pass. Used by `enrichInstrumentsBySymbol` so a single
 * holdings read can opportunistically enrich the handful of newly-bought /
 * newly-listed names that the weekly cron hasn't reached yet — WITHOUT
 * spawning one Yahoo call per holding for a large un-enriched portfolio.
 *
 * - Empty/whitespace symbols or exchanges are dropped (never queryable).
 * - Keys are case-folded on `${symbol}:${exchange}` for de-dup only; the first
 *   occurrence's original casing is preserved for the DB query.
 * - `max` caps the result (default 25); extra keys are left for the cron.
 *
 * Pure + side-effect-free so the selection/bounding is unit-tested without a DB.
 */
export function selectSymbolKeysToEnrich(
  keys: SymbolKey[],
  max = 25,
): SymbolKey[] {
  if (!Array.isArray(keys) || max <= 0) return [];
  const seen = new Set<string>();
  const out: SymbolKey[] = [];
  for (const k of keys) {
    const symbol = typeof k?.symbol === "string" ? k.symbol.trim() : "";
    const exchange = typeof k?.exchange === "string" ? k.exchange.trim() : "";
    if (!symbol || !exchange) continue;
    const dedupKey = `${symbol.toUpperCase()}:${exchange.toUpperCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ symbol, exchange });
    if (out.length >= max) break;
  }
  return out;
}

export interface SectorData {
  sector: string | null;
  industry: string | null;
}

export interface PendingSectorUpdate {
  id: string;
  sector: string;
  industry: string | null;
}

/**
 * The outcome bucket for a single instrument after a fetch attempt.
 * - "enriched": a real sector was found → write normalized sector/industry
 * - "skipped": no usable sector (null result, or a 404) → write the SKIPPED sentinel
 * - "failed": the fetch could not be COMPLETED (transport/HTTP outage, or any
 *   non-404 error) → record the error message, WRITE NOTHING, retry next run
 */
export type EnrichmentOutcomeKind = "enriched" | "skipped" | "failed";

// ── MONEY-1238 (#7): "no profile" vs "could not ask" ────────────────────────
//
// `SECTOR_SKIPPED` is effectively PERMANENT: the enrichment selector only picks
// rows whose sector is null/empty, and even `forceReEnrich` excludes the
// sentinel. So writing it is a claim that Yahoo has no profile for this symbol
// and never will.
//
// The fetchers could not make that claim honestly. `fetchQuoteSummary` catches
// EVERY error and returns `null`, so "Yahoo 500ed / timed out / blocked our
// egress" arrived as the same value as "this ETF has no assetProfile" — and the
// null branch wrote the permanent sentinel. One bad night marked the whole
// batch N/A forever, and the run reported `failed=0` because the "failed"
// branch was unreachable for any network fault.
//
// The rule this broke is the repo's standing one: NEVER CACHE A FAIL-OPEN
// DEFAULT. Make "couldn't determine" a DISTINCT value and key on DETERMINACY,
// not on the value. The three states below are that distinction, and both
// entry points into the decision honour it:
//
//   `decideFetchOutcome`  — accepts SECTOR_FETCH_UNAVAILABLE as a third return
//                           value for a fetcher that reports rather than throws.
//   `decideErrorOutcome`  — recognises `SectorFetchUnavailableError` FIRST, so
//                           a tagged transport failure can never be reclassified
//                           as a permanent skip by its message text.

/**
 * Third state for a sector fetch: the fetch itself did not complete.
 *
 * NOT a sector value and never written. Distinct from `null`, which means "a
 * well-formed answer that genuinely carries no profile".
 */
export const SECTOR_FETCH_UNAVAILABLE = "UNAVAILABLE" as const;

/** What a three-state sector fetcher may return. */
export type SectorFetchResult =
  | SectorData
  | null
  | typeof SECTOR_FETCH_UNAVAILABLE;

/**
 * A sector fetch that failed in TRANSPORT — timeout, network fault, 403 egress
 * block, 429, 5xx, a malformed body. Says nothing whatsoever about the symbol.
 *
 * Tagged by a `name` string rather than by `instanceof` alone: this error
 * crosses a package boundary (workers → @usemoney/core) and, under a bundler
 * that duplicates the module, `instanceof` against a second copy of the class
 * silently returns false — which here would mean falling through to the "404"
 * text rule and writing a PERMANENT sentinel. {@link isSectorFetchUnavailable}
 * checks both.
 */
export class SectorFetchUnavailableError extends Error {
  readonly name = "SectorFetchUnavailableError";
  /** Marker that survives a duplicated module copy. */
  readonly isSectorFetchUnavailable = true as const;
  readonly cause: unknown;

  constructor(symbol: string, cause: unknown) {
    super(
      `${symbol}: sector fetch unavailable — ${
        cause instanceof Error
          ? cause.message
          : String(cause ?? "unknown error")
      }`,
    );
    this.cause = cause;
  }
}

/** True for a {@link SectorFetchUnavailableError}, across module copies. */
export function isSectorFetchUnavailable(error: unknown): boolean {
  if (error instanceof SectorFetchUnavailableError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isSectorFetchUnavailable?: unknown })
      .isSectorFetchUnavailable === true
  );
}

/**
 * True when a fetch error is a permanent statement about the SYMBOL rather than
 * about the transport — i.e. Yahoo answered, and its answer was "no such
 * symbol". Only that class may be written down as {@link SECTOR_SKIPPED}.
 *
 * Deliberately a LOOSE 404 test rather than the anchored status parse in
 * `yahoo-api.ts` (`yahooErrorStatus`): this predicate also has to classify
 * errors raised by injected fetchers and by the web/on-demand path, whose
 * wording is not yahooFetch's. The two are not duplicates of one rule — that
 * one recovers a status code from a yahooFetch rejection, this one decides
 * whether a sector fetch failure is permanent — and the loose test is safe here
 * ONLY because a tagged transport failure is checked first.
 *
 * Reads the raw message, NOT the `symbol: message` string the caller builds: a
 * symbol containing "404" must not condemn its own row.
 */
export function isPermanentSymbolError(error: unknown): boolean {
  // NON-Error throws are never permanent. The rule this replaced read
  // `error instanceof Error ? error.message : "Unknown error"`, so a thrown
  // bare string "404 ..." fell through to FAILED; widening it to
  // `String(error)` would have turned that case into a permanent WRITE, which
  // is the one direction this fix must never drift in.
  const msg = error instanceof Error ? error.message : "";
  return msg.includes("404");
}

/**
 * Wrap a swallowed fetch error for re-throw by a sector fetcher.
 *
 * A permanent 404 is handed back RAW so {@link decideErrorOutcome}'s existing
 * skip rule still applies to it. Everything else is TAGGED, which makes it
 * un-skippable regardless of what its message happens to contain.
 */
export function toSectorFetchError(symbol: string, error: unknown): unknown {
  if (isSectorFetchUnavailable(error)) return error;
  if (isPermanentSymbolError(error)) return error;
  return new SectorFetchUnavailableError(symbol, error);
}

export interface EnrichmentOutcome {
  kind: EnrichmentOutcomeKind;
  update?: PendingSectorUpdate;
  error?: string;
}

/**
 * Split instruments into those Yahoo can't price (unfetchable → mark SKIPPED in
 * one batch) and those we should fetch. Mirrors the first pass of enrichSectors.
 */
export function partitionFetchable(instruments: EnrichableInstrument[]): {
  skippedIds: string[];
  fetchable: EnrichableInstrument[];
} {
  const skippedIds: string[] = [];
  const fetchable: EnrichableInstrument[] = [];
  for (const instrument of instruments) {
    if (isUnfetchableYahooSymbol(instrument.yahooSymbol)) {
      skippedIds.push(instrument.id);
    } else {
      fetchable.push(instrument);
    }
  }
  return { skippedIds, fetchable };
}

/**
 * Decide the outcome for a fetch that COMPLETED (`sectorData` may be null or
 * have a null sector). A real sector → "enriched" with normalized values;
 * otherwise → "skipped" with the SKIPPED sentinel.
 *
 * {@link SECTOR_FETCH_UNAVAILABLE} is the third state and is NOT a completed
 * fetch: it returns "failed" with NO `update`, so the caller counts it and
 * writes nothing. Without that branch a fetcher which reports an outage by
 * value instead of by throwing would land in the `null` case below and stamp a
 * permanent N/A — the whole defect, one layer up.
 *
 * A FOURTH outcome (MONEY-1302): the fetch completed and carried a sector the
 * NSE taxonomy does not recognise. That is also "failed" with no `update` —
 * see the guard inline below. Both enrichment entry points in
 * `sector-enrichment.ts` (the weekly `enrichSectors` and the on-demand
 * `enrichInstrumentsBySymbol`) route through this one function, so guarding it
 * covers every Yahoo-driven write without a second copy of the rule.
 */
export function decideFetchOutcome(
  instrument: EnrichableInstrument,
  sectorData: SectorFetchResult,
): EnrichmentOutcome {
  if (sectorData === SECTOR_FETCH_UNAVAILABLE) {
    return {
      kind: "failed",
      error: `${instrument.symbol}: sector fetch unavailable (upstream did not answer) — not written`,
    };
  }
  if (sectorData && sectorData.sector) {
    // MONEY-1302 — the WRITE guard. `normalizeToNseSector` used to sit here,
    // and it ends in `return rawSector`: a label with no alias was written
    // VERBATIM. Off-taxonomy values are unreachable by the screener's sector
    // facet AND excluded from re-enrichment (the selector only revisits
    // null/empty sectors), so such a row is permanent and silent — nothing
    // fails, nothing logs, and it surfaces only when somebody counts distinct
    // values by hand. That is precisely how the 101 rows on prod accumulated.
    const writable = toWritableNseSector(sectorData.sector);
    if (writable === null) {
      // A THIRD state, not a skip. Yahoo ANSWERED, so `SECTOR_SKIPPED` would be
      // a permanent lie ("no profile exists") about a symbol that plainly has
      // one — the fail-open-default trap this module already fell into once
      // (MONEY-1238). Write nothing, name the label loudly so an alias can be
      // added to YAHOO_TO_NSE_MAP, and let the next run pick the row up.
      return {
        kind: "failed",
        error:
          `${instrument.symbol}: upstream sector "${sectorData.sector}" is not in ` +
          `the NSE taxonomy — not written. Add an alias to YAHOO_TO_NSE_MAP ` +
          `(packages/core/src/market-data/instruments/sector-taxonomy.ts).`,
      };
    }
    return {
      kind: "enriched",
      update: {
        id: instrument.id,
        sector: writable,
        industry: sectorData.industry,
      },
    };
  }
  return {
    kind: "skipped",
    update: {
      id: instrument.id,
      sector: SECTOR_SKIPPED,
      industry: SECTOR_SKIPPED,
    },
  };
}

/**
 * Decide the outcome for a fetch that THREW.
 *
 * Order is load-bearing (MONEY-1238 #7):
 *   1. A TAGGED transport failure is "failed" unconditionally — never skipped,
 *      whatever its message says. This is the guard that stops an outage from
 *      being written down as a permanent fact.
 *   2. A 404 is a permanent statement about the symbol → "skipped".
 *   3. Anything else → "failed" with a `symbol: message` string.
 *
 * Only rule 2 produces a WRITE. Both failure rules leave the row untouched so
 * the next run retries it.
 */
export function decideErrorOutcome(
  instrument: EnrichableInstrument,
  error: unknown,
): EnrichmentOutcome {
  const msg = `${instrument.symbol}: ${
    error instanceof Error ? error.message : "Unknown error"
  }`;

  if (isSectorFetchUnavailable(error)) {
    return { kind: "failed", error: msg };
  }

  if (isPermanentSymbolError(error)) {
    return {
      kind: "skipped",
      update: {
        id: instrument.id,
        sector: SECTOR_SKIPPED,
        industry: SECTOR_SKIPPED,
      },
    };
  }
  return { kind: "failed", error: msg };
}

/**
 * Group pending updates by their (sector, industry) pair so each distinct pair
 * can be written with a single updateMany. Mirrors the flushUpdates grouping.
 * Returns the grouped writes; an empty `industry` string maps back to null.
 */
export function groupPendingUpdatesByData(
  pendingUpdates: PendingSectorUpdate[],
): Array<{ sector: string; industry: string | null; ids: string[] }> {
  const byData = new Map<string, string[]>();
  for (const u of pendingUpdates) {
    const key = `${u.sector}|||${u.industry ?? ""}`;
    const ids = byData.get(key);
    if (ids) ids.push(u.id);
    else byData.set(key, [u.id]);
  }
  return Array.from(byData.entries()).map(([key, ids]) => {
    const [sector, industry] = key.split("|||");
    return { sector: sector as string, industry: industry || null, ids };
  });
}
