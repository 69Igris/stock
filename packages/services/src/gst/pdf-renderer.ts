/**
 * GST invoice PDF rendering, GCS upload, and finalisation pipeline.
 *
 * The `@react-pdf/renderer` import is dynamic so it only loads when an
 * invoice is actually being rendered - keeps services-package consumers
 * (chat, dashboard, etc.) from paying the cost.
 *
 * Storage layout in the GST private bucket:
 *   {fy}/{invoice_number_safe}.pdf
 *   firc/{fy}/{invoice_number_safe}.pdf   (uploaded later - MONEY-217)
 *
 * Slashes in the invoice number ("UMAI/EXP/26-27/0001") are escaped to
 * underscores in the storage key because GCS treats "/" as a path separator
 * and we want the FY folder hierarchy to come from the prefix, not the
 * sequential number itself.
 */

import { Storage } from "@google-cloud/storage";
import { dbLogger as logger } from "@usemoney/logger";
import { prisma, GstInvoiceStatus, type GstInvoice } from "@usemoney/database";
import { recordAuditEvent } from "./audit-log";

const GCS_BUCKET_ENV = "GCS_BUCKET_GST_INVOICES";
const DEFAULT_BUCKET = "usemoney-gst-invoices";
const SIGNED_URL_TTL_SECONDS = 15 * 60;

let storage: Storage | null = null;

function getStorage(): Storage {
  if (storage) return storage;
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "GCP_PROJECT_ID environment variable is required for GST PDF storage",
    );
  }
  const keyBase64 = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
  if (keyBase64) {
    const credentials = JSON.parse(
      Buffer.from(keyBase64, "base64").toString("utf-8"),
    );
    storage = new Storage({ projectId, credentials });
  } else {
    storage = new Storage({ projectId });
  }
  return storage;
}

function getBucketName(): string {
  return process.env[GCS_BUCKET_ENV] || DEFAULT_BUCKET;
}

export function buildInvoiceStorageKey(args: {
  invoiceNumber: string;
  financialYear: string;
}): string {
  const safeNumber = args.invoiceNumber.replace(/\//g, "_");
  return `${args.financialYear}/${safeNumber}.pdf`;
}

interface SellerEnv {
  legalName: string;
  address: string;
  gstin: string;
  pan: string;
  stateCode: string;
}

interface BankEnv {
  beneficiary: string;
  account: string;
  ifsc: string;
  swift: string;
}

function readSellerEnv(): SellerEnv {
  return {
    legalName: process.env.GST_SELLER_LEGAL_NAME || "DIS Digital LLP",
    address: process.env.GST_SELLER_ADDRESS || "",
    gstin: process.env.GST_SELLER_GSTIN || "",
    pan: process.env.GST_SELLER_PAN || "",
    stateCode: process.env.GST_SELLER_STATE_CODE || "",
  };
}

function readBankEnv(): BankEnv {
  return {
    beneficiary: process.env.GST_BANK_BENEFICIARY || "",
    account: process.env.GST_BANK_ACCOUNT || "",
    ifsc: process.env.GST_BANK_IFSC || "",
    swift: process.env.GST_BANK_SWIFT || "",
  };
}

/**
 * Render the invoice template to a PDF buffer.
 *
 * Dispatches by `documentSubtype`:
 *   - EXPORT  → templates/export-invoice (UMAI/EXP, foreign buyer, LUT, FX)
 *   - DOMESTIC → templates/domestic-invoice (UMAI/DOM, Indian buyer, CGST+SGST/IGST)
 */
export async function renderInvoicePdf(invoice: GstInvoice): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");

  const items =
    Array.isArray(invoice.items) && invoice.items.length > 0
      ? (invoice.items as Array<{
          description: string;
          hsnSac: string;
          quantity: number;
          unitPriceForeign: number;
          lineTotalForeign: number;
        }>)
      : [];

  if (invoice.documentSubtype === "DOMESTIC") {
    const { GstDomesticInvoiceDocument } =
      await import("./templates/domestic-invoice");
    const doc = GstDomesticInvoiceDocument({
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      paymentDate: invoice.invoiceDate,
      placeOfSupply: invoice.placeOfSupply,
      seller: readSellerEnv(),
      buyer: {
        name: invoice.customerName,
        address: invoice.customerAddress,
        stateCode: invoice.customerState || "",
        gstin: invoice.customerGstin || undefined,
      },
      subtotalInr: invoice.subtotalInr,
      cgstRate: invoice.cgstRate ?? 0,
      cgstAmountInr: invoice.cgstAmountInr ?? 0,
      sgstRate: invoice.sgstRate ?? 0,
      sgstAmountInr: invoice.sgstAmountInr ?? 0,
      igstRate: invoice.igstRate ?? 0,
      igstAmountInr: invoice.igstAmountInr ?? 0,
      totalTaxInr: invoice.totalTaxInr,
      totalInr: invoice.totalInr,
      items,
    });
    return renderToBuffer(doc) as Promise<Buffer>;
  }

  // EXPORT path (default)
  const { GstExportInvoiceDocument } =
    await import("./templates/export-invoice");
  const doc = GstExportInvoiceDocument({
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    billingPeriodStart: invoice.invoiceDate,
    billingPeriodEnd: invoice.invoiceDate,
    placeOfSupply: invoice.placeOfSupply,
    seller: readSellerEnv(),
    buyer: {
      name: invoice.customerName,
      email: invoice.customerEmail,
      country: invoice.customerCountry,
      address: invoice.customerAddress,
    },
    currencyCode: invoice.currencyCode,
    exchangeRate: invoice.exchangeRate,
    exchangeRateDate: invoice.exchangeRateDate,
    exchangeRateSource: invoice.exchangeRateSource,
    subtotalForeign: invoice.subtotalForeign,
    subtotalInr: invoice.subtotalInr,
    totalInr: invoice.totalInr,
    items,
    lutNumber: invoice.lutNumber || "",
    bank: readBankEnv(),
  });

  return renderToBuffer(doc) as Promise<Buffer>;
}

export async function uploadInvoicePdf(args: {
  storageKey: string;
  pdfBuffer: Buffer;
}): Promise<void> {
  const bucket = getStorage().bucket(getBucketName());
  await bucket.file(args.storageKey).save(args.pdfBuffer, {
    contentType: "application/pdf",
    resumable: false,
    validation: false,
    metadata: {
      cacheControl: "private, max-age=0, no-store",
    },
  });
}

/**
 * Generate a v4 signed read URL. Default TTL 15 min - matches the admin-UI
 * download contract; never embed in emails or persistent share links.
 */
export async function getInvoiceDownloadUrl(args: {
  storageKey: string;
  ttlSeconds?: number;
}): Promise<{ url: string; expiresAt: Date }> {
  const ttl = args.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  const bucket = getStorage().bucket(getBucketName());
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const [url] = await bucket.file(args.storageKey).getSignedUrl({
    version: "v4",
    action: "read",
    expires: expiresAt.getTime(),
  });
  return { url, expiresAt };
}

/**
 * End-to-end: render PDF, upload to GCS, persist storage key, flip status.
 * Idempotent - already-finalised invoices return without re-rendering.
 *
 * Failure modes:
 *   - Render or upload fails → mark CANCELLED with reason, preserve number
 *   - Already CANCELLED → return as-is (no-op)
 *   - Already ISSUED → return as-is (no-op)
 */
export async function finaliseInvoice(invoiceId: string): Promise<GstInvoice> {
  const invoice = await prisma.gstInvoice.findUnique({
    where: { id: invoiceId },
  });
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  if (invoice.status !== GstInvoiceStatus.DRAFT) {
    return invoice;
  }

  const storageKey = buildInvoiceStorageKey({
    invoiceNumber: invoice.invoiceNumber,
    financialYear: invoice.financialYear,
  });

  try {
    const pdf = await renderInvoicePdf(invoice);
    await uploadInvoicePdf({ storageKey, pdfBuffer: pdf });
  } catch (error) {
    logger.error(
      {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        error,
      },
      "GST invoice PDF render/upload failed - cancelling number",
    );
    return prisma.gstInvoice.update({
      where: { id: invoiceId },
      data: {
        status: GstInvoiceStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: `PDF render failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }

  const updated = await prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: {
      status: GstInvoiceStatus.ISSUED,
      issuedAt: new Date(),
      pdfStorageKey: storageKey,
      pdfGeneratedAt: new Date(),
    },
  });
  await recordAuditEvent({
    documentType: "INVOICE",
    documentId: updated.id,
    invoiceNumber: updated.invoiceNumber,
    action: "FINALISE",
    before: { status: invoice.status },
    after: { status: updated.status, storageKey },
  }).catch((err) =>
    logger.warn({ err, invoiceId: updated.id }, "audit log write failed"),
  );
  logger.info(
    {
      invoiceId: updated.id,
      number: updated.invoiceNumber,
      storageKey,
    },
    "GST invoice finalised",
  );
  return updated;
}

export const INVOICE_PDF_DEFAULTS = {
  signedUrlTtlSeconds: SIGNED_URL_TTL_SECONDS,
  bucketEnv: GCS_BUCKET_ENV,
  defaultBucket: DEFAULT_BUCKET,
};
