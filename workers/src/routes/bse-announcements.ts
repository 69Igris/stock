import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { BseAnnouncementsSyncMessage } from "@usemoney/types/pubsub";
import { processBseAnnouncementsSync } from "../processors/bse-announcements-sync";

export const bseAnnouncementsRoute = new Hono();

bseAnnouncementsRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<BseAnnouncementsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing BSE announcements sync (message: ${messageId}, maxPages: ${data.maxPages ?? "default"})`,
    );

    await processBseAnnouncementsSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // Return 200 to prevent Pub/Sub retries - the processor handles errors
    // internally per-announcement. Retrying would just reprocess the same window.
    console.error("BSE announcements sync failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
