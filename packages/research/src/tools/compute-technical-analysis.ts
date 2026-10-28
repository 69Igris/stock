/**
 * Technical Analysis Tool
 *
 * SMA(20/50/200), RSI(14), MACD(12,26,9), Bollinger Bands,
 * support/resistance from price history.
 *
 * Uses shared indicator library for all computations.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { TechnicalAnalysisResult } from "../types";
import {
  sma,
  ema,
  computeRSI,
  findSupportResistance,
  computeMACD,
  computeBollingerBands,
  computeStochastic,
  computeATR,
  computeADX,
  computeSupertrend,
  computePivotPoints,
  computeOBV,
  computeVWAP,
  computeVolumeRatio,
  computeCCI,
  computeMFI,
  computeWilliamsR,
  computeROC,
  computePSAR,
  computeIchimoku,
  detectNarrowRange,
} from "../lib/indicators";
import { insufficientInput } from "./insufficient-input";

export const computeTechnicalAnalysisTool: ResearchToolDef = {
  name: "compute_technical_analysis",
  description:
    "Compute SMA, RSI, MACD, Bollinger Bands, support/resistance, and optional advanced indicators (Stochastic, ADX, ATR, OBV, Pivots, Supertrend, CCI, MFI, Williams %R, ROC, PSAR, Ichimoku, NR) from price history",
  category: "computation",
  parameters: {
    prices: {
      type: "array",
      description:
        "Array of closing prices sorted chronologically (oldest first)",
      required: true,
    },
    highs: {
      type: "array",
      description:
        "Array of high prices (same order as prices). Enables ADX, ATR, Pivots, Supertrend, CCI, MFI, Williams %R, PSAR, Ichimoku, NR.",
    },
    lows: {
      type: "array",
      description:
        "Array of low prices (same order as prices). Enables ADX, ATR, Pivots, Supertrend, CCI, MFI, Williams %R, PSAR, Ichimoku, NR.",
    },
    volumes: {
      type: "array",
      description:
        "Array of volumes (same order as prices). Enables OBV, VWAP, MFI.",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const prices = params.prices as number[] | undefined;
    const highs = params.highs as number[] | undefined;
    const lows = params.lows as number[] | undefined;
    const volumes = params.volumes as number[] | undefined;

    if (!prices?.length || prices.length < 30) {
      return insufficientInput(
        "At least 30 price data points required for technical analysis",
      );
    }

    try {
      const currentPrice = prices[prices.length - 1]!;
      const signals: string[] = [];

      // SMAs
      const sma20 = Math.round(sma(prices, 20) * 100) / 100;
      const sma50 = Math.round(sma(prices, 50) * 100) / 100;
      const sma200 =
        prices.length >= 200 ? Math.round(sma(prices, 200) * 100) / 100 : sma50;

      // SMA signals
      if (currentPrice > sma200) {
        signals.push("Price above SMA200 - long-term bullish");
      } else {
        signals.push("Price below SMA200 - long-term bearish");
      }

      if (sma50 > sma200 && prices.length >= 200) {
        signals.push("Golden cross - SMA50 above SMA200");
      } else if (sma50 < sma200 && prices.length >= 200) {
        signals.push("Death cross - SMA50 below SMA200");
      }

      // RSI
      const rsi14 = computeRSI(prices, 14);
      if (rsi14 > 70) signals.push(`RSI ${rsi14} - overbought`);
      else if (rsi14 < 30) signals.push(`RSI ${rsi14} - oversold`);

      // MACD (12, 26, 9) - using shared helper
      const macd = computeMACD(prices);
      let macdSignal: TechnicalAnalysisResult["macd"]["signal"] = "neutral";
      if (macd.macdLine > macd.signalLine) {
        macdSignal = "bullish";
        signals.push("MACD bullish crossover");
      } else if (macd.macdLine < macd.signalLine) {
        macdSignal = "bearish";
        signals.push("MACD bearish crossover");
      }

      // Bollinger Bands (20, 2 sigma) - using shared helper
      const bb = computeBollingerBands(prices);
      const bollingerBands = {
        upper: bb.upper,
        middle: bb.middle,
        lower: bb.lower,
      };

      if (currentPrice > bollingerBands.upper) {
        signals.push("Price above upper Bollinger Band - overbought");
      } else if (currentPrice < bollingerBands.lower) {
        signals.push("Price below lower Bollinger Band - oversold");
      }

      // ─── Advanced Indicators (when high/low/volume data available) ───

      const advanced: Record<string, unknown> = {};
      const hasHLC =
        highs?.length === prices.length && lows?.length === prices.length;
      const hasVolume = volumes?.length === prices.length;

      // EMA(9/21) - always compute (only needs closes)
      const ema9 = ema(prices, 9);
      const ema21 = ema(prices, 21);
      advanced.ema9 = Math.round(ema9[ema9.length - 1]! * 100) / 100;
      advanced.ema21 = Math.round(ema21[ema21.length - 1]! * 100) / 100;

      // ROC - only needs closes
      const roc = computeROC(prices);
      if (roc !== null) {
        advanced.roc = roc;
        if (roc > 10)
          signals.push(`ROC ${roc.toFixed(1)}% - strong upward momentum`);
        else if (roc < -10)
          signals.push(`ROC ${roc.toFixed(1)}% - strong downward momentum`);
      }

      if (hasHLC) {
        // Stochastic %K/%D
        const stochastic = computeStochastic(prices, highs!, lows!);
        if (stochastic) {
          advanced.stochastic = stochastic;
          if (stochastic.percentK < 20)
            signals.push(
              `Stochastic %K ${stochastic.percentK.toFixed(1)} - oversold`,
            );
          else if (stochastic.percentK > 80)
            signals.push(
              `Stochastic %K ${stochastic.percentK.toFixed(1)} - overbought`,
            );
        }

        // ATR (14-period)
        const atr14 = computeATR(prices, highs!, lows!);
        if (atr14 !== null) {
          advanced.atr14 = atr14;
        }

        // ADX (14-period)
        const adx = computeADX(prices, highs!, lows!);
        if (adx !== null) {
          advanced.adx = adx;
          if (adx > 25) signals.push(`ADX ${adx.toFixed(1)} - strong trend`);
          else if (adx < 20)
            signals.push(`ADX ${adx.toFixed(1)} - weak trend / ranging`);
        }

        // Supertrend (ATR multiplier 3, period 10)
        const supertrend = computeSupertrend(prices, highs!, lows!);
        if (supertrend) {
          advanced.supertrend = supertrend;
          if (supertrend.direction === "bullish")
            signals.push("Supertrend bullish");
          else if (supertrend.direction === "bearish")
            signals.push("Supertrend bearish");
        }

        // Pivot Points (Classic)
        const lastH = highs![highs!.length - 1]!;
        const lastL = lows![lows!.length - 1]!;
        advanced.pivotPoints = computePivotPoints(currentPrice, lastH, lastL);

        // CCI (20-period)
        const cci = computeCCI(prices, highs!, lows!);
        if (cci !== null) {
          advanced.cci = cci;
          if (cci > 100) signals.push(`CCI ${cci.toFixed(1)} - overbought`);
          else if (cci < -100) signals.push(`CCI ${cci.toFixed(1)} - oversold`);
        }

        // Williams %R (14-period)
        const williamsR = computeWilliamsR(prices, highs!, lows!);
        if (williamsR !== null) {
          advanced.williamsR = williamsR;
          if (williamsR > -20)
            signals.push(`Williams %R ${williamsR.toFixed(1)} - overbought`);
          else if (williamsR < -80)
            signals.push(`Williams %R ${williamsR.toFixed(1)} - oversold`);
        }

        // PSAR
        const psar = computePSAR(highs!, lows!);
        if (psar) {
          advanced.psar = psar;
          if (psar.trend === "bullish")
            signals.push("PSAR bullish - SAR below price");
          else signals.push("PSAR bearish - SAR above price");
        }

        // Ichimoku Cloud
        const ichimoku = computeIchimoku(prices, highs!, lows!);
        if (ichimoku) {
          advanced.ichimoku = ichimoku;
          if (ichimoku.priceVsCloud === "above")
            signals.push("Price above Ichimoku Cloud - bullish");
          else if (ichimoku.priceVsCloud === "below")
            signals.push("Price below Ichimoku Cloud - bearish");
          else signals.push("Price inside Ichimoku Cloud - indecisive");
        }

        // Narrow Range (NR4/NR7)
        const nr = detectNarrowRange(highs!, lows!);
        if (nr) {
          advanced.narrowRange = nr;
          if (nr.nr7) signals.push("NR7 detected - potential breakout setup");
          else if (nr.nr4) signals.push("NR4 detected - narrowing range");
        }
      }

      if (hasVolume) {
        // OBV
        advanced.obv = computeOBV(prices, volumes!);

        // VWAP (needs HLC + volume)
        if (hasHLC) {
          advanced.vwap = computeVWAP(prices, highs!, lows!, volumes!);
        }

        // MFI (needs HLC + volume)
        if (hasHLC) {
          const mfi = computeMFI(prices, highs!, lows!, volumes!);
          if (mfi !== null) {
            advanced.mfi = mfi;
            if (mfi > 80)
              signals.push(`MFI ${mfi.toFixed(1)} - overbought (money flow)`);
            else if (mfi < 20)
              signals.push(`MFI ${mfi.toFixed(1)} - oversold (money flow)`);
          }
        }

        // Volume signal
        const volRatio = computeVolumeRatio(volumes!);
        if (volRatio > 2) {
          signals.push(
            `Volume ${volRatio.toFixed(1)}x average - unusual activity`,
          );
        }
      }

      // Support/Resistance
      const { support, resistance } = findSupportResistance(prices);

      // Overall trend
      let trend: TechnicalAnalysisResult["trend"] = "sideways";
      const bullishSignals = [
        currentPrice > sma50,
        currentPrice > sma200,
        rsi14 > 50,
        macdSignal === "bullish",
      ].filter(Boolean).length;

      if (bullishSignals >= 3) trend = "bullish";
      else if (bullishSignals <= 1) trend = "bearish";

      const result: TechnicalAnalysisResult & {
        advanced?: Record<string, unknown>;
      } = {
        sma: { sma20, sma50, sma200 },
        rsi14,
        macd: {
          macdLine: macd.macdLine,
          signalLine: macd.signalLine,
          histogram: macd.histogram,
          signal: macdSignal,
        },
        bollingerBands,
        support,
        resistance,
        trend,
        signals,
      };

      // Attach advanced indicators if any were computed
      if (Object.keys(advanced).length > 0) {
        result.advanced = advanced;
      }

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Technical analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
