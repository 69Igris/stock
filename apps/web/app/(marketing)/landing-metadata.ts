import type { Metadata } from "next";

/**
 * MONEY-1130 — the marketing landing's metadata, shared by `/` and `/home`.
 *
 * Both routes render the same `HomeClient`, so they must describe themselves
 * identically. Keeping one object here is not just tidiness — it is the only
 * way the two stay in sync, and the `openGraph` block below has a sharp edge
 * that makes a forked copy actively dangerous.
 *
 * THE SHARP EDGE: Next.js merges metadata SHALLOWLY. A page that exports
 * `openGraph: { title, description }` REPLACES the root layout's entire
 * `openGraph` object — it does not merge into it. `/home` did exactly that, and
 * the built HTML proved the cost: `.next/server/app/home.html` carried only
 * `og:title` + `og:description`, having silently dropped `og:image`, `og:url`,
 * `og:site_name`, `og:locale` and `og:type` that `app/layout.tsx` provides. The
 * old `/` stub kept them purely because it declared no metadata of its own.
 *
 * Now that `/` IS the landing (and the URL people actually share), every
 * OpenGraph and Twitter field is spelled out in full here rather than relied on
 * from the parent. Adding a field to `app/layout.tsx`'s `openGraph` does NOT
 * reach these two routes — add it here too.
 *
 * `canonical` and `og:url` both point at `/`: `app/robots.ts` allows `/` and
 * disallows `/home`, so `/` is the indexable homepage and `/home` is the
 * internal signed-out landing that must never compete with it.
 */

const TITLE = "UseMoney AI — Ask anything about your money. Get real answers.";

const DESCRIPTION =
  "AI research grounded in your actual holdings across every broker. " +
  "Multi-broker portfolio analysis, no-code strategies with walk-forward " +
  "backtesting, and an INR-native FIRE planner — built for Indian retail " +
  "investors.";

const CANONICAL_URL = "https://usemoney.ai/";

export const LANDING_METADATA: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL_URL },
  openGraph: {
    type: "website",
    locale: "en_IN",
    siteName: "UseMoney AI",
    url: CANONICAL_URL,
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/og-website.png",
        width: 1200,
        height: 630,
        alt: "UseMoney AI - portfolio command center for Indian markets",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@usemoneyAI",
    creator: "@usemoneyAI",
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/og-website.png",
        alt: "UseMoney AI - portfolio command center for Indian markets",
      },
    ],
  },
};
