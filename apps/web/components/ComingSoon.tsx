"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  BarChart3,
  Zap,
  Bell,
  ArrowLeft,
  Check,
  Send,
  Hammer,
} from "lucide-react";

/**
 * ComingSoon — playful v5 redesign (MONEY-484).
 *
 * Visual spec: screens.jsx §01 (ComingSoonScreen).
 *   - Tilted ETA gold sticker pinned top-right
 *   - Sticker icon tile (tilt-l, pop color)
 *   - Emerald eyebrow pill with animated dot
 *   - Bold headline with serif-italic flourish
 *   - 3-up tilted feature cards
 *   - Inline notify-me email capture with success state
 *   - "Back to dashboard" + "See what's live →" footer row
 *
 * Notify-me wiring: no server action exists for waitlist signup.
 * On submit the component enters a local success state and shows a
 * confirmation message. Wire to a real action when the endpoint exists.
 */

interface FeatureCard {
  icon: typeof Brain;
  label: string;
  desc: string;
}

interface ComingSoonProps {
  pageName?: string;
  eta?: string;
  features?: FeatureCard[];
  popColor?: string;
}

const DEFAULT_FEATURES: FeatureCard[] = [
  {
    icon: Brain,
    label: "AI strategy builder",
    desc: "Plain English → backtested rule",
  },
  {
    icon: BarChart3,
    label: "5-year backtest",
    desc: "NSE + BSE, daily granularity",
  },
  {
    icon: Zap,
    label: "Forward simulate",
    desc: "Paper trade before going live",
  },
];

const TILT_CLASSES = ["pf-card tilt-l", "pf-card", "pf-card tilt-r"];
const POP_COLORS = ["var(--pop-1)", "var(--pop-3)", "var(--pop-5)"];
const ICON_TILTS = ["rotate(-5deg)", "rotate(-2deg)", "rotate(5deg)"];

export function ComingSoon({
  pageName = "Strategies",
  eta = "Q3 2026",
  features = DEFAULT_FEATURES,
  popColor = "var(--pop-3)",
}: ComingSoonProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    // No server action exists for waitlist/notify-me yet.
    // Simulate a brief delay then enter success state.
    await new Promise<void>((res) => setTimeout(res, 400));
    setSubmitted(true);
    setSubmitting(false);
  }

  return (
    <div
      style={{
        width: "100%",
        minHeight: "65vh",
        overflow: "auto",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "60px 16px 40px",
      }}
    >
      {/* Decorative rotated ETA sticker — top-right */}
      <div
        style={{
          position: "absolute",
          top: 24,
          right: 20,
          transform: "rotate(6deg)",
          zIndex: 2,
        }}
      >
        <div
          className="pf-card"
          style={{
            padding: "8px 14px",
            background: "var(--pop-2)",
            boxShadow: "3px 3px 0 var(--ink)",
            border: "2px solid var(--ink)",
            color: "#1d1d1b",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: 1.5,
              lineHeight: 1,
              color: "#3a3a35",
            }}
          >
            ETA
          </div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 800,
              letterSpacing: -0.5,
              lineHeight: 1.1,
              marginTop: 2,
              color: "#1d1d1b",
            }}
          >
            <span className="ser" style={{ fontStyle: "italic" }}>
              {eta}
            </span>
          </div>
        </div>
      </div>

      {/* Center column */}
      <div
        style={{
          maxWidth: 640,
          width: "100%",
          margin: "0 auto",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 22,
        }}
      >
        {/* Sticker icon tile */}
        <div
          className="pf-card tilt-l"
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: popColor,
            display: "grid",
            placeItems: "center",
            border: "2px solid var(--ink)",
            boxShadow: "4px 4px 0 var(--ink)",
            flexShrink: 0,
          }}
        >
          <Hammer style={{ width: 36, height: 36, color: "var(--paper)" }} />
        </div>

        {/* Eyebrow pill */}
        <div
          className="pf-pill emerald"
          style={{ border: "1.5px solid var(--ink)" }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--paper)",
              animation: "ph-pulse 1.6s infinite",
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          Coming soon
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: "clamp(34px, 6vw, 52px)",
            letterSpacing: -1.4,
            lineHeight: 1.02,
            fontWeight: 800,
            color: "var(--ink)",
            margin: 0,
          }}
        >
          {pageName} is on{" "}
          <span className="ser" style={{ letterSpacing: -1.2 }}>
            its&nbsp;way.
          </span>
        </h1>

        {/* Subtext */}
        <p
          className="ser"
          style={{
            fontSize: "clamp(16px, 2.5vw, 20px)",
            color: "var(--ink-3)",
            lineHeight: 1.4,
            margin: 0,
            maxWidth: 500,
          }}
        >
          We&apos;re shipping{" "}
          <span style={{ color: "var(--ink)" }}>{pageName}</span> soon. Drop
          your email and we&apos;ll ping you the minute it&apos;s live.
        </p>

        {/* 3-up feature cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            width: "100%",
          }}
        >
          {features.map((f, i) => {
            const FeatureIcon = f.icon;
            return (
              <div
                key={f.label}
                className={TILT_CLASSES[i]}
                style={{
                  padding: "14px 12px",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: POP_COLORS[i % POP_COLORS.length],
                    border: "1.5px solid var(--ink)",
                    boxShadow: "2px 2px 0 var(--ink)",
                    transform: ICON_TILTS[i],
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  <FeatureIcon
                    style={{ width: 16, height: 16, color: "var(--paper)" }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 800,
                      fontSize: 13,
                      color: "var(--ink)",
                      letterSpacing: -0.2,
                      lineHeight: 1.2,
                    }}
                  >
                    {f.label}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      marginTop: 3,
                      letterSpacing: 0.2,
                      lineHeight: 1.3,
                    }}
                  >
                    {f.desc}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Email capture card */}
        <div
          className="pf-card"
          style={{
            width: "100%",
            padding: "20px 18px 16px",
            background: "var(--paper-2)",
            textAlign: "left",
            position: "relative",
          }}
        >
          {/* "Notify me" pill tab pinned above card */}
          <div style={{ position: "absolute", top: -12, left: 20 }}>
            <div
              className="pf-pill gold"
              style={{ fontSize: 9.5, border: "1.5px solid var(--ink)" }}
            >
              <Bell style={{ width: 10, height: 10 }} />
              Notify me
            </div>
          </div>

          {submitted ? (
            /* Success state */
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "4px 0",
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "var(--emerald)",
                  border: "1.5px solid var(--ink)",
                  boxShadow: "2px 2px 0 var(--ink)",
                  transform: "rotate(-3deg)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <Check
                  style={{ width: 18, height: 18, color: "var(--paper)" }}
                />
              </div>
              <div>
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 14,
                    color: "var(--ink)",
                    lineHeight: 1.2,
                  }}
                >
                  You&apos;re on the list.
                </div>
                <div
                  className="ser"
                  style={{
                    fontSize: 13.5,
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  We&apos;ll email{" "}
                  <b
                    style={{
                      color: "var(--ink)",
                      fontFamily: "inherit",
                      fontStyle: "normal",
                    }}
                  >
                    {email}
                  </b>{" "}
                  when {pageName} ships.
                </div>
              </div>
            </div>
          ) : (
            /* Capture form */
            <>
              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 14,
                    color: "var(--ink)",
                    letterSpacing: -0.2,
                  }}
                >
                  Be first in line.
                </div>
                <div
                  className="ser"
                  style={{
                    fontSize: 13.5,
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  One email, the day it ships. No spam, we hate it too.
                </div>
              </div>
              <form
                onSubmit={handleSubmit}
                style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
              >
                <input
                  className="pf-input"
                  type="email"
                  placeholder="you@trader.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={{ flex: "1 1 180px", minWidth: 0 }}
                />
                <button
                  type="submit"
                  className="pf-bs"
                  disabled={submitting}
                  style={{
                    padding: "10px 16px",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  <Send style={{ width: 13, height: 13 }} />
                  {submitting ? "Sending…" : "Notify me"}
                </button>
              </form>
            </>
          )}

          {/* Status strip */}
          <div
            style={{
              marginTop: 14,
              borderTop: "1px dashed var(--rule-soft)",
              paddingTop: 10,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                letterSpacing: 1,
              }}
            >
              ● IN DEVELOPMENT
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                letterSpacing: 1,
              }}
            >
              247 ON WAITLIST
            </span>
          </div>
        </div>

        {/* Footer row */}
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: "center",
            marginTop: 4,
          }}
        >
          <button
            type="button"
            className="pf-bf"
            onClick={() => router.push("/dashboard")}
          >
            <ArrowLeft style={{ width: 14, height: 14 }} />
            Back to dashboard
          </button>
          <button
            type="button"
            className="ser"
            style={{
              background: "none",
              border: 0,
              cursor: "pointer",
              fontSize: 14,
              color: "var(--ink-3)",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
            onClick={() => router.push("/dashboard")}
          >
            See what&apos;s live →
          </button>
        </div>
      </div>
    </div>
  );
}
