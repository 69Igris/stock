/**
 * UNIT TEST — the widened exchange-fetch seam (MONEY-1085 / MONEY-1204 P0.2).
 *
 * `fetchExchangeAsset` grew optional per-call transport overrides so NSE's XBRL
 * filings could ride the archive seam instead of a bare `fetch()`. The Kite
 * exemption in `no-feed-fetch-bypass.test.ts` had written that exit ramp down in
 * advance ("widen the seam — optional headers + a caller-chosen 404 policy"),
 * and the condition attached to it is the thing this file exists to prove:
 * **additive**. Every existing caller passes no options and must be affected in
 * no way whatsoever.
 *
 * "Additive" is a claim about BEHAVIOUR, not about the diff, so the no-options
 * path is asserted header-by-header and value-by-value rather than by reading
 * the patch.
 *
 * The header merge in particular is not a convenience. `{...base, ...override}`
 * with `User-Agent` on one side and `user-agent` on the other does not replace —
 * `fetch` lowercases both and JOINS them with ", ", producing a single header
 * naming two different browsers. On a host that answers only browsers that is a
 * 403 with no local symptom.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  EXCHANGE_FETCH_TIMEOUT_MS,
  EXCHANGE_USER_AGENT,
  NSE_REFERER,
  fetchExchangeAsset,
  mergeExchangeHeaders,
} from "../../src/market-data/exchange-feed";
import {
  getFeedAsset,
  setFeedArchiveStore,
} from "../../src/market-data/feed-archive";

const URL_UNDER_TEST = "https://nsearchives.nseindia.com/content/cm/x.csv.zip";
const XBRL_URL =
  "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_1_2_15112024100348.xml";

const realFetch = globalThis.fetch;

interface Recorded {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}
let calls: Recorded[] = [];

/**
 * Record the request as `fetch` ACTUALLY sees it.
 *
 * Headers are read back through `new Headers(...)`, which is the normalisation
 * the platform applies — so a duplicate-cased header shows up here exactly as
 * it would on the wire (joined with ", "), rather than being hidden by the
 * object literal.
 */
function stubFetch(status = 200, body = "BYTES"): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    // `HeadersInit` is a DOM lib type and packages/core compiles with
    // lib:ES2022 (it is a Node package). The undici Headers ctor takes the
    // same shape, so the cast was never load-bearing — MONEY-1118.
    new Headers(
      init?.headers as ConstructorParameters<typeof Headers>[0],
    ).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(url),
      headers,
      signal: init?.signal ?? undefined,
    });
    if (status === 404) return new Response(null, { status });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

/** A fetch that never resolves unless its signal aborts. */
function stubHangingFetch(): void {
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: {},
      signal: init?.signal ?? undefined,
    });
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  setFeedArchiveStore(null);
  delete process.env.FEED_ARCHIVE_MODE;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setFeedArchiveStore(null);
});

describe("mergeExchangeHeaders", () => {
  test("returns the SAME object when there is nothing to merge", () => {
    // Not merely equivalent to the old code path — identical to it. This is the
    // strongest possible statement of "existing callers are unaffected".
    const base = { "User-Agent": "UA", Referer: "R" };
    assert.equal(mergeExchangeHeaders(base), base);
    assert.equal(mergeExchangeHeaders(base, undefined), base);
  });

  test("replaces case-insensitively — never emits the header twice", () => {
    const merged = mergeExchangeHeaders(
      { "User-Agent": "windows-chrome", Accept: "text/csv" },
      { "user-agent": "mac-chrome" },
    );
    const names = Object.keys(merged).map((k) => k.toLowerCase());
    assert.deepEqual(names.sort(), ["accept", "user-agent"]);
    assert.equal(
      merged[Object.keys(merged).find((k) => /user-agent/i.test(k))!],
      "mac-chrome",
    );
  });

  test("the naive spread it replaces WOULD have emitted both", () => {
    // Pins the reason the helper exists. Without this the merge reads like
    // gold-plating and the next refactor collapses it back to a spread.
    const naive = {
      "User-Agent": "windows-chrome",
      "user-agent": "mac-chrome",
    };
    const onTheWire: string[] = [];
    new Headers(naive).forEach((v, k) => {
      if (k === "user-agent") onTheWire.push(v);
    });
    assert.deepEqual(onTheWire, ["windows-chrome, mac-chrome"]);
  });

  test("a null value DELETES a default header", () => {
    const merged = mergeExchangeHeaders(
      { Origin: "https://www.nseindia.com", Accept: "*/*" },
      { Origin: null },
    );
    assert.deepEqual(Object.keys(merged), ["Accept"]);
  });

  test("does not mutate the base object", () => {
    const base = { "User-Agent": "UA" };
    mergeExchangeHeaders(base, { "user-agent": "other", Extra: "x" });
    assert.deepEqual(base, { "User-Agent": "UA" });
  });
});

describe("fetchExchangeAsset — the no-options path is byte-for-byte unchanged", () => {
  test("sends exactly the five browser-impersonation headers", async () => {
    stubFetch();
    await fetchExchangeAsset(URL_UNDER_TEST, NSE_REFERER);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.headers, {
      "user-agent": EXCHANGE_USER_AGENT,
      referer: NSE_REFERER,
      origin: "https://www.nseindia.com",
      accept: "text/csv,application/zip,application/octet-stream,*/*",
      "accept-language": "en-US,en;q=0.9",
    });
  });

  test("still maps 404 to null and still throws on any other non-OK", async () => {
    stubFetch(404);
    assert.equal(await fetchExchangeAsset(URL_UNDER_TEST, NSE_REFERER), null);

    stubFetch(403);
    await assert.rejects(
      () => fetchExchangeAsset(URL_UNDER_TEST, NSE_REFERER),
      /Exchange fetch failed: 403/,
    );
  });

  test("still uses the 30 s default when no timeout is given", async () => {
    stubHangingFetch();
    const started = Date.now();
    const pending = fetchExchangeAsset(URL_UNDER_TEST, NSE_REFERER);
    // Not waited out — 30 s in a unit test is a hang, not a test. What is
    // asserted is that the signal is live and has NOT aborted early.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls[0]!.signal?.aborted, false);
    assert.ok(Date.now() - started < EXCHANGE_FETCH_TIMEOUT_MS);
    calls[0]!.signal!.dispatchEvent(new Event("abort"));
    await pending.catch(() => {});
  });
});

describe("fetchExchangeAsset — per-call overrides (MONEY-1204)", () => {
  test("reproduces the verified XBRL request, Origin included by its absence", async () => {
    stubFetch();
    await fetchExchangeAsset(
      XBRL_URL,
      "https://www.nseindia.com/companies-listing/corporate-filings-financial-results",
      {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0",
          accept: "application/xml,text/xml,*/*",
          Origin: null,
        },
      },
    );

    assert.deepEqual(calls[0]!.headers, {
      "user-agent": "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0",
      accept: "application/xml,text/xml,*/*",
      referer:
        "https://www.nseindia.com/companies-listing/corporate-filings-financial-results",
      "accept-language": "en-US,en;q=0.9",
    });
    assert.ok(!("origin" in calls[0]!.headers));
  });

  test("a page-level referer would have produced a path-bearing Origin", async () => {
    // Why `Origin: null` is a correctness fix and not taste: the seam derives
    // Origin as `referer.replace(/\/$/, "")`, which is only an origin when the
    // referer is one.
    stubFetch();
    await fetchExchangeAsset(XBRL_URL, "https://www.nseindia.com/deep/page");
    assert.equal(
      calls[0]!.headers.origin,
      "https://www.nseindia.com/deep/page",
    );
  });

  test("honours a shorter per-call timeout", async () => {
    stubHangingFetch();
    await assert.rejects(() =>
      fetchExchangeAsset(XBRL_URL, NSE_REFERER, { timeoutMs: 25 }),
    );
    assert.equal(calls[0]!.signal?.aborted, true);
  });
});

describe("getFeedAsset forwards transport options (MONEY-1204)", () => {
  test("passes headers and timeout straight through", async () => {
    stubFetch();
    await getFeedAsset(
      XBRL_URL,
      "https://www.nseindia.com/companies-listing/corporate-filings-financial-results",
      { exchange: "NSE", feed: "results-xbrl", date: new Date("2024-09-30") },
      undefined,
      {
        headers: { "user-agent": "mac-chrome", Origin: null },
        timeoutMs: 20_000,
      },
    );
    assert.equal(calls[0]!.headers["user-agent"], "mac-chrome");
    assert.ok(!("origin" in calls[0]!.headers));
  });

  test("omitting them leaves every existing caller on the defaults", async () => {
    stubFetch();
    await getFeedAsset(URL_UNDER_TEST, NSE_REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: new Date("2026-07-27"),
    });
    assert.equal(calls[0]!.headers["user-agent"], EXCHANGE_USER_AGENT);
    assert.equal(calls[0]!.headers.origin, "https://www.nseindia.com");
  });
});
