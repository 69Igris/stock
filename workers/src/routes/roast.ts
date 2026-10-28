/**
 * Portfolio Roast Worker Route
 *
 * Receives Pub/Sub messages for portfolio roast jobs
 * and delegates to the roast processor.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { RoastJobMessage } from "@usemoney/types";
import { processRoast } from "../processors/roast";

export const roastRoute = new Hono();

roastRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<RoastJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing roast job ${data.jobId} session=${data.sessionId} (message: ${messageId})`);

    await processRoast(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Roast job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
