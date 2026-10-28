"use client";

import {
  Brain,
  Activity,
  BarChart3,
  Crown,
  Sparkles,
  Shield,
  Check,
  ArrowRight,
  Flame,
} from "lucide-react";
import Link from "next/link";
import { resolveUpgradeCopy } from "./upgrade-prompt-logic";

/**
 * UpgradePrompt — playful v5 full-page redesign (MONEY-484).
 *
 * Visual spec: screens.jsx §02 (PlanGatedScreen).
 *   - Two-column layout on desktop (pitch left, plan card right); stacks on mobile
 *   - Strikethrough "behind the velvet rope" headline
 *   - Plan card (pf-card) with washi-tape accent; card itself is un-rotated
 *     (text stays crisp) while the dashed frame + tape keep the playful tilt
 *   - ₹249/mo price for PRO, ₹1,499/mo for Premium
 *   - Feature checklist (first item filled emerald)
 *   - Trust strip below CTAs
 *
 * Plan-keyed copy + price live in ./upgrade-prompt-logic.ts (also unit-tested).
 * Props preserved verbatim from previous version.
 */

interface FeatureCard {
  icon: typeof Brain;
  label: string;
  blurb: string;
}

const PLAN_PREVIEWS: Record<string, FeatureCard[]> = {
  PRO: [
    { icon: Brain, label: "AI Research", blurb: "Deep + Comprehensive" },
    { icon: Activity, label: "Unlimited Sync", blurb: "All Brokers" },
    { icon: BarChart3, label: "50 Credits/mo", blurb: "StockSage AI" },
  ],
  PREMIUM: [
    { icon: Brain, label: "200 Credits/mo", blurb: "StockSage AI" },
    { icon: Activity, label: "AI Strategies", blurb: "Build + Backtest" },
    { icon: BarChart3, label: "Doc Vault + Tax", blurb: "Power tools" },
  ],
};

interface UpgradePromptProps {
  pageName: string;
  requiredPlan: string;
  currentPlan?: string;
}

export function UpgradePrompt({
  pageName,
  requiredPlan,
  currentPlan = "FREE",
}: UpgradePromptProps) {
  const { displayPlan, checklist, price, origPrice } =
    resolveUpgradeCopy(requiredPlan);
  const previews = PLAN_PREVIEWS[requiredPlan] ?? PLAN_PREVIEWS.PRO ?? [];
  const HeroIcon = requiredPlan === "PREMIUM" ? Crown : Sparkles;
  const heroColor =
    requiredPlan === "PREMIUM" ? "var(--pop-5)" : "var(--emerald)";

  void currentPlan; // prop kept for future conditional logic

  return (
    <div
      style={{
        width: "100%",
        minHeight: "65vh",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 0 40px",
      }}
    >
      {/* Rotated "premium" stamp — top-right */}
      <div
        style={{
          position: "absolute",
          top: 20,
          right: 20,
          transform: "rotate(-5deg)",
          zIndex: 2,
        }}
      >
        <div
          className="pf-pill violet"
          style={{
            fontSize: 10,
            padding: "5px 12px",
            boxShadow: "3px 3px 0 var(--ink)",
            border: "1.5px solid var(--ink)",
          }}
        >
          <Crown style={{ width: 11, height: 11 }} />
          Locked · {displayPlan}
        </div>
      </div>

      {/* Two-column grid */}
      <div
        style={{
          maxWidth: 980,
          width: "100%",
          padding: "60px 24px 32px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 0.95fr)",
          gap: 40,
          alignItems: "center",
        }}
        className="pg-two-col"
      >
        {/* ── LEFT: pitch ── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 20,
            alignItems: "flex-start",
          }}
        >
          {/* Hero icon tile */}
          <div
            className="pf-card tilt-l"
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              background: heroColor,
              display: "grid",
              placeItems: "center",
              border: "2px solid var(--ink)",
              boxShadow: "4px 4px 0 var(--ink)",
              flexShrink: 0,
            }}
          >
            <HeroIcon
              style={{ width: 36, height: 36, color: "var(--paper)" }}
            />
          </div>

          {/* Eyebrow pill */}
          <div
            className="pf-pill gold"
            style={{ border: "1.5px solid var(--ink)" }}
          >
            <Crown style={{ width: 10, height: 10, color: "#1d1d1b" }} />
            {displayPlan} feature
          </div>

          {/* Headline with inline strikethrough */}
          <h1
            style={{
              fontSize: "clamp(32px, 4.5vw, 52px)",
              letterSpacing: -1.4,
              lineHeight: 1.02,
              fontWeight: 800,
              color: "var(--ink)",
              margin: 0,
            }}
          >
            {pageName} is{" "}
            <span
              style={{
                position: "relative",
                display: "inline-block",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: -4,
                  right: -4,
                  top: "50%",
                  height: 4,
                  background: "var(--pop-1)",
                  transform: "rotate(-2deg) translateY(-50%)",
                  borderRadius: 2,
                  zIndex: 1,
                }}
                aria-hidden="true"
              />
              behind
            </span>{" "}
            <span className="ser" style={{ letterSpacing: -1.2 }}>
              the velvet rope.
            </span>
          </h1>

          {/* Sub */}
          <p
            className="ser"
            style={{
              fontSize: "clamp(16px, 2vw, 20px)",
              color: "var(--ink-3)",
              lineHeight: 1.4,
              margin: 0,
              maxWidth: 480,
            }}
          >
            Unlock {pageName}, deep research, and the rest of{" "}
            <span style={{ color: "var(--ink)" }}>{displayPlan}</span>. Cancel
            any time — no questions, no guilt-trips.
          </p>

          {/* Feature preview chips (small) */}
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {previews.map((p) => {
              const PIcon = p.icon;
              return (
                <div
                  key={p.label}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: 8,
                    border: "1.5px solid var(--rule-soft)",
                    background: "var(--paper-2)",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--ink-2)",
                  }}
                >
                  <PIcon
                    style={{
                      width: 13,
                      height: 13,
                      color: "var(--emerald-text)",
                    }}
                  />
                  {p.label}
                </div>
              );
            })}
          </div>

          {/* CTA row */}
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <Link
              href="/pricing"
              className="pf-bs lg"
              style={{ fontSize: 14, padding: "12px 20px" }}
            >
              <Crown style={{ width: 14, height: 14 }} />
              Upgrade to {displayPlan}
              <ArrowRight style={{ width: 14, height: 14 }} />
            </Link>
            <Link href="/pricing" className="pf-bf" style={{ fontSize: 13 }}>
              Compare plans
            </Link>
          </div>

          {/* Trust strip */}
          <div
            style={{
              display: "flex",
              gap: 20,
              flexWrap: "wrap",
              marginTop: 2,
            }}
          >
            {[
              { icon: Shield, label: "256-bit secure" },
              { icon: Check, label: "Cancel anytime" },
              { icon: Flame, label: "Instant access" },
            ].map((t) => {
              const TIcon = t.icon;
              return (
                <div
                  key={t.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "var(--ink-3)",
                  }}
                >
                  <TIcon
                    style={{
                      width: 12,
                      height: 12,
                      color: "var(--emerald-text)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    className="mono"
                    style={{ letterSpacing: 0.5, textTransform: "uppercase" }}
                  >
                    {t.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT: plan card ── */}
        <div style={{ position: "relative" }}>
          {/* Dotted decorative frame behind */}
          <div
            style={{
              position: "absolute",
              inset: -10,
              border: "2px dashed var(--ink)",
              borderRadius: 22,
              opacity: 0.2,
              transform: "rotate(1.5deg)",
              pointerEvents: "none",
            }}
          />

          <div
            className="pf-card"
            style={{
              padding: 24,
              background: "var(--paper-3)",
              boxShadow: "6px 6px 0 var(--ink)",
              // No panel-level rotate() — the card holds the plan copy and
              // tilting it re-rasterises the text (blurry). The dashed frame
              // and washi-tape accent stay tilted to keep the playful look.
              position: "relative",
              overflow: "visible",
            }}
          >
            {/* Washi-tape accent strip */}
            <div
              style={{
                position: "absolute",
                top: -10,
                left: "50%",
                transform: "translateX(-50%) rotate(-1deg)",
                width: 64,
                height: 20,
                background: "var(--pop-2)",
                opacity: 0.85,
                borderRadius: 3,
                border: "1.5px solid var(--ink)",
              }}
              aria-hidden="true"
            />

            {/* Card header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 14,
              }}
            >
              <div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    letterSpacing: 1.4,
                    textTransform: "uppercase",
                  }}
                >
                  Upgrade to
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 800,
                    color: "var(--ink)",
                    letterSpacing: -0.8,
                    lineHeight: 1.1,
                    marginTop: 4,
                  }}
                >
                  {displayPlan}{" "}
                  <span className="ser" style={{ color: "var(--ink-3)" }}>
                    plan
                  </span>
                </div>
              </div>
            </div>

            {/* Price row */}
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                padding: "12px 0",
                borderTop: "1.5px dashed var(--rule-soft)",
                borderBottom: "1.5px dashed var(--rule-soft)",
                marginBottom: 14,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 34,
                  fontWeight: 800,
                  color: "var(--ink)",
                  letterSpacing: -1.5,
                  lineHeight: 1,
                }}
              >
                {price}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 13,
                  color: "var(--ink-3)",
                  textDecoration: "line-through",
                }}
              >
                {origPrice}
              </div>
              <div
                className="ser"
                style={{
                  fontSize: 15,
                  color: "var(--ink-3)",
                  marginLeft: "auto",
                }}
              >
                / month
              </div>
            </div>

            {/* Feature checklist */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginBottom: 18,
              }}
            >
              {checklist.map((f, i) => (
                <div
                  key={f}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    fontSize: 13,
                    color: "var(--ink-2)",
                    lineHeight: 1.4,
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      border: "1.5px solid var(--ink)",
                      background: i === 0 ? "var(--emerald)" : "var(--paper)",
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                      marginTop: 1,
                    }}
                  >
                    <Check
                      style={{
                        width: 11,
                        height: 11,
                        color: i === 0 ? "var(--paper)" : "var(--ink)",
                      }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>{i === 0 ? <b>{f}</b> : f}</div>
                </div>
              ))}
            </div>

            {/* CTA button */}
            <Link
              href="/pricing"
              className="pf-bs"
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "13px 16px",
                fontSize: 14,
                width: "100%",
              }}
            >
              Upgrade now
              <ArrowRight style={{ width: 14, height: 14 }} />
            </Link>

            {/* Small print */}
            <div
              className="ser"
              style={{
                fontSize: 12,
                color: "var(--ink-3)",
                textAlign: "center",
                marginTop: 10,
                fontStyle: "italic",
              }}
            >
              First month at 50% off. Renews at {origPrice}/mo. Cancel any time.
            </div>
          </div>
        </div>
      </div>

      {/* Mobile responsive: stack columns */}
      <style>{`
        @media (max-width: 720px) {
          .pg-two-col {
            grid-template-columns: 1fr !important;
            gap: 28px !important;
            padding: 48px 18px 28px !important;
          }
          .pg-two-col > *:first-child {
            align-items: center !important;
            text-align: center !important;
          }
          .pg-two-col > *:first-child h1 {
            text-align: center;
          }
          .pg-two-col > *:first-child > div:last-of-type {
            justify-content: center !important;
          }
        }
      `}</style>
    </div>
  );
}
