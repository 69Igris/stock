/**
 * Sanitised failure strings for the sector deep-dive, shared by the action and
 * the panel that renders it.
 *
 * A plain module rather than part of `sector-deep-dive.ts`, because that file
 * is `"use server"` and Next requires every export from one to be an async
 * function.
 *
 * ## Why the panel needs to tell these apart
 *
 * The action deliberately sanitises failures — the previous version returned
 * `error.message` verbatim and put raw Prisma/Mongo text in front of users.
 * That rule stands. But collapsing every failure into one string also threw
 * away the one distinction that changes what the user should DO, because the
 * common failure here is not "something broke", it is "this took too long".
 *
 * These are fixed constants, not error text: they carry no driver detail, no
 * query, no stack. The detail still goes to the log.
 *
 * ## Why timeouts are the common case (measured, 2026-08-26)
 *
 * `cachedWithStaleFallback`'s single-flight backstop rejects at 25s. Timing
 * the compute's DB legs against prod data, on a cold cache:
 *
 *     Energy                    2.2s     9% of the deadline
 *     Financial Services        6.4s    25%
 *     Consumer Discretionary    9.6s    38%
 *     Commodities              12.0s    48%
 *     Industrials              14.1s    56%
 *
 * …and that is DB time alone, before the FII/DII and earnings legs. The same
 * daily-price query, fetching a near-identical ~4,500 rows, was separately
 * observed at 1.5s and at 11.1s — several seconds of ordinary variance on a
 * budget the heavy sectors already spend half of. That is the whole mechanism:
 * heavy sector + cold cache + a slow patch = past 25s.
 *
 * It is NOT a bad query plan. `DailyPrice` is indexed `@@unique([instrumentId,
 * date])`, which covers the filter, and dropping the `orderBy` to avoid the
 * cross-instrument sort measured no reliable improvement (2054ms vs 966ms on
 * one sector, 707ms vs 1102ms on another — noise, in both directions).
 *
 * So the honest fix is not a micro-optimisation. It is fewer serial hops or a
 * larger budget, and until then the panel should say "this was slow, try
 * again" rather than implying something is broken.
 */

/** The compute exceeded the 25s single-flight deadline. Transient; retry works. */
export const SECTOR_DEEP_DIVE_TIMEOUT_ERROR = "Sector deep-dive timed out";

/** Anything else that failed. Detail is in the server log, never here. */
export const SECTOR_DEEP_DIVE_FAILED_ERROR = "Failed to load sector deep-dive";

export type SectorDeepDiveFailureKind = "timeout" | "not-found" | "generic";

/**
 * Classify a failure string for display.
 *
 * `not-found` is matched on the SectorNotFoundError text, which the action
 * passes through unsanitised on purpose — it is a permanent answer ("nothing
 * is mapped here"), not an outage, and the panel says so instead of offering a
 * pointless retry.
 */
export function classifySectorDeepDiveError(
  error: string | null | undefined
): SectorDeepDiveFailureKind {
  if (!error) return "generic";
  if (error === SECTOR_DEEP_DIVE_TIMEOUT_ERROR) return "timeout";
  if (/no instruments mapped/i.test(error)) return "not-found";
  return "generic";
}
