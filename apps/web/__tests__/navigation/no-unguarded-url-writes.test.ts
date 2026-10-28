/**
 * Unguarded URL writes are BANNED in app source — MONEY-1082.
 *
 * ## What shipped, and why nothing caught it
 *
 * Navigating away from a page while it still had work in flight dropped the
 * user back on the page they had just left. App Router navigations run inside
 * `startTransition`, so the outgoing page stays mounted and re-rendering until
 * the next route's RSC payload arrives; a URL write issued from that stale
 * context re-asserts the old route.
 *
 * `/discover/screener` hit this FIRST and fixed it locally — an inline
 * pathname guard plus a comment. Nothing propagated: eight sibling sites kept
 * the pattern, and no test pinned the invariant. Worse, the comment asserted a
 * framework behaviour ("plain history.replaceState never affects Next's
 * routing state") that nobody verified, so two later call sites copied the
 * idea WITHOUT `window.history.state` and became live navigations.
 *
 * This scan is the propagation the original fix lacked. It mirrors
 * `__tests__/ui/no-native-dialogs.test.ts` (MONEY-764), which exists for the
 * same reason: a defect class fixed site-by-site comes back unless the suite
 * refuses it.
 *
 * ## Rule 1 — history writes must forward `window.history.state`
 *
 * Next patches `pushState`/`replaceState` and only skips its router dispatch
 * when the state object carries the `__NA` marker it stamps on its own history
 * entries (`next/dist/client/components/app-router.js`). Called with `{}` or
 * `null`, the patch runs `applyUrlFromHistoryPushReplace` -> ACTION_RESTORE —
 * a real navigation wearing a history-API costume.
 *
 * ## Rule 2 — `router.replace()` inside `useEffect` needs a route guard
 *
 * That is the shape that fires mid-transition. Use `useOwnedRoute`, whose
 * `replaceRoute` drops the call when the live pathname is no longer the
 * caller's. Scoped to `replace` (not `push`): `replace` is the in-place
 * URL-sync / redirect shape behind the yank-back, whereas effect-driven
 * `router.push` is overwhelmingly the auth gate deliberately sending signed-
 * out users to /home — a different, intended behaviour.
 *
 * Both rules carry an explicit allowlist. Adding an entry is fine; doing it
 * silently is not — each needs a reason recorded here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// CWD is apps/web (the package's test script runs from there).
const SCAN_ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tests__",
  "archive", // parked legacy components are not shipped
  "datafeeds", // vendored TradingView UDF sources
]);
const SOURCE_EXT = /\.(ts|tsx)$/;

/**
 * `history.pushState(` / `history.replaceState(` whose first argument is
 * `{}`, `{ ... }` or `null` — i.e. anything other than a forwarded state.
 * The compliant call is `replaceState(window.history.state, "", url)`.
 */
const BARE_HISTORY_STATE =
  /\bhistory\.(?:pushState|replaceState)\s*\(\s*(?:null|\{)/;

/** Any history write, used to confirm the compliant form is what remains. */
const ANY_HISTORY_WRITE = /\bhistory\.(?:pushState|replaceState)\s*\(/;

/**
 * Files permitted to write history with a literal state object, with the
 * reason. Empty today — every known site was migrated in MONEY-1082.
 */
const HISTORY_STATE_ALLOWLIST: Record<string, string> = {};

/**
 * Files permitted to call `router.replace()` inside a `useEffect`, with the
 * reason each is safe. All are one-shot redirects fired from a stable,
 * ref-guarded condition rather than from data arriving late.
 */
const EFFECT_REPLACE_ALLOWLIST: Record<string, string> = {
  // MONEY-1130 removed the "app/client.tsx" entry along with the file. The root
  // route is no longer a client-side redirector: `/` serves the prerendered
  // marketing landing and the signed-in redirect moved into proxy.ts.
  "app/brokers/client.tsx":
    "OAuth callback one-shot, gated by hasShownToast.current + the " +
    "module-level oauthToastHandled flag. Strips ?success=/?error= once, on " +
    "mount, before any navigation could be in flight.",
  "app/settings/client.tsx":
    "Payment-callback one-shot, gated by handledPaymentRef. Strips " +
    "?payment=/?paymentId= once on mount (MONEY-1074).",
  "components/PageGuard.tsx":
    "Kill-switch redirect to /dashboard, derived synchronously from feature " +
    "flags via computeGuardDecision — not from a late async result.",
};

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(entry)) yield full;
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) out.push(...walk(root));
  return out;
}

/**
 * Find `router.replace(` calls that sit inside a `useEffect(...)` body, by
 * brace-matching from the effect's opening `{`. Returns 1-based line numbers.
 */
function effectScopedRouterReplaces(src: string): number[] {
  const found: number[] = [];
  const effectRe = /useEffect\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = effectRe.exec(src)) !== null) {
    // The callback body's opening brace, if this effect has one nearby.
    const open = src.indexOf("{", match.index + match[0].length);
    if (open === -1 || open - match.index > 200) continue;

    let depth = 0;
    let close = src.length;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }

    const body = src.slice(open, close);
    const callRe = /\brouter\.replace\s*\(/g;
    let call: RegExpExecArray | null;
    while ((call = callRe.exec(body)) !== null) {
      const absolute = open + call.index;
      found.push(src.slice(0, absolute).split("\n").length);
    }
  }
  return found;
}

describe("no unguarded URL writes in app source (MONEY-1082)", () => {
  it("history.pushState/replaceState always forwards window.history.state", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (HISTORY_STATE_ALLOWLIST[file]) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (BARE_HISTORY_STATE.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      "history writes must forward `window.history.state` so Next's `__NA` " +
        "marker survives; `{}` / `null` turns the write into an " +
        "ACTION_RESTORE navigation. Prefer useOwnedRoute().syncParams.\n" +
        offenders.join("\n")
    );
  });

  it("the compliant history-write form is actually present (scan is live)", () => {
    // Guards against the scan silently passing because the regex stopped
    // matching anything at all — e.g. after a rename of the history API use.
    const writers = sourceFiles().filter((f) =>
      ANY_HISTORY_WRITE.test(readFileSync(f, "utf8"))
    );
    assert.ok(
      writers.length > 0,
      "expected at least one history write in app source; if these were all " +
        "removed, delete this scan rather than letting it pass vacuously"
    );
  });

  it("router.replace() inside useEffect is guarded or explicitly allowlisted", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (EFFECT_REPLACE_ALLOWLIST[file]) continue;
      const src = readFileSync(file, "utf8");
      for (const line of effectScopedRouterReplaces(src)) {
        offenders.push(`${file}:${line}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "router.replace() in an effect can fire mid-transition and yank the " +
        "user back to the page they left. Use useOwnedRoute().replaceRoute, " +
        "or add the file to EFFECT_REPLACE_ALLOWLIST with a reason.\n" +
        offenders.join("\n")
    );
  });

  it("every allowlisted file still exists and still has the pattern", () => {
    // A stale allowlist entry is a silent hole: it would also excuse a NEW
    // unguarded call added to that file later. Fail once the reason is gone.
    const stale: string[] = [];

    for (const file of Object.keys(EFFECT_REPLACE_ALLOWLIST)) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        stale.push(`${file} (missing — drop the allowlist entry)`);
        continue;
      }
      if (effectScopedRouterReplaces(src).length === 0) {
        stale.push(`${file} (no effect-scoped router.replace left — drop it)`);
      }
    }

    assert.deepEqual(stale, [], stale.join("\n"));
  });
});
