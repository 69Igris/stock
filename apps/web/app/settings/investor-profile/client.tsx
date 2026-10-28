"use client";

/**
 * InvestorProfileEditor — in-shell single-page editor for the investor
 * profile that the onboarding wizard collects (experience / goals / risk /
 * style). Renders INSIDE the app shell (Sidebar + TopBar visible) so the
 * user never loses their navigation context.
 *
 * Save logic is identical to WelcomeWizardClient: Clerk unsafeMetadata
 * `investorProfile` with the same field shape, so downstream consumers
 * (StockSage, dashboard level) see no difference.
 */

import { useState, useEffect, useCallback } from "react";
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
  ArrowLeft,
  Save,
  User,
} from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { SetSection } from "@/app/settings/tabs/primitives";
import { toast } from "sonner";

/* ─── Shared option data (mirrors WelcomeWizardClient) ─────────────── */

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

/* ─── Helpers ───────────────────────────────────────────────────────── */

function optionCard(on: boolean, compact = false): React.CSSProperties {
  return {
    padding: compact ? "12px 14px" : "14px 16px",
    border: `2px solid ${on ? "var(--emerald)" : "var(--ink)"}`,
    borderRadius: 11,
    background: on ? "var(--emerald-bg)" : "var(--paper)",
    boxShadow: on ? "2px 2px 0 var(--emerald)" : "none",
    display: "flex",
    gap: 11,
    alignItems: "center",
    cursor: "pointer",
    transition: "all .1s",
  };
}

function iconTile(on: boolean): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: 8,
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
    width: 20,
    height: 20,
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
    width: 20,
    height: 20,
    borderRadius: 99,
    border: "1.5px solid var(--ink)",
    background: on ? "var(--emerald)" : "var(--paper)",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  };
}

/* ─── Component ─────────────────────────────────────────────────────── */

export default function InvestorProfileEditor() {
  const router = useRouter();
  const { user } = useUser();

  const [saving, setSaving] = useState(false);
  const [experience, setExperience] = useState<string | null>(null);
  const [goals, setGoals] = useState<string[]>([]);
  const [risk, setRisk] = useState<string | null>(null);
  const [styles, setStyles] = useState<string[]>([]);

  /* Pre-fill from existing Clerk metadata on mount */
  useEffect(() => {
    const p = user?.unsafeMetadata?.investorProfile as
      | {
          experience?: string;
          goals?: string[];
          risk?: string;
          styles?: string[];
        }
      | undefined;
    if (!p) return;
    if (p.experience) setExperience(p.experience);
    if (p.goals?.length) setGoals(p.goals);
    if (p.risk) setRisk(p.risk);
    if (p.styles?.length) setStyles(p.styles);
  }, [user]);

  const toggleGoal = (k: string) =>
    setGoals((g) =>
      g.includes(k) ? g.filter((x) => x !== k) : g.length < 2 ? [...g, k] : g
    );

  const toggleStyle = (l: string) =>
    setStyles((s) => (s.includes(l) ? s.filter((x) => x !== l) : [...s, l]));

  const save = useCallback(async () => {
    if (!user) return;
    setSaving(true);
    try {
      await user.update({
        unsafeMetadata: {
          ...(user.unsafeMetadata ?? {}),
          investorProfile: {
            ...((user.unsafeMetadata?.investorProfile as Record<
              string,
              unknown
            >) ?? {}),
            experience,
            goals,
            risk,
            styles,
            completedAt: Date.now(),
            /* Clear a previous "skipped" flag now that the user has filled it */
            skipped: false,
          },
        },
      });
      toast.success("Investor profile saved!");
      router.push("/settings?tab=account");
    } catch {
      toast.error("Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [user, experience, goals, risk, styles, router]);

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-6 pb-24 pt-6 max-w-[820px] mx-auto">
          {/* Page header */}
          <PfPageHead
            eyebrow="SETTINGS · INVESTOR PROFILE"
            title={
              <>
                Your <span className="ser">investor</span>{" "}
                <span className="hl">profile.</span>
              </>
            }
            sub="Tunes StockSage and your dashboard level. Update any time — changes take effect immediately."
            right={
              <span className="pf-pill outline">
                <User className="h-3 w-3" />
                Profile
              </span>
            }
          />

          {/* Back link */}
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => router.push("/settings?tab=account")}
            style={{ marginBottom: 24 }}
          >
            <ArrowLeft size={13} /> Back to Account
          </button>

          <div className="flex flex-col gap-6">
            {/* ── Experience ── */}
            <SetSection
              title="How long have you been investing?"
              desc="There are no wrong answers. We'll tune StockSage to your level."
            >
              <div style={{ padding: "18px 22px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(220px, 1fr))",
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
                          <I size={15} />
                        </span>
                        <div style={{ flex: 1, textAlign: "left" }}>
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 800,
                              letterSpacing: "-0.3px",
                            }}
                          >
                            {o.l}
                          </div>
                          <div
                            style={{
                              fontFamily: "JetBrains Mono, monospace",
                              fontSize: 10.5,
                              color: "var(--ink-3)",
                              marginTop: 2,
                            }}
                          >
                            {o.s}
                          </div>
                        </div>
                        {on && (
                          <Check
                            size={14}
                            className="text-[var(--emerald-text)]"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </SetSection>

            {/* ── Goals ── */}
            <SetSection
              title="What are you here to do?"
              desc="Pick up to two. We use this to suggest right-fit tools."
            >
              <div style={{ padding: "18px 22px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(220px, 1fr))",
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
                        style={optionCard(on, true)}
                      >
                        <span style={checkBox(on)}>
                          {on && (
                            <Check size={11} className="text-[var(--paper)]" />
                          )}
                        </span>
                        <span
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 7,
                            background: "var(--rule-softer)",
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0,
                          }}
                        >
                          <I size={12} />
                        </span>
                        <div style={{ flex: 1, textAlign: "left" }}>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>
                            {o.l}
                          </div>
                          <div
                            style={{
                              fontFamily: "JetBrains Mono, monospace",
                              fontSize: 10,
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
                {goals.length === 2 && (
                  <div
                    style={{
                      marginTop: 10,
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 11,
                      color: "var(--emerald-text)",
                    }}
                  >
                    ✓ Max 2 goals selected
                  </div>
                )}
              </div>
            </SetSection>

            {/* ── Risk tolerance ── */}
            <SetSection
              title="Market drops 20% next week. You…"
              desc="We're checking risk tolerance — be honest, not aspirational."
            >
              <div style={{ padding: "18px 22px" }}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {RISK.map((o) => {
                    const on = risk === o.k;
                    return (
                      <button
                        key={o.k}
                        type="button"
                        onClick={() => setRisk(o.k)}
                        style={optionCard(on, true)}
                      >
                        <span style={radio(on)}>
                          {on && (
                            <span
                              style={{
                                width: 9,
                                height: 9,
                                borderRadius: 99,
                                background: "var(--paper)",
                              }}
                            />
                          )}
                        </span>
                        <div style={{ flex: 1, textAlign: "left" }}>
                          <div style={{ fontSize: 14, fontWeight: 700 }}>
                            {o.l}
                          </div>
                          <div
                            style={{
                              fontFamily: "JetBrains Mono, monospace",
                              fontSize: 10.5,
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
                            /* Same fix as welcome/client.tsx: var(--paper) in
                               dark mode is near-black, making coloured badges
                               (red, emerald) nearly unreadable. Use static
                               cream for contrast; dark only for gold (pop-2). */
                            color:
                              o.color === "var(--pop-2)"
                                ? "#1d1d1b"
                                : "#f7f3e6",
                            borderColor: o.color,
                          }}
                        >
                          {o.score}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </SetSection>

            {/* ── Investor style ── */}
            <SetSection
              title="Which of these sound like you?"
              desc="We're sketching how the app should feel for you. Pick freely."
            >
              <div style={{ padding: "18px 22px" }}>
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
                          transition: "all .1s",
                        }}
                      >
                        {on && "✓ "}
                        {l}
                      </button>
                    );
                  })}
                </div>
              </div>
            </SetSection>

            {/* ── Security note + Save ── */}
            <div
              style={{
                padding: "14px 16px",
                background: "var(--emerald-bg)",
                border: "1px solid var(--emerald)",
                borderRadius: 10,
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
              }}
            >
              <ShieldCheck
                size={16}
                className="text-[var(--emerald-text)] shrink-0 mt-0.5"
              />
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-2)",
                  lineHeight: 1.5,
                }}
              >
                Your profile is stored privately in your account. It is never
                shared with brokers or third parties, and is only used to
                personalise your UseMoney experience.
              </div>
            </div>

            {/* Save / cancel row */}
            <div
              style={{
                display: "flex",
                gap: 10,
                justifyContent: "flex-end",
                paddingBottom: 8,
              }}
            >
              <button
                type="button"
                className="pf-bf"
                onClick={() => router.push("/settings?tab=account")}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pf-bs"
                onClick={save}
                disabled={saving}
                style={{ minWidth: 110 }}
              >
                {saving ? (
                  "Saving…"
                ) : (
                  <>
                    <Save size={14} /> Save profile
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
