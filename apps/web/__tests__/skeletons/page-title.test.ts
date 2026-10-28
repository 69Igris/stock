/**
 * MONEY-392 (revised post-MONEY-485 / Task B): each route's loading.tsx
 * surfaces the page identity (title + optional breadcrumb) so the page
 * name is visible immediately. After the playful redesign, the SHELL
 * (`PageLoadingWrapper` → `PageSkeletonShell`) no longer renders the
 * title/breadcrumb itself — the page's own skeleton/hero owns that — but
 * the props are still accepted for API compatibility with the ~40
 * existing callers, and the shell container width still matches the
 * hydrated app shell so there's no layout jump.
 *
 * This test asserts that the wrapper still declares the props, delegates
 * to the shared shell at the canonical 1600px width, and that each major
 * loading.tsx surfaces its title/breadcrumb (prop OR inline JSX).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("MONEY-392 - page title in loading skeletons", () => {
  describe("PageLoadingWrapper signature", () => {
    const src = read("components/skeletons/index.tsx");
    it("accepts a title prop", () => {
      assert.ok(src.includes("title?: string"));
    });
    it("accepts a breadcrumb prop", () => {
      assert.ok(src.includes("breadcrumb?: string"));
    });
    it("delegates to the shared PageSkeletonShell (Task B: no own title/breadcrumb header)", () => {
      // Post-Task B the wrapper renders ONLY the shared shell — the
      // page skeleton/hero owns the title. The wrapper body must
      // delegate to PageSkeletonShell so stage-1 (loading.tsx) and
      // stage-2 (PageGuard fallback) are pixel-identical.
      const wrapperDeclIdx = src.indexOf("export function PageLoadingWrapper");
      assert.ok(wrapperDeclIdx !== -1, "PageLoadingWrapper must exist");
      const wrapperRegion = src.slice(wrapperDeclIdx, wrapperDeclIdx + 600);
      assert.ok(
        /return <PageSkeletonShell>\{children\}<\/PageSkeletonShell>;/.test(
          wrapperRegion
        ),
        "PageLoadingWrapper must delegate to PageSkeletonShell"
      );
    });
    it("shared shell container width matches TerminalLuxeShell (max-w-[1600px])", () => {
      // The PageSkeletonShell (used by PageLoadingWrapper AND PageGuard's
      // fallback) and TerminalLuxeShell must use the SAME default
      // max-width so users don't see a layout jump between loading and
      // hydrated states.
      const shellDefault = src.match(
        /export function PageSkeletonShell[\s\S]{0,1500}?max-w-\[(\d+)px\]/
      )?.[1];
      assert.equal(
        shellDefault,
        "1600",
        "PageSkeletonShell default container must use max-w-[1600px] (matches TerminalLuxeShell)"
      );
    });
  });

  describe("PageGuard fallback container parity", () => {
    const src = read("components/PageGuard.tsx");
    it("renders the same max-w-[1600px] container", () => {
      assert.ok(
        src.includes("max-w-[1600px]"),
        "PageGuard fallback must use max-w-[1600px] (matches TerminalLuxeShell + PageLoadingWrapper)"
      );
    });
    it("renders the title with same h1 styling as the wrapper", () => {
      // The ComingSoon / Upgrade fallback branches render the page name
      // in an h1 with the Terminal-Luxe heading scale. (`font-bold` sits
      // between the size + tracking utilities.)
      assert.ok(src.includes("text-[28px] font-bold tracking-[-0.5px]"));
    });
    it("PAGE_CONFIG includes breadcrumb field", () => {
      assert.ok(src.includes("breadcrumb: string"));
    });
  });

  describe("Loading titles match the hydrated page header", () => {
    // Each entry maps a loading.tsx to the title its hydrated page
    // renders. Most routes surface a plain `title="X"` prop on
    // PageLoadingWrapper or an inline `<h1>X</h1>`. The playful
    // (MONEY-485) pages that own an editorial split-span headline
    // (analysis, strategies) can't be matched by a single word, so they
    // carry an explicit `match` regex asserting the actual hydrated
    // headline fragment — still the page-identity contract, just the
    // real one. Any mismatch causes a visible flash when the page
    // hydrates.
    const ROUTES: Array<{ path: string; title: string; match?: RegExp }> = [
      { path: "app/holdings/loading.tsx", title: "Holdings" },
      { path: "app/tradebook/loading.tsx", title: "Tradebook" },
      { path: "app/brokers/loading.tsx", title: "Brokers" },
      { path: "app/watchlist/loading.tsx", title: "Watchlists" },
      { path: "app/fire/loading.tsx", title: "FIRE Calculator" },
      { path: "app/positions/loading.tsx", title: "Positions" },
      { path: "app/documents/loading.tsx", title: "Document Vault" },
      // Playful editorial headline: "Your research, on the record."
      {
        path: "app/analysis/loading.tsx",
        title: "Your research, on the record.",
        match: /Your research,[\s\S]{0,200}record\./,
      },
      { path: "app/discover/loading.tsx", title: "Discover" },
      { path: "app/chat-history/loading.tsx", title: "Chat History" },
      // Playful editorial headline: "Strategies that earn their keep."
      {
        path: "app/strategies/loading.tsx",
        title: "Strategies that earn their keep.",
        match: /Strategies that[\s\S]{0,200}their keep\./,
      },
      { path: "app/learning/loading.tsx", title: "Courses" },
      { path: "app/tax/loading.tsx", title: "Tax Report" },
      // PAGE_CONFIG / hydrated title is "StockSage Tutor".
      { path: "app/sage-tutor/loading.tsx", title: "StockSage Tutor" },
      { path: "app/quizzes/loading.tsx", title: "Quiz" },
      { path: "app/settings/loading.tsx", title: "Settings" },
      { path: "app/help/loading.tsx", title: "Help" },
      { path: "app/tradebook/import/loading.tsx", title: "Import trades" },
      { path: "app/tradebook/export/loading.tsx", title: "Export trades" },
      {
        path: "app/tradebook/import/history/loading.tsx",
        title: "Import history",
      },
    ];

    for (const { path, title, match } of ROUTES) {
      it(`${path} surfaces title="${title}" (prop OR inline JSX)`, () => {
        const src = read(path);
        // Editorial split-span headline routes assert their real
        // hydrated headline fragment directly.
        if (match) {
          assert.ok(
            match.test(src),
            `${path} does not surface its hydrated headline (${match})`
          );
          return;
        }
        // Accept either form: `title="X"` prop on PageLoadingWrapper,
        // or raw `>X<` text inside an inline `<h1>` block (the
        // analysis loading.tsx uses inline chrome to avoid the
        // PageLoadingWrapper max-w-[1600px] clamp).
        const asProp = src.includes(`title="${title}"`);
        const asInlineH1 = new RegExp(
          `<h1[^>]*>\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/h1>`,
          "i"
        ).test(src);
        assert.ok(
          asProp || asInlineH1,
          `${path} does not surface title="${title}" (neither as PageLoadingWrapper prop nor as inline <h1>)`
        );
      });
    }
  });

  describe("Loading breadcrumbs match the hydrated page header", () => {
    // Each entry maps a loading.tsx breadcrumb prop to the value the
    // hydrated page renders next to the title. Any mismatch causes a
    // visible flash when the page hydrates.
    const PAIRS: Array<{ path: string; breadcrumb: string }> = [
      { path: "app/holdings/loading.tsx", breadcrumb: "Portfolio" },
      { path: "app/tradebook/loading.tsx", breadcrumb: "Portfolio" },
      { path: "app/brokers/loading.tsx", breadcrumb: "Account" },
      { path: "app/watchlist/loading.tsx", breadcrumb: "Workspace" },
      { path: "app/fire/loading.tsx", breadcrumb: "Tools" },
      { path: "app/documents/loading.tsx", breadcrumb: "Tools" },
      // Analysis renders the breadcrumb chip inline in uppercase per the
      // Terminal Luxe design. The hydrated `analysis/client.tsx` also
      // uses "RESEARCH LIST" - keeps stage 1 → 2 → 3 in sync.
      { path: "app/analysis/loading.tsx", breadcrumb: "RESEARCH LIST" },
      {
        path: "app/tradebook/import/loading.tsx",
        breadcrumb: "Portfolio · Tradebook",
      },
      {
        path: "app/tradebook/export/loading.tsx",
        breadcrumb: "Portfolio · Tradebook",
      },
      {
        path: "app/tradebook/import/history/loading.tsx",
        breadcrumb: "Portfolio · Tradebook",
      },
    ];

    for (const { path, breadcrumb } of PAIRS) {
      it(`${path} surfaces breadcrumb="${breadcrumb}" (prop OR inline span)`, () => {
        const src = read(path);
        const asProp = src.includes(`breadcrumb="${breadcrumb}"`);
        // The analysis loading.tsx uses inline chrome; the breadcrumb
        // appears as a literal string inside a <span> chip rather than
        // as a PageLoadingWrapper prop. Allow surrounding whitespace
        // (JSX commonly puts the text on its own line).
        const asInlineText = new RegExp(
          `>\\s*${breadcrumb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<`,
          "i"
        ).test(src);
        assert.ok(
          asProp || asInlineText,
          `${path} does not surface breadcrumb="${breadcrumb}" (neither as PageLoadingWrapper prop nor inline)`
        );
      });
    }
  });

  describe("Paper Trading layout - server-side flag gate (MONEY-444)", () => {
    const src = read("app/paper-trading/layout.tsx");
    it("gates the kill-switch flag on the server via redirect() (no stage-1/2 flash)", () => {
      // MONEY-444 superseded the old client-side `<PageGuard bare>`
      // wrapper: the layout is now a SERVER component that reads the
      // `/paper-trading` flag and `redirect("/dashboard")`s BEFORE any
      // HTML is sent, so the user never sees the paper-trading shell
      // flash through loading.tsx + PageGuard while the flag resolves.
      assert.match(
        src,
        /redirect\(["']\/dashboard["']\)/,
        "paper-trading/layout.tsx should redirect('/dashboard') when the flag is off"
      );
      assert.match(
        src,
        /flags\[["']\/paper-trading["']\]/,
        "paper-trading/layout.tsx should gate on the /paper-trading flag"
      );
    });
    it("delegates interactive chrome to the client layout", () => {
      // The server gate is a thin wrapper; sub-nav / market clock /
      // Sidebar state live in PaperTradingLayoutClient.
      assert.match(
        src,
        /<PaperTradingLayoutClient>\s*\{children\}\s*<\/PaperTradingLayoutClient>/,
        "server layout should render <PaperTradingLayoutClient>{children}</PaperTradingLayoutClient>"
      );
    });
    it("PageGuard component still supports a `bare` prop (used by other nested routes)", () => {
      const guardSrc = read("components/PageGuard.tsx");
      assert.ok(guardSrc.includes("bare?: boolean"));
      assert.ok(guardSrc.includes("bare = false"));
    });
    it("does not return PageGuard at the top level", () => {
      // Ensure the old client-side `return <PageGuard>...` shape (which
      // caused the stage-1/2 chrome flash) didn't sneak back.
      assert.equal(
        /return \(\s*<PageGuard /.test(src),
        false,
        "layout return should not start with <PageGuard> - server redirect() is the gate now"
      );
    });
  });

  describe("Loading routes WITHOUT a hydrated breadcrumb must not pass one", () => {
    // These pages don't render a breadcrumb chip in their hydrated state.
    // Passing one in loading.tsx creates a chip that flashes in then
    // disappears - exactly what we're trying to eliminate.
    const NO_BREADCRUMB_ROUTES: string[] = [
      "app/positions/loading.tsx",
      "app/discover/loading.tsx",
      "app/chat-history/loading.tsx",
      "app/strategies/loading.tsx",
      "app/learning/loading.tsx",
      "app/tax/loading.tsx",
      "app/sage-tutor/loading.tsx",
      "app/quizzes/loading.tsx",
    ];

    for (const path of NO_BREADCRUMB_ROUTES) {
      it(`${path} does not pass a breadcrumb prop`, () => {
        const src = read(path);
        assert.equal(
          src.includes("breadcrumb="),
          false,
          `${path} should not pass breadcrumb= - the hydrated page does not render one, so the chip will flash`
        );
      });
    }
  });
});
