/**
 * `.pf-bf` / `.pf-bs` must not declare `display` at class specificity.
 *
 * ## The defect
 *
 * The button base rule declared `display: inline-flex` at (0,1,0) — the same
 * specificity as every Tailwind display utility. `layout.tsx` imports
 * playful-app.css AFTER globals.css, and globals.css is where
 * `@tailwind utilities` emits `.hidden`, `.grid` and the responsive variants.
 * Equal specificity, later source, no cascade layer: the button rule won, and
 * every display utility written on a `.pf-bf` was silently inert.
 *
 * Nothing errored. `className="pf-bf sm hidden lg:flex"` rendered at every
 * width, and `pf-bf … grid place-items-center` never became a grid. Because
 * the failure is invisible in the markup — the class IS there, it just does
 * nothing — the pattern kept getting written: two call sites shipped broken,
 * and two panels worked around it with conditional rendering plus a comment
 * concluding the cascade was unwinnable.
 *
 * ## The fix this pins
 *
 * `display` moved into `:where(.pf-bf, .pf-bs)`, which contributes ZERO
 * specificity, so it still supplies the default while any utility overrides
 * it.
 *
 * This scan exists because the fix is easy to undo by tidying: folding the
 * one-line rule back into the block above looks like harmless cleanup and
 * restores the bug in full, silently. A comment alone already failed to hold
 * this line once.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Comments are stripped before any scanning. Several comments in this file
// discuss `.pf-bf` / `.pf-bs` by name (including the one explaining this very
// fix), and a selector scan that treats the text before a `{` as the selector
// will otherwise attribute the NEXT rule's body to whatever comment precedes
// it — which reported `.pf-tabs` as a `.pf-bf` offender on the first run.
const CSS = readFileSync(
  join(process.cwd(), "app", "playful-app.css"),
  "utf8"
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first rule whose selector list exactly matches `selector`. */
function ruleBody(selector: string): string | null {
  const i = CSS.indexOf(selector);
  if (i === -1) return null;
  const open = CSS.indexOf("{", i);
  const close = CSS.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  return CSS.slice(open + 1, close);
}

describe(".pf-bf / .pf-bs display cascade", () => {
  test("the base button rule does NOT declare display", () => {
    const body = ruleBody(".pf-bf,\n.pf-bs {");
    assert.ok(body, "could not find the `.pf-bf, .pf-bs` base rule");
    assert.doesNotMatch(
      body,
      /(^|[;{\s])display\s*:/,
      "`display` is back at class specificity — it beats Tailwind's display " +
        "utilities on source order, making `hidden` / `grid` / `lg:flex` " +
        "silently inert on every .pf-bf button"
    );
  });

  test("display is declared through :where(), at zero specificity", () => {
    const body = ruleBody(":where(.pf-bf, .pf-bs) {");
    assert.ok(
      body,
      "the `:where(.pf-bf, .pf-bs)` rule is gone — buttons have no default " +
        "display, or it was folded back into the class-specificity rule"
    );
    assert.match(body, /display\s*:\s*inline-flex/);
  });

  test("no OTHER rule reintroduces display at class specificity", () => {
    // `.pf-bf.sm`, `.pf-bf.danger` etc. are (0,2,0) and would beat a utility
    // just as decisively as the base rule did.
    const offenders: string[] = [];
    const ruleRe = /(^|\})\s*([^{}@]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(CSS))) {
      const selector = m[2].trim();
      const body = m[3];
      if (!/\.pf-b[fs]\b/.test(selector)) continue;
      if (selector.startsWith(":where(")) continue;
      if (/(^|[;{\s])display\s*:/.test(body)) offenders.push(selector);
    }
    assert.deepEqual(
      offenders,
      [],
      `these .pf-b* rules declare display at class specificity: ${offenders.join(" | ")}`
    );
  });
});
