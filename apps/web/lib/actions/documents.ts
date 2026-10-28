"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { requireFeature } from "./premium-gate";
import { type ActionResponse } from "@usemoney/validation";
import { isDemoSession } from "@/lib/demo/session";
import { demoDocuments } from "@/lib/demo/data";
import {
  DocumentFilterSchema,
  UploadDocumentSchema,
  ImportUrlSchema,
  FetchNseDocumentSchema,
  GenerateReportSchema,
} from "@usemoney/validation";
import { uploadFile, deleteFile, generateSignedUrl } from "@/lib/storage";
import { publishDocumentProcessJob } from "@usemoney/pubsub/publish";
import { createJob } from "@/lib/jobs/job-service";
import { dbLogger as logger } from "@usemoney/logger";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";
import { isSafeFetchTarget } from "@usemoney/core/import";
import { deleteEmbeddingsV2, oid } from "@usemoney/core/embeddings-v2-write";
import { deriveUrlDocumentIdentity } from "@/lib/documents/url-identity";
import {
  resolveUploadMimeType,
  fileExtension,
} from "@/lib/documents/upload-accept";
import { prisma } from "@usemoney/database";
import type { DocumentCategory } from "@prisma/client";
import {
  getDocuments as getDocumentsService,
  getDocument as getDocumentService,
  deleteDocument as deleteDocumentService,
  generateReport as generateReportService,
  type DocumentListItem,
  type DocumentDetail as DocumentDetailService,
} from "@usemoney/services";

// Re-export types for consumers
export type {
  DocumentListItem,
  DocumentDetail,
  DocumentFilters,
  GenerateReportInput,
} from "@usemoney/services";

// Local type for view URL augmented detail
interface DocumentDetailWithViewUrl extends DocumentDetailService {
  viewUrl: string;
}

// ============== Allowed MIME types + size limits ==============

const ALLOWED_MIME_TYPES: Record<
  string,
  { maxSize: number; fileType: string }
> = {
  "application/pdf": { maxSize: 50 * 1024 * 1024, fileType: "PDF" },
  "image/png": { maxSize: 10 * 1024 * 1024, fileType: "IMAGE" },
  "image/jpeg": { maxSize: 10 * 1024 * 1024, fileType: "IMAGE" },
  "image/webp": { maxSize: 10 * 1024 * 1024, fileType: "IMAGE" },
  "text/csv": { maxSize: 20 * 1024 * 1024, fileType: "CSV" },
  "application/vnd.ms-excel": {
    maxSize: 50 * 1024 * 1024,
    fileType: "SPREADSHEET",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    maxSize: 50 * 1024 * 1024,
    fileType: "SPREADSHEET",
  },
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
}

function generateDocPath(
  userId: string,
  subdirectory: string,
  fileName: string
): string {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  const safeName = sanitizeFileName(fileName);
  return `documents/${userId}/${subdirectory}/${timestamp}-${randomId}-${safeName}`;
}

// ============== Upload ==============

export async function uploadDocumentAction(
  formData: FormData
): Promise<ActionResponse<{ documentId: string }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const file = formData.get("file") as File | null;
    if (!file) return { success: false, error: "No file provided" };

    const title = (formData.get("title") as string) || file.name;
    const description = (formData.get("description") as string) || undefined;
    const category = (formData.get("category") as string) || "OTHER";
    const customName = (formData.get("customName") as string) || undefined;
    const labelsRaw = (formData.get("labels") as string) || "";
    const labels: string[] = labelsRaw
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Validate metadata
    const metaResult = UploadDocumentSchema.safeParse({
      title,
      description,
      category,
    });
    if (!metaResult.success) {
      return {
        success: false,
        error: metaResult.error.issues[0]?.message || "Invalid input",
      };
    }

    // Validate MIME type. MONEY-1167: this used to look up `file.type`
    // directly, but browsers disagree on it — `.csv` reports "" on macOS and
    // `application/vnd.ms-excel` on Windows — so an empty key missed the
    // allowlist and a legitimately-picked file was rejected. Resolve through
    // the shared helper, which falls back to the extension.
    const resolvedMimeType = resolveUploadMimeType({
      name: file.name,
      type: file.type,
    });
    const mimeInfo = resolvedMimeType
      ? ALLOWED_MIME_TYPES[resolvedMimeType]
      : undefined;
    if (!mimeInfo || !resolvedMimeType) {
      const shown = file.type || fileExtension(file.name) || "unknown";
      return { success: false, error: `Unsupported file type: ${shown}` };
    }

    // Validate size
    if (file.size > mimeInfo.maxSize) {
      const maxMB = Math.round(mimeInfo.maxSize / (1024 * 1024));
      return {
        success: false,
        error: `File too large. Maximum ${maxMB}MB for this type.`,
      };
    }

    // Upload to GCS
    const storagePath = generateDocPath(authUser.userId, "uploads", file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    // Store the RESOLVED mime, not the browser's guess — an empty content-type
    // in GCS makes the file undownloadable in some clients.
    await uploadFile(storagePath, buffer, resolvedMimeType);

    // Create background job
    const jobId = await createJob({
      userId: authUser.userId,
      jobType: "DOCUMENT_PROCESS",
      payload: { action: "extract_text", fileName: file.name },
    });

    // Create document record
    const doc = await prisma.userDocument.create({
      data: {
        userId: authUser.userId,
        title: metaResult.data.title,
        description: metaResult.data.description,
        sourceType: "UPLOAD",
        documentType: mimeInfo.fileType as
          | "PDF"
          | "IMAGE"
          | "CSV"
          | "SPREADSHEET",
        category: metaResult.data.category as DocumentCategory,
        storagePath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: resolvedMimeType,
        processingStatus: "PENDING",
        customName: customName || undefined,
        labels: labels.length > 0 ? labels : [],
      },
    });

    // Publish processing job
    await publishDocumentProcessJob({
      jobId,
      userId: authUser.userId,
      documentId: doc.id,
      action: "extract_text",
    });

    logger.info(
      { documentId: doc.id, userId: authUser.userId },
      "Document uploaded"
    );
    return { success: true, data: { documentId: doc.id } };
  } catch (error) {
    logger.error({ error }, "Failed to upload document");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== Import from URL ==============

export async function importFromUrlAction(
  url: string,
  category?: string
): Promise<ActionResponse<{ documentId: string }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const parsed = ImportUrlSchema.safeParse({ url, category });
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid input",
      };
    }

    // SSRF guard: reject https-only violations and hosts that resolve to
    // private/loopback/link-local/metadata ranges before queueing the fetch.
    // The worker re-validates every redirect hop as defense-in-depth.
    const safeTarget = await isSafeFetchTarget(parsed.data.url);
    if (!safeTarget.safe) {
      return { success: false, error: "This URL cannot be imported." };
    }

    // MONEY-1166: name and type the row from the URL's own path instead of its
    // hostname. See lib/documents/url-identity.ts for why the old fallback made
    // every document from a host collide on one `.html` name.
    const identity = deriveUrlDocumentIdentity(parsed.data.url);
    const title = parsed.data.title || identity.title;
    const fileName = parsed.data.title
      ? // An explicit title still needs the extension the URL implies.
        `${parsed.data.title}${identity.fileName.slice(identity.title.length)}`
      : identity.fileName;
    const storagePath = generateDocPath(
      authUser.userId,
      "url-content",
      fileName
    );

    const jobId = await createJob({
      userId: authUser.userId,
      jobType: "DOCUMENT_PROCESS",
      payload: { action: "fetch_url", url: parsed.data.url },
    });

    const doc = await prisma.userDocument.create({
      data: {
        userId: authUser.userId,
        title,
        sourceType: "URL",
        // Best guess from the URL; the processor overwrites both from the
        // response's real content-type once the bytes arrive.
        documentType: identity.fileType,
        category: parsed.data.category as DocumentCategory,
        storagePath,
        originalUrl: parsed.data.url,
        fileName,
        fileSize: 0, // Will be updated by processor
        mimeType: identity.mimeType,
        processingStatus: "PENDING",
      },
    });

    await publishDocumentProcessJob({
      jobId,
      userId: authUser.userId,
      documentId: doc.id,
      action: "fetch_url",
      url: parsed.data.url,
    });

    logger.info({ documentId: doc.id, url }, "URL import initiated");
    return { success: true, data: { documentId: doc.id } };
  } catch (error) {
    logger.error({ error }, "Failed to import from URL");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== Fetch NSE Document ==============

export async function fetchNseDocumentAction(
  symbol: string,
  docType: string
): Promise<ActionResponse<{ documentId: string }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const parsed = FetchNseDocumentSchema.safeParse({ symbol, docType });
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid input",
      };
    }

    const title = `${parsed.data.symbol} - ${parsed.data.docType.replace(/_/g, " ")}`;
    const storagePath = generateDocPath(
      authUser.userId,
      "fetched/nse",
      `${parsed.data.symbol}-${parsed.data.docType}.pdf`
    );

    const jobId = await createJob({
      userId: authUser.userId,
      jobType: "DOCUMENT_PROCESS",
      payload: {
        action: "fetch_nse",
        symbol: parsed.data.symbol,
        docType: parsed.data.docType,
      },
    });

    const doc = await prisma.userDocument.create({
      data: {
        userId: authUser.userId,
        title,
        sourceType: "NSE_FETCH",
        documentType: "PDF",
        category: "ANNUAL_REPORT",
        storagePath,
        fileName: `${parsed.data.symbol}-${parsed.data.docType}.pdf`,
        fileSize: 0,
        mimeType: "application/pdf",
        processingStatus: "PENDING",
        metadata: { symbol: parsed.data.symbol, docType: parsed.data.docType },
      },
    });

    await publishDocumentProcessJob({
      jobId,
      userId: authUser.userId,
      documentId: doc.id,
      action: "fetch_nse",
    });

    logger.info({ documentId: doc.id, symbol, docType }, "NSE fetch initiated");
    return { success: true, data: { documentId: doc.id } };
  } catch (error) {
    logger.error({ error }, "Failed to fetch NSE document");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== List Documents ==============

export async function getDocumentsAction(filters?: {
  category?: string;
  sourceType?: string;
  search?: string;
  skip?: number;
  limit?: number;
}): Promise<ActionResponse<{ documents: DocumentListItem[]; total: number }>> {
  if (await isDemoSession()) {
    return {
      success: true,
      data: {
        documents: demoDocuments as unknown as DocumentListItem[],
        total: demoDocuments.length,
      },
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const parsed = DocumentFilterSchema.safeParse(filters || {});
    if (!parsed.success) {
      return { success: false, error: "Invalid filters" };
    }

    return getDocumentsService(authUser.userId, parsed.data);
  } catch (error) {
    logger.error({ error }, "Failed to list documents");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== Get Single Document ==============

export async function getDocumentAction(
  id: string
): Promise<ActionResponse<DocumentDetailWithViewUrl>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const result = await getDocumentService(authUser.userId, id);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    if (!result?.data) {
      return { success: false, error: "Document not found" };
    }

    // Generate a signed URL for viewing
    const viewUrl = await generateSignedUrl(result?.data.storagePath, {
      expiresIn: 3600,
    });

    return {
      success: true,
      data: {
        ...result?.data,
        viewUrl,
      },
    };
  } catch (error) {
    logger.error({ error }, "Failed to get document");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== Delete Document ==============

export async function deleteDocumentAction(
  id: string
): Promise<ActionResponse> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    // Get document details before deleting (need storagePath and isEmbedded)
    const docResult = await getDocumentService(authUser.userId, id);
    if (!docResult.success) {
      return { success: false, error: docResult.error };
    }
    if (!docResult.data) {
      return { success: false, error: "Document not found" };
    }

    const doc = docResult.data;

    // Soft delete via service
    const deleteResult = await deleteDocumentService(authUser.userId, id);
    if (!deleteResult.success) {
      return { success: false, error: deleteResult.error };
    }

    // Clean up GCS file (best-effort)
    try {
      await deleteFile(doc.storagePath);
    } catch (gcsError) {
      logger.warn(
        { gcsError, storagePath: doc.storagePath },
        "Failed to delete GCS file"
      );
    }

    // Delete embeddings if they exist
    if (doc.isEmbedded) {
      try {
        await prisma.documentEmbedding.deleteMany({
          where: {
            userId: authUser.userId,
            docType: "document",
            docId: doc.id,
          },
        });
        // MONEY-1499 — BOTH collections while both exist. The user deleted a
        // document; a chunk left in v2 stays retrievable by the research
        // agent, which is a privacy defect no counter reports.
        await deleteEmbeddingsV2((cmd) => prisma.$runCommandRaw(cmd as never), {
          userId: oid(authUser.userId),
          docType: "document",
          docId: doc.id,
        });
      } catch (embError) {
        logger.warn({ embError }, "Failed to delete document embeddings");
      }
    }

    logger.info(
      { documentId: id, userId: authUser.userId },
      "Document deleted"
    );
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Failed to delete document");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== Download Document ==============

export async function getDownloadUrlAction(
  id: string
): Promise<ActionResponse<{ downloadUrl: string; fileName: string }>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const result = await getDocumentService(authUser.userId, id);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    if (!result?.data) {
      return { success: false, error: "Document not found" };
    }

    if (result?.data.processingStatus !== "READY") {
      return { success: false, error: "Document is not ready for download" };
    }

    const downloadUrl = await generateSignedUrl(result?.data.storagePath, {
      expiresIn: 3600,
      contentDisposition: "attachment",
      // MONEY-1074: name the download after the human fileName, not the storage
      // key leaf (a cross-origin signed URL ignores the client's a.download).
      downloadFilename: result?.data.fileName,
    });

    return {
      success: true,
      data: { downloadUrl, fileName: result?.data.fileName },
    };
  } catch (error) {
    logger.error({ error }, "Failed to generate download URL");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}

// ============== Generate Report ==============

export async function generateReportAction(
  type: string,
  params?: { fy?: string }
): Promise<ActionResponse<{ documentId: string }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) return { success: false, error: "Not authenticated" };

    // MONEY-1142 — `/documents` maps to the `documentVault` feature, and until
    // now that gate existed ONLY in the client PageGuard. Every action in this
    // file is gated, reads included: the vault's value IS the stored
    // documents, so leaving the list or download open would hand over the
    // feature while only the upload button looked locked.
    const denied = await requireFeature(authUser.userId, "documentVault");
    if (denied) return denied;

    const parsed = GenerateReportSchema.safeParse({ type, fy: params?.fy });
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid input",
      };
    }

    // Create document record via service
    const reportResult = await generateReportService(
      authUser.userId,
      parsed.data.type,
      { fy: parsed.data.fy }
    );
    if (!reportResult.success) {
      return { success: false, error: reportResult.error };
    }
    if (!reportResult.data) {
      return { success: false, error: "Failed to create report record" };
    }

    // Create background job
    const jobId = await createJob({
      userId: authUser.userId,
      jobType: "DOCUMENT_PROCESS",
      payload: {
        action: "generate_report",
        reportType: parsed.data.type,
        fy: parsed.data.fy,
      },
    });

    // Publish processing job
    await publishDocumentProcessJob({
      jobId,
      userId: authUser.userId,
      documentId: reportResult.data.documentId,
      action: "generate_report",
      reportType: parsed.data.type as "tax" | "risk" | "portfolio_statement",
      reportParams: { fy: parsed.data.fy },
    });

    logger.info(
      { documentId: reportResult.data.documentId, type },
      "Report generation initiated"
    );
    return {
      success: true,
      data: { documentId: reportResult.data.documentId },
    };
  } catch (error) {
    logger.error({ error }, "Failed to generate report");
    return { success: false, error: getSafeErrorMessage(error) };
  }
}
