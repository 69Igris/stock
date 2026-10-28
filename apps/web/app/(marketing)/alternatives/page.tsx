import "./page.css";
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingAuthCta } from "../MarketingAuthCta";

export const metadata: Metadata = {
  title:
    "UseMoney vs Smallcase, Tickertape, Multibagg AI, INDmoney — honest comparison",
  description:
    "How UseMoney stacks up against the new breed of AI investing platforms and the legacy tools Indians have used for years. The intelligence layer is the moat — broker count isn't.",
};

export default function AlternativesPage() {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Compare · honest table, no hit pieces
          </div>
          <h1>
            How we <span className="ser">actually</span>{" "}
            <span className="hl">compare.</span>
          </h1>
          <p className="lede">
            Two comparisons — the new AI investing platforms and the legacy
            tools Indians have used for years.{" "}
            <span className="ser">Not a roast</span>: what each is good at, and
            where we&apos;re built different.
          </p>
        </div>
      </section>

      {/* 01 — NEW BREED MATRIX */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">01 / THE NEW BREED</span>
            <h2>
              vs the <span className="ser">AI-native</span> platforms.
            </h2>
          </div>
          <p className="section-sub">
            The recent wave of AI investing tools built for Indian markets. Each
            is strong in its lane — research, strategy, chat, or broking.
            We&apos;re the workspace that ties research to your real, reconciled
            book.
          </p>

          <div className="ctbl-wrap">
            <table className="ctbl">
              <thead>
                <tr>
                  <th style={{ width: "22%" }}>Capability</th>
                  <th className="us">UseMoney AI</th>
                  <th>Multibagg AI</th>
                  <th>Tradomate</th>
                  <th>Astor</th>
                  <th>Kalpi</th>
                  <th>Chanakya</th>
                  <th>Trackk</th>
                </tr>
              </thead>
              <tbody>
                <tr className="sec-row">
                  <td colSpan={8}>Your real portfolio</td>
                </tr>
                <tr>
                  <td>Multi-broker portfolio sync</td>
                  <td className="us">✓ 8 · read-only</td>
                  <td>3 · read-only</td>
                  <td className="no">—</td>
                  <td className="no">US only</td>
                  <td>broker-linked</td>
                  <td className="no">CSV upload</td>
                  <td className="no">own broker</td>
                </tr>
                <tr>
                  <td>Unified XIRR / P&amp;L across brokers</td>
                  <td className="us">✓</td>
                  <td>dashboard</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td>health report</td>
                  <td className="no">upload only</td>
                  <td className="no">own account</td>
                </tr>
                <tr>
                  <td>AI chat grounded in YOUR holdings</td>
                  <td className="us">✓ cite-and-audit</td>
                  <td>✓ Ask Portfolio</td>
                  <td className="no">stock-level</td>
                  <td>✓ US-only</td>
                  <td className="no">—</td>
                  <td>via upload</td>
                  <td className="no">—</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={8}>Research &amp; AI</td>
                </tr>
                <tr>
                  <td>AI stock research</td>
                  <td className="us">✓ multi-model</td>
                  <td>✓ Iris</td>
                  <td>✓ Circuit AI</td>
                  <td>✓ US stocks</td>
                  <td>✓ quant</td>
                  <td>✓ chat advisor</td>
                  <td>✓ screeners</td>
                </tr>
                <tr>
                  <td>Scanner / screener</td>
                  <td className="us">✓ 70+ indicators</td>
                  <td>fundamentals</td>
                  <td>✓ NL → rules</td>
                  <td className="no">—</td>
                  <td>✓ rule-based</td>
                  <td>fundamentals</td>
                  <td>✓ AI screens</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={8}>Strategy, planning &amp; tax</td>
                </tr>
                <tr>
                  <td>No-code strategy builder + backtest</td>
                  <td className="us">✓ walk-forward</td>
                  <td className="no">—</td>
                  <td>✓ 3-layer</td>
                  <td className="no">—</td>
                  <td>✓ quant</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>FIRE calculator · INR-native</td>
                  <td className="us">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">US-native</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>ITR-2 capital-gains export</td>
                  <td className="us">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">US tax</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={8}>Pricing &amp; access</td>
                </tr>
                <tr>
                  <td>Free tier</td>
                  <td className="us">✓ 5 credits/mo</td>
                  <td>✓ 10 prompts/mo</td>
                  <td className="ok">✓</td>
                  <td className="no">—</td>
                  <td>✓ free forever</td>
                  <td>✓ free core</td>
                  <td>✓ ₹0 a/c</td>
                </tr>
                <tr>
                  <td>Starting paid price</td>
                  <td className="us">₹249/mo</td>
                  <td>₹999/mo</td>
                  <td>free + paid</td>
                  <td>USD sub</td>
                  <td>₹499/mo</td>
                  <td>free + consult</td>
                  <td>₹20/trade</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={8}>Trust</td>
                </tr>
                <tr>
                  <td>Cannot place orders (read-only)</td>
                  <td className="us">✓ by design</td>
                  <td className="us">✓ research</td>
                  <td className="us">✓ research</td>
                  <td className="no">executes</td>
                  <td className="no">executes</td>
                  <td className="us">✓ advisory</td>
                  <td className="no">is a broker</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 02 — PAIRWISE (new breed) */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">02 / PAIRWISE</span>
            <h2>
              One-on-one with <span className="ser">the new breed.</span>
            </h2>
          </div>
          <p className="section-sub">
            Each of these is genuinely good at a focused slice. Here&apos;s
            where they win, and where the workspace approach wins.
          </p>

          <div className="verses" style={{ marginTop: 36 }}>
            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Multibagg AI</span>
              </div>
              <h3>
                If you want <span className="ser">document-deep research</span>,
                Multibagg AI is excellent.
              </h3>
              <p>
                Multibagg AI&apos;s Iris reads filings and concalls, and Ask
                Portfolio can reason over connected holdings — it&apos;s a
                serious research engine.{" "}
                <strong>We differ on the workspace around it</strong> —
                read-only OAuth across 8 brokers, plus the strategy builder,
                backtest, FIRE, and ITR layer Multibagg AI doesn&apos;t cover.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Multibagg AI strengths</h5>
                  <ul>
                    <li>Iris AI on filings &amp; concalls</li>
                    <li>Ask Portfolio (holdings-aware)</li>
                    <li>Fundamentals screener</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>8-broker read-only reconciliation</li>
                    <li>Strategy builder + backtest</li>
                    <li>FIRE planning in INR</li>
                    <li>ITR-2 Schedule CG export</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Tradomate</span>
              </div>
              <h3>
                If you want <span className="ser">AI screening + strategy</span>
                , Tradomate is close.
              </h3>
              <p>
                Tradomate is genuinely strong on the research-and-strategy side
                — a natural-language screener, a no-code strategy builder, and
                layered backtesting with its Circuit AI co-pilot.{" "}
                <strong>We add the portfolio half it doesn&apos;t do</strong> —
                reconciling your real brokers, plus FIRE and ITR tax.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Tradomate strengths</h5>
                  <ul>
                    <li>NL → rules screener</li>
                    <li>No-code strategy builder</li>
                    <li>Three-layer backtesting</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>Multi-broker reconciliation</li>
                    <li>AI chat on YOUR holdings</li>
                    <li>FIRE planning in INR</li>
                    <li>ITR-2 Schedule CG export</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Kalpi</span>
              </div>
              <h3>
                If you want <span className="ser">deep quant</span>, Kalpi is
                purpose-built.
              </h3>
              <p>
                Kalpi (Rainmatter-backed) is a no-code quant platform — build,
                backtest, and execute rule-based systematic strategies. If you
                live in factor models, <strong>that depth is its edge.</strong>{" "}
                We trade some depth for breadth: conversational research on your
                holdings, multi-broker reconciliation, FIRE, and tax — and we
                never execute.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Kalpi strengths</h5>
                  <ul>
                    <li>Quant / systematic depth</li>
                    <li>No-code rule strategies</li>
                    <li>Backtest + execute</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>AI chat on your holdings</li>
                    <li>Read-only — never executes</li>
                    <li>Multi-broker reconciliation</li>
                    <li>FIRE &amp; ITR-ready tax</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Chanakya</span>
              </div>
              <h3>
                If you want a <span className="ser">free AI advisor</span> to
                start, Chanakya is friendly.
              </h3>
              <p>
                Chanakya is a free, beginner-friendly AI advisor — a quick risk
                quiz, plain-English chat, and KEEP/SELL/ADD calls on holdings
                you upload as CSV. Both of us are educational, not
                SEBI-registered. <strong>We go deeper</strong> — live read-only
                sync across 8 brokers (vs an upload), a real scanner, strategy
                builder + backtest, FIRE, and ITR tax.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Chanakya strengths</h5>
                  <ul>
                    <li>Free AI chat advisor</li>
                    <li>Risk-profile quiz</li>
                    <li>Beginner-friendly picks</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>Live 8-broker read-only sync</li>
                    <li>Scanner + strategy + backtest</li>
                    <li>FIRE planning in INR</li>
                    <li>ITR-2 Schedule CG export</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 03 — LEGACY MATRIX */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">03 / LEGACY &amp; TRADITIONAL</span>
            <h2>
              vs the <span className="ser">tools you already know.</span>
            </h2>
          </div>
          <p className="section-sub">
            The tools Indian retail investors have stacked for years —
            Smallcase, Tickertape, Screener.in, Chartink, StockEdge.
          </p>

          <div className="ctbl-wrap">
            <table className="ctbl">
              <thead>
                <tr>
                  <th style={{ width: "24%" }}>Capability</th>
                  <th className="us">UseMoney AI</th>
                  <th>Smallcase</th>
                  <th>Tickertape</th>
                  <th>Screener.in</th>
                  <th>Chartink</th>
                  <th>StockEdge</th>
                </tr>
              </thead>
              <tbody>
                <tr className="sec-row">
                  <td colSpan={7}>Portfolio &amp; reconciliation</td>
                </tr>
                <tr>
                  <td>Multi-broker portfolio sync</td>
                  <td className="us">✓ 8 · read-only</td>
                  <td>✓ 13+</td>
                  <td>✓ 16+</td>
                  <td className="no">manual</td>
                  <td className="no">—</td>
                  <td className="no">manual</td>
                </tr>
                <tr>
                  <td>Unified XIRR / portfolio analytics</td>
                  <td className="us">✓</td>
                  <td>✓</td>
                  <td>✓</td>
                  <td className="no">manual</td>
                  <td className="no">—</td>
                  <td>watchlists</td>
                </tr>
                <tr>
                  <td>CSV import for any broker</td>
                  <td className="us">✓ 14 formats</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={7}>Research &amp; AI</td>
                </tr>
                <tr>
                  <td>AI chat grounded in YOUR holdings</td>
                  <td className="us">✓ cite-and-audit</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">doc AI</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>Fundamentals deep-dive</td>
                  <td className="us">✓ multi-model</td>
                  <td className="no">—</td>
                  <td>✓ 130+ filters</td>
                  <td>✓ 10-yr data</td>
                  <td>basic</td>
                  <td>✓</td>
                </tr>
                <tr>
                  <td>Scanner · technicals + fundamentals</td>
                  <td className="us">✓ 70+ indicators</td>
                  <td className="no">—</td>
                  <td>✓ both</td>
                  <td>fundamentals</td>
                  <td>✓ technicals</td>
                  <td>✓ 500+ scans</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={7}>Screens &amp; backtesting</td>
                </tr>
                <tr>
                  <td>Backtesting</td>
                  <td className="us">✓ walk-forward</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td>✓ scan-based</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>No-code strategy builder</td>
                  <td className="us">✓</td>
                  <td className="no">baskets</td>
                  <td className="no">—</td>
                  <td className="no">screens</td>
                  <td>scan rules</td>
                  <td>combo scans</td>
                </tr>
                <tr>
                  <td>Auto-place orders to your broker</td>
                  <td className="no">— (by design)</td>
                  <td>✓</td>
                  <td>US stocks</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={7}>Planning &amp; tax</td>
                </tr>
                <tr>
                  <td>FIRE calculator · INR-native</td>
                  <td className="us">✓</td>
                  <td className="no">—</td>
                  <td>basic SIP</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>
                <tr>
                  <td>ITR-2 Schedule CG export</td>
                  <td className="us">✓</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                  <td className="no">—</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={7}>Pricing &amp; access</td>
                </tr>
                <tr>
                  <td>Free tier exists</td>
                  <td className="us">✓ 5 credits/mo</td>
                  <td>✓ free baskets</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                  <td className="ok">✓</td>
                </tr>
                <tr>
                  <td>Starting paid price</td>
                  <td className="us">₹249/mo</td>
                  <td>per-basket</td>
                  <td>₹2,399/yr</td>
                  <td>₹4,999/yr</td>
                  <td>₹780/mo</td>
                  <td>₹1,799/yr</td>
                </tr>

                <tr className="sec-row">
                  <td colSpan={7}>Security</td>
                </tr>
                <tr>
                  <td>Read-only access (no order scope)</td>
                  <td className="us">✓ all 8 brokers</td>
                  <td className="no">places orders</td>
                  <td>✓ read-only*</td>
                  <td className="no">N/A</td>
                  <td className="no">N/A</td>
                  <td className="no">N/A</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 04 — PAIRWISE (legacy) */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">04 / PAIRWISE</span>
            <h2>
              One-on-one with <span className="ser">the legacy tools.</span>
            </h2>
          </div>
          <p className="section-sub">
            The four most investors actually weigh us against. Each owns its
            slice — here&apos;s the honest split.
          </p>

          <div className="verses" style={{ marginTop: 36 }}>
            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Smallcase</span>
              </div>
              <h3>
                If you want <span className="ser">curated baskets</span>,
                Smallcase wins.
              </h3>
              <p>
                Smallcase is a marketplace of manager-built baskets you invest
                in directly through your broker, with one-click rebalancing
                across 13+ brokers.{" "}
                <strong>
                  It picks for you; we&apos;re a workspace for your own work
                </strong>{" "}
                — AI research on your real holdings, strategy builder, FIRE, and
                ITR tax, all read-only.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Smallcase strengths</h5>
                  <ul>
                    <li>Curated manager baskets</li>
                    <li>One-click rebalancing</li>
                    <li>Direct invest via broker</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>AI chat on your book</li>
                    <li>Scanner + strategy + backtest</li>
                    <li>FIRE planning in INR</li>
                    <li>ITR-2 Schedule CG export</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Screener.in</span>
              </div>
              <h3>
                If you want the{" "}
                <span className="ser">deepest free fundamentals</span>,
                Screener.in wins.
              </h3>
              <p>
                Screener.in is the gold standard for fundamental analysis —
                10-year financials, formula-based custom screens, peer
                comparison, free for the core (and it just added AI
                document-insights).{" "}
                <strong>
                  We make those numbers conversational and personal
                </strong>{" "}
                — AI chat on your reconciled holdings, a strategy builder, FIRE,
                and ITR tax.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Screener.in strengths</h5>
                  <ul>
                    <li>10-yr financial data</li>
                    <li>Formula-based screens</li>
                    <li>Free, deep fundamentals</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>AI chat on your holdings</li>
                    <li>Multi-broker reconciliation</li>
                    <li>Strategy builder + backtest</li>
                    <li>FIRE &amp; ITR-ready tax</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Tickertape</span>
              </div>
              <h3>
                If you want a{" "}
                <span className="ser">best-in-class screener</span>, Tickertape
                wins.
              </h3>
              <p>
                Tickertape is a superb screener and analytics tool — 130+
                filters across fundamentals and technicals, multi-asset
                portfolio analysis, read-only sync with 16+ brokers.{" "}
                <strong>
                  We add the conversational + strategy + tax layer
                </strong>{" "}
                — AI chat on your holdings, a strategy builder with backtest,
                FIRE, and ITR export.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Tickertape strengths</h5>
                  <ul>
                    <li>130+ filter screener</li>
                    <li>Smart score &amp; checklists</li>
                    <li>16+ broker read-only sync</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>AI chat on your holdings</li>
                    <li>Strategy builder + backtest</li>
                    <li>FIRE planning in INR</li>
                    <li>ITR-2 Schedule CG export</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="vcard">
              <div className="vs-head">
                <span className="vs-name us">UseMoney AI</span>
                <span className="vs-divider">vs</span>
                <span className="vs-name them">Chartink</span>
              </div>
              <h3>
                If you want <span className="ser">fast technical scans</span>,
                Chartink wins.
              </h3>
              <p>
                Chartink is a real-time technical scanner — custom scan clauses,
                breakout/indicator screens, alerts, and scan backtesting on
                decades of data.{" "}
                <strong>We wrap scanning in the whole workspace</strong> —
                multi-broker portfolio, AI chat on your holdings, fundamentals
                alongside technicals, FIRE, and tax.
              </p>
              <div className="vsr">
                <div className="col">
                  <h5>Chartink strengths</h5>
                  <ul>
                    <li>Real-time technical scans</li>
                    <li>Scan alerts (SMS / email)</li>
                    <li>Scan backtesting</li>
                  </ul>
                </div>
                <div className="col us">
                  <h5>UseMoney AI strengths</h5>
                  <ul>
                    <li>Multi-broker portfolio</li>
                    <li>AI chat on your holdings</li>
                    <li>Fundamentals + technicals</li>
                    <li>FIRE &amp; ITR-ready tax</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 05 — EDITORIAL */}
      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">05 / EDITORIAL</span>
            <h2>
              The rows that <span className="ser">actually matter.</span>
            </h2>
          </div>

          <div className="verses" style={{ marginTop: 36 }}>
            <div className="vcard">
              <h3>
                Where we <span className="ser">lose.</span>
              </h3>
              <p>
                On raw broker count, Tickertape (16+ brokers) and Smallcase (13+
                brokers) beat us. We support 8 today and will add more · but if
                your only criterion is &ldquo;support every broker on the
                planet,&rdquo; they are better choices. We won&apos;t pretend
                otherwise.
              </p>
            </div>

            <div className="vcard">
              <h3>
                Where we <span className="ser">win.</span>
              </h3>
              <p>
                On AI chat grounded in your real, multi-broker portfolio, plus a
                no-code strategy builder with walk-forward backtesting at retail
                pricing, nobody else in India does all three. That combination
                is the entire product thesis.
              </p>
            </div>

            <div className="vcard">
              <h3>
                A note on Smallcase and <span className="ser">INDmoney.</span>
              </h3>
              <p>
                These are adjacent products, not direct competitors. Smallcase
                is curated thematic baskets sold by SEBI-registered advisers ·
                useful, different shape. INDmoney is a full-stack neobank-ish
                app with its own brokerage · useful, different shape. If you
                want curated baskets, use Smallcase. If you want a one-app
                neobank, use INDmoney. If you want AI that reads your existing
                portfolio across whatever brokers you already use and helps you
                reason about it, that&apos;s us.
              </p>
            </div>

            <div className="vcard">
              <h3>
                A note on Astor and <span className="ser">Multibagg AI.</span>
              </h3>
              <p>
                Astor (YC S25) is US-only and SEC-registered · different market,
                different regulatory regime. Multibagg AI is the closest
                shape-match in India · multi-broker read-only with Iris + Ask
                Portfolio AI on top · and we respect what they&apos;re building.
                The gap is walk-forward backtesting and the strategy builder +
                ITR-2 tax workflow that ships alongside the chat.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            The best <span className="ser">comparison</span> is{" "}
            <span className="hl">your own usage.</span>
          </h2>
          <p>
            Start free. Connect a broker. Decide for yourself. No card needed.
          </p>
          <div className="cta-row">
            <MarketingAuthCta signedOutLabel="Try UseMoney AI free →" />
            <Link className="btn-flat" href="/features">
              See features
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function monthYear(): string {
  return new Date().toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}
