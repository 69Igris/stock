/**
 * MF-sync processor — PURE orchestration logic (no network / Prisma).
 *
 * `mf-sync.ts` delegates the heavy lifting to `syncAmfiMutualFunds` (which fetches
 * the AMFI NAVAll.txt feed and writes MutualFundMaster). The only worker-level
 * orchestration is (a) reading the `forceFullSync` flag and (b) bounding how many
 * upstream errors get logged. Those side-effect-free bits are extracted here so
 * the test asserts the REAL symbol instead of an inline copy that "mirrors the
 * source". `mf-sync.ts` imports and CALLS these. Mirrors `import-logic.ts`.
 *
 * @see workers/src/processors/mf-sync.ts (caller)
 * @see apps/web/__tests__/workers/mf-sync.test.ts (tests the real exports)
 */

/** Max number of AMFI parse/upsert error strings logged after a sync run. */
export const MF_SYNC_ERROR_LOG_CAP = 10;

/**
 * Resolve the `forceFullSync` flag from the MF-sync job message (default false).
 * `syncAmfiMutualFunds` itself takes no args today, so this flag only governs the
 * processor's own log line — but centralizing the default keeps the processor and
 * its test reading the same source instead of a hand-copied `?? false`.
 */
export function resolveForceFullSync(data: { forceFullSync?: boolean }): boolean {
  return data.forceFullSync ?? false;
}

/** Cap an AMFI error list to `MF_SYNC_ERROR_LOG_CAP` for logging. */
export function capMfErrorsForLog(errors: string[]): string[] {
  return errors.slice(0, MF_SYNC_ERROR_LOG_CAP);
}

// ============== COMPLETENESS (MONEY-1404 C1) ==============

/**
 * How much of the active universe may go un-priced before the run is a failure.
 *
 * MEASURED, not chosen: on prod's last healthy run (2026-08-18 22:31 IST) the
 * sync touched 14,034 of 14,225 active schemes — **191 missing, 1.343%**. Those
 * 191 are real and permanent: AMFI drops a scheme from NAVAll when it matures
 * or merges, and NOTHING in this codebase ever sets `isActive: false` (prod
 * holds 14,225 active and ZERO inactive), so the gap is a floor that only
 * grows.
 *
 * RE-MEASURED 2026-09-13 against the LIVE feed, because a threshold that
 * THROWS deserves a number that is not 26 days old. Fetched NAVAll (200,
 * 1,519,175 B), parsed it with the shipped `parseAmfiFeed`, and intersected
 * with prod's active masters:
 *
 *   file lists                        14,361 distinct scheme codes
 *   parseAmfiFeed prices              14,120
 *   listed but not priced (nav <= 0)     241
 *   ---------------------------------------
 *   active masters                    14,225
 *     NOT in the file at all             199   <- the whole of `missing`
 *     in the file but not priced           0
 *   projected missing                    199   = 1.399%
 *
 * So the gap moved 191 -> 199 in 26 days and the headroom is ~0.6pp, about 85
 * more dead schemes.
 *
 * THE 241 UNPRICED CODES ARE NOT PART OF THIS, and the arithmetic that says
 * otherwise is the trap worth naming: `241 / 14,361` is 1.678% and looks like
 * it has eaten most of the headroom, but it divides a count of FEED codes by a
 * count of FEED codes while the gate divides MASTERS by MASTERS. Measured, the
 * intersection is ZERO — every code AMFI lists at nav <= 0 belongs to a scheme
 * we do not hold active. Two populations, one ratio, no overlap.
 *
 * 0.6pp is still the real ceiling on this constant, and it is why the number
 * lives here with its measurement rather than inline: when this starts firing
 * on healthy nights the fix is a deactivation rule for schemes AMFI has
 * dropped, NOT a bigger threshold. Raising it past ~3% would hide a whole AMC
 * (the largest, NIPPON, is ~4% of the universe).
 *
 * Re-measure before touching it. The command is in scripts/README.md under
 * `audit-etf-expense-ratio.ts`'s neighbours; the shape is: fetch NAVAll, run it
 * through `parseAmfiFeed`, and count active masters whose `schemeCode` the file
 * does not list.
 */
export const MF_SYNC_MAX_MISSING_PCT = 2;

/** At most this many scheme codes ride along in the failure message. */
export const MF_SYNC_MISSING_SAMPLE_CAP = 20;

export interface MfSyncCompleteness {
  /** False when more than {@link MF_SYNC_MAX_MISSING_PCT} went un-priced. */
  ok: boolean;
  missingCount: number;
  /** 0-100, not 0-1. */
  missingPct: number;
  /** Up to {@link MF_SYNC_MISSING_SAMPLE_CAP} of the missing scheme codes. */
  sample: string[];
}

/**
 * Did N active schemes produce N NAVs?
 *
 * ## Why this exists
 *
 * `syncAmfiMutualFunds` throws when the feed parses to ZERO — the MONEY-1403
 * shape, where AMFI moved two columns and 26 nights of `parsed=0` read as
 * success. That guard cannot see the PARTIAL: a grammar change that breaks one
 * AMC's block, a truncated download, a fan-out that quietly stops half way.
 * 7,000 of 14,225 schemes is not a zero and is not a normal night either, and
 * nothing in this pipeline had an opinion about it.
 *
 * ## Why the input is the MISSING CODES and not the parsed ones
 *
 * MONEY-1404 sketched this as `{activeSchemes, parsedSchemeCodes}` — a set
 * difference over both sides. Two things made the DB the better place to do the
 * difference:
 *
 *   - handing the worker every parsed code means a new field on
 *     `AmfiSyncResult`, and three `const result: AmfiSyncResult = {...}`
 *     literals in `apps/web/__tests__` construct that type by hand. A required
 *     field breaks their type-check; an OPTIONAL one makes "absent" and "zero
 *     schemes parsed" the same value at the exact call site whose entire job is
 *     to tell those two apart.
 *   - the master row carries `lastSyncedAt`, stamped by the upsert on every
 *     write, so "which active schemes did tonight's run NOT touch" is one
 *     indexed query that returns ~191 rows — and it names them, which a count
 *     difference cannot.
 *
 * So the caller supplies the codes the database says were missed; this decides
 * whether that is a bad night or a broken feed, and caps the sample.
 */
export function judgeMfSyncCompleteness(input: {
  /** Active schemes in `MutualFundMaster` after the run. */
  activeSchemes: number;
  /** Active schemes this run did NOT write. */
  missingSchemeCodes: readonly string[];
}): MfSyncCompleteness {
  const missingCount = input.missingSchemeCodes.length;
  // Zero active schemes is not a shortfall — it is an empty table, which is a
  // different failure and belongs to whatever first populates it. Guarding the
  // division here keeps `missingPct` finite for every input rather than
  // emitting NaN into a log line nobody can filter on.
  const missingPct =
    input.activeSchemes > 0 ? (missingCount / input.activeSchemes) * 100 : 0;

  return {
    ok: missingPct <= MF_SYNC_MAX_MISSING_PCT,
    missingCount,
    missingPct,
    sample: input.missingSchemeCodes.slice(0, MF_SYNC_MISSING_SAMPLE_CAP),
  };
}
