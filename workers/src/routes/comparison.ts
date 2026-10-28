/**
 * Comparison Worker Route (MONEY-553)
 *
 * Receives Pub/Sub messages for deep stock/MF comparison jobs
 * and delegates to the comparison processor.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ComparisonJobMessage } from "@usemoney/types";
import { processComparison } from "../processors/comparison";

export const comparisonRoute = new Hono();

comparisonRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ComparisonJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing comparison job ${data.jobId} session=${data.sessionId} kind=${data.kind} (message: ${messageId})`,
    );

    await processComparison(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("[comparison-route] processor threw, acking", { error });
    // Return 200 to prevent Pub/Sub retries (failure handled in the processor)
    return c.json({ error: "Processing failed" }, 200);
  }
});
