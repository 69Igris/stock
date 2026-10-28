import "./page.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title:
    "About — UseMoney AI · Built by one founder, in public, for Indian retail.",
  description:
    "Solo-founder. Bootstrapped. Beta since March 2026. Built by Shaswat Deep at DIS Digital LLP. SEBI Investment Adviser registration in motion.",
};

export default function AboutPage() {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            About · the team building it
          </div>
          <h1>
            We&apos;re <span className="ser">building</span> the workspace we{" "}
            <span className="hl">wished existed.</span>
          </h1>
          <p className="lede">
            A small team of engineers, traders, and writers. We use the product
            daily. We <b>make money the same way you do</b> — by being right
            about the markets, not by selling subscriptions.
          </p>
        </div>
      </section>

      {/* ── 01 / WHY — founding-team letter (restored from earlier) ── */}
      <section className="section">
        <div className="container-narrow">
          <div className="section-h">
            <span className="num">01 / WHY</span>
            <h2>
              <b>
                Customer <span className="hl">zero</span>
              </b>{" "}
              <span className="ser">was me.</span>
            </h2>
          </div>

          <div className="letter">
            <p className="lead">
              I&apos;m an Indian retail investor. Money spread across three
              brokers, a spreadsheet I updated by hand, and a WhatsApp group
              full of &ldquo;sure-shot&rdquo; tips I never quite trusted. And
              one question I could never actually answer: is my portfolio any
              good — or am I just getting lucky?
            </p>

            <p>
              I&apos;m also a software engineer — twelve years of it. So when no
              Indian product would answer that question honestly, I built one.
              For myself, first. It started as a side project in December 2025,
              went full-time in January, and opened to the public in March 2026.
            </p>

            <p>
              Every feature in UseMoney exists because I needed it for my own
              money before anyone else did. I&apos;m still its first and most
              demanding user — if something annoys me, it gets fixed; if a
              feature gets in the way, it gets removed.
            </p>

            <div className="signature">— Shaswat Deep, founder</div>
          </div>
        </div>
      </section>

      {/* ── 02 / THE BET (was 01) ── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container-narrow">
          <div className="section-h">
            <span className="num">02 / THE BET</span>
            <h2>
              Where the next <span className="ser">ten years go.</span>
            </h2>
          </div>

          <div className="letter">
            <p className="lead">
              India crossed 225 million demat accounts in 2025 — up from 50
              million in 2020. Around 125 million unique investors. And fewer
              than 1,300 SEBI-registered Investment Advisers to serve all of
              them.
            </p>

            <p>
              Indian retail got the apps it deserved a decade ago — Zerodha,
              Groww, Upstox, Angel One — and then innovation stalled at
              execution. You can buy a stock in three taps. You still can&apos;t
              get a straight answer about whether you should.
            </p>

            <p>
              The next ten years won&apos;t be about more brokers or cheaper
              trades. They&apos;ll be about the intelligence layer on top: AI
              that actually reads your real portfolio across every broker,
              strategies that backtest honestly instead of curve-fitting the
              past, and tools that respect the Indian tax code instead of
              pretending it&apos;s the US one.
            </p>

            <blockquote>
              That&apos;s the bet UseMoney is built on — that the winner in
              Indian wealth-tech won&apos;t be the platform with the most
              brokers, but the one that finally makes 125 million portfolios
              legible to the people who own them.
            </blockquote>
          </div>
        </div>
      </section>

      {/* ── WHAT WE ARE NOT ── */}
      <section className="section">
        <div className="container-narrow">
          <div className="section-h">
            <span className="num">03 / NOT YET</span>
            <h2>
              What we are <span className="ser">not,</span>{" "}
              <span className="hl">yet.</span>
            </h2>
          </div>

          <div className="letter">
            <p className="lead">
              We are not (yet) a SEBI-registered Investment Adviser.
            </p>

            <p>
              Registration is in motion — the founder is completing NISM XA and
              XB. Until SEBI IA registration is granted, everything in the
              product is{" "}
              <strong>educational and analytical, never advisory.</strong>
            </p>

            <p>
              Read-only access to your broker accounts. We cannot place orders.
              We will never write &ldquo;buy this stock now.&rdquo; Once we are
              RIA-registered, that changes — until then, the product is built to
              be useful inside those constraints, not around them.
            </p>

            <p>
              If you need formal investment advice before then, consult a
              SEBI-registered Investment Adviser.
            </p>
          </div>
        </div>
      </section>

      {/* ── THE ENTITY ── */}
      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container">
          <div className="section-h">
            <span className="num">04 / THE ENTITY</span>
            <h2>
              Four <span className="ser">non-negotiables.</span>
            </h2>
          </div>

          <div className="values">
            <div className="v-card">
              <div className="ix">01</div>
              <h4>
                Read-only, <span className="ser">always.</span>
              </h4>
              <p>
                OAuth read-only on every broker. We cannot place, modify, or
                cancel orders. By design, not by promise.
              </p>
            </div>
            <div className="v-card">
              <div className="ix">02</div>
              <h4>
                INR-native, <span className="ser">first.</span>
              </h4>
              <p>
                STCG, LTCG, PPF, EPF, NPS. Indian holidays. Indian inflation. No
                translated US assumptions in a calculator.
              </p>
            </div>
            <div className="v-card">
              <div className="ix">03</div>
              <h4>
                Honest <span className="ser">pricing.</span>
              </h4>
              <p>
                Free is real. PRO is ₹249/month. AI compute has a meter —
                we&apos;d rather show it than hide it.
              </p>
            </div>
            <div className="v-card">
              <div className="ix">04</div>
              <h4>
                AI is a peer, <span className="ser">not an oracle.</span>
              </h4>
              <p>
                StockSage cites sources, returns tables, shows the math. It
                computes, it doesn&apos;t predict.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            We&apos;re hiring. <span className="hl">Quietly.</span>
          </h2>
          <p>
            Send us your three favourite books, your real XIRR, and what
            you&apos;d change about UseMoney first.
          </p>
          <div className="cta-row">
            <a className="btn-solid" href="mailto:careers@usemoney.ai">
              Email careers →
            </a>
            <Link className="btn-flat" href="/blog">
              Read the blog
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
