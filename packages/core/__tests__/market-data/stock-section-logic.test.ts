/**
 * Pure read-side helpers for the stock page's data-engine sections —
 * MONEY-1204 (P14 / 14c.1 · 14c.2 · 14c.3).
 *
 * Behavioural, not shadow: every case here fails if the corresponding rule in
 * `stock-section-logic.ts` is removed. The four rules worth breaking a build
 * over, and the wrong implementation each one guards against:
 *
 *   1. current-state-per-kind is a REDUCE over an append-only table — taking
 *      "the newest row" collapses a 40-day stint to one day and loses `since`;
 *   2. one kind can carry SEVERAL simultaneous values (GSM + ESM on the same
 *      day) and dropping either is a missed retail warning;
 *   3. a null `deliveryPct` is `-` ("not reported"), and averaging it as 0
 *      understates delivery on exactly the illiquid names where it matters;
 *   4. the SLB ladder must not be collapsed across series — MONEY-1201
 *      measured that mistake discarding 84.2% of open borrow interest while
 *      reporting success.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  POINT_EVENT_RECENCY_DAYS,
  buildDerivativeSummaryView,
  buildIndexChips,
  buildMwplSnapshot,
  buildSlbLadder,
  buildStockFlagBadges,
  computeDeliveryTrend,
  describeOiBuildup,
  finiteOrNull,
  formatStockFlagValue,
  indexChipLabel,
  isExpiryWeek,
  isHeadlineWorthy,
  isKnownStockFlagKind,
  isoOrNull,
  mwplBand,
  parseStockFlagValue,
  selectHeadlineStockFlagBadges,
  textOrNull,
} from "../../src/market-data/stock-section-logic";
import { FLAG_KIND_POLICY } from "../../src/market-data/stock-flags";

const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

// ════════════════════════════════════════════════════════════════════════════
// Coercion primitives — the absence rules
// ════════════════════════════════════════════════════════════════════════════

describe("14c coercion: finiteOrNull / textOrNull / isoOrNull", () => {
  it("keeps a published ZERO and rejects blank/dash as null, never 0", () => {
    // The whole point: `Number("")` is 0 and `Number("-")` is NaN. A reported
    // 0% delivery and an unreported one must not land on the same value.
    assert.equal(finiteOrNull(0), 0);
    assert.equal(finiteOrNull("0"), 0);
    assert.equal(finiteOrNull(""), null);
    assert.equal(finiteOrNull("   "), null);
    assert.equal(finiteOrNull("-"), null);
    assert.equal(finiteOrNull("N/A"), null);
    assert.equal(finiteOrNull(null), null);
    assert.equal(finiteOrNull(undefined), null);
    assert.equal(finiteOrNull(NaN), null);
    assert.equal(finiteOrNull(Infinity), null);
    assert.equal(finiteOrNull("No Band"), null);
  });

  it("converts BigInt (the DerivativeSummary/deliveryQty column type)", () => {
    assert.equal(finiteOrNull(1_234_567_890n), 1_234_567_890);
    assert.equal(finiteOrNull(0n), 0);
  });

  it("textOrNull treats a dash as absence but keeps a real label", () => {
    assert.equal(textOrNull("-"), null);
    assert.equal(textOrNull(""), null);
    assert.equal(textOrNull("  EQ "), "EQ");
    assert.equal(textOrNull("No Band"), "No Band");
    assert.equal(textOrNull(null), null);
  });

  it("isoOrNull refuses an invalid date instead of coercing it", () => {
    assert.equal(isoOrNull(day("2026-08-14")), "2026-08-14T00:00:00.000Z");
    assert.equal(isoOrNull("not-a-date"), null);
    assert.equal(isoOrNull(new Date("nope")), null);
    assert.equal(isoOrNull(null), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.1 — StockFlag current state
// ════════════════════════════════════════════════════════════════════════════

describe("14c.1 parseStockFlagValue: per-kind value encoding", () => {
  it("decodes each kind's documented encoding", () => {
    assert.deepEqual(
      parseStockFlagValue(
        "WK52_HIGH_LOW",
        '{"high":246.61,"highDate":"2025-08-19","low":129.61,"lowDate":"2026-03-30"}',
      ),
      {
        type: "WK52_HIGH_LOW",
        high: 246.61,
        highDate: "2025-08-19",
        low: 129.61,
        lowDate: "2026-03-30",
      },
    );
    assert.deepEqual(
      parseStockFlagValue("BAND_CHANGE", '{"from":"10","to":"20"}'),
      {
        type: "BAND_CHANGE",
        from: "10",
        to: "20",
      },
    );
    assert.deepEqual(parseStockFlagValue("PRICE_BAND", '{"band":"2"}'), {
      type: "PRICE_BAND",
      band: "2",
    });
    assert.deepEqual(parseStockFlagValue("FO_BAN", "BAN"), { type: "FO_BAN" });
    assert.deepEqual(
      parseStockFlagValue("SERIES_CHANGE", '{"from":"EQ","to":"BE"}'),
      { type: "SERIES_CHANGE", from: "EQ", to: "BE" },
    );
    assert.deepEqual(parseStockFlagValue("SHORT_SELLING", '{"qty":91}'), {
      type: "SHORT_SELLING",
      qty: 91,
    });
  });

  it("keeps `No Band` as a STRING — Number('No Band') is NaN poison", () => {
    const parsed = parseStockFlagValue("PRICE_BAND", '{"band":"No Band"}');
    assert.equal(parsed?.type, "PRICE_BAND");
    assert.equal(
      parsed?.type === "PRICE_BAND" ? parsed.band : "MISSING",
      "No Band",
    );
  });

  it("stores surveillance VERBATIM and decodes at read time", () => {
    const parsed = parseStockFlagValue("SURVEILLANCE", "GSM STAGE - I");
    assert.equal(parsed?.type, "SURVEILLANCE");
    if (parsed?.type !== "SURVEILLANCE") return;
    assert.equal(parsed.code, "GSM STAGE - I", "raw code must survive intact");
    assert.equal(parsed.decode?.framework, "GSM");
    assert.equal(parsed.decode?.stage, 1);
  });

  it("returns null rather than a guess when the payload is malformed", () => {
    assert.equal(parseStockFlagValue("BAND_CHANGE", "not json"), null);
    assert.equal(parseStockFlagValue("PRICE_BAND", "[1,2]"), null);
    assert.equal(parseStockFlagValue("SURVEILLANCE", "   "), null);
    assert.equal(parseStockFlagValue("BRAND_NEW_NSE_FAMILY", "x"), null);
  });
});

describe("14c.1 buildStockFlagBadges: current state per kind", () => {
  /**
   * A 5-session GSM stint, correctly bounded by the day the code CHANGED.
   *
   * The value on 08-Aug differs, so the run must stop there — a reduce that
   * walked to the oldest row for the kind would report the stint as starting
   * three days too early.
   */
  const gsmRows = [
    { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-14") },
    { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-13") },
    { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-12") },
    { kind: "SURVEILLANCE", value: "GSM STAGE - 0", date: day("2026-08-11") },
    { kind: "SURVEILLANCE", value: "GSM STAGE - 0", date: day("2026-08-10") },
  ];

  it("reduces to the newest day and measures the run back to the CHANGE", () => {
    const [badge] = buildStockFlagBadges(gsmRows);
    assert.ok(badge, "expected one surveillance badge");
    assert.equal(badge.kind, "SURVEILLANCE");
    assert.equal(badge.label, "GSM Stage I");
    assert.equal(badge.tone, "critical");
    assert.equal(badge.date, "2026-08-14T00:00:00.000Z");
    assert.equal(badge.since, "2026-08-12T00:00:00.000Z");
    assert.equal(badge.observedSessions, 3);
    assert.equal(badge.runReachesWindowEdge, false);
    assert.equal(badge.isCurrent, true);
  });

  it("is order-independent — a shuffled page reduces identically", () => {
    const shuffled = [
      gsmRows[3]!,
      gsmRows[0]!,
      gsmRows[4]!,
      gsmRows[2]!,
      gsmRows[1]!,
    ];
    assert.deepEqual(
      buildStockFlagBadges(shuffled),
      buildStockFlagBadges(gsmRows),
    );
  });

  it("flags a run that fills the whole page — `since` is a LOWER BOUND", () => {
    // Every row we hold carries the same value, so the stint may start before
    // the fetched window. Reporting `since` as fact here would be a confident,
    // unfalsifiable, wrong date.
    const [badge] = buildStockFlagBadges(gsmRows.slice(0, 3));
    assert.ok(badge);
    assert.equal(badge.observedSessions, 3);
    assert.equal(badge.runReachesWindowEdge, true);
  });

  it("keeps EVERY simultaneous value on the newest day, not just the first", () => {
    // NSE publishes combined states; with no @@unique both rows land. Dropping
    // one silently hides a framework on the surface that exists to warn.
    const badges = buildStockFlagBadges([
      { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-14") },
      {
        kind: "SURVEILLANCE",
        value: "ESM STAGE - II",
        date: day("2026-08-14"),
      },
      { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-13") },
    ]);
    assert.equal(badges.length, 2);
    const labels = badges.map((b) => b.label).sort();
    assert.deepEqual(labels, ["ESM Stage II", "GSM Stage I"]);
    // Each carries its OWN run: GSM goes back a day, ESM appeared today.
    const gsm = badges.find((b) => b.label === "GSM Stage I");
    const esm = badges.find((b) => b.label === "ESM Stage II");
    assert.equal(gsm?.observedSessions, 2);
    assert.equal(esm?.observedSessions, 1);
  });

  it("orders badges by severity: ban, surveillance, then the rest", () => {
    const badges = buildStockFlagBadges([
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-14") },
      {
        kind: "WK52_HIGH_LOW",
        value: '{"high":10,"low":2}',
        date: day("2026-08-14"),
      },
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-14") },
      { kind: "SURVEILLANCE", value: "ASM Stage II", date: day("2026-08-14") },
    ]);
    assert.deepEqual(
      badges.map((b) => b.kind),
      ["FO_BAN", "SURVEILLANCE", "PRICE_BAND", "WK52_HIGH_LOW"],
    );
    assert.equal(badges[0]?.label, "F&O ban");
    assert.equal(badges[1]?.label, "ASM Stage II");
    assert.equal(badges[2]?.label, "20% band");
  });

  it("marks a stale flag not-current against ITS OWN KIND's latest day", () => {
    // RE-EXPRESSED, MONEY-1205. This case used to pass no reference at all and
    // assert that a three-week-old SURVEILLANCE row was stale *because
    // PRICE_BAND published today* — i.e. it pinned the cross-kind maximum,
    // which is the fail-open this ticket removed. The FACT it was reaching for
    // is real (an old GSM row whose family has since published without this
    // stock has ended), so it is restated with the denominator that actually
    // supports it: the surveillance family's OWN newest market-wide day.
    const badges = buildStockFlagBadges(
      [
        { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-14") },
        {
          kind: "SURVEILLANCE",
          value: "GSM STAGE - I",
          date: day("2026-07-24"),
        },
      ],
      {
        referenceDayByKind: {
          PRICE_BAND: "2026-08-14",
          SURVEILLANCE: "2026-08-14",
        },
      },
    );
    const surv = badges.find((b) => b.kind === "SURVEILLANCE");
    const band = badges.find((b) => b.kind === "PRICE_BAND");
    assert.equal(surv?.isCurrent, false);
    assert.equal(band?.isCurrent, true);
  });

  it("does NOT let a whole-universe kind declare a sparse kind ended", () => {
    // THE MONEY-1205 DEFECT, stated directly. HDFCBANK's newest SHORT_SELLING
    // row IS the newest that family published for it; PRICE_BAND and
    // WK52_HIGH_LOW publish 3,489 / 3,325 rows EVERY session, so a shared
    // reference day always belongs to one of them and every sparser family
    // reads as stale. That printed "Short sold 106 (ended)".
    const rows = [
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
      { kind: "SHORT_SELLING", value: '{"qty":106}', date: day("2026-08-10") },
    ];
    const shared = buildStockFlagBadges(rows);
    // Without a per-kind map the sparse kind falls back to its OWN newest day,
    // so it is never wrongly declared over.
    assert.equal(
      shared.find((b) => b.kind === "SHORT_SELLING")?.isCurrent,
      true,
    );

    // And with the real per-kind denominators — short selling last published
    // market-wide on the 10th, which is exactly this row's day.
    const perKind = buildStockFlagBadges(rows, {
      referenceDayByKind: {
        PRICE_BAND: "2026-08-17",
        SHORT_SELLING: "2026-08-10",
      },
    });
    assert.equal(
      perKind.find((b) => b.kind === "SHORT_SELLING")?.isCurrent,
      true,
      "the newest row of a family that last published that day is current",
    );

    // The map is what makes a REAL exit detectable: the family published on the
    // 17th and did not name this stock.
    const exited = buildStockFlagBadges(rows, {
      referenceDayByKind: {
        PRICE_BAND: "2026-08-17",
        SHORT_SELLING: "2026-08-17",
      },
    });
    assert.equal(
      exited.find((b) => b.kind === "SHORT_SELLING")?.isCurrent,
      false,
    );
  });

  it("treats a NULL per-kind reference as unknown-so-not-in-force", () => {
    // `surveillance-sync` is prod-only, so on QA the family has never landed.
    // A null reference must not read as "still flagged" off the stock's own row.
    const badges = buildStockFlagBadges(
      [
        {
          kind: "SURVEILLANCE",
          value: "GSM STAGE - I",
          date: day("2026-08-14"),
        },
      ],
      { referenceDayByKind: { SURVEILLANCE: null } },
    );
    assert.equal(badges[0]?.isCurrent, false);
  });

  it("honours an explicit referenceDay over the rows' own maximum", () => {
    const badges = buildStockFlagBadges(
      [
        {
          kind: "SURVEILLANCE",
          value: "GSM STAGE - I",
          date: day("2026-08-01"),
        },
      ],
      { referenceDay: "2026-08-14" },
    );
    assert.equal(badges[0]?.isCurrent, false);
  });

  it("does NOT bridge a gap of sessions with no row — the run breaks there", () => {
    // B2 — ban rows exist only on ban days, so a stock banned today and last
    // banned ten days ago has exactly two rows. Walking "the next row for this
    // kind" makes that read as an unbroken run, and the UI prints the word
    // "consecutive": "2 consecutive sessions, since 4 Aug" for a ban that
    // started this morning.
    const badges = buildStockFlagBadges([
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-14") },
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-04") },
    ]);
    assert.equal(badges.length, 1);
    assert.equal(badges[0]?.since, "2026-08-14T00:00:00.000Z");
    assert.equal(badges[0]?.observedSessions, 1);
  });

  it("breaks the run on a session we OBSERVED without the flag", () => {
    // 13-Aug is a session we demonstrably hold data for — PRICE_BAND publishes
    // every day — and it carries no ban. The ban run cannot span it.
    const badges = buildStockFlagBadges([
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-14") },
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-14") },
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-13") },
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-12") },
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-12") },
    ]);
    const ban = badges.find((b) => b.kind === "FO_BAN");
    assert.equal(ban?.since, "2026-08-14T00:00:00.000Z");
    assert.equal(ban?.observedSessions, 1);
  });

  it("counts a run across a WEEKEND as consecutive sessions", () => {
    // Mon 10-Aug back to Fri 7-Aug is one unbroken run: Sat/Sun are not
    // sessions, so their absence is not evidence the flag lifted. A naive
    // "previous calendar day" rule would cut every Monday's run to one day.
    const badges = buildStockFlagBadges([
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-10") },
      { kind: "FO_BAN", value: "BAN", date: day("2026-08-07") },
    ]);
    assert.equal(badges[0]?.since, "2026-08-07T00:00:00.000Z");
    assert.equal(badges[0]?.observedSessions, 2);
  });

  it("counts a run across an EXCHANGE HOLIDAY as consecutive sessions", () => {
    // 2026-10-02 (Gandhi Jayanti) is an NSE holiday: 1-Oct → 5-Oct is
    // consecutive trading, so a stint spanning it is one run, not two.
    const badges = buildStockFlagBadges([
      { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-10-05") },
      { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-10-01") },
    ]);
    assert.equal(badges[0]?.since, "2026-10-01T00:00:00.000Z");
    assert.equal(badges[0]?.observedSessions, 2);
  });

  it("keeps an UNKNOWN kind visible instead of dropping it", () => {
    // `kind` is a String column precisely because NSE invents frameworks
    // without notice; a new one must render, unstyled, not vanish.
    const badges = buildStockFlagBadges([
      { kind: "ESM_STAGE_CHANGE", value: "whatever", date: day("2026-08-14") },
    ]);
    assert.equal(badges.length, 1);
    assert.equal(badges[0]?.label, "Esm Stage Change");
    assert.equal(badges[0]?.parsed, null);
    assert.equal(badges[0]?.raw, "whatever");
  });

  it("drops rows with an unusable date and survives an empty set", () => {
    assert.deepEqual(buildStockFlagBadges([]), []);
    assert.deepEqual(
      buildStockFlagBadges([
        { kind: "FO_BAN", value: "BAN", date: "not-a-date" },
      ]),
      [],
    );
  });

  it("carries series + source through for provenance", () => {
    const [badge] = buildStockFlagBadges([
      {
        kind: "SERIES_CHANGE",
        value: '{"from":"EQ","to":"BE"}',
        date: day("2026-08-14"),
        series: "BE",
        source: "nse-series-change",
      },
    ]);
    assert.equal(badge?.label, "Series EQ → BE");
    assert.equal(badge?.series, "BE");
    assert.equal(badge?.source, "nse-series-change");
  });

  it("isKnownStockFlagKind gates the seven documented kinds", () => {
    assert.equal(isKnownStockFlagKind("FO_BAN"), true);
    assert.equal(isKnownStockFlagKind("WK52_HIGH_LOW"), true);
    assert.equal(isKnownStockFlagKind("MADE_UP"), false);
  });
});

// ─── Index chips ─────────────────────────────────────────────────────────────

describe("14c.1 buildIndexChips", () => {
  it("labels known slugs and leaves unknown ones VERBATIM", () => {
    assert.equal(indexChipLabel("nifty50"), "Nifty 50");
    assert.equal(indexChipLabel("banknifty"), "Bank Nifty");
    assert.equal(indexChipLabel("smallcap250"), "Nifty Smallcap 250");
    assert.equal(indexChipLabel("niftybrandnew"), "NIFTYBRANDNEW");
    assert.equal(indexChipLabel(""), "");
  });

  it("covers EVERY id index-constituent-sync can write", () => {
    // `ALL_INDEX_IDS` = keys(STATIC_INDICES) ∪ keys(MCAP_RANK_SPECS) in
    // workers/src/processors/index-constituent-sync.ts, sourced from
    // apps/web/lib/screener/index-constituents.ts. A miss renders as a raw
    // uppercase slug ("NIFTYDIVOPP50"), which is honest but ugly — this pins
    // the table to the writer so the two cannot silently drift apart.
    const WRITTEN_IDS = [
      // STATIC_INDICES (22)
      "nifty50",
      "banknifty",
      "niftypsubank",
      "niftyprivatebank",
      "niftyauto",
      "niftyit",
      "niftypharma",
      "niftyfmcg",
      "niftymetal",
      "niftyenergy",
      "niftymedia",
      "niftyoilgas",
      "niftyfinservice",
      "niftyhealthcare",
      "niftycommodities",
      "niftyrealty",
      "niftyconsumption",
      "niftyinfra",
      "niftypse",
      "niftycpse",
      "niftymnc",
      "niftydivopp50",
      // MCAP_RANK_SPECS (14)
      "niftynext50",
      "nifty100",
      "nifty200",
      "nifty500",
      "niftylargemid250",
      "niftymidcap50",
      "niftymidcap100",
      "niftymidcap150",
      "niftysmallcap50",
      "niftysmallcap100",
      "niftysmallcap250",
      "niftymidsmall400",
      "niftytotalmarket",
      "niftymicrocap250",
    ];
    assert.equal(WRITTEN_IDS.length, 36);
    const unlabelled = WRITTEN_IDS.filter(
      (id) => indexChipLabel(id) === id.toUpperCase(),
    );
    assert.deepEqual(unlabelled, [], "every written index id needs a label");
  });

  it("never invents addedOn for a stint that predates our observation", () => {
    // `addedOn: null` means "already a member when we started looking".
    // Back-filling it from firstSeen would tell a reader that every
    // constituent joined on our earliest snapshot — a fabricated rebalance.
    const [chip] = buildIndexChips([
      {
        indexId: "nifty50",
        addedOn: null,
        firstSeen: day("2026-01-02"),
        lastSeen: day("2026-08-14"),
        removedOn: null,
      },
    ]);
    assert.equal(chip?.addedOn, null);
    assert.equal(chip?.lastSeen, "2026-08-14T00:00:00.000Z");
    assert.equal(chip?.fallback, false);
  });

  it("drops a CLOSED stint even if the caller forgot the predicate", () => {
    const chips = buildIndexChips([
      {
        indexId: "nifty50",
        lastSeen: day("2026-03-01"),
        removedOn: day("2026-03-02"),
      },
      { indexId: "niftyit", lastSeen: day("2026-08-14"), removedOn: null },
    ]);
    assert.deepEqual(
      chips.map((c) => c.indexId),
      ["niftyit"],
    );
  });

  it("collapses re-entry stints to the newest, keeping its real addedOn", () => {
    const chips = buildIndexChips([
      {
        indexId: "nifty500",
        addedOn: null,
        lastSeen: day("2025-06-30"),
        removedOn: null,
      },
      {
        indexId: "nifty500",
        addedOn: day("2026-04-01"),
        lastSeen: day("2026-08-14"),
        removedOn: null,
      },
    ]);
    assert.equal(chips.length, 1);
    assert.equal(chips[0]?.addedOn, "2026-04-01T00:00:00.000Z");
  });

  it("marks the IndexConstituent path as a fallback", () => {
    const chips = buildIndexChips(
      [{ indexId: "nifty50", addedOn: null, lastSeen: day("2026-08-14") }],
      { fallback: true },
    );
    assert.equal(chips[0]?.fallback, true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.2 — delivery
// ════════════════════════════════════════════════════════════════════════════

describe("14c.2 computeDeliveryTrend", () => {
  it("SKIPS null sessions in the mean and reports the honest n/20", () => {
    // 4 sessions: 2 reported (40, 60), 2 printed `-`. The mean is 50, NOT 25.
    // Treating `-` as 0 halves the figure on exactly the trade-for-trade names
    // where delivery is 100% by construction.
    const t = computeDeliveryTrend([
      { date: day("2026-08-14"), deliveryPct: 40 },
      { date: day("2026-08-13"), deliveryPct: null },
      { date: day("2026-08-12"), deliveryPct: 60 },
      { date: day("2026-08-11"), deliveryPct: null },
    ]);
    assert.equal(t.mean20, 50);
    assert.equal(t.n20, 2, "only the reported sessions count");
    assert.equal(t.window20, 4, "the window is still four sessions wide");
    assert.equal(t.latest?.deliveryPct, 40);
    assert.equal(t.vsMean20, -10);
  });

  it("keeps a REPORTED zero in the mean — 0 is a fact, null is not", () => {
    const t = computeDeliveryTrend([
      { date: day("2026-08-14"), deliveryPct: 0 },
      { date: day("2026-08-13"), deliveryPct: 50 },
    ]);
    assert.equal(t.mean20, 25);
    assert.equal(t.n20, 2);
  });

  it("returns mean20 null (never 0) when NOTHING reported", () => {
    const t = computeDeliveryTrend([
      { date: day("2026-08-14"), deliveryPct: null },
      { date: day("2026-08-13"), deliveryPct: null },
    ]);
    assert.equal(t.mean20, null);
    assert.equal(t.n20, 0);
    assert.equal(t.window20, 2);
    assert.equal(t.vsMean20, null);
    // …and there is no headline session either: see "returns NO latest at all"
    // below. A row with no delivery column is not a delivery reading (B1).
    assert.equal(t.latest, null);
  });

  it("caps the mean window at 20 sessions and the series at 60", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      // i=0 newest. 100 for the newest 20, 0 for everything older, so a window
      // that leaked would move the mean off 100.
      date: new Date(Date.UTC(2026, 7, 14) - i * 86_400_000),
      deliveryPct: i < 20 ? 100 : 0,
    }));
    const t = computeDeliveryTrend(rows);
    assert.equal(t.mean20, 100);
    assert.equal(t.n20, 20);
    assert.equal(t.window20, 20);
    assert.equal(t.series60.length, 60);
  });

  it("emits the mini-series OLDEST-first with nulls preserved as gaps", () => {
    const t = computeDeliveryTrend([
      { date: day("2026-08-12"), deliveryPct: 30 },
      { date: day("2026-08-14"), deliveryPct: 50 },
      { date: day("2026-08-13"), deliveryPct: null },
    ]);
    assert.deepEqual(t.series60, [
      { date: "2026-08-12T00:00:00.000Z", deliveryPct: 30 },
      { date: "2026-08-13T00:00:00.000Z", deliveryPct: null },
      { date: "2026-08-14T00:00:00.000Z", deliveryPct: 50 },
    ]);
  });

  it("surfaces avgPrice / trades / deliveryQty, nulling absent ones", () => {
    const t = computeDeliveryTrend([
      {
        date: day("2026-08-14"),
        deliveryPct: 42.5,
        deliveryQty: 1_234_567_890n,
        avgPrice: 1450.25,
        trades: null,
      },
    ]);
    assert.equal(t.latest?.avgPrice, 1450.25);
    assert.equal(t.latest?.trades, null, "absent trades must NOT become 0");
    assert.equal(t.latest?.deliveryQty, 1_234_567_890);
  });

  it("skips a delivery-less newest row and headlines the newest REPORTED one", () => {
    // B1 — `DailyPrice.source` defaults to "YAHOO" and Yahoo rows carry OHLCV
    // ONLY. Taking `sorted[0]` as the headline renders a blank delivery % on a
    // day nobody reported delivery, dated to that day, with a null vsMean20 —
    // while three real bhavcopy sessions sit right behind it.
    const t = computeDeliveryTrend([
      {
        date: day("2026-08-14"),
        deliveryPct: null,
        close: 100,
        source: "YAHOO",
      },
      { date: day("2026-08-13"), deliveryPct: 58.2, source: "BHAVCOPY" },
      { date: day("2026-08-12"), deliveryPct: 61.4, source: "BHAVCOPY" },
      { date: day("2026-08-11"), deliveryPct: 55.9, source: "BHAVCOPY" },
    ]);
    assert.equal(t.latest?.date, "2026-08-13T00:00:00.000Z");
    assert.equal(t.latest?.deliveryPct, 58.2);
    assert.equal(
      t.latest?.source,
      "BHAVCOPY",
      "the source must come from the row the headline was READ from",
    );
    // Mean and denominator are unchanged by the fix: 3 reported of a 4-session
    // window, mean 58.5, so the headline sits 0.3 below it.
    assert.equal(t.mean20, 58.5);
    assert.equal(t.n20, 3);
    assert.equal(t.window20, 4);
    assert.equal(t.vsMean20, -0.3);
  });

  it("counts a qty-only session as a delivery session", () => {
    // "Carries ANY of the delivery columns" is the contract: a session with a
    // quantity but no percentage IS a delivery print, and skipping past it
    // would date the panel to an older day than the newest thing we hold.
    const t = computeDeliveryTrend([
      { date: day("2026-08-14"), deliveryPct: null, source: "YAHOO" },
      {
        date: day("2026-08-13"),
        deliveryPct: null,
        deliveryQty: 4_200n,
        source: "BHAVCOPY",
      },
      { date: day("2026-08-12"), deliveryPct: 60, source: "BHAVCOPY" },
    ]);
    assert.equal(t.latest?.date, "2026-08-13T00:00:00.000Z");
    assert.equal(t.latest?.deliveryQty, 4_200);
    assert.equal(t.latest?.deliveryPct, null, "absent % must NOT become 0");
    assert.equal(t.latest?.source, "BHAVCOPY");
  });

  it("returns NO latest at all when not one session reported delivery", () => {
    // The documented contract for `latest` is "newest session that carries ANY
    // of the delivery columns, ELSE NULL". A row that has no delivery data is
    // not a delivery headline, however new it is.
    const t = computeDeliveryTrend([
      {
        date: day("2026-08-14"),
        deliveryPct: null,
        close: 100,
        source: "YAHOO",
      },
      {
        date: day("2026-08-13"),
        deliveryPct: null,
        close: 99,
        source: "YAHOO",
      },
    ]);
    assert.equal(t.latest, null);
    assert.equal(t.mean20, null);
    assert.equal(t.n20, 0);
    assert.equal(t.window20, 2);
    assert.equal(t.vsMean20, null);
  });

  it("returns a fully empty trend for no rows", () => {
    assert.deepEqual(computeDeliveryTrend([]), {
      latest: null,
      mean20: null,
      n20: 0,
      window20: 0,
      series60: [],
      vsMean20: null,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.3 — F&O
// ════════════════════════════════════════════════════════════════════════════

describe("14c.3 describeOiBuildup: the quadrant", () => {
  it("maps each quadrant to the right price/OI signs — pinned, not guessed", () => {
    // Mirrors classifyOiBuildup (fo-analytics-logic.ts): OI up ⇒ LONG when
    // price rose, SHORT when it fell; OI down ⇒ SHORT_COVER / LONG_UNWIND.
    // Getting LONG and SHORT_COVER the wrong way round is invisible in an
    // aggregate, which is why it is asserted per-field here.
    const long = describeOiBuildup("LONG");
    assert.equal(long?.priceDirection, "UP");
    assert.equal(long?.oiDirection, "UP");
    assert.equal(long?.bias, "BULLISH");

    const short = describeOiBuildup("SHORT");
    assert.equal(short?.priceDirection, "DOWN");
    assert.equal(short?.oiDirection, "UP");
    assert.equal(short?.bias, "BEARISH");

    const cover = describeOiBuildup("SHORT_COVER");
    assert.equal(cover?.priceDirection, "UP");
    assert.equal(cover?.oiDirection, "DOWN");
    assert.equal(cover?.bias, "BULLISH");

    const unwind = describeOiBuildup("LONG_UNWIND");
    assert.equal(unwind?.priceDirection, "DOWN");
    assert.equal(unwind?.oiDirection, "DOWN");
    assert.equal(unwind?.bias, "BEARISH");
  });

  it("null in ⇒ null out; a flat day is not a quadrant", () => {
    assert.equal(describeOiBuildup(null), null);
    assert.equal(describeOiBuildup(undefined), null);
    assert.equal(describeOiBuildup(""), null);
    assert.equal(describeOiBuildup("SIDEWAYS"), null);
  });
});

describe("14c.3 buildSlbLadder: per-series, never collapsed", () => {
  it("keeps every series rung and derives the total FROM them", () => {
    // MONEY-1201's measurement, in miniature: nine CDSL rows on one day. A
    // last-write-wins/collapsing read reports the largest rung (or the last
    // one) and silently discards the rest.
    const ladder = buildSlbLadder([
      { series: "AUG2026", openQty: 100_000, openValue: 5_000_000 },
      { series: "SEP2026", openQty: 300_000, openValue: 15_000_000 },
      { series: "OCT2026", openQty: 600_000, openValue: 30_000_000 },
    ]);
    assert.equal(ladder.totalOpenQty, 1_000_000);
    assert.equal(ladder.seriesCount, 3);
    assert.deepEqual(
      ladder.series.map((r) => r.series),
      ["OCT2026", "SEP2026", "AUG2026"],
      "largest rung first",
    );
    assert.deepEqual(
      ladder.series.map((r) => r.sharePct),
      [60, 30, 10],
    );
    assert.equal(ladder.totalOpenValue, 50_000_000);
  });

  it("treats a null series as its OWN rung, not a collision", () => {
    const ladder = buildSlbLadder([
      { series: null, openQty: 10 },
      { series: "AUG2026", openQty: 20 },
    ]);
    assert.equal(ladder.seriesCount, 2);
    assert.equal(ladder.totalOpenQty, 30);
    assert.ok(ladder.series.some((r) => r.series === null));
  });

  it("leaves totalOpenValue NULL when no rung priced — never ₹0", () => {
    const ladder = buildSlbLadder([
      { series: "AUG2026", openQty: 10, openValue: null },
      { series: "SEP2026", openQty: 20 },
    ]);
    assert.equal(ladder.totalOpenValue, null);
    assert.equal(ladder.totalOpenQty, 30);
  });

  it("drops rows with an unusable openQty and handles an empty day", () => {
    const ladder = buildSlbLadder([
      { series: "AUG2026", openQty: null },
      { series: "SEP2026", openQty: 5 },
    ]);
    assert.equal(ladder.seriesCount, 1);
    assert.deepEqual(buildSlbLadder([]), {
      totalOpenQty: 0,
      totalOpenValue: null,
      seriesCount: 0,
      series: [],
    });
  });

  it("shares are null (not NaN) when the whole day is zero-quantity", () => {
    const ladder = buildSlbLadder([{ series: "AUG2026", openQty: 0 }]);
    assert.equal(ladder.totalOpenQty, 0);
    assert.equal(ladder.series[0]?.sharePct, null);
  });
});

describe("14c.3 mwplBand / buildMwplSnapshot", () => {
  it("returns NULL — not 'NONE' — when utilisation is unknown", () => {
    // `MwplDaily.utilisationPct` is null on every row today and stays null
    // until a real MWPL source exists. A stock at 97% and a stock with no
    // source must not both render an all-clear.
    assert.equal(mwplBand(null), null);
    assert.equal(mwplBand(undefined), null);
    assert.equal(mwplBand(NaN), null);
  });

  it("bands at NSE's 80% watch and 95% ban thresholds", () => {
    assert.equal(mwplBand(0), "NONE");
    assert.equal(mwplBand(79.99), "NONE");
    assert.equal(mwplBand(80), "WATCH");
    assert.equal(mwplBand(94.99), "WATCH");
    assert.equal(mwplBand(95), "NEAR_BAN");
    assert.equal(mwplBand(99.5), "NEAR_BAN");
  });

  it("snapshots the OI measures while leaving mwpl/utilisation null today", () => {
    const snap = buildMwplSnapshot({
      date: day("2026-08-14"),
      notionalOi: 987_654_321.5,
      futEquivOi: 140_455_762.42,
      mwpl: null,
      utilisationPct: null,
      source: "nse-mwpl",
    });
    assert.equal(snap?.notionalOi, 987_654_321.5);
    assert.equal(snap?.futEquivOi, 140_455_762.42);
    assert.equal(snap?.mwpl, null);
    assert.equal(snap?.utilisationPct, null);
    assert.equal(snap?.band, null, "no denominator ⇒ no band, not NONE");
    assert.equal(snap?.source, "nse-mwpl");
    assert.equal(buildMwplSnapshot(null), null);
  });
});

describe("14c.3 buildDerivativeSummaryView", () => {
  const row = {
    date: day("2026-08-14"),
    futOi: 12_000_000n,
    futOiChange: 2_000_000n,
    futBasisPct: 0.42,
    pcrOi: 1.15,
    pcrVol: 0.88,
    maxPain: 1450,
    maxPainExpiry: day("2026-08-27"),
    rolloverPct: 63.4,
    oiBuildup: "LONG",
    nearFutExpiry: day("2026-08-27"),
    nearFutOi: 9_000_000n,
    nearFutClose: 1462.5,
    callOi: 5_000_000n,
    putOi: 5_750_000n,
    callVol: 800_000n,
    putVol: 704_000n,
    underlyingClose: 1456.4,
    source: "BHAVCOPY_HIST",
  };

  it("coerces EVERY BigInt column so the payload can be JSON.stringify'd", () => {
    // The failure this prevents: `JSON.stringify` THROWS on a BigInt, so a raw
    // Prisma row crashes the server action / Hono response — for F&O names
    // only, at the boundary, not at the query.
    const view = buildDerivativeSummaryView(row);
    assert.ok(view);
    for (const k of [
      "futOi",
      "futOiChange",
      "nearFutOi",
      "callOi",
      "putOi",
      "callVol",
      "putVol",
    ] as const) {
      assert.equal(typeof view[k], "number", `${k} must be a number`);
    }
    assert.doesNotThrow(() => JSON.stringify(view));
    assert.equal(view.futOi, 12_000_000);
  });

  it("derives futOiChangePct against the PREVIOUS day's OI", () => {
    // prev = 12,000,000 − 2,000,000 = 10,000,000 ⇒ +20%.
    assert.equal(buildDerivativeSummaryView(row)?.futOiChangePct, 20);
  });

  it("leaves futOiChangePct null when the previous day is unknown or zero", () => {
    assert.equal(
      buildDerivativeSummaryView({ ...row, futOiChange: null })?.futOiChangePct,
      null,
    );
    assert.equal(
      buildDerivativeSummaryView({ futOi: 5n, futOiChange: 5n })
        ?.futOiChangePct,
      null,
      "prev = 0 must not divide",
    );
  });

  it("expands the buildup quadrant and passes nulls through untouched", () => {
    assert.equal(
      buildDerivativeSummaryView(row)?.buildup?.label,
      "Long buildup",
    );
    assert.equal(
      buildDerivativeSummaryView({ ...row, oiBuildup: null })?.buildup,
      null,
    );
    const sparse = buildDerivativeSummaryView({ date: day("2026-08-14") });
    assert.equal(sparse?.pcrOi, null);
    assert.equal(sparse?.maxPain, null);
    assert.equal(sparse?.futBasisPct, null);
    assert.equal(buildDerivativeSummaryView(null), null);
  });

  it("gates rollover % on expiry week, using the summary's OWN trading day", () => {
    assert.equal(buildDerivativeSummaryView(row)?.isExpiryWeek, false); // 13 days out
    const near = buildDerivativeSummaryView({
      ...row,
      date: day("2026-08-22"),
    });
    assert.equal(near?.isExpiryWeek, true); // 5 days out
    assert.equal(near?.rolloverPct, 63.4);
  });

  it("isExpiryWeek is inclusive at both ends and false once past expiry", () => {
    assert.equal(
      isExpiryWeek("2026-08-27T00:00:00Z", "2026-08-27T00:00:00Z"),
      true,
    );
    assert.equal(
      isExpiryWeek("2026-08-20T00:00:00Z", "2026-08-27T00:00:00Z"),
      true,
    );
    assert.equal(
      isExpiryWeek("2026-08-19T00:00:00Z", "2026-08-27T00:00:00Z"),
      false,
    );
    assert.equal(
      isExpiryWeek("2026-08-28T00:00:00Z", "2026-08-27T00:00:00Z"),
      false,
    );
    assert.equal(isExpiryWeek(null, "2026-08-27T00:00:00Z"), false);
    assert.equal(isExpiryWeek("2026-08-27T00:00:00Z", null), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY-1205 — the stock-header flag defects
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1205 · POINT events are dated one-offs, never standing state", () => {
  it("stamps `shape` from the ONE policy table, not from a local guess", () => {
    // The table moved to `stock-flags.ts` beside the union it is checked
    // against. Three layers were each deciding shape independently and two were
    // wrong; this asserts the badge builder now READS the table rather than
    // re-deriving it.
    const badges = buildStockFlagBadges([
      {
        kind: "BAND_CHANGE",
        value: '{"from":"5","to":"No Band"}',
        date: day("2026-08-17"),
      },
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
      {
        kind: "SERIES_CHANGE",
        value: '{"from":"EQ","to":"BE"}',
        date: day("2026-08-17"),
      },
    ]);
    for (const b of badges) {
      assert.equal(
        b.shape,
        FLAG_KIND_POLICY[b.kind].shape,
        `${b.kind} shape must come from FLAG_KIND_POLICY`,
      );
    }
    assert.equal(badges.find((b) => b.kind === "BAND_CHANGE")?.shape, "POINT");
    assert.equal(
      badges.find((b) => b.kind === "SERIES_CHANGE")?.shape,
      "POINT",
    );
    assert.equal(badges.find((b) => b.kind === "PRICE_BAND")?.shape, "STATE");
  });

  it("an OLD point event is not current — HDFCBANK's 2024 band change in a 2026 header", () => {
    // MEASURED on prod: HDFCBANK's newest BAND_CHANGE row is 2024-05-21 and the
    // header rendered it as a live flag that had since "(ended)". A point event
    // is never in force and can never end.
    const badges = buildStockFlagBadges([
      {
        kind: "BAND_CHANGE",
        value: '{"from":"5","to":"No Band"}',
        date: day("2024-05-21"),
      },
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
    ]);
    const change = badges.find((b) => b.kind === "BAND_CHANGE");
    assert.equal(change?.shape, "POINT");
    assert.equal(change?.isCurrent, false, "two years old is not recent");
    assert.equal(
      isHeadlineWorthy(change!),
      false,
      "and it must not reach the header strip",
    );
  });

  it("a RECENT point event is current, and the window is the boundary", () => {
    const at = (offsetDays: number): boolean => {
      const d = new Date(Date.UTC(2026, 7, 17) - offsetDays * 86_400_000);
      const badges = buildStockFlagBadges([
        {
          kind: "BAND_CHANGE",
          value: '{"from":"5","to":"10"}',
          date: d,
        },
        { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
      ]);
      return badges.find((b) => b.kind === "BAND_CHANGE")?.isCurrent === true;
    };
    assert.equal(at(0), true, "same day");
    assert.equal(at(POINT_EVENT_RECENCY_DAYS), true, "inclusive edge");
    assert.equal(at(POINT_EVENT_RECENCY_DAYS + 1), false, "one day past");
  });

  it("ages a point event against the MARKET's latest day, not its own kind", () => {
    // A point family can be silent for years — SERIES_CHANGE's newest row
    // platform-wide is 2023-08-22 — so judging recency against the kind's own
    // latest publication would call a three-year-old migration "today's news".
    const badges = buildStockFlagBadges(
      [
        {
          kind: "SERIES_CHANGE",
          value: '{"from":"EQ","to":"BE"}',
          date: day("2023-08-22"),
        },
      ],
      {
        referenceDayByKind: {
          SERIES_CHANGE: "2023-08-22",
          PRICE_BAND: "2026-08-17",
        },
      },
    );
    assert.equal(badges[0]?.isCurrent, false);
  });
});

describe("MONEY-1205 · the band label appends % to a WORD", () => {
  it("renders `No Band` as words on BOTH sides of a band change", () => {
    // `Band ${from}% → ${to}%` printed "Band 5% → No Band%". The guard existed
    // one function down and was wired into PRICE_BAND only. 208 of 3,489 stocks
    // carry `No Band` on any given session.
    const [badge] = buildStockFlagBadges([
      {
        kind: "BAND_CHANGE",
        value: '{"from":"5","to":"No Band"}',
        date: day("2026-08-17"),
      },
    ]);
    assert.equal(badge?.label, "Band 5% → no band");
    assert.ok(!badge?.label.includes("Band%"), "no `%` may follow a word");
  });

  it("still adds % to a numeric band on both sides", () => {
    const [badge] = buildStockFlagBadges([
      {
        kind: "BAND_CHANGE",
        value: '{"from":"10","to":"20"}',
        date: day("2026-08-17"),
      },
    ]);
    assert.equal(badge?.label, "Band 10% → 20%");
  });
});

describe("MONEY-1205 · formatStockFlagValue — one decoder, four products", () => {
  it("decodes every kind, and SURVEILLANCE stays BYTE-IDENTICAL", () => {
    const cases: Array<{
      kind: string;
      value: string;
      date?: Date;
      expect: string;
    }> = [
      // The verbatim rule: a better decode table must be able to improve rows
      // written years ago, which requires the stored bytes to survive intact.
      {
        kind: "SURVEILLANCE",
        value: "GSM STAGE - I",
        expect: "GSM STAGE - I",
      },
      {
        kind: "SURVEILLANCE",
        value: "Long Term Additional Surveillance Measure (LTASM) - Stage I",
        expect: "Long Term Additional Surveillance Measure (LTASM) - Stage I",
      },
      { kind: "FO_BAN", value: "BAN", expect: "F&O ban" },
      {
        kind: "BAND_CHANGE",
        value: '{"from":"5","to":"No Band"}',
        date: day("2024-05-21"),
        expect: "Price band 5% → no band on 21 May 2024",
      },
      {
        kind: "BAND_CHANGE",
        value: '{"from":"5","to":"No Band"}',
        expect: "Price band 5% → no band",
      },
      {
        kind: "SERIES_CHANGE",
        value: '{"from":"EQ","to":"BE"}',
        date: day("2023-08-22"),
        expect: "Series EQ → BE on 22 Aug 2023",
      },
      { kind: "PRICE_BAND", value: '{"band":"5"}', expect: "5% band" },
      { kind: "PRICE_BAND", value: '{"band":"20"}', expect: "20% band" },
      {
        kind: "PRICE_BAND",
        value: '{"band":"No Band"}',
        expect: "no price band (F&O)",
      },
      {
        kind: "SHORT_SELLING",
        value: '{"qty":106000}',
        expect: "1,06,000 shares sold short",
      },
      {
        kind: "SHORT_SELLING",
        value: '{"qty":106}',
        expect: "106 shares sold short",
      },
      {
        kind: "WK52_HIGH_LOW",
        value:
          '{"high":1020.5,"highDate":"2025-10-23","low":722,"lowDate":"2026-08-12"}',
        expect: "High ₹1,020.50 (23 Oct 2025) · Low ₹722.00 (12 Aug 2026)",
      },
    ];
    for (const c of cases) {
      assert.equal(
        formatStockFlagValue(c.kind, c.value, { date: c.date ?? null }),
        c.expect,
        `${c.kind} / ${c.value}`,
      );
    }
  });

  it("never leaks JSON to a user for a decodable kind", () => {
    for (const kind of Object.keys(FLAG_KIND_POLICY)) {
      const sample: Record<string, string> = {
        SURVEILLANCE: "GSM STAGE - I",
        FO_BAN: "BAN",
        BAND_CHANGE: '{"from":"5","to":"10"}',
        SERIES_CHANGE: '{"from":"EQ","to":"BE"}',
        PRICE_BAND: '{"band":"5"}',
        SHORT_SELLING: '{"qty":106}',
        WK52_HIGH_LOW: '{"high":10,"highDate":null,"low":2,"lowDate":null}',
      };
      const out = formatStockFlagValue(kind, sample[kind] ?? "");
      assert.ok(
        !out.includes("{") && !out.includes('"'),
        `${kind} still ships JSON: ${out}`,
      );
      assert.notEqual(out, "", `${kind} decoded to empty`);
    }
  });

  it("never puts a MALFORMED value in front of a user for a known kind", () => {
    // Switching on `kind` (not on the parse result) is what makes this hold. A
    // known kind whose JSON drifted still gets its kind's sentence; falling
    // through to `raw` would ship the broken blob itself, which is the exact
    // failure this decoder exists to end. `raw` stays on the badge for debugging.
    assert.equal(
      formatStockFlagValue("PRICE_BAND", "not json at all"),
      "Price band",
    );
    assert.equal(
      formatStockFlagValue("BAND_CHANGE", "not json at all", {
        date: day("2026-08-04"),
      }),
      "Price band changed on 4 Aug 2026",
    );
    assert.equal(
      formatStockFlagValue("SHORT_SELLING", "{oops"),
      "Short selling reported",
    );
    assert.equal(
      formatStockFlagValue("WK52_HIGH_LOW", '{"high":null,"low":null}'),
      "52-week range not reported",
    );
    // An UNKNOWN kind is the one case where the stored text IS the answer.
    assert.equal(formatStockFlagValue("NEW_NSE_THING", "WHATEVER"), "WHATEVER");
  });

  it("formats dates from UTC parts, so a negative-offset server cannot shift the day", () => {
    // Every date here is UTC midnight of a trading day; a locale formatter run
    // in UTC-5 would print the day before.
    assert.equal(
      formatStockFlagValue("SERIES_CHANGE", '{"from":"EQ","to":"BE"}', {
        date: "2023-08-22T00:00:00.000Z",
      }),
      "Series EQ → BE on 22 Aug 2023",
    );
  });
});

describe("MONEY-1205 · isHeadlineWorthy — a flag is an exception by definition", () => {
  const badgesFor = (
    rows: Parameters<typeof buildStockFlagBadges>[0],
    opts?: Parameters<typeof buildStockFlagBadges>[1],
  ) => buildStockFlagBadges(rows, opts);

  it("a plain 20%-band + 52-week-only stock yields ZERO headline badges", () => {
    // This is most of the market: 2,429 of 3,489 stocks sit at the 20% default
    // and all 3,325 with a 52-week row publish one every session. Before this,
    // 100% of stock pages rendered a "flag" strip.
    const badges = badgesFor([
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
      {
        kind: "WK52_HIGH_LOW",
        value:
          '{"high":1020.5,"highDate":"2025-10-23","low":722,"lowDate":"2026-08-12"}',
        date: day("2026-08-17"),
      },
    ]);
    assert.equal(badges.length, 2, "both are still BUILT — nothing is lost");
    assert.deepEqual(selectHeadlineStockFlagBadges(badges), []);
  });

  it("keeps SURVEILLANCE always and a NARROWED band, drops the 20% default", () => {
    const badges = badgesFor([
      { kind: "SURVEILLANCE", value: "GSM STAGE - I", date: day("2026-08-17") },
      { kind: "PRICE_BAND", value: '{"band":"5"}', date: day("2026-08-17") },
    ]);
    assert.deepEqual(
      selectHeadlineStockFlagBadges(badges).map((b) => b.kind),
      ["SURVEILLANCE", "PRICE_BAND"],
    );

    const wide = badgesFor([
      { kind: "PRICE_BAND", value: '{"band":"20"}', date: day("2026-08-17") },
    ]);
    assert.deepEqual(selectHeadlineStockFlagBadges(wide), []);

    // `No Band` is non-numeric — an F&O name with no circuit limit at all, not
    // a restraint. `Number("No Band")` is NaN, which is the trap.
    const noBand = badgesFor([
      {
        kind: "PRICE_BAND",
        value: '{"band":"No Band"}',
        date: day("2026-08-17"),
      },
    ]);
    assert.deepEqual(selectHeadlineStockFlagBadges(noBand), []);
  });

  it("drops SHORT_SELLING and WK52 even when they are the newest thing we hold", () => {
    const badges = badgesFor([
      { kind: "SHORT_SELLING", value: '{"qty":106}', date: day("2026-08-17") },
      {
        kind: "WK52_HIGH_LOW",
        value: '{"high":10,"low":2}',
        date: day("2026-08-17"),
      },
    ]);
    assert.equal(badges.length, 2);
    assert.deepEqual(selectHeadlineStockFlagBadges(badges), []);
  });

  it("keeps an F&O ban only while it is in force", () => {
    const live = badgesFor(
      [{ kind: "FO_BAN", value: "BAN", date: day("2026-08-17") }],
      { referenceDayByKind: { FO_BAN: "2026-08-17" } },
    );
    assert.equal(isHeadlineWorthy(live[0]!), true);

    const lifted = badgesFor(
      [{ kind: "FO_BAN", value: "BAN", date: day("2026-08-10") }],
      { referenceDayByKind: { FO_BAN: "2026-08-17" } },
    );
    assert.equal(isHeadlineWorthy(lifted[0]!), false);
  });

  it("shows an UNKNOWN kind rather than hiding it", () => {
    // A new NSE family must surface as an unstyled badge, not vanish — the same
    // rule surveillance codes follow. The opposite default makes the next
    // family invisible until somebody notices.
    const badges = badgesFor([
      { kind: "NEW_NSE_THING", value: "SOMETHING", date: day("2026-08-17") },
    ]);
    assert.equal(badges[0]?.shape, null);
    assert.equal(isHeadlineWorthy(badges[0]!), true);
  });
});
