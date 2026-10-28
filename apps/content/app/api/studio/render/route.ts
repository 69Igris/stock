/**
 * Studio render route — enqueue an async render job (Veo clip or full reel).
 *
 * Heavy work (Veo + TTS + ffmpeg + Playwright) runs in the Cloud Run worker, so
 * this just validates, publishes a RenderJob to Pub/Sub, seeds Redis status, and
 * returns a jobId for the client to poll via /api/studio/status.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Timeline, AspectRatio } from "@usemoney/video-studio/types";
import type { RenderJob } from "@usemoney/video-studio/jobs";
import { publishRenderJob, seedStatus } from "../_helpers";
import { checkDailyLimit } from "@/lib/studio-rate-limit";

const Body = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("render-reel"),
    timeline: Timeline,
    outName: z.string().optional(),
  }),
  z.object({
    type: z.literal("veo-clip"),
    prompt: z.string(),
    aspect: AspectRatio.optional(),
    durationSec: z.number().optional(),
    outName: z.string().optional(),
  }),
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = Body.parse(await req.json());
    const rl = await checkDailyLimit(userId, "reel");
    if (!rl.ok)
      return NextResponse.json(
        {
          error: `Daily reel-render limit reached (${rl.limit}/day). Renders are paused until tomorrow to control Veo cost.`,
          limit: rl.limit,
        },
        { status: 429 },
      );
    const jobId = randomUUID();
    const job: RenderJob =
      body.type === "render-reel"
        ? {
            type: "render-reel",
            jobId,
            userId,
            timeline: body.timeline,
            outName: body.outName,
          }
        : {
            type: "veo-clip",
            jobId,
            userId,
            prompt: body.prompt,
            aspect: body.aspect ?? "9:16",
            durationSec: body.durationSec ?? 6,
            outName: body.outName,
          };
    await seedStatus(job);
    const messageId = await publishRenderJob(job);
    return NextResponse.json({ jobId, messageId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "enqueue failed" },
      { status: 400 },
    );
  }
}
