/**
 * The error boundaries report to RUM, and the crash page initialises it itself
 * — MONEY-726.
 *
 * ## The failure this pins
 *
 * RUM's automatic error collection watches for UNCAUGHT exceptions. A React
 * error boundary is the one case where React has already caught the throw: what
 * arrives is a re-render of `error.tsx` / `global-error.tsx`, not an uncaught
 * error. So the single most severe client failure we have was the one Datadog
 * had no first-class event for, and `global-error.tsx` was worse still — it
 * replaces the document when `app/layout.tsx` throws, which puts it ABOVE the
 * tree that mounts `DatadogRumProvider`. RUM is not merely uninitialised there;
 * nothing in that render will ever initialise it. Its own comment said
 * "Datadog should have caught this", and that was false.
 *
 * ## Why a source scan
 *
 * These are Next.js App Router client boundaries: `error.tsx` pulls in Clerk's
 * `useUser` and the Sidebar, `global-error.tsx` renders its own <html>. Booting
 * either under `node:test` means a React renderer, a Clerk provider and a DOM,
 * which is a large amount of machinery to assert the presence of one call. The
 * scan is the cheap layer; the shapes below are chosen so that DELETING the
 * behaviour is what makes them fail, not merely renaming around it.
 *
 * The `[meta]` cases exist because a source scan over a file that moved reads
 * "" and then passes every absence assertion in the file vacuously — the class
 * of defect this repo has been burned by repeatedly.
 *
 * Sibling coverage: `analytics-imports-guarded.test.ts` owns the OTHER half of
 * this change (every dynamic import in both boundaries carries a `.catch`).
 * Run from apps/web — the `@/` alias needs its tsconfig.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

function repoRoot(): string {
  // Anchor on the workspace lockfile, never turbo.json — Turborepo supports
  // per-package configs, so a turbo.json walk stops inside apps/web and every
  // read below returns "", making this whole file vacuous.
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd());
}

const FILES = {
  error: "apps/web/app/error.tsx",
  globalError: "apps/web/app/global-error.tsx",
  rumInit: "apps/web/lib/datadog/rum-init.ts",
  provider: "apps/web/components/DatadogRumProvider.tsx",
} as const;

/** Read a target, failing loudly rather than returning "" if it moved. */
function read(rel: string): string {
  const abs = join(repoRoot(), rel);
  assert.ok(existsSync(abs), `${rel} does not exist — has it moved?`);
  return readFileSync(abs, "utf8");
}

/** LINE comments before BLOCK — MONEY-1143. A `//` containing a block-open
 *  starts a phantom comment that runs to the next close, eating real code and
 *  making every absence assertion below pass because the code is gone. The
 *  `[^:]` guard keeps `https://` in a URL from being read as a comment. */
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("error boundaries report to RUM (MONEY-726)", () => {
  it("[meta] every scanned file exists and is non-trivial", () => {
    for (const [name, rel] of Object.entries(FILES)) {
      const src = read(rel);
      assert.ok(src.length > 300, `${name} (${rel}) is empty or unreadable`);
    }
  });

  it("[meta] stripComments removes prose without eating the code", () => {
    // Every assertion below runs on stripped text. An over-eager stripper
    // returning "" would make the absence checks pass for the wrong reason,
    // and the boundary comments here are long enough to make that plausible.
    for (const [name, rel] of Object.entries(FILES)) {
      const raw = read(rel);
      const code = stripComments(raw);
      assert.ok(code.length < raw.length, `${name}: stripped nothing`);
      assert.ok(code.length > 200, `${name}: stripper ate the code`);
      assert.match(code, /export/, `${name}: the anchor did not survive`);
    }
  });

  it("error.tsx reports the caught error to RUM, tagged as the boundary", () => {
    const code = stripComments(read(FILES.error));
    // Anchored on `addError(error, {...})` rather than a bare `addError` so
    // that reporting a NEW Error, or dropping the error argument, is red: the
    // stack and the message are the whole payload.
    assert.match(
      code,
      /datadogRum\.addError\(\s*error\s*,\s*\{[^}]*boundary:\s*"error"[^}]*\}/,
      'error.tsx must call datadogRum.addError(error, { … boundary: "error" }) ' +
        "— RUM does not see boundary hits automatically, React caught the throw"
    );
    // The digest is the ONLY join key from this browser event back to the
    // server-side stack Next.js logged. Without it a RUM error is unresolvable.
    assert.match(
      code,
      /datadogRum\.addError\([\s\S]{0,120}?digest:/,
      "error.tsx must send the digest alongside the error"
    );
  });

  it("global-error.tsx reports its own boundary and keeps the console line", () => {
    const code = stripComments(read(FILES.globalError));
    assert.match(
      code,
      /datadogRum\.addError\(\s*error\s*,\s*\{[^}]*boundary:\s*"global-error"[^}]*\}/,
      "global-error.tsx must report with its own boundary tag — the two " +
        "surfaces have different severities and must be separable in Datadog"
    );
    // The console line is the LAST-DITCH breadcrumb. RUM here depends on two
    // dynamic imports and a public config that is absent in local dev, so the
    // console is the only channel guaranteed to survive; removing it because
    // "Datadog has it now" would leave the offline case with nothing at all.
    assert.match(
      code,
      /console\.error\("\[global-error\.tsx\]", error\)/,
      "global-error.tsx must keep its console.error breadcrumb"
    );
  });

  it("global-error.tsx initialises RUM, and ONLY behind getInitConfiguration()", () => {
    const code = stripComments(read(FILES.globalError));
    const inits = (code.match(/datadogRum\.init\(/g) ?? []).length;
    const guarded = (
      code.match(
        /if\s*\(\s*!\s*datadogRum\.getInitConfiguration\(\)\s*\)\s*\{?\s*datadogRum\.init\(/g
      ) ?? []
    ).length;
    // It MUST init: no provider mounts above this boundary, so an unguarded
    // addError alone would buffer into a RUM that is never started and the
    // event would simply never be sent.
    assert.equal(
      inits,
      1,
      "global-error.tsx must initialise RUM exactly once — nothing above this " +
        "boundary ever does"
    );
    // …and it must be guarded: `reset()` re-runs this effect, and a repeat
    // init() is refused by the SDK with a console error of its own, printed
    // into the very surface we are trying to read.
    assert.equal(
      guarded,
      inits,
      `${inits} datadogRum.init( call(s) but ${guarded} behind ` +
        "if (!datadogRum.getInitConfiguration()) — an unguarded re-init logs " +
        "an SDK error into the crash page on every reset()"
    );
  });

  it("global-error.tsx stays self-contained: no STATIC app or SDK import", () => {
    const code = stripComments(read(FILES.globalError));
    // This boundary renders when app/layout.tsx itself threw, so a static
    // import of anything from the app is a module that may already be the
    // thing that is broken. `react` is the one permitted static import.
    const staticImports = code.match(/^import\s[^\n]*from\s+"([^"]+)"/gm) ?? [];
    assert.deepEqual(
      staticImports.map((l) => l.replace(/^[\s\S]*from\s+"/, "").slice(0, -1)),
      ["react"],
      "global-error.tsx must import nothing statically but react — RUM and " +
        "rum-init are dynamic so a failed chunk degrades to the console line"
    );
  });

  it("rum-init.ts takes the site from the shared constant, never a literal", () => {
    const code = stripComments(read(FILES.rumInit));
    assert.match(
      code,
      /import\s*\{\s*DD_SITE\s*\}\s*from\s*"@usemoney\/datadog\/constants"/,
      "rum-init.ts must import DD_SITE from the constants subpath"
    );
    assert.match(code, /site:\s*DD_SITE/, "site must be the constant");
    // A hardcoded site is the MONEY-1229 failure verbatim: RUM pointed at a
    // site the client token was not minted on is answered 403 and dropped
    // silently, so the symptom is an empty dashboard, not an error.
    assert.doesNotMatch(
      code,
      /datadoghq\.(com|eu)/,
      "rum-init.ts must not hardcode a Datadog site — the org moved us3 -> us5 " +
        "and a stale literal is dropped with a silent 403"
    );
    // Absent public env must yield null rather than an object with undefined
    // fields, which the SDK accepts and then drops every event from.
    assert.match(
      code,
      /if\s*\(!applicationId\s*\|\|\s*!clientToken\)\s*return null/,
      "rumInitConfig must return null when the NEXT_PUBLIC_DD_* pair is absent"
    );
  });

  it("DatadogRumProvider.tsx uses the shared config, not a second copy", () => {
    const code = stripComments(read(FILES.provider));
    assert.match(
      code,
      /import\s*\{\s*rumInitConfig\s*\}\s*from\s*"@\/lib\/datadog\/rum-init"/,
      "the provider must import the shared config factory"
    );
    assert.match(code, /datadogRum\.init\(cfg\)/, "…and init with its result");
    // The duplicate this replaces is the point: two inline configs drift, and
    // the way they drift is silent — a boundary reporting under a different
    // service/env still returns 200 and lands where nobody is looking.
    assert.doesNotMatch(
      code,
      /applicationId:/,
      "the provider must no longer inline an init object — one config, one place"
    );
  });
});
