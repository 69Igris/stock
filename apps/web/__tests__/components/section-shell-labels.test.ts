/**
 * MONEY-1213 — the provenance chip speaks product, not pipeline.
 *
 * `SectionShell.sourceLabel` is the ONLY place a stored source code becomes
 * words a retail investor reads. MONEY-1144 established the rule for vendor
 * names ("Tickertape", "Yahoo") and `vendor-labels-hidden.test.ts` guards it.
 * This file guards the other half of the same rule, which nothing covered:
 *
 *   INGEST VOCABULARY. "Exchange bhavcopy" is not a vendor name, so it walked
 *   straight past the MONEY-1144 guard — but "bhavcopy" is the exchange's own
 *   filename for the end-of-day price dump our workers parse. It named a step
 *   in our pipeline. So did "(fetched)". "(XBRL)", "(PIT)" and "SAST" named a
 *   file format and two SEBI regulations. None of the five tells a reader
 *   anything they can act on, which is the same test that removed the vendors.
 *
 * ## Why this asserts BEHAVIOUR, not the shape of the table
 *
 * `source-label-coverage.test.ts` proves every minted code DECODES. It cannot
 * see whether the decode is any good, because it only ever asks "did something
 * come back". A label of `"BHAVCOPY"` satisfies it perfectly. So this file
 * calls `sourceLabel` for real and judges the string, and it reconstructs the
 * codes the services actually mint at RUNTIME rather than trusting the
 * constants — which is how `nse-fao-participant` passed coverage for a value
 * that never existed (see the positioning case below).
 *
 * Source: apps/web/components/stock/SectionShell.tsx
 *         packages/services/src/discover-sections.service.ts
 *         packages/core/src/market-data/discover-section-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceLabel } from "../../components/stock/SectionShell";

const WEB = join(__dirname, "..", "..");
const REPO = join(WEB, "..", "..");

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

/**
 * LINE comments before BLOCK comments — MONEY-1143. Reversed, a `//` line
 * containing `/*` opens a phantom block that eats the rest of the file, and
 * every absence assertion below would pass because the text was swallowed
 * rather than because it is gone. This file's subject is a table documented in
 * comments that necessarily quote the banned words, so the order is what makes
 * the assertions mean anything.
 */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const shellSrc = read(join(WEB, "components", "stock", "SectionShell.tsx"));

/** The LIVE `KNOWN` decode table — comments stripped — as key/label pairs. */
function knownEntries(): Array<[string, string]> {
  const start = shellSrc.indexOf("const KNOWN: Record<string, string> = {");
  assert.notEqual(start, -1, "the KNOWN decode table was renamed or removed");
  const end = shellSrc.indexOf("\n  };", start);
  assert.notEqual(end, -1, "could not find the end of the KNOWN table");
  const body = stripComments(shellSrc.slice(start, end));
  const out: Array<[string, string]> = [];
  for (const m of body.matchAll(/^\s*"?([A-Za-z0-9_-]+)"?:\s*"([^"]*)"/gm)) {
    out.push([m[1]!, m[2]!]);
  }
  return out;
}

const ENTRIES = knownEntries();
const KEYS = new Set(ENTRIES.map(([k]) => k));

/**
 * Words that describe how data REACHES us rather than what it IS.
 *
 * Split by why each is banned so a future reader can judge an addition rather
 * than pattern-match the list:
 *   - file / feed mechanics we run   → bhavcopy, dump, scrape, fetch…
 *   - machine formats we parse       → xbrl, csv, json, udiff, zip
 *   - unexpandable acronyms          → pit, sast, shp, slb
 *
 * The last group is the judgement call, so state the line: an acronym stays
 * only if the target reader already uses it. "F&O", "IPO", "FII/DII" and "NAV"
 * are everyday vocabulary for an Indian retail investor. "SLB", "PIT", "SAST"
 * and "SHP" are what the desk that ingests the file calls it — two of them are
 * SEBI regulation names, not products. Those get expanded, not abbreviated.
 */
const PIPELINE_WORDS = [
  "bhavcopy",
  "dump",
  "scrape",
  "scraped",
  "fetch",
  "fetched",
  "ingest",
  "ingested",
  "parser",
  "parsed",
  "backfill",
  "worker",
  "cron",
  "xbrl",
  "udiff",
  "csv",
  "json",
  "zip",
  "slug",
  "pit",
  "sast",
  "shp",
  "slb",
] as const;

/** Word-boundary match, so "Deposit" never trips on "pit". */
function pipelineHitsIn(text: string): string[] {
  return PIPELINE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
}

describe("MONEY-1213 — no pipeline vocabulary reaches the provenance chip", () => {
  it("[meta] the table parse is not silently blind", () => {
    // A parse that matched nothing would pass every assertion below while
    // proving nothing — the wrong-granularity failure of MONEY-1189.
    assert.ok(
      ENTRIES.length >= 15,
      `expected >= 15 KNOWN entries, parsed ${ENTRIES.length}. If the table ` +
        "moved or changed shape, this scan is blind — fix the parse, do not " +
        "lower the floor."
    );
    assert.ok(KEYS.has("NSE_INDICES"), "NSE_INDICES vanished from the parse");
  });

  it("[meta] stripComments cannot swallow the table it is protecting", () => {
    const fixture = [
      "// a line comment mentioning a bhavcopy/* which opens nothing",
      'const KEEP = "NSE indices";',
      "/* a real block naming bhavcopy */",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(stripped, /KEEP/);
    assert.doesNotMatch(stripped, /a real block/);
  });

  it("has no BHAVCOPY entry — neither key nor label", () => {
    const offenders = ENTRIES.filter(
      ([k, v]) => /bhavcopy/i.test(k) || /bhavcopy/i.test(v)
    );
    assert.deepEqual(
      offenders,
      [],
      'the chip is one `source={…}` away from rendering "bhavcopy" as polished ' +
        "product copy; `DailyPrice.source` still stores the code"
    );
  });

  it("leaves a removed code LOUD rather than plausible", () => {
    // The trade-off behind deleting the rows instead of rewording them: with
    // no entry the fallback returns the bare code, which is obviously wrong in
    // review. A friendly label would have looked deliberate forever.
    assert.equal(sourceLabel("BHAVCOPY"), "BHAVCOPY");
    assert.equal(sourceLabel("BHAVCOPY_HIST"), "BHAVCOPY HIST");
  });

  it("no label carries ingest, format or regulation vocabulary", () => {
    const offenders: string[] = [];
    for (const [key, label] of ENTRIES) {
      const hits = pipelineHitsIn(label);
      if (hits.length > 0) offenders.push(`${key} → "${label}" (${hits})`);
    }
    assert.deepEqual(
      offenders,
      [],
      "these labels name how the data reaches us, not what it is:\n  " +
        offenders.join("\n  ")
    );
  });

  it("no label is a raw provider id or registry slug", () => {
    // NOT "the label differs from its key". That heuristic was tried and is
    // wrong: "NSE_INDICES" → "NSE indices" and "NSE_IPO" → "NSE IPO" are the
    // key with the underscores swapped for spaces AND are exactly the right
    // words. Whether an all-caps token is jargon is a vocabulary judgement, so
    // it lives in PIPELINE_WORDS above where each entry can be argued. What is
    // mechanically decidable is a label that is still in CODE SHAPE.
    const offenders: string[] = [];
    for (const [key, label] of ENTRIES) {
      if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(label)) {
        offenders.push(`${key} → "${label}" (UPPER_SNAKE code)`);
      }
      if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(label)) {
        offenders.push(`${key} → "${label}" (registry slug)`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n  "));
  });

  it("an absent source is still an em dash, never the string 'null'", () => {
    assert.equal(sourceLabel(null), "—");
    assert.equal(sourceLabel(undefined), "—");
    assert.equal(sourceLabel(""), "—");
  });
});

describe("MONEY-1213 — the codes consumers actually pass have real labels", () => {
  /**
   * The positioning widget's source is INTERPOLATED:
   *   `${SRC_POSITIONING}-${metric.toLowerCase()}`
   * so the bare `SRC_POSITIONING` constant is never what reaches the chip.
   * `source-label-coverage.test.ts` scans constants, so it green-lit a key
   * that could not be hit while the two real values fell through to the slug
   * fallback and printed "NSE fao participant oi" on /discover/markets.
   *
   * Reconstructed from the template and the metric union rather than typed out
   * here — a hardcoded "-oi"/"-volume" pair is a shadow test the moment a
   * third metric ships. (The first draft of this file guessed "-vol"; the
   * union says "VOLUME". That is precisely the guess this reconstruction
   * removes.)
   */
  function mintedPositioningCodes(): string[] {
    const svc = stripComments(
      read(
        join(
          REPO,
          "packages",
          "services",
          "src",
          "discover-sections.service.ts"
        )
      )
    );
    const base = svc.match(/const SRC_POSITIONING\s*=\s*"([^"]+)"/);
    assert.ok(base, "SRC_POSITIONING was renamed or removed");

    const tmpl = svc.match(
      /source:\s*`\$\{SRC_POSITIONING\}-\$\{metric\.toLowerCase\(\)\}`/
    );
    assert.ok(
      tmpl,
      "the positioning source is no longer `${SRC_POSITIONING}-${metric…}` — " +
        "re-derive the minted codes rather than deleting this guard"
    );

    const logic = stripComments(
      read(
        join(
          REPO,
          "packages",
          "core",
          "src",
          "market-data",
          "discover-section-logic.ts"
        )
      )
    );
    const union = logic.match(
      /export const PARTICIPANT_METRICS = \[([^\]]+)\] as const;/
    );
    assert.ok(union, "PARTICIPANT_METRICS was renamed or removed");
    const metrics = [...union[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(
      metrics.length >= 2,
      `parsed ${metrics.length} metrics, expected >= 2`
    );

    return metrics.map((m) => `${base[1]!}-${m.toLowerCase()}`);
  }

  it("[regression] every interpolated positioning code has an EXPLICIT entry", () => {
    const offenders: string[] = [];
    for (const code of mintedPositioningCodes()) {
      // `KEYS.has` — not "does sourceLabel return something". The slug
      // fallback returns a string for any of these; that string was the bug.
      if (!KEYS.has(code)) offenders.push(`${code} → "${sourceLabel(code)}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "these render through the slug fallback, which prints the ingest slug " +
        "with the hyphens swapped for spaces:\n  " +
        offenders.join("\n  ")
    );
  });

  it("the set of components passing `source=` is pinned", () => {
    // Not a style rule: every file here hands a code to `sourceLabel`, so a
    // NEW one is a new chance to put a raw code on screen. Failing on an
    // unlisted addition forces a look at what it passes.
    const EXPECTED = [
      "components/discover/CircularsFeed.tsx",
      "components/discover/IndexDetailView.tsx",
      "components/discover/InstitutionalFlowsWidget.tsx",
      "components/discover/IpoBoard.tsx",
      "components/discover/MacroStripWidget.tsx",
      "components/discover/ParticipantPositioningWidget.tsx",
      "components/mf/MfPortfolioTab.tsx",
      "components/stock/StockDealsTab.tsx",
      "components/stock/StockDerivativesTab.tsx",
      "components/stock/StockInsiderTimeline.tsx",
    ];
    const actual = EXPECTED.filter((rel) =>
      /\n\s*source=\{/.test(stripComments(read(join(WEB, rel))))
    );
    assert.deepEqual(
      actual,
      EXPECTED,
      "a listed consumer stopped passing `source=`; drop it from EXPECTED"
    );
  });
});
