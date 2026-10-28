import "../changelog/page.css";
import "./page.css";
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingAuthCta } from "../MarketingAuthCta";

export const metadata: Metadata = {
  title: "Roadmap · UseMoney AI",
  description:
    "What we're shipping in the next three months. Bootstrapped, in public, dates honest.",
  alternates: { canonical: "https://usemoney.ai/roadmap" },
};

export default function RoadmapPage() {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Roadmap · updated as we ship
          </div>
          <h1>
            Three months out. <span className="ser">Honestly.</span>
          </h1>
          <p className="lede">
            No quarterly fantasy. Just what we&apos;re actively building,
            scheduled to land, and exploring · with the bias to ship.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container-narrow">
          <div className="rss-bar">
            <div className="left">
              <b>Forward plan</b> · subject to reality, updated as we ship
            </div>
            <div className="right">
              <a href="/changelog">Changelog</a>
              <Link href="/about">About</Link>
            </div>
          </div>

          {/* NOW SHIPPING · May 2026 */}
          <article className="release">
            <div className="meta">
              <div className="ver">
                Now <span className="ser">shipping</span>
              </div>
              <div className="date">May 2026</div>
              <span className="tag shipping">SHIPPING</span>
            </div>
            <div className="body">
              <h3>
                The big repositioning,{" "}
                <span className="hl">landing this week.</span>
              </h3>
              <p className="intro">
                Playful design system across the entire app. AI-first homepage.
                Newsletter. Roadmap. Eight brokers.
              </p>
              <div className="change-group">
                <h4 className="added">Added</h4>
                <ul>
                  <li>
                    <strong>Playful design system</strong> on every page: cream
                    and ink palette, Instrument Serif + JetBrains Mono.
                  </li>
                  <li>
                    <strong>StockSage 3-pane chat</strong>: research, results,
                    and history side-by-side.
                  </li>
                  <li>
                    <strong>Newsletter</strong> audience + weekly long-read in
                    public.
                  </li>
                  <li>
                    <strong>/roadmap</strong> (this page): three months out,
                    honestly.
                  </li>
                  <li>
                    <strong>Eight brokers staged</strong>: Zerodha in beta,
                    seven more coming soon, all eight going Live in the next two
                    months.
                  </li>
                  <li>
                    <strong>Portfolio XIRR / CAGR</strong> wired everywhere:
                    aggregate and per-broker.
                  </li>
                </ul>
              </div>
            </div>
          </article>

          {/* JUNE 2026 · Scheduled */}
          <article className="release">
            <div className="meta">
              <div className="ver">
                Live data &amp; <span className="ser">charts</span>
              </div>
              <div className="date">June 2026</div>
              <span className="tag scheduled">SCHEDULED</span>
            </div>
            <div className="body">
              <h3>
                Charts go live. Strategies get a{" "}
                <span className="hl">backtest UI.</span>
              </h3>
              <p className="intro">
                Charts move from delayed to live, the strategy builder gets a
                real walk-forward backtest UI, and research gets faster.
              </p>
              <div className="change-group">
                <h4 className="added">Planned</h4>
                <ul>
                  <li>
                    <strong>All 8 brokers &rarr; Live</strong>: promote Zerodha
                    out of beta and ship the remaining seven (Groww, Angel One,
                    Upstox, Dhan, Fyers, HDFC Sky, ICICI Direct).
                  </li>
                  <li>
                    <strong>BSE live data</strong> via official feed (currently
                    delayed).
                  </li>
                  <li>
                    <strong>TradingView Advanced Charts v32</strong> upgrade.
                  </li>
                  <li>
                    <strong>Strategy builder backtest UI</strong>: walk-forward,
                    no math degree required.
                  </li>
                  <li>
                    <strong>Mobile PWA polish</strong>: offline holdings, native
                    share, install prompt.
                  </li>
                  <li>
                    <strong>Alerts MVP</strong>: price + condition triggers,
                    in-app delivery.
                  </li>
                  <li>
                    <strong>L3 research speed</strong>: Flash-first router,
                    prompt cache reuse.
                  </li>
                </ul>
              </div>
            </div>
          </article>

          {/* JULY 2026 · Planned */}
          <article className="release">
            <div className="meta">
              <div className="ver">
                Alerts &amp; <span className="ser">Strategy v2</span>
              </div>
              <div className="date">July 2026</div>
              <span className="tag planned">PLANNED</span>
            </div>
            <div className="body">
              <h3>
                Alerts you can act on. Strategies you can{" "}
                <span className="hl">trust.</span>
              </h3>
              <p className="intro">
                Email + push alerts. Sixty pre-built strategies. Live source
                citations on every research card.
              </p>
              <div className="change-group">
                <h4 className="added">Planned</h4>
                <ul>
                  <li>
                    <strong>Email + push alerts</strong>: price, % move,
                    P&amp;L, news, dividend.
                  </li>
                  <li>
                    <strong>Strategy library v2</strong>: 60+ pre-built
                    strategies, custom strategy builder.
                  </li>
                  <li>
                    <strong>Pattern + scan engine</strong>: 12 chart and 25
                    candlestick patterns, Chartink and plain-English scans, with
                    walk-forward backtests on any strategy.
                  </li>
                  <li>
                    <strong>Quant + macro layer</strong>: factor scores, regime
                    &amp; volatility analysis, FII/DII + RBI macro context, and
                    Monte-Carlo forward scenarios.
                  </li>
                  <li>
                    <strong>L4 institutional research</strong>: deeper
                    fundamentals, relative valuation, DDM/DCF, and forward
                    scenario modelling (gated to PRO).
                  </li>
                  <li>
                    <strong>Vertex grounding</strong> for live source citations
                    across research.
                  </li>
                  <li>
                    <strong>Live socket</strong> for in-flight tool updates in
                    research streams.
                  </li>
                  <li>
                    <strong>Comparison cards 2.0</strong>: richer peer + macro
                    context.
                  </li>
                  <li>
                    <strong>Research speed</strong>: &lt;6s to first byte for L1
                    Flash.
                  </li>
                  <li>
                    <strong>Earnings calendar v2</strong> with per-stock impact
                    view.
                  </li>
                </ul>
              </div>
            </div>
          </article>

          {/* AUGUST 2026 · Planned */}
          <article className="release">
            <div className="meta">
              <div className="ver">
                Mobile beta &amp; <span className="ser">Tax v2</span>
              </div>
              <div className="date">August 2026</div>
              <span className="tag planned">PLANNED</span>
            </div>
            <div className="body">
              <h3>
                Mobile, in your pocket. Tax, in{" "}
                <span className="hl">your CA&apos;s format.</span>
              </h3>
              <p className="intro">
                iOS + Android beta. ITR-2 export. Per-broker XIRR. Macro context
                built in.
              </p>
              <div className="change-group">
                <h4 className="added">Planned</h4>
                <ul>
                  <li>
                    <strong>iOS + Android beta</strong>: read-only, OAuth-only,
                    watch-only.
                  </li>
                  <li>
                    <strong>Tax v2</strong>: ITR-2 capital-gains export,
                    indexation calculator, FY-aware reporting.
                  </li>
                  <li>
                    <strong>Per-broker XIRR + CAGR</strong> displayed alongside
                    aggregate.
                  </li>
                  <li>
                    <strong>ITR-2 PDF download</strong>: pre-filled,
                    CA-reviewed.
                  </li>
                  <li>
                    <strong>Macro tab</strong>: FII/DII flows, RBI rates,
                    USD/INR impact on portfolio.
                  </li>
                  <li>
                    <strong>L4 advanced research</strong>:
                    Tijori/StockEdge-grade fundamentals (gated to PRO).
                  </li>
                </ul>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container-narrow">
          <div className="section-h">
            <span className="num">EXPLORING</span>
            <h2>
              Maybe. <span className="ser">Probably not this quarter.</span>
            </h2>
          </div>
          <div className="explore-list">
            <div className="explore-row">
              <div className="t">US equities for Indian retail</div>
              <div className="s">NASDAQ/NYSE in INR, FX-adjusted P&amp;L.</div>
            </div>
            <div className="explore-row">
              <div className="t">Global mutual funds</div>
              <div className="s">
                Cross-border comparison, FX-corrected returns.
              </div>
            </div>
            <div className="explore-row">
              <div className="t">Interactive Brokers integration</div>
              <div className="s">9th broker.</div>
            </div>
            <div className="explore-row">
              <div className="t">Smallcase-style themed baskets</div>
              <div className="s">Your portfolio, your themes.</div>
            </div>
            <div className="explore-row">
              <div className="t">AI-generated quarterly summaries</div>
              <div className="s">One email per stock you hold.</div>
            </div>
            <div className="explore-row">
              <div className="t">Public read-only portfolio share links</div>
              <div className="s">Opt-in, anonymised.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            Want a <span className="hl">vote?</span>
          </h2>
          <p>
            The roadmap follows what users actually use. Email{" "}
            <a href="mailto:hello@usemoney.ai">hello@usemoney.ai</a> with what
            you&apos;d ship first.
          </p>
          <div className="cta-row">
            <MarketingAuthCta />
            <Link className="btn-flat" href="/changelog">
              See what shipped
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
