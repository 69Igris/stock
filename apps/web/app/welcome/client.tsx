"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import {
  GraduationCap,
  TrendingUp,
  Zap,
  Trophy,
  Flame,
  Shield,
  Receipt,
  ShieldCheck,
  Check,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";

const EXPERIENCE = [
  { k: "new", l: "Just starting", s: "0–12 months", icon: GraduationCap },
  { k: "some", l: "A bit", s: "1–3 years", icon: TrendingUp },
  { k: "lots", l: "Quite a bit", s: "3–10 years", icon: Zap },
  { k: "pro", l: "I'm a pro", s: "10+ years", icon: Trophy },
];

const GOALS = [
  {
    k: "wealth",
    l: "Build long-term wealth",
    s: "10+ year horizon",
    icon: TrendingUp,
  },
  {
    k: "fire",
    l: "FIRE — retire early",
    s: "Specific corpus by age",
    icon: Flame,
  },
  {
    k: "goal",
    l: "Save for a goal",
    s: "House, car, kid's college",
    icon: Shield,
  },
  { k: "beat", l: "Beat NIFTY", s: "Active stock-picking", icon: Zap },
  {
    k: "income",
    l: "Tax-efficient income",
    s: "Dividends, debt funds",
    icon: Receipt,
  },
  {
    k: "learn",
    l: "Learn how this works",
    s: "Curiosity & education",
    icon: GraduationCap,
  },
];

const RISK = [
  {
    k: "protect",
    l: "Sell everything — too painful",
    s: "Cash protector",
    score: "Low risk",
    color: "var(--pop-3)",
  },
  {
    k: "cautious",
    l: "Hold, but stop putting in more",
    s: "Cautious mode",
    score: "Low-mid",
    color: "var(--emerald)",
  },
  {
    k: "stay",
    l: "Hold and stay the course",
    s: "I trust the long term",
    score: "Moderate",
    color: "var(--pop-2)",
  },
  {
    k: "add",
    l: "Add more aggressively",
    s: "Discount sale",
    score: "High risk",
    color: "var(--pop-1)",
  },
  {
    k: "leverage",
    l: "Leverage up",
    s: "Margin / options",
    score: "Very high",
    color: "#b91c1c",
  },
];

const STYLES = [
  "Patient",
  "Curious",
  "Anxious in dips",
  "Read 10-Ks for fun",
  "Index it all",
  "Find the next bagger",
  "Tax-aware",
  "Goal-driven",
  "Sector specialist",
  "Avoid F&O",
  "Like a chart",
  "Dividend lover",
];

const STEP_META = [
  {
    n: 1,
    k: "EXPERIENCE",
    t: "How long have you been investing?",
    sub: "There are no wrong answers. We'll tune StockSage to your level.",
  },
  {
    n: 2,
    k: "GOALS",
    t: "What are you here to do?",
    sub: "Pick up to two. We use this to suggest right-fit tools.",
  },
  {
    n: 3,
    k: "RISK",
    t: "Market drops 20% next week. You…",
    sub: "We're checking risk tolerance — be honest, not aspirational.",
  },
  {
    n: 4,
    k: "STYLE",
    t: "Which of these sound like you?",
    sub: "We're sketching how the app should feel for you. Pick freely.",
  },
  {
    n: 5,
    k: "CONNECT",
    t: "Connect your first broker.",
    sub: "Read-only OAuth. We can pull holdings but never place orders.",
  },
];

export default function WelcomeWizardClient({
  onComplete,
  embedded = false,
}: { onComplete?: () => void; embedded?: boolean } = {}) {
  const router = useRouter();
  const { user } = useUser();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [experience, setExperience] = useState<string | null>(null);
  const [goals, setGoals] = useState<string[]>([]);
  const [risk, setRisk] = useState<string | null>(null);
  const [styles, setStyles] = useState<string[]>([]);

  const meta = STEP_META[step - 1];

  const toggleGoal = (k: string) =>
    setGoals((g) =>
      g.includes(k) ? g.filter((x) => x !== k) : g.length < 2 ? [...g, k] : g
    );
  const toggleStyle = (l: string) =>
    setStyles((s) => (s.includes(l) ? s.filter((x) => x !== l) : [...s, l]));

  const persist = async () => {
    try {
      setSaving(true);
      await user?.update({
        unsafeMetadata: {
          ...(user?.unsafeMetadata ?? {}),
          investorProfile: {
            experience,
            goals,
            risk,
            styles,
            completedAt: Date.now(),
          },
        },
      });
    } catch {
      /* non-blocking — profiling is a nicety, never a gate */
    } finally {
      setSaving(false);
    }
  };

  // When embedded in the onboarding sequence (TermsGate), hand control back
  // via onComplete so the walkthrough can fire; standalone /welcome routes on.
  const finish = async () => {
    await persist();
    if (onComplete) onComplete();
    else router.push("/dashboard");
  };

  // Step 5 "Connect a broker": complete onboarding the same way `finish` does
  // — persist the profile and release the gate via onComplete — BEFORE
  // navigating. Otherwise the route changes to /brokers but TermsGate still
  // sees !hasInvestorProfile and re-renders THIS wizard on top of /brokers, so
  // the redirect appears to do nothing. persist() must be awaited so the gate's
  // re-check on the pathname change reads the now-saved profile.
  const connectBroker = async () => {
    await persist();
    onComplete?.();
    router.push("/brokers");
  };

  // Pre-fill when re-taking from Settings (an existing, non-skipped profile).
  useEffect(() => {
    const p = user?.unsafeMetadata?.investorProfile as
      | {
          experience?: string;
          goals?: string[];
          risk?: string;
          styles?: string[];
          skipped?: boolean;
        }
      | undefined;
    if (!p || p.skipped) return;
    if (p.experience) setExperience((c) => c ?? p.experience ?? null);
    if (p.goals?.length) setGoals((c) => (c.length ? c : (p.goals ?? [])));
    if (p.risk) setRisk((c) => c ?? p.risk ?? null);
    if (p.styles?.length) setStyles((c) => (c.length ? c : (p.styles ?? [])));
  }, [user]);

  // Skip (onboarding only) — persist a dismissed marker so the gate won't
  // re-prompt on every load; the user can still fill it later from Settings.
  const skip = async () => {
    try {
      await user?.update({
        unsafeMetadata: {
          ...(user?.unsafeMetadata ?? {}),
          investorProfile: {
            ...((user?.unsafeMetadata?.investorProfile as Record<
              string,
              unknown
            >) ?? {}),
            skipped: true,
            completedAt: Date.now(),
          },
        },
      });
    } catch {
      /* non-blocking */
    }
    if (onComplete) onComplete();
    else router.push("/dashboard");
  };

  const canContinue =
    (step === 1 && experience) ||
    (step === 2 && goals.length > 0) ||
    (step === 3 && risk) ||
    step === 4 ||
    step === 5;

  return (
    <div
      className={embedded ? "" : "pf-app"}
      style={
        embedded
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 200,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(2px)",
              display: "grid",
              placeItems: "center",
              padding: "24px 16px",
              overflowY: "auto",
            }
          : {
              minHeight: "100vh",
              display: "grid",
              placeItems: "center",
              padding: "32px 16px",
            }
      }
    >
      <div
        className="pf-card"
        style={{
          width: "min(100%, 640px)",
          padding: 0,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Skip (onboarding) / Cancel (editing from Settings) — top-right */}
        {embedded ? (
          <button
            type="button"
            onClick={skip}
            className="pf-bf sm"
            style={{ position: "absolute", top: 14, right: 16, zIndex: 2 }}
          >
            Skip for now
          </button>
        ) : (
          <button
            type="button"
            onClick={() => router.push("/settings")}
            className="pf-bf sm"
            style={{ position: "absolute", top: 14, right: 16, zIndex: 2 }}
          >
            Cancel
          </button>
        )}
        {/* Header + progress */}
        <div style={{ padding: "22px 28px 18px" }}>
          <div
            className="pf-ph .eyebrow"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10.5,
              color: "var(--emerald)",
              letterSpacing: 1.5,
              fontWeight: 700,
            }}
          >
            ● BUILDING YOUR PROFILE · STEP {meta.n} OF 5
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            {STEP_META.map((s) => (
              <div
                key={s.n}
                style={{
                  flex: 1,
                  height: 5,
                  borderRadius: 99,
                  background:
                    s.n < step
                      ? "var(--emerald)"
                      : s.n === step
                        ? "var(--ink)"
                        : "var(--rule-soft)",
                }}
              />
            ))}
          </div>
          <h2
            style={{
              marginTop: 18,
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: "-1px",
              lineHeight: 1.1,
            }}
          >
            {meta.t}
          </h2>
          <div
            style={{
              marginTop: 8,
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontSize: 16,
              color: "var(--ink-3)",
              lineHeight: 1.35,
            }}
          >
            {meta.sub}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "0 28px 8px" }}>
          {step === 1 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {EXPERIENCE.map((o) => {
                const I = o.icon;
                const on = experience === o.k;
                return (
                  <button
                    key={o.k}
                    type="button"
                    onClick={() => setExperience(o.k)}
                    style={optionCard(on)}
                  >
                    <span style={iconTile(on)}>
                      <I size={16} />
                    </span>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 800,
                          letterSpacing: "-0.3px",
                        }}
                      >
                        {o.l}
                      </div>
                      <div
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 11,
                          color: "var(--ink-3)",
                          marginTop: 2,
                        }}
                      >
                        {o.s}
                      </div>
                    </div>
                    {on && (
                      <Check size={14} className="text-[var(--emerald)]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {step === 2 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {GOALS.map((o) => {
                const I = o.icon;
                const on = goals.includes(o.k);
                return (
                  <button
                    key={o.k}
                    type="button"
                    onClick={() => toggleGoal(o.k)}
                    style={optionCard(on, 11)}
                  >
                    <span style={checkBox(on)}>
                      {on && (
                        <Check size={12} className="text-[var(--paper)]" />
                      )}
                    </span>
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 7,
                        background: "var(--rule-softer)",
                        display: "grid",
                        placeItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <I size={13} />
                    </span>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{o.l}</div>
                      <div
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 10.5,
                          color: "var(--ink-3)",
                          marginTop: 1,
                        }}
                      >
                        {o.s}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {RISK.map((o) => {
                const on = risk === o.k;
                return (
                  <button
                    key={o.k}
                    type="button"
                    onClick={() => setRisk(o.k)}
                    style={optionCard(on, 11)}
                  >
                    <span style={radio(on)}>
                      {on && (
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 99,
                            background: "var(--paper)",
                          }}
                        />
                      )}
                    </span>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{o.l}</div>
                      <div
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 11,
                          color: "var(--ink-3)",
                          marginTop: 2,
                        }}
                      >
                        {o.s}
                      </div>
                    </div>
                    <span
                      className="pf-pill"
                      style={{
                        fontSize: 10,
                        background: o.color,
                        /* For var(--pop-2) (gold) use dark text for contrast;
                           for all other colors (coral, red, emerald) use a
                           static light cream so the pill is readable in both
                           light and dark themes — var(--paper) flips to near-
                           black in dark mode, making red/blue badges unreadable. */
                        color:
                          o.color === "var(--pop-2)" ? "#1d1d1b" : "#f7f3e6",
                        borderColor: o.color,
                      }}
                    >
                      {o.score}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {step === 4 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {STYLES.map((l) => {
                const on = styles.includes(l);
                return (
                  <button
                    key={l}
                    type="button"
                    onClick={() => toggleStyle(l)}
                    style={{
                      padding: "9px 16px",
                      borderRadius: 99,
                      border: "1.5px solid var(--ink)",
                      background: on ? "var(--emerald)" : "var(--paper)",
                      color: on ? "var(--paper)" : "var(--ink-2)",
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {on && "✓ "}
                    {l}
                  </button>
                );
              })}
            </div>
          )}

          {step === 5 && (
            <div>
              <button
                type="button"
                onClick={connectBroker}
                disabled={saving}
                className="pf-bs lg"
                style={{ width: "100%", justifyContent: "center" }}
              >
                Connect a broker <ArrowRight size={15} />
              </button>
              <div
                style={{
                  marginTop: 14,
                  padding: 12,
                  background: "var(--emerald-bg)",
                  border: "1px solid var(--emerald)",
                  borderRadius: 10,
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <ShieldCheck
                  size={17}
                  className="text-[var(--emerald)] shrink-0"
                />
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    lineHeight: 1.45,
                  }}
                >
                  Read-only OAuth · AES-256 token encryption · we{" "}
                  <strong className="text-[var(--emerald)]">
                    cannot place orders
                  </strong>
                  . Skip to explore in demo mode.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 28px",
            marginTop: 14,
            borderTop: "1.5px dashed var(--rule-soft)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "var(--paper-2)",
          }}
        >
          <button
            type="button"
            className="pf-bf sm"
            disabled={step === 1}
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            style={{ opacity: step === 1 ? 0.4 : 1 }}
          >
            <ArrowLeft size={13} /> Back
          </button>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {step === 5 ? (
              <>
                <button
                  type="button"
                  className="pf-bf sm"
                  disabled={saving}
                  onClick={() => finish()}
                >
                  Skip · use demo
                </button>
                <button
                  type="button"
                  className="pf-bs sm"
                  disabled={saving}
                  onClick={() => finish()}
                >
                  Finish →
                </button>
              </>
            ) : (
              <>
                <span
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 11,
                    color: "var(--ink-3)",
                  }}
                >
                  {step} / 5
                </span>
                <button
                  type="button"
                  className="pf-bs sm"
                  disabled={!canContinue}
                  onClick={() => setStep((s) => s + 1)}
                  style={{ opacity: canContinue ? 1 : 0.4 }}
                >
                  Continue <ArrowRight size={13} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function optionCard(on: boolean, radius = 12): React.CSSProperties {
  return {
    padding: radius === 12 ? 16 : "13px 16px",
    border: `2px solid ${on ? "var(--emerald)" : "var(--ink)"}`,
    borderRadius: radius,
    background: on ? "var(--emerald-bg)" : "var(--paper)",
    boxShadow: on ? "2px 2px 0 var(--emerald)" : "none",
    display: "flex",
    gap: 12,
    alignItems: "center",
    cursor: "pointer",
  };
}
function iconTile(on: boolean): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: 9,
    background: on ? "var(--emerald)" : "var(--ink)",
    color: "var(--paper)",
    display: "grid",
    placeItems: "center",
    border: "1.5px solid var(--ink)",
    transform: "rotate(-3deg)",
    flexShrink: 0,
  };
}
function checkBox(on: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 5,
    border: "1.5px solid var(--ink)",
    background: on ? "var(--emerald)" : "var(--paper)",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  };
}
function radio(on: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 99,
    border: "1.5px solid var(--ink)",
    background: on ? "var(--emerald)" : "var(--paper)",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  };
}
