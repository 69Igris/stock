/**
 * MONEY-1383 (L5) — do NOT tear the TradingView widget down on a symbol,
 * interval or theme change.
 *
 * A rebuild destroys the widget's iframe and re-runs the whole UDF handshake
 * (/config → /time → /symbols → /history), measured at 2.7s warm and 5.2s cold
 * before the first candle, every hop paying the India↔iad1 RTT. v31.0.0
 * exposes `setSymbol(symbol, interval, cb)` and `changeTheme(themeName)` on
 * the live widget, so none of the three needs a rebuild once the chart is
 * ready — see the header of `tv-widget-logic.ts` for the typings and the
 * shipped runtime source both methods were verified against.
 *
 * Source: apps/web/components/charts/tv-widget-logic.ts
 *         apps/web/components/charts/TradingViewAdvancedChart.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type TvWidgetApplied,
  type TvWidgetHandle,
  type TvWidgetLive,
  type TvWidgetTarget,
  dispatchWidgetUpdate,
  planWidgetUpdate,
  resolveAppliedState,
  shouldRebuildWidget,
  toLibraryThemeName,
} from "@/components/charts/tv-widget-logic";
import manifest from "@/lib/charts/preload-manifest.json";

const READY: TvWidgetLive = {
  symbol: "NSE:TCS",
  interval: "1D",
  theme: "Dark",
  ready: true,
  confirmed: true,
};

const SAME: TvWidgetTarget = {
  symbol: "NSE:TCS",
  interval: "1D",
  theme: "Dark",
};

describe("planWidgetUpdate — no live widget", () => {
  it("rebuilds when there is nothing to mutate", () => {
    assert.deepEqual(planWidgetUpdate(null, SAME), {
      kind: "rebuild",
      reason: "no-widget",
    });
    assert.equal(shouldRebuildWidget(null, SAME), true);
  });
});

describe("planWidgetUpdate — nothing changed", () => {
  it("is a no-op when the target matches a ready widget", () => {
    assert.deepEqual(planWidgetUpdate(READY, SAME), { kind: "none" });
    assert.equal(shouldRebuildWidget(READY, SAME), false);
  });

  it("is a no-op when the target matches an UNREADY widget", () => {
    // Load-bearing ordering: this is the mount pass. The widget has just been
    // constructed with exactly this target and has not fired onChartReady. If
    // readiness were checked before equality, this would report `rebuild`,
    // the caller would rebuild, and the new widget would land in the same
    // state — an infinite teardown loop.
    assert.deepEqual(planWidgetUpdate({ ...READY, ready: false }, SAME), {
      kind: "none",
    });
    assert.equal(shouldRebuildWidget({ ...READY, ready: false }, SAME), false);
  });
});

describe("planWidgetUpdate — ready widget, in-place updates", () => {
  it("symbol-only change → mutate via setSymbol, NO rebuild", () => {
    const plan = planWidgetUpdate(READY, { ...SAME, symbol: "NSE:INFY" });
    assert.deepEqual(plan, {
      kind: "mutate",
      setSymbol: true,
      changeTheme: false,
    });
    assert.equal(
      shouldRebuildWidget(READY, { ...SAME, symbol: "NSE:INFY" }),
      false
    );
  });

  it("interval-only change → setSymbol (it carries the resolution), NO rebuild", () => {
    assert.deepEqual(planWidgetUpdate(READY, { ...SAME, interval: "60" }), {
      kind: "mutate",
      setSymbol: true,
      changeTheme: false,
    });
  });

  it("theme-only change → changeTheme, NO setSymbol and NO rebuild", () => {
    // `changeTheme` EXISTS in this version, so theme leaves the teardown deps.
    // Calling setSymbol here instead would re-fetch every bar for a repaint.
    const plan = planWidgetUpdate(READY, { ...SAME, theme: "Light" });
    assert.deepEqual(plan, {
      kind: "mutate",
      setSymbol: false,
      changeTheme: true,
    });
    assert.equal(
      shouldRebuildWidget(READY, { ...SAME, theme: "Light" }),
      false
    );
  });

  it("symbol AND theme change → both, still one widget", () => {
    assert.deepEqual(
      planWidgetUpdate(READY, {
        symbol: "NSE:INFY",
        interval: "60",
        theme: "Light",
      }),
      { kind: "mutate", setSymbol: true, changeTheme: true }
    );
  });
});

describe("planWidgetUpdate — a change arriving before onChartReady", () => {
  const UNREADY: TvWidgetLive = { ...READY, ready: false };

  it("symbol change while not ready → rebuild", () => {
    // setSymbol reaches into the iframe via `_innerAPI()` and throws before
    // the widget is ready; dropping the change instead would strand the chart
    // on the old symbol forever.
    assert.deepEqual(
      planWidgetUpdate(UNREADY, { ...SAME, symbol: "NSE:INFY" }),
      {
        kind: "rebuild",
        reason: "not-ready",
      }
    );
    assert.equal(
      shouldRebuildWidget(UNREADY, { ...SAME, symbol: "NSE:INFY" }),
      true
    );
  });

  it("theme change while not ready → rebuild", () => {
    assert.deepEqual(planWidgetUpdate(UNREADY, { ...SAME, theme: "Light" }), {
      kind: "rebuild",
      reason: "not-ready",
    });
  });

  it("never returns `mutate` for an unready widget, for any change", () => {
    const targets: TvWidgetTarget[] = [
      { ...SAME, symbol: "NSE:INFY" },
      { ...SAME, interval: "5" },
      { ...SAME, theme: "Light" },
      { symbol: "BSE:TCS", interval: "1W", theme: "Light" },
    ];
    for (const t of targets) {
      assert.notEqual(
        planWidgetUpdate(UNREADY, t).kind,
        "mutate",
        `mutate on an unready widget for ${JSON.stringify(t)}`
      );
    }
  });
});

// ── MONEY-1383 (L5) B2: "applied" is an OUTCOME, never an intent ───────────
//
// `appliedRef.current = next` used to run synchronously beside a discarded
// `setSymbol` callback and a swallowed `changeTheme` rejection, so the ref
// claimed every change landed. TCS → INFY where `/symbols` answers
// `{s:"error"}` (also what a transient DB failure looks like) left the ref
// saying INFY, `planWidgetUpdate` answering `none` on every later render, and
// the header and URL over TCS's candles with no retry and no recovery.

const PENDING_INFY: TvWidgetApplied = {
  symbol: "NSE:INFY",
  interval: "1D",
  theme: "Dark",
  confirmed: false,
};

describe("planWidgetUpdate — a change arriving on an UNCONFIRMED widget", () => {
  const UNCONFIRMED: TvWidgetLive = { ...READY, confirmed: false };

  it("an UNCHANGED target is still `none` — in-flight is not a fault", () => {
    // Ordering is load-bearing the same way readiness is: this is the ordinary
    // window between dispatch and the library's callback. Rebuilding here
    // would tear the widget down mid-load and land in this same state.
    assert.deepEqual(planWidgetUpdate(UNCONFIRMED, SAME), { kind: "none" });
  });

  it("symbol change on an unconfirmed widget → rebuild, NOT mutate", () => {
    // The widget's real state is unknown — the previous setSymbol may have
    // half-applied with no data — so an in-place mutation from it cannot be
    // reasoned about.
    assert.deepEqual(
      planWidgetUpdate(UNCONFIRMED, { ...SAME, symbol: "NSE:WIPRO" }),
      { kind: "rebuild", reason: "unconfirmed" }
    );
    assert.equal(
      shouldRebuildWidget(UNCONFIRMED, { ...SAME, symbol: "NSE:WIPRO" }),
      true
    );
  });

  it("theme change on an unconfirmed widget → rebuild", () => {
    assert.deepEqual(
      planWidgetUpdate(UNCONFIRMED, { ...SAME, theme: "Light" }),
      {
        kind: "rebuild",
        reason: "unconfirmed",
      }
    );
  });

  it("a CONFIRMED widget still mutates — the fast path is untouched", () => {
    // The guard above must not cost the latency this whole ticket removed.
    assert.deepEqual(
      planWidgetUpdate(READY, { ...SAME, symbol: "NSE:WIPRO" }),
      {
        kind: "mutate",
        setSymbol: true,
        changeTheme: false,
      }
    );
  });
});

describe("resolveAppliedState — applied follows the outcome, not the dispatch", () => {
  it("pending → settled marks it applied", () => {
    assert.deepEqual(
      resolveAppliedState({
        applied: PENDING_INFY,
        dispatched: PENDING_INFY,
        outcome: "settled",
      }),
      { ...PENDING_INFY, confirmed: true }
    );
  });

  it("pending → failed leaves it UNAPPLIED, so the next plan retries", () => {
    const after = resolveAppliedState({
      applied: PENDING_INFY,
      dispatched: PENDING_INFY,
      outcome: "failed",
    });
    assert.deepEqual(after, PENDING_INFY, "a failure must not confirm");
    // …and THAT is what buys the recovery: the next differing target rebuilds
    // instead of being answered `none` forever.
    assert.deepEqual(
      planWidgetUpdate(
        { ...after!, ready: true },
        { ...PENDING_INFY, symbol: "NSE:WIPRO" }
      ),
      { kind: "rebuild", reason: "unconfirmed" }
    );
  });

  it("a LATE callback for a SUPERSEDED target cannot confirm the current one", () => {
    // User went TCS → INFY → WIPRO. INFY's onDataLoaded fires after WIPRO was
    // dispatched; confirming here would mark WIPRO landed on INFY's evidence.
    const current: TvWidgetApplied = {
      symbol: "NSE:WIPRO",
      interval: "1D",
      theme: "Dark",
      confirmed: false,
    };
    assert.deepEqual(
      resolveAppliedState({
        applied: current,
        dispatched: PENDING_INFY,
        outcome: "settled",
      }),
      current
    );
  });

  it("an interval-only supersede is also caught (all three fields compared)", () => {
    const current: TvWidgetApplied = { ...PENDING_INFY, interval: "60" };
    assert.deepEqual(
      resolveAppliedState({
        applied: current,
        dispatched: PENDING_INFY,
        outcome: "settled",
      }),
      current
    );
    const themed: TvWidgetApplied = { ...PENDING_INFY, theme: "Light" };
    assert.deepEqual(
      resolveAppliedState({
        applied: themed,
        dispatched: PENDING_INFY,
        outcome: "settled",
      }),
      themed
    );
  });

  it("a widget torn down mid-flight stays null", () => {
    assert.equal(
      resolveAppliedState({
        applied: null,
        dispatched: PENDING_INFY,
        outcome: "settled",
      }),
      null
    );
  });
});

/** One macrotask — enough for any promise chain in these tests to settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeWidget(overrides: Partial<TvWidgetHandle> = {}): TvWidgetHandle & {
  calls: { setSymbol: unknown[][]; changeTheme: unknown[][] };
} {
  const calls = {
    setSymbol: [] as unknown[][],
    changeTheme: [] as unknown[][],
  };
  return {
    calls,
    setSymbol(symbol, interval, onComplete) {
      calls.setSymbol.push([symbol, interval]);
      onComplete();
    },
    changeTheme(themeName) {
      calls.changeTheme.push([themeName]);
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe("dispatchWidgetUpdate — the promise IS the outcome", () => {
  const NEXT: TvWidgetTarget = {
    symbol: "NSE:INFY",
    interval: "60",
    theme: "Light",
  };

  it("resolves once setSymbol calls back, forwarding symbol AND interval", async () => {
    const w = fakeWidget();
    let settled = false;
    await dispatchWidgetUpdate(
      w,
      { setSymbol: true, changeTheme: false },
      NEXT
    ).then(() => {
      settled = true;
    });
    assert.equal(settled, true);
    assert.deepEqual(w.calls.setSymbol, [["NSE:INFY", "60"]]);
    assert.deepEqual(w.calls.changeTheme, [], "no theme in this plan");
  });

  it("NEVER settles when the callback is not invoked — the library's only failure signal is silence", async () => {
    // `changeSymbol` subscribes the callback to `onDataLoaded()` alone, so a
    // `/symbols` error simply never calls it. This is the case the old code
    // recorded as success.
    const w = fakeWidget({ setSymbol() {} });
    let settled: string | null = null;
    void dispatchWidgetUpdate(
      w,
      { setSymbol: true, changeTheme: false },
      NEXT
    ).then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      }
    );
    await tick();
    assert.equal(settled, null);
  });

  it("waits for BOTH operations when the plan carries both", async () => {
    let release: (() => void) | null = null;
    const w = fakeWidget({
      setSymbol(_s, _i, onComplete) {
        release = onComplete;
      },
    });
    let settled = false;
    void dispatchWidgetUpdate(
      w,
      { setSymbol: true, changeTheme: true },
      NEXT
    ).then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false, "changeTheme resolved but setSymbol had not");
    release!();
    await tick();
    assert.equal(settled, true);
  });

  it("passes changeTheme the LOWERCASE ThemeName the typings declare", async () => {
    const w = fakeWidget();
    await dispatchWidgetUpdate(
      w,
      { setSymbol: false, changeTheme: true },
      NEXT
    );
    assert.deepEqual(w.calls.changeTheme, [["light"]]);
  });

  it("rejects when changeTheme rejects — a real promise, a real failure edge", async () => {
    const w = fakeWidget({
      changeTheme: () => Promise.reject(new Error("iframe gone")),
    });
    await assert.rejects(
      dispatchWidgetUpdate(w, { setSymbol: false, changeTheme: true }, NEXT),
      /iframe gone/
    );
  });

  it("an empty plan resolves without touching the widget", async () => {
    const w = fakeWidget();
    await dispatchWidgetUpdate(
      w,
      { setSymbol: false, changeTheme: false },
      NEXT
    );
    assert.deepEqual(w.calls.setSymbol, []);
    assert.deepEqual(w.calls.changeTheme, []);
  });
});

describe('the reported failure end to end: TCS → INFY, /symbols answers {s:"error"}', () => {
  // This is the JOIN — plan, dispatch and the applied transition wired the way
  // `TradingViewAdvancedChart`'s effect wires them. Asserting the three pieces
  // separately would not catch a component that still confirmed on dispatch.
  const TCS: TvWidgetTarget = {
    symbol: "NSE:TCS",
    interval: "1D",
    theme: "Dark",
  };
  const INFY: TvWidgetTarget = { ...TCS, symbol: "NSE:INFY" };
  const WIPRO: TvWidgetTarget = { ...TCS, symbol: "NSE:WIPRO" };

  it("does not claim INFY landed, and the next navigation recovers", async () => {
    let applied: TvWidgetApplied | null = { ...TCS, confirmed: true };

    const plan = planWidgetUpdate({ ...applied, ready: true }, INFY);
    assert.deepEqual(plan, {
      kind: "mutate",
      setSymbol: true,
      changeTheme: false,
    });

    // The datafeed answers `{s:"error"}` → onDataLoaded never fires.
    const dead = fakeWidget({ setSymbol() {} });
    applied = { ...INFY, confirmed: false };
    void dispatchWidgetUpdate(dead, plan, INFY).then(() => {
      applied = resolveAppliedState({
        applied,
        dispatched: INFY,
        outcome: "settled",
      });
    });
    await tick();

    assert.equal(
      applied.confirmed,
      false,
      "a change that never landed is not applied"
    );

    // Re-rendering for the SAME target must not thrash the widget.
    assert.deepEqual(planWidgetUpdate({ ...applied, ready: true }, INFY), {
      kind: "none",
    });

    // The user navigates on — this is the render that used to be `none`
    // forever. It now recovers.
    assert.deepEqual(planWidgetUpdate({ ...applied, ready: true }, WIPRO), {
      kind: "rebuild",
      reason: "unconfirmed",
    });
  });

  it("the healthy path confirms, and stays on the in-place fast path", async () => {
    let applied: TvWidgetApplied | null = { ...TCS, confirmed: true };
    const plan = planWidgetUpdate({ ...applied, ready: true }, INFY);
    assert.equal(plan.kind, "mutate");

    const w = fakeWidget();
    applied = { ...INFY, confirmed: false };
    await dispatchWidgetUpdate(
      w,
      plan as { setSymbol: boolean; changeTheme: boolean },
      INFY
    ).then(() => {
      applied = resolveAppliedState({
        applied,
        dispatched: INFY,
        outcome: "settled",
      });
    });

    assert.equal(applied!.confirmed, true);
    assert.deepEqual(planWidgetUpdate({ ...applied!, ready: true }, WIPRO), {
      kind: "mutate",
      setSymbol: true,
      changeTheme: false,
    });
  });
});

describe("toLibraryThemeName", () => {
  it("maps our capitalised props to the library's lowercase ThemeName", () => {
    // `export type ThemeName = "light" | "dark";` — the CONSTRUCTOR option is
    // lowercased by the loader, but `changeTheme` passes straight through.
    assert.equal(toLibraryThemeName("Dark"), "dark");
    assert.equal(toLibraryThemeName("Light"), "light");
  });
});

describe("the SHIPPED library still has the methods this decision assumes", () => {
  // The premise of every `mutate` verdict above is that v31.0.0's widget can
  // change symbol and theme in place. That premise lives in a VENDORED file
  // (`yarn sync:chart` replaces it wholesale on an upgrade), so it is checked
  // against the artifact rather than remembered. If a future version drops
  // either method, `planWidgetUpdate` would keep returning `mutate` and the
  // component would throw a TypeError at the user instead of rebuilding.
  const WEB_ROOT = resolve(__dirname, "../..");
  const standalone = readFileSync(
    resolve(WEB_ROOT, "public/charting_library/charting_library.standalone.js"),
    "utf8"
  );
  const typings = readFileSync(
    resolve(WEB_ROOT, "types/tradingview/charting_library.d.ts"),
    "utf8"
  );

  it("the runtime defines setSymbol on the widget", () => {
    assert.match(standalone, /setSymbol\(e,t,i\)\{this\._innerAPI\(\)/);
  });

  it("the runtime defines changeTheme on the widget", () => {
    assert.match(
      standalone,
      /changeTheme\(e,t\)\{return this\._innerWindow\(\)/
    );
  });

  it("onChartReady still fires SYNCHRONOUSLY once ready", () => {
    // The component relies on this: it flips `widgetReadyRef` from the
    // callback rather than polling.
    assert.match(
      standalone,
      /onChartReady\(e\)\{this\._ready\?e\.call\(this\):this\._readyHandlers\.push\(e\)\}/
    );
  });

  it("ThemeName is still the lowercase union toLibraryThemeName maps to", () => {
    assert.match(typings, /export type ThemeName = "light" \| "dark";/);
  });

  // ── B2: setSymbol's callback is SUCCESS-ONLY, and that is the whole design ──
  //
  // `dispatchWidgetUpdate` returns a promise that never settles on a failed
  // symbol change, and `planWidgetUpdate` recovers on the next differing
  // target rather than on an error. Both follow from the runtime below. If an
  // upgrade ever wires the callback to the error delegates too, the honest fix
  // becomes "react to the failure" and this test is the signal to go do it.
  //
  // The main bundle's name carries a contenthash that moves on every
  // `yarn sync:chart`, so it is RESOLVED from the preload manifest (whose own
  // test already pins it to the file on disk) rather than pasted in — a
  // hard-coded hash would silently stop reading the shipped library.
  const mainBundle = manifest.find((e) =>
    /\/bundles\/library\.[0-9a-f]+\.js$/.test(e.href)
  );
  assert.ok(mainBundle, "no hashed main bundle in the preload manifest");
  const bundle = readFileSync(
    resolve(WEB_ROOT, "public", mainBundle.href.replace(/^\//, "")),
    "utf8"
  );

  it("changeSymbol subscribes the caller's callback to onDataLoaded, once", () => {
    assert.match(
      bundle,
      /changeSymbol\(e,t,i,s="API"\)\{[^}]*i&&this\.activeChart\(\)\.onDataLoaded\(\)\.subscribe\(null,i,!0\)\}/,
      "the completion callback's only subscription is the data-loaded delegate"
    );
  });

  it("onDataLoaded is the COMPLETED delegate — not error, not symbolError", () => {
    assert.match(
      bundle,
      /onDataLoaded\(\)\{return this\._makeSubscriptionFromDelegate\(this\._chartWidget\.model\(\)\.mainSeries\(\)\.dataEvents\(\)\.completed\(\)\)\}/
    );
    // The siblings exist on the SAME object and are deliberately not wired to
    // the callback — so "the symbol failed" is silence, never an argument.
    assert.match(
      bundle,
      /completed\(\)\{return this\._completed\}error\(\)\{return this\._error\}symbolError\(\)\{return this\._symbolError\}/
    );
  });
});
