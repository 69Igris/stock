/**
 * Document Processor
 *
 * Handles document processing jobs:
 * - extract_text: Download from GCS, extract text (PDF, CSV, etc.)
 * - fetch_url: Fetch content from URL, store in GCS, extract text
 * - fetch_nse: Fetch NSE filings for a symbol
 * - generate_report: Generate PDF report (tax, risk, portfolio)
 *
 * All paths update BackgroundJob status and create notifications on completion.
 */

import { prisma } from "@usemoney/database";
import type { DocumentProcessMessage } from "@usemoney/types";
import type { Prisma } from "@prisma/client";
import { downloadFromGCS, uploadToGCS } from "../lib/gcs";
import {
  generateEmbedding,
  generateBatchEmbeddings,
  chunkText,
} from "../lib/embeddings";
import { createNotification } from "../lib/notifications";
import { safeFetch } from "@usemoney/core/import";
import { getEmbeddingModel } from "@usemoney/core/embeddings";
import { writeTargets } from "@usemoney/core/embeddings-int8-logic";
import { getEmbeddingsMode } from "@usemoney/core/embeddings-v2-mode";
import { upsertEmbeddingsV2 } from "@usemoney/core/embeddings-v2-write";
import {
  stripHtmlTags,
  getNseUrl,
  capTextContent,
  classifyExtractionMethod,
  documentTypeFromContentType,
  isValidAction,
  shouldIndexForRAG,
  buildJobStatusUpdate,
  buildEmbeddingRecords,
} from "./document-process-logic";
import { describeDocumentFailure, RemoteFetchError } from "./document-failure";

// Cap on fetched-URL response bodies before they are stored to GCS + RAG-indexed.
const MAX_FETCH_BYTES = 25 * 1024 * 1024; // 25 MiB

export async function processDocument(
  data: DocumentProcessMessage,
): Promise<void> {
  const { jobId, userId, documentId, action } = data;

  // Update job status to PROCESSING
  await updateJobStatus(jobId, "PROCESSING");

  try {
    // Guard with the shared validator; unknown actions fall through to the
    // catch below (same FAILED-job + document-FAILED + retry path as before).
    if (!isValidAction(action)) {
      throw new Error(`Unknown action: ${action}`);
    }

    switch (action) {
      case "extract_text":
        await handleExtractText(userId, documentId);
        break;
      case "fetch_url":
        await handleFetchUrl(userId, documentId, data.url);
        break;
      case "fetch_nse":
        await handleFetchNse(userId, documentId);
        break;
      case "generate_report":
        await handleGenerateReport(
          userId,
          documentId,
          data.reportType,
          data.reportParams,
        );
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    // Mark job as completed
    await updateJobStatus(jobId, "COMPLETED");

    // Notify user
    const doc = await prisma.userDocument.findUnique({
      where: { id: documentId },
      select: { title: true },
    });

    await createNotification({
      userId,
      type: "DOCUMENT_READY",
      title: "Document Ready",
      message: `"${doc?.title || "Document"}" has been processed and is ready to view.`,
      metadata: { documentId, action },
    });
  } catch (error) {
    console.error(`[document-process] Failed (action=${action}):`, error);

    // Mark document as failed, WITH a reason the user can act on (MONEY-1168).
    // A bare FAILED made "the host refused us", "the link is wrong" and "our
    // pipeline broke" indistinguishable — which is how an upstream 403 got
    // mistaken for a bug in this feature.
    const failure = describeDocumentFailure(error);
    await prisma.userDocument
      .update({
        where: { id: documentId },
        data: {
          processingStatus: "FAILED",
          processingError: failure.message,
        },
      })
      .catch(() => {}); // best-effort

    // Mark job as failed
    await updateJobStatus(
      jobId,
      "FAILED",
      error instanceof Error ? error.message : "Unknown error",
    );

    throw error; // 500 → Pub/Sub retries
  }
}

// ============== Action Handlers ==============

async function handleExtractText(
  userId: string,
  documentId: string,
): Promise<void> {
  const doc = await prisma.userDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  await prisma.userDocument.update({
    where: { id: documentId },
    data: { processingStatus: "PROCESSING", processingError: null },
  });

  const buffer = await downloadFromGCS(doc.storagePath);
  let textContent = "";

  switch (classifyExtractionMethod(doc.mimeType)) {
    case "pdf":
      textContent = await extractPdfText(buffer);
      break;
    case "text":
      textContent = buffer.toString("utf-8");
      break;
    case "spreadsheet":
      // For spreadsheets, store raw content reference - full parsing is future work
      textContent = `[Spreadsheet: ${doc.fileName}]`;
      break;
    case "image":
      textContent = `[Image: ${doc.fileName}]`;
      break;
    case "unknown":
      textContent = "";
      break;
  }

  // Cap text length
  textContent = capTextContent(textContent);

  // Update document with extracted text
  await prisma.userDocument.update({
    where: { id: documentId },
    data: {
      textContent,
      processingStatus: "READY",
    },
  });

  // Index for RAG if we got meaningful text
  if (shouldIndexForRAG(textContent)) {
    await indexDocumentForRAG(userId, documentId, textContent, doc.title);
  }
}

async function handleFetchUrl(
  userId: string,
  documentId: string,
  url?: string,
): Promise<void> {
  const doc = await prisma.userDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  const fetchUrl = url || doc.originalUrl;
  if (!fetchUrl) throw new Error("No URL provided for fetch_url action");

  await prisma.userDocument.update({
    where: { id: documentId },
    data: { processingStatus: "PROCESSING", processingError: null },
  });

  // SSRF-safe fetch: https-only, DNS-resolved IP must be public, every redirect
  // hop re-validated, response body capped. The body is stored to GCS and
  // RAG-indexed, so an unguarded fetch would be a read-SSRF exfiltration sink.
  const { response, buffer } = await safeFetch(
    fetchUrl,
    {
      headers: {
        "User-Agent": "UseMoney/1.0 (Document Fetcher)",
      },
    },
    { maxBytes: MAX_FETCH_BYTES, timeoutMs: 30_000 },
  );

  if (!response.ok) {
    // MONEY-1168: typed, so the failure classifier reads `status` as a number
    // instead of regexing it back out of a message string.
    throw new RemoteFetchError(response.status, response.statusText);
  }

  const contentType = response.headers.get("content-type") || "text/html";
  const fileSize = buffer.length;

  // Upload to GCS
  await uploadToGCS(doc.storagePath, buffer, contentType);

  // Extract text based on content type
  let textContent = "";
  if (contentType.includes("pdf")) {
    textContent = await extractPdfText(buffer);
  } else if (contentType.includes("html") || contentType.includes("text")) {
    textContent = stripHtmlTags(buffer.toString("utf-8"));
  }

  textContent = capTextContent(textContent);

  // Determine file type from content
  const documentType = documentTypeFromContentType(contentType);

  await prisma.userDocument.update({
    where: { id: documentId },
    data: {
      textContent,
      fileSize,
      mimeType: contentType,
      documentType,
      processingStatus: "READY",
    },
  });

  if (shouldIndexForRAG(textContent)) {
    await indexDocumentForRAG(userId, documentId, textContent, doc.title);
  }
}

async function handleFetchNse(
  userId: string,
  documentId: string,
): Promise<void> {
  const doc = await prisma.userDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  const metadata = doc.metadata as Record<string, unknown> | null;
  const symbol = metadata?.symbol as string | undefined;
  const docType = metadata?.docType as string | undefined;

  if (!symbol || !docType) {
    throw new Error("Missing symbol or docType in document metadata");
  }

  await prisma.userDocument.update({
    where: { id: documentId },
    data: { processingStatus: "PROCESSING", processingError: null },
  });

  // Fetch from NSE website
  const nseUrl = getNseUrl(symbol, docType);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(nseUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/pdf,text/html,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`NSE fetch failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType =
      response.headers.get("content-type") || "application/pdf";

    await uploadToGCS(doc.storagePath, buffer, contentType);

    let textContent = "";
    if (contentType.includes("pdf")) {
      textContent = await extractPdfText(buffer);
    } else {
      textContent = stripHtmlTags(buffer.toString("utf-8"));
    }

    textContent = capTextContent(textContent);

    await prisma.userDocument.update({
      where: { id: documentId },
      data: {
        textContent,
        fileSize: buffer.length,
        mimeType: contentType,
        processingStatus: "READY",
      },
    });

    if (shouldIndexForRAG(textContent)) {
      await indexDocumentForRAG(userId, documentId, textContent, doc.title);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleGenerateReport(
  userId: string,
  documentId: string,
  reportType?: string,
  reportParams?: Record<string, unknown>,
): Promise<void> {
  const doc = await prisma.userDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  await prisma.userDocument.update({
    where: { id: documentId },
    data: { processingStatus: "PROCESSING", processingError: null },
  });

  const type =
    reportType ||
    ((doc.metadata as Record<string, unknown>)?.reportType as string);
  if (!type) throw new Error("No report type specified");

  // Dynamically import report generators to keep the processor lean
  const { renderReportToBuffer } = await import("../lib/report-renderer");
  const buffer = await renderReportToBuffer(userId, type, reportParams);

  await uploadToGCS(doc.storagePath, buffer, "application/pdf");

  await prisma.userDocument.update({
    where: { id: documentId },
    data: {
      fileSize: buffer.length,
      processingStatus: "READY",
    },
  });
}

// ============== Helpers ==============

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // Dynamic import - pdf-parse may not be installed in all environments
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return parsed.text || "";
  } catch (error) {
    console.error("[document-process] PDF text extraction failed:", error);
    return "[PDF text extraction failed]";
  }
}

async function indexDocumentForRAG(
  userId: string,
  documentId: string,
  textContent: string,
  title: string,
): Promise<void> {
  try {
    const chunks = chunkText(textContent, 512, 50);

    const texts = chunks.map((chunk) => `Document: ${title}\n\n${chunk.text}`);
    const { embeddings, failedIndices } = await generateBatchEmbeddings(texts);

    if (failedIndices.length > 0) {
      console.warn("[document-process] N embedding chunks failed", {
        count: failedIndices.length,
        documentId,
      });
    }

    // Store embeddings. `buildEmbeddingRecords` maps to the real schema fields
    // (docId + chunkId — the DocumentEmbedding model has NO `documentId`
    // column; writing one silently fails the createMany and leaves the doc
    // un-embedded and un-citable).
    const embeddingsToStore = buildEmbeddingRecords(
      userId,
      documentId,
      title,
      chunks,
      texts,
      embeddings,
      failedIndices,
    );

    if (embeddingsToStore.length > 0) {
      // Tag rows with the model that produced them (env-gated). See the
      // re-embed cutover note in workers/src/lib/embeddings.ts.
      const embeddingModel = getEmbeddingModel();
      const targets = writeTargets(await getEmbeddingsMode()); // MONEY-1499

      if (targets.includes("v1")) {
        await prisma.documentEmbedding.createMany({
          data: embeddingsToStore.map((e) => ({
            userId: e.userId,
            docId: e.docId,
            chunkId: e.chunkId,
            docType: e.docType,
            content: e.content,
            embedding: e.embedding,
            embeddingModel,
            metadata: e.metadata as Prisma.InputJsonValue,
          })),
        });
      }

      if (targets.includes("v2")) {
        const { refused } = await upsertEmbeddingsV2(
          (cmd) => prisma.$runCommandRaw(cmd as never),
          embeddingsToStore.map((e) => ({
            userId: e.userId,
            docType: e.docType,
            docId: e.docId,
            chunkId: e.chunkId,
            content: e.content,
            embedding: e.embedding,
            embeddingModel,
            metadata: e.metadata,
          })),
        );
        if (refused.length > 0) {
          console.error(
            "[document-process] chunks REFUSED by v2 — they are not in the v2 corpus",
            { documentId, refused },
          );
        }
      }

      await prisma.userDocument.update({
        where: { id: documentId },
        data: { isEmbedded: true },
      });
    }

    console.log(
      `[document-process] Indexed ${embeddingsToStore.length} chunks for document ${documentId}`,
    );
  } catch (error) {
    console.error("[document-process] RAG indexing failed:", error);
    // Don't throw - indexing failure shouldn't fail the whole job
  }
}

async function updateJobStatus(
  jobId: string,
  status: "PROCESSING" | "COMPLETED" | "FAILED",
  errorMessage?: string,
): Promise<void> {
  try {
    const data = buildJobStatusUpdate(status, errorMessage);

    await prisma.backgroundJob.update({
      where: { jobId },
      data,
    });
  } catch (error) {
    console.error(`[document-process] Failed to update job ${jobId}:`, error);
  }
}
