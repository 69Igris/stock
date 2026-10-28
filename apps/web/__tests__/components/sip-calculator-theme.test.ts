/**
 * MONEY-1211 E1 — the shared SIP calculator reads in BOTH themes.
 *
 * ## What was already true when this file was written
 *
 * The ticket named `components/etf/EtfSipCalculator.tsx` — a 520-line fork on
 * dark-only Tailwind. That fork is deleted and folded into
 * `components/mf/SipCalculator.tsx`, and `__tests__/mf/sip-calculator-etf-mode.test.ts`
 * already guards the fold: the `bg-white/…` fills, the `CircleDollarSign` →
 * `IndianRupee` swap, colour literals in the TSX, and every token the `.sip-*`
 * rules consume being defined in both themes. The source guards below are
 * restated at the path the ticket asked for; they are cheap, and a rule with
 * two independent statements does not quietly evaporate when one file is
 * refactored.
 *
 * ## What NONE of that could see — and what this file is really for
 *
 * The reported defect is the RANGE SLIDER, and it survived every check above.
 * `.sip-range` declared exactly one colour:
 *
 *     .sip-range { accent-color: var(--emerald); }
 *
 * That is a token. It is defined in both themes. It contains no literal. Every
 * existing assertion passes — and the control is still broken, because
 * `accent-color` only tints the THUMB and the filled portion. The empty track
 * is left to the user agent, which paints its default light grey (~#e9e9ed)
 * since nothing in this app declares `color-scheme`. On the cream `--paper`
 * card that grey is all but invisible; in dark mode the same grey is the only
 * reason the control shows at all. One UA default was doing the work of two
 * themes, and no amount of token-checking reveals it.
 *
 * So the guard here is not "is this a token" but "does the rule PAINT the
 * thing at all": an explicit track background, both vendor thumb
 * pseudo-elements, and a focus ring to replace the one `appearance: none`
 * removes. It also extends the no-literal rule to the STYLESHEET, which the
 * existing file only applied to the TSX — that is where the two hard-coded
 * `rgba(244, 237, 224, …)` values in the corpus card were hiding.
 *
 * Source: apps/web/components/mf/SipCalculator.tsx
 *         apps/web/components/mf/detail-playful.css
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `__dirname`, not `import.meta.dirname`: tsx loads apps/web tests as CJS.
const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * LINE comments before BLOCK comments — MONEY-1143.
 *
 * Load-bearing here for a specific reason: `SipCalculator.tsx`'s own docblock
 * NAMES the literals this file forbids ("bg-white/[0.06] accent-emerald-400",
 * "CircleDollarSign"), because that is how the fold recorded what it fixed.
 * Asserting over the raw bytes would fail on the explanation rather than the
 * code — and the tempting "fix" of deleting the explanation would trade real
 * documentation for a green regex. Strip first, assert second.
 */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const componentSrc = read("components/mf/SipCalculator.tsx");
const live = stripComments(componentSrc);
const css = read("components/mf/detail-playful.css");

/** The `.sip-range*` rules, comments stripped, as one blob. */
function sliderRules(): string {
  const blocks = stripComments(css)
    .split(/(?=^\.)/m)
    .filter((b) => /^\.sip-range/.test(b));
  assert.ok(
    blocks.length >= 4,
    `expected the track + both thumb pseudo-elements + focus rule, ` +
      `found ${blocks.length} \`.sip-range*\` blocks`
  );
  return blocks.join("\n");
}

describe("MONEY-1211 E1 — source guards", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    // Without this, every `doesNotMatch` below is unfalsifiable: a stripper
    // that ate the whole file would report a perfectly clean component.
    const fixture = [
      "// a line comment naming bg-white/[0.06] and /* opening nothing",
      'const KEEP = "IndianRupee";',
      "/* a real block naming CircleDollarSign */",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(stripped, /KEEP/);
    assert.doesNotMatch(stripped, /a real block/);
    // And the real file must still have a body left after stripping.
    assert.ok(
      live.replace(/\s/g, "").length > 2000,
      "stripComments ate the component — the assertions below prove nothing"
    );
  });

  it("[regression] renders no bg-white/ fill", () => {
    assert.doesNotMatch(
      live,
      /bg-white\//,
      "a bg-white/… fill is invisible on the cream light theme"
    );
  });

  it("[regression] uses IndianRupee, never CircleDollarSign", () => {
    assert.doesNotMatch(
      live,
      /CircleDollarSign/,
      'a "$" glyph beside ₹ amounts, in an India-only product'
    );
    assert.match(live, /IndianRupee/);
  });

  it("names no colour literal — every colour resolves through var(--…)", () => {
    for (const [re, what] of [
      [/#[0-9a-fA-F]{3,8}\b/, "a hex colour"],
      [/\brgba?\(/, "an rgb()/rgba() colour"],
      [/\bhsla?\(/, "an hsl()/hsla() colour"],
    ] as Array<[RegExp, string]>) {
      assert.doesNotMatch(live, re, `SipCalculator.tsx names ${what}`);
    }
  });

  it("uses no Tailwind literal-palette utility", () => {
    // `accent-emerald-400` was the fork's slider colour: a fixed mint that
    // does not move with the theme, unlike `var(--emerald)`.
    assert.doesNotMatch(
      live,
      /\b(?:bg|text|border|accent|ring|fill|stroke|from|via|to|shadow|divide|outline|decoration)-(?:white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/,
      "a fixed Tailwind palette colour does not follow the theme"
    );
  });
});

describe("MONEY-1211 E1 — the range slider paints its own track and thumb", () => {
  it("[regression] does not leave the track to accent-color alone", () => {
    const rules = sliderRules();
    // The exact prior state: `accent-color` and nothing else. It is a token,
    // it is theme-complete, and the track was still a UA default.
    assert.match(
      rules,
      /appearance:\s*none/,
      "without `appearance: none` the UA still owns the track"
    );
    assert.ok(
      !/accent-color/.test(rules) || /background:\s*var\(--/.test(rules),
      "`accent-color` may stay only alongside an explicit track background"
    );
  });

  it("the track has an explicit token background AND border", () => {
    // Background alone is not enough on either paper: `--rule-softer` is a
    // low-alpha wash of the ink, so the 1.5px `--rule-soft` edge is what
    // actually defines the rail's extent.
    const track = stripComments(css)
      .split(/(?=^\.)/m)
      .find((b) => /^\.sip-range\s*\{/.test(b));
    assert.ok(track, "the `.sip-range` track rule is gone");
    assert.match(
      track,
      /background:\s*var\(--[a-z0-9-]+\)/,
      "no token track fill"
    );
    assert.match(
      track,
      /border:[^;]*var\(--[a-z0-9-]+\)/,
      "no token track edge"
    );
  });

  it("both vendor thumb pseudo-elements are styled", () => {
    // WebKit and Gecko do not share a thumb selector, and neither inherits
    // from the other. Styling one leaves the other on the UA default — the
    // same single-theme failure, split by browser instead of by theme.
    for (const sel of ["::-webkit-slider-thumb", "::-moz-range-thumb"]) {
      assert.ok(
        new RegExp(`\\.sip-range${sel}\\s*\\{`).test(css),
        `.sip-range${sel} is unstyled — that browser keeps the UA thumb`
      );
    }
  });

  it("the thumb is ringed so it reads on EITHER paper", () => {
    const rules = sliderRules();
    // An emerald disc alone can sit accent-on-accent. `--paper` and `--ink`
    // both invert with the theme, so the ring is always the opposite of the
    // card behind it — that, not the fill, is what guarantees contrast.
    assert.match(rules, /border:[^;]*var\(--paper\)/, "no --paper ring");
    assert.match(rules, /box-shadow:[^;]*var\(--ink\)/, "no --ink halo");
  });

  it("keyboard focus survives appearance: none", () => {
    // `appearance: none` also removes the UA focus ring. These are the only
    // keyboard-operable controls in the card, so it has to be put back.
    assert.match(
      stripComments(css),
      /\.sip-range:focus-visible\s*\{[^}]*outline:[^;]*var\(--[a-z0-9-]+\)/,
      "no visible keyboard focus ring on the sliders"
    );
  });
});

describe("MONEY-1211 E1 — the stylesheet holds no colour literal either", () => {
  it("no .sip-* / .det-* rule hardcodes a colour", () => {
    // The existing ETF-mode file applies this rule to the TSX only. Both
    // hard-coded `rgba(244, 237, 224, …)` values lived here, inside the
    // pinned-dark corpus card, where the token ladder already had a name for
    // them (`--code-dim`).
    const blocks = stripComments(css)
      .split(/(?=^\.)/m)
      .filter((b) => /^\.(sip|det)-/.test(b));
    assert.ok(
      blocks.length >= 15,
      `parsed ${blocks.length} rules, expected >= 15`
    );

    const offenders: string[] = [];
    for (const b of blocks) {
      const name = b.match(/^(\.[^\s{,]+)/)?.[1] ?? "?";
      for (const [re, what] of [
        [/#[0-9a-fA-F]{3,8}\b/, "hex"],
        [/\brgba?\(/, "rgb()"],
        [/\bhsla?\(/, "hsl()"],
      ] as Array<[RegExp, string]>) {
        if (re.test(b)) offenders.push(`${name} (${what})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these rules pin a colour that cannot follow the theme:\n  " +
        offenders.join("\n  ")
    );
  });

  it("accent-coloured TEXT on paper uses the AA-safe variant", () => {
    // `--emerald` is the FILL token (live dot, thumb, gain bar) and is ~3.4:1
    // on cream — the "mint-on-cream values in light mode" half of the report.
    // `--emerald-text` is the palette's darkened variant for accent TEXT, and
    // maps back to the bright token in dark mode.
    const knob = stripComments(css)
      .split(/(?=^\.)/m)
      .find((b) => /^\.sip-knob-value\s*\{/.test(b));
    assert.ok(knob, "the `.sip-knob-value` rule is gone");
    assert.match(
      knob,
      /color:\s*var\(--emerald-text\)/,
      "the slider read-out is accent TEXT on paper, so it needs --emerald-text"
    );
  });
});
