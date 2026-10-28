/**
 * MONEY-290 — `next.config.js` bundle-budget config must stay configured.
 *
 * This file guards TWO invariants that share one blast radius, because they
 * share one file and both are bugs of ABSENCE:
 *
 *  1. `experimental.optimizePackageImports` — barrel-import optimization. The
 *     app's built chunks reached ~7.3 MB raw, and 305 files import from the
 *     `lucide-react` barrel (Sidebar.tsx alone pulls ~50 icons). Delete the key
 *     and nothing breaks, nothing type-errors, no test fails — the bundle just
 *     quietly grows again. That is exactly how this drifted the first time.
 *
 *  2. `experimental.staleTimes` — the client Router Cache (MONEY-1136). It has
 *     its own dedicated test next door, and it is re-asserted HERE on purpose:
 *     a careless edit to the experimental block (say, replacing it wholesale
 *     while adding an entry to the list above) must fail loudly from whichever
 *     test the author happens to look at.
 *
 * ## What "correct" means for optimizePackageImports
 *
 * Next UNIONs the user list with its own defaults — see
 * next/dist/server/config.js:
 *
 *     result.experimental.optimizePackageImports =
 *       [...new Set([...userProvidedOptimizePackageImports, ...NEXT_DEFAULTS])]
 *
 * so entries here are additive and can never remove a Next default. Several of
 * ours (`lucide-react`, `date-fns`, `recharts`) are ALREADY in Next 16.2.7's
 * default list; they are repeated in our config so a change to Next's defaults
 * on a future upgrade is a no-op instead of a silent regression.
 *
 * The inverse failure matters just as much: a package listed here that is not
 * a real dependency imported through a barrel is silent dead config. So this
 * test also asserts every listed entry resolves to something the app actually
 * depends on.
 *
 * Source: apps/web/next.config.js, apps/web/package.json
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require("../../next.config.js") as {
  experimental?: {
    optimizePackageImports?: string[];
    staleTimes?: { dynamic?: number };
  };
};

// CWD is apps/web (the package's test script runs from there).
const pkg = JSON.parse(readFileSync(join("package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

/**
 * Entries whose optimization we depend on. `@usemoney/ui` is the only one that
 * is NOT already a Next default, and the only one that changes output today:
 * its root barrel re-exports ~50 components.
 */
const REQUIRED_ENTRIES = [
  "@usemoney/ui",
  "lucide-react",
  "recharts",
  "date-fns",
];

describe("MONEY-290 — experimental.optimizePackageImports", () => {
  it("[regression] the key is set at all", () => {
    // The bug is the ABSENCE of this key. Everything still builds without it.
    assert.ok(
      nextConfig.experimental,
      "next.config.js must declare an experimental block"
    );
    assert.ok(
      Array.isArray(nextConfig.experimental?.optimizePackageImports),
      "experimental.optimizePackageImports must be an array — unset means " +
        "every barrel import ships its whole package graph (MONEY-290)"
    );
  });

  it("includes every barrel-heavy package we rely on", () => {
    const list = nextConfig.experimental?.optimizePackageImports ?? [];
    for (const entry of REQUIRED_ENTRIES) {
      assert.ok(
        list.includes(entry),
        `optimizePackageImports must include "${entry}" — see MONEY-290`
      );
    }
  });

  it("lists no package that is not an actual dependency", () => {
    // A bogus entry is silent dead config: Next accepts unknown package names
    // and simply never matches an import. `@radix-ui/react-icons` was proposed
    // for this list and rejected here — it is not a dependency and has zero
    // imports repo-wide.
    const list = nextConfig.experimental?.optimizePackageImports ?? [];
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    for (const entry of list) {
      // Sub-path entries (e.g. "react-icons/fa") resolve via their root pkg.
      const root = entry.startsWith("@")
        ? entry.split("/").slice(0, 2).join("/")
        : entry.split("/")[0];
      assert.ok(
        declared.has(root),
        `optimizePackageImports lists "${entry}" but "${root}" is not a ` +
          `dependency of @usemoney/web — a bogus entry is dead config`
      );
    }
  });

  it("does not list a package that was removed as dead", () => {
    // @tabler/icons-react (0 usages) and `motion` (only framer-motion is used)
    // were dropped in MONEY-290. Re-adding either to this list would resurrect
    // dead config even though the previous test would also catch it.
    const list = nextConfig.experimental?.optimizePackageImports ?? [];
    for (const dead of ["@tabler/icons-react", "motion"]) {
      assert.ok(
        !list.includes(dead),
        `"${dead}" was removed as a dead dependency — it must not be listed`
      );
    }
  });
});

describe("MONEY-290 — next.config.js edits must not drop MONEY-1136", () => {
  it("[regression] experimental.staleTimes.dynamic survives", () => {
    // Duplicated on purpose from __tests__/config/router-cache-staletimes.test.ts.
    // The two settings live in the same object literal, so the realistic way to
    // lose staleTimes is an edit aimed at optimizePackageImports.
    assert.notEqual(
      nextConfig.experimental?.staleTimes?.dynamic,
      undefined,
      "staleTimes.dynamic must stay set — dropping it disables the client " +
        "Router Cache and reintroduces the MONEY-1136 navigation bug"
    );
    assert.equal(nextConfig.experimental?.staleTimes?.dynamic, 30);
  });
});

describe("MONEY-290 — bundle analyzer stays wired and opt-in", () => {
  it("exports the plain config when ANALYZE is not set", () => {
    // The analyzer must never be on the default build path: `require`ing it
    // unconditionally would pull webpack-bundle-analyzer into every build (and
    // fail outright wherever the devDependency is not installed).
    assert.equal(
      process.env.ANALYZE,
      undefined,
      "this test asserts the default (ANALYZE unset) branch"
    );
    assert.ok(
      nextConfig.experimental,
      "with ANALYZE unset, next.config.js must export the raw config object"
    );
  });

  it("declares the analyzer dependency and an entry point", () => {
    assert.ok(
      pkg.devDependencies?.["@next/bundle-analyzer"],
      "@next/bundle-analyzer must be a devDependency — without it " +
        "`ANALYZE=true next build` throws MODULE_NOT_FOUND"
    );
    assert.match(
      pkg.scripts?.analyze ?? "",
      /ANALYZE=true/,
      "an `analyze` script is the discoverable entry point; the whole point " +
        "of MONEY-290 is that nobody could see inside the chunks"
    );
  });

  it("loads the analyzer lazily, inside the ANALYZE branch", () => {
    // A top-level `require("@next/bundle-analyzer")` would run on every build.
    const src = readFileSync(join("next.config.js"), "utf8");
    const requireIdx = src.indexOf('require("@next/bundle-analyzer")');
    assert.ok(requireIdx > 0, "next.config.js must require the analyzer");
    const guardIdx = src.indexOf('process.env.ANALYZE !== "true"');
    assert.ok(
      guardIdx > 0 && guardIdx < requireIdx,
      "the ANALYZE guard must come BEFORE the require, so a normal build " +
        "never loads the analyzer"
    );
  });
});
