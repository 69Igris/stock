"use client";

/**
 * PlanChangeConfirmDialog — playful re-skin (MONEY-484).
 *
 * All logic (copyFor, formatDate, PlanChangeKind, PlanChangePreviewData)
 * is preserved verbatim — only the JSX chrome is restyled with pf-* tokens.
 *
 * Six variants of copy (first_purchase, cycle_append, cycle_downgrade,
 * tier_upgrade, tier_downgrade, cancel) are all handled identically to
 * before; destructive variants get the coral "No refund" sticker and the
 * danger button treatment.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@usemoney/ui/dialog";
import { Loader2, Crown, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

export type PlanChangeKind =
  | "noop"
  | "first_purchase"
  | "cycle_append"
  | "cycle_downgrade"
  | "tier_upgrade"
  | "tier_downgrade"
  | "cancel";

export interface PlanChangePreviewData {
  kind: PlanChangeKind;
  daysRemaining?: number;
  bonusDays?: number;
  newTermDays?: number;
  /** ISO string; only set for scheduled variants. */
  effectiveAt?: string | null;
  willChargeToday?: boolean;
}

export interface PlanChangeConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Human-readable label for the user's current plan, e.g. "PRO Monthly". */
  fromLabel: string;
  /** Human-readable label for the target plan, e.g. "Premium Annual". */
  toLabel: string;
  /** Preview computed by the server `previewPlanChangeAction`. */
  preview: PlanChangePreviewData | null;
  /** True while the confirm callback is in flight. */
  busy?: boolean;
  /** Called when the user clicks Confirm. */
  onConfirm: () => void;
  /** MONEY-865: optional coupon UI, rendered only for upgrade variants. */
  couponSlot?: ReactNode;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

interface DialogCopy {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
}

function copyFor(
  kind: PlanChangeKind,
  from: string,
  to: string,
  p: PlanChangePreviewData | null
): DialogCopy {
  const effective = formatDate(p?.effectiveAt);
  const bonus = p?.bonusDays ?? 0;
  const total = p?.newTermDays ?? 0;
  const remaining = p?.daysRemaining ?? 0;

  switch (kind) {
    case "first_purchase":
      return {
        title: `Subscribe to ${to}`,
        body: `You'll be charged today and your plan activates immediately. Standard term: ${total} days.`,
        confirmLabel: "Continue to payment",
      };
    case "cycle_append":
      return {
        title: `Switch to ${to}`,
        body:
          bonus > 0
            ? `Your ${remaining} remaining monthly days will be added to the annual term — ${total} days in total. You'll be charged the annual price today.`
            : `Annual term begins today and runs for ${total} days. You'll be charged the annual price today.`,
        confirmLabel: "Continue to payment",
      };
    case "tier_upgrade":
      return {
        title: `Upgrade to ${to}`,
        body:
          bonus > 0
            ? `Your ${remaining} remaining days on ${from} convert to ${bonus} bonus day${bonus === 1 ? "" : "s"} on ${to}. New term: ${total} days. You'll be charged today.`
            : `${to} activates immediately. New term: ${total} days. You'll be charged today.`,
        confirmLabel: "Continue to payment",
      };
    case "cycle_downgrade":
      return {
        title: `Schedule switch to ${to}`,
        body: `Your current annual term continues until ${effective}. On that date, your billing cycle will switch to monthly. No refund is issued for unused annual time — you keep all features until then.`,
        confirmLabel: "Schedule switch",
        destructive: true,
      };
    case "tier_downgrade":
      return {
        title: `Schedule downgrade to ${to}`,
        body: `Your current ${from} plan stays active until ${effective}. On that date, you'll move to ${to}. No refund for unused time — your paid features are honored through the full term.`,
        confirmLabel: "Schedule downgrade",
        destructive: true,
      };
    case "cancel":
      return {
        title: "Cancel subscription",
        body: `Your ${from} plan stays active until ${effective}. After that date, you'll be on the Free plan. No refund is issued — you keep all paid features through your current term.`,
        confirmLabel: "Confirm cancel",
        destructive: true,
      };
    case "noop":
    default:
      return {
        title: "Nothing to change",
        body: "You're already on this plan and cycle.",
        confirmLabel: "Close",
      };
  }
}

export default function PlanChangeConfirmDialog({
  open,
  onOpenChange,
  fromLabel,
  toLabel,
  preview,
  busy = false,
  onConfirm,
  couponSlot,
}: PlanChangeConfirmDialogProps) {
  const kind = preview?.kind ?? "noop";
  const copy = copyFor(kind, fromLabel, toLabel, preview);
  const isScheduled =
    kind === "cancel" ||
    kind === "tier_downgrade" ||
    kind === "cycle_downgrade";
  const isUpgrade =
    kind === "first_purchase" ||
    kind === "cycle_append" ||
    kind === "tier_upgrade";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[480px]"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
          color: "var(--ink)",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* Header band */}
        <div
          style={{
            padding: "16px 22px",
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 9,
              background: isUpgrade
                ? "var(--pop-5)"
                : isScheduled
                  ? "var(--pop-1)"
                  : "var(--ink)",
              color: isUpgrade
                ? "var(--paper)"
                : isScheduled
                  ? "var(--paper)"
                  : "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <Crown style={{ width: 18, height: 18 }} />
          </div>
          <div>
            <DialogHeader className="p-0 m-0 text-left">
              <div
                className="mono"
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: "var(--ink-3)",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  marginBottom: 3,
                }}
              >
                CHANGE PLAN · {isScheduled ? "SCHEDULED" : "PRORATED"}
              </div>
              <DialogTitle
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  letterSpacing: "-0.4px",
                  color: "var(--ink)",
                  lineHeight: 1.2,
                }}
              >
                {copy.title}
              </DialogTitle>
            </DialogHeader>
          </div>
        </div>

        <div style={{ padding: 22 }}>
          {/* From → To comparison */}
          {kind !== "noop" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                gap: 8,
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              {/* From card */}
              <div
                style={{
                  padding: 12,
                  border: "1.5px solid var(--rule-soft)",
                  borderRadius: 10,
                  background: "var(--paper-2)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    letterSpacing: "1px",
                    textTransform: "uppercase",
                  }}
                >
                  FROM
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 16,
                    fontWeight: 800,
                    color: "var(--ink-3)",
                    marginTop: 4,
                    textDecoration: isUpgrade ? "line-through" : "none",
                  }}
                >
                  {fromLabel}
                </div>
              </div>

              <ArrowRight
                style={{ width: 20, height: 20, color: "var(--ink-3)" }}
              />

              {/* To card */}
              <div
                style={{
                  padding: 12,
                  border: "2px solid var(--ink)",
                  borderRadius: 10,
                  background: isScheduled
                    ? "rgba(185,28,28,0.06)"
                    : "var(--pop-5)",
                  color: isScheduled ? "var(--ink)" : "var(--paper)",
                  boxShadow: "3px 3px 0 var(--ink)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: isScheduled
                      ? "var(--ink-3)"
                      : "rgba(255,255,255,0.7)",
                    letterSpacing: "1px",
                    textTransform: "uppercase",
                  }}
                >
                  TO
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 16, fontWeight: 800, marginTop: 4 }}
                >
                  {toLabel}
                </div>
              </div>
            </div>
          )}

          {/* Body copy */}
          <DialogDescription
            className="ser"
            style={{
              fontSize: 15.5,
              lineHeight: 1.45,
              color: "var(--ink-2)",
            }}
          >
            {copy.body}
          </DialogDescription>

          {/* MONEY-865: coupon entry (upgrade variants only) */}
          {isUpgrade && couponSlot ? (
            <div style={{ marginTop: 14 }}>{couponSlot}</div>
          ) : null}

          {/* No-refund sticker for scheduled/cancel variants */}
          {isScheduled && (
            <div
              className="mono"
              style={{
                marginTop: 14,
                background: "var(--pop-2)",
                border: "2px solid var(--ink)",
                borderRadius: 10,
                boxShadow: "var(--shadow-soft)",
                padding: "10px 14px",
                fontSize: 12,
                lineHeight: 1.5,
                color: "#1d1d1b",
                fontWeight: 700,
              }}
            >
              No refund. Your current term is honored to its expiry date.
            </div>
          )}
        </div>

        <DialogFooter
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            background: "var(--paper-2)",
            margin: 0,
          }}
        >
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="pf-bf sm disabled:opacity-50"
          >
            {kind === "noop" ? "Close" : "Cancel"}
          </button>
          {kind !== "noop" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className={`sm disabled:opacity-50 ${copy.destructive ? "pf-bf danger" : "pf-bs"}`}
            >
              {busy ? (
                <>
                  <Loader2
                    style={{
                      width: 14,
                      height: 14,
                      animation: "spin 1s linear infinite",
                    }}
                  />
                  Processing…
                </>
              ) : (
                copy.confirmLabel
              )}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
