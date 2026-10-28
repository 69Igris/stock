/**
 * Stock Document Ingest Route — MONEY-1314.
 *
 * ONE DOCUMENT PER MESSAGE. The processor converts, reads, and persists a
 * single `stock_documents` row; there is no page, no chain and no batch.
 *
 * ACKs 200 on every path INCLUDING a throw. Pub/Sub ACKs only on 2xx, so any
 * other status NACKs and burns the delivery attempts — and a redelivery here
 * re-runs a PAID model call for a document whose row already records what
 * happened. Every failure class in this lane is either deterministic (an
 * unreadable document fails identically forever) or expensive to repeat.
 *
 * A message with no `documentId` is a 200 too. It cannot succeed on any
 * attempt, so NACKing it only spends five deliveries before dead-lettering.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import {
  processStockDocumentIngest,
  type StockDocumentIngestMessage,
} from "../processors/stock-document-ingest";

export const stockDocumentIngestRoute = new Hono();

stockDocumentIngestRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StockDocumentIngestMessage>(body);
    const messageId = getMessageId(body);

    if (!data?.documentId || typeof data.documentId !== "string") {
      console.warn(
        `[stock-document-ingest] no documentId in message ${messageId} — ` +
          "acking rather than burning five deliveries on a message that can " +
          "never succeed",
      );
      return c.json({ success: true, skipped: "no documentId" }, 200);
    }

    console.log(
      `Processing stock document ingest ${data.documentId} (message: ${messageId})`,
    );

    const outcome = await processStockDocumentIngest(data);

    return c.json({ success: true, outcome }, 200);
  } catch (error) {
    console.error("Stock document ingest failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
