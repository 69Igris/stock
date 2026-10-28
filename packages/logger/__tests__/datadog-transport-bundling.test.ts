/**
 * The Datadog log transport must be BUNDLED, not resolved at runtime — MONEY-1375.
 *
 * ## What this is guarding, and how it read as health
 *
 * `createProductionStream()` loads `@usemoney/datadog/logger-transport` with a
 * dynamic `import()`. The specifier used to be held in a VARIABLE:
 *
 *     const ddTransportModule = "@usemoney/datadog/logger-transport";
 *     await import(-* webpackIgnore: true *- ddTransportModule)
 *
 * A variable specifier is invisible to esbuild, so `tsup` left it as a real
 * runtime import and never bundled the module. In the container that resolved
 * to `packages/datadog/src/logger-transport.ts` — a raw TypeScript file Node
 * cannot load — which threw into `initLogger`'s `catch` and fell back to
 * stdout-only pino.
 *
 * Nothing failed. `stockbook-workers` printed every line perfectly to Cloud
 * Logging and shipped ZERO to Datadog for the entire life of the us5 org, while
 * every log monitor sat in NO DATA — indistinguishable from a quiet service.
 * The comment directly above the defect warned about "module resolution issues
 * in Docker builds where @usemoney/datadog exports raw .ts", which is exactly
 * what it then caused.
 *
 * Measured on the built bundle before the fix: `maxBatchSize` and `ddsource`
 * appeared ZERO times in `workers/dist/index.js`. After: both present, and no
 * unbundled `import("@usemoney/datadog/logger-transport")` remains.
 *
 * This asserts the SOURCE property that produces that outcome, because the
 * bundle is a build artefact the unit suite cannot assume exists.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "index.ts"),
  "utf8",
);

/**
 * Source with comments removed.
 *
 * Every assertion about CODE must run against this. A review found the positive
 * cases here matching raw text, which a comment can satisfy: deleting the stderr
 * write and leaving its message in a comment kept the suite green. The one
 * exception is the `webpackIgnore` case below, whose subject IS a comment.
 *
 * LINE FIRST, THEN BLOCK — MONEY-1143, and the reverse is not a style choice.
 * A `//` comment containing `/*` opens a phantom block that runs to the next
 * `*` + `/`, hundreds of lines away; measured on this tree, block-first
 * stripping ate 11,192 characters out of one file. That matters most for the
 * `doesNotMatch` cases here, which would then pass because the code was
 * DELETED rather than because it is absent — the one failure mode where a
 * broken test and a healthy one are indistinguishable.
 */
const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the Datadog log transport is loadable in a bundled runtime", () => {
  it("imports the transport with a LITERAL specifier", () => {
    // A literal is what esbuild follows. Anything computed is left as a runtime
    // import and the module never enters the bundle.
    // Tolerates the wrapped form prettier produces once the webpackIgnore
    // comment is present, but still requires the specifier itself to be a
    // literal string at the call — which is the property esbuild follows.
    assert.match(
      CODE,
      /await import\(\s*"@usemoney\/datadog\/logger-transport"\s*\)/,
      "the transport import is not a literal specifier, so it will not be bundled",
    );
  });

  it("does not route that import through a variable", () => {
    assert.doesNotMatch(
      CODE,
      /const\s+\w+\s*=\s*"@usemoney\/datadog\/logger-transport"/,
      "holding the specifier in a variable hides it from the bundler — the MONEY-1375 defect",
    );
  });

  it("KEEPS webpackIgnore, which is what protects the browser bundle", () => {
    // This case originally asserted the opposite, and `yarn build` proved it
    // wrong. `@usemoney/logger` is reachable from a client component
    // (home/client.tsx -> core/subscription -> gemini/pricing -> logger), so
    // without the comment webpack follows the import into `logger-transport.ts`
    // and dies on its `node:stream` dependency with UnhandledSchemeError.
    //
    // esbuild does not read webpack magic comments, so the literal specifier
    // above still bundles for the workers. One line, two bundlers, opposite
    // instructions — and only the VARIABLE was ever the defect.
    assert.match(
      SRC,
      /webpackIgnore/,
      "webpackIgnore is required: without it Next pulls node:stream into the browser bundle",
    );
  });

  it("says why it fell back instead of swallowing the reason", () => {
    // The catch existed so logging could never crash the app, which is right.
    // Silence is what made a module-resolution failure indistinguishable from
    // a service that simply had nothing to say.
    assert.match(
      CODE,
      /catch\s*\(\s*err\s*\)/,
      "the fallback must capture the error, not discard it",
    );
    // Against CODE, not SRC: with the raw text this passed after the write was
    // deleted, because the message survived in the comment describing it.
    assert.match(
      CODE,
      /process\.stderr[\s\S]{0,80}Datadog transport unavailable/,
      "the fallback must actually WRITE the reason, not merely mention it",
    );
  });
});
