/**
 * MONEY-1211 — the ETF SIP calculator fork is gone.
 *
 * `components/etf/EtfSipCalculator.tsx` was a 520-line duplicate of
 * `components/mf/SipCalculator.tsx`, untouched since 26 May and still on
 * pre-playful, dark-only Tailwind. Founder-visible defects (screenshot
 * confirmed): an invisible slider track and mint-on-cream values in LIGHT
 * mode (`bg-white/[0.06] accent-emerald-400`), no dark result card, and a
 * DOLLAR icon captioning the "₹ amount" input of an India-only product.
 *
 * Its three genuine extensions — unit-denominated instalments, projected unit
 * accumulation, and an asset-class tax footnote — were folded into the shared
 * component behind optional props. This file pins:
 *
 *   1. those three extensions, as PURE functions in the CSS-free `sip-math`
 *      module (the component itself imports `./detail-playful.css`, which
 *      node:test/tsx cannot parse — the same constraint the two existing
 *      sip-calculator test files call out);
 *   2. the MF caller's behaviour is unchanged when the ETF props are absent;
 *   3. theme-awareness of the surviving component, in BOTH themes, at the
 *      token level: every class it renders must be defined, and every CSS var
 *      those rules consume must exist under `:root` AND `html.dark`;
 *   4. the fork is actually deleted and nothing imports it.
 *
 * Sources: apps/web/components/mf/sip-math.ts
 *          apps/web/components/mf/SipCalculator.tsx
 *          apps/web/components/mf/detail-playful.css
 *          apps/web/app/etf/[symbol]/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  clamp,
  computeLumpsumFutureValue,
  computeSipFutureValue,
  formatInr,
  formatUnits,
  investedSplitPct,
  isUsableLtp,
  projectedUnitsFor,
  seedReturnFor,
  taxNoteFor,
} from "../../components/mf/sip-math";

// `__dirname`, not `import.meta.dirname`: tsx loads apps/web tests as CJS.
const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Strip comments — this file's sources DOCUMENT the literals they forbid. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const componentSrc = read("components/mf/SipCalculator.tsx");
const liveComponent = stripComments(componentSrc);
const detailCss = read("components/mf/detail-playful.css");
const playfulCss = read("app/playful-app.css");
const etfPage = read("app/etf/[symbol]/client.tsx");

// ══════════════════════════════════════════════════════════════════════
// 1. The fork is gone
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1211 — the duplicate ETF calculator is deleted", () => {
  it("components/etf/EtfSipCalculator.tsx no longer exists", () => {
    assert.equal(
      existsSync(join(ROOT, "components/etf/EtfSipCalculator.tsx")),
      false,
      "the fork is back — two calculators drift, which is how one of them " +
        "sat broken in light mode for three months"
    );
  });

  it("the ETF page mounts the SHARED component in ETF mode", () => {
    const live = stripComments(etfPage);
    assert.doesNotMatch(live, /EtfSipCalculator/);
    assert.match(live, /from "@\/components\/mf\/SipCalculator"/);
    // The two ETF-only props must actually be passed, or the page silently
    // degrades to the MF calculator: no units, no tax note.
    assert.match(live, /<SipCalculator[\s\S]{0,220}ltp=\{ltp\}/);
    assert.match(live, /<SipCalculator[\s\S]{0,220}assetClass=\{assetClass\}/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Theme-awareness — BOTH themes, at the token level
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1211 — the surviving calculator is theme-aware", () => {
  it("[regression] renders no bare bg-white/... fill", () => {
    // THE founder-visible bug: `bg-white/[0.06]` on the slider track and
    // `bg-white/[0.03]` / `bg-white/[0.02]` on the panels are invisible on
    // the cream light theme.
    assert.equal(
      /[^:]bg-white\//.test(liveComponent),
      false,
      "a bg-white/... fill only reads on dark"
    );
    assert.equal(/[^:]bg-black\//.test(liveComponent), false);
  });

  it("[regression] uses IndianRupee, never CircleDollarSign", () => {
    assert.equal(
      liveComponent.includes("CircleDollarSign"),
      false,
      'a "$" glyph next to a "₹ amount" control, in an India-only product'
    );
    assert.match(liveComponent, /IndianRupee/);
  });

  it("hardcodes no colour literal — every fill resolves through var(--…)", () => {
    for (const [re, what] of [
      [/#[0-9a-fA-F]{3,8}\b/, "a hex fill"],
      [/rgba?\(/, "an rgb/rgba fill"],
      [/hsla?\(/, "an hsl fill"],
      [/\btext-emerald-\d/, "a Tailwind emerald text colour"],
      [/\bbg-emerald-\d/, "a Tailwind emerald background"],
      [/\baccent-emerald-\d/, "a Tailwind accent colour"],
    ] as Array<[RegExp, string]>) {
      assert.equal(
        re.test(liveComponent),
        false,
        `SipCalculator.tsx renders ${what}`
      );
    }
  });

  it("every class it renders is defined in detail-playful.css", () => {
    const used = new Set<string>();
    for (const m of liveComponent.matchAll(
      /className=(?:"([^"]*)"|\{`([^`]*)`\})/g
    )) {
      for (const cls of (m[1] ?? m[2] ?? "").split(/[\s${}?:'"+]+/)) {
        if (/^(sip|det)-[a-z0-9-]+$/.test(cls)) used.add(cls);
      }
    }
    assert.ok(
      used.size >= 12,
      `expected the playful classes, found ${used.size}`
    );
    const missing = [...used].filter(
      (c) => !new RegExp(`\\.${c}[\\s,{:.]`).test(detailCss)
    );
    assert.deepEqual(missing, [], "these classes have no CSS rule at all");
  });

  it("every token those rules consume is defined in BOTH themes", () => {
    // The whole point: a token defined only under `:root` renders wrong in
    // dark, and one defined only under `html.dark` renders wrong in light —
    // which is exactly the class of bug the deleted fork shipped.
    const lightStart = playfulCss.indexOf(":root {");
    const darkStart = playfulCss.indexOf("html.dark {");
    assert.ok(lightStart >= 0 && darkStart > lightStart);
    const light = playfulCss.slice(lightStart, darkStart);
    const dark = playfulCss.slice(darkStart);

    const sipRules = detailCss
      .split(/(?=^\.)/m)
      .filter((b) => /^\.(sip|det)-/.test(b));
    assert.ok(sipRules.length >= 15);

    const tokens = new Set<string>();
    for (const m of sipRules.join("\n").matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      tokens.add(m[1]!);
    }
    // plus the two tokens the component sets inline
    for (const m of liveComponent.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      tokens.add(m[1]!);
    }
    assert.ok(
      tokens.size >= 8,
      `expected several tokens, found ${tokens.size}`
    );

    const undefinedInLight = [...tokens].filter(
      (t) => !new RegExp(`^\\s*${t}:`, "m").test(light)
    );
    const undefinedInDark = [...tokens].filter(
      (t) => !new RegExp(`^\\s*${t}:`, "m").test(dark)
    );
    assert.deepEqual(undefinedInLight, [], "undefined in the LIGHT theme");
    assert.deepEqual(undefinedInDark, [], "undefined in the DARK theme");
  });

  it("the disabled Units tab is dimmed with a token, not an opacity hack", () => {
    assert.match(detailCss, /\.det-tab-btn:disabled\s*\{[^}]*var\(--ink-4\)/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. The three genuine ETF extensions
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1211 seedReturnFor — asset-class default bands", () => {
  it("an explicit override always wins, clamped to 1..30", () => {
    assert.equal(seedReturnFor("Debt", 18), 18);
    assert.equal(seedReturnFor("Equity", 99), 30);
    assert.equal(seedReturnFor("Equity", -4), 1);
  });

  it("falls to the asset-class band when there is no override", () => {
    for (const c of ["Debt", "Bond ETF", "Gilt"]) {
      assert.equal(seedReturnFor(c, null), 7, c);
    }
    for (const c of ["International", "Global equity"]) {
      assert.equal(seedReturnFor(c, null), 10, c);
    }
    for (const c of ["Gold", "Commodity"]) {
      assert.equal(seedReturnFor(c, null), 9, c);
    }
    assert.equal(seedReturnFor("Equity", null), 12);
  });

  it("[MF parity] no asset class at all still means 12%", () => {
    assert.equal(seedReturnFor(null, null), 12);
    assert.equal(seedReturnFor(undefined, undefined), 12);
    assert.equal(seedReturnFor("", null), 12);
  });

  it("a non-finite override is ABSENCE, not a rate", () => {
    assert.equal(seedReturnFor("Debt", Number.NaN), 7);
    assert.equal(seedReturnFor("Debt", Number.POSITIVE_INFINITY), 7);
  });
});

describe("MONEY-1211 taxNoteFor — the ETF-only footnote", () => {
  it("returns null for the MF caller so no tax claim is made", () => {
    assert.equal(taxNoteFor(null), null);
    assert.equal(taxNoteFor(undefined), null);
    assert.equal(taxNoteFor("   "), null);
  });

  it("picks the regime by asset class", () => {
    assert.match(taxNoteFor("Debt")!, /slab rate/);
    assert.match(taxNoteFor("International")!, /12\.5%/);
    assert.match(taxNoteFor("Gold")!, /12\.5%/);
    assert.match(taxNoteFor("Equity")!, /₹1\.25L/);
  });

  it("is case-insensitive", () => {
    assert.equal(taxNoteFor("GILT FUND"), taxNoteFor("gilt fund"));
  });
});

describe("MONEY-1211 isUsableLtp / projectedUnitsFor — units need a real price", () => {
  it("0 is ABSENCE of a price, never a free ETF", () => {
    assert.equal(isUsableLtp(0), false);
    assert.equal(projectedUnitsFor(100000, 0), null);
  });

  it("rejects null / undefined / NaN / Infinity", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        isUsableLtp(v as number | null | undefined),
        false,
        String(v)
      );
      assert.equal(projectedUnitsFor(100000, v as number | null), null);
    }
  });

  it("negative prices are not prices", () => {
    assert.equal(isUsableLtp(-250), false);
    assert.equal(projectedUnitsFor(100000, -250), null);
  });

  it("divides the invested amount by the LTP", () => {
    assert.equal(isUsableLtp(250), true);
    assert.equal(projectedUnitsFor(100000, 250), 400);
  });

  it("null — never 0 — when unavailable, so the row hides instead of lying", () => {
    // A 0 would render "0 units", which is a CLAIM. Absence renders nothing.
    assert.equal(projectedUnitsFor(100000, null), null);
  });
});

describe("MONEY-1211 investedSplitPct — the transposed-clamp bug", () => {
  it("[regression] is not pinned at 100", () => {
    // The fork called `clamp(0, 100, pct)` against `clamp(v, lo, hi)`:
    //   Math.max(100, Math.min(pct, 0)) === 100 for every positive pct.
    // The invested/gain bar therefore read 100% invested at every input.
    const r = computeSipFutureValue(10_000, 10, 12);
    const pct = investedSplitPct(r.invested, r.estimatedValue);
    assert.ok(pct > 45 && pct < 60, `expected ~52%, got ${pct}`);
    assert.notEqual(pct, 100);
  });

  it("[meta] the transposed call really does return 100 — the bug was real", () => {
    assert.equal(clamp(0, 100, 51.6), 100);
    assert.equal(clamp(51.6, 0, 100), 51.6);
  });

  it("clamps to 0..100 and never emits NaN", () => {
    assert.equal(investedSplitPct(200, 100), 100);
    assert.equal(investedSplitPct(100, 0), 0);
    assert.equal(investedSplitPct(100, -5), 0);
    assert.equal(investedSplitPct(Number.NaN, 100), 0);
    assert.equal(investedSplitPct(100, Number.NaN), 0);
  });
});

describe("MONEY-1211 formatting helpers", () => {
  it("formatInr uses Indian magnitudes", () => {
    assert.equal(formatInr(2_323_391), "₹23.23 L");
    assert.equal(formatInr(15_000_000), "₹1.50 Cr");
    assert.equal(formatInr(4_500), "₹4.5k");
    assert.equal(formatInr(720), "₹720");
    assert.equal(formatInr(Number.NaN), "-");
  });

  it("formatUnits scales and never prints NaN", () => {
    assert.equal(formatUnits(400), "400 units");
    assert.equal(formatUnits(4_500), "4.5k units");
    assert.equal(formatUnits(2_400_000), "2.40M units");
    assert.equal(formatUnits(Number.POSITIVE_INFINITY), "-");
  });
});

describe("MONEY-1211 — the ETF lumpsum leg reuses the shared formula", () => {
  it("the component imports computeLumpsumFutureValue rather than inlining it", () => {
    assert.match(liveComponent, /computeLumpsumFutureValue/);
    assert.doesNotMatch(
      liveComponent,
      /Math\.pow\(1 \+ r, months\)/,
      "the fork's inline lumpsum re-derivation is back"
    );
  });

  it("units × LTP is the same instalment as the equivalent rupee amount", () => {
    const viaUnits = computeLumpsumFutureValue(2000 * 250, 10, 12);
    const viaRupees = computeLumpsumFutureValue(500_000, 10, 12);
    assert.deepEqual(viaUnits, viaRupees);
  });
});
