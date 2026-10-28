/**
 * MONEY-1383 (L5) — should a symbol / interval / theme change rebuild the
 * TradingView widget, or can it be applied to the live one?
 *
 * Rebuilding destroys the widget's iframe and re-runs the ENTIRE UDF
 * handshake — /config, /time, /symbols, /history — measured at 2.7s warm and
 * 5.2s cold before the first candle. Every one of those hops also pays the
 * India↔iad1 RTT. So a user flipping the theme, or switching symbol from a
 * chart that is already on screen, paid full chart-load latency for a change
 * the library can do in place.
 *
 * WHAT THIS LIBRARY VERSION ACTUALLY EXPOSES (v31.0.0, verified against the
 * BUNDLED artifacts, not against the docs):
 *
 *   types/tradingview/charting_library.d.ts, `IChartingLibraryWidget`:
 *     setSymbol(symbol: string, interval: ResolutionString, callback: EmptyCallback): void
 *     changeTheme(themeName: ThemeName, options?: ChangeThemeOptions): Promise<void>
 *     with `export type ThemeName = "light" | "dark";`  ← LOWERCASE
 *
 *   public/charting_library/charting_library.standalone.js (the shipped runtime):
 *     setSymbol(e,t,i){this._innerAPI().changeSymbol(e,t,i)}
 *     changeTheme(e,t){return this._innerWindow().changeTheme(e,t)}
 *     onChartReady(e){this._ready?e.call(this):this._readyHandlers.push(e)}
 *
 * Both exist, so BOTH symbol and theme are in-place operations here — theme
 * does not need to stay in the teardown deps. `setSymbol` takes the interval
 * too, which is why interval is folded into the same decision.
 *
 * `_innerAPI()` / `_innerWindow()` reach into the widget's iframe and are only
 * valid after `onChartReady`, hence `TvWidgetLive.ready`.
 */

export type TvTheme = "Dark" | "Light";

/** What a render wants the chart to show. */
export interface TvWidgetTarget {
  /** Combined `EXCHANGE:SYMBOL`, e.g. `NSE:TCS`. */
  symbol: string;
  /** TradingView resolution string, e.g. `1D`. */
  interval: string;
  theme: TvTheme;
}

/**
 * What the widget was last TOLD to show, and whether the library ever
 * CONFIRMED it.
 *
 * The two are NOT the same thing, and treating them as one is the defect this
 * split exists to remove. `setSymbol`'s completion callback is subscribed to
 * `onDataLoaded()` and nothing else (see `dispatchWidgetUpdate` for the
 * runtime source), so a `/symbols` answering `{s:"error"}` — which is also
 * what a transient DB failure looks like — leaves the callback unfired
 * forever. Recording the target as applied at DISPATCH time therefore claimed
 * a change that never landed: `planWidgetUpdate` then answered `none` for
 * every subsequent render, so there was no retry, no rebuild and no recovery,
 * and the header and URL said INFY over TCS's candles.
 */
export interface TvWidgetApplied extends TvWidgetTarget {
  /** false between dispatching setSymbol/changeTheme and the library confirming. */
  confirmed: boolean;
}

/** What the live widget was last TOLD to show, plus whether it can be talked to. */
export interface TvWidgetLive extends TvWidgetApplied {
  /** false between construction and `onChartReady`. */
  ready: boolean;
}

export type TvWidgetUpdate =
  | { kind: "none" }
  | { kind: "rebuild"; reason: "no-widget" | "not-ready" | "unconfirmed" }
  | { kind: "mutate"; setSymbol: boolean; changeTheme: boolean };

/** Same three fields, same values. */
function sameTarget(a: TvWidgetTarget, b: TvWidgetTarget): boolean {
  return (
    a.symbol === b.symbol && a.interval === b.interval && a.theme === b.theme
  );
}

/**
 * Decide how to move a live widget from `live` to `next`.
 *
 * `live` is null when no widget exists yet — nothing to mutate, so the caller
 * constructs one.
 */
export function planWidgetUpdate(
  live: TvWidgetLive | null,
  next: TvWidgetTarget
): TvWidgetUpdate {
  if (!live) return { kind: "rebuild", reason: "no-widget" };

  // `setSymbol` carries the interval, so the two move together.
  const symbolChanged =
    live.symbol !== next.symbol || live.interval !== next.interval;
  const themeChanged = live.theme !== next.theme;

  // ORDER IS LOAD-BEARING: "nothing changed" is answered BEFORE readiness.
  // The effect that calls this also runs on mount, when the widget has just
  // been constructed and is by definition not ready — checking readiness first
  // would report `rebuild` for a widget that is showing exactly what was
  // asked for, and the caller's rebuild would re-enter this same state. That
  // is an infinite teardown loop, which is the failure this whole change is
  // meant to remove.
  if (!symbolChanged && !themeChanged) return { kind: "none" };

  // A change arrived mid-initialisation. `setSymbol`/`changeTheme` reach into
  // the widget's iframe through `_innerAPI()` / `_innerWindow()` and throw
  // before `onChartReady`, so the only safe answer is to rebuild with the new
  // target rather than to drop the change on the floor.
  if (!live.ready) return { kind: "rebuild", reason: "not-ready" };

  // The last change was dispatched and never confirmed, and now a DIFFERENT
  // target is wanted. What the widget is actually showing is unknown — the
  // symbol may have half-applied with no data, or the theme may not have moved
  // at all — so an in-place mutation from an unknown state is not safe to
  // reason about. A rebuild is the recovery, and it is the only one available:
  // the library reports failure by never calling back (see
  // `dispatchWidgetUpdate`), so there is no error to react to at the time.
  //
  // AFTER the equality check on purpose. An unconfirmed state whose target is
  // unchanged is the ordinary in-flight case; rebuilding there would tear the
  // widget down mid-load, land in the same unconfirmed state and loop.
  if (!live.confirmed) return { kind: "rebuild", reason: "unconfirmed" };

  return {
    kind: "mutate",
    setSymbol: symbolChanged,
    changeTheme: themeChanged,
  };
}

/**
 * The `applied` transition — a function of the OUTCOME of a dispatched
 * update, never of the intent to dispatch one.
 *
 * `applied` is what the ref holds NOW; `dispatched` is the target the
 * completing operation was for.
 *
 *   - the widget was torn down mid-flight (`applied` null) → stays null
 *   - a NEWER dispatch already replaced the target → unchanged, so a late
 *     callback for a superseded symbol cannot confirm the current one
 *   - `failed` → unchanged, i.e. still unconfirmed, so the next differing
 *     target re-plans as a rebuild instead of believing the change landed
 *   - `settled` → confirmed
 */
export function resolveAppliedState(input: {
  applied: TvWidgetApplied | null;
  dispatched: TvWidgetTarget;
  outcome: "settled" | "failed";
}): TvWidgetApplied | null {
  const { applied, dispatched, outcome } = input;
  if (!applied) return null;
  if (!sameTarget(applied, dispatched)) return applied;
  if (outcome === "failed") return applied;
  return { ...applied, confirmed: true };
}

/** The two in-place methods {@link dispatchWidgetUpdate} drives. */
export interface TvWidgetHandle {
  setSymbol(symbol: string, interval: string, onComplete: () => void): void;
  changeTheme(themeName: "light" | "dark"): Promise<void>;
}

/**
 * Dispatch a `mutate` plan and resolve when the LIBRARY says it landed.
 *
 * WHAT `setSymbol`'s CALLBACK ACTUALLY PROMISES, read off the shipped runtime
 * rather than the docs:
 *
 *   charting_library.standalone.js
 *     setSymbol(e,t,i){this._innerAPI().changeSymbol(e,t,i)}
 *   bundles/library.<hash>.js
 *     changeSymbol(e,t,i,s="API"){ …setSymbol…;
 *       i && this.activeChart().onDataLoaded().subscribe(null,i,!0) }
 *     onDataLoaded(){return this._makeSubscriptionFromDelegate(
 *       this._chartWidget.model().mainSeries().dataEvents().completed())}
 *
 * The callback is subscribed ONCE to `dataEvents().completed()`. The sibling
 * delegates `error()`, `symbolError()` and `symbolResolved()` all exist on the
 * same object and NONE of them is wired to it. So the callback is a
 * SUCCESS-ONLY signal and failure is silence — there is no rejection to catch
 * and no error argument to inspect.
 *
 * That is why this returns a promise that, on a failed symbol change, NEVER
 * SETTLES. Inventing a timeout to manufacture a failure edge would be picking
 * a number the library gives no basis for; leaving the state unconfirmed lets
 * the next differing target rebuild (see `planWidgetUpdate`), which is the
 * safest signal actually available. `changeTheme` DOES return a real promise,
 * so its failure is a genuine rejection and propagates.
 */
export function dispatchWidgetUpdate(
  widget: TvWidgetHandle,
  plan: { setSymbol: boolean; changeTheme: boolean },
  next: TvWidgetTarget
): Promise<void> {
  const ops: Promise<unknown>[] = [];
  if (plan.setSymbol) {
    ops.push(
      new Promise<void>((resolve) =>
        widget.setSymbol(next.symbol, next.interval, resolve)
      )
    );
  }
  if (plan.changeTheme) {
    ops.push(widget.changeTheme(toLibraryThemeName(next.theme)));
  }
  return Promise.all(ops).then(() => undefined);
}

/** Convenience predicate over {@link planWidgetUpdate}. */
export function shouldRebuildWidget(
  live: TvWidgetLive | null,
  next: TvWidgetTarget
): boolean {
  return planWidgetUpdate(live, next).kind === "rebuild";
}

/**
 * Our props spell the theme `"Dark" | "Light"` (the widget CONSTRUCTOR option
 * is case-insensitive — the loader does `(this._options.theme||"light").toLowerCase()`).
 * `changeTheme` is typed `ThemeName = "light" | "dark"` and is passed straight
 * through to the inner window, so it gets the declared lowercase form.
 */
export function toLibraryThemeName(theme: TvTheme): "light" | "dark" {
  return theme === "Light" ? "light" : "dark";
}
