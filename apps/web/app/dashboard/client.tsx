"use client";

import { useState, useEffect } from "react";
import { useChatHistoryCache } from "@/hooks/useChatHistoryCache";
import { useRouter, useSearchParams } from "next/navigation";
import { DemoBanner } from "@/components/DemoBanner";
import DashboardOverview from "@/components/dashboard/DashboardOverview";
import { getDashboardStatsAction } from "@/lib/actions/dashboard";
import { useIDBCache } from "@/hooks/useIDBCache";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";
import type { DashboardStats } from "@usemoney/types";
import { AppShell, useAppAuthGuard } from "@/components/app/AppShell";

// ---------------------------------------------------------------------------
// Dashboard = the portfolio OVERVIEW only. The StockSage chat surface moved to
// its own /stocksage route (own client, skeleton, active-nav). This client no
// longer imports the chat stack or ChatProvider — it just renders the overview
// and forwards any legacy chat-intent URL to /stocksage.
// ---------------------------------------------------------------------------

// Greeting prefix that respects the user's local timezone - computed after
// hydration so SSR (server-time) doesn't lock the initial render to a wrong
// "Good morning". `isNew = true` skips the greeting for a first-time welcome.
function useGreetingPrefix(isNew: boolean): string | null {
  const [prefix, setPrefix] = useState<string | null>(null);
  useEffect(() => {
    if (isNew) {
      setPrefix("Welcome,");
      return;
    }
    const compute = () => {
      const hour = new Date().getHours(); // browser-local
      if (hour < 12) return "Good morning,";
      if (hour < 17) return "Good afternoon,";
      return "Good evening,";
    };
    setPrefix(compute());
    const id = window.setInterval(() => setPrefix(compute()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, [isNew]);
  return prefix;
}

export default function DashboardPage({
  isDemo,
  initialStats = null,
}: {
  isDemo?: boolean;
  /**
   * MONEY-1126: dashboard stats resolved by the server component. `null` when
   * the server call failed or blew its soft deadline — the client then fetches
   * exactly as it did before, so this is additive.
   */
  initialStats?: DashboardStats | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ownedRoute = useOwnedRoute("/dashboard");
  const { user } = useAppAuthGuard(isDemo);
  const userName = user?.fullName || user?.firstName || "Trader";
  const isDemoInner = useIsDemoMode({ isDemo, user });

  // StockSage now lives at its own /stocksage route. Any legacy chat-intent
  // landing on /dashboard (?view=chat / ?chatId / ?prompt / ?tool / ?userText —
  // old links, deep-links, walkthrough) is transparently forwarded to /stocksage
  // so the overview stays chat-free and the sidebar active-state + skeleton
  // resolve correctly.
  useEffect(() => {
    if (!searchParams) return;
    const isChatIntent =
      searchParams.get("view") === "chat" ||
      searchParams.has("chatId") ||
      searchParams.has("prompt") ||
      searchParams.has("tool") ||
      searchParams.has("userText");
    if (isChatIntent) {
      const qs = searchParams.toString();
      // MONEY-1082: guarded so the forward can't fire after the user has
      // already navigated somewhere other than /dashboard. The effect keys on
      // `searchParams`, which the router re-issues across a transition.
      ownedRoute.replaceRoute(`/stocksage${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    }
  }, [searchParams, ownedRoute]);

  // New-user detection - first-time visit has no chat history. Cached via
  // useChatHistoryCache so this doesn't add a roundtrip.
  //
  // MONEY-1126: deliberately NOT warm-loaded from the server component. This is
  // a different cache (`lib/chat-history/idb-cache`, its own BroadcastChannel
  // refresh bus and pagination cursor), it takes no `initialData` seam, and it
  // pages 25 rows purely to answer "is this length 0?". Threading SSR through it
  // would mean reshaping a hook shared with the StockSage surfaces for a boolean
  // that only picks a greeting string — cost far above the benefit.
  const { chats: historyChats, loading: historyLoading } = useChatHistoryCache({
    isArchived: false,
    searchQuery: "",
  });
  const isNewUser = !historyLoading && historyChats.length === 0;
  const greetingPrefix = useGreetingPrefix(isNewUser);

  const { data: stats } = useIDBCache<DashboardStats>({
    module: "dashboard",
    identifier: "stats",
    // Server-resolved payload. `useIDBCache` adopts it and skips the mount
    // fetch entirely (and persists it to IDB when IDB is available).
    initialData: initialStats,
    fetcher: async () => {
      const result = await getDashboardStatsAction();
      if (result?.success && result?.data)
        return result?.data as DashboardStats;
      throw new Error(result?.error || "Failed to load dashboard data");
    },
    skip: !user && !isDemoInner,
  });

  // "Ask Sage" from the overview jumps to the dedicated chat route, seeding the
  // question via ?prompt= (local state can't survive the route change).
  const handleAsk = (text: string) =>
    router.push(`/stocksage?prompt=${encodeURIComponent(text)}`, {
      scroll: false,
    });

  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pb-[calc(60px+env(safe-area-inset-bottom,0px))] lg:pb-0">
        {isDemoInner && (
          <div className="px-6 pt-6">
            <DemoBanner />
          </div>
        )}
        <DashboardOverview
          stats={stats}
          greeting={greetingPrefix}
          userName={userName}
          onAsk={handleAsk}
        />
      </div>
    </AppShell>
  );
}
