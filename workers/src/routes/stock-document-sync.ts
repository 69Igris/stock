import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { StockDocumentSyncMessage } from "@usemoney/types/pubsub";
import { processStockDocumentSync } from "../processors/stock-document-sync";

export const stockDocumentSyncRoute = new Hono();

stockDocumentSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StockDocumentSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing stock document sync (message: ${messageId})`);

    await processStockDocumentSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // Return 200 to prevent Pub/Sub retries - the processor handles errors
    // internally per-stock. Retrying would just reprocess the same stocks.
    console.error("Stock document sync failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
