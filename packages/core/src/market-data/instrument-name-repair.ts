/**
 * The two decisions behind the instrument-name repair — MONEY-1205.
 *
 * Consumed by `scripts/data/repair-instrument-names.ts`. Kept OUT of that
 * script deliberately, exactly like `series-readiness.ts` was pulled out of
 * `reclassify-instruments.ts` in MONEY-1196: the defect that motivates a repair
 * script is usually invisible precisely because the arithmetic lives inline
 * where nothing can assert on it.
 *
 * ## What was broken
 *
 * `parseCSV` in `instruments/zerodha-instruments-logic.ts` split Kite's
 * `/instruments` dump on `line.split(",")`. Kite quotes its `name` column
 * (106,262 of 114,427 lines), so the quotes were kept as part of the value:
 * **13,287 of 26,669 prod instrument names (49.8%) were stored wrapped in
 * literal double quotes**, including 540 of the 541 active ETFs.
 *
 * The parser is fixed. This module decides what a safe repair of the existing
 * rows looks like, and — the load-bearing half — whether repairing is even
 * worth doing yet.
 */

/**
 * How old the newest row may be for its evidence to count, in hours.
 *
 * The instrument-sync runs daily at 22:00 IST, so 36h always spans the previous
 * run while excluding a long-idle database, where the newest row predates the
 * deploy and therefore proves nothing in either direction.
 */
export const RECENT_SYNC_HOURS = 36;

/**
 * Strip ONE symmetric pair of wrapping double quotes.
 *
 * Idempotent on this data by construction: the corruption is exactly one pair
 * deep — measured on prod, zero rows carry an odd number of quote characters
 * and zero have interior-only quotes — so a second pass matches nothing.
 *
 * Returns the input UNCHANGED when it is not fully wrapped, when stripping
 * would empty the value, or when the string is too short to hold two distinct
 * delimiters. That last case is not pedantry: `'"'` is a one-character name and
 * `slice(1, -1)` on it yields `""`, which would look "fixed" while destroying
 * the only human-readable label the row has. `mapToUpsert` falls back to the
 * symbol for empty names, so the damage would not surface until someone looked.
 *
 * Asymmetric quoting (`"HALF OPEN`, `MID"DLE`) is a DIFFERENT defect and is
 * left alone. Guessing at it is how a display bug becomes data loss, and there
 * is no history column on `InstrumentMapping` to recover from.
 */
export function stripWrappingQuotes(name: string): string {
  if (name.length < 2) return name;
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  const inner = name.slice(1, -1);
  if (!inner.trim()) return name;
  return inner;
}

/** Evidence about whether the fixed parser is live, plus the verdict. */
export interface ParserFixVerdict {
  /** Newest `updatedAt` in the collection, or null when it is empty. */
  lastSyncAt: Date | null;
  /** Did a sync run recently enough for its evidence to count? */
  recentSync: boolean;
  /** Quoted rows written by that most recent run. */
  quotedInLastRun: number;
  /** false ⇒ the newest sync wrote quoted names ⇒ the fix is NOT deployed. */
  live: boolean;
  /** Why, in one line, for the operator. */
  reason: string;
}

/**
 * Decide whether the fixed parser is live, from data alone.
 *
 * ## Why this gate has to exist
 *
 * `ZerodhaInstrumentProvider.mapToUpdate` destructures away only `series` and
 * `instrumentType`. **`name` stays in the spread and is rewritten on EVERY
 * nightly UPDATE.** 12,377 of the 13,287 corrupt rows carried
 * `updatedAt = 2026-08-17` — the 22:00 IST instrument-sync had re-stamped them
 * the night before. So a repair applied against a deployment whose parser is
 * still broken is reverted within 24 hours, silently. That is the MONEY-1093
 * class: the nightly writer undoing a deliberate repair with no error anywhere.
 *
 * ## The inference
 *
 * If the most recent instrument-sync WROTE rows whose names are still quoted,
 * the parser that ran was the broken one — a fixed parser could not have
 * produced them. That is direct evidence, and it is the only signal available
 * to a script that cannot see the deployed container image.
 *
 * ## Absent evidence is not negative evidence
 *
 * When no sync has run recently, an idle database says nothing about the
 * deployed code, and this returns `live: true` with a reason that says so. That
 * asymmetry is deliberate. Refusing on absent evidence would block the
 * legitimate "deploy the fix, then repair immediately" order — and MONEY-1196
 * is the standing lesson that a gate which anti-correlates with the thing it
 * guards is worse than no gate, because it looks like caution.
 *
 * The gate is also INVARIANT under the operation it gates: repairing names
 * changes `name`, but the verdict is read from whether the most recent SYNC
 * wrote quotes. A repair cannot flip its own gate open or closed.
 */
export function judgeParserFixLive(input: {
  lastSyncAt: Date | null;
  quotedInLastRun: number;
  now: Date;
}): ParserFixVerdict {
  const { lastSyncAt, quotedInLastRun, now } = input;

  if (!lastSyncAt) {
    return {
      lastSyncAt: null,
      recentSync: false,
      quotedInLastRun,
      live: true,
      reason: "no rows at all — nothing to infer from",
    };
  }

  const ageHours = (now.getTime() - lastSyncAt.getTime()) / 3_600_000;
  const recentSync = ageHours <= RECENT_SYNC_HOURS;

  if (!recentSync) {
    return {
      lastSyncAt,
      recentSync: false,
      quotedInLastRun,
      live: true,
      reason:
        `newest row is ${Math.round(ageHours)}h old (> ${RECENT_SYNC_HOURS}h), ` +
        `so no recent sync exists to judge — evidence absent, not negative`,
    };
  }

  if (quotedInLastRun > 0) {
    return {
      lastSyncAt,
      recentSync: true,
      quotedInLastRun,
      live: false,
      reason:
        `the most recent sync (${Math.round(ageHours)}h ago) wrote ` +
        `${quotedInLastRun} rows whose names are STILL quoted — a fixed parser ` +
        `could not have produced them`,
    };
  }

  return {
    lastSyncAt,
    recentSync: true,
    quotedInLastRun: 0,
    live: true,
    reason:
      `the most recent sync (${Math.round(ageHours)}h ago) wrote no quoted ` +
      `names — the fixed parser is running`,
  };
}
