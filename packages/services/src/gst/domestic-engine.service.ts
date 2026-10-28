/**
 * Domestic per-user GST invoice generator (MONEY-227).
 *
 * Distinct from the export-of-services engine in `invoice-engine.service.ts`:
 *   - Customer = the individual UseMoney user (not a Dodo aggregate)
 *   - Supply = DOMESTIC India sale (CGST+SGST or IGST), not zero-rated LUT
 *   - Numbering = `UMAI/DOM/YY-YY/NNNN` from a separate counter
 *   - FX = always INR, no RBI lookup
 *   - Triggered per-Payment (not per billing-period × currency group)
 *
 * The PDF + storage + audit-log infra from MONEY-215/217 is reused via
 * `finaliseInvoice` and `recordAuditEvent` so we don't fork the pipeline.
 */

import {
  prisma,
  GstInvoiceStatus,
  GstSupplyType,
  type GstInvoice,
} from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { allocateUmaiNumber } from "./numbering";
import { recordAuditEvent } from "./audit-log";
import {
  roundCurrency,
  LutArnNotConfiguredError,
} from "./invoice-engine.service";
import { getUserGstProfile } from "./user-profile";

const DEFAULT_HSN_SAC = process.env.GST_DEFAULT_SAC ?? "998314";

/**
 * Default GST rate for SaaS subscriptions sold to Indian users.
 * Configurable per release because the actual rate the CA confirms may
 * differ from the default 18% (some financial-information services are
 * exempt; some are 18%; some have 28% as luxury).
 */
function getDefaultGstRate(): number {
  const raw = process.env.GST_DOMESTIC_RATE;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 28) return parsed;
  }
  return 18;
}

function getSellerStateCode(): string {
  return process.env.GST_SELLER_STATE_CODE ?? "";
}

export class GstProfileMissingError extends Error {
  constructor(userId: string) {
    super(
      `User ${userId} has no GST profile saved - cannot generate domestic invoice. User must add details at /settings.`,
    );
    this.name = "GstProfileMissingError";
  }
}

export class PaymentNotEligibleError extends Error {
  constructor(paymentId: string, reason: string) {
    super(`Payment ${paymentId} not eligible for invoice: ${reason}`);
    this.name = "PaymentNotEligibleError";
  }
}

export interface DomesticInvoiceTaxBreakdown {
  /** Total GST rate as a percentage (e.g. 18). */
  ratePercent: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cgstAmountInr: number;
  sgstAmountInr: number;
  igstAmountInr: number;
  totalTaxInr: number;
}

/**
 * Compute the tax split for a domestic sale.
 *
 * Place-of-supply rule:
 *   - Buyer state == seller state → CGST + SGST (rate split equally)
 *   - Buyer state != seller state → IGST (full rate as IGST)
 *
 * Reverse-charge / exempt cases need CA review per supply classification -
 * v1 hard-codes the GST_DOMESTIC_RATE env (default 18%).
 */
export function computeTaxBreakdown(args: {
  taxableValueInr: number;
  buyerStateCode: string;
  sellerStateCode: string;
  ratePercent?: number;
}): DomesticInvoiceTaxBreakdown {
  const ratePercent = args.ratePercent ?? getDefaultGstRate();
  const sameState =
    args.buyerStateCode &&
    args.sellerStateCode &&
    args.buyerStateCode === args.sellerStateCode;

  if (sameState) {
    const half = ratePercent / 2;
    const cgst = roundCurrency((args.taxableValueInr * half) / 100);
    const sgst = roundCurrency((args.taxableValueInr * half) / 100);
    return {
      ratePercent,
      cgstRate: half,
      sgstRate: half,
      igstRate: 0,
      cgstAmountInr: cgst,
      sgstAmountInr: sgst,
      igstAmountInr: 0,
      totalTaxInr: roundCurrency(cgst + sgst),
    };
  }

  const igst = roundCurrency((args.taxableValueInr * ratePercent) / 100);
  return {
    ratePercent,
    cgstRate: 0,
    sgstRate: 0,
    igstRate: ratePercent,
    cgstAmountInr: 0,
    sgstAmountInr: 0,
    igstAmountInr: igst,
    totalTaxInr: igst,
  };
}

export interface GenerateDomesticInvoiceInput {
  paymentId: string;
  /** Optional override for the document date (defaults to Payment.paidAt or now). */
  invoiceDateOverride?: Date;
  /** Optional override for GST rate (defaults to GST_DOMESTIC_RATE env or 18%). */
  ratePercentOverride?: number;
  /** clerkId of admin / "system" string when triggered by webhook. */
  generatedBy?: string;
}

/**
 * Idempotent: if an invoice already exists for `paymentId`, returns it
 * without allocating a new sequence. Callers may safely retry.
 */
export async function generateDomesticInvoiceForPayment(
  input: GenerateDomesticInvoiceInput,
): Promise<GstInvoice> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      userId: true,
      amount: true,
      currency: true,
      status: true,
      paidAt: true,
      planId: true,
      planName: true,
      dodoPaymentId: true,
      taxAmount: true,
      totalAmount: true,
    },
  });
  if (!payment) {
    throw new PaymentNotEligibleError(input.paymentId, "payment not found");
  }
  if (payment.status !== "COMPLETED") {
    throw new PaymentNotEligibleError(
      input.paymentId,
      `payment status is ${payment.status}, not COMPLETED`,
    );
  }
  if (payment.currency.toUpperCase() !== "INR") {
    // Non-INR payments fall under the export-of-services flow (MONEY-212–217)
    // because they're aggregated through Dodo. We don't double-invoice.
    throw new PaymentNotEligibleError(
      input.paymentId,
      `currency ${payment.currency} is not INR - handled by export flow`,
    );
  }

  // Short-circuit if we've already issued an invoice for this payment.
  const existing = await prisma.gstInvoice.findFirst({
    where: {
      paymentId: payment.id,
      status: { not: GstInvoiceStatus.CANCELLED },
    },
  });
  if (existing) {
    return existing;
  }

  // LUT not required for domestic supply, so we DO NOT enforce GST_LUT_ARN here.
  // (Documented difference from the export engine.)

  const profile = await getUserGstProfile(payment.userId);
  if (!profile) {
    throw new GstProfileMissingError(payment.userId);
  }

  const sellerState = getSellerStateCode();
  // Total amount paid (incl. tax) → derive taxable value backwards.
  // Payment.amount is the gross amount user paid; tax was inclusive at v1.
  const ratePercent = input.ratePercentOverride ?? getDefaultGstRate();
  const grossInr = payment.totalAmount ?? payment.amount;
  // Reverse-calculate taxable: gross = taxable * (1 + rate/100) → taxable = gross / (1 + rate/100)
  const taxableInr = roundCurrency(grossInr / (1 + ratePercent / 100));
  const breakdown = computeTaxBreakdown({
    taxableValueInr: taxableInr,
    buyerStateCode: profile.stateCode,
    sellerStateCode: sellerState,
    ratePercent,
  });

  const invoiceDate = input.invoiceDateOverride ?? payment.paidAt ?? new Date();

  const allocated = await allocateUmaiNumber({
    documentType: "INVOICE_DOMESTIC",
    invoiceDate,
  });

  let invoice: GstInvoice;
  try {
    invoice = await prisma.gstInvoice.create({
      data: {
        invoiceNumber: allocated.number,
        financialYear: allocated.financialYear,
        sequence: allocated.sequence,
        invoiceDate,
        documentSubtype: "DOMESTIC",
        supplyType: GstSupplyType.DOMESTIC,
        placeOfSupply: profile.stateCode,
        customerName: profile.legalName,
        customerEmail: "", // not displayed on PDF; stored for completeness
        customerCountry: "IN",
        customerState: profile.stateCode,
        customerGstin: profile.gstin,
        customerAddress: profile.address,
        paymentId: payment.id,
        dodoPaymentId: payment.dodoPaymentId,
        userId: payment.userId,
        currencyCode: "INR",
        exchangeRate: 1,
        exchangeRateDate: invoiceDate,
        exchangeRateSource: "INR_NO_CONVERSION",
        subtotalForeign: taxableInr,
        subtotalInr: taxableInr,
        cgstRate: breakdown.cgstRate,
        cgstAmountInr: breakdown.cgstAmountInr,
        sgstRate: breakdown.sgstRate,
        sgstAmountInr: breakdown.sgstAmountInr,
        igstRate: breakdown.igstRate,
        igstAmountInr: breakdown.igstAmountInr,
        totalTaxInr: breakdown.totalTaxInr,
        totalInr: roundCurrency(taxableInr + breakdown.totalTaxInr),
        items: [
          {
            description: `${payment.planName} (${payment.planId} subscription)`,
            hsnSac: DEFAULT_HSN_SAC,
            quantity: 1,
            unitPriceForeign: taxableInr,
            lineTotalForeign: taxableInr,
          },
        ],
        // No LUT for domestic supply
        status: GstInvoiceStatus.DRAFT,
        generatedBy: input.generatedBy,
      },
    });
  } catch (error) {
    // Insert failed AFTER number allocation - record cancelled placeholder
    // so the audited sequence has no phantom hole.
    logger.error(
      { error, allocated, paymentId: payment.id },
      "Domestic invoice insert failed - recording cancelled placeholder",
    );
    await prisma.gstInvoice.create({
      data: {
        invoiceNumber: allocated.number,
        financialYear: allocated.financialYear,
        sequence: allocated.sequence,
        invoiceDate,
        documentSubtype: "DOMESTIC",
        supplyType: GstSupplyType.DOMESTIC,
        placeOfSupply: profile.stateCode,
        customerName: profile.legalName,
        customerEmail: "",
        customerCountry: "IN",
        customerAddress: profile.address,
        currencyCode: "INR",
        exchangeRate: 1,
        exchangeRateDate: invoiceDate,
        exchangeRateSource: "INR_NO_CONVERSION",
        subtotalForeign: 0,
        subtotalInr: 0,
        totalTaxInr: 0,
        totalInr: 0,
        items: [],
        status: GstInvoiceStatus.CANCELLED,
        cancellationReason: `Insert failed: ${error instanceof Error ? error.message : String(error)}`,
        generatedBy: input.generatedBy,
      },
    });
    throw error;
  }

  await recordAuditEvent({
    documentType: "INVOICE",
    documentId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    action: "GENERATE",
    actorClerkId: input.generatedBy,
    after: {
      paymentId: payment.id,
      subtype: "DOMESTIC",
      taxableInr,
      totalInr: invoice.totalInr,
      ratePercent,
    },
  }).catch((err) =>
    logger.warn({ err, invoiceId: invoice.id }, "audit log write failed"),
  );

  logger.info(
    {
      invoiceId: invoice.id,
      number: invoice.invoiceNumber,
      paymentId: payment.id,
      totalInr: invoice.totalInr,
    },
    "Domestic GST invoice draft created",
  );

  return invoice;
}

// Re-export so callers can avoid cross-importing from invoice-engine.
export { LutArnNotConfiguredError };
