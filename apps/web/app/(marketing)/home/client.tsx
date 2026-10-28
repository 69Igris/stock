"use client";

import "./page.css";
// Landing-page pricing tiles reuse the .pcard / .cycle-tog / .badge styles from
// the dedicated /pricing page.css. Importing the file keeps tile design in a
// single source of truth — a /pricing tile redesign flows to the landing
// automatically without forking CSS.
import "../pricing/page.css";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { PLAN_CONFIG } from "@usemoney/core/subscription";
import { PlayfulTicker } from "@/components/marketing/PlayfulTicker";

type Cycle = "monthly" | "annual";

const PRO = PLAN_CONFIG.PRO;
const PREMIUM = PLAN_CONFIG.PREMIUM;
const INR = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// `slug` maps to `apps/web/public/brokers/${slug}.png` — same files /integrations
// uses, so the landing strip stays in sync with the broker page.
// Status: Zerodha is the only Beta integration shipping; the other seven are
// labeled Soon while we stage their production rollout.
const BROKERS: Array<{ slug: string; name: string; note: string }> = [
  { slug: "zerodha", name: "Zerodha", note: "Beta" },
  { slug: "groww", name: "Groww", note: "Soon" },
  { slug: "angel", name: "Angel One", note: "Soon" },
  { slug: "upstox", name: "Upstox", note: "Soon" },
  { slug: "dhan", name: "Dhan", note: "Soon" },
  { slug: "fyers", name: "Fyers", note: "Soon" },
  { slug: "hdfc", name: "HDFC Sky", note: "Soon" },
  { slug: "icici", name: "ICICI Direct", note: "Soon" },
];

export default function HomeClient() {
  const { isLoaded, isSignedIn } = useUser();
  const [cycle, setCycle] = useState<Cycle>("monthly");

  const authed = isLoaded && isSignedIn;
  const primaryHref = authed ? "/dashboard" : "/sign-up";
  const primaryLabel = authed ? "Go to dashboard →" : "Start free →";

  // Tile CTA hrefs mirror /pricing: signed-in lands on in-app checkout,
  // signed-out goes through sign-up so an account exists before payment.
  const ctaHref = (plan: "PRO" | "PREMIUM") =>
    authed ? `/settings?upgrade=${plan}` : `/sign-up?plan=${plan}`;

  /**
   * Take a Tour → Demo mode launcher.
   *
   * - POSTs to /api/demo/start which mints an HMAC-signed demo cookie
   *   server-side (24h TTL) and fires PostHog `demo_started` telemetry.
   * - Sets the `tradebook_demo_mode` localStorage flag (legacy compat
   *   for surfaces that key off it before the cookie hydrates).
   * - Hard-navigates to /dashboard via window.location.href so the
   *   demo cookie is sent with the next request and middleware can
   *   route to the demo experience without React Router state weirdness.
   *
   * Matches the convention in feedback_demo_flow_sync memory note —
   * window.location.href, not router.push.
   */
  async function handleTryDemo() {
    try {
      await fetch("/api/demo/start", { method: "POST" });
    } catch (err) {
      console.error("Demo start failed", err);
      // Continue to navigate even on failure — middleware handles
      // missing cookies gracefully and falls back to a fresh demo.
    }
    if (typeof window !== "undefined") {
      localStorage.setItem("tradebook_demo_mode", "true");
      window.location.href = "/dashboard";
    }
  }

  // Same helpers as /pricing/client.tsx so the toggle math stays in lockstep.
  const annualMonthly = (annual: number) => Math.round(annual / 12);
  const annualSavings = (monthly: number, annual: number) =>
    monthly * 12 - annual;
  const annualDiscountPct = (monthly: number, annual: number) =>
    monthly > 0 ? Math.round((1 - annual / (monthly * 12)) * 100) : 0;
  const maxAnnualDiscount = Math.max(
    annualDiscountPct(PRO.monthlyPrice ?? 249, PRO.annualPrice ?? 1999),
    annualDiscountPct(PREMIUM.price, PREMIUM.annualPrice ?? 14990)
  );

  return (
    <>
      {/* ── HERO (V4 design from claude.ai/design handoff) ──────────── */}
      <section className="hero">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            USE MONEY. INTELLIGENTLY.
          </div>

          <div className="hero-grid">
            <div className="hero-main">
              <h1 className="hero-title">
                Ask anything
                <br />
                about your <span className="ser">money.</span>
                <br />
                <span className="hl">No more</span>{" "}
                <span className="strike">guesswork.</span>
              </h1>

              <p className="lede">
                AI that&apos;s actually read your portfolio —{" "}
                <b>every broker, every holding</b>. Real answers, not generic
                tips.
              </p>

              <div className="prompts" aria-label="Example questions">
                <span className="prompts-label">Try asking →</span>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    width: "100%",
                  }}
                >
                  <Link className="prompt-chip" href={primaryHref}>
                    What&apos;s my real sector concentration?
                  </Link>
                  <Link className="prompt-chip" href={primaryHref}>
                    Roast my portfolio
                  </Link>
                  <Link className="prompt-chip" href={primaryHref}>
                    Is my MF overlap hurting returns?
                  </Link>
                  <Link className="prompt-chip" href={primaryHref}>
                    Did my last 6 trades beat a Nifty SIP?
                  </Link>
                </div>
              </div>

              <div className="cta-row">
                <Link className="btn-solid lg" href={primaryHref}>
                  {primaryLabel}
                </Link>
                <Link className="btn-flat lg" href="/features">
                  See how it works
                </Link>
                {/* Try Demo entry — restored per feedback_demo_flow_sync.
                    Signs the demo cookie, sets localStorage compat flag,
                    then hard-navigates to /dashboard. The btn-flat-tour
                    modifier tints this CTA emerald so visitors can tell
                    "try the product" apart from the other two CTAs in
                    the row (Start free / See how it works). */}
                <button
                  type="button"
                  className="btn-flat lg btn-flat-tour"
                  onClick={handleTryDemo}
                >
                  Take a Tour →
                </button>
              </div>

              <div className="fine">
                <span>
                  <span className="star">✦</span> <b>Read-only</b> · we
                  can&apos;t place orders
                </span>
                <span>
                  <span className="star">✦</span> <b>5 free</b> credits / month,
                  forever
                </span>
                <span>
                  <span className="star">✦</span> <b>PRO ₹249</b>/mo · 50% off
                </span>
              </div>
            </div>

            <aside className="hero-side">
              <div className="sticker">
                <strong>actually shipped:</strong> AI chat · roast · strategies
                · backtest
              </div>
              <div className="quote">
                We started this because five broker tabs and a Google sheet
                still can&apos;t answer the only question that matters —{" "}
                <b>is my portfolio actually any good?</b> UseMoney reads every
                holding you own and tells you straight.
              </div>
            </aside>
          </div>
        </div>

        <PlayfulTicker />
      </section>

      {/* ── SECTION 2: THE INTELLIGENCE LAYER ───────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">01 / INTELLIGENCE</span>
            <h2>
              <span className="hl">StockSage</span> knows your portfolio.{" "}
              <span className="ser">Generic AI doesn&apos;t.</span>
            </h2>
          </div>

          <p className="section-sub">
            If you&apos;ve ever pasted Zerodha P&amp;L into a spreadsheet to add
            Angel One returns — yes, this is for you.
          </p>

          <div className="who-grid">
            <div className="who-card">
              <div className="ix">PERSONA 01</div>
              <h4>
                The <span className="ser">multi-broker</span> investor
              </h4>
              <p>
                Zerodha for delivery, Groww for MFs, Angel for F&amp;O. Your
                XIRR is a mystery. One dashboard fixes that.
              </p>
              <span className="tag-pill gold" style={{ marginTop: 14 }}>
                unified holdings
              </span>
            </div>
            <div className="who-card">
              <div className="ix">PERSONA 02</div>
              <h4>
                The <span className="ser">researcher</span> who hates Excel
              </h4>
              <p>
                Stack 70+ technicals on top of fundamentals, ask follow-ups in
                plain English, save the screen, revisit weekly.
              </p>
              <span className="tag-pill pink" style={{ marginTop: 14 }}>
                scanner + chat
              </span>
            </div>
            <div className="who-card">
              <div className="ix">PERSONA 03</div>
              <h4>
                The <span className="ser">strategy builder</span> testing a
                thesis
              </h4>
              <p>
                Compose a rule-based strategy, backtest it across regimes with
                walk-forward, and get an honest review from StockSage before you
                risk a rupee.
              </p>
              <span className="tag-pill blue" style={{ marginTop: 14 }}>
                build · backtest · validate
              </span>
            </div>
            <div className="who-card">
              <div className="ix">PERSONA 04</div>
              <h4>
                The <span className="ser">FIRE planner</span> who thinks in INR
              </h4>
              <p>
                Real Indian assumptions — STCG, LTCG, PPF, EPF. Plot the year
                you can stop. Adjust until it feels real.
              </p>
              <span className="tag-pill coral" style={{ marginTop: 14 }}>
                FIRE in ₹
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 3: PRODUCT TOUR (V2 design from claude.ai/design handoff) */}
      <section className="section tour-wrap">
        <div className="container">
          <div className="section-h">
            <span className="num">02 / PRODUCT</span>
            <h2>
              A short tour, <span className="ser">on every screen.</span>
            </h2>
          </div>
          <p className="section-sub">
            The whole product on the laptop you trade with, the tablet you read
            on, and the phone you tap during the open.
          </p>

          <div className="stage">
            <div className="device-cluster">
              {/* ═══════════ LAPTOP ═══════════ */}
              <div className="laptop">
                <div className="lid">
                  <div className="scr">
                    <div className="chrome">
                      <span className="dots">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="url">
                        <svg
                          className="lock"
                          width="9"
                          height="9"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect
                            x="3"
                            y="11"
                            width="18"
                            height="11"
                            rx="2"
                            ry="2"
                          />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        app.usemoney.ai/dashboard?view=chat
                      </span>
                      <span className="right">
                        <span className="d" />4 brokers · LIVE
                      </span>
                    </div>
                    <div className="lt-body">
                      {/* SIDEBAR */}
                      <aside className="lt-side">
                        <div className="brand">
                          <span className="m">U</span>
                          <b>UseMoney</b>
                        </div>

                        <div className="sec-lab">
                          WORKSPACE
                          <span className="l" />
                        </div>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect x="3" y="3" width="7" height="9" />
                              <rect x="14" y="3" width="7" height="5" />
                              <rect x="14" y="12" width="7" height="9" />
                              <rect x="3" y="16" width="7" height="5" />
                            </svg>
                          </span>
                          <span>Dashboard</span>
                        </a>
                        <a className="on">
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="m12 3-1.9 5.8L4 10.6l4.8 3.5L7 20l5-3.6 5 3.6-1.8-5.9L20 10.6l-6.1-1.8z" />
                            </svg>
                          </span>
                          <span>StockSage</span>
                          <span className="badge">AI</span>
                        </a>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
                              <path d="M22 12A10 10 0 0 0 12 2v10z" />
                            </svg>
                          </span>
                          <span>Holdings</span>
                        </a>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </span>
                          <span>Watchlists</span>
                        </a>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                            </svg>
                          </span>
                          <span>Tradebook</span>
                        </a>
                        <a className="c-pink">
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                            </svg>
                          </span>
                          <span>Portfolio Roast</span>
                        </a>

                        <div className="sec-lab">
                          DISCOVER
                          <span className="l" />
                        </div>
                        <a className="c-blue">
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                            </svg>
                          </span>
                          <span>Markets</span>
                        </a>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="11" cy="11" r="8" />
                              <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                          </span>
                          <span>Screener</span>
                        </a>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                            </svg>
                          </span>
                          <span>Strategies</span>
                        </a>
                        <a>
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M4 22h16a2 2 0 0 0 2-2V8l-7-7H6a2 2 0 0 0-2 2v3" />
                              <path d="M14 2v6h6" />
                            </svg>
                          </span>
                          <span>News &amp; Events</span>
                        </a>

                        <div className="sec-lab">
                          TOOLS
                          <span className="l" />
                        </div>
                        <a className="c-coral">
                          <span className="ic">
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="12" cy="12" r="10" />
                              <circle cx="12" cy="12" r="6" />
                              <circle cx="12" cy="12" r="2" />
                            </svg>
                          </span>
                          <span>FIRE Calculator</span>
                        </a>
                        {/* Paper Trading mock-sidebar entry removed 2026-05-28 per product decision. */}
                      </aside>

                      {/* MAIN */}
                      <main className="lt-main">
                        <div className="lt-head">
                          <div>
                            <div className="crumb">
                              StockSage › Analysis › INFY (Infosys Ltd)
                            </div>
                            <h1>
                              Good evening, Shaswat.{" "}
                              <span className="ser">your sage is up.</span>
                            </h1>
                          </div>
                          <div className="qa">
                            <span>⌘ K</span>
                            <span>NEW CHAT</span>
                          </div>
                        </div>

                        {/* MTM strip */}
                        <div className="lt-mtm">
                          <span className="live">
                            <span className="d" />
                            LIVE
                          </span>
                          <div className="cell">
                            <div className="l">TODAY&apos;S P&amp;L</div>
                            <div className="v big em">+₹42,180</div>
                          </div>
                          <div className="cell">
                            <div className="l">VALUE</div>
                            <div className="v">₹17.24L</div>
                          </div>
                          <div className="cell">
                            <div className="l">XIRR</div>
                            <div className="v em">+18.6%</div>
                          </div>
                          <div className="cell">
                            <div className="l">UNREALIZED</div>
                            <div className="v em">+₹2.41L</div>
                          </div>
                        </div>

                        {/* Two-col body */}
                        <div className="lt-grid">
                          <div className="lt-card lt-sage">
                            <div className="ch">
                              <span className="lab">
                                SAGE · L2 RESEARCH · INFY
                              </span>
                              <span className="pill">cited · 14 rows</span>
                            </div>
                            <div className="verdict">
                              <b>Verdict ·</b> Margin expansion holding above
                              200 bps for three consecutive quarters. Forward PE
                              24.3× vs sector 27.8× — relative discount despite
                              quality.
                            </div>
                            <div className="stats">
                              <div className="stat">
                                <div className="l">P / E</div>
                                <div className="v">24.3×</div>
                              </div>
                              <div className="stat">
                                <div className="l">ROE</div>
                                <div className="v">28.1%</div>
                              </div>
                              <div className="stat">
                                <div className="l">REV YoY</div>
                                <div className="v em">+14.2%</div>
                              </div>
                              <div className="stat">
                                <div className="l">Δ MARG</div>
                                <div className="v em">+340bp</div>
                              </div>
                            </div>
                            <div className="chart">
                              <svg
                                viewBox="0 0 400 76"
                                preserveAspectRatio="none"
                                width="100%"
                                height="100%"
                              >
                                <defs>
                                  <linearGradient
                                    id="cgd"
                                    x1="0"
                                    x2="0"
                                    y1="0"
                                    y2="1"
                                  >
                                    <stop
                                      offset="0%"
                                      stopColor="#34d399"
                                      stopOpacity="0.5"
                                    />
                                    <stop
                                      offset="100%"
                                      stopColor="#34d399"
                                      stopOpacity="0"
                                    />
                                  </linearGradient>
                                </defs>
                                <path
                                  d="M0,52 L25,50 L50,55 L75,46 L100,48 L125,40 L150,42 L175,32 L200,36 L225,28 L250,24 L275,18 L300,22 L325,12 L350,16 L375,8 L400,4 L400,76 L0,76 Z"
                                  fill="url(#cgd)"
                                />
                                <path
                                  d="M0,52 L25,50 L50,55 L75,46 L100,48 L125,40 L150,42 L175,32 L200,36 L225,28 L250,24 L275,18 L300,22 L325,12 L350,16 L375,8 L400,4"
                                  fill="none"
                                  stroke="#34d399"
                                  strokeWidth="1.6"
                                />
                              </svg>
                            </div>
                          </div>
                          <div className="lt-card lt-hold">
                            <div className="ch">
                              <span className="lab">TOP HOLDINGS</span>
                              <span className="pill">4 brokers</span>
                            </div>
                            <div className="row">
                              <span className="br z">Z</span>
                              <span className="sym">RELIANCE</span>
                              <span className="px">₹2,487</span>
                              <span className="ch pos">+2.1%</span>
                            </div>
                            <div className="row">
                              <span className="br g">G</span>
                              <span className="sym">HDFCBANK</span>
                              <span className="px">₹1,743</span>
                              <span className="ch pos">+0.6%</span>
                            </div>
                            <div className="row">
                              <span className="br u">U</span>
                              <span className="sym">TCS</span>
                              <span className="px">₹3,821</span>
                              <span className="ch neg">−0.3%</span>
                            </div>
                            <div className="row">
                              <span className="br a">A</span>
                              <span className="sym">INFY</span>
                              <span className="px">₹1,654</span>
                              <span className="ch pos">+1.8%</span>
                            </div>
                            <div className="row">
                              <span className="br z">Z</span>
                              <span className="sym">ITC</span>
                              <span className="px">₹437</span>
                              <span className="ch pos">+1.1%</span>
                            </div>
                            <div className="row">
                              <span className="br g">G</span>
                              <span className="sym">SBIN</span>
                              <span className="px">₹812</span>
                              <span className="ch pos">+0.8%</span>
                            </div>
                          </div>
                        </div>
                      </main>

                      {/* RAIL */}
                      <aside className="lt-rail">
                        <div className="lab">BROKERS · 4 SYNCED</div>
                        <div className="brokers">
                          <div className="br-card">
                            <div
                              className="ic"
                              style={{ background: "#387ed1" }}
                            >
                              Z
                            </div>
                            <div className="nm">ZERODHA</div>
                            <div className="ok">● synced</div>
                          </div>
                          <div className="br-card">
                            <div
                              className="ic"
                              style={{ background: "#5eb66e" }}
                            >
                              G
                            </div>
                            <div className="nm">GROWW</div>
                            <div className="ok">● synced</div>
                          </div>
                          <div className="br-card">
                            <div
                              className="ic"
                              style={{ background: "#7b2ff7" }}
                            >
                              U
                            </div>
                            <div className="nm">UPSTOX</div>
                            <div className="ok">● synced</div>
                          </div>
                          <div className="br-card">
                            <div
                              className="ic"
                              style={{ background: "#e85454" }}
                            >
                              A
                            </div>
                            <div className="nm">ANGEL</div>
                            <div className="ok">● synced</div>
                          </div>
                        </div>

                        <div className="askbox">
                          <div className="head">
                            <span className="st">
                              <svg
                                width="8"
                                height="8"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="m12 3-1.9 5.8L4 10.6l4.8 3.5L7 20l5-3.6 5 3.6-1.8-5.9L20 10.6l-6.1-1.8z" />
                              </svg>
                            </span>
                            ASK SAGE · / TO START
                          </div>
                          <div className="field">
                            <b>Suggested</b>“Roast my portfolio.” “XIRR vs
                            NIFTY?”
                          </div>
                          <div className="chips">
                            <span>+ Compare</span>
                            <span>+ Save</span>
                            <span>+ Export</span>
                          </div>
                        </div>
                      </aside>
                    </div>
                  </div>
                  <div className="base" />
                </div>
              </div>

              {/* ═══════════ TABLET ═══════════ */}
              <div className="tablet">
                <span className="tb-label">TABLET · HOLDINGS</span>
                <div className="scr">
                  <div className="tb-top">
                    <span className="m">U</span>
                    <span className="ttl">Holdings</span>
                    <span className="pill">● LIVE</span>
                  </div>
                  <div className="tb-body">
                    <div className="tb-page-head">
                      <h2>
                        147 instruments,{" "}
                        <span className="ser">across 4 brokers.</span>
                      </h2>
                      <div className="sub">
                        Reconciled in 90 seconds. Tap any row to ask StockSage.
                      </div>
                    </div>
                    <div className="tb-pills">
                      <span className="p on">
                        ALL <span className="ct">147</span>
                      </span>
                      <span className="p">
                        EQ <span className="ct">112</span>
                      </span>
                      <span className="p">
                        MF <span className="ct">28</span>
                      </span>
                      <span className="p">
                        ETF <span className="ct">7</span>
                      </span>
                    </div>
                    <div className="tb-holdtab">
                      <div className="head">
                        <span />
                        <span>SYMBOL</span>
                        <span className="ar">LTP</span>
                        <span className="ar">DAY</span>
                      </div>
                      <div className="r">
                        <span className="br z">Z</span>
                        <div className="sym">
                          <span className="s">RELIANCE</span>
                          <span className="q">42 sh · ₹104,454</span>
                        </div>
                        <span className="px">₹2,487</span>
                        <span className="ch pos">+2.1%</span>
                      </div>
                      <div className="r">
                        <span className="br g">G</span>
                        <div className="sym">
                          <span className="s">HDFCBANK</span>
                          <span className="q">18 sh · ₹31,374</span>
                        </div>
                        <span className="px">₹1,743</span>
                        <span className="ch pos">+0.6%</span>
                      </div>
                      <div className="r">
                        <span className="br u">U</span>
                        <div className="sym">
                          <span className="s">TCS</span>
                          <span className="q">7 sh · ₹26,747</span>
                        </div>
                        <span className="px">₹3,821</span>
                        <span className="ch neg">−0.3%</span>
                      </div>
                      <div className="r">
                        <span className="br a">A</span>
                        <div className="sym">
                          <span className="s">INFY</span>
                          <span className="q">24 sh · ₹39,696</span>
                        </div>
                        <span className="px">₹1,654</span>
                        <span className="ch pos">+1.8%</span>
                      </div>
                      <div className="r">
                        <span className="br z">Z</span>
                        <div className="sym">
                          <span className="s">ITC</span>
                          <span className="q">110 sh · ₹48,070</span>
                        </div>
                        <span className="px">₹437</span>
                        <span className="ch pos">+1.1%</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ═══════════ PHONE ═══════════ */}
              <div className="phone">
                <span className="ph-label">PHONE · STOCKSAGE</span>
                <div className="scr">
                  <div className="notch" />
                  <div className="ph-stbar">
                    <span>9:41</span>
                    <span
                      style={{
                        display: "inline-flex",
                        gap: 5,
                        alignItems: "center",
                      }}
                    >
                      5G
                      <span className="b" />
                    </span>
                  </div>
                  <div className="ph-ssbar">
                    <span className="ico">
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="19" y1="12" x2="5" y2="12" />
                        <polyline points="12 19 5 12 12 5" />
                      </svg>
                    </span>
                    <span className="t">
                      StockSage<small>● FLASH · 4 BROKERS</small>
                    </span>
                    <span className="cr">4/5</span>
                  </div>
                  <div className="ph-body">
                    <div className="ph-you">
                      @INFY fundamentals &amp; momentum?
                    </div>
                    <div className="ph-meta">
                      <span className="st">
                        <svg
                          width="6"
                          height="6"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="m12 3-1.9 5.8L4 10.6l4.8 3.5L7 20l5-3.6 5 3.6-1.8-5.9L20 10.6l-6.1-1.8z" />
                        </svg>
                      </span>
                      SAGE · L2 · INFY
                    </div>
                    <div className="ph-sage">
                      <div className="h">
                        Infosys — <span className="ser">healthy.</span>
                      </div>
                      <div className="v">
                        <b>Verdict ·</b> margins above 200bps three quarters
                        running. PE 24.3× vs sector 27.8×.
                      </div>
                      <div className="stats">
                        <div className="stat">
                          <div className="l">P/E</div>
                          <div className="v2">24.3×</div>
                        </div>
                        <div className="stat">
                          <div className="l">ROE</div>
                          <div className="v2">28.1%</div>
                        </div>
                        <div className="stat">
                          <div className="l">REV</div>
                          <div className="v2 em">+14.2%</div>
                        </div>
                        <div className="stat">
                          <div className="l">Δ MRG</div>
                          <div className="v2 em">+340bp</div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="ph-composer">
                    <span className="pl">Ask StockSage anything…</span>
                    <div className="row">
                      <div className="tools">
                        <span className="t plus">
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.6"
                            strokeLinecap="round"
                          >
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                          </svg>
                        </span>
                        <span className="t">
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                          >
                            <circle cx="12" cy="12" r="4" />
                            <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
                          </svg>
                        </span>
                        <span className="t">
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.6"
                            strokeLinecap="round"
                          >
                            <line x1="17" y1="5" x2="7" y2="19" />
                          </svg>
                        </span>
                      </div>
                      <span className="s">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                        Send
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ═══════════ ANNOTATIONS ═══════════ */}
              <div className="annot a1">
                <span className="arr">↪</span> full sidebar,{" "}
                <b>every surface</b> — 18 routes, one keystroke away.
              </div>
              <div className="annot a2">
                <span className="arr">↩</span> the right rail is your{" "}
                <b>broker quilt</b>.
              </div>
              <div className="annot a3">
                <span className="arr">↑</span> read-only on the iPad,{" "}
                <b>over chai</b>.
              </div>
              <div className="annot a4">
                <span className="arr">＋</span> StockSage on the platform
                between trains.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 4: THE FOUNDATION ────────────────────────────────── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">03 / FOUNDATION</span>
            <h2>
              Every broker, one portfolio.{" "}
              <span className="ser">So the AI sees what you actually own.</span>
            </h2>
          </div>

          <p className="section-body">
            Five broker tabs and a Google sheet is not how anyone should run a
            ₹15-lakh portfolio. Connect once via official OAuth and your
            holdings, positions, and trade history sync across all eight brokers
            we support. That unified view is what makes the AI useful: when
            StockSage talks about your concentration risk, it&apos;s talking
            about the real one, not the one in your head.
          </p>

          <div className="broker-strip">
            {BROKERS.map(({ slug, name, note }) => (
              <div className="broker-chip" key={slug}>
                <span className="broker-initial">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/brokers/${slug}.png`} alt={name} />
                </span>
                <span className="broker-name">
                  {name}
                  {note ? <span className="broker-note">{note}</span> : null}
                </span>
              </div>
            ))}
          </div>

          <div className="section-caption">
            8 brokers · NSE + BSE · 14,000+ mutual funds · Read-only OAuth — we
            never place orders.
          </div>
        </div>
      </section>

      {/* ── SECTION 5: FOR WHEN YOU WANT TO GO DEEPER ───────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">04 / HOW</span>
            <h2>
              Three things, <span className="ser">then you&apos;re set.</span>
            </h2>
          </div>
          <p className="section-sub">
            No long onboarding. No &quot;schedule a demo.&quot; Connect a broker
            and start asking.
          </p>

          <div className="newsprint">
            <div className="step">
              <span className="n">STEP 01</span>
              <h4>
                Connect <span className="ser">a broker.</span>
              </h4>
              <p>
                OAuth into Zerodha (or Groww, Angel, Upstox, Dhan, Fyers, HDFC
                Sky, ICICI). Read-only — we never place orders. Holdings sync in
                roughly 90 seconds.
              </p>
              <code className="code-block">
                <span className="emerald">→</span> sync · zerodha
                <br />
                holdings · 47 instruments
                <br />
                positions · 3<br />
                tradebook · 2,114 rows
              </code>
            </div>
            <div className="step">
              <span className="n">STEP 02</span>
              <h4>
                Ask <span className="ser">anything.</span>
              </h4>
              <p>
                &quot;What&apos;s my XIRR vs NIFTY?&quot; &quot;Show IT stocks
                with margin growth.&quot; &quot;Roast this portfolio.&quot;
                StockSage routes to the right model — simple chats are free;
                deep research costs 1-3 credits.
              </p>
              <code className="code-block">
                <span className="emerald">you ›</span> roast my portfolio
                <br />
                <span className="emerald">sage ›</span> 38% IT concentration, no
                debt
                <br />
                fund exposure, 1 dud (avg buy ₹420 vs
                <br />
                cmp ₹287, -32%).
              </code>
            </div>
            <div className="step">
              <span className="n">STEP 03</span>
              <h4>
                Then <span className="ser">trade like you mean it.</span>
              </h4>
              <p>
                Build rule-based strategies and backtest them on 10+ years of
                history. Plan your FIRE date in INR. Export ITR-ready capital
                gains when April rolls around.
              </p>
              <code className="code-block">
                <span className="emerald">backtest ›</span> golden_cross /
                NIFTY50
                <br />
                cagr · 14.7% · sharpe · 1.31
                <br />
                mdd · -18.4% · trades · 41
                <br />
                win-rate · 58.5%
              </code>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 6: WHY (restored from 35a3ec3c, Multibagg → Multibagg AI) */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">05 / WHY</span>
            <h2>
              Why not the <span className="ser">other ones.</span>
            </h2>
          </div>
          <p className="section-sub">
            Not a hit-piece. Just where we differ — one AI-native peer
            (Multibagg AI) and the two tools you already know.
          </p>

          <div className="tbl-scroll" style={{ marginTop: 28 }}>
            <table className="compare-tbl">
              <thead>
                <tr>
                  <th style={{ width: "32%" }}>Capability</th>
                  <th>UseMoney AI</th>
                  <th>Multibagg AI</th>
                  <th>Smallcase</th>
                  <th>Tickertape</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="feat">AI chat on YOUR portfolio</td>
                  <td className="um">Yes · 5 free / mo</td>
                  <td>Ask Portfolio</td>
                  <td className="no">No</td>
                  <td className="no">No</td>
                </tr>
                <tr>
                  <td className="feat">Broker sync (read-only)</td>
                  <td className="um">8 brokers</td>
                  <td>3 brokers</td>
                  <td>13+</td>
                  <td>16+</td>
                </tr>
                <tr>
                  <td className="feat">No-code strategy builder</td>
                  <td className="um">Yes</td>
                  <td className="no">No</td>
                  <td className="no">Baskets</td>
                  <td className="no">No</td>
                </tr>
                <tr>
                  <td className="feat">Backtesting (walk-forward)</td>
                  <td className="um">Yes</td>
                  <td className="no">No</td>
                  <td className="no">No</td>
                  <td className="no">No</td>
                </tr>
                <tr>
                  <td className="feat">FIRE calculator (INR)</td>
                  <td className="um">Yes</td>
                  <td className="no">No</td>
                  <td className="no">No</td>
                  <td>Basic SIP</td>
                </tr>
                <tr>
                  <td className="feat">ITR capital-gains report</td>
                  <td className="um">Yes</td>
                  <td className="no">No</td>
                  <td className="no">No</td>
                  <td className="no">No</td>
                </tr>
                <tr>
                  <td className="feat">Starting paid price</td>
                  <td className="um">
                    <span className="small">₹249/mo</span>
                  </td>
                  <td>
                    <span className="small">₹999/mo</span>
                  </td>
                  <td>
                    <span className="small">per-basket</span>
                  </td>
                  <td>
                    <span className="small">₹2,399/yr</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 24 }}>
            <Link className="btn-flat" href="/alternatives">
              See the full comparison — 11 tools, both tiers →
            </Link>
          </div>
        </div>
      </section>

      {/* ── SECTION 7: FOUNDER NOTE ──────────────────────────────────── */}
      <section className="section founder-section">
        <div className="container">
          <div className="section-h">
            <span className="num">06 / CUSTOMER ZERO</span>
            <h2>
              <b>I built the tool</b>{" "}
              <span className="ser">I always wanted.</span>
            </h2>
          </div>

          <div className="founder-body">
            <p>
              I&apos;m an Indian retail investor. Money spread across three
              brokers, a spreadsheet I updated by hand, and a WhatsApp group
              full of &quot;sure-shot&quot; tips I never quite trusted. And one
              question I could never actually answer: is my portfolio any good —
              or am I just getting lucky?
            </p>
            <p>
              I&apos;m also a software engineer — twelve years of it. So when no
              Indian product would answer that question honestly, I built one.
              For myself, first. Every feature in UseMoney exists because I
              needed it for my own money before anyone else did.
            </p>
            <p>
              Turns out I wasn&apos;t the only one. We&apos;re a few months into
              beta now — bootstrapped, solo, growing every week on word of mouth
              from people who had the exact same problem I did.
            </p>
            <div className="founder-sig">— Shaswat Deep, founder</div>
          </div>

          <div style={{ marginTop: 32 }}>
            <Link className="btn-flat" href="/about">
              Read the full story →
            </Link>
          </div>
        </div>
      </section>

      {/* ── SECTION 8: PRICING (tiles cloned from /pricing/client.tsx) ── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h" style={{ marginBottom: 0 }}>
            <span className="num">07 / PRICING</span>
            <h2>
              Pricing that&apos;s{" "}
              <span className="ser">actually for retail investors.</span>
            </h2>
          </div>

          {/* Billing cycle toggle */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginTop: 28,
              marginBottom: 38,
            }}
          >
            <div className="cycle-tog">
              <button
                className={cycle === "monthly" ? "on" : ""}
                onClick={() => setCycle("monthly")}
              >
                Monthly
              </button>
              <button
                className={cycle === "annual" ? "on" : ""}
                onClick={() => setCycle("annual")}
              >
                Annual{" "}
                <span className="save">SAVE up to {maxAnnualDiscount}%</span>
              </button>
            </div>
          </div>

          <div className="price-grid">
            {/* FREE */}
            <div className="pcard">
              <div className="tier">
                Free
                <span className="blurb">For everyone, no card required</span>
              </div>
              <div className="price-row">
                <span className="price">₹0</span>
                <span className="per">forever</span>
              </div>
              <div className="period">
                {PLAN_CONFIG.FREE.credits} credits / month
              </div>
              <ul>
                <li>Unlimited StockSage chat (Flash)</li>
                <li>{PLAN_CONFIG.FREE.credits} research credits / month</li>
                <li>FIRE Calculator</li>
                <li>Manual tradebook &amp; portfolio</li>
                <li>1 broker · 30-day intro</li>
                <li className="muted">Live broker sync after 30 days</li>
                <li className="muted">Live discovery &amp; charting</li>
              </ul>
              <Link className="pcta" href={authed ? "/dashboard" : "/sign-up"}>
                {authed ? "Go to dashboard →" : "Start free →"}
              </Link>
            </div>

            {/* PRO — featured */}
            <div className="pcard feat yellow-surface" data-bg="yellow">
              <div className="badge off">
                🔥 {cycle === "monthly" ? "50% OFF" : "60% OFF"}
              </div>
              <div className="badge">LAUNCH</div>
              <div className="tier">
                PRO
                <span className="blurb">
                  {PRO.credits} credits / month · the sweet spot
                </span>
              </div>
              {cycle === "monthly" ? (
                <>
                  <div className="price-row">
                    <span className="price">
                      {INR(PRO.monthlyPrice ?? 249)}
                    </span>
                    <span className="strike">
                      {INR(PRO.monthlyOriginalPrice ?? 499)}
                    </span>
                    <span className="per">/month</span>
                  </div>
                  <div className="period">Billed monthly · cancel anytime</div>
                </>
              ) : (
                <>
                  <div className="price-row">
                    <span className="price">
                      {INR(PRO.annualPrice ?? 1999)}
                    </span>
                    <span className="strike">
                      {INR(PRO.annualOriginalPrice ?? 4999)}
                    </span>
                    <span className="per">/year</span>
                  </div>
                  <div className="period">
                    ~{INR(annualMonthly(PRO.annualPrice ?? 1999))}/mo · billed
                    annually · save{" "}
                    {INR(
                      annualSavings(
                        PRO.monthlyPrice ?? 249,
                        PRO.annualPrice ?? 1999
                      )
                    )}
                  </div>
                </>
              )}
              <ul>
                <li>Everything in Free</li>
                <li>{PRO.credits} research credits / month</li>
                <li>Unlimited broker sync (all 8 brokers)</li>
                <li>Unlimited holdings &amp; positions sync</li>
                <li>Stock &amp; MF discovery with live data</li>
                <li>No-code strategy builder</li>
                <li>Backtesting on historical NSE data</li>
                <li>Purchase additional credit packs</li>
              </ul>
              <Link className="pcta" href={ctaHref("PRO")}>
                Go PRO →
              </Link>
            </div>

            {/* PREMIUM */}
            <div className="pcard">
              <div className="badge off" style={{ background: "var(--pop-5)" }}>
                50% OFF
              </div>
              <div className="tier">
                Premium
                <span className="blurb">
                  {PREMIUM.credits} credits + AI strategy builder
                </span>
              </div>
              {cycle === "monthly" ? (
                <>
                  <div className="price-row">
                    <span className="price">{INR(PREMIUM.price)}</span>
                    <span className="strike">
                      {INR(PREMIUM.originalPrice ?? 2999)}
                    </span>
                    <span className="per">/month</span>
                  </div>
                  <div className="period">Billed monthly · cancel anytime</div>
                </>
              ) : (
                <>
                  <div className="price-row">
                    <span className="price">
                      {INR(PREMIUM.annualPrice ?? 14990)}
                    </span>
                    <span className="strike">
                      {INR(PREMIUM.annualOriginalPrice ?? 17988)}
                    </span>
                    <span className="per">/year</span>
                  </div>
                  <div className="period">
                    ~{INR(annualMonthly(PREMIUM.annualPrice ?? 14990))}/mo ·
                    billed annually · save{" "}
                    {INR(
                      annualSavings(PREMIUM.price, PREMIUM.annualPrice ?? 14990)
                    )}
                  </div>
                </>
              )}
              <ul>
                <li>Everything in PRO</li>
                <li>{PREMIUM.credits} research credits / month</li>
                <li>Portfolio analysis with StockSage</li>
                <li>Build trading strategies with StockSage</li>
                <li>Personalized learning modules</li>
                <li>Higher concurrency (5 parallel L2 runs)</li>
                <li>Priority support · &lt;24h response</li>
                <li>Purchase additional credit packs</li>
              </ul>
              <Link className="pcta" href={ctaHref("PREMIUM")}>
                Go Premium
              </Link>
            </div>
          </div>

          <div style={{ marginTop: 32 }}>
            <Link className="btn-flat" href="/pricing">
              See full pricing →
            </Link>
          </div>
        </div>
      </section>

      {/* ── SECTION 9: FAQ (restored from 35a3ec3c) ──────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">08 / FAQ</span>
            <h2>
              Questions <span className="ser">we get a lot.</span>
            </h2>
          </div>

          <details className="faq" open>
            <summary>How does pricing actually work?</summary>
            <div className="ans">
              Free forever with 5 credits/month.{" "}
              <span className="ser">PRO is ₹249/month or ₹1,999/year</span> (50%
              and 60% off respectively) for 50 credits/month and unlimited
              broker sync. Premium is ₹1,499/month / ₹14,990/year for 200
              credits and AI-assisted portfolio analysis. Credit packs (50 / 100
              / 250 / 500 / 1,000 credits) never expire.
            </div>
          </details>
          <details className="faq">
            <summary>How do AI credits work?</summary>
            <div className="ans">
              Simple chats are free.{" "}
              <span className="ser">Research credits</span> are spent on deeper
              work — multi-step research costs 1-3 credits, comprehensive stock
              dives cost ~10, comparisons across 5 stocks cost ~40. The system
              auto-routes to the right model for the question.
            </div>
          </details>
          <details className="faq">
            <summary>Can you place orders for me?</summary>
            <div className="ans">
              No. <span className="ser">We use read-only OAuth.</span> We can
              see your holdings and tradebook; we cannot place, modify, or
              cancel orders. This is by design, and we&apos;d like to keep it
              that way.
            </div>
          </details>
          <details className="faq">
            <summary>
              What if I&apos;m on a broker you don&apos;t support?
            </summary>
            <div className="ans">
              CSV import works for everything.{" "}
              <span className="ser">We add brokers based on user volume</span> —
              write to us and tell us which one.
            </div>
          </details>
          <details className="faq">
            <summary>Is my data safe?</summary>
            <div className="ans">
              256-bit AES-GCM encryption at rest, TLS in transit, isolated
              MongoDB per region, and broker tokens stored encrypted with
              rotation.{" "}
              <span className="ser">
                No personally identifiable data ever leaves our cloud.
              </span>{" "}
              Full details on the <Link href="/security">security page</Link>.
            </div>
          </details>
        </div>
      </section>

      {/* ── BIG CTA ──────────────────────────────────────────────────── */}
      <section className="big-cta">
        <div className="container">
          <h2>
            Ready to <span className="hl">Use Money</span>{" "}
            <span className="ser">intelligently?</span>
          </h2>
          <p>
            Start free. 5 AI credits/month forever. Upgrade only if it earns it.
          </p>
          <div className="cta-row">
            <Link className="btn-solid" href={primaryHref}>
              {primaryLabel}
            </Link>
            <Link className="btn-flat" href="/features">
              See how it works
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
