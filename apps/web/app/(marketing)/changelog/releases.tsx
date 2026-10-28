import type { ReactNode } from "react";

/**
 * Changelog release entries — the source of truth.
 *
 * Each entry renders as one `.release` card in /changelog. Adding a new release
 * = prepend an object to RELEASES. The page paginates by PAGE_SIZE; no other
 * changes needed when the list grows.
 *
 * `title`, `intro`, and bullet items are typed as ReactNode so each entry can
 * embed inline JSX (`<strong>`, `<code>`, `<span className="ser">`, …) without
 * a structured schema getting in the way of copy.
 */

export type TagVariant = "major" | "minor" | "patch" | "pricing";
export type GroupType = "added" | "changed" | "fixed";

export interface ReleaseGroup {
  /** Group header label is derived from `type` (Added / Changed / Fixed). */
  type: GroupType;
  /** Override the header label when "Added" should read as e.g. "Planned". */
  label?: string;
  items: ReactNode[];
}

export interface Release {
  /** Stable slug for React keys + future deep-linking (e.g. /changelog#may-30). */
  id: string;
  /** Right-aligned chip in the .meta column. */
  tag: { variant: TagVariant; label: string };
  /** Date string shown under .ver — e.g. "Week of 19 May 2026". */
  date: string;
  /** Headline above the date. Rendered as ver (mono) + ver .ser (serif). */
  verPrimary: ReactNode;
  verSerif?: ReactNode;
  /** Full h3 body. */
  title: ReactNode;
  /** Italic Instrument-Serif intro paragraph. */
  intro: ReactNode;
  /** One or more Added/Changed/Fixed groups, rendered in order. */
  groups: ReleaseGroup[];
}

/** Newest first. Prepend new releases. */
export const RELEASES: Release[] = [
  {
    id: "may-30-2026-site-app-relaunch",
    tag: { variant: "major", label: "MAJOR" },
    date: "30 May 2026",
    verPrimary: <>Site &amp; App </>,
    verSerif: "Relaunch",
    title: (
      <>
        The whole product, repositioned around{" "}
        <span className="ser">the AI intelligence layer.</span>
      </>
    ),
    intro:
      "Playful design system across the app, AI-led marketing site, newsletter and roadmap go public.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <strong>Playful design system</strong> on landing, auth, and 40+ app
            routes.
          </>,
          <>
            <strong>StockSage 3-pane chat</strong> with citations rail.
          </>,
          <>
            <strong>Newsletter audience</strong> on Resend, weekly long-read.
          </>,
          <>
            <strong>/roadmap</strong> · public 3-month forward plan.
          </>,
          <>
            <strong>Broker integrations staged</strong>: Zerodha in beta, seven
            more coming soon.
          </>,
          <>
            <strong>Portfolio XIRR + CAGR</strong> across holdings and
            dashboard.
          </>,
          <>
            <strong>Risk Analysis v2</strong> · snapshot, diagnose, stress,
            decide, calibrate.
          </>,
          <>
            <strong>Tax Report v2</strong> with CA-grade tabs.
          </>,
          <>
            <strong>Reusable playful primitives</strong> · placeholders,
            pickers, banners, toasts.
          </>,
          <>
            <strong>28 per-page loading skeletons</strong>.
          </>,
        ],
      },
      {
        type: "changed",
        items: [
          <>
            Homepage leads with <strong>AI research</strong>, not multi-broker.
          </>,
          <>
            Pricing reconciled to{" "}
            <strong>Free / PRO ₹249·mo / Premium ₹1,499·mo</strong>.
          </>,
          <>
            Default theme is <strong>light (&quot;Cream&quot;)</strong>; dark
            renamed <strong>Deep Ink</strong>.
          </>,
          "Custom Clerk-hook auth · sign-in/up, email-OTP, forgot-password, SSO.",
          <>
            Landing-after-login is configurable: <strong>Dashboard</strong> or{" "}
            <strong>StockSage</strong>.
          </>,
          <>
            Marketing nav · new <strong>Product</strong> dropdown.
          </>,
        ],
      },
      {
        type: "fixed",
        items: [
          "Sign-in/up post-auth dead-end via isSignedIn guard.",
          "Clerk Account modal dark-mode contrast.",
          "Holdings positions tab infinite refetch on zero-position accounts.",
          "Mobile bottom nav leaking onto desktop.",
          "Profile-menu flyout overflow and anchoring.",
        ],
      },
    ],
  },
  {
    id: "week-of-19-may-2026-news-sectors-strategies",
    tag: { variant: "major", label: "MAJOR" },
    date: "Week of 19 May 2026",
    verPrimary: <>News, Sectors &amp; </>,
    verSerif: "Strategies",
    title: (
      <>
        Three new verticals ·{" "}
        <span className="ser">News, Sectors, Strategies</span>: plus live risk
        stress-tests.
      </>
    ),
    intro:
      "News feed, sector deep-dive, and a Strategies builder land with worker pipelines behind them.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <strong>News &amp; Events</strong> · 4 tabs, categories, sources,
            side panel.
          </>,
          <>
            <strong>Sectors deep-dive</strong> · fundamentals, correlation,
            FII/DII, calendar.
          </>,
          <>
            <strong>Strategies builder</strong> · 6 stat fields, 6 tabs, 8
            categories, backtest.
          </>,
          <>
            <strong>Risk stress-test backend</strong> · live runner on the Risk
            dashboard.
          </>,
          <>
            <strong>Roast scope picker</strong> · 4 sources &times; 5 time
            ranges.
          </>,
          <>
            <strong>Document Vault &rarr; research pin</strong>.
          </>,
          <>
            <strong>Holdings-triggered research</strong> pre-fill in chat.
          </>,
          <>
            News ingestion, alerts schema, <code>strategy-stats</code> worker,
            Pub/Sub crons.
          </>,
        ],
      },
      {
        type: "changed",
        items: ["Notifications redesigned · underline tabs, per-type icons."],
      },
    ],
  },
  {
    id: "week-of-12-may-2026-hardening-coverage",
    tag: { variant: "patch", label: "PATCH" },
    date: "Week of 12 May 2026",
    verPrimary: <>Hardening &amp; </>,
    verSerif: "Coverage",
    title: (
      <>
        11,501 tests at 100% pass, <span className="hl">28 page-skeletons</span>
        , FREE plan opened up.
      </>
    ),
    intro:
      "Deeper coverage, kinder loading states, hardened broker OAuth, and a Free tier with real teeth.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <strong>Test coverage push</strong> (MONEY-393) · 17 new sections,
            c8 tooling, DRM contracts.
          </>,
          <>
            <strong>Page-skeleton sweep</strong> (MONEY-392) · 28+ skeletons,
            chat history lazy-load.
          </>,
        ],
      },
      {
        type: "changed",
        items: [
          <>
            <strong>Feature-flag cleanup</strong> (MONEY-394) · ungated{" "}
            <code>/analysis</code>, <code>/discover</code>,{" "}
            <code>/documents</code> for FREE.
          </>,
          "Custom Skills + Document-Vault locked for FREE; advanced research styles locked for FREE.",
          <>
            <code>UpgradePrompt</code> redesigned.
          </>,
        ],
      },
      {
        type: "fixed",
        items: [
          "OAuth CSRF state added across all 7 broker callbacks (MONEY-287).",
          <>
            Research session lookups scoped by <code>userId</code> · IDOR closed
            (MONEY-286).
          </>,
          <>
            Removed all-zero <code>ENCRYPTION_KEY</code> fallback (MONEY-285).
          </>,
        ],
      },
    ],
  },
  {
    id: "week-of-5-may-2026-terminal-luxe-v3",
    tag: { variant: "major", label: "MAJOR" },
    date: "Week of 5 May 2026",
    verPrimary: "Terminal-Luxe ",
    verSerif: "v3",
    title: (
      <>
        The Terminal-Luxe rollout reaches{" "}
        <span className="ser">every authenticated page.</span>
      </>
    ),
    intro:
      "Holdings, Tradebook, FIRE, Brokers, Settings, Roast, Analysis and Discover all move to v3.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <strong>Markets v3</strong> · treemap heatmap, market-hours refresh.
          </>,
          <>
            <strong>Screener v3</strong> · cards, watchlist popover, server-side
            pagination.
          </>,
          <>
            <strong>Stock detail v3</strong> · identity header, Summary /
            Financials / Peers / News.
          </>,
          <>
            <strong>Fund detail v3</strong> · key stats grid, NAV chart, SIP
            calculator.
          </>,
          <>
            <strong>Holdings</strong> · Stocks / MF / Positions tabs.
          </>,
          <>
            <strong>Tradebook</strong> · list + 4-step import wizard.
          </>,
          <>
            <strong>FIRE</strong>, <strong>Brokers</strong> multi-account,
            <strong>Settings</strong> (9 tabs).
          </>,
          <>
            <strong>Portfolio Roast</strong> redesign + 8-axis score.
          </>,
          <>
            <strong>Analysis</strong> list and detail pages.
          </>,
        ],
      },
      {
        type: "changed",
        items: [
          <>
            <strong>Chat hardening</strong> (MONEY-295) · topic classifier,
            graceful degradation, refusal UI.
          </>,
          <>
            <strong>Research v2</strong> (MONEY-239/240) · confirmation sheet,
            dynamic billing, LLM rewrite.
          </>,
          "Default planner emits 22-task baseline; 3.0 Flash family.",
        ],
      },
    ],
  },
  {
    id: "week-of-28-apr-2026-discover-surfaces",
    tag: { variant: "minor", label: "MINOR" },
    date: "Week of 28 April 2026",
    verPrimary: "Discover ",
    verSerif: "Surfaces",
    title: (
      <>
        Markets, Screener and detail pages ·{" "}
        <span className="hl">redrawn end to end.</span>
      </>
    ),
    intro:
      "Discovery becomes one calm surface · heatmaps, cards, and identity-led detail pages.",
    groups: [
      {
        type: "added",
        items: [
          <>
            Markets v3 · heatmap tabs (1D / 1W / 1M / YTD),{" "}
            <code>MarketTickerStrip</code>.
          </>,
          <>
            Screener v3.x · MF + ETF cards, compact filters, combined Funds
            &amp; ETFs tab.
          </>,
          "Server-side pagination + searchable Category / AMC dropdowns.",
          "Stock detail v3.1 · Summary / Financials / Peers / News cached.",
          "Fund detail v3.1 · identity polish, key stats, SIP calculator.",
        ],
      },
    ],
  },
  {
    id: "week-of-21-apr-2026-settings-foundations",
    tag: { variant: "minor", label: "MINOR" },
    date: "Week of 21 April 2026",
    verPrimary: <>Settings &amp; </>,
    verSerif: "Foundations",
    title: "The plumbing that made the v3 sweep possible.",
    intro:
      "Shared Settings primitives, Linked-accounts integration, and emerald CTAs repo-wide.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <code>SetRow</code> primitive · spine of every Settings tab.
          </>,
          <>Linked-accounts on the Settings &rarr; Integrations tab.</>,
        ],
      },
      {
        type: "changed",
        items: [
          "Repo-wide CTA palette flipped to emerald.",
          "Terminal-Luxe gradient cards across all Settings tabs.",
        ],
      },
    ],
  },
  {
    id: "apr-2026-pricing-v2",
    tag: { variant: "pricing", label: "PRICING" },
    date: "April 2026",
    verPrimary: "Pricing ",
    verSerif: "v2",
    title: (
      <>
        Pricing v2: <span className="hl">Monthly / Annual</span> + scheduled
        changes.
      </>
    ),
    intro:
      "Free / PRO / Premium / Ultimate · monthly or annual, downgrades respect paid time.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <strong>PRO</strong> · ₹249/mo or ₹1,999/yr · unlimited brokers, 50
            credits.
          </>,
          <>
            <strong>Premium</strong> · ₹1,499/mo or ₹14,990/yr · 200 credits.
          </>,
          <>
            <strong>Ultimate</strong> · ₹4,999/mo or ₹49,990/yr · 750 credits.
          </>,
          "Scheduled plan changes · downgrades take effect at term end.",
        ],
      },
      {
        type: "changed",
        items: ["Credit packs (50 / 100 / 250 / 500 / 1000) never expire."],
      },
    ],
  },
  {
    id: "late-mar-mid-apr-2026-document-sync-ci",
    tag: { variant: "major", label: "MAJOR" },
    date: "Late March – Mid April 2026",
    verPrimary: <>Document Sync &amp; </>,
    verSerif: "CI",
    title: (
      <>
        The data spine: <span className="ser">2,100 stocks</span> scraped,
        chunked, and ready for RAG.
      </>
    ),
    // MONEY-1144 — described a named third party's site as something we scrape,
    // on a PUBLIC page. Worse than the in-app vendor pills this ticket removed:
    // it is us advertising the practice, not just the provenance.
    intro:
      "Branch-naming enforced, a self-paginating fundamentals ingester, and the AI engine moves to production.",
    groups: [
      {
        type: "added",
        items: [
          <>
            <strong>Branch-naming convention</strong> enforced · Husky + GitHub
            Actions; <code>{`{type}/MONEY-{number}`}</code>.
          </>,
          <>
            <strong>Stock document sync</strong> · full fundamentals ingest,
            ~2,100 stocks to GCS.
          </>,
          <>
            <strong>AI financial analysis engine</strong> · multi-skill, 20+
            tools, planner/executor.
          </>,
          <>
            <strong>Credit-based pricing</strong> replaces flat tiers.
          </>,
          <>
            <strong>MongoDB Atlas Search</strong> · Instrument + MF + Vector
            indexes; QA falls back to regex.
          </>,
        ],
      },
      {
        type: "fixed",
        items: [
          "Pub/Sub SDK credential auto-detect on Cloud Run.",
          <>
            GCS resumable + CRC32C disabled for large uploads (
            <code>resumable:false, validation:false</code>).
          </>,
        ],
      },
    ],
  },
];

/** How many entries render per page. Tune as the list grows. */
export const PAGE_SIZE = 6;

/** Default header label per group type. Can be overridden per-group. */
export const GROUP_LABELS: Record<GroupType, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
};
