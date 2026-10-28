/**
 * Flash Responder - pure logic
 *
 * The side-effect-free helpers used by `flash-responder.ts` live here so they
 * can be unit-tested under `node:test` without importing the responder's heavy
 * chain (Prisma, the Gemini client, the research package). `flash-responder.ts`
 * imports and calls these, so production and the tests run the SAME code (no
 * shadow).
 */

import { METADATA_FIELDS } from "./metadata-fields";

/** Minimum number of financial (non-metadata) fields to consider data "rich" */
export const MIN_FINANCIAL_FIELDS = 3;

/**
 * Check if a query is a definition/concept question (no stock lookup needed).
 */
export function isDefinitionQuery(message: string): boolean {
  return /\bwhat\s+(is|are|does)\s+(a\s+)?(pe\s+ratio|pb\s+ratio|roe|roce|macd|rsi|bollinger|fibonacci|sip|swp|elss|etf|ipo|fii|dii|nav|aum|cagr|xirr|sharpe|sortino|beta|alpha|dividend\s+yield|book\s+value|eps|ebitda|debt.to.equity|current\s+ratio|quick\s+ratio|working\s+capital|free\s+cash\s+flow|intrinsic\s+value|margin\s+of\s+safety|moat|blue\s+chip|penny\s+stock|circuit\s+limit|upper\s+circuit|lower\s+circuit|nifty|sensex|mutual\s+fund|index\s+fund|nfo|stcg|ltcg|advance\s+tax)/i.test(
    message
  );
}

/** Humanize a camelCase field key into a display label. */
function labelize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

/**
 * Filter Yahoo Finance data to remove metadata fields and return only financial
 * data as a flat list of `{ label, value }` pairs, plus an `isRich` flag.
 *
 * Handles three value shapes inside each module: Yahoo `{ fmt }` wrappers,
 * `{ raw }` wrappers, and bare primitives.
 */
export function extractFinancialData(rawData: Record<string, unknown>): {
  items: Array<{ label: string; value: string }>;
  isRich: boolean;
} {
  const items: Array<{ label: string; value: string }> = [];

  for (const [moduleKey, moduleVal] of Object.entries(rawData)) {
    if (METADATA_FIELDS.has(moduleKey)) continue;

    if (
      typeof moduleVal === "object" &&
      moduleVal !== null &&
      !Array.isArray(moduleVal)
    ) {
      for (const [k, v] of Object.entries(
        moduleVal as Record<string, unknown>
      )) {
        if (METADATA_FIELDS.has(k) || k === "maxAge") continue;

        if (
          typeof v === "object" &&
          v !== null &&
          "fmt" in (v as Record<string, unknown>)
        ) {
          items.push({
            label: labelize(k),
            value: String((v as Record<string, unknown>).fmt ?? "N/A"),
          });
        } else if (
          typeof v === "object" &&
          v !== null &&
          "raw" in (v as Record<string, unknown>)
        ) {
          const raw = (v as Record<string, unknown>).raw;
          items.push({
            label: labelize(k),
            value:
              typeof raw === "number"
                ? raw.toLocaleString("en-IN")
                : String(raw ?? "N/A"),
          });
        } else if (
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
        ) {
          items.push({
            label: labelize(k),
            value:
              typeof v === "number" ? v.toLocaleString("en-IN") : String(v),
          });
        }
      }
    } else if (
      typeof moduleVal === "string" ||
      typeof moduleVal === "number" ||
      typeof moduleVal === "boolean"
    ) {
      if (!METADATA_FIELDS.has(moduleKey)) {
        items.push({
          label: labelize(moduleKey),
          value:
            typeof moduleVal === "number"
              ? moduleVal.toLocaleString("en-IN")
              : String(moduleVal),
        });
      }
    }
  }

  return {
    items,
    isRich: items.length >= MIN_FINANCIAL_FIELDS,
  };
}
