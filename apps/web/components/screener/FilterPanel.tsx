"use client";

/**
 * FilterPanel (playful-redesign MONEY-483).
 *
 * Two display modes, responsive:
 *
 * 1. Desktop (md+): inline card panel below the sticky chips bar.
 *    Header has active-count + "Reset all" + "Hide filters" links.
 *    Layout is identical to the original sidebar — vertically stacked
 *    filter cards, no width limit.
 *
 * 2. Mobile (< md): bottom sheet per the MobileScreenerSheet design.
 *    Drag handle pill at top, sticky header with match-count pill +
 *    Reset, scrollable body with all filter cards, sticky footer with
 *    "Save screen" + "Apply · show N →" CTAs.
 *
 * The component does NOT manage open state — that lives on the parent.
 */

import { X } from "lucide-react";
import type { ReactNode } from "react";

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
  /** Header label, e.g. "Filters" / "Fund filters". */
  title?: string;
  /** Active filter count — shown in header counter + mobile match line. */
  activeCount?: number;
  /** Live match count for the mobile "Apply · show N →" footer CTA.
   *  When undefined the footer shows "Apply filters →" generically. */
  matchCount?: number;
  /** When set, renders a "Reset all" link. */
  onResetAll?: () => void;
  /** Optional secondary CTA in the mobile footer (e.g. "Save screen"). */
  onSaveScreen?: () => void;
  /** Optional pre-children block (e.g. UniverseSection). Sits above filter cards. */
  pre?: ReactNode;
  /** Optional post-children block (e.g. SuggestedChips). Sits below. */
  post?: ReactNode;
  /** The filter cards. */
  children: ReactNode;
}

export function FilterPanel({
  open,
  onClose,
  title = "Filters",
  activeCount = 0,
  matchCount,
  onResetAll,
  onSaveScreen,
  pre,
  post,
  children,
}: FilterPanelProps) {
  if (!open) return null;
  return (
    <>
      {/* Desktop: inline panel, hidden on mobile */}
      <DesktopPanel
        title={title}
        activeCount={activeCount}
        onResetAll={onResetAll}
        onClose={onClose}
        pre={pre}
        post={post}
      >
        {children}
      </DesktopPanel>

      {/* Mobile: bottom sheet, hidden on desktop */}
      <MobileSheet
        title={title}
        activeCount={activeCount}
        matchCount={matchCount}
        onResetAll={onResetAll}
        onClose={onClose}
        onSaveScreen={onSaveScreen}
        pre={pre}
        post={post}
      >
        {children}
      </MobileSheet>
    </>
  );
}

// ── Desktop panel ──────────────────────────────────────────────────────────

function DesktopPanel({
  title,
  activeCount,
  onResetAll,
  onClose,
  pre,
  post,
  children,
}: {
  title: string;
  activeCount: number;
  onResetAll?: () => void;
  onClose: () => void;
  pre?: ReactNode;
  post?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="hidden md:block pf-card mb-4" style={{ padding: 18 }}>
      <div
        className="flex items-center mb-3 pb-2.5"
        style={{ borderBottom: "1.5px solid var(--ink)" }}
      >
        <span className="mono text-[10.5px] tracking-[1.5px] text-[var(--ink-2)] font-bold uppercase">
          {title}
          {!onResetAll && activeCount > 0 ? (
            <span className="ml-1 text-[var(--emerald-text)]">
              · {activeCount} active
            </span>
          ) : (
            ""
          )}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {onResetAll && (
            <button
              type="button"
              onClick={onResetAll}
              className="mono text-[11px] text-[var(--ink-3)] underline hover:text-[var(--emerald-text)] transition-colors cursor-pointer"
            >
              Reset all
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mono text-[11px] text-[var(--ink-3)] underline hover:text-[var(--emerald-text)] transition-colors cursor-pointer"
          >
            Hide filters
          </button>
        </div>
      </div>

      {pre && <div className="mb-3">{pre}</div>}
      <div className="space-y-2">{children}</div>
      {post && <div className="mt-3">{post}</div>}
    </div>
  );
}

// ── Mobile bottom sheet ────────────────────────────────────────────────────

function MobileSheet({
  title,
  activeCount,
  matchCount,
  onResetAll,
  onClose,
  onSaveScreen,
  pre,
  post,
  children,
}: {
  title: string;
  activeCount: number;
  matchCount?: number;
  onResetAll?: () => void;
  onClose: () => void;
  onSaveScreen?: () => void;
  pre?: ReactNode;
  post?: ReactNode;
  children: ReactNode;
}) {
  const applyLabel =
    matchCount != null
      ? `Apply · show ${matchCount.toLocaleString("en-IN")} →`
      : "Apply filters →";

  return (
    <div className="md:hidden fixed inset-0 z-50 flex items-end">
      {/* Scrim backdrop */}
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
        style={{ background: "rgba(0,0,0,0.45)" }}
      />

      {/* Sheet surface — flex column so footer is always sticky at bottom */}
      <div
        className="relative w-full flex flex-col animate-in slide-in-from-bottom duration-200"
        style={{
          maxHeight: "85vh",
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderBottom: 0,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          /* Design spec: hard offset shadow on top edge */
          boxShadow: "0 -8px 0 var(--ink)",
        }}
      >
        {/* Drag handle */}
        <div className="pt-2.5 pb-1.5 grid place-items-center shrink-0">
          <div
            style={{
              width: 50,
              height: 4,
              borderRadius: 999,
              background: "var(--ink-3)",
            }}
          />
        </div>

        {/* Sticky sheet header */}
        <div
          className="px-[18px] pb-3.5 shrink-0 flex items-end justify-between"
          style={{ borderBottom: "2px solid var(--ink)" }}
        >
          <div>
            <div
              className="font-bold text-[var(--ink)]"
              style={{ fontSize: 18, letterSpacing: -0.4 }}
            >
              {title}
            </div>
            {activeCount > 0 && (
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--emerald-text)", marginTop: 2 }}
              >
                ● {activeCount} filter{activeCount === 1 ? "" : "s"} active
              </div>
            )}
          </div>
          {onResetAll ? (
            <button
              type="button"
              onClick={onResetAll}
              className="mono cursor-pointer"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                textDecoration: "underline",
              }}
            >
              Reset
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="grid place-items-center cursor-pointer text-[var(--ink-3)] hover:text-[var(--emerald-text)] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Scrollable filter body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
          {pre && <div className="mb-4">{pre}</div>}
          <div className="space-y-3">{children}</div>
          {post && <div className="mt-4">{post}</div>}
        </div>

        {/* Sticky footer CTAs */}
        <div
          className="shrink-0 px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-3 flex gap-2"
          style={{
            borderTop: "2px solid var(--ink)",
            background: "var(--paper)",
          }}
        >
          {onSaveScreen && (
            <button
              type="button"
              onClick={onSaveScreen}
              className="pf-bf"
              style={{ flex: 1, justifyContent: "center", fontSize: 13 }}
            >
              Save screen
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="pf-bs"
            style={{
              flex: onSaveScreen ? 2 : 1,
              justifyContent: "center",
              fontSize: 13,
            }}
          >
            {applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default FilterPanel;
