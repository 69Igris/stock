/**
 * `/udf/history` through the real Hono app, against a fake tile store.
 * MONEY-1467 (A2).
 *
 * The store is faked and NOTHING else is: the route, the middleware chain, the
 * decode, the slicing and the header all execute. A test that faked the route's
 * own logic would assert its own mock.
 *
 * Every failure here is silent in the product — TradingView renders an empty
 * chart or spins forever, and never shows an error.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
// MONEY-1477 — the US licence gate needs a real signed token. The secret must
// be set before any handler verifies one.
import { bearer, TEST_SECRET } from "./helpers/mint";

process.env.MARKET_DATA_TOKEN_SECRET = TEST_SECRET;
import { resolveListing, inIndiaSession } from "../src/routes/history";
import {
  buildTilesFromBars,
  encodeTile,
  tileKey5y,
  tileKeyYear,
  type SourcedBar,
} from "@usemoney/core/market-data/tiles/tile-logic";
import {
  setTileStore,
  type TileStore,
} from "@usemoney/core/market-data/tiles/tile-store";

const app = createApp();

const DAY = 86_400;
/** Ascending daily bars ending at `lastIso`. */
function bars(n: number, lastIso: string, source = "BHAVCOPY"): SourcedBar[] {
  const last = Date.parse(lastIso);
  return Array.from({ length: n }, (_, i): SourcedBar => {
    const d = new Date(last - (n - 1 - i) * DAY * 1000);
    return {
      date: d,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000,
      source,
    };
  });
}

/** A store backed by a Map, plus a switch to make every read throw. */
function fakeStore(
  objects: Map<string, Buffer>,
  opts: { failing?: boolean } = {},
): TileStore {
  return {
    async get(key) {
      if (opts.failing) throw new Error("GCS credentials expired");
      return objects.get(key) ?? null;
    },
    async put(key, body) {
      objects.set(key, body);
    },
  };
}

function seedFiveY(
  listingId = "RELIANCE:NSE",
  barCount = 400,
): Map<string, Buffer> {
  const built = buildTilesFromBars(
    bars(barCount, "2026-09-11T00:00:00Z"),
    new Date("2026-09-12T00:00:00Z"),
    {
      market: "IN",
      listingId,
    },
  );
  const objects = new Map<string, Buffer>();
  objects.set(tileKey5y("IN", listingId), encodeTile(built.fiveY));
  for (const { year, tile } of built.years) {
    objects.set(tileKeyYear("IN", listingId, year), encodeTile(tile));
  }
  return objects;
}

test("the UDF symbol is EXCHANGE:SYMBOL and a listing id is SYMBOL:EXCHANGE", () => {
  // They are REVERSED. Getting it wrong produces a 404 that reads as "this
  // symbol has no history" rather than as a bug.
  // `kind` was added by MONEY-1478: a fund is neither an IN nor a US tile, and
  // a discriminated union is what stops the fund case being bolted on as a
  // special path the two endpoints then disagree about.
  assert.deepEqual(resolveListing("NSE:RELIANCE"), {
    kind: "tile",
    market: "IN",
    listingId: "RELIANCE:NSE",
  });
  assert.deepEqual(resolveListing("nse:reliance"), {
    kind: "tile",
    market: "IN",
    listingId: "RELIANCE:NSE",
  });
  assert.deepEqual(resolveListing("AAPL:NASDAQ:1980-12-12"), {
    kind: "tile",
    market: "US",
    listingId: "AAPL:NASDAQ:1980-12-12",
  });
  assert.equal(resolveListing("GARBAGE"), null);
  // This asserted `null` with "mutual funds are not tiles yet" until
  // MONEY-1478. They still are not TILES — they resolve to their OWN kind,
  // served from AMFI NAV. The union is what lets one resolver say that without
  // pretending a fund has an exchange.
  assert.deepEqual(resolveListing("MF:12345"), {
    kind: "fund",
    schemeCode: "12345",
  });
});

test("serves bars from the 5y tile, in seconds, with a CDN header", async () => {
  setTileStore(fakeStore(seedFiveY()));
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1600000000&to=1789000000",
  );
  assert.equal(res.status, 200);

  const cc = res.headers.get("cache-control") ?? "";
  assert.ok(
    cc.startsWith("public"),
    `a shared cache stores nothing without public: ${cc}`,
  );
  assert.match(cc, /s-maxage=\d+/);

  const body = (await res.json()) as { s: string; t: number[]; c: number[] };
  assert.equal(body.s, "ok");
  assert.ok(body.t.length > 0);
  assert.equal(body.t.length, body.c.length, "columns must be parallel");
  assert.ok(
    body.t.every((t) => t < 1e11),
    "SECONDS, never milliseconds",
  );
  // Ascending — the widget draws them in order and does not sort.
  assert.deepEqual(
    [...body.t].sort((a, b) => a - b),
    body.t,
  );
  setTileStore(null);
});

test("countback returns exactly N bars, overriding `from`", async () => {
  setTileStore(fakeStore(seedFiveY()));
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1788000000&to=1789000000&countback=120",
  );
  const body = (await res.json()) as { s: string; t: number[] };
  assert.equal(body.s, "ok");
  assert.equal(
    body.t.length,
    120,
    "a short initial load makes the chart re-request",
  );
  setTileStore(null);
});

test("a range with no bars answers no_data — and carries nextTime when one exists", async () => {
  setTileStore(fakeStore(seedFiveY()));
  // A window in the FUTURE: we hold older bars, so point the widget at them
  // rather than letting it step backwards one window at a time forever.
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1900000000&to=1900086400",
  );
  const body = (await res.json()) as { s: string; nextTime?: number };
  assert.equal(body.s, "no_data");
  assert.ok(
    typeof body.nextTime === "number" && body.nextTime > 0,
    "no nextTime = infinite spinner",
  );
  setTileStore(null);
});

test("a range older than all our history answers no_data WITHOUT nextTime", async () => {
  setTileStore(fakeStore(seedFiveY()));
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=100000&to=200000",
  );
  const body = (await res.json()) as { s: string; nextTime?: number };
  assert.equal(body.s, "no_data");
  // There is no OLDER bar to point at. Sending one sends the widget further
  // back — the same infinite loop by another route.
  assert.equal(body.nextTime, undefined);
  setTileStore(null);
});

test("a STORE OUTAGE is s:error, never s:no_data", async () => {
  // `no_data` renders as a blank chart with no message, indistinguishable from
  // a delisted instrument — so an outage would look like a data gap forever.
  setTileStore(fakeStore(new Map(), { failing: true }));
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1600000000&to=1789000000",
  );
  const body = (await res.json()) as { s: string; errmsg?: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg ?? "", /unavailable/i);
  // And it must NOT be cached — a cached outage outlives the outage.
  assert.equal(res.headers.get("cache-control"), "no-store");
  setTileStore(null);
});

test("an unknown symbol, a bad range and an intraday resolution are all s:error", async () => {
  setTileStore(fakeStore(seedFiveY()));
  const cases = [
    "/udf/history?symbol=GARBAGE&resolution=1D&from=1&to=2",
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1789000000&to=1600000000",
    // Milliseconds: finite, passes every other check, asks for a 55,000-year
    // window that quietly returns nothing.
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1600000000000&to=1789000000000",
    "/udf/history?symbol=NSE:RELIANCE&resolution=5&from=1600000000&to=1789000000",
  ];
  for (const path of cases) {
    const res = await app.request(path);
    const body = (await res.json()) as { s: string };
    assert.equal(body.s, "error", path);
  }
  setTileStore(null);
});

test("with no store registered the route answers, rather than throwing a 500", async () => {
  // A 500 is an infinite spinner. An unregistered store is the ordinary state
  // in local dev and before the first build.
  setTileStore(null);
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1600000000&to=1789000000",
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s: string };
  assert.equal(body.s, "no_data");
});

test("the India session window decides only the CDN TTL", () => {
  // 2026-09-15 is a Tuesday. 04:30Z = 10:00 IST (open); 12:00Z = 17:30 IST.
  assert.equal(inIndiaSession(new Date("2026-09-15T04:30:00Z")), true);
  assert.equal(inIndiaSession(new Date("2026-09-15T12:00:00Z")), false);
  // 2026-09-13 is a Sunday.
  assert.equal(inIndiaSession(new Date("2026-09-13T04:30:00Z")), false);
});

test("merging MULTIPLE year tiles keeps each bar with its OWN source", async () => {
  // The review's finding 4, and it was uncovered because no test seeded two
  // year tiles. Year tiles are prepended in ascending year order, so the merged
  // array is descending BY BLOCK; sorting `bars` alone and leaving `sources` in
  // merge order re-attributes every bar to some other bar's provenance. Both
  // arrays stay the right LENGTH, so no length check can see it.
  const listingId = "MULTIYEAR:NSE";
  const objects = new Map<string, Buffer>();

  // Three tiles, each with a DISTINCT source, so a mis-attribution is visible.
  const mk = (iso: string, source: string) =>
    buildTilesFromBars(
      [
        {
          date: new Date(iso),
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          source,
        },
      ],
      new Date("2026-09-12T00:00:00Z"),
      { market: "IN", listingId },
    );

  objects.set(
    tileKeyYear("IN", listingId, 2016),
    encodeTile(mk("2016-06-01T10:00:00Z", "YAHOO").years[0]!.tile),
  );
  objects.set(
    tileKeyYear("IN", listingId, 2017),
    encodeTile(mk("2017-06-01T10:00:00Z", "BHAVCOPY").years[0]!.tile),
  );
  objects.set(
    tileKey5y("IN", listingId),
    encodeTile(mk("2025-06-01T10:00:00Z", "TIINGO").fiveY),
  );

  setTileStore(fakeStore(objects));
  const res = await app.request(
    `/udf/history?symbol=NSE:MULTIYEAR&resolution=1D&from=1000000000&to=1789000000`,
  );
  const body = (await res.json()) as {
    s: string;
    t: number[];
    sources?: string[];
  };
  assert.equal(body.s, "ok");
  assert.equal(body.t.length, 3, "all three tiles merged");
  // Ascending by time...
  assert.deepEqual(
    [...body.t].sort((a, b) => a - b),
    body.t,
  );
  // ...and the sources must have travelled WITH their bars.
  assert.deepEqual(
    body.sources,
    ["YAHOO", "BHAVCOPY", "TIINGO"],
    "2016=YAHOO, 2017=BHAVCOPY, 2025=TIINGO — a mis-sorted parallel array puts them out of step",
  );
  setTileStore(null);
});

// ── MONEY-1477: the US licence gate covers DAILY, not only intraday ─────────
//
// It lived only inside `serveIntraday`, so US DAILY was served to anyone with
// the URL — `allUsers -> run.invoker` is granted on the LB, there is no Cloud
// Armor and no IAP. Tiingo COMMERCIAL is internal-use-only, so that is a
// licence breach answering 200.

test("US daily is REFUSED without a token", async () => {
  const res = await app.request(
    "/udf/history?symbol=AAPL:NASDAQ:1980-12-12&resolution=1D&from=0&to=9999999999",
  );
  // 200 with the UDF error shape, never a 401 — the widget cannot parse a
  // non-200 and renders nothing at all, so a status code would look like a
  // broken chart rather than a refused one.
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg ?? "", /not available on this account/);
  // A cached refusal would outlive the entitlement being granted.
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a VALID token WITHOUT the `us` claim is refused — a plan is not a licence", async () => {
  // THE LICENCE PROPERTY ITSELF, and a mutation proved it was untested: making
  // the gate accept any valid token (dropping `tokenMayReadUs`) left the whole
  // suite green. A PRO subscriber's token would then have read US daily OHLC.
  //
  // `US_MARKET_ALLOWED_EMAILS` defaults to the founder alone, so the claim is
  // set at MINT time by `currentUserMaySeeUsMarket` — it is a LICENCE, never
  // derived from the plan tier. One PlatformConfig write meant to unlock India
  // must not ship Tiingo's US series to every subscriber on that tier.
  const res = await app.request(
    "/udf/history?symbol=AAPL:NASDAQ:1980-12-12&resolution=1D&from=0&to=9999999999",
    { headers: bearer({ intraday: true }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg ?? "", /not available on this account/);
});

test("a token WITH the `us` claim passes the licence gate", async () => {
  // The other polarity: a gate that refuses everything is not a gate. No tile
  // store here, so it cannot be `ok` — but it must not be refused for the
  // LICENCE once the claim is present.
  const res = await app.request(
    "/udf/history?symbol=AAPL:NASDAQ:1980-12-12&resolution=1D&from=0&to=9999999999",
    { headers: bearer({ us: true }) },
  );
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.doesNotMatch(body.errmsg ?? "", /not available on this account/);
});

test("US INTRADAY is refused too — the gate is above the resolution split", async () => {
  // Placed per-branch is exactly how one of the two lanes ended up uncovered.
  const res = await app.request(
    "/udf/history?symbol=AAPL:NASDAQ:1980-12-12&resolution=5&from=0&to=9999999999",
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s?: string };
  assert.equal(body.s, "error");
});

test("INDIA daily stays PUBLIC — it is our own bhavcopy data", async () => {
  // The gate must be keyed on the LISTING'S MARKET, not applied to everything:
  // the smoke asserts "daily bars still need no token", and India data carries
  // no vendor redistribution limit.
  const res = await app.request(
    "/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=0&to=9999999999",
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.doesNotMatch(body.errmsg ?? "", /not available on this account/);
});
