import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import { RenderJob } from "@usemoney/video-studio/jobs";
import { processStudioRender } from "../processors/studio-render";

export const studioRenderRoute = new Hono();

studioRenderRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const raw = parsePubSubMessage<unknown>(body);
    const job = RenderJob.parse(raw);
    const messageId = getMessageId(body);

    console.log(
      `Studio render job ${job.jobId} (type: ${job.type}, message: ${messageId})`,
    );

    await processStudioRender(job);
    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Studio render job failed:", error);
    return c.json({ error: "Render failed" }, 500);
  }
});
