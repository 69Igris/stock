/**
 * META TEST — importing a stylesheet is inert under the test runner
 * (MONEY-1192).
 *
 * ## What this protects
 *
 * `apps/web` runs on `node --import tsx --test`. Node cannot parse CSS, so
 * before this stub any module in a test's import graph that imported a
 * stylesheet killed the process with a syntax error pointing at the CSS rather
 * than at the import:
 *
 *   apps/web/app/chat-blocks.css:14
 *   SyntaxError: Unexpected token ':'
 *
 * That made the standard Next pattern unusable — a stylesheet imported by a
 * client component, bundled into that component's chunk so it loads only where
 * the component renders. It is why 117KB of CSS still ships from the root
 * layout to all ~59 routes including 20 marketing pages (MONEY-1140).
 *
 * Thirteen renderers in `components/chat/blocks/` already import CSS and pass,
 * purely because no test happens to import any of them. This file removes the
 * dependence on that accident.
 *
 * ## Why a test and not just the loader
 *
 * The stub is wired through a `--import` flag in this workspace's `test`
 * script. A flag is easy to drop while reformatting a long command line, and
 * nothing would fail at that moment — the breakage would surface later, in an
 * unrelated PR, as a CSS syntax error nobody could place. This makes the wiring
 * itself the thing under test: if the flag goes, this file fails immediately
 * and says why.
 *
 * It follows that this test only passes via `yarn test`. Run standalone with a
 * bare `node --import tsx --test`, it fails — correctly, because that is
 * exactly the condition it exists to detect.
 *
 * ## What is deliberately NOT asserted
 *
 * Anything about styling. The stub does not parse, validate or apply CSS, and a
 * test must never reach through it to make a claim about appearance — that
 * belongs to the build and to visual review.
 *
 * Source: scripts/css-stub-register.mjs, scripts/css-stub-hooks.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The import under test. A real stylesheet, not a fixture: a fixture could be
// trivially small and still parse as something, whereas this file is 19KB of
// genuine CSS whose first rule is a syntax error to a JS parser.
import "@/app/chat-blocks.css";
import globals from "@/app/globals.css";

describe("MONEY-1192 — stylesheet imports are inert in tests", () => {
  it("a side-effect CSS import does not crash the process", () => {
    // Reaching this line at all is the assertion — the import above executes at
    // module load, so a missing stub fails the file before any test runs.
    assert.ok(true);
  });

  it("a default CSS import yields an empty object, not undefined", () => {
    // CSS-modules-style usage (`styles.foo`) must read as undefined rather than
    // throwing on a property access against undefined.
    assert.deepEqual(globals, {});
    assert.equal(
      (globals as Record<string, unknown>).someClassName,
      undefined,
      "an unknown class must be undefined, not a crash"
    );
  });

  it("the stub covers the other stylesheet dialects too", async () => {
    // scss/sass/less are registered alongside css. Asserted through the same
    // resolution path rather than by reading the source, so this fails if the
    // extension list shrinks.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    for (const ext of [".css", ".scss", ".sass", ".less"]) {
      assert.equal(
        typeof require.extensions[ext],
        "function",
        `${ext} has no stub registered — a component importing it would crash ` +
          `the test process`
      );
    }
  });
});
