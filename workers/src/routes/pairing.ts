import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { PairingJobMessage } from "@usemoney/types";
import { processPairing } from "../processors/pairing";

export const pairingRoute = new Hono();

pairingRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<PairingJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing pairing job ${data.jobId} (message: ${messageId})`);

    await processPairing(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Pairing job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
