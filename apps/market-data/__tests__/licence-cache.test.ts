/**
 * A LICENCE GATE IS UNDONE BY A `public` CACHE HEADER. MONEY-1478 review.
 *
 * MONEY-1477 put the `us` claim in front of US daily bars. The review of that
 * work found the gate was already defeated, not by a missing check but by the
 * header on the response the check had just allowed:
 *
 *   - Cloud CDN fronts this origin with `--cache-mode=USE_ORIGIN_HEADERS` and
 *     NO `--cache-key-include-http-header` (`setup-market-data-lb.sh`), so the
 *     cache key is scheme + host + path + query and carries NOTHING about the
 *     caller.
 *   - A successful US daily response took `cdnCacheControlForHistory(...)` =
 *     `public, s-maxage=3600, stale-while-revalidate=300`.
 *   - `/udf/history?symbol=AAPL:NASDAQ:1980-12-12&resolution=1D&from=X&to=Y`
 *     has no per-user component, so an anonymous client replays it verbatim.
 *
 * One entitled chart load would therefore publish an hour of Tiingo US OHLC to
 * anyone with the link — the redistribution MONEY-1262 has not bought, on the
 * exact lane MONEY-1477 was written to close.
 *
 * `history.test.ts` asserts the header on the REFUSAL and never on the SUCCESS,
 * which is why this survived that ticket's own tests. These cases assert the
 * ALLOWED path, for both markets, because the failure is invisible on the
 * refused one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { bearer, TEST_SECRET } from "./helpers/mint";

process.env.MARKET_DATA_TOKEN_SECRET = TEST_SECRET;

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createApp } from "../src/app";
import { CACHE_CONTROL } from "../src/app-logic";
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

function bars(n: number, lastIso: string): SourcedBar[] {
  const last = Date.parse(lastIso);
  return Array.from(
    { length: n },
    (_, i): SourcedBar => ({
      date: new Date(last - (n - 1 - i) * DAY * 1000),
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000,
      source: "TIINGO",
    }),
  );
}

function seed(market: "IN" | "US", listingId: string): TileStore {
  const built = buildTilesFromBars(
    bars(400, "2026-09-11T00:00:00Z"),
    new Date("2026-09-12T00:00:00Z"),
    { market, listingId },
  );
  const objects = new Map<string, Buffer>();
  objects.set(tileKey5y(market, listingId), encodeTile(built.fiveY));
  for (const { year, tile } of built.years) {
    objects.set(tileKeyYear(market, listingId, year), encodeTile(tile));
  }
  return {
    async get(key) {
      return objects.get(key) ?? null;
    },
    async put(key, body) {
      objects.set(key, body);
    },
  };
}

const US_ID = "AAPL:NASDAQ:1980-12-12";
const RANGE = "resolution=1D&from=0&to=9999999999";

test("a SUCCESSFUL US daily response is never shared-cacheable", async () => {
  setTileStore(seed("US", US_ID));
  try {
    const res = await app.request(
      `/udf/history?symbol=${encodeURIComponent(US_ID)}&${RANGE}`,
      { headers: bearer({ us: true }) },
    );
    const body = (await res.json()) as { s?: string; t?: number[] };
    // Prove we are on the ALLOWED path — a refusal would pass the header
    // assertions below for entirely the wrong reason, which is how this defect
    // stayed hidden behind the refusal-only tests.
    assert.equal(body.s, "ok", "this case must exercise a SERVED US response");
    assert.ok((body.t ?? []).length > 0, "it must actually carry bars");

    const cc = res.headers.get("cache-control") ?? "";
    assert.match(cc, /private/, `US must be private, got '${cc}'`);
    assert.doesNotMatch(
      cc,
      /public/,
      "`public` lets the CDN store an entitled response under a URL any " +
        "anonymous client can replay",
    );
    assert.doesNotMatch(
      cc,
      /s-maxage/,
      "`s-maxage` is the SHARED-cache directive — the one that matters here",
    );
  } finally {
    setTileStore(null);
  }
});

test("INDIA daily stays CDN-cacheable — the fix must not cost the edge", async () => {
  // The other polarity. A change that made everything private would pass the
  // case above and silently undo the whole point of this origin: India is our
  // own bhavcopy data and is deliberately public on this lane.
  setTileStore(seed("IN", "RELIANCE:NSE"));
  try {
    const res = await app.request(`/udf/history?symbol=NSE:RELIANCE&${RANGE}`);
    const body = (await res.json()) as { s?: string };
    assert.equal(body.s, "ok");
    const cc = res.headers.get("cache-control") ?? "";
    assert.match(cc, /public/, `India must stay public, got '${cc}'`);
    assert.match(cc, /s-maxage=\d+/);
  } finally {
    setTileStore(null);
  }
});

test("a US SYMBOL RESOLUTION is not shared-cached either", () => {
  // A SOURCE SCAN, and named as the weaker instrument it is: it proves the
  // header is set on the SUCCESS branch, not that the response carries it.
  //
  // It has to be. `/udf/symbols`' US success needs a `us_instruments` row and
  // these cases run with NO DATABASE, so a behavioural assertion here reaches
  // the "unknown symbol" return instead — and that path sets `no-store`, which
  // satisfies every header assertion for entirely the wrong reason. Measured:
  // deleting the override left a behavioural version of this case GREEN.
  //
  // So it asserts ORDER inside the US branch: the licensed header must be set
  // BEFORE the payload is built, which is the only arrangement that can reach
  // the response. The live payload is verified against PROD by
  // `market-data-smoke.sh`, which mints a real `us` token.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  const branch = src.slice(src.indexOf('if (listing.market === "US")'));
  const header = branch.indexOf("CACHE_CONTROL.licensed");
  const build = branch.indexOf("buildUsSymbolInfo({");
  assert.notEqual(header, -1, "the US success must set the licensed header");
  assert.notEqual(
    build,
    -1,
    "the US success branch was not found — did it move?",
  );
  assert.ok(
    header < build,
    "the licensed header must be set BEFORE the payload is built, or the " +
      "handler-level `public, s-maxage=300` survives on an entitled response",
  );
});

test("the handler-level default really is the shared-cache value", () => {
  // ANTI-VACUITY for the scan above. If `/udf/symbols` ever stopped defaulting
  // to a public value, the override would be dead weight and the scan would
  // keep passing while asserting nothing. This fails in that case instead.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  assert.match(
    src,
    /symbols\.get\("\/symbols"[\s\S]{0,200}CACHE_CONTROL\.symbols/,
    "the handler sets CACHE_CONTROL.symbols up front — that is what the US " +
      "branch has to override",
  );
  assert.match(CACHE_CONTROL.symbols, /public/);
});

test("an INDIA symbol resolution keeps the shared cache", async () => {
  const res = await app.request("/udf/symbols?symbol=NSE:RELIANCE");
  const cc = res.headers.get("cache-control") ?? "";
  // It may be `no-store` (no DB in this test, so the row lookup fails) or the
  // CDN value — what it must NEVER be is the licensed private value, which
  // would mean the US branch had swallowed India too.
  assert.doesNotMatch(
    cc,
    /private/,
    `India resolution must not be marked private, got '${cc}'`,
  );
});
