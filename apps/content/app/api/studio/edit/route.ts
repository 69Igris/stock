/**
 * Studio edit route — prompt or structured edits to a Timeline.
 *
 * Pure + serverless-safe: `apply_edits` (structured) and the offline path of
 * `edit_timeline` run with no creds. Freeform/translation instructions use
 * Gemini only if creds are present (else editTimeline throws a clear message).
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { Timeline } from "@usemoney/video-studio/types";
import { applyOps, EditOp } from "@usemoney/video-studio/editor/ops";
import { editTimeline } from "@usemoney/video-studio/director";

const Body = z.object({
  timeline: Timeline,
  instruction: z.string().optional(),
  edits: z.array(EditOp).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { timeline, instruction, edits } = Body.parse(await req.json());
    let next;
    if (edits && edits.length > 0) next = applyOps(timeline, edits);
    else if (instruction) next = await editTimeline(timeline, instruction);
    else
      return NextResponse.json(
        { error: "Provide edits[] or an instruction." },
        { status: 400 },
      );
    return NextResponse.json({ timeline: next });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "edit failed" },
      { status: 400 },
    );
  }
}
