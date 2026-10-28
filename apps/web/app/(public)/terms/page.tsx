import { PlayfulLegalShell } from "@/components/marketing/PlayfulLegalShell";
import "../legal/legal.css";

export const metadata = {
  title: "Terms of Service",
  description:
    "Terms of service for UseMoney — what you can do, what we owe you, where the disclaimers live.",
  alternates: { canonical: "https://usemoney.ai/terms" },
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

const FILE = I(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>
);
const GLOBE = I(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </>
);
const SHIELD = I(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
const CARD = I(
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <line x1="2" y1="10" x2="22" y2="10" />
  </>
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
const SCALE = I(
  <>
    <path d="M16 16 3 6l4-2 13 10z" />
    <path d="M16 8 6 21h16z" />
  </>
);
const MAIL = I(
  <>
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </>
);

export default function TermsPage() {
  return (
    <PlayfulLegalShell
      eyebrow="Terms · plain-English"
      title="Terms"
      serif="of Service"
      lede={
        <>
          What you&apos;re agreeing to when you use UseMoney.{" "}
          <b>Short version:</b> we&apos;re a portfolio workspace, not a broker —
          we never place orders, and we make no investment guarantees.
        </>
      }
      lastUpdated="28 May 2026"
      active="terms"
    >
      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{FILE}</span>
          <span className="lc-title">Agreement to terms</span>
        </header>
        <div className="lc-body">
          <p>
            By accessing or using UseMoney, you agree to be bound by these Terms
            of Service and our Privacy Policy. If you disagree with any part of
            these terms, you may not access the service.
          </p>
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{GLOBE}</span>
          <span className="lc-title">Description of service</span>
        </header>
        <div className="lc-body">
          <p>UseMoney provides:</p>
          <ul>
            <li>Portfolio tracking and management dashboard</li>
            <li>
              Multi-broker integration for syncing holdings, positions, and
              trades
            </li>
            <li>AI-powered analysis and insights</li>
            <li>FIRE calculator and financial planning tools</li>
            <li>Strategy builder and historical backtesting</li>
          </ul>
          <p>
            <strong>Important:</strong> UseMoney is a portfolio tracking tool
            only. We do NOT provide investment advice, execute trades on your
            behalf, or guarantee any investment returns.
          </p>
        </div>
      </article>

      <article className="legal-card tone-3">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">User responsibilities</span>
        </header>
        <div className="lc-body">
          <p>As a user, you agree to:</p>
          <ul>
            <li>Provide accurate and complete information</li>
            <li>Keep your account credentials secure</li>
            <li>Not share your account with others</li>
            <li>Use the service only for lawful purposes</li>
            <li>Not attempt to reverse engineer or hack the platform</li>
            <li>
              Not use the service to manipulate markets or engage in illegal
              trading
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-4">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">Broker connections</span>
        </header>
        <div className="lc-body">
          <p>When you connect your broker accounts:</p>
          <ul>
            <li>
              You authorize us to access <strong>read-only</strong> data from
              your broker
            </li>
            <li>We cannot and will not place any orders or execute trades</li>
            <li>You can disconnect any broker at any time</li>
            <li>Broker API availability depends on third-party services</li>
            <li>
              We are not responsible for broker API downtime or data accuracy
            </li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-5">
        <header className="lc-head">
          <span className="lc-ic">{CARD}</span>
          <span className="lc-title">Payments &amp; subscriptions</span>
        </header>
        <div className="lc-body">
          <ul>
            <li>
              <strong>PRO Tier:</strong> ₹249 per month or ₹1,999 per year
              (annual saves ₹989).
            </li>
            <li>
              <strong>Premium Tier:</strong> ₹1,499 per month or ₹14,990 per
              year (annual saves ₹2,998).
            </li>
            <li>
              Subscriptions can be cancelled any time and continue until the end
              of the paid period.
            </li>
          </ul>
          <p>Payments are processed securely through Dodo Payments.</p>
        </div>
      </article>

      <article className="legal-card tone-6">
        <header className="lc-head">
          <span className="lc-ic">{ALERT}</span>
          <span className="lc-title">Investment risk &amp; disclaimer</span>
        </header>
        <div className="lc-body">
          <p>
            <strong>Investment risk warning:</strong> Investing in stocks and
            securities involves risk. Past performance is not indicative of
            future results. You could lose some or all of your invested capital.
          </p>
          <ul>
            <li>UseMoney does NOT provide financial advice</li>
            <li>AI insights are for informational purposes only</li>
            <li>
              Always consult a qualified financial advisor before making
              investment decisions
            </li>
            <li>We are not SEBI-registered investment advisors</li>
            <li>We are not responsible for any trading losses</li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{BAN}</span>
          <span className="lc-title">Prohibited uses</span>
        </header>
        <div className="lc-body">
          <p>You may not use UseMoney to:</p>
          <ul>
            <li>Engage in market manipulation or insider trading</li>
            <li>Violate any applicable laws or regulations</li>
            <li>Scrape or extract data for commercial purposes</li>
            <li>Impersonate others or provide false information</li>
            <li>Interfere with the proper functioning of the service</li>
            <li>Attempt to gain unauthorized access to our systems</li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{SCALE}</span>
          <span className="lc-title">Limitation of liability</span>
        </header>
        <div className="lc-body">
          <p>
            To the maximum extent permitted by law, UseMoney shall not be liable
            for any indirect, incidental, special, consequential, or punitive
            damages, including but not limited to:
          </p>
          <ul>
            <li>Loss of profits or investment returns</li>
            <li>Trading losses based on AI insights or analysis</li>
            <li>Data loss or corruption</li>
            <li>Service interruptions or downtime</li>
            <li>Errors in broker data synchronization</li>
          </ul>
        </div>
      </article>

      <article className="legal-card tone-3">
        <header className="lc-head">
          <span className="lc-ic">{FILE}</span>
          <span className="lc-title">Changes to terms</span>
        </header>
        <div className="lc-body">
          <p>
            We reserve the right to modify these terms at any time. We will
            notify users of any material changes via email or in-app
            notification. Continued use of the service after changes constitutes
            acceptance of the new terms.
          </p>
        </div>
      </article>

      <article className="legal-card tone-4">
        <header className="lc-head">
          <span className="lc-ic">{MAIL}</span>
          <span className="lc-title">Contact us</span>
        </header>
        <div className="lc-body">
          <p>
            If you have any questions about these Terms, please contact us at{" "}
            <a href="mailto:legal@usemoney.ai">legal@usemoney.ai</a>.
          </p>
          <p>
            UseMoney is a product of DIS Digital LLP. For additional terms and
            conditions regarding our parent company, see the{" "}
            <a
              href="https://www.disdigital.in/terms"
              target="_blank"
              rel="noopener noreferrer"
            >
              DIS Digital Terms of Service ↗
            </a>
            .
          </p>
        </div>
      </article>
    </PlayfulLegalShell>
  );
}
