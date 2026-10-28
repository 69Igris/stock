/**
 * Floating elements must clear the global mobile bottom nav — MONEY-1151.
 *
 * QA report: on phone and tablet the "Ask FIRE" button was invisible. Cause was
 * not a missing z-index — GlobalMobileBottomNav (.gmbn-nav, z-50, 60px tall)
 * and the FAB (`fixed bottom-6 right-6 z-50`) were the SAME z-index, and the
 * nav renders after {children} in app/layout.tsx, so it won the tie and painted
 * over a button sitting 24px up inside its 60px band. Raising the FAB's
 * z-index would only have covered the Brokers slot; the fix is vertical.
 *
 * The bug had spread by copy-paste: AskFirePanel, AskScreenerPanel and the
 * EmbeddedChatPanel template all carried the identical `bottom-6`. All three
 * now anchor off `--mobile-nav-h` (globals.css), which is 0 wherever the bar
 * isn't mounted — so desktop and marketing routes are untouched.
 *
 * This static scan keeps them anchored. It does NOT try to prove pixel
 * geometry (there is no DOM-render layer in this suite); it proves the three
 * known copies still reference the shared variable instead of drifting back to
 * a hardcoded offset.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// CWD is apps/web (the package's test script runs from there).
const NAV_CLEARANCE_VAR = "--mobile-nav-h";
const NAV_HEIGHT_VAR = "--mobile-nav-bar-h";

/* The single definition of the launcher's geometry. The three panels below
   used to hand-roll this button each, which is why one bug needed fixing in
   three files; they now all render this. */
const LAUNCHER = "components/chat/ChatLauncherButton.tsx";

/* Every surface that floats a chat panel over page content. Each must still
   subtract the bar from its own height. Add new Ask*Panel surfaces as they
   land. */
const FLOATING_CHAT_SURFACES = [
  "app/fire/components/AskFirePanel.tsx",
  "app/discover/screener/components/AskScreenerPanel.tsx",
  "components/chat/EmbeddedChatPanel.tsx",
];

const SCANNED_FILES = [LAUNCHER, ...FLOATING_CHAT_SURFACES];

/* A launcher pinned with a bare Tailwind `bottom-<n>` is the exact shape that
   broke: it lands inside the bar's band. Anything anchored via the variable
   uses an inline style instead, so the utility must be gone.

   Matches the CLASS STRING, not `className=`. Anchoring to the attribute only
   caught the single-line form: prettier (which runs on every commit via
   lint-staged) wraps a long `cn(...)` onto its own lines, leaving
   `"fixed bottom-6 right-6 z-50 pf-bs",` with no `className=` beside it — the
   most likely way this regresses, and previously invisible to the guard. A
   class string can't span lines, so scanning literals catches both forms. */
const HARDCODED_BOTTOM_UTILITY = /["'`][^"'`\n]*\bfixed\b[^"'`\n]*\bbottom-\d/;

/** Blank out /* *​/ comments, preserving line numbers. */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Blank out comments (preserving line numbers) so prose describing the bug —
    this repo comments heavily, and several of those comments quote
    `fixed bottom-6 right-6` verbatim — cannot trip the scan. TS/TSX only:
    stripping `//` from CSS would eat the rest of any line holding a `url(...)`. */
function stripComments(src: string): string {
  return stripBlockComments(src).replace(/\/\/[^\n]*/g, (m) =>
    " ".repeat(m.length)
  );
}

describe("floating elements clear the global mobile bottom nav", () => {
  it(`${LAUNCHER} sits BELOW the More drawer's backdrop`, () => {
    // .gmbn-drawer is z-49 over a z-48 backdrop. At z-50 the launcher floated
    // undimmed above the OPEN drawer and swallowed taps meant for its nav
    // items — a regression introduced by lifting it out of the bar's band.
    // z-40 dims with the page, matching ScrollToTop.
    const src = stripComments(readFileSync(LAUNCHER, "utf8"));
    assert.ok(
      /\bz-40\b/.test(src),
      `${LAUNCHER} must pin the launcher at z-40. The More drawer is z-49 over ` +
        `a z-48 backdrop, so anything above z-48 paints over the open drawer.`
    );
    assert.ok(
      !/\bz-(4[89]|5\d|\[)/.test(src),
      `${LAUNCHER} uses a z-index at or above the drawer backdrop (z-48). The ` +
        `launcher must stay under it so the More drawer can cover it.`
    );
  });

  for (const file of SCANNED_FILES) {
    it(`${file} anchors off ${NAV_CLEARANCE_VAR}`, () => {
      const src = readFileSync(file, "utf8");
      assert.ok(
        src.includes(NAV_CLEARANCE_VAR),
        `${file} never references ${NAV_CLEARANCE_VAR}. A launcher or panel ` +
          `pinned to the viewport bottom will be painted over by .gmbn-nav ` +
          `(z-50, 60px) below 1024px. Anchor it with ` +
          `style={{ bottom: "calc(var(${NAV_CLEARANCE_VAR}, 0px) + 1.5rem)" }}.`
      );
    });

    it(`${file} reads ${NAV_CLEARANCE_VAR} with a 0px fallback`, () => {
      // An undefined custom property with no fallback invalidates the whole
      // declaration at computed-value time, so `bottom` becomes `auto` and a
      // fixed element lands at its static position. Any renderer without
      // globals.css (Storybook, jsdom) hits this.
      const bare = new RegExp(`var\\(${NAV_CLEARANCE_VAR}\\s*\\)`).test(
        stripComments(readFileSync(file, "utf8"))
      );
      assert.ok(
        !bare,
        `${file} reads var(${NAV_CLEARANCE_VAR}) with no fallback. Use ` +
          `var(${NAV_CLEARANCE_VAR}, 0px) so the declaration stays valid when ` +
          `globals.css isn't loaded.`
      );
    });

    it(`${file} has no hardcoded fixed bottom-<n> launcher`, () => {
      const offenders = stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => HARDCODED_BOTTOM_UTILITY.test(line))
        .map(([n, line]) => `${file}:${n}  ${line.trim()}`);

      assert.deepEqual(
        offenders,
        [],
        `Hardcoded bottom offset on a fixed element — this is the MONEY-1151 ` +
          `regression. Use calc(var(${NAV_CLEARANCE_VAR}) + …):\n${offenders.join("\n")}`
      );
    });
  }

  it("the panels also subtract the bar from their own height", () => {
    // Half the bug was invisible: the open panel ran to the viewport floor, so
    // the bar covered its composer and the chat could be opened but not typed
    // into. Each panel's height must net out the reserved space too.
    const missing = FLOATING_CHAT_SURFACES.filter((file) => {
      const src = readFileSync(file, "utf8");
      return !src.includes(`- var(${NAV_CLEARANCE_VAR}`);
    });
    assert.deepEqual(
      missing,
      [],
      `Panel height does not subtract ${NAV_CLEARANCE_VAR}, so the bottom bar ` +
        `will cover its composer on phone/tablet: ${missing.join(", ")}`
    );
  });

  it("the shared variables are defined exactly once, in globals.css", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    assert.ok(
      globals.includes(`${NAV_HEIGHT_VAR}:`),
      `${NAV_HEIGHT_VAR} must be declared in app/globals.css — it is the one ` +
        `definition of the bar's height.`
    );
    assert.ok(
      globals.includes("body:has(.gmbn-nav)"),
      `The body:has(.gmbn-nav) rule is what keeps ${NAV_CLEARANCE_VAR} at 0 on ` +
        `routes where the bar is not mounted (HIDDEN_PREFIXES) — without it, ` +
        `marketing and auth pages reserve space for a bar that isn't there.`
    );

    // The nav must measure itself off the shared height, not a literal, or the
    // bar and the space reserved for it can drift apart.
    const navCss = readFileSync("components/global-mobile-nav.css", "utf8");
    assert.ok(
      // \s* inside the parens: prettier wraps a long var() with a fallback
      // across lines, so the var name is not necessarily adjacent to `var(`.
      new RegExp(`height:\\s*var\\(\\s*${NAV_HEIGHT_VAR}\\s*[,)]`).test(navCss),
      `.gmbn-nav must take its height from var(${NAV_HEIGHT_VAR}) so the bar ` +
        `and the clearance below it can never disagree. A literal fallback ` +
        `inside the var() is fine — a second bare declaration is not.`
    );
    assert.ok(
      !/height:\s*calc\(60px/.test(navCss),
      `global-mobile-nav.css declares a bare 60px height — that is a second ` +
        `definition of the bar height and will drift from ${NAV_HEIGHT_VAR}. ` +
        `A literal is only allowed as a var() fallback.`
    );
  });

  it("the clearance query is the exact complement of Tailwind's lg", () => {
    // `max-width: 1023.98px` leaves a fractional sliver (1023.99px, reachable
    // via zoom / fractional DPR) where lg:hidden has not yet fired so the bar
    // is still painted, but no space is reserved for it.
    const globals = stripBlockComments(readFileSync("app/globals.css", "utf8"));
    assert.ok(
      /@media\s+not all and \(min-width:\s*1024px\)/.test(globals),
      `The ${NAV_CLEARANCE_VAR} media query must be ` +
        `"not all and (min-width: 1024px)" — the exact complement of the lg ` +
        `breakpoint that hides .gmbn-nav. A max-width cap leaves a gap.`
    );
    assert.ok(
      !/max-width:\s*1023/.test(globals),
      `A max-width: 1023.x cap cannot exactly complement min-width: 1024px.`
    );
  });

  it("the scan actually reads real files (anti-rot guard)", () => {
    // If a panel is renamed/moved, readFileSync would throw rather than
    // vacuously pass — but pin non-trivial content so a stub file also fails.
    for (const file of SCANNED_FILES) {
      const src = readFileSync(file, "utf8");
      assert.ok(
        src.length > 1000,
        `Expected ${file} to be a real component, saw ${src.length} bytes — moved?`
      );
    }
  });
});
