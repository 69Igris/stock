import PaperTradingClient from "../client";
import ChartPreloadLinks from "@/components/charts/ChartPreloadLinks";
import { isDemoSession } from "@/lib/demo/session";
import { getSubscriptionAccess } from "@/lib/subscription/access";
import { paperTerminalShowsChart } from "@/lib/charts/preload-gate";

export default async function PaperTradingTerminalPage() {
  // MONEY-1383 (L2): only preload for a render that will MOUNT the chart.
  // `../client.tsx` shows "Charts available on Pro plan" to a free user, so
  // the unconditional preload spent ~480 KB brotli / 2.5 MB on the majority
  // tier for bundles no document ever executes.
  //
  // `getSubscriptionAccess()` is the same user-scoped cached read
  // `/api/subscription/access` serves to <PageGuard> moments later, so this is
  // a cache hit in the common case and never a second DB round trip. The
  // parent layout is already `force-dynamic` (it awaits `getFeatureFlags()`),
  // so nothing here costs a static render that existed before.
  const [isDemo, access] = await Promise.all([
    isDemoSession(),
    getSubscriptionAccess(),
  ]);
  const preloadChart = paperTerminalShowsChart({
    isDemo,
    planId: access.planId,
  });

  return (
    <>
      {/* MONEY-1383 (L2): rendered OUTSIDE <PageGuard>, so the 2.5 MB
          charting library starts downloading with the document instead of
          after the ~0.6s /api/subscription/access round-trip the guard
          blocks on before mounting the chart. */}
      {preloadChart && <ChartPreloadLinks />}
      <PaperTradingClient />
    </>
  );
}
