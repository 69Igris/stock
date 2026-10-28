"use client";

/**
 * Section tabs for the stock detail page (v3.1):
 * Summary · Financials · Peers · News & events.
 *
 * Tabs are URL-synced via `?tab=` so deep links land on the right
 * section. The default tab is "summary" if the param is missing or
 * unknown.
 *
 * The tab values are intentionally kebab-case in the URL:
 *   summary | financials | peers | ownership | events | derivatives | actions | news
 */

import {
  Sparkles,
  BarChart3,
  Users,
  PieChart,
  Newspaper,
  CalendarClock,
  Activity,
  ArrowLeftRight,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * MONEY-1147 — "actions" is its own tab, split out of "news".
 *
 * Corporate actions and news were never merged into one list; they were two
 * sibling cards stacked inside a single "News & events" tab. They are
 * different kinds of thing and belong apart: corporate actions (dividends,
 * splits, bonuses, record dates) are structured, dated facts that a holder may
 * need to act on, while news is unstructured third-party commentary.
 *
 * `parseStockTab` below is the URL contract, so any value added here must be
 * added there in the same change or the deep link silently falls back to
 * "summary".
 */
export type StockTab =
  | "summary"
  | "financials"
  | "peers"
  | "ownership"
  | "events"
  | "derivatives"
  | "actions"
  | "news";

export const STOCK_TAB_DEFS: Array<{
  id: StockTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: "summary", label: "Summary", icon: Sparkles },
  { id: "financials", label: "Financials", icon: BarChart3 },
  { id: "peers", label: "Peers", icon: Users },
  { id: "ownership", label: "Ownership", icon: PieChart },
  // MONEY-1205 — "Events", split out of Ownership.
  //
  // Ownership answers "who owns this, and how much" — the shareholding pattern
  // and the schemes holding it. Those are STANDING POSITIONS, restated each
  // quarter. Insider & promoter activity and bulk & block deals answer a
  // different question: "what did significant holders just DO". They are dated,
  // backward-looking disclosures about other people's trades, and stacking them
  // under a heading that promises a position table made a reader scroll past
  // two event feeds to reach the number they came for.
  //
  // It is NOT merged into "Corporate actions", which is the other dated tab:
  // corporate actions are SCHEDULED and forward-looking (a record date the
  // holder may need to act on before it arrives), while these are reports of
  // something that already happened and that the reader cannot act on. Same
  // shape, opposite tense — and only one of them belongs on a to-do list.
  { id: "events", label: "Events", icon: ArrowLeftRight },
  // MONEY-1204 / 14c.3 — F&O. ONE new tab rather than one per data-engine
  // section: the other eight sections land inside existing tabs (delivery in
  // Summary, shareholding/insider/deals/funds in Ownership, the source badge in
  // Financials, flags in the header). Nine new top-level tabs would make a
  // fifteen-tab strip, which is a worse page than the data is worth.
  //
  // The entry is UNCONDITIONAL here and gets filtered at render time by
  // `visibleStockTabs` below. This list is a registry, not a policy: it cannot
  // know whether a given symbol has derivatives, because only
  // `StockDerivativesTab`'s own fetch can answer that.
  { id: "derivatives", label: "F&O", icon: Activity },
  { id: "actions", label: "Corporate actions", icon: CalendarClock },
  { id: "news", label: "News", icon: Newspaper },
];

// ── MONEY-1204 — the F&O tab's visibility rule ──────────────────────────────
//
// `StockDerivativesTab` self-gates and renders null for a cash-only name, but
// the TAB stayed up regardless: the user clicked "F&O", watched a skeleton, and
// got an empty panel. The component has always exposed `onFnoResolved` so the
// parent could drop the tab; nothing passed it.
//
// The answer is TRI-state. Before the section's fetch resolves it is UNKNOWN,
// which is not "no" — and whichever way a boolean collapses it, one of the two
// possible answers makes the tab flash in or out on every load.
//
// The rule lives here, as a pure function, rather than inline in the page:
// there are TWO tab registries (this one and the page's own `PF_STOCK_TABS`),
// and a policy written into one of them is a policy the other silently lacks.

/** What the page knows so far about a symbol's derivatives coverage. */
export type FnoTabState = "unknown" | "yes" | "no";

/**
 * Whether the F&O tab belongs in the strip.
 *
 * UNKNOWN hides it. The two failure modes are not symmetric: showing-then-
 * hiding can pull the tab out from under a click and then has to auto-navigate
 * the user off it, while hiding-then-showing only ever ADDS a tab, which nobody
 * is standing on. It is also right on first paint for most of the universe —
 * NSE lists ~200 F&O underlyings against a few thousand cash-only names.
 *
 * The exception is the deep link. `?tab=derivatives` SELECTS the tab, and a
 * selected tab missing from the strip is a broken page, so an active
 * `derivatives` keeps it visible until the answer arrives. If the answer is
 * "no", {@link tabAfterFnoHidden} moves the user first.
 *
 * KNOWN CONSEQUENCE, chosen rather than stumbled into: `StockDerivativesTab`
 * fires `onFnoResolved` only on a SUCCESSFUL read, so a failed one leaves the
 * state at "unknown" and the tab hidden for that page load — an F&O name whose
 * section errored shows no F&O tab instead of a tab onto a red panel. It
 * self-heals on reload, the deep link still reaches the error, and the
 * alternative (assume coverage on failure) reinstates the dead tab for every
 * cash-only stock the moment anything upstream hiccups. Closing it properly
 * means the section reporting its failure as well as its answer, which is a
 * change to `StockDerivativesTab`'s own contract.
 */
export function isFnoTabVisible(fno: FnoTabState, active: StockTab): boolean {
  if (fno === "yes") return true;
  if (fno === "no") return false;
  return active === "derivatives";
}

/**
 * Filter a tab registry against the resolved F&O state.
 *
 * Generic over `{ id: StockTab }` so BOTH registries — `STOCK_TAB_DEFS` and the
 * page's `PF_STOCK_TABS`, which carry different labels and icon shapes — apply
 * the identical rule.
 */
export function visibleStockTabs<T extends { id: StockTab }>(
  defs: readonly T[],
  fno: FnoTabState,
  active: StockTab
): T[] {
  const show = isFnoTabVisible(fno, active);
  return defs.filter((t) => t.id !== "derivatives" || show);
}

/**
 * Where to send a user who is standing on the F&O tab when it resolves hidden.
 *
 * Returns null when there is nothing to do — the common case, and the reason
 * this is not just "always go to summary": a stock resolving to cash-only must
 * not yank a reader off the Financials tab they were reading.
 */
export function tabAfterFnoHidden(active: StockTab): StockTab | null {
  return active === "derivatives" ? "summary" : null;
}

interface StockSectionTabsProps {
  active: StockTab;
  onChange: (next: StockTab) => void;
  /**
   * Resolved F&O state. Defaults to "yes" so an existing caller keeps today's
   * behaviour; pass the real state to get the gate.
   */
  fno?: FnoTabState;
}

export function StockSectionTabs({
  active,
  onChange,
  fno = "yes",
}: StockSectionTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Stock detail sections"
      className="flex items-center gap-1 border-b border-[var(--border-default)] -mx-1 px-1 mb-5 overflow-x-auto"
    >
      {visibleStockTabs(STOCK_TAB_DEFS, fno, active).map((t) => {
        const Icon = t.icon;
        const selected = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.id)}
            className={`relative inline-flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-semibold transition-colors cursor-pointer shrink-0 ${
              selected
                ? "text-emerald-400"
                : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{t.label}</span>
            {selected && (
              <span
                aria-hidden
                className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-emerald-400"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function parseStockTab(raw: string | null | undefined): StockTab {
  if (
    raw === "financials" ||
    raw === "peers" ||
    raw === "ownership" ||
    raw === "events" ||
    raw === "derivatives" ||
    raw === "actions" ||
    raw === "news"
  )
    return raw;
  return "summary";
}

export default StockSectionTabs;
