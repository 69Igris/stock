/**
 * GST invoice generation engine.
 *
 * Consumes `DodoPayoutStaging` rows for a (billingPeriod × currency) pair
 * and produces a finalised `GstInvoice` (or a `GstCreditNote` for refund
 * periods). Each invoice is dated the LAST day of its billing period (per
 * CGST §13 time-of-supply rules) regardless of when Dodo settled the payout.
 *
 * Pipeline (transactional intent - see comments on $transaction below):
 *   1. Hard-gate on GST_LUT_ARN env (LUT is mandatory for export-under-bond).
 *   2. Load all unconsumed staging rows for the (period, currency).
 *   3. Sum gross/fees/net. If net < 0 → branch to credit-note path.
 *   4. Resolve INR via RBI reference rate on the invoice date.
 *   5. Allocate the next UMAI number atomically.
 *   6. Insert invoice as DRAFT, mark staging rows as consumed.
 *   7. PDF generation handed off to MONEY-215 worker; this engine returns
 *      the draft invoice and lets the caller orchestrate finalisation.
 *
 * Banker's-rounding policy: all monetary values are stored as Float (Mongo
 * connector limitation, see schema comment). The engine rounds to 2dp at
 * the boundary (input + output) using half-to-even rounding to avoid
 * accumulating bias across many invoices, which would otherwise drift the
 * GSTR-1 totals against bank-statement reconciliation.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import {
  GstInvoiceStatus,
  GstSupplyType,
  GstCreditNoteReason,
  type Prisma,
  type GstInvoice,
  type GstCreditNote,
} from "@usemoney/database";
import { allocateUmaiNumber } from "./numbering";
import {
  getRbiReferenceRate,
  RbiRateUnavailableError,
  type FxRateLookup,
} from "./rbi-fx";
import { getFinancialYear } from "./billing-period";
import { recordAuditEvent } from "./audit-log";

const DEFAULT_HSN_SAC = process.env.GST_DEFAULT_SAC ?? "998314";
const SELLER_DEFAULT_GSTIN = process.env.GST_SELLER_GSTIN ?? "";

export class LutArnNotConfiguredError extends Error {
  constructor() {
    super(
      "LUT ARN not configured - invoice generation blocked. Set GST_LUT_ARN env.",
    );
    this.name = "LutArnNotConfiguredError";
  }
}

export class NoPendingPayoutsError extends Error {
  constructor(period: { start: Date; end: Date }, currency: string) {
    super(
      `No pending DodoPayoutStaging rows for ${currency} in period ${period.start.toISOString()} → ${period.end.toISOString()}`,
    );
    this.name = "NoPendingPayoutsError";
  }
}

export interface GenerateInvoiceInput {
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  currency: string;
  /** Optional override for the date stamped on the document. Defaults to
   * `billingPeriodEnd` (the time-of-supply date per CGST §13). Used by
   * backfills to land an invoice in a past FY's counter. */
  invoiceDateOverride?: Date;
  generatedBy?: string;
}

export type GenerateInvoiceResult =
  | { kind: "invoice"; invoice: GstInvoice }
  | { kind: "credit_note"; creditNote: GstCreditNote };

/**
 * Half-to-even rounding to 2 decimal places. JS's default `toFixed` uses
 * half-away-from-zero which biases sums upward for many positive values.
 * Banker's rounding distributes the bias evenly, which is what GSTR-1
 * reconciliation against bank statements requires.
 */
export function roundCurrency(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff < 0.5) rounded = floor;
  else if (diff > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / 100;
}

function requireLutArn(): string {
  const arn = process.env.GST_LUT_ARN;
  if (!arn || arn.trim() === "") throw new LutArnNotConfiguredError();
  return arn.trim();
}

/**
 * MONEY-1236 — the "not yet consumed by an invoice/credit note" predicate for
 * `DodoPayoutStaging`, in the ONLY spelling Prisma's MongoDB connector honours.
 *
 * Prisma-on-Mongo does NOT treat an ABSENT field as null. A bare
 * `{ consumedByInvoiceId: null }` compiles to an equality against an explicit
 * JSON null and therefore matches ONLY documents that actually CARRY the key.
 * Every freshly staged row is missing it: `stageDodoRows`' row build
 * (staging.service.ts) never wrote the field, and the schema's
 * `consumedByInvoiceId String? @db.ObjectId` has no `@default` — `prisma db push`
 * creates INDEXES, never FIELDS, so Mongo stores no key at all. The four read
 * sites below therefore selected ZERO rows against a table full of pending
 * payouts, and `generateGstInvoice` threw `NoPendingPayoutsError` — a silent
 * "nothing to invoice" on a GST-COMPLIANCE path, which is the worst possible
 * failure shape (no error, no alert, no invoice, and the export-under-LUT
 * filing quietly under-reports).
 *
 * This is the FIFTH occurrence of the same defect class in this repo
 * (MONEY-1050 `{not:false}` vs absent, MONEY-1205, MONEY-1234, MONEY-1235) and
 * the established fix is exactly the OR below. `isSet: false` is the only
 * Prisma spelling that reaches an absent key (it lowers to `$exists: false`);
 * `{ equals: null }`, `{ not: null }` and a bare `null` all do not.
 *
 * Kept as ONE constant rather than four copies of the literal so the read sites
 * cannot drift apart — a HALF-fixed predicate is precisely how MONEY-1234's
 * second broken pipe stayed hidden behind an INCOMPARABLE verdict.
 *
 * MEASURED ON PROD 2026-08-21: `dodo_payout_staging` total=0, absent=0. Nothing
 * has been mis-invoiced yet, because nothing has been staged yet. This is a fix
 * landed BEFORE the table fills, not a repair of damage already done — see the
 * `stageDodoRows` note for the write half of the same story.
 */
export const UNCONSUMED_STAGING_OR: Prisma.DodoPayoutStagingWhereInput[] = [
  { consumedByInvoiceId: null },
  { consumedByInvoiceId: { isSet: false } },
];

interface AggregatedTotals {
  grossForeign: number;
  feesForeign: number;
  netForeign: number;
  rowCount: number;
  rowIds: string[];
}

/**
 * Build the aggregate totals by summing all unconsumed staging rows for the
 * (period, currency). Returns null if there are no rows to invoice.
 */
async function aggregateStagingForPeriod(args: {
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  currency: string;
}): Promise<AggregatedTotals | null> {
  const rows = await prisma.dodoPayoutStaging.findMany({
    where: {
      // MONEY-1236: null-OR-absent. A bare `consumedByInvoiceId: null` here
      // matched nothing, so this whole engine was a no-op against real data.
      OR: UNCONSUMED_STAGING_OR,
      currency: args.currency,
      billingPeriodStart: args.billingPeriodStart,
      billingPeriodEnd: args.billingPeriodEnd,
    },
    select: {
      id: true,
      grossAmount: true,
      feesAmount: true,
      netAmount: true,
    },
  });
  if (rows.length === 0) return null;

  let gross = 0;
  let fees = 0;
  let net = 0;
  for (const r of rows) {
    gross += r.grossAmount;
    fees += r.feesAmount;
    net += r.netAmount;
  }
  return {
    grossForeign: roundCurrency(gross),
    feesForeign: roundCurrency(fees),
    netForeign: roundCurrency(net),
    rowCount: rows.length,
    rowIds: rows.map((r) => r.id),
  };
}

interface CustomerSnapshot {
  customerName: string;
  customerEmail: string;
  customerCountry: string;
  customerAddress: string;
}

/**
 * Pull a representative customer snapshot from the staging rows. For v1 we
 * stamp the invoice with the foreign-buyer summary required by export
 * invoices ("Foreign buyer - GSTIN N/A") rather than per-customer details,
 * because Dodo aggregates many end-customers into a single payout. The
 * detailed per-customer line items are preserved in `items` JSON.
 */
async function buildCustomerSnapshot(args: {
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  currency: string;
}): Promise<CustomerSnapshot> {
  const sample = await prisma.dodoPayoutStaging.findFirst({
    where: {
      // MONEY-1236: null-OR-absent. Must stay in lockstep with
      // `aggregateStagingForPeriod` above — if this one narrowed while that one
      // widened, the invoice would carry a customer country sampled from a
      // DIFFERENT row set than the one it totals.
      OR: UNCONSUMED_STAGING_OR,
      currency: args.currency,
      billingPeriodStart: args.billingPeriodStart,
      billingPeriodEnd: args.billingPeriodEnd,
    },
    select: { customerCountry: true },
  });
  return {
    customerName: "Foreign buyer (DodoPayments aggregated)",
    customerEmail: "n/a",
    customerCountry: sample?.customerCountry || "ZZ",
    customerAddress: "Foreign - GSTIN not applicable (export of services)",
  };
}

function periodLabel(start: Date, end: Date): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(start)} → ${fmt(end)}`;
}

export async function generateGstInvoice(
  input: GenerateInvoiceInput,
): Promise<GenerateInvoiceResult> {
  const lutArn = requireLutArn();
  const currency = input.currency.toUpperCase();
  const invoiceDate = input.invoiceDateOverride ?? input.billingPeriodEnd;
  const totals = await aggregateStagingForPeriod({
    billingPeriodStart: input.billingPeriodStart,
    billingPeriodEnd: input.billingPeriodEnd,
    currency,
  });
  if (!totals) {
    throw new NoPendingPayoutsError(
      { start: input.billingPeriodStart, end: input.billingPeriodEnd },
      currency,
    );
  }

  // Refund-heavy period → credit note path
  if (totals.netForeign < 0) {
    return generateCreditNoteForPeriod({
      ...input,
      invoiceDate,
      currency,
      totals,
      lutArn,
    });
  }

  // A period that nets to exactly zero (rare - full refunds offsetting full
  // charges) gives nothing to invoice. Mark staging rows as consumed under a
  // synthetic "ZERO_NET" sentinel and bail without allocating a number - we
  // do NOT want to burn an audited sequence on a zero-value invoice.
  if (totals.netForeign === 0) {
    await prisma.dodoPayoutStaging.updateMany({
      // MONEY-1236: null-OR-absent. `id: {in: …}` already pins the exact rows,
      // so the guard is belt-and-braces here — but it was the same broken
      // spelling, and a guard that can never fire is indistinguishable from an
      // absent one at review time.
      where: { id: { in: totals.rowIds }, OR: UNCONSUMED_STAGING_OR },
      data: {
        // Writing an EXPLICIT null (not `unset`) is deliberate: it MATERIALISES
        // the key, so these rows are afterwards matched by both arms of the OR
        // and are visible to any future re-generate.
        consumedByInvoiceId: null, // keep null so a future re-generate sees them
        consumedAt: new Date(), // but stamp the timestamp for audit
      },
    });
    logger.info(
      { currency, rowCount: totals.rowCount },
      "GST invoice skipped - period nets to zero",
    );
    throw new NoPendingPayoutsError(
      { start: input.billingPeriodStart, end: input.billingPeriodEnd },
      `${currency} (period nets to zero)`,
    );
  }

  // Resolve FX (skip if INR - domestic supply or INR-denominated payout)
  let fx: FxRateLookup | null = null;
  if (currency !== "INR") {
    try {
      fx = await getRbiReferenceRate({ currency, invoiceDate });
    } catch (error) {
      if (error instanceof RbiRateUnavailableError) {
        // Hard-fail loudly - never invent an FX rate.
        throw error;
      }
      throw error;
    }
  }

  const fxRate = fx?.rate ?? 1;
  const subtotalForeign = totals.netForeign;
  const subtotalInr = roundCurrency(subtotalForeign * fxRate);

  const customer = await buildCustomerSnapshot({
    billingPeriodStart: input.billingPeriodStart,
    billingPeriodEnd: input.billingPeriodEnd,
    currency,
  });

  const supplyType: GstSupplyType =
    currency === "INR" ? "DOMESTIC" : "EXPORT_LUT";
  const placeOfSupply = currency === "INR" ? "" : "96"; // 96 = "other territory" for export

  const allocated = await allocateUmaiNumber({
    documentType: "INVOICE",
    invoiceDate,
  });

  // The number is now spoken-for; if the insert fails we MUST still leave a
  // cancelled placeholder so the audit trail accounts for it. That recovery
  // path lives below in the catch.
  let invoice: GstInvoice;
  try {
    invoice = await prisma.gstInvoice.create({
      data: {
        invoiceNumber: allocated.number,
        financialYear: allocated.financialYear,
        sequence: allocated.sequence,
        invoiceDate,
        supplyType,
        placeOfSupply,
        customerName: customer.customerName,
        customerEmail: customer.customerEmail,
        customerCountry: customer.customerCountry,
        customerAddress: customer.customerAddress,
        currencyCode: currency,
        exchangeRate: fxRate,
        exchangeRateDate: invoiceDate,
        exchangeRateSource: fx?.sourceUrl ?? "INR_NO_CONVERSION",
        subtotalForeign,
        subtotalInr,
        totalTaxInr: 0, // EXPORT_LUT → zero-rated
        totalInr: subtotalInr,
        items: [
          {
            description: `SaaS subscription services (DodoPayments aggregated, ${periodLabel(input.billingPeriodStart, input.billingPeriodEnd)})`,
            hsnSac: DEFAULT_HSN_SAC,
            quantity: 1,
            unitPriceForeign: subtotalForeign,
            lineTotalForeign: subtotalForeign,
          },
        ],
        lutNumber: lutArn,
        status: GstInvoiceStatus.DRAFT,
        generatedBy: input.generatedBy,
      },
    });
  } catch (error) {
    // Insert failed AFTER number allocation. Persist a cancelled placeholder so
    // the sequence isn't a phantom hole at audit time.
    logger.error(
      { error, allocated },
      "GST invoice insert failed - recording cancelled placeholder for audited number",
    );
    await prisma.gstInvoice.create({
      data: {
        invoiceNumber: allocated.number,
        financialYear: allocated.financialYear,
        sequence: allocated.sequence,
        invoiceDate,
        supplyType,
        placeOfSupply,
        customerName: customer.customerName,
        customerEmail: customer.customerEmail,
        customerCountry: customer.customerCountry,
        customerAddress: customer.customerAddress,
        currencyCode: currency,
        exchangeRate: fxRate,
        exchangeRateDate: invoiceDate,
        exchangeRateSource: fx?.sourceUrl ?? "INR_NO_CONVERSION",
        subtotalForeign,
        subtotalInr,
        totalTaxInr: 0,
        totalInr: subtotalInr,
        items: [],
        lutNumber: lutArn,
        status: GstInvoiceStatus.CANCELLED,
        cancellationReason: `Insert failed: ${error instanceof Error ? error.message : String(error)}`,
        generatedBy: input.generatedBy,
      },
    });
    throw error;
  }

  // Atomically claim the staging rows. The "unconsumed" clause guards against a
  // concurrent invoice generation for the same period - if another caller
  // already consumed any of these rows, our updateMany affects fewer rows than
  // expected and we MUST cancel the just-issued invoice rather than leave a
  // phantom claim.
  //
  // MONEY-1236: this is the site where the bare `consumedByInvoiceId: null`
  // spelling was most dangerous. `aggregateStagingForPeriod` (fixed above) can
  // now SEE the absent-key rows, but a claim still written as `null` would
  // match ZERO of them, so `claim.count !== rowIds.length` on EVERY run — the
  // engine would cancel every invoice it had just issued and burn an audited
  // UMAI number per attempt, reporting a "concurrent race" that never happened.
  // Widening the read without widening the claim is strictly worse than
  // widening neither.
  const claim = await prisma.dodoPayoutStaging.updateMany({
    where: {
      id: { in: totals.rowIds },
      OR: UNCONSUMED_STAGING_OR,
    },
    data: {
      consumedByInvoiceId: invoice.id,
      consumedAt: new Date(),
    },
  });

  if (claim.count !== totals.rowIds.length) {
    logger.warn(
      {
        invoiceId: invoice.id,
        number: invoice.invoiceNumber,
        expected: totals.rowIds.length,
        claimed: claim.count,
      },
      "Concurrent staging consume - invoice cancelled to preserve audit trail",
    );
    await prisma.gstInvoice.update({
      where: { id: invoice.id },
      data: {
        status: GstInvoiceStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason:
          "Concurrent generation race - another caller consumed staging rows first",
      },
    });
    // Best-effort: release any rows we DID claim so the winning caller's
    // totals stay consistent. Mongo doesn't roll back the partial claim
    // automatically.
    await prisma.dodoPayoutStaging.updateMany({
      where: { consumedByInvoiceId: invoice.id },
      data: { consumedByInvoiceId: null, consumedAt: null },
    });
    throw new Error(
      `Staging-row race for ${currency} ${input.billingPeriodStart.toISOString()} → ${input.billingPeriodEnd.toISOString()} - invoice ${invoice.invoiceNumber} cancelled`,
    );
  }

  await recordAuditEvent({
    documentType: "INVOICE",
    documentId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    action: "GENERATE",
    actorClerkId: input.generatedBy,
    after: {
      status: invoice.status,
      currency: invoice.currencyCode,
      subtotalForeign,
      subtotalInr,
      fxRate,
      fxSource: fx?.sourceUrl ?? "n/a",
    },
  }).catch((err) =>
    logger.warn({ err, invoiceId: invoice.id }, "audit log write failed"),
  );

  logger.info(
    {
      invoiceId: invoice.id,
      number: invoice.invoiceNumber,
      currency,
      subtotalForeign,
      subtotalInr,
      fxSource: fx?.source ?? "n/a",
    },
    "GST invoice draft created",
  );

  return { kind: "invoice", invoice };
}

async function generateCreditNoteForPeriod(args: {
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  currency: string;
  invoiceDate: Date;
  totals: AggregatedTotals;
  lutArn: string;
  generatedBy?: string;
}): Promise<GenerateInvoiceResult> {
  const { totals, currency, invoiceDate } = args;
  const refundForeign = roundCurrency(Math.abs(totals.netForeign));

  let fx: FxRateLookup | null = null;
  if (currency !== "INR") {
    fx = await getRbiReferenceRate({ currency, invoiceDate });
  }
  const fxRate = fx?.rate ?? 1;
  const refundInr = roundCurrency(refundForeign * fxRate);

  const customer = await buildCustomerSnapshot({
    billingPeriodStart: args.billingPeriodStart,
    billingPeriodEnd: args.billingPeriodEnd,
    currency,
  });

  // Find the most recent prior invoice for this currency to anchor the CN.
  // Per ticket spec: a refund in a later period creates a CN linked to the
  // ORIGINAL invoice - we pick the latest finalised invoice for now and let
  // the admin re-target if needed.
  const original = await prisma.gstInvoice.findFirst({
    where: { currencyCode: currency, status: GstInvoiceStatus.ISSUED },
    orderBy: { invoiceDate: "desc" },
  });

  const allocated = await allocateUmaiNumber({
    documentType: "CREDIT_NOTE",
    invoiceDate,
  });

  const cn = await prisma.gstCreditNote.create({
    data: {
      creditNoteNumber: allocated.number,
      financialYear: allocated.financialYear,
      sequence: allocated.sequence,
      creditNoteDate: invoiceDate,
      originalInvoiceId: original?.id, // null when no unambiguous original
      originalInvoiceNumber: original?.invoiceNumber ?? "UNKNOWN",
      reason: GstCreditNoteReason.REFUND,
      supplyType:
        currency === "INR" ? GstSupplyType.DOMESTIC : GstSupplyType.EXPORT_LUT,
      customerName: customer.customerName,
      customerEmail: customer.customerEmail,
      customerCountry: customer.customerCountry,
      customerAddress: customer.customerAddress,
      currencyCode: currency,
      exchangeRate: fxRate,
      exchangeRateDate: invoiceDate,
      exchangeRateSource: fx?.sourceUrl ?? "INR_NO_CONVERSION",
      refundAmountForeign: refundForeign,
      refundAmountInr: refundInr,
      totalTaxReversedInr: 0,
      totalReversedInr: refundInr,
      status: GstInvoiceStatus.DRAFT,
      generatedBy: args.generatedBy,
    },
  });

  await prisma.dodoPayoutStaging.updateMany({
    where: { id: { in: totals.rowIds } },
    data: {
      consumedByInvoiceId: cn.id, // reuse the field; UI distinguishes via document type
      consumedAt: new Date(),
    },
  });

  logger.info(
    {
      creditNoteId: cn.id,
      number: cn.creditNoteNumber,
      currency,
      refundForeign,
      refundInr,
    },
    "GST credit note draft created",
  );

  return { kind: "credit_note", creditNote: cn };
}

/**
 * Cancel a previously-issued invoice. Per GST rules the number is NOT recycled -
 * status flips to CANCELLED and the row stays in place with the cancellation
 * reason and timestamp recorded for audit.
 */
export async function cancelInvoice(args: {
  invoiceId: string;
  reason: string;
  cancelledBy?: string;
}): Promise<GstInvoice> {
  const before = await prisma.gstInvoice.findUnique({
    where: { id: args.invoiceId },
    select: { status: true, invoiceNumber: true },
  });
  const updated = await prisma.gstInvoice.update({
    where: { id: args.invoiceId },
    data: {
      status: GstInvoiceStatus.CANCELLED,
      cancelledAt: new Date(),
      cancellationReason: args.reason,
    },
  });
  await recordAuditEvent({
    documentType: "INVOICE",
    documentId: updated.id,
    invoiceNumber: updated.invoiceNumber,
    action: "CANCEL",
    actorClerkId: args.cancelledBy,
    before: { status: before?.status },
    after: { status: updated.status, reason: args.reason },
  }).catch((err) =>
    logger.warn({ err, invoiceId: updated.id }, "audit log write failed"),
  );
  logger.info(
    {
      invoiceId: updated.id,
      number: updated.invoiceNumber,
      reason: args.reason,
      cancelledBy: args.cancelledBy,
    },
    "GST invoice cancelled",
  );
  return updated;
}

// Helper exports for tests + downstream tickets
export { getFinancialYear };
