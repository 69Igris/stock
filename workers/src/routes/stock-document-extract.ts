/**
 * Stock Document Extraction Worker Route (MONEY-783)
 *
 * Handles Pub/Sub messages that drive Document AI / pdf-parse text extraction
 * of PENDING stock PDFs, feeding the embed chain. ACKs 200 even on a throw so
 * Pub/Sub doesn't retry — the processor handles errors per-document.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { StockDocumentExtractMessage } from "@usemoney/types/pubsub";
import { processStockDocumentExtract } from "../processors/stock-document-extract";

export const stockDocumentExtractRoute = new Hono();

stockDocumentExtractRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StockDocumentExtractMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing stock document extract (message: ${messageId})`);

    await processStockDocumentExtract(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // Return 200 to prevent Pub/Sub retries - the processor handles errors
    // internally per-document. Retrying would just reprocess the same docs.
    console.error("Stock document extract failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
