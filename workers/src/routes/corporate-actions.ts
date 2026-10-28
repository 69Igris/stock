import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { CorporateActionsSyncMessage } from "@usemoney/types/pubsub";
import { processCorporateActionsSync } from "../processors/corporate-actions-sync";

export const corporateActionsRoute = new Hono();

corporateActionsRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<CorporateActionsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing corporate-actions sync (message: ${messageId}, symbols: ${data.symbols?.length ?? "auto"})`,
    );

    await processCorporateActionsSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // MONEY-1238 — 500, not the old blanket 200.
    //
    // The old comment was right about the SHAPE and wrong about the
    // consequence: the processor DOES isolate per-symbol failures, which is
    // exactly why an error that escapes it is never a per-symbol flake. It is
    // the DB or the corporate-actions service being unavailable for the whole
    // run — nothing persisted — and this is COST-BASIS data, where a lost
    // window of splits/bonuses/dividends silently misprices every downstream
    // P&L and nothing reconciles it afterwards. The upsert dedupes on
    // [symbol, exchange, type, exDate], so a redelivery is idempotent; 5
    // failures dead-letter to the founder notification.
    console.error("Corporate-actions sync failed:", error);
    return c.json({ success: false, error: "Processing failed" }, 500);
  }
});
