import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import {
  processNseAnnouncementsSync,
  type NseAnnouncementsSyncMessage,
} from "../processors/nse-announcements-sync";

export const nseAnnouncementsRoute = new Hono();

nseAnnouncementsRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<NseAnnouncementsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing NSE announcements sync (message: ${messageId}, ` +
        `window: ${data.fromDate ?? "auto"}..${data.toDate ?? "auto"}, ` +
        `windowDays: ${data.windowDays ?? "default"})`,
    );

    await processNseAnnouncementsSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // 500 = Pub/Sub retries. Unlike the BSE leg's ACK-200: NSE prunes its
    // announcement archive, so a lost evening is not recoverable by waiting.
    console.error("NSE announcements sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
