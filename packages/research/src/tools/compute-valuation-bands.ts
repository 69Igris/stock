/**
 * Valuation Bands - 5-year PE and PB band analysis
 *
 * Computes mean, standard deviation, ±1σ and ±2σ bands for PE and PB,
 * determines current position relative to bands, and assigns a valuation zone.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

type ValuationZone = "deep_value" | "value" | "fair" | "expensive" | "bubble";

interface BandValues {
  minus2SD: number;
  minus1SD: number;
  mean: number;
  plus1SD: number;
  plus2SD: number;
}

interface MultipleBandResult {
  mean: number;
  sd: number;
  bands: BandValues;
  current: number;
  zone: ValuationZone;
  zScore: number;
  percentileApprox: number;
  dataPoints: number;
}

interface ValuationBandsResult {
  pe: MultipleBandResult | null;
  pb: MultipleBandResult | null;
  combinedVerdict: string;
  combinedZone: ValuationZone;
  flags: string[];
}

function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function computeStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  const variance =
    squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function zScoreToPercentileApprox(z: number): number {
  // Approximate cumulative normal distribution using logistic approximation
  // P(Z <= z) ≈ 1 / (1 + exp(-1.7 * z))
  const p = 1 / (1 + Math.exp(-1.7 * z));
  return Math.round(p * 10000) / 100;
}

function determineZone(zScore: number): ValuationZone {
  if (zScore < -2) return "deep_value";
  if (zScore < -1) return "value";
  if (zScore <= 1) return "fair";
  if (zScore <= 2) return "expensive";
  return "bubble";
}

function computeBandResult(
  history: Array<{ date: string; value: number }>,
  current: number,
): MultipleBandResult | null {
  // Filter out invalid entries
  const valid = history.filter(
    (h) => h.value != null && isFinite(h.value) && h.value > 0,
  );

  if (valid.length < 10) return null;

  const values = valid.map((h) => h.value);
  const mean = computeMean(values);
  const sd = computeStdDev(values, mean);

  if (sd === 0) {
    return {
      mean: Math.round(mean * 100) / 100,
      sd: 0,
      bands: {
        minus2SD: Math.round(mean * 100) / 100,
        minus1SD: Math.round(mean * 100) / 100,
        mean: Math.round(mean * 100) / 100,
        plus1SD: Math.round(mean * 100) / 100,
        plus2SD: Math.round(mean * 100) / 100,
      },
      current: Math.round(current * 100) / 100,
      zone: "fair",
      zScore: 0,
      percentileApprox: 50,
      dataPoints: values.length,
    };
  }

  const zScore = (current - mean) / sd;
  const zone = determineZone(zScore);
  const percentileApprox = zScoreToPercentileApprox(zScore);

  return {
    mean: Math.round(mean * 100) / 100,
    sd: Math.round(sd * 100) / 100,
    bands: {
      minus2SD: Math.round((mean - 2 * sd) * 100) / 100,
      minus1SD: Math.round((mean - sd) * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      plus1SD: Math.round((mean + sd) * 100) / 100,
      plus2SD: Math.round((mean + 2 * sd) * 100) / 100,
    },
    current: Math.round(current * 100) / 100,
    zone,
    zScore: Math.round(zScore * 100) / 100,
    percentileApprox,
    dataPoints: values.length,
  };
}

export const computeValuationBandsTool: ResearchToolDef = {
  name: "compute_valuation_bands",
  description:
    "Compute 5-year PE and PB bands with mean, ±1σ/±2σ zones, and current position - identifies deep value, fair value, or bubble territory",
  category: "computation",
  parameters: {
    pe_history: {
      type: "array",
      description:
        "Array of { date: string, pe: number } for historical PE values",
      required: true,
    },
    pb_history: {
      type: "array",
      description:
        "Array of { date: string, pb: number } for historical PB values",
      required: true,
    },
    current_pe: {
      type: "number",
      description: "Current PE ratio",
      required: true,
    },
    current_pb: {
      type: "number",
      description: "Current PB ratio",
      required: true,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const peHistory = params.pe_history as
      | Array<{ date: string; pe: number }>
      | undefined;
    const pbHistory = params.pb_history as
      | Array<{ date: string; pb: number }>
      | undefined;
    const currentPE = params.current_pe as number | undefined;
    const currentPB = params.current_pb as number | undefined;

    if (
      (!peHistory || peHistory.length === 0) &&
      (!pbHistory || pbHistory.length === 0)
    ) {
      return insufficientInput(
        "At least one of pe_history or pb_history is required",
      );
    }

    if (currentPE == null && currentPB == null) {
      return insufficientInput(
        "At least one of current_pe or current_pb is required",
      );
    }

    try {
      // Compute PE bands
      const pe =
        peHistory && peHistory.length > 0 && currentPE != null
          ? computeBandResult(
              peHistory.map((h) => ({ date: h.date, value: h.pe })),
              currentPE,
            )
          : null;

      // Compute PB bands
      const pb =
        pbHistory && pbHistory.length > 0 && currentPB != null
          ? computeBandResult(
              pbHistory.map((h) => ({ date: h.date, value: h.pb })),
              currentPB,
            )
          : null;

      if (!pe && !pb) {
        return insufficientInput(
          "Insufficient data to compute valuation bands (need at least 10 data points)",
        );
      }

      // Combined zone - average the z-scores where available
      const zScores: number[] = [];
      if (pe) zScores.push(pe.zScore);
      if (pb) zScores.push(pb.zScore);

      const avgZScore =
        zScores.length > 0
          ? zScores.reduce((a, b) => a + b, 0) / zScores.length
          : 0;
      const combinedZone = determineZone(avgZScore);

      // Generate verdict
      const flags: string[] = [];
      let combinedVerdict = "";

      switch (combinedZone) {
        case "deep_value":
          combinedVerdict =
            "Stock is trading significantly below historical averages - potential deep value or distress signal. Verify fundamentals haven't deteriorated.";
          flags.push(
            "Trading below -2σ of historical valuation - deep value territory",
          );
          break;
        case "value":
          combinedVerdict =
            "Stock is trading below historical averages - may represent a value opportunity if fundamentals are intact.";
          flags.push("Trading between -1σ and -2σ - below-average valuation");
          break;
        case "fair":
          combinedVerdict =
            "Stock is trading within one standard deviation of its historical mean - fairly valued relative to its own history.";
          break;
        case "expensive":
          combinedVerdict =
            "Stock is trading above historical averages - premium valuation that needs strong growth to justify.";
          flags.push("Trading between +1σ and +2σ - above-average valuation");
          break;
        case "bubble":
          combinedVerdict =
            "Stock is trading far above historical norms - extreme premium territory. Exercise caution unless supported by exceptional growth catalysts.";
          flags.push(
            "Trading above +2σ - extreme premium, potential bubble territory",
          );
          break;
      }

      // Check for PE/PB divergence
      if (pe && pb) {
        const zDiff = Math.abs(pe.zScore - pb.zScore);
        if (zDiff > 1.5) {
          flags.push(
            `PE and PB zones diverge (PE z=${pe.zScore}, PB z=${pb.zScore}) - investigate book value dynamics`,
          );
        }
      }

      const result: ValuationBandsResult = {
        pe,
        pb,
        combinedVerdict,
        combinedZone,
        flags,
      };

      return {
        success: true,
        data: result,
        metadata: {
          peDataPoints: pe?.dataPoints ?? 0,
          pbDataPoints: pb?.dataPoints ?? 0,
          combinedZScore: Math.round(avgZScore * 100) / 100,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Valuation bands computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
