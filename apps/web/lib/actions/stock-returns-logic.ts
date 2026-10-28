/**
 * Pure return-window helpers (MONEY-244), extracted from the "use server"
 * getStockReturnsAction so they're testable without Prisma. The action fetches
 * the desc-sorted closes and calls these; the most-recent row is index 0.
 */

/** A daily close row, most-recent-first (matches Prisma `orderBy: date desc`). */
export interface CloseRow {
  date: Date;
  close: number;
}

/**
 * Index of the first close at or before `targetDays` ago (relative to the
 * latest close, index 0). Returns -1 when no such row exists (or no data).
 */
export function findCloseIndexAtOrBefore(
  closes: CloseRow[],
  targetDays: number
): number {
  if (closes.length === 0) return -1;
  const latest = closes[0]!;
  const targetTime = latest.date.getTime() - targetDays * 24 * 60 * 60 * 1000;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i]!.date.getTime() <= targetTime) return i;
  }
  return -1;
}

/**
 * Percent return from the close at `idx` to the latest close (index 0).
 * Returns null for an out-of-range index or a non-positive past close (a data
 * error — avoids a divide-by-zero / nonsensical %).
 */
export function pctReturnTo(closes: CloseRow[], idx: number): number | null {
  if (idx < 0 || idx >= closes.length) return null;
  const past = closes[idx]!.close;
  if (!past || past <= 0) return null;
  const latest = closes[0]!;
  return ((latest.close - past) / past) * 100;
}
