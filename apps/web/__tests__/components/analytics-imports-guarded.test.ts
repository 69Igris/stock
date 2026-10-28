/**
 * Analytics/monitoring dynamic imports must not reject into the void
 * — MONEY-1220.
 *
 * ## The failure
 *
 * `import()` REJECTS when its chunk cannot be fetched. With no `.catch()`, that
 * is an unhandled rejection originating inside a React effect:
 *
 *   ⨯ unhandledRejection: ChunkLoadError: Loading chunk
 *     _app-pages-browser_node_modules_datadog_browser-rum_… failed
 *       at DatadogRumProvider.useEffect (DatadogRumProvider.tsx:51:5)
 *
 * Observed on a dev server recompiling during navigation, alongside
 * `Failed to fetch RSC payload` and `ECONNRESET`. It is not exotic: an ad
 * blocker on `/ingest`, or a deploy rotating chunk hashes while a tab is open,
 * produces the same rejection in production.
 *
 * These three modules are OBSERVABILITY. Losing a pageview is acceptable;
 * taking navigation down to report one is not. The asymmetry is the whole
 * argument — nothing a monitoring provider does is worth an unhandled rejection
 * in the app it monitors.
 *
 * Scoped to the analytics providers deliberately. The chart imports in
 * `ResearchReport`, `ChartBlockRenderer` and `compare/client` sit inside
 * `next/dynamic`, which owns their failure path.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

function repoRoot(): string {
  // Anchor on the workspace lockfile, never turbo.json — Turborepo supports
  // per-package configs, so a turbo.json walk stops inside apps/web and every
  // read returns "", making a source guard silently vacuous.
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd());
}

const TARGETS = [
  "apps/web/components/DatadogRumProvider.tsx",
  "apps/web/components/PostHogProvider.tsx",
  "apps/web/lib/hooks/useDemoAnalytics.ts",
  // MONEY-726 — the two error boundaries now import @datadog/browser-rum
  // dynamically to report the boundary hit. They are the WORST place in the
  // app for an unhandled ChunkLoadError: the rejection would fire inside the
  // page that is already the last thing standing after a crash, so there is
  // nothing above it left to catch a second failure.
  "apps/web/app/error.tsx",
  "apps/web/app/global-error.tsx",
] as const;

/** LINE comments before BLOCK — MONEY-1143. A `//` containing `/*` opens a
 *  phantom block that runs to the next close, eating real code and making
 *  every absence assertion below pass because the code is gone. */
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("analytics dynamic imports are guarded (MONEY-1220)", () => {
  it("[meta] every target file is readable and non-trivial", () => {
    for (const t of TARGETS) {
      const src = readFileSync(join(repoRoot(), t), "utf8");
      assert.ok(src.length > 300, `${t} is empty or unreadable`);
    }
  });

  it("[meta] stripComments removes prose without eating the code", () => {
    // Every scan below runs on stripped text, so an over-eager stripper
    // returning "" would make the whole suite pass vacuously.
    for (const t of TARGETS) {
      const raw = readFileSync(join(repoRoot(), t), "utf8");
      const code = stripComments(raw);
      assert.ok(code.length < raw.length, `${t}: stripped nothing`);
      assert.ok(code.length > raw.length * 0.3, `${t}: stripper ate the code`);
      assert.match(code, /import\(/, `${t}: the anchor did not survive`);
    }
  });

  for (const t of TARGETS) {
    it(`${t.split("/").pop()} catches every dynamic import`, () => {
      const code = stripComments(readFileSync(join(repoRoot(), t), "utf8"));
      const imports = (code.match(/import\(/g) ?? []).length;
      const catches = (code.match(/\.catch\(/g) ?? []).length;
      assert.ok(imports > 0, "no dynamic import found — has the file moved?");
      assert.ok(
        catches >= imports,
        `${imports} dynamic import(s) but only ${catches} .catch() — an ` +
          "unguarded one becomes an unhandled ChunkLoadError inside a React effect"
      );
    });
  }

  it("the app still renders when analytics never initialises", () => {
    // PostHogProvider's own degradation path: `client` stays null on failure
    // and children render unwrapped. If that guard went away, a chunk failure
    // would take the subtree with it rather than just the analytics.
    const code = stripComments(
      readFileSync(
        join(repoRoot(), "apps/web/components/PostHogProvider.tsx"),
        "utf8"
      )
    );
    assert.match(
      code,
      /if \(!client\) return <>\{children\}<\/>/,
      "PostHogProvider must render children unwrapped when the client is absent"
    );
  });
});
