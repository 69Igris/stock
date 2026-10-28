/**
 * Zerodha holdings schema-drift guard — MONEY-500 (ZA-2).
 *
 * Zerodha renames/adds Kite holding fields a few times a year (the MTF block,
 * authorised_quantity, used_quantity were all added over time). The holdings
 * mapper (`zerodha.ts getHoldings`) types the raw payload as `any` and reads
 * keys positionally — so a rename of a REQUIRED key (e.g. `last_price` →
 * `ltp`) silently degrades to `undefined` → NaN currentValue/pnl, corrupting
 * every row with NO error.
 *
 * This guard validates the RAW snake_case payload (NOT the normalized object,
 * so `name === symbol` is never a false positive) and surfaces:
 *   - `missingRequired`: required keys that failed (a rename/removal — the
 *     corruption class)
 *   - `driftKeys`: unexpected new keys (Zerodha added a field — forward-
 *     compatible, logged so we know WHEN it happened)
 *
 * Non-throwing: a drift is a warn + telemetry event, never an exception —
 * today's behaviour (still persist rows) is preserved.
 */

import { z } from "zod";

/**
 * The 5 keys the mapper MUST have to produce a correct holding. Default
 * z.object strips (ignores) unknown keys rather than failing, so safeParse only
 * fails when a required key is missing or the wrong type.
 */
export const RawZerodhaHoldingSchema = z.object({
  tradingsymbol: z.string(),
  exchange: z.string(),
  quantity: z.number(),
  average_price: z.number(),
  last_price: z.number(),
});

/**
 * Every snake_case key the mapper reads + the documented dropped keys. Any key
 * NOT in here is "drift" (a new Zerodha field).
 */
const KNOWN_KEYS = new Set<string>([
  // consumed by the mapper
  "tradingsymbol",
  "instrument_token",
  "isin",
  "exchange",
  "quantity",
  "average_price",
  "last_price",
  "close_price",
  "pnl",
  "day_change",
  "day_change_percentage",
  "t1_quantity",
  "pledged_quantity",
  "collateral_quantity",
  "mtf",
  // present in the payload but intentionally dropped
  "authorised_quantity",
  "authorised_date",
  "opening_quantity",
  "realised_quantity",
  "short_quantity",
  "used_quantity",
  "discrepancy",
  "price",
  "product",
]);

export interface HoldingShapeResult {
  valid: boolean;
  /** Unexpected new keys seen across all rows (forward-compatible). */
  driftKeys: string[];
  /** Required keys that failed validation in any row (corruption risk). */
  missingRequired: string[];
}

/**
 * Validate the raw Zerodha holdings payload shape. Pure + non-throwing.
 */
export function validateZerodhaHoldingShape(
  rawRows: unknown[],
): HoldingShapeResult {
  const driftKeys = new Set<string>();
  const missingRequired = new Set<string>();

  for (const row of rawRows) {
    if (row && typeof row === "object") {
      for (const key of Object.keys(row as Record<string, unknown>)) {
        if (!KNOWN_KEYS.has(key)) driftKeys.add(key);
      }
    }
    const parsed = RawZerodhaHoldingSchema.safeParse(row);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string") missingRequired.add(key);
      }
    }
  }

  return {
    valid: missingRequired.size === 0,
    driftKeys: Array.from(driftKeys),
    missingRequired: Array.from(missingRequired),
  };
}
