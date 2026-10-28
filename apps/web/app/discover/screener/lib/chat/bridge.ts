import type { Dispatch, SetStateAction } from "react";
import type { ScreenerMode } from "@/components/screener/ModeTabs";
import type {
  ScreenFilters,
  MfScreenFilters,
  EtfScreenFilters,
  ScreenResult,
  MfScreenResult,
  EtfScreenResult,
} from "@/lib/actions/screener";
import type { ScreenerChatActions } from "./actions";
import type { ScreenerSnapshot } from "./systemPrompt";
import { FIELDS_BY_MODE } from "./filters";

/* =====================================================================
   Screener chat — bridge builders  (MONEY-1078)
   ---------------------------------------------------------------------
   Pure functions that turn the screener page's live state into (a) the
   `ScreenerChatActions` implementation the tool executor calls and (b)
   the `ScreenerSnapshot` fed to the system prompt.

   Extracted from `client.tsx` (mirroring fire/lib/chat/bridge.ts) so
   both halves are unit-testable without React: tests build a plain
   `ScreenerLive` object and assert what the actions write back.

   The `live` argument is passed as a GETTER so a bridge built once (via
   useMemo) always reads the current render's state — no stale closures.
   ===================================================================== */

/** Everything the chat needs to read/write on the screener page. */
export interface ScreenerLive {
  mode: ScreenerMode;
  query: string;
  stocksFilters: ScreenFilters;
  mfFilters: MfScreenFilters;
  etfFilters: EtfScreenFilters;
  stocksSort: string;
  mfSort: string;
  etfSort: string;
  stocksRows: readonly ScreenResult[];
  mfRows: readonly MfScreenResult[];
  etfRows: readonly EtfScreenResult[];
  stocksTotal: number;
  mfTotal: number;
  etfTotal: number;
  sectorOptions: readonly { name: string; count: number }[];
  mfCategories: readonly { name: string; count: number }[];
  mfAmcs: readonly string[];

  setMode: (mode: ScreenerMode) => void;
  setQuery: (query: string) => void;
  // Filter setters take the FULL Dispatch type (not just a value) because
  // the chat writes them with functional updaters — see writeFilters.
  setStocksFilters: Dispatch<SetStateAction<ScreenFilters>>;
  setMfFilters: Dispatch<SetStateAction<MfScreenFilters>>;
  setEtfFilters: Dispatch<SetStateAction<EtfScreenFilters>>;
  setStocksSort: (s: string) => void;
  setMfSort: (s: string) => void;
  setEtfSort: (s: string) => void;
  /** True while the active mode's results are being refetched. */
  isFetching: boolean;
  /**
   * Why the active mode's last refetch failed, or null when the rows on
   * screen match the active filters.
   *
   * `isFetching` alone is NOT enough for the chat: on a failed refetch the
   * loading flag clears normally, so the turn loop resumes and snapshots a
   * screen whose `filters` are FRESH but whose `resultTotal` / `topResults`
   * are from before the change. The model then quotes the pre-filter count
   * as the answer. Surfacing the error lets the snapshot mark the results
   * stale so the assistant reports the failure instead of certifying it.
   */
  fetchError: string | null;
  /**
   * Bumped every time a refetch SETTLES. `isFetching` is false both before
   * the effect starts and after it finishes, so a waiter cannot tell the two
   * apart; waiting for this counter to change is unambiguous.
   */
  fetchGeneration: number;
}

/** How many result rows / vocabulary options ride along in the prompt. */
export const SNAPSHOT_ROW_CAP = 10;
export const SNAPSHOT_OPTION_CAP = 40;

/** Drop undefined/null/"" so the prompt shows only the ACTIVE filters. */
function activeOnly(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, v]) => v !== undefined && v !== null && v !== ""
    )
  );
}

export function buildScreenerActions(
  getLive: () => ScreenerLive
): ScreenerChatActions {
  /**
   * Merge/unset against whichever mode's filter bag was addressed.
   *
   * CRITICAL — the update MUST go through React's functional updater form.
   * One tool call can write twice (merge + unset for null-valued keys) and
   * one batched hop can write several times, all synchronously. `liveRef`
   * only refreshes on render, so reading `live.stocksFilters` for `prev`
   * would hand every write in the batch the SAME pre-batch bag and the
   * last write would clobber the rest (a "clearFilters then setFilters"
   * pair would silently undo the clear). The functional form makes React
   * thread each update through the latest queued state instead.
   */
  const writeFilters = (
    mode: ScreenerMode,
    update: (prev: Record<string, unknown>) => Record<string, unknown>
  ) => {
    const live = getLive();
    const asUpdater = <T>(prev: T) =>
      update(prev as unknown as Record<string, unknown>) as unknown as T;
    if (mode === "stocks") {
      live.setStocksFilters(asUpdater<ScreenFilters>);
    } else if (mode === "mf") {
      live.setMfFilters(asUpdater<MfScreenFilters>);
    } else {
      live.setEtfFilters(asUpdater<EtfScreenFilters>);
    }
  };

  return {
    switchMode(mode) {
      getLive().setMode(mode);
    },
    mergeFilters(mode, filters) {
      writeFilters(mode, (prev) => ({ ...prev, ...filters }));
    },
    unsetFilters(mode, keys) {
      writeFilters(mode, (prev) => {
        const next = { ...prev };
        for (const k of keys) delete next[k];
        return next;
      });
    },
    clearFilters(mode) {
      // Replace with an empty bag rather than deleting known keys, so any
      // filter the chat doesn't know about is cleared too.
      writeFilters(mode, () => ({}));
    },
    setQuery(query) {
      getLive().setQuery(query);
    },
    setSort(mode, sort) {
      const live = getLive();
      if (mode === "stocks") live.setStocksSort(sort);
      else if (mode === "mf") live.setMfSort(sort);
      else live.setEtfSort(sort);
    },
  };
}

/** Compact the active mode's rows for the prompt (bounded, typed). */
function topRows(live: ScreenerLive): ScreenerSnapshot["topResults"] {
  if (live.mode === "stocks") {
    return live.stocksRows.slice(0, SNAPSHOT_ROW_CAP).map((r) => ({
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      ltp: r.ltp,
      pe: r.pe,
      roe: r.roe,
      marketCap: r.marketCap,
    }));
  }
  if (live.mode === "mf") {
    return live.mfRows.slice(0, SNAPSHOT_ROW_CAP).map((r) => ({
      schemeName: r.schemeName,
      amcName: r.amcName,
      category: r.category,
      nav: r.nav,
      returns3Y: r.returns3Y,
      expenseRatio: r.expenseRatio,
      aum: r.aum,
    }));
  }
  return live.etfRows.slice(0, SNAPSHOT_ROW_CAP).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    assetClass: r.assetClass,
    ltp: r.ltp,
    returns1Y: r.returns1Y,
    expenseRatio: r.expenseRatio,
    aum: r.aum,
  }));
}

export function buildScreenerSnapshot(live: ScreenerLive): ScreenerSnapshot {
  const filters =
    live.mode === "stocks"
      ? (live.stocksFilters as unknown as Record<string, unknown>)
      : live.mode === "mf"
        ? (live.mfFilters as unknown as Record<string, unknown>)
        : (live.etfFilters as unknown as Record<string, unknown>);

  const sort =
    live.mode === "stocks"
      ? live.stocksSort
      : live.mode === "mf"
        ? live.mfSort
        : live.etfSort;

  const resultTotal =
    live.mode === "stocks"
      ? live.stocksTotal
      : live.mode === "mf"
        ? live.mfTotal
        : live.etfTotal;

  // Only ship the vocabulary the ACTIVE mode can actually filter on —
  // sector lists are meaningless on the funds tabs and vice versa.
  const available: ScreenerSnapshot["available"] = {};
  if (live.mode === "stocks") {
    available.sectors = live.sectorOptions
      .slice(0, SNAPSHOT_OPTION_CAP)
      .map((s) => s.name);
  } else if (live.mode === "mf") {
    available.mfCategories = live.mfCategories
      .slice(0, SNAPSHOT_OPTION_CAP)
      .map((c) => c.name);
    available.mfAmcs = live.mfAmcs.slice(0, SNAPSHOT_OPTION_CAP) as string[];
  }

  // Strip keys outside the chat vocabulary (e.g. `limit`, `amcAny`) so the
  // model is never shown a filter it has no tool to change. `Object.hasOwn`
  // (not `in`) so inherited names like "constructor" / "toString" can't
  // pass as vocabulary.
  const vocab = FIELDS_BY_MODE[live.mode];
  const visible = Object.fromEntries(
    Object.entries(activeOnly(filters)).filter(([k]) => Object.hasOwn(vocab, k))
  );

  return {
    mode: live.mode,
    query: live.query,
    sort,
    filters: visible,
    resultTotal,
    // Mark the counts/rows stale when the last refetch failed. `filters`
    // above is already the NEW state (it is written optimistically), so
    // without this the model sees fresh criteria beside pre-change results
    // and reports the old count as the answer.
    ...(live.fetchError ? { resultsStale: { reason: live.fetchError } } : {}),
    topResults: topRows(live),
    available,
  };
}
