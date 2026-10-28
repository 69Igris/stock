import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { MfMetadataSyncMessage } from "@usemoney/types";
import { processMfMetadataSync } from "../processors/mf-metadata-sync";

export const mfMetadataSyncRoute = new Hono();

mfMetadataSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<MfMetadataSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing MF metadata sync job (message: ${messageId})`);

    await processMfMetadataSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("MF metadata sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
