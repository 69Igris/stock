/**
 * The pure Databento layer — MONEY-1373.
 *
 * Every response fixture below is hand-written from the vendor's OWN client
 * sources (`databento/databento-python`'s notebooks and tests, `databento/dbn`'s
 * CSV serializer, `databento/databento-rs`'s typed structs), and the CSV shapes
 * were produced by DECODING their checked-in test data. They are replaced with
 * live captures by `scripts/data/databento-probe.ts --capture-fixtures` the
 * first time the founder runs it against a real key.
 *
 * The most valuable case in this file is `parseOhlcvHeader` against a SHUFFLED
 * header. MONEY-980 finding 1 is the reason: Tiingo's documented column order
 * is `date,open,…` and the live header is `date,close,high,low,open,…`, so a
 * positional parser written from the docs swapped open and close on every US
 * security — no error, correct row count, wrong candle. A parser that reads by
 * name survives a reorder; one that reads by position fails that test and
 * nothing else.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createZstdCompress } from "node:zlib";

import {
  DATABENTO_ALL_SYMBOLS,
  archiveJobsWithoutLedgerRow,
  DATABENTO_MAX_SYMBOLS_PER_REQUEST,
  EQUS_MINI_HISTORY_FLOOR,
  LOADABLE_SCHEMAS,
  SCHEMA_TIMEFRAME,
  buildCostQuery,
  buildSubmitJobForm,
  classifyDatabentoHttp,
  classifyFile,
  databentoArchiveKey,
  expectedSessions,
  fromDatabentoSymbol,
  isLoadableSchema,
  fileSessionDate,
  parseBboHeader,
  parseBboRow,
  parseDatasetRange,
  parseJobResponse,
  parseJobSummary,
  parseListFiles,
  parseNanoTimestamp,
  parseOhlcvHeader,
  parseOhlcvRow,
  parseSymbologyResult,
  renderSymbolsParam,
  toDatabentoInstant,
  toDatabentoSymbol,
  type DatabentoJobRequest,
} from "../../src/market-data/databento/databento-logic";
import {
  splitLines,
  zstdLines,
} from "../../src/market-data/databento/databento-stream";
import { US_HOLIDAY_TABLE_YEARS } from "../../src/market-data/us-market-hours";

const D = (iso: string): Date => new Date(iso);

/* ─────────────────────────────────────────────────────────────────────── */

describe("MONEY-1373 — timeframes are the REPO's literals, not the vendor's", () => {
  it("maps the three OHLCV schemas onto D1's siblings", () => {
    // `M1` is what the realtime sink already writes and what the Prisma
    // `Candle.timeframe` comment reserves. A vendor-shaped "1m" here would key
    // cold shards under a second naming scheme for one concept.
    assert.equal(SCHEMA_TIMEFRAME["ohlcv-1m"], "M1");
    assert.equal(SCHEMA_TIMEFRAME["ohlcv-1h"], "H1");
    assert.equal(SCHEMA_TIMEFRAME["ohlcv-1s"], "S1");
  });

  it("has no timeframe for the quote schemas — they are not bars", () => {
    assert.equal(SCHEMA_TIMEFRAME["bbo-1m"], undefined);
    assert.equal(SCHEMA_TIMEFRAME["tbbo"], undefined);
  });

  it("loads only the two bar schemas; 1s is archive-only by decision", () => {
    assert.deepEqual([...LOADABLE_SCHEMAS], ["ohlcv-1m", "ohlcv-1h"]);
    assert.equal(isLoadableSchema("ohlcv-1s"), false);
    assert.equal(isLoadableSchema("ohlcv-1d"), false);
  });

  it("floors EQUS.MINI at its MEASURED start date, not at a plan tier's window", () => {
    assert.equal(EQUS_MINI_HISTORY_FLOOR, "2023-03-28");
  });
});

describe("symbol notation — a class letter flips, everything else passes through", () => {
  it("converts a single trailing class letter in both directions", () => {
    assert.equal(toDatabentoSymbol("BRK-B"), "BRK.B");
    assert.equal(fromDatabentoSymbol("BRK.B"), "BRK-B");
    assert.equal(toDatabentoSymbol("BF-A"), "BF.A");
    assert.equal(fromDatabentoSymbol("BF.A"), "BF-A");
  });

  it("round-trips", () => {
    for (const s of ["AAPL", "BRK-B", "BF-A", "SPY"]) {
      assert.equal(fromDatabentoSymbol(toDatabentoSymbol(s)), s);
    }
  });

  it("leaves a plain ticker alone", () => {
    assert.equal(toDatabentoSymbol("AAPL"), "AAPL");
    assert.equal(fromDatabentoSymbol("AAPL"), "AAPL");
  });

  it("does NOT guess at a preferred — it passes through and will quarantine", () => {
    // `SPG-P-J` has two dashes and is not a share class. A rule that mangled it
    // would file a bar under another security; an unconverted symbol simply
    // fails to resolve, is counted, and is settled by the probe's not_found
    // list. Absence of a guess is the feature.
    assert.equal(toDatabentoSymbol("SPG-P-J"), "SPG-P-J");
    assert.equal(fromDatabentoSymbol("SPG.P.J"), "SPG.P.J");
  });

  it("upper-cases and trims", () => {
    assert.equal(toDatabentoSymbol("  brk-b "), "BRK.B");
  });
});

describe("buildSubmitJobForm — the fixed fields are the contract", () => {
  const req = {
    dataset: "EQUS.MINI",
    symbols: ["AAPL", "BRK-B"],
    schema: "ohlcv-1m" as const,
    start: D("2024-01-02T00:00:00Z"),
    end: D("2024-01-03T00:00:00Z"),
    splitSymbols: true,
    splitDuration: "year" as const,
  };

  it("pins encoding, compression and the three pretty flags", () => {
    const f = buildSubmitJobForm(req);
    assert.equal(f.get("encoding"), "csv");
    assert.equal(f.get("compression"), "zstd");
    assert.equal(f.get("pretty_px"), "true");
    assert.equal(f.get("pretty_ts"), "true");
    assert.equal(f.get("map_symbols"), "true");
    assert.equal(f.get("stype_in"), "raw_symbol");
    assert.equal(f.get("stype_out"), "instrument_id");
    assert.equal(f.get("delivery"), "download");
  });

  it("converts symbols to the VENDOR's notation exactly once", () => {
    assert.equal(buildSubmitJobForm(req).get("symbols"), "AAPL,BRK.B");
  });

  it("renders both bounds as second-precision UTC", () => {
    const f = buildSubmitJobForm(req);
    assert.equal(f.get("start"), "2024-01-02T00:00:00Z");
    assert.equal(f.get("end"), "2024-01-03T00:00:00Z");
  });

  it("the COST query describes the same window as the submission", () => {
    // A quote that measured a different window from the job it authorises is a
    // budget guard that looks healthy and protects nothing.
    const submit = buildSubmitJobForm(req);
    const cost = buildCostQuery(req);
    for (const k of [
      "dataset",
      "symbols",
      "schema",
      "start",
      "end",
      "stype_in",
    ]) {
      assert.equal(cost.get(k), submit.get(k), `${k} disagrees`);
    }
  });

  it("refuses more than 2,000 symbols instead of truncating", () => {
    const many = Array.from(
      { length: DATABENTO_MAX_SYMBOLS_PER_REQUEST + 1 },
      (_, i) => `S${i}`,
    );
    assert.throws(() => renderSymbolsParam(many), /exceeds Databento's 2000/);
  });

  it("accepts exactly 2,000", () => {
    const exact = Array.from(
      { length: DATABENTO_MAX_SYMBOLS_PER_REQUEST },
      (_, i) => `S${i}`,
    );
    assert.equal(renderSymbolsParam(exact).split(",").length, 2000);
  });

  it("refuses an empty symbol list", () => {
    assert.throws(() => renderSymbolsParam([]), /empty symbol list/);
  });

  it("refuses split_symbols with ALL_SYMBOLS — the vendor does too", () => {
    assert.throws(
      () =>
        buildSubmitJobForm({
          ...req,
          symbols: DATABENTO_ALL_SYMBOLS,
          splitSymbols: true,
        }),
      /split_symbols cannot be combined with ALL_SYMBOLS/,
    );
  });

  it("allows ALL_SYMBOLS without splitting", () => {
    const f = buildSubmitJobForm({
      ...req,
      symbols: DATABENTO_ALL_SYMBOLS,
      splitSymbols: false,
    });
    assert.equal(f.get("symbols"), "ALL_SYMBOLS");
  });

  it("bounds split_size to the documented 1GB..10GB", () => {
    assert.throws(
      () => buildSubmitJobForm({ ...req, splitSize: 5e8 }),
      /1e9\.\.10e9/,
    );
    assert.throws(
      () => buildSubmitJobForm({ ...req, splitSize: 11e9 }),
      /1e9\.\.10e9/,
    );
    assert.equal(
      buildSubmitJobForm({ ...req, splitSize: 2e9 }).get("split_size"),
      "2000000000",
    );
  });

  it("emits the split shape it was GIVEN, with no fallback", () => {
    // MONEY-1375. `split_duration` fell back to `?? "day"` and `split_symbols`
    // to `=== true`, so a caller that omitted them bought a differently
    // shaped job and nothing said so. `ohlcv-1m-baseline` was bought that way
    // against a manifest asking for `true`/`"year"`: 439,569 cold-shard writes
    // instead of 2,028, and an extrapolated 78 h load against a 24 h task cap.
    const yearly = buildSubmitJobForm({
      ...req,
      splitSymbols: true,
      splitDuration: "year",
    });
    assert.equal(yearly.get("split_symbols"), "true");
    assert.equal(yearly.get("split_duration"), "year");

    const single = buildSubmitJobForm({
      ...req,
      splitSymbols: false,
      splitDuration: "none",
    });
    assert.equal(single.get("split_symbols"), "false");
    assert.equal(single.get("split_duration"), "none");
  });

  it("[types] REFUSES a request that omits splitDuration", () => {
    // The compile-time half, and the half that actually caught the defect —
    // no runtime assertion can see a field a caller never wrote. If the
    // fallback comes back and the field goes optional again, this line stops
    // erroring and `tsc --noEmit -p tsconfig.test.json` fails TS2578 on the
    // now-unused directive below — the only signal available for a guard whose
    // whole job is to make an omission impossible. (Do not spell the directive
    // in prose: a line comment carrying it IS one, and TS2578'd on itself.)
    // @ts-expect-error splitDuration is REQUIRED — see DatabentoJobRequest
    const bad: DatabentoJobRequest = {
      dataset: "EQUS.MINI",
      symbols: ["AAPL"],
      schema: "ohlcv-1m",
      start: D("2024-01-02T00:00:00Z"),
      end: D("2024-01-03T00:00:00Z"),
      splitSymbols: true,
    };
    assert.equal(bad.splitSymbols, true);
  });

  it("refuses an end at or before start — end is EXCLUSIVE", () => {
    assert.throws(
      () => buildSubmitJobForm({ ...req, end: req.start }),
      /end must be strictly after start/,
    );
  });

  it("refuses an Invalid Date rather than sending 'Invalid Date' to the vendor", () => {
    assert.throws(() => toDatabentoInstant(new Date("nope")), /Invalid Date/);
  });
});

describe("parseJobResponse — cost_usd is NULL at submission", () => {
  // The exact shape of a freshly-queued job, from the vendor's own published
  // capture. If this parser required cost_usd, every submission would throw;
  // if the BUDGET read cost_usd here it would compare against null and
  // authorise everything.
  const queued = {
    id: "GLBX-20230811-PDJMMKWNRG",
    user_id: "46PCMCVF",
    cost_usd: null,
    dataset: "EQUS.MINI",
    symbols: "AAPL",
    stype_in: "raw_symbol",
    stype_out: "instrument_id",
    schema: "ohlcv-1m",
    start: "2024-01-02 00:00:00+00:00",
    end: "2024-01-03 00:00:00+00:00",
    encoding: "csv",
    compression: "zstd",
    state: "queued",
    ts_received: "2023-08-11 00:24:03.786913+00:00",
    ts_queued: null,
    ts_process_start: null,
    ts_process_done: null,
    ts_expiration: null,
    record_count: null,
    billed_size: null,
    actual_size: null,
    package_size: null,
  };

  it("parses a queued job with every money/size field null", () => {
    const job = parseJobResponse(queued);
    assert.equal(job.id, "GLBX-20230811-PDJMMKWNRG");
    assert.equal(job.state, "queued");
    assert.equal(job.costUsd, null);
    assert.equal(job.recordCount, null);
    assert.equal(job.billedSize, null);
    assert.equal(job.tsExpiration, null);
  });

  it("parses a processed job", () => {
    const job = parseJobResponse({
      ...queued,
      state: "done",
      cost_usd: 0.7847935900092124,
      record_count: 123456,
      billed_size: 987654321,
      ts_expiration: "2023-09-10 00:24:03+00:00",
      progress: 100,
    });
    assert.equal(job.state, "done");
    assert.equal(job.costUsd, 0.7847935900092124);
    assert.equal(job.recordCount, 123456);
    assert.equal(job.billedSize, 987654321);
    assert.equal(job.tsExpiration, "2023-09-10 00:24:03+00:00");
    assert.equal(job.progress, 100);
  });

  it("tolerates the fields the vendor REMOVED (bill_id) and deprecated (packaging)", () => {
    // Removed from the response in 2025-08. A parser that required them would
    // have broken on the day the vendor shipped that change.
    const job = parseJobResponse({
      ...queued,
      bill_id: undefined,
      packaging: undefined,
    });
    assert.equal(job.id, queued.id);
  });

  it("throws when there is no id — a row nothing can poll is worse than an error", () => {
    assert.throws(
      () => parseJobResponse({ state: "queued" }),
      /carries no `id`/,
    );
  });

  it("parses the SUMMARY shape list_jobs returns since 2026-08", () => {
    const s = parseJobSummary({
      id: "X-1",
      state: "processing",
      ts_received: "2026-09-06T00:00:00Z",
    });
    assert.equal(s.id, "X-1");
    assert.equal(s.state, "processing");
  });
});

describe("parseListFiles — an unverifiable download is refused", () => {
  const ok = [
    {
      filename: "equs-mini-20240102.ohlcv-1m.csv.zst",
      size: 21832,
      hash: "sha256:1218930af153b4953632216044ef87607afa467fc7ab7fbb1f031fceacf9d52a",
      urls: {
        https:
          "https://api.databento.com/v0/batch/download/46PCMCVF/JOB/equs-mini-20240102.ohlcv-1m.csv.zst",
        ftp: "ftp://ftp.databento.com/46PCMCVF/JOB/equs-mini-20240102.ohlcv-1m.csv.zst",
      },
    },
  ];

  it("strips the algorithm prefix and keeps the hex", () => {
    const [f] = parseListFiles(ok);
    assert.equal(
      f!.sha256,
      "1218930af153b4953632216044ef87607afa467fc7ab7fbb1f031fceacf9d52a",
    );
    assert.equal(f!.size, 21832);
    assert.ok(f!.httpsUrl.startsWith("https://api.databento.com/"));
  });

  it("THROWS on a non-sha256 hash rather than skipping verification", () => {
    // The vendor's own client downgrades this to a warning. These bytes are the
    // only copy of data bought once; a silently unverified file becomes a
    // coverage gap that gets blamed on the exchange.
    assert.throws(
      () => parseListFiles([{ ...ok[0], hash: "md5:abc" }]),
      /not a sha256/,
    );
  });

  it("throws when https delivery is absent", () => {
    assert.throws(
      () => parseListFiles([{ ...ok[0], urls: { ftp: "ftp://x" } }]),
      /no urls\.https/,
    );
  });

  it("classifies data files and support files apart", () => {
    assert.equal(classifyFile("equs-mini-20240102.ohlcv-1m.csv.zst"), "data");
    assert.equal(classifyFile("manifest.json"), "support");
    assert.equal(classifyFile("condition.json"), "support");
    assert.equal(classifyFile("symbology.json"), "support");
    // A symbology file is NOT produced when map_symbols is on, but a classifier
    // that called it "data" would hand JSON to the CSV loader if it ever were.
    assert.equal(classifyFile("symbology.csv"), "support");
  });
});

describe("parseDatasetRange — the availability gate", () => {
  const payload = {
    start: "2023-03-28T00:00:00.000000000Z",
    end: "2026-09-05T00:00:00.000000000Z",
    schema: {
      "ohlcv-1m": {
        start: "2023-03-28T00:00:00Z",
        end: "2026-09-05T00:00:00Z",
      },
      "ohlcv-1h": {
        start: "2023-03-28T00:00:00Z",
        end: "2026-09-04T00:00:00Z",
      },
    },
  };

  it("reads the top-level range AND the per-schema map", () => {
    const r = parseDatasetRange(payload);
    assert.equal(r.start.toISOString().slice(0, 10), "2023-03-28");
    assert.equal(
      r.bySchema["ohlcv-1m"]!.end.toISOString().slice(0, 10),
      "2026-09-05",
    );
    // The two schemas legitimately differ — which is why the append gates per
    // schema and not on the dataset-wide end.
    assert.equal(
      r.bySchema["ohlcv-1h"]!.end.toISOString().slice(0, 10),
      "2026-09-04",
    );
  });

  it("ignores the deprecated start_date/end_date keys", () => {
    const r = parseDatasetRange({
      ...payload,
      start_date: "1999-01-01",
      end_date: "1999-01-02",
    });
    assert.equal(r.start.getUTCFullYear(), 2023);
  });

  it("throws on a payload with no usable range", () => {
    assert.throws(() => parseDatasetRange({ schema: {} }), /not a timestamp/);
  });
});

describe("parseSymbologyResult", () => {
  it("keeps the date-ranged mappings and both failure lists", () => {
    const r = parseSymbologyResult({
      result: { "BRK.B": [{ d0: "2024-01-01", d1: "2024-02-01", s: "12345" }] },
      partial: ["FOO"],
      not_found: ["SPG.P.J"],
      status: 0,
      message: "OK",
    });
    assert.equal(r.result.get("BRK.B")!.length, 1);
    assert.deepEqual(r.notFound, ["SPG.P.J"]);
    assert.deepEqual(r.partial, ["FOO"]);
  });
});

describe("classifyDatabentoHttp", () => {
  it("reads Retry-After on a 429 and defaults to one second when absent", () => {
    assert.deepEqual(classifyDatabentoHttp(429, "", "7"), {
      kind: "rate-limit",
      retryAfterS: 7,
      detail: "",
    });
    assert.equal(classifyDatabentoHttp(429, "", null).retryAfterS, 1);
  });

  it("caps a pathological Retry-After", () => {
    assert.equal(classifyDatabentoHttp(429, "", "99999").retryAfterS, 120);
  });

  it("separates auth from a bad request from an upstream fault", () => {
    assert.equal(classifyDatabentoHttp(403, '{"detail":"nope"}').kind, "auth");
    assert.equal(classifyDatabentoHttp(401, "").kind, "auth");
    assert.equal(classifyDatabentoHttp(422, "bad param").kind, "bad-request");
    assert.equal(classifyDatabentoHttp(503, "").kind, "upstream");
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("OHLCV CSV — read by NAME (the MONEY-980 lesson)", () => {
  const HEADER =
    "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";
  const ROW =
    "2020-12-28T13:00:00.000000000Z,33,1,5482,372025.000000000,372150.000000000,372025.000000000,372100.000000000,353,ESH1";

  it("parses the live header shape", () => {
    const cols = parseOhlcvHeader(HEADER);
    assert.equal(cols.tsEvent, 0);
    assert.equal(cols.symbol, 9);
  });

  it("REGRESSION: a SHUFFLED header parses to the identical row", () => {
    // The whole point. A positional parser passes the first case and fails this
    // one; that is exactly how a documented-but-wrong column order swapped open
    // and close on every US security in MONEY-980.
    const shuffled =
      "symbol,volume,close,low,high,open,instrument_id,publisher_id,rtype,ts_event";
    const shuffledRow =
      "ESH1,353,372100.000000000,372025.000000000,372150.000000000,372025.000000000,5482,1,33,2020-12-28T13:00:00.000000000Z";
    const a = parseOhlcvRow(ROW, parseOhlcvHeader(HEADER));
    const b = parseOhlcvRow(shuffledRow, parseOhlcvHeader(shuffled));
    assert.deepEqual(a, b);
  });

  it("truncates nanoseconds to milliseconds exactly", () => {
    const row = parseOhlcvRow(ROW, parseOhlcvHeader(HEADER));
    assert.ok(!("rejected" in row));
    assert.equal(
      new Date((row as { tsMs: number }).tsMs).toISOString(),
      "2020-12-28T13:00:00.000Z",
    );
  });

  it("keeps sub-second precision that fits in milliseconds", () => {
    assert.equal(
      parseNanoTimestamp("2024-01-02T14:30:00.123456789Z"),
      Date.parse("2024-01-02T14:30:00.123Z"),
    );
  });

  it("treats an EMPTY timestamp as no value — pretty_ts renders 0 and UNDEF that way", () => {
    assert.equal(parseNanoTimestamp(""), null);
    assert.equal(parseNanoTimestamp("   "), null);
  });

  it("REJECTS a row whose price is the UNDEF sentinel (an empty field)", () => {
    // Under pretty_px the vendor writes "" rather than 9223372036854775807. A
    // parser that read that as 0 would chart a real crash; one that read the
    // raw sentinel would store a price of 9.2e18.
    const undefRow =
      "2020-12-28T13:00:00.000000000Z,33,1,5482,,372150.000000000,372025.000000000,372100.000000000,353,ESH1";
    const r = parseOhlcvRow(undefRow, parseOhlcvHeader(HEADER));
    assert.deepEqual(r, { rejected: "price" });
  });

  it("names each rejection so the counters can tell them apart", () => {
    const cols = parseOhlcvHeader(HEADER);
    assert.deepEqual(parseOhlcvRow("a,b,c", cols), { rejected: "fields" });
    assert.deepEqual(parseOhlcvRow(",33,1,5482,1,2,0.5,1.5,10,ESH1", cols), {
      rejected: "timestamp",
    });
    assert.deepEqual(
      parseOhlcvRow(
        "2020-12-28T13:00:00.000000000Z,33,1,5482,1,2,0.5,1.5,10,",
        cols,
      ),
      { rejected: "symbol" },
    );
  });

  it("a missing volume is 0 — and that zero is a real 'nothing traded'", () => {
    const noVol = "2020-12-28T13:00:00.000000000Z,33,1,5482,1,2,0.5,1.5,,ESH1";
    const r = parseOhlcvRow(noVol, parseOhlcvHeader(HEADER));
    assert.equal((r as { volume: number }).volume, 0);
  });

  it("refuses a header with no symbol column and says why", () => {
    assert.throws(
      () => parseOhlcvHeader("ts_event,open,high,low,close,volume"),
      /map_symbols=true/,
    );
  });
});

describe("fileSessionDate — the per-file window filter reads the NAME", () => {
  it("reads the vendor's daily split name", () => {
    // `<dataset>-<YYYYMMDD>.<schema>.<ext>`. It is the only per-file
    // granularity there is: the LEDGER row spans the whole job — one row and
    // ~250 files for `tbbo-top50` — so a query filtering on the row's
    // start/end selects every file of any job the window merely TOUCHES, and
    // a 92-day request folded 12 months.
    assert.equal(
      fileSessionDate("equs-mini-20240102.ohlcv-1m.csv.zst"),
      "2024-01-02",
    );
    assert.equal(
      fileSessionDate("equs-mini-20261231.tbbo.csv.zst"),
      "2026-12-31",
    );
  });

  it("returns null for a name with no date — never a guess", () => {
    // "We cannot tell" and "outside the window" must not be the same answer:
    // the caller INCLUDES an undated file, because dropping data we hold
    // because we could not read its filename is the worse error.
    assert.equal(fileSessionDate("manifest.json"), null);
    assert.equal(fileSessionDate("symbology.csv"), null);
    assert.equal(fileSessionDate("equs-mini.ohlcv-1m.csv.zst"), null);
  });

  it("refuses a shape that parses but is not a date", () => {
    assert.equal(fileSessionDate("equs-mini-20241332.tbbo.csv.zst"), null);
  });

  it("does not mistake a longer digit run for a date", () => {
    // A job id or a checksum should not be read as a session.
    assert.equal(fileSessionDate("equs-mini-2024010212345.tbbo.csv"), null);
  });
});

describe("BBO CSV", () => {
  const HEADER =
    "ts_recv,ts_event,rtype,publisher_id,instrument_id,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00,symbol";
  const row = (bid: string, ask: string): string =>
    `2024-01-02T14:30:00.000000000Z,2024-01-02T14:29:59.900000000Z,1,95,5482,${bid},${ask},100,200,AAPL`;

  it("THROWS naming every column a header is missing", () => {
    // A header that lost `bid_px_00` would otherwise index `undefined`, turn
    // every price into NaN, reject every row as "price", and produce a cost
    // model built from zero samples with nothing naming the cause. The error
    // has to say WHICH column, because "the fold sampled nothing" is the same
    // symptom for a dozen different problems.
    assert.throws(
      () => parseBboHeader("ts_recv,symbol,ask_px_00,bid_sz_00"),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /parseBboHeader: missing column\(s\)/);
        assert.match(err.message, /bid_px_00/);
        return true;
      },
    );
  });

  it("names ALL the missing columns, not just the first", () => {
    assert.throws(
      () => parseBboHeader("ts_recv,symbol"),
      /bid_px_00, ask_px_00/,
    );
  });

  it("quotes the header it rejected, so the file can be identified", () => {
    assert.throws(() => parseBboHeader("a,b,c"), /Header was: a,b,c/);
  });

  it("parses top of book", () => {
    const cols = parseBboHeader(HEADER);
    const r = parseBboRow(row("100.00", "100.02"), cols);
    assert.ok(!("rejected" in r));
    const q = r as {
      bid: number;
      ask: number;
      bidSize: number;
      askSize: number;
    };
    assert.equal(q.bid, 100);
    assert.equal(q.ask, 100.02);
    assert.equal(q.bidSize, 100);
    assert.equal(q.askSize, 200);
  });

  it("REJECTS a crossed or locked book rather than clamping it", () => {
    // A zero or negative spread would tell the cost model that execution is
    // free at exactly the moments it is hardest.
    const cols = parseBboHeader(HEADER);
    assert.deepEqual(parseBboRow(row("100.05", "100.00"), cols), {
      rejected: "crossed",
    });
    assert.deepEqual(parseBboRow(row("100.00", "100.00"), cols), {
      rejected: "crossed",
    });
  });

  it("rejects an absent side (the UNDEF sentinel renders empty)", () => {
    const cols = parseBboHeader(HEADER);
    assert.deepEqual(parseBboRow(row("", "100.02"), cols), {
      rejected: "price",
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("zstdLines — streaming, and the last line is not dropped", () => {
  const gz = async (text: string): Promise<Readable> => {
    const chunks: Buffer[] = [];
    const c = createZstdCompress();
    const done = new Promise<void>((resolve, reject) => {
      c.on("data", (d: Buffer) => chunks.push(d));
      c.on("end", () => resolve());
      c.on("error", reject);
    });
    c.end(Buffer.from(text, "utf8"));
    c.resume();
    await done;
    return Readable.from(Buffer.concat(chunks));
  };

  it("yields every line, strips \\r, and keeps a final line with no newline", () => {
    return (async () => {
      const src = await gz("header\r\nrow1\r\nrow2");
      const out: string[] = [];
      for await (const line of zstdLines(src)) out.push(line);
      assert.deepEqual(out, ["header", "row1", "row2"]);
    })();
  });

  it("skips blank lines and survives a trailing newline", () => {
    return (async () => {
      const src = await gz("a\n\nb\n");
      const out: string[] = [];
      for await (const line of zstdLines(src)) out.push(line);
      assert.deepEqual(out, ["a", "b"]);
    })();
  });

  it("handles a line split across decoder chunks", () => {
    return (async () => {
      // A long line guarantees the decompressor emits it in pieces; a reader
      // that assumed one chunk equals one line would split a bar in half.
      const long = "x".repeat(200_000);
      const src = await gz(`${long}\nshort\n`);
      const out: string[] = [];
      for await (const line of zstdLines(src)) out.push(line);
      assert.equal(out.length, 2);
      assert.equal(out[0]!.length, 200_000);
      assert.equal(out[1], "short");
    })();
  });

  it("splitLines applies the same rules without a stream", () => {
    assert.deepEqual(splitLines("a\r\n\nb"), ["a", "b"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("expectedSessions — the coverage DENOMINATOR comes from the calendar", () => {
  it("excludes weekends", () => {
    // 2026-01-02 Fri .. 2026-01-05 Mon
    assert.deepEqual(expectedSessions("2026-01-02", "2026-01-05"), [
      "2026-01-02",
      "2026-01-05",
    ]);
  });

  it("excludes a market holiday", () => {
    // 2026-01-01 is New Year's Day — a Thursday, so it is a weekday the market
    // is nevertheless shut, which is the only case a weekend filter cannot get
    // right on its own.
    const s = expectedSessions("2026-01-01", "2026-01-02");
    assert.deepEqual(s, ["2026-01-02"]);
  });

  it("is inclusive on both bounds", () => {
    assert.deepEqual(expectedSessions("2026-01-02", "2026-01-02"), [
      "2026-01-02",
    ]);
  });

  it("throws on a malformed key rather than walking from NaN", () => {
    assert.throws(
      () => expectedSessions("2026-1-3", "2026-01-05"),
      /bad date key/,
    );
  });

  it("REFUSES a year the holiday table has no opinion about", () => {
    // Outside the table `isUsTradingDay` cannot say "closed" — it can only fail
    // to say "holiday", which reads as an open market. Unguarded, that is a
    // denominator that reports every closure as a missing session and gets the
    // vendor blamed for it.
    assert.throws(
      () => expectedSessions("1999-01-04", "1999-01-08"),
      /reaches outside the US holiday table/,
    );
  });

  it("the harvest's own history floor is INSIDE the holiday table", () => {
    // The manifest starts at EQUS.MINI's floor and the coverage report walks
    // from there, so the calendar has to reach at least that far back or the
    // first coverage run throws. This assertion is what ties the vendor's start
    // date to the table's declared range; they are two facts in two files and
    // nothing else compares them.
    const floorYear = Number(EQUS_MINI_HISTORY_FLOOR.slice(0, 4));
    assert.ok(
      floorYear >= US_HOLIDAY_TABLE_YEARS.first,
      `EQUS.MINI floors at ${floorYear} but US_MARKET_HOLIDAYS only covers ` +
        `${US_HOLIDAY_TABLE_YEARS.first}-${US_HOLIDAY_TABLE_YEARS.last}. ` +
        "Extend the table (see us-market-hours.ts) — the harvest walks that " +
        "whole span and every uncovered closure would report as a gap.",
    );
  });
});

describe("databentoArchiveKey — outside feeds/, and never overwriting", () => {
  it("builds the documented layout", () => {
    assert.equal(
      databentoArchiveKey({
        dataset: "EQUS.MINI",
        schema: "ohlcv-1m",
        year: 2024,
        jobId: "EQUS-20260906-ABC",
        filename: "equs-mini-20240102.ohlcv-1m.csv.zst",
      }),
      "databento/EQUS.MINI/ohlcv-1m/2024/EQUS-20260906-ABC/equs-mini-20240102.ohlcv-1m.csv.zst",
    );
  });

  it("is NOT under feeds/ — the prod->QA mirror rsyncs that whole prefix", () => {
    const key = databentoArchiveKey({
      dataset: "EQUS.MINI",
      schema: "ohlcv-1m",
      year: 2024,
      jobId: "J",
      filename: "f.csv.zst",
    });
    assert.ok(key.startsWith("databento/"));
    assert.ok(!key.startsWith("feeds/"));
  });

  it("keys two jobs over the same window apart, so nothing overwrites", () => {
    const a = databentoArchiveKey({
      dataset: "D",
      schema: "s",
      year: 2024,
      jobId: "J1",
      filename: "f.csv.zst",
    });
    const b = databentoArchiveKey({
      dataset: "D",
      schema: "s",
      year: 2024,
      jobId: "J2",
      filename: "f.csv.zst",
    });
    assert.notEqual(a, b);
  });
});

describe("archiveJobsWithoutLedgerRow — MONEY-1540", () => {
  const key = (jobId: string, filename: string) =>
    databentoArchiveKey({
      dataset: "EQUS.MINI",
      schema: "ohlcv-1m",
      year: 2023,
      jobId,
      filename,
    });

  it("names a job folder no ledger row names, with its object count and bytes", () => {
    const out = archiveJobsWithoutLedgerRow(
      [
        { name: key("EQUS-20260907-CXDTCWL9HP", "condition.json"), size: 10 },
        {
          name: key(
            "EQUS-20260907-CXDTCWL9HP",
            "equs-mini-20230328.ohlcv-1m.csv.zst",
          ),
          size: 90,
        },
        {
          name: key(
            "EQUS-20260908-BN8RS9XMHF",
            "equs-mini-2023.ohlcv-1m.AAPL.csv.zst",
          ),
          size: 5,
        },
      ],
      new Set(["EQUS-20260908-BN8RS9XMHF"]),
    );
    assert.deepEqual(out, [
      {
        prefix: "databento/EQUS.MINI/ohlcv-1m/2023/EQUS-20260907-CXDTCWL9HP/",
        jobId: "EQUS-20260907-CXDTCWL9HP",
        objects: 2,
        bytes: 100,
      },
    ]);
  });

  it("a fully-recorded archive reports nothing", () => {
    const out = archiveJobsWithoutLedgerRow(
      [{ name: key("J1", "f.csv.zst"), size: 1 }],
      new Set(["J1"]),
    );
    assert.deepEqual(out, []);
  });

  it("ignores keys outside the archive layout rather than guessing a job id", () => {
    const out = archiveJobsWithoutLedgerRow(
      [
        { name: "databento/EQUS.MINI/ohlcv-1m/coverage.json", size: 1 },
        { name: "feeds/NSE/x/2026/J9/f.csv", size: 1 },
      ],
      new Set(),
    );
    assert.deepEqual(out, []);
  });
});

describe("an OHLCV row with an unusable PRICE is rejected", () => {
  // `parseBboRow` one function down already refused a non-positive bid/ask.
  // The OHLCV guard tested finiteness only, so a literal 0 or a negative went
  // through — and a mutation dropping `close` from the check failed NOTHING,
  // because no fixture exercised that column. A `close: NaN` is the
  // non-finite money poison this repo has a whole discipline about.
  const header =
    "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";
  const cols = parseOhlcvHeader(header);
  const row = (over: Partial<Record<string, string>>): string => {
    const base: Record<string, string> = {
      ts_event: "2026-09-04T14:30:00.000000000Z",
      rtype: "32",
      publisher_id: "95",
      instrument_id: "1",
      open: "100.0",
      high: "101.0",
      low: "99.0",
      close: "100.5",
      volume: "1000",
      symbol: "AAPL",
    };
    return header
      .split(",")
      .map((h) => over[h] ?? base[h]!)
      .join(",");
  };

  it("[premise] the baseline row parses", () => {
    const r = parseOhlcvRow(row({}), cols);
    assert.ok(!("rejected" in r), JSON.stringify(r));
  });

  it("rejects a zero or negative in EVERY price column", () => {
    // Every column, so dropping any one of the four from the check fails.
    for (const col of ["open", "high", "low", "close"]) {
      for (const bad of ["0", "-1", "-0.01"]) {
        const r = parseOhlcvRow(row({ [col]: bad }), cols);
        assert.deepEqual(
          r,
          { rejected: "price" },
          `${col}=${bad} was accepted`,
        );
      }
    }
  });

  it("rejects an EMPTY or unparseable value in every price column", () => {
    for (const col of ["open", "high", "low", "close"]) {
      for (const bad of ["", "n/a", "UNDEF"]) {
        assert.deepEqual(
          parseOhlcvRow(row({ [col]: bad }), cols),
          { rejected: "price" },
          `${col}="${bad}" was accepted`,
        );
      }
    }
  });

  it("rejects a bar whose high is below its low", () => {
    assert.deepEqual(parseOhlcvRow(row({ high: "98.0", low: "99.0" }), cols), {
      rejected: "price",
    });
  });
});
