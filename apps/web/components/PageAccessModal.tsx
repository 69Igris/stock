"use client";

import { useRouter } from "next/navigation";
import type { PageRoute } from "@/lib/types/feature-flags";
import type { SubscriptionAccess } from "@/lib/subscription/access";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@usemoney/ui/dialog";
import { ShieldCheck, Crown, Sparkles, X, Check, Flame } from "lucide-react";
import { getPageAccessInfo } from "@/lib/utils/page-access";
import { useEffect, useState } from "react";
import { usePostHog } from "posthog-js/react";

interface PageAccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route: PageRoute | null;
  subscription: SubscriptionAccess | null;
  isDemoMode: boolean;
}

const PAGE_NAMES: Record<PageRoute, string> = {
  "/tradebook": "Tradebook",
  "/positions": "Positions",
  "/holdings": "Holdings",
  "/paper-trading": "Paper Trading",
  "/discover": "Discover",
  "/analysis": "Investment Analysis",
  "/sage-tutor": "StockSage Tutor",
  "/learning": "Learning",
  "/watchlist": "Watchlist",
  "/roast": "Roast Portfolio",
  "/risk": "Portfolio Risk",
  "/tax": "Tax Report",
  "/documents": "Documents",
  "/strategies": "Trading Strategies",
  "/quizzes": "Quizzes",
  "/discover/scans": "Scans",
};

// Per-page feature bullets for the upgrade card
const PAGE_FEATURES: Partial<Record<PageRoute, string[]>> = {
  "/strategies": [
    "Strategy builder + backtest (this feature)",
    "200 research credits / month",
    "Portfolio analysis with StockSage",
    "5 parallel L2 research runs",
  ],
  "/documents": [
    "Document Vault (this feature)",
    "AI document Q&A with RAG",
    "PDF / statement upload & extraction",
    "Tax-report generation",
  ],
  "/tax": [
    "Tax report (LTCG / STCG breakdown)",
    "Capital gains computation",
    "Harvesting recommendations",
    "ITR-2 Schedule export",
  ],
  "/risk": [
    "Risk analysis dashboard (this feature)",
    "Value at Risk (VaR) calculations",
    "Drawdown & correlation heatmaps",
    "Portfolio concentration metrics",
  ],
  "/roast": [
    "Portfolio roast (this feature)",
    "AI-powered scoring & grading",
    "Stock & MF quality evaluation",
    "Actionable improvement suggestions",
  ],
};

const DEFAULT_FEATURES = [
  "This feature (now unlocked)",
  "200 research credits / month",
  "Portfolio analysis with StockSage",
  "All premium pages & tools",
];

/**
 * PageAccessModal — playful v5 redesign (MONEY-484).
 *
 * Visual spec: screens.jsx §03 (PlanGatedModal).
 *   - Desktop: Dialog with hard 8px ink shadow, rotate(-0.5deg) tilt
 *   - Mobile: bottom-sheet with drag handle, rounded top corners
 *   - Coming-soon variant: sparkles icon, serif headline, "Got it" CTA centered
 *   - Upgrade variant: shield icon, gold plan card with inline checklist,
 *     "Go back" / "Upgrade to Premium →" footer
 *
 * All props + wiring (PostHog, getPageAccessInfo, showComingSoon/showUpgrade)
 * preserved verbatim from the previous implementation.
 */
export function PageAccessModal({
  open,
  onOpenChange,
  route,
  subscription,
  isDemoMode,
}: PageAccessModalProps) {
  const router = useRouter();
  const posthog = usePostHog();
  const [showComingSoon, setShowComingSoon] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);

  useEffect(() => {
    if (open && route) {
      getPageAccessInfo(route, false, isDemoMode).then((accessInfo) => {
        setShowComingSoon(accessInfo.showComingSoon);
        setShowUpgrade(accessInfo.showUpgrade);

        posthog?.capture("page_access_modal_viewed", {
          page: route,
          message_type: accessInfo.showComingSoon ? "coming_soon" : "upgrade",
          subscription_plan: subscription?.planId || "FREE",
          has_feature_access: accessInfo.showComingSoon,
        });
      });
    }
  }, [open, route, isDemoMode, posthog, subscription]);

  if (!route) return null;

  const pageName = PAGE_NAMES[route];
  const features = PAGE_FEATURES[route] ?? DEFAULT_FEATURES;
  const isComingSoon = showComingSoon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        /* Remove default DialogContent styles so we control everything */
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          /* Desktop: hard 8px shadow; mobile overridden below.
             No panel-level rotate() — tilting a text-bearing panel forces
             subpixel text re-rasterisation and blurs the modal copy. */
          boxShadow: "8px 8px 0 var(--ink)",
          color: "var(--ink)",
          padding: 0,
          overflow: "hidden",
          maxWidth: 460,
          width: "calc(100vw - 24px)",
          borderRadius: 18,
        }}
        /* Tailwind overrides for mobile bottom-sheet */
        className="pam-dialog"
      >
        {/* Fallback accessible name — the visible titles below live inside the
            coming-soon/upgrade branches, which are both absent during the
            brief async access-check before either flag resolves. Keeping an
            sr-only title here guarantees the content always has a name. */}
        <DialogTitle className="sr-only">
          {pageName ? `${pageName} access` : "Page access"}
        </DialogTitle>

        {/* Mobile drag handle (hidden on desktop via CSS below) */}
        <div className="pam-drag-handle" aria-hidden="true">
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 999,
              background: "var(--ink-3)",
              opacity: 0.4,
              margin: "8px auto 0",
            }}
          />
        </div>

        {/* Close button */}
        <button
          type="button"
          aria-label="Close"
          onClick={() => onOpenChange(false)}
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            width: 32,
            height: 32,
            borderRadius: 8,
            border: "1.5px solid var(--ink)",
            background: "var(--paper)",
            color: "var(--ink)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            zIndex: 10,
          }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>

        {/* ── COMING SOON variant ── */}
        {showComingSoon && (
          <>
            <div
              style={{
                padding: "30px 28px 20px",
                textAlign: "center",
              }}
            >
              {/* Icon tile */}
              <div
                className="pf-card tilt-l"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: "var(--pop-3)",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid var(--ink)",
                  boxShadow: "4px 4px 0 var(--ink)",
                  margin: "0 auto",
                }}
              >
                <Sparkles
                  style={{ width: 28, height: 28, color: "var(--paper)" }}
                />
              </div>

              {/* Pill */}
              <div style={{ marginTop: 14 }}>
                <div
                  className="pf-pill blue"
                  style={{ border: "1.5px solid var(--ink)" }}
                >
                  <Sparkles style={{ width: 10, height: 10 }} />
                  Coming soon
                </div>
              </div>

              <DialogHeader
                style={{ display: "block", textAlign: "center", marginTop: 14 }}
              >
                <DialogTitle
                  style={{
                    fontSize: 24,
                    fontWeight: 800,
                    letterSpacing: "-0.8px",
                    lineHeight: 1.15,
                    color: "var(--ink)",
                  }}
                >
                  {pageName} is on <span className="ser">its&nbsp;way.</span>
                </DialogTitle>
                <DialogDescription
                  style={{
                    marginTop: 10,
                    fontFamily: "Instrument Serif, serif",
                    fontStyle: "italic",
                    fontSize: 15.5,
                    color: "var(--ink-3)",
                    lineHeight: 1.45,
                  }}
                >
                  We&apos;re building this for you right now. Your subscription
                  includes it when it ships.
                </DialogDescription>
              </DialogHeader>
            </div>

            {/* Footer — centered "Got it" */}
            <div
              style={{
                padding: "14px 28px 22px",
                borderTop: "1.5px dashed var(--rule-soft)",
                background: "var(--paper-2)",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                className="pf-bs"
                style={{ padding: "10px 22px" }}
                onClick={() => onOpenChange(false)}
              >
                Got it
              </button>
            </div>
          </>
        )}

        {/* ── UPGRADE variant ── */}
        {showUpgrade && (
          <>
            <div style={{ padding: "30px 24px 6px", textAlign: "center" }}>
              {/* Icon tile */}
              <div
                className="pf-card tilt-l"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: "var(--pop-5)",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid var(--ink)",
                  boxShadow: "4px 4px 0 var(--ink)",
                  margin: "0 auto",
                }}
              >
                <ShieldCheck
                  style={{ width: 28, height: 28, color: "var(--paper)" }}
                />
              </div>

              {/* Pill */}
              <div style={{ marginTop: 14 }}>
                <div
                  className="pf-pill gold"
                  style={{ border: "1.5px solid var(--ink)" }}
                >
                  <Crown style={{ width: 10, height: 10, color: "#1d1d1b" }} />
                  Premium feature
                </div>
              </div>

              <DialogHeader
                style={{ display: "block", textAlign: "center", marginTop: 14 }}
              >
                <DialogTitle
                  style={{
                    fontSize: 23,
                    fontWeight: 800,
                    letterSpacing: "-0.8px",
                    lineHeight: 1.15,
                    color: "var(--ink)",
                  }}
                >
                  {pageName} needs <span className="ser">Premium.</span>
                </DialogTitle>
                <DialogDescription
                  style={{
                    marginTop: 8,
                    fontSize: 14.5,
                    color: "var(--ink-3)",
                    lineHeight: 1.45,
                    fontFamily: "Instrument Serif, serif",
                    fontStyle: "italic",
                  }}
                >
                  Unlock {pageName} and every Premium feature for ₹1,499/mo.
                </DialogDescription>
              </DialogHeader>

              {/* Gold plan card */}
              <div
                style={{
                  marginTop: 16,
                  marginBottom: 4,
                  padding: "14px 16px",
                  border: "2px solid var(--ink)",
                  borderRadius: 12,
                  background: "var(--pop-2)",
                  textAlign: "left",
                  position: "relative",
                }}
              >
                {/* Plan header */}
                <div style={{ marginBottom: 10 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1.3,
                      color: "#3a3a35",
                      textTransform: "uppercase",
                    }}
                  >
                    UPGRADE TO
                  </div>
                  <div
                    style={{
                      fontSize: 17,
                      fontWeight: 800,
                      color: "#1d1d1b",
                      marginTop: 2,
                    }}
                  >
                    Premium{" "}
                    <span
                      className="ser"
                      style={{ color: "#3a3a35", fontStyle: "italic" }}
                    >
                      · ₹1,499/mo
                    </span>
                  </div>
                </div>

                {/* Feature checklist */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 7,
                  }}
                >
                  {features.map((f, i) => (
                    <div
                      key={f}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 9,
                        fontSize: 12.5,
                        color: i === 0 ? "#1d1d1b" : "#3a3a35",
                        lineHeight: 1.4,
                      }}
                    >
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          border: "1.5px solid #1d1d1b",
                          background: i === 0 ? "#16a34a" : "#f7f3e6",
                          flexShrink: 0,
                          display: "grid",
                          placeItems: "center",
                          marginTop: 1,
                        }}
                      >
                        <Check
                          style={{
                            width: 9,
                            height: 9,
                            color: i === 0 ? "#f7f3e6" : "#1d1d1b",
                          }}
                        />
                      </div>
                      <span>{i === 0 ? <b>{f}</b> : f}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div
              style={{
                padding: "14px 24px 22px",
                borderTop: "1.5px dashed var(--rule-soft)",
                background: "var(--paper-2)",
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
              }}
            >
              <button
                type="button"
                style={{
                  background: "transparent",
                  color: "var(--ink-3)",
                  fontSize: 13,
                  fontWeight: 600,
                  border: 0,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                onClick={() => onOpenChange(false)}
              >
                ← Go back
              </button>
              <button
                type="button"
                className="pf-bs sm"
                onClick={() => {
                  posthog?.capture("upgrade_clicked_from_modal", {
                    page: route,
                    subscription_plan: subscription?.planId || "FREE",
                  });
                  onOpenChange(false);
                  router.push("/pricing");
                }}
              >
                <Crown
                  style={{ width: 11, height: 11, color: "var(--pop-2)" }}
                />
                Upgrade →
              </button>
            </div>
          </>
        )}
      </DialogContent>

      {/* Responsive overrides: mobile bottom-sheet */}
      <style>{`
        @media (max-width: 640px) {
          .pam-dialog {
            max-width: 100% !important;
            width: 100% !important;
            margin: 0 !important;
            border-radius: 20px 20px 0 0 !important;
            /* Hard shadow won't look right at bottom edge — soften on mobile */
            box-shadow: 0 -10px 40px rgba(0,0,0,.22) !important;
            transform: none !important;
            /* Anchor to bottom */
            position: fixed !important;
            bottom: 0 !important;
            top: auto !important;
            left: 0 !important;
            right: 0 !important;
            translate: none !important;
          }
          .pam-drag-handle {
            display: block !important;
          }
        }
        @media (min-width: 641px) {
          .pam-drag-handle {
            display: none !important;
          }
        }
      `}</style>
    </Dialog>
  );
}
