"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@usemoney/ui/dialog";
import { Zap, Loader2, CreditCard, Wallet, Building2 } from "lucide-react";
import { CREDIT_PACKS } from "@usemoney/core/subscription/plans";
import { toast } from "sonner";
import { createCheckoutAction } from "@/lib/actions/subscription";

interface PurchaseCreditsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Payment method config for the bottom row */
const PAY_METHODS = [
  {
    id: "upi",
    label: "UPI",
    Icon: Zap,
    color: "var(--emerald-text)",
    activeBg: "var(--emerald-bg)",
    activeBorder: "var(--emerald)",
  },
  {
    id: "card",
    label: "Card",
    Icon: CreditCard,
    color: "var(--pop-3-text)",
    activeBg: "rgba(59,130,246,0.08)",
    activeBorder: "var(--pop-3)",
  },
  {
    id: "netbanking",
    label: "Netbanking",
    Icon: Building2,
    color: "var(--pop-5-text)",
    activeBg: "rgba(167,139,250,0.08)",
    activeBorder: "var(--pop-5)",
  },
  {
    id: "wallet",
    label: "Wallet",
    Icon: Wallet,
    color: "var(--pop-1-text)",
    activeBg: "rgba(255,107,53,0.08)",
    activeBorder: "var(--pop-1)",
  },
] as const;

/**
 * Purchase Credits Modal — playful redesign (MONEY-484).
 *
 * 6-pack grid (5 packs from CREDIT_PACKS + Custom row) + payment methods,
 * wired to the real createCheckoutAction. Identical API to the previous
 * component; only the visual chrome changes.
 */
export function PurchaseCreditsModal({
  open,
  onOpenChange,
}: PurchaseCreditsModalProps) {
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [activeMethod, setActiveMethod] = useState<string>("upi");
  const [hoveredPack, setHoveredPack] = useState<string | null>(null);

  const handlePurchase = async (packId: string) => {
    setIsPurchasing(true);
    setSelectedPack(packId);

    try {
      const result = await createCheckoutAction("QUERY_PACK");

      if (result?.success && result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      } else {
        toast.error(result?.error || "Failed to create checkout session");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsPurchasing(false);
      setSelectedPack(null);
    }
  };

  // The "active" pack for the summary row: hover takes priority, then
  // the selected/purchasing one, then the popular 100-credit pack.
  const focusedPackId = hoveredPack ?? selectedPack ?? "pack_100";
  const focusedPack =
    CREDIT_PACKS.find((p) => p.id === focusedPackId) ?? CREDIT_PACKS[1];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
          color: "var(--ink)",
          padding: 0,
          overflow: "hidden",
          maxWidth: 560,
          width: "calc(100vw - 24px)",
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
              width: 36,
              height: 36,
              borderRadius: 9,
              background: "var(--emerald)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <Zap style={{ width: 17, height: 17 }} />
          </div>
          <div>
            <DialogHeader className="p-0 m-0 text-left">
              <DialogTitle
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  letterSpacing: "-0.3px",
                  color: "var(--ink)",
                }}
              >
                Buy a credit pack
              </DialogTitle>
              <DialogDescription
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginTop: 1,
                  letterSpacing: "0.5px",
                }}
              >
                NEVER EXPIRES · CARRIES FORWARD · USE ANY TIME
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>

        <div style={{ padding: 22 }}>
          {/* 3-column pack grid: 5 real packs + 1 "Custom" slot */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 10,
            }}
          >
            {CREDIT_PACKS.map((pack) => {
              const isPopular = pack.id === "pack_100";
              const isBestValue = pack.id === "pack_1000";
              const isActive = selectedPack === pack.id && isPurchasing;

              return (
                <button
                  key={pack.id}
                  disabled={isPurchasing}
                  onClick={() => handlePurchase(pack.id)}
                  onMouseEnter={() => setHoveredPack(pack.id)}
                  onMouseLeave={() => setHoveredPack(null)}
                  style={{
                    position: "relative",
                    padding: 14,
                    borderRadius: 11,
                    border: isPopular
                      ? "2.5px solid var(--ink)"
                      : "1.5px solid var(--ink)",
                    background: isPopular
                      ? "var(--pop-2)"
                      : isBestValue
                        ? "var(--emerald-bg)"
                        : "var(--paper)",
                    boxShadow: isPopular ? "3px 3px 0 var(--ink)" : "none",
                    cursor: isPurchasing ? "wait" : "pointer",
                    textAlign: "left",
                    opacity: isPurchasing && !isActive ? 0.6 : 1,
                    transition: "transform 0.12s, box-shadow 0.12s",
                  }}
                >
                  {isPopular && (
                    <span
                      style={{
                        position: "absolute",
                        top: -8,
                        right: 8,
                        padding: "2px 8px",
                        background: "var(--ink)",
                        color: "var(--pop-2)",
                        borderRadius: 99,
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 9,
                        fontWeight: 800,
                      }}
                    >
                      ★ POPULAR
                    </span>
                  )}
                  {isBestValue && (
                    <span
                      style={{
                        position: "absolute",
                        top: -8,
                        right: 8,
                        padding: "2px 8px",
                        background: "var(--emerald)",
                        color: "var(--paper)",
                        borderRadius: 99,
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 9,
                        fontWeight: 800,
                      }}
                    >
                      BEST VALUE
                    </span>
                  )}

                  <div
                    className="mono"
                    style={{
                      fontSize: 22,
                      fontWeight: 800,
                      letterSpacing: "-0.5px",
                      color: isPopular ? "#1d1d1b" : "var(--ink)",
                    }}
                  >
                    {isActive ? (
                      <Loader2
                        style={{
                          width: 20,
                          height: 20,
                          animation: "spin 1s linear infinite",
                          display: "inline-block",
                        }}
                      />
                    ) : (
                      `${pack.credits} cr`
                    )}
                  </div>
                  <div
                    className="mono"
                    style={{
                      marginTop: 6,
                      fontSize: 13,
                      fontWeight: 700,
                      color: isPopular ? "#1d1d1b" : "var(--ink)",
                    }}
                  >
                    ₹{pack.price.toLocaleString("en-IN")}
                  </div>
                  <div
                    className="mono"
                    style={{
                      marginTop: 2,
                      fontSize: 10.5,
                      color: isPopular ? "#3a3a35" : "var(--ink-3)",
                    }}
                  >
                    ₹{pack.perCredit} / credit
                  </div>
                </button>
              );
            })}

            {/* Custom / contact slot */}
            <button
              disabled={isPurchasing}
              onClick={() => {
                toast("Contact us for a custom pack", {
                  description: "Reach us at hello@usemoney.ai",
                });
              }}
              style={{
                padding: 14,
                borderRadius: 11,
                border: "1.5px dashed var(--ink)",
                background: "var(--paper)",
                cursor: "pointer",
                textAlign: "left",
                opacity: isPurchasing ? 0.6 : 1,
              }}
            >
              <div
                className="mono"
                style={{ fontSize: 22, fontWeight: 800, color: "var(--ink)" }}
              >
                Custom
              </div>
              <div
                style={{ marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}
                className="ser"
              >
                Pick any amount
              </div>
            </button>
          </div>

          {/* Selection summary */}
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "var(--rule-softer)",
              borderRadius: 9,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              <strong>{focusedPack.credits} credits</strong> · ~
              {Math.floor(focusedPack.credits / 3)} quick research /{" "}
              {Math.floor(focusedPack.credits / 10)} deep dives.
            </div>
            <div
              className="mono"
              style={{
                fontSize: 18,
                fontWeight: 800,
                color: "var(--emerald-text)",
              }}
            >
              ₹{focusedPack.price.toLocaleString("en-IN")}
            </div>
          </div>

          {/* Payment method picker */}
          <div
            className="mono"
            style={{
              marginTop: 16,
              fontSize: 11,
              fontWeight: 700,
              color: "var(--ink-3)",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            PAY VIA
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 8,
            }}
          >
            {PAY_METHODS.map((m) => {
              const active = activeMethod === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setActiveMethod(m.id)}
                  style={{
                    padding: "10px 6px",
                    borderRadius: 8,
                    border: `1.5px solid ${active ? m.activeBorder : "var(--ink)"}`,
                    background: active ? m.activeBg : "var(--paper)",
                    color: active ? m.color : "var(--ink)",
                    fontWeight: 700,
                    fontSize: 12.5,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                >
                  <m.Icon style={{ width: 14, height: 14 }} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            background: "var(--paper-2)",
          }}
        >
          <button
            type="button"
            className="pf-bf sm"
            disabled={isPurchasing}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pf-bs sm"
            disabled={isPurchasing}
            onClick={() => handlePurchase(focusedPack.id)}
          >
            {isPurchasing ? (
              <Loader2
                style={{
                  width: 13,
                  height: 13,
                  animation: "spin 1s linear infinite",
                }}
              />
            ) : (
              <CreditCard style={{ width: 13, height: 13 }} />
            )}
            Pay ₹{focusedPack.price.toLocaleString("en-IN")} ·{" "}
            {focusedPack.credits} credits →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
