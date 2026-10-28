"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import { normalizeSectorSlug } from "@/lib/sectors/slug";
import { getAllSectorNames } from "@usemoney/core/sector-taxonomy";
import { isPublicShellRoute } from "@/components/Sidebar";
import { sidenavConfig, bottomNavItems } from "@/components/Sidebar";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import {
  Activity,
  BarChart2,
  Brain,
  Briefcase,
  Flame,
  LineChart,
  MessageSquarePlus,
  Search,
  TrendingUp,
  // Trophy unused — Learning "Take a Quiz" command hidden per request
  // (re-enable to restore).
  // Trophy,
  X,
  Zap,
} from "lucide-react";

// ============== CONTEXT ==============

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue>({
  open: false,
  setOpen: () => {},
});

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

// ============== PROVIDER ==============

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Public marketing/content surfaces (landing, blog, glossary, docs,
  // legal, etc.) own their own ⌘K behaviour — the authed CommandPalette
  // listing in-app routes (Dashboard, Tradebook, Holdings…) must not
  // leak there. Same registry already drives TopBar/Sidebar mounting.
  const onPublic = isPublicShellRoute(pathname);

  // Global Cmd+K / Ctrl+K shortcut — wired only on authed routes.
  useEffect(() => {
    if (onPublic) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onPublic]);

  return (
    <CommandPaletteContext.Provider value={{ open, setOpen }}>
      {children}
      {!onPublic && <CommandPaletteDialog open={open} onOpenChange={setOpen} />}
    </CommandPaletteContext.Provider>
  );
}

// ============== SHARED TYPES ==============

// Icon renderer accepting both LucideIcon (size/strokeWidth) and
// generic React components (className only).
type AnyIcon = React.ComponentType<{ className?: string }>;

interface SearchResult {
  symbol: string;
  name: string;
  exchange?: string;
  type?: string;
}

interface FlatItem {
  id: string;
  label: string;
  sub?: string;
  icon: AnyIcon;
  iconColor?: string; // CSS color value for the icon tile bg
  kbd?: string[];
  onSelect: () => void;
}

interface FlatGroup {
  label: string;
  items: FlatItem[];
}

// ============== QUICK ACTIONS ==============

interface QuickAction {
  label: string;
  icon: AnyIcon;
  href: string;
}

const quickActions: QuickAction[] = [
  { label: "Start New Analysis", icon: Brain, href: "/analysis" },
  // Paper Trading entry removed 2026-05-28 per product decision.
  { label: "Create FIRE Scenario", icon: Flame, href: "/fire" },
  { label: "Discover Stocks", icon: TrendingUp, href: "/discover" },
  { label: "Generate AI Strategy", icon: Zap, href: "/strategies" },
  // Learning hidden per request — re-enable to restore.
  // { label: "Take a Quiz", icon: Trophy, href: "/quizzes" },
  {
    label: "Submit Feedback",
    icon: MessageSquarePlus,
    href: "/settings?tab=feedback",
  },
  {
    label: "View My Feedback",
    icon: MessageSquarePlus,
    href: "/settings?tab=feedback",
  },
];

// ============== POPULAR SECTORS ==============

// EXACTLY SIX ENTRIES, because `pickPop` is `index % POP_COLORS.length` and only
// six colour tokens exist (--pop-1..5 plus --emerald, per playful-app.css). Any
// seventh entry silently repeats a colour.
//
// Reordering only moved that problem: with eight entries "Real Estate" stopped
// sharing Financial Services' token and "Industrials" inherited it instead —
// still two sectors rendering identically in a list whose whole purpose is quick
// visual discrimination. This is a curated shortlist, so matching it to the
// palette's capacity is the honest fix; adding design tokens is not this
// ticket's call.
const POPULAR_SECTORS = [
  "Information Technology",
  "Financial Services",
  "Healthcare",
  "Energy",
  "FMCG",
  "Real Estate",
];

// Pop-color palette — cycles across the pf-* system pop tokens
const POP_COLORS = [
  "var(--pop-3)",
  "var(--pop-2)",
  "var(--pop-5)",
  "var(--pop-1)",
  "var(--pop-4)",
  "var(--emerald)",
];

function pickPop(index: number): string {
  return POP_COLORS[index % POP_COLORS.length];
}

// ============== DIALOG ==============

function CommandPaletteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // FF guards: "Take a Quiz" gated on /quizzes (same gating as the sidebar
  // Quiz entry). Hidden while flags resolve to avoid the optimistic-true
  // flash described in Sidebar.tsx.
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const visibleQuickActions = quickActions.filter((q) => {
    if (q.href === "/quizzes") return !flagsLoading && flags["/quizzes"];
    return true;
  });

  const navigate = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router]
  );

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSearchResults([]);
      setActiveIndex(0);
    } else {
      // Focus input when opened
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Debounced search
  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(0);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim() || value.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        // NO `includeUs` — India only, deliberately (MONEY-980 review).
        //
        // Two independent reasons, either of which is sufficient. (1) The
        // mapping below narrows the payload to `{symbol, name, exchange, type}`
        // and DROPS `market` / `listingStatus` / `listingEndDate`, so a
        // delisted 2008 listing would be indistinguishable from a live one.
        // (2) `onSelect` routes to `/stock/{symbol}?exchange={exchange}`, and
        // `app/stock/[symbol]/page.tsx` resolves against
        // `prisma.instrumentMapping` only — a NYSE ticker misses, the explicit
        // `exchange` suppresses the any-venue retry, and the synthesised
        // fallback stamps `yahooSymbol: "DOW.NS"`. The page would render
        // Indian market data under a US company's name.
        //
        // Making this a US-aware surface means widening BOTH — the row shape
        // here and the resolution there. Until then the route's default (US off
        // unless `includeUs=true`) is what keeps it honest.
        const res = await fetch(
          `/api/market/search?q=${encodeURIComponent(value)}&limit=12`
        );
        if (res.ok) {
          const data = await res.json();
          if (data.results) {
            setSearchResults(
              data.results.map(
                (r: Record<string, unknown>) =>
                  ({
                    symbol: (r.symbol as string) || "",
                    name: (r.name as string) || "",
                    exchange: (r.exchange as string) || undefined,
                    type: (r.type as string) || undefined,
                  }) satisfies SearchResult
              )
            );
          }
        }
      } catch {
        // Ignore search errors
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, []);

  // Build flat groups for keyboard navigation
  const groups: FlatGroup[] = React.useMemo(() => {
    if (query) {
      // Search mode: group by type.
      //
      // MONEY-1205: ETFs used to be bucketed WITH stocks here, which put them
      // under a "Stocks" heading and dropped them through to the `/stock/`
      // branch below. They are funds and get their own group and their own
      // route.
      const stockResults = searchResults.filter(
        (r) => !r.type || r.type === "EQUITY"
      );
      const etfResults = searchResults.filter((r) => r.type === "ETF");
      const mfResults = searchResults.filter((r) => r.type === "MF");
      const indexResults = searchResults.filter((r) => r.type === "INDEX");

      const makeResultItem = (
        r: SearchResult,
        Icon: AnyIcon,
        idx: number
      ): FlatItem => ({
        id: `${r.symbol}-${r.exchange}-${idx}`,
        label: r.type === "MF" ? r.name : r.symbol,
        sub: r.type === "MF" ? r.exchange : r.name,
        icon: Icon,
        iconColor: pickPop(idx),
        onSelect: () => {
          navigate(
            instrumentDetailHref({
              symbol: r.symbol,
              exchange: r.exchange,
              type: r.type,
            })
          );
        },
      });

      const out: FlatGroup[] = [];
      if (stockResults.length > 0) {
        out.push({
          label: "Stocks",
          items: stockResults.map((r, i) => makeResultItem(r, Briefcase, i)),
        });
      }
      if (etfResults.length > 0) {
        out.push({
          label: "ETFs",
          items: etfResults.map((r, i) =>
            makeResultItem(r, LineChart, stockResults.length + i)
          ),
        });
      }
      if (mfResults.length > 0) {
        out.push({
          label: "Mutual Funds",
          items: mfResults.map((r, i) =>
            makeResultItem(
              r,
              BarChart2,
              stockResults.length + etfResults.length + i
            )
          ),
        });
      }
      if (indexResults.length > 0) {
        out.push({
          label: "Indices",
          items: indexResults.map((r, i) =>
            makeResultItem(
              r,
              Activity,
              stockResults.length + etfResults.length + mfResults.length + i
            )
          ),
        });
      }
      return out;
    }

    // Default mode: nav sections + sectors + quick actions
    const out: FlatGroup[] = [];
    let colorOffset = 0;

    sidenavConfig.forEach((section) => {
      const items: FlatItem[] = [];
      section.items.forEach((item) => {
        // Mirror Sidebar.tsx gating — drop items/children whose FF is
        // false or while flags resolve. Without this, gated routes
        // (Learning / Sage Tutor / Quiz, etc.) show in ⌘K even when
        // hidden from the sidebar.
        if (item.featureFlag && (flagsLoading || !flags[item.featureFlag])) {
          return;
        }
        const Icon = item.icon;
        items.push({
          id: item.href,
          label: item.label,
          icon: Icon,
          iconColor: pickPop(colorOffset++),
          onSelect: () => navigate(item.href),
        });
        item.children?.forEach((child) => {
          if (
            child.featureFlag &&
            (flagsLoading || !flags[child.featureFlag])
          ) {
            return;
          }
          items.push({
            id: child.href,
            label: child.label,
            icon: child.icon,
            iconColor: pickPop(colorOffset++),
            onSelect: () => navigate(child.href),
          });
        });
      });
      if (items.length === 0) return;
      out.push({ label: section.label || "Overview", items });
    });

    // Account
    colorOffset = 0;
    out.push({
      label: "Account",
      items: bottomNavItems.map((item, i) => ({
        id: item.href,
        label: item.label,
        icon: item.icon,
        iconColor: pickPop(i + 2),
        onSelect: () => navigate(item.href),
      })),
    });

    // Sectors
    //
    // MONEY-1093: the shortlist is what you BROWSE; the full taxonomy is what
    // you can SEARCH.
    //
    // `POPULAR_SECTORS` is capped at six because `pickPop` cycles a six-token
    // colour palette, and adding design tokens was correctly judged out of
    // scope. But it was also the ONLY sector affordance here, so capping it
    // meant a user typing "industrials" or "consumer" into a SEARCH box got
    // nothing back — for sectors that are canonical, have a live page, and were
    // reachable before this branch narrowed the list to fit Real Estate in.
    //
    // Six is a sensible default list; it is not a sensible limit on what is
    // findable. With a query present, every canonical sector matches, and the
    // colour cycle simply repeats past the sixth — a repeated hue in a
    // query-filtered list of one or two hits costs nothing, whereas a
    // repeated hue across the whole default list was the actual objection.
    const sectorsToOffer =
      query.trim().length > 0 ? getAllSectorNames() : POPULAR_SECTORS;

    out.push({
      label: "Browse Sectors",
      items: sectorsToOffer.map((sector, i) => ({
        id: `sector-${sector}`,
        label: sector,
        icon: Briefcase,
        iconColor: pickPop(i),
        onSelect: () =>
          // /discover/markets is the canonical markets+sectors page and takes
          // a SLUG. This was the only sector entry point in the app that
          // bypassed the slug module and passed a display NAME to the legacy
          // /discover page — it worked, by raw string equality, but it landed
          // somewhere different from every other sector affordance.
          navigate(
            `/discover/markets?sector=${encodeURIComponent(
              normalizeSectorSlug(sector)
            )}`
          ),
      })),
    });

    // Quick actions
    out.push({
      label: "Quick Actions",
      items: visibleQuickActions.map((action) => ({
        id: action.href + action.label,
        label: action.label,
        icon: action.icon,
        iconColor: "var(--emerald)",
        onSelect: () => navigate(action.href),
      })),
    });

    return out;
  }, [
    query,
    searchResults,
    navigate,
    visibleQuickActions,
    flags,
    flagsLoading,
  ]);

  // Flat list of all items for arrow navigation
  const allItems = React.useMemo(
    () => groups.flatMap((g) => g.items),
    [groups]
  );

  // Keyboard navigation inside the palette
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, allItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        allItems[activeIndex]?.onSelect();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, allItems, activeIndex, onOpenChange]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-cmd-index="${activeIndex}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const totalItems = allItems.length;

  return (
    <>
      {/* Scrim */}
      <div
        className="pf-cmd-scrim"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />

      {/* Card */}
      <div
        className="pf-cmd-card"
        role="dialog"
        aria-modal
        aria-label="Command palette"
      >
        {/* Search tile header */}
        <div className="pf-cmd-search-row">
          <div className="pf-cmd-search-icon">
            <Search size={14} strokeWidth={2.25} />
          </div>
          <input
            ref={inputRef}
            className="pf-cmd-input"
            placeholder="Search stocks, mutual funds, indices…"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="pf-cmd-esc mono">esc</span>
          <button
            className="pf-cmd-close"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X size={12} strokeWidth={2.25} />
          </button>
        </div>

        {/* Results */}
        <div className="pf-cmd-list" ref={listRef}>
          {isSearching && <div className="pf-cmd-empty mono">Searching…</div>}
          {!isSearching && query.length >= 2 && totalItems === 0 && (
            <div className="pf-cmd-empty">No results found.</div>
          )}

          {groups.map((group) => (
            <div key={group.label} className="pf-cmd-group">
              <div className="pf-cmd-group-label mono">{group.label}</div>
              <div className="pf-cmd-group-items">
                {group.items.map((item) => {
                  const flatIdx = allItems.indexOf(item);
                  const isActive = flatIdx === activeIndex;
                  // Runtime icons are all lucide; widen for size/strokeWidth render props.
                  const Icon = item.icon as React.ComponentType<{
                    className?: string;
                    size?: number;
                    strokeWidth?: number;
                  }>;
                  return (
                    <button
                      key={item.id}
                      data-cmd-index={flatIdx}
                      className={`pf-cmd-item${isActive ? " is-active" : ""}`}
                      onMouseEnter={() => setActiveIndex(flatIdx)}
                      onClick={() => item.onSelect()}
                      tabIndex={-1}
                    >
                      {/* Icon tile */}
                      <span
                        className="pf-cmd-item-ic"
                        style={{ background: item.iconColor }}
                      >
                        <Icon size={12} strokeWidth={2.25} />
                      </span>

                      {/* Label + sub */}
                      <span className="pf-cmd-item-body">
                        <span className="pf-cmd-item-label">{item.label}</span>
                        {item.sub && (
                          <span className="pf-cmd-item-sub ser">
                            {item.sub}
                          </span>
                        )}
                      </span>

                      {/* Keyboard hint */}
                      {item.kbd && item.kbd.length > 0 && (
                        <span className="pf-cmd-item-kbds">
                          {item.kbd.map((k, ki) => (
                            <span key={ki} className="pf-cmd-kbd mono">
                              {k}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer legend */}
        <div className="pf-cmd-footer">
          <div className="pf-cmd-legend">
            <span className="pf-cmd-legend-item">
              <span className="pf-cmd-kbd mono">↑↓</span>
              <span className="ser">navigate</span>
            </span>
            <span className="pf-cmd-legend-item">
              <span className="pf-cmd-kbd mono">↵</span>
              <span className="ser">open</span>
            </span>
            <span className="pf-cmd-legend-item">
              <span className="pf-cmd-kbd mono">esc</span>
              <span className="ser">close</span>
            </span>
          </div>
          <span className="pf-cmd-brand ser">
            search powered by ✦ StockSage
          </span>
        </div>
      </div>

      <style>{`
        /* ── Command Palette overlay ──────────────────────────────── */
        .pf-cmd-scrim {
          position: fixed;
          inset: 0;
          z-index: 9998;
          background: rgba(15, 13, 8, 0.55);
          backdrop-filter: blur(2px);
        }
        html.dark .pf-cmd-scrim {
          background: rgba(0, 0, 0, 0.65);
        }

        /* Centered card. NB: no rotate() on this text-bearing panel —
           rotating the whole container forces every glyph onto a
           non-pixel-aligned raster and reads as "blurry". The playful
           tilt lives on the decorative icon tiles instead. */
        .pf-cmd-card {
          position: fixed;
          top: 12%;
          left: 50%;
          z-index: 9999;
          /* Round the centering translate to whole pixels so an
             even/odd-width box never lands on a half-pixel (subpixel
             text blur). */
          transform: translateX(-50%);
          width: min(580px, calc(100vw - 24px));
          max-height: min(540px, calc(100vh - 90px));
          background: var(--paper);
          border: 2px solid var(--ink);
          border-radius: 14px;
          box-shadow: 8px 8px 0 var(--ink);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: "Inter", system-ui, sans-serif;
          color: var(--ink);
        }
        html.dark .pf-cmd-card {
          box-shadow: 8px 8px 0 #000;
        }

        /* Search row ────────────────────────────────────────────── */
        .pf-cmd-search-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 18px;
          border-bottom: 2px solid var(--ink);
          background: var(--paper);
          flex-shrink: 0;
        }

        /* Emerald rotated icon tile */
        .pf-cmd-search-icon {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: var(--emerald);
          border: 1.25px solid var(--ink);
          display: grid;
          place-items: center;
          transform: rotate(-4deg);
          flex-shrink: 0;
          color: var(--paper);
        }

        .pf-cmd-input {
          flex: 1;
          background: transparent;
          border: 0;
          outline: none;
          font-size: 15px;
          font-weight: 600;
          color: var(--ink);
          font-family: inherit;
          min-width: 0;
        }
        .pf-cmd-input::placeholder {
          color: var(--ink-4);
          font-weight: 400;
        }

        .pf-cmd-esc {
          font-size: 10px;
          padding: 3px 7px;
          border: 1.25px solid var(--rule-soft);
          border-radius: 5px;
          color: var(--ink-3);
          flex-shrink: 0;
        }

        .pf-cmd-close {
          width: 28px;
          height: 28px;
          border: 1.5px solid var(--ink);
          background: var(--paper);
          border-radius: 7px;
          display: grid;
          place-items: center;
          cursor: pointer;
          color: var(--ink);
          flex-shrink: 0;
          transition: box-shadow 0.1s, transform 0.1s;
        }
        .pf-cmd-close:hover {
          transform: translate(-1px, -1px);
          box-shadow: 2px 2px 0 var(--ink);
        }

        /* Results list ─────────────────────────────────────────── */
        .pf-cmd-list {
          flex: 1;
          overflow-y: auto;
          padding: 10px;
          min-height: 0;
          scrollbar-width: none;
        }
        .pf-cmd-list::-webkit-scrollbar {
          display: none;
        }

        .pf-cmd-empty {
          padding: 24px 12px;
          text-align: center;
          font-size: 13px;
          color: var(--ink-3);
        }

        /* Group ───────────────────────────────────────────────── */
        .pf-cmd-group {
          margin-bottom: 8px;
        }
        .pf-cmd-group:last-child {
          margin-bottom: 0;
        }

        .pf-cmd-group-label {
          padding: 8px 10px 6px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 1.3px;
          color: var(--ink-3);
          text-transform: uppercase;
        }

        .pf-cmd-group-items {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        /* Individual result row ────────────────────────────────── */
        .pf-cmd-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 8px;
          background: transparent;
          border: 1.5px solid transparent;
          font-family: inherit;
          cursor: pointer;
          text-align: left;
          color: var(--ink);
          width: 100%;
          transition: background 0.08s, border-color 0.08s, box-shadow 0.08s, transform 0.08s;
        }
        .pf-cmd-item:hover,
        .pf-cmd-item.is-active {
          background: var(--pop-2);
          border-color: var(--ink);
          box-shadow: 2px 2px 0 var(--ink);
          /* Whole-pixel lift only — no rotate() here: rotating the
             active row blurs its label text on hover/selection. */
          transform: translate(-1px, -1px);
          color: #1d1d1b;
        }
        html.dark .pf-cmd-item:hover,
        html.dark .pf-cmd-item.is-active {
          /* pop-2 in dark is #fcd34d — keeps dark-ink text readable */
          color: #1d1d1b;
        }

        /* Pop-colored icon tile inside each row */
        .pf-cmd-item-ic {
          width: 26px;
          height: 26px;
          border-radius: 6px;
          border: 1.25px solid var(--ink);
          display: grid;
          place-items: center;
          transform: rotate(-3deg);
          flex-shrink: 0;
          color: var(--paper);
        }
        .pf-cmd-item.is-active .pf-cmd-item-ic,
        .pf-cmd-item:hover .pf-cmd-item-ic {
          border-color: #1d1d1b;
        }

        .pf-cmd-item-body {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        .pf-cmd-item-label {
          font-size: 13px;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pf-cmd-item-sub {
          font-size: 11.5px;
          color: var(--ink-3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-top: 1px;
        }
        .pf-cmd-item.is-active .pf-cmd-item-sub,
        .pf-cmd-item:hover .pf-cmd-item-sub {
          color: rgba(29, 29, 27, 0.65);
        }

        /* Keyboard hint badges */
        .pf-cmd-item-kbds {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }

        .pf-cmd-kbd {
          font-size: 10px;
          padding: 2px 6px;
          border: 1.25px solid var(--ink);
          border-radius: 5px;
          background: var(--paper);
          color: var(--ink);
          font-weight: 700;
          min-width: 18px;
          text-align: center;
          display: inline-block;
        }
        .pf-cmd-item.is-active .pf-cmd-kbd,
        .pf-cmd-item:hover .pf-cmd-kbd {
          background: var(--paper);
          border-color: var(--ink);
          color: var(--ink);
        }

        /* Footer legend ─────────────────────────────────────────── */
        .pf-cmd-footer {
          padding: 10px 18px;
          border-top: 1.5px dashed var(--rule-soft);
          background: var(--paper-2);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-shrink: 0;
        }

        .pf-cmd-legend {
          display: flex;
          gap: 14px;
        }

        .pf-cmd-legend-item {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 10.5px;
          color: var(--ink-3);
        }
        .pf-cmd-legend-item .pf-cmd-kbd {
          border-color: var(--rule-soft);
          background: transparent;
          color: var(--ink-2);
        }

        .pf-cmd-brand {
          font-size: 12px;
          color: var(--ink-3);
          white-space: nowrap;
        }

        /* Mobile breakpoint — full-width, anchored near top */
        @media (max-width: 640px) {
          .pf-cmd-card {
            top: 64px;
            width: calc(100% - 24px);
            max-height: calc(100vh - 90px);
            border-radius: 12px;
          }
          .pf-cmd-legend-item .ser,
          .pf-cmd-brand {
            display: none;
          }
        }
      `}</style>
    </>
  );
}
