/**
 * Stock Research Worker Route
 *
 * Receives Pub/Sub messages for stock research jobs
 * and delegates to the research processor.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ResearchJobMessage } from "@usemoney/types";
import { processResearch } from "../processors/research";

export const researchRoute = new Hono();

researchRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ResearchJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing research job ${data.jobId} session=${data.sessionId} (message: ${messageId})`,
    );

    await processResearch(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // Always return 200 to Pub/Sub so it doesn't retry endlessly.
    // processResearch already handles errors internally and marks
    // the session as FAILED. Retrying won't help - the session state
    // is persisted in the DB, and the user can re-trigger manually.
    console.error("[research-route] processor threw, acking", { error });
    return c.json({ success: true, recovered: true }, 200);
  }
});
