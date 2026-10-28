/**
 * UMAI invoice/credit-note number allocation.
 *
 * Critical GST rule: numbering must be GAPLESS per (documentType, FY) - every
 * sequence resets on April 1, no holes are allowed (audit will flag missing
 * numbers). Cancelled documents keep their number; only the status changes.
 *
 * Concurrency model:
 *   Mongo's `findOneAndUpdate` with `$inc` on a counter document is atomic
 *   per document - two concurrent calls cannot allocate the same number.
 *   The unique index on `(documentType, financialYear)` ensures only one
 *   counter per FY exists.
 *
 * Format produced:
 *   Invoices       → UMAI/EXP/26-27/0001
 *   Credit notes   → UMAI/EXP/CN/26-27/0001
 *
 * The `prefix` is stored on the counter so backfill-FY counters can opt
 * into a different prefix if regulation changes (currently always `UMAI/EXP/`
 * for export invoices and `UMAI/EXP/CN/` for credit notes).
 */

import { prisma } from "@usemoney/database";
import { getFinancialYear } from "./billing-period";

export type DocumentType =
  | "INVOICE" // export-of-services aggregated invoice (MONEY-212–217)
  | "INVOICE_DOMESTIC" // per-user domestic invoice (MONEY-227)
  | "CREDIT_NOTE";

const PREFIX_BY_TYPE: Record<DocumentType, string> = {
  INVOICE: "UMAI/EXP/",
  INVOICE_DOMESTIC: "UMAI/DOM/",
  CREDIT_NOTE: "UMAI/EXP/CN/",
};

const PAD_WIDTH = 4;

export interface AllocatedNumber {
  documentType: DocumentType;
  financialYear: string;
  sequence: number;
  /** The full formatted document number, e.g. "UMAI/EXP/26-27/0001" */
  number: string;
}

/**
 * Allocate the next number atomically for the given documentType + FY.
 * Two callers racing on the same FY each get a distinct sequence; Mongo
 * guarantees this via document-level atomicity on `$inc`.
 *
 * NOTE: this function is intentionally NOT idempotent - every call advances
 * the counter. The engine MUST follow the call with an immediate insert of
 * a `GstInvoice`/`GstCreditNote` row that pins the number; on insert failure
 * the engine writes a `cancelled` placeholder so the audit trail still has
 * the number accounted for (per the invoice-engine ticket spec).
 */
export async function allocateUmaiNumber(args: {
  documentType: DocumentType;
  invoiceDate: Date;
}): Promise<AllocatedNumber> {
  const fy = getFinancialYear(args.invoiceDate);
  const prefix = PREFIX_BY_TYPE[args.documentType];

  const updated = await prisma.gstInvoiceCounter.upsert({
    where: {
      documentType_financialYear: {
        documentType: args.documentType,
        financialYear: fy,
      },
    },
    update: {
      sequence: { increment: 1 },
    },
    create: {
      documentType: args.documentType,
      financialYear: fy,
      prefix,
      sequence: 1,
    },
  });

  const padded = String(updated.sequence).padStart(PAD_WIDTH, "0");
  // For invoices: prefix already ends in "/" → "UMAI/EXP/" + "26-27/" + "0001"
  // For credit notes: "UMAI/EXP/CN/" + "26-27/" + "0001"
  return {
    documentType: args.documentType,
    financialYear: fy,
    sequence: updated.sequence,
    number: `${prefix}${fy}/${padded}`,
  };
}

/**
 * Read-only helper for tests / admin tools - returns the next sequence WITHOUT
 * advancing the counter. Useful for previewing what number a generation call
 * would produce.
 */
export async function peekNextUmaiSequence(args: {
  documentType: DocumentType;
  financialYear: string;
}): Promise<number> {
  const counter = await prisma.gstInvoiceCounter.findUnique({
    where: {
      documentType_financialYear: {
        documentType: args.documentType,
        financialYear: args.financialYear,
      },
    },
  });
  return (counter?.sequence ?? 0) + 1;
}
