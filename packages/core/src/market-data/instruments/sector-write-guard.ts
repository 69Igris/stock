/**
 * Which instrument types may carry a `sector` — the write-side invariant
 * (MONEY-1093).
 *
 * A bond has an issuer, not a sector. Before this ticket, Kite's dump typed
 * every cash instrument `EQ`, so ~11,795 G-Secs, T-bills and SDLs sat in
 * `InstrumentMapping` as EQUITY carrying a Yahoo sector — which then flowed
 * into holdings sector concentration, the risk stress test and the heatmap as
 * if they were shares. The nightly bhavcopy backfill now types those rows DEBT
 * and clears `sector`/`industry` in the same write.
 *
 * That clear fires AT MOST ONCE per row: `planMetadataBackfill` only selects
 * rows still stamped the default type, so once a row is DEBT it is never
 * revisited. Every other writer therefore has to hold the invariant by itself —
 * a single unguarded write puts a sector back permanently, and the population
 * only grows.
 *
 * This module exists because that is exactly what happened. Four runtime paths
 * write `InstrumentMapping.sector`, and an earlier pass on this ticket guarded
 * one of them (`scripts/data/enrich-sectors-gemini.ts`) while
 * `apps/web/lib/actions/stock-sector.ts` and `packages/core/src/screener/engine.ts`
 * kept re-writing sectors onto bonds — the screener on EVERY fundamental
 * request, the action on every visit to a bond's stock page. Both swallowed
 * their errors, so it was silent. The invariant lives here, once, so the next
 * writer imports it instead of re-deriving a list.
 */

/**
 * Instrument types for which a `sector` is meaningful.
 *
 * Deliberately a POSITIVE allow-list. `instrumentType` is
 * `String @default("EQUITY")` in the schema, and a Mongo document written
 * before the field existed can lack it entirely — against which
 * `{ not: "DEBT" }` / `{ notIn: [...] }` does NOT match (the MONEY-1050
 * Prisma-Mongo gotcha). A negative filter would therefore silently skip legacy
 * rows; an allow-list skips them too, but in the safe direction — failing to
 * write a sector is recoverable, writing one onto a bond is not.
 *
 * REIT and INVIT are included ON PURPOSE. They are equity-like, they have a
 * genuine sector (Real Estate for REITs — the reason this ticket added it), and
 * `reclassify-instruments.ts` deliberately does NOT retype them so their
 * news/filings sync keeps working. A bare `"EQUITY"` guard would strand the ~7
 * real trusts with no sector at all.
 */
export const SECTOR_BEARING_TYPES = ["EQUITY", "REIT", "INVIT"] as const;

export type SectorBearingType = (typeof SECTOR_BEARING_TYPES)[number];

/**
 * The `where` fragment every `sector` write must spread in.
 *
 * Returned as a fresh object each call: Prisma mutates nothing, but sharing one
 * frozen literal across call sites invites a caller to mutate it and change
 * every other writer's filter.
 *
 * Spread it INTO the write's own `where`, alongside the row identity:
 *
 * ```ts
 * await prisma.instrumentMapping.updateMany({
 *   where: { id: instrument.id, ...sectorWritableWhere() },
 *   data: { sector, industry },
 * });
 * ```
 *
 * Note `updateMany`, not `update`: `update` requires a unique `where`, so
 * adding a type predicate to it is a compile error. `updateMany` also gives the
 * caller a `count`, which is how a caller can tell "the row was retyped under
 * me" from "the write landed" — the two are indistinguishable with `update`.
 */
export function sectorWritableWhere(): {
  instrumentType: { in: string[] };
} {
  return { instrumentType: { in: [...SECTOR_BEARING_TYPES] } };
}

/**
 * True when a row's stored type may carry a sector.
 *
 * For the in-process check, BEFORE spending a network call on enrichment. Takes
 * the loose shape Prisma hands back (and tolerates the absent-field case) so a
 * caller does not have to widen its own select just to ask.
 *
 * The `?? "EQUITY"` mirrors the schema default, which is what the row would
 * have been created with — so a legacy document missing the field is treated as
 * equity here, and is enriched, rather than being silently skipped. That is the
 * opposite bias from `sectorWritableWhere()`, and deliberately so: this
 * function only decides whether to BOTHER, while the `where` decides whether to
 * WRITE. The write is the one that must fail closed.
 */
export function isSectorBearing(
  instrumentType: string | null | undefined,
): boolean {
  // Blank is treated exactly like absent, not as an unknown type. `""` is a
  // real stored state in this collection — `sector-enrichment.ts` lists
  // `{ sector: "" }` alongside null and absent when selecting unenriched rows —
  // and a `??` alone does not catch it, so an empty string would have fallen
  // through to "not sector-bearing" and silently stopped enriching those rows.
  const raw = (instrumentType ?? "").trim();
  const t = (raw === "" ? "EQUITY" : raw).toUpperCase();
  return (SECTOR_BEARING_TYPES as readonly string[]).includes(t);
}
