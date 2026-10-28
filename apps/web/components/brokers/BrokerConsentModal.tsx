"use client";

/**
 * BrokerConsentModal — SEBI IA Reg 18(9) AI-advisory consent (MONEY-505).
 *
 * Shown before broker-connect: presents the AI-advisory disclosure (StockSage
 * is informational AI, not SEBI-registered advice, read-only) and records a
 * single-tap, version-stamped consent in the ConsentRecord ledger. Theme-aware
 * via the shared dialog primitives. Also re-presentable from Settings → Security
 * in `reviewOnly` mode (shows the disclosure without recording).
 */

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShieldCheck, Check } from "lucide-react";
import { AI_ADVISORY_DISCLOSURE } from "@/lib/consent/ai-advisory";
import { recordBrokerConsentAction } from "@/lib/actions/consent";

export default function BrokerConsentModal({
  open,
  onAccepted,
  onClose,
  source = "broker_connect",
  reviewOnly = false,
}: {
  open: boolean;
  onAccepted?: () => void;
  onClose?: () => void;
  source?: string;
  /** When true, no consent is recorded — just shows the disclosure (Settings). */
  reviewOnly?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleAccept = () => {
    if (reviewOnly) {
      onClose?.();
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await recordBrokerConsentAction(source);
      if (res.success) {
        onAccepted?.();
      } else {
        setError(res.error ?? "Could not record consent. Please try again.");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-lg">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck size={18} aria-hidden />
          </div>
          <div>
            <DialogTitle className="text-lg">
              {AI_ADVISORY_DISCLOSURE.heading}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              {reviewOnly
                ? "The AI-advisory disclosure you accepted."
                : "Please read this before connecting a broker."}
            </DialogDescription>
          </div>
        </div>

        <ul className="mt-4 space-y-2.5">
          {AI_ADVISORY_DISCLOSURE.points.map((point, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <Check
                size={15}
                className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
              <span className="text-foreground/90">{point}</span>
            </li>
          ))}
        </ul>

        {!reviewOnly && (
          <p className="mt-4 text-xs text-muted-foreground">
            {AI_ADVISORY_DISCLOSURE.ackLabel}. Your acceptance is recorded with
            a timestamp.
          </p>
        )}

        {error && (
          <p
            className="mt-3 text-sm text-red-600 dark:text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          {!reviewOnly && onClose && (
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleAccept}
            disabled={isPending}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {reviewOnly ? "Close" : isPending ? "Saving…" : "Agree & continue"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
