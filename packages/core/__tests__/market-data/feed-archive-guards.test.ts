/**
 * FUNCTIONAL TEST — the three guards that had to exist before
 * `FEED_ARCHIVE_MODE` can be switched on anywhere (MONEY-1157).
 *
 * Drives the REAL `getFeedAsset` from
 * packages/core/src/market-data/feed-archive.ts with an injected fake store and
 * a stubbed `fetch`, so the archive/replay decision, the deadline and the
 * counters are all exercised without GCP or network.
 *
 * The three defects, and what each section pins:
 *
 *   FIX 3  Whatever came back 2xx was archived. NSE/BSE answer 200 with an
 *          HTML interstitial under throttling, so prod would archive that HTML
 *          (possibly OVER a `current/` master) and QA would replay it forever,
 *          producing COMPLETED syncs with 0 rows and no error.
 *   FIX 4  `uploadFile` passes no timeout and the GCS client has no
 *          `retryOptions` (defaults: totalTimeout 600s, maxRetries 3) inside a
 *          push handler whose ack deadline is also 600s. One slow `put` lets
 *          Pub/Sub redeliver mid-run; the two runs then race
 *          `dailyPrice.createMany` and the losing leg's prices are lost.
 *   FIX 5  Replayed vs scraped was invisible: `MarketDataSyncLog.source` is
 *          "BHAVCOPY" either way, with no counter and no field.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  diffFeedArchiveCounters,
  getFeedAsset,
  readFeedArchiveCounters,
  resetFeedArchiveCounters,
  setFeedArchiveStore,
  FEED_ARCHIVE_WRITE_TIMEOUT_MS,
  type FeedArchiveStore,
} from "../../src/market-data/feed-archive";

/** Resolved from THIS FILE, not cwd — a cwd-relative path would silently
 *  drop the suite (node reports a throwing describe as fail 0, exit 0). */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const NSE_ZIP =
  "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260727_F_0000.csv.zip";
const BSE_CSV =
  "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_20260727_F_0000.CSV";
const MASTER = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const REFERER = "https://www.nseindia.com/";
const DAY = new Date(Date.UTC(2026, 6, 27));

const NSE_BHAVCOPY = {
  exchange: "NSE" as const,
  feed: "bhavcopy",
  date: DAY,
};
const BSE_BHAVCOPY = {
  exchange: "BSE" as const,
  feed: "bhavcopy",
  date: DAY,
};
const EQUITY_MASTER = { exchange: "NSE" as const, feed: "equity-master" };

const BSE_KEY =
  "feeds/BSE/bhavcopy/2026/07/BhavCopy_BSE_CM_0_0_0_20260727_F_0000.CSV";
const MASTER_KEY = "feeds/NSE/equity-master/current/EQUITY_L.csv";

const THROTTLE_PAGE =
  '<!DOCTYPE html>\n<html lang="en"><head><title>Access Denied</title></head>' +
  "<body><h1>Resource unavailable</h1><p>Please try again later.</p></body></html>\n";

const BHAVCOPY_CSV =
  "TckrSymb,ISIN,SctySrs,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol,FinInstrmTp,FinInstrmNm\n" +
  "RELIANCE,INE002A01018,EQ,10,11,9,10.5,10,1000,STK,RELIANCE INDUSTRIES\n";

const MASTER_CSV =
  "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n" +
  "RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995,10,1,INE002A01018,10\n";

function makeStore(seed?: Record<string, string | Buffer>) {
  const puts: Array<{ key: string; body: Buffer }> = [];
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
    /** Resolve `put` only after this many ms (simulates a slow GCS). */
    putDelayMs?: number;
    /** Never resolve `put` at all (simulates a hung GCS). */
    putHangs?: boolean;
  } = {
    puts,
    gets,
    async get(key) {
      gets.push(key);
      return data.get(key) ?? null;
    },
    async put(key, body) {
      if (store.putHangs) {
        // Deliberately never settles. No timer, so it cannot orphan the test —
        // the SOURCE's deadline is what has to rescue us, which is the point.
        await new Promise<void>(() => {});
      }
      if (store.putDelayMs) {
        await new Promise((r) => setTimeout(r, store.putDelayMs));
      }
      puts.push({ key, body });
      data.set(key, body);
    },
  };
  return store;
}

let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

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
  resetFeedArchiveCounters();
  delete process.env.FEED_ARCHIVE_MODE;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setFeedArchiveStore(null);
  resetFeedArchiveCounters();
  delete process.env.FEED_ARCHIVE_MODE;
});

// ─── FIX 3 — the write side ──────────────────────────────────────────

describe("archive mode: garbage is never persisted", () => {
  beforeEach(() => {
    process.env.FEED_ARCHIVE_MODE = "archive";
  });

  test("a 200 HTML interstitial is NOT archived, and the ingest still runs", async () => {
    const store = makeStore();
    setFeedArchiveStore(store);
    stubFetch(THROTTLE_PAGE);

    const res = await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);

    assert.deepEqual(
      store.puts,
      [],
      "an HTML throttle page must never enter the archive — QA would replay " +
        "it indefinitely and every day would look like a market holiday",
    );
    // Not an error: the fetch succeeded, so prod's ingest proceeds exactly as
    // it does today and simply finds no rows.
    assert.equal(await res!.text(), THROTTLE_PAGE);
    assert.equal(readFeedArchiveCounters().archiveSkipped, 1);
    assert.equal(readFeedArchiveCounters().archived, 0);
  });

  test("HTML must not OVERWRITE a good `current/` master", async () => {
    // The worst case in the audit: the masters archive under `current/` and are
    // overwritten every run, so one throttled night would destroy the last good
    // copy for every later replay.
    const store = makeStore({ [MASTER_KEY]: MASTER_CSV });
    setFeedArchiveStore(store);
    stubFetch(THROTTLE_PAGE);

    await getFeedAsset(MASTER, REFERER, EQUITY_MASTER);

    assert.deepEqual(store.puts, []);
    process.env.FEED_ARCHIVE_MODE = "replay";
    const replayed = await getFeedAsset(MASTER, REFERER, EQUITY_MASTER);
    assert.equal(
      await replayed!.text(),
      MASTER_CSV,
      "the previously archived good master must survive a throttled run",
    );
  });

  test("a ZIP feed answering with non-ZIP bytes is NOT archived", async () => {
    const store = makeStore();
    setFeedArchiveStore(store);
    stubFetch("this is definitely not a zip file, but it is 200 OK and long");

    await getFeedAsset(NSE_ZIP, REFERER, NSE_BHAVCOPY);

    assert.deepEqual(store.puts, []);
    assert.equal(readFeedArchiveCounters().archiveSkipped, 1);
  });

  test("real feed bytes ARE still archived (the guard is not a blanket refusal)", async () => {
    const store = makeStore();
    setFeedArchiveStore(store);
    stubFetch(BHAVCOPY_CSV);

    await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);

    assert.equal(store.puts.length, 1);
    assert.equal(store.puts[0]!.key, BSE_KEY);
    assert.equal(readFeedArchiveCounters().archived, 1);
    assert.equal(readFeedArchiveCounters().archiveSkipped, 0);
  });
});

// ─── FIX 3 — the read side ───────────────────────────────────────────

describe("replay mode: a bad archived object degrades to a MISS", () => {
  beforeEach(() => {
    process.env.FEED_ARCHIVE_MODE = "replay";
  });

  test("archived HTML is not served as data — QA falls back to the exchange", async () => {
    // The 0-byte case was already guarded; NON-EMPTY garbage was not, and it is
    // the one that reaches the parser and yields a silent zero-row day.
    const store = makeStore({ [BSE_KEY]: THROTTLE_PAGE });
    setFeedArchiveStore(store);
    stubFetch(BHAVCOPY_CSV);

    const res = await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);

    assert.equal(await res!.text(), BHAVCOPY_CSV);
    assert.equal(fetchCalls.length, 1, "must fall back to the exchange");
    const c = readFeedArchiveCounters();
    assert.equal(c.replayRejected, 1);
    assert.equal(c.replayHits, 0);
  });

  test("a valid archived object is still served with zero exchange traffic", async () => {
    const store = makeStore({ [BSE_KEY]: BHAVCOPY_CSV });
    setFeedArchiveStore(store);
    stubFetch("FROM-EXCHANGE");

    const res = await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);

    assert.equal(await res!.text(), BHAVCOPY_CSV);
    assert.equal(fetchCalls.length, 0);
    assert.equal(readFeedArchiveCounters().replayHits, 1);
  });
});

// ─── FIX 4 — the archive write can never eat the ack budget ──────────

describe("archive write is bounded", () => {
  beforeEach(() => {
    process.env.FEED_ARCHIVE_MODE = "archive";
  });

  test("a hung `put` is abandoned and the ingest gets its bytes anyway", async () => {
    const store = makeStore();
    store.putHangs = true;
    // A 20ms deadline for the test; prod uses FEED_ARCHIVE_WRITE_TIMEOUT_MS.
    setFeedArchiveStore(store, { writeTimeoutMs: 20 });
    stubFetch(BHAVCOPY_CSV);

    const startedAt = Date.now();
    const res = await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);
    const elapsed = Date.now() - startedAt;

    assert.equal(
      await res!.text(),
      BHAVCOPY_CSV,
      "a slow archive must never cost the ingest its data",
    );
    assert.ok(
      elapsed < 5_000,
      `getFeedAsset waited ${elapsed}ms on a hung put — unbounded, so one ` +
        "slow GCS write can consume the whole 600s Pub/Sub ack deadline and " +
        "let a redelivery race dailyPrice.createMany",
    );
    assert.equal(readFeedArchiveCounters().archiveTimedOut, 1);
    assert.equal(
      readFeedArchiveCounters().archiveFailed,
      0,
      "a timeout is an archive SKIP, never a fetch failure",
    );
  });

  test("a slow-but-finishing `put` inside the deadline still archives", async () => {
    const store = makeStore();
    store.putDelayMs = 5;
    setFeedArchiveStore(store, { writeTimeoutMs: 500 });
    stubFetch(BHAVCOPY_CSV);

    await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);

    assert.equal(store.puts.length, 1);
    assert.equal(readFeedArchiveCounters().archived, 1);
    assert.equal(readFeedArchiveCounters().archiveTimedOut, 0);
  });

  test("a rejecting `put` STILL does not fail the ingest (unchanged)", async () => {
    // The failure path was already correct and tested; the deadline must not
    // have regressed it into a throw.
    const store = makeStore();
    store.put = async () => {
      throw new Error("simulated GCS write outage");
    };
    setFeedArchiveStore(store, { writeTimeoutMs: 500 });
    stubFetch(MASTER_CSV);

    const res = await getFeedAsset(MASTER, REFERER, EQUITY_MASTER);

    assert.equal(await res!.text(), MASTER_CSV);
    assert.equal(readFeedArchiveCounters().archiveFailed, 1);
    assert.equal(readFeedArchiveCounters().archiveTimedOut, 0);
  });

  test("a hung replay READ is abandoned and falls back to the exchange", async () => {
    process.env.FEED_ARCHIVE_MODE = "replay";
    const store = makeStore();
    store.get = async () => new Promise<Buffer | null>(() => {});
    setFeedArchiveStore(store, { readTimeoutMs: 20 });
    stubFetch(BHAVCOPY_CSV);

    const startedAt = Date.now();
    const res = await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);

    assert.equal(await res!.text(), BHAVCOPY_CSV);
    assert.ok(Date.now() - startedAt < 5_000);
    assert.equal(readFeedArchiveCounters().replayMisses, 1);
  });

  test("the shipped default is a real bound, not Infinity", () => {
    assert.ok(
      Number.isFinite(FEED_ARCHIVE_WRITE_TIMEOUT_MS) &&
        FEED_ARCHIVE_WRITE_TIMEOUT_MS > 0 &&
        FEED_ARCHIVE_WRITE_TIMEOUT_MS <= 60_000,
      "must stay a small fraction of the 600s Pub/Sub ack deadline",
    );
  });

  test("re-registering without options restores the default deadline", () => {
    // A leaked 20ms deadline from a previous registration would silently stop
    // prod archiving anything at all.
    const store = makeStore();
    setFeedArchiveStore(store, { writeTimeoutMs: 1 });
    setFeedArchiveStore(store);
    // Observable through behaviour: a 5ms put now completes.
    store.putDelayMs = 5;
    process.env.FEED_ARCHIVE_MODE = "archive";
    stubFetch(BHAVCOPY_CSV);
    return getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY).then(() => {
      assert.equal(store.puts.length, 1);
    });
  });
});

// ─── FIX 5 — replayed vs scraped is visible ──────────────────────────

describe("feed-archive counters", () => {
  test("counts each outcome separately across a mixed run", async () => {
    process.env.FEED_ARCHIVE_MODE = "replay";
    const store = makeStore({
      [BSE_KEY]: BHAVCOPY_CSV, // a hit
      [MASTER_KEY]: THROTTLE_PAGE, // archived garbage → rejected
    });
    setFeedArchiveStore(store);
    stubFetch(MASTER_CSV);

    const before = readFeedArchiveCounters();
    await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY); // hit
    await getFeedAsset(MASTER, REFERER, EQUITY_MASTER); // rejected
    await getFeedAsset(
      "https://x/ind_close_all_27072026.csv",
      REFERER,
      { exchange: "NSE", feed: "indices", date: DAY }, // miss
    );

    const delta = diffFeedArchiveCounters(before, readFeedArchiveCounters());
    assert.deepEqual(delta, {
      replayHits: 1,
      replayMisses: 1,
      replayRejected: 1,
      archived: 0,
      archiveSkipped: 0,
      archiveFailed: 0,
      archiveTimedOut: 0,
    });
  });

  test("readFeedArchiveCounters returns a COPY, so before/after can differ", async () => {
    // Handing back the live object would make every snapshot-diff read zero —
    // the counters would exist and report nothing, which is worse than absent.
    process.env.FEED_ARCHIVE_MODE = "replay";
    setFeedArchiveStore(makeStore());
    stubFetch(BHAVCOPY_CSV);

    const before = readFeedArchiveCounters();
    await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);
    const after = readFeedArchiveCounters();

    assert.equal(before.replayMisses, 0);
    assert.equal(after.replayMisses, 1);
    assert.equal(
      diffFeedArchiveCounters(before, after).replayMisses,
      1,
      "the per-run delta is what lands on MarketDataSyncLog.metadata",
    );
  });

  test("the diff never goes negative", () => {
    const high = { ...readFeedArchiveCounters(), replayHits: 5 };
    const low = { ...readFeedArchiveCounters(), replayHits: 0 };
    assert.equal(diffFeedArchiveCounters(high, low).replayHits, 0);
  });

  test("mode off touches no counter (byte-identical to pre-MONEY-1085)", async () => {
    setFeedArchiveStore(makeStore());
    stubFetch(BHAVCOPY_CSV);
    await getFeedAsset(BSE_CSV, REFERER, BSE_BHAVCOPY);
    assert.deepEqual(readFeedArchiveCounters(), {
      replayHits: 0,
      replayMisses: 0,
      replayRejected: 0,
      archived: 0,
      archiveSkipped: 0,
      archiveFailed: 0,
      archiveTimedOut: 0,
    });
  });
});

// ─── FIX 5 — the counters actually reach the database ────────────────

describe("ingest jobs persist the counters on MarketDataSyncLog", () => {
  /**
   * A source scan, for the same reason `no-feed-fetch-bypass.test.ts` is one:
   * both call sites construct a Prisma client at module scope, so importing
   * them from a unit test would open a real DB connection. What must not
   * regress is the WIRING — counters that are collected but never written are
   * exactly the invisible-failure shape this fix exists to remove.
   */
  const CALL_SITES = [
    join(REPO_ROOT, "workers", "src", "processors", "bhavcopy-sync.ts"),
    join(
      REPO_ROOT,
      "packages",
      "core",
      "src",
      "market-data",
      "instruments",
      "instrument-sync.ts",
    ),
  ];

  for (const file of CALL_SITES) {
    test(`${file.split("/").slice(-1)[0]} snapshots, diffs and writes them`, () => {
      const src = readFileSync(file, "utf8");
      assert.match(
        src,
        /readFeedArchiveCounters\(\)/,
        "must snapshot the counters",
      );
      assert.match(
        src,
        /diffFeedArchiveCounters\(/,
        "must diff rather than reset — two ingest jobs can overlap in one " +
          "worker process and a reset would steal the other's counts",
      );
      assert.match(
        src,
        /feedArchive:/,
        "the delta must reach MarketDataSyncLog.metadata — a counter that is " +
          "never persisted leaves the DB saying COMPLETED with normal counts",
      );
      assert.match(
        src,
        /resolveFeedArchiveMode\(\)/,
        "the mode belongs on the row: 0 replay hits means something very " +
          "different under 'replay' than under 'off'",
      );
    });
  }
});
