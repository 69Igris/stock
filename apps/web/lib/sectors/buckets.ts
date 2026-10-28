/* =====================================================================
   Sector bucket labelling  (MONEY-1092)
   ---------------------------------------------------------------------
   Deliberately NOT in `lib/actions/sector-heatmap.ts`: that file carries
   the "use server" directive, and Next only permits async function
   exports from a server-action module. A pure helper exported from there
   fails the build with

       Only async functions are allowed to be exported in a "use server" file.

   which `tsc` does not catch — it is a bundler-level rule. Pure sector
   helpers therefore live here, importable from both server actions and
   client components.
   ===================================================================== */

/** The label the rest of the app uses for the "N/A" enrichment sentinel. */
export const UNCATEGORISED_SECTOR = "Not Categorised";

/** The sentinel `InstrumentMapping.sector` value written by the enrichment
 *  pipeline when Yahoo cannot resolve a symbol. Non-null on purpose, so a
 *  dead symbol is never re-fetched. */
export const SECTOR_SKIPPED = "N/A";

/**
 * Map a raw `InstrumentMapping.sector` string to its display bucket.
 *
 * Only the sentinel is rewritten. Non-canonical passthrough values
 * ("Other", "Agriculture", "Media & Entertainment", …) are left ALONE on
 * purpose: they are a real data-quality problem, and collapsing them here
 * would hide it while silently changing every m-cap weight in the ranked
 * table. Tracked separately.
 */
export function normalizeBucketName(sector: string): string {
  return sector === SECTOR_SKIPPED ? UNCATEGORISED_SECTOR : sector;
}
