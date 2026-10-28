/**
 * Server-side gate for /paper-trading (MONEY-444).
 *
 * Paper-trading is kill-switched behind the `page-visibility-paper-trading`
 * PostHog flag. The client-side PageGuard already redirects to /dashboard
 * when the flag is off, but only AFTER the user has already seen
 * Next.js' loading.tsx and PageGuard's flag-loading skeleton — visible
 * flash through stages 1 and 2.
 *
 * This server layout evaluates the flag on the server BEFORE any HTML
 * is sent. If the flag is off, Next.js' redirect() throws and a 307 is
 * returned to the browser, which navigates to /dashboard without ever
 * rendering the paper-trading shell.
 *
 * The client interactivity (sub-nav, market clock, Sidebar state) lives
 * in PaperTradingLayoutClient — this server component is a thin wrapper
 * that does the gate check and delegates to the client layout for
 * allowlisted users.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFeatureFlags } from "@/lib/actions/feature-flags";
import PaperTradingLayoutClient from "./PaperTradingLayoutClient";

// Distinct browser-tab / share title for the whole /paper-trading section
// (overview, positions, history, analytics, terminal) instead of the
// generic site default.
export const metadata: Metadata = {
  title: "Paper Trading",
};

// getFeatureFlags() calls Clerk's auth() which reads headers(); without
// this hint Next.js tries to statically optimise the route and trips on
// the dynamic-server-usage check.
export const dynamic = "force-dynamic";

export default async function PaperTradingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { flags } = await getFeatureFlags();
  if (!flags["/paper-trading"]) {
    redirect("/dashboard");
  }
  return <PaperTradingLayoutClient>{children}</PaperTradingLayoutClient>;
}
