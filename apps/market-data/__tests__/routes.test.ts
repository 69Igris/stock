/**
 * The routes, exercised through the real Hono app.
 *
 * `app.request()` runs the full middleware chain without a socket, so these are
 * contract tests rather than a mock of one: a header set in the wrong
 * middleware, or a route that never mounted, fails here.
 *
 * The UDF contract is the thing worth pinning. TradingView's widget reads these
 * responses and renders an EMPTY CHART on a shape it does not understand —
 * never an error — so every one of these failures is silent in the product.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app";
import { runReadyChecks } from "../src/routes/health";
import { readyStatus } from "../src/app-logic";

const app = createApp();

test("/udf/config returns the datafeed config, publicly cacheable", async () => {
  const res = await app.request("/udf/config");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");

  const body = (await res.json()) as Record<string, unknown>;
  // The fields the widget actually reads. A missing `supported_resolutions`
  // makes every timeframe button inert with no console error.
  for (const field of [
    "supports_search",
    "supports_marks",
    "supported_resolutions",
    "exchanges",
  ]) {
    assert.ok(field in body, `UDF config is missing ${field}`);
  }
  assert.ok(Array.isArray(body.supported_resolutions));
  assert.ok((body.supported_resolutions as unknown[]).length > 0);
});

test("/udf/time returns SECONDS as plain text", async () => {
  const res = await app.request("/udf/time");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=1");

  const text = await res.text();
  assert.match(text, /^\d+$/, "the UDF spec reads this as text, not JSON");

  const seconds = Number(text);
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.ok(
    Math.abs(seconds - nowSeconds) < 5,
    `time is ${seconds}, expected ~${nowSeconds}`,
  );
  // MILLISECONDS would put the chart ~55,000 years in the future and render as
  // an empty chart rather than an error.
  assert.ok(seconds < 1e11, "must be seconds, not milliseconds");
});

test("the routes still awaiting their prompt answer 501, and are NOT cacheable", async () => {
  // `/udf/symbols` and `/udf/search` LEFT THIS LIST in MONEY-1476, and the
  // reason is the whole ticket: they stayed 501 while `/udf/history` was
  // completed, and flipping `MARKET_DATA_TILES` true on prod pointed every
  // chart at a service that could not resolve a symbol. TradingView calls
  // `resolveSymbol` FIRST, so every chart read "Symbol Error · invalid symbol"
  // while history served correctly. This test passed throughout — it was
  // asserting the outage as the contract.
  for (const path of ["/udf/marks"]) {
    const res = await app.request(path);
    assert.equal(
      res.status,
      501,
      `${path} should be 501 until its prompt lands`,
    );
    // A cached 501 outlives the deploy that implements the endpoint.
    assert.equal(res.headers.get("cache-control"), "no-store", path);

    const body = (await res.json()) as { s?: string; errmsg?: string };
    // The UDF ERROR shape, not `{ s: "no_data" }` — "no_data" means "this
    // symbol has no bars in this range", which the widget renders as a blank
    // chart with no message, indistinguishable from a delisted instrument.
    assert.equal(body.s, "error", path);
    assert.ok(
      body.errmsg && body.errmsg.length > 0,
      `${path} must say what is missing`,
    );
  }
});

test("/health/live does not touch dependencies", async () => {
  // A liveness probe that fails when Mongo is down makes Cloud Run kill and
  // restart every instance during a database incident — a degraded service
  // becomes no service.
  const res = await app.request("/health/live");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { status?: string };
  assert.equal(body.status, "ok");
});

test("readiness reports 503 when Mongo is down, with the dependency named", async () => {
  const results = await runReadyChecks({
    pingMongo: async () => {
      throw new Error("connection refused");
    },
    pingRedis: async () => "PONG",
  });
  assert.equal(readyStatus(results), 503);

  const mongo = results.find((r) => r.name === "mongo");
  assert.equal(mongo?.ok, false);
  assert.match(
    mongo?.detail ?? "",
    /connection refused/,
    "the probe must say WHICH dependency and why",
  );

  const redis = results.find((r) => r.name === "redis");
  assert.equal(redis?.ok, true, "one failure must not mask the other's result");
});

test("a HUNG dependency fails the budget rather than blocking the probe", async () => {
  // This is the case the budget exists for. Unbudgeted, the probe does not
  // fail — it BLOCKS, and the operator or probe waiting on it waits with it.
  const started = Date.now();
  const results = await runReadyChecks(
    {
      pingMongo: () => new Promise(() => {}), // never settles
      pingRedis: async () => "PONG",
    },
    50,
  );
  const elapsed = Date.now() - started;

  assert.equal(readyStatus(results), 503);
  assert.match(
    results.find((r) => r.name === "mongo")?.detail ?? "",
    /timeout/,
  );
  assert.ok(
    elapsed < 1000,
    `the probe returned in ${elapsed}ms rather than hanging`,
  );
});

test("the checks are STARTED together, so the worst case is one budget, not the sum", async () => {
  // A LOGICAL interlock, not a stopwatch. This assertion used to read
  // `elapsed < 220` for two 120ms budgets, and it measured the machine rather
  // than the code: under the full parallel build it read 782ms and failed an
  // implementation that is correct. Raising the ceiling would have made it
  // unable to fail at all, which is the worse of the two outcomes.
  //
  // So mongo's probe does not settle until redis's has been CALLED. A
  // sequential `await budgeted(mongo); await budgeted(redis)` can never call
  // redis, mongo burns its whole budget, and the result is 503 — on any
  // machine, at any load. Parallel resolves both immediately.
  let redisCalled!: () => void;
  const redisStarted = new Promise<void>((resolve) => {
    redisCalled = resolve;
  });

  const results = await runReadyChecks(
    {
      pingMongo: async () => {
        await redisStarted;
        return "ok";
      },
      pingRedis: async () => {
        redisCalled();
        return "PONG";
      },
    },
    500,
  );

  assert.equal(
    readyStatus(results),
    200,
    "mongo never saw redis start — the checks are being awaited one after the other",
  );
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true],
  );
});

test("an unknown path returns the UDF error shape, not an HTML 404", async () => {
  const res = await app.request("/nope");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { s?: string };
  assert.equal(body.s, "error");
});

test("every UNCACHED response carries a request id, and an inbound one is echoed", async () => {
  const fresh = await app.request("/health/live");
  assert.ok(
    fresh.headers.get("x-request-id"),
    "responses must be correlatable",
  );

  const echoed = await app.request("/health/live", {
    headers: { "x-request-id": "from-the-edge" },
  });
  assert.equal(
    echoed.headers.get("x-request-id"),
    "from-the-edge",
    "a trace started at the load balancer must stay one identity across the hop",
  );
});

test("a SHARED-CACHEABLE response carries NO request id", async () => {
  // Cloud CDN stores the origin's headers and replays them on every hit, so an
  // id on `public, max-age=3600` is handed to every caller for an hour — it
  // does not merely go stale, it correlates a reader's request to a stranger's.
  // Withheld rather than sent-and-hoped; the origin's own log line still has it.
  for (const path of ["/udf/config", "/udf/time"]) {
    const res = await app.request(path);
    const cc = res.headers.get("cache-control") ?? "";
    assert.ok(cc.includes("public"), `${path} is expected to be CDN-cacheable`);
    assert.equal(
      res.headers.get("x-request-id"),
      null,
      `${path} is cached by the CDN — an id here is replayed to every caller`,
    );
  }

  // And an INBOUND id must not sneak through on a cacheable route either: the
  // echo is the more tempting path to leave open, and it is the worse one —
  // the CDN would then serve one caller's own id back to everybody else.
  const echoed = await app.request("/udf/config", {
    headers: { "x-request-id": "caller-private-id" },
  });
  assert.equal(echoed.headers.get("x-request-id"), null);
});
