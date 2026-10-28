import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { DocumentProcessMessage } from "@usemoney/types";
import { processDocument } from "../processors/document-process";

export const documentProcessRoute = new Hono();

documentProcessRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<DocumentProcessMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing document job ${data.jobId} (action: ${data.action}, message: ${messageId})`
    );

    await processDocument(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Document process job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
