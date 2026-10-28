import type { Metadata } from "next";
import { LANDING_METADATA } from "./landing-metadata";
import HomeClient from "./home/client";

/**
 * MONEY-1130 — `/` IS the marketing landing page. It is not a redirect stub.
 *
 * What it used to be: `app/page.tsx` rendered `app/client.tsx`, a client
 * component that waited for Clerk's `useUser().isLoaded` and then
 * `router.replace("/home")`. An anonymous visitor therefore paid:
 *
 *   middleware → prerendered `/` (a spinner) → download + init clerk.js →
 *   resolve session → client-navigate → fetch the `/home` RSC payload + bundle
 *
 * …two full page loads before a single word of the hero painted. Datadog RUM
 * confirmed it: the LCP element on `/` was the "Loading…" `<p>` of that stub.
 *
 * Why the landing lives HERE rather than `/` redirecting to `/home`:
 *
 *  1. Zero redirects. A server redirect would still cost a round trip before
 *     the hero starts downloading. Serving the page at `/` costs none — the
 *     HTML is prerendered at build time and served straight from the CDN.
 *  2. `/` is already the SEO surface. `app/robots.ts` ALLOWS `/` and
 *     DISALLOWS `/home`; `app/sitemap.ts` lists `/` at priority 1. Redirecting
 *     `/` → `/home` would point crawlers at a robots-disallowed URL, i.e. the
 *     homepage could not be indexed at all.
 *  3. It stays prerendered. This file is a server component with no
 *     `searchParams`, no `cookies()`/`headers()`/`auth()` — nothing
 *     per-request — so `/` remains in the prerender manifest exactly as the
 *     stub was.
 *
 * `/home` keeps working and keeps rendering the same `HomeClient` (one source
 * of truth for the content, two URLs): ~25 call sites push signed-out users
 * there, and `ClerkProvider`'s `afterSignOutUrl` targets it. `/home` declares
 * `/` as its canonical so the duplicate URL never competes in search.
 *
 * The signed-in case is NOT handled here — `apps/web/proxy.ts` redirects a
 * request for `/` that carries a Clerk session to `/dashboard` before this page
 * is ever reached. That is deliberate: the decision needs the session, and the
 * middleware is the only layer that has it without making `/` dynamic.
 */

export const metadata: Metadata = LANDING_METADATA;

export default function RootPage() {
  return <HomeClient />;
}
