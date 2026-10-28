import { auth } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";
import { NextRequest, NextResponse } from "next/server";
import { apiLogger as logger } from "@usemoney/logger";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ jobId: string }> }
) {
  const params = await props.params;
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const job = await prisma.backgroundJob.findFirst({
      where: {
        jobId: params.jobId,
        userId: user.id,
      },
      select: {
        jobId: true,
        jobType: true,
        status: true,
        progress: true,
        result: true,
        errorMessage: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      job,
    });
  } catch (error) {
    logger.error({ error, jobId: params.jobId }, "Error fetching job status");
    return NextResponse.json(
      { error: "Failed to fetch job status" },
      { status: 500 }
    );
  }
}
