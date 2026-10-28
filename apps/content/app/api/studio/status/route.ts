/**
 * Studio status route — poll a render job's status (scoped to the caller).
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { readStatus } from "../_helpers";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId)
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  const status = await readStatus(jobId);
  if (!status) return NextResponse.json({ state: "unknown" });
  if (status.userId !== userId)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(status);
}
