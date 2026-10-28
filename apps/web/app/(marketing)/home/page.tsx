import type { Metadata } from "next";
import { LANDING_METADATA } from "../landing-metadata";
import HomeClient from "./client";

/**
 * MONEY-1130 — `/home` and `/` render the SAME `HomeClient` and share the SAME
 * metadata. `/` is the canonical marketing URL (allowed in robots.ts, priority
 * 1 in sitemap.ts); `/home` is the internal signed-out landing that ~25 call
 * sites and `ClerkProvider afterSignOutUrl` push to, and which robots.ts
 * deliberately disallows.
 *
 * Keeping both alive is deliberate — one component, one metadata object, two
 * URLs, no forked copy. The shared `canonical` points at `/` so the duplicate
 * never competes with it in search.
 *
 * This file used to declare its own partial `openGraph`/`twitter`, which
 * SHALLOWLY REPLACED the root layout's and silently stripped `og:image`,
 * `og:url`, `og:site_name`, `og:locale` and `og:type` from every share of this
 * page. See `../landing-metadata.ts` for the full story.
 */
export const metadata: Metadata = LANDING_METADATA;

export default function HomePage() {
  return <HomeClient />;
}
