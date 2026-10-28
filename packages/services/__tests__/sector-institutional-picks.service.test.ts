/**
 * SERVICE TEST — sector institutional picks (MONEY-268).
 *
 * The card these back replaces two that were hidden because their data source
 * does not exist: `institutional_flows` is market-wide (8 rows on prod, no
 * `symbol` column), so "TOP FII PICK" could only ever have been a national
 * aggregate multiplied by an index weight and printed as a per-stock fact.
 * `institutional_deals` answers a narrower question truthfully, and this suite
 * is about keeping it truthful.
 *
 * The REAL functions with a hand-rolled fake prisma + cache injected through
 * `OwnershipSectionDeps`; `@usemoney/services` runs ESM, so every collaborator
 * goes through the deps seam and the assertions land on shipped code — the
 * exact `where` / `orderBy` / `take`, the cache key and TTL, and the envelope.
 *
 * The cases that carry the weight:
 *
 *   1. **Sign.** A flipped sign moves a seller onto the buy card. The sides are
 *      asserted independently AND jointly (nothing net-positive may appear in
 *      `sells`), because a flip that inverted BOTH lists would satisfy either
 *      assertion alone.
 *   2. **BigInt.** `Number(9007199254740993n)` is `9007199254740992` — it does
 *      not throw. `dealQtyToNumber` reports the loss instead of laundering it.
 *   3. **Determinism.** Equal nets must not reorder between requests; a card
 *      that reshuffles on refresh reads as live data that it is not.
 *   4. **Refusals.** A corrupt side and a non-finite price are SKIPPED, never
 *      defaulted — defaulting moves real rupees to the wrong list.
 *   5. **Empty is not an error, and is never cached.**
 *
 * Every window is driven by injected fixtures: no timers, no clock races.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateSectorInstitutionalPicks,
  dealQtyToNumber,
  getSectorInstitutionalPicks,
  type OwnershipSectionDeps,
  type SectorDealInput,
} from "../src/stock-sections-ownership.service";

type Rec = Record<string, unknown>;

const SECTOR = "Information Technology";
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** A deal row with everything defaulted except what the case is about. */
function deal(over: Partial<SectorDealInput> = {}): SectorDealInput {
  return {
    symbol: "INFY",
    securityName: "Infosys Limited",
    clientName: "SBI MUTUAL FUND",
    buySell: "BUY",
    qty: 1_000n,
    avgPrice: 100,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fake prisma
// ═══════════════════════════════════════════════════════════════════════════

interface DbCfg {
  /** Rows in `institutional_deals`, market-wide. */
  deals?: Array<Rec & { date: Date }>;
  /** Rows in `instrument_mappings`. */
  instruments?: Rec[];
  throwOn?: "institutionalDeal" | "instrumentMapping";
}

interface Calls {
  groupBy: Rec[];
  dealFindMany: Rec[];
  instrumentFindMany: Rec[];
}

interface CacheSet {
  module: unknown;
  scope: unknown;
  key: unknown;
  data: unknown;
  ttl: unknown;
}

function mkDeps(
  opts: { db?: DbCfg; cached?: unknown; isLive?: boolean } = {},
): {
  deps: OwnershipSectionDeps;
  calls: Calls;
  cacheGets: unknown[];
  cacheSets: CacheSet[];
} {
  const cfg = opts.db ?? {};
  const calls: Calls = {
    groupBy: [],
    dealFindMany: [],
    instrumentFindMany: [],
  };
  const cacheGets: unknown[] = [];
  const cacheSets: CacheSet[] = [];

  const db = {
    institutionalDeal: {
      /**
       * Groups and sorts for real, then applies `take` LAST.
       *
       * Order matters: Prisma runs `groupBy` in the database, so `take` selects
       * the top N GROUPS. A fake that sliced first would hand the service the
       * newest N ROWS instead, and the "seven sessions" window would silently
       * become "seven prints" — which on prod's ~120-prints-a-day feed is a
       * few hours, not a week, and every window assertion below would be
       * measuring the fake rather than the service.
       */
      groupBy: async (a: Rec) => {
        calls.groupBy.push(a);
        if (cfg.throwOn === "institutionalDeal")
          throw new Error("ECONNRESET mongodb://user:pw@host/secret");
        const counts = new Map<number, number>();
        for (const r of cfg.deals ?? []) {
          const t = r.date.getTime();
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const groups = [...counts.entries()]
          .sort((x, y) => y[0] - x[0])
          .map(([t, n]) => ({ date: new Date(t), _count: { _all: n } }));
        const take = Number(a.take ?? Number.MAX_SAFE_INTEGER);
        return groups.slice(0, take);
      },
      findMany: async (a: Rec) => {
        calls.dealFindMany.push(a);
        if (cfg.throwOn === "institutionalDeal")
          throw new Error("ECONNRESET mongodb://user:pw@host/secret");
        const where = a.where as
          | { symbol?: { in?: string[] }; date?: { gte?: Date } }
          | undefined;
        const inSet = where?.symbol?.in;
        const gte = where?.date?.gte;
        let rows = (cfg.deals ?? []).filter((r) => {
          if (inSet && !inSet.includes(String(r.symbol))) return false;
          if (gte instanceof Date && r.date.getTime() < gte.getTime())
            return false;
          return true;
        });
        const dir = (a.orderBy as { date?: string } | undefined)?.date;
        if (dir !== undefined) {
          rows = rows
            .slice()
            .sort((x, y) =>
              dir === "desc"
                ? y.date.getTime() - x.date.getTime()
                : x.date.getTime() - y.date.getTime(),
            );
        }
        return rows.slice(0, Number(a.take ?? Number.MAX_SAFE_INTEGER));
      },
    },
    instrumentMapping: {
      findMany: async (a: Rec) => {
        calls.instrumentFindMany.push(a);
        if (cfg.throwOn === "instrumentMapping")
          throw new Error("ECONNRESET mongodb://user:pw@host/secret");
        const where = a.where as { sector?: string } | undefined;
        return (cfg.instruments ?? []).filter(
          (r) => where?.sector === undefined || r.sector === where.sector,
        );
      },
    },
  };

  const deps = {
    prisma: db as unknown as NonNullable<OwnershipSectionDeps["prisma"]>,
    getCached: (async (_m: unknown, _s: unknown, key: unknown) => {
      cacheGets.push(key);
      return (opts.cached ?? null) as never;
    }) as unknown as NonNullable<OwnershipSectionDeps["getCached"]>,
    setCached: (async (
      module: unknown,
      scope: unknown,
      key: unknown,
      data: unknown,
      _filters: unknown,
      config?: { ttl?: unknown },
    ) => {
      cacheSets.push({ module, scope, key, data, ttl: config?.ttl });
    }) as unknown as NonNullable<OwnershipSectionDeps["setCached"]>,
    getNseMarketStatus: () => ({ isLive: opts.isLive ?? false }),
  } satisfies OwnershipSectionDeps;

  return { deps, calls, cacheGets, cacheSets };
}

function unwrap<T>(
  r: { success: true; data: T } | { success: false; error: string },
): T {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return (r as { success: true; data: T }).data;
}

/** Seven sessions of scaffolding so the window is never the thing under test. */
const SESSION_DAYS = [
  "2026-08-17",
  "2026-08-13",
  "2026-08-12",
  "2026-08-11",
  "2026-08-10",
  "2026-08-07",
  "2026-08-04",
].map(day);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The BigInt seam
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-268 — dealQtyToNumber", () => {
  it("is exact for every quantity this feed has ever carried", () => {
    // Prod's largest single print, 2026-08-19.
    assert.deepEqual(dealQtyToNumber(170_116_200n), {
      value: 170_116_200,
      exact: true,
    });
    assert.deepEqual(dealQtyToNumber(0n), { value: 0, exact: true });
  });

  it("reports the boundary exactly, on both sides", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 − 1
    assert.equal(dealQtyToNumber(max).exact, true);
    assert.equal(dealQtyToNumber(max + 1n).exact, false);
    assert.equal(dealQtyToNumber(-max).exact, true);
    assert.equal(dealQtyToNumber(-max - 1n).exact, false);
  });

  it("[regression] the loss it reports is REAL and silent without it", () => {
    // This is the whole reason the column is BigInt. `Number()` neither throws
    // nor round-trips here, so nothing else in the pipeline could notice.
    const beyond = 9_007_199_254_740_993n; // 2^53 + 1
    const { value, exact } = dealQtyToNumber(beyond);
    assert.equal(exact, false);
    assert.equal(value, 9_007_199_254_740_992);
    assert.notEqual(
      BigInt(value),
      beyond,
      "the conversion round-tripped — " +
        "then this test is not exercising the precision cliff at all",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The pure aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY-268 — aggregate: sign", () => {
  it("BUY adds and SELL subtracts", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", buySell: "BUY", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "B", buySell: "SELL", qty: 10n, avgPrice: 100 }),
    ]);
    assert.equal(r.buys.length, 1);
    assert.equal(r.sells.length, 1);
    assert.equal(r.buys[0]!.symbol, "A");
    assert.equal(r.buys[0]!.netValue, 1_000);
    assert.equal(r.sells[0]!.symbol, "B");
    assert.equal(r.sells[0]!.netValue, -1_000);
  });

  it("[regression] a net seller never appears on the BUY card", () => {
    // The joint form. A sign flip that inverted BOTH lists would still satisfy
    // the case above; it cannot satisfy this one.
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", buySell: "BUY", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "A", buySell: "SELL", qty: 30n, avgPrice: 100 }),
      deal({ symbol: "B", buySell: "SELL", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "B", buySell: "BUY", qty: 30n, avgPrice: 100 }),
    ]);
    for (const row of r.buys)
      assert.ok(
        row.netValue > 0,
        `${row.symbol} on buys with net ${row.netValue}`,
      );
    for (const row of r.sells)
      assert.ok(
        row.netValue < 0,
        `${row.symbol} on sells with net ${row.netValue}`,
      );
    assert.deepEqual(
      r.buys.map((x) => x.symbol),
      ["B"],
    );
    assert.deepEqual(
      r.sells.map((x) => x.symbol),
      ["A"],
    );
  });

  it("the `B` / `S` abbreviations the raw files carry are honoured", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", buySell: "b", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "B", buySell: " s ", qty: 10n, avgPrice: 100 }),
    ]);
    assert.equal(r.buys[0]?.symbol, "A");
    assert.equal(r.sells[0]?.symbol, "B");
  });

  it("[regression] a corrupt side is SKIPPED, not defaulted to one direction", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", buySell: "", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "A", buySell: "???", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "A", buySell: "BUY", qty: 10n, avgPrice: 100 }),
    ]);
    assert.equal(r.buys.length, 1);
    assert.equal(
      r.buys[0]!.netValue,
      1_000,
      "a skipped row leaked into the sum",
    );
    assert.equal(r.buys[0]!.dealCount, 1, "a skipped row was still counted");
    assert.equal(r.sells.length, 0);
  });

  it("[regression] a non-finite price is skipped rather than poisoning the sum", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", avgPrice: Number.NaN, qty: 10n }),
      deal({ symbol: "A", avgPrice: 100, qty: 10n }),
    ]);
    assert.equal(r.buys.length, 1);
    assert.equal(
      r.buys[0]!.netValue,
      1_000,
      "one NaN made the whole symbol's net NaN — it sorts unpredictably " +
        "rather than loudly, so nothing downstream would have noticed",
    );
  });
});

describe("MONEY-268 — aggregate: grouping", () => {
  it("prints net per SYMBOL across clients, sides and days", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({
        symbol: "A",
        clientName: "X",
        buySell: "BUY",
        qty: 100n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "Y",
        buySell: "SELL",
        qty: 40n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "Y",
        buySell: "BUY",
        qty: 10n,
        avgPrice: 10,
      }),
    ]);
    assert.equal(r.buys.length, 1);
    assert.equal(r.buys[0]!.netValue, 1_000 - 400 + 100);
    assert.equal(r.buys[0]!.dealCount, 3);
  });

  it("keeps the first NON-EMPTY security name", () => {
    // `securityName` defaults to "" when the exchange file drops the column; an
    // empty string must not overwrite a real one, in either arrival order.
    const forward = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", securityName: "" }),
      deal({ symbol: "A", securityName: "Alpha Ltd" }),
    ]);
    assert.equal(forward.buys[0]!.securityName, "Alpha Ltd");
    const reverse = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", securityName: "Alpha Ltd" }),
      deal({ symbol: "A", securityName: "" }),
    ]);
    assert.equal(reverse.buys[0]!.securityName, "Alpha Ltd");
  });

  it("a symbol whose prints cancelled appears on NEITHER card", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", buySell: "BUY", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "A", buySell: "SELL", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "B", buySell: "BUY", qty: 10n, avgPrice: 100 }),
    ]);
    assert.deepEqual(
      r.buys.map((x) => x.symbol),
      ["B"],
    );
    assert.deepEqual(
      r.sells.map((x) => x.symbol),
      [],
    );
  });

  it("a sub-rupee residue is treated as float noise, not a direction", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", buySell: "BUY", qty: 1n, avgPrice: 100.0000001 }),
      deal({ symbol: "A", buySell: "SELL", qty: 1n, avgPrice: 100 }),
    ]);
    assert.equal(r.buys.length, 0);
    assert.equal(r.sells.length, 0);
  });
});

describe("MONEY-268 — aggregate: ordering and top-N", () => {
  const many = (n: number, sign: 1 | -1): SectorDealInput[] =>
    Array.from({ length: n }, (_, i) =>
      deal({
        symbol: `S${String(i).padStart(2, "0")}`,
        buySell: sign === 1 ? "BUY" : "SELL",
        qty: BigInt(i + 1),
        avgPrice: 1_000,
      }),
    );

  it("keeps the LARGEST five net buys, most positive first", () => {
    const r = aggregateSectorInstitutionalPicks(many(12, 1), { limit: 5 });
    assert.equal(r.buys.length, 5);
    assert.deepEqual(
      r.buys.map((x) => x.symbol),
      ["S11", "S10", "S09", "S08", "S07"],
    );
    for (let i = 1; i < r.buys.length; i++) {
      assert.ok(r.buys[i - 1]!.netValue >= r.buys[i]!.netValue);
    }
  });

  it("keeps the MOST NEGATIVE five net sells first", () => {
    const r = aggregateSectorInstitutionalPicks(many(12, -1), { limit: 5 });
    assert.equal(r.sells.length, 5);
    assert.deepEqual(
      r.sells.map((x) => x.symbol),
      ["S11", "S10", "S09", "S08", "S07"],
    );
    for (let i = 1; i < r.sells.length; i++) {
      assert.ok(
        r.sells[i - 1]!.netValue <= r.sells[i]!.netValue,
        "the sells card is ordered by magnitude, so the biggest seller is first",
      );
    }
  });

  it("[regression] equal nets break by symbol, not by arrival order", () => {
    const rows = ["DELTA", "ALPHA", "CHARLIE", "BRAVO"].map((s) =>
      deal({ symbol: s, qty: 10n, avgPrice: 100 }),
    );
    const forward = aggregateSectorInstitutionalPicks(rows, { limit: 4 });
    const reverse = aggregateSectorInstitutionalPicks(rows.slice().reverse(), {
      limit: 4,
    });
    assert.deepEqual(
      forward.buys.map((x) => x.symbol),
      ["ALPHA", "BRAVO", "CHARLIE", "DELTA"],
    );
    assert.deepEqual(
      forward.buys.map((x) => x.symbol),
      reverse.buys.map((x) => x.symbol),
      "the card reorders itself when the DB returns rows in a different " +
        "order — which reads as live data that it is not",
    );
  });

  it("a tie AT THE CUTOFF resolves deterministically too", () => {
    // Six equal nets into five slots: the dropped one must be the same one
    // every time, or the card silently rotates its last row.
    const rows = ["F", "E", "D", "C", "B", "A"].map((s) =>
      deal({ symbol: s, qty: 10n, avgPrice: 100 }),
    );
    const a = aggregateSectorInstitutionalPicks(rows, { limit: 5 });
    const b = aggregateSectorInstitutionalPicks(rows.slice().reverse(), {
      limit: 5,
    });
    assert.deepEqual(
      a.buys.map((x) => x.symbol),
      ["A", "B", "C", "D", "E"],
    );
    assert.deepEqual(
      a.buys.map((x) => x.symbol),
      b.buys.map((x) => x.symbol),
    );
  });
});

describe("MONEY-268 — aggregate: the dominant client and its chip", () => {
  it("names the counterparty with the largest |net|, not the most prints", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({
        symbol: "A",
        clientName: "GRAVITON RESEARCH CAPITAL LLP",
        qty: 1n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "GRAVITON RESEARCH CAPITAL LLP",
        qty: 1n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "GRAVITON RESEARCH CAPITAL LLP",
        qty: 1n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "SBI MUTUAL FUND",
        qty: 100n,
        avgPrice: 10,
      }),
    ]);
    assert.equal(r.buys[0]!.dominantClient, "SBI MUTUAL FUND");
    assert.equal(r.buys[0]!.clientClass, "DII");
  });

  it("|net| means magnitude — a big SELLER can dominate a net-buying symbol", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({
        symbol: "A",
        clientName: "SMALL BUYER",
        buySell: "BUY",
        qty: 300n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "ISHARES INDIA MAURITIUS CO",
        buySell: "SELL",
        qty: 200n,
        avgPrice: 10,
      }),
    ]);
    assert.equal(r.buys[0]!.netValue, 1_000);
    assert.equal(r.buys[0]!.dominantClient, "SMALL BUYER");
    // …and when the seller is the bigger leg, the chip follows the seller.
    const r2 = aggregateSectorInstitutionalPicks([
      deal({
        symbol: "A",
        clientName: "SMALL BUYER",
        buySell: "BUY",
        qty: 300n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "X",
        buySell: "BUY",
        qty: 300n,
        avgPrice: 10,
      }),
      deal({
        symbol: "A",
        clientName: "ISHARES INDIA MAURITIUS CO",
        buySell: "SELL",
        qty: 400n,
        avgPrice: 10,
      }),
    ]);
    assert.equal(r2.buys[0]!.dominantClient, "ISHARES INDIA MAURITIUS CO");
    assert.equal(r2.buys[0]!.clientClass, "FII");
  });

  it("[regression] equal-sized counterparties break by name", () => {
    const rows = [
      deal({ symbol: "A", clientName: "ZED CAPITAL", qty: 10n, avgPrice: 10 }),
      deal({ symbol: "A", clientName: "ACME CAPITAL", qty: 10n, avgPrice: 10 }),
    ];
    assert.equal(
      aggregateSectorInstitutionalPicks(rows).buys[0]!.dominantClient,
      "ACME CAPITAL",
    );
    assert.equal(
      aggregateSectorInstitutionalPicks(rows.slice().reverse()).buys[0]!
        .dominantClient,
      "ACME CAPITAL",
    );
  });

  it("[regression] an unrecognised counterparty is Institutional, never guessed", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", clientName: "HRTI PRIVATE LIMITED" }),
    ]);
    assert.equal(r.buys[0]!.clientClass, "INSTITUTIONAL");
  });
});

describe("MONEY-268 — aggregate: BigInt precision", () => {
  it("does not flag ordinary quantities", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", qty: 170_116_200n, avgPrice: 1 }),
    ]);
    assert.equal(r.qtyPrecisionLoss, false);
  });

  it("[regression] a quantity past 2^53 raises the flag", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", qty: 9_007_199_254_740_993n, avgPrice: 1 }),
    ]);
    assert.equal(
      r.qtyPrecisionLoss,
      true,
      "the conversion was inexact and nothing said so — which is exactly " +
        "what `Number(bigint)` does on its own",
    );
  });

  it("one inexact row flags the whole section, and the rest still aggregate", () => {
    const r = aggregateSectorInstitutionalPicks([
      deal({ symbol: "A", qty: 10n, avgPrice: 100 }),
      deal({ symbol: "B", qty: 9_007_199_254_740_993n, avgPrice: 1 }),
    ]);
    assert.equal(r.qtyPrecisionLoss, true);
    assert.equal(r.buys.length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The service
// ═══════════════════════════════════════════════════════════════════════════

const INSTRUMENTS = [
  { symbol: "INFY", sector: SECTOR },
  { symbol: "TCS", sector: SECTOR },
  { symbol: "WIPRO", sector: SECTOR },
  { symbol: "RELIANCE", sector: "Energy" },
];

function dealRow(over: Rec & { date: Date }): Rec & { date: Date } {
  return {
    symbol: "INFY",
    securityName: "Infosys",
    clientName: "SBI MUTUAL FUND",
    buySell: "BUY",
    qty: 1_000n,
    avgPrice: 100,
    ...over,
  };
}

describe("MONEY-268 — getSectorInstitutionalPicks: the queries", () => {
  it("the session window is the feed's last N DISTINCT DATES", async () => {
    // Ten sessions in the table, seven asked for. The window floor must be the
    // 7th newest date, not "seven days ago" and not the oldest row.
    const deals = SESSION_DAYS.concat(
      ["2026-08-03", "2026-07-30", "2026-07-21"].map(day),
    ).map((d) => dealRow({ date: d }));
    const { deps, calls } = mkDeps({
      db: { deals, instruments: INSTRUMENTS },
    });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );

    assert.equal(calls.groupBy[0]!.take, 7, "the groupBy must be bounded to N");
    assert.deepEqual(calls.groupBy[0]!.by, ["date"]);
    assert.deepEqual(calls.groupBy[0]!.orderBy, { date: "desc" });
    assert.equal(env.data.sessions, 7);
    assert.equal(env.data.toIso, "2026-08-17");
    assert.equal(env.data.fromIso, "2026-08-04");
    assert.deepEqual(
      (calls.dealFindMany[0]!.where as { date: { gte: Date } }).date.gte,
      day("2026-08-04"),
      "the deals read must be floored at the OLDEST session in the window",
    );
  });

  it("[regression] the window is MARKET-WIDE, not this sector's last N active days", async () => {
    // Only one recent print in this sector; the rest of the feed is busy. A
    // sector-scoped window would reach back to July and label it "this week".
    const deals = [
      ...SESSION_DAYS.map((d) => dealRow({ date: d, symbol: "RELIANCE" })),
      dealRow({ date: day("2026-07-21"), symbol: "INFY" }),
    ];
    const { deps } = mkDeps({ db: { deals, instruments: INSTRUMENTS } });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.equal(env.empty, true, "a July print was counted as this week's");
    assert.equal(env.data.fromIso, "2026-08-04");
  });

  it("constituents are read with the deep-dive's own predicate", async () => {
    const { deps, calls } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    await getSectorInstitutionalPicks({ sector: SECTOR }, deps);
    const where = calls.instrumentFindMany[0]!.where as Rec;
    // `exchange: NSE` keeps the ~278 dual-listed names from being counted
    // twice; `EQUITY` keeps ETFs out of a sector card. Both are the reasons the
    // deep-dive action carries the same predicate.
    assert.deepEqual(where, {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
      sector: SECTOR,
    });
    assert.ok(Number(calls.instrumentFindMany[0]!.take) > 0, "unbounded read");
  });

  it("only this sector's symbols reach the ranking", async () => {
    const deals = [
      ...SESSION_DAYS.map((d) =>
        dealRow({ date: d, symbol: "RELIANCE", qty: 100_000n }),
      ),
      dealRow({ date: day("2026-08-17"), symbol: "INFY" }),
    ];
    const { deps, calls } = mkDeps({ db: { deals, instruments: INSTRUMENTS } });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.deepEqual(
      (calls.dealFindMany[0]!.where as { symbol: { in: string[] } }).symbol.in,
      ["INFY", "TCS", "WIPRO"],
    );
    assert.deepEqual(
      env.data.buys.map((b) => b.symbol),
      ["INFY"],
    );
  });

  it("`sessions` is overridable and flows into the query", async () => {
    const { deps, calls } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR, sessions: 3 }, deps),
    );
    assert.equal(calls.groupBy[0]!.take, 3);
    assert.equal(env.data.sessions, 3);
    assert.equal(env.data.fromIso, "2026-08-12");
  });
});

describe("MONEY-268 — getSectorInstitutionalPicks: the envelope", () => {
  it("a populated sector is labelled with its source and newest session", async () => {
    const { deps } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.equal(env.empty, false);
    assert.equal(env.source, "NSE_DEALS");
    assert.equal(env.asOf, "2026-08-17");
    assert.equal(env.data.buys[0]!.symbol, "INFY");
    assert.equal(env.data.buys[0]!.dealCount, 7);
  });

  it("a sector with no prints is EMPTY, still carrying the window", async () => {
    // "No prints between 04 and 17 Aug" and "we could not establish a window"
    // are different statements; only the second is a reason to doubt the feed.
    const { deps } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) =>
          dealRow({ date: d, symbol: "RELIANCE" }),
        ),
        instruments: INSTRUMENTS,
      },
    });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(env.data.buys, []);
    assert.deepEqual(env.data.sells, []);
    assert.equal(env.data.fromIso, "2026-08-04");
    assert.equal(env.data.toIso, "2026-08-17");
  });

  it("an unknown sector is EMPTY, not an error", async () => {
    const { deps, calls } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    const r = await getSectorInstitutionalPicks({ sector: "Nonesuch" }, deps);
    const env = unwrap(r);
    assert.equal(env.empty, true);
    assert.equal(
      calls.dealFindMany.length,
      0,
      "with no constituents there is nothing to ask the deals table",
    );
  });

  it("an empty FEED yields null dates — distinguishable from an empty sector", async () => {
    const { deps } = mkDeps({ db: { deals: [], instruments: INSTRUMENTS } });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.equal(env.empty, true);
    assert.equal(env.data.sessions, 0);
    assert.equal(env.data.fromIso, null);
    assert.equal(env.data.toIso, null);
  });

  it("[regression] BigInt never reaches the wire", async () => {
    // `JSON.stringify` THROWS on a BigInt, so an uncoerced qty is a 500 at the
    // server/client boundary rather than a wrong number.
    const { deps } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.doesNotThrow(() => JSON.stringify(env));
  });
});

describe("MONEY-268 — getSectorInstitutionalPicks: caching", () => {
  it("reads and writes one key per sector and window, at the section's TTL", async () => {
    const { deps, cacheGets, cacheSets } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    await getSectorInstitutionalPicks({ sector: SECTOR }, deps);
    assert.deepEqual(cacheGets, [`sector-picks:${SECTOR}:7`]);
    assert.equal(cacheSets.length, 1);
    assert.equal(cacheSets[0]!.key, `sector-picks:${SECTOR}:7`);
    assert.equal(cacheSets[0]!.module, "discover");
    assert.equal(cacheSets[0]!.scope, "_global");
    // Closed market: the rolling EOD files do not change intraday.
    assert.equal(cacheSets[0]!.ttl, 6 * 60 * 60);
  });

  it("a shorter TTL applies while the market is live", async () => {
    const { deps, cacheSets } = mkDeps({
      isLive: true,
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    await getSectorInstitutionalPicks({ sector: SECTOR }, deps);
    assert.equal(cacheSets[0]!.ttl, 60 * 60);
  });

  it("the window is part of the key, so `sessions` cannot serve a stale span", async () => {
    const { deps, cacheGets } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    await getSectorInstitutionalPicks({ sector: SECTOR, sessions: 3 }, deps);
    assert.deepEqual(cacheGets, [`sector-picks:${SECTOR}:3`]);
  });

  it("[regression] an EMPTY section is never cached", async () => {
    // Standing rule: caching "couldn't determine" pins it for the TTL and makes
    // the next request lie. A sector's first print of the week must be visible.
    const { deps, cacheSets } = mkDeps({
      db: {
        deals: SESSION_DAYS.map((d) =>
          dealRow({ date: d, symbol: "RELIANCE" }),
        ),
        instruments: INSTRUMENTS,
      },
    });
    const env = unwrap(
      await getSectorInstitutionalPicks({ sector: SECTOR }, deps),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(cacheSets, []);
  });

  it("a cache hit short-circuits the database entirely", async () => {
    const { deps, calls } = mkDeps({
      cached: {
        data: { buys: [], sells: [] },
        source: "NSE_DEALS",
        asOf: null,
        empty: false,
      },
      db: {
        deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
        instruments: INSTRUMENTS,
      },
    });
    await getSectorInstitutionalPicks({ sector: SECTOR }, deps);
    assert.deepEqual(calls.groupBy, []);
    assert.deepEqual(calls.dealFindMany, []);
    assert.deepEqual(calls.instrumentFindMany, []);
  });
});

describe("MONEY-268 — getSectorInstitutionalPicks: failure", () => {
  for (const model of ["institutionalDeal", "instrumentMapping"] as const) {
    it(`a ${model} throw is a sanitised failure, not a leak`, async () => {
      const { deps } = mkDeps({
        db: {
          throwOn: model,
          deals: SESSION_DAYS.map((d) => dealRow({ date: d })),
          instruments: INSTRUMENTS,
        },
      });
      const r = await getSectorInstitutionalPicks({ sector: SECTOR }, deps);
      assert.equal(r.success, false);
      const msg = (r as { success: false; error: string }).error;
      assert.equal(msg, "Failed to load institutional deals");
      assert.doesNotMatch(msg, /mongodb|ECONNRESET|secret|pw@/i);
    });
  }
});
