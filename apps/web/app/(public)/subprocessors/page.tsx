import { PlayfulLegalShell } from "@/components/marketing/PlayfulLegalShell";
import "../legal/legal.css";

export const metadata = {
  title: "Subprocessors",
  description:
    "Full list of subprocessors UseMoney engages to deliver its services — infrastructure, auth, payments, AI, broker APIs.",
  alternates: { canonical: "https://usemoney.ai/subprocessors" },
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

const SERVER = I(
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </>
);
const SHIELD = I(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
const CARD = I(
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <line x1="2" y1="10" x2="22" y2="10" />
  </>
);
const MAIL = I(
  <>
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </>
);
const CHART = I(
  <>
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
  </>
);
const BANK = I(
  <>
    <line x1="3" y1="22" x2="21" y2="22" />
    <line x1="6" y1="18" x2="6" y2="11" />
    <line x1="10" y1="18" x2="10" y2="11" />
    <line x1="14" y1="18" x2="14" y2="11" />
    <line x1="18" y1="18" x2="18" y2="11" />
    <polygon points="12 2 20 7 4 7" />
  </>
);
const BRAIN = I(
  <>
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04Z" />
  </>
);
const DRIVE = I(
  <>
    <line x1="22" y1="12" x2="2" y2="12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </>
);

type Sub = { name: string; purpose: string; data: string; location: string };

const INFRA: Sub[] = [
  {
    name: "Google Cloud Platform",
    purpose: "Compute, AI, messaging, scheduling",
    data: "Portfolio data, trade pairing, research analysis, background jobs",
    location: "India (asia-south1) + US",
  },
  {
    name: "Vercel",
    purpose: "Web app hosting, serverless functions, edge network",
    data: "User sessions, page renders, API responses",
    location: "Global Edge · India POPs",
  },
  {
    name: "DigitalOcean",
    purpose: "Managed MongoDB, managed Redis",
    data: "All persistent data, cached data",
    location: "Bangalore",
  },
];

const AUTH: Sub[] = [
  {
    name: "Clerk",
    purpose: "User authentication, OAuth, session management",
    data: "Email, name, profile image, OAuth tokens",
    location: "US",
  },
];

const PAYMENTS: Sub[] = [
  {
    name: "Dodo Payments",
    purpose: "Subscription billing, payment processing",
    data: "Payment method, billing details, subscription status",
    location: "US / India",
  },
];

const COMMS: Sub[] = [
  {
    name: "Resend",
    purpose: "Transactional & newsletter email delivery",
    data: "Subscriber emails, notification content",
    location: "US",
  },
];

const ANALYTICS: Sub[] = [
  {
    name: "PostHog",
    purpose: "Product analytics, feature flags",
    data: "Page views, click events, user properties",
    location: "US",
  },
  {
    name: "Datadog",
    purpose: "APM, error tracking, performance monitoring",
    data: "Error stack traces, request metadata, performance metrics",
    location: "US",
  },
];

const BROKERS: Sub[] = [
  {
    name: "Zerodha (Kite Connect)",
    purpose: "Fetch holdings, positions, trades, mutual funds",
    data: "Portfolio data, trade history, MF holdings",
    location: "India",
  },
  {
    name: "Upstox API",
    purpose: "Fetch holdings, positions, trades",
    data: "Portfolio data, trade history",
    location: "India",
  },
  {
    name: "Angel One (SmartAPI)",
    purpose: "Fetch holdings, positions, trades",
    data: "Portfolio data, trade history",
    location: "India",
  },
  {
    name: "Groww API",
    purpose: "Fetch holdings, positions, trades",
    data: "Portfolio data, trade history",
    location: "India",
  },
  {
    name: "Dhan API",
    purpose: "Fetch holdings, positions, trades",
    data: "Portfolio data, trade history",
    location: "India",
  },
  {
    name: "Fyers API",
    purpose: "Fetch holdings, positions, trades",
    data: "Portfolio data, trade history",
    location: "India",
  },
  {
    name: "HDFC Sky API",
    purpose: "Fetch holdings, positions",
    data: "Portfolio data",
    location: "India",
  },
  {
    name: "ICICI Direct (Beta)",
    purpose: "Fetch holdings, positions (Beta)",
    data: "Portfolio data",
    location: "India",
  },
];

const AI: Sub[] = [
  {
    name: "Google Vertex AI (Gemini)",
    purpose: "AI chat, portfolio analysis, research, content generation",
    data: "User queries, portfolio context, analysis results",
    location: "India (asia-south1)",
  },
];

const STORAGE: Sub[] = [
  {
    name: "Google Cloud Storage",
    purpose: "Object storage for learning content, documents, reports",
    data: "User uploads, generated reports, learning media",
    location: "India (asia-south1)",
  },
];

function SubTable({ rows }: { rows: Sub[] }) {
  return (
    <table className="legal-sub-tbl">
      <thead>
        <tr>
          <th>Subprocessor</th>
          <th>Purpose</th>
          <th>Data processed</th>
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((sp) => (
          <tr key={sp.name}>
            <td className="nm">{sp.name}</td>
            <td>{sp.purpose}</td>
            <td>{sp.data}</td>
            <td className="loc">{sp.location}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SubprocessorsPage() {
  return (
    <PlayfulLegalShell
      eyebrow="Subprocessors · the full list"
      title="Sub"
      serif="processors"
      lede={
        <>
          UseMoney engages the following subprocessors to deliver its services.
          Everything below is open for inspection — no hidden third parties, no
          surprise data pipes. <b>India-only data residency</b> on every primary
          user store.
        </>
      }
      lastUpdated="28 May 2026"
      active="subprocessors"
    >
      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{SERVER}</span>
          <span className="lc-title">Infrastructure &amp; hosting</span>
        </header>
        <div className="lc-body">
          <SubTable rows={INFRA} />
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{SHIELD}</span>
          <span className="lc-title">Authentication &amp; identity</span>
        </header>
        <div className="lc-body">
          <SubTable rows={AUTH} />
        </div>
      </article>

      <article className="legal-card tone-3">
        <header className="lc-head">
          <span className="lc-ic">{CARD}</span>
          <span className="lc-title">Payments</span>
        </header>
        <div className="lc-body">
          <SubTable rows={PAYMENTS} />
        </div>
      </article>

      <article className="legal-card tone-4">
        <header className="lc-head">
          <span className="lc-ic">{MAIL}</span>
          <span className="lc-title">Communication</span>
        </header>
        <div className="lc-body">
          <SubTable rows={COMMS} />
        </div>
      </article>

      <article className="legal-card tone-5">
        <header className="lc-head">
          <span className="lc-ic">{CHART}</span>
          <span className="lc-title">Analytics &amp; monitoring</span>
        </header>
        <div className="lc-body">
          <SubTable rows={ANALYTICS} />
        </div>
      </article>

      <article className="legal-card tone-6">
        <header className="lc-head">
          <span className="lc-ic">{BANK}</span>
          <span className="lc-title">Broker data APIs</span>
        </header>
        <div className="lc-body">
          <SubTable rows={BROKERS} />
        </div>
      </article>

      <article className="legal-card tone-1">
        <header className="lc-head">
          <span className="lc-ic">{BRAIN}</span>
          <span className="lc-title">AI &amp; machine learning</span>
        </header>
        <div className="lc-body">
          <SubTable rows={AI} />
        </div>
      </article>

      <article className="legal-card tone-2">
        <header className="lc-head">
          <span className="lc-ic">{DRIVE}</span>
          <span className="lc-title">Storage</span>
        </header>
        <div className="lc-body">
          <SubTable rows={STORAGE} />
        </div>
      </article>
    </PlayfulLegalShell>
  );
}
