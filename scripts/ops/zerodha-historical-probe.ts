/**
 * MONEY-880 — one-off probe: does the new Zerodha QA *Personal* app have access
 * to the Console /backoffice tradebook endpoint that the historical backfill
 * uses? Runs the worker's EXACT code path (ZerodhaClient.getHistoricalTrades)
 * against a freshly-minted access token, so the verdict is faithful.
 *
 * Needs an interactive Kite login ONCE (only the api_key+secret can't call a
 * user-data endpoint). Pass creds + the request_token from the login redirect
 * via env (never hardcoded):
 *
 *   ZERODHA_PROBE_API_KEY=... \
 *   ZERODHA_PROBE_API_SECRET=... \
 *   ZERODHA_PROBE_REQUEST_TOKEN=... \
 *   node --import tsx scripts/ops/zerodha-historical-probe.ts
 */

import { ZerodhaClient, createBrokerClient } from "@usemoney/core/brokers";

async function main() {
  const apiKey = process.env.ZERODHA_PROBE_API_KEY || "";
  const apiSecret = process.env.ZERODHA_PROBE_API_SECRET || "";
  const requestToken = process.env.ZERODHA_PROBE_REQUEST_TOKEN || "";
  if (!apiKey || !apiSecret || !requestToken) {
    console.error(
      "Missing ZERODHA_PROBE_API_KEY / ZERODHA_PROBE_API_SECRET / ZERODHA_PROBE_REQUEST_TOKEN",
    );
    process.exit(2);
  }

  console.log("[probe] exchanging request_token → access_token …");
  let accessToken: string;
  let userId: string;
  try {
    const session = await ZerodhaClient.exchangeToken(
      apiKey,
      apiSecret,
      requestToken,
    );
    accessToken = session.accessToken;
    userId = session.userId;
    console.log(`[probe] session OK for user ${userId} (token not printed)`);
  } catch (err) {
    console.error(
      `[probe] TOKEN EXCHANGE FAILED — request_token may be stale/used, or the api_key/secret don't match the app: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Worker's exact path: a 365-day EQ-only window. Endpoint accessible == call
  // returns (any count, incl. 0); a 403/permission error == NOT accessible.
  const client = createBrokerClient("ZERODHA", { apiKey, accessToken });
  const toDate = new Date();
  const fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  console.log(
    `[probe] calling getHistoricalTrades(EQ, ${fromDate.toISOString().slice(0, 10)}..${toDate.toISOString().slice(0, 10)}) …`,
  );
  try {
    const trades = await client.getHistoricalTrades(fromDate, toDate, ["EQ"]);
    console.log("");
    console.log(
      `✅ VERDICT: backoffice tradebook is ACCESSIBLE on this app — returned ${trades.length} EQ trade(s) for the last year.`,
    );
    console.log(
      "   → Historical sync WORKS on the new Personal app. Keep HISTORICAL_TRADEBOOK_SYNC on (default).",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("");
    console.log(`❌ VERDICT: backoffice tradebook call FAILED — ${msg}`);
    console.log(
      "   → If this is a 403/permission/forbidden, the free Personal app can't do historical;",
    );
    console.log(
      "     disable it in non-prod (HISTORICAL_TRADEBOOK_SYNC=off on qa/dev workers).",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[probe] unexpected:", err);
  process.exit(1);
});
