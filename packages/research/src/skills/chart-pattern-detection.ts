/**
 * Chart Pattern Detection Skill - Price-action pattern recognition
 *
 * Triggers: "chart patterns on TCS", "candlestick patterns", "breakout setup",
 *   "head and shoulders", "cup and handle", "double top", "is there a flag /
 *   triangle pattern"
 * Output: Detected classical chart patterns (head & shoulders, cup & handle,
 *   double top/bottom, flags, triangles), candlestick formations, and breakout
 *   setups with observation-only commentary (MONEY-457 SEBI compliance — no
 *   buy/sell/hold verdict, no price-target call to action).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const chartPatternDetectionSkill: ResearchSkill = {
  name: "chart-pattern-detection",
  description:
    "Detects classical chart patterns (head & shoulders, cup & handle, double top/bottom, flags, triangles), candlestick formations, and breakout setups from price history (observation-only — no buy/sell/hold verdict)",
  triggers: [
    // Explicit pattern-detection intent on chart/candlestick price action
    /\b(chart|candle\s*stick|candlestick|price\s*action)\s*(pattern|patterns|formation|formations|setup|setups)\b/i,
    /\b(pattern|patterns|formation|formations)\b.*\b(chart|candle\s*stick|candlestick|price\s*action)\b/i,
    // Breakout setups / patterns
    /\bbreak\s*out\s*(setup|setups|pattern|patterns)\b/i,
    /\b(detect|find|spot|scan\s*for)\b.*\bbreak\s*out\b/i,
    // Named classical chart patterns
    /\bhead\s*(and|&|n)?\s*shoulders?\b/i,
    /\bcup\s*(and|&|n)?\s*handle\b/i,
    /\bdouble\s*(top|bottom)\b/i,
    /\b(bull|bear)(ish)?\s*(flag|pennant)\b/i,
    /\b(ascending|descending|symmetrical)\s*triangle\b/i,
    // Generic "<pattern> pattern" mentions of the supported formations
    /\b(flag|pennant|triangle|wedge|channel)\s*pattern\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (price history is the sole input for detection)
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),

      // Phase 2: Pattern detection (all depend on price history)
      computeTask("chart_patterns", "detect_chart_patterns", {}, ["history"]),
      computeTask("candlestick_patterns", "detect_candlestick_patterns", {}, [
        "history",
      ]),
      computeTask("breakout_setups", "detect_breakout_setups", {}, ["history"]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            params.query || `Chart pattern detection of ${params.symbol}`,
        },
        ["history", "chart_patterns", "candlestick_patterns", "breakout_setups"],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Chart pattern detection of ${params.symbol}`,
      skill: "chart-pattern-detection",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
