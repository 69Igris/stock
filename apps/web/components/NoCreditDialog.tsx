"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Zap, CreditCard, Crown } from "lucide-react";
import Link from "next/link";

interface NoCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "free" = no plan, "no_credits" = has plan but credits exhausted */
  reason: "free" | "no_credits";
}

export function NoCreditDialog({
  open,
  onOpenChange,
  reason,
}: NoCreditDialogProps) {
  const isNoCredits = reason === "no_credits";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
          color: "var(--ink)",
          maxWidth: 480,
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
              width: 36,
              height: 36,
              borderRadius: 9,
              background: isNoCredits ? "var(--pop-2)" : "var(--emerald)",
              color: isNoCredits ? "#1d1d1b" : "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            {isNoCredits ? (
              <CreditCard style={{ width: 16, height: 16 }} />
            ) : (
              <Zap style={{ width: 16, height: 16 }} />
            )}
          </div>
          <div>
            <AlertDialogTitle
              style={{
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: "-0.3px",
                color: "var(--ink)",
              }}
            >
              {isNoCredits ? "No Credits Remaining" : "Upgrade Required"}
            </AlertDialogTitle>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--ink-3)",
                marginTop: 1,
                letterSpacing: "1px",
              }}
            >
              {isNoCredits
                ? "PACK EXHAUSTED · NEVER EXPIRES"
                : "SAGE AI · SUBSCRIPTION REQUIRED"}
            </div>
          </div>
        </div>

        <div style={{ padding: 22 }}>
          <AlertDialogHeader>
            <AlertDialogDescription
              className="ser"
              style={{
                fontSize: 15.5,
                color: "var(--ink-2)",
                lineHeight: 1.45,
              }}
            >
              {isNoCredits ? (
                <>
                  You&apos;ve used all your AI query credits for this period.
                  Purchase a credit pack for additional credits — they{" "}
                  <strong
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontStyle: "normal",
                      color: "var(--ink)",
                    }}
                  >
                    never expire
                  </strong>{" "}
                  and carry forward.
                </>
              ) : (
                <>
                  AI Analysis requires a Pro or Premium plan. Upgrade to unlock
                  AI-powered stock analysis, portfolio insights, and research
                  tools.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Highlight card */}
          {!isNoCredits && (
            <div
              style={{
                marginTop: 16,
                padding: 14,
                background: "var(--pop-2)",
                border: "2px solid var(--ink)",
                borderRadius: 12,
                boxShadow: "var(--shadow-soft)",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: "1px",
                  color: "#3a3a35",
                }}
              >
                UPGRADE TO PRO
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: "#1d1d1b",
                  marginTop: 4,
                }}
              >
                50 credits/mo{" "}
                <span className="ser" style={{ color: "#3a3a35" }}>
                  · all brokers · AI research
                </span>
              </div>
            </div>
          )}

          {isNoCredits && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: "var(--rule-softer)",
                borderRadius: 9,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11.5,
                color: "var(--ink-3)",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>Credits never expire · carry forward each month</span>
              <Crown
                style={{ width: 14, height: 14, color: "var(--pop-5-text)" }}
              />
            </div>
          )}
        </div>

        <AlertDialogFooter
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            margin: 0,
          }}
        >
          <AlertDialogCancel className="pf-bf sm mt-0">Close</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Link
              href={isNoCredits ? "/settings?tab=subscription" : "/pricing"}
              className="pf-bs sm"
            >
              {isNoCredits ? "Buy Credit Pack →" : "View Plans →"}
            </Link>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
