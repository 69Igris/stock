/**
 * Writing a reading into `document_financial_extracts` — MONEY-1314.
 *
 * EXTRACTED from `stock-document-parse.ts` so the OLD parse lane and the NEW
 * ingest lane cannot disagree about what a reading is. They write the same
 * unique key into the same collection, and the figure map below encodes
 * several judgements — which columns this reader may claim, and which it
 * deliberately does not — that would silently diverge if each lane kept its
 * own copy. A test asserts there is exactly one definition.
 */

import prisma from "@usemoney/database";
import {
  DOC_FINANCIALS_PROMPT_VERSION,
  type MappedExtract,
  buildExtractWritePayload,
  type ExtractionVerdict,
} from "@usemoney/core/market-data/document-financials-logic";

/** Set a document's terminal parse status, and `parsedAt` on success. */
export async function markParseStatus(
  id: string,
  parseStatus: string,
  parsedAt: Date | null = null,
): Promise<void> {
  await prisma.stockDocument.update({
    where: { id },
    data: { parseStatus, ...(parsedAt ? { parsedAt } : {}) },
  });
}

/**
 * Upsert one reading, keyed on `(documentId, periodEnd, periodType, basis)`.
 *
 * An upsert rather than a create so a re-parse REPLACES its predecessor instead
 * of colliding on the unique key. That is safe in a way a `stock_financials`
 * write is not: this table's key carries `documentId` and `basis`, so the row
 * being replaced is a reading of the SAME document under the SAME basis and is
 * reproducible by re-running the same (model, prompt) pair — which is exactly
 * what `model` and `promptVersion` are stamped for.
 */
export async function upsertExtract(args: {
  documentId: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  model: string;
  row: MappedExtract;
  /**
   * The gate's WHOLE verdict, not just its status — MONEY-1340.
   *
   * The status alone is FAILED_VALIDATION for every rejection, which is the
   * blind spot this ticket closes: 96.6% of them turned out to be one rule,
   * and no query could have said so.
   */
  verdict: Pick<ExtractionVerdict, "status" | "reasons" | "warnings">;
}): Promise<void> {
  const { documentId, instrumentId, symbol, exchange, model, row, verdict } =
    args;

  // ONE payload, built in core — MONEY-1340. Both writers call this, so a
  // column can no longer be added to one and missed by the other.
  const figures = buildExtractWritePayload(row, verdict, model);

  await prisma.documentFinancialExtract.upsert({
    where: {
      documentId_periodEnd_periodType_basis: {
        documentId,
        periodEnd: row.periodEnd,
        periodType: row.periodType,
        basis: row.basis,
      },
    },
    create: {
      documentId,
      instrumentId,
      symbol,
      exchange,
      periodEnd: row.periodEnd,
      periodType: row.periodType,
      basis: row.basis,
      ...figures,
    },
    update: figures,
  });
}
