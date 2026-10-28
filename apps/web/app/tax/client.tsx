"use client";

/* =====================================================================
   Tax Report v2 — page client (MONEY-485)
   CA-grade, novice-friendly tax report in the playful (pf-*) idiom.
   Section tabs (Snapshot / Income & Gains / Optimize / Compliance / File)
   with the active tab persisted in sessionStorage. Wrapped by the
   existing shell: PageGuard(route="/tax") + Sidebar + global TopBar.
   All ₹ figures come from the real TaxReportResult; everything the
   backend can't supply renders an honest "needs data" placeholder
   (backend tracked in MONEY-486). Demo mode uses demo data via the
   same shape.
   ===================================================================== */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import {
  Plus,
  Receipt,
  AlertTriangle,
  TrendingUp,
  Sparkles,
  CheckSquare,
  FileText,
  ChevronDown,
} from "lucide-react";

import Sidebar from "@/components/Sidebar";
import { DemoBanner } from "@/components/DemoBanner";
import AnimatedPageLoader from "@/components/AnimatedPageLoader";
import { PageGuard } from "@/components/PageGuard";
import { Skeleton } from "@usemoney/ui/skeleton";
import { useIDBCache } from "@/hooks/useIDBCache";

import { getTaxReportAction } from "@/lib/actions/tax";
import type { TaxReportResult } from "@/lib/actions/tax";

import FYSelector, { getCurrentFY } from "./components/FYSelector";
import TaxSnapshot from "./sections/TaxSnapshot";
import IncomeGains from "./sections/IncomeGains";
import Optimize from "./sections/Optimize";
import Compliance from "./sections/Compliance";
import FileSection from "./sections/FileSection";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

type TaxTab = "snapshot" | "income" | "optimize" | "compliance" | "file";

const TAB_KEY = "stockbook:tax-tab";

const TABS: Array<{ id: TaxTab; label: string; icon: typeof Receipt }> = [
  { id: "snapshot", label: "Snapshot", icon: Receipt },
  { id: "income", label: "Income & Gains", icon: TrendingUp },
  { id: "optimize", label: "Optimize", icon: Sparkles },
  { id: "compliance", label: "Compliance", icon: CheckSquare },
  { id: "file", label: "File", icon: FileText },
];

export default function TaxPageClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  const [selectedFY, setSelectedFY] = useState<string>(getCurrentFY());
  const [manualError, setManualError] = useState<string | null>(null);

  // Active section tab — persisted in sessionStorage (per the spec).
  const [tab, setTab] = useState<TaxTab>("snapshot");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.sessionStorage.getItem(TAB_KEY) as TaxTab | null;
    if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
  }, []);
  const changeTab = useCallback((next: TaxTab) => {
    setTab(next);
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(TAB_KEY, next);
  }, []);

  // FY selector + Old/New regime toggle (snapshot assumes New for CG tax).
  const [regime, setRegime] = useState<"Old" | "New">("New");

  // Salary income — persisted client-side only (never sent to the server) so
  // the regime sandbox reflects real take-home, not a constant.
  const [salaryIncome, setSalaryIncome] = useState<number>(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("stockbook:tax-salary");
    setSalaryIncome(raw ? parseInt(raw, 10) || 0 : 0);
  }, []);
  const persistSalary = useCallback((next: number) => {
    setSalaryIncome(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("stockbook:tax-salary", String(next));
    }
  }, []);

  const isDemoMode = useIsDemoMode({ user });

  // IDB-cached tax report — keyed by FY so switching FYs hits separate entries.
  const {
    data: taxReport,
    isLoading: idbLoading,
    error: idbError,
    refresh,
  } = useIDBCache<TaxReportResult | null>({
    module: "tax",
    identifier: selectedFY,
    fetcher: async () => {
      const result = await getTaxReportAction(selectedFY);
      if (result?.success && result?.data) return result.data;
      throw new Error(result?.error || "Failed to generate tax report.");
    },
    skip: !isLoaded || (!user && !isDemoMode),
  });

  const error = manualError || (idbError ? idbError.message : null);
  const hasLoaded = !idbLoading;

  useEffect(() => {
    const demoMode = localStorage.getItem("tradebook_demo_mode");
    if (!isLoaded) return;
    if (user && demoMode) {
      localStorage.removeItem("tradebook_demo_mode");
      localStorage.removeItem("tradebook_user_id");
    }
    if (!user && !demoMode) router.push("/home");
  }, [isLoaded, user, router]);

  const handleFYChange = useCallback((fy: string) => {
    setSelectedFY(fy);
    setManualError(null);
  }, []);

  // "Ask Sage" surfaces — route to the StockSage chat. (The design's chat
  // seed flow is not yet supported app-wide; we open the assistant.)
  const ask = useCallback(
    (_q: string) => {
      router.push("/sage-tutor");
    },
    [router]
  );

  const taxSkeleton = (
    <div className="space-y-6">
      <Skeleton className="h-10 w-48 bg-muted" />
      <Skeleton className="h-5 w-96 bg-muted" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-48 bg-muted rounded-lg" />
        <Skeleton className="h-48 bg-muted rounded-lg" />
        <Skeleton className="h-48 bg-muted rounded-lg" />
      </div>
    </div>
  );

  return (
    <PageGuard
      route="/tax"
      fallback={taxSkeleton}
      containerClassName="p-4 sm:p-6 pb-24"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-4 sm:p-6 pb-24">
            {isDemoMode && <DemoBanner />}

            {/* Playful page header (pf-ph idiom). */}
            <div className="pf-ph">
              <div className="l">
                <div className="eyebrow">
                  <span className="d" aria-hidden />
                  TAX · FY {selectedFY} · NEW REGIME · STCG · LTCG · F&amp;O
                </div>
                <h1>
                  Your tax, <span className="ser">already done.</span>{" "}
                  <span className="hl">
                    {taxReport?.capitalGains.fno.net ? "ITR-3" : "ITR-2"}
                  </span>{" "}
                  ready.
                </h1>
                <div className="sub">
                  From STCG calculator to filing co-pilot &mdash; capital gains,
                  F&amp;O turnover, dividends, all cross-referenced with your
                  tradebook.
                </div>
              </div>
              <div className="r">
                <FYSelector
                  selectedFY={selectedFY}
                  onFYChange={handleFYChange}
                />
                {/* Old / New regime toggle */}
                <div
                  className="inline-flex items-center"
                  style={{
                    border: "1.5px solid var(--ink)",
                    borderRadius: 8,
                    padding: 3,
                    background: "var(--paper)",
                  }}
                >
                  {(["Old", "New"] as const).map((r) => {
                    const active = r === regime;
                    return (
                      <button
                        key={r}
                        onClick={() => setRegime(r)}
                        className="mono"
                        style={{
                          padding: "5px 10px",
                          borderRadius: 5,
                          fontSize: 11.5,
                          fontWeight: active ? 700 : 600,
                          background: active ? "var(--ink)" : "transparent",
                          color: active ? "var(--paper)" : "var(--ink-3)",
                        }}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
                <button
                  className="pf-bf"
                  onClick={() => router.push("/tradebook")}
                >
                  <Plus className="h-3.5 w-3.5" /> Add trades
                </button>
              </div>
            </div>

            {/* Section tabs (sessionStorage-persisted). */}
            <div className="mb-5">
              <div
                className="inline-flex items-center"
                style={{
                  border: "2px solid var(--ink)",
                  borderRadius: 12,
                  padding: 5,
                  background: "var(--paper)",
                  boxShadow: "var(--shadow-soft)",
                  flexWrap: "wrap",
                  gap: 4,
                  maxWidth: "100%",
                }}
                role="tablist"
                aria-label="Tax report sections"
              >
                {TABS.map((t) => {
                  const Icon = t.icon;
                  const active = t.id === tab;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={active}
                      onClick={() => changeTab(t.id)}
                      className="inline-flex items-center gap-2"
                      style={{
                        padding: "8px 14px",
                        borderRadius: 8,
                        fontSize: 13,
                        fontWeight: active ? 700 : 600,
                        background: active ? "var(--ink)" : "transparent",
                        color: active ? "var(--paper)" : "var(--ink-2)",
                        cursor: "pointer",
                        transition: "background .12s, color .12s",
                      }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Broker filter chip */}
            <div className="mb-4">
              <button
                className="br-chip"
                onClick={() => router.push("/brokers")}
              >
                <span
                  className="dot"
                  style={{ background: "var(--emerald)" }}
                />
                All brokers
                <span className="text-[var(--ink-3)]">·</span>
                <span className="pf-pill emerald" style={{ fontSize: 9.5 }}>
                  {taxReport?.capitalGains.trades?.length ?? 0} trades
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-[var(--ink-3)]" />
              </button>
            </div>

            {/* Loading State */}
            {idbLoading && !taxReport && (
              <AnimatedPageLoader
                centerIcon={
                  <svg
                    className="w-16 h-16 text-emerald-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2-3-2z" />
                    <line x1="8" y1="8" x2="16" y2="8" />
                    <line x1="8" y1="12" x2="14" y2="12" />
                    <line x1="8" y1="16" x2="12" y2="16" />
                  </svg>
                }
                orbitIcons={[
                  {
                    color: "text-emerald-400",
                    delay: 0,
                    icon: (
                      <svg
                        className="w-6 h-6"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="6" y1="3" x2="18" y2="3" />
                        <line x1="6" y1="8" x2="18" y2="8" />
                        <path d="M6 3c0 5 6 10 12 10" />
                        <path d="M6 8c0 4 4.5 8 10 9.5" />
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
                        <rect x="4" y="2" width="16" height="20" rx="2" />
                        <line x1="8" y1="6" x2="16" y2="6" />
                        <circle cx="8" cy="11" r="1" fill="currentColor" />
                        <circle cx="12" cy="11" r="1" fill="currentColor" />
                        <circle cx="16" cy="11" r="1" fill="currentColor" />
                        <circle cx="8" cy="15" r="1" fill="currentColor" />
                        <circle cx="12" cy="15" r="1" fill="currentColor" />
                        <circle cx="16" cy="15" r="1" fill="currentColor" />
                      </svg>
                    ),
                  },
                  {
                    color: "text-amber-500",
                    delay: 0.6,
                    icon: (
                      <svg
                        className="w-6 h-6"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M12 2a10 10 0 1 0 10 10h-10V2z" />
                        <path d="M20 12a8 8 0 0 0-8-8v8h8z" />
                      </svg>
                    ),
                  },
                ]}
                title={`Generating Tax Report - FY ${selectedFY}`}
                subtitle="Computing capital gains, harvesting & advance tax"
                steps={[
                  { label: "Capital Gains", delay: 0 },
                  { label: "Tax Harvesting", delay: 0.5 },
                  { label: "ITR Schedule", delay: 1 },
                ]}
              />
            )}

            {/* Error State */}
            {error && !idbLoading && (
              <div className="pf-card flat flex flex-col items-center justify-center py-16 text-center">
                <AlertTriangle
                  className="h-12 w-12 mb-4"
                  style={{ color: "var(--pop-1-text)" }}
                />
                <p
                  className="text-lg font-bold mb-2"
                  style={{ color: "var(--pop-1-text)" }}
                >
                  Failed to Load Tax Report
                </p>
                <p className="text-[var(--ink-3)] text-sm mb-4">{error}</p>
                <button
                  onClick={() => {
                    setManualError(null);
                    refresh();
                  }}
                  className="pf-bs"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty State */}
            {hasLoaded && !error && !taxReport && !idbLoading && (
              <div className="pf-card flat flex flex-col items-center justify-center py-16 text-center">
                <Receipt className="h-12 w-12 text-[var(--ink-3)] mb-4 opacity-60" />
                <p className="text-lg font-bold text-[var(--ink-2)] mb-2">
                  No Tax Data Available
                </p>
                <p className="text-[var(--ink-3)] text-sm">
                  No trades found for FY {selectedFY}. Your tax report is
                  generated once you have closed trades.
                </p>
              </div>
            )}

            {/* Report content — active section */}
            {taxReport && (
              <>
                {tab === "snapshot" && (
                  <TaxSnapshot report={taxReport} fy={selectedFY} ask={ask} />
                )}
                {tab === "income" && (
                  <IncomeGains report={taxReport} fy={selectedFY} ask={ask} />
                )}
                {tab === "optimize" && (
                  <Optimize
                    report={taxReport}
                    salaryIncome={salaryIncome}
                    onSalaryChange={persistSalary}
                    ask={ask}
                  />
                )}
                {tab === "compliance" && (
                  <Compliance report={taxReport} fy={selectedFY} ask={ask} />
                )}
                {tab === "file" && (
                  <FileSection report={taxReport} fy={selectedFY} ask={ask} />
                )}

                {/* Disclaimer — always visible under every tab. */}
                <div
                  className="mt-6 p-4 rounded-xl"
                  style={{
                    border: "1.5px solid var(--pop-2)",
                    background: "var(--rule-softer)",
                  }}
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle
                      className="h-5 w-5 shrink-0 mt-0.5"
                      style={{ color: "var(--pop-2-text)" }}
                    />
                    <div>
                      <p
                        className="text-sm font-bold mb-1"
                        style={{ color: "var(--pop-2-text)" }}
                      >
                        Indicative only — verify with your CA
                      </p>
                      <p className="text-xs text-[var(--ink-3)] leading-relaxed">
                        This is an estimate for informational purposes. Numbers
                        are computed from trades synced with UseMoney and may
                        not include all sources of income. The New regime is
                        assumed for capital-gains tax; regime and salary
                        comparisons are indicative. Consult a qualified
                        Chartered Accountant before filing.
                      </p>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
