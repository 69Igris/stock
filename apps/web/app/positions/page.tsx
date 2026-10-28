// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

/**
 * Positions has been folded into Holdings as the third tab (Stocks · MF · Positions)
 * per the Terminal Luxe redesign (MONEY-187). This route now redirects so external
 * links and bookmarks continue to work. The standalone `client.tsx` is no longer
 * rendered but kept on disk for reference until MONEY-185 fully retires it.
 */
export default function PositionsPage() {
  redirect("/holdings?tab=positions");
}
