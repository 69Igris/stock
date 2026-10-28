import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { SyncJobMessage } from "@usemoney/types";
import { processSync } from "../processors/sync";

export const syncRoute = new Hono();

syncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<SyncJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing sync job ${data.jobId} (message: ${messageId})`);

    await processSync(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
