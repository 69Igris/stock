/**
 * L3/L4 comprehensive-analysis processor — PURE helpers (no Prisma / network).
 *
 * `l3-analysis.ts` used to compute the per-segment progress percentage inline
 * (`Math.round((segmentIndex / session.totalSegments) * 100)`) and the test
 * SHADOWED it with its own `calculateProgress` / `isSegmentCompleted` copies
 * plus an invented `calculateRefund` (the real, finite-guarded refund formula
 * is `computeReservationRefund` in @usemoney/services — already its own
 * real-source suite). These worker-owned bits now live here so `l3-analysis.ts`
 * imports and CALLS them and the test asserts the REAL code.
 *
 * @see workers/src/processors/l3-analysis.ts (caller)
 * @see apps/web/__tests__/workers/l3-analysis.test.ts (tests the real exports)
 */

/** Minimal shape of a segment as persisted on AnalysisSession.segments. */
export interface L3SegmentLike {
  status?: string;
}

/**
 * Progress percent (0–100) for the segment about to run.
 *
 * BUG GUARD (MONEY-620): the live formula was
 * `Math.round((segmentIndex / session.totalSegments) * 100)`. A session with
 * `totalSegments = 0` (corrupt/empty config) makes that `NaN`, which was then
 * written straight to `AnalysisSession.progress` (an Int column / JSON) and
 * rendered as "NaN%" on the analysis page. `0 / 0` and any non-finite result
 * now collapse to 0, and the output is clamped to [0, 100].
 */
export function computeSegmentProgress(
  segmentIndex: number,
  totalSegments: number,
): number {
  const idx = Number.isFinite(segmentIndex) ? segmentIndex : 0;
  const total = Number.isFinite(totalSegments) ? totalSegments : 0;
  if (total <= 0) return 0;
  const pct = Math.round((idx / total) * 100);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Idempotency check: has the segment at `index` already completed? Used to
 * skip re-running a segment when a Pub/Sub message is redelivered. Out-of-range
 * indices and missing rows are treated as "not completed".
 */
export function isSegmentCompleted(
  segments: readonly L3SegmentLike[],
  index: number,
): boolean {
  const seg = segments[index];
  return seg ? seg.status === "completed" : false;
}
