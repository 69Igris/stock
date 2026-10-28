"use client";

/**
 * Scans Library — client (MONEY-795 · C2).
 *
 * Owns: category-rail state, free-text search, the active scan run + its
 * results. Renders:
 *   • a category chip rail (All + each populated category, with counts)
 *   • a search box
 *   • a responsive grid of scan cards (name, description, source/category
 *     pills, tag chips, Run / Open affordance)
 *   • an inline results panel (reuses the screener's `StockCardCompact`
 *     `ScreenResult` cards) when a runnable scan is executed.
 *
 * SEBI: cards + results are descriptive only. Copy never says buy/sell;
 * the page sub-line + a footnote make the "surfaces data, not advice"
 * stance explicit.
 *
 * DEFERRED (own follow-up tickets — NOT built here):
 *   • Inline execution of Chartink-DSL + Tickertape-metric scans via the
 *     async `strategy-scan` worker. Today those are browse cards that route
 *     to the screener / StockSage chat.
 *   • Chartink rate-limit queue + nightly pre-warm worker.
 *   • Real trade-by-trade backtests; Chartink URL→clause import;
 *     "scan my watchlist" allow-list.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import { Search, Play, ArrowUpRight, Loader2, ScanLine } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { DemoBanner } from "@/components/DemoBanner";
import { EmptyState } from "@/components/empty/EmptyState";
import { StockCardCompact } from "@/components/screener/StockCardCompact";
import { ScreenerInnerSkeleton } from "@/components/screener/InnerSkeleton";
import { toast } from "sonner";
import { runScanAction, type RunScanResult } from "@/lib/actions/scans";
import {
  searchScans,
  scansByCategory,
  type ScanDef,
  type ScanCategory,
  type ScanCategoryInfo,
  type ScanSource,
} from "@/lib/scans/catalog";
import type { ScreenResult } from "@/lib/actions/screener";

interface ScansClientProps {
  scans: ScanDef[];
  categories: ScanCategoryInfo[];
}

/** Source pill accent — keeps the three registries visually distinct. */
const SOURCE_STYLE: Record<ScanSource, { label: string; cls: string }> = {
  core: { label: "Engine", cls: "emerald" },
  builtin: { label: "Strategy", cls: "gold" },
  chartink: { label: "Chartink", cls: "outline" },
};

function formatCount(n: number): string {
  return n.toLocaleString("en-IN");
}

export default function ScansClient({ scans, categories }: ScansClientProps) {
  const router = useRouter();
  // MONEY-1137: this page rendered <DemoBanner /> UNCONDITIONALLY — the only
  // one of 31 render sites that did — so every visitor, signed in and paying,
  // was told their portfolio was fake and invited to sign in. Gated on `user`
  // as well as the localStorage flag, so a stale flag from an earlier demo
  // visit can never re-assert demo state on an authenticated session.
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });

  const [activeCategory, setActiveCategory] = useState<ScanCategory | "all">(
    "all"
  );
  const [query, setQuery] = useState("");

  // Active run state — a single scan at a time (the results panel replaces
  // the previous run). `runningId` drives the per-card spinner.
  const [runningId, setRunningId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunScanResult | null>(null);

  // Client-side filter: category + free-text. The catalog is static and
  // bounded (~140 scans) so filtering in the client is instant — no need
  // to round-trip the server for browse. Filtering reuses the catalog's
  // own `searchScans` / `scansByCategory` helpers (the `scans` prop IS the
  // full `SCAN_CATALOG`) so there's a single filter implementation shared
  // with `runScanAction` + the unit tests — no divergent inline copy.
  const visibleScans = useMemo(() => {
    const byText = searchScans(query);
    if (activeCategory === "all") return byText;
    const inCategory = new Set(
      scansByCategory(activeCategory).map((s) => s.id)
    );
    return byText.filter((s) => inCategory.has(s.id));
  }, [activeCategory, query]);

  const runnableCount = useMemo(
    () => scans.filter((s) => s.runnable).length,
    [scans]
  );

  const runScan = useCallback(
    async (scan: ScanDef) => {
      if (!scan.runnable) {
        // DEFERRED inline path — route the user to the screener where the
        // full filter set + the async run path live, instead of dead-ending.
        router.push("/discover/screener?mode=stocks");
        toast.info(
          "Opening the screener — this scan runs through filters there for now."
        );
        return;
      }
      setRunningId(scan.id);
      try {
        const res = await runScanAction(scan.id, { limit: 50 });
        if (!res.success) {
          toast.error(res.error || "Couldn't run this scan.");
          return;
        }
        setActiveRun(res.data);
        if (res.data.total === 0) {
          toast.info("No stocks matched this scan right now.");
        }
      } catch {
        toast.error("Couldn't run this scan.");
      } finally {
        setRunningId(null);
      }
    },
    [router]
  );

  const headerEyebrow = `${formatCount(scans.length)} SCANS · ${formatCount(runnableCount)} ONE-CLICK · DATA-ONLY · NOT ADVICE`;

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
          {isDemoMode && <DemoBanner />}

          <PfPageHead
            eyebrow={headerEyebrow}
            title={
              <>
                Pre-built <span className="ser">scans,</span>{" "}
                <span className="hl-gold">one tap.</span>
              </>
            }
            sub="Browse momentum, moving-average, value, and volume scans. Run a scan to see the stocks it surfaces — scans show data, they're not buy or sell calls."
          />

          <PageGuard
            route="/discover/scans"
            bare
            fallback={<ScreenerInnerSkeleton />}
          >
            {/* Category rail */}
            <div className="mt-4 flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c.category}
                  type="button"
                  onClick={() => setActiveCategory(c.category)}
                  className={`pf-pill ${
                    activeCategory === c.category ? "emerald" : "outline"
                  }`}
                  style={{ cursor: "pointer" }}
                >
                  {c.label}
                  <span className="ml-1.5 font-mono text-[10px] opacity-70 tabular-nums">
                    {formatCount(c.count)}
                  </span>
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="mt-4 mb-5 w-full">
              <div className="relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)]"
                  size={15}
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search scans — golden cross, RSI, breakout, value…"
                  className="pf-input w-full"
                  style={{ paddingLeft: 36, height: 42 }}
                />
              </div>
            </div>

            {/* Active run results */}
            {activeRun && (
              <ScanResultsPanel
                run={activeRun}
                onClose={() => setActiveRun(null)}
              />
            )}

            {/* Scan card grid */}
            {visibleScans.length === 0 ? (
              <div className="pf-card" style={{ padding: 16 }}>
                <EmptyState
                  icon={ScanLine}
                  title="No scans match"
                  description="Try a different category or clear the search."
                  muted
                  card={false}
                  action={
                    query || activeCategory !== "all"
                      ? {
                          label: "Reset",
                          onClick: () => {
                            setQuery("");
                            setActiveCategory("all");
                          },
                        }
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {visibleScans.map((scan) => (
                  <ScanCard
                    key={scan.id}
                    scan={scan}
                    running={runningId === scan.id}
                    onRun={() => runScan(scan)}
                  />
                ))}
              </div>
            )}

            {/* SEBI footnote */}
            <p className="mt-6 mono text-[10.5px] text-[var(--ink-3)] leading-relaxed">
              Scans surface stocks that currently match a technical or
              fundamental condition. They are informational only and are not
              investment advice or a recommendation to buy or sell any security.
            </p>
          </PageGuard>
        </div>
      </main>
    </div>
  );
}

// ── Scan card ────────────────────────────────────────────────────────

function ScanCard({
  scan,
  running,
  onRun,
}: {
  scan: ScanDef;
  running: boolean;
  onRun: () => void;
}) {
  const src = SOURCE_STYLE[scan.source];
  return (
    <div className="pf-card flex flex-col gap-2.5" style={{ padding: 14 }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`pf-pill ${src.cls}`} style={{ fontSize: 9.5 }}>
            {src.label}
          </span>
          <span
            className="pf-pill outline"
            style={{ fontSize: 9.5, color: "var(--ink-3)" }}
          >
            {scan.category.replace(/_/g, " ")}
          </span>
        </div>
      </div>

      <div>
        <div className="text-[13.5px] font-bold text-[var(--ink)] leading-snug">
          {scan.name}
        </div>
        <p className="mt-1 text-[12px] text-[var(--ink-2)] leading-relaxed line-clamp-3">
          {scan.description}
        </p>
      </div>

      {scan.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {scan.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="mono text-[9.5px] px-1.5 py-0.5 rounded-[5px] border border-[var(--rule-soft)] text-[var(--ink-3)]"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto pt-1">
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className={`pf-bf sm w-full justify-center ${running ? "opacity-70" : ""}`}
          style={{ cursor: running ? "default" : "pointer" }}
          title={
            scan.runnable
              ? `Run ${scan.name}`
              : "Open this scan in the screener"
          }
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
            </>
          ) : scan.runnable ? (
            <>
              <Play className="h-3.5 w-3.5" /> Run scan
            </>
          ) : (
            <>
              <ArrowUpRight className="h-3.5 w-3.5" /> Open in screener
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Results panel (reuses screener cards) ────────────────────────────

function ScanResultsPanel({
  run,
  onClose,
}: {
  run: RunScanResult;
  onClose: () => void;
}) {
  // Selection is required by StockCardCompact but the scans page doesn't
  // wire Compare — a no-op keeps the card self-contained (clicking a row
  // still routes to the stock page; only the checkbox is inert).
  const noopSelect = useCallback((_symbol: string) => undefined, []);

  return (
    <div className="pf-card mb-5" style={{ padding: 16 }}>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="pf-pill emerald shrink-0 whitespace-nowrap">
            {run.total.toLocaleString("en-IN")} matches
          </span>
          <span className="text-[13px] font-bold text-[var(--ink)] truncate">
            {run.scanName}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="pf-bf sm"
          style={{ cursor: "pointer" }}
        >
          Close
        </button>
      </div>

      {run.partial && run.unmapped.length > 0 && (
        <p className="mono text-[10.5px] text-[var(--ink-3)] mb-3">
          Showing the closest match using {run.unmapped.length} condition
          {run.unmapped.length === 1 ? "" : "s"} we can&apos;t run inline yet (
          {run.unmapped.join(", ")}). Refine in the screener for the full scan.
        </p>
      )}

      {run.rows.length === 0 ? (
        <EmptyState
          icon={ScanLine}
          title="No stocks matched"
          description="This scan returned nothing right now. Markets move — try again later or tweak it in the screener."
          muted
          card={false}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {run.rows.map((r: ScreenResult) => (
            <StockCardCompact
              key={`${r.symbol}|${r.exchange}`}
              row={r}
              selected={false}
              onToggleSelect={noopSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
