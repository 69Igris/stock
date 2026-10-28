/**
 * /launch — post-login redirect router.
 *
 * Reads the signed-in user's `preferences.defaultPage` and forwards them to:
 *   - "stocksage" → /stocksage  (opens StockSage / chat mode) — THE DEFAULT
 *   - "dashboard"  → /dashboard           (opens the portfolio overview)
 *
 * Chat is where an unset user lands; the preference is opt-in, so that is
 * nearly everyone. An explicitly saved "dashboard" is still honoured.
 *
 * Before reading the preference it provisions the DB user
 * (getAuthenticatedUser → getOrCreateDbUser) so a brand-new OAuth user whose
 * row isn't materialised yet doesn't fail the pref read and get bounced back
 * toward sign-in (MONEY-878).
 *
 * Both ClerkProvider.signInFallbackRedirectUrl and the SSO callback's
 * signInForceRedirectUrl point here so sign-in via any method respects the
 * pref.
 *
 * Sign-up flows stay wired to /dashboard directly — new users have no
 * saved preference yet, so the overview is the right landing.
 *
 * Unauthenticated hits are caught by the auth middleware and routed
 * through sign-in before ever reaching this component.
 */

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";
import { getDefaultPagePreferenceAction } from "@/lib/actions/user";

// `/launch` reads the signed-in user's preference (via Clerk `headers()`) and
// redirects. There is nothing to prerender — opt out of static generation so
// the build doesn't invoke the action with no auth context and log a noisy
// DYNAMIC_SERVER_USAGE error during `Generating static pages`.
export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  // MONEY-878 — provision the DB user BEFORE reading any preference. A
  // brand-new OAuth user (a "sign in" that Clerk transferred into a sign-up)
  // can reach /launch before their DB row exists. getAuthenticatedUser() runs
  // getOrCreateDbUser(), materialising that row so the preference read below —
  // and every downstream page action — resolves against a real user instead
  // of failing and leaving the user bounced back toward sign-in.
  const authUser = await getAuthenticatedUser();

  // Couldn't resolve/provision the user. Don't silently fall through; send
  // them to the dashboard (the safe new-user landing — a client shell whose
  // own actions retry provisioning) with an explicit marker for traceability,
  // rather than landing back on sign-in with no signal.
  if (!authUser) {
    redirect("/dashboard?from=launch");
  }

  const result = await getDefaultPagePreferenceAction();

  // Honour the resolved preference. "stocksage" is now the default the action
  // returns when nothing is stored, so an unset user lands on chat; an
  // explicitly saved "dashboard" still wins.
  if (result.success) {
    redirect(result.value === "dashboard" ? "/dashboard" : "/stocksage");
  }

  // The action FAILED — we don't know the preference. Land on /dashboard
  // rather than the default: this is the same reasoning as the !authUser
  // branch above. The dashboard is a client shell whose own actions retry
  // provisioning, so it recovers from the condition that just broke the read.
  // Deliberately NOT the default page — an error path should go somewhere
  // resilient, not somewhere merely typical.
  redirect("/dashboard?from=launch-pref-error");
}
