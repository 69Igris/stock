/**
 * MONEY-1204 (P14 / 14e.2) — the three converted tools' DB-first ordering.
 *
 * `fetch_bulk_block_deals`, `fetch_fii_dii_flows` and `fetch_macro_dashboard`
 * scraped live and had ZERO Prisma references. Each now reads our own synced
 * table FIRST and keeps its live path as the fallback.
 *
 * These tests import the REAL exported orchestrators (`resolveBulkBlockDeals`,
 * `resolveFiiDiiFlows`, `resolveMacroDashboard`) and the REAL live→row mappers,
 * and inject fake DB/live readers — no network, no database, no shadow copy of
 * the ordering logic. The four properties each must hold:
 *
 *   1. DB rows present ⇒ returned, and LIVE IS NEVER CALLED. If the live path
 *      still ran on the happy path the inversion would have bought nothing.
 *   2. DB empty ⇒ live answers, flagged `fallback: true` so the citation is
 *      honest about which source spoke.
 *   3. DB throws ⇒ live answers rather than the tool dying.
 *   4. Both empty ⇒ an EMPTY CITED result, never an exception, with the reason
 *      in `provenance`.
 *
 * Sources: packages/research/src/tools/fetch-{bulk-block-deals,fii-dii-flows,
 *          macro-dashboard}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveBulkBlockDeals,
  type BulkBlockLiveContext,
} from "../src/tools/fetch-bulk-block-deals";
import {
  resolveFiiDiiFlows,
  summariseFlows,
  summaryToFlowRows,
} from "../src/tools/fetch-fii-dii-flows";
import {
  resolveMacroDashboard,
  snapshotToMacroRows,
  MACRO_DASHBOARD_SERIES,
} from "../src/tools/fetch-macro-dashboard";
import { partitionFlags, describeFlags } from "../src/tools/fetch-stock-flags";
import {
  rollupBySchemeLatest,
  totalExposure,
} from "../src/tools/fetch-funds-holding";
import {
  latestPerIsinSegment,
  yearsToMaturity,
} from "../src/tools/fetch-bond-quotes";
import { vixRegime, VIX_NOT_REPORTED } from "../src/tools/fetch-vix";
import type {
  CitedRows,
  DealRow,
  FlowRow,
  FundHoldingRow,
  MacroRow,
  StockFlagRowOut,
} from "../src/data-sources/market-structure-logic";
import type { FIIDIISummary } from "../src/data-sources/nse-fii-dii";
import type { MacroSnapshot } from "../src/data-sources/rbi-client";

// ════════════════════════════════════════════════════════════════════
// fetch_fii_dii_flows
// ════════════════════════════════════════════════════════════════════

const DB_FLOW: FlowRow = {
  date: "2026-08-14T00:00:00.000Z",
  category: "FII",
  segment: "CASH",
  buyValue: 12_000,
  sellValue: 13_050,
  netValue: -1_050,
  source: "NSE_FII_DII_CASH",
};

const LIVE_SUMMARY: FIIDIISummary = {
  flows: [
    {
      date: "2026-08-14",
      fii: { buyValue: 1, sellValue: 2, netValue: -1 },
      dii: { buyValue: 5, sellValue: 3, netValue: 2 },
    },
  ],
  fiiNetTotal: -1,
  diiNetTotal: 2,
  trend: "fii_selling",
  period: "1d",
};

const citedFlows = (rows: FlowRow[]): CitedRows<FlowRow> => ({
  rows,
  asOf: rows[0]?.date ?? null,
  provenance: { origin: "DB", source: "InstitutionalFlow" },
});

describe("fetch_fii_dii_flows — DB-first with live fallback", () => {
  it("serves DB rows and never touches NSE", async () => {
    let liveCalls = 0;
    const out = await resolveFiiDiiFlows(
      async () => citedFlows([DB_FLOW]),
      async () => {
        liveCalls++;
        return LIVE_SUMMARY;
      },
    );
    assert.equal(
      liveCalls,
      0,
      "the live scrape must not run on the happy path",
    );
    assert.equal(out.provenance.origin, "DB");
    assert.equal(out.provenance.source, "InstitutionalFlow");
    assert.deepEqual(out.rows, [DB_FLOW]);
    assert.equal(out.asOf, "2026-08-14T00:00:00.000Z");
  });

  it("falls back to live NSE when the table is empty, flagged as a fallback", async () => {
    const out = await resolveFiiDiiFlows(
      async () => citedFlows([]),
      async () => LIVE_SUMMARY,
    );
    assert.equal(out.provenance.origin, "LIVE");
    assert.equal(out.provenance.fallback, true);
    // One source day becomes TWO rows — the grain InstitutionalFlow stores and
    // its unique key enforces — so the fallback is a drop-in.
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows.map((r) => r.category).sort(), ["DII", "FII"]);
  });

  it("falls back when the DB read throws", async () => {
    const out = await resolveFiiDiiFlows(
      async () => {
        throw new Error("PrismaClient is not configured");
      },
      async () => LIVE_SUMMARY,
    );
    assert.equal(out.provenance.origin, "LIVE");
    assert.equal(out.provenance.fallback, true);
    assert.equal(out.rows.length, 2);
  });

  it("both dry ⇒ an empty CITED result, not a thrown tool", async () => {
    const out = await resolveFiiDiiFlows(
      async () => citedFlows([]),
      async () => null,
    );
    assert.deepEqual(out.rows, []);
    assert.equal(out.provenance.origin, "NONE");
    assert.match(out.provenance.note ?? "", /Neither the synced/);
  });

  it("records a live outage separately from a genuine gap", async () => {
    const out = await resolveFiiDiiFlows(
      async () => citedFlows([]),
      async () => {
        throw new Error("NSE 403");
      },
    );
    assert.equal(out.provenance.sourceError, "NSE 403");
    assert.deepEqual(out.rows, []);
  });

  it("summariseFlows skips unreported nets rather than counting them as 0", () => {
    const totals = summariseFlows([
      { ...DB_FLOW, netValue: -1_000 },
      { ...DB_FLOW, netValue: null },
      { ...DB_FLOW, category: "DII", netValue: 800 },
    ]);
    assert.equal(totals.fiiNetTotal, -1_000);
    assert.equal(totals.diiNetTotal, 800);
    assert.equal(totals.trend, "fii_selling");
  });

  it("summaryToFlowRows tolerates an empty/absent live payload", () => {
    assert.deepEqual(summaryToFlowRows(null), []);
    assert.deepEqual(summaryToFlowRows({ ...LIVE_SUMMARY, flows: [] }), []);
  });
});

// ════════════════════════════════════════════════════════════════════
// fetch_macro_dashboard
// ════════════════════════════════════════════════════════════════════

const DB_MACRO: MacroRow = {
  seriesId: "RBI_REPO_RATE",
  period: "2026-08-01T00:00:00.000Z",
  value: 5.5,
  unit: "PERCENT",
  frequency: "MONTHLY",
  label: "Policy Repo Rate",
  releasedOn: "2026-08-07T00:00:00.000Z",
  source: "rbi-nsdp-rates",
};

const LIVE_SNAPSHOT: MacroSnapshot = {
  repoRate: { value: 5.5, date: "2026-08-01" },
  cpi: { value: 3.2, date: "2026-07-01" },
  gdpGrowth: { value: 7.4, quarter: "Q1 FY27", date: "2026-06-30" },
  forexReserves: { value: 704_000, date: "2026-08-08", unit: "USD_MILLION" },
  iip: { value: 4.1, date: "2026-06-01" },
  riskFreeRate: 6.4,
};

const citedMacro = (rows: MacroRow[]): CitedRows<MacroRow> => ({
  rows,
  asOf: rows[0]?.period ?? null,
  provenance: { origin: "DB", source: "MacroSeries" },
});

describe("fetch_macro_dashboard — DB-first with live fallback", () => {
  it("serves MacroSeries rows and never scrapes RBI", async () => {
    let liveCalls = 0;
    const out = await resolveMacroDashboard(
      async () => citedMacro([DB_MACRO]),
      async () => {
        liveCalls++;
        return LIVE_SNAPSHOT;
      },
    );
    assert.equal(liveCalls, 0);
    assert.equal(out.provenance.origin, "DB");
    assert.deepEqual(out.rows, [DB_MACRO]);
  });

  it("falls back to the live RBI snapshot when the table is empty", async () => {
    const out = await resolveMacroDashboard(
      async () => citedMacro([]),
      async () => LIVE_SNAPSHOT,
    );
    assert.equal(out.provenance.origin, "LIVE");
    assert.equal(out.provenance.fallback, true);
    assert.ok(out.rows.some((r) => r.seriesId === "RBI_REPO_RATE"));
  });

  it("falls back when the DB read throws, and stays empty-but-cited if live is dry", async () => {
    const thrown = await resolveMacroDashboard(
      async () => {
        throw new Error("db down");
      },
      async () => LIVE_SNAPSHOT,
    );
    assert.equal(thrown.provenance.origin, "LIVE");

    const dry = await resolveMacroDashboard(
      async () => citedMacro([]),
      async () => null,
    );
    assert.deepEqual(dry.rows, []);
    assert.equal(dry.provenance.origin, "NONE");
  });

  it("the live mapper DROPS an observation whose period will not parse", () => {
    // Stamping it with the fetch day would assert that today's reading
    // describes today — false by up to six weeks for a monthly CPI print.
    const rows = snapshotToMacroRows({
      ...LIVE_SNAPSHOT,
      cpi: { value: 3.2, date: "not a date" },
    });
    assert.equal(
      rows.some((r) => r.seriesId === "MOSPI_CPI_COMBINED"),
      false,
    );
    assert.ok(rows.some((r) => r.seriesId === "RBI_REPO_RATE"));
  });

  it("keeps the dashboard series ids stable — the id is half the unique key", () => {
    // Renaming one FORKS the series in place rather than moving it.
    assert.deepEqual(
      [...MACRO_DASHBOARD_SERIES],
      [
        "RBI_REPO_RATE",
        "MOSPI_CPI_COMBINED",
        "OEA_WPI_ALL_COMMODITIES",
        "RBI_FOREX_RESERVES_TOTAL_USD_MN",
        "RBI_FOREX_RESERVES_TOTAL_INR_CR",
        "MOSPI_IIP_GENERAL",
        "RBI_GSEC_10Y_YIELD",
      ],
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// fetch_bulk_block_deals
// ════════════════════════════════════════════════════════════════════

const DB_DEAL: DealRow = {
  date: "2026-08-14T00:00:00.000Z",
  symbol: "IDEA",
  exchange: "NSE",
  securityName: "Vodafone Idea",
  clientName: "GRAVITON RESEARCH CAPITAL LLP",
  buySell: "BUY",
  qty: 1_200_000_000,
  avgPrice: 8.4,
  dealType: "BULK",
  remarks: null,
  source: "NSE_DEALS",
};

const citedDeals = (rows: DealRow[]): CitedRows<DealRow> => ({
  rows,
  asOf: rows[0]?.date ?? null,
  provenance: { origin: "DB", source: "InstitutionalDeal" },
});

describe("fetch_bulk_block_deals — DB-first with live trade-info fallback", () => {
  it("serves real deals from InstitutionalDeal and never scrapes", async () => {
    let liveCalls = 0;
    const out = await resolveBulkBlockDeals(
      async () => citedDeals([DB_DEAL]),
      async () => {
        liveCalls++;
        return { tradeInfo: { x: 1 } };
      },
    );
    assert.equal(liveCalls, 0);
    assert.equal(out.cited.provenance.origin, "DB");
    assert.deepEqual(out.cited.rows, [DB_DEAL]);
    assert.equal(out.liveContext, null, "no live payload on the happy path");
  });

  it("attaches live trade info as CONTEXT, clearly not as deals", async () => {
    const live: BulkBlockLiveContext = {
      tradeInfo: { deliveryToTradedQuantity: 41.2 },
      corporateActions: [{ subject: "Dividend" }],
    };
    const out = await resolveBulkBlockDeals(
      async () => citedDeals([]),
      async () => live,
    );
    // The rows stay EMPTY: trade info is delivery/corporate-action data and is
    // not a bulk or block deal. Dressing it up as one is the bug this tool had.
    assert.deepEqual(out.cited.rows, []);
    assert.equal(out.cited.provenance.origin, "NONE");
    assert.match(out.cited.provenance.note ?? "", /NOT deals/);
    assert.deepEqual(out.liveContext, live);
  });

  it("falls through to the live path when the DB read throws", async () => {
    const out = await resolveBulkBlockDeals(
      async () => {
        throw new Error("db down");
      },
      async () => ({ tradeInfo: { x: 1 } }),
    );
    assert.equal(out.cited.provenance.sourceError, "db down");
    assert.ok(out.liveContext);
  });

  it("both dry ⇒ an empty cited result that says both were tried", async () => {
    const out = await resolveBulkBlockDeals(
      async () => citedDeals([]),
      async () => null,
    );
    assert.deepEqual(out.cited.rows, []);
    assert.equal(out.liveContext, null);
    assert.match(out.cited.provenance.note ?? "", /returned nothing either/);
  });
});

// ════════════════════════════════════════════════════════════════════
// New tools — pure helpers
// ════════════════════════════════════════════════════════════════════

function flagRow(over: Partial<StockFlagRowOut>): StockFlagRowOut {
  return {
    kind: "SURVEILLANCE",
    raw: "GSM STAGE - I",
    framework: "GSM",
    stage: 1,
    label: "GSM Stage I",
    date: "2026-08-14T00:00:00.000Z",
    since: "2026-08-01T00:00:00.000Z",
    observedSessions: 10,
    runReachesWindowEdge: false,
    isCurrent: true,
    series: "EQ",
    source: "nse-reg-ind",
    ...over,
  };
}

describe("fetch_stock_flags helpers", () => {
  it("splits current from ended — an ended ban is not a current one", () => {
    const { current, ended } = partitionFlags([
      flagRow({}),
      flagRow({ kind: "FO_BAN", label: "F&O ban", isCurrent: false }),
    ]);
    assert.equal(current.length, 1);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.kind, "FO_BAN");
  });

  it("says so plainly when nothing is in force", () => {
    assert.match(
      describeFlags([flagRow({ isCurrent: false })]),
      /No surveillance, price-band or F&O-ban flag is currently in force/,
    );
  });

  it("reads a window-edge run as a LOWER BOUND, not a precise start date", () => {
    const s = describeFlags([flagRow({ runReachesWindowEdge: true })]);
    assert.match(s, /at least since 2026-08-01/);
    const t = describeFlags([flagRow({ runReachesWindowEdge: false })]);
    assert.match(t, /since 2026-08-01/);
    assert.doesNotMatch(t, /at least since/);
  });
});

describe("fetch_funds_holding helpers", () => {
  const holding = (over: Partial<FundHoldingRow>): FundHoldingRow => ({
    period: "2026-07-01T00:00:00.000Z",
    amc: "SBI",
    schemeName: "SBI Bluechip Fund",
    schemeKey: "sbibluechip",
    isin: "INE002A01018",
    instrumentName: "Reliance Industries Ltd",
    holdingType: "EQUITY",
    quantity: 1000,
    marketValueLakh: 2500,
    percentToNav: 4.2,
    source: "amc-sbi",
    ...over,
  });

  it("keeps the newest disclosure per scheme, sorted by conviction", () => {
    const rolled = rollupBySchemeLatest([
      holding({ period: "2026-06-01T00:00:00.000Z", percentToNav: 9 }),
      holding({ period: "2026-07-01T00:00:00.000Z", percentToNav: 4.2 }),
      holding({
        schemeName: "SBI Large & Midcap",
        schemeKey: "sbilargemid",
        percentToNav: 6.1,
      }),
    ]);
    assert.equal(rolled.length, 2);
    // Newest per scheme, so Bluechip is 4.2 (July), not 9 (June).
    assert.deepEqual(
      rolled.map((r) => [r.schemeKey, r.percentToNav]),
      [
        ["sbilargemid", 6.1],
        ["sbibluechip", 4.2],
      ],
    );
  });

  it("sorts an UNREPORTED weight last rather than treating it as 0", () => {
    const rolled = rollupBySchemeLatest([
      holding({ schemeKey: "a", schemeName: "A", percentToNav: null }),
      holding({ schemeKey: "b", schemeName: "B", percentToNav: 1 }),
    ]);
    assert.deepEqual(
      rolled.map((r) => r.schemeKey),
      ["b", "a"],
    );
  });

  it("totals to NULL when no scheme reported a rupee value", () => {
    const rolled = rollupBySchemeLatest([
      holding({ schemeKey: "a", schemeName: "A", marketValueLakh: null }),
    ]);
    assert.deepEqual(totalExposure(rolled), {
      schemes: 1,
      totalMarketValueLakh: null,
    });
    assert.deepEqual(totalExposure(rollupBySchemeLatest([holding({})])), {
      schemes: 1,
      totalMarketValueLakh: 2500,
    });
  });
});

describe("fetch_bond_quotes helpers", () => {
  const quote = (over: Record<string, unknown>) => ({
    isin: "INE261F08EO7",
    date: "2026-08-14T00:00:00.000Z",
    segment: "CBM",
    lastPrice: 101,
    lastYtm: 7.9,
    wapPrice: null,
    wtdYtm: null,
    totalTradeValueLacs: 20,
    symbol: "BOB",
    issuer: "Bank of Baroda",
    coupon: 8.33,
    maturityDate: "2031-03-31T00:00:00.000Z",
    creditRating: "CRISIL AAA",
    secType: "PT",
    source: "cbm_trd",
    ...over,
  });

  it("keeps BOTH segments — the same ISIN prints in CBM and WDM at different prices", () => {
    const latest = latestPerIsinSegment([
      quote({}),
      quote({ segment: "WDM", lastPrice: 99.5, lastYtm: 8.4 }),
      quote({ date: "2026-08-13T00:00:00.000Z", lastPrice: 100 }),
    ]);
    assert.equal(latest.length, 2);
    assert.deepEqual(
      latest.map((r) => [r.segment, r.lastPrice]),
      [
        ["CBM", 101],
        ["WDM", 99.5],
      ],
    );
  });

  it("computes years to maturity, and refuses for a perpetual", () => {
    assert.equal(
      yearsToMaturity("2026-08-14T00:00:00.000Z", "2031-08-14T00:00:00.000Z"),
      5,
    );
    assert.equal(yearsToMaturity("2026-08-14T00:00:00.000Z", null), null);
  });

  it("an empty history yields an empty list, never a throw", () => {
    assert.deepEqual(latestPerIsinSegment([]), []);
  });
});

describe("fetch_vix helpers", () => {
  it("names the five columns India VIX never reports", () => {
    assert.deepEqual(
      [...VIX_NOT_REPORTED],
      ["volume", "turnoverCr", "pe", "pb", "divYield"],
    );
  });

  it("reads a regime from the level, and 'unknown' when there is none", () => {
    assert.equal(vixRegime(11.31), "complacent");
    assert.equal(vixRegime(14), "calm");
    assert.equal(vixRegime(18), "elevated");
    assert.equal(vixRegime(30), "stressed");
    assert.equal(vixRegime(null), "unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════
// Source hygiene — a literal NUL makes a file INVISIBLE to review
// ═════════════════════════════════════════════════════════════════════

/**
 * git classifies a blob as BINARY the moment it finds a NUL byte in its first
 * 8000 bytes, and a binary blob has NO diff: `git diff`, `gh pr diff` and every
 * review tool print `Bin 0 -> N bytes` instead of the change. A composite map
 * key written with a RAW NUL separator — `fetch-funds-holding.ts`'s
 * `(amc, scheme)` rollup key was one — embeds that byte in the SOURCE, so the
 * whole module silently stops being reviewable.
 *
 * The separator SEMANTICS are worth keeping (a NUL cannot occur in an AMC name
 * or a scheme key). Writing it as the escape sequence keeps the runtime byte
 * identical while leaving the file pure ASCII text.
 *
 * Scans the whole package rather than the one known site: the idiom is
 * copy-pasted, and the next copy is the one nobody looks at. The same scan over
 * `packages/core/src` immediately turned up a site nobody had listed.
 */
describe("packages/research/src carries no literal NUL byte", () => {
  const SRC_ROOT = join(import.meta.dirname, "..", "src");

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  };

  it("no .ts source file embeds a raw NUL", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const at = readFileSync(file).indexOf(0);
      if (at !== -1) offenders.push(`${file} (byte ${at})`);
    }
    assert.deepEqual(
      offenders,
      [],
      "these files embed a raw NUL and are therefore BINARY to git — no " +
        "diff, no review. Use the escape sequence, never the literal byte",
    );
  });
});
