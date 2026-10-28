import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import {
  processEventsSync,
  type EventsSyncMessage,
} from "../processors/events-sync";

export const eventsSyncRoute = new Hono();

eventsSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<EventsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing events sync (message: ${messageId}, symbols: ${data.symbols?.length ?? "auto"})`,
    );

    await processEventsSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Events sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
