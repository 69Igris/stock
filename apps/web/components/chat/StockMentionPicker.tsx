"use client";

/**
 * StockMentionPicker - 5 tabs:
 *   Recent · Stocks · Funds · Brokers · Commands
 *
 * Brokers tab delegates to BrokerAccountsList (the same component used
 * by the "+" popover's Connectors view), so the two surfaces stay
 * pixel-identical: per-platform card with logo + "+ Add", status pills,
 * 3-dot menu (Resync / Reconnect / Delete), and "Link a new broker"
 * dashed CTA at the bottom. Clicking a row mentions that broker so the
 * chat scopes its holdings / trades context to that account.
 *
 * Stocks + Funds keep the rich-search backend (dedup'd, price>0).
 * Funds combines MF + ETF rows in a single tab.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Input } from "@usemoney/ui/input";
import {
  ArrowUpDown,
  AtSign,
  BarChart3,
  Briefcase,
  CloudUpload,
  Database,
  FileSpreadsheet,
  FileText,
  Flame,
  FolderOpen,
  HelpCircle,
  Landmark,
  Loader2,
  PieChart,
  Receipt,
  Search,
  Shield,
  Slash,
  Star,
  Trash2,
  TrendingUp,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  searchCommands,
  type SlashCommand,
  type SlashCommandCategory,
} from "@/lib/chat/slash-commands";
import {
  richSearchInstrumentsAction,
  type RichSearchStockResult,
  type RichSearchMfResult,
} from "@/lib/actions/discover";
import BrokerAccountsList, {
  type BrokerAccountRow,
} from "./brokers/BrokerAccountsList";

// ── Exchange badge color map ──────────────────────────────────────
// Distinct colors per exchange / instrument type so users can scan at a glance.
const EXCHANGE_COLOR: Record<string, string> = {
  NSE: "var(--emerald)",
  BSE: "var(--pop-3)",
  MF: "var(--pop-5)",
  ETF: "var(--pop-1)",
};
// AA-contrast text variants for the same exchange palette (used where the
// color is applied as text rather than as a border/fill).
const EXCHANGE_TEXT_COLOR: Record<string, string> = {
  NSE: "var(--emerald-text)",
  BSE: "var(--pop-3-text)",
  MF: "var(--pop-5-text)",
  ETF: "var(--pop-1-text)",
};
function exchangeColor(exchange: string): string {
  return EXCHANGE_COLOR[exchange.toUpperCase()] ?? "var(--ink-3)";
}
function exchangeTextColor(exchange: string): string {
  return EXCHANGE_TEXT_COLOR[exchange.toUpperCase()] ?? "var(--ink-3)";
}

const MENTION_ICON_MAP: Record<string, LucideIcon> = {
  PieChart,
  Briefcase,
  TrendingUp,
  ArrowUpDown,
  Landmark,
  FileText,
  Flame,
  Search,
  BarChart3,
  Shield,
  Receipt,
  FolderOpen,
  FileSpreadsheet,
  Upload,
  CloudUpload,
  HelpCircle,
  Trash2,
};

const MENTION_CATEGORY_COLOR: Record<SlashCommandCategory, string> = {
  portfolio: "var(--emerald)",
  trading: "var(--emerald)",
  research: "var(--pop-5)",
  tools: "var(--pop-3)",
  utility: "var(--ink-3)",
};

// ── Types ──────────────────────────────────────────────────────────

// De-shadowed (MONEY-620): the recents store + tab-cycle live in the React-free
// stock-mention-logic.ts so they can be unit-tested. Types + helpers are
// imported and re-exported here so existing importers keep their path.
import {
  loadRecents as loadRecentsFromStorage,
  pushRecent as pushRecentToStorage,
  cycleTab,
  RECENTS_CAP,
  type MentionedSymbol,
  type PickerTab,
} from "./stock-mention-logic";

export type { MentionedSymbol };

interface StockMentionPickerProps {
  visible: boolean;
  onSelect: (item: MentionedSymbol) => void;
  onClose: () => void;
  /** Query text typed after @ in the main textarea */
  externalQuery?: string;
  /** Optional command-select callback (Commands tab) */
  onCommandSelect?: (cmd: SlashCommand) => void;
  /**
   * Initial tab to open on. The toolbar `@` chip opens with `stocks`;
   * the toolbar `/` chip opens with `commands`. Honoured each time the
   * picker becomes visible.
   */
  initialTab?: PickerTab;
  /**
   * Filters the visible tabs:
   *   - "mention" (default) - Recent / Stocks / Funds / Brokers
   *     (Commands hidden - slash commands have their own entry point)
   *   - "command" - Commands tab only (everything else hidden so the
   *     top bar reads clean when the user opens via `/`)
   */
  mode?: "mention" | "command";
  /**
   * Hide the Brokers tab. Used by the instrument-only flows (chat "Analyse a
   * stock/fund" chip, the action-block "Wrong stock" picker) where scoping to a
   * broker account makes no sense — only Recent / Stocks / Funds are relevant.
   */
  hideBrokers?: boolean;
}

const MAX_STOCKS = 5;
const MAX_MF = 4;
const MAX_ETF = 4;

/**
 * MONEY-1123: debounce for the picker's OWN search input. The `@`-in-textarea
 * path (the `externalQuery` effect below) has always been debounced at 350ms;
 * typing directly in the picker fired `runSearch` synchronously on every
 * keystroke, so "RELIANCE" cost 8 server-action round trips instead of 1.
 * Same value so both entry points behave identically.
 */
const SEARCH_DEBOUNCE_MS = 350;

// PickerTab + the recents helpers now live in stock-mention-logic.ts;
// re-exported (imported above) so existing importers keep their path.
export type { PickerTab };

// Component-local wrappers bind the recents helpers to the browser's
// localStorage (the logic module accepts an injectable Storage for tests).
const loadRecents = (): MentionedSymbol[] => loadRecentsFromStorage();
export const pushRecent = (item: MentionedSymbol): void =>
  pushRecentToStorage(item);

/** Colored exchange/type badge for instrument rows. */
function ExchangeBadge({ label }: { label: string }) {
  const color = exchangeColor(label);
  const textColor = exchangeTextColor(label);
  return (
    <span
      className="mono shrink-0 ml-2"
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: "1px 6px",
        borderRadius: 5,
        color: textColor,
        border: `1.5px solid ${color}`,
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────

// Unified row shape rendered by Stocks + Funds branches. Differs from
// the underlying RichSearchStockResult / RichSearchMfResult so the
// renderer doesn't need to branch on which call returned the row.
type RichRow = {
  key: string;
  symbol: string;
  name: string;
  exchange: string;
  type: MentionedSymbol["type"];
};

export default function StockMentionPicker({
  visible,
  onSelect,
  onClose,
  externalQuery,
  onCommandSelect,
  initialTab,
  mode = "mention",
  hideBrokers = false,
}: StockMentionPickerProps) {
  // Tabs visible for the active mode - keeps the top bar clean.
  const visibleTabIds: PickerTab[] = useMemo(() => {
    if (mode === "command") return ["commands"];
    return hideBrokers
      ? ["recent", "stocks", "funds"]
      : ["recent", "stocks", "funds", "brokers"];
  }, [mode, hideBrokers]);

  // Initial tab honors the explicit prop, otherwise the first tab of
  // the active mode.
  const defaultTab: PickerTab =
    initialTab && visibleTabIds.includes(initialTab)
      ? initialTab
      : visibleTabIds[0]!;
  const [activeTab, setActiveTab] = useState<PickerTab>(defaultTab);
  // Re-honor `initialTab` only on the open transition (visible
  // false→true). If we re-honor on every effect run, the user can't
  // change tabs - clicking Brokers fires `setActiveTab("brokers")`,
  // the effect re-runs, sees `initialTab === "stocks"`, and snaps
  // back to Stocks. The ref guards against that loop.
  const lastVisibleRef = useRef(visible);
  useEffect(() => {
    const wasVisible = lastVisibleRef.current;
    lastVisibleRef.current = visible;
    if (!visible) return;
    // Only on a fresh open: honor initialTab + clamp to visible set.
    if (!wasVisible) {
      if (initialTab && visibleTabIds.includes(initialTab)) {
        setActiveTab(initialTab);
      } else if (!visibleTabIds.includes(activeTab)) {
        setActiveTab(visibleTabIds[0]!);
      }
      return;
    }
    // While already open: only correct if the active tab fell out of
    // the visible set (e.g. mode prop changed mid-open).
    if (!visibleTabIds.includes(activeTab)) {
      setActiveTab(visibleTabIds[0]!);
    }
  }, [visible, initialTab, visibleTabIds, activeTab]);
  const [searchInput, setSearchInput] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recents, setRecents] = useState<MentionedSymbol[]>([]);
  const [richRows, setRichRows] = useState<RichRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Request-ID guard so a slow earlier search can't overwrite a newer
  // one (same pattern as the "+" popover's InstrumentsView).
  const reqIdRef = useRef(0);
  // MONEY-1123: pending debounce for the picker's own input.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSearchDebounce = useCallback(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
  }, []);

  const searchableTab = activeTab === "stocks" || activeTab === "funds";

  // Slash commands filtered by current query (Commands tab)
  const commandResults = useMemo(() => {
    if (activeTab !== "commands") return [];
    const trimmed = searchInput.trim().replace(/^\//, "");
    return searchCommands(trimmed).slice(0, 8);
  }, [activeTab, searchInput]);

  // Backend fetch - switches between richSearchInstruments(stocks) and
  // richSearchInstruments(mfs). Funds tab combines MFs + ETFs by issuing
  // both calls in parallel and merging.
  const runSearch = useCallback(
    async (q: string) => {
      if (!searchableTab) return;
      const myReq = ++reqIdRef.current;
      setIsLoading(true);
      try {
        if (activeTab === "stocks") {
          const res = await richSearchInstrumentsAction({
            query: q,
            kind: "stocks",
            limit: 8,
          });
          if (myReq !== reqIdRef.current) return;
          const rows: RichRow[] = (res.data?.stocks ?? []).map(
            (s: RichSearchStockResult) => ({
              key: `${s.symbol}::${s.exchange}`,
              symbol: s.symbol,
              name: s.name,
              exchange: s.exchange,
              type: "stock",
            })
          );
          setRichRows(rows);
        } else {
          // Funds tab - MF + ETF in parallel, merged by AUM/marketCap.
          const [mfRes, etfRes] = await Promise.all([
            richSearchInstrumentsAction({ query: q, kind: "mfs", limit: 6 }),
            richSearchInstrumentsAction({ query: q, kind: "etfs", limit: 4 }),
          ]);
          if (myReq !== reqIdRef.current) return;
          const mfRows: RichRow[] = (mfRes.data?.mfs ?? []).map(
            (m: RichSearchMfResult) => ({
              key: `mf::${m.schemeCode}`,
              symbol: m.schemeCode,
              name: m.schemeName,
              exchange: "MF",
              type: "mf",
            })
          );
          const etfRows: RichRow[] = (etfRes.data?.etfs ?? []).map(
            (e: RichSearchStockResult) => ({
              key: `etf::${e.symbol}::${e.exchange}`,
              symbol: e.symbol,
              name: e.name,
              exchange: e.exchange,
              type: "etf",
            })
          );
          setRichRows([...mfRows, ...etfRows].slice(0, 8));
        }
      } finally {
        if (myReq === reqIdRef.current) setIsLoading(false);
      }
    },
    [activeTab, searchableTab]
  );

  const visibleResults = useMemo(() => {
    if (activeTab === "recent") return recents;
    if (activeTab === "commands") return commandResults;
    // Brokers tab delegates to BrokerAccountsList - click-only, no
    // keyboard nav (mirrors the popover's Connectors view).
    if (activeTab === "brokers") return [];
    return richRows;
  }, [activeTab, recents, commandResults, richRows]);

  // Refresh recents whenever picker opens. Runs on close too, so a pending
  // keystroke debounce never outlives the open/close transition.
  useEffect(() => {
    clearSearchDebounce();
    if (visible) {
      setRecents(loadRecents());
      setSearchInput("");
      setSelectedIndex(0);
      if (searchableTab) void runSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTab, richRows, recents, commandResults]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    const selected = items[selectedIndex] as HTMLElement | undefined;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Sync external query (text typed after @ in the main textarea)
  useEffect(() => {
    if (!visible || externalQuery === undefined) return;
    setSearchInput(externalQuery);
    if (externalQuery.length === 0 || !searchableTab) return;
    const timer = setTimeout(() => {
      void runSearch(externalQuery);
    }, 350);
    return () => clearTimeout(timer);
  }, [visible, externalQuery, searchableTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // MONEY-1123: debounced so a burst of keystrokes issues ONE search. The
  // request-ID guard inside `runSearch` still protects against out-of-order
  // responses; this only stops the requests from being made at all.
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      clearSearchDebounce();
      if (!searchableTab) return;
      searchDebounceRef.current = setTimeout(() => {
        searchDebounceRef.current = null;
        void runSearch(value);
      }, SEARCH_DEBOUNCE_MS);
    },
    [runSearch, searchableTab, clearSearchDebounce]
  );

  // Refire search when the user switches tabs (Recents + Commands are
  // local - only Stocks/Funds need the backend roundtrip). Any keystroke
  // debounce still pending belongs to the PREVIOUS tab (it closed over the
  // old `runSearch`), so drop it rather than letting it land here.
  useEffect(() => {
    clearSearchDebounce();
    if (visible && searchableTab) void runSearch(searchInput);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Never leave a timer behind on unmount.
  useEffect(() => clearSearchDebounce, [clearSearchDebounce]);

  const handleRichSelect = useCallback(
    (row: RichRow) => {
      const item: MentionedSymbol = {
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange,
        type: row.type,
      };
      pushRecent(item);
      onSelect(item);
    },
    [onSelect]
  );

  const handleBrokerSelect = useCallback(
    (row: BrokerAccountRow) => {
      // Symbol = compact "@LabelNickname" tag inserted in the message.
      // brokerConnectionId rides along so a future chat-route handler
      // can scope holdings/trades to this account specifically.
      const item: MentionedSymbol = {
        symbol: `${row.platformLabel.replace(/\s+/g, "")}-${row.nickname.replace(/\s+/g, "")}`,
        name: `${row.platformLabel} · ${row.nickname}`,
        exchange: row.platformLabel,
        type: "broker",
        brokerConnectionId: row.id,
      };
      pushRecent(item);
      onSelect(item);
    },
    [onSelect]
  );

  const handleRecentSelect = useCallback(
    (item: MentionedSymbol) => {
      pushRecent(item);
      onSelect(item);
    },
    [onSelect]
  );

  const handleCommandPick = useCallback(
    (cmd: SlashCommand) => {
      onCommandSelect?.(cmd);
      onClose();
    },
    [onCommandSelect, onClose]
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!visible) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const len = visibleResults.length;
      if (e.key === "ArrowDown" && len > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev < len - 1 ? prev + 1 : 0));
        return;
      }
      if (e.key === "ArrowUp" && len > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : len - 1));
        return;
      }
      if (e.key === "Tab" && len > 0) {
        e.preventDefault();
        if (visibleTabIds.length <= 1) return;
        setActiveTab(
          cycleTab(activeTab, e.shiftKey ? "prev" : "next", visibleTabIds)
        );
        return;
      }
      if (e.key === "Enter" && len > 0) {
        e.preventDefault();
        const sel = visibleResults[selectedIndex];
        if (!sel) return;
        if (activeTab === "recent") handleRecentSelect(sel as MentionedSymbol);
        else if (activeTab === "commands")
          handleCommandPick(sel as SlashCommand);
        else handleRichSelect(sel as RichRow);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    visible,
    onClose,
    visibleResults,
    visibleTabIds,
    selectedIndex,
    activeTab,
    handleRecentSelect,
    handleCommandPick,
    handleRichSelect,
  ]);

  // Click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        visible &&
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose]);

  if (!visible) return null;

  const ALL_TABS: Array<{
    id: PickerTab;
    label: string;
    icon: typeof Search;
  }> = [
    { id: "recent", label: "Recent", icon: Star },
    { id: "stocks", label: "Stocks", icon: TrendingUp },
    { id: "funds", label: "Funds", icon: PieChart },
    { id: "brokers", label: "Brokers", icon: Database },
    { id: "commands", label: "Commands", icon: Slash },
  ];
  const TABS = ALL_TABS.filter((t) => visibleTabIds.includes(t.id));

  const placeholder =
    activeTab === "stocks"
      ? "Search NSE / BSE…"
      : activeTab === "funds"
        ? "Search MFs · ETFs…"
        : activeTab === "commands"
          ? "Search slash commands…"
          : activeTab === "brokers"
            ? "Filter linked brokers…"
            : "Search recents…";

  return (
    <div
      ref={containerRef}
      className="pf-card pf-app w-full mb-2 overflow-hidden"
      style={{ padding: 0, borderRadius: 14, boxShadow: "var(--shadow-hard)" }}
      data-testid="mention-picker"
    >
      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-2 py-2"
        style={{
          background: "var(--paper-2)",
          borderBottom: "1.5px solid var(--ink)",
        }}
      >
        {TABS.map((t) => {
          const Ic = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              data-testid={`tab-${t.id}`}
              data-active={active ? "true" : "false"}
              className="mono inline-flex items-center gap-1.5"
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.04em",
                padding: "6px 11px",
                borderRadius: 7,
                cursor: "pointer",
                transition: "background 0.1s, color 0.1s",
                background: active ? "var(--ink)" : "transparent",
                color: active ? "var(--paper)" : "var(--ink-3)",
              }}
            >
              <Ic className="w-3 h-3" />
              <span>{t.label}</span>
            </button>
          );
        })}
        <span
          className="mono ml-auto hidden sm:inline pr-1"
          style={{
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--ink-3)",
          }}
        >
          ↑↓ navigate · ⏎ insert · ⇥ next tab
        </span>
      </div>

      {/* Search input - hidden on Recents (no search) */}
      {activeTab !== "recent" && (
        <div
          className="p-2.5"
          style={{ borderBottom: "1.5px dashed var(--rule-soft)" }}
        >
          <div
            className="flex items-center gap-2"
            style={{
              padding: "8px 12px",
              border: "1.5px solid var(--ink)",
              borderRadius: 9,
              background: "var(--paper)",
            }}
          >
            <Search
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: "var(--ink-3)" }}
            />
            <Input
              ref={inputRef}
              placeholder={placeholder}
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-auto border-0 bg-transparent p-0 text-sm text-[var(--ink)] placeholder:text-[var(--ink-3)] focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
        </div>
      )}

      {/* Results */}
      <div ref={listRef} className="max-h-64 overflow-y-auto">
        {/* Recents */}
        {activeTab === "recent" &&
          (recents.length === 0 ? (
            <p className="text-xs text-[var(--ink-3)] text-center py-6">
              <AtSign className="w-3.5 h-3.5 mx-auto mb-1.5 opacity-60" />
              No recent picks yet - choose a stock or fund to see it here.
            </p>
          ) : (
            recents.map((r, idx) => (
              <button
                type="button"
                key={`${r.symbol}:${r.exchange}:${idx}`}
                onClick={() => handleRecentSelect(r)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className="w-full text-left flex items-center justify-between text-sm"
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px dashed var(--rule-soft)",
                  background:
                    idx === selectedIndex ? "var(--emerald-bg)" : "transparent",
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="mono shrink-0"
                    style={{ fontWeight: 800, color: "var(--ink)" }}
                  >
                    {r.symbol}
                  </span>
                  <span
                    className="truncate"
                    style={{ fontSize: 12, color: "var(--ink-3)" }}
                  >
                    {r.name.replace(/^"|"$/g, "")}
                  </span>
                </div>
                <ExchangeBadge
                  label={r.type === "stock" ? r.exchange : r.type.toUpperCase()}
                />
              </button>
            ))
          ))}

        {/* Stocks + Funds */}
        {(activeTab === "stocks" || activeTab === "funds") && (
          <>
            {isLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2
                  className="h-4 w-4 animate-spin"
                  style={{ color: "var(--ink-3)" }}
                />
              </div>
            ) : richRows.length === 0 ? (
              <p
                className="text-center py-4"
                style={{ fontSize: 12, color: "var(--ink-3)" }}
              >
                No results found
              </p>
            ) : (
              richRows.map((row, idx) => (
                <button
                  type="button"
                  key={row.key}
                  onClick={() => handleRichSelect(row)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className="w-full text-left flex items-center justify-between text-sm"
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px dashed var(--rule-soft)",
                    background:
                      idx === selectedIndex
                        ? "var(--emerald-bg)"
                        : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="mono shrink-0"
                      style={{ fontWeight: 800, color: "var(--ink)" }}
                    >
                      {row.symbol}
                    </span>
                    <span
                      className="truncate"
                      style={{ fontSize: 12, color: "var(--ink-3)" }}
                    >
                      {row.name.replace(/^"|"$/g, "")}
                    </span>
                  </div>
                  <ExchangeBadge
                    label={
                      row.type === "stock"
                        ? row.exchange
                        : row.type.toUpperCase()
                    }
                  />
                </button>
              ))
            )}
          </>
        )}

        {/* Commands — playful icon-square rows matching SlashCommandMenu */}
        {activeTab === "commands" &&
          (commandResults.length === 0 ? (
            <div
              className="flex flex-col items-center gap-1 py-6"
              style={{ color: "var(--ink-3)" }}
            >
              <Slash className="h-4 w-4 opacity-50" />
              <p style={{ fontSize: 12 }}>No commands found</p>
            </div>
          ) : (
            <div style={{ padding: "6px 8px" }}>
              {commandResults.map((cmd, idx) => {
                const Icon = MENTION_ICON_MAP[cmd.icon] ?? HelpCircle;
                const accent = MENTION_CATEGORY_COLOR[cmd.category];
                const isSelected = idx === selectedIndex;
                return (
                  <button
                    type="button"
                    key={cmd.name}
                    onClick={() => handleCommandPick(cmd)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className="w-full text-left flex items-center gap-3"
                    style={{
                      padding: "7px 10px",
                      borderRadius: 9,
                      background: isSelected ? "var(--paper-2)" : "transparent",
                      border: isSelected
                        ? "1.5px solid var(--rule-soft)"
                        : "1.5px solid transparent",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Playful icon square */}
                    <span
                      className="shrink-0 grid place-items-center"
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        background: accent,
                        color: "var(--paper)",
                        border: "1.5px solid var(--ink)",
                        transform: "rotate(-3deg)",
                        boxShadow: "2px 2px 0 var(--ink)",
                      }}
                      aria-hidden
                    >
                      <Icon size={12} strokeWidth={2.5} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <span
                        className="mono"
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--ink)",
                        }}
                      >
                        /{cmd.name}
                      </span>
                      <div
                        className="truncate"
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          marginTop: 1,
                        }}
                      >
                        {cmd.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}

        {/* Brokers - shared component matches the "+" popover Connectors
            view exactly: per-platform card with broker logo, "+ Add",
            status pills, 3-dot menu (Resync / Reconnect / Delete), and
            "Link a new broker" CTA at the bottom. */}
        {activeTab === "brokers" && (
          <BrokerAccountsList
            filter={searchInput}
            onSelectAccount={handleBrokerSelect}
          />
        )}
      </div>

      {/* Foot - context line */}
      <div
        className="mono flex items-center justify-between px-3.5 py-2"
        style={{
          fontSize: 10,
          letterSpacing: "0.04em",
          borderTop: "1.5px solid var(--ink)",
          background: "var(--paper-2)",
          color: "var(--ink-3)",
        }}
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{
              background: "var(--emerald)",
              boxShadow: "0 0 6px var(--emerald)",
            }}
          />
          {activeTab === "commands"
            ? "slash registry · live"
            : activeTab === "brokers"
              ? "your accounts · live"
              : "NSE & BSE · live"}
        </span>
        <span>
          {activeTab === "stocks"
            ? "5,200+ symbols"
            : activeTab === "funds"
              ? "1,800+ schemes"
              : activeTab === "brokers"
                ? "linked accounts"
                : activeTab === "commands"
                  ? `${commandResults.length} commands`
                  : `${recents.length}/${RECENTS_CAP} recents`}
        </span>
      </div>
    </div>
  );
}

// ── Helper: render mentioned symbols as badges ──────────────────

export function MentionBadges({
  mentions,
  onRemove,
}: {
  mentions: MentionedSymbol[];
  onRemove: (symbol: string) => void;
}) {
  if (mentions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-2">
      <span
        className="mono"
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "1px",
          color: "var(--ink-3)",
          marginRight: 2,
        }}
      >
        CONTEXT
      </span>
      {mentions.map((m) => (
        <span
          key={m.symbol}
          className="pf-pill blue"
          style={{ fontSize: 10.5, padding: "2px 8px" }}
        >
          @{m.symbol}
          <button
            type="button"
            onClick={() => onRemove(m.symbol)}
            className="ml-0.5"
            aria-label={`Remove ${m.symbol}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

// ── Limits checker ──────────────────────────────────────────────

const MAX_BROKER = 1; // Only one broker scope per message - extra slots add noise.

export function canAddMention(
  mentions: MentionedSymbol[],
  type: MentionedSymbol["type"]
): boolean {
  const count = mentions.filter((m) => m.type === type).length;
  switch (type) {
    case "stock":
      return count < MAX_STOCKS;
    case "mf":
      return count < MAX_MF;
    case "etf":
      return count < MAX_ETF;
    case "broker":
      return count < MAX_BROKER;
  }
}
