import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { BhavcopySyncMessage } from "@usemoney/types/pubsub";
import { processBhavcopySync } from "../processors/bhavcopy-sync";

export const bhavcopySyncRoute = new Hono();

bhavcopySyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<BhavcopySyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing bhavcopy sync job (message: ${messageId}, exchanges: ${data.exchanges?.join(", ") ?? "BSE+NSE"}, date: ${data.date ?? "latest"})`,
    );

    await processBhavcopySync(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Bhavcopy sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
