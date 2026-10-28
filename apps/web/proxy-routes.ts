/**
 * Route-matcher pattern lists for `proxy.ts` (the Next.js middleware).
 *
 * Extracted so `proxy.ts` (which imports `@clerk/nextjs/server`'s
 * `createRouteMatcher` and cannot be imported under `node --test`) and the
 * route-classification tests share the SAME source-of-truth arrays. Previously
 * these patterns were inlined in `proxy.ts` and re-implemented (drifted) inside
 * the security/middleware route tests.
 *
 * Keep this file dependency-free (no `@clerk/*`, no `next/*`).
 */

/** Public routes that never require authentication. */
export const PUBLIC_ROUTE_PATTERNS: string[] = [
  "/",
  "/home",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // OAuth/SSO callback — MUST be public. The Clerk session is established
  // client-side by handleRedirectCallback on this page; if the route is gated,
  // the unauthenticated handshake hit is bounced to
  // /sign-in?redirect_url=/sso-callback and loops, so a new user "signing up via
  // the sign-in flow" never completes. (MONEY-878)
  "/sso-callback(.*)",
  // Password reset — the user isn't signed in, so it must be reachable
  // (otherwise the middleware bounces it to /sign-in). (MONEY-881)
  "/forgot-password(.*)",
  "/privacy",
  "/terms",
  "/data-usage",
  "/risk-disclosure",
  "/subprocessors",
  "/legal",
  "/api/webhooks(.*)",
  "/api/demo(.*)",
  "/api/newsletter(.*)",
  // `app/(public)/unsubscribe` — token-verified newsletter unsubscribe. It sat
  // in the `(public)` route group, styled as marketing, `robots: noindex`, and
  // was in NEITHER pattern list, so the catch-all demanded a Clerk session.
  // A newsletter subscriber frequently has NO account at all, so gating it
  // makes unsubscribing impossible for exactly the people who need it — the one
  // page that must never require an identity.
  //
  // Not currently linked (emails point at `/api/newsletter/unsubscribe`, which
  // renders its own inline HTML and is public via the pattern above), so this
  // is not a live outage — it is a live trap for whoever wires the page up.
  //
  // Safe to expose: the page verifies its own signed token and shows nothing
  // without a valid one.
  "/unsubscribe(.*)",
  // Scheduled crons (apply-scheduled-plan-changes hourly, sync-products daily)
  // are invoked with `Authorization: Bearer ${CRON_SECRET}` and NO Clerk
  // session, so the middleware would 401 them before the handler runs. Safe to
  // make public because every cron handler fails closed on its own via the
  // timing-safe verifyCronAuth (@usemoney/security/cron-auth): 503 when
  // CRON_SECRET is unset, 401 on a missing/wrong token.
  "/api/cron(.*)",
  // /api/auth/signup-precheck (MONEY-144) is called by SignUpDeletionToast on
  // /sign-up; its ONLY audience is signed-OUT visitors, so a Clerk gate 401s
  // every caller (the toast then silently swallows it). Safe to make public
  // because the handler is per-IP rate-limited and anti-enumeration by contract
  // (always `{ blocked: false }` on every non-blocked path, 200-not-429 under
  // rate-limit, no user-existence signal).
  "/api/auth/signup-precheck",
  // /api/market/indices is the data feed for the MarketTicker shown on
  // /home (landing) + Sidebar. The handler is auth-aware - when
  // unauthenticated it falls back to Yahoo-only data - but it must not
  // be gated by middleware, otherwise the ticker store retries every
  // 5 s and floods production logs with 401s.
  "/api/market/indices",
  "/ingest(.*)", // PostHog analytics proxy (rewritten in next.config.js)
  "/learning(.*)",
  "/blog(.*)",
  "/newsletter(.*)",
  "/glossary(.*)",
  "/pricing(.*)",
  "/docs(.*)",
  "/alternatives(.*)", // "Compare" marketing page (UseMoney vs competitors)
  // Playful marketing routes (MONEY-483). All marketing surfaces must
  // be reachable without an account; the Resources dropdown should
  // resolve every link for signed-out visitors.
  "/features(.*)",
  "/about(.*)",
  "/changelog(.*)",
  "/roadmap(.*)",
  "/security(.*)",
  "/integrations(.*)",
];

/** API routes (everything under /api). */
export const API_ROUTE_PATTERNS: string[] = ["/api(.*)"];

/** App routes (dashboard, tradebook, etc.) — demo-cookie OR auth gated. */
export const APP_ROUTE_PATTERNS: string[] = [
  "/dashboard(.*)",
  "/stocksage(.*)",
  "/tradebook(.*)",
  "/positions(.*)",
  "/holdings(.*)",
  "/discover(.*)",
  "/analysis(.*)",
  "/tutor(.*)",
  "/fire(.*)",
  "/brokers(.*)",
  "/chat(.*)",
  "/chat-history(.*)",
  "/insights(.*)",
  "/paper-trading(.*)",
  "/settings(.*)",
  "/help(.*)",
  "/watchlist(.*)",
  "/stock(.*)",
  "/mf(.*)",
  // MONEY-1139 — `/etf/[symbol]` exists and was in NEITHER list, so it fell to
  // the catch-all below, which requires a Clerk session and has no demo branch.
  // Demo visitors browsing ETFs were bounced to /sign-in mid-session. Same
  // class as the /calculators omission noted further down; its siblings
  // `/stock` and `/mf` were always here, which is why it read as a one-off
  // rather than a pattern.
  //
  // Swept the rest of app/ while fixing this: `/launch`, `/welcome`, `/invite`
  // and `/debug-posthog` are also absent, and correctly so — they are post-auth
  // or internal, so "requires a real session, no demo path" is the intended
  // behaviour for them. Absence is only a bug for demo-visible product pages.
  "/etf(.*)",
  "/compare(.*)",
  "/roast(.*)",
  "/risk(.*)",
  "/tax(.*)",
  "/sage-tutor(.*)",
  "/quizzes(.*)",
  "/strategies(.*)",
  "/documents(.*)",
  "/feedback(.*)",
  // MONEY-394 - /calculators was missing, so demo users (no Clerk
  // session) fell through to the catch-all redirect at the bottom and
  // bounced to /sign-in. Calculator pages themselves are demo-friendly
  // (pure client math, no DB calls), so they only need to be in the
  // app-route group that accepts the HMAC demo cookie.
  "/calculators(.*)",
  // /notifications was the same shape of miss as /calculators — the
  // page itself short-circuits to `demoNotifications` via
  // `isDemoSession()` in getNotificationsAction (see
  // lib/actions/notifications.ts), but demo users never reached it
  // because the middleware redirected them to /sign-in first.
  "/notifications(.*)",
];
