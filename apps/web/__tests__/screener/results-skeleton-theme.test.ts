/**
 * MONEY-392: Screener result skeletons must use theme-aware tokens, not
 * dark-only `bg-white/[...]` / `bg-black/[...]` patterns. Also asserts the
 * filter-change loading behavior in stocks/mf/etf modes always uses the full
 * skeleton (matches the roast page experience).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const resultsSkeletonSrc = read("components/screener/ResultsSkeleton.tsx");
const screenerLoadingSrc = read("app/discover/screener/loading.tsx");
const marketsLoadingSrc = read("app/discover/markets/loading.tsx");
const stocksModeSrc = read("app/discover/screener/stocks-mode.tsx");
const mfModeSrc = read("app/discover/screener/mf-mode.tsx");
const etfModeSrc = read("app/discover/screener/etf-mode.tsx");

describe("MONEY-392 - screener skeletons + loaders", () => {
  describe("ResultsSkeleton component (theme-aware)", () => {
    it("does not use dark-only bg-white/[...] tokens", () => {
      // Allow `dark:bg-white/...` (intentionally theme-scoped) but not
      // plain `bg-white/[...]` which only renders on dark theme.
      assert.equal(
        /[^:]bg-white\/\[/.test(resultsSkeletonSrc),
        false,
        "ResultsSkeleton still uses bg-white/[...] dark-only color"
      );
    });

    it("uses theme-aware CSS-var tokens for shimmer fills (MONEY-485 playful redesign)", () => {
      // MONEY-485 moved the screener skeletons off `bg-muted/*` onto the playful
      // CSS-var design tokens (--rule-soft / --rule-softer / --emerald-bg /
      // --emerald). Those are defined per-theme, so the shimmer still adapts in
      // both light + dark — the exact "theme-aware, never a hardcoded color"
      // guarantee this test protects, just expressed via CSS vars instead of
      // Tailwind's bg-muted.
      assert.ok(
        /var\(--(rule-soft|rule-softer|emerald-bg|emerald)\)/.test(
          resultsSkeletonSrc
        ),
        "ResultsSkeleton must use theme-aware CSS-var tokens (var(--rule-soft) etc.) for fills"
      );
      // ...and must NOT hardcode a fixed hex fill that ignores the active theme.
      assert.equal(
        /background:\s*["']#[0-9a-fA-F]{3,8}/.test(resultsSkeletonSrc),
        false,
        "ResultsSkeleton must not hardcode a hex fill (use theme-aware CSS vars)"
      );
    });
  });

  describe("Screener route-level loading.tsx (theme-aware)", () => {
    it("does not use dark-only bg-white/[...] tokens", () => {
      assert.equal(/[^:]bg-white\/\[/.test(screenerLoadingSrc), false);
    });
  });

  describe("Markets route-level loading.tsx (theme-aware)", () => {
    it("does not use dark-only bg-white/[...] tokens", () => {
      assert.equal(/[^:]bg-white\/\[/.test(marketsLoadingSrc), false);
    });
  });

  describe("Filter-change loading behavior", () => {
    it("stocks-mode shows full skeleton on every filter change", () => {
      // The bug pattern was `loading && pageRows.length === 0 ? <ResultsSkeleton/>`
      // which only showed skeleton on first load. Fixed to `loading ? <ResultsSkeleton/>`.
      assert.equal(
        stocksModeSrc.includes("loading && pageRows.length === 0"),
        false,
        "stocks-mode still gates skeleton on pageRows.length === 0 - should show on every load"
      );
      assert.ok(
        stocksModeSrc.includes("{loading ? ("),
        "stocks-mode must show <ResultsSkeleton/> whenever loading is true"
      );
    });

    it("mf-mode shows full skeleton on every filter change", () => {
      assert.equal(
        mfModeSrc.includes("loading && pageRows.length === 0"),
        false,
        "mf-mode still gates skeleton on pageRows.length === 0"
      );
    });

    it("etf-mode shows full skeleton on every filter change", () => {
      assert.equal(
        etfModeSrc.includes("loading && pageRows.length === 0"),
        false,
        "etf-mode still gates skeleton on pageRows.length === 0"
      );
    });
  });
});
