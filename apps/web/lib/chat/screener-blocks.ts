/**
 * Screener result -> ContentBlock formatting (MONEY-587).
 *
 * Shared by BOTH chat lanes so a screener renders identically whether it was
 * reached by a free-text query (`/api/chat`) or a deterministic chip dispatch
 * (`/api/chat/execute-tool`). Previously the formatter lived inline in
 * `/api/chat` only, so chip-dispatched screens returned raw data the client
 * dropped. Pure module - no server-only imports, safe on the client too.
 */

import type { ContentBlock } from "@usemoney/types";

/** Identity/metadata columns that are not display metrics. */
const META_FIELDS = new Set([
  "symbol",
  "tradingsymbol",
  "name",
  "company_name",
  "id",
  "isin",
  "sector",
  "exchange",
  "instrument_type",
]);

/** Raw metric key -> human-friendly column label. */
const METRIC_LABELS: Record<string, string> = {
  price: "Price (₹)",
  distanceFrom52WeekLow: "Near 52W Low (%)",
  distanceFrom52WeekHigh: "Below 52W High (%)",
  fiftyTwoWeekLow: "52W Low (₹)",
  fiftyTwoWeekHigh: "52W High (₹)",
  pe: "PE Ratio",
  pb: "PB Ratio",
  roe: "ROE (%)",
  roce: "ROCE (%)",
  rsi14: "RSI",
  macd: "MACD",
  sma50: "SMA 50",
  sma200: "SMA 200",
  marketCap: "Market Cap",
  dividendYield: "Div Yield (%)",
  debtToEquity: "Debt/Equity",
  volumeRatio: "Vol Ratio",
};

/** Short plain-language explanation of each metric (for the list description). */
const METRIC_DESCRIPTIONS: Record<string, string> = {
  distanceFrom52WeekLow:
    "Near 52W Low (%) - How close the stock is to its lowest price in the past year. Lower % = closer to the bottom.",
  distanceFrom52WeekHigh:
    "Below 52W High (%) - How far the stock has fallen from its highest price in the past year.",
  fiftyTwoWeekLow:
    "52W Low - The lowest price this stock hit in the past 12 months.",
  fiftyTwoWeekHigh:
    "52W High - The highest price this stock hit in the past 12 months.",
  pe: "PE Ratio - Price divided by earnings. Lower PE may mean the stock is cheaper relative to its profits.",
  pb: "PB Ratio - Price divided by book value. Lower PB may indicate undervaluation.",
  roe: "ROE (%) - Return on Equity. How efficiently the company uses shareholder money to generate profit. Higher is better.",
  roce: "ROCE (%) - Return on Capital Employed. Measures how well the company uses all its capital. Higher is better.",
  rsi14:
    "RSI - Momentum indicator (0-100). Below 30 = oversold (potential buy). Above 70 = overbought (potential sell).",
  macd: "MACD - Trend indicator. Positive = bullish momentum. Negative = bearish momentum.",
  sma50:
    "SMA 50 - 50-day average price. Price above SMA 50 = short-term uptrend.",
  sma200:
    "SMA 200 - 200-day average price. Price above SMA 200 = long-term uptrend.",
  marketCap:
    "Market Cap - Total value of the company (share price × total shares).",
  dividendYield:
    "Div Yield (%) - Annual dividend as a percentage of the stock price. Higher = more income.",
  debtToEquity:
    "Debt/Equity - How much debt the company has relative to equity. Lower = less risky.",
  volumeRatio:
    "Vol Ratio - Today's trading volume compared to the 20-day average. Above 1 = higher than usual activity.",
};

/** Priority order for choosing which metrics to surface per row. */
const METRIC_PRIORITY = [
  "price",
  "distanceFrom52WeekLow",
  "distanceFrom52WeekHigh",
  "fiftyTwoWeekLow",
  "fiftyTwoWeekHigh",
  "pe",
  "roe",
  "roce",
  "rsi14",
  "macd",
  "sma50",
  "sma200",
  "marketCap",
  "dividendYield",
  "debtToEquity",
  "volumeRatio",
];

/** Extract the result rows from a screener payload (array or `{ data: [...] }`). */
export function extractScreenerRows(
  data: unknown
): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>).data;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return null;
}

/**
 * Build the rendered blocks for a screener result: a `stock-list` block on hits,
 * or an info `error` block on zero matches. Returns `[]` when the payload isn't
 * a recognised screener shape (caller falls back to generic formatting).
 */
export function buildScreenerBlocks(
  data: unknown,
  screenQuery?: string
): ContentBlock[] {
  if (!data || typeof data !== "object") return [];
  const screenerData = data as Record<string, unknown>;
  const resultArray = extractScreenerRows(data);
  if (!resultArray) return [];

  if (resultArray.length === 0) {
    return [
      {
        type: "error",
        severity: "info",
        title: "No stocks matched your criteria",
        message:
          (screenerData.message as string) ||
          "The screener ran but found no stocks matching your filters. Try broadening the criteria, changing the index (e.g. Nifty 100/500), or using a different strategy.",
      } as ContentBlock,
    ];
  }

  // Which metric keys are present (for the explanatory description line).
  const sampleMetricKeys = Object.keys(
    resultArray[0] as Record<string, unknown>
  )
    .filter((k) => !META_FIELDS.has(k))
    .sort(
      (a, b) =>
        (METRIC_PRIORITY.indexOf(a) === -1 ? 999 : METRIC_PRIORITY.indexOf(a)) -
        (METRIC_PRIORITY.indexOf(b) === -1 ? 999 : METRIC_PRIORITY.indexOf(b))
    )
    .slice(0, 4);

  const descParts = sampleMetricKeys
    .filter((k) => METRIC_DESCRIPTIONS[k])
    .map((k) => METRIC_DESCRIPTIONS[k]);
  const metricDescription =
    descParts.length > 0 ? descParts.join(" · ") : undefined;

  return [
    {
      type: "stock-list",
      title:
        (screenerData.message as string) ||
        `Screening Results (${resultArray.length} stocks)`,
      description: metricDescription,
      stocks: resultArray.map((s: Record<string, unknown>) => {
        const allMetrics = Object.entries(s)
          .filter(([k]) => !META_FIELDS.has(k))
          .filter(([, v]) => typeof v === "string" || typeof v === "number");
        allMetrics.sort(([a], [b]) => {
          const ai = METRIC_PRIORITY.indexOf(a);
          const bi = METRIC_PRIORITY.indexOf(b);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        const cleanMetrics: Record<string, string | number> = {};
        for (const [k, v] of allMetrics.slice(0, 4)) {
          const label = METRIC_LABELS[k] || k;
          if (typeof v === "number") {
            if (
              k.startsWith("distance") ||
              k === "roe" ||
              k === "roce" ||
              k === "roa" ||
              k === "dividendYield"
            ) {
              cleanMetrics[label] = `${v.toFixed(2)}%`;
            } else if (k === "price" || k.startsWith("fiftyTwo")) {
              cleanMetrics[label] = `₹${v.toLocaleString("en-IN", {
                maximumFractionDigits: 2,
              })}`;
            } else if (k === "marketCap") {
              cleanMetrics[label] =
                v >= 1e7
                  ? `₹${(v / 1e7).toFixed(0)}Cr`
                  : `₹${(v / 1e5).toFixed(0)}L`;
            } else {
              cleanMetrics[label] = Number.isInteger(v)
                ? v
                : Number(v.toFixed(2));
            }
          } else {
            cleanMetrics[label] = v as string;
          }
        }
        return {
          symbol: (s.symbol || s.tradingsymbol || "") as string,
          name: (s.name || s.company_name || "") as string,
          sector: (s.sector || "") as string,
          exchange: (s.exchange || "NSE") as string,
          metrics: cleanMetrics,
        };
      }),
      total: resultArray.length,
      screenQuery: screenQuery || "",
    } as ContentBlock,
  ];
}
