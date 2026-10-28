/**
 * The ACTION-PATH half of the adjustment parity fixture — MONEY-1528 (A).
 *
 * `adjustment-parity.csv` is US-shaped: every bar states its own `div_cash` and
 * `split_factor`, so the join's COALESCE never falls through, and the one
 * harness that runs in BigQuery fed the action side `WHERE FALSE`. Every CTE
 * that reads `corporate_action` was parsed there and never executed — and the
 * first run that DID execute them failed on BigQuery's NUMERIC arithmetic
 * (`dataform/includes/adjustment.js`, "THE FACTORS ARE FLOAT64").
 *
 * This is the other half: one India-shaped listing, NULL in both columns as
 * every bhavcopy row is, and the actions that move it. ONE fixture, TWO
 * executors, for the CSV's reason: `adjustment-sql-parity.test.ts` runs it in
 * SQLite on every push and `scripts/ops/adjustment-parity.ts` runs it in
 * BigQuery, both against `referenceBars` below, so a BigQuery failure is a fact
 * about BigQuery and never a fixture bug.
 *
 * What each row is FOR:
 *   BONUS 10 + SPLIT 5, one ex_date      the composed path. In NUMERIC,
 *                                        EXP(LN(10) + LN(5)) is 49.999999979.
 *   CAPITAL_ADJUSTMENT 2, observed 1.940678
 *                                        the observed gap wins, as it does in
 *                                        `actionFactor` (MONEY-1528 B).
 *   DIVIDEND 7.35 on a 1,017.40 close    a non-round factor, which a quantised
 *                                        price_factor cannot round back to.
 *   Volumes in the tens of millions      so a factor off in its ninth digit
 *                                        moves an adjusted volume.
 *
 * Every ex_date is a SESSION and nothing is a duplicate, so `referenceBars`
 * needs no carrier or suppression rule. Those are proven by the SQLite cases;
 * restating them here would be a third implementation of the policy.
 */

import {
  actionFactor,
  QTY_CHANGING_TYPES,
} from "../../../src/market-data/price-adjust";
import type { TiingoEodBar } from "../../../src/market-data/tiingo/tiingo-logic";

/** A silver `price_bar_d1` row, as both executors load it. */
export interface ParityBarRow {
  market: string;
  listing_id: string;
  symbol: string;
  exchange: string;
  session_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  div_cash: number | null;
  split_factor: number | null;
  source: string;
}

/** A silver `corporate_action` row, as the join reads it. */
export interface ParityActionRow {
  market: string;
  listing_id: string;
  action_type: string;
  ex_date: string;
  ratio: number | null;
  observed_ratio: number | null;
  cash: number | null;
  observed_at: string;
  source_record_key: string;
  source: string;
}

const LISTING = "PARITYIN:NSE";

function bar(
  session_date: string,
  close: number,
  volume: number,
): ParityBarRow {
  return {
    market: "IN",
    listing_id: LISTING,
    symbol: "PARITYIN",
    exchange: "NSE",
    session_date,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    div_cash: null,
    split_factor: null,
    source: "BHAVCOPY_HIST",
  };
}

export const ACTION_PATH_BARS: readonly ParityBarRow[] = [
  bar("2024-01-01", 1000.0, 31_250_000),
  bar("2024-01-02", 1017.4, 29_800_000),
  bar("2024-01-03", 1003.15, 30_500_000),
  bar("2024-01-04", 1008.6, 33_100_000),
  bar("2024-01-05", 20.35, 1_512_000_000),
  bar("2024-01-08", 20.61, 1_498_000_000),
  bar("2024-01-09", 10.62, 2_990_000_000),
  bar("2024-01-10", 10.7, 3_010_000_000),
  bar("2024-01-11", 10.66, 2_950_000_000),
];

function act(
  action_type: string,
  ex_date: string,
  values: Partial<Pick<ParityActionRow, "ratio" | "observed_ratio" | "cash">>,
): ParityActionRow {
  return {
    market: "IN",
    listing_id: LISTING,
    action_type,
    ex_date,
    ratio: null,
    observed_ratio: null,
    cash: null,
    observed_at: "2026-01-01T00:00:00Z",
    source_record_key: `${action_type}:${ex_date}`,
    source: "NSE",
    ...values,
  };
}

export const ACTION_PATH_ACTIONS: readonly ParityActionRow[] = [
  act("DIVIDEND", "2024-01-03", { cash: 7.35 }),
  act("BONUS", "2024-01-05", { ratio: 10 }),
  act("SPLIT", "2024-01-05", { ratio: 5 }),
  act("CAPITAL_ADJUSTMENT", "2024-01-09", {
    ratio: 2,
    observed_ratio: 1.940678,
  }),
];

/**
 * The TypeScript answer for ONE listing's bars, oldest first.
 *
 * Each bar's own column where it STATES one — a split factor > 0, a dividend
 * >= 0, the same rule as the SQL's `witnessed` — and otherwise the actions on
 * that session: `actionFactor` choosing each ratio, a same-day composition
 * multiplying, dividends summing. Then `computeAdjustedSeries`, the validated
 * reference, does the rest.
 */
export function referenceBars(
  rows: readonly ParityBarRow[],
  actions: readonly ParityActionRow[],
): TiingoEodBar[] {
  return [...rows]
    .sort((a, b) => a.session_date.localeCompare(b.session_date))
    .map((r) => {
      const here = actions.filter(
        (a) =>
          a.market === r.market &&
          a.listing_id === r.listing_id &&
          a.ex_date === r.session_date,
      );
      const actionSplit = here
        .filter((a) => QTY_CHANGING_TYPES.has(a.action_type))
        .reduce(
          (product, a) =>
            product *
            (actionFactor({
              type: a.action_type,
              exDate: new Date(`${a.ex_date}T00:00:00Z`),
              ratio: a.ratio,
              details:
                a.observed_ratio === null
                  ? null
                  : { observedRatio: a.observed_ratio },
            }) ?? 1),
          1,
        );
      const actionCash = here
        .filter((a) => a.action_type === "DIVIDEND")
        .reduce((sum, a) => sum + (a.cash ?? 0), 0);
      return {
        date: r.session_date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        divCash:
          r.div_cash !== null && r.div_cash >= 0 ? r.div_cash : actionCash,
        splitFactor:
          r.split_factor !== null && r.split_factor > 0
            ? r.split_factor
            : actionSplit,
      };
    });
}
