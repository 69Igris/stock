/**
 * Volume Profile Analysis
 *
 * Volume-by-price profile from OHLCV. Buckets the price range into ~20 bins
 * and assigns each bar's volume to the bin of its typical price ((H+L+C)/3).
 * Surfaces Point of Control (POC), the 70% Value Area (VAH/VAL), high/low
 * volume nodes, volume trend, up/down volume (accumulation vs distribution),
 * and recent volume vs average.
 *
 * PURE compute tool: reads everything from params (closes/highs/lows/volumes
 * supplied by the executor from fetch_price_history.prices[]). No io.
 *
 * Observations / scores / flags only - no buy/sell/hold advice (SEBI: UseMoney
 * is not a registered Research Analyst).
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface VolumeProfilePriceLevel {
  /** Bin midpoint price */
  price: number;
  /** Lower edge of the bin */
  priceLow: number;
  /** Upper edge of the bin */
  priceHigh: number;
  /** Total volume that landed in this bin */
  volume: number;
  /** Volume as a share of total volume (0-1) */
  volumePercent: number;
}

export interface VolumeProfileResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Number of bars used in the profile */
  bars?: number;
  /** ~20 price bins from low to high */
  levels?: VolumeProfilePriceLevel[];
  /** Point of Control - the highest-volume price bin midpoint */
  poc?: number;
  /** Value Area High - top of the smallest contiguous band holding ~70% volume */
  valueAreaHigh?: number;
  /** Value Area Low - bottom of that band */
  valueAreaLow?: number;
  /** Share of total volume captured by the value area (0-1) */
  valueAreaVolumePercent?: number;
  /** Bin midpoints flagged as high-volume nodes (>=1.5x mean bin volume) */
  highVolumeNodes?: number[];
  /** Bin midpoints flagged as low-volume nodes (<=0.5x mean bin volume) */
  lowVolumeNodes?: number[];
  /** Average-volume trend: last 20 bars vs the prior 20 */
  volumeTrend?: "rising" | "falling" | "flat";
  /** Sum(up-close volume) / sum(down-close volume); >1 accumulation, <1 distribution */
  upDownVolumeRatio?: number;
  /** Last bar volume / 50-bar average volume; >1.5 = surge */
  recentVolumeVsAvg?: number;
  /** Where the latest close sits relative to the value area */
  priceVsValueArea?: "above" | "inside" | "below";
  /** Observational flags - no recommendations */
  flags?: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Coerce an unknown array param into a clean number[] (drops non-finite). */
function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export const computeVolumeProfileTool: ResearchToolDef = {
  name: "compute_volume_profile",
  description:
    "Compute volume-by-price profile from OHLCV - POC, 70% value area (VAH/VAL), high/low volume nodes, volume trend, up/down volume ratio, and recent volume vs average",
  category: "computation",
  parameters: {
    closes: {
      type: "array",
      description:
        "Array of closing prices sorted chronologically (oldest first). Required.",
      required: true,
    },
    highs: {
      type: "array",
      description:
        "Array of high prices (same order/length as closes). Optional - falls back to close.",
    },
    lows: {
      type: "array",
      description:
        "Array of low prices (same order/length as closes). Optional - falls back to close.",
    },
    volumes: {
      type: "array",
      description:
        "Array of volumes (same order/length as closes). Required - profile is undefined without it.",
    },
    symbol: {
      type: "string",
      description: "Symbol for labelling the result (optional)",
    },
    bins: {
      type: "number",
      description: "Number of price bins to bucket the range into",
      default: 20,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string"
        ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
        : undefined;

    const closes = toNumberArray(params.closes);
    const volumes = toNumberArray(params.volumes);
    const highsRaw = toNumberArray(params.highs);
    const lowsRaw = toNumberArray(params.lows);

    // ── Graceful degradation: honest "—" instead of fabricated numbers ──
    if (closes.length === 0) {
      return {
        success: true,
        data: {
          available: false,
          reason: "No closing prices provided",
          symbol,
        } satisfies VolumeProfileResult,
      };
    }
    if (volumes.length === 0) {
      return {
        success: true,
        data: {
          available: false,
          reason: "Volume data unavailable - cannot build a volume profile",
          symbol,
        } satisfies VolumeProfileResult,
      };
    }

    try {
      // Align all series to the shortest length so indices line up safely.
      const n = Math.min(closes.length, volumes.length);
      if (n < 20) {
        return {
          success: true,
          data: {
            available: false,
            reason: `Insufficient bars (${n}) - need at least 20 for a volume profile`,
            symbol,
          } satisfies VolumeProfileResult,
        };
      }

      const c = closes.slice(closes.length - n);
      const vol = volumes.slice(volumes.length - n);
      const hasHighs = highsRaw.length >= n;
      const hasLows = lowsRaw.length >= n;
      const h = hasHighs ? highsRaw.slice(highsRaw.length - n) : null;
      const l = hasLows ? lowsRaw.slice(lowsRaw.length - n) : null;

      // Typical price per bar: (H+L+C)/3, falling back to close if H/L absent.
      const typical: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const close = c[i]!;
        const high = h && isFiniteNumber(h[i]) ? h[i]! : close;
        const low = l && isFiniteNumber(l[i]) ? l[i]! : close;
        typical[i] = (high + low + close) / 3;
      }

      // Price range across the window (use typical + any H/L extremes).
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      for (let i = 0; i < n; i++) {
        const close = c[i]!;
        const high = h && isFiniteNumber(h[i]) ? h[i]! : close;
        const low = l && isFiniteNumber(l[i]) ? l[i]! : close;
        if (low < minPrice) minPrice = low;
        if (high > maxPrice) maxPrice = high;
        if (typical[i]! < minPrice) minPrice = typical[i]!;
        if (typical[i]! > maxPrice) maxPrice = typical[i]!;
      }

      const flags: string[] = [];

      // Degenerate (flat) price range - profile collapses to a single level.
      const requestedBins =
        isFiniteNumber(params.bins) && params.bins >= 2
          ? Math.min(100, Math.floor(params.bins as number))
          : 20;
      const span = maxPrice - minPrice;

      let levels: VolumeProfilePriceLevel[];
      let totalVolume = 0;
      for (let i = 0; i < n; i++) totalVolume += vol[i]!;

      if (span <= 0 || totalVolume <= 0) {
        // Flat price or zero volume - single bin at the price.
        levels = [
          {
            price: round2(minPrice),
            priceLow: round2(minPrice),
            priceHigh: round2(maxPrice),
            volume: Math.round(totalVolume),
            volumePercent: totalVolume > 0 ? 1 : 0,
          },
        ];
      } else {
        const binCount = requestedBins;
        const binSize = span / binCount;
        const binVol = new Array<number>(binCount).fill(0);

        for (let i = 0; i < n; i++) {
          let idx = Math.floor((typical[i]! - minPrice) / binSize);
          if (idx < 0) idx = 0;
          if (idx >= binCount) idx = binCount - 1; // top edge lands in last bin
          binVol[idx]! += vol[i]!;
        }

        levels = binVol.map((v, idx) => {
          const lowEdge = minPrice + idx * binSize;
          const highEdge = lowEdge + binSize;
          return {
            price: round2(lowEdge + binSize / 2),
            priceLow: round2(lowEdge),
            priceHigh: round2(highEdge),
            volume: Math.round(v),
            volumePercent: round4(v / totalVolume),
          };
        });
      }

      // ── Point of Control: highest-volume bin ──
      let pocIdx = 0;
      for (let i = 1; i < levels.length; i++) {
        if (levels[i]!.volume > levels[pocIdx]!.volume) pocIdx = i;
      }
      const poc = levels[pocIdx]!.price;

      // ── Value Area: smallest contiguous band holding ~70% of volume ──
      // Expand outward from the POC, always adding the larger adjacent bin.
      const targetVolume = totalVolume * 0.7;
      let lowIdx = pocIdx;
      let highIdx = pocIdx;
      let vaVolume = levels[pocIdx]!.volume;

      while (vaVolume < targetVolume && (lowIdx > 0 || highIdx < levels.length - 1)) {
        const below = lowIdx > 0 ? levels[lowIdx - 1]!.volume : -1;
        const above =
          highIdx < levels.length - 1 ? levels[highIdx + 1]!.volume : -1;
        if (below < 0 && above < 0) break;
        if (above >= below) {
          highIdx += 1;
          vaVolume += levels[highIdx]!.volume;
        } else {
          lowIdx -= 1;
          vaVolume += levels[lowIdx]!.volume;
        }
      }

      const valueAreaLow = levels[lowIdx]!.priceLow;
      const valueAreaHigh = levels[highIdx]!.priceHigh;
      const valueAreaVolumePercent =
        totalVolume > 0 ? round4(vaVolume / totalVolume) : 0;

      // ── High / low volume nodes vs mean bin volume ──
      const meanBinVolume = totalVolume / levels.length;
      const highVolumeNodes: number[] = [];
      const lowVolumeNodes: number[] = [];
      for (const lvl of levels) {
        if (meanBinVolume > 0 && lvl.volume >= meanBinVolume * 1.5) {
          highVolumeNodes.push(lvl.price);
        } else if (meanBinVolume > 0 && lvl.volume <= meanBinVolume * 0.5) {
          lowVolumeNodes.push(lvl.price);
        }
      }

      // ── Volume trend: avg of last 20 bars vs the prior 20 ──
      let volumeTrend: VolumeProfileResult["volumeTrend"] = "flat";
      if (n >= 40) {
        const last20 = vol.slice(n - 20);
        const prior20 = vol.slice(n - 40, n - 20);
        const avgLast = last20.reduce((a, b) => a + b, 0) / 20;
        const avgPrior = prior20.reduce((a, b) => a + b, 0) / 20;
        if (avgPrior > 0) {
          const change = (avgLast - avgPrior) / avgPrior;
          if (change > 0.1) volumeTrend = "rising";
          else if (change < -0.1) volumeTrend = "falling";
        }
      }

      // ── Up/Down volume ratio (accumulation vs distribution) ──
      // Up day = close > previous close; down day = close < previous close.
      let upVolume = 0;
      let downVolume = 0;
      for (let i = 1; i < n; i++) {
        if (c[i]! > c[i - 1]!) upVolume += vol[i]!;
        else if (c[i]! < c[i - 1]!) downVolume += vol[i]!;
      }
      const upDownVolumeRatio =
        downVolume > 0
          ? round2(upVolume / downVolume)
          : upVolume > 0
            ? 99.99 // all up-volume, no down-volume
            : 0;

      // ── Recent volume vs 50-bar average ──
      const avgWindow = Math.min(50, n);
      const recentAvg =
        vol.slice(n - avgWindow).reduce((a, b) => a + b, 0) / avgWindow;
      const lastVolume = vol[n - 1]!;
      const recentVolumeVsAvg =
        recentAvg > 0 ? round2(lastVolume / recentAvg) : 0;

      // ── Where does the latest close sit vs the value area? ──
      const lastClose = c[n - 1]!;
      let priceVsValueArea: VolumeProfileResult["priceVsValueArea"] = "inside";
      if (lastClose > valueAreaHigh) priceVsValueArea = "above";
      else if (lastClose < valueAreaLow) priceVsValueArea = "below";

      // ── Observational flags (no advice) ──
      if (recentVolumeVsAvg > 1.5) {
        flags.push(
          `Recent volume ${recentVolumeVsAvg.toFixed(1)}x the 50-bar average - volume surge`,
        );
      } else if (recentVolumeVsAvg > 0 && recentVolumeVsAvg < 0.5) {
        flags.push(
          `Recent volume ${recentVolumeVsAvg.toFixed(1)}x average - well below normal participation`,
        );
      }

      if (upDownVolumeRatio >= 99) {
        flags.push("All advancing volume in window - no down-day volume to offset");
      } else if (upDownVolumeRatio > 1.5) {
        flags.push(
          `Up/down volume ${upDownVolumeRatio.toFixed(2)} - volume skewed to advancing days (accumulation pattern)`,
        );
      } else if (upDownVolumeRatio > 0 && upDownVolumeRatio < 0.67) {
        flags.push(
          `Up/down volume ${upDownVolumeRatio.toFixed(2)} - volume skewed to declining days (distribution pattern)`,
        );
      }

      if (volumeTrend === "rising") {
        flags.push("Average volume rising over the last 20 bars vs prior 20");
      } else if (volumeTrend === "falling") {
        flags.push("Average volume falling over the last 20 bars vs prior 20");
      }

      if (priceVsValueArea === "above") {
        flags.push(
          `Price trading above the value area high (${valueAreaHigh}) - acceptance outside prior value`,
        );
      } else if (priceVsValueArea === "below") {
        flags.push(
          `Price trading below the value area low (${valueAreaLow}) - acceptance outside prior value`,
        );
      }

      if (highVolumeNodes.length > 0) {
        flags.push(
          `${highVolumeNodes.length} high-volume node(s) - well-accepted prices that often act as support/resistance`,
        );
      }
      if (lowVolumeNodes.length > 0) {
        flags.push(
          `${lowVolumeNodes.length} low-volume node(s) - thinly traded prices that often see fast moves`,
        );
      }

      const result: VolumeProfileResult = {
        available: true,
        symbol,
        bars: n,
        levels,
        poc,
        valueAreaHigh: round2(valueAreaHigh),
        valueAreaLow: round2(valueAreaLow),
        valueAreaVolumePercent,
        highVolumeNodes,
        lowVolumeNodes,
        volumeTrend,
        upDownVolumeRatio,
        recentVolumeVsAvg,
        priceVsValueArea,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Volume profile analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
