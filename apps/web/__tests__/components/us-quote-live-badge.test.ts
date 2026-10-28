/**
 * A fallback quote must never RENDER as a live one — MONEY-1309 follow-up.
 *
 * ## The defect, and why every existing test was blind to it
 *
 * `decideUsQuote` emits `{source:"TIINGO_RT", fallback:true}` for a realtime
 * quote that is no longer live. `DelayedDataNote` branched on
 * `isLiveQuoteSource(source)` and NEVER READ `fallback`, so that quote rendered
 *
 *     class  … text-emerald-500
 *     title  "Streaming quote, last updated 05:30 am."
 *     text   "Live quote · 05:30 am"
 *
 * — i.e. the compliance disclaimer REPLACED by a live-price claim, on the same
 * header whose `ProvenanceChip` was correctly showing an amber `fallback` pill.
 * One fact, two consumers, one of them reading half of it.
 *
 * `us-quote-freshness.test.ts` covered this area and could not see it: it is a
 * SOURCE SCAN, and it asserted the presence of the very expression that was
 * wrong (`isLiveQuoteSource(source)`). A test that pins an implementation
 * cannot notice that the implementation is incomplete.
 *
 * ## So this one RENDERS
 *
 * The premise that no render assertion was available here is false — the older
 * files say "the repo's runner has no DOM", which is true and beside the point:
 * `react-dom/server` needs no DOM, it emits a string. These cases render the
 * REAL components with `renderToStaticMarkup` and read the markup, so they see
 * what a user sees rather than what the source says it will do.
 *
 * Source: apps/web/components/market/DelayedDataNote.tsx
 *         apps/web/components/stock/SectionShell.tsx
 *         packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import DelayedDataNote from "@/components/market/DelayedDataNote";
import {
  ProvenanceChip,
  formatAsOf,
  marketTimeZoneForSource,
  sourceLabel,
} from "@/components/stock/SectionShell";
import { isLiveQuote } from "@/app/api/market/quote/quote-logic";

/** A US regular-session close: 16:00 ET on 29 Aug 2026 (EDT, UTC-4). */
const US_CLOSE_ISO = "2026-08-29T20:00:00.000Z";

function note(props: Parameters<typeof DelayedDataNote>[0]): string {
  return renderToStaticMarkup(createElement(DelayedDataNote, props));
}

function chip(props: Parameters<typeof ProvenanceChip>[0]): string {
  return renderToStaticMarkup(createElement(ProvenanceChip, props));
}

/** The live badge is green and says so; the disclaimer is neither. */
function looksLive(html: string): boolean {
  return /Live quote/.test(html) || /emerald/.test(html);
}
function discloses(html: string): boolean {
  return /Exchange-delayed data/.test(html);
}

describe("[meta] the render harness actually renders (MONEY-1309)", () => {
  it("both components emit markup, and the two branches differ", () => {
    // Ceiling. Every assertion below reads a rendered string; a harness that
    // produced "" would satisfy the negative half of the matrix vacuously —
    // which is the exact failure mode the source-scan test had.
    const live = note({
      provenance: { source: "TIINGO_RT", fallback: false, asOf: US_CLOSE_ISO },
    });
    const delayed = note({ provenance: undefined });
    assert.ok(live.length > 50, `live branch rendered ${live.length} chars`);
    assert.ok(delayed.length > 50, `delayed branch rendered ${delayed.length}`);
    assert.notEqual(live, delayed, "both branches render identical markup");
    assert.ok(looksLive(live), live);
    assert.ok(discloses(delayed), delayed);

    const c = chip({ source: "NSE_XBRL", asOf: US_CLOSE_ISO });
    assert.match(c, /<span/, `chip rendered: ${c}`);
  });
});

describe("DelayedDataNote reads BOTH provenance fields (MONEY-1309)", () => {
  it("[regression] a FALLBACK realtime quote renders the disclaimer, not a live badge", () => {
    const html = note({
      provenance: { source: "TIINGO_RT", fallback: true, asOf: US_CLOSE_ISO },
    });
    assert.ok(
      discloses(html),
      "a fallback quote lost the exchange-delayed disclosure:\n" + html
    );
    assert.ok(
      !looksLive(html),
      "a fallback quote rendered as a LIVE quote. The badge REPLACES the " +
        "compliance disclaimer, so this is a live-price claim standing where " +
        "the disclosure should be:\n" +
        html
    );
    assert.doesNotMatch(html, /Streaming quote/);
  });

  it("a genuinely live quote still gets its badge, with the time", () => {
    // The fix must not be "always disclose" — that would delete the feature
    // and pass the case above for the wrong reason.
    const html = note({
      provenance: { source: "TIINGO_RT", fallback: false, asOf: US_CLOSE_ISO },
    });
    assert.match(html, /Live quote/);
    assert.match(html, /emerald/);
    assert.match(html, /Streaming quote, last updated/);
    assert.ok(!discloses(html));
  });

  it("the EOD close and an omitted provenance both disclose", () => {
    for (const provenance of [
      { source: "TIINGO", fallback: true, asOf: US_CLOSE_ISO },
      { source: "TIINGO", fallback: false, asOf: US_CLOSE_ISO },
      { source: "yahoo", fallback: false },
      { source: null, fallback: null },
      undefined,
      null,
    ] as const) {
      const html = note({ provenance });
      assert.ok(
        discloses(html) && !looksLive(html),
        `${JSON.stringify(provenance)} rendered as live:\n${html}`
      );
    }
  });

  it("the component cannot be handed a source without its flag", () => {
    // The structural half of the fix. The prop is the provenance OBJECT, so
    // there is no `source="TIINGO_RT"` call that omits `fallback` — the shape
    // that produced the defect is not expressible.
    const src = require("node:fs").readFileSync(
      require("node:path").join("components", "market", "DelayedDataNote.tsx"),
      "utf8"
    ) as string;
    const start = src.indexOf("interface DelayedDataNoteProps {");
    assert.notEqual(start, -1, "the props interface was renamed or removed");
    const end = src.indexOf("\n}", start);
    assert.notEqual(end, -1, "could not find the end of the props interface");
    const props = src.slice(start, end);
    // Sanity: the parse found the real block, not an empty slice.
    assert.match(props, /provenance\?:/, `parsed props block:\n${props}`);
    assert.doesNotMatch(
      props,
      /^\s*source\??:/m,
      "DelayedDataNote took a bare `source` prop again; liveness is a property " +
        "of the PAIR (source, fallback), and a prop that carries only half of " +
        "it lets a caller withhold the other half:\n" +
        props
    );
    assert.match(src, /isLiveQuote\(provenance\)/);
  });
});

describe("the chip and the note cannot disagree (MONEY-1309)", () => {
  it("[regression] one object, two renderers, one verdict", () => {
    // The shape of the original bug: the chip read `fallback`, the note read
    // `source`, and they were two inches apart on the same header saying
    // opposite things. Hand BOTH the identical object and require agreement.
    const cases = [
      { source: "TIINGO_RT", fallback: false, asOf: US_CLOSE_ISO },
      { source: "TIINGO_RT", fallback: true, asOf: US_CLOSE_ISO },
      { source: "TIINGO", fallback: true, asOf: US_CLOSE_ISO },
    ];
    for (const provenance of cases) {
      const chipHtml = chip(provenance);
      const noteHtml = note({ provenance });
      const chipSaysFallback = /fallback/.test(chipHtml);
      const noteSaysLive = looksLive(noteHtml);
      assert.ok(
        !(chipSaysFallback && noteSaysLive),
        `chip shows a fallback pill while the note claims live, for ` +
          `${JSON.stringify(provenance)}:\n${chipHtml}\n${noteHtml}`
      );
      assert.equal(
        noteSaysLive,
        isLiveQuote(provenance),
        `the note disagrees with the shared predicate for ${JSON.stringify(provenance)}`
      );
    }
  });
});

describe("no vendor name reaches the US quote chip (MONEY-1144 / MONEY-1309)", () => {
  it("[regression] TIINGO_RT and TIINGO decode instead of rendering raw", () => {
    // The table had no entry for either, so the UPPER_SNAKE fallback rendered
    // `TIINGO RT` on screen with a `Source: TIINGO RT` tooltip — MONEY-1144's
    // rule broken for the third time, by omission each time.
    for (const source of ["TIINGO_RT", "TIINGO"]) {
      assert.equal(sourceLabel(source), "Third-party data");
      const html = chip({ source, asOf: US_CLOSE_ISO, fallback: false });
      assert.doesNotMatch(
        html,
        /TIINGO/i,
        `the chip rendered the vendor code for ${source}:\n${html}`
      );
      assert.match(html, /Third-party data/);
    }
  });

  it("the table is exhaustive over the source UNION, not a hand-kept list", () => {
    // A `Record<UsQuoteSource, string>` cannot be short by one: adding a member
    // in core fails `type-check` here until it has a label. Adding two more
    // rows to `KNOWN` — which is what the three previous fixes did — would not.
    const src = require("node:fs").readFileSync(
      require("node:path").join("components", "stock", "SectionShell.tsx"),
      "utf8"
    ) as string;
    assert.match(
      src,
      /Record<UsQuoteSource,\s*string>/,
      "the US quote labels are no longer keyed by the core union, so a new " +
        "source can ship with no label and render raw"
    );
    assert.match(src, /\.\.\.US_QUOTE_SOURCE_LABELS/);
  });
});

describe("a US session date is rendered on the US clock (MONEY-1309)", () => {
  it("[regression] a 29 Aug US close does not render as 30 Aug", () => {
    // 16:00 ET on the 29th is 01:30 IST on the 30th. `formatAsOf` hardcoded
    // Asia/Kolkata, so every US quote advertised the WRONG SESSION — the number
    // beside it was genuinely the 29th's.
    assert.equal(formatAsOf(US_CLOSE_ISO, "TIINGO"), "29 Aug 2026");
    assert.equal(formatAsOf(US_CLOSE_ISO, "TIINGO_RT"), "29 Aug 2026");
    const html = chip({ source: "TIINGO", asOf: US_CLOSE_ISO, fallback: true });
    assert.match(html, /29 Aug 2026/);
    assert.doesNotMatch(html, /30 Aug 2026/, html);
  });

  it("India is unchanged — the same instant is still 30 Aug in IST", () => {
    // The India rendering is CORRECT for an India source and must not move.
    assert.equal(formatAsOf(US_CLOSE_ISO), "30 Aug 2026");
    assert.equal(formatAsOf(US_CLOSE_ISO, "NSE_XBRL"), "30 Aug 2026");
    assert.equal(formatAsOf(US_CLOSE_ISO, null), "30 Aug 2026");
    const html = chip({ source: "NSE_XBRL", asOf: US_CLOSE_ISO });
    assert.match(html, /30 Aug 2026/);
  });

  it("the zone is derived from the SAME record that supplies the label", () => {
    assert.equal(marketTimeZoneForSource("TIINGO_RT"), "America/New_York");
    assert.equal(marketTimeZoneForSource("TIINGO"), "America/New_York");
    assert.equal(marketTimeZoneForSource("NSE_XBRL"), "Asia/Kolkata");
    assert.equal(marketTimeZoneForSource(null), "Asia/Kolkata");
    assert.equal(marketTimeZoneForSource(undefined), "Asia/Kolkata");
  });

  it("DST is the platform's problem, not ours — a winter close is EST", () => {
    // 21:00Z on 2 Jan is 16:00 EST on the 2nd, and 02:30 IST on the 3rd.
    const winter = "2027-01-02T21:00:00.000Z";
    assert.equal(formatAsOf(winter, "TIINGO"), "02 Jan 2027");
    assert.equal(formatAsOf(winter), "03 Jan 2027");
  });

  it("an unparseable or absent date is still null, in either market", () => {
    assert.equal(formatAsOf(null, "TIINGO"), null);
    assert.equal(formatAsOf("", "TIINGO"), null);
    assert.equal(formatAsOf("not-a-date", "TIINGO"), null);
  });
});
