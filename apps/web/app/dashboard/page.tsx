export const dynamic = "force-dynamic";

import { getDashboardStatsAction } from "@/lib/actions/dashboard";
import { isDemoSession } from "@/lib/demo/session";
import { withTimeout } from "@/lib/utils/with-timeout";
import DashboardPageClient from "./client";

/**
 * MONEY-1126: the dashboard used to ship ZERO data from the server — it awaited
 * only `isDemoSession()` and then let the client fire `getDashboardStatsAction`
 * on mount, which is serialized behind clerk.js loading (`useIDBCache` needs a
 * Clerk `user.id` before it will even look in IndexedDB). That put a full
 * server-action round trip on the critical path of a page whose p75
 * network-settle was 14.4s.
 *
 * `app/holdings/page.tsx` already had the shape: resolve on the server behind a
 * soft timeout, hand the result down as `initialX`. The dashboard service is
 * already parallel + projected + Redis-cached, so this is a straight move of an
 * existing cost from the client's critical path to the server's, where it
 * overlaps the rest of the render instead of queueing behind auth.
 *
 * Chat history is deliberately NOT warm-loaded here — see the note in
 * `./client.tsx`.
 */
export default async function DashboardPage() {
  const isDemo = await isDemoSession();

  // `.catch(() => null)` BEFORE the race: past the deadline nothing is awaiting
  // this promise any more, so a late rejection would surface as an unhandled
  // rejection and take down the render. A failure here is not fatal — the
  // client refetches.
  const statsResult = await withTimeout(
    getDashboardStatsAction().catch(() => null),
    4000
  );

  const initialStats =
    statsResult?.success && statsResult.data ? statsResult.data : null;

  return <DashboardPageClient isDemo={isDemo} initialStats={initialStats} />;
}
