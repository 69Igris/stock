"use server";

import { auth } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { gst } from "@usemoney/services";

/**
 * Ingest a DodoPayments wallet ledger CSV into the staging table.
 *
 * The admin app passes the raw CSV body (server-side fetch from a signed
 * upload URL or direct paste) - keeping the parser in the service layer means
 * future webhook ingestion (FEATURE_DODO_WEBHOOK_INGEST) reuses the same
 * staging path without rewriting parser/dedup logic.
 */
export async function ingestDodoCsvAction(input: {
  csvText: string;
  sourceFileKey?: string;
}): Promise<
  | {
      success: true;
      data: {
        csvHash: string;
        alreadyIngested: boolean;
        inserted: number;
        skippedDuplicates: number;
        totalParsed: number;
        rowErrors: Array<{ rowIndex: number; reason: string }>;
        headerErrors: string[];
      };
    }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const { userId } = await auth();
    const { rows, csvHash, headerErrors, rowErrors } = gst.parseDodoCsv(
      input.csvText,
    );

    if (headerErrors.length > 0) {
      return {
        success: false,
        error: `CSV header invalid: ${headerErrors.join("; ")}`,
      };
    }

    const result = await gst.stageDodoRows({
      rows,
      csvHash,
      uploadedBy: userId || undefined,
      sourceFileKey: input.sourceFileKey,
    });

    return {
      success: true,
      data: {
        csvHash: result.csvHash,
        alreadyIngested: result.alreadyIngested,
        inserted: result.inserted,
        skippedDuplicates: result.skippedDuplicates,
        totalParsed: result.totalParsed,
        rowErrors,
        headerErrors,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to ingest CSV",
    };
  }
}

/**
 * List staged Dodo rows pending invoice generation, grouped by
 * (billingPeriod × currency). Used by the "Generate from payout" drawer in
 * the admin UI (MONEY-216) to preview which invoices WOULD be created.
 */
export async function listPendingPayoutGroupsAction(): Promise<
  | {
      success: true;
      data: Array<{
        billingPeriodStart: Date;
        billingPeriodEnd: Date;
        currency: string;
        rowCount: number;
        netAmount: number;
        grossAmount: number;
      }>;
    }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    // MongoDB Prisma doesn't support `groupBy` on Date fields directly across
    // arbitrary granularity; fetch unconsumed rows and aggregate in memory.
    // Volume is bounded (≤ a few thousand pending rows per cycle) so this is fine.
    //
    // MONEY-1236 — "unconsumed" must be spelled null-OR-absent. Prisma's Mongo
    // connector does not treat an ABSENT field as null, and every staged row
    // written before this ticket is missing `consumedByInvoiceId` entirely
    // (`stageDodoRows` omitted it; the schema has no `@default`; `db push`
    // creates indexes, never fields). A bare `{consumedByInvoiceId: null}` here
    // returned an EMPTY pending list against a full staging table, so the
    // "Generate from payout" drawer showed "nothing pending" and the admin had
    // no way to discover the rows existed.
    //
    // The canonical predicate is `UNCONSUMED_STAGING_OR` in
    // packages/services/src/gst/invoice-engine.service.ts. It is duplicated
    // here rather than imported because `@usemoney/services` only exposes the
    // GST barrel (`./gst`) and this ticket does not own that barrel — the two
    // copies are pinned together by
    // apps/web/__tests__/services/gst-unconsumed-staging-filter.test.ts, which
    // fails if EITHER file loses the `isSet: false` arm.
    const pending = await prisma.dodoPayoutStaging.findMany({
      where: {
        OR: [
          { consumedByInvoiceId: null },
          { consumedByInvoiceId: { isSet: false } },
        ],
      },
      select: {
        billingPeriodStart: true,
        billingPeriodEnd: true,
        currency: true,
        netAmount: true,
        grossAmount: true,
      },
    });

    const groups = new Map<
      string,
      {
        billingPeriodStart: Date;
        billingPeriodEnd: Date;
        currency: string;
        rowCount: number;
        netAmount: number;
        grossAmount: number;
      }
    >();
    for (const row of pending) {
      const key = `${row.billingPeriodStart.toISOString()}|${row.billingPeriodEnd.toISOString()}|${row.currency}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rowCount++;
        existing.netAmount += row.netAmount;
        existing.grossAmount += row.grossAmount;
      } else {
        groups.set(key, {
          billingPeriodStart: row.billingPeriodStart,
          billingPeriodEnd: row.billingPeriodEnd,
          currency: row.currency,
          rowCount: 1,
          netAmount: row.netAmount,
          grossAmount: row.grossAmount,
        });
      }
    }

    return {
      success: true,
      data: Array.from(groups.values()).sort(
        (a, b) =>
          a.billingPeriodStart.getTime() - b.billingPeriodStart.getTime(),
      ),
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to list pending payout groups",
    };
  }
}

// ============== List + filter + download ==============

export interface InvoiceListItem {
  id: string;
  invoiceNumber: string;
  invoiceDate: Date;
  financialYear: string;
  customerName: string;
  customerCountry: string;
  currencyCode: string;
  subtotalForeign: number;
  totalInr: number;
  status: string;
  fircStatus: string;
  pdfStorageKey: string | null;
  createdAt: Date;
}

/**
 * List invoices for the admin table. Filters compose: pass any/all of date
 * range, currency, status, and a free-text search over invoiceNumber +
 * dodoPaymentId. Pagination is offset-based - admin volumes are low (≤ a
 * few hundred per FY) so we don't need cursors yet.
 */
export async function listGstInvoicesAction(input: {
  startDate?: Date;
  endDate?: Date;
  currency?: string;
  status?: "DRAFT" | "ISSUED" | "CANCELLED";
  fircStatus?: "PENDING" | "RECEIVED" | "NA";
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<
  | {
      success: true;
      data: { items: InvoiceListItem[]; total: number };
    }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(100, Math.max(10, input.pageSize ?? 25));

    const where: Record<string, unknown> = {};
    if (input.startDate || input.endDate) {
      where.invoiceDate = {
        ...(input.startDate ? { gte: input.startDate } : {}),
        ...(input.endDate ? { lte: input.endDate } : {}),
      };
    }
    if (input.currency) where.currencyCode = input.currency;
    if (input.status) where.status = input.status;
    if (input.search && input.search.trim().length > 0) {
      const term = input.search.trim();
      where.OR = [
        { invoiceNumber: { contains: term, mode: "insensitive" } },
        { dodoPaymentId: { contains: term, mode: "insensitive" } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.gstInvoice.count({ where }),
      prisma.gstInvoice.findMany({
        where,
        orderBy: { invoiceDate: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items: InvoiceListItem[] = rows.map((r) => {
      // FIRC status is currently inferred from MONEY-217's planned schema
      // additions; until those land, surface "PENDING" / "RECEIVED" via a
      // boolean derived from cancellationReason or absence - placeholder.
      const fircStatus = "PENDING";
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        financialYear: r.financialYear,
        customerName: r.customerName,
        customerCountry: r.customerCountry,
        currencyCode: r.currencyCode,
        subtotalForeign: r.subtotalForeign,
        totalInr: r.totalInr,
        status: r.status,
        fircStatus,
        pdfStorageKey: r.pdfStorageKey,
        createdAt: r.createdAt,
      };
    });

    return { success: true, data: { items, total } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to list invoices",
    };
  }
}

/**
 * Generate a 15-min signed download URL for a finalised invoice's PDF.
 * Returns 404-equivalent error for invoices without a stored PDF (DRAFT or
 * CANCELLED) so we never accidentally surface a stale link.
 */
export async function getGstInvoiceDownloadUrlAction(
  invoiceId: string,
): Promise<
  | { success: true; data: { url: string; expiresAt: Date } }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const invoice = await prisma.gstInvoice.findUnique({
      where: { id: invoiceId },
      select: { pdfStorageKey: true, status: true },
    });
    if (!invoice) return { success: false, error: "Invoice not found" };
    if (!invoice.pdfStorageKey) {
      return {
        success: false,
        error: "Invoice has no rendered PDF (status: " + invoice.status + ")",
      };
    }
    const result = await gst.getInvoiceDownloadUrl({
      storageKey: invoice.pdfStorageKey,
    });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to generate download URL",
    };
  }
}

// ============== Generate from payout (preview → confirm) ==============

/**
 * Confirm-and-generate path for the "Generate from payout" drawer. Iterates
 * the pending (period × currency) groups, runs the engine + PDF render +
 * upload + finalise per group, surfaces per-row errors so partial success
 * is observable. Sequential generation - never parallel - so the gapless
 * counter contract isn't tested concurrently from the admin path.
 */
export async function generateInvoicesFromPayoutAction(input: {
  groups: Array<{
    billingPeriodStart: string; // ISO
    billingPeriodEnd: string; // ISO
    currency: string;
  }>;
}): Promise<{
  success: true;
  data: Array<{
    billingPeriodStart: string;
    billingPeriodEnd: string;
    currency: string;
    status: "issued" | "credit_note" | "failed" | "skipped";
    invoiceNumber?: string;
    error?: string;
  }>;
}> {
  await requireAdmin();
  const { userId } = await auth();
  const results: Array<{
    billingPeriodStart: string;
    billingPeriodEnd: string;
    currency: string;
    status: "issued" | "credit_note" | "failed" | "skipped";
    invoiceNumber?: string;
    error?: string;
  }> = [];

  for (const g of input.groups) {
    const start = new Date(g.billingPeriodStart);
    const end = new Date(g.billingPeriodEnd);
    try {
      const generated = await gst.generateGstInvoice({
        billingPeriodStart: start,
        billingPeriodEnd: end,
        currency: g.currency,
        generatedBy: userId || undefined,
      });
      if (generated.kind === "credit_note") {
        results.push({
          billingPeriodStart: g.billingPeriodStart,
          billingPeriodEnd: g.billingPeriodEnd,
          currency: g.currency,
          status: "credit_note",
          invoiceNumber: generated.creditNote.creditNoteNumber,
        });
        continue;
      }
      const finalised = await gst.finaliseInvoice(generated.invoice.id);
      results.push({
        billingPeriodStart: g.billingPeriodStart,
        billingPeriodEnd: g.billingPeriodEnd,
        currency: g.currency,
        status: finalised.status === "ISSUED" ? "issued" : "failed",
        invoiceNumber: finalised.invoiceNumber,
        ...(finalised.cancellationReason
          ? { error: finalised.cancellationReason }
          : {}),
      });
    } catch (error) {
      results.push({
        billingPeriodStart: g.billingPeriodStart,
        billingPeriodEnd: g.billingPeriodEnd,
        currency: g.currency,
        status: "failed",
        error:
          error instanceof Error ? error.message : "Invoice generation failed",
      });
    }
  }

  return { success: true, data: results };
}

/**
 * Cancel an issued invoice. Per GST rules the number stays - only status
 * flips and a reason is recorded for audit.
 */
export async function cancelGstInvoiceAction(input: {
  invoiceId: string;
  reason: string;
}): Promise<
  | { success: true; data: { invoiceNumber: string } }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const { userId } = await auth();
    const updated = await gst.cancelInvoice({
      invoiceId: input.invoiceId,
      reason: input.reason,
      cancelledBy: userId || undefined,
    });
    return { success: true, data: { invoiceNumber: updated.invoiceNumber } };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to cancel invoice",
    };
  }
}

// ============== FIRC tracking (MONEY-217) ==============

export async function markFircReceivedAction(input: {
  invoiceId: string;
  fircStorageKey: string;
  bankCreditDate: Date;
  bankCreditAmountInr: number;
  notes?: string;
}): Promise<
  | { success: true; data: { invoiceNumber: string } }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const { userId } = await auth();
    const before = await prisma.gstInvoice.findUnique({
      where: { id: input.invoiceId },
      select: { fircStatus: true, invoiceNumber: true },
    });
    const updated = await gst.markFircReceived(input);
    await gst.recordAuditEvent({
      documentType: "INVOICE",
      documentId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      action: "FIRC_UPDATE",
      actorClerkId: userId || undefined,
      before: { fircStatus: before?.fircStatus },
      after: {
        fircStatus: updated.fircStatus,
        bankCreditDate: input.bankCreditDate,
        bankCreditAmountInr: input.bankCreditAmountInr,
      },
    });
    return { success: true, data: { invoiceNumber: updated.invoiceNumber } };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to mark FIRC received",
    };
  }
}

export async function getFircReconciliationAction(input: {
  startDate?: Date;
  endDate?: Date;
}) {
  await requireAdmin();
  try {
    const data = await gst.getFircReconciliation(input);
    return { success: true as const, data };
  } catch (error) {
    return {
      success: false as const,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load FIRC reconciliation",
    };
  }
}

// ============== GSTR-1 Table 6A export (MONEY-217) ==============

export async function exportGstr1Table6aAction(input: {
  monthStart: Date;
  monthEnd: Date;
}): Promise<
  | {
      success: true;
      data: { csv: string; rowCount: number; monthLabel: string };
    }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const { userId } = await auth();
    const result = await gst.buildGstr1Table6aCsv(input);

    // Record export event - one audit row per export, not per invoice, since
    // the export is a snapshot across many documents. documentId is omitted
    // (the schema makes it optional for cross-document events like GSTR1_EXPORT).
    if (result.rows.length > 0) {
      await prisma.gstAuditLog.create({
        data: {
          documentType: "INVOICE",
          invoiceNumber: `GSTR1_${result.monthLabel}`,
          action: "GSTR1_EXPORT",
          actorClerkId: userId || undefined,
          afterJson: {
            month: result.monthLabel,
            invoiceCount: result.rows.length,
            invoiceNumbers: result.rows.map((r) => r.invoiceNumber),
          } as unknown as object,
        },
      });
    }

    return {
      success: true,
      data: {
        csv: result.csv,
        rowCount: result.rows.length,
        monthLabel: result.monthLabel,
      },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to export GSTR-1 Table 6A",
    };
  }
}

// ============== Audit log read ==============

export async function getInvoiceAuditHistoryAction(invoiceId: string) {
  await requireAdmin();
  try {
    const events = await gst.getAuditHistory(invoiceId);
    return { success: true as const, data: events };
  } catch (error) {
    return {
      success: false as const,
      error:
        error instanceof Error ? error.message : "Failed to load audit log",
    };
  }
}

// ============== Admin: per-user GST profile editor (MONEY-227) ==============

export async function adminGetUserGstProfileAction(userId: string) {
  await requireAdmin();
  try {
    const profile = await gst.getUserGstProfile(userId);
    return { success: true as const, data: profile };
  } catch (error) {
    return {
      success: false as const,
      error: error instanceof Error ? error.message : "Failed to load profile",
    };
  }
}

export async function adminSetUserGstProfileAction(input: {
  userId: string;
  legalName: string;
  address: string;
  stateCode: string;
  gstin?: string;
  pan?: string;
}): Promise<
  | { success: true; data: { legalName: string } }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const { userId: actorClerkId } = await auth();
    const before = await gst.getUserGstProfile(input.userId);
    const profile = await gst.setUserGstProfile(input.userId, {
      legalName: input.legalName,
      address: input.address,
      stateCode: input.stateCode,
      gstin: input.gstin,
      pan: input.pan,
    });
    // Audit row anchored to the user (not an invoice). documentId is the
    // user's ObjectId; the action string distinguishes this from the
    // invoice GENERATE/CANCEL events.
    await prisma.gstAuditLog.create({
      data: {
        documentType: "INVOICE",
        documentId: input.userId,
        invoiceNumber: `USER_GST_PROFILE_${input.userId}`,
        action: "FIRC_UPDATE", // closest existing action; expand enum later
        actorClerkId: actorClerkId || undefined,
        beforeJson: before
          ? {
              legalName: before.legalName,
              gstin: before.gstin,
              stateCode: before.stateCode,
            }
          : undefined,
        afterJson: {
          legalName: profile.legalName,
          gstin: profile.gstin,
          stateCode: profile.stateCode,
        },
      },
    });
    return { success: true, data: { legalName: profile.legalName } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to save profile",
    };
  }
}

/**
 * Admin trigger to (re)generate a domestic invoice for a specific payment.
 * Useful when the user added their GST profile after the payment cleared,
 * or when the profile was wrong and the invoice needs regeneration.
 */
export async function adminGenerateDomesticInvoiceAction(input: {
  paymentId: string;
}): Promise<
  | { success: true; data: { invoiceNumber: string } }
  | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const { userId: actorClerkId } = await auth();
    const invoice = await gst.generateDomesticInvoiceForPayment({
      paymentId: input.paymentId,
      generatedBy: actorClerkId || undefined,
    });
    const finalised = await gst.finaliseInvoice(invoice.id);
    return {
      success: true,
      data: { invoiceNumber: finalised.invoiceNumber },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate invoice",
    };
  }
}
