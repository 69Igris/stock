"use client";

import { Crown, Check, Download, Loader2 } from "lucide-react";
import { SetSection, SetRow } from "./primitives";
import type { SubscriptionData } from "@/lib/actions/subscription";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

interface PaymentHistoryItem {
  id: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  period: string;
  invoiceUrl: string | null;
  paymentMethod: string | null;
  paymentMethodType: string | null;
  cardLastFour: string | null;
  cardNetwork: string | null;
}

interface BillingTabProps {
  subscription: SubscriptionData | null;
  paymentHistory: PaymentHistoryItem[];
  isDemoMode: boolean;
  isLoadingPayments: boolean;
}

// Currency-aware money formatter. The billing page shows the ACTUAL charge, which
// may be INR (₹) or a foreign currency (e.g. USD $) when Dodo's adaptive pricing
// charged the customer in their local currency — so ₹ can't be hardcoded (BUG-2).
function formatMoney(amount: number, currency: string): string {
  const code = currency || "INR";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function BillingTab({
  subscription,
  paymentHistory,
  isDemoMode,
  isLoadingPayments,
}: BillingTabProps) {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const planId = subscription?.planId || "FREE";
  const isPaid = planId !== "FREE";
  // MONEY-866: the one-time "lifetime" PRO is deprecated. A PRO with a real
  // billing cycle (annual/monthly) is NOT lifetime — only legacy grandfathered
  // PROs (no recurring cycle) are. Without this a paid PRO-annual rendered as
  // "PRO · Lifetime · ₹999 one-time" despite the ₹1,999 annual charge.
  const isLifetime = planId === "PRO" && !subscription?.billingPeriod;
  const startDate = subscription?.startDate
    ? formatDate(String(subscription.startDate))
    : "—";
  const nextBilling = subscription?.nextBillingDate
    ? formatDate(String(subscription.nextBillingDate))
    : null;
  // Scheduled cancel/downgrade-to-FREE: the term won't renew — show when it
  // ENDS instead of a misleading "Auto-renews" (no-refund policy, MONEY-482).
  const cancelScheduled = subscription?.scheduledPlanId === "FREE";
  const endsOn = formatDate(
    subscription?.scheduledEffectiveAt
      ? String(subscription.scheduledEffectiveAt)
      : subscription?.nextBillingDate
        ? String(subscription.nextBillingDate)
        : null
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Plan hero — sticker card (gold in light, terminal band in dark;
          MONEY-764 theme-aware --sticker-* tokens). */}
      <div
        className="pf-card"
        style={{
          padding: 26,
          background: "var(--sticker-bg)",
          color: "var(--sticker-fg)",
          boxShadow: "var(--shadow-hard)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 8,
                flexWrap: "wrap",
              }}
            >
              {/* Pills use sticker tokens, not var(--ink)/var(--pop-2) — the
                  gold band is PINNED in dark mode, where --ink flips to cream
                  and would invert the pill treatment. */}
              <span
                className="pf-pill"
                style={{
                  background: "var(--sticker-fg)",
                  color: "var(--sticker-bg)",
                  borderColor: "var(--sticker-fg)",
                }}
              >
                <Crown className="h-3 w-3" />
                {planId} {isLifetime ? "· Lifetime" : ""}
              </span>
              {isPaid && (
                <span
                  className="pf-pill"
                  style={{
                    background: "transparent",
                    color: "var(--sticker-fg)",
                    borderColor: "var(--sticker-fg)",
                  }}
                >
                  {subscription?.status || "ACTIVE"}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 800,
                letterSpacing: -0.6,
                color: "var(--sticker-fg)",
              }}
            >
              UseMoney {planId}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--sticker-dim)",
                marginTop: 4,
              }}
            >
              {isLifetime
                ? `One-time ₹999 · paid ${startDate} · unlimited lifetime access.`
                : isPaid
                  ? `Subscribed ${startDate} · ${
                      cancelScheduled
                        ? `ends ${endsOn}`
                        : nextBilling
                          ? `renews ${nextBilling}`
                          : "active"
                    }`
                  : "Free tier · limited features"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--sticker-dim)",
                letterSpacing: 1,
                fontWeight: 700,
              }}
            >
              {isLifetime ? "NEXT BILL" : cancelScheduled ? "ENDS" : "RENEWS"}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 16,
                color: "var(--sticker-fg)",
                marginTop: 4,
                fontWeight: 700,
              }}
            >
              {isLifetime ? "—" : cancelScheduled ? endsOn : nextBilling || "—"}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--sticker-dim)",
                marginTop: 2,
              }}
            >
              {isLifetime
                ? "Lifetime · no recurring"
                : cancelScheduled
                  ? "Cancels at period end"
                  : "Auto-renews"}
            </div>
          </div>
        </div>

        {/* Stats grid - plan credits + (when present) pack credits balance. */}
        {isPaid &&
          (() => {
            const packLimit = subscription?.packCreditsLimit ?? 0;
            const packUsed = subscription?.packCreditsUsed ?? 0;
            const packRemaining = Math.max(0, packLimit - packUsed);
            const cells: Array<[string, string]> = [
              ["Brokers", "Unlimited"],
              [
                "Credits",
                subscription?.creditsLimit
                  ? `${subscription.creditsLimit}/mo`
                  : "Unlimited",
              ],
            ];
            if (packLimit > 0) {
              cells.push([
                "Pack credits",
                `${packRemaining} left · ${packLimit} total`,
              ]);
            } else if (paperTradingEnabled) {
              cells.push(["Paper balance", "₹10.5 L"]);
            }
            const gridCols = cells.length === 2 ? "grid-cols-2" : "grid-cols-3";
            return (
              <div
                className={`grid ${gridCols} gap-2.5`}
                style={{ marginTop: 18 }}
              >
                {cells.map(([k, v]) => (
                  <div
                    key={k}
                    className="mono"
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      background: "var(--sticker-tile-bg)",
                      border: "1.5px solid var(--sticker-tile-border)",
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        color: "var(--sticker-dim)",
                        fontSize: 9.5,
                        letterSpacing: 1.2,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {k}
                    </div>
                    <div
                      style={{
                        color: "var(--sticker-fg)",
                        fontSize: 14,
                        fontWeight: 700,
                        marginTop: 4,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
      </div>

      {/* Invoices */}
      <SetSection
        title="Invoices"
        desc={
          paymentHistory.length > 0
            ? `Last ${paymentHistory.length} ${paymentHistory.length === 1 ? "payment" : "payments"}. Tap to download PDF.`
            : "No invoices yet."
        }
      >
        {isLoadingPayments ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px 0",
              color: "var(--ink-3)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
            }}
          >
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading...
          </div>
        ) : paymentHistory.length === 0 ? (
          <div
            style={{
              padding: "32px 22px",
              textAlign: "center",
              fontSize: 13,
              color: "var(--ink-3)",
            }}
          >
            {isPaid
              ? "Your payment history will appear here."
              : "Upgrade to see your invoices here."}
          </div>
        ) : (
          paymentHistory.map((p, i, arr) => {
            const last = i === arr.length - 1;
            const ok = p.status === "COMPLETED";
            const failed = p.status === "FAILED";
            return (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 22px",
                  borderBottom: last ? 0 : "1px dashed var(--rule-soft)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--ink)",
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.planName}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      marginTop: 3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatDate(p.paidAt || p.createdAt)} · {p.id.slice(-8)}
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 14,
                    color: "var(--ink)",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatMoney(p.amount, p.currency)}
                </div>
                <span
                  className={`pf-pill${ok ? " emerald" : ""}`}
                  style={
                    ok
                      ? { fontSize: 10 }
                      : failed
                        ? {
                            fontSize: 10,
                            background: "rgba(185,28,28,0.1)",
                            color: "#b91c1c",
                            borderColor: "#b91c1c",
                          }
                        : {
                            fontSize: 10,
                            background: "rgba(245,158,11,0.12)",
                            color: "#b45309",
                            borderColor: "#b45309",
                          }
                  }
                >
                  {ok && <Check className="h-2.5 w-2.5" />}
                  {ok ? "Paid" : failed ? "Failed" : "Pending"}
                </span>
                {/* Download icon — always rendered for visual consistency.
                    Disabled state when no invoiceUrl exists. */}
                {p.invoiceUrl ? (
                  <a
                    href={p.invoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pf-tb-icon-btn"
                    style={{ width: 30, height: 30 }}
                    title="Download invoice"
                  >
                    <Download className="h-3 w-3" />
                  </a>
                ) : (
                  <button
                    disabled
                    title="Invoice not available"
                    className="pf-tb-icon-btn"
                    style={{
                      width: 30,
                      height: 30,
                      opacity: 0.4,
                      cursor: "not-allowed",
                    }}
                  >
                    <Download className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </SetSection>

      {/* Danger zone */}
      <SetSection
        title="Danger zone"
        desc={
          isLifetime
            ? "Cancellation is irreversible. PRO is lifetime — there is no recurring charge to cancel."
            : isPaid
              ? "Cancellation takes effect at the end of your billing period."
              : "You're on the Free tier. No active subscription to manage."
        }
      >
        <SetRow
          label="Downgrade to Free"
          hint={
            isPaid
              ? paperTradingEnabled
                ? "You'll lose unlimited brokers, paper trading and StockSage access."
                : "You'll lose unlimited brokers and StockSage access."
              : "Already on Free tier."
          }
          onClick={() => {}}
          locked={isDemoMode || !isPaid}
          last
        />
        {/* MONEY-482: no-refund policy — the "Request refund" row was
            removed. When the user cancels or downgrades, their current
            term is honored until expiry and no money is returned. */}
      </SetSection>
    </div>
  );
}
