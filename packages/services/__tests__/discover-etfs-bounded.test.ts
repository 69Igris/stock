/**
 * `getETFs` — three defects on one function (MONEY-1205).
 *
 * 1. **The MF-master read had no `where` at all.** It pulled every row out of
 *    `mutual_fund_masters` — ~14,000 on prod — and then filtered them in JS
 *    against the ETF ISIN set to keep ~307. The predicate was always
 *    expressible as a query.
 * 2. **`limit` was accepted, folded into the CACHE KEY, and applied to
 *    nothing.** `getETFs({ limit: 20 })` returned every quoted ETF (510 on
 *    prod) under a cache entry that claims to hold 20.
 * 3. **A fund with no `latest_quote` row was silently dropped.** 544 active
 *    ETF/REIT/INVIT instruments, 510 quotes: 34 funds were invisible on the
 *    ETF surface with nothing to indicate anything was missing.
 *
 * `@usemoney/services` runs its suite as ESM with no `require.cache`
 * module-mocking, so this drives the REAL exported function through the `db` /
 * cache ports — which is also the only way to observe what query it issues.
 *
 * Source: packages/services/src/discover-market.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getETFs,
  type EtfInstrumentRow,
  type EtfListPorts,
  type EtfMasterRow,
  type EtfQuoteRow,
} from "../src/discover-market.service";

// ── Fixtures ────────────────────────────────────────────────────────────────

function instrument(n: number, withIsin = true): EtfInstrumentRow {
  return {
    id: `inst-${n}`,
    symbol: `ETF${n}`,
    name: `Fund ${n} ETF`,
    exchange: "NSE",
    yahooSymbol: `ETF${n}.NS`,
    isin: withIsin ? `INF00000${n}` : null,
  };
}

function quote(n: number): EtfQuoteRow {
  return {
    instrumentId: `inst-${n}`,
    price: 100 + n,
    change: n,
    changePercent: n,
    volume: 1_000 * n,
  };
}

interface Capture {
  instrumentArgs: Array<Record<string, unknown>>;
  masterArgs: Array<Record<string, unknown>>;
  cacheWrites: unknown[];
}

function ports(opts: {
  instruments: EtfInstrumentRow[];
  quotes: EtfQuoteRow[];
  masters?: EtfMasterRow[];
}): {
  db: EtfListPorts;
  capture: Capture;
  getCached: () => Promise<null>;
  setCached: (...args: unknown[]) => Promise<void>;
} {
  const capture: Capture = {
    instrumentArgs: [],
    masterArgs: [],
    cacheWrites: [],
  };
  const db: EtfListPorts = {
    instrumentMapping: {
      async findMany(args) {
        capture.instrumentArgs.push(args);
        const take = typeof args.take === "number" ? args.take : undefined;
        return take ? opts.instruments.slice(0, take) : opts.instruments;
      },
    },
    latestQuote: {
      async findMany() {
        return opts.quotes;
      },
    },
    mutualFundMaster: {
      async findMany(args) {
        capture.masterArgs.push(args);
        return opts.masters ?? [];
      },
    },
  };
  return {
    db,
    capture,
    getCached: async () => null,
    setCached: async (...args: unknown[]) => {
      capture.cacheWrites.push(args[3]);
    },
  };
}

/** The service's cache ports are structurally wider than these stubs. */
function deps(p: ReturnType<typeof ports>) {
  return {
    db: p.db,
    getCached: p.getCached as never,
    setCached: p.setCached as never,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MONEY-1205 — getETFs issues a bounded query", () => {
  it("[regression] the MF-master read is filtered by the ETF ISINs", async () => {
    const p = ports({
      instruments: [instrument(1), instrument(2)],
      quotes: [quote(1), quote(2)],
    });
    const res = await getETFs({ limit: 10 }, deps(p));
    assert.equal(res.success, true);

    assert.equal(p.capture.masterArgs.length, 1);
    const where = p.capture.masterArgs[0].where as
      | { OR?: Array<Record<string, unknown>> }
      | undefined;
    assert.ok(where, "a read of the whole scheme universe is not a filter");
    assert.deepEqual(where.OR, [
      { isinGrowth: { in: ["INF000001", "INF000002"] } },
      { isinDividend: { in: ["INF000001", "INF000002"] } },
    ]);
  });

  it("skips the master read entirely when no ETF has an ISIN", async () => {
    const p = ports({
      instruments: [instrument(1, false)],
      quotes: [quote(1)],
    });
    await getETFs(undefined, deps(p));
    assert.equal(p.capture.masterArgs.length, 0);
  });

  it("[regression] the instrument read is capped", async () => {
    const p = ports({ instruments: [instrument(1)], quotes: [quote(1)] });
    await getETFs(undefined, deps(p));
    const take = p.capture.instrumentArgs[0].take;
    assert.equal(
      typeof take,
      "number",
      "an uncapped findMany is a full scan waiting to happen",
    );
    assert.ok(
      (take as number) >= 544,
      "the cap must clear the real fund universe",
    );
  });

  it("[regression] `limit` actually limits", async () => {
    const many = Array.from({ length: 40 }, (_, i) => instrument(i + 1));
    const p = ports({
      instruments: many,
      quotes: many.map((_, i) => quote(i + 1)),
    });
    const res = await getETFs({ limit: 5 }, deps(p));
    assert.ok(res.success);
    assert.equal(res.data.length, 5);
    assert.equal(
      (p.capture.cacheWrites[0] as unknown[]).length,
      5,
      "the cached payload must match the key it is cached under",
    );
  });

  it("the limit is applied AFTER the sort", async () => {
    const many = [instrument(1), instrument(2), instrument(3)];
    const p = ports({
      instruments: many,
      // ETF3 moved most; it must survive a limit of 1.
      quotes: [quote(1), quote(2), quote(3)],
    });
    const res = await getETFs({ limit: 1, sortBy: "changePercent" }, deps(p));
    assert.ok(res.success);
    assert.equal(res.data[0].symbol, "ETF3");
  });
});

describe("MONEY-1205 — a quote-less fund is reported, not dropped", () => {
  it("[regression] it stays in the list with null price fields", async () => {
    const p = ports({
      instruments: [instrument(1), instrument(2)],
      quotes: [quote(1)], // ETF2 has no quote row
    });
    const res = await getETFs({ limit: 10 }, deps(p));
    assert.ok(res.success);
    assert.deepEqual(
      res.data.map((e) => e.symbol),
      ["ETF1", "ETF2"],
      "a listed fund with an unknown price is still a listed fund",
    );
    const missing = res.data.find((e) => e.symbol === "ETF2")!;
    assert.equal(missing.price, null);
    assert.equal(missing.change, null);
    assert.equal(missing.changePercent, null);
    assert.notEqual(
      missing.price,
      0,
      "0 is a price; null is the absence of one",
    );
  });

  it("an unknown change sorts LAST, not as a zero", async () => {
    const p = ports({
      instruments: [instrument(1), instrument(2), instrument(3)],
      quotes: [
        { ...quote(1), change: -0.2, changePercent: -0.2 },
        { ...quote(3), change: 4, changePercent: 4 },
      ],
    });
    const res = await getETFs({ limit: 10, sortBy: "changePercent" }, deps(p));
    assert.ok(res.success);
    assert.equal(
      res.data[res.data.length - 1].symbol,
      "ETF2",
      "a null must not park itself between two real movers",
    );
  });

  it("an unknown volume sorts last too", async () => {
    const p = ports({
      instruments: [instrument(1), instrument(2)],
      quotes: [{ ...quote(1), volume: 0 }],
    });
    const res = await getETFs({ limit: 10, sortBy: "volume" }, deps(p));
    assert.ok(res.success);
    assert.deepEqual(
      res.data.map((e) => e.symbol),
      ["ETF1", "ETF2"],
      "volume 0 is a measurement and outranks an unknown",
    );
  });
});

describe("MONEY-1205 — enrichment still lands on the right fund", () => {
  it("returns/AUM are matched by ISIN through both master columns", async () => {
    const p = ports({
      instruments: [instrument(1), instrument(2)],
      quotes: [quote(1), quote(2)],
      masters: [
        {
          isinGrowth: "INF000001",
          isinDividend: null,
          returns1Y: 11,
          returns3Y: 12,
          returns5Y: 13,
          aum: 1234,
        },
        {
          isinGrowth: null,
          isinDividend: "INF000002",
          returns1Y: 21,
          returns3Y: 22,
          returns5Y: 23,
          aum: 4321,
        },
      ],
    });
    const res = await getETFs({ limit: 10 }, deps(p));
    assert.ok(res.success);
    assert.equal(res.data.find((e) => e.symbol === "ETF1")!.aum, 1234);
    assert.equal(res.data.find((e) => e.symbol === "ETF2")!.returns5Y, 23);
  });
});
