/**
 * Pure helpers for `persistence.ts` — MONEY-1205.
 *
 * Split out because `persistence.ts` imports Prisma at module load, which is
 * exactly why the existing fallback test inlines "a fake Prisma client + the
 * helper logic" rather than importing the real module: it asserts a
 * re-implementation, so it stays green when the real one breaks. Logic that
 * needs proving lives here, where a test can import the thing that actually
 * runs in production.
 */

/**
 * Decide what `rawData` this row should carry — MONEY-1205.
 *
 * `rawData` is the raw material every later repair depends on:
 * `scripts/data/backfill-financials-from-rawdata.ts` re-projects the 11 columns
 * prod is missing straight out of it. Two bugs made it useless here.
 *
 * 1. The three fetch tools passed the WHOLE statement array
 *    (`rawData: ttIncome`), which was then written onto every period row of
 *    that symbol — so five annual rows each held the same five-element array
 *    instead of their own. The backfill sees a non-object and buckets the row
 *    `unmappable`; it cannot fail loudly, because an array is a legal `Json?`.
 * 2. The upsert wrote `rawData: opts.rawData ?? null` on UPDATE, so a persist
 *    that carried no payload NULLED a good per-row payload that a previous
 *    writer had stored. This helper is what lets the caller OMIT the key
 *    instead — the same absent-is-not-null rule the numeric columns follow.
 *
 * This path is fire-and-forget (`persistFinancialFallbackInBackground`) and
 * swallows its errors, so neither bug could ever surface as a failure.
 *
 * Returns `undefined` when nothing row-specific is known, which the caller must
 * treat as "leave `rawData` alone".
 */
export function resolveRowRawData(
  row: { raw?: unknown },
  callRawData: unknown,
): Record<string, unknown> | undefined {
  if (isPlainRecord(row.raw)) return row.raw;
  // An array is the statement HISTORY, never one row's payload. Rejected rather
  // than stored, because storing it silently destroys what was there.
  if (isPlainRecord(callRawData)) return callRawData;
  return undefined;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
