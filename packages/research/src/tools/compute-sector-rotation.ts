/**
 * Sector Rotation / Relative-Strength Positioning
 *
 * PURE compute tool. Given a set of sector performance readings
 * (1m/3m/6m returns) it ranks sectors by a blended relative-strength
 * score vs the market, classifies the implied business-cycle phase
 * (early / mid / late / contraction), and places the subject's sector
 * in an RRG-style quadrant (leading / improving / weakening / lagging)
 * derived from (relative strength, relative momentum). Optional FII/DII
 * sector flows reinforce the read when present.
 *
 * SEBI note: this emits OBSERVATIONS, SCORES and FLAGS only. No buy /
 * sell / hold / target-price language. UseMoney is not a SEBI-registered
 * Research Analyst.
 *
 * Inputs are injected by the executor from upstream fetch results:
 *   - sector           ← fetch_company_profile.sector
 *   - sectorPerformances ← fetch_macro_dashboard (sector indices, if present)
 *   - fiiDiiFlows      ← fetch_fii_dii_flows (optional)
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { anySectorKeyMatches } from "@usemoney/core/sector-key-match";

// ─── Result interface ───────────────────────────────────────

export type RrgQuadrant = "leading" | "improving" | "weakening" | "lagging";
export type CyclePhase = "early" | "mid" | "late" | "contraction" | "unknown";

export interface RankedSector {
  sector: string;
  /** Blended relative-strength score vs market (percentage points). */
  relativeStrength: number;
  /** Relative momentum: short-term minus longer-term relative return (pp). */
  relativeMomentum: number;
  /** Composite blend used for ranking (pp). */
  blendedScore: number;
  /** RRG-style quadrant for this sector. */
  quadrant: RrgQuadrant;
  rank: number;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  /** Net FII+DII flow into the sector (INR crore), if supplied. */
  netFlow: number | null;
}

export interface SectorRotationResult {
  available: boolean;
  reason?: string;
  /** Subject sector (from company profile), normalized, if supplied. */
  sector?: string;
  /** Number of sectors that had usable performance data. */
  sectorsRanked?: number;
  /** Blended market return baseline (pp), equal-weighted across sectors. */
  marketBlendedReturn?: number;
  rankedSectors?: RankedSector[];
  /** The subject sector's RRG quadrant, if it was found in the inputs. */
  subjectSectorQuadrant?: RrgQuadrant | null;
  /** The subject sector's rank among ranked sectors (1 = strongest), if found. */
  subjectSectorRank?: number | null;
  /** Implied business-cycle phase from which sector groups are leading. */
  cyclePhase?: CyclePhase;
  /** Plain-language rationale behind the cycle-phase call. */
  cyclePhaseRationale?: string;
  flags?: string[];
}

// ─── Cycle-phase sector groupings (canonical labels, lowercased) ──

const EARLY_CYCLE = [
  "financials",
  "financial services",
  "banks",
  "banking",
  "bank",
  "nbfc",
  "realty",
  "real estate",
  "auto",
  "automobile",
  "consumer discretionary",
];
const MID_CYCLE = [
  "industrials",
  "industrial",
  "capital goods",
  "infrastructure",
  "infra",
  "it",
  "information technology",
  "technology",
  "tech",
  "software",
];
const LATE_CYCLE = [
  "energy",
  "oil & gas",
  "oil and gas",
  "metals",
  "metal",
  "mining",
  "commodities",
  "materials",
  "cement",
];
const DEFENSIVE = [
  "fmcg",
  "consumer staples",
  "staples",
  "pharma",
  "pharmaceuticals",
  "healthcare",
  "health care",
  "utilities",
  "power",
];

// ─── Helpers ────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Number(v.replace(/[%,\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSector(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

function classifyGroup(
  sector: string,
): "early" | "mid" | "late" | "defensive" | "other" {
  // MONEY-1093: `s.includes(k)` with the two-character key "it" in MID_CYCLE
  // matched inside "utIlITies" and "commodITies". Because MID_CYCLE is tested
  // BEFORE LATE_CYCLE and DEFENSIVE — both of which correctly list
  // "commodities" and "utilities" — those two branches were unreachable for
  // those sectors, and the business-cycle phase reported to the user counted
  // Utilities and Commodities as mid-cycle IT.
  //
  // The order of these four tests is deliberate (most specific cycle first), so
  // the fix is the matcher, not the order.
  const hit = (list: string[]) => anySectorKeyMatches(sector, list);
  if (hit(EARLY_CYCLE)) return "early";
  if (hit(MID_CYCLE)) return "mid";
  if (hit(LATE_CYCLE)) return "late";
  if (hit(DEFENSIVE)) return "defensive";
  return "other";
}

interface RawPerf {
  sector: string;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
}

function parsePerformances(raw: unknown): RawPerf[] {
  if (!Array.isArray(raw)) return [];
  const out: RawPerf[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const sector = normalizeSector(rec.sector ?? rec.name ?? rec.index);
    if (!sector) continue;
    out.push({
      sector,
      ret1m: toNum(rec.ret1m ?? rec.return1m ?? rec.r1m ?? rec.oneMonth),
      ret3m: toNum(rec.ret3m ?? rec.return3m ?? rec.r3m ?? rec.threeMonth),
      ret6m: toNum(rec.ret6m ?? rec.return6m ?? rec.r6m ?? rec.sixMonth),
    });
  }
  return out;
}

/** Map of normalized-lowercase sector → net flow (INR crore). */
function parseFlows(raw: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const sector = normalizeSector(rec.sector ?? rec.name);
    if (!sector) continue;
    const fii = toNum(rec.fii ?? rec.fiiNet ?? rec.fiiFlow);
    const dii = toNum(rec.dii ?? rec.diiNet ?? rec.diiFlow);
    const explicitNet = toNum(rec.net ?? rec.netFlow);
    const net = explicitNet != null ? explicitNet : (fii ?? 0) + (dii ?? 0);
    if (net !== 0 || explicitNet != null || fii != null || dii != null) {
      map.set(sector.toLowerCase(), round2(net));
    }
  }
  return map;
}

// ─── Tool ───────────────────────────────────────────────────

export const computeSectorRotationTool: ResearchToolDef = {
  name: "compute_sector_rotation",
  description:
    "Rank sectors by blended relative strength vs market, classify business-cycle phase, and place the subject's sector in an RRG-style quadrant",
  category: "computation",
  parameters: {
    sector: {
      type: "string",
      description:
        "Subject company's sector (from company profile) to locate in the rotation map",
    },
    sectorPerformances: {
      type: "array",
      description:
        "Array of { sector, ret1m, ret3m, ret6m } percentage returns per sector (from macro dashboard sector indices)",
      required: true,
    },
    fiiDiiFlows: {
      type: "array",
      description:
        "Optional array of { sector, fii, dii } net flows (INR crore) to reinforce the relative-strength read",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const subjectSector = normalizeSector(params.sector);
      const perfs = parsePerformances(params.sectorPerformances);
      const usable = perfs.filter(
        (p) => p.ret1m != null || p.ret3m != null || p.ret6m != null,
      );

      if (usable.length === 0) {
        const degraded: SectorRotationResult = {
          available: false,
          reason:
            "No sector performance data available to compute sector rotation",
          sector: subjectSector || undefined,
        };
        return { success: true, data: degraded };
      }

      const flows = parseFlows(params.fiiDiiFlows);

      // ── Market baseline: equal-weighted blended return across sectors.
      // Blend favours medium-term: 0.5×3m + 0.3×6m + 0.2×1m, using
      // whatever windows each sector has (re-weighted on availability).
      const blendOf = (p: RawPerf): number | null => {
        const parts: Array<{ w: number; v: number }> = [];
        if (p.ret1m != null) parts.push({ w: 0.2, v: p.ret1m });
        if (p.ret3m != null) parts.push({ w: 0.5, v: p.ret3m });
        if (p.ret6m != null) parts.push({ w: 0.3, v: p.ret6m });
        if (parts.length === 0) return null;
        const wSum = parts.reduce((a, b) => a + b.w, 0);
        const vSum = parts.reduce((a, b) => a + b.w * b.v, 0);
        return vSum / wSum;
      };

      const blended = usable.map((p) => ({ p, blend: blendOf(p)! }));
      const marketBlended =
        blended.reduce((a, b) => a + b.blend, 0) / blended.length;

      // Relative momentum baseline: average of (short - long) spread.
      const momentumOf = (p: RawPerf): number => {
        const short = p.ret1m ?? p.ret3m ?? 0;
        const long = p.ret6m ?? p.ret3m ?? p.ret1m ?? 0;
        return short - long;
      };
      const marketMomentum =
        usable.reduce((a, p) => a + momentumOf(p), 0) / usable.length;

      // ── Per-sector scoring.
      const scored: RankedSector[] = blended.map(({ p, blend }) => {
        const relativeStrength = round2(blend - marketBlended);
        const relativeMomentum = round2(momentumOf(p) - marketMomentum);
        // Composite tilts to strength but rewards positive momentum.
        const blendedScore = round2(
          0.7 * relativeStrength + 0.3 * relativeMomentum,
        );
        const strongRs = relativeStrength >= 0;
        const strongMom = relativeMomentum >= 0;
        const quadrant: RrgQuadrant = strongRs
          ? strongMom
            ? "leading"
            : "weakening"
          : strongMom
            ? "improving"
            : "lagging";
        return {
          sector: p.sector,
          relativeStrength,
          relativeMomentum,
          blendedScore,
          quadrant,
          rank: 0,
          ret1m: p.ret1m,
          ret3m: p.ret3m,
          ret6m: p.ret6m,
          netFlow: flows.get(p.sector.toLowerCase()) ?? null,
        };
      });

      scored.sort((a, b) => b.blendedScore - a.blendedScore);
      scored.forEach((s, i) => {
        s.rank = i + 1;
      });

      // ── Subject sector lookup (case-insensitive, substring tolerant).
      let subjectMatch: RankedSector | null = null;
      if (subjectSector) {
        const lc = subjectSector.toLowerCase();
        subjectMatch =
          scored.find((s) => s.sector.toLowerCase() === lc) ??
          scored.find(
            (s) =>
              s.sector.toLowerCase().includes(lc) ||
              lc.includes(s.sector.toLowerCase()),
          ) ??
          null;
      }

      // ── Business-cycle phase from which groups are leading.
      // Leadership = average blended relative strength of each group.
      const groupScores: Record<string, { sum: number; count: number }> = {
        early: { sum: 0, count: 0 },
        mid: { sum: 0, count: 0 },
        late: { sum: 0, count: 0 },
        defensive: { sum: 0, count: 0 },
      };
      for (const s of scored) {
        const g = classifyGroup(s.sector);
        if (g === "other") continue;
        groupScores[g]!.sum += s.relativeStrength;
        groupScores[g]!.count += 1;
      }
      const groupAvg = (g: string): number | null => {
        const gs = groupScores[g]!;
        return gs.count > 0 ? gs.sum / gs.count : null;
      };

      let cyclePhase: CyclePhase = "unknown";
      let cyclePhaseRationale =
        "Insufficient mapped sectors to infer a business-cycle phase";
      const phaseCandidates: Array<{ phase: CyclePhase; score: number }> = [];
      const earlyAvg = groupAvg("early");
      const midAvg = groupAvg("mid");
      const lateAvg = groupAvg("late");
      const defAvg = groupAvg("defensive");
      if (earlyAvg != null)
        phaseCandidates.push({ phase: "early", score: earlyAvg });
      if (midAvg != null) phaseCandidates.push({ phase: "mid", score: midAvg });
      if (lateAvg != null)
        phaseCandidates.push({ phase: "late", score: lateAvg });
      if (defAvg != null)
        phaseCandidates.push({ phase: "contraction", score: defAvg });

      if (phaseCandidates.length > 0) {
        phaseCandidates.sort((a, b) => b.score - a.score);
        const leader = phaseCandidates[0]!;
        cyclePhase = leader.phase;
        const groupLabel: Record<CyclePhase, string> = {
          early: "early-cycle sectors (financials, realty, auto)",
          mid: "mid-cycle sectors (industrials, IT)",
          late: "late-cycle sectors (energy, metals)",
          contraction: "defensive sectors (FMCG, pharma, utilities)",
          unknown: "no clearly leading group",
        };
        cyclePhaseRationale = `${groupLabel[cyclePhase]} are showing the strongest relative strength (avg ${round2(leader.score)}pp vs market), implying a ${cyclePhase === "contraction" ? "defensive / late-contraction" : cyclePhase + "-cycle"} positioning`;
      }

      // ── Flags (observations only — no advice language).
      const flags: string[] = [];
      const leader = scored[0]!;
      const laggard = scored[scored.length - 1]!;
      flags.push(
        `${leader.sector} is the strongest sector (rank 1, ${leader.relativeStrength >= 0 ? "+" : ""}${leader.relativeStrength}pp vs market, ${leader.quadrant})`,
      );
      if (scored.length > 1) {
        flags.push(
          `${laggard.sector} is the weakest sector (rank ${laggard.rank}, ${laggard.relativeStrength}pp vs market, ${laggard.quadrant})`,
        );
      }

      if (subjectMatch) {
        flags.push(
          `Subject sector ${subjectMatch.sector} sits in the ${subjectMatch.quadrant} quadrant (rank ${subjectMatch.rank} of ${scored.length}, ${subjectMatch.relativeStrength >= 0 ? "+" : ""}${subjectMatch.relativeStrength}pp relative strength)`,
        );
        if (subjectMatch.quadrant === "improving") {
          flags.push(
            `${subjectMatch.sector} relative momentum is positive while strength is still below market — early-recovery profile`,
          );
        } else if (subjectMatch.quadrant === "weakening") {
          flags.push(
            `${subjectMatch.sector} is still above market on strength but momentum is fading — watch for rotation out`,
          );
        }
        if (subjectMatch.netFlow != null) {
          const dir = subjectMatch.netFlow >= 0 ? "inflow" : "outflow";
          const reinforces =
            (subjectMatch.netFlow >= 0 && subjectMatch.relativeStrength >= 0) ||
            (subjectMatch.netFlow < 0 && subjectMatch.relativeStrength < 0);
          flags.push(
            `FII/DII net ${dir} of ${Math.abs(subjectMatch.netFlow)} cr ${reinforces ? "reinforces" : "diverges from"} the relative-strength read for ${subjectMatch.sector}`,
          );
        }
      } else if (subjectSector) {
        flags.push(
          `Subject sector "${subjectSector}" was not found among the supplied sector performances — could not place it in the rotation map`,
        );
      }

      const result: SectorRotationResult = {
        available: true,
        sector: subjectSector || undefined,
        sectorsRanked: scored.length,
        marketBlendedReturn: round2(marketBlended),
        rankedSectors: scored,
        subjectSectorQuadrant: subjectMatch ? subjectMatch.quadrant : null,
        subjectSectorRank: subjectMatch ? subjectMatch.rank : null,
        cyclePhase,
        cyclePhaseRationale,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Sector rotation analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
