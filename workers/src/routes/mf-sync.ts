import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { MfSyncMessage } from "@usemoney/types";
import { processMfSync } from "../processors/mf-sync";

export const mfSyncRoute = new Hono();

mfSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<MfSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing MF sync job (message: ${messageId})`);

    await processMfSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("MF sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
