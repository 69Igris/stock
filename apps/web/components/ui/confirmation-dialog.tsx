"use client";

/**
 * ConfirmationDialog — playful re-skin (MONEY-484).
 *
 * Paper bg + 2px ink border + hard (6px) offset shadow.
 * Rotated danger icon for destructive variant.
 * Design source: DeleteAccountDialog in dialogs.jsx.
 * API is fully preserved: open, onOpenChange, title, description,
 * confirmLabel, cancelLabel, onConfirm, variant.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@usemoney/ui/alert-dialog";
import { AlertTriangle } from "lucide-react";

interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  variant?: "default" | "destructive";
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  variant = "default",
}: ConfirmationDialogProps) {
  const isDestructive = variant === "destructive";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "6px 6px 0 var(--ink)",
          color: "var(--ink)",
          padding: 22,
          maxWidth: 460,
          width: "92%",
        }}
      >
        <AlertDialogHeader>
          {/* Destructive: rotated alert icon above the title */}
          {isDestructive && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 6,
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: "rgba(185,28,28,0.1)",
                  color: "#b91c1c",
                  display: "grid",
                  placeItems: "center",
                  border: "1.5px solid #b91c1c",
                  transform: "rotate(-3deg)",
                  flexShrink: 0,
                }}
              >
                <AlertTriangle size={18} />
              </div>
              <AlertDialogTitle
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  letterSpacing: "-0.4px",
                  color: "#b91c1c",
                }}
              >
                {title}
              </AlertDialogTitle>
            </div>
          )}

          {/* Default: plain title */}
          {!isDestructive && (
            <AlertDialogTitle
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "var(--ink)",
              }}
            >
              {title}
            </AlertDialogTitle>
          )}

          <AlertDialogDescription
            className="ser"
            style={{
              fontSize: 16,
              color: "var(--ink-2)",
              lineHeight: 1.4,
              marginTop: isDestructive ? 8 : 4,
            }}
          >
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter
          style={{
            marginTop: 20,
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            borderTop: "1.5px dashed var(--rule-soft)",
            paddingTop: 14,
          }}
        >
          <AlertDialogCancel className="pf-bf sm mt-0">
            {cancelLabel}
          </AlertDialogCancel>

          <AlertDialogAction
            onClick={onConfirm}
            className="pf-bs sm"
            style={
              isDestructive
                ? { background: "#b91c1c", borderColor: "#b91c1c" }
                : undefined
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
