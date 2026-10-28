import { PlayfulLegalShell } from "@/components/marketing/PlayfulLegalShell";
import "../legal/legal.css";

export const metadata = {
  title: "Data Usage Policy",
  description:
    "How UseMoney collects, processes, stores, and protects your financial data — broker tokens, holdings, AI chat history.",
  alternates: { canonical: "https://usemoney.ai/data-usage" },
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

const DB = I(
  <>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </>
);
const LOCK = I(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>
);
const EYE = I(
  <>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </>
);
const SHIELD = I(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
const SERVER = I(
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </>
);
const SHARE = I(
  <>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </>
);
const TRASH = I(
  <>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </>
);
const REFRESH = I(
  <>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </>
);

export default function DataUsagePage() {
  return (
    <PlayfulLegalShell
      eyebrow="Data usage · where your broker data flows"
      title="Data"
      serif="Usage"
      lede={
        <>
          What we collect, how it&apos;s stored, who we share it with, and how
          long we keep it. <b>Short version:</b> read-only OAuth, encrypted at
          rest, never sold, never used for AI training.
        </>
      }
      lastUpdated="28 May 2026"
      active="data-usage"
    >
      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{DB}</span>
          <span className="lc-title">What data we collect</span>
        </header>
        <div className="lc-body">
          <p>
            When you connect a broker account, UseMoney accesses your portfolio
            data through your broker&apos;s official API. This includes:
          </p>
          <ul>
            <li>
              <strong>Holdings</strong> — current stock and ETF positions,
              average prices, quantities
            </li>
            <li>
              <strong>Positions</strong> — open F&amp;O and intraday positions
            </li>
            <li>
              <strong>Trade history</strong> — buy/sell transactions for P&amp;L
              calculation and FIFO pairing
            </li>
            <li>
              <strong>Mutual fund holdings</strong> — NAV, units, folio details
              (where supported by the broker API)
            </li>
            <li>
              <strong>Account profile</strong> — broker user ID, name, and email
              for account identification
            </li>
          </ul>
          <p>
            We also collect standard usage data: pages visited, features used,
            device type, and IP address for analytics and security.
          </p>
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{LOCK}</span>
          <span className="lc-title">How we store your data</span>
        </header>
        <div className="lc-body">
          <ul>
            <li>
              <strong>Broker credentials</strong> are encrypted at rest using{" "}
              <strong>AES-256-GCM</strong> with per-user encryption keys. We
              never store your broker password — only the API access token
              issued by your broker&apos;s OAuth flow.
            </li>
            <li>
              <strong>Portfolio data</strong> (holdings, trades, positions) is
              stored in <strong>MongoDB Atlas</strong> with encryption at rest
              and in transit (TLS 1.2+).
            </li>
            <li>
              <strong>Market data cache</strong> (quotes, historical prices) is
              stored in Redis with automatic expiration and is not personally
              identifiable.
            </li>
            <li>
              <strong>AI chat conversations</strong> are stored to provide
              conversation history. They are not used to train AI models and can
              be deleted at any time.
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-3">
        <header className="lc-head">
          <span className="lc-ic">{EYE}</span>
          <span className="lc-title">How we use your data</span>
        </header>
        <div className="lc-body">
          <p>
            Your data is used exclusively to provide the UseMoney platform
            features:
          </p>
          <ul>
            <li>
              <strong>Portfolio dashboard</strong> — aggregating holdings across
              multiple brokers into a single view
            </li>
            <li>
              <strong>P&amp;L analytics</strong> — FIFO trade pairing,
              realized/unrealized gains, tax analysis
            </li>
            <li>
              <strong>AI-powered insights</strong> — portfolio analysis,
              research, and roast features use your holdings data as context for
              context-aware analysis
            </li>
            <li>
              <strong>Risk analysis</strong> — concentration metrics, VaR
              calculations, and drawdown analysis
            </li>
            <li>
              <strong>Strategy backtesting</strong> — historical signal replay
              is computed separately and never affects real broker data
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-4">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">What we do NOT do</span>
        </header>
        <div className="lc-body">
          <ul>
            <li>
              We <strong>never sell your data</strong> to third parties — not
              brokers, not advertisers, not data aggregators
            </li>
            <li>
              We <strong>never place trades</strong> on your behalf — UseMoney
              is read-only access to your broker account
            </li>
            <li>
              We <strong>never use your data to train AI models</strong> — your
              conversations and portfolio data are not included in any training
              dataset
            </li>
            <li>
              We <strong>never share identifiable data</strong> with other users
              — your portfolio is visible only to you
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-5">
        <header className="lc-head">
          <span className="lc-ic">{SERVER}</span>
          <span className="lc-title">Third-party services</span>
        </header>
        <div className="lc-body">
          <p>UseMoney integrates with the following services to operate:</p>
          <ul>
            <li>
              <strong>Clerk</strong> — authentication and user management
            </li>
            <li>
              <strong>Google Cloud Platform</strong> — infrastructure, Pub/Sub
              messaging, Cloud Run
            </li>
            <li>
              <strong>MongoDB Atlas</strong> — primary database
            </li>
            <li>
              <strong>Vercel</strong> — web application hosting
            </li>
            <li>
              <strong>Google Gemini</strong> — AI features (portfolio analysis,
              research, chat)
            </li>
            <li>
              <strong>PostHog</strong> — privacy-friendly product analytics
            </li>
            <li>
              <strong>Broker APIs</strong> (Zerodha, Upstox, Angel One, Groww,
              Dhan, Fyers, HDFC Sky, ICICI Direct) — read-only portfolio data
              access
            </li>
          </ul>
          <p>
            See our <a href="/subprocessors">Subprocessors page</a> for the full
            list.
          </p>
        </div>
      </article>

      <article className="legal-card tone-6">
        <header className="lc-head">
          <span className="lc-ic">{SHARE}</span>
          <span className="lc-title">Data sharing</span>
        </header>
        <div className="lc-body">
          <p>
            We share data only with the third-party services listed above, and
            only to the extent necessary to provide the platform. Specifically:
          </p>
          <ul>
            <li>
              Broker APIs receive your access token to fetch your portfolio data
              — no other data is sent to brokers
            </li>
            <li>
              Google Gemini receives portfolio context (anonymized symbol +
              quantity data) during AI chat sessions — never your name, email,
              or broker credentials
            </li>
            <li>
              PostHog receives anonymized usage events — no portfolio data, no
              PII
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{TRASH}</span>
          <span className="lc-title">Data retention &amp; deletion</span>
        </header>
        <div className="lc-body">
          <ul>
            <li>
              <strong>Broker connections</strong> — you can disconnect a broker
              at any time from the Brokers page. Disconnecting removes the
              encrypted credentials immediately.
            </li>
            <li>
              <strong>Portfolio data</strong> — retained for as long as your
              account is active. When you delete your account, all associated
              data is permanently deleted within 30 days.
            </li>
            <li>
              <strong>Market data cache</strong> — automatically expires
              (quotes: 5 minutes, historical bars: 1 hour).
            </li>
            <li>
              <strong>AI chat history</strong> — you can delete individual
              conversations or all chat history from the settings page.
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{REFRESH}</span>
          <span className="lc-title">Updates to this policy</span>
        </header>
        <div className="lc-body">
          <p>
            We may update this Data Usage Policy from time to time. When we make
            significant changes, we&apos;ll notify you via email or an in-app
            notification. Continued use of the platform after changes
            constitutes acceptance of the updated policy.
          </p>
          <p>
            Questions about how we handle your data? Contact us at{" "}
            <a href="mailto:privacy@usemoney.ai">privacy@usemoney.ai</a>.
          </p>
        </div>
      </article>
    </PlayfulLegalShell>
  );
}
