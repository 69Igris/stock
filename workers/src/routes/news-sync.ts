import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { NewsSyncMessage } from "../processors/news-sync";
import { processNewsSync } from "../processors/news-sync";

export const newsSyncRoute = new Hono();

newsSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<NewsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing news sync (message: ${messageId}, symbols: ${data.symbols?.length ?? "auto"})`,
    );

    await processNewsSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("News sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
