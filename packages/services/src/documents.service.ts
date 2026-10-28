/**
 * Documents Service
 *
 * CRUD operations for UserDocument records and report generation.
 * Source: apps/web/lib/actions/documents.ts
 *
 * NOTE: Upload, signed URLs, GCS operations, and Pub/Sub publishing
 * stay in the action layer since they depend on GCS and Pub/Sub infra.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  clampDocumentPagination,
  documentScopeWhere,
  buildDocumentListWhere,
} from "./documents-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface DocumentListItem {
  id: string;
  title: string;
  description: string | null;
  sourceType: string;
  documentType: string;
  category: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  processingStatus: string;
  /**
   * MONEY-1168: why a FAILED document failed, in one already-sanitised
   * sentence. Null for every other status, and for rows that failed before the
   * field existed — so the UI must treat "FAILED with no reason" as a valid
   * state rather than assuming this is present.
   */
  processingError: string | null;
  isEmbedded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDetail {
  id: string;
  title: string;
  description: string | null;
  sourceType: string;
  documentType: string;
  category: string;
  storagePath: string;
  originalUrl: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  processingStatus: string;
  isEmbedded: boolean;
  textContent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentFilters {
  category?: string;
  sourceType?: string;
  search?: string;
  skip?: number;
  limit?: number;
}

export interface GenerateReportInput {
  type: string;
  fy?: string;
}

// ── Service Functions ──────────────────────────────────────────────

export async function getDocuments(
  userId: string,
  filters: DocumentFilters = {},
): Promise<ServiceResult<{ documents: DocumentListItem[]; total: number }>> {
  try {
    const { category, sourceType, search, skip, limit } = filters;

    // userId-scoped + soft-delete-hidden where (single source of truth so the
    // list can never leak another user's documents or deleted rows).
    const where = buildDocumentListWhere(userId, {
      category,
      sourceType,
      search,
    });

    // Clamp possibly-untrusted pagination (a future apps/api `/v1/documents`
    // route forwards raw ?skip=/?limit= query) into safe Prisma bounds. Without
    // this, a NaN/negative/huge take|skip reaches findMany and Prisma throws —
    // see documents-logic.ts#clampDocumentPagination.
    const { take, skip: safeSkip } = clampDocumentPagination(limit, skip);

    const [documents, total] = await Promise.all([
      prisma.userDocument.findMany({
        where,
        select: {
          id: true,
          title: true,
          description: true,
          sourceType: true,
          documentType: true,
          category: true,
          fileName: true,
          fileSize: true,
          mimeType: true,
          processingStatus: true,
          // MONEY-1168: without this the card can only ever show a bare
          // FAILED, which is the bug — a 403 from the remote host looked
          // identical to a defect in our own pipeline.
          processingError: true,
          isEmbedded: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: safeSkip,
        take,
      }),
      prisma.userDocument.count({ where }),
    ]);

    return { success: true, data: { documents, total } };
  } catch (error) {
    logger.error({ error, userId }, "Get documents service error");
    return { success: false, error: "Failed to list documents" };
  }
}

export async function getDocument(
  userId: string,
  id: string,
): Promise<ServiceResult<DocumentDetail>> {
  try {
    const doc = await prisma.userDocument.findFirst({
      where: documentScopeWhere(id, userId),
      select: {
        id: true,
        title: true,
        description: true,
        sourceType: true,
        documentType: true,
        category: true,
        storagePath: true,
        originalUrl: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        processingStatus: true,
        isEmbedded: true,
        textContent: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!doc) {
      return { success: false, error: "Document not found" };
    }

    return {
      success: true,
      data: {
        ...doc,
        metadata: doc.metadata as Record<string, unknown> | null,
      },
    };
  } catch (error) {
    logger.error({ error, userId, id }, "Get document service error");
    return {
      success: false,
      error: "Failed to get document",
      code: "INTERNAL",
    };
  }
}

export async function deleteDocument(
  userId: string,
  id: string,
): Promise<ServiceResult<void>> {
  try {
    // IDOR-safe soft delete: scope the MUTATION itself by BOTH id AND userId
    // (and not-already-deleted) via updateMany. A bare `update({ where: { id } })`
    // would let any caller soft-delete another user's document — the classic IDOR.
    // updateMany returns the affected count, which doubles as the ownership check:
    // 0 ⇒ the document doesn't exist, isn't owned by this user, or is already
    // deleted → reported as "not found" (no existence oracle for other users' ids).
    const result = await prisma.userDocument.updateMany({
      where: documentScopeWhere(id, userId),
      data: { isDeleted: true },
    });

    if (result.count === 0) {
      return { success: false, error: "Document not found" };
    }

    return { success: true, data: undefined, message: "Document deleted" };
  } catch (error) {
    logger.error({ error, userId, id }, "Delete document service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to delete document",
      code: "INTERNAL",
    };
  }
}

export async function generateReport(
  userId: string,
  type: string,
  params?: { fy?: string },
): Promise<ServiceResult<{ documentId: string }>> {
  try {
    const reportLabels: Record<string, string> = {
      tax: "Tax Report",
      risk: "Risk Report",
      portfolio_statement: "Portfolio Statement",
    };
    const categoryMap: Record<
      string,
      "TAX_REPORT" | "RISK_REPORT" | "PORTFOLIO_STATEMENT" | "OTHER"
    > = {
      tax: "TAX_REPORT",
      risk: "RISK_REPORT",
      portfolio_statement: "PORTFOLIO_STATEMENT",
    };

    const title = `${reportLabels[type] || type}${params?.fy ? ` - FY ${params.fy}` : ""}`;
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    const storagePath = `documents/${userId}/generated/${timestamp}-${randomId}-${type}-report.pdf`;

    const doc = await prisma.userDocument.create({
      data: {
        userId,
        title,
        sourceType: "GENERATED",
        documentType: "REPORT",
        category: categoryMap[type] || "OTHER",
        storagePath,
        fileName: `${type}-report.pdf`,
        fileSize: 0,
        mimeType: "application/pdf",
        processingStatus: "PENDING",
        metadata: { reportType: type, fy: params?.fy },
      },
    });

    return { success: true, data: { documentId: doc.id } };
  } catch (error) {
    logger.error({ error, userId, type }, "Generate report service error");
    return { success: false, error: "Failed to generate report" };
  }
}
