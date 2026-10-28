import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { PriceSyncMessage } from "@usemoney/types";
import { processPriceSync } from "../processors/price-sync";

export const priceSyncRoute = new Hono();

priceSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<PriceSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing price sync job (message: ${messageId}, source: ${data.source ?? "YAHOO"})`,
    );

    const result = await processPriceSync(data);

    if (!result.ok) {
      // 200, NOT 500 — and the reason is arithmetic, not squeamishness.
      //
      // The house idiom (routes/xbrl-sync.ts) is transient -> 500 so Pub/Sub
      // retries, deterministic -> 200 so it does not storm. A Yahoo outage IS
      // transient, so 500 would be the answer for a job of ordinary length.
      // This job is not of ordinary length. `price-backfill-incremental-daily`
      // walks EVERY active EQUITY/INDEX/ETF instrument (~10k) with a 500 ms
      // pause every 10, which is already past Pub/Sub's 600 s MAXIMUM ack
      // deadline before a single HTTP round trip. Redelivery therefore starts a
      // SECOND concurrent copy of a run that is still going; NACKing on purpose
      // would multiply a job that is already at risk of double-delivery.
      //
      // The decider being wired here is the `marketDataSyncLog` row — its
      // `status`, `recordsProcessed`, `recordsFailed` and `errorMessage` are
      // what an operator and a dashboard actually read, and all four are now
      // computed from the run's counts instead of a literal "COMPLETED"
      // (MONEY-1238). The failure is loud in the body and in the log line; what
      // it deliberately does not do is ask for the whole sweep again.
      console.error(`[price-sync] run reported FAILED: ${result.reason}`);
      return c.json({ success: false, retried: false, ...result }, 200);
    }

    return c.json({ success: true, ...result }, 200); // 200 = ack message
  } catch (error) {
    console.error("Price sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
