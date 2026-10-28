import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import {
  processNewsRssSync,
  type NewsRssSyncMessage,
} from "../processors/news-rss-sync";

export const newsRssSyncRoute = new Hono();

newsRssSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<NewsRssSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing news RSS sync (message: ${messageId}, sources: ${data.sources?.length ?? "all"})`,
    );

    await processNewsRssSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("News RSS sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
