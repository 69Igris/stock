/**
 * FIRC (Foreign Inward Remittance Certificate) reconciliation.
 *
 * The bank issues a FIRC after foreign currency funds clear into the Indian
 * account - this is the proof RBI/GST auditors look for that an export
 * actually brought money into India. Our process:
 *   1. Operator uploads FIRC PDF + bank credit date + bank credit amount (INR)
 *   2. Service flips fircStatus to RECEIVED, persists the values
 *   3. Reconciliation view flags invoices where bank-credit INR diverges
 *      from invoiced INR by > 1% - that's a CA-review signal
 *
 * INR-denominated invoices have fircStatus = NA (no remittance occurred);
 * those rows are filtered out of the FIRC reconciliation view.
 */

import { prisma, GstFircStatus, type GstInvoice } from "@usemoney/database";

export interface MarkFircReceivedInput {
  invoiceId: string;
  fircStorageKey: string;
  bankCreditDate: Date;
  bankCreditAmountInr: number;
  notes?: string;
}

const RECONCILIATION_THRESHOLD = 0.01; // 1% - anything wider goes to CA

export async function markFircReceived(
  input: MarkFircReceivedInput,
): Promise<GstInvoice> {
  return prisma.gstInvoice.update({
    where: { id: input.invoiceId },
    data: {
      fircStatus: GstFircStatus.RECEIVED,
      fircReceivedAt: new Date(),
      fircStorageKey: input.fircStorageKey,
      fircBankCreditDate: input.bankCreditDate,
      fircBankCreditAmountInr: input.bankCreditAmountInr,
      fircNotes: input.notes,
    },
  });
}

export async function markFircNotApplicable(invoiceId: string) {
  return prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: { fircStatus: GstFircStatus.NA },
  });
}

export interface FircReconciliationItem {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerCountry: string;
  currencyCode: string;
  invoicedInr: number;
  bankCreditInr: number;
  bankCreditDate: Date;
  variance: number; // (bankCredit - invoiced) / invoiced
  flagged: boolean; // |variance| > RECONCILIATION_THRESHOLD
}

/**
 * Build the FIRC reconciliation view: invoices where FIRC has been received
 * AND the bank credit amount differs materially from the invoiced INR.
 * The variance is informational on every row; `flagged` indicates whether
 * the row warrants CA attention (>1% delta).
 */
export async function getFircReconciliation(args: {
  startDate?: Date;
  endDate?: Date;
}): Promise<FircReconciliationItem[]> {
  const where: Record<string, unknown> = {
    fircStatus: GstFircStatus.RECEIVED,
  };
  if (args.startDate || args.endDate) {
    where.invoiceDate = {
      ...(args.startDate ? { gte: args.startDate } : {}),
      ...(args.endDate ? { lte: args.endDate } : {}),
    };
  }
  const invoices = await prisma.gstInvoice.findMany({
    where,
    orderBy: { invoiceDate: "desc" },
  });

  const out: FircReconciliationItem[] = [];
  for (const inv of invoices) {
    if (inv.fircBankCreditAmountInr == null || inv.fircBankCreditDate == null) {
      continue; // shouldn't happen given fircStatus = RECEIVED, but defensive
    }
    const invoicedInr = inv.totalInr;
    const bankCreditInr = inv.fircBankCreditAmountInr;
    const variance =
      invoicedInr === 0 ? 0 : (bankCreditInr - invoicedInr) / invoicedInr;
    out.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      customerCountry: inv.customerCountry,
      currencyCode: inv.currencyCode,
      invoicedInr,
      bankCreditInr,
      bankCreditDate: inv.fircBankCreditDate,
      variance,
      flagged: Math.abs(variance) > RECONCILIATION_THRESHOLD,
    });
  }
  return out;
}

export const FIRC_RECONCILIATION_THRESHOLD = RECONCILIATION_THRESHOLD;
