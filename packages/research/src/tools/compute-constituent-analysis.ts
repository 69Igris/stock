/**
 * Constituent Stock Analysis (single-fund) — MONEY-446 Part C.
 *
 * A single-fund MF "Analyse" run should not stop at the fund-level overview +
 * sector/cap split; it should also look INTO the fund and score each of its
 * top underlying constituent stocks by the parameters we already have for them.
 *
 * Per-constituent fan-out (fetching a full financials/ratios/price-history set
 * for each holding and running compute_health_score / compute_factor_scores
 * per name) is NOT done here: the static research planner can't generate N×~12
 * fetch tasks at runtime, and doing so would blow up credits + wall-clock and
 * hammer Tickertape. Instead — exactly as the ticket allows and mirroring
 * compute_holdings_overlap's PURE-compute style — this tool derives a
 * parameter-based mini-analysis for the top N constituents straight from the
 * already-fetched fetch_mf_holdings payload (no io):
 *
 *   - portfolioWeight   the holding's % of the fund
 *   - weightRank        1 = largest holding
 *   - concentrationTier mega / large / mid / small bucket by weight
 *   - sectorWeight      total fund weight in this holding's sector
 *   - sectorShare       this holding's share OF its own sector sleeve
 *   - read              one-line, SEBI-safe observational sentence
 *
 * It also rolls the analysed constituents up into a sector grouping and a few
 * fund-level observations (top-N concentration, sector tilt, single-name max).
 *
 * The top N is BOUNDED by the caller (skill passes topN = 5 for comprehensive,
 * 8 for advanced) and hard-capped here so a malformed param can't enlarge the
 * section. When holdings are absent/unparseable the tool degrades gracefully to
 * { available: false } — never throws into the executor.
 *
 * SEBI (MONEY-457): observations / parameters / tiers only. No constituent is
 * named a "winner", no buy/sell/hold/target language is emitted.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ── Result shape ──────────────────────────────────────────────────────

export interface ConstituentParams {
  /** % of the fund this constituent represents. */
  portfolioWeight: number;
  /** 1 = largest holding (by weight) among the analysed top N. */
  weightRank: number;
  /** mega | large | mid | small — bucketed by portfolio weight. */
  concentrationTier: "mega" | "large" | "mid" | "small";
  /** Total fund weight sitting in this constituent's sector (null if unknown). */
  sectorWeight: number | null;
  /** This constituent's share of its own sector sleeve, 0-100 (null if unknown). */
  sectorShare: number | null;
}

export interface AnalysedConstituent {
  /** Normalised key (uppercased symbol, else name). */
  key: string;
  /** Human-readable name. */
  name: string;
  /** Sector label, or null if the holdings feed didn't carry one. */
  sector: string | null;
  params: ConstituentParams;
  /** One-line, SEBI-safe observational read of the params. */
  read: string;
}

export interface ConstituentSectorGroup {
  sector: string;
  /** Total fund weight across this group's analysed constituents. */
  weight: number;
  /** Keys of the analysed constituents in this sector, weight desc. */
  constituents: string[];
}

export interface ConstituentAnalysisResult {
  available: boolean;
  reason?: string;
  /** How many constituents the fund's holdings feed actually carried. */
  totalHoldings: number;
  /** How many were analysed (min(topN, totalHoldings), bounded). */
  analysedCount: number;
  /** The N requested by the caller after clamping. */
  topN: number;
  /** Per-constituent parameter analysis, weight desc. */
  constituents: AnalysedConstituent[];
  /** Analysed constituents grouped by sector, weight desc. */
  sectorGroups: ConstituentSectorGroup[];
  /** Sum of the analysed constituents' weights (top-N concentration). */
  analysedWeightPct: number;
  /** Fund-level, SEBI-safe observations. */
  observations: string[];
}

// ── Bounds / tiers ──────────────────────────────────────────────────────

/** Absolute ceiling on N regardless of what the caller passes. */
const MAX_TOP_N = 12;
const DEFAULT_TOP_N = 5;

/** Portfolio-weight tier thresholds (% of fund). */
const TIER_MEGA = 8; // >= 8%  : dominant single name
const TIER_LARGE = 5; // >= 5%  : large position
const TIER_MID = 2; // >= 2%  : mid position; below = small

/** A single name at/above this % is a notable concentration. */
const SINGLE_NAME_NOTABLE = 8;
/** A sector sleeve at/above this % is a notable tilt. */
const SECTOR_TILT_NOTABLE = 30;

// ── Pure helpers ──────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface NormHolding {
  key: string;
  name: string;
  sector: string | null;
  weight: number;
}

/** Coerce an arbitrary holding payload into a clean NormHolding (or null). */
function normalizeHolding(raw: unknown): NormHolding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;

  const symbolRaw = rec.symbol ?? rec.ticker ?? rec.tradingsymbol;
  const nameRaw = rec.name ?? rec.holdingName ?? rec.company;
  const keySource =
    (typeof symbolRaw === "string" && symbolRaw.trim()
      ? symbolRaw
      : typeof nameRaw === "string"
        ? nameRaw
        : "") ?? "";
  const key = String(keySource)
    .replace(/\.(NS|BO)$/i, "")
    .trim()
    .toUpperCase();
  if (!key) return null;

  const name =
    typeof nameRaw === "string" && nameRaw.trim()
      ? nameRaw.trim()
      : String(keySource).trim() || key;

  const weightRaw =
    rec.weight ?? rec.percentage ?? rec.allocation ?? rec.pct ?? rec.holdingPct;
  const weight = Number(weightRaw);
  const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 0;

  const sectorRaw = rec.sector;
  const sector =
    typeof sectorRaw === "string" && sectorRaw.trim() ? sectorRaw.trim() : null;

  return { key, name, sector, weight: safeWeight };
}

/**
 * Accept the fetch_mf_holdings result in any shape the executor might hand us:
 *   - a bare MfHolding[]                          (Tickertape returns this)
 *   - { holdings: [...] } | { topHoldings: [...] }
 *   - { data: [...] }
 * Duplicate keys are summed; a holding with no parseable key/weight is dropped.
 */
function normalizeHoldings(params: Record<string, unknown>): NormHolding[] {
  const raw = params.holdings ?? params.topHoldings ?? params.data;
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.holdings)
      ? ((raw as Record<string, unknown>).holdings as unknown[])
      : [];

  const byKey = new Map<string, NormHolding>();
  for (const h of arr) {
    const norm = normalizeHolding(h);
    if (!norm) continue;
    const existing = byKey.get(norm.key);
    if (existing) {
      existing.weight += norm.weight;
      if (!existing.sector && norm.sector) existing.sector = norm.sector;
    } else {
      byKey.set(norm.key, { ...norm });
    }
  }
  return Array.from(byKey.values());
}

function tierFor(weight: number): ConstituentParams["concentrationTier"] {
  if (weight >= TIER_MEGA) return "mega";
  if (weight >= TIER_LARGE) return "large";
  if (weight >= TIER_MID) return "mid";
  return "small";
}

/** SEBI-safe one-liner describing the constituent's place in the fund. */
function buildRead(
  c: AnalysedConstituent,
  fundTotalWeight: number,
): string {
  const { name, sector, params } = c;
  const w = params.portfolioWeight;
  const rankWord = params.weightRank === 1 ? "the largest" : `the #${params.weightRank}`;
  const tierWord =
    params.concentrationTier === "mega"
      ? "a dominant"
      : params.concentrationTier === "large"
        ? "a large"
        : params.concentrationTier === "mid"
          ? "a mid-sized"
          : "a small";

  const parts: string[] = [];
  parts.push(
    `${name} is ${rankWord} holding at ${w}% of the fund (${tierWord} position).`,
  );
  if (sector && params.sectorWeight !== null) {
    const sectorOfFund =
      fundTotalWeight > 0
        ? round1((params.sectorWeight / fundTotalWeight) * 100)
        : params.sectorWeight;
    if (params.sectorShare !== null) {
      parts.push(
        `It accounts for ${params.sectorShare}% of the fund's ${sector} sleeve (~${sectorOfFund}% of the portfolio).`,
      );
    }
  }
  return parts.join(" ");
}

// ── Tool ──────────────────────────────────────────────────────────────

export const computeConstituentAnalysisTool: ResearchToolDef = {
  name: "compute_constituent_analysis",
  description:
    "Score a single fund's top N underlying constituent stocks by parameters (portfolio weight, rank, concentration tier, sector context) from already-fetched holdings — observation only, no winner",
  category: "computation",
  parameters: {
    holdings: {
      type: "array",
      description:
        "The fund's holdings from fetch_mf_holdings (executor-injected): MfHolding[] or { holdings: [{ symbol|name, weight|percentage, sector? }] }",
      required: true,
    },
    topN: {
      type: "number",
      description: `How many top constituents to analyse (default ${DEFAULT_TOP_N}, hard-capped at ${MAX_TOP_N})`,
      required: false,
      default: DEFAULT_TOP_N,
    },
    fundName: {
      type: "string",
      description: "Optional fund name for labelling",
      required: false,
    },
  },
  cacheTTL: 86400,
  execute: async (params): Promise<ToolOutput> => {
    try {
      // Clamp topN into [1, MAX_TOP_N]; non-numeric falls back to default.
      const rawN = Number(params.topN);
      const topN = Number.isFinite(rawN)
        ? Math.max(1, Math.min(MAX_TOP_N, Math.floor(rawN)))
        : DEFAULT_TOP_N;

      const holdings = normalizeHoldings(params);

      // Graceful degradation: no parseable holdings → available:false.
      if (holdings.length === 0) {
        const degraded: ConstituentAnalysisResult = {
          available: false,
          reason: "no parseable holdings to analyse",
          totalHoldings: 0,
          analysedCount: 0,
          topN,
          constituents: [],
          sectorGroups: [],
          analysedWeightPct: 0,
          observations: [],
        };
        return { success: true, data: degraded };
      }

      // Fund-level totals (across ALL holdings, not just the top N).
      const fundTotalWeight = holdings.reduce((s, h) => s + h.weight, 0);

      // Sector sleeves across the WHOLE fund (so sectorWeight/share are honest
      // even when the tilt's other names sit outside the top N).
      const sectorTotals = new Map<string, number>();
      for (const h of holdings) {
        if (!h.sector) continue;
        sectorTotals.set(
          h.sector,
          (sectorTotals.get(h.sector) ?? 0) + h.weight,
        );
      }

      // Rank by weight desc and take the bounded top N.
      const ranked = holdings.slice().sort((a, b) => b.weight - a.weight);
      const top = ranked.slice(0, topN);

      const constituents: AnalysedConstituent[] = top.map((h, i) => {
        const sectorWeight =
          h.sector && sectorTotals.has(h.sector)
            ? round2(sectorTotals.get(h.sector)!)
            : null;
        const sectorShare =
          h.sector && sectorWeight && sectorWeight > 0
            ? round1((h.weight / sectorWeight) * 100)
            : null;

        const c: AnalysedConstituent = {
          key: h.key,
          name: h.name,
          sector: h.sector,
          params: {
            portfolioWeight: round2(h.weight),
            weightRank: i + 1,
            concentrationTier: tierFor(h.weight),
            sectorWeight,
            sectorShare,
          },
          read: "",
        };
        c.read = buildRead(c, fundTotalWeight);
        return c;
      });

      // Sector grouping of the ANALYSED constituents.
      const groupMap = new Map<string, ConstituentSectorGroup>();
      for (const c of constituents) {
        const sector = c.sector ?? "Unclassified";
        const g = groupMap.get(sector);
        if (g) {
          g.weight = round2(g.weight + c.params.portfolioWeight);
          g.constituents.push(c.key);
        } else {
          groupMap.set(sector, {
            sector,
            weight: c.params.portfolioWeight,
            constituents: [c.key],
          });
        }
      }
      const sectorGroups = Array.from(groupMap.values()).sort(
        (a, b) => b.weight - a.weight,
      );

      const analysedWeightPct = round2(
        constituents.reduce((s, c) => s + c.params.portfolioWeight, 0),
      );

      // ── Fund-level observations (SEBI-safe; no winner / no advice) ──
      const observations: string[] = [];
      observations.push(
        `Top ${constituents.length} constituents account for ${analysedWeightPct}% of the fund.`,
      );

      const biggest = constituents[0];
      if (biggest && biggest.params.portfolioWeight >= SINGLE_NAME_NOTABLE) {
        observations.push(
          `${biggest.name} is the largest single-name exposure at ${biggest.params.portfolioWeight}% — a notable concentration.`,
        );
      }

      // Sector tilt across the whole fund (use fund totals, not just top N).
      if (fundTotalWeight > 0 && sectorTotals.size > 0) {
        let topSector: string | null = null;
        let topSectorWeight = 0;
        for (const [sector, w] of Array.from(sectorTotals.entries())) {
          if (w > topSectorWeight) {
            topSectorWeight = w;
            topSector = sector;
          }
        }
        const sectorPctOfFund = round1((topSectorWeight / fundTotalWeight) * 100);
        if (topSector && sectorPctOfFund >= SECTOR_TILT_NOTABLE) {
          observations.push(
            `The fund tilts toward ${topSector} (~${sectorPctOfFund}% of the portfolio).`,
          );
        }
      }

      if (constituents.length < topN) {
        observations.push(
          `Holdings feed carried only ${holdings.length} constituent(s); analysed all of them.`,
        );
      }

      const result: ConstituentAnalysisResult = {
        available: true,
        totalHoldings: holdings.length,
        analysedCount: constituents.length,
        topN,
        constituents,
        sectorGroups,
        analysedWeightPct,
        observations,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Constituent analysis failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};
