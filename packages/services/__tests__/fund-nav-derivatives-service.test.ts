/**
 * `getFundNavDerivatives` — the server-side NAV derivation both fund pages
 * consume (MONEY-1205).
 *
 * This math used to be a `useMemo` in `apps/web/app/mf/[schemeCode]/client.tsx`.
 * Being client-local had three consequences: `/etf/[symbol]` could not reach it
 * and hard-passed `navHigh={null} navLow={null} returnsInception={null}` for a
 * fund with a full NAV series; the two routes could disagree about the same
 * fund; and nothing tested it.
 *
 * The cache rule here is the load-bearing one. A COLD read has just queued the
 * backfill that fixes it, so caching "we have nothing" for six hours would turn
 * a transient gap into a shift-long one — the same reason
 * `getMfPortfolioSection` refuses to cache an empty disclosure.
 *
 * Source: packages/services/src/discover-market.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getFundNavDerivatives,
  type FundNavDerivativesDeps,
} from "../src/discover-market.service";

const DAY = 86_400_000;
const REF = new Date("2026-08-18T00:00:00Z");

/** A daily NAV series ending at REF, `years` long, rising linearly. */
function series(years: number, from = 100, to = 200) {
  const points: Array<{ date: string; nav: number }> = [];
  const n = Math.round(years * 365);
  for (let i = n; i >= 0; i--) {
    const d = new Date(REF.getTime() - i * DAY);
    points.push({
      date: d.toISOString().slice(0, 10),
      nav: from + ((to - from) * (n - i)) / Math.max(1, n),
    });
  }
  return points;
}

interface Spy {
  writes: Array<{ key: string; ttl: unknown }>;
  reads: string[];
}

function deps(
  points: Array<{ date: string; nav: number }>,
  opts: { storedRows?: number; cold?: boolean; cached?: unknown } = {},
): { d: FundNavDerivativesDeps; spy: Spy } {
  const spy: Spy = { writes: [], reads: [] };
  const d: FundNavDerivativesDeps = {
    readNavHistory: (async (schemeCode: string) => ({
      points,
      coverage: {
        schemeCode,
        storedRows: opts.storedRows ?? points.length,
        cold: opts.cold ?? points.length === 0,
      },
    })) as never,
    getCached: (async (_ns: string, _u: string, key: string) => {
      spy.reads.push(key);
      return (opts.cached ?? null) as never;
    }) as never,
    setCached: (async (
      _ns: string,
      _u: string,
      key: string,
      _v: unknown,
      _f: unknown,
      cfg?: { ttl?: number },
    ) => {
      spy.writes.push({ key, ttl: cfg?.ttl });
    }) as never,
  };
  return { d, spy };
}

describe("MONEY-1205 — getFundNavDerivatives", () => {
  it("derives the horizons a fund actually spans", async () => {
    const { d } = deps(series(6));
    const res = await getFundNavDerivatives({ schemeCode: "145648" }, d);
    assert.ok(res.success);
    assert.ok(res.data.derivatives.r1Y !== null);
    assert.ok(res.data.derivatives.r3Y !== null);
    assert.ok(res.data.derivatives.r5Y !== null);
    assert.ok(res.data.derivatives.high52 !== null);
  });

  it("[regression] reports WHY a horizon is null for a young fund", async () => {
    // 2.5 years of history: r5Y must be null AND the caller must be able to
    // tell that apart from "we failed to load anything".
    const { d } = deps(series(2.5));
    const res = await getFundNavDerivatives({ schemeCode: "145648" }, d);
    assert.ok(res.success);
    assert.equal(res.data.derivatives.r5Y, null);
    assert.ok(res.data.derivatives.dataPoints > 0);
    assert.ok((res.data.derivatives.coverageYears ?? 0) > 2.4);
    assert.equal(res.data.firstNavDate, series(2.5)[0].date);
  });

  it("[regression] reports the not-loaded state distinctly", async () => {
    const { d } = deps([], { storedRows: 0, cold: true });
    const res = await getFundNavDerivatives({ schemeCode: "145648" }, d);
    assert.ok(res.success);
    assert.equal(res.data.derivatives.dataPoints, 0);
    assert.equal(res.data.derivatives.coverageYears, null);
    assert.equal(res.data.cold, true);
    assert.equal(res.data.firstNavDate, null);
  });

  it("[regression] never caches an empty result", async () => {
    // The cold read just PUBLISHED the backfill that fills this in.
    const { d, spy } = deps([], { storedRows: 0, cold: true });
    await getFundNavDerivatives({ schemeCode: "145648" }, d);
    assert.deepEqual(
      spy.writes,
      [],
      "a queued backfill must not be masked for 6h",
    );
  });

  it("caches a real result under a scheme-scoped key", async () => {
    const { d, spy } = deps(series(3));
    await getFundNavDerivatives({ schemeCode: "145648" }, d);
    assert.equal(spy.writes.length, 1);
    assert.equal(spy.writes[0].key, "fund-nav-derivatives:145648");
    assert.equal(spy.writes[0].ttl, 6 * 60 * 60);
  });

  it("serves a cache hit without reading NAV history", async () => {
    let reads = 0;
    const { d } = deps(series(3), {
      cached: { derivatives: { dataPoints: 1 } },
    });
    const wrapped: FundNavDerivativesDeps = {
      ...d,
      readNavHistory: (async () => {
        reads += 1;
        throw new Error("must not be called");
      }) as never,
    };
    const res = await getFundNavDerivatives({ schemeCode: "145648" }, wrapped);
    assert.ok(res.success);
    assert.equal(reads, 0);
  });

  it("rejects a scheme code that is not one, before any query", async () => {
    let reads = 0;
    const { d } = deps([]);
    const wrapped: FundNavDerivativesDeps = {
      ...d,
      readNavHistory: (async () => {
        reads += 1;
        return {
          points: [],
          coverage: { schemeCode: "", storedRows: 0, cold: true },
        };
      }) as never,
    };
    assert.equal(
      (await getFundNavDerivatives({ schemeCode: "" }, wrapped)).success,
      false,
    );
    assert.equal(
      (await getFundNavDerivatives({ schemeCode: "x".repeat(25) }, wrapped))
        .success,
      false,
    );
    assert.equal(reads, 0);
  });

  it("a failed read is a failed result, never a fabricated zero", async () => {
    const { d } = deps([]);
    const wrapped: FundNavDerivativesDeps = {
      ...d,
      readNavHistory: (async () => {
        throw new Error("mongo down");
      }) as never,
    };
    const res = await getFundNavDerivatives({ schemeCode: "145648" }, wrapped);
    assert.equal(res.success, false);
  });
});
