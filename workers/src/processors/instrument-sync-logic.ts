/**
 * Instrument-sync processor — PURE orchestration logic (no Prisma / network).
 *
 * Side-effect-free helpers extracted out of `instrument-sync.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting
 * the `@usemoney/core/market-data` sync pipeline (which opens a Prisma client +
 * fetches the broker instrument dump at call time). `instrument-sync.ts` imports
 * and CALLS every export here, so the production code path and the tests execute
 * the SAME code. Mirrors the worker precedent `import-logic.ts` / `pairing-logic.ts`.
 *
 * What lives here (all side-effect-free):
 *   - `resolveInstrumentSyncOptions` — the default-resolution the processor feeds
 *     to `syncInstruments` (`exchanges` default `["NSE","BSE"]`, `forceFullSync`
 *     default `false`). The OLD inline shadow asserted these against a copy; this
 *     is now the single source the processor and the test both run.
 *   - `RECENT_SYNC_WINDOW_HOURS` — the "skip if synced within N hours" window the
 *     processor passes to `hasRecentSync` (20h). A regression on this silently
 *     re-pulls the multi-MB instrument dump every run.
 *   - `shouldSkipRecentSync` — whether to short-circuit (recent + not forced).
 *   - `INSTRUMENT_ERROR_LOG_CAP` + `capErrorsForLog` — the `slice(0, 10)` bound on
 *     how many per-provider errors are logged (a pathological all-rows-fail batch
 *     must not spam thousands of warn lines).
 *
 * @see workers/src/processors/instrument-sync.ts (caller)
 * @see apps/web/__tests__/workers/instrument-sync.test.ts (tests the real exports)
 */

/** Default exchanges synced when the job message omits an explicit list. */
export const DEFAULT_INSTRUMENT_EXCHANGES: readonly string[] = ["NSE", "BSE"];

/**
 * Window (hours) for the "already synced recently" guard. The processor skips a
 * non-forced sync when `hasRecentSync("ZERODHA", RECENT_SYNC_WINDOW_HOURS)` is
 * true, so a re-trigger inside the window does not re-pull the full instrument
 * master dump.
 */
export const RECENT_SYNC_WINDOW_HOURS = 20;

/** Max number of per-provider error strings logged after a sync run. */
export const INSTRUMENT_ERROR_LOG_CAP = 10;

/** Resolved options handed to `syncInstruments`. */
export interface ResolvedInstrumentSyncOptions {
  exchanges: string[];
  forceFullSync: boolean;
}

/**
 * Resolve the instrument-sync options from the job message. `exchanges` defaults
 * to `DEFAULT_INSTRUMENT_EXCHANGES` (NSE + BSE) and `forceFullSync` to `false`.
 * A provided-but-empty `exchanges` array is preserved verbatim (the caller asked
 * for no exchanges); only an `undefined`/missing value triggers the default.
 */
export function resolveInstrumentSyncOptions(data: {
  exchanges?: string[];
  forceFullSync?: boolean;
}): ResolvedInstrumentSyncOptions {
  return {
    exchanges: data.exchanges ?? [...DEFAULT_INSTRUMENT_EXCHANGES],
    forceFullSync: data.forceFullSync ?? false,
  };
}

/**
 * True when the sync should be skipped because a recent sync exists and the job
 * is not forcing a full re-sync. A forced sync (`forceFullSync === true`) never
 * skips, regardless of how recently the last sync ran.
 */
export function shouldSkipRecentSync(
  hasRecent: boolean,
  forceFullSync: boolean,
): boolean {
  return !forceFullSync && hasRecent;
}

/** Cap a provider's error list to `INSTRUMENT_ERROR_LOG_CAP` for logging. */
export function capErrorsForLog(errors: string[]): string[] {
  return errors.slice(0, INSTRUMENT_ERROR_LOG_CAP);
}
