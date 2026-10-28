/**
 * The popover must not publish a member count it has not fetched.
 *
 * ## The bug
 *
 * `WatchlistPopover` holds `lists` in `useState([])` and derives
 * `memberCount = lists.filter(...).length`, so the count is 0 until the
 * popover has actually fetched — and it only fetches when OPENED. Its
 * "surface the count to the parent" effect fired on MOUNT with that 0.
 *
 * The screener cards consume it as:
 *
 *     const memberCount = overrideCount ?? countFor(symbol, exchange, kind)
 *
 * `??` falls through on null/undefined but NOT on 0. So the uninitialised 0
 * became a PERMANENT override: every card pinned itself to "+ Watch" and
 * `countFor` was never consulted again, even once membership loaded. MONEY-1253
 * fetched, cached and matched correctly the whole time — and had its answer
 * discarded one render later. Verified on a real account whose lists should
 * have shown "In 2" / "In 1" / "In 1" and showed "+ Watch" on every card.
 *
 * ## Why a source scan
 *
 * The defect lives in an effect's firing conditions across two components.
 * There is no React test harness in this repo (no jsdom, no testing-library),
 * so the behaviour cannot be driven directly, and a hand-rolled fake would
 * assert things about the fake. What CAN be pinned is the guard itself — and
 * it is a one-line early return that looks removable to anyone who has not hit
 * the bug, which is exactly what a scan is for.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const POPOVER = read("components/watchlist/WatchlistPopover.tsx");
const STOCK_CARD = read("components/screener/StockCardCompact.tsx");
const FUND_CARD = read("components/screener/FundCardCompact.tsx");

/** Body of the effect that calls `onMembershipChange`. */
function membershipEffectBody(src: string): string {
  const call = src.indexOf("onMembershipChange?.(");
  assert.notEqual(call, -1, "the popover no longer surfaces a member count");
  // Walk back to the `useEffect(` that owns this call.
  const start = src.lastIndexOf("useEffect(", call);
  assert.notEqual(start, -1, "the call is no longer inside a useEffect");
  return src.slice(start, call);
}

describe("WatchlistPopover — membership callback is gated on a real fetch", () => {
  test("[regression] the effect returns early before it has fetched", () => {
    // `cachedFor` is set ONLY inside `refresh`, after a successful response,
    // so it is the marker for "this popover has real data". Without this
    // guard the popover publishes its uninitialised 0 on mount.
    const body = membershipEffectBody(POPOVER);
    assert.match(
      body,
      /if\s*\(\s*cachedFor\s*===\s*null\s*\)\s*return/,
      "onMembershipChange must not fire before `cachedFor` is set — an " +
        "unfetched 0 permanently overrides the screener cards' own count"
    );
  });

  test("`cachedFor` is only set after a successful fetch", () => {
    // If it were initialised to a non-null value, or set before the response,
    // the guard above would pass while still publishing an unfetched count.
    assert.match(
      POPOVER,
      /useState<string \| null>\(null\)/,
      "cachedFor must start null"
    );
    const refresh = POPOVER.slice(
      POPOVER.indexOf("const refresh = useCallback"),
      POPOVER.indexOf("const refresh = useCallback") + 600
    );
    const setAt = refresh.indexOf("setCachedFor(");
    const okAt = refresh.indexOf("res.success && res.data");
    assert.ok(setAt > -1 && okAt > -1 && setAt > okAt, "set only on success");
  });

  test("the effect depends on cachedFor, so the first real count publishes", () => {
    // Gating without adding the dep would latch: the effect would never re-run
    // when `cachedFor` flips, so the count would never reach the card at all —
    // the same blank outcome by the opposite mistake.
    const src = POPOVER.slice(POPOVER.indexOf("onMembershipChange?.("));
    const deps = src.slice(
      src.indexOf("}, ["),
      src.indexOf("]", src.indexOf("}, ["))
    );
    assert.match(deps, /cachedFor/);
    assert.match(deps, /memberCount/);
  });
});

describe("screener cards — the `??` coupling this guard protects", () => {
  for (const [name, src] of [
    ["StockCardCompact", STOCK_CARD],
    ["FundCardCompact", FUND_CARD],
  ] as const) {
    test(`${name} still applies the override with ?? (0 wins)`, () => {
      // Not a style preference: `??` is what makes an unfetched 0 permanent,
      // and it is why the popover-side guard is required. If a card ever
      // switches to `||`, a legitimate 0 from the popover would be discarded
      // instead — the opposite bug — so both halves must move together.
      assert.match(
        src,
        /overrideCount \?\?\s*\n?\s*countFor\(/,
        `${name} changed how it applies overrideCount — re-check the popover guard`
      );
    });
  }
});
