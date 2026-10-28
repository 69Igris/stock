/**
 * A chart must never be built on a datafeed that could not read `/config`.
 * MONEY-1481.
 *
 * ## THE BUG THIS EXISTS FOR
 *
 * TradingView's vendored `UDFCompatibleDatafeed` reads `/config` ONCE at
 * construction and maps ANY failure to `null`. It then silently adopts a config
 * HARDCODED in the bundle whose `supports_group_request` is TRUE, builds a
 * `SymbolsStorage`, and fetches `/udf/symbol_info?group=NYSE|FOREX|AMEX` — a
 * default exchange list with nothing to do with us. This origin serves no
 * `symbol_info`, so the storage fails to init and EVERY `resolveSymbol` rejects
 * "invalid symbol" for the life of the page.
 *
 * Measured in the browser, in this order:
 *
 *     /udf/config                   (failed)
 *     /udf/symbol_info?group=NYSE
 *     /udf/symbol_info?group=FOREX
 *     /udf/symbol_info?group=AMEX
 *     Series symbol resolve error: invalid symbol
 *
 * It is INTERMITTENT, which is what made it hard to see: when `/config` gets
 * through the chart is perfect, and when it does not that page load is dead.
 * Nothing server-side can observe it — the request that failed never arrived,
 * and `market-data-smoke.sh` passes 30/30 throughout.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { usableDatafeedBase } from "@/components/charts/TradingViewAdvancedChart";

const SERVICE = "https://market-data-qa.usemoney.ai/udf";
const LEGACY = "/api/market/udf";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string) => Promise<unknown>) {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    return impl(String(input));
  }) as typeof fetch;
  return () => calls;
}

const okConfig = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      supports_search: true,
      supports_group_request: false,
    }),
  });

describe("a healthy config keeps the service", () => {
  it("returns the service base and probes exactly once", async () => {
    const calls = stubFetch(okConfig);
    assert.equal(await usableDatafeedBase(SERVICE), SERVICE);
    assert.equal(calls(), 1, "a healthy probe must not retry");
  });

  it("a same-origin base is never probed at all", async () => {
    // `/api/market/udf` is served by the app itself; probing it would only
    // delay the very path that IS the fallback.
    const calls = stubFetch(() => {
      throw new Error("must not be called");
    });
    assert.equal(await usableDatafeedBase(LEGACY), LEGACY);
    assert.equal(calls(), 0);
  });
});

describe("an unreachable config falls back — but not on the first blip", () => {
  it("retries before giving up", async () => {
    // A single transient failure must NOT demote a user to the legacy route for
    // their whole session. That is the difference between a hiccup and an
    // outage, and the chart should not confuse them.
    const calls = stubFetch(() =>
      Promise.reject(new TypeError("Failed to fetch"))
    );
    assert.equal(await usableDatafeedBase(SERVICE), LEGACY);
    assert.equal(calls(), 3, "it must try three times before falling back");
  });

  it("recovers when a retry succeeds — no fallback", async () => {
    let n = 0;
    stubFetch(() => {
      n++;
      return n === 1 ? Promise.reject(new TypeError("blip")) : okConfig();
    });
    assert.equal(
      await usableDatafeedBase(SERVICE),
      SERVICE,
      "one blip must not cost the service"
    );
  });

  it("a non-2xx is a failure, not a config", async () => {
    stubFetch(() =>
      Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
    );
    assert.equal(await usableDatafeedBase(SERVICE), LEGACY);
  });
});

describe("a config that DEMANDS symbol_info is refused", () => {
  it("supports_group_request:true falls back", async () => {
    // The exact shape the broken state produces. A 200 is not enough: if the
    // datafeed would go on to request `/udf/symbol_info?group=NYSE`, this
    // origin cannot serve it and the chart is dead either way.
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          supports_search: false,
          supports_group_request: true,
        }),
      })
    );
    assert.equal(await usableDatafeedBase(SERVICE), LEGACY);
  });
});
