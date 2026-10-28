/**
 * MONEY-848: ZerodhaClient.getHistoricalTrades — benign CD/COM-segment 400 skip.
 *
 * The Kite Console/backoffice tradebook 400s for a segment the account never
 * trades (the QA symptom: `segment=CD FAILED … 400 Bad Request` on EVERY window
 * of a cash-only Personal-tier account). That is an expected "no data for this
 * segment", NOT an outage. The existing per-segment isolation already kept the
 * segments that succeeded; this suite pins the REFINEMENT:
 *   - a single-segment 400 is logged at INFO ("no data for this account"),
 *     NOT at WARN (so a routine empty CD/COM book stops spamming the worker
 *     logs ~10× per connect across the year-by-year backfill windows), and the
 *     successful segments are still returned;
 *   - a NON-400 single-segment failure (timeout / 5xx) stays at WARN;
 *   - an all-segments outage still THROWS (unchanged total-outage safety net).
 *
 * Drives the REAL client against a mocked global.fetch (same seam as
 * zerodha-historical-trades.test.ts).
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

function httpErr(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

const EQ_OK = {
  status: "success",
  data: {
    state: "SUCCESS",
    result: [
      {
        trade_date: "2022-03-21",
        trade_type: "buy",
        quantity: 1,
        price: 100,
        order_id: "O1",
        trade_id: "T1",
        exchange: "NSE",
        tradingsymbol: "X",
        order_execution_time: "2022-03-21T09:27:42",
      },
    ],
    pagination: { total_pages: 1 },
  },
};

/** Capture console.info / console.warn lines for the duration of `fn`. */
async function captureConsole(
  fn: () => Promise<void>,
): Promise<{ infos: string[]; warns: string[] }> {
  const infos: string[] = [];
  const warns: string[] = [];
  const realInfo = console.info;
  const realWarn = console.warn;
  const realLog = console.log;
  console.info = (...a: unknown[]) => void infos.push(a.join(" "));
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  console.log = () => {}; // silence the per-segment success line
  try {
    await fn();
  } finally {
    console.info = realInfo;
    console.warn = realWarn;
    console.log = realLog;
  }
  return { infos, warns };
}

describe("ZerodhaClient.getHistoricalTrades — CD/COM benign 400 skip (MONEY-848)", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.ZERODHA_BACKOFFICE_POLL_MS = "1";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.ZERODHA_BACKOFFICE_POLL_MS;
  });

  it("a 400 on CD → INFO note (not WARN), and EQ's trades are still returned", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("segment=EQ")) return jsonOk(EQ_OK);
      return httpErr(400, "Bad Request"); // CD
    }) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);

    let trades: Awaited<ReturnType<typeof client.getHistoricalTrades>> = [];
    const { infos, warns } = await captureConsole(async () => {
      trades = await client.getHistoricalTrades(
        new Date("2022-06-01T00:00:00Z"),
        new Date("2022-06-02T00:00:00Z"),
        ["EQ", "CD"],
      );
    });

    // EQ kept
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.tradeId, "T1");
    // CD logged as a benign INFO note, NOT a WARN
    assert.ok(
      infos.some((l) => l.includes("segment=CD") && /no data/i.test(l)),
      `expected an INFO 'no data' note for CD; got infos=${JSON.stringify(infos)}`,
    );
    assert.ok(
      !warns.some((l) => l.includes("segment=CD")),
      `CD must NOT produce a WARN; got warns=${JSON.stringify(warns)}`,
    );
  });

  it("a NON-400 failure (500) on a segment stays a WARN (real problem)", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("segment=EQ")) return jsonOk(EQ_OK);
      return httpErr(500, "Internal Server Error"); // CD: genuine failure
    }) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);

    const { infos, warns } = await captureConsole(async () => {
      await client.getHistoricalTrades(
        new Date("2022-06-01T00:00:00Z"),
        new Date("2022-06-02T00:00:00Z"),
        ["EQ", "CD"],
      );
    });

    assert.ok(
      warns.some((l) => l.includes("segment=CD") && /FAILED/.test(l)),
      `a 500 must WARN; got warns=${JSON.stringify(warns)}`,
    );
    assert.ok(
      !infos.some((l) => l.includes("segment=CD") && /no data/i.test(l)),
      "a 500 must NOT be downgraded to a benign 'no data' note",
    );
  });

  it("all segments 400 → still THROWS (total-outage safety net unchanged)", async () => {
    globalThis.fetch = (async () =>
      httpErr(400, "Bad Request")) as unknown as typeof globalThis.fetch;

    const client = new ZerodhaClient({
      apiKey: "k",
      accessToken: "t",
    } as never);
    await captureConsole(async () => {
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
});
