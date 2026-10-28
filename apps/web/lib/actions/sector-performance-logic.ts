/**
 * Pure sector-performance aggregation (MONEY-393 §7), extracted from the
 * "use server" getSectorPerformanceAction so the bucketing + weighting +
 * bar-width math is unit-testable WITHOUT importing @usemoney/core (which pulls
 * fs/child_process) or Prisma. The action fetches the rows from Prisma and calls
 * this with the real `normalize` / `getDisplay` injected; tests inject mocks.
 */

/**
 * `SECTOR_SKIPPED` from `@usemoney/core/market-data`, copied rather than
 * imported (MONEY-1152).
 *
 * This module's whole reason for existing is to stay free of `@usemoney/core`,
 * which pulls `fs`/`child_process` — so the one value it needs is duplicated
 * here. `sector-performance-logic.test.ts` asserts this equals the real
 * constant, so the copy fails a test rather than drifting silently.
 *
 * Why it must be excluded: it is the tombstone the enrichment cron writes for a
 * permanently unresolvable symbol, and `normalizeToNseSector` passes it through
 * UNCHANGED. Measured on QA, that put a row literally labelled "N/A" into the
 * `/discover` sector-performance list as its 3rd-largest "sector" — 1,296
 * instruments, 15.8% of the aggregate, ranked between Industrials and Financial
 * Services. Filtering at the query is an optimisation; this is the guarantee,
 * because it also catches the empty string that no `where` fragment excludes.
 */
const SECTOR_SKIPPED_SENTINEL = "N/A";

/** Local mirror of core's `hasRealSector` — see the note above. */
function isRealSector(sector: string | null | undefined): sector is string {
  return (
    typeof sector === "string" &&
    sector.length > 0 &&
    sector !== SECTOR_SKIPPED_SENTINEL
  );
}

/** Minimal instrument row the aggregator reads. */
export interface SectorInstrument {
  id: string;
  sector: string | null;
}

/** Minimal quote row the aggregator reads. */
export interface SectorQuote {
  instrumentId: string;
  changePercent: number | null;
  volume: number | null;
}

/** One aggregated sector row, parameterised over the display-config type. */
export interface SectorPerformanceRow<TDisplay> {
  sector: string;
  count: number;
  meanChangePct: number;
  weightedChangePct: number;
  barWidth: number;
  display: TDisplay | null;
}

/**
 * Aggregate change% across equity stocks grouped by (normalized) sector:
 *   - mean = simple arithmetic mean of constituents' changePercent
 *   - weighted = volume-weighted mean (volume ≤ 0 / null → weight 1)
 *   - barWidth = |weighted| / maxAbs(weighted) × 100 (0 on an all-flat set)
 *   - sorted by weightedChangePct descending (gainers first)
 * Stocks with no quote or a null changePercent are skipped; sectors with zero
 * constituents are omitted.
 */
export function aggregateSectorPerformance<TDisplay>(
  instruments: SectorInstrument[],
  quoteByInst: Map<string, SectorQuote>,
  normalize: (sector: string) => string,
  getDisplay: (sector: string) => TDisplay | null
): SectorPerformanceRow<TDisplay>[] {
  const buckets = new Map<
    string,
    {
      changePcts: number[];
      weighted: Array<{ change: number; weight: number }>;
    }
  >();

  for (const inst of instruments) {
    const q = quoteByInst.get(inst.id);
    // `!inst.sector` alone let the "N/A" tombstone through — see
    // SECTOR_SKIPPED_SENTINEL above for what that put on the page.
    if (!q || q.changePercent == null || !isRealSector(inst.sector)) continue;
    const canonical = normalize(inst.sector);
    if (!buckets.has(canonical)) {
      buckets.set(canonical, { changePcts: [], weighted: [] });
    }
    const bucket = buckets.get(canonical)!;
    bucket.changePcts.push(q.changePercent);
    const weight = q.volume && q.volume > 0 ? q.volume : 1;
    bucket.weighted.push({ change: q.changePercent, weight });
  }

  const rows: Array<Omit<SectorPerformanceRow<TDisplay>, "barWidth">> = [];
  for (const [sector, bucket] of Array.from(buckets.entries())) {
    if (bucket.changePcts.length === 0) continue;

    const meanChangePct =
      bucket.changePcts.reduce((s, v) => s + v, 0) / bucket.changePcts.length;
    const totalWeight = bucket.weighted.reduce((s, w) => s + w.weight, 0);
    const weightedSum = bucket.weighted.reduce(
      (s, w) => s + w.change * w.weight,
      0
    );
    const weightedChangePct = totalWeight > 0 ? weightedSum / totalWeight : 0;

    rows.push({
      sector,
      count: bucket.changePcts.length,
      meanChangePct,
      weightedChangePct,
      display: getDisplay(sector),
    });
  }

  const maxAbs = rows.reduce(
    (m, r) => Math.max(m, Math.abs(r.weightedChangePct)),
    0
  );
  return rows
    .map((r) => ({
      ...r,
      barWidth:
        maxAbs > 0
          ? Math.min(100, (Math.abs(r.weightedChangePct) / maxAbs) * 100)
          : 0,
    }))
    .sort((a, b) => b.weightedChangePct - a.weightedChangePct);
}
