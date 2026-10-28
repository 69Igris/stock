/**
 * Centralized NSE Sector Taxonomy
 *
 * Canonical sector classification based on NSE India's macro-economic sectors
 * (13 since 2026-07-30, when Real Estate was split out of Financial Services).
 * Replaces per-file SECTOR_CONFIG / SECTOR_COLORS with a single source of truth.
 *
 * Usage:
 *   import { NSE_SECTORS, normalizeToNseSector, getSectorDisplayConfig } from "./sector-taxonomy";
 */

// ============== NSE SECTOR DEFINITIONS ==============

export interface SectorDisplayConfig {
  label: string;
  color: string;
  icon: string;
}

/**
 * NSE India's macro-economic sector classification.
 * Keys are the canonical sector names stored in InstrumentMapping.sector.
 */
export const NSE_SECTORS: Record<string, SectorDisplayConfig> = {
  "Information Technology": {
    label: "IT & Technology",
    color: "#3b82f6",
    icon: "Cpu",
  },
  "Financial Services": {
    label: "Banking & Finance",
    color: "#10b981",
    icon: "Landmark",
  },
  Healthcare: {
    label: "Healthcare & Pharma",
    color: "#ef4444",
    icon: "Heart",
  },
  // MONEY-1093 — its own sector as of 2026-07-30 (founder decision). It used
  // to fold into Financial Services, which made DLF, Godrej Properties and
  // Oberoi Realty indistinguishable from HDFC Bank in every sector aggregate.
  // Teal is deliberately distinct from Financial Services' emerald. Note this
  // field is NOT what colours the heatmap — SectorsHeatmap and Treemap colour by
  // change%, and nothing in this repo maps `icon` to a component at all. The
  // only consumer that ships these is the mobile /v1/discover/sectors
  // endpoint, so "distinct" matters there, not on web.
  "Real Estate": {
    label: "Real Estate & Realty",
    color: "#14b8a6",
    icon: "Building2",
  },
  Energy: {
    label: "Energy & Power",
    color: "#f59e0b",
    icon: "Zap",
  },
  "Consumer Discretionary": {
    label: "Consumer Discretionary",
    color: "#8b5cf6",
    icon: "ShoppingCart",
  },
  Industrials: {
    label: "Industrials & Manufacturing",
    color: "#6366f1",
    icon: "Factory",
  },
  Commodities: {
    label: "Metals & Commodities",
    color: "#78716c",
    icon: "Pickaxe",
  },
  FMCG: {
    label: "FMCG & Essentials",
    color: "#22c55e",
    icon: "ShoppingBag",
  },
  Telecommunication: {
    label: "Telecom & Media",
    color: "#06b6d4",
    icon: "Radio",
  },
  Utilities: {
    label: "Utilities",
    color: "#eab308",
    icon: "Plug",
  },
  Services: {
    label: "Services",
    color: "#a855f7",
    icon: "Briefcase",
  },
  Diversified: {
    label: "Diversified",
    color: "#d97706",
    icon: "Layers",
  },
};

// ============== YAHOO → NSE MAPPING ==============

/**
 * Maps Yahoo Finance GICS sector names to the canonical NSE sector names.
 * Used when writing enriched sector data to InstrumentMapping.
 */
export const YAHOO_TO_NSE_MAP: Record<string, string> = {
  // Standard GICS → NSE mappings
  Technology: "Information Technology",
  "Financial Services": "Financial Services",
  Healthcare: "Healthcare",
  Energy: "Energy",
  "Consumer Cyclical": "Consumer Discretionary",
  Industrials: "Industrials",
  "Basic Materials": "Commodities",
  "Consumer Defensive": "FMCG",
  "Communication Services": "Telecommunication",
  Utilities: "Utilities",
  // MONEY-1093 — Real Estate is now its OWN sector (founder decision,
  // 2026-07-30) rather than folding into Financials. Both spellings must land
  // on it: "Real Estate" is what Yahoo/GICS returns, "Realty" is what NSE and
  // the screener use. "Realty" previously mapped NOWHERE, so it fell through
  // `normalizeToNseSector`'s passthrough into a non-canonical bucket that the
  // screener's sector filter could not reach.
  //
  // The self-mapping below is redundant (a direct NSE_SECTORS hit returns
  // first) and kept deliberately: it documents that this alias pair is one
  // decision, so a future edit cannot move one without seeing the other.
  //
  // NOTE this only affects FUTURE writes. Rows already stored as "Financial
  // Services" do not re-bucket themselves — the enrichment pipeline only
  // fetches rows with NO sector — so use `scripts/data/resector-real-estate.ts`
  // to move the existing ones.
  "Real Estate": "Real Estate",
  Realty: "Real Estate",
  // Additional Yahoo sector names seen in Indian stocks
  Conglomerate: "Diversified",
  Power: "Energy",
  "Consumer Goods": "FMCG",
  Metals: "Commodities",
  "Oil & Gas": "Energy",
  Pharma: "Healthcare",
  Automobile: "Consumer Discretionary",
  Cement: "Commodities",
  Chemicals: "Commodities",
  Construction: "Industrials",
  IT: "Information Technology",
  Telecom: "Telecommunication",
  Banking: "Financial Services",
  Insurance: "Financial Services",
  Infrastructure: "Industrials",
  Media: "Telecommunication",
  Textiles: "Consumer Discretionary",
  // ── MONEY-1302 — two labels that were named as known leftovers and left ──
  //
  // Measured on prod 2026-08-30: 101 ACTIVE rows carried a sector outside
  // NSE_SECTORS. Only 43 of them were actually unreachable by the screener's
  // sector facet — `Construction`, `Automobile`, `Textiles` and `Chemicals`
  // were already aliases here, so `resolveCanonicalSector` already folded them.
  // The genuinely unmapped values were `Other` (29), `Media & Entertainment`
  // (9) and `Agriculture` (5).
  //
  // Each mapping below was chosen after reading the COMPANY NAMES, not the
  // label. That mattered: the label alone would have produced two wrong
  // answers (see the `Other` note at the end of this block).

  // All 9 rows are real media companies and the classifier types all 9 EQUITY:
  // Zee Entertainment (NSE+BSE), Zee Media (NSE+BSE), Zinema Media, 7Seas
  // Entertainment, Encash Entertainment, P.B. Films, 3B Films.
  //
  // Telecommunication rather than Consumer Discretionary because that is where
  // this taxonomy ALREADY puts media: the bare token `Media` is mapped to it
  // eight lines up, and the sector's own display label is "Telecom & Media".
  // Splitting the two spellings across two chips would put Zee Entertainment
  // and Zee Media in different sectors from every other broadcaster.
  "Media & Entertainment": "Telecommunication",

  // 5 rows: Zuari Agro Chemicals (NSE+BSE), Zeal Aqua, AG Ventures, Coromandel
  // Agro Products & Oils. All real companies.
  //
  // THIS ONE IS A JUDGEMENT CALL and the population does not settle it — the
  // rows split between two defensible targets. Zeal Aqua (aquaculture),
  // Coromandel Agro (edible oils) and AG Ventures (agri services) are
  // agri-FOOD, which NSE's own scheme files under Fast Moving Consumer Goods
  // ("Agricultural Food & other Products"). Zuari Agro Chemicals — 2 of the 5
  // rows — is a FERTILISER maker, which NSE files under Chemicals, i.e.
  // Commodities here.
  //
  // FMCG wins on the LABEL's semantics rather than on this row count, because
  // an alias is durable and applies to every future write: a writer describing
  // a fertiliser business reaches for "Chemicals" (already mapped, to
  // Commodities) far sooner than for "Agriculture". Zuari is therefore treated
  // as a mislabelled row, not as evidence against the mapping — and
  // `resector-noncanonical.ts --only Agriculture` prints those two rows so the
  // decision stays visible rather than buried here.
  Agriculture: "FMCG",

  // `Other` (29 rows) is deliberately NOT mapped, and specifically NOT mapped
  // to the empty `Diversified` bucket even though its `industry` column says
  // "Diversified" on 15 of them. That column is unvalidated Gemini free text,
  // and the rows behind it are not diversified holding companies:
  //
  //   26 of 29 are DEBT — `765GUJSDL29` (a Gujarat State Development Loan),
  //   `1028NIDO29`, `1164MECL29`, `85TMCV26`/`85TMCV27`, `EELNIFT28` and
  //   `NWFLNIFT26` (market-linked debentures), `RERTZC28` (zero-coupon),
  //   `VALIANTOCPS` (optionally-convertible preference shares) and the rest.
  //   Only Bluspring Enterprises (NSE+BSE) and Surya India are companies.
  //
  // Mapping it would hand 26 bonds a sector chip — the exact state MONEY-1093
  // built `sector-write-guard.ts` to prevent. Left unmapped, they resolve to
  // the "Not Categorised" catch-all, which is the honest answer for a bond.
  // The three real rows want re-enrichment (clear the sector so the Yahoo pass
  // picks them up), not an alias; `resector-noncanonical.ts` reports them
  // under UNMAPPED rather than silently bucketing them.
};

// ============== UTILITY FUNCTIONS ==============

/**
 * Normalize a raw sector string (from Yahoo Finance or elsewhere) to the
 * canonical NSE sector name.  Returns the input unchanged if no mapping exists
 * and it already matches a known NSE sector.
 *
 * READ-SIDE ONLY. The trailing passthrough means an unmapped label survives
 * this function unchanged, which is what the diagnostic surfaces want and what
 * makes it unsafe for a WRITE — see {@link toWritableNseSector} (MONEY-1302),
 * which every path that persists `InstrumentMapping.sector` must use instead.
 */
export function normalizeToNseSector(rawSector: string): string {
  // Direct match in NSE_SECTORS?
  if (rawSector in NSE_SECTORS) return rawSector;

  // Yahoo → NSE mapping?
  const mapped = YAHOO_TO_NSE_MAP[rawSector];
  if (mapped) return mapped;

  // Fallback: return as-is (will get a default color via getSectorDisplayConfig)
  return rawSector;
}

/**
 * Get display config (label, color, icon) for a sector name.
 * Falls back to a neutral gray if the sector isn't recognized.
 */
export function getSectorDisplayConfig(
  sectorName: string,
): SectorDisplayConfig {
  // Try direct match first, then try normalizing
  const config =
    NSE_SECTORS[sectorName] ?? NSE_SECTORS[normalizeToNseSector(sectorName)];

  return (
    config ?? {
      label: sectorName,
      color: "#6b7280",
      icon: "Circle",
    }
  );
}

/**
 * Returns all canonical NSE sector names.
 */
export function getAllSectorNames(): string[] {
  return Object.keys(NSE_SECTORS);
}

// ============== SCREENER SECTOR FACETS (MONEY-1157) ==============

/**
 * ## Why the facet predicate lives HERE, next to the maps
 *
 * The screener's sector chips are produced by `buildSectorFacets`
 * (`packages/services/src/discover-logic.ts`) and consumed by the sector FILTER
 * in `packages/services/src/screener.service.ts` + its lockstep twin in
 * `apps/web/lib/actions/screener.ts`. Those were three separate opinions about
 * what "this row is in sector X" means, and they disagreed:
 *
 *   - the COUNTS folded `Construction` into Industrials and `Textiles` into
 *     Consumer Discretionary via `normalizeToNseSector`, and sent everything
 *     still non-canonical (`Other`, `Media & Entertainment`) to the catch-all;
 *   - the FILTER compared the RAW stored string, so `sectorMatches` returned
 *     false for every one of them.
 *
 * Measured on prod: Industrials over-reported by ~40, Consumer Discretionary by
 * ~8 and "Not Categorised" by ~242 — ~285 rows that were COUNTED under a chip
 * and then not RETURNED by it. `instrumentsFirstPath` screens the very array
 * the counts were built from, so the discrepancy was exact and user-visible.
 *
 * Both sides now derive from `resolveCanonicalSector` below, so the
 * conservation property ("the chip's count is the number of rows the chip
 * returns") is structural rather than a coincidence two files have to keep
 * agreeing on. Do NOT reintroduce a local copy in either consumer.
 *
 * The Mongo/Prisma twin (`sectorFacetInstrumentWhere`) is deliberately in this
 * same file for the same reason — it is the one thing that cannot call the JS
 * predicate per row, so it is derived from the same index instead.
 *
 * NOTE the asymmetry with `apps/web/lib/sectors/buckets.ts` is still deliberate:
 * the heatmap keeps showing raw non-canonical values because it is a DIAGNOSTIC
 * surface. This is a FILTER, where an unreachable bucket is the defect.
 */

/** The display label for the catch-all facet. The STORED values behind it are
 *  `null`, an ABSENT field, `""`, the `"N/A"` enrichment sentinel, or any string
 *  that does not resolve to a canonical sector — the two are not
 *  interchangeable. */
export const UNCATEGORISED_SECTOR_FACET = "Not Categorised";

/** Both spellings ship in the wild (the chip label is en-GB; older links and
 *  the mobile client use en-US). */
const UNCATEGORISED_FILTER_LABELS: ReadonlySet<string> = new Set([
  "not categorised",
  "not categorized",
]);

interface SectorFacetIndex {
  /** lowercase(stored value) → canonical NSE sector name. */
  readonly rawToCanonical: ReadonlyMap<string, string>;
  /** canonical NSE sector name → every stored value that folds onto it,
   *  in its ORIGINAL casing (what a `$in` has to be built from). */
  readonly canonicalToRaws: ReadonlyMap<string, readonly string[]>;
  /** Every stored value the taxonomy knows how to fold, original casing. */
  readonly knownValues: readonly string[];
}

/**
 * One pass over the two maps, producing both directions at once.
 *
 * Built together on purpose: a `$in` expansion derived independently from the
 * forward lookup is exactly the kind of second opinion this module exists to
 * delete. An alias whose lowercase is already claimed is skipped — every such
 * collision today is a self-map (`Financial Services`, `Healthcare`, `Energy`,
 * `Industrials`, `Utilities`, `Real Estate`), so nothing is lost; the guard is
 * there so a future alias that contradicts a canonical name cannot silently win.
 */
function buildSectorFacetIndex(): SectorFacetIndex {
  const rawToCanonical = new Map<string, string>();
  const canonicalToRaws = new Map<string, string[]>();
  const knownValues: string[] = [];

  const add = (raw: string, canonical: string): void => {
    const key = raw.toLowerCase();
    if (rawToCanonical.has(key)) return;
    rawToCanonical.set(key, canonical);
    knownValues.push(raw);
    const existing = canonicalToRaws.get(canonical);
    if (existing) existing.push(raw);
    else canonicalToRaws.set(canonical, [raw]);
  };

  for (const name of Object.keys(NSE_SECTORS)) add(name, name);
  for (const [alias, target] of Object.entries(YAHOO_TO_NSE_MAP)) {
    // Never let an alias invent a facet the chip strip does not offer.
    if (target in NSE_SECTORS) add(alias, target);
  }

  return { rawToCanonical, canonicalToRaws, knownValues };
}

const SECTOR_FACET_INDEX = buildSectorFacetIndex();

/** lowercase(canonical name) → canonical name. Deliberately NOT the alias map:
 *  `?stocks.sector=Construction` must keep meaning the 40 rows literally stored
 *  as "Construction" (the heatmap deep-dive links raw bucket names), not the
 *  whole Industrials chip. */
const CANONICAL_BY_LOWER: ReadonlyMap<string, string> = new Map(
  Object.keys(NSE_SECTORS).map((name) => [name.toLowerCase(), name]),
);

/** Every stored `InstrumentMapping.sector` value the taxonomy can fold onto a
 *  canonical sector, in its original casing. The complement of this set is
 *  exactly what the "Not Categorised" facet holds. */
export const KNOWN_SECTOR_VALUES: readonly string[] =
  SECTOR_FACET_INDEX.knownValues;

/**
 * The canonical NSE sector a STORED value belongs to, or `null` when it belongs
 * to the "Not Categorised" catch-all.
 *
 * Total and case-insensitive. `null`/`undefined`/`""`, the `"N/A"` sentinel and
 * any unmapped string (`Other`, `Agriculture`, `Media & Entertainment` — only
 * the bare token `Media` is in `YAHOO_TO_NSE_MAP`) all return `null`.
 *
 * Case-insensitivity is a widening, never a narrowing: a row stored `"energy"`
 * now lands under Energy instead of the catch-all, and no value that resolved
 * before stops resolving.
 */
export function resolveCanonicalSector(
  rowSector: string | null | undefined,
): string | null {
  if (!rowSector) return null;
  return SECTOR_FACET_INDEX.rawToCanonical.get(rowSector.toLowerCase()) ?? null;
}

/**
 * ## The WRITE guard — MONEY-1302
 *
 * The canonical sector a raw upstream label may be STORED as, or `null` when
 * the taxonomy does not recognise it and nothing may be written.
 *
 * ### Why this is not `normalizeToNseSector`
 *
 * `normalizeToNseSector` ends in `return rawSector` — an unmapped label passes
 * through and is written VERBATIM. That passthrough is correct for READS (the
 * heatmap is a diagnostic surface and deliberately shows raw buckets, see the
 * facet-section header) and is the whole defect on WRITES: a sector Yahoo
 * renames, or a GICS label nobody added an alias for, lands off-taxonomy and is
 * then INVISIBLE. The screener's sector facet cannot reach it, and the
 * enrichment selector only revisits rows whose sector is null/empty — so the
 * row never self-heals and the only way to discover it is for somebody to count
 * distinct values against `NSE_SECTORS` by hand. That is how the 101 rows this
 * ticket found accumulated, and how `Other` and `Media & Entertainment` sat
 * NAMED in this file's own comments for two tickets without being closed.
 *
 * So reads keep the passthrough and writes get this. The asymmetry is the same
 * one the facet section already documents, applied one layer earlier.
 *
 * ### Rejection, not a catch-all
 *
 * Returning `null` means "do not write", NOT "write something safe". Neither
 * substitute is available:
 *
 *   - writing the raw label is the defect itself;
 *   - writing `SECTOR_SKIPPED` ("N/A") would be a LIE and a permanent one —
 *     the sentinel means "Yahoo has no profile for this symbol", the selector
 *     excludes it, and `forceReEnrich` excludes it too. Yahoo answering with a
 *     sector we happen not to have an alias for is the opposite of no profile.
 *     That is the repo's standing rule — NEVER CACHE A FAIL-OPEN DEFAULT —
 *     which `sector-enrichment-logic.ts` already had to learn once (MONEY-1238).
 *
 * The caller therefore treats a `null` as a FAILED fetch: nothing is written,
 * the label is surfaced in the run's `errors`, and the next run retries it. The
 * unmapped label becomes loud instead of silent, an alias gets added here, and
 * the row enriches on the following pass.
 *
 * Derived from `resolveCanonicalSector` rather than from `YAHOO_TO_NSE_MAP`
 * directly, so what may be WRITTEN and what the screener chip can REACH are the
 * same set by construction — a write that lands in a chip nobody can click is
 * the bug one layer down.
 */
export function toWritableNseSector(
  rawSector: string | null | undefined,
): string | null {
  return resolveCanonicalSector(rawSector);
}

/**
 * Every stored value that folds onto `canonicalName` — the canonical name plus
 * each alias that maps to it. Returns `[]` for a non-canonical name.
 */
export function sectorFacetRawValues(canonicalName: string): readonly string[] {
  return SECTOR_FACET_INDEX.canonicalToRaws.get(canonicalName) ?? [];
}

/**
 * Does this filter value name one of the 13 canonical chips? Case-insensitive.
 * Returns the canonical spelling, or `null` for the catch-all label and for any
 * other free-text value.
 */
export function canonicalSectorFacetFor(filterSector: string): string | null {
  return CANONICAL_BY_LOWER.get(filterSector.toLowerCase()) ?? null;
}

/** Is this filter value the catch-all chip (either spelling)? */
export function isUncategorisedSectorFilter(filterSector: string): boolean {
  return UNCATEGORISED_FILTER_LABELS.has(filterSector.toLowerCase());
}

/**
 * The screener's sector predicate — the single authority on what a chip means.
 *
 * Three branches, in order:
 *
 *   1. the catch-all chip matches every row that does NOT resolve to a
 *      canonical sector (absent / null / `""` / `"N/A"` / `Other` / anything
 *      else unmapped). This is the widening that closes the ~242-row
 *      over-report: the old test was `!rowSector || rowSector === "N/A"`, which
 *      counted `Other` under the chip and then never returned it.
 *   2. a CANONICAL chip matches every row that folds onto it, so `Construction`
 *      and `Infrastructure` are reachable under Industrials and `Textiles`
 *      under Consumer Discretionary — exactly how `buildSectorFacets` counts
 *      them.
 *   3. anything else falls back to raw case-insensitive equality. This is not
 *      dead: `SectorDeepDive` links `/discover/screener?stocks.sector=<bucket>`
 *      with the RAW heatmap bucket name, so `Other` (228 rows) and
 *      `Construction` (40) arrive here and must keep reaching their rows.
 *      Branch 2 is checked first, so a canonical name can never fall through to
 *      it and re-open the over-report.
 *
 * Branches 1 and 2 partition the universe (a row resolves canonically or it does
 * not), which is what makes chip counts and chip results provably equal.
 */
export function matchesSectorFacet(
  rowSector: string | null | undefined,
  filterSector: string | undefined,
): boolean {
  if (!filterSector) return true;
  if (isUncategorisedSectorFilter(filterSector)) {
    return resolveCanonicalSector(rowSector) === null;
  }
  const canonicalTarget = canonicalSectorFacetFor(filterSector);
  if (canonicalTarget !== null) {
    return resolveCanonicalSector(rowSector) === canonicalTarget;
  }
  return (rowSector ?? "").toLowerCase() === filterSector.toLowerCase();
}

/**
 * The DB-side twin of `matchesSectorFacet`, as a Prisma `where` fragment against
 * the related `InstrumentMapping` row (MONEY-1131 pushed the predicate into the
 * query so the ratios path stops fetching the whole banded set).
 *
 * A per-row JS function cannot run inside a Mongo filter, so the canonical
 * target is expanded into the SET of stored values that fold onto it. Both
 * halves come from `SECTOR_FACET_INDEX`, so the expansion cannot drift from the
 * predicate.
 *
 * Two shape decisions, both load-bearing:
 *
 *   - the named branch is an OR of `{ equals, mode: "insensitive" }` rather than
 *     one `$in`. `matchesSectorFacet` is case-insensitive on the row side, so a
 *     case-sensitive `$in` would NOT be a superset of it — a row stored
 *     `"power"` would be dropped by the database and the retained JS pass
 *     cannot rescue a row that never arrived. Prisma types `mode` alongside
 *     `in`, but the Mongo connector's support for that combination is not
 *     something this fix should bet a silent row-loss on; `{equals, mode}` is
 *     the form already proven in production here. It collapses to the single
 *     clause when a sector has no aliases (Utilities, Services), so the query
 *     shape only grows where it must.
 *
 *   - the catch-all branch keeps `{ sector: { isSet: false } }` FIRST and does
 *     NOT rely on `$nin` matching absent fields. Prisma's `{sector: null}`
 *     is an explicit-null equality that misses documents where the key was
 *     never created, and every instrument minted by the nightly sync looks like
 *     that until enrichment reaches it — precisely the population this chip
 *     exists to surface. The `notIn` branch is what widens the bucket to
 *     `Other` and friends; whether it also happens to match absent/null is
 *     irrelevant, because those are already covered explicitly. A `$nin`-only
 *     formulation is the trap here.
 *
 * The DB clause is a SUPERSET of the predicate, never a subset: the caller
 * still runs `matchesSectorFacet` over the returned rows, so the visible result
 * set is decided by the predicate and the query is only a transport
 * optimisation. Returns `null` when no sector filter is active.
 */
export function sectorFacetInstrumentWhere(
  filterSector: string | undefined,
): Record<string, unknown> | null {
  if (!filterSector) return null;

  if (isUncategorisedSectorFilter(filterSector)) {
    return {
      OR: [
        { sector: { isSet: false } },
        { sector: null },
        { sector: "" },
        { sector: "N/A" },
        { sector: { notIn: [...KNOWN_SECTOR_VALUES] } },
      ],
    };
  }

  const canonicalTarget = canonicalSectorFacetFor(filterSector);
  const values =
    canonicalTarget === null
      ? [filterSector]
      : sectorFacetRawValues(canonicalTarget);

  if (values.length === 1) {
    return { sector: { equals: values[0]!, mode: "insensitive" } };
  }
  return {
    OR: values.map((value) => ({
      sector: { equals: value, mode: "insensitive" },
    })),
  };
}
