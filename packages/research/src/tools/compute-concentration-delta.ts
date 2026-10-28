/**
 * Concentration Delta Analysis (portfolio-aware)
 *
 * How adding/resizing a candidate position shifts portfolio concentration.
 * Computes current vs post HHI (Herfindahl-Hirschman Index), top-holding
 * weight shift, and the candidate sector's weight shift, then flags threshold
 * breaches (>20% single name, >40% sector).
 *
 * PURE compute - no io. Holdings are injected by the executor from a server
 * action. In single-stock research no portfolio context exists, so the tool
 * degrades gracefully (available:false, reason 'no portfolio context').
 *
 * SEBI: observations / scores / flags only. No buy/sell/hold advice.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

interface HoldingInput {
  symbol: string;
  value: number;
  sector?: string;
}

export interface ConcentrationDeltaResult {
  available: boolean;
  reason?: string;
  symbol: string;
  /** Total portfolio value BEFORE adding the candidate */
  currentTotalValue: number;
  /** Total portfolio value AFTER adding/resizing the candidate */
  postTotalValue: number;
  /** Herfindahl-Hirschman Index 0-10000 (sum of weight^2 × 10000) */
  currentHHI: number;
  postHHI: number;
  /** postHHI - currentHHI (positive = more concentrated) */
  hhiDelta: number;
  concentrationDirection: "more_concentrated" | "less_concentrated" | "unchanged";
  /** Largest single-holding weight as a fraction 0-1 */
  currentTopWeight: number;
  postTopWeight: number;
  currentTopSymbol: string;
  postTopSymbol: string;
  /** Candidate's sector exposure as a fraction 0-1 */
  candidateSector: string | null;
  currentSectorWeight: number;
  postSectorWeight: number;
  /** Candidate's own weight in the post portfolio 0-1 */
  candidateWeight: number;
  /** Threshold breaches introduced/sustained by the change */
  breaches: Array<{
    type: "single_name" | "sector";
    label: string;
    weight: number;
    threshold: number;
  }>;
  flags: string[];
}

const SINGLE_NAME_THRESHOLD = 0.2; // 20% of portfolio in one name
const SECTOR_THRESHOLD = 0.4; // 40% of portfolio in one sector

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** HHI in 0-10000 space from an array of positive position values. */
function computeHHI(values: number[], total: number): number {
  if (total <= 0) return 0;
  let hhi = 0;
  for (const v of values) {
    const w = v / total;
    hhi += w * w;
  }
  return Math.round(hhi * 10000);
}

/** Coerce an arbitrary upstream holdings payload into clean HoldingInput[]. */
function normalizeHoldings(raw: unknown): HoldingInput[] {
  if (!Array.isArray(raw)) return [];
  const out: HoldingInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const symbol = String(rec.symbol ?? rec.tradingsymbol ?? rec.name ?? "")
      .replace(/\.(NS|BO)$/i, "")
      .toUpperCase()
      .trim();
    const value = Number(rec.value ?? rec.currentValue ?? rec.marketValue ?? 0);
    if (!symbol || !Number.isFinite(value) || value <= 0) continue;
    const sectorRaw = rec.sector;
    const sector =
      typeof sectorRaw === "string" && sectorRaw.trim()
        ? sectorRaw.trim()
        : undefined;
    out.push({ symbol, value, sector });
  }
  return out;
}

export const computeConcentrationDeltaTool: ResearchToolDef = {
  name: "compute_concentration_delta",
  description:
    "Show how adding/resizing a candidate position shifts portfolio HHI, top-holding weight, and sector weight - flags >20% single-name and >40% sector breaches",
  category: "computation",
  parameters: {
    holdings: {
      type: "array",
      description:
        "Portfolio holdings (server-action injected): array of { symbol, value, sector? }. Absent in single-stock research.",
    },
    candidateSymbol: {
      type: "string",
      description: "Symbol of the candidate position being added/resized",
      required: true,
    },
    candidateValue: {
      type: "number",
      description:
        "Rupee value to add to the candidate position (the size of the new/incremental position)",
      required: true,
    },
    candidateSector: {
      type: "string",
      description: "Sector of the candidate (for sector-concentration math)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const candidateSymbol = String(params.candidateSymbol ?? "")
        .replace(/\.(NS|BO)$/i, "")
        .toUpperCase()
        .trim();

      const candidateSector =
        typeof params.candidateSector === "string" &&
        params.candidateSector.trim()
          ? params.candidateSector.trim()
          : null;

      const addValueRaw = Number(params.candidateValue);
      const addValue =
        Number.isFinite(addValueRaw) && addValueRaw > 0 ? addValueRaw : 0;

      const holdings = normalizeHoldings(params.holdings);

      // Graceful degradation: no portfolio context (expected in single-stock research)
      if (holdings.length === 0) {
        const result: ConcentrationDeltaResult = {
          available: false,
          reason: "no portfolio context",
          symbol: candidateSymbol,
          currentTotalValue: 0,
          postTotalValue: 0,
          currentHHI: 0,
          postHHI: 0,
          hhiDelta: 0,
          concentrationDirection: "unchanged",
          currentTopWeight: 0,
          postTopWeight: 0,
          currentTopSymbol: "",
          postTopSymbol: "",
          candidateSector,
          currentSectorWeight: 0,
          postSectorWeight: 0,
          candidateWeight: 0,
          breaches: [],
          flags: [],
        };
        return { success: true, data: result };
      }

      // ── Current portfolio state ──────────────────────────────
      const currentTotalValue = holdings.reduce((s, h) => s + h.value, 0);
      const currentValues = holdings.map((h) => h.value);
      const currentHHI = computeHHI(currentValues, currentTotalValue);

      // Current top holding
      let currentTopSymbol = "";
      let currentTopValue = 0;
      for (const h of holdings) {
        if (h.value > currentTopValue) {
          currentTopValue = h.value;
          currentTopSymbol = h.symbol;
        }
      }
      const currentTopWeight =
        currentTotalValue > 0 ? currentTopValue / currentTotalValue : 0;

      // Current sector weight for the candidate's sector
      let currentSectorValue = 0;
      if (candidateSector) {
        for (const h of holdings) {
          if (
            h.sector &&
            h.sector.toLowerCase() === candidateSector.toLowerCase()
          ) {
            currentSectorValue += h.value;
          }
        }
      }
      const currentSectorWeight =
        currentTotalValue > 0 ? currentSectorValue / currentTotalValue : 0;

      // ── Post-change portfolio state ──────────────────────────
      // Merge the candidate value into an existing holding if symbol matches,
      // otherwise treat it as a new position.
      const postPositions = new Map<string, number>();
      for (const h of holdings) {
        postPositions.set(h.symbol, (postPositions.get(h.symbol) ?? 0) + h.value);
      }
      postPositions.set(
        candidateSymbol,
        (postPositions.get(candidateSymbol) ?? 0) + addValue,
      );

      const postTotalValue = currentTotalValue + addValue;
      const postValues = Array.from(postPositions.values());
      const postHHI = computeHHI(postValues, postTotalValue);

      // Post top holding
      let postTopSymbol = "";
      let postTopValue = 0;
      // Array.from() (not direct Map iteration) — the web app's tsconfig
      // target rejects for-of over a Map without downlevelIteration.
      for (const [sym, val] of Array.from(postPositions.entries())) {
        if (val > postTopValue) {
          postTopValue = val;
          postTopSymbol = sym;
        }
      }
      const postTopWeight =
        postTotalValue > 0 ? postTopValue / postTotalValue : 0;

      // Post sector weight (current sector value + candidate's add, if same sector)
      const postSectorValue = currentSectorValue + (candidateSector ? addValue : 0);
      const postSectorWeight =
        postTotalValue > 0 && candidateSector
          ? postSectorValue / postTotalValue
          : 0;

      // Candidate's own weight post-change
      const candidatePostValue = postPositions.get(candidateSymbol) ?? addValue;
      const candidateWeight =
        postTotalValue > 0 ? candidatePostValue / postTotalValue : 0;

      const hhiDelta = postHHI - currentHHI;
      let concentrationDirection: ConcentrationDeltaResult["concentrationDirection"] =
        "unchanged";
      if (hhiDelta > 0) concentrationDirection = "more_concentrated";
      else if (hhiDelta < 0) concentrationDirection = "less_concentrated";

      // ── Threshold breaches & flags (observations only) ───────
      const breaches: ConcentrationDeltaResult["breaches"] = [];
      const flags: string[] = [];

      if (candidateWeight > SINGLE_NAME_THRESHOLD) {
        breaches.push({
          type: "single_name",
          label: candidateSymbol,
          weight: round4(candidateWeight),
          threshold: SINGLE_NAME_THRESHOLD,
        });
        flags.push(
          `${candidateSymbol} would be ${(candidateWeight * 100).toFixed(1)}% of the portfolio, above the 20% single-name concentration guideline`,
        );
      }

      // Surface any other post-change single-name breach (e.g. an existing
      // holding pushed over 20% by the smaller denominator change — rare, but
      // most often the candidate itself when it merges into a big position).
      if (
        postTopSymbol &&
        postTopSymbol !== candidateSymbol &&
        postTopWeight > SINGLE_NAME_THRESHOLD
      ) {
        breaches.push({
          type: "single_name",
          label: postTopSymbol,
          weight: round4(postTopWeight),
          threshold: SINGLE_NAME_THRESHOLD,
        });
        flags.push(
          `Top holding ${postTopSymbol} remains above the 20% single-name guideline at ${(postTopWeight * 100).toFixed(1)}%`,
        );
      }

      if (candidateSector && postSectorWeight > SECTOR_THRESHOLD) {
        breaches.push({
          type: "sector",
          label: candidateSector,
          weight: round4(postSectorWeight),
          threshold: SECTOR_THRESHOLD,
        });
        flags.push(
          `${candidateSector} sector would reach ${(postSectorWeight * 100).toFixed(1)}% of the portfolio, above the 40% sector concentration guideline`,
        );
      }

      if (hhiDelta > 0) {
        flags.push(
          `Adding ${candidateSymbol} raises portfolio concentration (HHI ${currentHHI} → ${postHHI}, +${hhiDelta})`,
        );
      } else if (hhiDelta < 0) {
        flags.push(
          `Adding ${candidateSymbol} improves diversification (HHI ${currentHHI} → ${postHHI}, ${hhiDelta})`,
        );
      }

      if (candidateSector === null) {
        flags.push(
          "Candidate sector unknown - sector-concentration impact not assessed",
        );
      }

      const result: ConcentrationDeltaResult = {
        available: true,
        symbol: candidateSymbol,
        currentTotalValue: round2(currentTotalValue),
        postTotalValue: round2(postTotalValue),
        currentHHI,
        postHHI,
        hhiDelta,
        concentrationDirection,
        currentTopWeight: round4(currentTopWeight),
        postTopWeight: round4(postTopWeight),
        currentTopSymbol,
        postTopSymbol,
        candidateSector,
        currentSectorWeight: round4(currentSectorWeight),
        postSectorWeight: round4(postSectorWeight),
        candidateWeight: round4(candidateWeight),
        breaches,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Concentration delta analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
