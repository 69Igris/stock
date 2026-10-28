/**
 * Make `import "./foo.css"` inert under `node --test` (MONEY-1192).
 *
 * Used as `node --import ../../scripts/css-stub-register.mjs …` from a
 * workspace; `node --test` forwards execArgv to its per-file children, so one
 * registration covers the whole run.
 *
 * ## Two seams, because the workspaces disagree about module systems
 *
 * The obvious implementation — an ESM `resolve` hook redirecting `*.css` to an
 * empty module — silently does NOTHING in apps/web, and that cost a debugging
 * pass worth recording:
 *
 *   apps/web is CommonJS ("type" is not "module"), so tsx transpiles its TS to
 *   CJS and loads it with require(). ESM loader hooks only ever see `import`.
 *   The failing stack said so plainly — `Module.require` / `cjs/loader` — while
 *   the hook sat there looking correct and never firing.
 *
 * So both seams are installed:
 *
 *   require.extensions[".css"]  the CJS path — what apps/web actually uses
 *   register(hooks)             the ESM path — apps/api and workers are ESM
 *
 * `require.extensions` is soft-deprecated and is still the only interception
 * point for CJS require. It is scoped to test processes, never shipped.
 *
 * ## What this does NOT do
 *
 * It does not parse, validate or apply CSS, and a test must never assert
 * anything about styling through it. The point is only that importing a
 * stylesheet cannot crash a test process — which is what made component-scoped
 * CSS impossible and left 117KB on every marketing page (MONEY-1140).
 */

import { register, createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── CJS (apps/web) ──────────────────────────────────────────────────────────
// The loader calls this instead of compiling the file. Assigning `{}` to
// module.exports keeps CSS-modules-style default imports (`styles.foo`)
// undefined rather than throwing.
for (const ext of [".css", ".scss", ".sass", ".less"]) {
  require.extensions[ext] = (module) => {
    module.exports = {};
  };
}

// ── ESM (apps/api, workers, and any web file loaded as ESM) ─────────────────
register("./css-stub-hooks.mjs", import.meta.url);
