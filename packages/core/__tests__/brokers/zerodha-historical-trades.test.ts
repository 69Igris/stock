/**
 * MONEY-837: ZerodhaClient.getHistoricalTrades — Kite Console/backoffice tradebook.
 *
 * Drives the REAL client against a mocked global.fetch to pin the behaviours the
 * doc describes and that nothing else tests:
 *   - async polling: state PENDING is re-polled until SUCCESS,
 *   - pagination: pages 1..total_pages are walked,
 *   - normalization: backoffice rows → NormalizedTrade (side/symbol/isin/value),
 *   - bounded FAILURE: repeated FAILURE throws (no infinite loop).
 *
 * The poll sleep is shortened via ZERODHA_BACKOFFICE_POLL_MS so the test is fast.
 *
 * Source: packages/core/src/brokers/clients/zerodha.ts (getHistoricalTrades)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ZerodhaClient } from "../../src/brokers/clients/zerodha";

function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const PENDING = {
  status: "success",
  data: { state: "PENDING", result: [], pagination: null },
};

const SEGMENTS = ["EQ"]; // single segment keeps the test focused + fast

describe("ZerodhaClient.getHistoricalTrades (Console/backoffice polling)", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.ZERODHA_BACKOFFICE_POLL_MS = "1";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.ZERODHA_BACKOFFICE_POLL_MS;
  });

  it("polls PENDING→SUCCESS, paginates total_pages, and normalizes rows", async () => {
    const row = (over: Record<string, unknown>) => ({
      trade_date: "2022-03-21",
      trade_type: "buy",
      quantity: 9,
      price: 3089.75,
      order_id: "O1",
      trade_id: "T1",
      series: "EQ",
      exchange: "NSE",
      segment: "EQ",
      order_execution_time: "2022-03-21T09:27:42",
      isin: "INE021A01026",
      tradingsymbol: "ASIANPAINT",
      ...over,
    });
    const page1 = {
      status: "success",
      data: {
        state: "SUCCESS",
        result: [row({})],
        pagination: { page: 1, per_page: 20, total_pages: 2, total: 2 },
      },
    };
    const page2 = {
      status: "success",
      data: {
        state: "SUCCESS",
        result: [
          row({
            trade_id: "T2",
            order_id: "O2",
            trade_type: "sell",
            price: 3100,
          }),
        ],
        pagination: { page: 2, per_page: 20, total_pages: 2, total: 2 },
      },
    };

    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("page=1")) {
        // PENDING on the FIRST poll of page 1, SUCCESS thereafter.
        const p1 = calls.filter((u) => u.includes("page=1")).length;
        return jsonOk(p1 === 1 ? PENDING : page1);
      }
      if (url.includes("page=2")) return jsonOk(page2);
      return jsonOk(PENDING);
    }) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    const trades = await client.getHistoricalTrades(
      new Date("2022-06-01T00:00:00Z"),
      new Date("2022-12-26T00:00:00Z"),
      SEGMENTS,
    );

    // both pages collected
    assert.equal(trades.length, 2);
    // normalization
    assert.equal(trades[0]!.tradeId, "T1");
    assert.equal(trades[0]!.orderId, "O1");
    assert.equal(trades[0]!.transactionType, "BUY");
    assert.equal(trades[0]!.symbol, "ASIANPAINT");
    assert.equal(trades[0]!.isin, "INE021A01026");
    assert.equal(trades[0]!.quantity, 9);
    assert.equal(trades[0]!.value, 9 * 3089.75);
    assert.equal(trades[1]!.tradeId, "T2");
    assert.equal(trades[1]!.transactionType, "SELL");
    // polled through PENDING (page 1 hit at least twice)
    assert.ok(calls.filter((u) => u.includes("page=1")).length >= 2);
    // correct endpoint + params
    assert.ok(calls[0]!.includes("/backoffice/tradebook"));
    assert.ok(calls[0]!.includes("segment=EQ"));
    assert.ok(calls[0]!.includes("from_date=2022-06-01"));
    assert.ok(calls[0]!.includes("to_date=2022-12-26"));
  });

  it("synthesizes a stable, distinct brokerTradeId when the backoffice omits trade_id", async () => {
    // MONEY-839: the Console/backoffice schema may expose NO trade_id (its field
    // names already differ from the day /trades endpoint — see 5f304542). Without
    // a synthesized id, every row would carry `tradeId: undefined`, persistTrades
    // upserts them all onto `brokerTradeId: undefined`, and Prisma throws on the
    // compound-unique where — collapsing the whole backfill (the 33-of-8553 bug).
    const baseRow = {
      trade_date: "2022-03-21",
      trade_type: "buy",
      exchange: "NSE",
      order_execution_time: "2022-03-21T09:27:42",
      tradingsymbol: "ASIANPAINT",
      // NOTE: deliberately NO trade_id / tradeId / id key
    };
    const rows = [
      { ...baseRow, quantity: 9, price: 3089.75, order_id: "O1" },
      { ...baseRow, quantity: 5, price: 3100, order_id: "O2" },
      {
        ...baseRow,
        quantity: 9,
        price: 3089.75,
        order_id: "O1",
        trade_type: "sell",
      },
    ];
    globalThis.fetch = (async () =>
      jsonOk({
        status: "success",
        data: {
          state: "SUCCESS",
          result: rows,
          pagination: { total_pages: 1 },
        },
      })) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    const trades = await client.getHistoricalTrades(
      new Date("2022-06-01T00:00:00Z"),
      new Date("2022-12-26T00:00:00Z"),
      SEGMENTS,
    );

    assert.equal(trades.length, 3);
    for (const t of trades) {
      // never undefined (→ persistTrades upsert can't throw) and clearly synthesized
      assert.ok(
        t.tradeId && t.tradeId.startsWith("bo:"),
        "a synthesized id must be present when trade_id is absent",
      );
    }
    // distinct fills → distinct ids (no upsert collapse onto a single key)
    assert.equal(new Set(trades.map((t) => t.tradeId)).size, 3);

    // idempotent: re-fetching the same rows yields identical ids, so a re-run of
    // the backfill upserts the same rows rather than duplicating them.
    const again = await client.getHistoricalTrades(
      new Date("2022-06-01T00:00:00Z"),
      new Date("2022-12-26T00:00:00Z"),
      SEGMENTS,
    );
    assert.deepEqual(
      again.map((t) => t.tradeId),
      trades.map((t) => t.tradeId),
    );
  });

  it("throws (does not loop forever) on repeated FAILURE", async () => {
    globalThis.fetch = (async () =>
      jsonOk({
        status: "success",
        data: { state: "FAILURE", result: [], pagination: null },
      })) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    await assert.rejects(
      () =>
        client.getHistoricalTrades(
          new Date("2022-06-01T00:00:00Z"),
          new Date("2022-06-02T00:00:00Z"),
          SEGMENTS,
        ),
      /FAILED/,
    );
  });

  it("returns [] when there are no historical trades", async () => {
    globalThis.fetch = (async () =>
      jsonOk({
        status: "success",
        data: {
          state: "SUCCESS",
          result: [],
          pagination: { page: 1, per_page: 20, total_pages: 1, total: 0 },
        },
      })) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    const trades = await client.getHistoricalTrades(
      new Date("2022-06-01T00:00:00Z"),
      new Date("2022-06-02T00:00:00Z"),
      SEGMENTS,
    );
    assert.deepEqual(trades, []);
  });

  it("MONEY-839: isolates a per-segment failure — keeps the segments that succeeded", async () => {
    // EQ → SUCCESS with one row; CD → 400 Bad Request. Must return EQ's trade,
    // NOT throw away the whole backfill (the live bug: a 400 on CD/COM zeroed
    // ~8.5k already-fetched EQ+FO trades).
    const eqRow = {
      trade_date: "2022-03-21",
      trade_type: "buy",
      quantity: 1,
      price: 100,
      order_id: "O1",
      trade_id: "T1",
      exchange: "NSE",
      tradingsymbol: "X",
      order_execution_time: "2022-03-21T09:27:42",
    };
    globalThis.fetch = (async (url: string) => {
      if (url.includes("segment=EQ")) {
        return jsonOk({
          status: "success",
          data: {
            state: "SUCCESS",
            result: [eqRow],
            pagination: { total_pages: 1 },
          },
        });
      }
      // CD (and anything else) → 400 (non-retryable → makeRequest throws).
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    const trades = await client.getHistoricalTrades(
      new Date("2022-06-01T00:00:00Z"),
      new Date("2022-06-02T00:00:00Z"),
      ["EQ", "CD"],
    );
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.tradeId, "T1");
  });

  it("MONEY-839: throws only when EVERY segment fails (surfaces a total outage)", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({}),
        text: async () => "",
      }) as unknown as Response) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    await assert.rejects(
      () =>
        client.getHistoricalTrades(
          new Date("2022-06-01T00:00:00Z"),
          new Date("2022-06-02T00:00:00Z"),
          ["EQ", "CD"],
        ),
      /400|Bad Request/,
    );
  });
});
