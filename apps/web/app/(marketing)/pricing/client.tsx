"use client";

import "./page.css";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { PLAN_CONFIG, CREDIT_PACKS } from "@usemoney/core/subscription";
import { capturePromoFromUrl } from "@/lib/promo";

type Cycle = "monthly" | "annual";

const PRO = PLAN_CONFIG.PRO;
const PREMIUM = PLAN_CONFIG.PREMIUM;

const INR = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export default function PricingClient() {
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const { isLoaded, isSignedIn } = useUser();

  // MONEY-385: capture a ?promo=CODE from the marketing CTA so the in-app
  // upgrade dialog pre-fills the coupon.
  useEffect(() => {
    capturePromoFromUrl();
  }, []);

  // CTAs: signed-in → settings (where in-app checkout lives);
  // signed-out → /sign-up so user creates an account first.
  // Guard with isLoaded so we don't flash the wrong CTA during Clerk init.
  const authed = isLoaded && isSignedIn;
  const ctaHref = (plan: "PRO" | "PREMIUM") =>
    authed ? `/settings?upgrade=${plan}` : `/sign-up?plan=${plan}`;

  const annualMonthly = (annual: number) => Math.round(annual / 12);
  const annualSavings = (monthly: number, annual: number) =>
    monthly * 12 - annual;
  // Derive max annual discount from plan config so badge never drifts.
  const annualDiscountPct = (monthly: number, annual: number) =>
    monthly > 0 ? Math.round((1 - annual / (monthly * 12)) * 100) : 0;
  const maxAnnualDiscount = Math.max(
    annualDiscountPct(PRO.monthlyPrice ?? 249, PRO.annualPrice ?? 1999),
    annualDiscountPct(PREMIUM.price, PREMIUM.annualPrice ?? 14990)
  );

  return (
    <>
      {/* ── PAGE HEAD ────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Pricing · launch window · up to 60% off
          </div>
          <h1>
            Free forever. <span className="ser">Paid plans</span> from{" "}
            <span className="hl">{INR(PRO.monthlyPrice ?? 249)}/mo.</span>
          </h1>
          <p className="lede">
            No subscription traps. Free is real, with{" "}
            <b>{PLAN_CONFIG.FREE.credits} credits a month, forever.</b> Paid
            plans are monthly or annual — annual saves up to 60%. Credit packs
            never expire.
          </p>
        </div>
      </section>

      {/* ── PLAN TILES ───────────────────────────────────────────── */}
      <section className="section">
        <div className="container">
          {/* Billing cycle toggle */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
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

          <p
            style={{
              textAlign: "center",
              marginTop: 28,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: "var(--ink-3)",
              letterSpacing: "0.3px",
            }}
          >
            All plans · 256-bit encryption · read-only OAuth · SEBI-aligned risk
            disclosure · GST included
          </p>
        </div>
      </section>

      {/* ── CREDIT PACKS ─────────────────────────────────────────── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">02 / PACKS</span>
            <h2>
              Credit packs that <span className="ser">never expire.</span>
            </h2>
          </div>
          <p className="section-sub">
            Top up when the AI is earning its keep. Pro and Premium only.
            Carries forward indefinitely — no pressure to burn through them.
          </p>

          <div className="packs-grid" style={{ marginTop: 36 }}>
            {CREDIT_PACKS.map((pack, i) => {
              const isBest = pack.credits === 500;
              return (
                <div
                  key={pack.id}
                  className={`pack ${isBest ? "best yellow-surface" : ""}`}
                  data-bg={isBest ? "yellow" : undefined}
                >
                  <div className="c">
                    {pack.credits.toLocaleString("en-IN")}
                  </div>
                  <div className="l">
                    credits
                    {isBest
                      ? " · popular"
                      : i === CREDIT_PACKS.length - 1
                        ? " · best rate"
                        : ""}
                  </div>
                  <div className="p">{INR(pack.price)}</div>
                  <div className="pp">
                    ₹{pack.perCredit.toFixed(1)} / credit
                  </div>
                  <Link
                    className="buy"
                    href={authed ? "/settings?packs=1" : "/sign-up"}
                  >
                    Buy
                  </Link>
                </div>
              );
            })}
          </div>

          <p
            style={{
              textAlign: "center",
              marginTop: 26,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12.5,
              color: "var(--ink-3)",
            }}
          >
            Simple chats are{" "}
            <strong style={{ color: "var(--emerald-text)" }}>free.</strong>{" "}
            Research credits power deep work — l2 research costs 1-3 ·
            comprehensive stock dive ~10 · 5-stock comparison ~40 · portfolio
            roast 5.
          </p>
        </div>
      </section>

      {/* ── COMPARE (restored from 35a3ec3c, Ultimate column dropped) */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">03 / COMPARE</span>
            <h2>
              Feature by feature, <span className="ser">tier by tier.</span>
            </h2>
          </div>

          <div className="ctbl-wrap">
            <table className="ctbl">
              <thead>
                <tr>
                  <th style={{ width: "42%" }}>Feature</th>
                  <th>Free</th>
                  <th className="feat-col">PRO</th>
                  <th>Premium</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Monthly price</td>
                  <td>₹0</td>
                  <td>{INR(PRO.monthlyPrice ?? 249)}</td>
                  <td>{INR(PREMIUM.price)}</td>
                </tr>
                <tr>
                  <td>Annual price</td>
                  <td>—</td>
                  <td>{INR(PRO.annualPrice ?? 1999)}</td>
                  <td>{INR(PREMIUM.annualPrice ?? 14990)}</td>
                </tr>
                <tr>
                  <td>Research credits / month</td>
                  <td>{PLAN_CONFIG.FREE.credits}</td>
                  <td>{PRO.credits}</td>
                  <td>{PREMIUM.credits}</td>
                </tr>
                <tr>
                  <td>StockSage chat (Flash)</td>
                  <td className="ok">unlimited</td>
                  <td className="ok">unlimited</td>
                  <td className="ok">unlimited</td>
                </tr>
                <tr>
                  <td>Broker connections</td>
                  <td>1 · 30 days</td>
                  <td className="ok">unlimited</td>
                  <td className="ok">unlimited</td>
                </tr>
                <tr>
                  <td>Holdings &amp; positions sync</td>
                  <td>30-day trial</td>
                  <td className="ok">unlimited</td>
                  <td className="ok">unlimited</td>
                </tr>
                <tr>
                  <td>Live stock &amp; MF discovery</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>No-code strategy builder</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>Backtesting</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>FIRE Calculator</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>ITR capital-gains report</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>Portfolio analysis with AI</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>AI strategy builder</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>Advanced research (L3 + L4)</td>
                  <td className="no">—</td>
                  <td className="ok">L3 only</td>
                  <td className="ok">L3 + L4</td>
                </tr>
                <tr>
                  <td>Advanced AI models</td>
                  <td>Flash</td>
                  <td className="ok">Flash + Pro</td>
                  <td className="ok">Flash + Pro</td>
                </tr>
                <tr>
                  <td>Personalized learning</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>Parallel research runs (L2)</td>
                  <td>1</td>
                  <td>2</td>
                  <td>5</td>
                </tr>
                <tr>
                  <td>Priority support</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="ok">✓</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">04 / FAQ</span>
            <h2>
              Pricing questions, <span className="ser">answered.</span>
            </h2>
          </div>

          <div className="faq-list">
            <details className="faq" open>
              <summary>
                Is PRO really ₹249/month? What about the &ldquo;lifetime&rdquo;
                offer I saw?
              </summary>
              <div className="ans">
                PRO is ₹249/month or ₹1,999/year. We retired the one-time
                lifetime offer in our 2026 pricing reset. If you bought the old
                lifetime PRO, you keep it —{" "}
                <span className="ser">
                  email support@usemoney.ai if anything looks off.
                </span>
              </div>
            </details>

            <details className="faq">
              <summary>How do credits work?</summary>
              <div className="ans">
                One question costs 1–3 credits depending on complexity. A
                portfolio check or a price lookup is 1 credit. A multi-document
                earnings deep-dive on a stock you own is 2–3.{" "}
                <span className="ser">
                  The system picks the right Gemini model for the question — you
                  don&apos;t choose.
                </span>{" "}
                Unused credits in a credit pack never expire.
              </div>
            </details>

            <details className="faq">
              <summary>What happens when I run out of credits?</summary>
              <div className="ans">
                Everything that doesn&apos;t need AI keeps working. To keep
                asking StockSage, buy a credit pack (₹399 for 50, scaling to
                ₹3,999 for 1,000).{" "}
                <span className="ser">Credit packs never expire.</span>
              </div>
            </details>

            <details className="faq">
              <summary>Can I cancel or downgrade?</summary>
              <div className="ans">
                Anytime. Monthly plans stop at the end of the current month.
                Annual plans run until the end of the paid period and then drop
                to Free. <span className="ser">We never lock data.</span>
              </div>
            </details>

            <details className="faq">
              <summary>Is UseMoney SEBI-registered?</summary>
              <div className="ans">
                No. UseMoney is{" "}
                <span className="ser">
                  not a SEBI-registered Research Analyst or Investment Advisor.
                </span>{" "}
                All AI outputs are educational and informational. You make your
                own investment decisions. See the{" "}
                <Link href="/security">security &amp; compliance page</Link> for
                full details.
              </div>
            </details>
          </div>
        </div>
      </section>

      {/* ── DISCLOSURES ──────────────────────────────────────────── */}
      <section className="section" style={{ padding: "60px 0" }}>
        <div className="container-narrow">
          <div className="disclose">
            <div className="lab">Required disclosures</div>
            <p>
              UseMoney is not a SEBI-registered Research Analyst or Investment
              Advisor. All AI outputs are educational and informational only.
            </p>
            <p>
              StockSage is powered by Google Gemini via Vertex AI. The system
              routes each query to the appropriate model based on complexity.
              Market data may be delayed. Rate limits apply per plan tier.
            </p>
            <p>
              Investment decisions are solely your responsibility. Past
              performance is not indicative of future results.
            </p>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ────────────────────────────────────────────── */}
      <section className="big-cta">
        <div className="container">
          <h2>
            Stop paying <span className="hl">yearly traps.</span>
            <br />
            <span className="ser">Pay for what you use.</span>
          </h2>
          <p>
            Free is free. PRO is ₹249/mo. Premium is for power users.
            That&apos;s it.
          </p>
          <div className="cta-row">
            <Link
              className="btn-solid"
              href={authed ? "/dashboard" : "/sign-up"}
            >
              {authed ? "Go to dashboard →" : "Start free →"}
            </Link>
            <Link className="btn-flat" href="/features">
              Take the tour
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
