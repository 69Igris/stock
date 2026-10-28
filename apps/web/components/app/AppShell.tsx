"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { GradientOrbs } from "@/components/GradientOrbs";

/**
 * Shared authenticated app shell + demo/auth guard for the dashboard (overview)
 * and StockSage (chat) routes. These were split out of one combined client so
 * each route owns its own bundle, loading skeleton, and active-nav state — this
 * holds the chrome + redirect logic that both still share.
 */
export function useAppAuthGuard(isDemo?: boolean) {
  const router = useRouter();
  const { user, isLoaded: clerkLoaded } = useUser();

  useEffect(() => {
    if (!clerkLoaded) return;

    const demoMode =
      isDemo || localStorage.getItem("tradebook_demo_mode") === "true";

    if (user && demoMode) {
      localStorage.removeItem("tradebook_demo_mode");
      localStorage.removeItem("tradebook_user_id");
    }

    if (!user && !demoMode) {
      router.push("/home");
    }
  }, [clerkLoaded, user, router, isDemo]);

  return { user, clerkLoaded, isRealUser: clerkLoaded && !!user };
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen bg-background overflow-hidden relative">
      <GradientOrbs />
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)] flex flex-col">
        {children}
      </main>
    </div>
  );
}
