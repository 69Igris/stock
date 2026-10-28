"use client";

/**
 * Risk v2 (MONEY-485) — playful, tabbed risk report for a novice ICP.
 *
 * Shell: pf-app + Sidebar + playful offsets (matches roast, holdings, etc.).
 * Inside, a tabbed report (Snapshot / Diagnose / Stress Lab / Decide /
 * Calibrate) replaces the old single-scroll layout. Active tab persists in
 * sessionStorage. Data comes from getPortfolioRiskAction; sections render
 * honest "needs data — coming soon" states wherever the backend (MONEY-487)
 * doesn't yet provide a metric. "Ask StockSage" seeds the dashboard chat via
 * /dashboard?prompt=.
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useIDBCache } from "@/hooks/useIDBCache";
import Sidebar from "@/components/Sidebar";
import { DemoBanner } from "@/components/DemoBanner";
import { PfPageHead } from "@/components/playful/PfPageHead";

import "./risk-playful.css";
import {
  ShieldAlert,
  RefreshCw,
  Sparkles,
  Shield,
  Brain,
  Flame,
  Target,
  SlidersHorizontal,
} from "lucide-react";
import {
  getPortfolioRiskAction,
  type PortfolioRiskResult,
} from "@/lib/actions/risk";

import AnimatedPageLoader from "@/components/AnimatedPageLoader";
import { PageGuard } from "@/components/PageGuard";
import { Skeleton } from "@usemoney/ui/skeleton";

import RiskTabs, { type RiskTabItem } from "./components/RiskTabs";
import SnapshotSection from "./sections/SnapshotSection";
import DiagnoseSection from "./sections/DiagnoseSection";
import StressLabSection from "./sections/StressLabSection";
import DecideSection from "./sections/DecideSection";
import CalibrateSection from "./sections/CalibrateSection";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

type SectionId = "snapshot" | "diagnose" | "stress" | "decide" | "calibrate";

const SECTION_IDS: SectionId[] = [
  "snapshot",
  "diagnose",
  "stress",
  "decide",
  "calibrate",
];

const STORAGE_KEY = "risk_active_section";

export default function RiskPageClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [mounted, setMounted] = useState(false);
  const [section, setSection] = useState<SectionId>("snapshot");

  useEffect(() => {
    setMounted(true);
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved && (SECTION_IDS as string[]).includes(saved)) {
        setSection(saved as SectionId);
      }
    } catch {
      /* sessionStorage unavailable — default to snapshot */
    }
  }, []);

  const onSectionChange = useCallback((id: string) => {
    setSection(id as SectionId);
    try {
      sessionStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const isDemoMode = useIsDemoMode({ user });

  // Redirect unauthenticated non-demo users (preserved from v1).
  useEffect(() => {
    if (!isLoaded || !mounted) return;
    const demoMode = localStorage.getItem("tradebook_demo_mode");

    if (user && demoMode) {
      localStorage.removeItem("tradebook_demo_mode");
      localStorage.removeItem("tradebook_user_id");
    }

    if (!user && !demoMode) {
      router.push("/home");
    }
  }, [isLoaded, user, router, mounted]);

  const {
    data: riskData,
    isLoading: loading,
    error: idbError,
  } = useIDBCache<PortfolioRiskResult>({
    module: "risk",
    identifier: "portfolio",
    fetcher: async () => {
      const result = await getPortfolioRiskAction();
      if (result?.success && result?.data) {
        return result?.data;
      }
      throw new Error(result?.error || "Failed to load risk analysis");
    },
    skip: !mounted || !isLoaded || (!user && !isDemoMode),
  });

  const error = idbError?.message ?? null;

  // "Ask Sage" → seed the StockSage chat (the app's chat-first surface).
  const ask = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      router.push(
        trimmed
          ? `/stocksage?prompt=${encodeURIComponent(trimmed)}`
          : "/stocksage"
      );
    },
    [router]
  );

  const tabs: RiskTabItem[] = [
    { id: "snapshot", label: "Snapshot", icon: Shield },
    { id: "diagnose", label: "Diagnose", icon: Brain, count: 6 },
    { id: "stress", label: "Stress Lab", icon: Flame },
    { id: "decide", label: "Decide", icon: Target },
    { id: "calibrate", label: "Calibrate", icon: SlidersHorizontal },
  ];

  const riskSkeleton = (
    <div className="space-y-6">
      <Skeleton className="h-10 w-48 bg-muted" />
      <Skeleton className="h-5 w-80 bg-muted" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-64 bg-muted rounded-lg" />
        <Skeleton className="h-64 bg-muted rounded-lg" />
        <Skeleton className="h-64 bg-muted rounded-lg" />
      </div>
    </div>
  );

  return (
    <PageGuard
      route="/risk"
      fallback={riskSkeleton}
      containerClassName="p-4 sm:p-6 pb-24"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-4 sm:p-6 pb-24">
            {isDemoMode && <DemoBanner />}

            {/* Playful page header */}
            <PfPageHead
              eyebrow="RISK · LIVE BROKER DATA"
              title={
                <>
                  How much <span className="ser">heat</span> can your portfolio{" "}
                  <span className="hl-gold">take.</span>
                </>
              }
              sub="Your risk number, what's driving it, how it behaves when markets break — and what to do about it."
              right={
                <>
                  <button
                    onClick={() => {
                      setMounted(false);
                      setTimeout(() => setMounted(true), 0);
                    }}
                    className="pf-bf sm"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Recompute
                  </button>
                  <button
                    className="pf-bf sm"
                    onClick={() => ask("Explain my risk report")}
                  >
                    <Sparkles className="h-3.5 w-3.5" /> Ask StockSage
                  </button>
                  <span className="pf-pill gold">EDUCATIONAL · NOT ADVICE</span>
                </>
              }
            />
            {/* Section tabs (persisted to sessionStorage) */}
            {!loading && !error && riskData && (
              <div className="pf-risk-tabs">
                <RiskTabs
                  items={tabs}
                  active={section}
                  onChange={onSectionChange}
                />
              </div>
            )}

            {/* Loading State */}
            {loading && (
              <AnimatedPageLoader
                centerIcon={
                  <svg
                    className="w-16 h-16 text-primary"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M12 2l8 4v6c0 5.25-3.5 9.74-8 11-4.5-1.26-8-5.75-8-11V6l8-4z" />
                    <polyline points="8 14 10.5 11 13 13 16 9" />
                    <circle cx="16" cy="9" r="1" fill="currentColor" />
                  </svg>
                }
                orbitIcons={[
                  {
                    color: "text-amber-500",
                    delay: 0,
                    icon: (
                      <svg
                        className="w-6 h-6"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    ),
                  },
                  {
                    color: "text-blue-500",
                    delay: 0.3,
                    icon: (
                      <svg
                        className="w-6 h-6"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="3" y="12" width="4" height="9" rx="1" />
                        <rect x="10" y="7" width="4" height="14" rx="1" />
                        <rect x="17" y="3" width="4" height="18" rx="1" />
                      </svg>
                    ),
                  },
                  {
                    color: "text-red-500",
                    delay: 0.6,
                    icon: (
                      <svg
                        className="w-6 h-6"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
                        <polyline points="16 17 22 17 22 11" />
                      </svg>
                    ),
                  },
                ]}
                title="Analyzing Portfolio Risk"
                subtitle="Computing risk metrics and correlations"
                steps={[
                  { label: "Concentration", delay: 0 },
                  { label: "Value at Risk", delay: 0.5 },
                  { label: "Correlations", delay: 1 },
                ]}
              />
            )}

            {/* Error State */}
            {!loading && error && (
              <div className="pf-card flat flex flex-col items-center justify-center min-h-[360px] gap-3 text-center">
                <ShieldAlert
                  className="h-12 w-12"
                  style={{ color: "var(--pop-1-text)" }}
                />
                <p
                  className="text-lg font-bold"
                  style={{ color: "var(--pop-1-text)" }}
                >
                  {error}
                </p>
                <p className="text-sm text-[var(--ink-3)]">
                  Connect a broker and add holdings to analyze your risk.
                </p>
                <Link href="/holdings?add=manual" className="pf-bs sm mt-1">
                  Add holdings
                </Link>
              </div>
            )}

            {/* Tabbed risk report */}
            {!loading && !error && riskData && (
              <>
                {section === "snapshot" && (
                  <SnapshotSection data={riskData} ask={ask} />
                )}
                {section === "diagnose" && (
                  <DiagnoseSection data={riskData} ask={ask} />
                )}
                {section === "stress" && (
                  <StressLabSection data={riskData} ask={ask} />
                )}
                {section === "decide" && (
                  <DecideSection data={riskData} ask={ask} />
                )}
                {section === "calibrate" && (
                  <CalibrateSection data={riskData} ask={ask} />
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
