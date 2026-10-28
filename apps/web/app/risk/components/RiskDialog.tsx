"use client";

/**
 * Risk v2 (MONEY-485) — playful modal dialog.
 *
 * Used for the design's flow dialogs (rebalance confirm, pre-trade check,
 * RTQ wizard). Theme-aware backdrop + offset-shadow card. Closes on
 * backdrop click or Escape.
 */

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export default function RiskDialog({
  open,
  onClose,
  eyebrow,
  title,
  children,
  footer,
  maxWidth = 560,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center p-4"
      style={{ background: "rgba(29,29,27,0.55)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="pf-card w-full overflow-hidden"
        style={{ maxWidth, padding: 0, boxShadow: "var(--shadow-hard)" }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between gap-3"
          style={{ padding: "16px 18px", borderBottom: "2px solid var(--ink)" }}
        >
          <div>
            <div
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1.2,
                color: "var(--emerald-text)",
              }}
            >
              {eyebrow}
            </div>
            <div className="text-[16px] font-extrabold tracking-[-0.4px] text-[var(--ink)] mt-0.5">
              {title}
            </div>
          </div>
          <button
            onClick={onClose}
            className="pf-tb-icon-btn"
            style={{ width: 32, height: 32 }}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div style={{ padding: 18 }}>{children}</div>

        {footer && (
          <div
            className="flex items-center justify-end gap-2"
            style={{
              padding: "14px 18px",
              borderTop: "1.5px dashed var(--rule-soft)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
