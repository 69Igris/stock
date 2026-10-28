import { PlayfulLegalShell } from "@/components/marketing/PlayfulLegalShell";
import "../legal/legal.css";

export const metadata = {
  title: "Risk Disclosure — UseMoney AI",
  description:
    "UseMoney is educational and analytical, not advisory. Pre-RIA. SEBI Investment Adviser registration in motion. Past performance is not indicative of future returns.",
  alternates: { canonical: "https://usemoney.ai/risk-disclosure" },
};

const I = (path: React.ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {path}
  </svg>
);

const ALERT = I(
  <>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>
);
const BAN = I(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="4.9" y1="4.9" x2="19.1" y2="19.1" />
  </>
);
const CHART = I(
  <>
    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
    <polyline points="16 17 22 17 22 11" />
  </>
);
const SHIELD = I(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
const INFO = I(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </>
);
const FILE = I(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>
);

export default function RiskDisclosurePage() {
  return (
    <PlayfulLegalShell
      eyebrow="Risk Disclosure · read before investing"
      title="Risk"
      serif="Disclosure"
      lede={
        <>
          This page sets out, in plain English, what UseMoney is — and what it
          is not — for the purpose of any investment decision you make.{" "}
          <b>Read it. It is short on purpose.</b>
        </>
      }
      lastUpdated="May 2026"
      active="risk-disclosure"
    >
      {/* 1 — Not an investment adviser. Yet. */}
      <article className="legal-card tone-4">
        <header className="lc-head">
          <span className="lc-ic">{ALERT}</span>
          <span className="lc-title">
            1. UseMoney is not an investment adviser. Yet.
          </span>
        </header>
        <div className="lc-body">
          <p>
            We are pre-RIA. SEBI Investment Adviser registration is in motion —
            the founder is completing NISM XA and XB certifications. Until
            registration is granted by SEBI, the product provides{" "}
            <strong>educational and analytical content only</strong>. We do not
            provide investment advice within the meaning of the SEBI (Investment
            Advisers) Regulations, 2013.
          </p>
        </div>
      </article>

      {/* 2 — What we do */}
      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{INFO}</span>
          <span className="lc-title">2. What we do.</span>
        </header>
        <div className="lc-body">
          <p>
            We provide portfolio aggregation, AI-assisted research, screening,
            strategy backtesting, FIRE planning, and capital-gains reports.
            Outputs are analytical artefacts — they describe and contextualise,
            they do not prescribe.
          </p>
        </div>
      </article>

      {/* 3 — What we do not do */}
      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{BAN}</span>
          <span className="lc-title">3. What we do not do.</span>
        </header>
        <div className="lc-body">
          <ul>
            <li>
              We do not <strong>recommend specific securities</strong> to buy or
              sell.
            </li>
            <li>We do not manage your money.</li>
            <li>
              We do not place trades.{" "}
              <strong>Read-only broker access by design.</strong>
            </li>
            <li>
              We do not guarantee any return, projection, or backtested outcome.
            </li>
          </ul>
        </div>
      </article>

      {/* 4 — Markets are risky */}
      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{CHART}</span>
          <span className="lc-title">4. Markets are risky.</span>
        </header>
        <div className="lc-body">
          <p>
            Investing in equities, mutual funds, and derivatives involves risk,
            including the risk of losing some or all of your invested capital.{" "}
            <strong>
              Past performance is not indicative of future returns.
            </strong>{" "}
            Backtest results are hypothetical, assume frictionless execution,
            and routinely overstate live results. Walk-forward backtesting
            reduces but does not eliminate overfitting risk.
          </p>
          <p>A non-exhaustive list of risks in Indian markets:</p>
          <ul>
            <li>
              <strong>Market risk:</strong> share prices, NAVs, and derivatives
              premiums can fall sharply due to economic, political, or
              sector-specific events
            </li>
            <li>
              <strong>Liquidity risk:</strong> some securities (especially
              small-caps, certain ETFs, illiquid F&amp;O contracts) may not have
              a willing buyer at the price you want
            </li>
            <li>
              <strong>Leverage risk:</strong> F&amp;O and intraday positions can
              lose more than the initial margin in adverse moves
            </li>
            <li>
              <strong>Concentration risk:</strong> over-allocation to a single
              stock, sector, or theme amplifies drawdowns
            </li>
            <li>
              <strong>Tax-policy risk:</strong> STCG / LTCG / F&amp;O tax
              treatment can change with each Union Budget
            </li>
            <li>
              <strong>Model risk:</strong> AI-generated research can
              hallucinate, misread financial statements, or extrapolate past
              patterns that do not repeat
            </li>
          </ul>
        </div>
      </article>

      {/* 5 — AI is not a financial adviser */}
      <article className="legal-card tone-3">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">5. AI is not a financial adviser.</span>
        </header>
        <div className="lc-body">
          <p>
            StockSage is powered by <strong>Google Gemini</strong>. It can
            summarise, compare, screen, and reason — and it can also be wrong.
            Treat its outputs as research inputs, not decisions.
          </p>
          <ul>
            <li>
              Treat StockSage as a research <em>assistant</em>, not an oracle.
              Verify every number by clicking through to the broker / source
              row.
            </li>
            <li>
              Consult a SEBI-registered Investment Adviser before making
              significant allocation decisions.
            </li>
            <li>
              Read the offer document of any mutual fund before subscribing.
            </li>
            <li>
              Past returns shown in backtests, scanner results, or paper trades
              have <strong>no predictive value</strong> for future returns.
            </li>
          </ul>
        </div>
      </article>

      {/* 6 — Your decisions are your own */}
      <article className="legal-card tone-5">
        <header className="lc-head">
          <span className="lc-ic">{INFO}</span>
          <span className="lc-title">6. Your decisions are your own.</span>
        </header>
        <div className="lc-body">
          <p>
            You alone are responsible for your investment decisions, and you
            alone bear the consequences. If you need formal investment advice,
            consult a SEBI-registered Investment Adviser.
          </p>
          <p>
            We <strong>never</strong> place orders. We do not have the broker
            scope to do so, by design. We have no discretion over your money.
          </p>
        </div>
      </article>

      {/* 7 — Regulatory references */}
      <article className="legal-card tone-6">
        <header className="lc-head">
          <span className="lc-ic">{FILE}</span>
          <span className="lc-title">7. Regulatory references.</span>
        </header>
        <div className="lc-body">
          <p>
            UseMoney AI operates within the SEBI framework for software adjacent
            to portfolio management. We are aware of and align with:
          </p>
          <ul>
            <li>
              SEBI (Investment Advisers) Regulations, 2013 — we do not perform
              any activity reserved for registered advisers
            </li>
            <li>
              SEBI (Research Analysts) Regulations, 2014 — we do not publish
              research reports as defined therein
            </li>
            <li>
              The Digital Personal Data Protection Act, 2023 — consent,
              breach-notification, and data-principal-rights handling
            </li>
          </ul>
          <p>
            If you believe the product crosses into regulated territory at any
            point, please write to{" "}
            <a href="mailto:legal@usemoney.ai">legal@usemoney.ai</a> — we will
            review and respond.
          </p>
        </div>
      </article>
    </PlayfulLegalShell>
  );
}
