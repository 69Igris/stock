import { PlayfulLegalShell } from "@/components/marketing/PlayfulLegalShell";
import "../legal/legal.css";

export const metadata = {
  title: "Privacy Policy",
  description:
    "Privacy policy for UseMoney — what we collect, how it's stored, who can see it, and how to ask us to delete it.",
  alternates: { canonical: "https://usemoney.ai/privacy" },
};

const SHIELD = (
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
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const DB = (
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
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </svg>
);
const EYE = (
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
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const LOCK = (
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
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const GLOBE = (
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
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);
const MAIL = (
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
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

export default function PrivacyPage() {
  return (
    <PlayfulLegalShell
      eyebrow="Privacy · what we collect, what we don't"
      title="Privacy"
      serif="Policy"
      lede={
        <>
          We collect the bare minimum needed to run a portfolio workspace.{" "}
          <b>Broker tokens are encrypted at rest with AES-256-GCM.</b>{" "}
          <span className="ser">No data egress outside India.</span>
        </>
      }
      lastUpdated="28 May 2026"
      active="privacy"
    >
      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">Introduction</span>
        </header>
        <div className="lc-body">
          <p>
            UseMoney (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;) is
            committed to protecting your privacy. This Privacy Policy explains
            how we collect, use, disclose, and safeguard your information when
            you use our portfolio management platform.
          </p>
          <p>
            By using UseMoney, you agree to the collection and use of
            information in accordance with this policy.
          </p>
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{DB}</span>
          <span className="lc-title">Information we collect</span>
        </header>
        <div className="lc-body">
          <h4>Account information</h4>
          <ul>
            <li>Email address and name (via Clerk authentication)</li>
            <li>Profile information you provide</li>
          </ul>
          <h4>Broker connection data</h4>
          <ul>
            <li>OAuth tokens from connected brokers (encrypted)</li>
            <li>Holdings, positions, and trade history synced from brokers</li>
            <li>
              We use <strong>read-only</strong> access — we cannot place orders
              on your behalf
            </li>
          </ul>
          <h4>Usage data</h4>
          <ul>
            <li>Pages visited and features used</li>
            <li>AI queries and interactions</li>
            <li>Device and browser information</li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-3">
        <header className="lc-head">
          <span className="lc-ic">{EYE}</span>
          <span className="lc-title">How we use your information</span>
        </header>
        <div className="lc-body">
          <ul>
            <li>To provide and maintain our service</li>
            <li>
              To sync and display your portfolio data from connected brokers
            </li>
            <li>To provide AI-powered insights and analysis on your trading</li>
            <li>To calculate performance metrics (P&amp;L, XIRR, CAGR)</li>
            <li>To send important service updates and notifications</li>
            <li>To process payments for premium subscriptions</li>
            <li>To improve our platform and develop new features</li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-4">
        <header className="lc-head">
          <span className="lc-ic">{LOCK}</span>
          <span className="lc-title">Data security</span>
        </header>
        <div className="lc-body">
          <p>We implement industry-standard security measures:</p>
          <ul>
            <li>
              <strong>Encryption:</strong> All broker credentials are encrypted
              using AES-256-GCM before storage
            </li>
            <li>
              <strong>Secure authentication:</strong> We use Clerk for secure
              user authentication with OAuth and MFA support
            </li>
            <li>
              <strong>HTTPS:</strong> All data transmitted is encrypted via
              TLS/SSL
            </li>
            <li>
              <strong>Read-only access:</strong> We only request read
              permissions from brokers — we cannot execute trades
            </li>
            <li>
              <strong>No password storage:</strong> We never store your broker
              passwords
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-5">
        <header className="lc-head">
          <span className="lc-ic">{GLOBE}</span>
          <span className="lc-title">Third-party services</span>
        </header>
        <div className="lc-body">
          <p>We use the following third-party services:</p>
          <ul>
            <li>
              <strong>Clerk:</strong> Authentication and user management
            </li>
            <li>
              <strong>MongoDB Atlas:</strong> Database hosting (encrypted at
              rest)
            </li>
            <li>
              <strong>Dodo Payments:</strong> Payment processing for
              subscriptions
            </li>
            <li>
              <strong>Broker APIs:</strong> Zerodha, Upstox, Angel One, Groww,
              Dhan, Fyers, HDFC Sky, ICICI Direct for data sync
            </li>
            <li>
              <strong>Google Gemini (via Google Vertex AI):</strong> for
              portfolio analysis, research, and StockSage chat
            </li>
          </ul>
          <p>
            Each third-party service has its own privacy policy governing the
            use of your information.
          </p>
        </div>
      </article>

      <article className="legal-card tone-6">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">Your rights</span>
        </header>
        <div className="lc-body">
          <p>You have the right to:</p>
          <ul>
            <li>
              <strong>Access:</strong> Request a copy of your personal data
            </li>
            <li>
              <strong>Correction:</strong> Update or correct your information
            </li>
            <li>
              <strong>Deletion:</strong> Request deletion of your account and
              data
            </li>
            <li>
              <strong>Disconnect:</strong> Revoke broker connections at any time
            </li>
            <li>
              <strong>Export:</strong> Export your trade and portfolio data
            </li>
          </ul>
          <p>
            To exercise any of these rights, please contact us at{" "}
            <a href="mailto:privacy@usemoney.ai">privacy@usemoney.ai</a>.
          </p>
        </div>
      </article>

      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{MAIL}</span>
          <span className="lc-title">Contact us</span>
        </header>
        <div className="lc-body">
          <p>
            If you have any questions about this Privacy Policy, please contact
            us at <a href="mailto:privacy@usemoney.ai">privacy@usemoney.ai</a>.
          </p>
          <p>
            UseMoney is a product of DIS Digital LLP. For additional privacy
            information regarding our parent company, see the{" "}
            <a
              href="https://www.disdigital.in/privacy"
              target="_blank"
              rel="noopener noreferrer"
            >
              DIS Digital Privacy Policy ↗
            </a>
            .
          </p>
        </div>
      </article>
    </PlayfulLegalShell>
  );
}
