/**
 * MONEY-1255 — one empty-state body across /stock, /mf and /etf.
 *
 * Nineteen sections each wrote their own "nothing here" sentence. The founder
 * decision is that the visible body is now `SECTION_EMPTY_BODY` everywhere.
 *
 * ## What this file is really guarding
 *
 * Not the flatten — that is a one-line change anyone can see in a diff. It
 * guards the two ways the flatten can go WRONG, which are opposite:
 *
 *   TOO LITTLE. A section keeps (or re-grows) its own prose, and the page goes
 *   back to nineteen voices. `emptyMessage` still exists on `SectionShell`
 *   because the `/discover` lane is out of scope and still passes prose, so
 *   nothing in the type system stops a stock section from reaching for it.
 *
 *   TOO MUCH. Nine of the deleted sentences encoded a real distinction — *we
 *   have not fetched it* versus *the exchange genuinely published nothing* —
 *   and `StockShareholdingSection` carries a comment recording that its
 *   PREVIOUS copy made the wrong one of those claims and was rewritten for
 *   exactly that reason (MONEY-1205). Deleting the meaning outright
 *   re-introduces a closed defect. It is DEMOTED to `emptyNote`, which renders
 *   as the box's tooltip.
 *
 * So: a sweep that fails on bespoke prose, and a table that fails on a missing
 * demotion. Either alone is satisfiable by doing the wrong thing.
 *
 * Source: apps/web/components/stock/SectionShell.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";
import {
  fundStatsState,
  historyCellText,
  type FundStatsHistory,
} from "@/components/mf/FundKeyStatsGrid";

const WEB = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/**
 * LINE comments first, then BLOCK comments — MONEY-1143, and load-bearing
 * here for the same reason it is in `vendor-labels-hidden.test.ts`. Reversed,
 * a `//` line containing the block-open sequence swallows the rest of the file
 * and every absence assertion below passes because the code was eaten rather
 * than because it is gone.
 *
 * It matters in the other direction too: every file this sweeps EXPLAINS its
 * demotion in a comment that necessarily quotes the sentence being demoted, so
 * a presence assertion run against un-stripped source would be satisfied by
 * the explanation instead of by the code.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Glue adjacent string literals back together.
 *
 * These notes are long enough to be written as `"..." + "..."` across lines,
 * so an `includes()` on the raw source can fail on a phrase that IS present
 * and merely reflowed by prettier — an assertion that breaks on formatting is
 * an assertion people delete. Matching the JOINED text means the guard is
 * about the sentence, not about where the line wraps.
 */
function glue(src: string): string {
  return src.replace(/"\s*\+\s*"/g, "");
}

/**
 * Drop `import` lines.
 *
 * M18 of the mutation battery survived without this: replacing a rendered
 * `{SECTION_EMPTY_BODY}` with the old literal prose left the IMPORT behind, so
 * a presence check on the identifier still passed while the screen showed
 * bespoke copy again. A file that imports the constant and does not use it is
 * exactly the regression, so the import must not be able to satisfy the test.
 */
function stripImports(src: string): string {
  // `[^;]*` deliberately, not `[\s\S]*? from "…";` — a side-effect import
  // (`import "./detail-playful.css";` in NavGrowthChart) has no `from`, so the
  // lazier pattern runs on past it and swallows real code up to the next
  // import that does. Terminating on the first line-final semicolon handles
  // multi-line named imports and side-effect imports alike.
  return src.replace(/^import\b[^;]*;$/gm, "");
}

/** The dashed box, as a className. Copy-pasted into four files before this. */
const DASHED_BOX = "border-2 border-dashed border-[var(--rule-soft)]";

/**
 * Every component that renders a section on the three pages in scope.
 *
 * Directory sweep rather than a hand list: MONEY-1207's lesson is that a guard
 * scoped to the files that happened to break at the time is a guard a new file
 * walks straight past. `/discover` is deliberately NOT here — it mounts the
 * same `SectionShell` and is out of this decision's scope.
 */
function inScopeFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["components/stock", "components/mf"]) {
    for (const f of readdirSync(join(WEB, dir))) {
      if (f.endsWith(".tsx")) out.push(`${dir}/${f}`);
    }
  }
  for (const extra of [
    "components/FundCompositionSection.tsx",
    "app/stock/[symbol]/client.tsx",
    "app/mf/[schemeCode]/client.tsx",
    "app/etf/[symbol]/client.tsx",
  ]) {
    if (existsSync(join(WEB, extra))) out.push(extra);
  }
  return out.sort();
}

/**
 * Files another agent held open while MONEY-1255 landed, so their migration
 * was handed over as a patch rather than applied here.
 *
 * This exemption CANNOT rot, because it is asserted from both sides: each
 * entry must still carry its bespoke box. The moment the handover patch lands,
 * this test goes red and the only way to green is deleting the entry — which
 * is the point. An exemption that stays green after the thing it excuses is
 * fixed is just a hole.
 */
// Empty. Both entries were handed over and have since been migrated — the
// assertion below FAILS on a stale entry rather than letting one rot here, so
// an empty list is the steady state, not a sign the guard was switched off.
const PENDING_HANDOVER: readonly string[] = [];

describe("MONEY-1255 — the shared body", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    const fixture = [
      "const a = 1;",
      "// a line comment mentioning a/* which opens nothing",
      'const KEEP = "emptyNote";',
      "/* a real block */",
      "const b = 2;",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(
      stripped,
      /KEEP/,
      "LINE before BLOCK, or every assertion in this file is unfalsifiable"
    );
    assert.doesNotMatch(stripped, /a real block/);
  });

  it("is exactly the founder's sentence", () => {
    assert.equal(SECTION_EMPTY_BODY, "No data available");
  });

  it("is what an empty section renders when the caller says nothing", () => {
    const shell = stripComments(read("components/stock/SectionShell.tsx"));
    assert.match(
      shell,
      /\{children \?\? SECTION_EMPTY_BODY\}/,
      "SectionEmpty must fall back to the shared body, not to prose"
    );
    // The old default was a literal sentence in this position. A regression
    // here would look identical in a screenshot of a section that passes
    // `emptyMessage`, and different everywhere else.
    assert.doesNotMatch(
      shell,
      /Nothing published for this stock yet/,
      "the per-page default sentence is gone"
    );
  });

  it("SectionShell's empty branch renders SectionEmpty, not its own box", () => {
    const shell = stripComments(read("components/stock/SectionShell.tsx"));
    const branch = shell.slice(shell.indexOf("      ) : empty ? ("));
    assert.ok(branch.length > 0, "could not locate the empty branch");
    assert.match(branch.slice(0, 600), /<SectionEmpty\b/);
  });

  it("stays theme-aware — tokens only, no literal colours", () => {
    const shell = read("components/stock/SectionShell.tsx");
    for (const fn of ["export function SectionEmpty(", "SectionEmptyInline("]) {
      const start = shell.indexOf(fn);
      assert.notEqual(start, -1, `${fn} was renamed or removed`);
      const body = stripComments(shell.slice(start, start + 900));
      assert.match(body, /var\(--/, `${fn} must use theme tokens`);
      assert.doesNotMatch(
        body,
        /#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/,
        `${fn} must not hard-code a colour`
      );
    }
  });
});

describe("MONEY-1255 — no section re-grows bespoke prose", () => {
  it("no in-scope component hand-rolls the dashed empty box", () => {
    const offenders = inScopeFiles().filter(
      (rel) =>
        rel !== "components/stock/SectionShell.tsx" &&
        !PENDING_HANDOVER.includes(rel as (typeof PENDING_HANDOVER)[number]) &&
        stripComments(read(rel)).includes(DASHED_BOX)
    );
    assert.deepEqual(
      offenders,
      [],
      "these re-type SectionShell's empty box instead of importing " +
        "`SectionEmpty`. That className drifted in four files before this."
    );
  });

  it("no in-scope component passes `emptyMessage`", () => {
    // The prop still exists for `/discover`, which is out of scope. Nothing in
    // the type system keeps a stock section off it, so this does.
    const offenders = inScopeFiles().filter(
      (rel) =>
        rel !== "components/stock/SectionShell.tsx" &&
        !PENDING_HANDOVER.includes(rel as (typeof PENDING_HANDOVER)[number]) &&
        /emptyMessage\s*=/.test(stripComments(read(rel)))
    );
    assert.deepEqual(
      offenders,
      [],
      "the empty BODY is generic everywhere on these three pages — the " +
        "section-specific sentence belongs in `emptyNote`, which renders as " +
        "the box's tooltip"
    );
  });

  it("the handover exemption is still needed, entry by entry", () => {
    for (const rel of PENDING_HANDOVER) {
      const src = stripComments(read(rel));
      assert.ok(
        src.includes(DASHED_BOX) || /emptyMessage\s*=/.test(src),
        `${rel} has been migrated — delete it from PENDING_HANDOVER so the ` +
          "sweep above starts covering it"
      );
    }
  });

  it("nested sub-empties use the shared inline body too", () => {
    // The dashed-box sweep cannot see these: a sub-panel empty inside a
    // section that HAS data is bare text by design (two nested dashed boxes
    // read as a broken layout), so it has no className to sweep for. Counts,
    // because a revert of one of the three derivatives panels would otherwise
    // leave the other two satisfying any presence check.
    const expected: Array<[string, number]> = [
      ["components/stock/StockDerivativesTab.tsx", 3],
      ["components/stock/StockFundsHolding.tsx", 1],
    ];
    for (const [rel, n] of expected) {
      const found = (
        stripComments(read(rel)).match(/<SectionEmptyInline\b/g) ?? []
      ).length;
      assert.equal(
        found,
        n,
        `${rel} must render ${n} shared inline empty state(s), found ${found}`
      );
    }
  });

  it("the surfaces with no SectionShell still render the shared body", () => {
    // These are plain paragraphs and stat cells, not sections with a shell.
    // They are in scope all the same — the founder decision is about what the
    // reader sees, not about which primitive happens to render it.
    for (const rel of [
      "app/stock/[symbol]/client.tsx",
      "components/mf/FundAboutCard.tsx",
      "components/mf/NavGrowthChart.tsx",
      "components/mf/FundKeyStatsGrid.tsx",
      "components/FundCompositionSection.tsx",
    ]) {
      assert.match(
        stripImports(stripComments(read(rel))),
        /SECTION_EMPTY_BODY/,
        `${rel} must RENDER the shared body, not merely import it`
      );
    }
  });

  it("no retired sentence has crept back onto any in-scope surface", () => {
    // The sweeps above are structural — they catch the dashed box and the
    // `emptyMessage` prop. This one catches the same regression expressed as
    // plain text in a file that never used either, which is how the copy got
    // to nineteen voices in the first place.
    const RETIRED = [
      "Nothing published for this stock yet",
      "No description available",
      "No news for",
      "No corporate actions on record",
      "No NAV history available",
      "Holdings breakdown not generated",
      "No short sales disclosed",
      "No open borrow positions published",
      "No MWPL row published",
    ];
    const offenders: string[] = [];
    for (const rel of inScopeFiles()) {
      if (PENDING_HANDOVER.includes(rel as (typeof PENDING_HANDOVER)[number])) {
        continue;
      }
      const src = glue(stripComments(read(rel)));
      for (const phrase of RETIRED) {
        if (src.includes(phrase)) offenders.push(`${rel}: "${phrase}"`);
      }
    }
    assert.deepEqual(offenders, [], "retired empty-state prose is back");
  });

  it("the corp-actions empty branch returns the shared box directly", () => {
    // Pinned to the BRANCH, not to the file. `stock-tabs-split.test.ts` only
    // asserts the component mentions `SectionEmpty` somewhere, which a second
    // return placed above this one satisfies while rendering something else
    // entirely (mutation M20 survived exactly that way).
    const src = stripComments(
      read("components/stock/StockCorpActionsHistoryCard.tsx")
    );
    // Anchored on the FIRST element the branch returns, not on "SectionEmpty
    // appears somewhere nearby": a decoy `return (<div …/>)` inserted above it
    // leaves the real one well inside any fixed-width window, and that is how
    // this assertion survived its own mutation on the first attempt.
    const m =
      /if \(actions\.length === 0\)\s*\{\s*return \(\s*(<[A-Za-z][A-Za-z0-9]*)/.exec(
        src
      );
    assert.ok(m, "the empty branch was renamed, removed, or returns nothing");
    assert.equal(
      m[1],
      "<SectionEmpty",
      "the empty branch must return the shared box first — not a silent " +
        "collapse and not markup of its own"
    );
  });

  it("the two dead components are gone, not merely unimported", () => {
    // Verified zero importers before deletion; asserted here because an
    // un-deleted copy is exactly how a bespoke empty state comes back.
    for (const rel of [
      "components/stock/StockShareholdingTab.tsx",
      "components/stock/StockCorpActionsCard.tsx",
    ]) {
      assert.equal(existsSync(join(WEB, rel)), false, `${rel} is back`);
    }
  });
});

/**
 * The nine sentences that meant something, and where each one went.
 *
 * Keyed by the phrase that carries the DISTINCTION, not by the whole sentence
 * — a reworded note is fine, a note that stops saying which of the two causes
 * applies is not.
 */
const DEMOTED: Array<{ file: string; phrase: string; why: string }> = [
  {
    file: "components/stock/StockShareholdingSection.tsx",
    phrase: "gap in our coverage rather than in the exchange's filings",
    why:
      "MONEY-1205: the copy before this claimed NSE had published nothing, " +
      "which is false — NSE files one for every listed company and the gap " +
      "is our sync. Losing this re-opens that defect.",
  },
  {
    file: "components/stock/StockInsiderTimeline.tsx",
    phrase: "The exchange has published none for this stock",
    why: "the other half of the distinction: a real absence, not our gap",
  },
  {
    file: "components/stock/StockDealsTab.tsx",
    phrase: "coverageNote(coverage)",
    why: "the covered WINDOW — without it, 'no deals' and 'no backfill' read alike",
  },
  {
    file: "components/stock/StockDerivativesTab.tsx",
    phrase: "Nothing has been published for",
    why: "a cash-only name is absent from the F&O file — a fact about the stock",
  },
  {
    file: "components/stock/StockFundsHolding.tsx",
    phrase: "have not landed yet",
    why: "both causes are possible and indistinguishable, so the note says both",
  },
  {
    file: "components/stock/StockCorpActionsHistoryCard.tsx",
    phrase: "is on record for",
    why: "genuinely 'none declared', NOT 'the fetch failed'",
  },
  {
    file: "components/mf/MfPortfolioTab.tsx",
    phrase: "published one we can read yet",
    why: "'we can read' is the claim — a PDF our parser cannot open is our gap",
  },
  {
    file: "components/mf/NavGrowthChart.tsx",
    phrase: "once the fund has a series we can read",
    why: "the coverage caveat that used to render as a second visible line",
  },
  {
    file: "components/FundCompositionSection.tsx",
    phrase: "not a reading of the AMC's filed portfolio disclosure",
    why:
      "the AI-estimate caveat. Also rendered twice IN the result, so this is " +
      "a demotion and not the only place a reader is told.",
  },
];

describe("MONEY-1255 — the provenance survives the flatten", () => {
  for (const { file, phrase, why } of DEMOTED) {
    it(`${file} still carries its distinction`, () => {
      const src = glue(stripComments(read(file)));
      assert.ok(
        src.includes(phrase),
        `"${phrase}" is gone from the CODE of ${file} (comments stripped). ${why}`
      );
    });
  }

  it("StockDealsTab's coverage note is a real string, not markup", () => {
    // `coverageNote` exists because the box no longer renders JSX. If it
    // silently returned null for a populated coverage window, the tooltip
    // would be blank and this file's whole point would be lost.
    const src = read("components/stock/StockDealsTab.tsx");
    const start = src.indexOf("export function coverageNote(");
    assert.notEqual(start, -1, "coverageNote was renamed or removed");
    const body = src.slice(start, src.indexOf("\nfunction CoverageLine"));
    assert.match(body, /partial backfill/, "the backfill caveat must survive");
    assert.match(body, /continuousDays/, "the session count must survive");
  });

  it("the demoted notes reach a TOOLTIP, not the visible body", () => {
    const shell = stripComments(read("components/stock/SectionShell.tsx"));
    assert.match(
      shell,
      /title=\{tip\}/,
      "SectionEmpty must render its note as a native tooltip"
    );
    assert.match(
      shell,
      /note=\{emptyNote \?\? prov\.note\}/,
      "SectionShell must forward emptyNote (falling back to the envelope's " +
        "note, which otherwise has nowhere to render on an empty section)"
    );
    // The failure this pins: rendering the note as the body would satisfy
    // "the phrase is still in the file" while undoing the whole change.
    assert.doesNotMatch(
      shell,
      /\{note\}\s*\n\s*<\/div>/,
      "the note must not be rendered as visible text"
    );
  });
});

describe("MONEY-1255 — the two states that are NOT 'no data available'", () => {
  it("a fund younger than the window still says so", () => {
    // "The fund did not exist yet" is a true fact about the world. Flattening
    // it to "no data available" would state something false — the data is not
    // missing, the years are.
    const young: FundStatsHistory = {
      dataPoints: 620,
      coverageYears: 2.5,
      firstDate: "2024-02-14",
    };
    assert.equal(fundStatsState(young, 5), "too-young");
    const cell = historyCellText(null, 5, young, () => "-");
    assert.equal(cell.value, "Since Feb 2024");
    assert.notEqual(
      cell.value,
      SECTION_EMPTY_BODY,
      "a fund that had not launched is not a fund with no data"
    );
  });

  it("only the not-loaded branch became generic", () => {
    const notLoaded: FundStatsHistory = { dataPoints: 0, coverageYears: null };
    assert.equal(fundStatsState(notLoaded, 5), "not-loaded");
    const cell = historyCellText(null, 5, notLoaded, () => "-");
    assert.equal(cell.value, SECTION_EMPTY_BODY);
    assert.equal(
      cell.hint,
      "NAV history pending",
      "the WHY is demoted to the hint, which is this grid's tooltip"
    );
  });

  it("sparse history keeps its explained dash, not the generic body", () => {
    const sparse: FundStatsHistory = { dataPoints: 4, coverageYears: 6 };
    assert.equal(fundStatsState(sparse, 5), "sparse");
    assert.equal(historyCellText(null, 5, sparse, () => "-").value, "-");
  });

  it("Financials keeps the two-branch empty and its switch button", () => {
    // The comment at the branch forbids claiming the other period is empty
    // from an unfinished probe, so the BUTTON is the only thing that can
    // distinguish "populated period one click away" from "nothing anywhere"
    // now that the prose is gone. Without it the flatten loses a real state.
    const tab = stripComments(read("components/stock/StockFinancialsTab.tsx"));
    assert.match(tab, /<SectionEmpty\b/, "the panel must use the shared box");
    assert.match(
      tab,
      /otherPeriodWithData \? \(/,
      "the switch branch must survive"
    );
    assert.match(
      tab,
      /className="fin-empty-switch"/,
      "the switch button is load-bearing, not decoration"
    );
    assert.match(
      tab,
      /setPeriod\(otherPeriodWithData\)/,
      "the button must still switch period"
    );
    // The unknown branch must stay silent. Any note here would be a claim
    // about a period we have not read.
    const call = tab.slice(tab.indexOf("<SectionEmpty"));
    assert.match(
      call.slice(0, 700),
      /: undefined/,
      "the unknown branch must pass no note"
    );
  });

  it("the dead .fin-empty-card duplicate is gone from the CSS too", () => {
    const css = read("components/stock/financials-playful.css");
    assert.doesNotMatch(
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
      /\.fin-empty-card\s*\{/,
      "that rule was SectionShell's dashed box re-expressed as CSS"
    );
    assert.match(
      css,
      /\.fin-empty-switch\s*\{/,
      "the switch rule must NOT be deleted with it"
    );
  });
});
