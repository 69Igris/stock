"use client";

import { useState } from "react";
import { Loader2, Download, FileText } from "lucide-react";
import { toast } from "sonner";
import {
  getMyInvoiceDownloadUrlAction,
  generateMyInvoiceForPaymentAction,
} from "@/lib/actions/gst-profile";

/**
 * Per-payment row action: surface the GST invoice download link.
 *
 * Three states:
 *   1. Invoice exists → shows "GST Invoice" link → opens signed URL in new tab
 *   2. No invoice yet → shows "Generate" button → triggers domestic engine,
 *      then the link replaces it
 *   3. No GST profile → button still surfaces but the action returns an
 *      "Add your GST details" error which we toast with a /settings deeplink
 */
export function GstInvoiceLink({ paymentId }: { paymentId: string }) {
  const [generating, setGenerating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [hasInvoice, setHasInvoice] = useState<boolean | null>(null);

  // Lazy: only call download action on click. The "no invoice yet" message
  // becomes the trigger to call the generate action.
  const handleClick = async () => {
    setOpening(true);
    const downloadResult = await getMyInvoiceDownloadUrlAction(paymentId);
    setOpening(false);
    if (downloadResult.success) {
      setHasInvoice(true);
      window.open(downloadResult.data.url, "_blank", "noopener,noreferrer");
      return;
    }

    // No invoice yet - try generation.
    setHasInvoice(false);
    setGenerating(true);
    const generationResult = await generateMyInvoiceForPaymentAction(paymentId);
    setGenerating(false);
    if (!generationResult.success) {
      // Most common failure: missing GST profile. Direct user to settings.
      if (generationResult.error.toLowerCase().includes("gst details")) {
        toast.error(generationResult.error, {
          action: {
            label: "Add details",
            onClick: () => {
              window.location.hash = "tax";
            },
          },
        });
        return;
      }
      toast.error(generationResult.error);
      return;
    }
    // Generation succeeded - re-request the URL and open it
    const retry = await getMyInvoiceDownloadUrlAction(paymentId);
    if (retry.success) {
      setHasInvoice(true);
      window.open(retry.data.url, "_blank", "noopener,noreferrer");
      toast.success(`GST invoice ${generationResult.data.invoiceNumber} ready`);
    } else {
      toast.error(retry.error);
    }
  };

  const busy = opening || generating;
  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 underline disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : hasInvoice === false ? (
        <FileText className="h-3 w-3" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      {generating
        ? "Generating..."
        : opening
          ? "Opening..."
          : hasInvoice === false
            ? "Generate GST Invoice"
            : "GST Invoice"}
    </button>
  );
}
