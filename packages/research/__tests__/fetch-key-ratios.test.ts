/**
 * MONEY-1060 (RC3/RC4) — fetch_key_ratios DB-first fallback.
 *
 * The tool previously hit LIVE sources only (Yahoo → Tickertape). When the
 * worker can't reach them it returned failed/empty. It now falls back to the
 * synced `StockRatios` row (via `getOrFetchRatios`) and, when the live source
 * threw AND the DB is also empty, reports success:false + metadata.sourceError
 * (source-down) instead of a silent empty-success.
 *
 * These tests import the REAL exported orchestrator `resolveKeyRatios` and the
 * REAL `dbRowToKeyRatios` mapper (de-shadow: the SAME code `execute` runs) and
 * inject fake live/DB fetchers — no network, no database.
 *
 * Source under test: packages/research/src/tools/fetch-key-ratios.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveKeyRatios,
  dbRowToKeyRatios,
  fetchKeyRatiosTool,
  fetchLiveRatios,
} from "../src/tools/fetch-key-ratios";
import type { KeyRatios } from "../src/types";

// A realistic synced StockRatios row (extra columns present, as Prisma returns).
const DB_ROW: Record<string, unknown> = {
  symbol: "TCS",
  exchange: "NSE",
  pe: 28.5,
  pb: 12.1,
  evToEbitda: 20.3,
  roe: 0.46,
  roa: 0.31,
  debtToEquity: 0.09,
  currentRatio: 2.5,
  dividendYield: 0.012,
  beta: 0.7,
  operatingMargin: 0.25,
  netMargin: 0.19,
  revenueGrowth: 0.07,
  earningsGrowth: 0.09,
  source: "TICKERTAPE",
};

describe("dbRowToKeyRatios — StockRatios row → KeyRatios", () => {
  it("returns null for a null/absent row", () => {
    assert.equal(dbRowToKeyRatios(null), null);
    assert.equal(dbRowToKeyRatios(undefined), null);
  });

  it("returns null when the row has no finite ratio figure", () => {
    assert.equal(
      dbRowToKeyRatios({ pe: null, pb: null, roe: undefined, marketCap: 100 }),
      null,
    );
    assert.equal(dbRowToKeyRatios({ pe: Number.NaN }), null);
  });

  it("maps the finite ratio fields and drops the rest", () => {
    const r = dbRowToKeyRatios(DB_ROW);
    assert.ok(r);
    assert.equal(r!.pe, 28.5);
    assert.equal(r!.roe, 0.46);
    assert.equal(r!.earningsGrowth, 0.09);
    // Non-KeyRatios columns are not copied through.
    assert.equal((r as Record<string, unknown>).source, undefined);
    assert.equal((r as Record<string, unknown>).symbol, undefined);
  });
});

describe("resolveKeyRatios — live-primary, DB fallback (RC3/RC4)", () => {
  it("returns live data and does NOT touch the DB when live succeeds", async () => {
    let dbCalls = 0;
    const out = await resolveKeyRatios(
      "TCS.NS",
      async () => ({
        data: { pe: 30 } as KeyRatios,
        metadata: { currentPrice: 100 },
      }),
      async () => {
        dbCalls++;
        return DB_ROW;
      },
    );
    assert.equal(out.success, true);
    assert.deepEqual(out.data, { pe: 30 });
    assert.equal(out.metadata?.currentPrice, 100);
    assert.equal(dbCalls, 0, "DB must not be queried when live succeeds");
  });

  it("RC3: live EMPTY → serves the DB row (success:true, fallback flagged, no sourceError)", async () => {
    const out = await resolveKeyRatios(
      "TCS.NS",
      async () => null,
      async () => DB_ROW,
    );
    assert.equal(out.success, true);
    assert.equal((out.data as KeyRatios).pe, 28.5);
    assert.equal(out.metadata?.fallback, true);
    assert.equal(out.metadata?.dbFirst, true);
    assert.equal(out.metadata?.source, "TICKERTAPE");
    assert.equal(out.metadata?.sourceError, undefined);
  });

  it("RC3+RC4: live THROWS but DB has the row → success:true WITH metadata.sourceError", async () => {
    const out = await resolveKeyRatios(
      "TCS.NS",
      async () => {
        throw new Error("Yahoo 429");
      },
      async () => DB_ROW,
    );
    assert.equal(out.success, true);
    assert.equal((out.data as KeyRatios).pe, 28.5);
    assert.equal(out.metadata?.fallback, true);
    assert.match(String(out.metadata?.sourceError), /Yahoo 429/);
  });

  it("RC4: live THROWS and DB empty → success:false with metadata.sourceError", async () => {
    const out = await resolveKeyRatios(
      "TCS.NS",
      async () => {
        throw new Error("Yahoo 429");
      },
      async () => null,
    );
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /Yahoo 429/);
    assert.match(String(out.metadata?.sourceError), /Yahoo 429/);
  });

  it("live empty + DB empty → success:false, no sourceError (genuine gap)", async () => {
    const out = await resolveKeyRatios(
      "TCS.NS",
      async () => null,
      async () => null,
    );
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /No ratios found for TCS\.NS/);
    assert.equal(out.metadata, undefined);
  });

  it("an all-null DB row is NOT served (maps to null → genuine gap)", async () => {
    const out = await resolveKeyRatios(
      "TCS.NS",
      async () => null,
      async () => ({
        symbol: "TCS",
        pe: null,
        roe: null,
        source: "TICKERTAPE",
      }),
    );
    assert.equal(out.success, false);
  });
});

// ── fetchLiveRatios — REAL swallow-path wiring (MONEY-1060 fix 1) ────────────
//
// Production `yahooFetchQuoteSummary` NEVER throws (it catches internally and
// returns null) and `withExchangeFallback` swallows thrown fetches too — the
// `onError` observer is the ONLY outage signal on the real path. The fakes
// below mirror that exact shape: RETURN EMPTY + call onError, never throw.

describe("fetchLiveRatios — swallow-path onError wiring", () => {
  it("summary empty + onError reported + chain empty → THROWS the captured error", async () => {
    await assert.rejects(
      fetchLiveRatios(
        "TCS.NS",
        async (_s, _m, opts) => {
          opts?.onError?.(new Error("Yahoo 429"), "fetchQuoteSummary:TCS.NS");
          return null; // swallow-shaped: null, NO throw — the real behavior
        },
        async () => null,
      ),
      /Yahoo 429/,
    );
  });

  it("end-to-end: swallow-shaped outage + empty DB → success:false + metadata.sourceError", async () => {
    const out = await resolveKeyRatios(
      "TCS.NS",
      () =>
        fetchLiveRatios(
          "TCS.NS",
          async (_s, _m, opts) => {
            opts?.onError?.(new Error("Yahoo 429"));
            return null;
          },
          async () => null,
        ),
      async () => null,
    );
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /Yahoo 429/);
    assert.match(String(out.metadata?.sourceError), /Yahoo 429/);
  });

  it("summary data → mapped ratios + analyst metadata; chain untouched", async () => {
    let chainCalls = 0;
    const live = await fetchLiveRatios(
      "TCS.NS",
      async () => ({
        defaultKeyStatistics: {
          trailingPE: { raw: 28 },
          priceToBook: { raw: 12 },
        },
        financialData: {
          returnOnEquity: { raw: 0.45 },
          currentPrice: { raw: 4100 },
          recommendationKey: "none",
        },
      }),
      async () => {
        chainCalls++;
        return null;
      },
    );
    assert.ok(live);
    const ratios = live!.data as KeyRatios;
    assert.equal(ratios.pe, 28);
    assert.equal(ratios.pb, 12);
    assert.equal(ratios.roe, 0.45);
    assert.equal(live!.metadata?.currentPrice, 4100);
    assert.equal(chainCalls, 0);
  });

  it("summary empty (no error) + chain data → chain fallback flagged", async () => {
    const live = await fetchLiveRatios(
      "TCS.NS",
      async () => null,
      async () => ({ source: "tickertape", data: { pe: 22 } }),
    );
    assert.ok(live);
    assert.deepEqual(live!.data, { pe: 22 });
    assert.equal(live!.metadata?.source, "tickertape");
    assert.equal(live!.metadata?.fallback, true);
  });

  it("summary empty (no error) + chain empty → null (genuine gap, no throw)", async () => {
    const live = await fetchLiveRatios(
      "TCS.NS",
      async () => null,
      async () => null,
    );
    assert.equal(live, null);
  });
});

describe("fetch_key_ratios tool — schema unchanged", () => {
  it("requires a symbol", async () => {
    const out = await fetchKeyRatiosTool.execute({});
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /symbol is required/);
  });
});
