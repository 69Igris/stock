"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";
import {
  createJob,
  getJobForUser,
  getUserJobs,
  type JobData,
} from "@/lib/jobs/job-service";
import {
  processImportJob,
  type BrokerFormat,
  type ImportJobPayload,
  type ImportJobResult,
} from "@/lib/jobs/import-processor";
import { publishImportJob } from "@usemoney/pubsub/publish";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";

// ================== User Helper ==================

async function getOrCreateUser() {
  const { userId: clerkUserId } = await auth();
  const clerkUser = await currentUser();

  if (!clerkUserId || !clerkUser?.emailAddresses?.[0]?.emailAddress) {
    return null;
  }

  const email = clerkUser.emailAddresses[0].emailAddress;
  const name = clerkUser.fullName || clerkUser.firstName || undefined;

  let user = await prisma.user.findFirst({
    where: {
      OR: [{ clerkId: clerkUserId }, { email }],
    },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { email, name, clerkId: clerkUserId },
    });
  } else if (!user.clerkId) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { clerkId: clerkUserId },
    });
  }

  return user;
}

// ================== Import Job Actions ==================

export interface StartImportJobOptions {
  content: string;
  brokerFormat: BrokerFormat;
  fileType: "csv" | "xlsx";
  fileName?: string;
  fileSize?: number;
  brokerConnectionId?: string;
  linkToManual?: boolean;
}

export interface StartImportJobResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

/**
 * Start an import job - creates job record and begins processing
 * Returns immediately with job ID for progress tracking
 */
export async function startImportJobAction(
  options: StartImportJobOptions
): Promise<StartImportJobResult> {
  const user = await getOrCreateUser();

  if (!user) {
    return { success: false, error: "Unauthorized - please sign in" };
  }

  try {
    // Create job record
    const jobId = await createJob({
      userId: user.id,
      jobType: "CSV_IMPORT",
      payload: {
        brokerFormat: options.brokerFormat,
        fileType: options.fileType,
        fileName: options.fileName,
        fileSize: options.fileSize,
        brokerConnectionId: options.brokerConnectionId,
        linkToManual: options.linkToManual,
        // Don't store full content in job payload to avoid size issues
        contentLength: options.content.length,
      },
    });

    // Publish to Pub/Sub for async processing by workers
    await publishImportJob({
      jobId,
      userId: user.id,
      content: options.content,
      brokerFormat: options.brokerFormat,
      fileType: options.fileType,
      fileName: options.fileName,
      brokerConnectionId: options.brokerConnectionId,
      linkToManual: options.linkToManual,
    });

    // Update BackgroundJob with Pub/Sub metadata
    await prisma.backgroundJob.update({
      where: { jobId },
      data: { queueName: getTopicName(PUBSUB_TOPICS.CSV_IMPORT) },
    });

    return { success: true, jobId };
  } catch (error) {
    console.error("Failed to start import job:", error);
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to start import"),
    };
  }
}

/**
 * Synchronous import - waits for completion
 * Use this for small imports where you want immediate feedback
 */
export async function importTradesWithJobAction(
  options: StartImportJobOptions
): Promise<{
  success: boolean;
  jobId: string;
  result?: ImportJobResult;
  error?: string;
}> {
  const user = await getOrCreateUser();

  if (!user) {
    return {
      success: false,
      jobId: "",
      error: "Unauthorized - please sign in",
    };
  }

  try {
    const jobId = await createJob({
      userId: user.id,
      jobType: "CSV_IMPORT",
      payload: {
        brokerFormat: options.brokerFormat,
        fileType: options.fileType,
        fileName: options.fileName,
        fileSize: options.fileSize,
        brokerConnectionId: options.brokerConnectionId,
        linkToManual: options.linkToManual,
      },
    });

    const payload: ImportJobPayload = {
      content: options.content,
      brokerFormat: options.brokerFormat,
      fileType: options.fileType,
      fileName: options.fileName,
      fileSize: options.fileSize,
      brokerConnectionId: options.brokerConnectionId,
      linkToManual: options.linkToManual,
    };

    // Process and wait for completion
    const result = await processImportJob(jobId, user.id, payload);

    return { success: result?.success, jobId, result };
  } catch (error) {
    console.error("Import job failed:", error);
    return {
      success: false,
      jobId: "",
      error: getSafeErrorMessage(error, "Import failed"),
    };
  }
}

// ================== Job Status Actions ==================

export interface ImportJobStatus {
  jobId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  result?: ImportJobResult;
  errorMessage?: string;
  queuedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  // Progress details
  stage?: string;
  totalRows?: number;
  validRows?: number;
  imported?: number;
  skipped?: number;
  processedCount?: number;
}

/**
 * Get the status of an import job
 */
export async function getImportJobStatusAction(
  jobId: string
): Promise<{ success: boolean; job?: ImportJobStatus; error?: string }> {
  const user = await getOrCreateUser();

  if (!user) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const job = await getJobForUser(jobId, user.id);

    if (!job) {
      return { success: false, error: "Job not found" };
    }

    const payload = job.payload as Record<string, unknown> | undefined;
    const result = job.result as ImportJobResult | undefined;

    const status: ImportJobStatus = {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      result: job.status === "COMPLETED" ? result : undefined,
      errorMessage: job.errorMessage,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      // Progress details from result (updated during processing)
      stage: result?.stage as string | undefined,
      totalRows: result?.totalRows as number | undefined,
      validRows: result?.validRows as number | undefined,
      imported: result?.imported as number | undefined,
      skipped: result?.skipped as number | undefined,
      processedCount: result?.processedCount as number | undefined,
    };

    return { success: true, job: status };
  } catch (error) {
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to get job status"),
    };
  }
}

/**
 * Get all import jobs for the current user
 */
export async function getImportJobsAction(options?: {
  limit?: number;
  status?: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
}): Promise<{ success: boolean; jobs?: ImportJobStatus[]; error?: string }> {
  const user = await getOrCreateUser();

  if (!user) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const jobs = await getUserJobs(user.id, {
      jobType: "CSV_IMPORT",
      status: options?.status,
      limit: options?.limit || 10,
    });

    const statuses: ImportJobStatus[] = jobs.map((job) => {
      const result = job.result as ImportJobResult | undefined;
      return {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        result: job.status === "COMPLETED" ? result : undefined,
        errorMessage: job.errorMessage,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        stage: result?.stage as string | undefined,
        totalRows: result?.totalRows as number | undefined,
        imported: result?.imported as number | undefined,
        skipped: result?.skipped as number | undefined,
      };
    });

    return { success: true, jobs: statuses };
  } catch (error) {
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to get jobs"),
    };
  }
}

/**
 * Get active (processing) import jobs
 */
export async function getActiveImportJobsAction(): Promise<{
  success: boolean;
  jobs?: ImportJobStatus[];
  error?: string;
}> {
  const user = await getOrCreateUser();

  if (!user) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const jobs = await getUserJobs(user.id, {
      jobType: "CSV_IMPORT",
      limit: 5,
    });

    const activeJobs = jobs.filter(
      (j) => j.status === "PENDING" || j.status === "PROCESSING"
    );

    const statuses: ImportJobStatus[] = activeJobs.map((job) => {
      const result = job.result as ImportJobResult | undefined;
      return {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        errorMessage: job.errorMessage,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        stage: result?.stage as string | undefined,
        totalRows: result?.totalRows as number | undefined,
        imported: result?.imported as number | undefined,
        skipped: result?.skipped as number | undefined,
        processedCount: result?.processedCount as number | undefined,
      };
    });

    return { success: true, jobs: statuses };
  } catch (error) {
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to get active jobs"),
    };
  }
}
