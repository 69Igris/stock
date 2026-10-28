import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { InstrumentSyncMessage } from "@usemoney/types";
import { processInstrumentSync } from "../processors/instrument-sync";

export const instrumentSyncRoute = new Hono();

instrumentSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<InstrumentSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing instrument sync job (message: ${messageId}, exchanges: ${data.exchanges?.join(", ") ?? "ALL"})`
    );

    await processInstrumentSync(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Instrument sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
