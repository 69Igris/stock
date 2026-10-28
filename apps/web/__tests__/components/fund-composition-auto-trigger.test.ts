/**
 * MONEY-1205 — FundCompositionSection must not spend a Gemini call because
 * somebody looked at a page.
 *
 * ## The defect
 *
 * The mount effect called `triggerExtraction()` whenever the cached composition
 * was missing, with no gate above it on the ETF page. A single visit to any of
 * ~446 NSE ETFs without a composition therefore burned an LLM call and wrote
 * another 2024-05 row. 102 of the 111 `fund_composition_meta` rows on prod are
 * ETFs, and one was (re-)extracted the morning this was measured. An "Analyze
 * Holdings" button already existed; nobody had to press it.
 *
 * The rule now lives in `shouldAutoExtractComposition`
 * (packages/core/.../fund-composition-logic.ts) — pure, importable, and the
 * SAME function the component calls, so these cases are not a shadow of it.
 *
 * ## Two layers
 *
 *  A. BEHAVIOUR — the real exported rule, over the full input space.
 *  B. WIRING — the component actually routes its effect through that rule
 *     rather than re-implementing (or ignoring) it, and the provenance footer
 *     no longer prints the model's self-reported confidence as fact. A rule
 *     nothing calls is indistinguishable from no rule.
 *
 * Source: apps/web/components/FundCompositionSection.tsx
 *         packages/core/src/market-data/instruments/fund-composition-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  shouldAutoExtractComposition,
  type AutoExtractContext,
} from "../../../../packages/core/src/market-data/instruments/fund-composition-logic";

const ROOT = join(__dirname, "..", "..");

/** LINE comments before BLOCK comments — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const componentSrc = readFileSync(
  join(ROOT, "components/FundCompositionSection.tsx"),
  "utf8"
);
const componentCode = stripComments(componentSrc);

function ctx(overrides: Partial<AutoExtractContext> = {}): AutoExtractContext {
  return {
    fundType: "MF",
    hasOfficialDisclosure: false,
    isDemoMode: false,
    hasComposition: false,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// A. The rule
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-1205 shouldAutoExtractComposition — the auto-trigger rule", () => {
  it("[regression] NEVER auto-extracts for an ETF, even with nothing else on the page", () => {
    assert.strictEqual(
      shouldAutoExtractComposition(ctx({ fundType: "ETF" })),
      false,
      "~446 ETF pages x 1 Gemini call per view is the runaway this fixes"
    );
  });

  it("[regression] NEVER auto-extracts for an INDEX either", () => {
    assert.strictEqual(
      shouldAutoExtractComposition(ctx({ fundType: "INDEX" })),
      false
    );
  });

  it("[regression] NEVER auto-extracts when an official disclosure exists", () => {
    for (const fundType of ["MF", "ETF", "INDEX"] as const) {
      assert.strictEqual(
        shouldAutoExtractComposition(
          ctx({ fundType, hasOfficialDisclosure: true })
        ),
        false,
        `${fundType}: the AI panel never second-guesses a filed portfolio`
      );
    }
  });

  it("never auto-extracts in demo mode (fabricated data is rendered instead)", () => {
    assert.strictEqual(
      shouldAutoExtractComposition(ctx({ isDemoMode: true })),
      false
    );
  });

  it("never auto-extracts when a composition was already loaded", () => {
    assert.strictEqual(
      shouldAutoExtractComposition(ctx({ hasComposition: true })),
      false
    );
  });

  it("[regression] MONEY-1405 D6 — an MF with nothing to show does NOT auto-extract either", () => {
    // This was the ONE remaining true case, and it rested on a premise
    // measurement has removed: that an auto-extraction produces something
    // worth having when the AMC publishes nothing. `buildExtractionPrompt`
    // interpolates three strings out of our own DB and asks a model for
    // holdings "based on the most recent publicly available SEBI portfolio
    // disclosure" — a disclosure it is never given. 1,800 stored rows across
    // 111 funds, weight sums p50 84% of NAV, 10 funds under 50%.
    assert.strictEqual(
      shouldAutoExtractComposition(ctx()),
      false,
      "a page view is not consent to spend a paid thinking call"
    );
  });

  it("is exhaustive: NONE of the 24 input combinations may trigger", () => {
    let triggered = 0;
    const combos: AutoExtractContext[] = [];
    for (const fundType of ["MF", "ETF", "INDEX"] as const) {
      for (const hasOfficialDisclosure of [false, true]) {
        for (const isDemoMode of [false, true]) {
          for (const hasComposition of [false, true]) {
            const c = {
              fundType,
              hasOfficialDisclosure,
              isDemoMode,
              hasComposition,
            };
            combos.push(c);
            if (shouldAutoExtractComposition(c)) triggered++;
          }
        }
      }
    }
    assert.strictEqual(combos.length, 24);
    // MUTATION: restore `return ctx.fundType === "MF"` → triggered becomes 6
    // and this goes red. VERIFIED.
    assert.strictEqual(
      triggered,
      0,
      "any triggering combination is a page-view-driven LLM spend"
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. The component is actually wired to it
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-1205 FundCompositionSection — wired to the rule, not to a copy", () => {
  it("imports the real rule from packages/core (no local re-implementation)", () => {
    assert.match(
      componentCode,
      /shouldAutoExtractComposition[\s\S]{0,200}?from "@usemoney\/core\/market-data\/instruments\/fund-composition-logic"/,
      "the component must call the same function this file tests"
    );
  });

  it("accepts the hasOfficialDisclosure prop the page uses to gate it", () => {
    assert.match(componentCode, /hasOfficialDisclosure\?: boolean/);
    assert.match(componentCode, /hasOfficialDisclosure = false/);
  });

  it("[regression] the mount effect calls the rule before extracting", () => {
    assert.match(
      componentCode,
      /if \(\s*shouldAutoExtractComposition\(\{[\s\S]{0,240}?\}\)\s*\)\s*\{\s*triggerExtraction\(\);/,
      "extraction on mount must be inside the gate"
    );
  });

  it("[regression] there is no UNGUARDED triggerExtraction() call left in the effect", () => {
    // The original bug in one line: `setIsLoading(false); triggerExtraction();`
    assert.doesNotMatch(
      componentCode,
      /setIsLoading\(false\);\s*triggerExtraction\(\);/,
      "an unconditional call on the no-data path is exactly the defect"
    );
  });

  it("passes hasOfficialDisclosure and fundType into the rule", () => {
    const call = /shouldAutoExtractComposition\(\{([\s\S]{0,240}?)\}\)/.exec(
      componentCode
    );
    assert.ok(call, "expected a shouldAutoExtractComposition({...}) call");
    for (const key of [
      "fundType",
      "hasOfficialDisclosure",
      "isDemoMode",
      "hasComposition",
    ]) {
      assert.ok(
        call![1]!.includes(key),
        `the rule must be given ${key} — a dropped input silently re-opens a path`
      );
    }
  });

  it("still offers an explicit action when nothing is generated", () => {
    // Killing the auto-trigger without an idle state would leave a perpetual
    // "Analyzing…" spinner for an extraction that never starts. NOTHING
    // auto-fires now, so this idle branch is the ONLY way a composition from
    // this source can come into existence.
    assert.match(componentCode, /Estimate holdings with AI/);
    assert.match(componentCode, /\) : !isExtracting \? \(/);
  });

  it("[regression] MONEY-1405 D4 — NEVER a second holdings table beside the disclosure", () => {
    // The old page gate (`disclosure === "no-official"`) was what stopped two
    // tables of different numbers for one fund. D4 relaxed that gate so the
    // donuts can be built FROM the disclosure, which means the guarantee now
    // has to live HERE: when the composition IS the disclosure, `MfPortfolioTab`
    // above is already rendering those exact rows (with the MoM diff this
    // snapshot cannot produce), so this panel renders donuts only.
    //
    // MUTATION: delete the `{!officialTableAbove && (` wrapper → red. VERIFIED.
    assert.match(
      componentCode,
      /const fromDisclosure = composition\.source === "AMC_DISCLOSURE";/
    );
    assert.match(
      componentCode,
      /\{!officialTableAbove && \(\s*<Card>\s*<CardHeader>[\s\S]{0,400}?Portfolio Holdings/,
      "the holdings table must be suppressed when an official one is on screen"
    );
  });

  it("[regression] MONEY-1401 — hasOfficialDisclosure HAS behaviour, and this is it", () => {
    // THE VACUITY. `fund-route-canonical.test.ts` and
    // `portfolio-disclosure-mount.test.ts` both assert that the pages pass
    // `hasOfficialDisclosure={disclosure === "official"}`. Both stayed FULLY
    // GREEN (21/0 and 8/0) with this component ignoring the prop outright —
    // measured, by mutation — because its only consumer was
    // `shouldAutoExtractComposition`, whose body is `return false`. Two source
    // scans were guarding a prop that reached nothing.
    //
    // It reaches something now, and it is the rule those two files' comments
    // already claim: never two tables of different numbers for one fund.
    // `fromDisclosure` answers "is MY data the filing"; `hasOfficialDisclosure`
    // answers "is the filing already on screen". They come apart exactly when
    // this panel is serving a RECOLLECTION on a page whose `MfPortfolioTab`
    // resolved an official disclosure — which is what MONEY-1401 F5's displaced
    // cache entry produced.
    //
    // MUTATION: `fromDisclosure || hasOfficialDisclosure` → `fromDisclosure` →
    //   AssertionError on the first match. VERIFIED red.
    // MUTATION: `||` → `&&` → same. VERIFIED red.
    assert.match(
      componentCode,
      /const officialTableAbove =\s*fromDisclosure \|\| hasOfficialDisclosure;/,
      "the page's answer must join the composition's own"
    );
    // …and it is the value the table is actually gated on, not a dead const.
    assert.match(componentCode, /\{!officialTableAbove && \(/);
    // The orphan the first rule would otherwise leave: "Top holdings shown,
    // covering 84.0%" printed under no table at all.
    assert.match(
      componentCode,
      /\{!officialTableAbove && totalWeight < 99\.5 && \(/,
      "the coverage note belongs to the table it describes"
    );
  });

  it("[regression] MONEY-1405 D4 — the footer tells the truth about WHICH source", () => {
    // A disclosure-derived donut labelled "Estimated by StockSage (AI)" is the
    // MONEY-1205 provenance lie with the polarity reversed.
    assert.match(componentCode, /fromDisclosure \? \(/);
    assert.match(componentCode, /own SEBI portfolio disclosure/);
    assert.match(componentCode, /cap bands from NSE\s*index membership/);
  });

  it("[regression] MONEY-1405 D6 — the control is LABELLED a third-party model estimate", () => {
    // On the control itself, not only in the `title` tooltip a touch device
    // never shows and not only in the result a reader has to run it to see.
    assert.match(
      componentCode,
      /Third-party model estimate/,
      "the button is now the only entry point; it has to say what it spends on"
    );
    assert.match(componentCode, /recollection, not a reading of/);
  });
});

describe("MONEY-1205 FundCompositionSection — the footer stops asserting provenance", () => {
  it("[regression] no longer claims the data was extracted from public disclosures", () => {
    assert.doesNotMatch(
      componentCode,
      /StockSage-extracted from public disclosures/,
      "nothing in this path reads a filed disclosure"
    );
  });

  it("[regression] no longer renders the model's self-reported confidence", () => {
    assert.doesNotMatch(
      componentCode,
      /Confidence: \$\{Math\.round\(composition\.confidence \* 100\)\}%/,
      "0.95-0.99 on 111 rows that were all 26-28 months wrong"
    );
    assert.doesNotMatch(componentCode, /composition\.confidence/);
  });

  it("labels the period as model-reported and unverified where it does render it", () => {
    assert.match(componentCode, /Model-reported period/);
    assert.match(componentCode, /unverified/);
    assert.match(componentCode, /Estimated by StockSage \(AI\)/);
  });

  it("[regression] the content gate is a CALL to the shared rule, whose polarity is testable", () => {
    // THE VACUITY, MONEY-1401. These two cases used to scan for
    // `/isCompositionContentStale\(result\.data\.dataAsOf\)/` and
    // `/result\.data\.source !== "AMC_DISCLOSURE" &&\s*isCompositionContentStale/`
    // against an inline `if (!unverifiedAndStale)`. MEASURED: flipping that `!`
    // — so the component serves ONLY stale recollections and withholds every
    // good one — leaves BOTH regexes matching. A source scan cannot assert a
    // polarity; the two spellings are the same string minus one character.
    //
    // The decision moved into `shouldServeComposition` (packages/core, pure),
    // where both directions are executed in
    // `__tests__/core/market-data/fund-composition-provenance.test.ts`. What is
    // left here is the WIRING, which is all a scan can honestly claim.
    //
    // MUTATION: `if (shouldServeComposition(...))` → `if (!shouldServe...)` →
    //   the provenance suite's behavioural cases are unaffected (they test the
    //   function), so this scan is deliberately NOT the guard for polarity —
    //   it is the guard for "the component calls the shared rule at all".
    //   Deleting the call → red here. VERIFIED.
    assert.match(
      componentCode,
      /shouldServeComposition[\s\S]{0,200}?from "@usemoney\/core\/market-data\/instruments\/fund-composition-logic"/,
      "the rule must be imported from core, not re-implemented inline"
    );
    assert.match(
      componentCode,
      /if \(shouldServeComposition\(result\.data\)\) \{\s*loaded = result\.data;/,
      "the served composition must be the one the rule admitted"
    );
    // …and the inline form it replaced must not come back.
    assert.doesNotMatch(
      componentCode,
      /const unverifiedAndStale =/,
      "an inline polarity is a polarity no test in this file can pin"
    );
  });

  it("the demo period is computed, not a literal that ages past the gate", () => {
    assert.match(componentCode, /dataAsOf: demoDataAsOf\(\)/);
    assert.doesNotMatch(componentCode, /dataAsOf: "20\d\d-\d\d"/);
  });
});
