/**
 * Stock Document Financials-Parse Worker Route — MONEY-1255.
 *
 * Handles Pub/Sub messages that drive the Gemini PDF reading of pending
 * annual-report / results PDFs into `document_financial_extracts`.
 *
 * ACKs 200 even on a throw. Pub/Sub ACKs only on 2xx, so any other status
 * NACKs and burns the delivery attempts — and a redelivery here restarts a
 * batch of PAID model calls. The processor already handles errors
 * per-document and marks each row's terminal `parseStatus`, so a retry of the
 * whole message buys nothing and costs the batch twice.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import { processStockDocumentParse } from "../processors/stock-document-parse";
import type { StockDocumentParseMessage } from "../processors/stock-document-parse-logic";

export const stockDocumentParseRoute = new Hono();

stockDocumentParseRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StockDocumentParseMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing stock document parse (message: ${messageId})`);

    await processStockDocumentParse(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Stock document parse failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
