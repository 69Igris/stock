"use client";

import type { CSSProperties, ReactNode } from "react";
import Sidebar from "@/components/Sidebar";

/* =====================================================================
   MONEY-485 · Playful loading skeletons.

   Every per-page skeleton mimics ITS hydrated playful layout using a
   small set of shared primitives built on the playful design tokens
   (playful-app.css — theme-aware via `html.dark`). NO hardcoded dark
   RGBA: shimmer blocks ride on `var(--rule-softer)` with a sweep of
   `var(--paper-2)`, ink-bordered cards use `var(--ink)` / `var(--rule)`,
   so both light cream-paper and deep-ink dark render correctly.

   These exports are consumed by two stages that must look identical:
     1. route `loading.tsx` (wrapped in `PageLoadingWrapper`)
     2. `PageGuard` fallback (rendered inside the hydrated shell)

   Shimmer rules (`.pf-skel`, `.pf-skel-card`, `@keyframes pf-skel-sweep`,
   reduced-motion override) live in `apps/web/app/playful-app.css` — the
   global stylesheet already loaded by app/layout.tsx. They USED to be
   injected inline twice (`PfSkel` + `PageSkeletonShell`); React 18
   hydration reconciles the inner `<style>` text content byte-for-byte
   against the SSR output, and the two nested `<style>` tags emitted
   slightly different whitespace between server / client, throwing the
   "Text content did not match" error whenever a `loading.tsx` wrapped a
   page skeleton (the common path). Moving the rules to the external CSS
   file removes the comparison entirely.

   IMPORTANT: export names + signatures are load-bearing (loading.tsx +
   PageGuard import them by name) — do not rename or change params.
   ===================================================================== */

/**
 * Skeleton root. Stagger wrapper so any older `.skeleton-stagger` CSS
 * still applies. Shimmer rules live in playful-app.css (see header
 * comment) — no inline `<style>` here.
 */
function PfSkel({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`skeleton-stagger${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

/**
 * Deterministic bar heights for the fake charts, as percentage STRINGS.
 *
 * These are rendered on the server and hydrated on the client, so the two must
 * produce byte-identical style values. Computing them inline did not guarantee
 * that: ECMAScript leaves `Math.sin` IMPLEMENTATION-APPROXIMATED (§21.3.2), so
 * Node and a browser are permitted to disagree in the last bits — and React
 * serialises a raw number at full precision, which turns a 1-ULP difference
 * into a hydration error on a decorative placeholder.
 *
 * Rounding to two decimals is what actually closes it: any conforming
 * implementation agrees far above 0.01, so the string is stable no matter who
 * computed it. It also shrinks the emitted HTML — 60 bars carried up to 17
 * significant digits each for a shimmer nobody measures.
 *
 * Computed once at module scope rather than per render; the arrays are frozen
 * so a caller cannot mutate a shared placeholder set.
 */
function barHeights(
  count: number,
  base: number,
  step: number,
  amplitude: number
): readonly string[] {
  return Object.freeze(
    Array.from(
      { length: count },
      (_, i) =>
        `${(base + Math.abs(Math.sin(i * step)) * amplitude).toFixed(2)}%`
    )
  );
}

/** 60-bar price chart placeholder (stock/ETF/MF detail). */
const CHART_BAR_HEIGHTS = barHeights(60, 20, 0.15, 50);
/** 12-bar compact card placeholder. */
const MINI_BAR_HEIGHTS = barHeights(12, 30, 0.9, 55);
/** 30-bar wide chart placeholder. Base 45 = the original `30 + … + 15`. */
const WIDE_BAR_HEIGHTS = barHeights(30, 45, 0.4, 50);

/**
 * Shimmer bar — the atomic placeholder. Rounded, theme-aware sweep.
 * Sizing/positioning via `className` (Tailwind) or `style`.
 */
function Bar({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={`pf-skel ${className ?? ""}`} style={style} />;
}

/**
 * Ink-bordered playful card shell (`.pf-card` look) holding placeholders.
 */
function SkCard({
  children,
  className,
  flat,
  style,
}: {
  children?: ReactNode;
  className?: string;
  flat?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`pf-skel-card${flat ? " flat" : ""} p-[18px]${className ? ` ${className}` : ""}`}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * `.pf-stat` strip tile placeholder — mono label bar + big value bar.
 */
function StatTile({ accent }: { accent?: boolean }) {
  return (
    <SkCard
      flat
      className="px-[18px] py-4"
      style={accent ? { borderColor: "var(--rule-soft)" } : undefined}
    >
      <Bar className="h-2.5 w-16" />
      <Bar className="h-6 w-24 mt-2.5" />
      <Bar className="h-3 w-12 mt-2" />
    </SkCard>
  );
}

/**
 * `.pf-ph` page-heading placeholder — eyebrow + display headline + sub,
 * with the signature 2px ink underline. Used by `PageLoadingWrapper`
 * and any skeleton that owns its hero.
 */
function HeroHead({ withRight = true }: { withRight?: boolean }) {
  return (
    <div
      className="flex items-end justify-between gap-5 flex-wrap mb-[22px] pb-[18px]"
      style={{ borderBottom: "2px solid var(--ink)" }}
    >
      <div className="flex-1 min-w-0 basis-[280px]">
        <div className="flex items-center gap-2 mb-2.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--rule-soft)" }}
          />
          <Bar className="h-2.5 w-40" />
        </div>
        <Bar className="h-9 w-[320px] max-w-full" />
        <Bar className="h-4 w-56 max-w-full mt-3" />
      </div>
      {withRight && (
        <div className="flex items-center gap-2">
          <Bar className="h-9 w-28 rounded-lg" />
          <Bar className="h-9 w-9 rounded-lg" />
        </div>
      )}
    </div>
  );
}

/**
 * Shared shell used by BOTH stage-1 (`PageLoadingWrapper`) and stage-2
 * (`PageLoadingSkeleton` in PageGuard) so the two stages are
 * pixel-identical. Renders the Sidebar + the correct `<main>` offset
 * (matching the hydrated app layout: sidebar width on desktop, mobile
 * header height on mobile, topbar height on desktop).
 *
 * NEVER renders a second <TopBar> — the global TopBar is already
 * mounted by app/layout.tsx above {children}.
 *
 * Exported so PageGuard can import it directly.
 */
export function PageSkeletonShell({
  children,
  containerClassName,
}: {
  children: ReactNode;
  /** Optional container override (matches PageGuard's `containerClassName`). */
  containerClassName?: string;
}) {
  const cls =
    containerClassName ??
    "px-4 sm:px-6 py-5 max-w-[1600px] mx-auto pb-24 lg:pb-12";
  return (
    // pf-app on the OUTERMOST element so the dotted background covers the full
    // viewport AND the scrollable area — matching the hydrated page (Roast
    // pattern). The previous bg-background outer + inner `pf-app min-h-full`
    // collapsed to content height, leaving the page un-dotted below the fold.
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)] pb-20 lg:pb-0">
        <div className={cls} aria-hidden="true">
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Loading wrapper for route `loading.tsx` files.
 *
 * Stage-1 shell: renders the IDENTICAL chrome as PageGuard's
 * `PageLoadingSkeleton` (stage 2) via the shared `PageSkeletonShell`.
 * Both stages produce: Sidebar + offset main + skeleton body — no
 * breadcrumb/title header (Task B). The `title` and `breadcrumb` props
 * are kept for API compatibility with the ~40 existing `loading.tsx`
 * callers but are intentionally NOT rendered (Task B).
 */
export function PageLoadingWrapper({
  children,
}: {
  children: React.ReactNode;
  /** Accepted for API compatibility — no longer rendered (Task B). */
  title?: string;
  /** Accepted for API compatibility — no longer rendered (Task B). */
  breadcrumb?: string;
}) {
  return <PageSkeletonShell>{children}</PageSkeletonShell>;
}

/* ========== PRIMITIVE HELPERS (kept by name + signature) ========== */

/**
 * Stats card placeholder — playful `.pf-stat` tile.
 */
export function StatsCardSkeleton() {
  return <StatTile />;
}

/**
 * Table row placeholder — dashed-rule playful table row.
 */
export function TableRowSkeleton({ columns = 6 }: { columns?: number }) {
  return (
    <tr style={{ borderBottom: "1px dashed var(--rule-soft)" }}>
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="px-3 py-3">
          <Bar className="h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}

/**
 * Table placeholder — playful ink-bordered card wrapping a `.pf-tbl`-style
 * header + rows.
 */
export function TableSkeleton({
  rows = 5,
  columns = 6,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <SkCard className="overflow-hidden !p-0">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: "1.5px solid var(--rule-soft)" }}>
              {Array.from({ length: columns }).map((_, i) => (
                <th key={i} className="px-3 py-3 text-left">
                  <Bar className="h-3 w-16" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, i) => (
              <TableRowSkeleton key={i} columns={columns} />
            ))}
          </tbody>
        </table>
      </div>
    </SkCard>
  );
}

/**
 * Chart placeholder — ink-bordered card with a bar-graph silhouette.
 */
export function ChartSkeleton({ height = "h-64" }: { height?: string }) {
  return (
    <SkCard>
      <Bar className="h-4 w-32 mb-1.5" />
      <Bar className="h-3 w-48 mb-4" />
      <div className={`${height} flex items-end justify-between gap-1`}>
        {Array.from({ length: 12 }).map((_, i) => (
          <Bar
            key={i}
            className="flex-1 rounded-t"
            style={{ height: MINI_BAR_HEIGHTS[i] }}
          />
        ))}
      </div>
    </SkCard>
  );
}

/**
 * Position / holding card placeholder.
 */
export function PositionCardSkeleton() {
  return (
    <SkCard>
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <Bar className="h-5 w-24 mb-1.5" />
          <Bar className="h-3 w-16" />
        </div>
        <Bar className="h-5 w-12 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Bar className="h-3 w-12 mb-1.5" />
          <Bar className="h-4 w-16" />
        </div>
        <div>
          <Bar className="h-3 w-12 mb-1.5" />
          <Bar className="h-4 w-16" />
        </div>
      </div>
    </SkCard>
  );
}

/**
 * Segment / filter pill row placeholder.
 */
export function FilterPillSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2">
      {Array.from({ length: count }).map((_, i) => (
        <Bar
          key={i}
          className="h-8 rounded-full flex-shrink-0"
          style={{ width: `${60 + (i % 3) * 18}px` }}
        />
      ))}
    </div>
  );
}

/**
 * Search / filter bar placeholder.
 */
export function SearchBarSkeleton() {
  return (
    <div className="flex items-center gap-4 mb-6">
      <Bar className="h-10 flex-1 max-w-sm rounded-lg" />
      <Bar className="h-10 w-32 rounded-lg" />
      <Bar className="h-10 w-32 rounded-lg" />
    </div>
  );
}

/**
 * Section title placeholder.
 */
export function SectionTitleSkeleton({ width = "w-48" }: { width?: string }) {
  return (
    <div className="mb-6">
      <Bar className={`h-8 ${width} mb-2`} />
      <Bar className="h-4 w-64" />
    </div>
  );
}

/* ========== PAGE-SPECIFIC SKELETONS ========== */

/**
 * Dashboard skeleton — playful chat-first hero: optional history rail,
 * eyebrow + greeting headline + index cards, then the prompt composer +
 * quick-action chips. Mirrors the hydrated dashboard chrome.
 */
export function DashboardSkeleton() {
  return (
    <PfSkel>
      {/* Hero head — eyebrow + title + sub + right actions (mirrors PfPageHead) */}
      <div
        className="flex items-end justify-between gap-5 flex-wrap mb-[22px] pb-[18px]"
        style={{ borderBottom: "2px solid var(--ink)" }}
      >
        <div className="flex-1 min-w-0 basis-[280px]">
          <div className="flex items-center gap-2 mb-2.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--rule-soft)" }}
            />
            <Bar className="h-2.5 w-44" />
          </div>
          <Bar className="h-9 w-[320px] max-w-full" />
          <Bar className="h-4 w-56 max-w-full mt-3" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Bar className="h-9 w-28 rounded-lg" />
          <Bar className="h-9 w-9 rounded-lg" />
        </div>
      </div>

      {/* Portfolio stat strip — 4 tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatTile key={i} />
        ))}
      </div>

      {/* Performance / Ask-Sage (wide) + side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <SkCard className="lg:col-span-2">
          <Bar className="h-3 w-32 mb-3" />
          <Bar className="h-[180px] w-full rounded-lg" />
        </SkCard>
        <SkCard>
          <Bar className="h-3 w-24 mb-3" />
          <div className="space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Bar key={i} className="h-9 w-full rounded-lg" />
            ))}
          </div>
        </SkCard>
      </div>

      {/* Top holdings table card */}
      <SkCard className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <Bar className="h-3 w-28" />
          <Bar className="h-3 w-16" />
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Bar className="h-8 w-8 rounded-md shrink-0" />
              <Bar className="h-3 w-28" />
              <Bar className="h-3 w-16 ml-auto" />
              <Bar className="h-3 w-20 hidden sm:block" />
            </div>
          ))}
        </div>
      </SkCard>

      {/* Connected brokers + FIRE tip row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <SkCard key={i}>
            <Bar className="h-3 w-24 mb-3" />
            <Bar className="h-4 w-40 mb-2" />
            <Bar className="h-3 w-32" />
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Tradebook skeleton — sub-nav strip + 4-stat strip + period/filter rows
 * + trades table. Mirrors the hydrated tradebook playful layout.
 */
export function TradebookSkeleton() {
  return (
    <PfSkel>
      {/* Sub-nav strip + action */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="inline-flex items-center gap-1.5 p-1 pf-skel-card flat rounded-[9px] overflow-x-auto">
          <Bar className="h-7 w-20 rounded-md shrink-0" />
          <Bar className="h-7 w-20 rounded-md shrink-0" />
          <Bar className="h-7 w-20 rounded-md shrink-0" />
        </div>
        <Bar className="h-9 w-28 rounded-md shrink-0 hidden sm:block" />
      </div>

      {/* 4 stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatTile key={i} />
        ))}
      </div>

      {/* Period pill group */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Bar className="h-3 w-12 mr-1 hidden sm:block" />
        <div className="inline-flex items-center gap-1 p-1 pf-skel-card flat rounded-[9px] overflow-x-auto max-w-full">
          {[20, 18, 16, 16, 20, 18].map((w, i) => (
            <Bar
              key={i}
              className="h-6 rounded-md shrink-0"
              style={{ width: `${w * 4}px` }}
            />
          ))}
        </div>
      </div>

      {/* Filter chip row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Bar className="h-7 w-20 rounded-md" />
        <Bar className="h-7 w-24 rounded-md" />
        <Bar className="h-7 w-28 rounded-md" />
        <div className="hidden sm:flex sm:ml-auto items-center gap-2">
          <Bar className="h-7 w-32 rounded-md" />
        </div>
      </div>

      {/* Trades table */}
      <SkCard className="overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr style={{ borderBottom: "1.5px solid var(--rule-soft)" }}>
                {Array.from({ length: 9 }).map((_, i) => (
                  <th key={i} className="py-3 px-3 sm:px-4 text-left">
                    <Bar className="h-3 w-12" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr
                  key={i}
                  style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                >
                  <td className="py-3 px-3 sm:px-4">
                    <Bar className="h-4 w-14" />
                  </td>
                  <td className="py-3 px-3 sm:px-4">
                    <div className="flex items-center gap-2">
                      <Bar className="h-4 w-20" />
                      <Bar className="h-4 w-10 rounded-full hidden sm:inline-block" />
                    </div>
                  </td>
                  <td className="py-3 px-3 sm:px-4">
                    <Bar className="h-5 w-12 rounded-full" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right">
                    <Bar className="h-4 w-8 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right">
                    <Bar className="h-4 w-20 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right hidden md:table-cell">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right hidden md:table-cell">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 hidden lg:table-cell">
                    <Bar className="h-4 w-16" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right">
                    <Bar className="h-8 w-8 rounded-md ml-auto" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SkCard>
    </PfSkel>
  );
}

/**
 * Holdings skeleton — hero header + 5-stat strip + tab bar + donut row +
 * filter row + holdings table. Mirrors holdings/client.tsx playful layout.
 */
export function HoldingsSkeleton() {
  return (
    <PfSkel>
      <HeroHead />

      {/* 5-stat strip */}
      <div
        className="grid gap-3 mb-4"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <StatTile key={i} accent={i === 2} />
        ))}
      </div>

      {/* Tab bar */}
      <div className="inline-flex items-center gap-1.5 p-1 pf-skel-card flat rounded-[9px] mb-4 w-full sm:w-auto overflow-x-auto">
        <Bar className="h-7 w-24 rounded-md shrink-0" />
        <Bar className="h-7 w-28 rounded-md shrink-0" />
        <Bar className="h-7 w-24 rounded-md shrink-0" />
      </div>

      {/* Donut breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <SkCard key={i}>
            <Bar className="h-3 w-20 mb-3" />
            <div className="flex items-center gap-4">
              <Bar className="h-24 w-24 sm:h-32 sm:w-32 !rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="flex items-center gap-2">
                    <Bar className="h-2.5 w-2.5 !rounded-full shrink-0" />
                    <Bar className="h-3 w-16" />
                    <Bar className="h-3 w-8 ml-auto" />
                  </div>
                ))}
              </div>
            </div>
          </SkCard>
        ))}
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Bar className="h-8 w-16 rounded-md" />
        <Bar className="h-8 w-24 rounded-md" />
        <Bar className="h-8 w-24 rounded-md hidden sm:block" />
        <Bar className="h-8 w-20 rounded-md" />
        <div className="hidden md:flex md:ml-auto items-center gap-2">
          <Bar className="h-8 w-28 rounded-md" />
          <Bar className="h-8 w-28 rounded-md" />
          <Bar className="h-8 w-32 rounded-md" />
        </div>
      </div>

      {/* Holdings table */}
      <SkCard className="overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr style={{ borderBottom: "1.5px solid var(--rule-soft)" }}>
                {Array.from({ length: 7 }).map((_, i) => (
                  <th
                    key={i}
                    className={`py-3 px-3 sm:px-4 text-left ${i > 4 ? "hidden md:table-cell" : ""}`}
                  >
                    <Bar className="h-3 w-12" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr
                  key={i}
                  style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                >
                  <td className="py-3 px-3 sm:px-4">
                    <Bar className="h-4 w-20 mb-1.5" />
                    <Bar className="h-3 w-12" />
                  </td>
                  <td className="py-3 px-3 sm:px-4">
                    <Bar className="h-5 w-5 !rounded-full" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right">
                    <Bar className="h-4 w-10 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right">
                    <Bar className="h-4 w-16 ml-auto mb-1.5" />
                    <Bar className="h-3 w-10 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right hidden md:table-cell">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-3 sm:px-4 text-right hidden md:table-cell">
                    <Bar className="h-8 w-8 rounded-md ml-auto" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SkCard>
    </PfSkel>
  );
}

/**
 * Positions skeleton — hero header + 5-stat strip + filter card + open
 * positions table + closed-today table.
 */
export function PositionsSkeleton() {
  return (
    <PfSkel>
      <HeroHead />

      {/* 5-stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <StatTile key={i} accent={i === 2} />
        ))}
      </div>

      {/* Filter card */}
      <SkCard flat className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Bar className="h-9 flex-1 min-w-[150px] rounded-lg" />
          <Bar className="h-9 w-32 rounded-lg" />
          <Bar className="h-9 w-24 rounded-lg" />
        </div>
      </SkCard>

      {/* Open positions table */}
      <SkCard className="overflow-hidden !p-0 mb-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr style={{ borderBottom: "1.5px solid var(--rule-soft)" }}>
                {Array.from({ length: 10 }).map((_, i) => (
                  <th key={i} className="py-4 px-4 text-left">
                    <Bar className="h-3 w-12" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr
                  key={i}
                  style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                >
                  <td className="py-3 px-4">
                    <Bar className="h-4 w-20" />
                  </td>
                  <td className="py-3 px-4">
                    <Bar className="h-4 w-28 mb-1.5" />
                    <Bar className="h-3 w-10" />
                  </td>
                  <td className="py-3 px-4">
                    <Bar className="h-5 w-14 rounded-full" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-4 w-10 ml-auto" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-5 w-20 ml-auto mb-1.5" />
                    <Bar className="h-3 w-10 ml-auto" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-4">
                    <Bar className="h-5 w-16 rounded-full" />
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1">
                      <Bar className="h-4 w-4 rounded" />
                      <Bar className="h-4 w-16" />
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-7 w-14 ml-auto rounded-md" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SkCard>

      {/* Closed today */}
      <SkCard className="!p-0">
        <div className="px-4 pt-4 pb-3 flex items-center gap-2">
          <Bar className="h-4 w-4 rounded" />
          <Bar className="h-4 w-24" />
          <Bar className="h-5 w-6 rounded-full" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: "1.5px solid var(--rule-soft)" }}>
                {Array.from({ length: 7 }).map((_, i) => (
                  <th key={i} className="py-3 px-4 text-left">
                    <Bar className="h-3 w-14" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr
                  key={i}
                  style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                >
                  <td className="py-3 px-4">
                    <Bar className="h-4 w-24" />
                  </td>
                  <td className="py-3 px-4">
                    <Bar className="h-4 w-10" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Bar className="h-4 w-20 ml-auto" />
                  </td>
                  <td className="py-3 px-4">
                    <Bar className="h-5 w-14 rounded-full" />
                  </td>
                  <td className="py-3 px-4">
                    <Bar className="h-4 w-16" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SkCard>
    </PfSkel>
  );
}

/**
 * Paper trading skeleton — sub-nav strip + 4-stat strip + performance
 * chart + filter row + positions grid.
 */
export function PaperTradingSkeleton() {
  return (
    <PfSkel>
      {/* Sub-nav strip */}
      <div className="inline-flex items-center gap-1 p-1 pf-skel-card flat rounded-[9px] mb-4 w-full sm:w-auto overflow-x-auto">
        {[20, 20, 16, 20, 20, 20].map((w, i) => (
          <Bar
            key={i}
            className={`h-7 rounded-md shrink-0${i === 5 ? " hidden sm:inline-block" : ""}`}
            style={{ width: `${w * 4}px` }}
          />
        ))}
      </div>

      {/* 4 stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatTile key={i} accent={i === 2} />
        ))}
      </div>

      {/* Performance chart */}
      <SkCard className="mb-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <Bar className="h-4 w-32" />
          <Bar
            className="h-5 w-32 rounded-full"
            style={{ background: "var(--rule-softer)" }}
          />
        </div>
        <div className="h-40 sm:h-52 flex items-end gap-1 sm:gap-1.5">
          {Array.from({ length: 30 }).map((_, i) => (
            <Bar
              key={i}
              className="flex-1 rounded-t min-w-[3px]"
              style={{ height: WIDE_BAR_HEIGHTS[i] }}
            />
          ))}
        </div>
      </SkCard>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Bar className="h-8 w-20 rounded-md" />
        <Bar className="h-8 w-24 rounded-md" />
        <Bar className="h-8 w-24 rounded-md hidden sm:block" />
        <div className="ml-auto flex items-center gap-2">
          <Bar className="h-8 w-32 rounded-md hidden md:block" />
        </div>
      </div>

      {/* Positions grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkCard key={i}>
            <div className="flex items-start justify-between mb-3 gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <Bar className="h-5 w-20" />
                  <Bar className="h-4 w-10 rounded-full" />
                </div>
                <Bar className="h-3 w-28" />
              </div>
              <Bar className="h-5 w-14 rounded-full shrink-0" />
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j}>
                  <Bar className="h-3 w-14 mb-1.5" />
                  <Bar className="h-4 w-16" />
                </div>
              ))}
            </div>
            <div
              className="pt-3 flex items-center justify-between"
              style={{ borderTop: "1px dashed var(--rule-soft)" }}
            >
              <Bar className="h-3 w-8" />
              <Bar className="h-5 w-20" />
            </div>
            <div className="flex gap-2 mt-3">
              <Bar className="h-8 flex-1 rounded-md" />
              <Bar className="h-8 w-8 rounded-md" />
            </div>
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Analysis skeleton — "Running now" pulse row + research history panel
 * (filter row + tier pills + session rows + pagination).
 */
export function AnalysisSkeleton() {
  return (
    <PfSkel>
      {/* Running now */}
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-3">
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: "var(--pop-2)" }}
          />
          <Bar className="h-3 w-28" />
        </div>
        <SkCard flat className="flex items-center gap-3">
          <Bar className="h-5 w-5 !rounded-full flex-shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <Bar className="h-4 w-20" />
              <Bar className="h-4 w-16 rounded-full" />
              <Bar className="h-4 w-20 rounded-full" />
            </div>
            <Bar className="h-1.5 w-full rounded-full" />
            <div className="flex items-center justify-between">
              <Bar className="h-3 w-40" />
              <Bar className="h-3 w-12 ml-2" />
            </div>
          </div>
          <Bar className="h-6 w-6 rounded-md flex-shrink-0" />
        </SkCard>
      </div>

      {/* Research history panel */}
      <SkCard className="!p-0">
        <div
          className="px-5 py-4"
          style={{ borderBottom: "1.5px solid var(--rule-soft)" }}
        >
          <div className="flex items-center gap-2">
            <Bar className="h-3.5 w-3.5 rounded" />
            <Bar className="h-3 w-36" />
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Bar className="h-9 flex-1 min-w-[200px] rounded-lg" />
            <Bar className="h-9 w-[130px] rounded-lg" />
            <Bar className="h-9 w-[130px] rounded-lg" />
          </div>
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <div className="flex gap-1 p-[3px] pf-skel-card flat rounded-[9px]">
              {Array.from({ length: 5 }).map((_, i) => (
                <Bar key={i} className="h-6 w-10 rounded-md" />
              ))}
            </div>
            <div className="flex-1" />
            <Bar className="h-7 w-24 rounded-md" />
          </div>
        </div>

        <div className="p-3 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkCard key={i} flat className="flex items-center gap-3">
              <Bar className="w-10 h-10 !rounded-full flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Bar className="h-4 w-20" />
                  <Bar className="h-4 w-16 rounded-full" />
                  <Bar className="h-4 w-12 rounded-full" />
                </div>
                <Bar className="h-3 w-40 mt-1.5" />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Bar className="h-3 w-14" />
                <Bar className="h-7 w-7 rounded-md" />
                <Bar className="h-7 w-7 rounded-md" />
              </div>
            </SkCard>
          ))}
        </div>

        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ borderTop: "1.5px solid var(--rule-soft)" }}
        >
          <Bar className="h-4 w-32" />
          <div className="flex items-center gap-2">
            <Bar className="h-8 w-8 rounded-md" />
            <Bar className="h-4 w-16" />
            <Bar className="h-8 w-8 rounded-md" />
          </div>
        </div>
      </SkCard>
    </PfSkel>
  );
}

/**
 * FIRE skeleton — 4-stat strip + scenario tabs + projection chart +
 * two-column parameters / summary.
 */
export function FireSkeleton() {
  return (
    <PfSkel>
      {/* 4 stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatTile key={i} />
        ))}
      </div>

      {/* Scenario tabs */}
      <div className="inline-flex items-center gap-1.5 p-1 pf-skel-card flat rounded-[9px] mb-4 w-full sm:w-auto overflow-x-auto">
        <Bar className="h-7 w-28 rounded-md shrink-0" />
        <Bar className="h-7 w-24 rounded-md shrink-0" />
        <Bar className="h-7 w-24 rounded-md shrink-0" />
        <Bar className="h-7 w-7 rounded-md shrink-0 ml-1" />
      </div>

      {/* Projection chart */}
      <SkCard className="mb-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <Bar className="h-4 w-40" />
          <Bar
            className="h-5 w-48 rounded-full"
            style={{ background: "var(--rule-softer)" }}
          />
        </div>
        <div className="h-60 sm:h-72 lg:h-80 flex items-end justify-between gap-1 sm:gap-2">
          {Array.from({ length: 20 }).map((_, i) => (
            <Bar
              key={i}
              className="flex-1 rounded-t min-w-[6px]"
              style={{ height: `${Math.min(100, 20 + i * 4)}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between mt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Bar key={i} className="h-3 w-8" />
          ))}
        </div>
      </SkCard>

      {/* Two-column params + summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          <SkCard>
            <Bar className="h-4 w-32 mb-3" />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i}>
                  <Bar className="h-3 w-24 mb-2" />
                  <Bar className="h-2 w-full rounded-full mb-1.5" />
                  <Bar className="h-3 w-8" />
                </div>
              ))}
            </div>
          </SkCard>
          <SkCard className="space-y-3">
            <Bar className="h-4 w-36 mb-2" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Bar className="h-8 w-8 rounded-md" />
                <div className="flex-1">
                  <Bar className="h-3 w-20 mb-1.5" />
                  <Bar className="h-2 w-full rounded-full" />
                </div>
                <Bar className="h-3 w-10" />
              </div>
            ))}
          </SkCard>
        </div>

        <div className="space-y-4">
          <SkCard className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <Bar className="h-4 w-36" />
              <Bar className="h-8 w-24 rounded-md" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2"
                style={{ borderBottom: "1px dashed var(--rule-soft)" }}
              >
                <Bar className="h-3 w-28" />
                <Bar className="h-3 w-20" />
              </div>
            ))}
            <div className="flex items-center justify-between pt-2">
              <Bar className="h-4 w-20" />
              <Bar className="h-4 w-24" />
            </div>
          </SkCard>
          <SkCard>
            <div className="text-center mb-4">
              <Bar className="h-3 w-32 mx-auto mb-2.5" />
              <Bar
                className="h-9 sm:h-10 w-48 max-w-full mx-auto"
                style={{ background: "var(--rule-softer)" }}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center">
                <Bar className="h-3 w-24 mx-auto mb-2" />
                <Bar className="h-6 w-20 mx-auto" />
              </div>
              <div className="text-center">
                <Bar className="h-3 w-24 mx-auto mb-2" />
                <Bar className="h-6 w-20 mx-auto" />
              </div>
            </div>
          </SkCard>
        </div>
      </div>
    </PfSkel>
  );
}

/**
 * Brokers skeleton — connected brokers grid + available brokers grid.
 */
export function BrokersSkeleton() {
  return (
    <PfSkel>
      <div className="mb-3">
        <Bar className="h-3 w-28" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkCard key={i}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Bar className="h-10 w-10 rounded-lg shrink-0" />
                <div className="flex-1 min-w-0">
                  <Bar className="h-4 w-24 mb-2" />
                  <Bar className="h-3 w-20" />
                </div>
              </div>
              <Bar
                className="h-5 w-16 rounded-full shrink-0"
                style={{ background: "var(--rule-softer)" }}
              />
            </div>
            <Bar className="h-3 w-32 mb-3" />
            <div className="flex items-center gap-2">
              <Bar className="h-8 flex-1 rounded-md" />
              <Bar className="h-8 w-8 rounded-md" />
            </div>
          </SkCard>
        ))}
      </div>

      <div className="mb-3">
        <Bar className="h-3 w-28" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkCard key={i} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Bar className="h-10 w-10 rounded-lg shrink-0" />
              <Bar className="h-4 w-24" />
            </div>
            <Bar className="h-7 w-16 rounded-md shrink-0" />
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Settings skeleton — plan pill + mobile pill nav + sticky rail + profile
 * card + preferences/security cards.
 */
export function SettingsSkeleton() {
  return (
    <PfSkel>
      {/* Plan pill */}
      <div className="flex justify-end mb-3 -mt-3">
        <Bar
          className="h-5 w-20 rounded-full"
          style={{ background: "var(--rule-softer)" }}
        />
      </div>

      {/* Mobile pill nav */}
      <div className="lg:hidden flex gap-1.5 overflow-x-auto pb-1 mb-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Bar key={i} className="h-8 w-24 shrink-0 rounded-full" />
        ))}
      </div>

      {/* Two-column */}
      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-7 items-start">
        <aside className="hidden lg:block">
          <SkCard flat className="p-2 !rounded-[12px]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="w-full px-3 py-2.5 flex items-center gap-2.5 mb-0.5"
              >
                <Bar className="h-3.5 w-3.5 rounded shrink-0" />
                <Bar className="h-4 w-24" />
              </div>
            ))}
          </SkCard>
          <SkCard flat className="mt-3 !p-3 space-y-2">
            <Bar className="h-3 w-14" />
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-3/4" />
          </SkCard>
        </aside>

        <div className="space-y-4">
          {/* Profile card */}
          <SkCard>
            <div className="flex items-center justify-between mb-5">
              <Bar className="h-5 w-40" />
              <div className="flex items-center gap-2">
                <Bar className="h-8 w-28 rounded-md" />
                <Bar className="h-8 w-8 !rounded-full" />
              </div>
            </div>
            <div
              className="flex items-center gap-4 pb-4 mb-6"
              style={{ borderBottom: "1px dashed var(--rule-soft)" }}
            >
              <Bar className="h-16 w-16 !rounded-full flex-shrink-0" />
              <div>
                <Bar className="h-5 w-36 mb-2" />
                <Bar className="h-4 w-48" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Bar className="h-3 w-20" />
                  <Bar className="h-5 w-36" />
                </div>
              ))}
            </div>
          </SkCard>

          {/* Preferences + security */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <SkCard>
              <div className="flex items-center gap-2 mb-1.5">
                <Bar className="h-5 w-5 rounded" />
                <Bar className="h-5 w-28" />
              </div>
              <Bar className="h-3 w-48 mb-4" />
              <Bar className="h-4 w-32 mb-2" />
              <Bar className="h-10 w-full rounded-md mb-2" />
              <Bar className="h-3 w-56" />
            </SkCard>
            <SkCard>
              <div className="flex items-center gap-2 mb-1.5">
                <Bar className="h-5 w-5 rounded" />
                <Bar className="h-5 w-20" />
              </div>
              <Bar className="h-3 w-44 mb-4" />
              <SkCard flat className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Bar className="h-5 w-5 rounded" />
                  <div>
                    <Bar className="h-4 w-44 mb-1.5" />
                    <Bar className="h-3 w-40" />
                  </div>
                </div>
                <Bar className="h-5 w-24 rounded-full" />
              </SkCard>
            </SkCard>
          </div>
        </div>
      </div>
    </PfSkel>
  );
}

/**
 * Discover skeleton — hero + tabs + search + filter pills + stock card
 * grid + pagination.
 */
export function DiscoverSkeleton() {
  const StockCardSkeleton = () => (
    <SkCard className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="flex items-center gap-1.5">
            <Bar className="h-5 w-16" />
            <Bar className="h-4 w-10 rounded-full" />
          </div>
          <Bar className="h-3 w-28 mt-1.5" />
        </div>
        <Bar className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center justify-between">
        <Bar className="h-6 w-20" />
        <Bar className="h-4 w-14" />
      </div>
      <div
        className="flex items-center justify-between mt-3 pt-3"
        style={{ borderTop: "1px dashed var(--rule-soft)" }}
      >
        <Bar className="h-3 w-20" />
        <Bar className="h-3 w-24" />
      </div>
      <div className="flex gap-2 mt-3">
        <Bar className="h-8 flex-1 rounded-md" />
        <Bar className="h-8 w-8 rounded-md" />
      </div>
    </SkCard>
  );

  return (
    <PfSkel>
      <HeroHead />

      {/* Tabs */}
      <div className="inline-flex gap-1 p-1 pf-skel-card flat rounded-lg w-fit mb-6">
        <Bar className="h-8 w-24 rounded-md" />
        <Bar className="h-8 w-32 rounded-md" />
        <Bar className="h-8 w-32 rounded-md" />
      </div>

      {/* Search */}
      <Bar className="h-10 w-full rounded-md mb-4" />

      {/* Exchange pills */}
      <div className="flex flex-wrap gap-2 mb-3">
        <Bar className="h-6 w-24 rounded-full" />
        <Bar className="h-6 w-12 rounded-full" />
        <Bar className="h-6 w-12 rounded-full" />
      </div>

      {/* List mode pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Bar className="h-6 w-20 rounded-full" />
        <Bar className="h-6 w-24 rounded-full" />
        <Bar className="h-6 w-[88px] rounded-full" />
      </div>

      {/* Sector dropdown */}
      <div className="flex gap-3 mb-6">
        <Bar className="h-10 w-[220px] rounded-lg" />
        <Bar className="h-10 w-36 rounded-lg" />
      </div>

      {/* Section header */}
      <div className="flex items-center gap-2 mb-4">
        <Bar className="h-5 w-5 rounded" />
        <Bar className="h-6 w-24" />
        <Bar className="h-5 w-8 rounded-full" />
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <StockCardSkeleton key={i} />
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <Bar className="h-4 w-40" />
        <div className="flex items-center gap-2">
          <Bar className="h-8 w-8 rounded-md" />
          <Bar className="h-4 w-16" />
          <Bar className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </PfSkel>
  );
}

/**
 * Tutor skeleton — chat interface card with a message row + input.
 */
export function TutorSkeleton() {
  return (
    <PfSkel>
      <div className="mb-6">
        <Bar className="h-8 w-48 mb-2.5" />
        <Bar className="h-4 w-64" />
      </div>

      <SkCard>
        <div className="space-y-4 mb-6 min-h-[400px]">
          <div className="flex gap-3">
            <Bar className="h-8 w-8 !rounded-full flex-shrink-0" />
            <div className="flex-1">
              <Bar className="h-4 w-full mb-2" />
              <Bar className="h-4 w-3/4" />
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Bar className="h-12 flex-1 rounded-lg" />
          <Bar className="h-12 w-12 rounded-lg" />
        </div>
      </SkCard>
    </PfSkel>
  );
}

/**
 * Stock detail skeleton — back button + price header + chart card + stats
 * / about grid + action buttons.
 */
export function StockDetailSkeleton() {
  return (
    <PfSkel>
      {/* Back button */}
      <div className="flex items-center gap-4 mb-6">
        <Bar className="h-8 w-20 rounded-lg" />
      </div>

      {/* Price header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1.5">
            <Bar className="h-9 w-36" />
            <Bar className="h-6 w-12 rounded-full" />
            <Bar className="h-6 w-20 rounded-full" />
          </div>
          <Bar className="h-4 w-48" />
        </div>
        <div className="text-right">
          <Bar className="h-9 w-32 ml-auto mb-1.5" />
          <Bar className="h-4 w-40 ml-auto" />
        </div>
      </div>

      {/* Chart card */}
      <SkCard className="mb-6 !p-0">
        <div className="flex items-center justify-end px-4 pt-3">
          <Bar className="h-5 w-16 rounded-full" />
        </div>
        <div className="h-[500px] px-4 pb-4 flex items-end gap-0.5">
          {Array.from({ length: 60 }).map((_, i) => (
            <Bar
              key={i}
              className="flex-1 rounded-t-sm"
              style={{ height: CHART_BAR_HEIGHTS[i] }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1 px-4 pb-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Bar key={i} className="h-8 w-12 rounded-md" />
          ))}
        </div>
      </SkCard>

      {/* Stats + about grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <SkCard>
          <div className="flex items-center gap-2 mb-4">
            <Bar className="h-5 w-5 rounded" />
            <Bar className="h-5 w-28" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i}>
                <Bar className="h-3 w-16 mb-1.5" />
                <Bar className="h-5 w-24" />
              </div>
            ))}
          </div>
        </SkCard>

        <SkCard>
          <div className="flex items-center gap-2 mb-4">
            <Bar className="h-5 w-5 rounded" />
            <Bar className="h-5 w-16" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex justify-between py-2"
                style={{ borderBottom: "1px dashed var(--rule-soft)" }}
              >
                <Bar className="h-4 w-16" />
                <Bar className="h-4 w-24" />
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-2">
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-4/5" />
            <Bar className="h-3 w-3/5" />
          </div>
        </SkCard>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        <Bar className="h-10 w-44 rounded-lg" />
        <Bar className="h-10 w-36 rounded-lg" />
      </div>
    </PfSkel>
  );
}

/**
 * Watchlist skeleton — sidebar list + active watchlist table.
 */
export function WatchlistSkeleton() {
  return (
    <PfSkel>
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Sidebar list */}
        <div className="w-full lg:w-64 shrink-0 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <Bar className="h-4 w-24" />
            <Bar className="h-7 w-7 rounded-md" />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 p-2 rounded-lg">
              <Bar className="h-4 w-4 rounded" />
              <Bar className="h-4 w-24" />
              <Bar className="h-4 w-6 ml-auto rounded-full" />
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-3 mb-4">
            <Bar className="h-6 w-44" />
            <Bar className="h-3 w-24" />
            <div className="ml-auto flex items-center gap-2">
              <Bar className="h-8 w-8 rounded-md" />
              <Bar className="h-8 w-8 rounded-md" />
            </div>
          </div>

          <SkCard className="overflow-hidden !p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr style={{ borderBottom: "1.5px solid var(--rule-soft)" }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <th
                        key={i}
                        className={`py-3 px-3 sm:px-4 ${i === 1 ? "hidden sm:table-cell" : ""} ${i === 4 ? "text-right" : "text-left"}`}
                      >
                        <Bar className="h-3 w-14" />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <tr
                      key={i}
                      style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                    >
                      <td className="py-3 px-3 sm:px-4">
                        <Bar className="h-4 w-16" />
                      </td>
                      <td className="py-3 px-3 sm:px-4 hidden sm:table-cell">
                        <Bar className="h-4 w-32" />
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right">
                        <Bar className="h-4 w-16 ml-auto" />
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right">
                        <Bar className="h-4 w-14 ml-auto" />
                      </td>
                      <td className="py-3 px-3 sm:px-4 text-right">
                        <Bar className="h-8 w-8 rounded-md ml-auto" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SkCard>
        </div>
      </div>
    </PfSkel>
  );
}

/**
 * Tax report skeleton — playful generic placeholder. The /tax v2 layout
 * is being built in parallel, so this is a clean, on-brand stand-in:
 * 3-stat strip + two stacked content cards.
 */
export function TaxSkeleton() {
  return (
    <PfSkel>
      {/* 3-stat strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <StatTile key={i} />
        ))}
      </div>

      {/* Breakdown table card */}
      <SkCard className="mb-4">
        <Bar className="h-5 w-48 mb-4" />
        <TableSkeleton rows={6} columns={6} />
      </SkCard>

      {/* Two summary cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SkCard className="space-y-3">
          <Bar className="h-5 w-36 mb-1" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-2"
              style={{ borderBottom: "1px dashed var(--rule-soft)" }}
            >
              <Bar className="h-4 w-24" />
              <Bar className="h-4 w-20" />
            </div>
          ))}
        </SkCard>
        <SkCard className="space-y-4">
          <Bar className="h-5 w-40 mb-1" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Bar className="h-10 w-10 !rounded-full" />
              <div className="flex-1">
                <Bar className="h-4 w-24 mb-1.5" />
                <Bar className="h-3 w-16" />
              </div>
              <Bar className="h-5 w-20" />
            </div>
          ))}
        </SkCard>
      </div>
    </PfSkel>
  );
}

/* ========== LEARNING PAGE SKELETONS ========== */

/**
 * Learning hub skeleton — header + search + tabs + level filter + course
 * card grid.
 */
export function LearningSkeleton() {
  return (
    <PfSkel>
      <div className="mb-6">
        <Bar className="h-8 w-32 mb-2.5" />
        <Bar className="h-4 w-56" />
      </div>

      {/* Search */}
      <Bar className="h-10 w-full max-w-md rounded-lg mb-4" />

      {/* Tabs */}
      <div className="mb-6">
        <div className="inline-flex h-10 items-center justify-center rounded-lg pf-skel-card flat p-1 gap-1">
          <Bar className="h-8 w-24 rounded-md" />
          <Bar className="h-8 w-20 rounded-md" />
          <Bar className="h-8 w-24 rounded-md" />
          <Bar className="h-8 w-24 rounded-md" />
        </div>
      </div>

      {/* Level pills */}
      <FilterPillSkeleton count={4} />

      {/* Course cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkCard key={i} className="!p-0 overflow-hidden">
            <Bar className="h-40 w-full !rounded-none" />
            <div className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Bar className="h-5 w-20 rounded-full" />
                <Bar className="h-5 w-16 rounded-full" />
              </div>
              <Bar className="h-5 w-3/4 mb-2" />
              <Bar className="h-3 w-full mb-1.5" />
              <Bar className="h-3 w-2/3 mb-3" />
              <div className="flex items-center justify-between">
                <Bar className="h-3 w-20" />
                <Bar className="h-3 w-16" />
              </div>
            </div>
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Course detail skeleton — back button + course header + lesson list.
 */
export function CourseDetailSkeleton() {
  return (
    <PfSkel>
      <Bar className="h-8 w-24 rounded-lg mb-6" />

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Bar className="h-6 w-20 rounded-full" />
          <Bar className="h-6 w-16 rounded-full" />
        </div>
        <Bar className="h-9 w-2/3 mb-3" />
        <Bar className="h-4 w-full mb-1.5" />
        <Bar className="h-4 w-3/4 mb-4" />

        <div className="flex items-center gap-6 mb-4">
          <Bar className="h-4 w-20" />
          <Bar className="h-4 w-24" />
          <Bar className="h-4 w-20" />
        </div>

        <Bar className="h-2 w-full rounded-full mb-2" />
        <Bar className="h-3 w-24" />
      </div>

      <Bar className="h-10 w-40 rounded-lg mb-6" />

      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkCard key={i}>
            <div className="flex items-center gap-3">
              <Bar className="h-8 w-8 !rounded-full" />
              <div className="flex-1">
                <Bar className="h-4 w-2/3 mb-1.5" />
                <Bar className="h-3 w-20" />
              </div>
              <Bar className="h-5 w-5 rounded" />
            </div>
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Lesson detail skeleton — content column + sticky sidebar nav.
 */
export function LessonSkeleton() {
  return (
    <PfSkel className="flex gap-6">
      <div className="flex-1">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 mb-6">
          <Bar className="h-4 w-16" />
          <Bar className="h-4 w-4" />
          <Bar className="h-4 w-24" />
          <Bar className="h-4 w-4" />
          <Bar className="h-4 w-32" />
        </div>

        <Bar className="h-8 w-3/4 mb-4" />

        <SkCard className="mb-6">
          <div className="space-y-3">
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-5/6" />
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-3/4" />
            <Bar className="h-32 w-full rounded-lg mt-4" />
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-2/3" />
          </div>
        </SkCard>

        <div className="flex items-center justify-between">
          <Bar className="h-10 w-32 rounded-lg" />
          <Bar className="h-10 w-32 rounded-lg" />
        </div>
      </div>

      <div className="hidden lg:block w-64 shrink-0">
        <SkCard className="sticky top-6">
          <Bar className="h-5 w-28 mb-4" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <Bar className="h-4 w-4 rounded" />
                <Bar
                  className="h-3 flex-1"
                  style={{ width: `${60 + (i % 4) * 10}%` }}
                />
              </div>
            ))}
          </div>
        </SkCard>
      </div>
    </PfSkel>
  );
}

/**
 * Risk report skeleton — playful generic placeholder. The /risk v2 layout
 * is being built in parallel, so this is a clean, on-brand stand-in:
 * 4-stat strip + 2x2 chart/metric cards.
 */
export function RiskSkeleton() {
  return (
    <PfSkel>
      {/* 4-stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatTile key={i} accent={i === 0} />
        ))}
      </div>

      {/* 2x2 cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Concentration */}
        <SkCard>
          <div className="flex items-center justify-between mb-4">
            <Bar className="h-5 w-44" />
            <Bar className="h-6 w-32 rounded-full" />
          </div>
          <Bar className="h-8 w-24 mb-3" />
          <Bar className="h-2.5 w-full rounded-full mb-4" />
          <div className="space-y-2 mb-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Bar className="h-4 w-20" />
                <Bar className="h-2 flex-1 rounded-full" />
                <Bar className="h-4 w-12" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <Bar className="h-40 w-40 !rounded-full" />
            <div className="flex-1 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Bar className="h-3 w-3 rounded-sm" />
                  <Bar className="h-3 w-20" />
                  <Bar className="h-3 w-10 ml-auto" />
                </div>
              ))}
            </div>
          </div>
        </SkCard>

        {/* Correlation */}
        <SkCard>
          <div className="flex items-center justify-between mb-4">
            <Bar className="h-5 w-36" />
            <Bar className="h-6 w-40 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <Bar className="h-16 rounded-lg" />
            <Bar className="h-16 rounded-lg" />
          </div>
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-1">
                <Bar className="h-10 w-20" />
                {Array.from({ length: 5 }).map((_, j) => (
                  <Bar key={j} className="h-10 w-16 rounded-sm" />
                ))}
              </div>
            ))}
          </div>
        </SkCard>

        {/* VaR stat */}
        <StatsCardSkeleton />

        {/* Chart */}
        <ChartSkeleton height="h-64" />
      </div>
    </PfSkel>
  );
}

/**
 * Documents skeleton — header + upload zone + URL import + filter pills +
 * search + document card grid.
 */
export function DocumentsSkeleton() {
  return (
    <PfSkel>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Bar className="h-8 w-8 rounded" />
            <Bar className="h-8 w-36" />
          </div>
          <Bar className="h-4 w-72 mt-1.5" />
        </div>
        <Bar className="h-10 w-40 rounded-lg" />
      </div>

      {/* Upload zone */}
      <div className="space-y-3 mb-6">
        <SkCard
          flat
          className="p-8"
          style={{ borderStyle: "dashed", borderColor: "var(--rule-soft)" }}
        >
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <Bar className="h-6 w-6 rounded" />
              <Bar className="h-6 w-6 rounded" />
            </div>
            <div className="text-center">
              <Bar className="h-4 w-56 mx-auto mb-1.5" />
              <Bar className="h-3 w-48 mx-auto" />
            </div>
          </div>
        </SkCard>

        <div className="flex gap-2">
          <Bar className="h-10 flex-1 rounded-lg" />
          <Bar className="h-10 w-20 rounded-lg" />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="flex flex-wrap gap-1.5">
          {[40, 130, 110, 70].map((w, i) => (
            <Bar
              key={i}
              className="h-8 rounded-md"
              style={{ width: `${w}px` }}
            />
          ))}
        </div>
        <div className="sm:ml-auto">
          <Bar className="h-8 w-64 rounded-lg" />
        </div>
      </div>

      {/* Document grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 9 }).map((_, i) => (
          <SkCard key={i}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Bar className="h-5 w-5 rounded shrink-0" />
                <Bar className="h-4 w-32" />
              </div>
              <Bar className="h-4 w-16 rounded-full shrink-0" />
            </div>
            <Bar className="h-3 w-40 mb-2" />
            <div className="flex items-center justify-between mb-2">
              <Bar className="h-3 w-14" />
              <div className="flex items-center gap-1">
                <Bar className="h-3 w-3 !rounded-full" />
                <Bar className="h-3 w-12" />
              </div>
            </div>
            <Bar className="h-3 w-24 mb-3" />
            <div
              className="flex items-center gap-2 pt-2"
              style={{ borderTop: "1px dashed var(--rule-soft)" }}
            >
              <Bar className="h-7 w-14 rounded-md" />
              <Bar className="h-7 w-7 rounded-md ml-auto" />
            </div>
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Chat history skeleton — header + search + filters + chat list.
 */
export function ChatHistorySkeleton() {
  return (
    <PfSkel className="max-w-6xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Bar className="h-7 w-7 rounded" />
          <Bar className="h-7 w-36" />
        </div>
        <Bar className="h-4 w-64" />
      </div>

      <SkCard className="mb-6">
        <Bar className="h-10 w-full rounded-lg" />
      </SkCard>

      <SkCard className="mb-6">
        <Bar className="h-4 w-14 mb-3" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Bar key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      </SkCard>

      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkCard key={i}>
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-3">
                <Bar className="h-10 w-10 !rounded-full" />
                <div>
                  <Bar className="h-4 w-32 mb-1.5" />
                  <Bar className="h-3 w-40" />
                </div>
              </div>
              <div className="flex gap-2">
                <Bar className="h-8 w-8 rounded-md" />
                <Bar className="h-8 w-8 rounded-md" />
                <Bar className="h-8 w-8 rounded-md" />
              </div>
            </div>
            <Bar className="h-3 w-full mb-1.5 ml-[52px]" />
            <Bar className="h-3 w-3/4 ml-[52px]" />
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Help center skeleton — header + tab pills + search + category chips +
 * prompt card grid.
 */
export function HelpSkeleton() {
  return (
    <PfSkel>
      <div className="flex items-center gap-3 mb-6">
        <Bar className="h-6 w-6 rounded" />
        <div>
          <Bar className="h-6 w-28 mb-1.5" />
          <Bar className="h-4 w-72" />
        </div>
      </div>

      {/* Tab pills */}
      <div className="inline-flex gap-1 p-1 rounded-lg pf-skel-card flat mb-6 flex-wrap">
        <Bar className="h-8 w-20 rounded-md" />
        <Bar className="h-8 w-24 rounded-md" />
        <Bar className="h-8 w-[72px] rounded-md" />
        <Bar className="h-8 w-14 rounded-md" />
        <Bar className="h-8 w-14 rounded-md" />
        <Bar className="h-8 w-20 rounded-md" />
      </div>

      <div className="space-y-6">
        {/* Search */}
        <Bar className="h-10 w-full rounded-lg" />

        {/* Category chips */}
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Bar
              key={i}
              className="h-7 rounded-full"
              style={{ width: `${60 + (i % 4) * 14}px` }}
            />
          ))}
        </div>

        {/* Prompt card grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <SkCard key={i} className="flex items-start gap-3">
              <Bar className="h-4 w-4 rounded shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <Bar className="h-4 w-3/4 mb-2" />
                <Bar className="h-3 w-full mb-1.5" />
                <Bar className="h-3 w-2/3" />
              </div>
              <Bar className="h-4 w-4 rounded shrink-0 mt-0.5" />
            </SkCard>
          ))}
        </div>
      </div>
    </PfSkel>
  );
}

/**
 * Roast hub skeleton — flame hero + big CTA + config bar + roast history
 * grid.
 */
export function RoastSkeleton() {
  return (
    <PfSkel className="max-w-5xl mx-auto">
      {/* Hero */}
      <div className="text-center mb-8">
        <Bar
          className="h-[76px] w-[76px] !rounded-[20px] mx-auto mb-[18px]"
          style={{ background: "rgba(255, 107, 53, 0.12)" }}
        />
        <Bar className="h-9 w-64 mx-auto mb-2.5" />
        <Bar className="h-4 w-80 max-w-full mx-auto" />
      </div>

      {/* CTA */}
      <Bar
        className="h-14 w-full !rounded-xl mb-7"
        style={{ background: "rgba(255, 107, 53, 0.12)" }}
      />

      {/* Config bar */}
      <SkCard flat className="px-5 py-3 mb-4 !rounded-[12px]">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Bar className="h-3 w-28" />
          <Bar className="h-3 w-40 hidden sm:block" />
          <div className="flex-1 hidden sm:block" />
          <Bar
            className="h-3 w-20 ml-auto"
            style={{ background: "var(--rule-softer)" }}
          />
        </div>
      </SkCard>

      {/* History grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkCard key={i} flat className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Bar className="h-5 w-16 rounded-full" />
              <Bar className="h-3 w-20" />
            </div>
            <Bar className="h-6 w-32" />
            <div className="flex items-center gap-2">
              <Bar className="h-5 w-14 rounded-full" />
              <Bar className="h-5 w-14 rounded-full" />
              <Bar className="h-5 w-16 rounded-full" />
            </div>
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-2/3" />
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Roast detail skeleton — meta-chip header + centred progress hero + 4
 * result tiles. Used by both stage 1 (loading.tsx) and stage 2 (PageGuard
 * fallback) so they render identically.
 */
export function RoastDetailSkeleton() {
  return (
    <PfSkel>
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <Bar className="h-8 w-8 rounded-md shrink-0" />
          <div className="flex items-center gap-2 flex-wrap">
            <Bar className="h-5 w-16 rounded-full" />
            <Bar className="h-5 w-12 rounded-full" />
            <Bar className="h-5 w-16 rounded-full hidden sm:inline-block" />
            <Bar className="h-4 w-24" />
          </div>
        </div>
        <Bar className="h-8 w-20 rounded-md shrink-0" />
      </div>

      <SkCard flat className="py-10 sm:py-14 px-4">
        <div className="max-w-md mx-auto text-center">
          <Bar
            className="h-14 w-14 sm:h-16 sm:w-16 !rounded-2xl mx-auto mb-5"
            style={{ background: "rgba(255, 107, 53, 0.12)" }}
          />
          <Bar className="h-6 w-56 max-w-full mx-auto mb-2.5" />
          <Bar className="h-4 w-40 max-w-full mx-auto mb-6" />
          <Bar className="h-2.5 w-full rounded-full mb-2.5" />
          <div className="flex items-center justify-between">
            <Bar className="h-3 w-16" />
            <Bar className="h-3 w-10" />
          </div>
        </div>
      </SkCard>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkCard key={i} flat className="space-y-3">
            <Bar className="h-3 w-20" />
            <Bar className="h-7 w-28" />
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-3/4" />
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Quizzes skeleton — header + 2 hero cards + 3 quiz cards.
 */
export function QuizzesSkeleton() {
  return (
    <PfSkel className="space-y-6">
      <div>
        <Bar className="h-8 w-48" />
        <Bar className="h-4 w-72 mt-2.5" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkCard className="h-64" />
        <SkCard className="h-64" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkCard key={i} className="h-48" />
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Strategies header-right action placeholders. Handed to
 * `<PageGuard headerRight={...}>` so they stay inline with the title.
 */
export function StrategiesHeaderRightSkeleton() {
  return (
    <>
      <Bar className="h-7 w-28 rounded-md" />
      <Bar
        className="h-7 w-32 rounded-md"
        style={{ background: "var(--rule-softer)" }}
      />
    </>
  );
}

/**
 * Strategies skeleton — PageGuard `bare` fallback variant: tab row + sub-tab
 * pills + search/filter row + strategy card grid (no header — the hydrated
 * chrome owns it).
 */
export function StrategiesSkeleton() {
  return (
    <PfSkel className="space-y-6">
      {/* Tab row */}
      <div
        className="flex gap-1"
        style={{ borderBottom: "2px solid var(--rule-soft)" }}
      >
        {[24, 20, 24, 24, 28, 24].map((w, i) => (
          <Bar
            key={i}
            className="h-8 rounded-t-md"
            style={{ width: `${w * 4}px` }}
          />
        ))}
      </div>

      {/* Sub-tab pills */}
      <div className="flex gap-2 flex-wrap">
        {[40, 56, 80, 56, 56, 96, 56, 56].map((w, i) => (
          <Bar key={i} className="h-6 rounded-md" style={{ width: `${w}px` }} />
        ))}
      </div>

      {/* Search + chips + sort */}
      <div className="flex items-center gap-2 flex-wrap">
        <Bar className="h-9 flex-1 min-w-[220px] rounded-md" />
        <Bar className="h-7 w-16 rounded-md" />
        <Bar
          className="h-7 w-20 rounded-md"
          style={{ background: "var(--rule-softer)" }}
        />
        <Bar className="h-7 w-16 rounded-md" />
        <Bar className="h-9 w-24 rounded-md ml-auto" />
      </div>

      {/* Strategy cards */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {Array.from({ length: 9 }).map((_, i) => (
          <SkCard key={i} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <Bar className="h-4 w-3/5" />
              <Bar
                className="h-4 w-16 rounded-md"
                style={{ background: "var(--rule-softer)" }}
              />
            </div>
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-4/5" />
            <div className="grid grid-cols-3 gap-x-3 gap-y-2.5 mt-4">
              {Array.from({ length: 6 }).map((_, j) => (
                <div key={j} className="space-y-1.5">
                  <Bar className="h-2 w-10" />
                  <Bar className="h-3 w-12" />
                </div>
              ))}
            </div>
            <Bar
              className="h-16 w-full rounded-md mt-2"
              style={{ background: "var(--rule-softer)" }}
            />
          </SkCard>
        ))}
      </div>
    </PfSkel>
  );
}

/**
 * Generic page body for routes that had NO `loading.tsx` at all (MONEY-1256).
 *
 * The sidebar is rendered PER PAGE, not by the root layout — deliberately, for
 * a measured reason (`Sidebar.tsx`: one mount fires 19 middleware
 * invocations, so hoisting it made cold loads far worse). The consequence is
 * that a route without a `loading.tsx` shows NOTHING while the server responds:
 * no sidebar, no skeleton, just the root layout's topbar over an empty page.
 *
 * This is deliberately generic rather than a per-page mirror. The bug is the
 * chrome disappearing, and `PageLoadingWrapper` supplies that; a skeleton
 * pretending to match a layout it does not track would go stale silently and
 * be worse than an honest neutral block.
 */
export function GenericPageSkeleton() {
  return (
    <div className="space-y-4">
      <SectionTitleSkeleton width="w-56" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="pf-card" style={{ padding: 16 }}>
            <Bar className="h-4 w-3/5 mb-2" />
            <Bar className="h-3 w-full mb-1.5" />
            <Bar className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
