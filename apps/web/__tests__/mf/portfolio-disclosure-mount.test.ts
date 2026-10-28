/**
 * The MF page shows the AMC's own portfolio disclosure — MONEY-1204 (14d.1).
 *
 * ## What shipped
 *
 * `components/mf/MfPortfolioTab.tsx` was written, reviewed and tested, and had
 * ZERO references outside itself. `/mf/[schemeCode]` kept rendering only
 * `FundCompositionSection` — the AI/Kuvera reading that 14d.1 exists to demote
 * in favour of the SEBI-mandated monthly disclosure. A component nothing mounts
 * is indistinguishable, from a user's seat, from a component nobody wrote.
 *
 * ## What this pins, and why each half matters
 *
 * The disclosure panel must be mounted UNCONDITIONALLY: it owns its own empty
 * state and its own provenance chip, so a scheme whose AMC has published
 * nothing says exactly that instead of rendering silence. Only 3 of the top-5
 * AMCs are covered today, so "empty" is the common case and it has to be a
 * sentence, not a blank.
 *
 * The AI panel must survive as a FALLBACK rather than being deleted, for two
 * reasons that are easy to lose in a cleanup:
 *
 *   1. It is the only surface that triggers the extraction writing
 *      `FundHolding` — the very table `getMfPortfolioSection` falls back to.
 *   2. It carries the sector and market-cap donuts, which the AMC disclosure
 *      does not provide at all.
 *
 * …but it must be HIDDEN when an official disclosure exists, because that is
 * the one case where the two panels show different numbers for the same fund.
 *
 * Source: apps/web/app/mf/[schemeCode]/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const pageSrc = stripComments(
  readFileSync(join(ROOT, "app/mf/[schemeCode]/client.tsx"), "utf8")
);

describe("MONEY-1204 — MfPortfolioTab is mounted on the fund page", () => {
  it("[regression] the page imports it", () => {
    assert.match(
      pageSrc,
      /import \{ MfPortfolioTab \} from "@\/components\/mf\/MfPortfolioTab"/,
      "an unimported component cannot be mounted"
    );
  });

  it("[regression] and actually renders it", () => {
    // The gap: written, tested, never mounted.
    assert.match(
      pageSrc,
      /<MfPortfolioTab[\s\S]{0,200}?schemeCode=\{schemeCode\}/,
      "the disclosure panel must be on the page"
    );
  });

  it("[regression] renders it unconditionally, so an empty scheme still speaks", () => {
    // Wrapping the mount in the disclosure gate would hide the panel exactly
    // when its empty state is the useful thing on screen: "we track SEBI
    // monthly disclosures for this scheme and the AMC has not published one".
    assert.doesNotMatch(
      pageSrc,
      /disclosure === "official" &&[\s\S]{0,200}?<MfPortfolioTab/,
      "the disclosure panel owns its own empty state; do not gate the mount"
    );
  });
});

describe("MONEY-1204 — the derived composition panel is demoted, not deleted", () => {
  it("[regression] still rendered — it is the only extraction trigger", () => {
    assert.match(
      pageSrc,
      /<FundCompositionSection\s+fundType="MF"/,
      "deleting it starves the FundHolding table the section falls back to"
    );
  });

  it("[regression] MONEY-1405 D4 — mounted for BOTH disclosure states, never while UNKNOWN", () => {
    // The old gate was `no-official`, which made the panel's own data the ONLY
    // thing it could ever show — and that data is a model recollection. Now it
    // is handed the scheme code and serves the AMC's filing, so it must mount
    // when one exists. "Two tables of different numbers for one fund" is still
    // forbidden; it is enforced inside the component (it suppresses its OWN
    // holdings table when the composition came from the disclosure) and
    // asserted in `components/fund-composition-auto-trigger.test.ts`.
    assert.match(
      pageSrc,
      /disclosure !== "unknown" && \(\s*<FundCompositionSection/,
      "a disclosure-derived donut cannot render from a panel that never mounts"
    );
    assert.doesNotMatch(
      pageSrc,
      /disclosure === "no-official" && \(\s*<FundCompositionSection/
    );
  });

  it("[regression] MONEY-1405 D4 — and is given the scheme code + the disclosure state", () => {
    assert.match(
      pageSrc,
      /<FundCompositionSection[\s\S]{0,200}?schemeCode=\{schemeCode\}/,
      "without it the panel can only serve the model recollection"
    );
    // MONEY-1401 — the BEHAVIOUR behind this prop lives in
    // `__tests__/components/fund-composition-auto-trigger.test.ts`
    // ("hasOfficialDisclosure HAS behaviour"). This assertion alone is a scan of
    // the PAGE: measured by mutation, it stays green with the component
    // ignoring the prop outright, because for two releases its only consumer
    // was `shouldAutoExtractComposition`, whose body is `return false`.
    assert.match(
      pageSrc,
      /<FundCompositionSection[\s\S]{0,240}?hasOfficialDisclosure=\{disclosure === "official"\}/
    );
  });

  it("[regression] the gate is TRI-state, and UNKNOWN hides the panel", () => {
    // A boolean would have to guess during the fetch, and guessing "show"
    // means the panel is torn out from under a reader who is already in it
    // whenever the disclosure turns out to exist. Hiding until known only ever
    // ADDS a panel — an ordinary progressive load.
    assert.match(
      pageSrc,
      /useState<\s*"unknown" \| "official" \| "no-official"\s*>\("unknown"\)/,
      'the pre-answer state must be its own value, not folded into "official"'
    );
  });

  it("[regression] a failed read is not evidence of an official disclosure", () => {
    // The fail-safe direction: on error we show MORE (the pre-change
    // behaviour of this page), and "couldn't determine" never masquerades as
    // "the AMC published one".
    assert.match(
      pageSrc,
      /if \(!r\.success\) \{\s*setDisclosure\("no-official"\);/,
      "an unsuccessful read must not hide the composition panel"
    );
    assert.match(
      pageSrc,
      /\.catch\(\(\) => \{[\s\S]{0,160}?setDisclosure\("no-official"\)/,
      "a thrown action must not leave the holdings block half-empty"
    );
  });
});
