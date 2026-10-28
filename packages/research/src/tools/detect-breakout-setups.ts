/**
 * Breakout / Breakdown Setup Detection
 *
 * PURE compute tool — detects technical breakout/breakdown setups from OHLCV
 * data. Computes rolling resistance/support (Donchian channels + swing
 * highs/lows), range/consolidation tightness (ATR%, channel width), volume
 * confirmation, 52-week-high proximity, and NR7 / inside-bar contraction.
 *
 * SEBI NOTE: This tool DESCRIBES the technical condition only (e.g. "price is
 * within 2% of its 60-bar high" / "closed above resistance with elevated
 * volume"). It emits OBSERVATIONS / SCORES / FLAGS — never buy/sell/hold
 * advice, target prices, or recommendations. UseMoney is not a SEBI-registered
 * Research Analyst.
 *
 * Inputs are injected by the executor from fetch_price_history.prices[]
 * (closes / highs / lows / volumes), oldest → newest.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

const MIN_BARS = 30;

export type BreakoutSetupType =
  | "consolidation_range"
  | "breakout_above_resistance"
  | "breakdown_below_support"
  | "near_52w_high"
  | "tightening_range_nr7"
  | "inside_bar"
  | "donchian_breakout"
  | "donchian_breakdown";

export interface BreakoutSetup {
  /** Machine-readable setup type. */
  type: BreakoutSetupType;
  /** Human-readable technical observation (no advice language). */
  observation: string;
  /** The price level the setup references (resistance/support/52w high). */
  level: number;
  /** Signed distance of last close from `level`, in percent (rounded 2dp). */
  distancePct: number;
  /** Whether the move was confirmed by volume > 1.5x recent average. */
  volumeConfirmed: boolean;
  /** Confidence the technical condition is met, 0–1 (rounded 2dp). */
  confidence: number;
}

export interface BreakoutSetupsResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Latest close used as the reference price. */
  lastClose?: number;
  /** Nearest rolling resistance (N-bar high) at or above the last close. */
  nearestResistance?: number;
  /** Nearest rolling support (N-bar low) at or below the last close. */
  nearestSupport?: number;
  /**
   * Where the last close sits inside the recent Donchian channel, 0–100.
   * 0 = at support, 100 = at resistance.
   */
  rangeBoundPct?: number;
  /** Recent average true range as a percent of price (consolidation gauge). */
  atrPercent?: number;
  /** 52-week (or full-window) high over the supplied bars. */
  fiftyTwoWeekHigh?: number;
  /** 52-week (or full-window) low over the supplied bars. */
  fiftyTwoWeekLow?: number;
  /** Detected technical setups, highest confidence first. */
  setups?: BreakoutSetup[];
  /** Lookback used for the rolling Donchian channel. */
  lookback?: number;
  /** Neutral, advice-free text summary of what was observed. */
  textSummary?: string;
}

/** Round to a given number of decimals (defaults to 2). */
function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Coerce an unknown array param into a clean number[] (drops non-finite). */
function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Wilder-style true range series from highs/lows/closes. */
function trueRanges(highs: number[], lows: number[], closes: number[]): number[] {
  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i]!;
    const l = lows[i]!;
    const prevClose = closes[i - 1]!;
    tr.push(
      Math.max(
        h - l,
        Math.abs(h - prevClose),
        Math.abs(l - prevClose),
      ),
    );
  }
  return tr;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export const detectBreakoutSetupsTool: ResearchToolDef = {
  name: "detect_breakout_setups",
  description:
    "Detect breakout/breakdown technical setups from OHLCV — rolling resistance/support (Donchian + swings), consolidation/range tightness (ATR%), volume confirmation, 52w-high proximity, and NR7/inside-bar contraction. Emits observations, levels, and confidence scores only (no buy/sell advice).",
  category: "computation",
  parameters: {
    closes: {
      type: "array",
      description:
        "Closing prices, chronological (oldest first). From fetch_price_history.prices[].close. Minimum 30 bars.",
      required: true,
    },
    highs: {
      type: "array",
      description:
        "High prices, same length/order as closes. From fetch_price_history.prices[].high.",
      required: true,
    },
    lows: {
      type: "array",
      description:
        "Low prices, same length/order as closes. From fetch_price_history.prices[].low.",
      required: true,
    },
    volumes: {
      type: "array",
      description:
        "Trading volumes, same length/order as closes (optional — enables volume confirmation). From fetch_price_history.prices[].volume.",
    },
    lookback: {
      type: "number",
      description:
        "Rolling lookback (bars) for Donchian resistance/support. Default 20.",
      default: 20,
    },
    symbol: {
      type: "string",
      description: "Optional symbol, echoed back for rendering context.",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol = typeof params.symbol === "string" ? params.symbol : undefined;

    try {
      const closes = toNumberArray(params.closes);
      const highsRaw = toNumberArray(params.highs);
      const lowsRaw = toNumberArray(params.lows);
      const volumesRaw = toNumberArray(params.volumes);

      // Graceful degradation: insufficient data → available:false (not an error)
      if (closes.length < MIN_BARS) {
        const result: BreakoutSetupsResult = {
          available: false,
          reason: `Insufficient price history: ${closes.length} bars supplied, ${MIN_BARS} required for breakout-setup detection`,
          symbol,
        };
        return { success: true, data: result };
      }

      const n = closes.length;
      // Align highs/lows to closes; fall back to close when missing/mismatched.
      const highs =
        highsRaw.length === n ? highsRaw : closes.map((c) => c);
      const lows = lowsRaw.length === n ? lowsRaw : closes.map((c) => c);
      const hasVolume = volumesRaw.length === n;

      const lookbackParam =
        typeof params.lookback === "number" && Number.isFinite(params.lookback)
          ? Math.floor(params.lookback)
          : 20;
      // Keep at least one prior bar for the channel; cap at available history.
      const lookback = Math.max(2, Math.min(lookbackParam, n - 1));

      const lastClose = closes[n - 1]!;
      const lastHigh = highs[n - 1]!;
      const lastLow = lows[n - 1]!;

      // ─── Donchian channel (prior `lookback` bars, excluding the last bar) ───
      const channelHighs = highs.slice(n - 1 - lookback, n - 1);
      const channelLows = lows.slice(n - 1 - lookback, n - 1);
      const resistance = Math.max(...channelHighs);
      const support = Math.min(...channelLows);
      const channelWidth = resistance - support;

      const rangeBoundPct =
        channelWidth > 0
          ? round(((lastClose - support) / channelWidth) * 100, 1)
          : 50;

      // ─── ATR% (consolidation gauge) over recent window ───
      const tr = trueRanges(highs, lows, closes);
      const atrWindow = tr.slice(-Math.min(14, tr.length));
      const atr = mean(atrWindow);
      const atrPercent = lastClose > 0 ? round((atr / lastClose) * 100, 2) : 0;

      // ─── Volume confirmation (last bar vs prior-20 average) ───
      let volumeConfirmed = false;
      let volumeRatio = 0;
      if (hasVolume) {
        const volWindow = volumesRaw.slice(
          Math.max(0, n - 1 - 20),
          n - 1,
        );
        const avgVol = mean(volWindow);
        if (avgVol > 0) {
          volumeRatio = round(volumesRaw[n - 1]! / avgVol, 2);
          volumeConfirmed = volumeRatio > 1.5;
        }
      }

      // ─── 52w (full-window) high / low ───
      const fiftyTwoWeekHigh = Math.max(...highs);
      const fiftyTwoWeekLow = Math.min(...lows);
      const distFrom52wHighPct =
        fiftyTwoWeekHigh > 0
          ? round(
              ((fiftyTwoWeekHigh - lastClose) / fiftyTwoWeekHigh) * 100,
              2,
            )
          : 0;

      const setups: BreakoutSetup[] = [];

      // ── 1. Breakout above resistance (close clears prior N-bar high) ──
      if (resistance > 0 && lastClose > resistance) {
        const distancePct = round(
          ((lastClose - resistance) / resistance) * 100,
          2,
        );
        // Confidence grows with how decisively it cleared + volume confirm.
        let confidence = 0.5 + Math.min(0.25, distancePct / 20);
        if (volumeConfirmed) confidence += 0.2;
        setups.push({
          type: "breakout_above_resistance",
          observation: `Last close (${round(lastClose)}) is ${distancePct}% above the ${lookback}-bar resistance of ${round(resistance)}${
            volumeConfirmed
              ? `, with volume ${volumeRatio}x the recent average`
              : ", without elevated volume"
          }.`,
          level: round(resistance),
          distancePct,
          volumeConfirmed,
          confidence: round(Math.min(1, confidence)),
        });
      }

      // ── 2. Breakdown below support (close breaks prior N-bar low) ──
      if (support > 0 && lastClose < support) {
        const distancePct = round(
          ((lastClose - support) / support) * 100,
          2,
        );
        let confidence = 0.5 + Math.min(0.25, Math.abs(distancePct) / 20);
        if (volumeConfirmed) confidence += 0.2;
        setups.push({
          type: "breakdown_below_support",
          observation: `Last close (${round(lastClose)}) is ${Math.abs(distancePct)}% below the ${lookback}-bar support of ${round(support)}${
            volumeConfirmed
              ? `, with volume ${volumeRatio}x the recent average`
              : ", without elevated volume"
          }.`,
          level: round(support),
          distancePct,
          volumeConfirmed,
          confidence: round(Math.min(1, confidence)),
        });
      }

      // ── 3. Donchian channel breakout/breakdown (full-channel incl. last) ──
      // Distinct from #1/#2: references the inclusive channel extreme so a bar
      // that *makes* a new channel high/low is flagged even if it equals it.
      if (channelWidth > 0) {
        if (lastHigh >= resistance && lastClose >= support + channelWidth * 0.9) {
          const distancePct = round(
            ((lastClose - resistance) / resistance) * 100,
            2,
          );
          if (!setups.some((s) => s.type === "breakout_above_resistance")) {
            setups.push({
              type: "donchian_breakout",
              observation: `Price touched/exceeded the upper ${lookback}-bar Donchian band (${round(resistance)}); close sits in the top decile of the channel.`,
              level: round(resistance),
              distancePct,
              volumeConfirmed,
              confidence: round(volumeConfirmed ? 0.6 : 0.45),
            });
          }
        } else if (
          lastLow <= support &&
          lastClose <= support + channelWidth * 0.1
        ) {
          const distancePct = round(
            ((lastClose - support) / support) * 100,
            2,
          );
          if (!setups.some((s) => s.type === "breakdown_below_support")) {
            setups.push({
              type: "donchian_breakdown",
              observation: `Price touched/breached the lower ${lookback}-bar Donchian band (${round(support)}); close sits in the bottom decile of the channel.`,
              level: round(support),
              distancePct,
              volumeConfirmed,
              confidence: round(volumeConfirmed ? 0.6 : 0.45),
            });
          }
        }
      }

      // ── 4. Consolidation / range (low ATR% + narrow channel) ──
      const channelWidthPct =
        lastClose > 0 ? (channelWidth / lastClose) * 100 : 0;
      if (atrPercent > 0 && atrPercent < 2 && channelWidthPct < 10) {
        // Tighter range → higher confidence the price is consolidating.
        const confidence = round(
          Math.min(0.9, 0.4 + (2 - atrPercent) / 4 + (10 - channelWidthPct) / 40),
        );
        setups.push({
          type: "consolidation_range",
          observation: `Price is range-bound: ${lookback}-bar channel width is ${round(channelWidthPct, 1)}% and recent ATR is ${atrPercent}% of price (low volatility / consolidation).`,
          level: round((resistance + support) / 2),
          distancePct: rangeBoundPct,
          volumeConfirmed: false,
          confidence,
        });
      }

      // ── 5. 52w-high proximity (within 3% = near a breakout zone) ──
      if (
        fiftyTwoWeekHigh > 0 &&
        distFrom52wHighPct >= 0 &&
        distFrom52wHighPct < 3 &&
        lastClose <= fiftyTwoWeekHigh
      ) {
        const confidence = round(0.5 + (3 - distFrom52wHighPct) / 12);
        setups.push({
          type: "near_52w_high",
          observation: `Last close is ${distFrom52wHighPct}% below the ${n}-bar high of ${round(fiftyTwoWeekHigh)} — within the near-breakout zone (<3%).`,
          level: round(fiftyTwoWeekHigh),
          distancePct: round(-distFrom52wHighPct, 2),
          volumeConfirmed,
          confidence,
        });
      }

      // ── 6. NR7 — narrowest range of the last 7 bars (range contraction) ──
      if (n >= 7) {
        const last7 = [];
        for (let i = n - 7; i < n; i++) {
          last7.push(highs[i]! - lows[i]!);
        }
        const lastRange = last7[last7.length - 1]!;
        const isNr7 = last7.every((r, idx) =>
          idx === last7.length - 1 ? true : lastRange <= r,
        );
        if (isNr7 && lastRange >= 0) {
          setups.push({
            type: "tightening_range_nr7",
            observation: `Latest bar has the narrowest high-low range of the last 7 bars (NR7) — range contraction often precedes an expansion.`,
            level: round(lastClose),
            distancePct: 0,
            volumeConfirmed: false,
            confidence: 0.5,
          });
        }
      }

      // ── 7. Inside bar (last bar's range engulfed by the prior bar) ──
      if (n >= 2) {
        const prevHigh = highs[n - 2]!;
        const prevLow = lows[n - 2]!;
        if (lastHigh <= prevHigh && lastLow >= prevLow && prevHigh > prevLow) {
          setups.push({
            type: "inside_bar",
            observation: `Latest bar is an inside bar (high ${round(lastHigh)} ≤ prior high ${round(prevHigh)}, low ${round(lastLow)} ≥ prior low ${round(prevLow)}) — a coiling / indecision pattern.`,
            level: round(lastClose),
            distancePct: 0,
            volumeConfirmed: false,
            confidence: 0.45,
          });
        }
      }

      // Highest-confidence first.
      setups.sort((a, b) => b.confidence - a.confidence);

      // Nearest resistance/support relative to the last close.
      const nearestResistance =
        lastClose <= resistance ? round(resistance) : round(fiftyTwoWeekHigh);
      const nearestSupport =
        lastClose >= support ? round(support) : round(fiftyTwoWeekLow);

      // Neutral, advice-free summary.
      const summaryParts: string[] = [];
      if (setups.length === 0) {
        summaryParts.push(
          `No notable breakout/breakdown technical setup detected over the supplied ${n} bars; price sits ${rangeBoundPct}% up the ${lookback}-bar channel.`,
        );
      } else {
        const top = setups[0]!;
        summaryParts.push(
          `${setups.length} technical setup${setups.length === 1 ? "" : "s"} observed. Strongest: ${top.type.replace(/_/g, " ")} (confidence ${top.confidence}).`,
        );
        summaryParts.push(
          `Nearest resistance ${nearestResistance}, nearest support ${nearestSupport}; ATR ${atrPercent}% of price.`,
        );
      }

      const result: BreakoutSetupsResult = {
        available: true,
        symbol,
        lastClose: round(lastClose),
        nearestResistance,
        nearestSupport,
        rangeBoundPct,
        atrPercent,
        fiftyTwoWeekHigh: round(fiftyTwoWeekHigh),
        fiftyTwoWeekLow: round(fiftyTwoWeekLow),
        setups,
        lookback,
        textSummary: summaryParts.join(" "),
      };

      return {
        success: true,
        data: result,
        metadata: {
          barsAnalyzed: n,
          lookback,
          volumeDataProvided: hasVolume,
          setupTypesChecked: [
            "breakout_above_resistance",
            "breakdown_below_support",
            "donchian_breakout",
            "donchian_breakdown",
            "consolidation_range",
            "near_52w_high",
            "tightening_range_nr7",
            "inside_bar",
          ],
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Breakout setup detection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
