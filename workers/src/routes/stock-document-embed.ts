import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { StockDocumentEmbedMessage } from "@usemoney/types/pubsub";
import { processStockDocumentEmbed } from "../processors/stock-document-embed";

export const stockDocumentEmbedRoute = new Hono();

stockDocumentEmbedRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StockDocumentEmbedMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing stock document embedding (message: ${messageId})`);

    await processStockDocumentEmbed(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // MONEY-1238 — 500, not the old blanket 200.
    //
    // The processor isolates PER-DOCUMENT failures itself (they are counted and
    // logged, and never escape), so by the time an error reaches here it is one
    // of exactly two things: the selection query failed, or the whole batch
    // stored ZERO embeddings — the revoked-key / exhausted-quota shape. Neither
    // saved any partial progress, so the old justification ("partial progress is
    // saved per-document") does not apply to what actually throws, and ACKing it
    // turned a total embedding outage into a 200 with a cheerful log line.
    // Bounded: max-delivery-attempts=5, then the shared dead-letter topic, whose
    // consumer notifies the founder.
    console.error("Stock document embedding failed:", error);
    return c.json({ success: false, error: "Processing failed" }, 500);
  }
});
