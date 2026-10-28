import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { PeersSyncMessage } from "@usemoney/types";
import { processPeersSync } from "../processors/peers-sync";

export const peersSyncRoute = new Hono();

peersSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<PeersSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing peers sync job (message: ${messageId})`);

    await processPeersSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Peers sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
