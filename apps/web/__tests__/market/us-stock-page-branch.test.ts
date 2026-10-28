/**
 * The stock page's US branch — MONEY-1309.
 *
 * `/stock/[symbol]` is a server component over Prisma, Clerk and PostHog, so it
 * cannot be invoked here; what follows is a SOURCE scan, named as the weaker
 * instrument it is. It checks the four properties that would each be a silent
 * defect rather than an error, and each one has a specific failure in mind.
 *
 *   1. THE SYNTHESIS MUST NOT WIN. `instrument_mappings` is India-only. Ask this
 *      page for `DOW` and every lookup misses, the fallback block synthesises
 *      `yahooSymbol: "DOW.NS"` — a real NSE symbol for a DIFFERENT company — and
 *      Yahoo answers it. The US branch has to sit BEFORE that block or it can
 *      never run for the tickers it exists for.
 *   2. THE MARKET MUST BE NAMED. 214 tickers exist in both collections;
 *      `resolveInstrument({symbol})` with no market lets one market's ranking
 *      answer for the other. India has already had its turn by this point, so
 *      the call must be narrowed to `market: "US"`.
 *   3. THE FLAG MUST STILL GATE IT. `us-stocks-listing` defaults false and is
 *      founder-targeted; flag OFF has to mean the pre-existing behaviour, not a
 *      half-rendered page.
 *   4. THE PING MUST NOT BE AWAITED. It is a subscription hint. Awaiting it puts
 *      Redis on the render's critical path for something whose entire value is
 *      "maybe a live quote next time".
 *
 * Source: apps/web/app/stock/[symbol]/page.tsx, apps/web/lib/market/us-interest.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = join("app", "stock", "[symbol]", "page.tsx");
const CLIENT = join("app", "stock", "[symbol]", "us-client.tsx");
const INTEREST = join("lib", "market", "us-interest.ts");

const pageSrc = readFileSync(PAGE, "utf8");
const clientSrc = readFileSync(CLIENT, "utf8");
const interestSrc = readFileSync(INTEREST, "utf8");

describe("the US branch on /stock/[symbol] (MONEY-1309)", () => {
  it("[meta] all three files are readable and are the ones we think", () => {
    // Ceiling: several assertions below are index comparisons on `indexOf`,
    // and `-1 < -1` is false but `-1 < 5` is TRUE — a missing marker would make
    // an ordering check pass for the wrong reason.
    assert.ok(pageSrc.length > 4000, `page read as ${pageSrc.length} chars`);
    assert.ok(clientSrc.length > 1000, `client read as ${clientSrc.length}`);
    assert.ok(
      interestSrc.length > 500,
      `interest read as ${interestSrc.length}`
    );
    assert.match(pageSrc, /export default async function StockPage/);
  });

  it("resolves against the US collection, naming the market explicitly", () => {
    assert.match(pageSrc, /resolveInstrument\(\{/);
    assert.match(
      pageSrc,
      /market:\s*"US"/,
      "the US resolve is not narrowed to the US market. 214 tickers exist in " +
        "BOTH collections, and a bare resolve lets India's ranking answer a " +
        "question India has already been asked."
    );
  });

  it("runs BEFORE the synthesised NSE fallback", () => {
    const branchAt = pageSrc.indexOf('market: "US"');
    const synthAt = pageSrc.indexOf("construct minimal data from URL params");
    assert.ok(branchAt > 0, "the US branch marker is missing");
    assert.ok(synthAt > 0, "the synthesis marker is missing");
    assert.ok(
      branchAt < synthAt,
      "the US branch sits AFTER the synthesised fallback, so it can never run " +
        "— the fallback already produced a `.NS` symbol and returned."
    );
  });

  it("is gated on the existing us-stocks-listing flag", () => {
    assert.match(pageSrc, /getUsFeatureFlags\(\)/);
    assert.match(pageSrc, /flags\["us-stocks-listing"\]/);
  });

  it("reads the flag only on an India MISS, not on every page view", () => {
    // A flag evaluation is an `auth()` plus a possible Clerk round trip
    // (~200ms uncached — MONEY-1123). Hoisting it to the top of the function
    // would charge every India page view for an answer it never uses.
    const missAt = pageSrc.indexOf("if (!instrument) {");
    const flagAt = pageSrc.indexOf("getUsFeatureFlags()");
    assert.ok(missAt > 0 && flagAt > 0);
    assert.ok(
      missAt < flagAt,
      "the US feature flag is evaluated outside the India-miss branch"
    );
  });

  it("hands the ping the RESOLVED venue and does not await it", () => {
    assert.match(
      pageSrc,
      /noteUsSymbolInterest\(us\.symbol,\s*us\.exchange\)/,
      "the interest ping is not called with the resolved symbol and venue"
    );
    assert.doesNotMatch(
      pageSrc,
      /await\s+noteUsSymbolInterest/,
      "the interest ping is awaited. It is a subscription hint — awaiting it " +
        "puts Redis on the render's critical path."
    );
  });
});

describe("the interest ping cannot fail a render (MONEY-1309)", () => {
  it("wraps BOTH the scheduling call and the work in try/catch", () => {
    // Two separate hazards. `after()` throws outside a request scope (a unit
    // test, a script), and the dynamic import can reject on its own — neither
    // is caught by the inner function's own handler.
    const catches = interestSrc.match(/}\s*catch\s*(\{|\()/g) ?? [];
    assert.ok(
      catches.length >= 2,
      `expected an outer and an inner catch; found ${catches.length}`
    );
    assert.match(interestSrc, /after\(async/);
  });

  it("returns void — there is no promise a caller could accidentally await", () => {
    assert.match(
      interestSrc,
      /export function noteUsSymbolInterest\([\s\S]*?\):\s*void\s*\{/,
      "the ping returns something awaitable; a caller could put it on the " +
        "critical path by accident"
    );
  });

  it("ignores a non-US venue instead of erroring on one", () => {
    assert.match(interestSrc, /normalizeUsExchange\(exchange\)\s*===\s*null/);
  });
});

describe("the US panel renders provenance, not just a price (MONEY-1309)", () => {
  it("reuses the SHARED provenance chip", () => {
    // Re-implementing the chip would put two visual languages for the same fact
    // on one page — the argument `SectionShell` already makes against importing
    // the page-level empty state into a section.
    assert.match(clientSrc, /ProvenanceChip/);
    assert.match(clientSrc, /from "@\/components\/stock\/SectionShell"/);
  });

  it("prefers PER-QUOTE provenance over the envelope label", () => {
    // The envelope carries one `source` for a whole batch and is pessimistic by
    // design; the quote knows exactly which store answered it.
    assert.match(clientSrc, /quote\?\.provenance/);
    assert.match(clientSrc, /provenance\?\.source\s*\?\?\s*source/);
    assert.match(clientSrc, /provenance\?\.fallback\s*\?\?\s*meta\.delayed/);
  });

  it("[regression] the chip and the disclaimer get the SAME OBJECT", () => {
    // They used to get two derived values off it — `fallback` for the chip,
    // `chipSource` for the note — and the note's predicate never read
    // `fallback`. So `{source:"TIINGO_RT", fallback:true}` rendered an amber
    // `fallback` pill and a green "Live quote" badge two inches apart on one
    // header, with the badge standing where the compliance disclaimer should
    // be. Handing both renderers one object removes the seam the disagreement
    // lived in. (What each one DOES with it is asserted by rendering, in
    // `__tests__/components/us-quote-live-badge.test.ts`.)
    assert.match(clientSrc, /<ProvenanceChip\s+\{\.\.\.quoteProvenance\}/);
    assert.match(
      clientSrc,
      /<DelayedDataNote\s+provenance=\{quoteProvenance\}/
    );
    assert.doesNotMatch(
      clientSrc,
      /<DelayedDataNote[^>]*\bsource=/,
      "the disclaimer is being handed a bare source again, which is how it " +
        "came to ignore `fallback`"
    );
  });

  it("prices in USD and does not stamp a rupee symbol on a US quote", () => {
    // Every existing financial consumer in this repo hardcodes `₹`, which is
    // exactly how a currency-less amount becomes wrong (CLAUDE.md, MONEY-982).
    assert.doesNotMatch(clientSrc, /₹/);
    assert.match(clientSrc, /\$\$\{/);
  });
});
