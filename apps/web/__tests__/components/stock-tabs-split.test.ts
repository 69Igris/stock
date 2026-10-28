/**
 * MONEY-1147 — Corporate actions is its own section, separate from News.
 *
 * They were never a merged list: two sibling cards stacked inside one
 * "News & events" tab. So this is an information-architecture change, and the
 * things most likely to break are the seams around it rather than the render:
 *
 *   - the URL contract (`?tab=`) — a new tab value that `parseStockTab` does
 *     not accept silently falls back to "summary", so the deep link looks like
 *     it works until someone shares one;
 *   - the TWO tab lists. `StockSectionTabs.tsx` exports `STOCK_TAB_DEFS`, but
 *     the page renders its OWN inline strip (`PF_STOCK_TABS`) and does not
 *     mount that component. Adding a tab to one and not the other leaves a
 *     section that exists but is unreachable;
 *   - the empty state. The corp-actions card used to `return null` when there
 *     was nothing to show, which was correct while it sat above the news list
 *     and is wrong now that it owns a panel.
 *
 * Source: apps/web/components/stock/StockSectionTabs.tsx,
 *         apps/web/app/stock/[symbol]/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const tabsSrc = stripComments(read("components/stock/StockSectionTabs.tsx"));
const pageSrc = stripComments(read("app/stock/[symbol]/client.tsx"));
const corpSrc = read("components/stock/StockCorpActionsHistoryCard.tsx");

// ── Structural parsing, because the character budgets were lying ────────────
//
// MONEY-1205. Most of this file's assertions were of the form
// `/tab === "ownership"[\s\S]{0,600}?StockInsiderTimeline/` — "these two
// strings appear within N characters of each other". That is not a structural
// claim, and it fails in the one direction nobody checks: SILENTLY GREEN.
//
// When the insider timeline and the deals tab MOVED OUT of the ownership tab
// into the new "events" tab, the events block landed immediately after the
// ownership block in the same file. `StockInsiderTimeline` was then 338
// characters past `tab === "ownership"` (budget 600) and `StockDealsTab` 411
// (budget 700). Both guards passed. Both were asserting something that had
// just stopped being true, and the test named "Ownership carries insider
// activity and deals" would have gone on passing forever.
//
// The same regexes also fail in the opposite direction for no reason at all: a
// prettier reflow, or one more tab in a registry, moves a match past its budget
// and reds a suite without a behaviour change. The measured distances when this
// note was written were 464/600 and 424/600 — passing, at 77% of budget, one
// tab away from a false alarm.
//
// So: parse the structure. `tabBlock` scopes to a single JSX block by matching
// braces, and `tabIdsInOrder` reads a registry's ids out of the array literal.
// Both answer the question the test's TITLE asks, and neither can be moved by
// whitespace.

/**
 * The JSX block gated on `{tab === "<id>" && ( … )}`, brace-matched.
 *
 * Returns the block and nothing after it, so `doesNotMatch` against it is a
 * real statement about that tab rather than about the whole file. Comments are
 * already stripped, and JSX braces (`{symbol}`) are balanced, so counting
 * depth is sufficient.
 *
 * Throws rather than returning "" on a missing block: an assertion that
 * silently passes against an empty string is the exact failure this helper was
 * written to remove.
 */
function tabBlock(src: string, tabId: string): string {
  const marker = `{tab === "${tabId}"`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `no \`${marker}\` block in the page source`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after \`${marker}\``);
}

/**
 * Tab ids of a registry array literal, IN SOURCE ORDER.
 *
 * Scoped to the array that follows the declaration so a later `id: "…"`
 * elsewhere in the file cannot contribute. Order is part of the contract here —
 * the two registries are duplicated rather than derived, so they can disagree
 * about sequence while both containing every tab.
 */
function tabIdsInOrder(src: string, declName: string): string[] {
  const at = src.indexOf(declName);
  assert.ok(at >= 0, `no \`${declName}\` in source`);
  const open = src.indexOf("[", at);
  assert.ok(open >= 0, `no array literal after \`${declName}\``);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert.ok(close > open, `unterminated array literal after \`${declName}\``);
  return [...src.slice(open, close).matchAll(/\bid:\s*"([^"]+)"/g)].map(
    (m) => m[1]!
  );
}

describe("MONEY-1147 — News and Corporate actions are separate sections", () => {
  it('"actions" is part of the StockTab union', () => {
    assert.match(tabsSrc, /export type StockTab[\s\S]{0,220}?\|\s*"actions"/);
  });

  it("[regression] parseStockTab accepts it, so deep links survive", () => {
    // Without this the URL silently degrades to "summary" and the section is
    // unreachable by link while looking fine when clicked.
    assert.match(
      tabsSrc,
      /function parseStockTab[\s\S]{0,400}?raw === "actions"/,
      "a tab value the URL parser rejects is not really a tab"
    );
  });

  it("[regression] BOTH tab lists carry it — they are separate sources", () => {
    // STOCK_TAB_DEFS is exported but the page does NOT mount StockSectionTabs;
    // it renders PF_STOCK_TABS inline. Whichever one is missing the entry, the
    // result is a section that exists and cannot be opened.
    //
    // Membership, not proximity: this used to be a {0,600} character window,
    // which was at 77% of budget when a single extra tab was added. See the
    // note above `tabBlock`.
    assert.ok(
      tabIdsInOrder(tabsSrc, "STOCK_TAB_DEFS").includes("actions"),
      "StockSectionTabs.STOCK_TAB_DEFS is missing the tab"
    );
    assert.ok(
      tabIdsInOrder(pageSrc, "PF_STOCK_TABS").includes("actions"),
      "the page's inline tab strip is missing the tab"
    );
  });

  it("[regression] the two cards render under DIFFERENT tabs", () => {
    // The actual split. Previously both sat inside `tab === "news"`.
    // Block-scoped since MONEY-1205 — the hand-rolled slice below was already
    // doing this for the negative half, and the positive half needs it just as
    // much: a character window run forward from one tab lands in the next.
    assert.match(
      tabBlock(pageSrc, "actions"),
      /StockCorpActionsHistoryCard/,
      "corporate actions must render under its own tab"
    );
    assert.match(
      tabBlock(pageSrc, "news"),
      /StockNewsTab/,
      "news must still render under the news tab"
    );

    // And the news block must NOT still contain the corp-actions card.
    assert.doesNotMatch(
      tabBlock(pageSrc, "news"),
      /StockCorpActionsHistoryCard/,
      "the news tab still stacks the corporate-actions card — not split"
    );
  });

  it("[regression] the corp-actions card no longer collapses to null when empty", () => {
    // Correct while it was stacked above the news list; wrong now that it owns
    // a panel — it would render as an unexplained blank section.
    assert.doesNotMatch(
      stripComments(corpSrc),
      /if \(actions\.length === 0\) return null;/,
      "an owned section needs a real empty state, not a silent collapse"
    );
    // MONEY-1255 — the sentence became the shared `SectionEmpty` body. The
    // rule this asserts is unchanged (an owned section needs a real empty
    // state) and the "nothing on record, not a failed fetch" distinction it
    // used to carry now rides in that box's tooltip — asserted by
    // `empty-state-copy.test.ts`.
    assert.match(corpSrc, /<SectionEmpty\b/);
  });
});

// ── MONEY-1205 · the Events tab ─────────────────────────────────────────────
//
// The same four-place contract, applied to the tab that splits Ownership in
// two. Ownership keeps the STANDING POSITIONS (the quarterly shareholding
// pattern, the schemes holding the stock); Events takes the DATED DISCLOSURES
// about what significant holders did (insider & promoter activity, bulk & block
// deals).
//
// Corporate actions deliberately stays its own tab rather than absorbing these.
// Both are dated and structured, but the tense is opposite: a record date is
// scheduled and forward-looking and the holder may need to act before it
// arrives, while an insider filing reports something that already happened to
// somebody else's shares. Only one of them belongs on a to-do list.
describe("MONEY-1205 — the Events tab is registered in all four places", () => {
  it("is in the StockTab union", () => {
    assert.ok(
      /export type StockTab[\s\S]*?;/
        .exec(tabsSrc)?.[0]
        ?.includes('| "events"'),
      "a tab missing from the union does not typecheck at the mount site"
    );
  });

  it("is accepted by parseStockTab (the URL contract)", () => {
    // Omit this and ?tab=events silently falls back to "summary": the deep
    // link looks like it works until somebody shares one.
    assert.match(
      tabsSrc,
      /function parseStockTab[\s\S]*?raw === "events"/,
      "a tab value the URL parser rejects is not really a tab"
    );
  });

  it("[regression] is in BOTH registries — they are duplicated, not derived", () => {
    assert.ok(
      tabIdsInOrder(tabsSrc, "STOCK_TAB_DEFS").includes("events"),
      "StockSectionTabs.STOCK_TAB_DEFS is missing the tab"
    );
    assert.ok(
      tabIdsInOrder(pageSrc, "PF_STOCK_TABS").includes("events"),
      "the page's inline strip is missing the tab — section exists, unreachable"
    );
  });

  it("[regression] sits between Ownership and F&O in BOTH registries", () => {
    // ORDER is a real part of this change, and it is the part a membership
    // check cannot see. The tab reads as a split of Ownership, so it has to sit
    // next to it; dropped at the end of either list it becomes an unrelated
    // eighth tab. The registries are duplicated, so both can drift apart.
    for (const [name, ids] of [
      ["STOCK_TAB_DEFS", tabIdsInOrder(tabsSrc, "STOCK_TAB_DEFS")],
      ["PF_STOCK_TABS", tabIdsInOrder(pageSrc, "PF_STOCK_TABS")],
    ] as const) {
      const at = ids.indexOf("events");
      assert.ok(at > 0, `${name}: no events tab`);
      assert.equal(
        ids[at - 1],
        "ownership",
        `${name}: events must follow ownership — it is a split of it`
      );
      assert.equal(
        ids[at + 1],
        "derivatives",
        `${name}: events must precede F&O`
      );
    }
  });

  it("[regression] BOTH registries agree on the whole tab order", () => {
    // Two hand-maintained lists that contain the same ids in a different order
    // give the reader a different strip depending on which component renders —
    // a drift no membership assertion can catch.
    assert.deepEqual(
      tabIdsInOrder(pageSrc, "PF_STOCK_TABS"),
      tabIdsInOrder(tabsSrc, "STOCK_TAB_DEFS"),
      "the two tab registries have drifted apart in order or content"
    );
  });
});

describe("MONEY-1205 — the ownership/events sections actually moved", () => {
  it("Events mounts the insider timeline and the deals tab", () => {
    const events = tabBlock(pageSrc, "events");
    assert.match(events, /<StockInsiderTimeline\s/);
    assert.match(events, /<StockDealsTab\s/);
  });

  it("[regression] Ownership no longer mounts either of them", () => {
    // The half that a character-distance regex CANNOT express. The events
    // block sits immediately after the ownership block, so
    // `/tab === "ownership"[\s\S]*?StockDealsTab/` matches the page source
    // whether or not the move happened — it just runs past the closing brace
    // into the next tab. Only a brace-matched block makes this assertable.
    const ownership = tabBlock(pageSrc, "ownership");
    assert.doesNotMatch(
      ownership,
      /StockInsiderTimeline/,
      "insider activity is still mounted under Ownership"
    );
    assert.doesNotMatch(
      ownership,
      /StockDealsTab/,
      "bulk & block deals are still mounted under Ownership"
    );
  });

  it("[regression] the two blocks are disjoint, not nested", () => {
    // A nested `{tab === "events"}` inside the ownership block would satisfy
    // every assertion above while making Events unreachable.
    const ownership = tabBlock(pageSrc, "ownership");
    assert.doesNotMatch(ownership, /tab === "events"/);
  });

  it("Ownership keeps exactly the standing-position sections", () => {
    const ownership = tabBlock(pageSrc, "ownership");
    assert.match(ownership, /<StockShareholdingSection\s/);
    assert.match(ownership, /<StockFundsHolding\s/);
  });
});

// ── MONEY-1204 / P14 · the F&O tab ──────────────────────────────────────────
//
// Same four-place contract the "actions" split established, applied to the one
// tab P14 adds. The other eight data-engine sections deliberately land INSIDE
// existing tabs (delivery in Summary, shareholding/insider/deals in Ownership,
// the source badge in Financials, flags in the header) — nine new top-level
// tabs would make a fifteen-tab strip, which is a worse page than the data is
// worth. Only a real TAB needs this guard.
//
// The windows below are generous on purpose: this file's existing assertions
// use {0,600} against a list that P14 grew, and a guard that fails because the
// list got longer teaches people to widen the number rather than read it.
//
// REGISTRATION IS NOT THE WHOLE CONTRACT — a fifth place was missing for the
// whole of P14 and none of the four guards below noticed. `StockDerivativesTab`
// self-gates to null for a cash-only name and exposes `onFnoResolved` so the
// TAB can be dropped too; nothing passed it, so every stock in the market
// carried a live "F&O" tab that opened onto a skeleton and then an empty div.
// The visibility half is pinned in the describe that follows this one, and the
// tri-state rule itself is unit-tested in `fno-tab-visibility.test.ts`.
describe("MONEY-1204 — the derivatives tab is registered in all four places", () => {
  it("is in the StockTab union (or a deep link is not really a tab)", () => {
    assert.match(
      tabsSrc,
      /export type StockTab[\s\S]{0,400}?\|\s*"derivatives"/
    );
  });

  it("is accepted by parseStockTab (the URL contract)", () => {
    // Omit it here and ?tab=derivatives silently falls back to "summary" —
    // the failure the original split test was written to catch.
    assert.match(
      tabsSrc,
      /function parseStockTab[\s\S]{0,600}?raw === "derivatives"/
    );
  });

  it("is in STOCK_TAB_DEFS", () => {
    assert.ok(tabIdsInOrder(tabsSrc, "STOCK_TAB_DEFS").includes("derivatives"));
  });

  it("is in the page's OWN inline strip (PF_STOCK_TABS)", () => {
    // The page does not mount StockSectionTabs; it renders its own strip. A tab
    // in one list and not the other is a section that exists but is unreachable.
    assert.ok(tabIdsInOrder(pageSrc, "PF_STOCK_TABS").includes("derivatives"));
  });

  it("actually renders StockDerivativesTab", () => {
    // Deliberately loose about HOW: the mount moved out of a
    // `{tab === "derivatives" && …}` block (see the next describe for why), so
    // this asserts only that the page still mounts the component.
    assert.match(pageSrc, /<StockDerivativesTab\s/);
  });
});

// ── MONEY-1204 — the F&O tab is HIDDEN for a cash-only name ─────────────────
//
// The gap this describe exists for: the mechanism was built, exported and
// documented, and then nothing used it. `StockDerivativesTab.onFnoResolved`
// (StockDerivativesTab.tsx:50, fired at :98) had ZERO call sites, and
// `StockSectionTabs.tsx` carried a comment claiming "a non-F&O name shows
// nothing rather than an empty F&O panel" — which was false for every stock on
// the exchange.
describe("MONEY-1204 — the F&O tab hides itself when the stock has no derivatives", () => {
  it("[regression] passes onFnoResolved — without it nothing can hide the tab", () => {
    assert.match(
      pageSrc,
      /<StockDerivativesTab[\s\S]{0,200}?onFnoResolved=\{/,
      "the tab-hiding callback is exported and fired; the page must pass it"
    );
  });

  it("[regression] mounts the section OUTSIDE the active-tab gate", () => {
    // The subtle half. `isFno` is knowable only from this component's own
    // fetch, so gating the MOUNT on `tab === "derivatives"` means the answer
    // never arrives for a user who never opens the tab — and the tab can
    // therefore never be hidden, which is exactly the shipped behaviour.
    assert.doesNotMatch(
      pageSrc,
      /\{tab === "derivatives" &&/,
      "gating the mount on the active tab makes the F&O answer unreachable"
    );
    assert.match(
      pageSrc,
      /hidden=\{tab !== "derivatives"\}[\s\S]{0,200}?<StockDerivativesTab/,
      "the panel is mounted for every tab and merely hidden unless selected"
    );
  });

  it("[regression] the strip renders the FILTERED list, not the raw registry", () => {
    // `PF_STOCK_TABS.map(...)` was the shipped strip: every entry, always.
    assert.doesNotMatch(
      pageSrc,
      /PF_STOCK_TABS\.map\(/,
      "mapping the raw registry renders the F&O tab for every stock"
    );
    assert.match(
      pageSrc,
      /visibleTabs\.map\(/,
      "the strip must render the F&O-filtered list"
    );
    assert.match(
      pageSrc,
      /visibleStockTabs\(\s*PF_STOCK_TABS,\s*fnoState,\s*tab\s*\)/,
      "the filtered list must come from the shared tri-state rule"
    );
  });

  it("[regression] never strands a user on the tab it just removed", () => {
    // Including the deep link `?tab=derivatives` on a cash-only name.
    assert.match(
      pageSrc,
      /handleFnoResolved[\s\S]{0,700}?tabAfterFnoHidden\(tabRef\.current\)/,
      "resolving to non-F&O while the tab is active must move the selection"
    );
    // MONEY-1082: a late write from a fetch continuation goes through the
    // guarded owned-route API, never a bare history call.
    assert.match(
      pageSrc,
      /tabAfterFnoHidden\(tabRef\.current\)[\s\S]{0,600}?ownedRoute\.syncParams\(/,
      "the URL write that follows must be route-guarded"
    );
  });

  it("[regression] the state is TRI-state, not a boolean", () => {
    // A boolean makes "not resolved yet" indistinguishable from "not an F&O
    // name", which is what turns the gate into a flash on every page load.
    assert.match(pageSrc, /useState<FnoTabState>\("unknown"\)/);
  });
});

describe("MONEY-1204 — the non-tab sections are actually mounted", () => {
  it("header carries the exchange-flag badges", () => {
    // 14c.1 renders in the header rather than a tab, so nothing else in this
    // file would notice if the import were left unused.
    assert.match(pageSrc, /<StockFlagsBadges\s/);
  });

  it("Summary NO LONGER carries the delivery chip or circulars strip", () => {
    // MONEY-1213 — both were removed. Inverted rather than deleted, so the
    // page cannot quietly regain them: `StockDeliveryChip` led with
    // "EXCHANGE BHAVCOPY / 20/20 SESSIONS REPORTED / GAPS = NOT REPORTED", and
    // `SymbolCircularsStrip` was labelled "HEURISTIC MATCH" and rendered an
    // empty state on most symbols. Both are pipeline internals, not reader
    // information.
    const summary = tabBlock(pageSrc, "summary");
    assert.doesNotMatch(summary, /StockDeliveryChip/);
    assert.doesNotMatch(summary, /SymbolCircularsStrip/);
    assert.doesNotMatch(pageSrc, /StockDeliveryChip|SymbolCircularsStrip/);
  });

  it("Ownership carries the shareholding pattern and funds-holding", () => {
    // MONEY-1205 re-anchored this. It used to assert that the insider timeline
    // and the deals tab were ALSO here; they moved to the "events" tab, and
    // what remains under Ownership is the pair that answers "how much" —
    // the quarterly pattern, and the schemes holding it from the other side.
    //
    // THIS TEST USED TO LIE, TWICE, for two different reasons.
    //
    // First (MONEY-1204): the word "shareholding" appeared only in its title.
    // It asserted the insider timeline and the deals tab and nothing else, so
    // 14c.4 — the section the whole provenance envelope was designed around —
    // shipped with a service, an action, an apps/api route and ZERO call sites
    // in apps/web, and this guard stayed green throughout. A title is not an
    // assertion.
    //
    // Second (MONEY-1205): the assertions were character-distance regexes, so
    // when the two event sections moved OUT of this tab into the block that
    // immediately follows it, `tab === "ownership"[\s\S]{0,600}?
    // StockInsiderTimeline` went on matching — across the block boundary, into
    // a different tab. Green, and false. Scoping to the brace-matched block is
    // what makes "carries" mean carries.
    const ownership = tabBlock(pageSrc, "ownership");
    assert.match(
      ownership,
      /StockShareholdingSection/,
      "the shareholding section this test is named after must be mounted"
    );
    assert.match(
      ownership,
      /StockFundsHolding/,
      "the inverse who-holds-this lookup belongs beside the pattern"
    );
  });

  it("[regression] the NSE section REPLACES the legacy Tickertape tab", () => {
    // The deliberate call, pinned so re-adding it is a decision and not a
    // drift. `StockShareholdingTab` reads the unlabelled Tickertape chain; the
    // new section reads NSE first and LABELS the provider when it falls back.
    // Side by side they show different numbers for the same quarter with no
    // way for a reader to tell which is which — the precise failure the
    // envelope in packages/services/src/provenance.ts exists to prevent.
    assert.doesNotMatch(
      pageSrc,
      /<StockShareholdingTab\s/,
      "two shareholding panels disagreeing on one screen is worse than either"
    );
  });

  it("[regression] the section branches on the envelope, not on row count", () => {
    // `empty` and `rows.length === 0` are different questions once a fallback
    // exists: zero NSE rows with a populated Tickertape series is NOT empty.
    // Seven discover components get this wrong; this one must not join them.
    const src = stripComments(
      read("components/stock/StockShareholdingSection.tsx")
    );
    assert.match(
      src,
      /setEmpty\(r\.data\.empty\)/,
      "emptiness must come from the provenance envelope"
    );
    assert.doesNotMatch(
      src,
      /empty=\{[^}]*\.length === 0\}/,
      "deriving `empty` from a row count defeats the fallback"
    );
    // The fallback chip and the staleness label are the section's reason to
    // exist — SHAREHOLDING_FALLBACK_SOURCE / buildShareholdingNote /
    // SHAREHOLDING_STALE_TTL_S were all dead on web before this mount.
    assert.match(src, /fallback: r\.data\.fallback/);
    assert.match(src, /prov\.fallback &&/);
    assert.match(src, /data\?\.stale/);
  });
});

describe("MONEY-1204 — 14c.7/8/9 are mounted where they were placed", () => {
  it("[MONEY-1211] Financials carries the TABLE and nothing above it", () => {
    // RETIRED, not weakened. 14c.8 required a "Financials provenance" section
    // above the table — a STATEMENT SOURCE / LAST REFRESHED card, a
    // standalone-vs-consolidated toggle, per-filing coverage rows and a
    // "Where these numbers come from." explainer. MONEY-1211 removes the
    // section outright at the founder's request, so the old assertion no
    // longer describes reality and is replaced by its inverse rather than
    // being softened into something that passes either way.
    const block = tabBlock(pageSrc, "financials");
    assert.match(block, /StockFinancialsTab/);
    assert.doesNotMatch(
      block,
      /StockFinancialsSourceBadge/,
      "the provenance section is back on the financials tab"
    );
  });

  it("Corporate actions carries the filings timeline", () => {
    // Block-scoped (MONEY-1205): the news block follows this one, so a
    // character window here would reach into it the same way the ownership
    // guard reached into events.
    assert.match(tabBlock(pageSrc, "actions"), /StockFilingsTimeline/);
  });

  it("Ownership carries funds-holding", () => {
    assert.match(tabBlock(pageSrc, "ownership"), /StockFundsHolding/);
  });
});
