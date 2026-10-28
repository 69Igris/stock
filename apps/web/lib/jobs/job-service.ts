"use server";

import { prisma } from "@usemoney/database";
import type { JobType, JobStatus, Prisma } from "@prisma/client";

// ================== Types ==================

export interface JobData {
  jobId: string;
  jobType: JobType;
  status: JobStatus;
  progress: number;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
  queuedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface CreateJobOptions {
  userId: string;
  jobType: JobType;
  payload?: Record<string, unknown>;
}

export interface UpdateJobOptions {
  status?: JobStatus;
  progress?: number;
  result?: Record<string, unknown>;
  errorMessage?: string;
}

// ================== Job Service ==================

/**
 * Create a new background job
 */
export async function createJob(options: CreateJobOptions): Promise<string> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  await prisma.backgroundJob.create({
    data: {
      jobId,
      userId: options.userId,
      jobType: options.jobType,
      status: "PENDING",
      progress: 0,
      payload: (options.payload || {}) as Prisma.InputJsonValue,
      queuedAt: new Date(),
    },
  });

  return jobId;
}

/**
 * Start processing a job
 */
export async function startJob(jobId: string): Promise<void> {
  await prisma.backgroundJob.update({
    where: { jobId },
    data: {
      status: "PROCESSING",
      startedAt: new Date(),
    },
  });
}

/**
 * Update job progress (0-100)
 */
export async function updateJobProgress(
  jobId: string,
  progress: number,
  partialResult?: Record<string, unknown>
): Promise<void> {
  const updateData: Prisma.BackgroundJobUpdateInput = {
    progress: Math.min(100, Math.max(0, progress)),
  };

  if (partialResult) {
    // Merge with existing result
    const existing = await prisma.backgroundJob.findUnique({
      where: { jobId },
      select: { result: true },
    });
    updateData.result = {
      ...((existing?.result as Record<string, unknown>) || {}),
      ...partialResult,
    } as Prisma.InputJsonValue;
  }

  await prisma.backgroundJob.update({
    where: { jobId },
    data: updateData,
  });
}

/**
 * Complete a job successfully
 */
export async function completeJob(
  jobId: string,
  result: Record<string, unknown>
): Promise<void> {
  await prisma.backgroundJob.update({
    where: { jobId },
    data: {
      status: "COMPLETED",
      progress: 100,
      result: result as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
}

/**
 * Fail a job
 */
export async function failJob(
  jobId: string,
  errorMessage: string,
  partialResult?: Record<string, unknown>
): Promise<void> {
  const job = await prisma.backgroundJob.findUnique({
    where: { jobId },
    select: { retryCount: true, maxRetries: true },
  });

  await prisma.backgroundJob.update({
    where: { jobId },
    data: {
      status: "FAILED",
      errorMessage,
      result: partialResult
        ? (partialResult as Prisma.InputJsonValue)
        : undefined,
      completedAt: new Date(),
      retryCount: (job?.retryCount || 0) + 1,
    },
  });
}

/**
 * Cancel a job
 */
export async function cancelJob(jobId: string): Promise<void> {
  await prisma.backgroundJob.update({
    where: { jobId },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
    },
  });
}

/**
 * Get job by ID
 */
export async function getJob(jobId: string): Promise<JobData | null> {
  const job = await prisma.backgroundJob.findUnique({
    where: { jobId },
  });

  if (!job) return null;

  return {
    jobId: job.jobId,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    payload: job.payload as Record<string, unknown> | undefined,
    result: job.result as Record<string, unknown> | undefined,
    errorMessage: job.errorMessage || undefined,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * Get job by ID for a specific user (with authorization check)
 */
export async function getJobForUser(
  jobId: string,
  userId: string
): Promise<JobData | null> {
  const job = await prisma.backgroundJob.findFirst({
    where: { jobId, userId },
  });

  if (!job) return null;

  return {
    jobId: job.jobId,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    payload: job.payload as Record<string, unknown> | undefined,
    result: job.result as Record<string, unknown> | undefined,
    errorMessage: job.errorMessage || undefined,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * Get all jobs for a user
 */
export async function getUserJobs(
  userId: string,
  options?: {
    jobType?: JobType;
    status?: JobStatus;
    limit?: number;
  }
): Promise<JobData[]> {
  const jobs = await prisma.backgroundJob.findMany({
    where: {
      userId,
      ...(options?.jobType && { jobType: options.jobType }),
      ...(options?.status && { status: options.status }),
    },
    orderBy: { queuedAt: "desc" },
    take: options?.limit || 20,
  });

  return jobs.map((job) => ({
    jobId: job.jobId,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    payload: job.payload as Record<string, unknown> | undefined,
    result: job.result as Record<string, unknown> | undefined,
    errorMessage: job.errorMessage || undefined,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  }));
}

/**
 * Get active (pending/processing) jobs for a user
 */
export async function getActiveJobs(userId: string): Promise<JobData[]> {
  return getUserJobs(userId, {
    limit: 10,
  }).then((jobs) =>
    jobs.filter((j) => j.status === "PENDING" || j.status === "PROCESSING")
  );
}

/**
 * Clean up old completed jobs (older than 7 days)
 */
export async function cleanupOldJobs(userId: string): Promise<number> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const result = await prisma.backgroundJob.deleteMany({
    where: {
      userId,
      status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
      completedAt: { lt: sevenDaysAgo },
    },
  });

  return result.count;
}
