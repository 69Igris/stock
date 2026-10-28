"use client";

/**
 * TradingViewAdvancedChart
 *
 * Thin React wrapper around the TradingView Advanced Charts library
 * (proprietary, v31.0.0). Loads the library + UDF datafeed adapter from
 * /public via next/script, then instantiates the widget against our
 * /api/market/udf/* backend.
 *
 * The library is iframe-free (the standalone build injects into a div) but
 * its bundle loader is sensitive to a few things - read the inline comments
 * before changing constructor options.
 *
 * Used by:
 * - apps/web/app/stock/[symbol]/client.tsx           (equity OHLCV)
 * - apps/web/app/mf/[schemeCode]/client.tsx          (MF NAV line chart)
 * - apps/web/app/paper-trading/client.tsx            (gated to Pro users)
 * - apps/web/components/chat/blocks/ChartBlockRenderer.tsx (chat embed)
 */

import { useUdfBaseUrl } from "./UdfBaseUrlProvider";
import { BarBasisBadge } from "./BarBasisBadge";
import { installMarketDataFetch } from "@/lib/market/market-data-auth";
import { useEffect, useMemo, useRef, useState, memo } from "react";
import Script from "next/script";
import { useTheme } from "next-themes";
import { cn } from "@usemoney/ui";
import DelayedDataNote from "@/components/market/DelayedDataNote";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import {
  type TvWidgetApplied,
  type TvWidgetTarget,
  dispatchWidgetUpdate,
  planWidgetUpdate,
  resolveAppliedState,
} from "./tv-widget-logic";

// ============== AMBIENT TYPES ==============

// The TradingView Advanced Charts library exposes itself on `window.TradingView`
// when loaded via the standalone script tag. The bundled UDF adapter exposes
// itself on `window.Datafeeds`. Both are loaded by this component via
// <Script> tags at runtime - they are NOT npm packages we can import.
//
// We don't import the official charting_library.d.ts here because it's
// authored as `declare module "charting_library"` (designed for `import`
// usage, not script-tag loading). Declaring a small Window augmentation
// keeps the wrapper self-contained and TypeScript-safe.
declare global {
  interface Window {
    TradingView?: {
      widget: new (options: TVWidgetOptions) => TVWidgetInstance;
    };
    Datafeeds?: {
      UDFCompatibleDatafeed: new (
        baseUrl: string,
        updateFrequency?: number,
        limitedServerResponse?: {
          maxResponseLength: number;
          ignoreInvalidResponses: boolean;
        }
      ) => unknown;
    };
  }
}

interface TVWidgetOptions {
  container: HTMLElement;
  library_path: string;
  datafeed: unknown;
  symbol: string;
  interval: string;
  locale: string;
  timezone: string;
  theme?: "Dark" | "Light";
  autosize?: boolean;
  width?: number;
  height?: number;
  fullscreen?: boolean;
  chart_type?: number; // 1 = candle, 2 = line, 3 = area, 0 = bars
  disabled_features?: string[];
  enabled_features?: string[];
  debug?: boolean;
  client_id?: string;
  user_id?: string;
}

interface TVWidgetInstance {
  remove: () => void;
  /**
   * Fires the callback SYNCHRONOUSLY when the chart is already ready
   * (`onChartReady(e){this._ready?e.call(this):this._readyHandlers.push(e)}`),
   * and `remove()` splices the pending handlers, so a queued callback for a
   * torn-down widget never runs.
   */
  onChartReady: (cb: () => void) => void;
  /**
   * MONEY-1383 (L5). `IChartingLibraryWidget.setSymbol` — takes the interval
   * as well, so a symbol switch and a resolution switch are one call. Only
   * valid after `onChartReady`: the runtime is
   * `setSymbol(e,t,i){this._innerAPI().changeSymbol(e,t,i)}`.
   */
  setSymbol: (symbol: string, interval: string, callback: () => void) => void;
  /**
   * MONEY-1383 (L5). `IChartingLibraryWidget.changeTheme`. `ThemeName` is
   * declared `"light" | "dark"` — lowercase, unlike the constructor option.
   * Returns a promise; only valid after `onChartReady`.
   */
  changeTheme: (themeName: "light" | "dark") => Promise<void>;
}

// ============== PROPS ==============

export type TVChartType = "candle" | "line";

export interface TradingViewAdvancedChartProps {
  /**
   * Symbol identifier. Accepts either combined `"NSE:TCS"` form or a bare
   * symbol - when bare, the wrapper combines it with the `exchange` prop.
   * For mutual funds pass the schemeCode and `exchange="MF"`.
   */
  symbol: string;
  /** Exchange. Defaults to NSE. Use "MF" for mutual funds. */
  exchange?: "NSE" | "BSE" | "MF";
  /**
   * The `/udf` origin to read bars from — MONEY-1468 (A3).
   *
   * Resolved SERVER-side from the `MARKET_DATA_TILES` flag
   * (`lib/market/udf-target.ts`) and passed down, because this is a client
   * component and the flag is a `PlatformConfig` row. Omitted = the legacy
   * `/api/market/udf` route, which is the safe direction.
   */
  udfBaseUrl?: string;
  /** "candle" for OHLCV (default), "line" for MFs / single-value series. */
  chartType?: TVChartType;
  /** TradingView resolution string. Defaults to "1D". */
  interval?: string;
  /**
   * Theme override. When omitted (the common case), the chart automatically
   * follows the platform theme via `next-themes`. Only pass this prop when
   * you need to force Dark or Light regardless of user preference.
   */
  theme?: "Dark" | "Light";
  /** Container height in px. The container MUST have a non-zero height. */
  height?: number;
  /** Extra TV features to disable. Always merged with the wrapper defaults. */
  disabledFeatures?: string[];
  /** Extra TV features to enable. */
  enabledFeatures?: string[];
  className?: string;
  /**
   * MONEY-566: show the "exchange-delayed data" disclaimer below the chart for
   * users without an active broker session. Defaults to true; auto-hidden for
   * `exchange="MF"` (NAV is daily, not exchange-delayed). Set false to suppress.
   */
  showDelayedDataNote?: boolean;
}

// ============== CONSTANTS ==============

// Disabled by default - drawings/layouts persistence is out of scope for v1.
const DEFAULT_DISABLED_FEATURES = [
  "use_localstorage_for_settings",
  "header_saveload",
  "study_templates",
];

// Trailing slash MANDATORY - without it the library tries to load
// "/charting_librarybundles/..." which 404s. Most common first-time error.
const LIBRARY_PATH = "/charting_library/";
const STANDALONE_SCRIPT = "/charting_library/charting_library.standalone.js";
const DATAFEED_SCRIPT = "/datafeeds/udf/dist/bundle.js";
// MONEY-1466 (A1): the Cloud Run datafeed exists and is CDN-fronted, but this
// stays pointed at the Vercel route until A3 flips it. A1 ships the service and
// the env plumbing; A3 moves the traffic once /udf/history actually returns
// bars — flipping now would point the widget at a 501.
//
// `NEXT_PUBLIC_MARKET_DATA_URL` is read rather than hardcoded so A3 is a config
// change plus a one-line default, not a code search.
/**
 * The route this chart has always used, and the DEFAULT for every caller that
 * does not pass `udfBaseUrl` — MONEY-1468 (A3).
 *
 * The cutover is a PROP rather than a constant read here because the decision
 * needs `PlatformConfig`, a Mongo row, and this is a client component. A server
 * component resolves it (`lib/market/udf-target.ts`) and passes it down, which
 * is also what lets prod be flipped — in either direction — without a deploy.
 *
 * Unthreaded callers keep the legacy route, deliberately: falling back costs
 * latency nobody notices, while pointing a chart at a service whose tiles are
 * missing answers `no_data` for every symbol and renders BLANK with no error.
 */
const UDF_BASE_URL = "/api/market/udf";
const UDF_STREAM_URL = "/api/market/udf/stream";

function chartTypeToNumber(chartType: TVChartType): number {
  return chartType === "line" ? 2 : 1;
}

function combineSymbol(symbol: string, exchange: string): string {
  // Already combined?
  if (symbol.includes(":")) return symbol;
  return `${exchange}:${symbol}`;
}

// ============== LIVE-STREAM OVERLAY ==============

/**
 * Minimal shape of the bundled UDFCompatibleDatafeed instance that we
 * monkey-patch. We only care about the two subscribeBars hooks; the
 * rest of the methods (onReady, resolveSymbol, getBars, etc.) are
 * handled internally by the UDF bundle.
 */
type TVSymbolInfo = { ticker?: string; name?: string };
type TVBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
type TVRealtimeCallback = (bar: TVBar) => void;
interface UDFDatafeedInstance {
  subscribeBars?: (
    symbolInfo: TVSymbolInfo,
    resolution: string,
    onRealtimeCallback: TVRealtimeCallback,
    subscriberUID: string,
    onResetCacheNeededCallback: () => void
  ) => void;
  unsubscribeBars?: (subscriberUID: string) => void;
}

/**
 * Install a custom `subscribeBars` / `unsubscribeBars` on an instance
 * of the bundled UDFCompatibleDatafeed. This is the client end of the
 * MONEY-123 Part B live stream - it bridges TV's datafeed callback to
 * our SSE endpoint `/api/market/udf/stream`.
 *
 * Flow per subscription:
 *   1. TV calls subscribeBars(symbolInfo, resolution, cb, uid, _)
 *   2. We open an EventSource to /api/market/udf/stream?symbol=…&resolution=…
 *   3. Parse each SSE `data:` event, convert bar.time (unix sec) to
 *      TV's expected unix ms, and invoke cb(bar)
 *   4. TV calls unsubscribeBars(uid) on chart unmount/symbol switch
 *   5. We close the EventSource bound to that uid
 *
 * Failure handling:
 *   - If the SSE returns 4xx (e.g. 409 no broker creds), EventSource
 *     fires `onerror` and we close it. No bars are delivered, and
 *     TradingView's internal polling continues against /history.
 *     The chart still works - it just refreshes via polling instead
 *     of streaming. This is the pre-MONEY-123 v1 behavior.
 */
/**
 * A base URL whose `/config` this origin will actually answer.
 *
 * ## ONE MISSED /udf/config POISONS THE CHART FOR THE WHOLE PAGE LOAD
 *
 * TradingView's vendored `UDFCompatibleDatafeed` reads `/config` ONCE at
 * construction and maps ANY failure — a network blip, a CORS hiccup, a body it
 * cannot parse — to `null`. It then silently adopts a config HARDCODED in the
 * bundle whose `supports_group_request` is TRUE, builds a `SymbolsStorage`, and
 * fetches `/udf/symbol_info?group=NYSE|FOREX|AMEX` — three exchanges from a
 * default list that has nothing to do with us. This origin serves no
 * `symbol_info`, the storage fails to init, and every `resolveSymbol` rejects
 * "invalid symbol" until the page is reloaded.
 *
 * Measured in the browser on a broken page, in this exact order:
 *
 *     /udf/config                   (failed)
 *     /udf/symbol_info?group=NYSE
 *     /udf/symbol_info?group=FOREX
 *     /udf/symbol_info?group=AMEX
 *     Series symbol resolve error: invalid symbol
 *
 * THIS IS WHY THE CHART COMES AND GOES. When `/config` gets through the chart
 * is fine; when it does not, that page load is dead — and nothing on the server
 * can see it, because the request that failed never arrived. The service's own
 * smoke suite passes 30/30 throughout.
 *
 * RETRIED BEFORE IT IS BELIEVED. A single transient failure must not demote a
 * user to the legacy route for their whole session, so the probe is attempted
 * three times before it gives up — and only then falls back to the same-origin
 * route this file already documents as the safe direction, which needs no CORS,
 * no preflight and no token.
 *
 * A same-origin base is returned unchecked: `/api/market/udf` is served by the
 * app itself, and probing it would only delay the fallback path.
 */
export async function usableDatafeedBase(base: string): Promise<string> {
  if (!base.startsWith("http")) return base;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/config`, { credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cfg = (await res.json()) as { supports_group_request?: boolean };
      // A config that ASKS for group requests is as unusable as one that never
      // arrived — this origin serves no `/udf/symbol_info`. Checked rather than
      // assumed, because that is precisely the shape the broken state produces.
      if (cfg.supports_group_request) {
        throw new Error("config demands symbol_info, which this origin lacks");
      }
      return base;
    } catch (err) {
      if (attempt === 2) {
        console.warn(
          `[TVAdvancedChart] ${base}/config unusable after 3 tries (${String(err)}). ` +
            `Using ${UDF_BASE_URL}. The chart still works — it is reading the ` +
            `legacy route rather than the market-data service.`
        );
        return UDF_BASE_URL;
      }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  return UDF_BASE_URL;
}

function installLiveStream(
  datafeed: UDFDatafeedInstance,
  realtimeAllowed: { readonly current: boolean }
): void {
  const connections = new Map<string, EventSource>();

  datafeed.subscribeBars = (
    symbolInfo,
    resolution,
    onRealtimeCallback,
    subscriberUID
  ) => {
    // Live streaming is a BROKER entitlement (MONEY-566 commitment): only a
    // user with an ACTIVE broker session may receive real-time bars; everyone
    // else stays on the exchange-delayed /history polling that the
    // DelayedDataNote below the chart discloses. Ref-read at subscribe time so
    // broker-status resolution never tears the widget down. (The server
    // double-gates the stream endpoint; this also saves the wasted SSE
    // attempt + console error for every broker-less chart.)
    if (!realtimeAllowed.current) return;

    const ticker = symbolInfo.ticker ?? symbolInfo.name;
    if (!ticker) {
      console.warn(
        "[TVAdvancedChart] subscribeBars: missing symbolInfo.ticker"
      );
      return;
    }

    // Close any stale connection registered under this UID (shouldn't
    // happen in normal flow but covers StrictMode double-subscribe).
    const stale = connections.get(subscriberUID);
    if (stale) stale.close();

    const url = `${UDF_STREAM_URL}?symbol=${encodeURIComponent(ticker)}&resolution=${encodeURIComponent(resolution)}`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | {
              type: "bar";
              bar: {
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volume?: number;
              };
              isNew?: boolean;
            }
          | { type: "error"; message: string }
          | { type: "closed" };

        if (payload.type === "bar") {
          // SSE sends unix seconds; TradingView expects unix milliseconds.
          onRealtimeCallback({
            time: payload.bar.time * 1000,
            open: payload.bar.open,
            high: payload.bar.high,
            low: payload.bar.low,
            close: payload.bar.close,
            volume: payload.bar.volume ?? 0,
          });
        } else if (payload.type === "error") {
          console.warn(
            `[TVAdvancedChart] live stream error for ${ticker} ${resolution}:`,
            payload.message
          );
        }
        // "closed" is purely informational - the server-side hub is
        // telling us it's shutting the stream down. EventSource's own
        // onerror will fire right after; cleanup happens there.
      } catch (err) {
        console.warn(
          "[TVAdvancedChart] malformed SSE payload:",
          event.data,
          err
        );
      }
    };

    es.onerror = () => {
      // Any error - auth failure, network drop, 4xx - closes the
      // stream. TradingView will continue to poll /history for
      // updates via its default polling loop, so the chart stays
      // functional, just not "live."
      es.close();
      connections.delete(subscriberUID);
    };

    connections.set(subscriberUID, es);
  };

  datafeed.unsubscribeBars = (subscriberUID) => {
    const es = connections.get(subscriberUID);
    if (es) {
      es.close();
      connections.delete(subscriberUID);
    }
  };
}

// ============== COMPONENT ==============

function TradingViewAdvancedChartComponent({
  symbol,
  exchange = "NSE",
  udfBaseUrl,
  chartType = "candle",
  interval = "1D",
  theme: themeProp,
  height = 500,
  disabledFeatures,
  enabledFeatures,
  className,
  showDelayedDataNote = true,
}: TradingViewAdvancedChartProps) {
  // MONEY-1468 (A3) — the resolved `/udf` origin for this tree, put there by
  // the root layout. An explicit `udfBaseUrl` prop still wins; both fall back
  // to the legacy route, which is the safe direction.
  const contextUdfBaseUrl = useUdfBaseUrl();

  // MONEY-1469/1470 — install the market-data transport BEFORE the datafeed is
  // constructed, and unconditionally.
  //
  // TradingView's vendored `UDFCompatibleDatafeed` builds its own requester
  // with no headers and exports no `Requester` to pass one to, so this wrapper
  // is the only place an `Authorization` header can be attached. Without it
  // every intraday request is refused with a 200 `{s:"error"}` and a
  // console.warn — the entire A5 read path unreachable, silently, while the
  // writers fill Redis nightly.
  //
  // It is inert for every origin but the service's, and a same-origin legacy
  // base URL makes it a pass-through.
  const serviceOrigin = (() => {
    const base = udfBaseUrl || contextUdfBaseUrl || UDF_BASE_URL;
    try {
      return base.startsWith("http") ? new URL(base).origin : "";
    } catch {
      return "";
    }
  })();
  /**
   * The base the datafeed will actually be built with — null until probed.
   *
   * A SEPARATE effect, deliberately. The widget effect cannot await: React
   * needs its cleanup returned synchronously, and an effect that awaited before
   * returning one leaks a widget on every fast unmount.
   */
  const requestedBase = udfBaseUrl || contextUdfBaseUrl || UDF_BASE_URL;
  const [datafeedBase, setDatafeedBase] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void usableDatafeedBase(requestedBase).then((b) => {
      if (!dead) setDatafeedBase(b);
    });
    return () => {
      dead = true;
    };
  }, [requestedBase]);

  useEffect(() => {
    installMarketDataFetch(serviceOrigin);
  }, [serviceOrigin]);
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TVWidgetInstance | null>(null);

  // Broker-gated realtime (shared across stock detail, research report and
  // chat embeds — they all render THIS component, so the entitlement check
  // lives here once). Kept in a ref so a status flip (loading → active)
  // re-arms streaming on the next subscribe without rebuilding the widget.
  const { brokerStatus, isLoading: brokerStatusLoading } = useBrokerStatus();
  const realtimeAllowedRef = useRef(false);
  realtimeAllowedRef.current =
    !brokerStatusLoading && brokerStatus.status === "active";

  // MONEY-587 (C2): stabilise the feature-flag arrays by CONTENT. Callers may
  // pass fresh `disabledFeatures`/`enabledFeatures` array literals on every
  // render; if those reached the widget-construction effect's dependency array
  // by reference, the effect would re-run every render → the widget (and its
  // UDF datafeed) would be torn down and rebuilt in a tight loop, re-firing
  // /api/market/udf/history endlessly and leaving the chart empty. Joining to a
  // stable string key means the effect only re-runs when the *values* actually
  // change. (The chat embed passes neither, so this is also a no-op there.)
  const disabledFeaturesKey = (disabledFeatures ?? []).join(",");
  const enabledFeaturesKey = (enabledFeatures ?? []).join(",");
  const stableDisabledFeatures = useMemo(
    () => disabledFeatures ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabledFeaturesKey]
  );
  const stableEnabledFeatures = useMemo(
    () => enabledFeatures ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabledFeaturesKey]
  );

  // ── Theme: follow platform theme unless caller forces an override ──
  // MONEY-1383 (L5): the `theme` CONSTRUCTOR option is read once, but this
  // library version also exposes `changeTheme()` on the live widget, so a
  // theme flip is applied IN PLACE and no longer tears the iframe down and
  // re-runs the whole 3-hop UDF handshake. See `tv-widget-logic.ts` for the
  // typing that settles which methods v31.0.0 actually has.
  // `resolvedTheme` is the next-themes API that resolves "system" → the
  // actual OS theme, so we get the right value even when "system" is selected.
  const { resolvedTheme } = useTheme();
  const theme: "Dark" | "Light" =
    themeProp ?? (resolvedTheme === "light" ? "Light" : "Dark");

  // We detect script readiness by POLLING window for the globals rather than
  // relying on `<Script onLoad>` callbacks. Reasons:
  //
  //   1. SPA navigation: `<Script onLoad>` only fires once per browser session.
  //      If the scripts loaded on a previous page visit and the user then
  //      navigates via client-side routing to a page with this component, the
  //      <Script> tags remount but onLoad never fires - the useState flags
  //      stay `false` forever and the widget never instantiates.
  //
  //   2. Error recovery: if the first page visit hit a 404 (e.g. stale bundle
  //      on disk), onError fires and the component sets `error`. If the user
  //      then fixes the underlying issue and navigates back, polling picks up
  //      the now-available globals instead of staying stuck in error state.
  //
  //   3. Multiple instances: if another chart on the page already loaded the
  //      scripts, polling detects the globals immediately without waiting for
  //      a fresh download.
  //
  // Polling window for `window.TradingView` and `window.Datafeeds` is the
  // source of truth. The <Script> tags below still inject the script URLs
  // into the document; we just ignore their lifecycle callbacks.
  const [scriptsReady, setScriptsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const combinedSymbol = combineSymbol(symbol, exchange);

  // ── MONEY-1383 (L5): mutate the live widget, don't rebuild it ──
  //
  // `symbol`, `interval` and `theme` used to sit in the construction effect's
  // dependency array, so any of them changing destroyed the iframe and re-ran
  // /config → /time → /symbols → /history (2.7s warm, 5.2s cold before the
  // first candle). They are now read through a ref at construction time and
  // applied through `setSymbol` / `changeTheme` afterwards.
  const target: TvWidgetTarget = { symbol: combinedSymbol, interval, theme };
  /** Latest desired state — read by the construction effect, which no longer
   *  depends on it. */
  const targetRef = useRef<TvWidgetTarget>(target);
  targetRef.current = target;
  /** What the LIVE widget was last told to show, and whether the library
   *  confirmed it; null when no widget exists. */
  const appliedRef = useRef<TvWidgetApplied | null>(null);
  /** false between construction and `onChartReady` — the window in which the
   *  widget's iframe API is not reachable. */
  const widgetReadyRef = useRef(false);
  /** Bumped only when a change cannot be applied in place, to force the
   *  construction effect to re-run. */
  const [rebuildToken, setRebuildToken] = useState(0);

  // ── Script ready detection via polling ──
  useEffect(() => {
    if (scriptsReady) return;
    if (typeof window === "undefined") return;

    let cancelled = false;

    const check = (): boolean => {
      if (cancelled) return false;
      const libOk = !!window.TradingView;
      const dfOk = !!window.Datafeeds;
      if (libOk && dfOk) {
        setScriptsReady(true);
        // Clear any stale error from a previous failed load.
        setError((prev) =>
          prev && /library|datafeed|Script/i.test(prev) ? null : prev
        );
        return true;
      }
      return false;
    };

    // Immediate check - scripts may already be loaded (SPA navigation case)
    if (check()) return;

    const startedAt = Date.now();
    const POLL_INTERVAL_MS = 100;
    // 30s - chart bundle is ~3MB; on slow connections / cold edge cache
    // the original 15s wasn't enough and users saw "Failed to load chart"
    // even though the bundle was still mid-flight.
    const TIMEOUT_MS = 30000;

    const intervalId = setInterval(() => {
      if (check()) {
        clearInterval(intervalId);
        return;
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        clearInterval(intervalId);
        if (!cancelled) {
          const missing: string[] = [];
          if (!window.TradingView) missing.push("TradingView library");
          if (!window.Datafeeds) missing.push("UDF datafeed adapter");
          console.error(
            `[TradingView] ${missing.join(" and ")} did not load within ${TIMEOUT_MS / 1000}s. ` +
              `Check the network tab for 404s on /charting_library/ or /datafeeds/.`
          );
          setError(
            "Chart is temporarily unavailable. Please refresh the page or try again later."
          );
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [scriptsReady]);

  // ── Widget instantiation ──
  useEffect(() => {
    if (!scriptsReady) return;
    // Built only once `/config` has been confirmed reachable — see
    // `usableDatafeedBase`. The datafeed latches its config at construction and
    // never re-reads it, so this is the only moment the choice can be made.
    if (!datafeedBase) return;
    if (!containerRef.current) return;
    if (!window.TradingView || !window.Datafeeds) return;

    // Guard against zero-height container. autosize:true silently fails if
    // the container has no layout height at mount time. getBoundingClientRect()
    // is synchronous; if it reports 0 height, we defer via rAF to let layout
    // settle and try again.
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.height === 0) {
      let rafId = 0;
      const retry = () => {
        if (!containerRef.current) return;
        if (containerRef.current.getBoundingClientRect().height > 0) {
          // Force re-run by toggling a ref - simpler: just log and bail.
          // The next render cycle (if any) will re-enter this effect.
          console.warn(
            "[TradingViewAdvancedChart] container had 0 height; deferred."
          );
          return;
        }
        rafId = requestAnimationFrame(retry);
      };
      rafId = requestAnimationFrame(retry);
      return () => cancelAnimationFrame(rafId);
    }

    // StrictMode double-mount safety: a flag we close over so the cleanup
    // can no-op if the effect was torn down before the widget finished
    // construction. Also nulls widgetRef on cleanup so the second mount
    // doesn't try to call remove() on a stale instance.
    let cancelled = false;

    // Read the CURRENT target rather than closing over the props: symbol,
    // interval and theme are deliberately absent from this effect's deps, so
    // the values captured by a stale closure would be wrong after an in-place
    // update followed by a rebuild.
    const built = targetRef.current;

    try {
      const datafeed = new window.Datafeeds.UDFCompatibleDatafeed(
        datafeedBase
      ) as UDFDatafeedInstance;
      // Overlay our live-stream subscribe/unsubscribe on the bundled
      // UDF datafeed. This turns the TV widget into a real-time chart
      // (MONEY-123 Part B) without forking the library — but ONLY for
      // active-broker users; see `installLiveStream` for the contract.
      installLiveStream(datafeed, realtimeAllowedRef);
      const widget = new window.TradingView.widget({
        container: containerRef.current,
        library_path: LIBRARY_PATH,
        datafeed,
        symbol: built.symbol,
        interval: built.interval,
        locale: "en",
        timezone: "Asia/Kolkata",
        theme: built.theme,
        autosize: true,
        chart_type: chartTypeToNumber(chartType),
        disabled_features: [
          ...DEFAULT_DISABLED_FEATURES,
          ...stableDisabledFeatures,
        ],
        enabled_features: stableEnabledFeatures,
        debug: process.env.NODE_ENV === "development",
      });

      if (cancelled) {
        // Effect was torn down between script load and widget construction;
        // discard the freshly-created widget so it doesn't leak.
        widget.remove();
        return;
      }

      widgetRef.current = widget;
      widgetReadyRef.current = false;
      // `confirmed: true` — the CONSTRUCTOR took this target, so it is the
      // widget's configured state whatever the datafeed goes on to answer.
      // (An in-place `setSymbol` is the opposite: it can be issued and never
      // land.) Marking a fresh widget unconfirmed would make the first symbol
      // change after every mount a rebuild, which is the whole latency this
      // ticket removed.
      appliedRef.current = { ...built, confirmed: true };
      // Cheap and idempotent; fires synchronously if the widget is already
      // ready and is dropped by `remove()` otherwise.
      widget.onChartReady(() => {
        if (!cancelled) widgetReadyRef.current = true;
      });
      setError(null);
    } catch (err) {
      console.error(
        "[TradingViewAdvancedChart] widget construction failed:",
        err
      );
      setError(err instanceof Error ? err.message : "Failed to load chart");
    }

    return () => {
      cancelled = true;
      if (widgetRef.current) {
        try {
          widgetRef.current.remove();
        } catch (err) {
          console.warn(
            "[TradingViewAdvancedChart] cleanup remove() threw:",
            err
          );
        }
        widgetRef.current = null;
      }
      widgetReadyRef.current = false;
      appliedRef.current = null;
    };
    // `combinedSymbol` / `interval` / `theme` are read through `targetRef`, and
    // `rebuildToken` is a deliberate re-run trigger the body never reads —
    // both directions are what this effect is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scriptsReady,
    // The probed base. It settles once per mount, so this rebuilds the widget
    // at most one extra time — and only ever from "not yet known" to a value.
    datafeedBase,
    // MONEY-1383 (L5): `combinedSymbol`, `interval` and `theme` are NOT here —
    // the effect below applies them to the live widget instead. `rebuildToken`
    // is that effect's escape hatch for the one case it cannot handle.
    rebuildToken,
    chartType,
    // Content-stable (see the useMemo above) — not the raw caller arrays, so a
    // fresh array literal per render no longer rebuilds the widget every render.
    stableDisabledFeatures,
    stableEnabledFeatures,
  ]);

  // ── MONEY-1383 (L5): apply symbol / interval / theme to the LIVE widget ──
  useEffect(() => {
    const widget = widgetRef.current;
    const next: TvWidgetTarget = { symbol: combinedSymbol, interval, theme };
    const plan = planWidgetUpdate(
      widget && appliedRef.current
        ? { ...appliedRef.current, ready: widgetReadyRef.current }
        : null,
      next
    );

    if (plan.kind === "none") return;

    if (plan.kind === "rebuild") {
      // `no-widget` means the construction effect has not run yet (scripts
      // still loading). It will read `targetRef` when it does, so bumping the
      // token here would rebuild nothing and only add a render.
      if (widget) setRebuildToken((t) => t + 1);
      return;
    }

    if (!widget) return; // `mutate` implies a live widget; belt and braces.

    // Record the INTENT unconfirmed, then let the outcome confirm it. This
    // used to be a synchronous `appliedRef.current = next` beside a discarded
    // callback and a swallowed rejection, which claimed every change landed:
    // a `/symbols` answering `{s:"error"}` left the ref saying INFY over TCS's
    // candles with `planWidgetUpdate` answering `none` forever after — no
    // retry, no rebuild, no recovery. See `dispatchWidgetUpdate` for why
    // failure is silence rather than an error.
    appliedRef.current = { ...next, confirmed: false };
    dispatchWidgetUpdate(widget, plan, next).then(
      () => {
        appliedRef.current = resolveAppliedState({
          applied: appliedRef.current,
          dispatched: next,
          outcome: "settled",
        });
      },
      (err) => {
        // Only `changeTheme` can reach here — a failed symbol change never
        // settles. Leaving the state unconfirmed is the point: the next
        // differing target re-plans as a rebuild instead of believing the
        // widget moved.
        console.warn("[TradingViewAdvancedChart] widget update failed:", err);
      }
    );
  }, [combinedSymbol, interval, theme]);

  return (
    <div
      className={cn("trading-view-advanced-chart relative w-full", className)}
    >
      {/*
        Library: standalone IIFE that attaches window.TradingView.
        We don't use onLoad/onReady/onError callbacks - the ready-detection
        effect above polls window directly, which is robust to SPA navigation
        and script caching where `<Script>` lifecycle callbacks don't re-fire.
        `next/script` still injects the script tag exactly once per document.
      */}
      {/* `afterInteractive` (not `lazyOnload`): the chat block is itself
          inside a Suspense lazy boundary that mounts after the page is
          idle; with `lazyOnload` the browser sometimes defers the chart
          scripts indefinitely, causing the 15s poll to time out and the
          "Failed to load chart" error to show. `afterInteractive` runs
          the script as soon as the component renders, regardless of
          when in the page lifecycle that happens. */}
      <Script src={STANDALONE_SCRIPT} strategy="afterInteractive" />
      {/* UDF datafeed adapter: independent of the library, sets window.Datafeeds */}
      <Script src={DATAFEED_SCRIPT} strategy="afterInteractive" />

      {/* Container - autosize:true requires a fixed height parent. */}
      <div
        ref={containerRef}
        className="tv-chart-container w-full"
        style={{ height: `${height}px` }}
      />

      {/* MONEY-566: exchange-delayed disclaimer for non-active-broker users.
          Self-hides for active brokers (real-time under their own token) and
          for MF NAV charts (daily NAV is not "exchange-delayed"). */}
      {showDelayedDataNote && exchange !== "MF" && (
        <div className="mt-1 px-1">
          <DelayedDataNote />
        </div>
      )}

      {/* Loading overlay shown until both scripts are ready */}
      {!scriptsReady && !error && (
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center pointer-events-none",
            theme === "Dark" ? "bg-[#1a1a2e]/80" : "bg-white/80"
          )}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span
              className={cn(
                "text-sm",
                theme === "Dark" ? "text-gray-400" : "text-gray-500"
              )}
            >
              Loading TradingView…
            </span>
          </div>
        </div>
      )}

      {/*
        MONEY-1470 (A5) — the bar-basis badge.

        Rendered unconditionally; the component returns null unless the current
        series is `quote_mid`. Putting the condition inside it keeps the one
        place that knows what the basis MEANS next to the words that say so, and
        means nothing here has to be updated when a third basis appears.
      */}
      <div className="pointer-events-none absolute left-2 top-2 z-10">
        <BarBasisBadge className="pointer-events-auto" />
      </div>

      {/* Error overlay */}
      {error && (
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center",
            theme === "Dark" ? "bg-[#1a1a2e]/90" : "bg-white/90"
          )}
        >
          <div className="text-center px-4">
            <p className="text-red-500 font-medium mb-2">
              Failed to load chart
            </p>
            <p
              className={cn(
                "text-sm",
                theme === "Dark" ? "text-gray-400" : "text-gray-500"
              )}
            >
              {error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const TradingViewAdvancedChart = memo(TradingViewAdvancedChartComponent);
TradingViewAdvancedChart.displayName = "TradingViewAdvancedChart";

export default TradingViewAdvancedChart;
export { TradingViewAdvancedChart };
