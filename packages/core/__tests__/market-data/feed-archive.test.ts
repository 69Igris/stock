/**
 * UNIT TEST — raw exchange-feed archive + replay (MONEY-1085).
 *
 * Exercises the REAL exports from packages/core/src/market-data/feed-archive.ts
 * with an injected fake store and a stubbed `fetch`, so the full mode matrix is
 * covered without GCP or network.
 *
 * What matters here is the SIDE EFFECTS, not the return values:
 *   - replay must serve archived bytes and NOT touch the exchange (that is the
 *     entire point — QA stops scraping NSE/BSE),
 *   - archive must persist the bytes AND still hand the caller a readable body
 *     (reading it to archive drains the original Response),
 *   - a storage failure must never fail an ingest that already succeeded,
 *   - unset mode must be byte-identical to pre-MONEY-1085 behaviour.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildFeedArchiveKey,
  feedContentType,
  getFeedArchiveStore,
  getFeedAsset,
  resolveFeedArchiveMode,
  setFeedArchiveStore,
  type FeedArchiveStore,
} from "../../src/market-data/feed-archive";

const NSE_ZIP =
  "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260727_F_0000.csv.zip";
const MASTER = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const REFERER = "https://www.nseindia.com/";
const DAY = new Date(Date.UTC(2026, 6, 27));

/**
 * A minimal, REAL single-entry STORED ZIP — the shape `unzipSingleEntry`
 * parses, and the shape `validateFeedPayload` now requires before anything is
 * archived under a `.zip` key (MONEY-1157).
 *
 * The fixtures below used to be plain strings ("ARCHIVED-BYTES") sitting under
 * a `.zip` descriptor, i.e. payloads that could never have come from NSE. They
 * are real ZIPs now so each test still asserts its own property — draining the
 * body, serving archived bytes, zero exchange traffic — using bytes the
 * production path could actually see.
 */
function zipBytes(csv: string): Buffer {
  const name = Buffer.from("BhavCopy.csv", "utf-8");
  const data = Buffer.from(csv, "utf-8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // "PK\x03\x04"
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(0, 8); // method 0 = STORED
  header.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
  header.writeUInt32LE(data.length, 18); // compressed size
  header.writeUInt32LE(data.length, 22); // uncompressed size
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name, data]);
}

/** A UDiFF bhavcopy CSV carrying the header tokens the parser requires. */
const BHAVCOPY_CSV =
  "TckrSymb,ISIN,SctySrs,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol,FinInstrmTp,FinInstrmNm\n" +
  "RELIANCE,INE002A01018,EQ,10,11,9,10.5,10,1000,STK,RELIANCE INDUSTRIES\n";

/** A master CSV carrying the header tokens `parseNseMasterCsv` requires. */
const MASTER_CSV =
  "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n" +
  "RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995,10,1,INE002A01018,10\n";

/** A recording fake store. */
function makeStore(seed?: Record<string, string | Buffer>) {
  const puts: Array<{ key: string; body: string; contentType: string }> = [];
  const gets: string[] = [];
  const data = new Map<string, Buffer>(
    Object.entries(seed ?? {}).map(([k, v]) => [
      k,
      Buffer.isBuffer(v) ? v : Buffer.from(v),
    ]),
  );
  const store: FeedArchiveStore & {
    puts: typeof puts;
    gets: typeof gets;
    failGet?: boolean;
    failPut?: boolean;
  } = {
    puts,
    gets,
    async get(key) {
      gets.push(key);
      if (store.failGet) throw new Error("simulated GCS read outage");
      return data.get(key) ?? null;
    },
    async put(key, body, contentType) {
      if (store.failPut) throw new Error("simulated GCS write outage");
      puts.push({ key, body: body.toString(), contentType });
      data.set(key, body);
    },
  };
  return store;
}

let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

/** Stub fetch. `status` 404 exercises the non-trading-day path. */
function stubFetch(body: string | Buffer, status = 200): void {
  globalThis.fetch = (async (url: unknown) => {
    fetchCalls.push(String(url));
    if (status === 404) return new Response(null, { status });
    return new Response(Buffer.isBuffer(body) ? new Uint8Array(body) : body, {
      status,
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
  setFeedArchiveStore(null);
  delete process.env.FEED_ARCHIVE_MODE;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setFeedArchiveStore(null);
  delete process.env.FEED_ARCHIVE_MODE;
});

describe("resolveFeedArchiveMode", () => {
  test("unset / unrecognised is off (the safe default)", () => {
    assert.equal(resolveFeedArchiveMode(undefined), "off");
    assert.equal(resolveFeedArchiveMode(""), "off");
    assert.equal(resolveFeedArchiveMode("   "), "off");
    assert.equal(resolveFeedArchiveMode("yes"), "off");
    assert.equal(resolveFeedArchiveMode("true"), "off");
  });

  test("accepts archive / replay, case- and space-insensitively", () => {
    assert.equal(resolveFeedArchiveMode("archive"), "archive");
    assert.equal(resolveFeedArchiveMode("  ARCHIVE "), "archive");
    assert.equal(resolveFeedArchiveMode("Replay"), "replay");
  });
});

describe("buildFeedArchiveKey", () => {
  test("dated feeds land under YYYY/MM with the exchange filename", () => {
    assert.equal(
      buildFeedArchiveKey(
        { exchange: "NSE", feed: "bhavcopy", date: DAY },
        NSE_ZIP,
      ),
      "feeds/NSE/bhavcopy/2026/07/BhavCopy_NSE_CM_0_0_0_20260727_F_0000.csv.zip",
    );
  });

  test("undated snapshots land under current/ so they overwrite", () => {
    assert.equal(
      buildFeedArchiveKey({ exchange: "NSE", feed: "equity-master" }, MASTER),
      "feeds/NSE/equity-master/current/EQUITY_L.csv",
    );
  });

  /**
   * MONEY-1157. The test this replaces called `buildFeedArchiveKey` TWICE with
   * IDENTICAL arguments and asserted the two results were equal. It was named
   * for "prod's key == QA's replay key" but could only ever prove purity — it
   * was incapable of failing short of someone injecting `Date.now()`.
   *
   * The property it claimed is exercised end-to-end below (archive in prod
   * mode, then read it back in QA mode). The property it MISSED is here: the
   * `YYYY/MM` prefix and the exchange's own date token in the filename have to
   * come from the SAME calendar.
   */
  test("the YYYY/MM prefix agrees with the IST date token in the filename", () => {
    // An IST-midnight Date: 18:30 UTC on the last day of July == 00:00 IST on
    // 1 August. Every filename token in this system is IST-derived (`istParts`
    // in bhavcopy.ts adds +5:30), so the file is named …20260801…; a prefix
    // read off getUTCMonth() would file it under 2026/07.
    const istMidnightAug1 = new Date("2026-07-31T18:30:00.000Z");
    assert.equal(
      buildFeedArchiveKey(
        { exchange: "NSE", feed: "bhavcopy", date: istMidnightAug1 },
        "https://x/BhavCopy_NSE_CM_0_0_0_20260801_F_0000.csv.zip",
      ),
      "feeds/NSE/bhavcopy/2026/08/BhavCopy_NSE_CM_0_0_0_20260801_F_0000.csv.zip",
      "an IST-midnight Date must not file August's bhavcopy under 2026/07",
    );
  });

  test("folds a query string INTO the filename, before the extension", () => {
    // This used to assert the query was STRIPPED — i.e. it pinned the defect.
    // Stripping made every query variant of one path share a single object
    // key, so the second fetch silently overwrote the first with different
    // data. The query now discriminates, and the extension stays last so the
    // object is still recognisable as a CSV.
    const key = buildFeedArchiveKey(
      { exchange: "NSE", feed: "indices" },
      `${MASTER}?v=2`,
    );
    assert.match(
      key,
      /^feeds\/NSE\/indices\/current\/EQUITY_L__v-2-[0-9a-f]{8}\.csv$/,
    );
  });

  test("prefix and filename token agree across day/month/year boundaries", () => {
    // Live callers are safe today only because `resolveTargetDay` →
    // `parseIsoDay` anchors at UTC NOON, so the +5:30 shift cannot cross a day
    // boundary — an unasserted property of a caller in a different package.
    // This pins the invariant for ANY anchor a future caller might pass.
    const anchors = [
      "2026-07-31T18:30:00.000Z", // IST 2026-08-01 00:00 — month rolls
      "2026-12-31T18:30:00.000Z", // IST 2027-01-01 00:00 — year rolls
      "2026-08-01T12:00:00.000Z", // the UTC-noon anchor live callers use
      "2026-08-01T23:59:59.000Z", // IST 2026-08-02 05:29
      "2026-01-05T00:00:00.000Z", // IST same day, month must stay padded
    ];

    for (const iso of anchors) {
      const date = new Date(iso);
      // Rebuild the filename token exactly as the URL builders do (+5:30).
      const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
      const token =
        `${ist.getUTCFullYear()}` +
        `${String(ist.getUTCMonth() + 1).padStart(2, "0")}` +
        `${String(ist.getUTCDate()).padStart(2, "0")}`;

      const key = buildFeedArchiveKey(
        { exchange: "NSE", feed: "bhavcopy", date },
        `https://x/BhavCopy_NSE_CM_0_0_0_${token}_F_0000.csv.zip`,
      );
      const [, , , year, month] = key.split("/");
      assert.equal(
        `${year}${month}`,
        token.slice(0, 6),
        `${iso}: prefix ${year}/${month} disagrees with filename token ${token}`,
      );
    }
  });

  test("no query means no discriminator (existing keys are unchanged)", () => {
    // The archive is keyed on this, so a URL that never had a query must
    // produce exactly the key it produced before MONEY-1157.
    assert.equal(
      buildFeedArchiveKey({ exchange: "NSE", feed: "indices" }, MASTER),
      "feeds/NSE/indices/current/EQUITY_L.csv",
    );
  });

  test("REGRESSION: two query variants of one path cannot collide", () => {
    // The live risk: BSE's ListofScripData returns the FULL ~12,600-row
    // universe for segment=Debt and a different 4,926-row subset for
    // segment=Equity. Both used to be archived as `w`.
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    const base = "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w";
    const debt = buildFeedArchiveKey(
      d,
      `${base}?Group=&Scripcode=&industry=&segment=Debt&status=Active`,
    );
    const equity = buildFeedArchiveKey(
      d,
      `${base}?Group=&Scripcode=&industry=&segment=Equity&status=Active`,
    );

    assert.notEqual(debt, equity, "the two segments must not share an object");
    // And neither is the opaque single letter the URL path ends with.
    assert.doesNotMatch(debt, /\/w$/);
    assert.doesNotMatch(equity, /\/w$/);
  });

  test("an explicit basename replaces an unusable URL-derived one", () => {
    assert.match(
      buildFeedArchiveKey(
        {
          exchange: "BSE",
          feed: "scrip-master",
          basename: "bse-scrip-master.json",
        },
        "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?segment=Debt",
      ),
      /^feeds\/BSE\/scrip-master\/current\/bse-scrip-master__segment-Debt-[0-9a-f]{8}\.json$/,
    );
  });

  test("empty params are dropped from the label but still bind the key", () => {
    // `Group=&Scripcode=&industry=` carry no information, so they are not
    // paraded in the object name — but the digest covers the raw query, so a
    // URL that differs ONLY in an empty param still gets its own key.
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    const withEmpties = buildFeedArchiveKey(
      d,
      "https://x/y/w?Group=&segment=Debt",
    );
    const withoutEmpties = buildFeedArchiveKey(d, "https://x/y/w?segment=Debt");

    assert.match(withEmpties, /w__segment-Debt-[0-9a-f]{8}$/);
    assert.match(withoutEmpties, /w__segment-Debt-[0-9a-f]{8}$/);
    assert.notEqual(withEmpties, withoutEmpties);
  });

  test("param ORDER does not change the key (no orphaned archives)", () => {
    // A caller reordering its query string must not orphan every object it
    // already archived.
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    assert.equal(
      buildFeedArchiveKey(d, "https://x/y/w?a=1&b=2"),
      buildFeedArchiveKey(d, "https://x/y/w?a=1&b=2"),
    );
    assert.match(buildFeedArchiveKey(d, "https://x/y/w?b=2&a=1"), /a-1_b-2-/);
  });

  test("a query key is stable across calls (prod archive == QA replay)", () => {
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    const url = "https://x/y/w?segment=Debt&status=Active";
    assert.equal(buildFeedArchiveKey(d, url), buildFeedArchiveKey(d, url));
  });

  test("pads the month and separates the exchanges", () => {
    const jan = new Date(Date.UTC(2026, 0, 5));
    assert.match(
      buildFeedArchiveKey(
        { exchange: "BSE", feed: "bhavcopy", date: jan },
        "https://x/a.CSV",
      ),
      /^feeds\/BSE\/bhavcopy\/2026\/01\/a\.CSV$/,
    );
  });
});

describe("feedContentType", () => {
  test("maps the extensions we actually archive", () => {
    assert.equal(feedContentType(NSE_ZIP), "application/zip");
    assert.equal(feedContentType(MASTER), "text/csv");
    assert.equal(feedContentType("https://x/y/FILE.CSV"), "text/csv");
    assert.equal(
      feedContentType("https://x/y/blob"),
      "application/octet-stream",
    );
  });

  test("the binary formats we archive are identifiable, not octet-stream", () => {
    // MONEY-1204 — two `enabled: true` families were landing in GCS as
    // `application/octet-stream`: `nse-market-pulse` (pdf) and `nse-fii-stats`
    // (xls). Same defect the `.xml` and BSE-JSON branches were added to fix.
    // An unidentifiable blob is not a broken download — it is a file that
    // opens wrong, later, in a tool that was never told what it was holding.
    assert.equal(
      feedContentType(
        "https://nsearchives.nseindia.com/content/fo/fii_stats_13-Aug-2026.xls",
      ),
      "application/vnd.ms-excel",
    );
    assert.equal(
      feedContentType(
        "https://www.nseindia.com/web/mediaattachment/2026-07/Market_Pulse_July_2026.pdf",
      ),
      "application/pdf",
    );
    // NSE serves the legacy OLE2 binary under `.xls`; OOXML is a DIFFERENT
    // format behind the same three letters. Collapsing them to one guess
    // would mislabel every file we actually receive.
    assert.notEqual(
      feedContentType("https://x/y/a.xls"),
      feedContentType("https://x/y/a.xlsx"),
    );
    assert.equal(
      feedContentType("https://x/y/a.xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // Case-insensitive, like every other branch.
    assert.equal(feedContentType("https://x/y/A.PDF"), "application/pdf");
  });

  test("an explicit basename wins over an extensionless REST route", () => {
    // BSE's scrip master: the URL has no extension, so it was archived as an
    // opaque octet-stream blob. The basename is what says "this is JSON".
    const url =
      "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?segment=Debt";
    assert.equal(feedContentType(url), "application/octet-stream");
    assert.equal(
      feedContentType(url, "bse-scrip-master.json"),
      "application/json",
    );
  });
});

describe("getFeedAsset — mode off (default)", () => {
  test("passes through to the exchange and never touches the store", async () => {
    const store = makeStore();
    setFeedArchiveStore(store);
    stubFetch("FROM-EXCHANGE");

    const res = await getFeedAsset(MASTER, REFERER, {
      exchange: "NSE",
      feed: "equity-master",
    });

    assert.equal(await res!.text(), "FROM-EXCHANGE");
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(store.puts, [], "off mode must not archive");
    assert.deepEqual(store.gets, [], "off mode must not read the archive");
  });

  test("a 404 still maps to null (non-trading day)", async () => {
    stubFetch("", 404);
    const res = await getFeedAsset(NSE_ZIP, REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: DAY,
    });
    assert.equal(res, null);
  });
});

describe("getFeedAsset — archive mode (prod)", () => {
  beforeEach(() => {
    process.env.FEED_ARCHIVE_MODE = "archive";
  });

  test("fetches, stores the bytes, and STILL returns a readable body", async () => {
    // Regression guard: archiving reads the body, which drains the original
    // Response. Forgetting to re-wrap would hand the ingest an empty file.
    const store = makeStore();
    setFeedArchiveStore(store);
    const zip = zipBytes(BHAVCOPY_CSV);
    stubFetch(zip);

    const res = await getFeedAsset(NSE_ZIP, REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: DAY,
    });

    assert.deepEqual(Buffer.from(await res!.arrayBuffer()), zip);
    assert.equal(store.puts.length, 1);
    assert.equal(
      store.puts[0]!.key,
      "feeds/NSE/bhavcopy/2026/07/BhavCopy_NSE_CM_0_0_0_20260727_F_0000.csv.zip",
    );
    assert.equal(store.puts[0]!.body, zip.toString());
    assert.equal(store.puts[0]!.contentType, "application/zip");
  });

  test("a descriptor basename drives BOTH the key and the content type", async () => {
    // End-to-end wiring, not just the pure helpers: getFeedAsset must pass
    // descriptor.basename to feedContentType, or the object is still archived
    // as an unidentifiable octet-stream.
    const store = makeStore();
    setFeedArchiveStore(store);
    // Must clear the registered BSE/scrip-master floor (kind "json",
    // minBytes 32 in feed-payload.ts) — the payload sanity check runs BEFORE
    // the put, so a toy fixture would be SKIPPED and this test would assert
    // against an empty store for a reason that has nothing to do with the
    // basename wiring it is actually pinning.
    stubFetch(
      '[{"SCRIP_CD":"500325","Scrip_Name":"RELIANCE","GROUP":"A",' +
        '"ISIN_NUMBER":"INE002A01018","Status":"Active"}]',
    );

    await getFeedAsset(
      "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w" +
        "?Group=&segment=Debt&status=Active",
      "https://www.bseindia.com/",
      {
        exchange: "BSE",
        feed: "scrip-master",
        basename: "bse-scrip-master.json",
      },
    );

    assert.equal(store.puts.length, 1);
    assert.match(
      store.puts[0]!.key,
      /^feeds\/BSE\/scrip-master\/current\/bse-scrip-master__segment-Debt_status-Active-[0-9a-f]{8}\.json$/,
    );
    assert.equal(store.puts[0]!.contentType, "application/json");
  });

  test("a storage outage does NOT fail the ingest", async () => {
    // Losing the archive copy is an inconvenience; failing a price ingest that
    // already succeeded is an outage. This must stay swallowed.
    const store = makeStore();
    store.failPut = true;
    setFeedArchiveStore(store);
    stubFetch(MASTER_CSV);

    const res = await getFeedAsset(MASTER, REFERER, {
      exchange: "NSE",
      feed: "equity-master",
    });

    assert.equal(await res!.text(), MASTER_CSV);
  });

  test("nothing is archived for a 404", async () => {
    const store = makeStore();
    setFeedArchiveStore(store);
    stubFetch("", 404);

    const res = await getFeedAsset(NSE_ZIP, REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: DAY,
    });

    assert.equal(res, null);
    assert.deepEqual(
      store.puts,
      [],
      "a non-trading day must not archive an empty object",
    );
  });

  test("with no store registered it degrades to passthrough", async () => {
    setFeedArchiveStore(null);
    stubFetch("NO-STORE");
    const res = await getFeedAsset(MASTER, REFERER, {
      exchange: "NSE",
      feed: "equity-master",
    });
    assert.equal(await res!.text(), "NO-STORE");
    assert.equal(fetchCalls.length, 1);
  });
});

describe("archive → replay round trip", () => {
  /**
   * THE property the deleted determinism test claimed to cover: what prod
   * WRITES under `archive` is what QA FINDS under `replay`. Driven through the
   * real seam in both modes, so it fails if the key ever starts depending on
   * the mode, the environment, or the clock — which calling one pure function
   * twice with identical arguments could never detect.
   */
  test("prod's archived object is exactly what QA's replay reads back", async () => {
    const store = makeStore();
    const descriptor = {
      exchange: "NSE" as const,
      feed: "bhavcopy",
      date: DAY,
    };
    const zip = zipBytes(BHAVCOPY_CSV);

    process.env.FEED_ARCHIVE_MODE = "archive";
    setFeedArchiveStore(store);
    stubFetch(zip);
    await getFeedAsset(NSE_ZIP, REFERER, descriptor);
    assert.equal(store.puts.length, 1, "prod must have archived one object");

    // Same process, same store, QA's mode — nothing else carried over.
    process.env.FEED_ARCHIVE_MODE = "replay";
    fetchCalls = [];
    const replayed = await getFeedAsset(NSE_ZIP, REFERER, descriptor);

    assert.deepEqual(Buffer.from(await replayed!.arrayBuffer()), zip);
    assert.equal(fetchCalls.length, 0, "QA must not have touched the exchange");
    assert.deepEqual(store.gets, [store.puts[0]!.key]);
  });
});

describe("getFeedAsset — replay mode (qa)", () => {
  const KEY =
    "feeds/NSE/bhavcopy/2026/07/BhavCopy_NSE_CM_0_0_0_20260727_F_0000.csv.zip";

  beforeEach(() => {
    process.env.FEED_ARCHIVE_MODE = "replay";
  });

  test("THE POINT: serves the archived bytes with ZERO exchange traffic", async () => {
    const archived = zipBytes(BHAVCOPY_CSV);
    const store = makeStore({ [KEY]: archived });
    setFeedArchiveStore(store);
    stubFetch("FROM-EXCHANGE");

    const res = await getFeedAsset(NSE_ZIP, REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: DAY,
    });

    assert.deepEqual(Buffer.from(await res!.arrayBuffer()), archived);
    assert.equal(fetchCalls.length, 0, "replay must not hit the exchange");
    assert.deepEqual(store.gets, [KEY]);
    assert.deepEqual(store.puts, [], "replay must not re-archive");
  });

  test("a miss falls back to the exchange rather than failing", async () => {
    // QA must stay functional when the daily rsync is late.
    const store = makeStore();
    setFeedArchiveStore(store);
    stubFetch("FROM-EXCHANGE");

    const res = await getFeedAsset(NSE_ZIP, REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: DAY,
    });

    assert.equal(await res!.text(), "FROM-EXCHANGE");
    assert.equal(fetchCalls.length, 1);
  });

  test("an empty archived object is treated as a miss, not as empty data", async () => {
    // A 0-byte object would otherwise parse to zero rows and look like a
    // non-trading day — the silent-bad-data failure mode.
    const store = makeStore({ [KEY]: "" });
    setFeedArchiveStore(store);
    stubFetch("FROM-EXCHANGE");

    const res = await getFeedAsset(NSE_ZIP, REFERER, {
      exchange: "NSE",
      feed: "bhavcopy",
      date: DAY,
    });

    assert.equal(await res!.text(), "FROM-EXCHANGE");
  });

  test("a store read error falls back to the exchange", async () => {
    const store = makeStore();
    store.failGet = true;
    setFeedArchiveStore(store);
    stubFetch("FROM-EXCHANGE");

    const res = await getFeedAsset(MASTER, REFERER, {
      exchange: "NSE",
      feed: "equity-master",
    });

    assert.equal(await res!.text(), "FROM-EXCHANGE");
  });
});

describe("setFeedArchiveStore", () => {
  test("registers and clears the store", () => {
    assert.equal(getFeedArchiveStore(), null);
    const store = makeStore();
    setFeedArchiveStore(store);
    assert.equal(getFeedArchiveStore(), store);
    setFeedArchiveStore(null);
    assert.equal(getFeedArchiveStore(), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1204 (P0.2) — NSE XBRL result filings
// ─────────────────────────────────────────────────────────────────────────────

const XBRL_A =
  "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_116875_1315808_15112024100348.xml";
const XBRL_WEB =
  "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_116875_1315808_15112024100348_WEB.xml";
/** The quarter the filing DESCRIBES — see `archiveDayForFiling`. */
const QUARTER_END = new Date(Date.UTC(2024, 8, 30));

describe("XBRL filing archive key (MONEY-1204)", () => {
  test("keys under feeds/NSE/results-xbrl/{YYYY}/{MM}/{basename}", () => {
    // The grammar the `nse-results-xbrl` registry row and the archive-audit
    // classifier both document. It is FROZEN — ~66,950 objects per bucket — so
    // this assertion is the contract, not a snapshot.
    assert.equal(
      buildFeedArchiveKey(
        { exchange: "NSE", feed: "results-xbrl", date: QUARTER_END },
        XBRL_A,
      ),
      "feeds/NSE/results-xbrl/2024/09/INDAS_116875_1315808_15112024100348.xml",
    );
  });

  test("needs NO descriptor.basename — filing URLs are per-filing unique", () => {
    // The `_WEB` variant is a different object at a different URL and must not
    // collide with the plain one. This is why the row carries no
    // `buildBasename`, unlike the REST-route families.
    const key = (url: string) =>
      buildFeedArchiveKey(
        { exchange: "NSE", feed: "results-xbrl", date: QUARTER_END },
        url,
      );
    assert.notEqual(key(XBRL_A), key(XBRL_WEB));
    assert.match(
      key(XBRL_WEB),
      /INDAS_116875_1315808_15112024100348_WEB\.xml$/,
    );
  });

  test("an UNDATED filing files under current/, never under a guessed month", () => {
    // `archiveDayForFiling` returns undefined when the index gives neither a
    // quarter-end nor a broadcast date. An honest "undated" beats a confident
    // wrong month, and per-filing-unique basenames mean it can never overwrite
    // another filing.
    assert.equal(
      buildFeedArchiveKey({ exchange: "NSE", feed: "results-xbrl" }, XBRL_A),
      "feeds/NSE/results-xbrl/current/INDAS_116875_1315808_15112024100348.xml",
    );
  });

  test("the IST boundary decides the month, not UTC", () => {
    // 2024-09-30T19:00Z is 2024-10-01 in IST. `buildFeedArchiveKey` routes
    // through `toIstDateKey` precisely so this is not re-derived per feed.
    assert.match(
      buildFeedArchiveKey(
        {
          exchange: "NSE",
          feed: "results-xbrl",
          date: new Date("2024-09-30T19:00:00.000Z"),
        },
        XBRL_A,
      ),
      /^feeds\/NSE\/results-xbrl\/2024\/10\//,
    );
  });

  test("feedContentType names .xml rather than storing an opaque blob", () => {
    assert.equal(feedContentType(XBRL_A), "application/xml");
    assert.equal(feedContentType(XBRL_WEB), "application/xml");
    // Unchanged for every existing extension.
    assert.equal(feedContentType("https://x/a.csv.zip"), "application/zip");
    assert.equal(feedContentType("https://x/a.csv"), "text/csv");
    assert.equal(feedContentType("https://x/a.json"), "application/json");
    // The "not in the table" example was `.pdf` until MONEY-1204 added a pdf
    // branch — `nse-market-pulse` is a live pdf feed, so that case was
    // asserting the defect. Swapped for an extension nothing serves, which is
    // what the line was always FOR: same assertion, same strictness, an
    // example whose premise is still true.
    assert.equal(
      feedContentType("https://x/a.dat"),
      "application/octet-stream",
    );
    assert.equal(feedContentType("https://x/a.pdf"), "application/pdf");
  });
});
