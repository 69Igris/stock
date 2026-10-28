/**
 * Reading `lake_gold_{env}` — BigQuery. MONEY-1506 (data-platform B4).
 *
 * The one consumer today is `scripts/jobs/tile-build-d1.ts --market=US`, which
 * B4 switches off `CandleRepository` and onto `gold.adjusted_bar_d1`.
 *
 * THIN ON PURPOSE: every row-shape decision lives in `gold-logic.ts`, which
 * imports nothing and is fully tested. This file moves rows.
 *
 * ## IT FAILS LOUD, LIKE THE LEDGER NEXT DOOR
 *
 * "I could not reach BigQuery" is not "this listing has no bars". The tile
 * builder's whole safety argument rests on an empty result meaning something —
 * `skippedNoBars`, `zeroWriteRefusal` — so a read that degraded to `[]` would
 * turn an outage into a nightly run that walks the market, writes nothing and
 * reports success. Same reasoning `ledger.ts` records for the ledger.
 *
 * ## IT IS NOT ON A REQUEST PATH, AND MUST NEVER BE
 *
 * `docs/reference/lake-layout.md` §8: the web request path never queries
 * BigQuery. This module is imported by a Cloud Run JOB. `stockbook-api@` is
 * granted nothing on BigQuery, which is the version of that rule that survives
 * somebody not having read it.
 */
import { BigQuery } from "@google-cloud/bigquery";
import {
  toAdjustedBar,
  toTileListing,
  type GoldAdjustedBar,
  type GoldAdjustedBarRow,
  type GoldTileListing,
  type GoldTileListingRow,
} from "./gold-logic";

export type { GoldAdjustedBar, GoldTileListing } from "./gold-logic";

/** One region for the whole data plane — the 14-Sep region rule. */
const LAKE_REGION = "asia-south1";

/**
 * `LAKE_ENV`, read PER CALL.
 *
 * Never a module-scope const: a module-level read freezes at import, and on a
 * warm container that turns a redeployed variable into no variable at all —
 * the defect CLAUDE.md records against `XBRL_PROJECTION_APPLY`, `TIINGO_PLAN`
 * and `CANDLE_COLD_FORMAT`.
 *
 * REFUSED rather than defaulted, for the reason `ledger.ts` gives about the
 * bronze dataset: a silent fallback to `qa` makes a production job read the
 * wrong warehouse and report a healthy empty result.
 */
function goldConfig(): { projectId: string; dataset: string } {
  const projectId =
    process.env.LAKE_PROJECT ?? process.env.GCP_PROJECT_ID ?? "";
  const env = process.env.LAKE_ENV ?? "";
  if (!projectId)
    throw new Error("LAKE_PROJECT (or GCP_PROJECT_ID) is required");
  if (env !== "qa" && env !== "prod") {
    throw new Error(`LAKE_ENV must be "qa" or "prod" (got "${env}")`);
  }
  return { projectId, dataset: `lake_gold_${env}` };
}

let client: BigQuery | null = null;
function bq(): BigQuery {
  const { projectId } = goldConfig();
  // Cached by PROJECT, so a script that changes LAKE_PROJECT between calls does
  // not keep talking to the first one.
  if (!client || client.projectId !== projectId) {
    // LOCATION STATED. BigQuery runs a job in exactly one location and a job
    // that landed in the US would fail on every asia-south1 dataset with a
    // "not found" that reads like a missing table.
    client = new BigQuery({ projectId, location: LAKE_REGION });
  }
  return client;
}

function goldTable(name: string): string {
  const { projectId, dataset } = goldConfig();
  return `\`${projectId}.${dataset}.${name}\``;
}

async function query<T>(
  sql: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  const [rows] = await bq().query({
    query: sql,
    params,
    location: LAKE_REGION,
  });
  return rows as T[];
}

/**
 * Every tileable listing for a market, with the two facts that decide whether
 * its tile is stale.
 *
 * ONE QUERY FOR THE WHOLE MARKET, not one per listing. ~14,000 US listings at
 * one BigQuery job each is hours of latency and a billed 10 MB minimum per
 * job; the manifest is one row per listing and fits in a single result.
 */
export async function listGoldTileListings(
  market: string,
  limit: number | null = null,
): Promise<GoldTileListing[]> {
  const rows = await query<GoldTileListingRow>(
    `SELECT listing_id, symbol, exchange, last_session, actions_fingerprint
       FROM ${goldTable("chart_tile_manifest")}
      WHERE market = @market
      ORDER BY symbol, listing_id
      ${limit ? "LIMIT @limit" : ""}`,
    limit ? { market, limit } : { market },
  );
  return rows.map(toTileListing);
}

/**
 * Adjusted bars for a BATCH of listings from `fromYear` onward.
 *
 * BATCHED, and the caller groups the result: one query per listing is ~14,000
 * BigQuery jobs a night. The India path makes the same trade with its
 * per-listing Mongo reads, at a far lower per-query cost.
 */
export async function readGoldAdjustedBars(args: {
  market: string;
  listingIds: readonly string[];
  fromYear: number;
}): Promise<GoldAdjustedBar[]> {
  if (args.listingIds.length === 0) return [];
  const rows = await query<GoldAdjustedBarRow>(
    `SELECT listing_id, session_date, adj_open, adj_high, adj_low, adj_close,
            adj_volume, source
       FROM ${goldTable("adjusted_bar_d1")}
      WHERE market = @market
        AND listing_id IN UNNEST(@ids)
        AND session_date >= @from
      ORDER BY listing_id, session_date`,
    {
      market: args.market,
      ids: [...args.listingIds],
      from: `${args.fromYear}-01-01`,
    },
  );
  return rows.map(toAdjustedBar);
}
