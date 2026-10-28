/**
 * META TEST — a table/cards pair shows exactly ONE half at every width
 * (MONEY-1173).
 *
 * ## The bug this locks shut
 *
 * Holdings and the tradebook render the same list twice: a desktop table and a
 * stack of mobile cards. Only one may ever be visible, and which one is decided
 * by two SEPARATE CSS rules that must agree on a boundary:
 *
 *   .um-mobile-only    shown  at <= 1100px, hidden at >= 1101px
 *   .um-hide-lt-1100   hidden at <= 1100px, visible above
 *
 * The original pairing used `.um-hide-mobile`, which hides at **720px**. Those
 * two numbers disagreeing by 380px meant that between 721 and 1100px BOTH
 * halves rendered and the whole holdings list appeared twice. On a tablet, the
 * most common width in that band, the page was simply wrong.
 *
 * MONEY-1171 fixed it by introducing `.um-hide-lt-1100` at the matching
 * boundary. This file exists because that fix is a coincidence of two numbers
 * that live apart, with nothing tying them together:
 *
 *   - `.um-hide-mobile` is the name a future author will reach for. It sounds
 *     like the right complement to `.um-mobile-only` and is not.
 *   - Changing 1100 in one rule and not the other silently reopens the gap.
 *   - CSS has no runtime assertions. Nothing else in the suite can see this —
 *     it renders, it just renders twice, and only at some widths.
 *
 * ## What is asserted
 *
 * The INVARIANT (the two boundaries are equal), not the current value. Moving
 * the app's breakpoint is allowed; moving one of the pair without the other is
 * not.
 *
 * Source: apps/web/app/globals.css
 *         apps/web/app/{holdings,tradebook,tradebook/import/history}/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");
const CSS = readFileSync(join(WEB, "app", "globals.css"), "utf8");

/** Every `@media (<cond>) { … }` block, with its condition and body. */
function mediaBlocks(): Array<{ cond: string; body: string }> {
  const out: Array<{ cond: string; body: string }> = [];
  for (const m of CSS.matchAll(/@media\s*\(([^)]+)\)\s*\{/g)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") depth--;
      i++;
    }
    out.push({ cond: m[1]!.trim(), body: CSS.slice(m.index!, i) });
  }
  return out;
}

/** The `max-width` px at which `cls` is given `display: <value>`. */
function boundaryFor(cls: string, display: string): number | null {
  for (const { cond, body } of mediaBlocks()) {
    const px = /max-width:\s*(\d+)px/.exec(cond);
    if (!px) continue;
    const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*display:\\s*${display}`);
    if (rule.test(body)) return Number(px[1]);
  }
  return null;
}

/** Files that render a responsive table/cards pair. */
const PAIRED_VIEWS = [
  "app/holdings/client.tsx",
  "app/tradebook/client.tsx",
  "app/tradebook/import/history/client.tsx",
];

/** Count `className="… <cls> …"` occurrences, ignoring comments. */
function classUses(src: string, cls: string): number {
  return [...src.matchAll(new RegExp(`className="[^"]*\\b${cls}\\b`, "g"))]
    .length;
}

describe("MONEY-1173 — responsive pairs show exactly one half", () => {
  it("[meta] both classes are actually found in globals.css", () => {
    // A regex that matched nothing would report a perfectly consistent
    // stylesheet and be indistinguishable from a correct one.
    assert.notEqual(
      boundaryFor("um-mobile-only", "flex"),
      null,
      ".um-mobile-only display:flex not found — the CSS parser is broken"
    );
    assert.notEqual(
      boundaryFor("um-hide-lt-1100", "none"),
      null,
      ".um-hide-lt-1100 display:none not found — the CSS parser is broken"
    );
  });

  it("the two halves switch at the SAME breakpoint", () => {
    // The whole bug in one assertion. These were 1100 and 720, so between 721
    // and 1100px both halves rendered and the list appeared twice.
    const shows = boundaryFor("um-mobile-only", "flex");
    const hides = boundaryFor("um-hide-lt-1100", "none");
    assert.equal(
      hides,
      shows,
      `.um-mobile-only shows at <=${shows}px but its complement hides at ` +
        `<=${hides}px. Every width between them renders BOTH halves — the ` +
        `holdings list appears twice. Move both or neither`
    );
  });

  it("the desktop half is hidden below the breakpoint, not above it", () => {
    // Guards the mirror mistake: a complement that hides ABOVE 1100 would blank
    // the table on desktop and show nothing but cards.
    const hidesAbove = mediaBlocks().some(
      ({ cond, body }) =>
        /min-width/.test(cond) &&
        /\.um-hide-lt-1100\s*\{[^}]*display:\s*none/.test(body)
    );
    assert.equal(
      hidesAbove,
      false,
      ".um-hide-lt-1100 must hide BELOW the breakpoint; hiding above it would " +
        "leave desktop with no table at all"
    );
  });

  it("no paired view uses um-hide-mobile as the complement", () => {
    // `.um-hide-mobile` hides at 720px and is the name that caused this bug —
    // it reads like the natural opposite of `.um-mobile-only` and is not. It
    // stays legitimate for STANDALONE controls (the holdings "Add manually"
    // button, the tradebook filter row), which is why this counts pairs rather
    // than banning the class.
    const offenders: string[] = [];
    for (const rel of PAIRED_VIEWS) {
      const src = readFileSync(join(WEB, rel), "utf8");
      const mobileHalves = classUses(src, "um-mobile-only");
      const desktopHalves = classUses(src, "um-hide-lt-1100");
      if (mobileHalves !== desktopHalves) {
        offenders.push(
          `${rel}: ${mobileHalves} um-mobile-only vs ${desktopHalves} um-hide-lt-1100`
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "every .um-mobile-only half needs exactly one .um-hide-lt-1100 partner. " +
        "An unmatched half means either a list that renders twice on tablets, " +
        "or one that vanishes entirely at some width"
    );
  });
});
