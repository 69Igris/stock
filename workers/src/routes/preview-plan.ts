/**
 * POST /jobs/research-preview-plan - MONEY-240 A.
 *
 * Pub/Sub push subscription for the preview-plan worker fallback.
 * Triggered by /api/research/preview-plan when the inline LLM
 * rewrite would exceed the 4 s soft-timeout.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ResearchPreviewPlanJobMessage } from "@usemoney/types";
import { processResearchPreviewPlan } from "../processors/preview-plan";

export const previewPlanRoute = new Hono();

previewPlanRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ResearchPreviewPlanJobMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing preview-plan job ${data.jobId} (message: ${messageId}, query length: ${data.query.length})`,
    );

    const result = await processResearchPreviewPlan(data);

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("Preview-plan job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
