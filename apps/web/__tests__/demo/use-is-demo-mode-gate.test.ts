/**
 * MONEY-1137 — the CLIENT demo signal must be gated on the authenticated user.
 *
 * Background. Demo state is signalled two ways: an HMAC-signed `sb_demo`
 * cookie (server, authoritative, already proven safe by
 * `__tests__/security/demo-mode-resolver.test.ts` — Clerk always wins there),
 * and `localStorage["tradebook_demo_mode"]` on the client. The localStorage
 * half had no such guarantee: `useIsDemoMode()` called without `user` returned
 * true purely on that flag, so a stale flag left over from an earlier
 * "Try Demo" visit re-armed demo mode for a fully authenticated session.
 *
 * `DemoSessionGuard` is supposed to clear the flag on sign-in and looks
 * correct — but 14 of 41 call sites were passing no `user`, so ANY failure of
 * that one cleanup (private-mode Safari where the remove throws, a tab that
 * never mounted the guard, a cross-device stale flag) degraded real users with
 * no second line of defence. And `isDemoMode` gates far more than the banner:
 *
 *   - `components/FundCompositionSection.tsx` swaps the real
 *     `getFundCompositionAction` call for `getDemoComposition(...)` — invented
 *     holdings and weights, with no banner in that component at all.
 *   - `app/discover/client.tsx` swaps in `MOCK_*_DISCOVER_DATA` *and* sets
 *     `skip: true` on every real fetch.
 *   - `app/stock/[symbol]/client.tsx` hard-codes the sector to
 *     "Financial Services / Diversified".
 *
 * i.e. the failure mode is fabricated portfolio/market data shown to a paying
 * user, not a stray banner.
 *
 * What this file locks down:
 *   1. The decision itself — a real user beats a stale flag (the core
 *      property), asserted against the REAL exported functions, not a copy.
 *   2. Signed-out visitors still get demo mode (the fix must not break the
 *      product's actual demo).
 *   3. No call site anywhere under app/ components/ hooks/ lib/ uses the bare
 *      form — this is what stops a 15th site appearing.
 *   4. The bare form is no longer expressible: `user` is a REQUIRED option, so
 *      omitting it is a compile error rather than a silent downgrade.
 *
 * Source: apps/web/lib/hooks/useIsDemoMode.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  useIsDemoMode,
  readDemoFlagFromStorage,
  resolveClientDemoState,
  DEMO_LOCALSTORAGE_KEY,
  DEMO_LOCALSTORAGE_VALUE,
} from "@/lib/hooks/useIsDemoMode";

const ROOT = join(__dirname, "..", "..");
const HOOK_REL = "lib/hooks/useIsDemoMode.ts";

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// window/localStorage stubbing (no jsdom in this repo — node:test only)
// ---------------------------------------------------------------------------

interface StubGlobal {
  window?: { localStorage: { getItem(key: string): string | null } };
}
const g = globalThis as unknown as StubGlobal;

/** Install a fake `window.localStorage` returning `value` for the demo key. */
function stubStorage(value: string | null): void {
  g.window = {
    localStorage: {
      getItem: (key: string) => (key === DEMO_LOCALSTORAGE_KEY ? value : null),
    },
  };
}

/** Install a `window.localStorage` that throws — private-mode Safari. */
function stubThrowingStorage(): void {
  g.window = {
    localStorage: {
      getItem: () => {
        throw new Error("SecurityError: localStorage is not available");
      },
    },
  };
}

afterEach(() => {
  delete g.window;
});

// A stand-in for the Clerk `UserResource` the call sites hand over. Only `.id`
// is structurally relevant to the gate (it checks truthiness).
const SIGNED_IN_USER = { id: "user_2abcDEF" } as const;

describe("MONEY-1137 — demo signal is gated on the authenticated user", () => {
  // -------------------------------------------------------------------------
  // 1. The core property, end to end: the two real functions composed exactly
  //    the way the hook composes them (effect reads storage → decision).
  // -------------------------------------------------------------------------
  describe("[core] stale localStorage flag + signed-in user", () => {
    it("returns FALSE — a real user is never downgraded to demo", () => {
      stubStorage(DEMO_LOCALSTORAGE_VALUE);

      const clientFlag = readDemoFlagFromStorage();
      assert.equal(clientFlag, true, "precondition: the stale flag IS set");

      assert.equal(
        resolveClientDemoState({
          isDemo: false,
          user: SIGNED_IN_USER,
          clientFlag,
        }),
        false,
        "signed-in user with a stale demo flag must NOT be in demo mode"
      );
    });

    it("returns FALSE for the userId-string form too (useAuth() call sites)", () => {
      stubStorage(DEMO_LOCALSTORAGE_VALUE);
      assert.equal(
        resolveClientDemoState({
          isDemo: false,
          user: "user_2abcDEF",
          clientFlag: readDemoFlagFromStorage(),
        }),
        false,
        "/discover passes useAuth().userId — a string must gate just as well"
      );
    });

    it("[regression] the pre-fix behaviour (no user) would have returned TRUE", () => {
      // Pins exactly what was broken: same storage, no identity signal.
      stubStorage(DEMO_LOCALSTORAGE_VALUE);
      assert.equal(
        resolveClientDemoState({
          isDemo: false,
          user: null,
          clientFlag: readDemoFlagFromStorage(),
        }),
        true,
        "with no user the flag alone still wins — which is why `user` is now required"
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Demo must keep working for real demo visitors.
  // -------------------------------------------------------------------------
  describe("signed-out visitors keep demo mode", () => {
    it("flag set + no user ⇒ TRUE", () => {
      stubStorage(DEMO_LOCALSTORAGE_VALUE);
      assert.equal(
        resolveClientDemoState({
          isDemo: false,
          user: null,
          clientFlag: readDemoFlagFromStorage(),
        }),
        true
      );
    });

    it("flag set + `user: undefined` (Clerk not yet loaded) ⇒ TRUE", () => {
      // useUser() reports `undefined` before Clerk hydrates. Demo visitors sit
      // in that state permanently, so it must behave like signed-out.
      stubStorage(DEMO_LOCALSTORAGE_VALUE);
      assert.equal(
        resolveClientDemoState({
          isDemo: false,
          user: undefined,
          clientFlag: readDemoFlagFromStorage(),
        }),
        true
      );
    });

    it("no flag + no user ⇒ FALSE (ordinary signed-out visitor)", () => {
      stubStorage(null);
      assert.equal(
        resolveClientDemoState({
          isDemo: false,
          user: null,
          clientFlag: readDemoFlagFromStorage(),
        }),
        false
      );
    });

    it("the authoritative server `isDemo` still wins outright", () => {
      // `isDemo` originates from `resolveDemoState`, which already returns
      // false whenever a Clerk session exists (see demo-mode-resolver.test.ts),
      // so `isDemo === true` implies "no real user" by construction.
      stubStorage(null);
      assert.equal(
        resolveClientDemoState({
          isDemo: true,
          user: null,
          clientFlag: false,
        }),
        true
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. The localStorage read itself (the half the effect runs).
  // -------------------------------------------------------------------------
  describe("readDemoFlagFromStorage", () => {
    it('only "true" counts — the drifted "1" writer does not', () => {
      stubStorage("1");
      assert.equal(readDemoFlagFromStorage(), false);
    });

    it("a missing key is false", () => {
      stubStorage(null);
      assert.equal(readDemoFlagFromStorage(), false);
    });

    it("returns false (never throws) when localStorage is blocked", () => {
      stubThrowingStorage();
      assert.doesNotThrow(() => readDemoFlagFromStorage());
      assert.equal(readDemoFlagFromStorage(), false);
    });

    it("returns false with no `window` at all (SSR)", () => {
      delete g.window;
      assert.equal(readDemoFlagFromStorage(), false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. No shadow: the hook must actually delegate to the functions above.
  // -------------------------------------------------------------------------
  describe("the hook delegates to the tested functions (no second copy)", () => {
    const hookSrc = read(HOOK_REL);

    it("the mount effect reads the flag via readDemoFlagFromStorage", () => {
      assert.match(
        hookSrc,
        /setClientFlag\(readDemoFlagFromStorage\(\)\)/,
        "the effect must call the exported reader, not re-inline getItem"
      );
    });

    it("the hook returns resolveClientDemoState(...)", () => {
      assert.match(
        hookSrc,
        /return resolveClientDemoState\(\{\s*isDemo,\s*user,\s*clientFlag\s*\}\)/,
        "the hook must return the exported decision, not re-inline the branches"
      );
    });

    it("only one comparison against the localStorage key exists", () => {
      const comparisons = hookSrc.match(/DEMO_LOCALSTORAGE_VALUE/g) ?? [];
      // One in the const declaration, one in readDemoFlagFromStorage.
      assert.equal(
        comparisons.length,
        2,
        "a second comparison means the key/value check has been duplicated"
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Repo-wide call-site scan — the guard against a 15th ungated site.
  // -------------------------------------------------------------------------
  describe("no call site uses the bare useIsDemoMode() form", () => {
    /**
     * Strip comments so JSDoc/inline usage examples aren't read as calls.
     *
     * LINE comments first, then BLOCK comments — the order is load-bearing and
     * this file got it backwards at first. A `//` comment containing `/*`
     * (e.g. `Sidebar.tsx`'s line mentioning `tours/*`) opens a phantom block
     * that runs to the next `*` + `/` hundreds of lines away. Measured on the
     * real tree, block-first deleted 11,192 characters from `Sidebar.tsx`
     * alone — taking `NavLink`, `CollapsibleNavItem` and a real
     * `useIsDemoMode(` call site with them — and 26,686 characters across 22
     * files. The `callSites.length >= 30` liveness guard below does NOT catch
     * it (40 survivors still clear 30).
     *
     * That is the worst failure mode for a scan whose whole job is to prove an
     * absence: the text is eaten, nothing is found, and the test reports
     * success. Mutation-checked — reverting a call site to the bare
     * `useIsDemoMode()` form is MISSED under block-first and CAUGHT under this
     * ordering.
     */
    function stripComments(src: string): string {
      return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    }

    function walk(dir: string, acc: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, acc);
        else if (/\.tsx?$/.test(entry)) acc.push(full);
      }
      return acc;
    }

    /** Extract each `useIsDemoMode(...)` invocation with balanced parens. */
    function extractCalls(src: string): string[] {
      const needle = "useIsDemoMode(";
      const calls: string[] = [];
      let i = src.indexOf(needle);
      while (i !== -1) {
        let depth = 0;
        let end = -1;
        for (let j = i + needle.length - 1; j < src.length; j++) {
          if (src[j] === "(") depth++;
          else if (src[j] === ")" && --depth === 0) {
            end = j;
            break;
          }
        }
        if (end === -1) break;
        // Skip the declaration itself (`export function useIsDemoMode(...)`).
        if (!/function\s+$/.test(src.slice(Math.max(0, i - 12), i))) {
          calls.push(src.slice(i, end + 1));
        }
        i = src.indexOf(needle, end);
      }
      return calls;
    }

    const files = ["app", "components", "hooks", "lib"].flatMap((d) =>
      walk(join(ROOT, d))
    );

    const callSites: { file: string; call: string }[] = [];
    for (const file of files) {
      if (file.endsWith(HOOK_REL.replace(/\//g, "/"))) continue; // the hook itself
      for (const call of extractCalls(
        stripComments(readFileSync(file, "utf8"))
      )) {
        callSites.push({ file: file.slice(ROOT.length + 1), call });
      }
    }

    it("[meta] stripComments cannot swallow the code under scan", () => {
      // Reproduces the ordering bug directly, on input that triggers it. The
      // liveness check below does NOT substitute for this: block-first strips
      // 11,192 chars from Sidebar.tsx and still leaves 40 call sites, clearing
      // the >= 30 floor while having silently discarded real ones.
      const fixture = [
        "const a = 1;",
        "// a line comment mentioning tours/* which opens nothing",
        "const keep = useIsDemoMode({ user });",
        "/* a real block */",
        "const b = 2;",
      ].join("\n");

      const stripped = stripComments(fixture);
      assert.match(
        stripped,
        /useIsDemoMode\(\{ user \}\)/,
        "stripComments must remove LINE comments before BLOCK comments — " +
          "otherwise a `//` comment containing `/*` swallows every call site " +
          "up to the next `*/` and the absence assertions become unfalsifiable"
      );
      assert.doesNotMatch(stripped, /a real block/);
      assert.doesNotMatch(stripped, /a line comment/);
    });

    it("the scan actually found the call sites (not a vacuous pass)", () => {
      // MONEY-1093's lesson: a scan that silently matches nothing passes.
      assert.ok(
        callSites.length >= 30,
        `expected 30+ useIsDemoMode call sites, found ${callSites.length} — the walker is broken`
      );
    });

    it("every call site passes a `user` option", () => {
      const ungated = callSites.filter((c) => !/\buser\s*[:,}]/.test(c.call));
      assert.deepEqual(
        ungated.map((c) => `${c.file}: ${c.call}`),
        [],
        "these call sites read the demo flag without gating on the signed-in user"
      );
    });

    it("no call site is the bare zero-argument form", () => {
      const bare = callSites.filter((c) =>
        /^useIsDemoMode\(\s*\)$/.test(c.call)
      );
      assert.deepEqual(
        bare.map((c) => c.file),
        []
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Task 2 — the unsafe form is unreachable, enforced by the type checker.
  // -------------------------------------------------------------------------
  describe("the unsafe form no longer type-checks", () => {
    const hookSrc = read(HOOK_REL);

    it("`user` is declared REQUIRED on UseIsDemoModeOptions", () => {
      assert.match(
        hookSrc,
        /^\s{2}user: DemoModeUser;$/m,
        "`user?:` would make omitting it legal again"
      );
      assert.doesNotMatch(hookSrc, /^\s{2}user\?:/m);
    });

    it("the options parameter has no default, so a bare call is arity-0", () => {
      assert.match(
        hookSrc,
        /export function useIsDemoMode\(\s*opts: UseIsDemoModeOptions\s*\): boolean/
      );
      assert.doesNotMatch(
        hookSrc,
        /useIsDemoMode\(\s*opts: UseIsDemoModeOptions = \{\}/,
        "a `= {}` default silently restores the bare form"
      );
    });

    it("DemoModeUser rejects booleans (the plausible wrong signal)", () => {
      // `{ user: isSignedIn }` reads fine and is wrong in both directions.
      assert.doesNotMatch(hookSrc, /export type DemoModeUser[^;]*boolean/);
    });

    /**
     * `user` must be REQUIRED on the options type — that requirement is the
     * entire enforcement mechanism for MONEY-1137, since it is what turns a
     * forgotten gate into a compile error at the other 41 call sites.
     *
     * Asserted against the SOURCE rather than with `@ts-expect-error` probes,
     * because those probes do not run here and would be false comfort: `tsx`
     * transpiles without type-checking, and `apps/web` declares no
     * `check-types` script, so `turbo run check-types` skips this workspace
     * entirely. Only `next build` would ever evaluate them. An earlier version
     * of this test paired them with `assert.equal(safe.length, 4)` — literally
     * `4 === 4` — so it passed whatever the types said.
     */
    it("[regression] `user` is a REQUIRED option, not optional", () => {
      const iface = hookSrc.slice(
        hookSrc.indexOf("export interface UseIsDemoModeOptions")
      );
      const body = iface.slice(0, iface.indexOf("\n}"));

      assert.match(
        body,
        /^\s*user:\s*DemoModeUser;/m,
        "`user` must be declared `user: DemoModeUser` — an optional `user?:` " +
          "silently re-opens every call site that forgets the gate"
      );
      assert.doesNotMatch(
        body,
        /user\?:/,
        "`user?:` is the exact regression MONEY-1137 exists to prevent"
      );
      // `isDemo` stays optional by design — server-aware surfaces pass it,
      // client-only ones cannot. Pinned so the two are not conflated.
      assert.match(body, /isDemo\?:\s*boolean;/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useFeatureFlags — the SAME bug class, in the consumer that gates the paywall
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `useIsDemoMode` was hardened first, and it is not the dangerous one.
 *
 * `useFeatureFlags` keeps its OWN demo read, and `PageGuard` feeds that value
 * into `computeGuardDecision`, whose demo branch returns NO_GATE for every
 * non-kill-switch route — skipping the plan check entirely. So an un-gated
 * localStorage read there is not a cosmetic banner bug, it is a self-service
 * premium bypass: a signed-in FREE user setting `tradebook_demo_mode=true` in
 * devtools opened `/risk`, `/tax` and `/documents`, and neither
 * `getPortfolioRiskAction` nor `getTaxReportAction` re-checks the tier
 * server-side, so real premium analysis came back.
 *
 * It also could not self-heal: the old code early-returned out of the
 * Clerk-dependent effect whenever the flag was set, so the true flags were
 * never fetched.
 *
 * Source-level, matching this file's convention — the hook needs Clerk +
 * React and cannot be imported into node:test.
 */
describe("MONEY-1137 — useFeatureFlags gates its demo read on the user too", () => {
  const flagsSrc = readFileSync(
    join(ROOT, "lib/hooks/useFeatureFlags.ts"),
    "utf8"
  );

  it("[regression] does not read the localStorage key directly", () => {
    // A raw `localStorage.getItem("tradebook_demo_mode")` here is the bug:
    // it is the read that bypasses the user gate. Go through the shared
    // helper, which is the only copy of the key/value comparison.
    assert.doesNotMatch(
      flagsSrc,
      /localStorage\.getItem\(\s*["']tradebook_demo_mode["']\s*\)/,
      "read the flag via readDemoFlagFromStorage() so the gate cannot be skipped"
    );
    assert.match(flagsSrc, /readDemoFlagFromStorage/);
  });

  it("[regression] resolves demo state through the shared precedence helper", () => {
    // Sharing `resolveClientDemoState` with useIsDemoMode is what guarantees
    // the two hooks cannot drift — which is how they diverged in the first
    // place.
    assert.match(
      flagsSrc,
      /resolveClientDemoState\(\{[\s\S]{0,200}?user:/,
      "useFeatureFlags must resolve demo state through the shared helper, " +
        "passing the authenticated user"
    );
  });

  it("[regression] passes the REAL user once Clerk has loaded", () => {
    // `isUserLoaded ? (user ?? null) : null` is deliberate: before Clerk
    // resolves we must not claim "no user" as a decision (that would be
    // indistinguishable from signed-out), and after it resolves a real user
    // must force demo off.
    assert.match(
      flagsSrc,
      /user:\s*isUserLoaded\s*\?\s*\(?user\s*\?\?\s*null\)?\s*:\s*null/,
      "the user must be threaded in only once Clerk has loaded"
    );
  });

  it("[regression] demo state is derived, not stored in useState", () => {
    // Storing it is what made the old bug unrecoverable: the value was written
    // once on mount, before Clerk loaded, and nothing recomputed it.
    assert.doesNotMatch(
      flagsSrc,
      /const \[isDemoMode, setIsDemoMode\] = useState/,
      "isDemoMode must be derived from the user on every render, not latched " +
        "at mount time when Clerk has not resolved yet"
    );
    assert.match(flagsSrc, /const isDemoMode = resolveClientDemoState\(/);
  });

  it("re-reads the flag when the demo session ends", () => {
    // Same-tab writes do not fire `storage`, so the explicit event is the only
    // signal that DemoSessionGuard cleared the flag after a sign-in.
    assert.match(flagsSrc, /DEMO_SESSION_ENDED_EVENT/);
    assert.match(flagsSrc, /addEventListener\("storage"/);
  });
});
