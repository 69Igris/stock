/**
 * L3 Comprehensive Analysis Worker Route
 *
 * Handles Pub/Sub messages for L3 analysis segments.
 * Each segment runs the research agent with a specific skill,
 * stores the result in Redis, and chains to the next segment.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { L3AnalysisMessage } from "@usemoney/types";
import { processL3Segment } from "../processors/l3-analysis";

export const l3AnalysisRoute = new Hono();

l3AnalysisRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<L3AnalysisMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[l3-analysis] Processing segment ${data.segmentIndex} for session=${data.sessionId} messageId=${messageId}`
    );

    await processL3Segment(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("[l3-analysis-route] processor threw, acking", { error });
    // Return 200 to prevent Pub/Sub retries (we handle failure in the processor)
    return c.json({ error: "Processing failed" }, 200);
  }
});
