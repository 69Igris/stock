/**
 * FUNCTIONAL TEST — the two whole-market corp-action fetchers actually CHUNK
 * (MONEY-1098 / P5.2).
 *
 * `corp-actions-window.test.ts` pins the boundary arithmetic in isolation. This
 * file pins that the arithmetic is WIRED: it stubs `globalThis.fetch` and reads
 * the date parameters off the URLs the fetchers really build, so a refactor that
 * keeps `splitDateWindows` green while silently reverting to one wide request
 * fails here.
 *
 *   - NSE `corporates-corporateActions` -> `from_date` / `to_date` (DD-MM-YYYY)
 *   - BSE `DefaultData/w`               -> `Fdate` / `TDate`      (dd MMM yyyy)
 *
 * NO NETWORK: every request is answered by the stub. `paceMs: 0` /
 * `CORP_ACTIONS_WINDOW_PACE_MS=0` skips the inter-window sleep entirely, so the
 * file arms no timers.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { fetchNSECorporateActionsBulkWindowed } from "../src/data-sources/corp-actions-window";
import { invalidateNseSession } from "../src/data-sources/nse-filings";
import { fetchBSECorporateActions } from "../src/data-sources/bse-client";

const utc = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d));

const realFetch = globalThis.fetch;
const prevPace = process.env.CORP_ACTIONS_WINDOW_PACE_MS;

/** Every URL the stub was asked for, in order. */
let requested: string[] = [];

const prevBackoff = process.env.NSE_RETRY_BACKOFF_MS;

before(() => {
  // Belt and braces: the NSE path takes its pace from the env (the call site in
  // the worker passes no override), so zero it for the whole file.
  process.env.CORP_ACTIONS_WINDOW_PACE_MS = "0";
  // The retry path is what these tests exercise; at the real 2s/4s backoff the
  // file would sleep for seconds and arm timers outliving the assertions.
  process.env.NSE_RETRY_BACKOFF_MS = "0";
});

after(() => {
  globalThis.fetch = realFetch;
  if (prevBackoff === undefined) delete process.env.NSE_RETRY_BACKOFF_MS;
  else process.env.NSE_RETRY_BACKOFF_MS = prevBackoff;
  if (prevPace === undefined) delete process.env.CORP_ACTIONS_WINDOW_PACE_MS;
  else process.env.CORP_ACTIONS_WINDOW_PACE_MS = prevPace;
});

beforeEach(() => {
  requested = [];
  // The session cache is module-level and survives between tests; a cookie left
  // by the previous case would hide the handshakes this file counts.
  invalidateNseSession();
});

/** Pull one query parameter out of a recorded URL. */
function param(url: string, key: string): string {
  return new URL(url).searchParams.get(key) ?? "";
}

// ── NSE ──────────────────────────────────────────────────────────────────────

/**
 * `nse-filings` talks HTTP through `ky`, which resolves `globalThis.fetch` at
 * request time — so a stub installed here is what it calls. It hands the stub a
 * real `Request`, hence the `url` read below.
 *
 * The stub also answers the cookie handshake (`GET https://www.nseindia.com`)
 * with a `set-cookie`, because `getSession()` runs before the first API call.
 */
function stubNse(rowsPerWindow: (from: string, to: string) => unknown[]): void {
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : ((input as { url: string }).url ?? String(input));
    requested.push(url);

    if (!url.includes("/api/")) {
      // Session handshake.
      return new Response("<html></html>", {
        status: 200,
        headers: { "set-cookie": "nsit=stub; Path=/" },
      });
    }
    const body = rowsPerWindow(param(url, "from_date"), param(url, "to_date"));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchNSECorporateActionsBulkWindowed", () => {
  it("splits a 20-year request into contiguous <=180-day windows", async () => {
    stubNse((from) => [
      {
        symbol: "RELIANCE",
        subject: "Dividend - Rs 10 Per Share",
        // Echo the window start back as the ex-date so each window contributes
        // a distinguishable row and we can prove concatenation order.
        exDate: from,
      },
    ]);

    const out = await fetchNSECorporateActionsBulkWindowed(
      utc(2005, 1, 1),
      utc(2024, 12, 31),
    );

    const apiCalls = requested.filter((u) =>
      u.includes("corporates-corporateActions"),
    );
    assert.strictEqual(apiCalls.length, 41, "7305 days / 180 = 41 windows");
    assert.strictEqual(
      out.rows.length,
      41,
      "every window's rows are concatenated",
    );
    assert.deepStrictEqual(out.failedWindows, [], "none of them failed");

    // First window starts at the requested `from`; last ends at the requested
    // `to`; every window abuts the previous one with no gap and no overlap.
    assert.strictEqual(param(apiCalls[0]!, "from_date"), "01-01-2005");
    assert.strictEqual(param(apiCalls.at(-1)!, "to_date"), "31-12-2024");

    const MS_PER_DAY = 86_400_000;
    const asDate = (ddmmyyyy: string): number => {
      const [d, m, y] = ddmmyyyy.split("-").map(Number);
      return Date.UTC(y!, m! - 1, d!);
    };
    for (let i = 1; i < apiCalls.length; i++) {
      assert.strictEqual(
        asDate(param(apiCalls[i]!, "from_date")),
        asDate(param(apiCalls[i - 1]!, "to_date")) + MS_PER_DAY,
        `window ${i} must start the day after window ${i - 1} ends`,
      );
    }
  });

  it("keeps a narrow range at exactly ONE request (no behaviour change)", async () => {
    stubNse(() => []);
    await fetchNSECorporateActionsBulkWindowed(
      utc(2026, 8, 1),
      utc(2026, 8, 8),
    );
    const apiCalls = requested.filter((u) =>
      u.includes("corporates-corporateActions"),
    );
    assert.strictEqual(apiCalls.length, 1);
    assert.strictEqual(param(apiCalls[0]!, "from_date"), "01-08-2026");
    assert.strictEqual(param(apiCalls[0]!, "to_date"), "08-08-2026");
  });

  it("accepts pre-formatted DD-MM-YYYY strings and still chunks them", async () => {
    stubNse(() => []);
    await fetchNSECorporateActionsBulkWindowed("01-01-2024", "31-12-2024");
    const apiCalls = requested.filter((u) =>
      u.includes("corporates-corporateActions"),
    );
    assert.strictEqual(apiCalls.length, 3); // 366 days
    assert.strictEqual(param(apiCalls[0]!, "from_date"), "01-01-2024");
    assert.strictEqual(param(apiCalls.at(-1)!, "to_date"), "31-12-2024");
  });

  it("degrades to a SINGLE unwindowed call when the range can't be parsed", async () => {
    stubNse(() => []);
    // Not a format the splitter understands — the old behaviour (one call,
    // params passed through verbatim) is preserved rather than returning [].
    await fetchNSECorporateActionsBulkWindowed("2024/01/01", "2024/12/31");
    const apiCalls = requested.filter((u) =>
      u.includes("corporates-corporateActions"),
    );
    assert.strictEqual(apiCalls.length, 1);
    assert.strictEqual(param(apiCalls[0]!, "from_date"), "2024/01/01");
  });
});

describe("NSE bulk retry — session staleness (MONEY-1189)", () => {
  /**
   * Fail the API `failFirst` times, then succeed. Counts handshakes separately
   * so a retry that reuses the dead cookie is distinguishable from one that
   * re-handshakes.
   */
  function stubFlakyNse(failFirst: number): { handshakes: () => number } {
    let apiCalls = 0;
    let handshakes = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : ((input as { url: string }).url ?? String(input));
      requested.push(url);

      if (!url.includes("/api/")) {
        handshakes++;
        return new Response("<html></html>", {
          status: 200,
          headers: { "set-cookie": `nsit=stub${handshakes}; Path=/` },
        });
      }
      if (++apiCalls <= failFirst) throw new Error("Request timed out");
      return new Response(
        JSON.stringify([
          {
            symbol: "RELIANCE",
            subject: "Dividend - Rs 10 Per Share",
            exDate: "01-06-2006",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { handshakes: () => handshakes };
  }

  it("RE-HANDSHAKES before each retry instead of reusing the dead cookie", async () => {
    // THE REGRESSION. Growing the deadline (30/45/60s) was not enough: when
    // Akamai retires a cookie early it HANGS the request rather than 403ing, so
    // all three attempts timed out on the same dead credential while the same
    // window fetched from a fresh process answered in ~300ms. 37 windows were
    // lost this way in whole-chunk trios that tracked the preceding BSE leg's
    // duration, not the window size.
    const stub = stubFlakyNse(2);
    const out = await fetchNSECorporateActionsBulkWindowed(
      utc(2006, 6, 1),
      utc(2006, 6, 30),
    );

    assert.strictEqual(out.rows.length, 1, "the third attempt succeeded");
    assert.deepStrictEqual(out.failedWindows, []);
    assert.strictEqual(
      stub.handshakes(),
      3,
      "one handshake per attempt — a retry on the same cookie is not a retry",
    );
  });

  it("does NOT re-handshake when the first attempt succeeds", async () => {
    // The invalidation costs a round trip against a rate-limited host, so it
    // must not fire on the happy path (~40 windows on a 20-year walk).
    const stub = stubFlakyNse(0);
    await fetchNSECorporateActionsBulkWindowed(
      utc(2006, 6, 1),
      utc(2006, 6, 30),
    );
    assert.strictEqual(stub.handshakes(), 1);
  });

  it("reports the window as FAILED once every attempt is exhausted", async () => {
    const stub = stubFlakyNse(99);
    const out = await fetchNSECorporateActionsBulkWindowed(
      utc(2006, 6, 1),
      utc(2006, 6, 30),
    );
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(out.failedWindows.length, 1, "silence is not emptiness");
    assert.strictEqual(stub.handshakes(), 3);
  });

  it("treats an HTML challenge page carrying HTTP 200 as retryable", async () => {
    // Throttled, not "no such data" — status alone never decides this.
    let apiCalls = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : ((input as { url: string }).url ?? String(input));
      requested.push(url);
      if (!url.includes("/api/")) {
        return new Response("<html></html>", {
          status: 200,
          headers: { "set-cookie": "nsit=stub; Path=/" },
        });
      }
      if (++apiCalls === 1) {
        return new Response("<html>Access Denied</html>", { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            symbol: "TCS",
            subject: "Dividend - Rs 5 Per Share",
            exDate: "05-07-2005",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await fetchNSECorporateActionsBulkWindowed(
      utc(2005, 7, 1),
      utc(2005, 7, 31),
    );
    assert.strictEqual(out.rows.length, 1);
    assert.deepStrictEqual(out.failedWindows, []);
  });
});

// ── BSE ──────────────────────────────────────────────────────────────────────

/** `bse-client` uses bare `fetch(url, init)`, so the stub sees a URL string. */
function stubBse(status = 200, body: unknown = []): void {
  globalThis.fetch = (async (url: unknown) => {
    requested.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
}

describe("fetchBSECorporateActions chunking", () => {
  it("splits a wide range into contiguous <=180-day Fdate/TDate windows", async () => {
    stubBse(200, [
      {
        short_name: "RELIANCE",
        Purposecode: "P9",
        Purpose: "Dividend - Rs 10 Per Share",
        Ex_date: "2024-03-15",
      },
    ]);

    const out = await fetchBSECorporateActions({
      fromDate: utc(2024, 1, 1),
      toDate: utc(2024, 12, 31),
      paceMs: 0,
    });

    const calls = requested.filter((u) => u.includes("DefaultData/w"));
    assert.strictEqual(calls.length, 3, "366 days / 180 = 3 windows");
    assert.strictEqual(out.rows.length, 3, "rows from every window are merged");
    assert.deepStrictEqual(out.failedWindows, []);

    assert.strictEqual(param(calls[0]!, "Fdate"), "01 Jan 2024");
    assert.strictEqual(param(calls[0]!, "TDate"), "28 Jun 2024");
    assert.strictEqual(param(calls[1]!, "Fdate"), "29 Jun 2024");
    assert.strictEqual(param(calls[1]!, "TDate"), "25 Dec 2024");
    assert.strictEqual(param(calls[2]!, "Fdate"), "26 Dec 2024");
    assert.strictEqual(param(calls[2]!, "TDate"), "31 Dec 2024");

    // Blank scripcode / Purposecode (whole market, every action class) survives
    // the refactor — that is what makes this the WHOLE-MARKET pull.
    assert.strictEqual(param(calls[0]!, "scripcode"), "");
    assert.strictEqual(param(calls[0]!, "Purposecode"), "");
  });

  it("keeps a narrow range at exactly ONE request (no behaviour change)", async () => {
    stubBse(200, []);
    await fetchBSECorporateActions({
      fromDate: "2024-03-14",
      toDate: "2024-03-15",
      paceMs: 0,
    });
    const calls = requested.filter((u) => u.includes("DefaultData/w"));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(param(calls[0]!, "Fdate"), "14 Mar 2024");
    assert.strictEqual(param(calls[0]!, "TDate"), "15 Mar 2024");
  });

  it("a non-429 failure REPORTS the window instead of silently returning []", async () => {
    // Every window 500s: the batch still resolves rather than throwing
    // (best-effort contract), but each failure is now NAMED. MONEY-1189: BSE
    // 500'd 16-Aug-2014..11-Feb-2015 on the 20-year run and the empty array it
    // returned was indistinguishable from "BSE listed nothing for six months",
    // so the window was never retried.
    stubBse(500, []);
    const out = await fetchBSECorporateActions({
      fromDate: utc(2024, 1, 1),
      toDate: utc(2024, 12, 31),
      paceMs: 0,
    });
    assert.deepStrictEqual(out.rows, [], "no rows were obtained");
    assert.strictEqual(out.failedWindows.length, 3, "all three are reported");
    assert.strictEqual(
      requested.filter((u) => u.includes("DefaultData/w")).length,
      3,
      "a failed window must not stop the walk",
    );
  });

  it("distinguishes an EMPTY window from a FAILED one", async () => {
    // The whole point: a 200 carrying no rows is data, not an outage.
    stubBse(200, []);
    const out = await fetchBSECorporateActions({
      fromDate: utc(2024, 1, 1),
      toDate: utc(2024, 12, 31),
      paceMs: 0,
    });
    assert.deepStrictEqual(out.rows, []);
    assert.deepStrictEqual(
      out.failedWindows,
      [],
      "an empty answer is an answer",
    );
  });

  it("keeps the SUCCEEDING windows when only some fail", async () => {
    // The 20-year run's real shape: most windows fine, a few lost. The rows we
    // did get must survive, and the gaps must still be named.
    let n = 0;
    globalThis.fetch = (async (url: unknown) => {
      requested.push(String(url));
      const fail = ++n === 2;
      return {
        ok: !fail,
        status: fail ? 500 : 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify(
            fail
              ? []
              : [
                  {
                    short_name: "RELIANCE",
                    Purposecode: "P9",
                    Purpose: "Dividend - Rs 10 Per Share",
                    Ex_date: "2024-03-15",
                  },
                ],
          ),
      };
    }) as unknown as typeof fetch;

    const out = await fetchBSECorporateActions({
      fromDate: utc(2024, 1, 1),
      toDate: utc(2024, 12, 31),
      paceMs: 0,
    });
    assert.strictEqual(out.rows.length, 2, "windows 1 and 3 still contributed");
    assert.strictEqual(out.failedWindows.length, 1);
    assert.strictEqual(
      out.failedWindows[0]!.from.toISOString().slice(0, 10),
      "2024-06-29",
      "the reported window is the one that actually failed",
    );
  });

  it("honours maxWindowDays for a one-off narrower backfill", async () => {
    stubBse(200, []);
    await fetchBSECorporateActions({
      fromDate: utc(2024, 1, 1),
      toDate: utc(2024, 1, 31),
      maxWindowDays: 10,
      paceMs: 0,
    });
    const calls = requested.filter((u) => u.includes("DefaultData/w"));
    assert.strictEqual(calls.length, 4); // 31 days / 10
    assert.strictEqual(param(calls[0]!, "TDate"), "10 Jan 2024");
    assert.strictEqual(param(calls.at(-1)!, "TDate"), "31 Jan 2024");
  });
});
