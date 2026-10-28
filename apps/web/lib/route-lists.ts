/**
 * Shared public-route lists for the app shell + terms gate.
 *
 * Extracted (dependency-free, no React / next) so `Sidebar.tsx`,
 * `TermsGate.tsx` AND the route-access consistency test all reference the SAME
 * arrays. Previously these lists were inlined in each component and a fourth
 * copy was asserted in `__tests__/middleware/route-access.test.ts` — adding a
 * public page (e.g. /data-usage) to one but not the others silently broke the
 * sidebar/ticker suppression or popped the terms modal over a legal page.
 */

/**
 * Routes where the authenticated app shell (sidebar + topbar + ticker) must NOT
 * render — i.e. public/marketing/legal surfaces. Consumed by
 * `Sidebar.tsx::isPublicShellRoute`.
 */
export const PUBLIC_SHELL_ROUTES: string[] = [
  "/",
  "/home",
  "/sign-in",
  "/sign-up",
  // MONEY-881: OAuth callback + password reset are auth pages too — keep them
  // chrome-less (no TopBar/Sidebar/CommandPalette) so the OAuth loader doesn't
  // flash the app shell.
  "/sso-callback",
  "/forgot-password",
  "/privacy",
  "/terms",
  "/data-usage",
  "/subprocessors",
  "/legal",
  "/blog",
  "/newsletter",
  "/glossary",
  "/docs",
  "/pricing",
  "/alternatives",
  "/risk-disclosure",
  // Playful marketing routes (MONEY-483)
  "/features",
  "/about",
  "/changelog",
  "/roadmap",
  "/security",
  "/integrations",
];

/**
 * Routes where the terms-acceptance modal must NEVER appear — public pages, auth
 * pages, and the legal documents a user must be able to read BEFORE accepting.
 * Consumed by `TermsGate.tsx::isExcludedPath`.
 */
export const TERMS_GATE_EXCLUDED_PATHS: string[] = [
  "/",
  "/home",
  "/sign-in",
  "/sign-up",
  "/sso-callback",
  "/forgot-password",
  "/terms",
  "/privacy",
  "/data-usage",
  "/risk-disclosure",
  "/legal",
  "/subprocessors",
  "/pricing",
  "/api/",
  "/blog",
  "/docs",
  "/glossary",
  "/newsletter",
  // The standalone welcome wizard handles its own UI — suppress the
  // TermsGate overlay so the onboarding sequence doesn't double-render.
  // The settings investor-profile editor is also excluded: it's a normal
  // authenticated page that users reach deliberately, not from onboarding.
  "/welcome",
  "/settings/investor-profile",
];
