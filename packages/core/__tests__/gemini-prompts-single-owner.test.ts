/**
 * MONEY-1274 — `getSystemPrompt` has exactly ONE implementation.
 *
 * ## Why this test exists
 *
 * The page-anchor fix for MONEY-1155 #33/#34/#44 was written into
 * `apps/web/lib/gemini/prompts.ts` — a stale FORK with zero production
 * importers. The live implementation is this package's `prompts.ts`, which
 * `apps/web/lib/gemini/conversation.ts` imports via `@usemoney/core`. So the
 * fix compiled, its tests passed against the fork, and the anchor never reached
 * a model. The two files had identical PAGE_PROMPTS key sets and core exported a
 * strict superset, confirming the fork carried nothing of its own.
 *
 * That was the THIRD duplicate-copy failure in this branch:
 *
 *   1. the converted compute guards, tested from packages/research AND apps/web
 *   2. main's `internalOnly` tests, written against a signature this branch changed
 *   3. this — a fix landing in a file nothing imports
 *
 * Unit tests cannot catch it: a test importing the fork proves the fork works.
 * Only a check on the module GRAPH can, which is what this is.
 *
 * ## What would break if this test were deleted
 *
 * Someone re-creates `apps/web/lib/gemini/prompts.ts` (a plausible move — the
 * old path is in git history and in older comments), edits it, ships a fix that
 * never runs, and the suite stays green.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Repo root from packages/core. */
const ROOT = join(process.cwd(), "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next")
      continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("getSystemPrompt — exactly one owner", () => {
  const sources = [
    ...walk(join(ROOT, "apps")),
    ...walk(join(ROOT, "packages")),
  ].filter((p) => !p.includes("__tests__"));

  it("[regression] only ONE file defines getSystemPrompt", () => {
    const definers = sources.filter((p) =>
      /export function getSystemPrompt\b/.test(readFileSync(p, "utf8")),
    );
    assert.deepEqual(
      definers.map((p) => relative(ROOT, p)),
      ["packages/core/src/gemini/prompts.ts"],
      "a second getSystemPrompt exists — a fix written into the wrong one " +
        "compiles, tests green against itself, and never runs",
    );
  });

  it("[regression] only ONE file defines the page-anchor helpers", () => {
    for (const fn of [
      "resolvePromptKey",
      "parsePageAnchor",
      "formatPageAnchor",
    ]) {
      const definers = sources.filter((p) =>
        new RegExp(`export function ${fn}\\b`).test(readFileSync(p, "utf8")),
      );
      assert.equal(
        definers.length,
        1,
        `${fn} is defined in ${definers.length} files: ${definers
          .map((p) => relative(ROOT, p))
          .join(", ")}`,
      );
    }
  });

  it("[regression] the deleted apps/web fork has not come back", () => {
    assert.ok(
      !existsSync(join(ROOT, "apps/web/lib/gemini/prompts.ts")),
      "apps/web/lib/gemini/prompts.ts is back — it is a fork of this " +
        "package's prompts.ts and nothing imports it",
    );
  });

  it("the live implementation resolves paths by SEGMENT, not exact key", () => {
    // The defect the fork was supposed to fix. Asserted on the live file so it
    // cannot regress to `PAGE_PROMPTS[context.pagePath]` here.
    const src = readFileSync(
      join(ROOT, "packages/core/src/gemini/prompts.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(
      src,
      /PAGE_PROMPTS\[context\.pagePath\]/,
      "back to an exact-key lookup — every dynamic route misses again",
    );
    assert.match(src, /resolvePromptKey\(context\.pagePath/);
    assert.match(src, /formatPageAnchor\(/);
  });

  it("the anchor is sanitized — pagePath is request-body input", () => {
    const src = readFileSync(
      join(ROOT, "packages/core/src/gemini/prompts.ts"),
      "utf8",
    );
    assert.match(
      src,
      /formatPageAnchor\(\s*parsePageAnchor\(context\.pagePath\),\s*sanitizeForPrompt/,
      "the anchor is being built without the sanitizer",
    );
  });
});
