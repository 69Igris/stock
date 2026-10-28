/**
 * MONEY-979 T10 — the Prisma I/O half of the US fundamentals seam.
 *
 * These tests drive the REAL exported functions from
 * `packages/core/src/us-fundamentals/repository.ts` with the Prisma delegates
 * monkey-patched (the pattern `candle-hot-load.test.ts` established — this repo
 * does not use `node:test`'s `mock.module`, which needs an experimental flag).
 * No database, no network.
 *
 * ## The property this file exists for
 *
 * In Prisma over MongoDB `where: { cik10: undefined }` is NOT "match nothing"
 * and NOT an error — the key is DROPPED and the query matches EVERYTHING. So a
 * symbol that resolves to no US filer would return ANOTHER COMPANY'S income
 * statement, attributed to the symbol the caller asked about. Every read here
 * must either carry a concrete cik10 or not run at all.
 *
 * MUTATION-VERIFIED — each `MUTATION:` note names the source edit applied,
 * confirmed RED, and reverted.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@usemoney/database";

import {
  getBeneficialOwners,
  getFilerCoverage,
  getFilings,
  getInsiderActivity,
  getInsiderTransactions,
  getManagerHoldings,
  getStatements,
  getStatementsAsFinancialStatements,
  getTopHolders,
  resolveUsFiler,
  PIT_ROWS_PER_PERIOD,
  REASON_CIK_MALFORMED,
  REASON_COLD_READ_FAILED,
  REASON_COLD_SHARD_ABSENT,
  REASON_COLD_STORE_UNREGISTERED,
  REASON_HOLDER_SET_TRUNCATED,
  REASON_INSIDER_WINDOW_TRUNCATED,
  REASON_NO_IDENTIFIER,
  REASON_NO_PRIOR_PERIOD,
  REASON_NO_ROWS,
  REASON_NO_THIRTEENF_FILING,
  REASON_REQUESTED_PERIOD_EMPTY,
  REASON_SYMBOL_HAS_NO_CIK,
  REASON_SYMBOL_NOT_IN_UNIVERSE,
  US_FULL_SCAN_MAX,
  US_INSIDER_SCAN_MAX,
} from "../../src/us-fundamentals/repository";
import {
  encodeThirteenFShard,
  setUsColdStore,
  type UsColdStore,
} from "../../src/us-fundamentals/cold-holdings";
import type { UsHoldingRow } from "../../src/us-fundamentals/types";

/* ─────────────────────────────────────────────────────────────────────────
   A recording fake over the real Prisma delegates
   ──────────────────────────────────────────────────────────────────────── */

interface Call {
  op: string;
  arg: Record<string, unknown>;
}

type Handler = (arg: Record<string, unknown>) => unknown;

class FakePrisma {
  readonly calls: Call[] = [];
  private restore: Array<() => void> = [];

  /** Ops the test has explicitly answered. Anything else throws loudly. */
  private handlers = new Map<string, Handler>();

  on(op: string, handler: Handler): this {
    this.handlers.set(op, handler);
    return this;
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  argsFor(op: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.op === op).map((c) => c.arg);
  }

  wheresFor(op: string): Array<Record<string, unknown>> {
    return this.argsFor(op).map(
      (a) => (a.where ?? {}) as Record<string, unknown>,
    );
  }

  install(models: readonly string[], methods: readonly string[]): void {
    const client = prisma as unknown as Record<string, Record<string, unknown>>;
    for (const model of models) {
      const delegate = client[model];
      if (!delegate) throw new Error(`no prisma delegate "${model}"`);
      for (const method of methods) {
        const op = `${model}.${method}`;
        const original = delegate[method];
        this.restore.push(() => {
          delegate[method] = original;
        });
        delegate[method] = async (arg: Record<string, unknown> = {}) => {
          this.calls.push({ op, arg });
          const handler = this.handlers.get(op);
          if (!handler) {
            throw new Error(
              `FakePrisma: unexpected ${op} — the test did not arm it, which ` +
                `means a code path queried something it was supposed to skip`,
            );
          }
          return handler(arg);
        };
      }
    }
  }

  uninstall(): void {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
  }
}

const ALL_MODELS = [
  "usInstrument",
  "usFundamentals",
  "usInsiderTransaction",
  "usThirteenFFiling",
  "usThirteenFHolding",
  "usBeneficialOwnership",
  "usFiling",
  "usFiler",
] as const;
const ALL_METHODS = ["findMany", "findFirst", "groupBy"] as const;

let fake: FakePrisma;

beforeEach(() => {
  fake = new FakePrisma();
  fake.install(ALL_MODELS, ALL_METHODS);
  setUsColdStore(null);
});

afterEach(() => {
  fake.uninstall();
  setUsColdStore(null);
});

/** `us_instruments` answers with one ACTIVE AAPL row carrying a CIK. */
function armAaplListing(): void {
  fake.on("usInstrument.findMany", () => [
    { cik: "320193", symbol: "AAPL", listingStartDate: new Date("1980-12-12") },
  ]);
  fake.on("usInstrument.findFirst", () => ({ symbol: "AAPL" }));
}

const AAPL_CIK10 = "0000320193";

function statementRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cik10: AAPL_CIK10,
    symbol: "AAPL",
    statementType: "INCOME",
    periodType: "QUARTERLY",
    periodStart: new Date("2024-01-01T00:00:00.000Z"),
    periodEnd: new Date("2024-03-30T00:00:00.000Z"),
    fiscalYear: 2024,
    fiscalPeriod: "Q2",
    accession: "0000320193-24-000001",
    form: "10-Q",
    filedAt: new Date("2024-05-02T00:00:00.000Z"),
    isAmendment: false,
    isLatest: false,
    standardized: { Revenue: 90_753_000_000, NetIncome: 23_636_000_000 },
    asReported: [],
    mappingSource: "FILING_XBRL",
    mappingVersion: "1",
    parserVersion: "1",
    ...over,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   1. Identity resolution — the undefined-cik10 guard
   ═══════════════════════════════════════════════════════════════════════ */

describe("identity resolution", () => {
  it("a symbol in NO active US listing returns empty with a named reason, and NEVER queries statements", async () => {
    // MUTATION: replacing the `if (!resolved.ok) return empty(...)` early
    // return in getStatements with `const cik10 = resolved.ok ?
    // resolved.identity.cik10 : undefined` (i.e. letting the query run with
    // `cik10: undefined`) turned BOTH assertions below RED — the fake recorded
    // a usFundamentals.findMany whose where had no cik10 key at all, which over
    // Mongo matches every filer. Restored byte-identically.
    fake.on("usInstrument.findMany", () => []);
    const out = await getStatements({
      symbol: "NOT-A-REAL-TICKER",
      statementType: "INCOME",
      periodType: "ANNUAL",
    });

    assert.deepEqual(out.rows, []);
    assert.equal(out.reason, REASON_SYMBOL_NOT_IN_UNIVERSE);
    assert.equal(out.origin, "NONE");
    assert.equal(out.currency, "USD");
    assert.equal(
      fake.ops().includes("usFundamentals.findMany"),
      false,
      "the data collection must not be touched at all when identity is unresolved",
    );
  });

  it("distinguishes 'not in our universe' from 'no CIK joined yet'", async () => {
    // 14.4% of active US stock listings have no CIK (7,111 of 8,307, measured
    // on prod 2026-08-29). That is a different fact from an unknown symbol and
    // is reported as one.
    fake.on("usInstrument.findMany", () => [
      { cik: null, symbol: "NOCIK", listingStartDate: new Date("2020-01-01") },
      { cik: "", symbol: "NOCIK", listingStartDate: new Date("2019-01-01") },
    ]);
    const out = await getStatements({
      symbol: "NOCIK",
      statementType: "INCOME",
      periodType: "ANNUAL",
    });
    assert.equal(out.reason, REASON_SYMBOL_HAS_NO_CIK);
    assert.equal(fake.ops().includes("usFundamentals.findMany"), false);
  });

  it("every armed query carries a CONCRETE, zero-padded cik10", async () => {
    armAaplListing();
    fake.on("usFundamentals.findMany", () => [
      statementRow({ isLatest: true }),
    ]);
    await getStatements({
      symbol: "aapl",
      statementType: "INCOME",
      periodType: "ANNUAL",
    });

    const where = fake.wheresFor("usFundamentals.findMany")[0];
    assert.ok(where, "the query ran");
    assert.equal(where.cik10, AAPL_CIK10, "padded to 10 digits, not '320193'");
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "cik10"),
      true,
      "the key must be PRESENT — Prisma drops an undefined key and matches everything",
    );
  });

  it("resolves SEC's slash spelling to our dash spelling before querying", async () => {
    fake.on("usInstrument.findMany", () => [
      {
        cik: "1067983",
        symbol: "BRK-B",
        listingStartDate: new Date("1996-05-09"),
      },
    ]);
    const out = await resolveUsFiler({ symbol: "BRK/B" });
    assert.equal(out.ok, true);
    assert.equal(fake.wheresFor("usInstrument.findMany")[0]?.symbol, "BRK-B");
  });

  it("refuses a malformed cik10 rather than querying with it", async () => {
    const out = await getStatements({
      cik10: "not-a-cik",
      statementType: "INCOME",
      periodType: "ANNUAL",
    });
    assert.equal(out.reason, REASON_CIK_MALFORMED);
    assert.deepEqual(fake.ops(), [], "nothing was queried");
  });

  it("with neither symbol nor cik10, nothing is queried", async () => {
    const out = await getStatements({
      statementType: "INCOME",
      periodType: "ANNUAL",
    });
    assert.equal(out.reason, REASON_NO_IDENTIFIER);
    assert.deepEqual(fake.ops(), []);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   2. getStatements — the point-in-time query shape
   ═══════════════════════════════════════════════════════════════════════ */

describe("getStatements", () => {
  it("with asOf, filters on filedAt <= asOf and NOT on isLatest", async () => {
    armAaplListing();
    const original = statementRow();
    const restated = statementRow({
      accession: "0000320193-24-000009",
      filedAt: new Date("2024-08-01T00:00:00.000Z"),
      isLatest: true,
      standardized: { Revenue: 90_000_000_000 },
    });
    // The repository hands Prisma's rows to `pickPointInTime`; the fake returns
    // BOTH so the pick is what decides, not the query.
    fake.on("usFundamentals.findMany", () => [restated, original]);

    const out = await getStatements({
      symbol: "AAPL",
      statementType: "INCOME",
      periodType: "QUARTERLY",
      asOf: "2024-06-15T00:00:00.000Z",
    });

    const where = fake.wheresFor("usFundamentals.findMany")[0] ?? {};
    assert.deepEqual(where.filedAt, {
      lte: new Date("2024-06-15T00:00:00.000Z"),
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "isLatest"),
      false,
      "a point-in-time read must not narrow to the CURRENT pointer",
    );
    assert.equal(out.rows.length, 1);
    assert.equal(
      out.rows[0]?.accession,
      "0000320193-24-000001",
      "asked as of a date between two filings, we get the OLDER one",
    );
    assert.equal(out.rows[0]?.currency, "USD");
  });

  it("with NO asOf, narrows to isLatest in the query itself", async () => {
    armAaplListing();
    fake.on("usFundamentals.findMany", () => [
      statementRow({ isLatest: true }),
    ]);
    await getStatements({
      symbol: "AAPL",
      statementType: "INCOME",
      periodType: "ANNUAL",
    });
    const where = fake.wheresFor("usFundamentals.findMany")[0] ?? {};
    assert.equal(where.isLatest, true);
    assert.equal(Object.prototype.hasOwnProperty.call(where, "filedAt"), false);
  });

  it("oversamples the take, because one periodEnd occupies several ROWS", async () => {
    // MONEY-1207: a `take` counted in rows over a population where one logical
    // unit occupies several rows silently returns fewer distinct units than
    // asked for. Here the unit is a PERIOD and the rows are its restatements.
    armAaplListing();
    fake.on("usFundamentals.findMany", () => [
      statementRow({ isLatest: true }),
    ]);
    await getStatements({
      symbol: "AAPL",
      statementType: "INCOME",
      periodType: "ANNUAL",
      limit: 5,
    });
    assert.equal(
      fake.argsFor("usFundamentals.findMany")[0]?.take,
      5 * PIT_ROWS_PER_PERIOD,
    );
  });

  it("an empty match is NO_ROWS, distinct from an unresolved symbol", async () => {
    armAaplListing();
    fake.on("usFundamentals.findMany", () => []);
    const out = await getStatements({
      symbol: "AAPL",
      statementType: "CASH_FLOW",
      periodType: "ANNUAL",
    });
    assert.deepEqual(out.rows, []);
    assert.equal(out.reason, REASON_NO_ROWS);
    assert.notEqual(out.reason, REASON_SYMBOL_NOT_IN_UNIVERSE);
  });

  it("maps to the FinancialStatement shape the compute tools already bind to", async () => {
    armAaplListing();
    fake.on("usFundamentals.findMany", () => [
      statementRow({
        isLatest: true,
        standardized: {
          Revenue: 391_035_000_000,
          NetIncome: 93_736_000_000,
          NetCashFromOperatingActivities: 118_254_000_000,
          CapitalExpenses: 9_447_000_000,
          Assets: 364_980_000_000,
        },
      }),
    ]);
    const out = await getStatementsAsFinancialStatements({
      symbol: "AAPL",
      statementType: "INCOME",
      periodType: "ANNUAL",
    });
    const row = out.rows[0];
    assert.equal(row?.revenue, 391_035_000_000);
    assert.equal(row?.netIncome, 93_736_000_000);
    assert.equal(row?.operatingCashFlow, 118_254_000_000);
    assert.equal(row?.capitalExpenditure, -9_447_000_000);
    assert.equal(row?.totalAssets, 364_980_000_000);
    assert.equal(row?.currency, "USD");
    assert.equal(row?.accession, "0000320193-24-000001");
  });
});

/* ════════════════════════════════════════════════════════════════════════
   3. Insider transactions
   ═══════════════════════════════════════════════════════════════════════ */

function insiderRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accession: "0001214128-26-000001",
    rowIndex: 0,
    issuerCik10: AAPL_CIK10,
    issuerName: "Apple Inc.",
    symbol: "AAPL",
    ownerCik10: "0001214128",
    ownerName: "COOK TIMOTHY D",
    isDirector: false,
    isOfficer: true,
    isTenPctOwner: false,
    officerTitle: "CEO",
    form: "4",
    transactionDate: new Date("2026-08-01T00:00:00.000Z"),
    filedAt: new Date("2026-08-03T00:00:00.000Z"),
    securityTitle: "Common Stock",
    isDerivative: false,
    isHolding: false,
    transactionCode: "S",
    codeMeaning: "open market or private sale",
    equitySwap: false,
    acquiredDisposed: "D",
    shares: 100_000,
    price: 220,
    value: 22_000_000,
    sharesOwnedAfter: 3_000_000,
    directIndirect: "D",
    isAmendment: false,
    ...over,
  };
}

describe("getInsiderTransactions", () => {
  it("queries by issuerCik10 with a concrete value and honours the code filter", async () => {
    armAaplListing();
    fake.on("usInsiderTransaction.findMany", () => [insiderRow()]);
    const out = await getInsiderTransactions({
      symbol: "AAPL",
      codes: ["p", " s "],
      from: "2026-01-01",
      to: "2026-12-31",
    });
    const where = fake.wheresFor("usInsiderTransaction.findMany")[0] ?? {};
    assert.equal(where.issuerCik10, AAPL_CIK10);
    assert.deepEqual(where.transactionCode, { in: ["P", "S"] });
    assert.deepEqual(where.transactionDate, {
      gte: new Date("2026-01-01"),
      lte: new Date("2026-12-31"),
    });
    assert.equal(out.rows[0]?.currency, "USD");
    assert.equal(out.rows[0]?.accession, "0001214128-26-000001");
  });

  it("omits the code filter entirely when no codes are given", async () => {
    armAaplListing();
    fake.on("usInsiderTransaction.findMany", () => [insiderRow()]);
    await getInsiderTransactions({ symbol: "AAPL" });
    const where = fake.wheresFor("usInsiderTransaction.findMany")[0] ?? {};
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "transactionCode"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "transactionDate"),
      false,
    );
  });

  it("getInsiderActivity applies the clock in the QUERY and summarises by class", async () => {
    armAaplListing();
    fake.on("usInsiderTransaction.findMany", () => [
      insiderRow(),
      insiderRow({
        rowIndex: 1,
        transactionCode: "F",
        value: 52_800_000,
        shares: 240_000,
      }),
    ]);
    const now = new Date("2026-08-29T00:00:00.000Z");
    const out = await getInsiderActivity({
      symbol: "AAPL",
      windowDays: 30,
      now,
    });
    const where = fake.wheresFor("usInsiderTransaction.findMany")[0] ?? {};
    const range = where.transactionDate as { gte: Date; lte: Date };
    assert.equal(range.lte.toISOString(), now.toISOString());
    assert.equal(range.gte.toISOString(), "2026-07-30T00:00:00.000Z");
    assert.equal(out.summary.byClass.OPEN_MARKET_SELL.shares, -100_000);
    assert.equal(
      out.summary.byClass.TAX_WITHHOLDING.shares,
      -240_000,
      "a tax withholding is not an open-market sale",
    );
    assert.equal(out.summary.netOpenMarketShares, -100_000);
  });

  /**
   * `take` honoured, so the fake truncates exactly the way Mongo would.
   * `orderBy transactionDate desc` is modelled by handing back an array that is
   * already newest-first.
   */
  function armInsiderWindow(rows: Array<Record<string, unknown>>): void {
    fake.on("usInsiderTransaction.findMany", (arg) => {
      const take = Number(arg.take);
      return Number.isFinite(take) ? rows.slice(0, take) : rows;
    });
  }

  /** 600 sales (newest) then 100 purchases (oldest), spread over 100 days. */
  function sellsThenBuys(): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    const day = 24 * 60 * 60 * 1000;
    const newest = new Date("2026-08-28T00:00:00.000Z").getTime();
    for (let i = 0; i < 600; i++) {
      rows.push(
        insiderRow({
          rowIndex: i,
          transactionCode: "S",
          acquiredDisposed: "D",
          shares: 1_000,
          value: 220_000,
          transactionDate: new Date(newest - Math.floor(i / 12) * day),
        }),
      );
    }
    for (let i = 0; i < 100; i++) {
      rows.push(
        insiderRow({
          rowIndex: 600 + i,
          transactionCode: "P",
          acquiredDisposed: "A",
          shares: 2_000,
          value: 440_000,
          transactionDate: new Date(newest - (60 + i) * day),
        }),
      );
    }
    return rows;
  }

  it("[regression] the summary covers the WHOLE window, not the newest `limit` rows", async () => {
    // MUTATION: restoring the old body — `getInsiderTransactions({..., limit:
    // clampLimit(args.limit, US_MAX_LIMIT)})` then `summarizeInsiderActivity(
    // out.rows, windowDays)` — turned this RED on four assertions at once:
    // rowsCounted 500 (not 700), OPEN_MARKET_BUY.shares 0 (not 200_000),
    // OPEN_MARKET_SELL.shares -500_000 (not -600_000) and netOpenMarketShares
    // -500_000 (not -400_000). The 100 purchases are the OLDEST rows in the
    // window, so a `take` ordered newest-first removes every one of them and
    // reports an issuer whose insiders only sold.
    armAaplListing();
    armInsiderWindow(sellsThenBuys());

    const out = await getInsiderActivity({
      symbol: "AAPL",
      windowDays: 180,
      limit: 20,
      now: new Date("2026-08-29T00:00:00.000Z"),
    });

    assert.equal(
      out.summary.rowsCounted,
      700,
      "every row in the window is counted, not the first page of them",
    );
    assert.equal(out.summary.byClass.OPEN_MARKET_BUY.shares, 200_000);
    assert.equal(out.summary.byClass.OPEN_MARKET_SELL.shares, -600_000);
    assert.equal(out.summary.netOpenMarketShares, -400_000);
    assert.equal(
      out.rows.length,
      20,
      "`limit` still caps what is PRESENTED — it just no longer caps the arithmetic",
    );
    assert.equal(out.reason, null);
    assert.equal(out.degraded, false);
    assert.equal(
      fake.argsFor("usInsiderTransaction.findMany")[0]?.take,
      US_INSIDER_SCAN_MAX + 1,
      "one row past the ceiling, which is how the query learns it was truncated",
    );
  });

  it("[regression] a window past the ceiling is DEGRADED and named, never a quietly smaller total", async () => {
    // MUTATION: replacing `truncated ? REASON_INSIDER_WINDOW_TRUNCATED : null`
    // with `null` turned this RED — the summary of 20,000 of 20,001 rows came
    // back reason:null degraded:false, i.e. presented as the window's total.
    armAaplListing();
    const day = 24 * 60 * 60 * 1000;
    const newest = new Date("2026-08-28T00:00:00.000Z").getTime();
    const huge = Array.from({ length: US_INSIDER_SCAN_MAX + 1 }, (_, i) =>
      insiderRow({
        rowIndex: i,
        transactionDate: new Date(newest - (i % 150) * day),
      }),
    );
    armInsiderWindow(huge);

    const out = await getInsiderActivity({
      symbol: "AAPL",
      windowDays: 180,
      limit: 20,
      now: new Date("2026-08-29T00:00:00.000Z"),
    });

    assert.equal(out.reason, REASON_INSIDER_WINDOW_TRUNCATED);
    assert.equal(out.degraded, true);
    assert.equal(out.rows.length, 20);
    assert.equal(
      out.summary.rowsCounted,
      US_INSIDER_SCAN_MAX,
      "the ceiling is applied to the arithmetic too — the +1 sentinel is not counted",
    );
  });

  it("an unresolved symbol still returns a summary, and never queries transactions", async () => {
    // The refactor gave getInsiderActivity its own identity resolution. A
    // missing `summary` here would be a TypeError in every consumer that reads
    // `out.summary.netOpenMarketShares` without guarding.
    fake.on("usInstrument.findMany", () => []);
    const out = await getInsiderActivity({ symbol: "ZZZZ" });
    assert.equal(out.reason, REASON_SYMBOL_NOT_IN_UNIVERSE);
    assert.equal(out.summary.rowsCounted, 0);
    assert.equal(out.summary.netOpenMarketShares, 0);
    assert.equal(
      fake.ops().includes("usInsiderTransaction.findMany"),
      false,
      "an undefined issuerCik10 would match EVERY issuer",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   4. 13F top holders — the limit must not hide the seller
   ═══════════════════════════════════════════════════════════════════════ */

function holdingRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accession: "ACC",
    rowIndex: 0,
    managerCik10: "0001067983",
    periodOfReport: new Date("2026-06-30T00:00:00.000Z"),
    filedAt: new Date("2026-08-14T00:00:00.000Z"),
    cusip: "037833100",
    figi: null,
    issuerName: "Apple Inc.",
    titleOfClass: "COM",
    valueUsd: 1_000_000,
    shares: 5_000,
    sharesType: "SH",
    putCall: null,
    symbol: "AAPL",
    ...over,
  };
}

describe("getTopHolders", () => {
  /**
   * `us_13f_holdings` carries no manager NAME — only `managerCik10`. The name
   * lives on the FILING, so `getTopHolders` joins `us_13f_filings` for the rows
   * it RETURNS, and every case below reaches that read.
   *
   * Armed ONCE here rather than a line per case. A rule stated N times is a
   * rule the next case forgets, and the forgotten stub does not fail as a
   * missing stub — it fails as `FakePrisma: unexpected usThirteenFFiling
   * .findMany`, which reads like a source bug.
   */
  beforeEach(() => {
    armManagerNames();
  });

  /**
   * Answer the name join. `byAccession` omitted → every accession asked about
   * is named. Given → ONLY those accessions exist; the rest are ABSENT from the
   * store, which is how the "unknown stays null" case is set up.
   */
  function armManagerNames(byAccession?: Record<string, string>): void {
    fake.on("usThirteenFFiling.findMany", (arg) => {
      const where = (arg.where ?? {}) as { accession?: { in?: string[] } };
      const asked = where.accession?.in ?? [];
      return asked
        .filter((a) => byAccession === undefined || a in byAccession)
        .map((a) => ({
          accession: a,
          managerName: byAccession?.[a] ?? `Manager of ${a}`,
        }));
    });
  }

  it("applies the limit PER BUCKET so a truncation can never drop every exit", async () => {
    // MUTATION: replacing the two `.slice(0, limit)` calls with a single
    // `deltas.slice(0, limit)` over the combined list turned this RED — with
    // limit 2 the exited holder (valueUsd 0, sorted last) vanished entirely.
    // Restored byte-identically.
    fake.on("usInstrument.findFirst", () => ({ symbol: "AAPL" }));
    fake.on("usThirteenFHolding.findFirst", (arg) => {
      const where = (arg.where ?? {}) as Record<string, unknown>;
      return where.periodOfReport
        ? { periodOfReport: new Date("2026-03-31T00:00:00.000Z") }
        : { periodOfReport: new Date("2026-06-30T00:00:00.000Z") };
    });
    fake.on("usThirteenFHolding.findMany", (arg) => {
      const where = (arg.where ?? {}) as { periodOfReport?: Date };
      const current =
        where.periodOfReport?.toISOString() === "2026-06-30T00:00:00.000Z";
      if (current) {
        return [
          holdingRow({
            managerCik10: "M1",
            valueUsd: 9_000_000,
            shares: 40_000,
          }),
          holdingRow({
            managerCik10: "M2",
            valueUsd: 5_000_000,
            shares: 20_000,
          }),
          holdingRow({
            managerCik10: "M3",
            valueUsd: 1_000_000,
            shares: 4_000,
          }),
        ];
      }
      return [
        holdingRow({
          managerCik10: "M1",
          valueUsd: 8_000_000,
          shares: 38_000,
          periodOfReport: new Date("2026-03-31T00:00:00.000Z"),
        }),
        holdingRow({
          managerCik10: "SELLER",
          accession: "PRIOR-ACC",
          valueUsd: 7_500_000,
          shares: 33_000,
          periodOfReport: new Date("2026-03-31T00:00:00.000Z"),
        }),
      ];
    });

    const out = await getTopHolders({ symbol: "AAPL", limit: 2 });
    const seller = out.rows.find((r) => r.managerCik10 === "SELLER");
    assert.ok(seller, "the manager who liquidated must still be in the result");
    assert.equal(seller.isExited, true);
    assert.equal(seller.sharesDelta, -33_000);
    assert.equal(seller.valueDelta, -7_500_000);
    assert.equal(
      seller.accession,
      "PRIOR-ACC",
      "an exit cites the filing it appeared in",
    );
    assert.equal(
      out.rows.filter((r) => !r.isExited).length,
      2,
      "held holders honour the limit",
    );
  });

  it("names the missing prior period instead of implying every holder is new", async () => {
    fake.on("usInstrument.findFirst", () => ({ symbol: "AAPL" }));
    fake.on("usThirteenFHolding.findFirst", (arg) => {
      const where = (arg.where ?? {}) as Record<string, unknown>;
      return where.periodOfReport
        ? null
        : { periodOfReport: new Date("2026-06-30T00:00:00.000Z") };
    });
    fake.on("usThirteenFHolding.findMany", () => [holdingRow()]);
    const out = await getTopHolders({ symbol: "AAPL" });
    assert.equal(out.reason, REASON_NO_PRIOR_PERIOD);
    assert.equal(out.degraded, true);
    assert.equal(out.rows[0]?.isNew, true);
  });

  it("an unknown symbol never reaches the holdings collection", async () => {
    fake.on("usInstrument.findFirst", () => null);
    const out = await getTopHolders({ symbol: "ZZZZ" });
    assert.equal(out.reason, REASON_SYMBOL_NOT_IN_UNIVERSE);
    assert.equal(fake.ops().includes("usThirteenFHolding.findMany"), false);
    assert.equal(fake.ops().includes("usThirteenFHolding.findFirst"), false);
  });

  /* ── The row cap must not decide who exists ────────────────────────────── */

  const CURRENT_ISO = "2026-06-30T00:00:00.000Z";
  const PRIOR_ISO = "2026-03-31T00:00:00.000Z";

  /** Both period lookups: newest for this symbol, then the one before it. */
  function armPeriods(): void {
    fake.on("usInstrument.findFirst", () => ({ symbol: "AAPL" }));
    fake.on("usThirteenFHolding.findFirst", (arg) => {
      const where = (arg.where ?? {}) as Record<string, unknown>;
      return where.periodOfReport
        ? { periodOfReport: new Date(PRIOR_ISO) }
        : { periodOfReport: new Date(CURRENT_ISO) };
    });
  }

  /**
   * A faithful `usThirteenFHolding.findMany`: it honours `take` the way Mongo
   * does. Without that the fake would hand back the whole population whatever
   * the source asked for, and this defect — which IS the `take` — could not be
   * expressed at all.
   */
  function armHoldings(
    current: Array<Record<string, unknown>>,
    previous: Array<Record<string, unknown>>,
  ): void {
    fake.on("usThirteenFHolding.findMany", (arg) => {
      const where = (arg.where ?? {}) as { periodOfReport?: Date };
      const rows =
        where.periodOfReport?.toISOString() === CURRENT_ISO
          ? current
          : previous;
      const take = Number(arg.take);
      return Number.isFinite(take) ? rows.slice(0, take) : rows;
    });
  }

  /**
   * 600 managers, sorted by `valueUsd` desc as the query would return them.
   *
   * 598 are inert filler between 1,000,000 and 940,300. The two that matter
   * straddle the OLD 500-row window in opposite directions:
   *
   *   FALLER  rank 100 last quarter -> rank 599 this quarter
   *   RISER   rank 599 last quarter -> rank 0   this quarter
   */
  function holderUniverse(args: {
    periodIso: string;
    riserValue: number;
    riserShares: number;
    fallerValue: number;
    fallerShares: number;
  }): Array<Record<string, unknown>> {
    const period = new Date(args.periodIso);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 598; i++) {
      rows.push(
        holdingRow({
          managerCik10: `FILLER-${String(i).padStart(3, "0")}`,
          valueUsd: 1_000_000 - i * 100,
          shares: 10_000,
          periodOfReport: period,
        }),
      );
    }
    rows.push(
      holdingRow({
        managerCik10: "RISER",
        valueUsd: args.riserValue,
        shares: args.riserShares,
        periodOfReport: period,
      }),
      holdingRow({
        managerCik10: "FALLER",
        valueUsd: args.fallerValue,
        shares: args.fallerShares,
        periodOfReport: period,
      }),
    );
    return rows.sort((a, b) => (b.valueUsd as number) - (a.valueUsd as number));
  }

  it("[regression] a manager who crosses the row cap is neither a liquidation nor a new stake", async () => {
    // MUTATION: restoring `take: US_MAX_LIMIT` on the two findMany calls turned
    // this RED on both directions at once. With a 500-row window over a
    // 600-manager issuer, FALLER (rank 100 -> 599) is present in `previous` and
    // absent from `current`, so resolveQoQ reports isExited with the whole
    // position as a negative delta — a named manager liquidating a $990k stake
    // that was never sold. RISER (rank 599 -> 0) is the mirror: isNew with the
    // whole position as the delta.
    //
    // This is not a corner case. AAPL is held by thousands of 13F filers and
    // the boundary around rank 500 churns every quarter on ordinary price
    // moves, so the old code manufactured exits and entries continuously.
    armPeriods();
    armHoldings(
      holderUniverse({
        periodIso: CURRENT_ISO,
        riserValue: 2_000_000, // rank 0
        riserShares: 2_000,
        fallerValue: 900_000, // rank 599
        fallerShares: 4_500,
      }),
      holderUniverse({
        periodIso: PRIOR_ISO,
        riserValue: 940_000, // rank 599
        riserShares: 1_000,
        fallerValue: 990_050, // rank 100
        fallerShares: 5_000,
      }),
    );

    const out = await getTopHolders({ symbol: "AAPL", limit: 500 });

    assert.deepEqual(
      out.rows.filter((r) => r.isExited).map((r) => r.managerCik10),
      [],
      "nobody sold: every manager filed in both quarters",
    );

    const riser = out.rows.find((r) => r.managerCik10 === "RISER");
    assert.ok(riser, "the top holder must be in the result");
    assert.equal(
      riser.isNew,
      false,
      "RISER held 1,000 shares last quarter — it is not a new position",
    );
    assert.equal(
      riser.sharesDelta,
      1_000,
      "the delta is the CHANGE (2,000 - 1,000), not the whole 2,000-share stake",
    );

    assert.equal(out.reason, null);
    assert.equal(out.degraded, false);
    assert.deepEqual(
      fake.argsFor("usThirteenFHolding.findMany").map((a) => a.take),
      [US_FULL_SCAN_MAX + 1, US_FULL_SCAN_MAX + 1],
      "both periods are read whole — one row past the ceiling, to detect it",
    );
  });

  it("[regression] hitting the scan ceiling is DEGRADED and named, on either side of the diff", async () => {
    // MUTATION 1: `const truncated = false` -> RED (reason null, degraded false
    // on a diff whose current period was cut at 20,000 of 20,001 rows).
    // MUTATION 2: dropping the `previousPage.length > US_FULL_SCAN_MAX` operand
    // -> RED on the second half only, which is why both sides are asserted: one
    // truncated period is enough to invent exits in the OTHER one.
    armPeriods();
    const huge = Array.from({ length: US_FULL_SCAN_MAX + 1 }, (_, i) =>
      holdingRow({
        managerCik10: `BIG-${i}`,
        valueUsd: 1_000_000 - i,
        periodOfReport: new Date(CURRENT_ISO),
      }),
    );
    const small = [holdingRow({ managerCik10: "SMALL" })];

    armHoldings(huge, small);
    const currentTruncated = await getTopHolders({ symbol: "AAPL" });
    assert.equal(currentTruncated.reason, REASON_HOLDER_SET_TRUNCATED);
    assert.equal(currentTruncated.degraded, true);
    assert.ok(
      currentTruncated.rows.length > 0,
      "a partial answer is still an answer — it just has to say it is partial",
    );

    armHoldings(small, huge);
    const priorTruncated = await getTopHolders({ symbol: "AAPL" });
    assert.equal(priorTruncated.reason, REASON_HOLDER_SET_TRUNCATED);
    assert.equal(priorTruncated.degraded, true);
  });

  it("TRUNCATED outranks NO_PRIOR_PERIOD — the stronger claim is the one reported", async () => {
    // Both flags can be set at once. NO_PRIOR_PERIOD invalidates `isNew`;
    // TRUNCATED invalidates `isNew` AND `isExited`, so reporting the weaker one
    // would understate what is unsafe about the result.
    fake.on("usInstrument.findFirst", () => ({ symbol: "AAPL" }));
    fake.on("usThirteenFHolding.findFirst", (arg) => {
      const where = (arg.where ?? {}) as Record<string, unknown>;
      return where.periodOfReport
        ? null // no prior period at all
        : { periodOfReport: new Date(CURRENT_ISO) };
    });
    const huge = Array.from({ length: US_FULL_SCAN_MAX + 1 }, (_, i) =>
      holdingRow({ managerCik10: `BIG-${i}`, valueUsd: 1_000_000 - i }),
    );
    fake.on("usThirteenFHolding.findMany", (arg) =>
      huge.slice(0, Number(arg.take)),
    );

    const out = await getTopHolders({ symbol: "AAPL" });
    assert.equal(out.reason, REASON_HOLDER_SET_TRUNCATED);
    assert.equal(out.degraded, true);
  });

  /* ── An empty CURRENT period against a populated prior one ──────────────── */

  it("an empty current period is a NAMED, DEGRADED refusal — not a liquidation", async () => {
    // MUTATION 1: dropping the `true` from
    // `empty(REASON_REQUESTED_PERIOD_EMPTY, true)` turned the `degraded`
    // assertion RED. It shipped without it while the `NO_PRIOR_13F_PERIOD`
    // sibling four lines below sets it, so the one result that refused to
    // answer was the one that did not say so.
    //
    // MUTATION 2: removing the `if (current.length === 0)` guard entirely
    // turned the rows/reason assertions RED — `resolveQoQ([], previous)` marks
    // every prior holder `isExited` with its whole position as a negative
    // delta and reports it with `reason: null, degraded: false`.
    armPeriods();
    armHoldings([], [holdingRow({ managerCik10: "STILL-HOLDS" })]);

    const out = await getTopHolders({ symbol: "AAPL" });
    assert.deepEqual(
      out.rows,
      [],
      "a prior holder must NOT be reported as having liquidated",
    );
    assert.equal(out.reason, REASON_REQUESTED_PERIOD_EMPTY);
    assert.equal(
      out.reason,
      "REQUESTED_PERIOD_HAS_NO_ROWS",
      "the wire value states the SHAPE, never the CAUSE — two different things " +
        "reach this branch (ingestion lag, and a caller passing an " +
        "offset-bearing timestamp that misses an exact-equality match), and a " +
        "name that picks the lag turns a caller bug into reassuring noise",
    );
    assert.equal(
      out.degraded,
      true,
      "a comparison the data would support was REFUSED — that is degraded, " +
        "not a clean empty",
    );
    // The name join is never reached: there are no presented rows to name.
    assert.equal(fake.ops().includes("usThirteenFFiling.findMany"), false);
  });

  /* ── The manager NAME, which this view returned as null for every holder ─── */

  it("names the holders instead of returning bare CIK strings, and an unknown stays NULL", async () => {
    // MUTATION 1: reverting `attachManagerNames([...held, ...exited])` to the
    // plain `[...held, ...exited]` turned this RED — every managerName null,
    // which is exactly what shipped: `fetch_us_13f_holders` is described as
    // returning "institutional holders" and returned CIK strings.
    //
    // MUTATION 2 (the join itself): keying `nameFor` on `managerCik10` instead
    // of `accession` turned the UNNAMED assertion RED — the row with no filing
    // was handed its neighbour's name. That is the defect class this case
    // exists for; "a name came back" alone would not have caught it.
    //
    // MUTATION 3: `nameFor.get(r.accession) ?? r.managerCik10` turned the same
    // assertion RED. An unknown name is not the CIK.
    armPeriods();
    armHoldings(
      [
        holdingRow({
          accession: "ACC-NAMED",
          managerCik10: "0001067983",
          valueUsd: 9_000_000,
        }),
        holdingRow({
          accession: "ACC-NO-FILING-ROW",
          managerCik10: "0000102909",
          valueUsd: 5_000_000,
        }),
      ],
      [],
    );
    // Only ONE of the two accessions has a filing row.
    armManagerNames({ "ACC-NAMED": "BERKSHIRE HATHAWAY INC" });

    const out = await getTopHolders({ symbol: "AAPL" });

    const named = out.rows.find((r) => r.managerCik10 === "0001067983");
    assert.ok(named, "the named manager is missing from the result");
    assert.equal(
      named.managerName,
      "BERKSHIRE HATHAWAY INC",
      "the issuer-side view must resolve the name the filing carries",
    );

    const unknown = out.rows.find((r) => r.managerCik10 === "0000102909");
    assert.ok(unknown, "the unnamed manager is missing from the result");
    assert.equal(
      unknown.managerName,
      null,
      'an absent filing row is UNKNOWN — never the CIK, never "", and never ' +
        "the other row's name",
    );

    // ONE join, not one per row. And it asks only about the PRESENTED rows.
    const joins = fake.argsFor("usThirteenFFiling.findMany");
    assert.equal(joins.length, 1, "the name join must not be per-row (N+1)");
    const asked = ((joins[0]?.where ?? {}) as { accession?: { in?: string[] } })
      .accession?.in;
    assert.deepEqual(
      [...(asked ?? [])].sort(),
      ["ACC-NAMED", "ACC-NO-FILING-ROW"],
      "the join is keyed on the accession each row cites, deduplicated",
    );
  });

  it("resolves names for the EXIT bucket too, off the prior filing", async () => {
    // An exit cites the PRIOR period's accession, so a join keyed on the
    // current period would leave every seller anonymous — and the seller is the
    // row a reader most wants named.
    armPeriods();
    armHoldings(
      [holdingRow({ accession: "ACC-CUR", managerCik10: "HOLDER" })],
      [
        holdingRow({
          accession: "ACC-PRIOR",
          managerCik10: "SELLER",
          periodOfReport: new Date(PRIOR_ISO),
        }),
      ],
    );
    armManagerNames({
      "ACC-CUR": "STILL HOLDING LLC",
      "ACC-PRIOR": "SOLD OUT CAPITAL LP",
    });

    const out = await getTopHolders({ symbol: "AAPL" });
    const seller = out.rows.find((r) => r.isExited);
    assert.ok(seller, "the exit is missing");
    assert.equal(seller.managerName, "SOLD OUT CAPITAL LP");
    assert.equal(
      out.rows.find((r) => !r.isExited)?.managerName,
      "STILL HOLDING LLC",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   5. getManagerHoldings — HOT, COLD, and the failure that must not read empty
   ═══════════════════════════════════════════════════════════════════════ */

const COLD_PERIOD = new Date("2024-03-31T00:00:00.000Z");

function coldShardRows(): UsHoldingRow[] {
  return [
    {
      accession: "COLD-ACC",
      rowIndex: 0,
      managerCik10: "0001067983",
      managerName: null,
      periodOfReport: COLD_PERIOD,
      filedAt: new Date("2024-05-15T00:00:00.000Z"),
      cusip: "037833100",
      figi: "BBG000B9XRY4",
      issuerName: "Apple Inc.",
      titleOfClass: "COM",
      valueUsd: 135_360_000_000,
      shares: 789_368_450,
      sharesType: "SH",
      putCall: null,
      symbol: "AAPL",
      currency: "USD",
    },
  ];
}

function armColdFiling(): void {
  fake.on("usThirteenFFiling.findMany", () => [
    {
      accession: "COLD-ACC",
      filedAt: new Date("2024-05-15T00:00:00.000Z"),
      isAmendment: false,
      amendmentType: null,
      tier: "COLD",
      coldPath: "edgar/13f/0001067983/2024-03-31",
      managerName: "BERKSHIRE HATHAWAY INC",
    },
  ]);
  fake.on("usThirteenFHolding.findMany", () => []);
}

describe("getManagerHoldings", () => {
  it("reads a COLD quarter from the shard and merges it in", async () => {
    armColdFiling();
    const store: UsColdStore = {
      get: async (key) => {
        assert.equal(key, "edgar/13f/0001067983/2024-03-31");
        return encodeThirteenFShard(coldShardRows());
      },
    };
    setUsColdStore(store);

    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(out.origin, "COLD");
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.cusip, "037833100");
    assert.equal(out.rows[0]?.valueUsd, 135_360_000_000);
    assert.equal(out.rows[0]?.currency, "USD");
    assert.equal(
      out.rows[0]?.managerName,
      "BERKSHIRE HATHAWAY INC",
      "the cover page's name backfills a shard row that lacks one",
    );
    assert.equal(out.degraded, false);
    assert.equal(out.reason, null);
  });

  it("a FAILED cold read is reported as FAILED, never as an empty portfolio", async () => {
    // MUTATION: changing the `cold.status === "failed"` branch to fall through
    // (i.e. treating a throw as "absent") turned this RED — `reason` came back
    // as COLD_STORE_NOT_REGISTERED and the result no longer named a failure.
    // Separately, making `readThirteenFColdShard` return
    // `{ status: "present", rows: [] }` on a caught error turned it RED with
    // `degraded === false`. Both restored byte-identically.
    armColdFiling();
    setUsColdStore({
      get: async () => {
        throw new Error("503 from GCS");
      },
    });

    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(out.reason, REASON_COLD_READ_FAILED);
    assert.equal(out.degraded, true);
    assert.deepEqual(out.rows, [], "we have nothing to show…");
    assert.notEqual(
      out.reason,
      REASON_NO_ROWS,
      "…but 'we could not read it' must never be spelled 'this manager holds nothing'",
    );
  });

  it("corrupt shard bytes are a FAILURE, not an empty quarter", async () => {
    armColdFiling();
    setUsColdStore({ get: async () => Buffer.from("this is not gzip") });
    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(out.reason, REASON_COLD_READ_FAILED);
    assert.equal(out.degraded, true);
  });

  it("a cold failure degrades the result EVEN WHEN the hot half answered", async () => {
    // MUTATION: neutering the `cold.status === "failed"` branch (`if (false)`)
    // left this RED — the result came back `degraded: false, reason: null`
    // while carrying only the hot half. A partial answer that does not say it
    // is partial is worse than an empty one: nothing about it looks wrong.
    // Restored byte-identically.
    fake.on("usThirteenFFiling.findMany", () => [
      {
        accession: "COLD-ACC",
        filedAt: new Date("2024-05-15T00:00:00.000Z"),
        isAmendment: false,
        amendmentType: null,
        tier: "COLD",
        coldPath: "edgar/13f/0001067983/2024-03-31",
        managerName: "BERKSHIRE HATHAWAY INC",
      },
    ]);
    fake.on("usThirteenFHolding.findMany", () => [
      holdingRow({ accession: "COLD-ACC", periodOfReport: COLD_PERIOD }),
    ]);
    setUsColdStore({
      get: async () => {
        throw new Error("503 from GCS");
      },
    });

    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(out.rows.length, 1, "the hot row is real and is returned");
    assert.equal(out.degraded, true, "…and the caller is told it is a SUBSET");
    assert.equal(out.reason, REASON_COLD_READ_FAILED);
  });

  it("distinguishes an unregistered store from a shard that 404s", async () => {
    armColdFiling();
    const unregistered = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(unregistered.reason, REASON_COLD_STORE_UNREGISTERED);
    assert.equal(unregistered.degraded, true);

    // A registered store answering 404 for a shard the evictor claims to have
    // written is its OWN diagnosis — most likely the Python writer and this
    // reader disagree about the key's date segment, which would 404 on every
    // quarter forever and otherwise be indistinguishable from a cold miss.
    setUsColdStore({ get: async () => null });
    const absent = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(absent.reason, REASON_COLD_SHARD_ABSENT);
    assert.equal(absent.degraded, true);
    assert.notEqual(absent.reason, REASON_COLD_READ_FAILED);
  });

  it("a RESTATEMENT amendment queries only the amending accession", async () => {
    fake.on("usThirteenFFiling.findMany", () => [
      {
        accession: "ORIG",
        filedAt: new Date("2026-08-14T00:00:00.000Z"),
        isAmendment: false,
        amendmentType: null,
        tier: "HOT",
        coldPath: null,
        managerName: "Fake Capital",
      },
      {
        accession: "AMD",
        filedAt: new Date("2026-08-20T00:00:00.000Z"),
        isAmendment: true,
        amendmentType: "RESTATEMENT",
        tier: "HOT",
        coldPath: null,
        managerName: "Fake Capital",
      },
    ]);
    fake.on("usThirteenFHolding.findMany", () => [
      holdingRow({ accession: "AMD" }),
    ]);
    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: "2026-06-30T00:00:00.000Z",
    });
    assert.deepEqual(
      fake.wheresFor("usThirteenFHolding.findMany")[0]?.accession,
      {
        in: ["AMD"],
      },
    );
    assert.equal(out.rows.length, 1);
  });

  it("no filing for that period is its own reason", async () => {
    fake.on("usThirteenFFiling.findMany", () => []);
    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: "2026-06-30",
    });
    assert.equal(out.reason, REASON_NO_THIRTEENF_FILING);
    assert.equal(fake.ops().includes("usThirteenFHolding.findMany"), false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   6. 13D/G, filings, coverage
   ═══════════════════════════════════════════════════════════════════════ */

describe("getBeneficialOwners / getFilings / getFilerCoverage", () => {
  it("13D/G queries by subjectCik10 and preserves the structured-data flag", async () => {
    armAaplListing();
    fake.on("usBeneficialOwnership.findMany", () => [
      {
        accession: "0000000000-19-000001",
        rowIndex: 0,
        schedule: "13G",
        form: "SC 13G",
        isAmendment: false,
        subjectCik10: AAPL_CIK10,
        subjectName: "Apple Inc.",
        cusip: "037833100",
        symbol: "AAPL",
        filerCik10: "0000102909",
        filerName: "VANGUARD GROUP INC",
        percentOfClass: null,
        sharesOwned: null,
        typeOfReportingPerson: "IA",
        eventDate: null,
        filedAt: new Date("2019-02-11T00:00:00.000Z"),
        purposeText: null,
        hasStructuredData: false,
      },
    ]);
    const out = await getBeneficialOwners({ symbol: "AAPL" });
    assert.equal(
      fake.wheresFor("usBeneficialOwnership.findMany")[0]?.subjectCik10,
      AAPL_CIK10,
    );
    assert.equal(out.rows[0]?.hasStructuredData, false);
    assert.equal(
      out.rows[0]?.percentOfClass,
      null,
      "a pre-2024 filing's null percent means 'not machine-readable', not zero",
    );
  });

  it("getFilings normalises the form list and never sends an empty `in`", async () => {
    armAaplListing();
    fake.on("usFiling.findMany", () => [
      {
        accession: "0000320193-26-000106",
        cik10: AAPL_CIK10,
        form: "8-K",
        filedAt: new Date("2026-08-01T00:00:00.000Z"),
        acceptedAt: new Date("2026-07-31T21:53:00.000Z"),
        periodOfReport: null,
        items: ["2.02"],
        primaryDocument: "a8-k.htm",
        isXbrl: true,
        parseClass: "EIGHTK",
        status: "PARSED",
      },
    ]);
    const out = await getFilings({ symbol: "AAPL", forms: [" 8-k ", ""] });
    const where = fake.wheresFor("usFiling.findMany")[0] ?? {};
    assert.deepEqual(where.form, { in: ["8-K"] });
    assert.equal(
      out.rows[0]?.acceptedAt?.toISOString(),
      "2026-07-31T21:53:00.000Z",
    );
    assert.equal(out.rows[0]?.currency, "USD");

    fake.calls.length = 0;
    await getFilings({ symbol: "AAPL" });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        fake.wheresFor("usFiling.findMany")[0] ?? {},
        "form",
      ),
      false,
    );
  });

  it("coverage counts DISTINCT fiscal years, not rows", async () => {
    fake.on("usFiler.findMany", () => [
      { cik10: "A", eligibleForCoverage: true, fiscalYearsOnFile: 9 },
      { cik10: "B", eligibleForCoverage: true, fiscalYearsOnFile: 8 },
      { cik10: "C", eligibleForCoverage: false, fiscalYearsOnFile: 2 },
    ]);
    // Filer A has ONE fiscal year restated three times. A row count would call
    // that three years of coverage.
    fake.on("usFundamentals.groupBy", () => [
      { cik10: "A", fiscalYear: 2024 },
      { cik10: "B", fiscalYear: 2020 },
      { cik10: "B", fiscalYear: 2021 },
      { cik10: "B", fiscalYear: 2022 },
      { cik10: "B", fiscalYear: 2023 },
      { cik10: "B", fiscalYear: 2024 },
      { cik10: "C", fiscalYear: 2025 },
      { cik10: "C", fiscalYear: 2024 },
    ]);
    const out = await getFilerCoverage();
    assert.equal(out.eligible, 2);
    assert.equal(out.eligibleCovered, 1, "A holds one fiscal year, not three");
    assert.equal(out.pct, 50);
    assert.equal(out.ineligibleWithAllAvailable, 1);
    assert.deepEqual(fake.argsFor("usFundamentals.groupBy")[0]?.by, [
      "cik10",
      "fiscalYear",
    ]);
  });

  it("an empty universe never divides by zero", async () => {
    fake.on("usFiler.findMany", () => []);
    const out = await getFilerCoverage();
    assert.equal(out.pct, 100);
    assert.equal(Number.isNaN(out.pct), false);
    assert.equal(
      fake.ops().includes("usFundamentals.groupBy"),
      false,
      "no filers means no reason to scan the statements table",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   7. The cold store must be REGISTERED somewhere, or the whole tier is dead
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * MERGED IS NOT WIRED.
 *
 * `setUsColdStore` shipped with ZERO non-test callers: the definition, the
 * barrel export, and this file. With no registration `readThirteenFColdShard`
 * returns `absent` for every key, so the cold tier — three-state outcome,
 * deadline, codec, key builder, all of it — had never executed in any runtime.
 * The same defect had already been found twice on this branch, and
 * `candle-cold-store.test.ts` carries the identical assertion for candles.
 *
 * These read SOURCE TEXT rather than importing the worker: `workers/` is not a
 * dependency of `@usemoney/core` and must not become one — the arrow points the
 * other way. A text assertion is weaker than an execution, and it is the
 * strongest thing available from this side of the boundary.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const readRepo = (...parts: string[]): string =>
  readFileSync(join(REPO, ...parts), "utf8");

/**
 * Source with comments stripped — LINE comments before BLOCK comments.
 *
 * Reversed, a `//` line containing a `/*` opens a phantom block that runs to
 * the next `*` + `/` hundreds of lines away (MONEY-1143). Without stripping at
 * all, `includes("catch")` would match the PROSE explaining why there is no
 * catch, and a scan that fires on its own documentation gets deleted rather
 * than fixed.
 */
const codeOnly = (src: string): string =>
  src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the 13F cold store is registered in a real runtime (MONEY-979)", () => {
  const ADAPTER = ["workers", "src", "lib", "us-cold-store-gcs.ts"] as const;

  it("the worker registers the store at boot", () => {
    // MUTATION: deleting the `initUsColdStore();` line turns this RED, as does
    // deleting only the import (the FIRST assertion). An imported-but-uncalled
    // initialiser is exactly the shape that produced this finding.
    //
    // Both assertions read COMMENT-STRIPPED source, and the second matches a
    // whole trimmed LINE rather than a substring. A plain `includes()` over raw
    // text was satisfied by `// initUsColdStore();` AND by
    // `if (false) initUsColdStore();` — the two likeliest accidents, neither of
    // which registers anything. Stripping comments alone only fixes the first.
    const src = codeOnly(readRepo("workers", "src", "index.ts"));
    assert.ok(
      src.includes("initUsColdStore"),
      "workers/src/index.ts must import the 13F cold-store initialiser",
    );
    assert.ok(
      src.split("\n").some((line) => line.trim() === "initUsColdStore();"),
      "imported but not called at top level — `if (false) initUsColdStore();` " +
        "passes a plain includes()",
    );
  });

  it("the adapter calls setUsColdStore, in code and not in a comment", () => {
    const src = codeOnly(readRepo(...ADAPTER));
    assert.ok(
      /\bsetUsColdStore\s*\(/.test(src),
      "the adapter must actually register the port",
    );
  });

  it("[regression] the adapter NEVER catches — `failed` must not collapse into `absent`", () => {
    // `@usemoney/storage`'s downloadFile maps 404 -> null and RETHROWS
    // everything else, which is the entire port contract: null is an ANSWER
    // ("this quarter is not archived"), a throw is the ABSENCE of one. A catch
    // here would turn a credentials failure into an empty 13F portfolio — a
    // manager who sold everything, which is not visibly wrong. MONEY-941,
    // MONEY-1189 and MONEY-1126 are all this bug.
    const src = codeOnly(readRepo(...ADAPTER));
    assert.equal(
      /\bcatch\b/.test(src),
      false,
      "the adapter must not swallow a storage error — core needs the throw to " +
        "report COLD_SHARD_READ_FAILED instead of an empty portfolio",
    );
    assert.equal(
      /\btry\b/.test(src),
      false,
      "same reason: nothing here may intercept the throw",
    );
  });

  it("the port stays READ-ONLY and list-free", () => {
    // The shards are written by the PYTHON evictor. A `put` here would let a
    // TypeScript caller race it for the same key. A `list` would be worse:
    // `listFiles` FAILS OPEN to `[]` on an auth failure (MONEY-941), so a
    // listing is never proof of absence.
    const src = codeOnly(readRepo(...ADAPTER));
    assert.equal(/^\s*async put\s*\(/m.test(src), false);
    assert.equal(/\buploadFile\b/.test(src), false);
    assert.equal(/\blistFiles\b/.test(src), false);
  });

  it("nothing under apps/ registers the store — its downloadFile swallows errors", () => {
    // Not a style rule. `apps/web/lib/storage/gcp-client.ts` downloadFile
    // catches EVERY error, logs it and returns null — no 404 branch at all — so
    // an adapter built on it reports a storage outage as an empty portfolio.
    // The premise is asserted first: if that function is ever fixed, this test
    // fails pointing at the premise rather than silently enforcing a stale one.
    const webClient = codeOnly(
      readRepo("apps", "web", "lib", "storage", "gcp-client.ts"),
    );
    const downloadAt = webClient.indexOf("export async function downloadFile");
    assert.notEqual(downloadAt, -1, "apps/web still has its own downloadFile");
    const body = webClient.slice(downloadAt, downloadAt + 600);
    assert.ok(
      /catch\s*\([\s\S]*?return null;/.test(body),
      "PREMISE: apps/web's downloadFile returns null on ANY error. If this is " +
        "no longer true, revisit whether apps/web may register the port.",
    );
    assert.equal(
      /\bcode\b[\s\S]{0,80}===\s*404/.test(body),
      false,
      "PREMISE: it does not distinguish a 404 from a failure",
    );

    const offenders = registrationSites(join(REPO, "apps"));
    assert.deepEqual(
      offenders,
      [],
      "these files register the 13F cold store from apps/, where a storage " +
        "failure reads as an empty portfolio:\n  " +
        offenders.join("\n  "),
    );
  });
});

/** Non-test `.ts`/`.tsx` files under `dir` that call `setUsColdStore(`. */
function registrationSites(dir: string): string[] {
  const skip = new Set([
    "node_modules",
    "dist",
    ".next",
    ".turbo",
    "coverage",
    "vendor",
    "__tests__",
  ]);
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        if (
          /\bsetUsColdStore\s*\(/.test(codeOnly(readFileSync(full, "utf8")))
        ) {
          out.push(full.slice(REPO.length + 1));
        }
      }
    }
  };
  walk(dir);
  return out.sort();
}
