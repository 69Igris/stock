/**
 * MONEY-1205 — the header flag strip stops crying wolf.
 *
 * ## What was wrong
 *
 * `StockFlagsBadges` mounts inside the `<h1>` flex row and its own docblock
 * states the contract: "a flag is an exception by definition". It shipped
 * contradicting that on ~100% of stock pages, because two of the seven kinds
 * publish for the WHOLE CASH UNIVERSE every session. Measured on prod for
 * 2026-08-17: `PRICE_BAND` 3,489 rows and `WK52_HIGH_LOW` 3,325. Every stock
 * therefore carried at least two "flags", so the strip's presence carried no
 * information at all.
 *
 * ## Why this file tests source text for half of it
 *
 * The DECISION — which badges are exceptional — is pure and lives in
 * `@usemoney/core/market-data`, where it is unit-tested directly
 * (`packages/core/__tests__/market-data/stock-section-logic.test.ts`). Those
 * tests are imported from here for the half that can be executed.
 *
 * The RENDERING is JSX inside a client component that imports the server-action
 * graph, so it cannot be mounted in `node:test`. That half is pinned by reading
 * the source, in the house style of `stock-tabs-split.test.ts` — and the
 * assertions are deliberately about STRUCTURE (which identifier feeds the
 * render, which branch guards a suffix) rather than about wording, so a copy
 * edit does not red the suite and a behaviour change cannot slip through.
 *
 * Source: apps/web/components/stock/StockFlagsBadges.tsx
 *         apps/web/components/stock/StockDerivativesTab.tsx
 *         apps/web/app/stock/[symbol]/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildStockFlagBadges,
  selectHeadlineStockFlagBadges,
  stockFlagShape,
  FLAG_KIND_POLICY,
} from "@usemoney/core/market-data";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const flagsSrc = stripComments(read("components/stock/StockFlagsBadges.tsx"));
const derivSrc = stripComments(
  read("components/stock/StockDerivativesTab.tsx")
);
const pageSrc = stripComments(read("app/stock/[symbol]/client.tsx"));

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// ── The data half — executed, not read ──────────────────────────────────────

describe("MONEY-1205 — the strip is empty for an ordinary stock", () => {
  it("a plain 20%-band + 52-week-only stock produces NOTHING to headline", () => {
    // The end-to-end claim the header depends on, at the page's own level:
    // this is what the overwhelming majority of the market looks like, and the
    // strip must have zero chips for it. Both flags are still BUILT — the fix
    // is a narrowing at the render boundary, not a loss of data.
    const badges = buildStockFlagBadges([
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
      {
        kind: "WK52_HIGH_LOW",
        value:
          '{"high":1020.5,"highDate":"2025-10-23","low":722,"lowDate":"2026-08-12"}',
        date: day("2026-08-17"),
      },
    ]);
    assert.equal(badges.length, 2, "both flags are still built — nothing lost");
    assert.deepEqual(
      selectHeadlineStockFlagBadges(badges),
      [],
      "an ordinary stock must contribute no header chips"
    );
  });

  it("[regression] the two whole-universe kinds are the ones excluded", () => {
    // Pinned against the POLICY table rather than restated as a literal, so
    // this cannot drift away from the rule the service applies. A kind that
    // publishes for the whole universe daily is by construction not an
    // exception, which is the entire premise of the strip.
    for (const kind of ["PRICE_BAND", "WK52_HIGH_LOW"] as const) {
      assert.equal(
        FLAG_KIND_POLICY[kind].wholeUniverseDaily,
        true,
        `${kind} is the reason the strip rendered on every page`
      );
    }
  });

  it("a genuinely flagged stock still headlines — the filter is not a mute", () => {
    // The failure mode opposite to crying wolf: narrowing so hard that a real
    // surveillance stint stops showing. GSM is exactly what the strip is for.
    const badges = buildStockFlagBadges([
      { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-17") },
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
    ]);
    assert.deepEqual(
      selectHeadlineStockFlagBadges(badges).map((b) => b.kind),
      ["SURVEILLANCE"]
    );
  });
});

describe("MONEY-1205 — a POINT badge is a dated event, never a state", () => {
  it("a two-year-old band change is POINT and not current", () => {
    // This is the exact input that produced the shipped falsehood: HDFCBANK's
    // 21-May-2024 band change rendered in a 2026 header with "(ended)". A band
    // change is a one-day event, so it was never in force and cannot end.
    //
    // `referenceDayByKind` is supplied because the real caller supplies it
    // (`stock-sections-market.service.ts` → `buildStockFlagBadges(allFlagRows,
    // { referenceDayByKind })`). Without it the badge is judged against its OWN
    // newest row, which for a single-row POINT kind is the event itself — so it
    // reports `isCurrent: true` and this test would assert nothing. The
    // reference day IS the market calendar, and it is what makes "recent"
    // mean recent.
    const badges = buildStockFlagBadges(
      [{ kind: "BAND_CHANGE", value: '{"to":"5"}', date: day("2024-05-21") }],
      { referenceDayByKind: { BAND_CHANGE: "2026-08-17" } }
    );
    const badge = badges[0];
    assert.ok(badge, "the badge must still be built");
    assert.equal(badge.shape, "POINT", "a band change is a point event");
    assert.equal(
      badge.isCurrent,
      false,
      "two years stale — this is what used to trigger the (ended) suffix"
    );
    // …and `isCurrent === false` on a POINT badge means NOT RECENT, so it is
    // also correctly absent from the headline.
    assert.deepEqual(selectHeadlineStockFlagBadges(badges), []);
  });

  it("shape is null for a kind the policy table has never seen", () => {
    // The third branch. Grouping an unknown family with POINT is deliberate:
    // guessing that a new NSE family is a standing state is the mistake the
    // branch exists to stop making, and a plain dated event is the claim that
    // survives being wrong.
    assert.equal(stockFlagShape("NEW_NSE_THING"), null);
    assert.equal(stockFlagShape("SURVEILLANCE"), "STATE");
    assert.equal(stockFlagShape("BAND_CHANGE"), "POINT");
  });
});

// ── The render half — structure, read from source ───────────────────────────

describe("MONEY-1205 — StockFlagsBadges renders `headline`, not `badges`", () => {
  it("[regression] the rendered list is fed by `headline`", () => {
    // The one-line heart of the fix. `badges` is the COMPLETE set — the
    // screener and the research tool both need it — and rendering it here is
    // what put a flag strip on every stock in the market.
    assert.match(
      flagsSrc,
      /const badges = data\.headline/,
      "the strip must render the narrowed set"
    );
  });

  it("[regression] does NOT fall back to `badges` on an old cached envelope", () => {
    // `data.badges ?? []` as a fallback would reinstate the cry-wolf strip for
    // the whole 6-hour closed-market TTL whenever an envelope predates this
    // change. The fallback must go the other way: render nothing.
    assert.doesNotMatch(
      flagsSrc,
      /const badges = data\.headline \?\? data\.badges/,
      "falling back to the full set re-creates the bug for a whole TTL"
    );
    assert.doesNotMatch(
      flagsSrc,
      /data\.badges/,
      "this component must not read the unnarrowed set at all"
    );
  });

  it("[regression] the three empty-path `return null`s survive", () => {
    // The component mounts INSIDE the `<h1>` flex row, where `SectionShell`
    // never returns null. MONEY-1205 makes the empty case the COMMON case, so
    // these go from protecting a minority of pages to ~99% of them: a shimmer,
    // an `<h3>` or a dashed empty box would now land in the headline of almost
    // every stock page.
    const returns = flagsSrc.match(/return null;/g) ?? [];
    assert.ok(
      returns.length >= 3,
      `expected the loading / failed / empty guards, found ${returns.length}`
    );
    assert.match(flagsSrc, /if \(meta\?\.empty \?\? true\) return null;/);
    assert.match(
      flagsSrc,
      /badges\.length === 0 && indexes\.length === 0\) return null;/
    );
  });
});

describe('MONEY-1205 — "(ended)" is gated on STATE', () => {
  it("[regression] the suffix is not driven by `isCurrent` alone", () => {
    // The shipped bug: `{!badge.isCurrent && <span>(ended)</span>}`. For a POINT
    // badge that is not a stale label, it is a false statement — the event
    // never was in force.
    assert.doesNotMatch(
      flagsSrc,
      /\{!badge\.isCurrent && \(/,
      "an unconditional isCurrent gate renders (ended) for dated one-offs"
    );
  });

  it("[regression] the shape is consulted before the suffix is computed", () => {
    // Structural rather than textual: some STATE-valued predicate must exist
    // and must be what guards the suffix.
    assert.match(
      flagsSrc,
      /const isState = badge\.shape === "STATE";/,
      "the STATE/POINT branch must be an explicit decision"
    );
    assert.match(
      flagsSrc,
      /const endedSuffix = isState && !badge\.isCurrent;/,
      "(ended) requires BOTH a standing state and it no longer being in force"
    );
    assert.match(
      flagsSrc,
      /\{endedSuffix && \(/,
      "the suffix must render off the guarded value"
    );
  });

  it("a POINT badge shows its DATE instead of a state suffix", () => {
    // Half the fact for a one-day event, and what stops a two-year-old band
    // change reading as news.
    assert.match(flagsSrc, /\{!isState && on !== null && \(/);
  });
});

describe("MONEY-1205 — the popover decodes, except where raw IS the point", () => {
  it("[regression] SURVEILLANCE stays byte-identical to the stored value", () => {
    // The badge LABEL decodes surveillance codes; this popover is the one place
    // the raw code is the point, because it is what makes the column checkable
    // against what NSE actually published.
    assert.match(
      flagsSrc,
      /badge\.kind === "SURVEILLANCE"\s*\?\s*row\.value/,
      "decoding the surveillance code here destroys the verbatim column"
    );
  });

  it("every other kind renders the shared decode", () => {
    // Before `display`, this row rendered stored JSON at a user: `{"band":"5"}`.
    assert.match(
      flagsSrc,
      /row\.display \?\? row\.value/,
      "non-surveillance rows must use the service-side decoder"
    );
  });
});

describe("MONEY-1205 — the dropped kinds were RELOCATED, not deleted", () => {
  it("52-week extremes moved to a second DayRangeBar in the header", () => {
    // `DayRangeBar`'s `label` prop is documented for exactly this. The numbers
    // also already sit in the 52W HIGH / 52W LOW metrics; the bar is what puts
    // the current price between them.
    assert.match(
      pageSrc,
      /<DayRangeBar\s+label="52W range"/,
      "52-week high/low must remain visible somewhere on the page"
    );
    assert.match(pageSrc, /low=\{quote\?\.week52Low\}/);
    assert.match(pageSrc, /high=\{quote\?\.week52High\}/);
  });

  it("short selling moved beside the SLB panel in the F&O tab", () => {
    // A disclosed short sale is the SLB borrow's twin: the two halves of the
    // only short-interest picture India publishes, legible side by side and
    // nowhere else.
    assert.match(derivSrc, /<SlbPanel[\s\S]{0,400}?<ShortSellingPanel/);
    assert.match(derivSrc, /function ShortSellingPanel/);
  });

  it("[regression] the F&O panel reads `badges`, NOT `headline`", () => {
    // The inverse of the header's rule, and the reason the panel exists:
    // `selectHeadlineStockFlagBadges` deliberately excludes SHORT_SELLING, so
    // reading `headline` here would render an always-empty panel.
    assert.match(
      derivSrc,
      /flags\.badges \?\? \[\]/,
      "the relocated panel needs the complete set, not the header's narrowing"
    );
    assert.doesNotMatch(
      derivSrc,
      /flags\.headline/,
      "headline never contains SHORT_SELLING — this panel would always be empty"
    );
  });

  it("both kinds stay reachable in the flags payload's history", () => {
    // Relocation is only honest if the rows are still there. The panel reads
    // its ladder straight out of `history`.
    assert.match(derivSrc, /flags\.history\?\.SHORT_SELLING/);
  });
});
