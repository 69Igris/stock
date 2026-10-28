/**
 * The macro-sync RUN VERDICT — PURE (no Prisma, no network) — MONEY-1238.
 *
 * ## The defect this closes
 *
 * `processMacroSync` judged a run with
 *
 *     ok = results.every((r) => r.fetched && r.recognised && r.parsed > 0)
 *
 * — three fetch/parse properties and nothing about the WRITE. `written` was
 * computed, logged, returned in the result, and read by nobody who decides
 * anything. So a run in which every single `macroSeries.upsert` threw produced
 * `written: 0, parsed: 90, ok: true`, the route answered 200, Pub/Sub acked,
 * and the log line looked healthy in every field an operator scans.
 *
 * That is worse here than it would be almost anywhere else in this repo. The
 * three RBI pages are ROLLING WINDOWS, and `param=2` (forex reserves) serves
 * exactly ONE "as on" column — measured 2026-08-13. A bhavcopy missed today can
 * be re-walked from NSE next week; a forex column we acked without storing is
 * gone. The `macro-sync-midweek` Tuesday run is the ONLY second chance, and it
 * only helps if the Saturday run admitted it failed.
 *
 * ## Why the verdict is a function and not an expression
 *
 * The route turns `ok` into an HTTP code, so the verdict IS the decider. Kept
 * pure and separate so it can be tested without a Prisma client or an RBI page,
 * and so the failure REASON is a value rather than a boolean an operator has to
 * re-derive from six other fields.
 *
 * ## Partial writes are NOT ok — deliberately
 *
 * `writeObservations` catches per-row upsert failures and continues, so one bad
 * row never costs the other 89. That is the right INGEST behaviour and the
 * wrong REPORTING behaviour: a source that stored 89 of 90 observations has a
 * permanent hole in a page that cannot be re-read. `PARTIAL_WRITE` therefore
 * clears `ok`, the route 500s, and Pub/Sub redelivers — which is safe and cheap
 * because the write is an upsert on `(seriesId, period)`, so the 89 that landed
 * are no-ops and the 1 that failed gets another attempt.
 *
 * @see workers/src/processors/macro-sync.ts (the only caller)
 */

/**
 * The fields of a per-source result the verdict reads.
 *
 * A structural subset of `MacroSourceResult` rather than an import of it: this
 * module must not depend on the processor (which imports Prisma), and the
 * compiler still checks the real result satisfies it at the call site.
 */
export interface MacroSourceOutcome {
  /** Bytes came back (from the archive or from RBI). */
  fetched: boolean;
  /** The page carried a recognisable table. */
  recognised: boolean;
  /** Observations parsed out of the page. */
  parsed: number;
  /** Observations whose upsert SUCCEEDED. */
  written: number;
  /** Observations whose upsert THREW. Previously logged and nothing else. */
  writeFailed: number;
}

/**
 * Why a source is or is not ok. Ordered from earliest failure to latest, so the
 * first thing that went wrong is the thing that gets named.
 */
export type MacroSourceVerdict =
  | "OK"
  | "FETCH_FAILED"
  | "NO_TABLE"
  | "NO_TRACKED_SERIES"
  | "NOTHING_WRITTEN"
  | "PARTIAL_WRITE";

/**
 * Classify ONE source. Every branch is a state the ingest can genuinely reach
 * and that a reader would otherwise have to reconstruct from five numbers.
 */
export function judgeMacroSource(r: MacroSourceOutcome): MacroSourceVerdict {
  if (!r.fetched) return "FETCH_FAILED";
  if (!r.recognised) return "NO_TABLE";
  if (r.parsed === 0) return "NO_TRACKED_SERIES";
  // The MONEY-1238 branch: the page was fetched, recognised and parsed, and not
  // one row reached MongoDB. Indistinguishable from a healthy run under the old
  // `ok` expression.
  if (r.written === 0) return "NOTHING_WRITTEN";
  if (r.writeFailed > 0 || r.written < r.parsed) return "PARTIAL_WRITE";
  return "OK";
}

/** A source is ok only when every parsed observation was persisted. */
export function isMacroSourceOk(r: MacroSourceOutcome): boolean {
  return judgeMacroSource(r) === "OK";
}

/**
 * The RUN verdict.
 *
 * `length > 0` folds in the "the operator named ids that match nothing" case,
 * which `Array.every` alone reports as `true` — an empty run is not a clean
 * run, it is a run that did nothing.
 */
export function macroRunOk(results: readonly MacroSourceOutcome[]): boolean {
  return results.length > 0 && results.every(isMacroSourceOk);
}

/** The per-source verdicts that are not `OK`, for the failure log line. */
export function macroFailureReasons(
  results: ReadonlyArray<MacroSourceOutcome & { sourceId: string }>,
): Array<{ sourceId: string; verdict: MacroSourceVerdict }> {
  return results
    .map((r) => ({ sourceId: r.sourceId, verdict: judgeMacroSource(r) }))
    .filter((r) => r.verdict !== "OK");
}
