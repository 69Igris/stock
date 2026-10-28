/**
 * MONEY-1255 — the ownership-breakdown sub-card, and the chip it labels itself
 * with.
 *
 * Three things are guarded here and each has a different failure mode:
 *
 *   1. **The label table decodes both breakdown writers.** `shareholding_break-
 *      down` is written by two legs under two different `source` codes, and a
 *      code with no entry reaches the screen as a raw slug — the exact defect
 *      `source-label-coverage.test.ts` was written for after four discover
 *      codes shipped that way.
 *   2. **The card obeys the branch's empty-state architecture.** The visible
 *      body is `SECTION_EMPTY_BODY` via `SectionEmptyInline`; the reason lives
 *      in the tooltip. `empty-state-copy.test.ts` sweeps for the dashed box and
 *      the `emptyMessage` prop; this file pins the POSITIVE — that the nested
 *      empty is the shared primitive rather than bare text of its own.
 *   3. **web / apps/api parity.** The standing rule is that the server action
 *      and the `/v1` route stay in sync. They cannot drift here by
 *      construction — both call ONE service function — and that is what is
 *      asserted, rather than comparing two response shapes by eye.
 *
 * Source: apps/web/components/stock/StockShareholdingSection.tsx
 *         apps/web/components/stock/SectionShell.tsx
 *         apps/web/lib/actions/stock-sections-ownership.ts
 *         apps/api/src/routes/v1/stocks.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  sourceLabel,
  SECTION_EMPTY_BODY,
} from "@/components/stock/SectionShell";
import { groupIndianDigits } from "@/components/stock/StockShareholdingSection";

const WEB = join(__dirname, "..", "..");
const REPO = join(WEB, "..", "..");

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** LINE comments before BLOCK — MONEY-1143. Reversed, a `//` line containing
 *  the block-open sequence swallows the rest of the file and every absence
 *  assertion below passes because the code was eaten rather than removed. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Glue adjacent string literals back together.
 *
 * These notes are long enough to be written as `"..." + "..."` across lines, so
 * an `includes()` on raw source can fail on a phrase that IS present and merely
 * reflowed by prettier. Unlike `empty-state-copy.test.ts`'s copy, this one also
 * joins a TEMPLATE literal to the string beside it (`` `…from NSE ` + "and…" ``)
 * — the notes here interpolate the symbol, so the seam is backtick-to-quote and
 * a quote-only pattern silently matches nothing across it.
 */
function glue(s: string): string {
  return s.replace(/["`]\s*\+\s*["`]/g, "");
}

const CARD = join(WEB, "components", "stock", "StockShareholdingSection.tsx");
const SHELL = join(WEB, "components", "stock", "SectionShell.tsx");
const ACTION = join(WEB, "lib", "actions", "stock-sections-ownership.ts");
const API_ROUTE = join(REPO, "apps", "api", "src", "routes", "v1", "stocks.ts");

// ════════════════════════════════════════════════════════════════════════════
// 1. Labels
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1255 — every shareholding source decodes to a human label", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    const fixture = [
      "const a = 1;",
      "// a line comment mentioning a/* which opens nothing",
      'const KEEP = "SectionEmptyInline";',
      "/* a real block */",
      "const b = 2;",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(
      stripped,
      /KEEP/,
      "LINE before BLOCK, or nothing here is falsifiable"
    );
    assert.doesNotMatch(stripped, /a real block/);
  });

  it("names BSE as an exchange, not as a raw code", () => {
    // 2,605 symbols on prod have a BSE shareholding row and no NSE one. Without
    // this entry the UPPER_SNAKE fallback renders "BSE SHP" — the code with its
    // punctuation swapped, on a page a retail investor reads.
    assert.equal(sourceLabel("BSE_SHP"), "BSE shareholding");
    assert.notEqual(sourceLabel("BSE_SHP"), "BSE SHP");
  });

  it("names the breakdown filing without naming the file format", () => {
    const label = sourceLabel("NSE_SHP_XBRL");
    assert.equal(label, "NSE shareholding filing");
    // MONEY-1213: "XBRL" is the machine format our ingest reads and "SHP" is
    // desk shorthand. Neither tells a reader anything they can act on.
    assert.doesNotMatch(label, /\bxbrl\b/i);
    assert.doesNotMatch(label, /\bshp\b/i);
  });

  it("the two breakdown writers are DISTINGUISHABLE on screen", () => {
    // They are not interchangeable: one parses NSE's attached filing, the other
    // BSE's own payload, and they cover different symbols. One label for both
    // would hide which of the two a reader is looking at.
    assert.notEqual(sourceLabel("NSE_SHP_XBRL"), sourceLabel("BSE_SHP"));
    assert.notEqual(sourceLabel("NSE_SHP_XBRL"), sourceLabel("NSE_SHP"));
  });

  it("the card passes its source THROUGH sourceLabel, never raw", () => {
    const src = stripComments(read(CARD));
    // NOT `match(/\{sourceLabel\(section\.source\)\}/)` — that survived its own
    // mutation. The chip's `title=` uses the SAME call inside a template
    // literal (`${sourceLabel(section.source)}`), whose text contains the
    // braced form as a substring, so replacing the VISIBLE decode with the raw
    // code left the tooltip satisfying the assertion while the screen showed
    // "BSE_SHP". A first-match locator over two occurrences.
    assert.doesNotMatch(
      src,
      /\{section\.source\}/,
      "the stored code must never render — it is decoded or it is not shown"
    );
    // Both uses, counted: the tooltip and the visible pill.
    const decoded = (src.match(/sourceLabel\(section\.source\)/g) ?? []).length;
    assert.equal(
      decoded,
      2,
      `expected the chip to decode in both its tooltip and its body, found ${decoded}`
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The card
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1255 — the breakdown card follows the branch's architecture", () => {
  const src = stripComments(read(CARD));

  it("renders the shared inline empty, not prose of its own", () => {
    // No dashed box: a box inside a section that HAS data reads as a broken
    // layout, which is why these were hand-rolled as bare text before.
    assert.match(src, /<SectionEmptyInline\b/);
    assert.doesNotMatch(
      src,
      /border-2 border-dashed border-\[var\(--rule-soft\)\]/,
      "the sub-card must not re-type SectionShell's dashed box"
    );
    assert.doesNotMatch(src, /emptyMessage\s*=/);
  });

  it("the empty REASON is a note (tooltip), never the visible body", () => {
    const start = src.indexOf("<SectionEmptyInline");
    assert.notEqual(start, -1);
    const el = src.slice(start, start + 400);
    assert.match(el, /note=\{/, "the distinction must ride in the tooltip");
    // SectionEmptyInline renders SECTION_EMPTY_BODY itself; a card that also
    // wrote a sentence would be the nineteen-voices regression in a new place.
    assert.equal(SECTION_EMPTY_BODY, "No data available");
  });

  it("is theme-aware — tokens for every neutral, no literal colours", () => {
    const start = src.indexOf("function OwnershipBreakdownCard(");
    assert.notEqual(start, -1, "OwnershipBreakdownCard was renamed or removed");
    const end = src.indexOf("\nfunction BreakdownRow(", start);
    assert.notEqual(end, -1, "could not bound the card");
    const body = src.slice(start, end);
    assert.match(body, /var\(--/, "the card must use theme tokens");
    assert.doesNotMatch(
      body,
      /#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/,
      "no hard-coded colour survives a theme switch"
    );
  });

  it("renders EVERY leg the service sends, and all three of its fields", () => {
    // The seven labels live in the pure layer (pinned by packages/core's
    // ownership-breakdown-logic.test.ts) precisely so the card cannot hold a
    // second, drifting copy. What has to be true HERE is that the card maps the
    // whole list rather than cherry-picking, and renders the level, the point
    // delta and the nesting that says MF/insurance/banks/govt sit INSIDE DII.
    assert.match(src, /legs\.map\(\(leg\) => \(/, "every leg must render");
    const start = src.indexOf("function BreakdownRow(");
    assert.notEqual(start, -1, "BreakdownRow was renamed or removed");
    const row = src.slice(start, start + 1600);
    assert.match(row, /\{leg\.nested \? `· \$\{leg\.label\}` : leg\.label\}/);
    assert.match(
      row,
      /\{pct\(leg\.pct\)\}/,
      "the level must render through pct()"
    );
    assert.match(row, /\{delta\(leg\.deltaPct\)\}/, "the QoQ column is POINTS");
    // The relative change is the guarded division; it is a tooltip, not a
    // number on the screen, because it is null exactly when the prior level
    // was 0 and a blank cell there would read as "no movement".
    assert.match(row, /leg\.changePct === null/);
  });

  it("a delta is never colour-coded", () => {
    const start = src.indexOf("function BreakdownRow(");
    assert.notEqual(start, -1);
    const body = src.slice(
      start,
      src.indexOf("\n}", src.indexOf("return (", start))
    );
    // A rising FII stake is not universally good. Colouring it states a
    // judgement the filing does not make — the same rule the quarter table
    // above already follows.
    assert.doesNotMatch(
      body,
      /text-(red|green|emerald|rose)-\d/,
      "the QoQ column must stay neutral"
    );
  });

  it("keeps the MONEY-1205 distinction in the section's empty note", () => {
    // "we have not fetched it" vs "the exchange published nothing". Losing it
    // re-opens a closed defect; `empty-state-copy.test.ts` pins the same phrase
    // from the other side.
    const glued = glue(src);
    assert.match(
      glued,
      /gap in our coverage rather than in the exchange's filings/
    );
    // …and the note now covers BOTH exchanges, because both are read.
    assert.match(glued, /from NSE and from BSE/);
  });

  it("the third-party fallback sentence no longer claims only NSE was checked", () => {
    // `src` is already comment-stripped, so this is the CODE and not the
    // explanation of the change beside it.
    const glued = glue(src);
    assert.match(
      glued,
      /Neither NSE nor BSE has published a shareholding pattern/
    );
    assert.doesNotMatch(
      glued,
      /NSE has published no shareholding for this symbol — showing/,
      "the single-exchange sentence is false for a BSE-only company"
    );
    // MONEY-1144: no vendor names on screen. This sentence renders as visible
    // body text, not as a tooltip, so a vendor name here is a pill in prose.
    assert.doesNotMatch(glued, /Tickertape/);
  });
});

describe("MONEY-1255 — groupIndianDigits", () => {
  it("groups the last three, then twos", () => {
    assert.equal(groupIndianDigits("6441503000"), "6,44,15,03,000");
    assert.equal(groupIndianDigits("1234567"), "12,34,567");
    assert.equal(groupIndianDigits("100000"), "1,00,000");
    assert.equal(groupIndianDigits("1000"), "1,000");
  });

  it("leaves short counts and zero alone", () => {
    assert.equal(groupIndianDigits("0"), "0");
    assert.equal(groupIndianDigits("42"), "42");
    assert.equal(groupIndianDigits("999"), "999");
  });

  it("groups the STRING — a count past 2^53 keeps every digit", () => {
    // The counts arrive as strings precisely so no share count survives a
    // float. Converting here to insert commas would undo that at the last step:
    // `Number("9007199254740993")` is 9007199254740992.
    assert.equal(
      groupIndianDigits("9007199254740993"),
      "9,00,71,99,25,47,40,993"
    );
    assert.match(groupIndianDigits("9007199254740993"), /993$/);
  });

  it("passes anything that is not a decimal count through untouched", () => {
    assert.equal(groupIndianDigits("n/a"), "n/a");
    assert.equal(groupIndianDigits(""), "");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Parity
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1255 — the web action and the /v1 route cannot drift", () => {
  const action = stripComments(read(ACTION));
  const route = stripComments(read(API_ROUTE));

  it("the web action is a wrapper over the shared service", () => {
    assert.match(
      action,
      /getStockOwnershipBreakdownSection,/,
      "must import the service"
    );
    assert.match(
      action,
      /export async function getStockOwnershipBreakdownAction\(/
    );
    assert.match(action, /return getStockOwnershipBreakdownSection\(args\);/);
  });

  it("apps/api mounts the SAME function on a /v1 route", () => {
    // Not "a route exists" — the route must be wired to the identical service
    // export. `stock-tabs.service.ts` is the cautionary tale: a hand-maintained
    // PORT that drifted, and MONEY-1062 spent a lane repairing what it cost.
    assert.match(
      route,
      /getStockOwnershipBreakdownSection,/,
      "must import the service"
    );
    const m =
      /mountStockSection\(\s*"\/:symbol\/ownership-breakdown",\s*"([^"]+)",\s*(\w+),\s*\)/.exec(
        route
      );
    assert.ok(m, "the /v1/stocks/:symbol/ownership-breakdown mount is missing");
    assert.equal(m[2], "getStockOwnershipBreakdownSection");
    assert.equal(m[1], "ownership breakdown");
  });

  it("the route reuses the mount helper, so it cannot lose the parse guard", () => {
    // `mountStockSection` owns parse -> 400 -> service -> 500 -> 200. A
    // longhand copy is a fresh chance to drop the `parsed.ok` guard or leak a
    // raw error string.
    assert.doesNotMatch(
      route,
      /stocksRoutes\.get\("\/:symbol\/ownership-breakdown"/,
      "this section must go through mountStockSection, not longhand"
    );
  });

  it("both surfaces re-export the same payload type", () => {
    assert.match(action, /type StockOwnershipBreakdownData,/);
    assert.match(action, /^\s*StockOwnershipBreakdownData,$/m);
  });
});
