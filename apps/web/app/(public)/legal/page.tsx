import Link from "next/link";
import "./legal.css";

export const metadata = {
  title: "Legal",
  description:
    "Privacy policy, terms of service, data usage, subprocessors — every legal document that governs your use of UseMoney.",
  alternates: { canonical: "https://usemoney.ai/legal" },
};

const LEGAL_PAGES: Array<{
  href: string;
  title: string;
  serif?: string;
  blurb: string;
  icon: React.ReactNode;
}> = [
  {
    href: "/privacy",
    title: "Privacy",
    serif: "Policy",
    blurb:
      "What we collect, how we store it, who we share it with, and how you can ask us to delete it.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    href: "/terms",
    title: "Terms",
    serif: "of Service",
    blurb:
      "What you can and can't do with UseMoney, what we owe each other, and where the disclaimers live.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="9" y1="13" x2="15" y2="13" />
        <line x1="9" y1="17" x2="15" y2="17" />
      </svg>
    ),
  },
  {
    href: "/data-usage",
    title: "Data",
    serif: "usage",
    blurb:
      "How broker data flows through the product — what's encrypted, what's cached, what's retained.",
    icon: (
      <svg
        width="18"
        height="18"
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
    ),
  },
  {
    href: "/subprocessors",
    title: "Sub",
    serif: "processors",
    blurb:
      "The full list of third-party processors we engage — Clerk, MongoDB Atlas, Vercel, Dodo, and more.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    href: "/risk-disclosure",
    title: "SEBI",
    serif: "risk disclosure",
    blurb:
      "The investment-risk warning SEBI requires. Past performance, no guarantees, not investment advice.",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  {
    href: "/security",
    title: "Security",
    serif: "architecture",
    blurb:
      "How we protect your data — AES-256-GCM encryption, read-only broker access, zero-trust infra.",
    icon: (
      <svg
        width="18"
        height="18"
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
    ),
  },
];

export default function LegalPage() {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Legal · the fine print, kept short
          </div>
          <h1>
            The <span className="ser">fine print,</span> in{" "}
            <span className="hl">plain English.</span>
          </h1>
          <p className="lede">
            What you&apos;re agreeing to, what we&apos;re promising in return,
            and where your data goes. <b>Written by humans</b> who&apos;d want
            to read it themselves.
          </p>
        </div>
      </section>

      <section className="section" style={{ padding: "60px 0" }}>
        <div className="container">
          <div className="legal-cards">
            {LEGAL_PAGES.map((p) => (
              <Link key={p.href} href={p.href}>
                <div className="lh">
                  <span className="ic">{p.icon}</span>
                  <h3>
                    {p.title} <span className="ser">{p.serif}</span>
                  </h3>
                </div>
                <p>{p.blurb}</p>
                <span className="arrow">Read →</span>
              </Link>
            ))}
          </div>

          <div
            style={{
              marginTop: 36,
              padding: "22px 26px",
              border: "2px dashed var(--ink)",
              borderRadius: 14,
              background: "var(--paper-3)",
              display: "flex",
              gap: 20,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontStyle: "italic",
                fontSize: 17,
                color: "var(--ink-2)",
                maxWidth: 560,
              }}
            >
              Questions about any of the above? Our legal team reads every
              email.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a className="btn-flat" href="mailto:legal@usemoney.ai">
                Email legal →
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
