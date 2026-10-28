"use server";

import { prisma } from "@usemoney/database";
import { getAuthenticatedUser } from "@/lib/auth";
import { gst } from "@usemoney/services";
import type { UserGstProfile } from "@usemoney/services/gst";

/**
 * Read the signed-in user's GST profile. Returns null when not yet saved -
 * /settings UI surfaces the empty state in that case.
 */
export async function getMyGstProfileAction(): Promise<
  | { success: true; data: UserGstProfile | null }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const profile = await gst.getUserGstProfile(authUser.userId);
    return { success: true, data: profile };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to load GST profile",
    };
  }
}

/**
 * Save / update the signed-in user's GST profile. Validation runs in the
 * service layer (Zod). Form-level errors are surfaced as the `error` field.
 */
export async function setMyGstProfileAction(input: {
  legalName: string;
  address: string;
  stateCode: string;
  gstin?: string;
  pan?: string;
}): Promise<
  { success: true; data: UserGstProfile } | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const profile = await gst.setUserGstProfile(authUser.userId, input);
    return { success: true, data: profile };
  } catch (error) {
    // Zod validation errors carry the field-specific message - surface as-is.
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to save GST profile",
    };
  }
}

/**
 * Generate a 15-min signed download URL for THIS USER's GST invoice
 * attached to a specific payment. IDOR-guarded: refuses to surface URLs for
 * payments belonging to a different user, even with the correct payment ID.
 */
export async function getMyInvoiceDownloadUrlAction(
  paymentId: string
): Promise<
  | { success: true; data: { url: string; expiresAt: Date } }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    // IDOR guard - fetch the invoice with BOTH paymentId and userId so a
    // crafted ID can't leak someone else's invoice link.
    const invoice = await prisma.gstInvoice.findFirst({
      where: {
        paymentId,
        userId: authUser.userId,
        status: "ISSUED",
      },
      select: { pdfStorageKey: true, invoiceNumber: true },
    });
    if (!invoice || !invoice.pdfStorageKey) {
      return {
        success: false,
        error: "No invoice available for this payment yet",
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

/**
 * Trigger domestic invoice generation for the current user's payment.
 * Returns idempotently - if an invoice already exists, it's used.
 *
 * v1 callsites: when the user clicks "Download invoice" but no invoice
 * exists yet (e.g. paid before they added their GST profile), this action
 * creates one. Render+upload happens synchronously here (small INR scale).
 */
export async function generateMyInvoiceForPaymentAction(
  paymentId: string
): Promise<
  | { success: true; data: { invoiceNumber: string } }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    // IDOR guard
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, userId: authUser.userId },
      select: { id: true },
    });
    if (!payment) {
      return { success: false, error: "Payment not found" };
    }
    const invoice = await gst.generateDomesticInvoiceForPayment({
      paymentId: payment.id,
      generatedBy: authUser.userId,
    });
    // Render + upload synchronously
    const finalised = await gst.finaliseInvoice(invoice.id);
    return {
      success: true,
      data: { invoiceNumber: finalised.invoiceNumber },
    };
  } catch (error) {
    if (error instanceof gst.GstProfileMissingError) {
      return {
        success: false,
        error: "Add your GST details in Settings before generating an invoice.",
      };
    }
    if (error instanceof gst.PaymentNotEligibleError) {
      return { success: false, error: error.message };
    }
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to generate invoice",
    };
  }
}
