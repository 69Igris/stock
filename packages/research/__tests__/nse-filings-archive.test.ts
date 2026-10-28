/**
 * FUNCTIONAL TEST — the NSE filings fetchers route their RAW response through
 * the P5.7 archive seam (MONEY-1189, audit gap #6).
 *
 * `nse-json-archive.test.ts` pins the seam in isolation: which paths key, which
 * are skipped, that a store failure is swallowed. This file pins that the
 * fetchers are WIRED to it — `fetchNSEAnnouncements`, `fetchNSEFinancialResults`
 * and `fetchNSECorporateActions` each fetched NSE and discarded the bytes while
 * three of their siblings in the same file archived correctly, so the file read
 * as compliant and the announcements feed (annual reports, categorized filings,
 * the annual-reports-sync worker) was never archived at all.
 *
 * TWO different things are asserted, because the seam answers them differently:
 *
 *   - PER-SYMBOL fetchers (the three above) reach the seam and the seam DECLINES
 *     to write: `symbol=` is the archive's deliberate volume exclusion. The
 *     observable is the `skipped` counter — "we asked, the policy said no" —
 *     which is a different state from the pre-fix "nobody asked", and the only
 *     one that follows the policy if it ever changes.
 *   - The MARKET-WIDE bulk leg writes for real, so the key and the exact bytes
 *     are pinned there, along with the never-throw contract against a store that
 *     rejects.
 *
 * NO NETWORK, NO TIMERS: `globalThis.fetch` is stubbed (ky resolves it at
 * request time) and answers the cookie handshake too, so `getSession` never
 * sleeps. Failure statuses are 404 rather than 5xx on purpose — ky retries
 * 500/502/503/504 by default, which would arm real backoff timers.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchNSEAnnouncements,
  fetchNSECorporateActions,
  fetchNSECorporateActionsBulk,
  fetchNSEFinancialResults,
  invalidateNseSession,
} from "../src/data-sources/nse-filings";
import {
  nseJsonArchiveKey,
  readNseJsonArchiveCounters,
  resetNseJsonArchiveCounters,
} from "../src/data-sources/nse-json-archive";
import {
  setFeedArchiveStore,
  type FeedArchiveStore,
} from "@usemoney/core/market-data";

const realFetch = globalThis.fetch;
const prevMode = process.env.FEED_ARCHIVE_MODE;
const prevBackoff = process.env.NSE_RETRY_BACKOFF_MS;

/** Every URL the stub was asked for, in order (handshake included). */
let requested: string[] = [];
/** Everything that reached the archive store. */
let puts: Array<{ key: string; body: string; contentType: string }> = [];

const recordingStore: FeedArchiveStore = {
  get: async () => null,
  put: async (key, body, contentType) => {
    puts.push({ key, body: body.toString("utf8"), contentType });
  },
};

/**
 * Answer the cookie handshake, then serve `body` with `status` for the API call.
 * `body` is a STRING, not an object: what these tests are about is the raw text,
 * so nothing here is allowed to re-serialize it on the way out.
 */
function stubNse(body: string, status = 200): void {
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
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** The one API URL the fetcher asked for (the handshake is not one). */
function apiUrl(): string {
  const calls = requested.filter((u) => u.includes("/api/"));
  assert.equal(calls.length, 1, `expected exactly 1 API call, got ${calls}`);
  return calls[0]!;
}

/** The `/api/…` path of that call — what the fetcher hands the archive. */
function apiPath(): string {
  const url = new URL(apiUrl());
  return `${url.pathname}${url.search}`;
}

before(() => {
  // The seam only does anything when the archive is ARMED and a store is
  // registered; otherwise every assertion below would pass on a no-op.
  process.env.FEED_ARCHIVE_MODE = "archive";
  // Only the bulk leg retries, and only on failure — but a real 2s backoff
  // would outlive the assertion if a case ever takes that path.
  process.env.NSE_RETRY_BACKOFF_MS = "0";
});

after(() => {
  globalThis.fetch = realFetch;
  setFeedArchiveStore(null);
  if (prevMode === undefined) delete process.env.FEED_ARCHIVE_MODE;
  else process.env.FEED_ARCHIVE_MODE = prevMode;
  if (prevBackoff === undefined) delete process.env.NSE_RETRY_BACKOFF_MS;
  else process.env.NSE_RETRY_BACKOFF_MS = prevBackoff;
});

beforeEach(() => {
  requested = [];
  puts = [];
  resetNseJsonArchiveCounters();
  setFeedArchiveStore(recordingStore);
  // The cookie cache is module-level and outlives a test; a stale one would
  // hide the handshake and change how many URLs `requested` holds.
  invalidateNseSession();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setFeedArchiveStore(null);
});

// ── Per-symbol: the seam is reached, the policy declines ─────────────────────

describe("fetchNSEAnnouncements → archive seam (MONEY-1189)", () => {
  it("hands the seam the SAME path it fetched, once", async () => {
    stubNse(
      JSON.stringify([{ desc: "Annual Report 2025-26", an_dt: "2026-06-01" }]),
    );

    const filings = await fetchNSEAnnouncements("reliance.NS", {
      from: "01-01-2026",
      to: "31-01-2026",
    });

    assert.equal(filings.length, 1, "the fetch result is unchanged");
    assert.equal(
      apiPath(),
      "/api/corporates-announcements?symbol=RELIANCE&from_date=01-01-2026&to_date=31-01-2026",
    );
    // ONE path string builds the request AND the archive call, which is the
    // property that failed on the bulk leg before MONEY-1189: a URL that only
    // exists inside ky has nothing to give the archive.
    assert.equal(
      readNseJsonArchiveCounters().skipped,
      1,
      "the seam was consulted exactly once",
    );
    // …and declined it, because the path is per-symbol. Asserted here rather
    // than assumed: if the exclusion is ever lifted, this is the line that
    // says where the behaviour changed.
    assert.equal(nseJsonArchiveKey(apiPath(), new Date()), null);
    assert.deepEqual(puts, [], "nothing is written for a per-symbol path");
  });

  it("archives INDEPENDENTLY of the domain parse", async () => {
    // The whole reason the archive exists: a body `parseAnnouncements` can make
    // nothing of is exactly the body someone will need to re-read next month.
    // Archiving after the domain parse (or only on its success) would lose it.
    stubNse('{"unexpected":"shape"}');

    const filings = await fetchNSEAnnouncements("RELIANCE");

    assert.deepEqual(filings, [], "a non-array response still parses to []");
    assert.equal(readNseJsonArchiveCounters().skipped, 1);
  });

  it("does NOT archive an HTML challenge page carrying a 200", async () => {
    stubNse("<html>Access Denied</html>");

    const filings = await fetchNSEAnnouncements("RELIANCE");

    assert.deepEqual(filings, []);
    assert.deepEqual(readNseJsonArchiveCounters(), {
      archived: 0,
      failed: 0,
      timedOut: 0,
      skipped: 0,
    });
  });

  it("does NOT archive a non-2xx response", async () => {
    stubNse("[]", 404);

    const filings = await fetchNSEAnnouncements("RELIANCE");

    assert.deepEqual(filings, []);
    assert.equal(readNseJsonArchiveCounters().skipped, 0);
  });

  it("an archive that throws on contact does not change the result", async () => {
    // The correctness contract: archiving is best-effort, the fetch is not.
    setFeedArchiveStore({
      get: async () => {
        throw new Error("GCS on fire");
      },
      put: async () => {
        throw new Error("GCS on fire");
      },
    });
    stubNse(JSON.stringify([{ desc: "Investor Presentation", an_dt: "x" }]));

    const filings = await fetchNSEAnnouncements("RELIANCE");

    assert.equal(filings.length, 1);
    assert.equal(filings[0]!.title, "Investor Presentation");
  });
});

describe("fetchNSEFinancialResults → archive seam (MONEY-1189)", () => {
  it("hands the seam the SAME path it fetched, once", async () => {
    stubNse(JSON.stringify({ results: [{ period: "Q3 FY26" }] }));

    const filings = await fetchNSEFinancialResults("tcs.BO");

    assert.equal(filings.length, 1);
    assert.equal(apiPath(), "/api/corporates-financial-results?symbol=TCS");
    assert.equal(readNseJsonArchiveCounters().skipped, 1);
    assert.deepEqual(puts, []);
  });

  it("does NOT archive an HTML challenge page", async () => {
    stubNse("<html>Access Denied</html>");
    assert.deepEqual(await fetchNSEFinancialResults("TCS"), []);
    assert.equal(readNseJsonArchiveCounters().skipped, 0);
  });
});

describe("fetchNSECorporateActions → archive seam (MONEY-1189)", () => {
  it("hands the seam the SAME path it fetched, once", async () => {
    stubNse(
      JSON.stringify([{ subject: "Dividend - Rs 10 Per Share", exDate: "x" }]),
    );

    const actions = await fetchNSECorporateActions("INFY");

    assert.equal(actions.length, 1);
    assert.equal(
      apiPath(),
      "/api/corporates-corporateActions?index=equities&symbol=INFY",
    );
    assert.equal(readNseJsonArchiveCounters().skipped, 1);
    assert.deepEqual(puts, []);
  });

  it("still returns [] for a challenge page and a 404 (decode moved, behaviour did not)", async () => {
    // This fetcher used to decode with ky's `.json()`, which cannot yield the
    // raw text an archive needs. Both failure shapes must still land on [].
    stubNse("<html>Access Denied</html>");
    assert.deepEqual(await fetchNSECorporateActions("INFY"), []);

    requested = [];
    invalidateNseSession();
    stubNse("[]", 404);
    assert.deepEqual(await fetchNSECorporateActions("INFY"), []);
    assert.equal(readNseJsonArchiveCounters().skipped, 0);
  });
});

// ── Market-wide: the write path, end to end ──────────────────────────────────

describe("the archived bytes are what NSE served (MONEY-1189)", () => {
  // `fetchNSECorporateActionsBulk` omits `symbol`, so this is the leg where the
  // seam actually writes — the only place the key and the body can be pinned
  // against a real store.
  const RAW = `[
  {"symbol":"RELIANCE","subject":"Dividend - Rs 10 Per Share","exDate":"2026-03-15","nseInternalField":"dropped by the parser"}
]`;

  it("writes the RAW text, not a re-serialization of the parse", async () => {
    stubNse(RAW);

    const rows = await fetchNSECorporateActionsBulk("01-01-2026", "31-01-2026");

    assert.equal(rows?.length, 1, "the fetch result is unchanged");
    assert.equal(puts.length, 1);
    assert.match(
      puts[0]!.key,
      /^feeds\/NSE\/api\/corporate-actions\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-corporates-corporateActions-index-equities-from-date-01-01-2026-to-date-31-01-2026\.json$/,
    );
    assert.equal(puts[0]!.contentType, "application/json");
    // Byte-for-byte, whitespace and the field the parser drops included. A
    // `JSON.stringify(parsed)` would pass every other assertion here and still
    // have thrown away the thing an archive is for.
    assert.equal(puts[0]!.body, RAW);
  });

  it("a REJECTED archive write leaves the rows and never rejects", async () => {
    setFeedArchiveStore({
      get: async () => null,
      put: async () => {
        throw new Error("GCS on fire");
      },
    });
    stubNse(RAW);

    const rows = await fetchNSECorporateActionsBulk("01-01-2026", "31-01-2026");

    assert.equal(
      rows?.length,
      1,
      "the failure is the archive's, not the caller's",
    );
    assert.equal(
      readNseJsonArchiveCounters().failed,
      1,
      "…and it is COUNTED, so a bucket-IAM gap is visible rather than silent",
    );
  });
});
