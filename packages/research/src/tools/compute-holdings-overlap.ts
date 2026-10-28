/**
 * Holdings Overlap Analysis (multi-fund)
 *
 * Decomposes the constituent stocks of 2+ mutual funds into a COMMON set
 * (held by 2+ funds) vs DISTINCT sets (unique to a single fund), then quantifies
 * how much the funds actually overlap: pairwise Jaccard on holding keys,
 * weight-overlap (sum of min(weightA, weightB) across shared keys), per-fund
 * common-weight share, and aggregate concentration of the shared names.
 *
 * Surfaces observational flags for diversification (highly-identical pairs),
 * concentration (a single name large across many funds), and differentiation
 * (a fund's unique high-conviction sleeve).
 *
 * PURE compute - no io. The executor accumulates one `funds[]` entry per
 * `fetch_mf_holdings` dependency (each returns MfHolding[] from Tickertape:
 * { name, symbol, sector, weight, value }). Inputs are parsed defensively:
 * a holding key may arrive as `symbol` OR `name`, a weight as `weight` OR
 * `percentage`. Fewer than 2 funds with parseable holdings degrades gracefully
 * (available:false, reason 'need >=2 funds with holdings').
 *
 * SEBI: observations / scores / flags only. No fund is named a "winner" and no
 * buy/sell/hold language is used.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

interface NormalizedHolding {
  key: string;
  name: string;
  weight: number;
  sector: string | null;
}

interface NormalizedFund {
  id: string;
  name: string;
  holdings: NormalizedHolding[];
  /** key -> aggregated weight within this fund (duplicate keys summed) */
  weightByKey: Map<string, number>;
  /** total weight of the fund (sum of holding weights) */
  totalWeight: number;
}

export interface CommonStock {
  key: string;
  name: string;
  sector: string | null;
  /** number of funds (>=2) holding this stock */
  fundCount: number;
  perFund: Array<{ fundId: string; weight: number }>;
  /** sum of the stock's weight across the funds that hold it */
  aggregateWeight: number;
  avgWeight: number;
  minWeight: number;
  maxWeight: number;
  /** maxWeight - minWeight across the holding funds */
  weightDispersion: number;
}

export interface DistinctFundStocks {
  fundId: string;
  holdings: Array<{
    key: string;
    name: string;
    weight: number;
    sector: string | null;
  }>;
}

export interface PairwiseOverlap {
  fundA: string;
  fundB: string;
  /** number of shared holding keys */
  sharedCount: number;
  /** |A∩B| / |A∪B| by key, as a percentage 0-100 */
  jaccard: number;
  /** sum of min(weightA, weightB) over shared keys, as a percentage */
  weightOverlapPct: number;
}

export interface HoldingsOverlapResult {
  available: boolean;
  reason?: string;
  /** number of funds compared (with parseable holdings) */
  fundCount: number;
  fundIds: string[];
  /** stocks held by >= 2 funds, sorted by aggregateWeight desc */
  common: CommonStock[];
  commonStockCount: number;
  /** stocks unique to exactly one fund, grouped per fund */
  distinct: DistinctFundStocks[];
  /** pairwise overlap for every fund pair */
  pairwise: PairwiseOverlap[];
  /** average pairwise weight-overlap across all pairs, as a percentage */
  overallOverlapPct: number;
  /** for each fund, what % of its own weight sits in the common set */
  commonWeightShareByFund: Array<{ fundId: string; sharePct: number }>;
  flags: string[];
}

/** Concentration guideline: a shared name this large across funds is notable. */
const HIGH_AGGREGATE_WEIGHT = 20; // aggregate % across the holding funds
/** Pairwise Jaccard at/above this is "limited diversification benefit". */
const HIGH_JACCARD = 50; // %
/** A fund with at least this many unique names "differentiates". */
const DIFFERENTIATION_DISTINCT_COUNT = 5;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Coerce an arbitrary holding payload into a clean NormalizedHolding. */
function normalizeHolding(raw: unknown): NormalizedHolding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;

  // key: prefer symbol/ticker, fall back to name (upper-trimmed)
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

  // human-readable name: prefer name, fall back to the key source
  const name =
    typeof nameRaw === "string" && nameRaw.trim()
      ? nameRaw.trim()
      : String(keySource).trim() || key;

  // weight: accept weight OR percentage (OR allocation/pct)
  const weightRaw =
    rec.weight ?? rec.percentage ?? rec.allocation ?? rec.pct ?? rec.holdingPct;
  const weight = Number(weightRaw);
  const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 0;

  const sectorRaw = rec.sector;
  const sector =
    typeof sectorRaw === "string" && sectorRaw.trim() ? sectorRaw.trim() : null;

  return { key, name, weight: safeWeight, sector };
}

/** Coerce a single fund entry (or a bare {holdings} payload). */
function normalizeFund(raw: unknown, index: number): NormalizedFund | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;

  const holdingsRaw = Array.isArray(rec.holdings)
    ? rec.holdings
    : Array.isArray(rec.data)
      ? rec.data
      : null;
  if (!Array.isArray(holdingsRaw)) return null;

  const weightByKey = new Map<string, number>();
  const order: string[] = [];
  const nameByKey = new Map<string, string>();
  const sectorByKey = new Map<string, string | null>();

  for (const h of holdingsRaw) {
    const norm = normalizeHolding(h);
    if (!norm) continue;
    if (!weightByKey.has(norm.key)) {
      order.push(norm.key);
      nameByKey.set(norm.key, norm.name);
      sectorByKey.set(norm.key, norm.sector);
    }
    weightByKey.set(norm.key, (weightByKey.get(norm.key) ?? 0) + norm.weight);
    // backfill a sector/name if the first sighting lacked it
    if (!sectorByKey.get(norm.key) && norm.sector) {
      sectorByKey.set(norm.key, norm.sector);
    }
  }

  if (weightByKey.size === 0) return null;

  const id =
    typeof rec.id === "string" && rec.id.trim()
      ? rec.id.trim()
      : typeof rec.symbol === "string" && rec.symbol.trim()
        ? rec.symbol.trim()
        : `fund_${index}`;
  const name =
    typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;

  const holdings: NormalizedHolding[] = order.map((key) => ({
    key,
    name: nameByKey.get(key) ?? key,
    weight: weightByKey.get(key) ?? 0,
    sector: sectorByKey.get(key) ?? null,
  }));

  let totalWeight = 0;
  for (const w of Array.from(weightByKey.values())) totalWeight += w;

  return { id, name, holdings, weightByKey, totalWeight };
}

/** Accept funds[] OR a single bare {holdings} payload. */
function normalizeFunds(params: Record<string, unknown>): NormalizedFund[] {
  const rawFunds = params.funds;
  let candidates: unknown[];
  if (Array.isArray(rawFunds)) {
    candidates = rawFunds;
  } else if (Array.isArray(params.holdings)) {
    // a single fund passed as a bare {holdings} payload
    candidates = [params];
  } else {
    candidates = [];
  }

  const funds: NormalizedFund[] = [];
  const usedIds = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const f = normalizeFund(candidates[i], i);
    if (!f) continue;
    // de-dupe ids so pairwise keys stay unambiguous
    let id = f.id;
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `${f.id}_${suffix++}`;
    }
    usedIds.add(id);
    funds.push({ ...f, id });
  }
  return funds;
}

export const computeHoldingsOverlapTool: ResearchToolDef = {
  name: "compute_holdings_overlap",
  description:
    "Decompose the constituent stocks of 2+ funds into common vs distinct holdings - pairwise Jaccard, weight overlap, per-fund common-weight share, and concentration/diversification flags",
  category: "computation",
  parameters: {
    funds: {
      type: "array",
      description:
        "Array of funds to compare (executor-injected, one per fetch_mf_holdings): each { id, name?, holdings: [{ symbol|name, weight|percentage, sector?, marketCap? }] }. A single { holdings } payload is also accepted.",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const funds = normalizeFunds(params);

      // Graceful degradation: overlap needs at least 2 funds with holdings.
      if (funds.length < 2) {
        const result: HoldingsOverlapResult = {
          available: false,
          reason: "need >=2 funds with holdings",
          fundCount: funds.length,
          fundIds: funds.map((f) => f.id),
          common: [],
          commonStockCount: 0,
          distinct: funds.map((f) => ({
            fundId: f.id,
            holdings: f.holdings
              .slice()
              .sort((a, b) => b.weight - a.weight)
              .map((h) => ({
                key: h.key,
                name: h.name,
                weight: round2(h.weight),
                sector: h.sector,
              })),
          })),
          pairwise: [],
          overallOverlapPct: 0,
          commonWeightShareByFund: [],
          flags: [],
        };
        return { success: true, data: result };
      }

      const fundIds = funds.map((f) => f.id);
      const fundById = new Map<string, NormalizedFund>(
        funds.map((f) => [f.id, f]),
      );

      // ── Count how many funds hold each key ───────────────────────────
      const fundCountByKey = new Map<string, number>();
      for (const f of funds) {
        for (const key of Array.from(f.weightByKey.keys())) {
          fundCountByKey.set(key, (fundCountByKey.get(key) ?? 0) + 1);
        }
      }

      // ── COMMON set: keys held by >= 2 funds ──────────────────────────
      const common: CommonStock[] = [];
      const commonKeys = new Set<string>();
      for (const [key, count] of Array.from(fundCountByKey.entries())) {
        if (count < 2) continue;
        commonKeys.add(key);

        const perFund: Array<{ fundId: string; weight: number }> = [];
        let name = key;
        let sector: string | null = null;
        const weights: number[] = [];
        for (const f of funds) {
          const w = f.weightByKey.get(key);
          if (w === undefined) continue;
          perFund.push({ fundId: f.id, weight: round2(w) });
          weights.push(w);
          // capture a readable name/sector from a holding that has them
          const h = f.holdings.find((x) => x.key === key);
          if (h) {
            if (name === key && h.name) name = h.name;
            if (sector === null && h.sector) sector = h.sector;
          }
        }

        const aggregateWeight = weights.reduce((s, w) => s + w, 0);
        const minWeight = Math.min(...weights);
        const maxWeight = Math.max(...weights);
        common.push({
          key,
          name,
          sector,
          fundCount: count,
          perFund,
          aggregateWeight: round2(aggregateWeight),
          avgWeight: round2(aggregateWeight / weights.length),
          minWeight: round2(minWeight),
          maxWeight: round2(maxWeight),
          weightDispersion: round2(maxWeight - minWeight),
        });
      }
      common.sort((a, b) => b.aggregateWeight - a.aggregateWeight);

      // ── DISTINCT set: keys unique to exactly one fund ────────────────
      const distinct: DistinctFundStocks[] = funds.map((f) => {
        const uniques = f.holdings
          .filter((h) => (fundCountByKey.get(h.key) ?? 0) === 1)
          .slice()
          .sort((a, b) => b.weight - a.weight)
          .map((h) => ({
            key: h.key,
            name: h.name,
            weight: round2(h.weight),
            sector: h.sector,
          }));
        return { fundId: f.id, holdings: uniques };
      });

      // ── Pairwise overlap (Jaccard + weight overlap) ──────────────────
      const pairwise: PairwiseOverlap[] = [];
      for (let i = 0; i < funds.length; i++) {
        for (let j = i + 1; j < funds.length; j++) {
          const a = funds[i]!;
          const b = funds[j]!;
          const keysA = new Set(a.weightByKey.keys());
          const keysB = new Set(b.weightByKey.keys());

          let sharedCount = 0;
          let weightOverlap = 0;
          for (const key of Array.from(keysA)) {
            if (!keysB.has(key)) continue;
            sharedCount += 1;
            weightOverlap += Math.min(
              a.weightByKey.get(key) ?? 0,
              b.weightByKey.get(key) ?? 0,
            );
          }
          const unionCount = keysA.size + keysB.size - sharedCount;
          const jaccard = unionCount > 0 ? (sharedCount / unionCount) * 100 : 0;

          pairwise.push({
            fundA: a.id,
            fundB: b.id,
            sharedCount,
            jaccard: round1(jaccard),
            weightOverlapPct: round2(weightOverlap),
          });
        }
      }

      const overallOverlapPct =
        pairwise.length > 0
          ? round2(
              pairwise.reduce((s, p) => s + p.weightOverlapPct, 0) /
                pairwise.length,
            )
          : 0;

      // ── Per-fund: what % of the fund's weight is in the common set ───
      const commonWeightShareByFund = funds.map((f) => {
        let commonWeight = 0;
        for (const key of Array.from(f.weightByKey.keys())) {
          if (commonKeys.has(key)) commonWeight += f.weightByKey.get(key) ?? 0;
        }
        const sharePct =
          f.totalWeight > 0 ? (commonWeight / f.totalWeight) * 100 : 0;
        return { fundId: f.id, sharePct: round1(sharePct) };
      });

      // ── Observational flags (SEBI-safe: no winner, no advice) ────────
      const flags: string[] = [];

      // 1. Highly-identical fund pairs (limited diversification benefit).
      for (const p of pairwise) {
        if (p.jaccard >= HIGH_JACCARD) {
          flags.push(
            `Funds ${p.fundA} and ${p.fundB} are ${p.jaccard}% identical by holding - limited diversification benefit from holding both`,
          );
        }
      }

      // 2. A single name large across multiple funds (concentration if combined).
      for (const c of common) {
        if (c.aggregateWeight >= HIGH_AGGREGATE_WEIGHT) {
          flags.push(
            `${c.name} is a ${c.aggregateWeight}% combined position across ${c.fundCount} of the compared funds - concentration risk if held together`,
          );
        }
      }

      // 3. Funds that differentiate with a sizeable unique sleeve.
      for (const d of distinct) {
        if (d.holdings.length >= DIFFERENTIATION_DISTINCT_COUNT) {
          const fund = fundById.get(d.fundId);
          const label = fund?.name ?? d.fundId;
          flags.push(
            `Fund ${label} differentiates with ${d.holdings.length} unique positions not found in the other compared funds`,
          );
        }
      }

      const result: HoldingsOverlapResult = {
        available: true,
        fundCount: funds.length,
        fundIds,
        common,
        commonStockCount: common.length,
        distinct,
        pairwise,
        overallOverlapPct,
        commonWeightShareByFund,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Holdings overlap analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
