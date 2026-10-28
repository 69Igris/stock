import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ImportJobMessage } from "@usemoney/types";
import { processImport } from "../processors/import";

export const importRoute = new Hono();

importRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ImportJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing import job ${data.jobId} (message: ${messageId})`);

    await processImport(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Import job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
