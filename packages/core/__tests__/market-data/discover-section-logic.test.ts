/**
 * Pure read-side helpers for the discover data-engine surfaces — MONEY-1204
 * (P14 / 14d.2 · 14d.3 · 14d.5 · 14d.6).
 *
 * Behavioural, not shadow. Every case here fails if the corresponding rule in
 * `discover-section-logic.ts` is deleted, and each one is written against the
 * WRONG implementation it exists to reject:
 *
 *   1. a 20-session cumulative over a CALENDAR window silently treats a missing
 *      trading day as a flat session and drags the total toward zero;
 *   2. `issueEnd >= new Date()` marks an IPO closed at 05:30 IST on its own
 *      final bidding day, so "currently bidding" is empty for the whole day
 *      anyone would look;
 *   3. a SUBSTRING search for a ticker in a circular subject matches "BEL"
 *      inside "below" and attaches unrelated price-band notices to Bharat
 *      Electronics every week;
 *   4. reading `MarketPositioning` without a `metric` filter mixes the
 *      participant feed with `nse-fii-stats`, and summing totals alongside
 *      their per-underlying breakdowns double-counts every index — neither
 *      raises anything, both produce a plausible number;
 *   5. `weightBps` is percent×10⁴ despite its name, so the arithmetic the name
 *      asks for inflates every index weight a hundredfold;
 *   6. `IndexClose.pe` is null when NSE printed `-`, and `?? 0` turns a
 *      volatility index into the cheapest thing on the exchange.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CIRCULAR_MATCH_DISCLAIMER,
  FII_STATS_METRIC,
  MACRO_STRIP_SERIES_IDS,
  buildCircularFeed,
  buildIndexConstituents,
  buildIndexDetail,
  buildIndexMembership,
  buildInstitutionalFlowSection,
  buildIpoDashboardCard,
  buildMacroStrip,
  buildPositioningSection,
  bucketIpos,
  checkPositioningGrain,
  circularKey,
  classifyIpoPhase,
  computeMacroYoy,
  countCircularDepartments,
  istDayKey,
  matchCircularsForSymbol,
  normalizeIndexSlug,
  resolveIndexRoute,
  selectPositioningRows,
  sumPositioningField,
  tokenizeCircularText,
  type IndexCloseInput,
  type InstitutionalFlowInput,
  type NseCircularInput,
  type PositioningRowInput,
  type UpcomingIpoInput,
} from "../../src/market-data/discover-section-logic";

/** UTC midnight of an IST trading day — how every one of these tables stores a date. */
const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

// ════════════════════════════════════════════════════════════════════
// 14d.2 (a) — FII/DII cash flows
// ════════════════════════════════════════════════════════════════════

describe("14d.2 buildInstitutionalFlowSection", () => {
  /** 21 consecutive weekday-ish sessions of FII net flow, `net` per day. */
  const seriesOf = (
    days: ReadonlyArray<{ d: string; net: number }>,
  ): InstitutionalFlowInput[] =>
    days.map(({ d, net }) => ({
      date: day(d),
      category: "FII",
      segment: "CASH",
      buyValue: 10_000,
      sellValue: 10_000 - net,
      netValue: net,
    }));

  it("counts the window in SESSIONS PRESENT — a missing day is not a zero", () => {
    // 21 dated sessions with 2026-08-10 ABSENT from the feed. A calendar-window
    // implementation would span 2026-07-23..2026-08-12 and fold a 0 in for the
    // hole; the session-window one sums the 20 rows that exist.
    const dates = [
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-03",
      "2026-08-04",
      // 2026-08-10 is deliberately missing from the middle of the run
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ];
    // Every session is +100 so the arithmetic is unmistakable: 20 sessions of
    // +100 is 2000. A fabricated zero day would make it 1900.
    const rows = seriesOf(dates.map((d) => ({ d, net: 100 })));
    const out = buildInstitutionalFlowSection(rows, { windowSessions: 20 });

    const fii = out.series.find((s) => s.category === "FII");
    assert.ok(fii, "FII series must be present");
    assert.equal(fii.sessionsCounted, 20);
    assert.equal(fii.cumulativeNetCr, 2000, "a hole must not contribute a 0");
    assert.equal(fii.windowComplete, true);
    assert.equal(fii.spark.length, 20);
    assert.ok(
      !fii.points.some((p) => p.date === "2026-08-10"),
      "the missing session must be ABSENT, not present with a zero",
    );
    // The window is the 20 most recent PRESENT sessions, so the oldest row
    // (2026-07-22) drops out — not some 21st calendar day.
    assert.equal(fii.points[0]?.date, "2026-07-23");
    assert.equal(fii.latest?.date, "2026-08-20");
  });

  it("reports a SHORT window instead of implying a full one", () => {
    const rows = seriesOf([
      { d: "2026-08-18", net: 50 },
      { d: "2026-08-19", net: -20 },
      { d: "2026-08-20", net: 10 },
    ]);
    const fii = buildInstitutionalFlowSection(rows, {
      windowSessions: 20,
    }).series[0];
    assert.ok(fii);
    assert.equal(fii.sessionsCounted, 3);
    assert.equal(fii.windowSessions, 20);
    assert.equal(
      fii.windowComplete,
      false,
      "3 sessions is not a 20-day figure",
    );
    assert.equal(fii.cumulativeNetCr, 40);
  });

  it("keeps a published ZERO net distinct from a missing one", () => {
    const rows: InstitutionalFlowInput[] = [
      {
        date: day("2026-08-19"),
        category: "FII",
        segment: "CASH",
        buyValue: 5000,
        sellValue: 5000,
        netValue: 0,
      },
      {
        date: day("2026-08-20"),
        category: "FII",
        segment: "CASH",
        buyValue: null,
        sellValue: null,
        netValue: null,
      },
    ];
    const fii = buildInstitutionalFlowSection(rows).series[0];
    assert.ok(fii);
    // The zero counted; the null did not. Cumulative is 0 — a real reading —
    // and NOT null, because one session did report.
    assert.equal(fii.cumulativeNetCr, 0);
    assert.equal(fii.sessionsCounted, 1);
    assert.equal(fii.latest?.netCr, null, "a null net must not become 0");
  });

  it("carries the ₹ CRORE unit and does not rescale the feed's own numbers", () => {
    const rows = seriesOf([{ d: "2026-08-20", net: 1234.56 }]);
    const out = buildInstitutionalFlowSection(rows);
    assert.equal(out.unit, "INR_CRORE");
    assert.equal(out.series[0]?.latest?.netCr, 1234.56);
  });

  it("splits FII/DII and CASH/FNO into separate series, FII first", () => {
    const rows: InstitutionalFlowInput[] = [
      {
        date: day("2026-08-20"),
        category: "DII",
        segment: "CASH",
        netValue: 5,
      },
      { date: day("2026-08-20"), category: "FII", segment: "FNO", netValue: 7 },
      {
        date: day("2026-08-20"),
        category: "FII",
        segment: "CASH",
        netValue: 3,
      },
    ];
    const out = buildInstitutionalFlowSection(rows);
    assert.deepEqual(
      out.series.map((s) => `${s.category}|${s.segment}`),
      ["FII|CASH", "FII|FNO", "DII|CASH"],
    );
  });

  it("collapses a duplicated (date, category, segment) so a re-run cannot double a cumulative", () => {
    const rows = [
      ...seriesOf([{ d: "2026-08-20", net: 100 }]),
      ...seriesOf([{ d: "2026-08-20", net: 100 }]),
    ];
    const fii = buildInstitutionalFlowSection(rows).series[0];
    assert.equal(fii?.sessionsCounted, 1);
    assert.equal(fii?.cumulativeNetCr, 100);
  });

  it("is empty, not zeroed, when the table holds nothing", () => {
    const out = buildInstitutionalFlowSection([]);
    assert.deepEqual(out.series, []);
    assert.equal(out.asOf, null);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14d.2 (b) — participant positioning grain
// ════════════════════════════════════════════════════════════════════

describe("14d.2 positioning metric + bucket grain", () => {
  const participantRow = (
    over: Partial<PositioningRowInput> = {},
  ): PositioningRowInput => ({
    date: day("2026-08-13"),
    participant: "FII",
    bucket: "FUT_IDX",
    metric: "OI",
    longQty: 100,
    shortQty: 40,
    netQty: 60,
    ...over,
  });

  const fiiStatsRow = (
    over: Partial<PositioningRowInput> = {},
  ): PositioningRowInput => ({
    date: day("2026-08-13"),
    participant: "FII",
    bucket: "IDX_FUT",
    metric: FII_STATS_METRIC,
    longQty: 100,
    shortQty: 40,
    netQty: 60,
    longValue: 900,
    shortValue: 400,
    netValue: 500,
    ...over,
  });

  it("flags a set that mixes the participant feed with nse-fii-stats", () => {
    const grain = checkPositioningGrain([participantRow(), fiiStatsRow()]);
    assert.deepEqual(grain.metrics, ["FII_STATS", "OI"]);
    assert.equal(grain.mixedMetrics, true);
    assert.equal(grain.ok, false);
  });

  it("REFUSES to sum a mixed-metric set rather than returning a plausible number", () => {
    const sum = sumPositioningField(
      [participantRow(), fiiStatsRow()],
      "netQty",
    );
    assert.equal(sum.blocked, "MIXED_METRIC");
    assert.equal(sum.value, null, "a mixed sum must be null, never a number");
    assert.equal(sum.rowsUsed, 0);
  });

  it("flags totals sitting alongside their per-underlying breakdowns", () => {
    // `IDX_OPT` is the total; `IDX_OPT:NIFTY` / `IDX_OPT:BANKNIFTY` are its
    // children. Summing all three counts every index twice.
    const rows = [
      fiiStatsRow({ bucket: "IDX_OPT", netQty: 100 }),
      fiiStatsRow({ bucket: "IDX_OPT:NIFTY", netQty: 70 }),
      fiiStatsRow({ bucket: "IDX_OPT:BANKNIFTY", netQty: 30 }),
    ];
    const grain = checkPositioningGrain(rows);
    assert.equal(grain.mixedMetrics, false, "one metric — the hazard is grain");
    assert.equal(grain.mixedGrain, true);
    assert.equal(grain.ok, false);

    const sum = sumPositioningField(rows, "netQty");
    assert.equal(sum.blocked, "MIXED_GRAIN");
    assert.equal(
      sum.value,
      null,
      "200 would be the double-counted answer and must not be returned",
    );
  });

  it("sums cleanly once the set is one metric at one grain", () => {
    const rows = [
      fiiStatsRow({ bucket: "IDX_FUT", netQty: 60 }),
      fiiStatsRow({ bucket: "IDX_OPT", netQty: 40 }),
      fiiStatsRow({ bucket: "STK_FUT", netQty: null }),
    ];
    const sum = sumPositioningField(rows, "netQty");
    assert.equal(sum.blocked, null);
    assert.equal(sum.value, 100);
    assert.equal(sum.rowsUsed, 2);
    assert.equal(sum.rowsSkipped, 1, "a null leg is skipped, not counted as 0");
  });

  it("selectPositioningRows drops every row of the other metric", () => {
    const rows = [
      participantRow(),
      fiiStatsRow(),
      participantRow({ metric: "VOLUME" }),
    ];
    const oi = selectPositioningRows(rows, { metric: "OI" });
    assert.equal(oi.length, 1);
    assert.equal(oi[0]?.metric, "OI");
    assert.equal(checkPositioningGrain(oi).ok, true);
  });

  it("builds legs for one participant with a day-on-day net change", () => {
    const rows = [
      participantRow({
        date: day("2026-08-12"),
        bucket: "FUT_IDX",
        netQty: 40,
      }),
      participantRow({
        date: day("2026-08-13"),
        bucket: "FUT_IDX",
        netQty: 60,
      }),
      participantRow({
        date: day("2026-08-13"),
        bucket: "OPT_IDX_PUT",
        longQty: 10,
        shortQty: 30,
        netQty: -20,
      }),
      // A different participant must not leak into FII's legs.
      participantRow({
        date: day("2026-08-13"),
        participant: "CLIENT",
        netQty: 999,
      }),
    ];
    const out = buildPositioningSection(rows, {
      participant: "FII",
      metric: "OI",
    });
    assert.equal(out.date, "2026-08-13");
    assert.equal(out.previousDate, "2026-08-12");
    assert.deepEqual(
      out.legs.map((l) => l.bucket),
      ["FUT_IDX", "OPT_IDX_PUT"],
    );
    const fut = out.legs[0];
    assert.equal(fut?.netQty, 60);
    assert.equal(fut?.netChange, 20, "60 today vs 40 on the previous SESSION");
    assert.equal(fut?.label, "Index futures");
    assert.equal(fut?.longSharePct, 71.43);
  });

  it("measures the change against the previous SESSION PRESENT, not 'yesterday'", () => {
    // Friday → Monday. A calendar-day lookback finds nothing over the weekend
    // and would report no change at all on every Monday of the year.
    const rows = [
      participantRow({ date: day("2026-08-14"), netQty: 40 }),
      participantRow({ date: day("2026-08-17"), netQty: 55 }),
    ];
    const out = buildPositioningSection(rows, {
      participant: "FII",
      metric: "OI",
    });
    assert.equal(out.previousDate, "2026-08-14");
    assert.equal(out.legs[0]?.netChange, 15);
  });

  it("renders NO legs when handed a mixed-grain set — the widget's own backstop", () => {
    const rows = [
      participantRow(),
      // Same participant, same day, the OTHER feed. A query missing its
      // `metric` filter returns exactly this.
      fiiStatsRow(),
    ];
    const out = buildPositioningSection(rows, {
      participant: "FII",
      // Deliberately no metric restriction at the select — the caller passes a
      // metric, so the mix can only arise if the metric strings themselves
      // collide. Prove the ok-flag drives the refusal.
      metric: "OI",
    });
    // Selecting on OI removed the FII_STATS row, so this one IS renderable.
    assert.equal(out.grain.ok, true);
    assert.equal(out.legs.length, 1);

    // And when the grain hazard survives the select (totals + breakdowns of the
    // SAME metric), the section refuses.
    const mixed = buildPositioningSection(
      [
        fiiStatsRow({ bucket: "IDX_OPT" }),
        fiiStatsRow({ bucket: "IDX_OPT:NIFTY" }),
      ],
      { participant: "FII", metric: FII_STATS_METRIC },
    );
    assert.equal(mixed.grain.mixedGrain, true);
    assert.deepEqual(
      mixed.legs,
      [],
      "a refused section renders nothing, not a chart",
    );
  });

  it("has no data at all for a participant that did not trade that day", () => {
    const out = buildPositioningSection([participantRow()], {
      participant: "PRO",
      metric: "OI",
    });
    assert.equal(out.date, null);
    assert.deepEqual(out.legs, []);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14d.2 (c) — macro strip
// ════════════════════════════════════════════════════════════════════

describe("14d.2 buildMacroStrip", () => {
  it("gives every tile its OWN period — no shared 'as of'", () => {
    const strip = buildMacroStrip([
      {
        seriesId: "RBI_REPO_RATE",
        period: day("2026-08-07"),
        value: 5.5,
        unit: "PERCENT",
        frequency: "WEEKLY",
        label: "Repo Rate",
        releasedOn: day("2026-08-08"),
      },
      {
        seriesId: "RBI_FOREX_RESERVES_TOTAL_USD_MN",
        period: day("2026-08-01"),
        value: 702_345,
        unit: "USD_MILLION",
        frequency: "WEEKLY",
        label: "Foreign Exchange Reserves",
      },
    ]);
    const repo = strip.items.find((i) => i.seriesId === "RBI_REPO_RATE");
    const fx = strip.items.find(
      (i) => i.seriesId === "RBI_FOREX_RESERVES_TOTAL_USD_MN",
    );
    assert.equal(repo?.period, "2026-08-07");
    assert.equal(fx?.period, "2026-08-01");
    assert.notEqual(
      repo?.period,
      fx?.period,
      "vintages differ and must show it",
    );
    assert.equal(repo?.value, 5.5);
    assert.equal(repo?.unit, "PERCENT");
    assert.equal(repo?.releasedOn, "2026-08-08T00:00:00.000Z");
    // The section-level newest is for the envelope only.
    assert.equal(strip.newestPeriod, "2026-08-07");
  });

  it("renders a missing series as unavailable, not as 0", () => {
    const strip = buildMacroStrip([]);
    assert.equal(strip.items.length, MACRO_STRIP_SERIES_IDS.length);
    for (const item of strip.items) {
      assert.equal(item.value, null, `${item.seriesId} must be null, not 0`);
      assert.ok(item.unavailable !== null);
      assert.equal(item.period, null);
    }
  });

  it("computes CPI YoY from index LEVELS twelve months apart", () => {
    const yoy = computeMacroYoy([
      {
        seriesId: "MOSPI_CPI_COMBINED",
        period: day("2025-07-01"),
        value: 200,
        label: "Consumer Price Index (2012=100)",
      },
      {
        seriesId: "MOSPI_CPI_COMBINED",
        period: day("2026-07-01"),
        value: 210,
        label: "Consumer Price Index (2012=100)",
      },
    ]);
    assert.equal(yoy.yoyPct, 5);
    assert.equal(yoy.basePeriod, "2025-07-01");
    assert.equal(yoy.latestPeriod, "2026-07-01");
    assert.equal(yoy.unavailable, null);
  });

  it("refuses a YoY when there is no observation exactly twelve months back", () => {
    // 11 months apart. Computing it anyway would label an 11-month change
    // "year-on-year" and be wrong by roughly one month of inflation.
    const yoy = computeMacroYoy([
      { seriesId: "X", period: day("2025-08-01"), value: 200, label: "L" },
      { seriesId: "X", period: day("2026-07-01"), value: 210, label: "L" },
    ]);
    assert.equal(yoy.yoyPct, null);
    assert.equal(yoy.unavailable, "NO_BASE");
  });

  it("refuses a YoY across a REBASE — two scales are not a ratio", () => {
    const yoy = computeMacroYoy([
      {
        seriesId: "OEA_WPI_ALL_COMMODITIES",
        period: day("2025-07-01"),
        value: 155,
        label: "Wholesale Price Index (2011-12=100)",
      },
      {
        seriesId: "OEA_WPI_ALL_COMMODITIES",
        period: day("2026-07-01"),
        value: 108,
        label: "Wholesale Price Index (2022-23=100)",
      },
    ]);
    assert.equal(yoy.rebased, true);
    assert.equal(yoy.yoyPct, null, "-30% would be the rebase, not deflation");
    assert.equal(yoy.unavailable, "REBASE");
  });

  it("labels a YoY tile as PERCENT, not the underlying INDEX unit", () => {
    const strip = buildMacroStrip([
      {
        seriesId: "MOSPI_CPI_COMBINED",
        period: day("2025-07-01"),
        value: 200,
        unit: "INDEX",
        label: "CPI",
      },
      {
        seriesId: "MOSPI_CPI_COMBINED",
        period: day("2026-07-01"),
        value: 212,
        unit: "INDEX",
        label: "CPI",
      },
    ]);
    const cpi = strip.items.find((i) => i.seriesId === "MOSPI_CPI_COMBINED");
    assert.equal(cpi?.kind, "YOY");
    assert.equal(cpi?.value, 6);
    assert.equal(cpi?.unit, "PERCENT");
  });
});

// ════════════════════════════════════════════════════════════════════
// 14d.3 — IPO windows, on the IST calendar day
// ════════════════════════════════════════════════════════════════════

describe("14d.3 IPO IST day boundary", () => {
  /** An issue open 14–16 Aug 2026 IST, stored as UTC midnights. */
  const issue: UpcomingIpoInput = {
    symbol: "NEWCO",
    companyName: "Newco Industries Limited",
    issueStart: day("2026-08-14"),
    issueEnd: day("2026-08-16"),
    priceMin: 100,
    priceMax: 105,
    status: "OPEN",
  };

  it("is CURRENT through the whole of its final IST day (the ~5.5h bug)", () => {
    // 11:30 IST on the closing day. `issueEnd >= now` is FALSE here — the
    // stored instant (2026-08-16T00:00Z) is already 6h in the past — so an
    // instant comparison drops the issue at 05:30 IST and it is missing for
    // every waking hour of the day bids actually close.
    const midday = new Date("2026-08-16T06:00:00.000Z");
    assert.equal(istDayKey(midday), "2026-08-16");
    assert.equal(classifyIpoPhase(issue, istDayKey(midday)!), "CURRENT");

    // And right up to the last IST minute of that day.
    const lastMinute = new Date("2026-08-16T18:29:00.000Z"); // 23:59 IST
    assert.equal(istDayKey(lastMinute), "2026-08-16");
    assert.equal(classifyIpoPhase(issue, istDayKey(lastMinute)!), "CURRENT");
  });

  it("stops being CURRENT the moment IST rolls to the next day", () => {
    // 00:01 IST on the 17th is still 2026-08-16 in UTC. A UTC-day comparison
    // keeps advertising a closed issue as open for another 5.5 hours.
    const justAfter = new Date("2026-08-16T18:31:00.000Z");
    assert.equal(justAfter.toISOString().slice(0, 10), "2026-08-16");
    assert.equal(istDayKey(justAfter), "2026-08-17");
    assert.equal(classifyIpoPhase(issue, istDayKey(justAfter)!), "RECENT");
  });

  it("becomes CURRENT the moment IST reaches its opening day", () => {
    // 00:01 IST on the 14th; UTC still says the 13th.
    const justOpened = new Date("2026-08-13T18:31:00.000Z");
    assert.equal(istDayKey(justOpened), "2026-08-14");
    assert.equal(classifyIpoPhase(issue, istDayKey(justOpened)!), "CURRENT");

    // 23:59 IST the evening before is still UPCOMING.
    const nightBefore = new Date("2026-08-13T18:29:00.000Z");
    assert.equal(istDayKey(nightBefore), "2026-08-13");
    assert.equal(classifyIpoPhase(issue, istDayKey(nightBefore)!), "UPCOMING");
  });

  it("buckets into the three tabs and marks the closing day", () => {
    const rows: UpcomingIpoInput[] = [
      issue,
      {
        symbol: "SOONCO",
        issueStart: day("2026-08-20"),
        issueEnd: day("2026-08-22"),
      },
      {
        symbol: "OLDCO",
        issueStart: day("2026-07-28"),
        issueEnd: day("2026-07-30"),
        listingDate: day("2026-08-04"),
      },
      {
        symbol: "ANCIENTCO",
        issueStart: day("2026-01-05"),
        issueEnd: day("2026-01-07"),
        listingDate: day("2026-01-12"),
      },
    ];
    const out = bucketIpos(rows, {
      today: new Date("2026-08-16T06:00:00.000Z"),
    });
    assert.equal(out.today, "2026-08-16");
    assert.deepEqual(
      out.current.map((v) => v.symbol),
      ["NEWCO"],
    );
    assert.deepEqual(
      out.upcoming.map((v) => v.symbol),
      ["SOONCO"],
    );
    assert.deepEqual(
      out.recent.map((v) => v.symbol),
      ["OLDCO"],
    );
    assert.equal(out.current[0]?.closesToday, true);
    assert.equal(out.current[0]?.daysToClose, 0);
    assert.equal(out.upcoming[0]?.daysToOpen, 4);
    // ANCIENTCO listed in January: outside the 30-day window, so it is neither
    // recent nor silently promoted into another tab. Crucially it is NOT in
    // `unplaced` either — that bucket means "NSE published no dates", and
    // filling it with every IPO in history makes it useless.
    assert.ok(!out.recent.some((v) => v.symbol === "ANCIENTCO"));
    assert.ok(!out.unplaced.some((v) => v.symbol === "ANCIENTCO"));
    assert.equal(
      out.archivedCount,
      1,
      "dropped rows are counted, not vanished",
    );
  });

  it("keeps an un-priced issue's band NULL rather than a free ₹0 offer", () => {
    const out = bucketIpos(
      [
        {
          symbol: "TBACO",
          issueStart: day("2026-09-01"),
          priceMin: null,
          priceMax: null,
        },
      ],
      { today: day("2026-08-16") },
    );
    const v = out.upcoming[0];
    assert.equal(v?.priceMin, null);
    assert.equal(v?.priceMax, null);
    assert.equal(v?.lotSize, null);
  });

  it("surfaces a dateless issue instead of dropping it", () => {
    const out = bucketIpos(
      [{ symbol: "NODATES", status: "UPCOMING" }, { symbol: "TOTALLYUNKNOWN" }],
      { today: day("2026-08-16") },
    );
    // A status-only row still places; a row with neither is surfaced.
    assert.deepEqual(
      out.upcoming.map((v) => v.symbol),
      ["NODATES"],
    );
    assert.deepEqual(
      out.unplaced.map((v) => v.symbol),
      ["TOTALLYUNKNOWN"],
    );
  });

  it("lets a real listing date override a stale OPEN status", () => {
    // The sync stamps `status` from whichever endpoint won the merge and it
    // goes stale between runs; a published listing date is a fact.
    const listed: UpcomingIpoInput = {
      symbol: "STALECO",
      issueStart: day("2026-08-03"),
      issueEnd: day("2026-08-05"),
      listingDate: day("2026-08-11"),
      status: "OPEN",
    };
    assert.equal(classifyIpoPhase(listed, "2026-08-16"), "RECENT");
  });

  it("builds a dashboard card only while something is open or forthcoming", () => {
    const open = bucketIpos([issue], { today: day("2026-08-16") });
    const card = buildIpoDashboardCard(open);
    assert.equal(card.empty, false);
    assert.equal(card.openCount, 1);
    assert.deepEqual(
      card.closingToday.map((v) => v.symbol),
      ["NEWCO"],
    );
    assert.equal(card.nextOpen, null);

    const quiet = buildIpoDashboardCard(
      bucketIpos([], { today: day("2026-08-16") }),
    );
    assert.equal(
      quiet.empty,
      true,
      "no card at all beats a permanent 'no IPOs' tile",
    );

    const forthcoming = buildIpoDashboardCard(
      bucketIpos([{ symbol: "SOONCO", issueStart: day("2026-08-20") }], {
        today: day("2026-08-16"),
      }),
    );
    assert.equal(forthcoming.empty, false);
    assert.equal(forthcoming.nextOpen?.symbol, "SOONCO");
  });
});

// ════════════════════════════════════════════════════════════════════
// 14d.5 — circulars
// ════════════════════════════════════════════════════════════════════

describe("14d.5 circular identity + feed", () => {
  const base: NseCircularInput = {
    circularNumber: "75736",
    displayNumber: "NSE/CML/75736",
    department: "Listing",
    category: "Compliance",
    subject: "Listing of further issues",
    circularDate: day("2026-08-13"),
    topic: "LISTING",
  };

  it("keys on (circularNumber, department) — NSE re-issues one number per department", () => {
    const reissued: NseCircularInput = { ...base, department: "Emerge" };
    assert.notEqual(circularKey(base), circularKey(reissued));

    const feed = buildCircularFeed([base, reissued]);
    assert.equal(
      feed.length,
      2,
      "keying on circularNumber alone silently discards half of every re-issue",
    );
    assert.deepEqual(feed.map((c) => c.department).sort(), [
      "Emerge",
      "Listing",
    ]);
  });

  it("collapses a genuinely duplicated row and orders newest first", () => {
    const feed = buildCircularFeed([
      base,
      base,
      { ...base, circularNumber: "75800", circularDate: day("2026-08-14") },
    ]);
    assert.equal(feed.length, 2);
    assert.equal(feed[0]?.circularNumber, "75800");
    assert.equal(feed[0]?.date, "2026-08-14");
  });

  it("counts departments for the filter chips", () => {
    const counts = countCircularDepartments([
      base,
      { ...base, department: "Surveillance", circularNumber: "1" },
      { ...base, department: "Surveillance", circularNumber: "2" },
    ]);
    assert.deepEqual(counts, [
      { department: "Surveillance", count: 2 },
      { department: "Listing", count: 1 },
    ]);
  });
});

describe("14d.5 SURV symbol heuristic", () => {
  const surv = (
    subject: string,
    over: Partial<NseCircularInput> = {},
  ): NseCircularInput => ({
    circularNumber: String(Math.random()).slice(2, 8),
    department: "Surveillance",
    category: "Compliance",
    subject,
    circularDate: day("2026-08-13"),
    topic: "SURVEILLANCE",
    ...over,
  });

  it("matches a symbol that appears as a bare token in the subject", () => {
    const hits = matchCircularsForSymbol(
      [surv("Moving RELIANCE to ASM Framework Stage I")],
      "RELIANCE",
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.basis, "SUBJECT_TOKEN");
    assert.equal(hits[0]?.confidence, "LOW");
  });

  // ── the false positive this exists to bound ────────────────────────
  it("does NOT match a short symbol hiding inside an unrelated word", () => {
    // "BEL" is Bharat Electronics. A substring search finds it inside "below",
    // a word that appears in a large share of price-band and surveillance
    // circulars — so every one of them would land on BEL's stock page.
    const rows = [
      surv("Securities moved below the applicable price band"),
      surv("Revised BELOW-par settlement guidance"),
    ];
    assert.deepEqual(matchCircularsForSymbol(rows, "BEL"), []);
    // Prove the tokenizer is the mechanism, not a coincidence of casing.
    assert.deepEqual(tokenizeCircularText("moved below the band"), [
      "MOVED",
      "BELOW",
      "THE",
      "BAND",
    ]);
    assert.ok(!tokenizeCircularText("moved below the band").includes("BEL"));
  });

  it("splits on punctuation so a possessive still matches", () => {
    const hits = matchCircularsForSymbol(
      [surv("Clarification on TATAMOTORS's board meeting outcome")],
      "TATAMOTORS",
    );
    assert.equal(hits.length, 1);
  });

  it("refuses two-character symbols for subject matching entirely", () => {
    // No stopword list saves a 2-char ticker from ordinary English.
    assert.deepEqual(
      matchCircularsForSymbol([surv("Trading window to be shut")], "TO"),
      [],
    );
  });

  it("drops stopword collisions that would otherwise match nearly every circular", () => {
    assert.deepEqual(
      matchCircularsForSymbol([surv("ASM Framework Stage II review")], "ASM"),
      [],
    );
    assert.deepEqual(
      matchCircularsForSymbol([surv("NSE to conduct a mock session")], "NSE"),
      [],
    );
  });

  it("prefers NSE's own company column and ranks it above a subject guess", () => {
    const rows = [
      surv("Change in the price band", {
        company: "ITC Limited",
        circularDate: day("2026-08-01"),
      }),
      surv("Surveillance action on ITC", { circularDate: day("2026-08-13") }),
    ];
    const hits = matchCircularsForSymbol(rows, "ITC");
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.basis, "COMPANY_FIELD");
    assert.equal(hits[0]?.confidence, "HIGH");
    assert.equal(
      hits[1]?.basis,
      "SUBJECT_TOKEN",
      "a newer subject guess must not outrank the exchange's own attribution",
    );
  });

  it("filters to the requested departments", () => {
    const rows = [
      surv("RELIANCE moved to ASM"),
      surv("RELIANCE listing of further issues", { department: "Listing" }),
    ];
    const hits = matchCircularsForSymbol(rows, "RELIANCE", {
      departments: ["Surveillance"],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.circular.department, "Surveillance");
  });

  it("ships the disclaimer as a constant so the wording cannot drift", () => {
    assert.match(CIRCULAR_MATCH_DISCLAIMER, /heuristic match/i);
    assert.match(
      CIRCULAR_MATCH_DISCLAIMER,
      /not by an exchange-provided link/i,
    );
  });

  it("STILL matches an English-word ticker used in its ordinary sense", () => {
    // The residue the bounds do NOT close, pinned deliberately: IDEA is a real
    // NSE symbol and this circular is not about it. This is why the surface is
    // labelled a heuristic instead of being tightened until it looks factual —
    // if this ever needs to be authoritative it needs an exchange-provided
    // symbol link, not another regex.
    const hits = matchCircularsForSymbol(
      [surv("Clarification on the IDEA of extended settlement")],
      "IDEA",
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.confidence, "LOW");
  });
});

// ════════════════════════════════════════════════════════════════════
// 14d.6 — index detail
// ════════════════════════════════════════════════════════════════════

describe("14d.6 index route resolution", () => {
  it("maps a route slug to BOTH index namespaces", () => {
    const nifty = resolveIndexRoute("nifty-50");
    assert.equal(nifty.indexSlug, "nifty-50", "IndexClose.indexSlug");
    assert.equal(nifty.indexId, "nifty50", "IndexConstituent.indexId");
    assert.equal(nifty.known, true);

    // The one divergence: NSE's file says niftybank, our DB id says banknifty.
    const bank = resolveIndexRoute("nifty-bank");
    assert.equal(bank.indexSlug, "nifty-bank");
    assert.equal(bank.indexId, "banknifty");
  });

  it("resolves aliases rather than 404-ing a legitimate spelling", () => {
    for (const alias of [
      "banknifty",
      "niftybank",
      "Bank Nifty",
      "BANK-NIFTY",
    ]) {
      assert.equal(resolveIndexRoute(alias).indexId, "banknifty", alias);
    }
  });

  it("still serves a closes-only index, with no constituent list", () => {
    // ind_close_all publishes ~100 indices; only eight have constituent files.
    // A null indexId is the normal case, not a failure.
    const vix = resolveIndexRoute("india-vix");
    assert.equal(vix.indexSlug, "india-vix");
    assert.equal(vix.indexId, null);
    assert.equal(vix.known, false);
    assert.equal(vix.label, "India VIX");
  });

  it("normalises the way the WRITER does (bhavcopy-sync-logic toIndexSlug)", () => {
    // The writer's own documented examples — a drift here is a 404 on a real index.
    assert.equal(normalizeIndexSlug("Nifty 50"), "nifty-50");
    assert.equal(normalizeIndexSlug("NIFTY BANK"), "nifty-bank");
    assert.equal(
      normalizeIndexSlug("Nifty BHARAT Bond Index - Apr 33"),
      "nifty-bharat-bond-index-apr-33",
    );
  });
});

describe("14d.6 buildIndexConstituents", () => {
  it("divides weightBps by 10,000 — the column is percent×10⁴, not basis points", () => {
    // NSE publishes 8.4321%; the writer stores 84321. Dividing by 100 (the
    // arithmetic the field NAME asks for) yields 843.21% for a single stock.
    const out = buildIndexConstituents([
      { symbol: "HDFCBANK", weightBps: 84321, rank: 1 },
    ]);
    assert.equal(out.rows[0]?.weightPct, 8.4321);
    assert.ok((out.rows[0]?.weightPct ?? 0) < 100);
    assert.equal(out.hasWeights, true);
  });

  it("leaves an unpublished weight NULL — archive rows carry none", () => {
    const out = buildIndexConstituents([
      { symbol: "INFY", weightBps: null, rank: 2 },
      { symbol: "TCS", weightBps: null, rank: 1 },
    ]);
    assert.equal(
      out.hasWeights,
      false,
      "the weight column must not render at all",
    );
    assert.equal(
      out.weightCoveragePct,
      null,
      "0% coverage would be a fabrication",
    );
    for (const r of out.rows) assert.equal(r.weightPct, null);
    // Ranked, not weight-sorted — sorting on a mostly-null column buries the index.
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["TCS", "INFY"],
    );
  });

  it("puts unranked rows after ranked ones instead of at rank 0", () => {
    const out = buildIndexConstituents([
      { symbol: "ZZZ", rank: null },
      { symbol: "AAA", rank: 3 },
    ]);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["AAA", "ZZZ"],
    );
  });
});

describe("14d.6 buildIndexMembership", () => {
  it("treats removedOn:null as the OPEN interval", () => {
    const out = buildIndexMembership([
      {
        symbol: "CURRENT1",
        firstSeen: day("2020-01-01"),
        lastSeen: day("2026-08-13"),
        addedOn: null,
        removedOn: null,
      },
      {
        symbol: "JOINED",
        firstSeen: day("2024-03-28"),
        lastSeen: day("2026-08-13"),
        addedOn: day("2024-03-28"),
        removedOn: null,
      },
      {
        symbol: "LEFT",
        firstSeen: day("2020-01-01"),
        lastSeen: day("2024-03-27"),
        addedOn: null,
        removedOn: day("2024-03-28"),
      },
    ]);
    assert.equal(out.currentCount, 2);
    assert.equal(
      out.preexistingCount,
      1,
      "addedOn:null means 'already a member when we started looking'",
    );
    assert.deepEqual(out.changes, [
      { symbol: "JOINED", kind: "ADDED", date: "2024-03-28" },
      { symbol: "LEFT", kind: "REMOVED", date: "2024-03-28" },
    ]);
    assert.equal(out.observedFrom, "2020-01-01");
  });

  it("emits NO ADDED event for a pre-existing member", () => {
    // Deriving addedOn from firstSeen would tell a backtest that all 50
    // constituents joined on our earliest snapshot — a fabricated rebalance.
    const out = buildIndexMembership([
      {
        symbol: "OLDTIMER",
        firstSeen: day("2019-06-01"),
        lastSeen: day("2026-08-13"),
        addedOn: null,
        removedOn: null,
      },
    ]);
    assert.deepEqual(out.changes, []);
  });

  it("keeps both stints of a symbol that left and returned", () => {
    const out = buildIndexMembership([
      {
        symbol: "BOOMERANG",
        firstSeen: day("2020-01-01"),
        lastSeen: day("2022-09-29"),
        addedOn: null,
        removedOn: day("2022-09-30"),
      },
      {
        symbol: "BOOMERANG",
        firstSeen: day("2025-03-28"),
        lastSeen: day("2026-08-13"),
        addedOn: day("2025-03-28"),
        removedOn: null,
      },
    ]);
    assert.equal(out.currentCount, 1);
    assert.deepEqual(
      out.changes.map((c) => `${c.kind}@${c.date}`),
      ["ADDED@2025-03-28", "REMOVED@2022-09-30"],
    );
  });
});

describe("14d.6 buildIndexDetail", () => {
  const close = (
    d: string,
    over: Partial<IndexCloseInput> = {},
  ): IndexCloseInput => ({
    date: day(d),
    name: "Nifty 50",
    open: 24_500,
    high: 24_800,
    low: 24_400,
    close: 24_700,
    prevClose: 24_600,
    pe: 22.4,
    pb: 3.8,
    divYield: 1.25,
    volume: 285_000_000,
    turnoverCr: 34_500.5,
    ...over,
  });

  it("keeps an unreported P/E NULL — 0 reads as the cheapest index on the exchange", () => {
    const out = buildIndexDetail(
      [
        close("2026-08-13", {
          pe: null,
          pb: null,
          divYield: null,
          volume: null,
          turnoverCr: null,
        }),
      ],
      { label: "India VIX" },
    );
    assert.equal(out.valuation.pe, null);
    assert.equal(out.valuation.pb, null);
    assert.equal(out.valuation.divYield, null);
    assert.equal(out.valuation.volume, null);
    assert.equal(out.valuation.turnoverCr, null);
    // The price side is still real.
    assert.equal(out.close, 24_700);
  });

  it("carries a published valuation through unchanged", () => {
    const out = buildIndexDetail([close("2026-08-13")], { label: "Nifty 50" });
    assert.equal(out.valuation.pe, 22.4);
    assert.equal(out.valuation.divYield, 1.25);
    assert.equal(out.valuation.turnoverCr, 34_500.5);
    assert.equal(out.name, "Nifty 50");
    assert.equal(out.date, "2026-08-13");
  });

  it("computes the day change from prevClose, falling back to the prior session", () => {
    const withPrev = buildIndexDetail([close("2026-08-13")], {
      label: "Nifty 50",
    });
    assert.equal(withPrev.changeAbs, 100);
    assert.equal(withPrev.changePct, 0.41);

    const noPrevColumn = buildIndexDetail(
      [
        close("2026-08-12", { close: 24_000 }),
        close("2026-08-13", { close: 24_240, prevClose: null }),
      ],
      { label: "Nifty 50" },
    );
    assert.equal(noPrevColumn.prevClose, 24_000);
    assert.equal(noPrevColumn.changePct, 1);
  });

  it("leaves the change null rather than substituting `open`", () => {
    const out = buildIndexDetail(
      [close("2026-08-13", { prevClose: null, open: 24_000 })],
      { label: "Nifty 50" },
    );
    assert.equal(out.prevClose, null);
    assert.equal(out.changeAbs, null);
    assert.equal(out.changePct, null, "open is intraday, not day-on-day");
  });

  it("builds an oldest→newest sparkline and drops sessions with no close", () => {
    const out = buildIndexDetail(
      [
        close("2026-08-13", { close: 24_700 }),
        close("2026-08-11", { close: 24_500 }),
        close("2026-08-12", { close: null }),
      ],
      { label: "Nifty 50" },
    );
    assert.deepEqual(
      out.spark.map((p) => p.date),
      ["2026-08-11", "2026-08-13"],
    );
    assert.deepEqual(
      out.spark.map((p) => p.close),
      [24_500, 24_700],
    );
    assert.equal(
      out.sessions,
      3,
      "the null session existed, it just has no point",
    );
  });

  it("is empty rather than zeroed when the index has no closes at all", () => {
    const out = buildIndexDetail([], { label: "Nifty 50" });
    assert.equal(out.date, null);
    assert.equal(out.close, null);
    assert.equal(out.valuation.pe, null);
    assert.deepEqual(out.spark, []);
  });
});
