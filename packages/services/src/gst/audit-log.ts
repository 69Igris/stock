/**
 * Append-only audit log for GST invoice/credit-note state changes.
 *
 * Per the GST Act, audit retention is 6+ years - these rows are NEVER
 * deleted. Every state-change calls `recordAuditEvent` with a snapshot
 * before/after so a future investigation can reconstruct exactly what
 * the admin saw and acted on.
 */

import { prisma } from "@usemoney/database";

export type GstAuditAction =
  | "GENERATE"
  | "FINALISE"
  | "CANCEL"
  | "FIRC_UPDATE"
  | "BULK_DOWNLOAD"
  | "GSTR1_EXPORT"
  | "CSV_UPLOAD";

export interface AuditEventInput {
  documentType: "INVOICE" | "CREDIT_NOTE";
  documentId: string;
  invoiceNumber: string;
  action: GstAuditAction;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  actorClerkId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  await prisma.gstAuditLog.create({
    data: {
      documentType: input.documentType,
      documentId: input.documentId,
      invoiceNumber: input.invoiceNumber,
      action: input.action,
      beforeJson: input.before
        ? (input.before as unknown as object)
        : undefined,
      afterJson: input.after ? (input.after as unknown as object) : undefined,
      actorClerkId: input.actorClerkId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}

/**
 * Read the audit history for a single document, newest first.
 */
export async function getAuditHistory(documentId: string) {
  return prisma.gstAuditLog.findMany({
    where: { documentId },
    orderBy: { at: "desc" },
  });
}
