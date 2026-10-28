/**
 * MONEY-980 C4/C5 — the candle cold store, which had never executed.
 *
 * Before this ticket `setCandleColdStore` had ZERO callers outside tests, so
 * `writeColdShard` threw in every process and `readColdShard` answered `absent`
 * for every key. The cold tier compiled, was exported, was documented, and was
 * wired to nothing. These cases are therefore not regression cover for a
 * working mechanism — they are the first exercise of one, and they are aimed at
 * the three ways it goes wrong SILENTLY:
 *
 *   - an unregistered store read as "this security has no history";
 *   - a partial write REPLACING a symbol-year instead of merging into it;
 *   - an eviction that clears the fresh entry and leaves the `:last-good` twin,
 *     which looks exactly like an eviction that worked.
 *
 * The store is process-global module state, so every case registers its own
 * fake and clears it afterwards, and each uses a DISTINCT symbol — the read
 * path is cached, and a shared symbol would let one case serve another's bytes.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  setCandleColdStore,
  getCandleColdStore,
  readColdShard,
  readColdShardUncached,
  writeColdShard,
  evictColdShard,
  CANDLE_COLD_TIMEOUT_MS,
  COLD_CACHE_SCOPE,
  COLD_CACHE_LAST_GOOD_SUFFIX,
  type CandleColdStore,
} from "../../src/market-data/candles/candle-cold-store";
import {
  decodeColdShard,
  sniffColdShardFormat,
  type CandleBar,
} from "../../src/market-data/candles/candle-logic";
import { SINGLE_FLIGHT_TIMEOUT_MS } from "../../src/cache/stale-while-error";

const CORE = join(import.meta.dirname, "..", "..");
const REPO = join(CORE, "..", "..");
const read = (...parts: string[]): string =>
  readFileSync(join(REPO, ...parts), "utf8");

/**
 * Source with comments stripped.
 *
 * A naive `src.includes("listFiles")` matched the PROSE explaining why there is
 * no `listFiles` — a scan that fires on its own documentation is a scan that
 * gets deleted rather than fixed. Comments out, then look for the call.
 *
 * ## LINE BEFORE BLOCK, and the order is not cosmetic (MONEY-1143)
 *
 * Strip block comments first and a `//` comment containing a `/*` opens a
 * phantom block that runs to the next `*` + `/` — hundreds of lines away.
 * Measured on the real tree, that deleted 11,192 characters from one file with
 * live call sites inside them.
 *
 * Every scan below asserts an ABSENCE — no `listFiles`, no `list` member. When
 * the text is eaten, the absence assertion passes BECAUSE THE CODE IS GONE,
 * not because the property holds. It is the one failure mode where a broken
 * test and a healthy test are indistinguishable, which is why
 * `apps/web/__tests__/meta/comment-strip-ordering.test.ts` fails the build on
 * the reverse order rather than trusting anyone to remember.
 */
const codeOnly = (src: string): string =>
  src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

function bar(iso: string, over: Partial<CandleBar> = {}): CandleBar {
  return {
    symbol: "TEST",
    exchange: "NASDAQ",
    timeframe: "D1",
    ts: new Date(`${iso}T00:00:00Z`),
    listingId: "TEST:NASDAQ:1980-12-12",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    ...over,
  };
}

/**
 * An in-memory store, plus a log of what it was asked to do.
 *
 * `put` RECORDS ITS THIRD ARGUMENT. It used to take `(key, body)` and drop the
 * content type on the floor, and nothing in this file or any other asserted
 * what label a shard was uploaded with — so mutating
 * `coldShardContentType(format)` to a constant left 424 cases green while every
 * parquet shard went up labelled `application/gzip`. TypeScript cannot catch
 * that: a 2-arg function is assignable to a 3-arg signature. The join is
 * covered by "the content type stamped on the object follows the FORMAT" below.
 */
function fakeStore(): {
  store: CandleColdStore;
  objects: Map<string, Buffer>;
  gets: string[];
  puts: string[];
  contentTypes: string[];
} {
  const objects = new Map<string, Buffer>();
  const gets: string[] = [];
  const puts: string[] = [];
  const contentTypes: string[] = [];
  return {
    objects,
    gets,
    puts,
    contentTypes,
    store: {
      async get(key) {
        gets.push(key);
        return objects.get(key) ?? null;
      },
      async put(key, body, contentType) {
        puts.push(key);
        contentTypes.push(contentType);
        objects.set(key, Buffer.from(body));
      },
    },
  };
}

afterEach(() => setCandleColdStore(null));

describe("registration — an unregistered store is LOUD on write, quiet on read", () => {
  beforeEach(() => setCandleColdStore(null));

  it("writeColdShard THROWS rather than no-opping", async () => {
    // The single most important assertion in this file. `scripts/jobs/tiingo-us-backfill.ts`
    // fails CLOSED on this throw rather than walking 72,685 symbols archiving
    // nothing, so a silent no-op here would turn a backfill that did nothing
    // into a backfill that reported success — the MONEY-1255 shape, at the
    // scale of the entire US price history.
    await assert.rejects(
      () =>
        writeColdShard({
          market: "US",
          timeframe: "D1",
          symbol: "NOSTORE",
          year: 2010,
          bars: [bar("2010-01-04")],
        }),
      /no cold store registered/,
    );
  });

  it("readColdShard answers `absent`, and absent is an ANSWER", async () => {
    // Deliberately NOT a throw, and deliberately not `failed`. With no store
    // registered "everything we hold is hot" is TRUE, which is the correct
    // reading for local dev and for any env that has not opted in.
    const outcome = await readColdShard({
      market: "US",
      timeframe: "D1",
      symbol: "NOSTORE2",
      year: 2010,
    });
    assert.equal(outcome.status, "absent");
  });

  it("getCandleColdStore reports the registration, and null clears it", () => {
    const { store } = fakeStore();
    setCandleColdStore(store);
    assert.equal(getCandleColdStore(), store);
    setCandleColdStore(null);
    assert.equal(getCandleColdStore(), null);
  });
});

describe("writeColdShard — a GCS write is a REPLACE, so it MERGES", () => {
  it("keeps the months a partial write did not mention", async () => {
    // The failure this prevents draws a shorter line and raises no error:
    // handed March, a naive write leaves the 2014 object holding March alone.
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "D1", symbol: "MERGE1", year: 2014 };

    await writeColdShard({
      ...key,
      bars: [
        bar("2014-01-02", { symbol: "MERGE1" }),
        bar("2014-02-03", { symbol: "MERGE1" }),
      ],
    });
    const second = await writeColdShard({
      ...key,
      bars: [bar("2014-03-04", { symbol: "MERGE1" })],
    });

    assert.equal(second.merged, true, "the second write must have read first");
    assert.equal(second.bars, 3);
    const stored = await decodeColdShard(
      f.objects.get("candles/US/D1/MERGE1/2014")!,
    );
    assert.deepEqual(
      stored.map((b) => b.ts.toISOString().slice(0, 10)),
      ["2014-01-02", "2014-02-03", "2014-03-04"],
    );
  });

  it("the merge read is UNCACHED — it goes to the store every time", async () => {
    // Merging onto `readColdShard`'s 6h-cached copy would union today's bars
    // with the shard as it stood hours ago and then WRITE THAT BACK, turning a
    // stale read into a permanent one. Asserted by counting the store's own
    // `get` calls, which a cache hit would skip.
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "D1", symbol: "MERGE2", year: 2014 };

    await writeColdShard({
      ...key,
      bars: [bar("2014-01-02", { symbol: "MERGE2" })],
    });
    await writeColdShard({
      ...key,
      bars: [bar("2014-02-03", { symbol: "MERGE2" })],
    });
    await writeColdShard({
      ...key,
      bars: [bar("2014-03-04", { symbol: "MERGE2" })],
    });

    assert.equal(f.gets.length, 3, "one uncached GET per write");
    assert.equal(
      f.gets.every((k) => k === "candles/US/D1/MERGE2/2014"),
      true,
    );

    // The count above is NOT sufficient on its own and that is worth stating:
    // `readColdShard` also calls `active.get` on a cache MISS, so a merge
    // rewritten to read through the cache produces the same three gets in a
    // test process with no Redis. The behaviour is indistinguishable here and
    // catastrophic in production — a 6h-old shard unioned with today's bars and
    // written back, turning a stale READ into a permanent one. So the call is
    // pinned structurally as well.
    const body = read(
      "packages",
      "core",
      "src",
      "market-data",
      "candles",
      "candle-cold-store.ts",
    ).slice(0);
    const fn = body.slice(
      body.indexOf("export async function writeColdShard"),
      body.indexOf("export async function evictColdShard"),
    );
    assert.ok(
      fn.includes("await withDeadline(active.get(key), key)"),
      "the merge must read the STORE directly",
    );
    assert.equal(
      fn.includes("readColdShard("),
      false,
      "the merge must NOT read through the 6h cache",
    );
  });

  it("merges a JSONL shard and re-writes it as parquet — a half-converted bucket is safe", async () => {
    // The property that makes CANDLE_COLD_FORMAT flippable at all. The key
    // carries no extension, so an existing object's format is whatever it was
    // written as; the merge must READ that (via magic bytes) and WRITE the
    // configured one. If it could only read what it writes, flipping the switch
    // would make every pre-existing shard unreadable — and `writeColdShard`
    // would replace it with a partial year rather than fail.
    const saved = process.env.CANDLE_COLD_FORMAT;
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "D1", symbol: "XFMT", year: 2014 };
    const objectKey = "candles/US/D1/XFMT/2014";

    try {
      delete process.env.CANDLE_COLD_FORMAT;
      await writeColdShard({
        ...key,
        bars: [
          bar("2014-01-02", { symbol: "XFMT" }),
          bar("2014-02-03", { symbol: "XFMT", close: 111 }),
        ],
      });
      assert.equal(
        sniffColdShardFormat(f.objects.get(objectKey)!),
        "JSONL_GZ",
        "the first write must land as JSONL",
      );
      // THE JOIN, which nothing used to assert: `writeColdShard` passes
      // `coldShardContentType(format)` as `put`'s third argument, and the fake
      // dropped it. Mutating that call to a constant left 424 cases green while
      // every parquet shard uploaded labelled `application/gzip` — metadata a
      // human with `gsutil stat` and a downstream Python reader filtering a
      // listing both trust. Asserted BESIDE the sniff, so the label and the
      // bytes are checked against each other rather than each in isolation.
      assert.equal(f.contentTypes.at(-1), "application/gzip");

      process.env.CANDLE_COLD_FORMAT = "parquet";
      const second = await writeColdShard({
        ...key,
        bars: [
          // OVERLAPS the JSONL shard on (symbol, exchange, timeframe, ts).
          // Without dedupe the union is four bars, not three, and the chart
          // draws the same day twice with two different closes.
          bar("2014-02-03", { symbol: "XFMT", close: 222 }),
          bar("2014-03-04", { symbol: "XFMT" }),
        ],
      });

      assert.equal(second.merged, true);
      assert.equal(second.bars, 3, "sorted UNION, deduped on the natural key");
      assert.equal(
        sniffColdShardFormat(f.objects.get(objectKey)!),
        "PARQUET",
        "the re-write must use the CONFIGURED format, not the one it read",
      );
      assert.equal(
        f.contentTypes.at(-1),
        "application/vnd.apache.parquet",
        "a parquet shard must not go up labelled application/gzip",
      );

      const stored = await decodeColdShard(f.objects.get(objectKey)!);
      assert.deepEqual(
        stored.map((b) => b.ts.toISOString().slice(0, 10)),
        ["2014-01-02", "2014-02-03", "2014-03-04"],
      );
      assert.equal(
        stored[1]!.close,
        222,
        "incoming wins the overlap, as it does within one format",
      );

      // And back again: a parquet shard merges into JSONL just as readily, so
      // the switch is reversible and the bucket may stay mixed indefinitely.
      delete process.env.CANDLE_COLD_FORMAT;
      const third = await writeColdShard({
        ...key,
        bars: [bar("2014-04-07", { symbol: "XFMT" })],
      });
      assert.equal(third.merged, true);
      assert.equal(third.bars, 4);
      assert.equal(sniffColdShardFormat(f.objects.get(objectKey)!), "JSONL_GZ");
      assert.equal(f.contentTypes.at(-1), "application/gzip");
      assert.equal(
        (await decodeColdShard(f.objects.get(objectKey)!)).length,
        4,
      );

      // The label FOLLOWS the bytes on every write, not just the last one — a
      // stamp that only tracked the env at the first write would pass all three
      // point checks above if they ran in the other order.
      assert.deepEqual(f.contentTypes, [
        "application/gzip",
        "application/vnd.apache.parquet",
        "application/gzip",
      ]);
      assert.equal(
        f.contentTypes.length,
        f.puts.length,
        "every put carried a content type",
      );
    } finally {
      if (saved === undefined) delete process.env.CANDLE_COLD_FORMAT;
      else process.env.CANDLE_COLD_FORMAT = saved;
    }
  });

  it("the FIRST write of a year does not report itself as merged", async () => {
    const f = fakeStore();
    setCandleColdStore(f.store);
    const res = await writeColdShard({
      market: "US",
      timeframe: "D1",
      symbol: "MERGE3",
      year: 2014,
      bars: [bar("2014-01-02", { symbol: "MERGE3" })],
    });
    assert.equal(res.merged, false);
    assert.equal(res.bars, 1);
    assert.equal(f.gets.length, 1, "it still LOOKED, it just found nothing");
  });

  it("`merge: false` skips the read and REPLACES — the full-year path", async () => {
    // The backfill fetches a security's entire history in one request, so the
    // read would be pure cost across ~231,825 shards. Opt-in, never the
    // default: the default has to be the one that cannot lose data.
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "D1", symbol: "MERGE4", year: 2014 };

    await writeColdShard({
      ...key,
      bars: [bar("2014-01-02", { symbol: "MERGE4" })],
    });
    const getsAfterFirst = f.gets.length;
    const res = await writeColdShard({
      ...key,
      bars: [bar("2014-03-04", { symbol: "MERGE4" })],
      merge: false,
    });

    assert.equal(res.merged, false);
    assert.equal(f.gets.length, getsAfterFirst, "no read at all");
    const stored = await decodeColdShard(
      f.objects.get("candles/US/D1/MERGE4/2014")!,
    );
    assert.deepEqual(
      stored.map((b) => b.ts.toISOString().slice(0, 10)),
      ["2014-03-04"],
    );
  });

  it("the round trip survives: written bytes decode to the same bars", async () => {
    const f = fakeStore();
    setCandleColdStore(f.store);
    const bars = [
      bar("2014-01-02", { symbol: "RT", close: 11.25, volume: 4_500_000_000 }),
      bar("2014-01-03", {
        symbol: "RT",
        close: 12.5,
        divCash: 0.22,
        splitFactor: 4,
      }),
    ];
    await writeColdShard({
      market: "US",
      timeframe: "D1",
      symbol: "RT",
      year: 2014,
      bars,
    });
    const outcome = await readColdShard({
      market: "US",
      timeframe: "D1",
      symbol: "RT",
      year: 2014,
    });
    assert.equal(outcome.status, "present");
    if (outcome.status !== "present") return;
    assert.equal(outcome.bars.length, 2);
    assert.equal(outcome.bars[1]?.close, 12.5);
    assert.equal(outcome.bars[1]?.divCash, 0.22);
    assert.equal(outcome.bars[1]?.splitFactor, 4);
    assert.equal(outcome.bars[0]?.volume, 4_500_000_000);
    // `ts` must come back a real Date. The cache round-trips through JSON and
    // the revive happens at the boundary; a string here poisons every consumer.
    assert.equal(outcome.bars[0]?.ts instanceof Date, true);
  });

  it("a store that THROWS on put propagates — never a quiet success", async () => {
    setCandleColdStore({
      async get() {
        return null;
      },
      async put() {
        throw new Error("403 from GCS");
      },
    });
    await assert.rejects(
      () =>
        writeColdShard({
          market: "US",
          timeframe: "D1",
          symbol: "THROWS",
          year: 2010,
          bars: [bar("2010-01-04", { symbol: "THROWS" })],
        }),
      /403 from GCS/,
    );
  });
});

describe("evictColdShard — both entries, and never a throw", () => {
  it("returns true and does not throw with no cache reachable", async () => {
    // A cache that cannot be reached is a SLOW read, not a wrong one, and a
    // completed object write must never be reported as a failure because its
    // invalidation could not run.
    setCandleColdStore(fakeStore().store);
    await assert.doesNotReject(() =>
      evictColdShard({
        market: "US",
        timeframe: "D1",
        symbol: "EV",
        year: 2010,
      }),
    );
  });

  it("clears the `:last-good` TWIN as well as the fresh entry", () => {
    // Source-scanned rather than mocked, because `deleteCached` binds to the
    // process-wide cache client and there is nothing to observe without one.
    // Dropping only the fresh copy would leave a failed recompute serving the
    // PRE-WRITE shard out of the stale entry for up to seven days — an eviction
    // that looks complete and is not.
    const src = read(
      "packages",
      "core",
      "src",
      "market-data",
      "candles",
      "candle-cold-store.ts",
    );
    const body = src.slice(
      src.indexOf("export async function evictColdShard"),
      src.indexOf("/* ", src.indexOf("export async function evictColdShard")),
    );
    assert.ok(body.length > 100, "evictColdShard body not found");
    assert.equal(
      (body.match(/deleteCached\(/g) ?? []).length,
      2,
      "both the fresh entry and the :last-good twin must be deleted",
    );
    assert.ok(body.includes("COLD_CACHE_LAST_GOOD_SUFFIX"));
    assert.ok(body.includes("COLD_CACHE_SCOPE"));
    assert.ok(
      body.includes("CANDLE_COLD_CACHE_MODULE"),
      "the module must come from the constant the read path uses",
    );
  });

  it("writeColdShard evicts what it just moved", () => {
    // The reason this entry point exists at all: an object that has moved under
    // a 6h cache is a stale read. `CA_EVICTION_UNAVAILABLE` used to argue leg
    // (c) applied nothing partly because no entry point existed; that half is
    // retracted, and this is what retracted it.
    const src = read(
      "packages",
      "core",
      "src",
      "market-data",
      "candles",
      "candle-cold-store.ts",
    );
    const body = src.slice(
      src.indexOf("export async function writeColdShard"),
      src.indexOf("export async function evictColdShard"),
    );
    assert.ok(body.includes("await evictColdShard(args);"));
  });
});

describe("the copied constants are PINNED to their originals", () => {
  it("`:last-good` still matches what cachedWithStaleFallback appends", () => {
    // A copied constant is only safe when something fails on the day it stops
    // being a copy — the same guard `TIINGO_BACKOFF_BASE_MS` carries in
    // `us-eod-sync.ts`. `stale-while-error.ts` builds this as a local and does
    // not export it, so the only alternative to copying is reaching into a
    // private.
    const src = read(
      "packages",
      "core",
      "src",
      "cache",
      "stale-while-error.ts",
    );
    assert.ok(
      src.includes("const lastGoodId = `${identifier}:last-good`;"),
      "stale-while-error.ts no longer builds the twin as `${identifier}:last-good` — " +
        "COLD_CACHE_LAST_GOOD_SUFFIX is now WRONG and every eviction leaves a stale copy",
    );
    assert.equal(COLD_CACHE_LAST_GOOD_SUFFIX, ":last-good");
  });

  it("the scope literal is declared ONCE, not spelled twice", () => {
    // `CA_EVICTION_UNAVAILABLE` refused to rebuild this key on the grounds that
    // two of its segments were private to modules the job must not restate. The
    // fix was to name them, not to argue — so the literal must not reappear.
    const src = read(
      "packages",
      "core",
      "src",
      "market-data",
      "candles",
      "candle-cold-store.ts",
    );
    assert.equal(COLD_CACHE_SCOPE, "_global");
    assert.equal(
      (src.match(/"_global"/g) ?? []).length,
      1,
      "the scope must be the COLD_CACHE_SCOPE declaration and nothing else",
    );
  });

  it("the deadline stays INSIDE the single-flight backstop", () => {
    // MONEY-1135: a backstop that fires before the mechanism it backs up does
    // not protect that mechanism, it replaces it. The subtraction makes the
    // ordering structural; this asserts the ordering it produces.
    assert.ok(
      CANDLE_COLD_TIMEOUT_MS < SINGLE_FLIGHT_TIMEOUT_MS,
      `${CANDLE_COLD_TIMEOUT_MS} must be under the ${SINGLE_FLIGHT_TIMEOUT_MS}ms backstop`,
    );
    assert.ok(CANDLE_COLD_TIMEOUT_MS >= 5_000);
  });
});

describe("the port has no `list`, and that is enforced", () => {
  it("nothing in the cold store reaches listFiles", () => {
    // `listFiles` in @usemoney/storage FAILS OPEN to `[]` on an auth or network
    // error (MONEY-941), so a listing-driven read would report "this security
    // has no history" for a credentials problem. The read computes candidate
    // year keys from the range and `get`s each one instead.
    for (const file of ["candle-cold-store.ts", "candle-repository.ts"]) {
      const src = codeOnly(
        read("packages", "core", "src", "market-data", "candles", file),
      );
      assert.equal(
        /\blistFiles\b/.test(src),
        false,
        `${file} must not list a prefix to decide what exists`,
      );
      // The port itself. A `list` member added to the interface is how the
      // read path would gain the ability in the first place.
      assert.equal(
        /^\s*list\s*[(<:]/m.test(src),
        false,
        `${file} must not declare a list member on the port`,
      );
    }
  });

  it("the worker adapter passes isPublic: false", () => {
    // `uploadFile` DEFAULTS `isPublic: true`, and a public upload resolves
    // GCP_PUBLIC_STORAGE_BUCKET rather than GCP_STORAGE_BUCKET (MONEY-865).
    // These are licensed price series on a plan whose licence is INTERNAL USE
    // ONLY, so a public object is a redistribution act, not just a wrong bucket.
    const src = codeOnly(
      read("workers", "src", "lib", "candle-cold-store-gcs.ts"),
    );
    assert.ok(src.includes("isPublic: false"));
    assert.equal(
      src.includes("isPublic: true"),
      false,
      "a public upload resolves the PUBLIC bucket, not GCP_STORAGE_BUCKET",
    );
    assert.equal(
      /\blistFiles\b/.test(src),
      false,
      "the adapter must not add a list",
    );
  });

  it("the worker registers the store at boot", () => {
    // MERGED IS NOT WIRED (MONEY-1220). `setCandleColdStore` had zero non-test
    // callers before this ticket, which is exactly how a fully-built cold tier
    // ran in no runtime at all.
    const src = read("workers", "src", "index.ts");
    assert.ok(src.includes("initCandleColdStore"));
    assert.ok(
      src.includes("initCandleColdStore();"),
      "imported is not called — the defect this assertion exists for",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1373 — readColdShardUncached
   ──────────────────────────────────────────────────────────────────────── */

describe("readColdShardUncached — the eviction job's read", () => {
  it("goes to the STORE on every call, never to a cached copy", async () => {
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "M1", symbol: "UNC1", year: 2026 };
    await writeColdShard({
      ...key,
      bars: [bar("2026-01-02", { symbol: "UNC1", timeframe: "M1" })],
    });
    const before = f.gets.length;

    await readColdShardUncached(key);
    await readColdShardUncached(key);

    assert.equal(
      f.gets.length - before,
      2,
      "two reads must be two GETs — a cached second read would be one",
    );
  });

  it("WRITES NOTHING to the cache — a later cached read still hits the store", async () => {
    // The point of the whole function. `cachedWithStaleFallback` writes TWO
    // Redis entries per key (the fresh one and its `:last-good` twin) holding
    // the DECODED shard as JSON, with no size guard. A 242,000-bar M1
    // year-shard is ~36 MB that way, and the first intraday eviction night
    // walks ~14,570 units — tens of gigabytes pushed into Redis to answer a
    // question asked exactly once.
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "M1", symbol: "UNC2", year: 2026 };
    await writeColdShard({
      ...key,
      bars: [bar("2026-01-02", { symbol: "UNC2", timeframe: "M1" })],
    });

    await readColdShardUncached(key);
    const before = f.gets.length;
    // If the uncached read had populated the cache, THIS read would be served
    // from it and the store would not be touched.
    const cached = await readColdShard(key);
    assert.equal(cached.status, "present");
    assert.equal(
      f.gets.length - before,
      1,
      "the uncached read must not have primed the cache",
    );
  });

  it("`failed` is DISTINGUISHABLE from `absent`", async () => {
    // Collapsing them is this repo's most expensive recurring bug, and on the
    // DELETE side it decides whether a GCS outage reads as "there is no shard,
    // so this row was never archived". Both resolve to KEEP; only one is worth
    // waking somebody.
    setCandleColdStore({
      async get() {
        throw new Error("503 from GCS");
      },
      async put() {},
    });
    const failed = await readColdShardUncached({
      market: "US",
      timeframe: "M1",
      symbol: "UNC3",
      year: 2026,
    });
    assert.equal(failed.status, "failed");
    assert.equal(
      failed.status === "failed" && (failed.error as Error).message,
      "503 from GCS",
      "the cause travels with the outcome",
    );

    setCandleColdStore({
      async get() {
        return null;
      },
      async put() {},
    });
    const absent = await readColdShardUncached({
      market: "US",
      timeframe: "M1",
      symbol: "UNC4",
      year: 2026,
    });
    assert.equal(absent.status, "absent");
  });

  it("a thrown read is REPORTED, never propagated", async () => {
    // The paged eviction path calls this inside a per-group loop and continues
    // on a failure. A throw would abort the whole leaf over one bad object.
    setCandleColdStore({
      async get() {
        throw new Error("boom");
      },
      async put() {},
    });
    await assert.doesNotReject(() =>
      readColdShardUncached({
        market: "US",
        timeframe: "M1",
        symbol: "UNC5",
        year: 2026,
      }),
    );
  });

  it("an unregistered store answers `absent`, matching the cached read", async () => {
    setCandleColdStore(null);
    const outcome = await readColdShardUncached({
      market: "US",
      timeframe: "M1",
      symbol: "UNC6",
      year: 2026,
    });
    assert.equal(outcome.status, "absent");
  });

  it("`ts` comes back a real Date, with no JSON round trip to revive", async () => {
    const f = fakeStore();
    setCandleColdStore(f.store);
    const key = { market: "US", timeframe: "M1", symbol: "UNC7", year: 2026 };
    await writeColdShard({
      ...key,
      bars: [bar("2026-01-02", { symbol: "UNC7", timeframe: "M1" })],
    });
    const outcome = await readColdShardUncached(key);
    assert.equal(outcome.status, "present");
    if (outcome.status !== "present") return;
    assert.equal(outcome.bars[0]?.ts instanceof Date, true);
    assert.equal(outcome.bars[0]?.ts.toISOString(), "2026-01-02T00:00:00.000Z");
  });

  it("SOURCE: the function body does not reach the cache at all", () => {
    const body = read(
      "packages",
      "core",
      "src",
      "market-data",
      "candles",
      "candle-cold-store.ts",
    );
    const fn = codeOnly(body).slice(
      codeOnly(body).indexOf("export async function readColdShardUncached"),
      codeOnly(body).indexOf("export async function writeColdShard"),
    );
    assert.ok(fn.length > 100, "the scan found the function");
    assert.equal(
      fn.includes("cachedWithStaleFallback"),
      false,
      "the uncached read must not go through the cache primitive",
    );
    // CONTROL: the scan CAN see that call — it is right there in the cached read.
    const cached = codeOnly(body).slice(
      codeOnly(body).indexOf("export async function readColdShard("),
      codeOnly(body).indexOf("export async function readColdShardUncached"),
    );
    assert.ok(cached.includes("cachedWithStaleFallback"));
  });
});
