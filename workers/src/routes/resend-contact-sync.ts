import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ResendContactSyncMessage } from "@usemoney/types/pubsub";
import { processResendContactSync } from "../processors/resend-contact-sync";

export const resendContactSyncRoute = new Hono();

resendContactSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ResendContactSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing Resend contact sync (message: ${messageId})`);

    await processResendContactSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Resend contact sync failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
