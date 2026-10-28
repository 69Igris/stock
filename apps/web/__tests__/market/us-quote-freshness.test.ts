/**
 * "Delayed" follows the DATA, and says so in ONE place — MONEY-1309.
 *
 * Four surfaces make the same claim about a price: the web response envelope's
 * `delayed` flag, apps/api's per-quote `delayed`, the disclaimer the chart
 * renders, and the provenance chip on the US panel. Before this ticket the first
 * was hardcoded `true` and the third was unconditional, which was correct while
 * every provider was Yahoo. It stops being correct the moment one source is
 * live, and independent re-derivations of "is this live" are precisely how
 * MONEY-1259 ended up hiding a compliance disclosure from the users most likely
 * to need it.
 *
 * ## What this file used to assert, and why it missed the defect it covered
 *
 * It checked `isLiveQuoteSource(source)` — a SOURCE-ONLY predicate — and then
 * source-scanned the two consumers for the literal string
 * `isLiveQuoteSource(source)`. Both halves passed while `DelayedDataNote`
 * rendered `{source:"TIINGO_RT", fallback:true}` as a green "Live quote" badge
 * IN PLACE OF the exchange-delayed disclaimer, because the predicate it pinned
 * could not see `fallback` and the scan pinned the very expression that was
 * wrong. A test that asserts an implementation cannot notice the implementation
 * is incomplete.
 *
 * So: the predicate under test now takes the PROVENANCE, the matrix includes the
 * combination that broke, and the rendered-output half moved to
 * `__tests__/components/us-quote-live-badge.test.ts`, which renders the real
 * components with `react-dom/server` instead of reading their source. What stays
 * here is the wiring claim — that each consumer READS the shared function rather
 * than re-deciding — which is a structural property and is checkable by scan.
 *
 * Source: apps/web/app/api/market/quote/quote-logic.ts,
 *         apps/web/app/api/market/quote/route.ts,
 *         apps/web/components/market/DelayedDataNote.tsx,
 *         apps/api/src/routes/v1/market.ts,
 *         packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isLiveQuote } from "@/app/api/market/quote/quote-logic";
import { isLiveQuoteProvenance } from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";

const ROUTE = join("app", "api", "market", "quote", "route.ts");
const NOTE = join("components", "market", "DelayedDataNote.tsx");
const LOGIC = join("app", "api", "market", "quote", "quote-logic.ts");
const API_MARKET = join(
  "..",
  "..",
  "apps",
  "api",
  "src",
  "routes",
  "v1",
  "market.ts"
);
const routeSrc = readFileSync(ROUTE, "utf8");
const noteSrc = readFileSync(NOTE, "utf8");
const logicSrc = readFileSync(LOGIC, "utf8");
const apiSrc = readFileSync(API_MARKET, "utf8");

/**
 * LINE comments before BLOCK comments — MONEY-1143. Reversed, a `//` line
 * containing an opener would swallow the rest of the file and every absence
 * assertion below would pass because the text was eaten rather than gone.
 */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Component body with the header comment stripped — prose is not behaviour. */
function noteBody(): string {
  const end = noteSrc.indexOf("*/");
  assert.ok(end > 0, "ceiling: DelayedDataNote has no header comment to strip");
  return noteSrc.slice(end + 2);
}

describe("isLiveQuote (MONEY-1309)", () => {
  it("[meta] it is the real export, and it is core's — not a local copy", () => {
    // Ceiling. A function stuck on one answer would satisfy half the cases
    // below and silently break the other half; a LOCAL re-implementation would
    // satisfy all of them while re-creating the drift this consolidation
    // exists to remove.
    assert.equal(typeof isLiveQuote, "function");
    assert.equal(
      isLiveQuote,
      isLiveQuoteProvenance,
      "apps/web has its own answer to 'is this live' again"
    );
    assert.notEqual(
      isLiveQuote({ source: "TIINGO_RT", fallback: false }),
      isLiveQuote({ source: "yahoo" }),
      "the function returns the same answer for a live and a delayed source"
    );
  });

  it("ONLY the realtime store, and only when it is not a fallback, is live", () => {
    assert.equal(isLiveQuote({ source: "TIINGO_RT", fallback: false }), true);
    assert.equal(isLiveQuote({ source: "TIINGO_RT" }), true);
  });

  it("[regression] fallback:true is NOT live, even on the realtime source", () => {
    // THE defect this file failed to catch. It is asserted in the predicate
    // here and in the RENDERED OUTPUT in us-quote-live-badge.test.ts — a
    // predicate can be right while the consumer ignores it, which is what
    // happened.
    assert.equal(isLiveQuote({ source: "TIINGO_RT", fallback: true }), false);
  });

  it("Yahoo is delayed and the EOD close is not live", () => {
    // Yahoo's India feed is exchange-delayed by ~15 minutes; "TIINGO" is the
    // previous session's close standing in for a quote. Neither is live, and
    // calling either one live is a compliance claim with nothing behind it.
    assert.equal(isLiveQuote({ source: "yahoo" }), false);
    assert.equal(isLiveQuote({ source: "TIINGO", fallback: true }), false);
    assert.equal(isLiveQuote({ source: "TIINGO", fallback: false }), false);
    assert.equal(isLiveQuote({ source: "zerodha" }), false);
  });

  it("an unknown provenance is NOT live", () => {
    // Fail-closed. A new source added upstream must opt IN to being called live.
    assert.equal(isLiveQuote(undefined), false);
    assert.equal(isLiveQuote(null), false);
    assert.equal(isLiveQuote({}), false);
    assert.equal(isLiveQuote({ source: "" }), false);
    assert.equal(isLiveQuote({ source: "some-future-feed" }), false);
    assert.equal(isLiveQuote({ source: "tiingo_rt" }), false); // casing is not a guess
  });
});

describe("nothing re-decides what 'live' means", () => {
  it("[meta] every source under assertion is readable, and survives stripping", () => {
    assert.ok(routeSrc.length > 2000, `route read as ${routeSrc.length} chars`);
    assert.ok(logicSrc.length > 2000, `logic read as ${logicSrc.length} chars`);
    assert.ok(apiSrc.length > 5000, `apps/api read as ${apiSrc.length} chars`);
    // A stripper that ate the code would make every `doesNotMatch` below pass
    // vacuously, which is the failure mode MONEY-1143 named.
    assert.match(stripComments(apiSrc), /marketRoutes\.get\("\/us\/quotes"/);
    assert.match(stripComments(logicSrc), /export function parseSymbolList/);
    assert.match(stripComments(routeSrc), /export async function GET/);
  });

  it("there is no exported SOURCE-ONLY predicate left to reach for", () => {
    // The shape was the bug: with `isLiveQuoteSource(source: string)` available,
    // every consumer had to remember to check `fallback` separately, and one of
    // the four did not. Removing the half-answer is what makes the omission
    // unrepresentable rather than merely fixed once.
    assert.doesNotMatch(
      stripComments(logicSrc),
      /export function isLiveQuoteSource/,
      "the source-only predicate is back; a caller can once again ask about a " +
        "source while ignoring the flag that qualifies it"
    );
    assert.match(logicSrc, /isLiveQuoteProvenance as isLiveQuote/);
  });

  it("the quote route derives `delayed` and does not hardcode it", () => {
    assert.doesNotMatch(
      stripComments(routeSrc),
      /delayed:\s*true/,
      "the route hardcodes `delayed: true` again. A US quote served from the " +
        "realtime keys is NOT delayed, and a payload that says otherwise makes " +
        "the UI disclaimer disagree with the data."
    );
    assert.match(
      routeSrc,
      /delayed:\s*!isLiveQuote\(/,
      "`delayed` is no longer derived from the shared predicate"
    );
  });

  it("apps/api derives its per-quote `delayed` from the same function", () => {
    // It had the rule right — `q.provenance.fallback || q.provenance.source !==
    // "TIINGO_RT"` — but written out by hand, which is a copy that can lose an
    // operand. Deleting `fallback ||` from it left every fixture in
    // `market-us-quotes-contract.test.ts` green.
    assert.match(apiSrc, /delayed:\s*!isLiveQuoteProvenance\(q\.provenance\)/);
    // Comments stripped: this file's own note NAMES the expression it forbids.
    assert.doesNotMatch(
      stripComments(apiSrc),
      /q\.provenance\.source\s*!==\s*"TIINGO_RT"/,
      "apps/api re-derives liveness by hand instead of calling the one predicate"
    );
  });

  it("routes US venues away from the India cache path", () => {
    // `fetchQuotesCached` writes to the cross-user `_global` scope, which is
    // licence-safe only for Yahoo. Tiingo's Commercial plan is internal-use-only
    // (MONEY-1262), so its quotes must not go through that store.
    assert.match(routeSrc, /isUsExchange\(exchange\)/);
    assert.match(routeSrc, /fetchUsQuotesUncached\(/);
  });
});

describe("DelayedDataNote follows the DATA (MONEY-1309)", () => {
  it("[meta] the component source is readable and is the one we think", () => {
    assert.ok(noteSrc.length > 500, `note read as ${noteSrc.length} chars`);
    assert.match(noteBody(), /export default function DelayedDataNote/);
  });

  it("takes the whole provenance and asks the shared predicate about it", () => {
    const body = noteBody();
    assert.match(body, /provenance\?:\s*QuoteNoteProvenance/);
    assert.match(
      body,
      /isLiveQuote\(provenance\)/,
      "the note re-decides what 'live' means instead of reading the one " +
        "function the response envelope also reads"
    );
  });

  it("treats an OMITTED provenance as delayed — every existing mount is unchanged", () => {
    // `TradingViewAdvancedChart` is the single mount every chart surface renders
    // through and it passes nothing. Omission must therefore keep today's
    // behaviour exactly, or this ticket silently drops a disclosure from every
    // India chart in the app. The RENDERED proof is in
    // us-quote-live-badge.test.ts; this is the structural half.
    assert.match(noteBody(), /provenance\?:\s*QuoteNoteProvenance\s*\|\s*null/);
  });

  it("still discloses on the delayed branch", () => {
    // The disclosure is the POINT of the component. Adding a live branch must
    // not quietly weaken the branch that carries the compliance text.
    assert.match(noteBody(), /Exchange-delayed data/);
  });

  it("makes no claim about brokers on either branch", () => {
    // MONEY-1259's finding: connecting a broker gets nobody a better feed.
    const body = noteBody();
    assert.doesNotMatch(body, /\/brokers/);
    assert.doesNotMatch(body, /useBrokerStatus/);
  });
});
