import Link from "next/link";

/**
 * Shared chrome for /privacy, /terms, /data-usage, /subprocessors.
 * Renders the playful page-head with eyebrow + headline + lede +
 * "last updated" stamp, then a sidebar of sibling legal pages alongside
 * the content slot. Each sub-page passes only its own copy and content
 * blocks — header, sidebar nav, and the bottom contact strip are
 * defined here once so all four pages stay visually identical.
 */

interface LegalShellProps {
  eyebrow: string;
  title: string;
  serif?: string;
  hl?: string;
  trailing?: string;
  lede: React.ReactNode;
  lastUpdated: string;
  active:
    | "privacy"
    | "terms"
    | "data-usage"
    | "subprocessors"
    | "risk-disclosure";
  children: React.ReactNode;
}

const LEGAL_PAGES = [
  { key: "privacy", href: "/privacy", label: "Privacy Policy" },
  { key: "terms", href: "/terms", label: "Terms of Service" },
  { key: "data-usage", href: "/data-usage", label: "Data Usage" },
  { key: "subprocessors", href: "/subprocessors", label: "Subprocessors" },
  {
    key: "risk-disclosure",
    href: "/risk-disclosure",
    label: "SEBI Risk Disclosure",
  },
] as const;

export function PlayfulLegalShell({
  eyebrow,
  title,
  serif,
  hl,
  trailing,
  lede,
  lastUpdated,
  active,
  children,
}: LegalShellProps) {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            {eyebrow}
          </div>
          <h1>
            {title}
            {serif && (
              <>
                {" "}
                <span className="ser">{serif}</span>
              </>
            )}
            {hl && (
              <>
                {" "}
                <span className="hl">{hl}</span>
              </>
            )}
            {trailing && <> {trailing}</>}
          </h1>
          <p className="lede">{lede}</p>
          <div className="legal-stamp">
            <span className="dot" />
            Last updated · {lastUpdated}
          </div>
        </div>
      </section>

      <section className="section legal-body">
        <div className="container legal-grid">
          <aside className="legal-aside">
            <div className="legal-aside-label">Legal</div>
            <ul>
              {LEGAL_PAGES.map((p) => (
                <li key={p.key}>
                  <Link
                    href={p.href}
                    className={p.key === active ? "is-active" : undefined}
                  >
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="legal-aside-foot">
              Questions?{" "}
              <a href="mailto:legal@usemoney.ai">legal@usemoney.ai</a>
            </div>
          </aside>

          <div className="legal-content">{children}</div>
        </div>
      </section>
    </>
  );
}
