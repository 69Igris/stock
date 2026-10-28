/**
 * The purchase manifest — MONEY-1373.
 *
 * This validates the REAL checked-in file, not a fixture. The manifest is the
 * only statement of what we buy, and a schema tested against an invented object
 * proves nothing about the document the jobs will read.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  chunkSymbols,
  parseManifest,
  resolveEntryRange,
  resolveSymbolSet,
  symbolsHash,
  type DatabentoManifest,
  datasetForEntry,
  manifestEntrySchema,
} from "../../src/market-data/databento/databento-manifest-logic";
import {
  DATABENTO_MAX_SYMBOLS_PER_REQUEST,
  EQUS_MINI_HISTORY_FLOOR,
  isLoadableSchema,
} from "../../src/market-data/databento/databento-logic";

// CWD is `packages/core`.
const MANIFEST_PATH = join(
  "..",
  "..",
  "scripts",
  "data",
  "databento-manifest.json",
);
const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;

describe("the checked-in manifest is valid", () => {
  it("parses", () => {
    const m = parseManifest(raw);
    assert.equal(m.dataset, "EQUS.MINI");
    assert.equal(m.historyFloor, EQUS_MINI_HISTORY_FLOOR);
  });

  it("[premise] carries a real S&P baseline, not a placeholder", () => {
    // A manifest that validated against three example tickers would pass every
    // other case in this file while buying almost nothing.
    const m = parseManifest(raw);
    const baseline = m.symbolSets["BASELINE"];
    assert.ok(Array.isArray(baseline), "BASELINE is not a literal list");
    assert.ok(
      baseline.length >= 480 && baseline.length <= 520,
      `BASELINE holds ${baseline.length} symbols; the S&P 500 is ~503`,
    );
    assert.ok(baseline.includes("AAPL"));
    // The share-class conversion actually happened: SSGA publishes BRK.B and
    // our master keys on BRK-B.
    assert.ok(
      baseline.includes("BRK-B"),
      "BRK-B is missing — dot form not converted",
    );
    assert.ok(
      !baseline.includes("BRK.B"),
      "BRK.B is present — vendor notation leaked in",
    );
  });

  it("every symbol looks like a ticker we could resolve", () => {
    const m = parseManifest(raw);
    const bad: string[] = [];
    for (const [name, set] of Object.entries(m.symbolSets)) {
      if (!Array.isArray(set)) continue;
      for (const s of set) {
        if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(s)) bad.push(`${name}:${s}`);
      }
    }
    // SSGA's workbook carries non-ticker rows — a bare "-" and a SEDOL-shaped
    // "2602335D". Both must have been dropped by the refresh script; either one
    // reaching the manifest would quarantine every bar it produced.
    assert.deepEqual(bad, []);
  });
});

describe("what the manifest may NOT say", () => {
  const withEntry = (patch: Record<string, unknown>): unknown => {
    const m = JSON.parse(JSON.stringify(raw)) as { entries: unknown[] };
    m.entries = [{ ...(m.entries[0] as object), ...patch }];
    return m;
  };

  it("REFUSES an ohlcv-1d entry — Tiingo owns the daily series", () => {
    // The structural half of "no 1d harvest". The displacement rule refuses a
    // D1 write at run time; this refuses it at edit time, before a quote costs
    // anything.
    assert.throws(() => parseManifest(withEntry({ schema: "ohlcv-1d" })));
  });

  it("REFUSES load:true on a schema that produces no bars", () => {
    assert.throws(() =>
      parseManifest(withEntry({ schema: "bbo-1m", load: true })),
    );
    assert.throws(() =>
      parseManifest(withEntry({ schema: "ohlcv-1s", load: true })),
    );
  });

  it("REFUSES split_symbols with ALL_SYMBOLS — the vendor does too", () => {
    assert.throws(() =>
      parseManifest(
        withEntry({ symbolSets: ["ALL_SYMBOLS"], splitSymbols: true }),
      ),
    );
  });

  it("REFUSES split_symbols with a DAY or WEEK split — the ledger cannot hold it", () => {
    // Not a preference. Every downloaded file becomes one `files[]` entry on
    // ONE ledger document, measured at 292 B each (253,341 B for 867 entries).
    // Splitting by symbol AND by day multiplies the two counts: BASELINE is
    // 507 symbols x 868 sessions = 440,076 entries ~= 128 MB, past MongoDB's
    // 16 MB per-document cap — so `replaceFileRecords` throws AFTER the vendor
    // job has been bought and paid for, and the ledger cannot even record what
    // was purchased. Refusing at parse time costs nothing.
    for (const splitDuration of ["day", "week"]) {
      assert.throws(
        () => parseManifest(withEntry({ splitSymbols: true, splitDuration })),
        /16 MB document cap|day or week split/,
        `splitSymbols + ${splitDuration} was accepted`,
      );
    }
  });

  it("ACCEPTS month and year with split_symbols, and day without it", () => {
    // The other half, so the rule is a rule and not a ban on splitting.
    // ohlcv-1s at a monthly split is 507 x 42 = 21,294 entries ~= 6.2 MB, and
    // the archive-only day-split entries carry no per-symbol multiplier at all.
    for (const splitDuration of ["month", "year"]) {
      assert.doesNotThrow(
        () => parseManifest(withEntry({ splitSymbols: true, splitDuration })),
        `splitSymbols + ${splitDuration} was refused`,
      );
    }
    assert.doesNotThrow(() =>
      parseManifest(withEntry({ splitSymbols: false, splitDuration: "day" })),
    );
  });

  it("REFUSES duplicate ids and duplicate orders", () => {
    const dupOrder = JSON.parse(JSON.stringify(raw)) as {
      entries: Array<Record<string, unknown>>;
    };
    dupOrder.entries[1]!["order"] = dupOrder.entries[0]!["order"];
    assert.throws(() => parseManifest(dupOrder));

    const dupId = JSON.parse(JSON.stringify(raw)) as {
      entries: Array<Record<string, unknown>>;
    };
    dupId.entries[1]!["id"] = dupId.entries[0]!["id"];
    assert.throws(() => parseManifest(dupId));
  });

  it("REFUSES a history floor earlier than the dataset actually carries", () => {
    const early = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    early["historyFloor"] = "2018-01-01";
    assert.throws(() => parseManifest(early), /carries nothing before/);
  });

  it("the 1s entry is ARCHIVE ONLY, by founder decision", () => {
    const m = parseManifest(raw);
    const s1 = m.entries.find((e) => e.schema === "ohlcv-1s");
    assert.ok(s1, "the ohlcv-1s entry is gone");
    assert.equal(s1.load, false);
    // And it is submitted LAST: it is TB-scale, and every other entry should
    // be safely downloaded before the 30-day window is spent on it.
    assert.equal(Math.max(...m.entries.map((e) => e.order)), s1.order);
  });

  it("every loadable entry names a schema that produces bars", () => {
    const m = parseManifest(raw);
    for (const e of m.entries) {
      if (e.load)
        assert.ok(isLoadableSchema(e.schema), `${e.id} loads ${e.schema}`);
    }
  });
});

describe("resolveEntryRange", () => {
  const m = parseManifest(raw) as DatabentoManifest;
  const now = new Date("2026-09-08T12:00:00Z"); // a Tuesday
  const opts = { now, historyFloor: m.historyFloor };
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  it("historyFloor..latest spans the dataset", () => {
    const r = resolveEntryRange({ start: "historyFloor", end: "latest" }, opts);
    assert.equal(day(r.startMs), "2023-03-28");
    assert.ok(r.endMsExclusive > r.startMs);
  });

  it("a trailing window lands on a TRADING day", () => {
    const r = resolveEntryRange(
      { start: "trailing-12mo", end: "latest" },
      opts,
    );
    const startKey = day(r.startMs);
    // Stepping forward to the next trading day matters: a window starting on a
    // Saturday asks for a session that does not exist, and the empty first day
    // reads as a gap in the coverage report.
    assert.ok(new Date(`${startKey}T12:00:00Z`).getUTCDay() !== 0);
    assert.ok(new Date(`${startKey}T12:00:00Z`).getUTCDay() !== 6);
  });

  it("CLAMPS the end to what the vendor says it holds", () => {
    // Under the T+1 embargo the newest session may not exist yet. Asking for it
    // returns nothing, which is indistinguishable from a holiday.
    const cap = Date.parse("2026-08-01T00:00:00Z");
    const r = resolveEntryRange(
      { start: "historyFloor", end: "latest" },
      { ...opts, datasetRangeEndMs: cap },
    );
    assert.equal(r.endMsExclusive, cap);
  });

  it("never starts before the floor, even when asked to", () => {
    const r = resolveEntryRange({ start: "2019-01-02", end: "latest" }, opts);
    assert.equal(day(r.startMs), "2023-03-28");
  });

  it("REFUSES a zero-width window rather than buying nothing", () => {
    assert.throws(
      () =>
        resolveEntryRange(
          { start: "2024-06-03", end: "2024-06-02" },
          { ...opts, historyFloor: "2023-03-28" },
        ),
      /empty/,
    );
  });
});

describe("symbol sets", () => {
  const m = parseManifest(raw) as DatabentoManifest;
  const noMaster = async (): Promise<string[]> => {
    throw new Error("MASTER should not have been resolved");
  };

  it("unions the literal sets, deduped and SORTED", async () => {
    const s = await resolveSymbolSet({
      names: ["BASELINE", "BENCHMARKS"],
      manifest: m,
      resolveMaster: noMaster,
    });
    assert.ok(s.includes("SPY"));
    assert.ok(s.includes("AAPL"));
    assert.deepEqual(
      s,
      [...s].sort(),
      "not sorted — the hash would be unstable",
    );
    assert.equal(new Set(s).size, s.length, "not deduped");
  });

  it("resolves MASTER through the injected reader, never from the file", async () => {
    // A fourteen-thousand-symbol list in JSON would be a second copy of a table
    // that already exists, going stale on every listing.
    const s = await resolveSymbolSet({
      names: ["MASTER"],
      manifest: m,
      resolveMaster: async () => ["ZZZ", "aaa"],
    });
    assert.deepEqual(s, ["AAA", "ZZZ"]);
  });

  it("REFUSES an undeclared set instead of submitting an empty request", async () => {
    await assert.rejects(
      () =>
        resolveSymbolSet({
          names: ["NOPE"],
          manifest: m,
          resolveMaster: noMaster,
        }),
      /not declared/,
    );
  });

  it("REFUSES a set that resolves to nothing", async () => {
    await assert.rejects(
      () =>
        resolveSymbolSet({
          names: ["MASTER"],
          manifest: m,
          resolveMaster: async () => [],
        }),
      /zero symbols/,
    );
  });
});

describe("chunking and hashing", () => {
  it("chunks at the vendor's documented per-request ceiling", () => {
    const many = Array.from({ length: 14_000 }, (_, i) => `S${i}`);
    const chunks = chunkSymbols(many);
    assert.equal(
      chunks.length,
      Math.ceil(14_000 / DATABENTO_MAX_SYMBOLS_PER_REQUEST),
    );
    assert.ok(
      chunks.every((c) => c.length <= DATABENTO_MAX_SYMBOLS_PER_REQUEST),
    );
    assert.equal(chunks.flat().length, 14_000);
  });

  it("the baseline fits in ONE request", () => {
    const m = parseManifest(raw);
    const baseline = m.symbolSets["BASELINE"] as string[];
    assert.equal(
      chunkSymbols([...baseline, "SPY", "QQQ", "DIA", "IWM"]).length,
      1,
    );
  });

  it("the hash is ORDER-INDEPENDENT — it is a purchase's idempotency key", () => {
    // A hash that changed with iteration order would buy the same window twice.
    assert.equal(symbolsHash(["B", "A", "C"]), symbolsHash(["C", "B", "A"]));
    assert.notEqual(symbolsHash(["A", "B"]), symbolsHash(["A", "B", "C"]));
    assert.match(symbolsHash(["A", "B"]), /^2-[0-9a-f]{8}$/);
  });
});

describe("a per-entry dataset override — MONEY-1373", () => {
  const base = {
    id: "x",
    schema: "statistics" as const,
    symbolSets: ["BASELINE"],
    end: "latest" as const,
    load: false,
    splitSymbols: false,
    splitDuration: "month" as const,
    append: false,
    order: 99,
  };

  it("resolves to the manifest's dataset when the entry omits one", () => {
    // The fallback lives in ONE function, because a call site that restates it
    // and gets it wrong buys the wrong data under the right entry id.
    assert.equal(
      datasetForEntry({ dataset: undefined }, { dataset: "EQUS.MINI" }),
      "EQUS.MINI",
    );
    assert.equal(
      datasetForEntry({ dataset: "EQUS.SUMMARY" }, { dataset: "EQUS.MINI" }),
      "EQUS.SUMMARY",
    );
  });

  it("REFUSES an override that inherits the manifest's history floor", () => {
    // `historyFloor` is EQUS.MINI's 2023-03-28; EQUS.SUMMARY begins
    // 2024-07-01. Measured: asking earlier is 422
    // data_start_before_available_start.
    assert.throws(
      () =>
        manifestEntrySchema.parse({
          ...base,
          dataset: "EQUS.SUMMARY",
          start: "historyFloor",
        }),
      /must carry an explicit `start`/,
    );
  });

  it("accepts an override with an explicit start", () => {
    const e = manifestEntrySchema.parse({
      ...base,
      dataset: "EQUS.SUMMARY",
      start: "2024-07-01",
    });
    assert.equal(e.dataset, "EQUS.SUMMARY");
  });

  it("leaves an entry with NO override free to use historyFloor", () => {
    const e = manifestEntrySchema.parse({
      ...base,
      schema: "ohlcv-1m" as const,
      start: "historyFloor",
    });
    assert.equal(e.dataset, undefined);
  });
});
