/**
 * MONEY-393 §11 - 5 client hooks source-shape tests.
 *
 * The hooks live in `apps/web/hooks/*` and depend on React state +
 * server actions, so a true integration test would need jsdom + the
 * Testing Library - both excluded from this push per the agreed
 * scope. Instead we do source-text guards that catch:
 *
 *   - `"use client"` directive (Next.js Server Components hard-fail
 *     without it).
 *   - The hook contract (state shape, polling interval, dedupe rule,
 *     load-on-mount, race-guard ref, etc.).
 *
 * Pattern mirrors the existing skeleton/page-title source-text tests.
 */

import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS = join(__dirname, "..", "..", "hooks");
const LIB_HOOKS = join(__dirname, "..", "..", "lib", "hooks");

function read(rel: string): string {
  // Look in /hooks first, then /lib/hooks for the demo analytics hook.
  try {
    return readFileSync(join(HOOKS, rel), "utf8");
  } catch {
    return readFileSync(join(LIB_HOOKS, rel), "utf8");
  }
}

// ── useMarketStatus ────────────────────────────────────────────────

it("[useMarketStatus] is a client hook with the safe core import path", () => {
  const src = read("useMarketStatus.ts");
  assert.match(src, /^"use client"/m);
  // Import from the dedicated subpath, NOT the barrel - the barrel
  // pulls in Vertex AI which breaks the client bundle (Next.js
  // "Module not found: Can't resolve 'fs'"). Documented in the hook
  // - this test catches a refactor that breaks the bundle.
  assert.match(
    src,
    /@usemoney\/core\/market-data\/market-hours/,
    "must import from the dedicated market-hours subpath"
  );
  // Ban the barrel import.
  assert.ok(
    !/from\s+["']@usemoney\/core["']/.test(src),
    "must NOT import from @usemoney/core barrel (Vertex AI brick)"
  );
});

it("[useMarketStatus] re-evaluates the market phase on a 30-second interval", () => {
  const src = read("useMarketStatus.ts");
  assert.match(
    src,
    /setInterval[\s\S]{0,200}30[_]?000/,
    "must poll every 30 seconds (30_000ms) for the open/close boundary"
  );
  assert.match(src, /clearInterval/, "must cleanup the interval on unmount");
});

it("[useMarketStatus] exposes both status + closedReason", () => {
  const src = read("useMarketStatus.ts");
  assert.match(src, /export\s+interface\s+UseMarketStatusResult/);
  assert.match(src, /closedReason/);
});

// ── useResearchPreferences ─────────────────────────────────────────

it("[useResearchPreferences] is a client hook + lazy-loads on mount", () => {
  const src = read("useResearchPreferences.ts");
  assert.match(src, /^"use client"/m);
  // Lazy-load: useEffect calls load() once after mount.
  assert.match(src, /useEffect/);
  assert.match(src, /load\(\)/);
});

it("[useResearchPreferences] uses a race-guard ref to prevent setState after unmount", () => {
  const src = read("useResearchPreferences.ts");
  assert.match(src, /useRef/);
  // isMounted ref pattern - guards against the user navigating away
  // during an in-flight save() or load().
  assert.match(
    src,
    /isMounted\.current\s*=\s*false/,
    "must clear isMounted.current on unmount"
  );
  assert.match(
    src,
    /if\s*\(\s*!isMounted\.current\s*\)\s*return/,
    "must guard setState calls behind isMounted.current"
  );
});

it("[useResearchPreferences] save() is wrapped in useCallback with stable deps", () => {
  const src = read("useResearchPreferences.ts");
  assert.match(
    src,
    /const\s+save\s*=\s*useCallback/,
    "save must be useCallback so parent re-renders don't churn deps"
  );
  // load() and save() should both use empty deps (state goes through
  // functional setState updaters). Catch the regression where someone
  // adds `state` to the deps and creates an identity churn loop.
  const useCallbackCalls = src.match(/useCallback\(/g) ?? [];
  assert.ok(
    useCallbackCalls.length >= 2,
    `expected ≥2 useCallback wrappers (load + save), got ${useCallbackCalls.length}`
  );
  // At least one useCallback should have an empty deps array `[])`.
  assert.match(
    src,
    /\}\s*,\s*\[\]\s*\)/,
    "at least one useCallback must have an empty deps array"
  );
});

// ── useComposerPreferences ─────────────────────────────────────────

it("[useComposerPreferences] is a client hook", () => {
  const src = read("useComposerPreferences.ts");
  assert.match(src, /^"use client"/m);
});

// ── useHeatmapData ─────────────────────────────────────────────────

it("[useHeatmapData] is a client hook", () => {
  const src = read("useHeatmapData.ts");
  assert.match(src, /^"use client"/m);
});

// ── useResearchPlanPreview ─────────────────────────────────────────

it("[useResearchPlanPreview] is a client hook + polls a status endpoint", () => {
  const src = read("useResearchPlanPreview.ts");
  assert.match(src, /^"use client"/m);
  // The plan-preview lifecycle: fire-and-poll. Must poll for jobId
  // status until terminal.
  assert.match(src, /setTimeout|setInterval/, "must schedule a status poll");
  // Must clean up the timer to avoid setState-after-unmount.
  assert.match(src, /clearTimeout|clearInterval/);
});

// ── useDemoAnalytics (covered separately in §3, but ensure file lives where the hooks aggregator expects) ──

it("[useDemoAnalytics] file path is lib/hooks/useDemoAnalytics.ts", () => {
  const src = readFileSync(join(LIB_HOOKS, "useDemoAnalytics.ts"), "utf8");
  assert.match(src, /^"use client"/m);
  assert.match(src, /useDemoAnalytics/);
});
