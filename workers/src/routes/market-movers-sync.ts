import { Hono } from "hono";
import { getMessageId } from "../lib/message";
import { processMarketMoversSync } from "../processors/market-movers-sync";

export const marketMoversSyncRoute = new Hono();

marketMoversSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(
      `Processing market movers sync (message: ${getMessageId(body)})`,
    );

    const result = await processMarketMoversSync();

    // A closed market is a SUCCESS, not a failure. The runtime gate exists so
    // an exchange holiday — which cron cannot know about — costs zero requests,
    // and returning 500 would make Pub/Sub retry the poll it just declined to
    // make, which is the opposite of the intent.
    if (result.skippedClosed) {
      return c.json({ success: true, skipped: "market-closed" }, 200);
    }

    // A tripped circuit is NOT retried here. NSE just refused us; Pub/Sub's
    // exponential backoff would fire the same request at the same host within
    // seconds, which is precisely the retry-loop-against-a-refusing-host that
    // the circuit break exists to prevent. 200 ACKs the message and lets the
    // NEXT scheduled poll (3 minutes away) be the retry — the feed cannot be
    // backfilled either way, and one lost snapshot is cheaper than an IP block.
    if (result.circuitBroken) {
      console.error("Market movers sync circuit-broke — ACKing, not retrying");
      return c.json({ success: false, circuitBroken: true }, 200);
    }

    if (!result.ok) {
      // A parse rejection or a zero-row payload from a 200. Worth a retry:
      // this is a shape problem or a transient body, not a host refusal.
      return c.json(
        { success: false, movers: result.movers, indices: result.indices },
        500,
      );
    }

    return c.json(
      { success: true, movers: result.movers, indices: result.indices },
      200,
    );
  } catch (error) {
    console.error("Market movers sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
