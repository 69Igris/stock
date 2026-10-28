import Link from "next/link";
import { getDocsAction } from "@/lib/actions/content";
import type { PostListItem } from "@usemoney/types";
import "./page.css";

export const metadata = {
  title: "Documentation",
  description:
    "UseMoney documentation — broker setup, AI chat, XIRR, FIRE, tax reports. Written by the team that builds the thing.",
  alternates: { canonical: "https://usemoney.ai/docs" },
  openGraph: {
    title: "Documentation · UseMoney",
    description:
      "UseMoney documentation — broker setup, AI chat, XIRR, FIRE, tax reports. Written by the team that builds the thing.",
    type: "website",
    url: "https://usemoney.ai/docs",
    images: [
      {
        url: "/og-website.png",
        width: 1200,
        height: 630,
        alt: "UseMoney Documentation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Documentation · UseMoney",
    description:
      "UseMoney documentation — broker setup, AI chat, XIRR, FIRE, tax reports. Written by the team that builds the thing.",
    images: ["/og-website.png"],
  },
};

interface SearchParams {
  q?: string;
}

// Editorial categories — fixed taxonomy that maps every published doc into
// one of these buckets via its tag list. The article count uses real
// Prisma data when matching docs exist; otherwise renders "Coming soon".
const CATEGORIES: Array<{
  key: string;
  match: string[];
  title: string;
  serif?: string;
  blurb: string;
  topics: string[];
  href: string;
  icon: React.ReactNode;
}> = [
  {
    key: "getstarted",
    match: ["getting-started", "get-started", "intro", "onboarding"],
    title: "Get",
    serif: "started",
    blurb:
      "Sign up, connect your first broker, take your first chat with StockSage.",
    topics: [
      "What is UseMoney?",
      "Your first 5 minutes",
      "Free vs PRO vs Premium",
      "Keyboard shortcuts",
      "Onboarding checklist",
    ],
    href: "/docs?tag=getting-started",
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
        <polyline points="13 17 18 12 13 7" />
        <polyline points="6 17 11 12 6 7" />
      </svg>
    ),
  },
  {
    key: "brokers",
    match: ["brokers", "broker", "oauth", "zerodha", "groww"],
    title: "Brokers",
    blurb:
      "OAuth setup, troubleshooting, CSV import, capability matrix per broker.",
    topics: [
      "Connecting Zerodha",
      "Connecting Groww",
      "All 8 brokers · setup guides",
      "CSV import (any broker)",
      "Troubleshooting OAuth errors",
    ],
    href: "/docs?tag=brokers",
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
        <path d="M16 18h.01M3 7h18M3 17h18" />
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
    ),
  },
  {
    key: "ai",
    match: ["ai", "stocksage", "chat", "credits", "gemini"],
    title: "StockSage",
    serif: "AI",
    blurb:
      "How chat works, credits explained, cite-and-audit, prompt patterns.",
    topics: [
      "How credits are spent",
      "Free chat (Flash) vs research",
      "Reading a citation",
      "Best prompts for fundamentals",
      "Exporting an answer",
    ],
    href: "/docs?tag=ai",
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12c0-3.87-3.13-7-7-7s-7 3.13-7 7" />
        <path d="M12 19c-3.87 0-7-3.13-7-7" />
      </svg>
    ),
  },
  {
    key: "portfolio",
    match: ["portfolio", "xirr", "holdings", "tradebook"],
    title: "Portfolio",
    serif: "& XIRR",
    blurb:
      "Holdings reconciliation, XIRR vs TWRR, allocation, drift, corporate actions.",
    topics: [
      "What is XIRR? (real)",
      "XIRR vs TWRR vs CAGR",
      "Allocation drift & rebalance",
      "Corporate action handling",
      "Manual tradebook",
    ],
    href: "/docs?tag=portfolio",
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
        <path d="M3 3v18h18" />
        <path d="m19 9-5 5-4-4-3 3" />
      </svg>
    ),
  },
  {
    key: "scanner",
    match: ["scanner", "discover", "screen", "screener"],
    title: "Scanner &",
    serif: "Discover",
    blurb: "Build screens, save presets, share, alerts, available indicators.",
    topics: [
      "Your first scanner",
      "70+ technical indicators",
      "Saving & sharing presets",
      "Entry / exit alerts",
      "Sector heatmap",
    ],
    href: "/docs?tag=scanner",
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
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    ),
  },
  {
    key: "strategy",
    match: ["strategy", "backtest", "backtesting", "scanner-strategy"],
    title: "Strategy &",
    serif: "Backtest",
    blurb:
      "Build no-code strategies, run backtests, read the metrics, walk-forward validation.",
    topics: [
      "Your first strategy",
      "No-code rule builder",
      "Reading a backtest result",
      "Walk-forward validation",
      "Sortino vs Sharpe",
    ],
    href: "/docs?tag=strategy",
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
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    key: "fire",
    match: ["fire", "swp", "retirement", "planning"],
    title: "FIRE &",
    serif: "planning",
    blurb:
      "FIRE math with INR assumptions, SWP modeling, drawdown survival, goals.",
    topics: [
      "FIRE basics, INR-native",
      "SWP modeling & survival",
      "Tax assumptions explained",
      "Three flavours of FIRE",
    ],
    href: "/docs?tag=fire",
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
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
  },
  {
    key: "tax",
    match: ["tax", "itr", "stcg", "ltcg", "capital-gains"],
    title: "Tax &",
    serif: "ITR",
    blurb:
      "ITR-ready capital gains, STCG / LTCG split, F&O business income, dividends.",
    topics: [
      "ITR-2 Schedule CG export",
      "STCG / LTCG / equity vs MF",
      "F&O business income",
      "Dividend TDS reconciliation",
    ],
    href: "/docs?tag=tax",
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
      </svg>
    ),
  },
  {
    key: "security",
    match: ["security", "privacy", "encryption", "auth"],
    title: "Security &",
    serif: "privacy",
    blurb: "OAuth scopes, AES-256-GCM, data residency, MFA, account deletion.",
    topics: [
      "Read-only OAuth, in detail",
      "Setting up MFA",
      "Per-device sessions",
      "Delete your account",
      "India-only data residency",
    ],
    href: "/docs?tag=security",
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
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
];

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d)
    .toLocaleString("en-IN", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    })
    .toUpperCase();
}

function readMinutes(post: PostListItem): number {
  const words = (post.excerpt || "").split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.min(15, Math.round(words / 50)));
}

function categoryOfPost(post: PostListItem): string | null {
  const haystack = post.tags
    .flatMap((t) => [t.slug, t.name])
    .map((s) => s.toLowerCase());
  for (const c of CATEGORIES) {
    if (c.match.some((m) => haystack.includes(m.toLowerCase()))) return c.key;
  }
  return null;
}

export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = params.q || undefined;

  const { posts, total } = await getDocsAction({
    page: 1,
    limit: 100,
    search: q,
  });

  const counts = new Map<string, number>();
  for (const p of posts) {
    const cat = categoryOfPost(p);
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }

  const recent = [...posts]
    .sort((a, b) => {
      const ad = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bd = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bd - ad;
    })
    .slice(0, 5);

  const quickKeys = ["getstarted", "brokers", "ai", "tax"];
  const quickLinks = quickKeys
    .map((key) => {
      const cat = CATEGORIES.find((c) => c.key === key)!;
      const post = posts.find((p) => categoryOfPost(p) === key);
      return { cat, post };
    })
    .filter((q) => q.post)
    .slice(0, 4);

  const totalLabel =
    total > 0
      ? `${total} article${total === 1 ? "" : "s"} · updated weekly`
      : "Coming soon · updated weekly";

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Docs · {totalLabel}
          </div>
          <h1>
            The <span className="ser">manual.</span>{" "}
            <span className="hl">RTFM</span> in the friendliest sense.
          </h1>
          <p className="last-updated">Last updated 28 May 2026</p>
          <p className="lede">
            Every product surface, every broker, every API call — explained for
            humans. Searchable. <b>Skim or read.</b>{" "}
            <span className="ser">
              Written by the team that builds the thing.
            </span>
          </p>

          <form className="doc-search" action="/docs" method="get">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              name="q"
              defaultValue={q || ""}
              placeholder="Search the docs — try 'connect zerodha' or 'XIRR'"
            />
          </form>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-h">
            <span className="num">01 / CATEGORIES</span>
            <h2>
              Browse by <span className="ser">topic.</span>
            </h2>
          </div>

          <div className="cat-grid">
            {CATEGORIES.map((c) => {
              const count = counts.get(c.key) ?? 0;
              return (
                <Link className="cat" key={c.key} href={c.href}>
                  <div className="cat-head">
                    <div className="ic">{c.icon}</div>
                    <h3>
                      {c.title}
                      {c.serif && (
                        <>
                          {" "}
                          <span className="ser">{c.serif}</span>
                        </>
                      )}
                    </h3>
                  </div>
                  <p>{c.blurb}</p>
                  <ul>
                    {c.topics.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                  {count > 0 ? (
                    <div className="count">
                      {count} article{count === 1 ? "" : "s"}
                    </div>
                  ) : (
                    <div className="soon">Coming soon</div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {quickLinks.length > 0 && (
        <section className="section" style={{ background: "var(--paper-2)" }}>
          <div className="container">
            <div className="section-h">
              <span className="num">02 / QUICK LINKS</span>
              <h2>
                The articles <span className="ser">everyone reads first.</span>
              </h2>
            </div>

            <div className="ql-grid">
              {quickLinks.map(({ cat, post }) => (
                <Link
                  key={post!.id}
                  className="ql"
                  href={`/docs/${post!.postUrl}`}
                >
                  <div className="kicker">
                    {readMinutes(post!)} MIN ·{" "}
                    {cat.title.replace(/&$/, "").trim().toUpperCase()}
                  </div>
                  <h4>{post!.title}</h4>
                  {post!.excerpt && <p>{post!.excerpt}</p>}
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {recent.length > 0 ? (
        <section className="section">
          <div className="container">
            <div className="section-h">
              <span className="num">03 / RECENT</span>
              <h2>
                Recently <span className="ser">updated.</span>
              </h2>
            </div>

            <div className="recent">
              {recent.map((post) => {
                const catKey = categoryOfPost(post);
                const catName = catKey
                  ? CATEGORIES.find((c) => c.key === catKey)
                      ?.title.replace(/&$/, "")
                      .trim()
                  : "Docs";
                return (
                  <Link
                    key={post.id}
                    className="recent-row"
                    href={`/docs/${post.postUrl}`}
                  >
                    <div className="date">{fmtDate(post.updatedAt)}</div>
                    <div>
                      <div className="t">{post.title}</div>
                      {post.excerpt && <div className="s">{post.excerpt}</div>}
                    </div>
                    <div className="cat-tag">{catName?.toUpperCase()}</div>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      ) : (
        <section className="section">
          <div className="container">
            <div className="docs-empty">
              <p>
                Docs are shipping weekly through beta. Next 30 days:
                Multi-broker connect setup · StockSage prompting guide ·
                Strategy builder walkthrough · Backtest interpretation · FIRE
                planner methodology · ITR capital-gains report. If there&apos;s
                something you need first, email{" "}
                <a href="mailto:docs@usemoney.ai">docs@usemoney.ai</a>.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="big-cta">
        <div className="container">
          <h2>
            Got stuck? <span className="hl">Just ask</span>{" "}
            <span className="ser">StockSage.</span>
          </h2>
          <p>
            Every doc page also lives inside the product — searchable from ⌘K.
            Free chat is unlimited.
          </p>
          <div className="cta-row">
            <Link className="btn-solid" href="/sign-up">
              Start free →
            </Link>
            <Link className="btn-flat" href="/glossary">
              Browse the glossary
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
