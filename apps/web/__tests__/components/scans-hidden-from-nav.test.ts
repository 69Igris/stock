/**
 * MONEY-1138 — Scans is hidden from navigation, but the ROUTE stays open.
 *
 * Two halves, and they pull in opposite directions, which is the whole point:
 *
 *  1. No navigation surface may offer Scans — to ANY user, founder included.
 *     Previously the sidebar entry was founder-visible via the
 *     `page-visibility-scans` PostHog flag (MONEY-1058).
 *
 *  2. `/discover/scans` must remain reachable by URL for whoever that flag
 *     targets (deepshaswat@gmail.com). So it must NOT be added to
 *     FORCE_DISABLED_ROUTES — that is /paper-trading's mechanism, and it closes
 *     the route as well as the nav entry, which is the opposite of the intent.
 *
 * Getting half of this right looks correct in a screenshot and is wrong: kill
 * -switching hides the item AND locks the founder out of the page they are
 * still building; deleting the route hides it AND loses the work.
 *
 * The ⌘K palette is covered transitively — `CommandPalette.tsx` builds its
 * navigation entries by iterating the exported `sidenavConfig`, so an item
 * absent there cannot appear in the palette. That is asserted below rather
 * than assumed.
 *
 * Source: apps/web/components/Sidebar.tsx, apps/web/lib/actions/feature-flags.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const sidebarSrc = read("components/Sidebar.tsx");
const paletteSrc = read("components/CommandPalette.tsx");
const flagsSrc = read("lib/actions/feature-flags.ts");

/**
 * Strip block and line comments so a commented-out restoration snippet (kept
 * deliberately in the sidebar) is not mistaken for a live nav entry.
 */
function stripComments(src: string): string {
  // LINE comments first, then block comments — the order is load-bearing.
  //
  // Stripping blocks first is what the neighbouring nav tests do, and it is
  // wrong here: `Sidebar.tsx` contains a LINE comment mentioning `tours/*`,
  // whose `/*` opens a phantom block that runs to the next `*/` hundreds of
  // lines later. Measured, it silently deletes 11,192 characters — so an
  // assertion like "Scans is absent" could pass because the text was eaten
  // rather than because the entry is gone. A vacuous pass on a test whose
  // whole job is to notice something is missing is worse than no test.
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Guard against exactly the failure above. Asserting on a live nav href would
 * NOT catch it — measured, the phantom block currently eats 11,192 characters
 * of `Sidebar.tsx` without touching a single `href:` or nav symbol, so every
 * such probe survives and reports nothing. The order bug has to be tested
 * DIRECTLY, on input that reproduces it, or the guard is decoration.
 */
function assertStripCommentsOrderIsCorrect(): void {
  const fixture = [
    "const a = 1;",
    "// a line comment mentioning tours/* which opens nothing",
    'const KEEP_ME = "/discover/scans";',
    "/* a real block */",
    "const b = 2;",
  ].join("\n");

  const stripped = stripComments(fixture);
  assert.match(
    stripped,
    /KEEP_ME/,
    "stripComments must remove LINE comments before BLOCK comments — " +
      "otherwise a `//` comment containing `/*` swallows everything up to " +
      "the next `*/`, and the absence assertions become unfalsifiable"
  );
  assert.doesNotMatch(stripped, /a real block/);
  assert.doesNotMatch(stripped, /a line comment/);
}

describe("MONEY-1138 — Scans hidden from nav, route still open", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    assertStripCommentsOrderIsCorrect();
  });

  it("[regression] no live nav entry points at /discover/scans", () => {
    const live = stripComments(sidebarSrc);
    assert.doesNotMatch(
      live,
      /href:\s*"\/discover\/scans"/,
      "Scans must not appear in the sidenav config for any user"
    );
  });

  it("keeps the restoration snippet, so bringing it back is not archaeology", () => {
    // The entry is commented out rather than deleted on purpose.
    assert.match(
      sidebarSrc,
      /MONEY-1138/,
      "the sidebar should record why Scans is absent"
    );
    assert.match(
      sidebarSrc,
      /\/\/\s*\{\s*href:\s*"\/discover\/scans"/,
      "keep the commented-out entry so restoring it is a one-line revert"
    );
  });

  it("the ⌘K palette derives from sidenavConfig, so it follows automatically", () => {
    // If this ever stops being true, the palette needs its own assertion.
    assert.match(
      paletteSrc,
      /import\s*\{[^}]*sidenavConfig[^}]*\}\s*from\s*"@\/components\/Sidebar"/,
      "CommandPalette must build nav entries from sidenavConfig"
    );
    assert.match(
      paletteSrc,
      /sidenavConfig\.forEach/,
      "palette iterates sidenavConfig — an absent item cannot surface there"
    );
    assert.doesNotMatch(
      stripComments(paletteSrc),
      /"\/discover\/scans"/,
      "the palette must not hard-code a Scans entry of its own"
    );
  });

  it("[regression] /discover/scans is NOT kill-switched — the route stays reachable", () => {
    // The opposite failure: hiding the nav by force-disabling the flag would
    // also lock the founder out of the page via PageGuard.
    const killSwitch = flagsSrc.match(
      /FORCE_DISABLED_ROUTES = new Set<PageRoute>\(\[([\s\S]*?)\]\)/
    );
    assert.ok(killSwitch, "could not locate FORCE_DISABLED_ROUTES");
    assert.doesNotMatch(
      killSwitch[1],
      /discover\/scans/,
      "kill-switching Scans would close the route the founder still needs"
    );
  });

  it("the feature flag and its PostHog mapping are left intact", () => {
    // Route access is still governed by `page-visibility-scans`; removing the
    // mapping would break PageGuard's evaluation for the targeted user.
    assert.match(flagsSrc, /"\/discover\/scans":\s*"page-visibility-scans"/);
  });
});
