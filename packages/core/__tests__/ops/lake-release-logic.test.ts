/**
 * Lake release logic — MONEY-1518 (data-platform B7).
 *
 * Every assertion here targets something a running release builder does NOT
 * report:
 *
 *   overwrite=true        a re-run silently replaces a release other people
 *                         have already pinned. Both cuts "succeed"; a backtest
 *                         re-run months later gets different answers from the
 *                         same release_id, which is the exact property the
 *                         artifact exists to provide.
 *   a missing wildcard    the export works until a result exceeds one file —
 *                         i.e. until the release that matters.
 *   an injectable market  a partition value reaching both a path segment and a
 *                         SQL literal unescaped.
 *   a dropped factor      `bars_d1` without price_factor/split_factor_cum
 *                         still reads perfectly, and quietly restores the need
 *                         for a second CRSP implementation in Python.
 *   an empty dataset      an immutable artifact whose `bars_m1/` is an empty
 *                         directory. Every read over it reports a clean run on
 *                         no data. `trade_bar_m1` holds ZERO rows on prod
 *                         today, so this is the live case.
 *   verify() as a boolean an UNLISTED object (a crashed partial cut) and a
 *                         MISSING one need opposite fixes and must not
 *                         collapse into one word.
 *   an INT64 / NUMERIC    exported as-is, volume is a parquet INT64 (a
 *                         `bigint` the TS `finite()` guard drops, so every bar
 *                         vanishes) and prices are DECIMAL (a `Decimal` object
 *                         column that lake.py cannot multiply).
 *   a copied policy       the manifest naming a policy none of its rows carry,
 *                         in an artifact that can never be corrected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ADJUSTMENT_POLICY_VERSION,
  RELEASE_DATASETS,
  RELEASE_LICENCE_NOTES,
  RELEASE_PREFIX,
  assertReleaseComplete,
  buildExportSql,
  doubleReplacements,
  parseReleaseId,
  planPartitions,
  releaseId,
  releaseKey,
  releaseUri,
  resolveAdjustmentPolicy,
  resolveReleaseApply,
  verifyManifest,
  type ReleaseManifest,
} from "../../src/ops/lake-release-logic";
import { UnknownPrefixError } from "../../src/ops/lake-layout";

const D1 = RELEASE_DATASETS.find((d) => d.name === "bars_d1")!;
const M1 = RELEASE_DATASETS.find((d) => d.name === "bars_m1")!;
const FLAT = RELEASE_DATASETS.find((d) => d.name === "corporate_actions")!;

describe("the release id is the snapshot instant, and it is shape-checked", () => {
  it("renders a colon-free, sortable id", () => {
    assert.equal(
      releaseId(new Date("2026-09-22T00:00:00.000Z")),
      "2026-09-22T00-00-00Z",
    );
    assert.equal(
      releaseId(new Date("2026-01-02T03:04:05.678Z")),
      "2026-01-02T03-04-05Z",
    );
  });

  it("sorts lexically in time order — a listing of releases must be a history", () => {
    const ids = [
      releaseId(new Date("2026-10-01T00:00:00Z")),
      releaseId(new Date("2026-09-22T23:59:59Z")),
      releaseId(new Date("2026-09-22T00:00:00Z")),
    ];
    assert.deepEqual([...ids].sort(), [
      "2026-09-22T00-00-00Z",
      "2026-09-22T23-59-59Z",
      "2026-10-01T00-00-00Z",
    ]);
  });

  it("refuses an Invalid Date rather than naming a release `NaN`", () => {
    assert.throws(() => releaseId(new Date("not a date")), /Invalid Date/);
  });

  it("accepts only what releaseId emits", () => {
    assert.equal(
      parseReleaseId("  2026-09-22T00-00-00Z "),
      "2026-09-22T00-00-00Z",
    );
    for (const bad of [
      "",
      "latest",
      "2026-09-22",
      "2026-09-22T00:00:00Z", // colons — the spelling that survives nothing
      "../2026-09-22T00-00-00Z",
      "2026-09-22T00-00-00Z/extra",
      "2026-09-22T00-00-00",
    ]) {
      assert.throws(
        () => parseReleaseId(bad),
        /Not a release id/,
        `accepted ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("keys land under `releases/` and are ROUTED, not merely concatenated", () => {
  it("builds the key and the uri for both envs", () => {
    assert.equal(
      releaseKey("prod", "2026-09-22T00-00-00Z", "manifest.json"),
      "releases/2026-09-22T00-00-00Z/manifest.json",
    );
    assert.equal(
      releaseUri("qa", "2026-09-22T00-00-00Z", "bars_d1/market=US/year=2024"),
      "gs://stockbook-lake-qa/releases/2026-09-22T00-00-00Z/bars_d1/market=US/year=2024",
    );
    assert.equal(
      releaseUri("prod", "2026-09-22T00-00-00Z", "manifest.json"),
      "gs://stockbook-lake-prod/releases/2026-09-22T00-00-00Z/manifest.json",
    );
  });

  it("the prefix constant is the one lake-layout declares", () => {
    // If `releases/` were ever dropped from LAKE_PREFIXES, releaseKey's own
    // bucketForPrefix call throws — this pins the spelling that reaches it.
    assert.equal(RELEASE_PREFIX, "releases/");
    assert.doesNotThrow(() =>
      releaseKey("prod", "2026-09-22T00-00-00Z", "x.parquet"),
    );
  });

  it("refuses a relPath that escapes the release", () => {
    for (const bad of ["", "   ", "..", "../../tiles/x", "a/../../b"]) {
      assert.throws(
        () => releaseKey("prod", "2026-09-22T00-00-00Z", bad),
        /empty or escapes the release/,
        `accepted ${JSON.stringify(bad)}`,
      );
    }
  });

  it("refuses an unknown env at the routing layer rather than defaulting", () => {
    assert.throws(
      () =>
        releaseKey("staging" as never, "2026-09-22T00-00-00Z", "manifest.json"),
      UnknownPrefixError,
    );
  });
});

describe("the arm flag is the literal string, read per call", () => {
  it("only `true` arms", () => {
    assert.equal(resolveReleaseApply("true"), true);
    assert.equal(resolveReleaseApply(" TRUE "), true);
    for (const raw of [
      "false",
      "False",
      "0",
      "1",
      "yes",
      "",
      "  ",
      undefined,
    ]) {
      assert.equal(
        resolveReleaseApply(raw),
        false,
        `armed on ${JSON.stringify(raw)}`,
      );
    }
  });

  it('"false" does NOT arm — Boolean("false") is true', () => {
    assert.equal(resolveReleaseApply("false"), false);
  });

  it("reads the environment at CALL time, not at import", () => {
    const before = process.env.LAKE_RELEASE_APPLY;
    try {
      process.env.LAKE_RELEASE_APPLY = "false";
      assert.equal(resolveReleaseApply(), false);
      process.env.LAKE_RELEASE_APPLY = "true";
      assert.equal(resolveReleaseApply(), true);
    } finally {
      if (before === undefined) delete process.env.LAKE_RELEASE_APPLY;
      else process.env.LAKE_RELEASE_APPLY = before;
    }
  });
});

describe("partition planning", () => {
  it("an unpartitioned dataset is one flat export", () => {
    assert.deepEqual(
      planPartitions(FLAT, [{ market: "US" }, { market: "IN" }]),
      [{ dataset: "corporate_actions", segments: [], predicates: [] }],
    );
  });

  it("d1 splits market x year, and the predicate matches the segment", () => {
    assert.deepEqual(
      planPartitions(D1, [
        { market: "US", year: 2024 },
        { market: "IN", year: 2025 },
      ]),
      [
        {
          dataset: "bars_d1",
          segments: ["market=US", "year=2024"],
          predicates: [
            "market = 'US'",
            "EXTRACT(YEAR FROM session_date) = 2024",
          ],
        },
        {
          dataset: "bars_d1",
          segments: ["market=IN", "year=2025"],
          predicates: [
            "market = 'IN'",
            "EXTRACT(YEAR FROM session_date) = 2025",
          ],
        },
      ],
    );
  });

  it("m1 adds a ZERO-PADDED month — `month=2` and `month=02` must not both exist", () => {
    const [p] = planPartitions(M1, [{ market: "US", year: 2024, month: 2 }]);
    assert.deepEqual(p.segments, ["market=US", "year=2024", "month=02"]);
    assert.deepEqual(p.predicates, [
      "market = 'US'",
      "EXTRACT(YEAR FROM session_date) = 2024",
      "EXTRACT(MONTH FROM session_date) = 2",
    ]);
  });

  it("refuses a partition value that would inject into the path or the SQL", () => {
    for (const market of ["US'; DROP", "../..", "US/IN", "", "a".repeat(33)]) {
      assert.throws(
        () => planPartitions(D1, [{ market, year: 2024 }]),
        /not a safe partition value/,
        `accepted ${JSON.stringify(market)}`,
      );
    }
  });

  it("refuses a non-integer or out-of-range grain rather than naming `year=NaN`", () => {
    assert.throws(
      () => planPartitions(D1, [{ market: "US" }]),
      /year must be an integer/,
    );
    assert.throws(
      () => planPartitions(D1, [{ market: "US", year: 2024.5 }]),
      /year must be an integer/,
    );
    assert.throws(
      () => planPartitions(M1, [{ market: "US", year: 2024, month: 13 }]),
      /is not a month/,
    );
    assert.throws(
      () => planPartitions(M1, [{ market: "US", year: 2024, month: 0 }]),
      /is not a month/,
    );
  });

  it("an empty grain list writes NOTHING — a release cannot invent partitions", () => {
    assert.deepEqual(planPartitions(D1, []), []);
  });
});

describe("the EXPORT DATA statement", () => {
  const base = {
    uriPrefix:
      "gs://stockbook-lake-qa/releases/2026-09-22T00-00-00Z/bars_d1/market=US/year=2024",
    qualifiedSource: "p.lake_gold_qa.adjusted_bar_d1",
    predicates: ["market = 'US'", "EXTRACT(YEAR FROM session_date) = 2024"],
  };

  it("is IMMUTABLE — overwrite=false is spelled, not left to the default", () => {
    const sql = buildExportSql(base);
    assert.match(sql, /overwrite\s*=\s*false/);
    assert.doesNotMatch(sql, /overwrite\s*=\s*true/);
  });

  it("writes SNAPPY parquet to a single-wildcard uri", () => {
    const sql = buildExportSql(base);
    assert.match(sql, /format\s*=\s*'PARQUET'/);
    assert.match(sql, /compression\s*=\s*'SNAPPY'/);
    const uri = /uri\s*=\s*'([^']+)'/.exec(sql)?.[1] ?? "";
    assert.equal(uri, `${base.uriPrefix}/part-*.parquet`);
    assert.equal(
      uri.split("*").length - 1,
      1,
      "BigQuery rejects more than one wildcard",
    );
  });

  it("carries the predicates, and omits WHERE entirely when there are none", () => {
    assert.match(
      buildExportSql(base),
      /WHERE market = 'US' AND EXTRACT\(YEAR FROM session_date\) = 2024/,
    );
    assert.doesNotMatch(buildExportSql({ ...base, predicates: [] }), /WHERE/);
  });

  it("projects the named columns, and selects everything when none are named", () => {
    assert.match(
      buildExportSql({ ...base, columns: ["market", "close"] }),
      /SELECT market, close/,
    );
    assert.match(buildExportSql(base), /SELECT \*/);
  });

  it("refuses a uriPrefix that already has a wildcard or is not gs://", () => {
    assert.throws(
      () => buildExportSql({ ...base, uriPrefix: `${base.uriPrefix}/*` }),
      /must not already contain a wildcard/,
    );
    assert.throws(
      () => buildExportSql({ ...base, uriPrefix: "/tmp/out" }),
      /must be a gs:\/\/ uri/,
    );
  });
});

describe("the release contents", () => {
  it("bars_d1 comes from the GOLD view and bars_m1 from SILVER", () => {
    assert.equal(D1.layer, "gold");
    assert.equal(D1.source, "adjusted_bar_d1");
    assert.equal(M1.layer, "silver");
    assert.equal(M1.source, "trade_bar_m1");
  });

  it("no dataset projects a column list — dropping the FACTORS would restore the Python CRSP port", () => {
    // `adjusted_bar_d1` emits price_factor + split_factor_cum; they are what
    // let an intraday bar be adjusted by joining its session date. A `columns`
    // list on bars_d1 is the one edit that could quietly drop them, so none of
    // these entries carries one.
    for (const d of RELEASE_DATASETS) {
      assert.equal(
        (d as { columns?: unknown }).columns,
        undefined,
        `${d.name} projects columns — check price_factor/split_factor_cum survive`,
      );
    }
  });

  it("the universe is identity-complete: listing AND symbol_history", () => {
    const names = RELEASE_DATASETS.map((d) => d.name);
    assert.ok(names.includes("instruments/listing"));
    // Without symbol_history, `universe(as_of)` cannot be survivorship-free —
    // it would resolve today's tickers and call that the past.
    assert.ok(names.includes("instruments/symbol_history"));
    assert.ok(names.includes("corporate_actions"));
  });

  it("intraday is month-grained and daily is year-grained", () => {
    assert.deepEqual(D1.partitionBy, ["market", "year"]);
    assert.deepEqual(M1.partitionBy, ["market", "year", "month"]);
  });

  it("the licence notes name BOTH US vendors' restrictions", () => {
    const joined = RELEASE_LICENCE_NOTES.join(" ");
    assert.match(joined, /INTERNAL USE ONLY/);
    assert.match(joined, /EQUS\.MINI/);
    assert.match(joined, /subset of the SIP/i);
  });

  it("bars_d1 names the column its policy is READ from — there is no copy to go stale", () => {
    assert.equal(D1.policyColumn, "adjustment_policy_version");
    for (const d of RELEASE_DATASETS.filter((x) => x !== D1)) {
      assert.equal(d.policyColumn, undefined, `${d.name} carries no policy`);
    }
  });
});

describe("the adjustment policy is what the ROWS say", () => {
  it("takes the one distinct value when it is the one this build expects", () => {
    assert.equal(
      resolveAdjustmentPolicy([ADJUSTMENT_POLICY_VERSION]),
      ADJUSTMENT_POLICY_VERSION,
    );
    assert.equal(resolveAdjustmentPolicy(["crsp-v9"], "crsp-v9"), "crsp-v9");
  });

  it("refuses rows that disagree — a view mid-redeploy is not one policy", () => {
    assert.throws(
      () => resolveAdjustmentPolicy(["crsp-v2", "crsp-v3"]),
      /2 adjustment_policy_version value\(s\)/,
    );
  });

  it("refuses a warehouse still computing the OLD policy — Dataform not re-run", () => {
    // The shape a policy bump produces until Dataform is re-run: the repo
    // expects the new version while the view still computes the old one.
    // Printing the rows' value would be truthful and permanent; refusing sends
    // the operator to Dataform first.
    assert.throws(
      () => resolveAdjustmentPolicy(["crsp-v2"], "crsp-v3"),
      /computes crsp-v2, and this build expects crsp-v3/,
    );
  });

  it("refuses no value, a NULL and a blank — never a manifest with an unnamed policy", () => {
    for (const bad of [[], [null], [undefined], ["  "], ["crsp-v3", null]]) {
      assert.throws(
        () => resolveAdjustmentPolicy(bad),
        /adjustment_policy_version/,
        `accepted ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("THE DOUBLE RULE — no INT64 and no NUMERIC leaves in a release", () => {
  // The real prod shapes, read from INFORMATION_SCHEMA.COLUMNS on 2026-09-23.
  const priceBar = [
    { name: "market", dataType: "STRING" },
    { name: "session_date", dataType: "DATE" },
    { name: "open", dataType: "NUMERIC(18, 6)" },
    { name: "close", dataType: "NUMERIC(18, 6)" },
    { name: "volume", dataType: "INT64" },
    { name: "price_factor", dataType: "FLOAT64" },
    { name: "observed_at", dataType: "TIMESTAMP" },
  ];

  it("casts volume and every NUMERIC — parameterised spelling included", () => {
    assert.deepEqual(doubleReplacements(priceBar), [
      "CAST(open AS FLOAT64) AS open",
      "CAST(close AS FLOAT64) AS close",
      "CAST(volume AS FLOAT64) AS volume",
    ]);
  });

  it("covers the wide decimal types and an INT64 identifier too", () => {
    const out = doubleReplacements([
      { name: "a", dataType: "BIGNUMERIC" },
      { name: "b", dataType: "BIGNUMERIC(40, 10)" },
      { name: "publisher_id", dataType: "INT64" },
    ]);
    assert.equal(out.length, 3);
  });

  it("leaves strings, dates, timestamps and doubles alone", () => {
    assert.deepEqual(
      doubleReplacements([
        { name: "symbol", dataType: "STRING" },
        { name: "d", dataType: "DATE" },
        { name: "t", dataType: "TIMESTAMP" },
        { name: "f", dataType: "FLOAT64" },
      ]),
      [],
    );
  });

  it("refuses a column name it would have to QUOTE into SQL", () => {
    for (const name of ["a b", "x; DROP", "`v`", "", "1st"]) {
      assert.throws(
        () => doubleReplacements([{ name, dataType: "INT64" }]),
        /not a plain column name/,
        `accepted ${JSON.stringify(name)}`,
      );
    }
  });

  it("reaches the statement as SELECT * REPLACE — every column still leaves", () => {
    const sql = buildExportSql({
      uriPrefix:
        "gs://stockbook-lake-qa/releases/2026-09-22T00-00-00Z/bars_d1/market=US/year=2024",
      qualifiedSource: "p.lake_gold_qa.adjusted_bar_d1",
      predicates: [],
      replace: doubleReplacements(priceBar),
    });
    assert.match(
      sql,
      /SELECT \* REPLACE \(CAST\(open AS FLOAT64\) AS open, CAST\(close AS FLOAT64\) AS close, CAST\(volume AS FLOAT64\) AS volume\)/,
    );
  });

  it("`columns` and `replace` together are refused, not silently merged", () => {
    assert.throws(
      () =>
        buildExportSql({
          uriPrefix: "gs://stockbook-lake-qa/releases/2026-09-22T00-00-00Z/x",
          qualifiedSource: "p.d.t",
          predicates: [],
          columns: ["a"],
          replace: ["CAST(b AS FLOAT64) AS b"],
        }),
      /exclusive/,
    );
  });
});

describe("a release refuses to ship an empty dataset", () => {
  const full = Object.fromEntries(RELEASE_DATASETS.map((d) => [d.name, 1]));

  it("passes when every dataset wrote rows", () => {
    assert.doesNotThrow(() => assertReleaseComplete(full));
  });

  it("refuses the LIVE case — trade_bar_m1 holds zero rows on prod today", () => {
    assert.throws(
      () => assertReleaseComplete({ ...full, bars_m1: 0 }),
      /bars_m1 exported zero rows/,
    );
  });

  it("refuses an ABSENT count, not only a zero one", () => {
    const { bars_d1: _drop, ...missing } = full;
    assert.throws(
      () => assertReleaseComplete(missing),
      /bars_d1 exported zero rows/,
    );
  });

  it("names EVERY empty dataset, so one cut reveals the whole gap", () => {
    assert.throws(
      () =>
        assertReleaseComplete({ ...full, bars_m1: 0, corporate_actions: 0 }),
      /corporate_actions, bars_m1|bars_m1, corporate_actions/,
    );
  });
});

describe("verifyManifest reports disagreements, never a boolean", () => {
  const manifest: ReleaseManifest = {
    manifestVersion: 1,
    releaseId: "2026-09-22T00-00-00Z",
    env: "qa",
    snapshotAt: "2026-09-22T00:00:00.000Z",
    gitSha: "abc1234",
    adjustmentPolicy: "crsp-v3",
    universeRule: "every listing in lake_silver.listing",
    calendars: ["XNYS", "XNSE"],
    licence: RELEASE_LICENCE_NOTES,
    rowCounts: { bars_d1: 10 },
    files: [
      {
        path: "bars_d1/market=US/year=2024/part-000.parquet",
        bytes: 100,
        checksum: { algo: "crc32c", value: "AAAA" },
        sha256: "a".repeat(64),
      },
      {
        path: "corporate_actions/part-000.parquet",
        bytes: 50,
        checksum: { algo: "crc32c", value: "BBBB" },
        sha256: "b".repeat(64),
      },
    ],
  };
  const good = [
    {
      path: "bars_d1/market=US/year=2024/part-000.parquet",
      bytes: 100,
      crc32c: "AAAA",
    },
    { path: "corporate_actions/part-000.parquet", bytes: 50, crc32c: "BBBB" },
  ];

  it("is silent when the bucket matches", () => {
    assert.deepEqual(verifyManifest(manifest, good), []);
  });

  it("names a MISSING file", () => {
    assert.deepEqual(verifyManifest(manifest, good.slice(0, 1)), [
      "MISSING corporate_actions/part-000.parquet",
    ]);
  });

  it("names an UNLISTED file — a crashed partial cut a `bars_d1/**` scan would still read", () => {
    const extra = [
      ...good,
      {
        path: "bars_d1/market=US/year=2024/part-001.parquet",
        bytes: 9,
        crc32c: "CCCC",
      },
    ];
    assert.deepEqual(verifyManifest(manifest, extra), [
      "UNLISTED bars_d1/market=US/year=2024/part-001.parquet",
    ]);
  });

  it("MISSING and UNLISTED are DIFFERENT words — they need opposite fixes", () => {
    const swapped = [
      {
        path: "bars_d1/market=US/year=2024/part-999.parquet",
        bytes: 100,
        crc32c: "AAAA",
      },
      good[1]!,
    ];
    const out = verifyManifest(manifest, swapped);
    assert.ok(
      out.some((p) => p.startsWith("MISSING ")),
      out.join("; "),
    );
    assert.ok(
      out.some((p) => p.startsWith("UNLISTED ")),
      out.join("; "),
    );
  });

  it("catches a CRC that moved under an unchanged size", () => {
    const tampered = [{ ...good[0]!, crc32c: "ZZZZ" }, good[1]!];
    assert.deepEqual(verifyManifest(manifest, tampered), [
      "CRC bars_d1/market=US/year=2024/part-000.parquet: manifest AAAA, bucket ZZZZ",
    ]);
  });

  it("catches a size that moved under an unchanged CRC", () => {
    const tampered = [{ ...good[0]!, bytes: 101 }, good[1]!];
    assert.deepEqual(verifyManifest(manifest, tampered), [
      "SIZE bars_d1/market=US/year=2024/part-000.parquet: manifest 100, bucket 101",
    ]);
  });

  it("the checksum algorithm is a NAMED field, and sha256 rides beside it", () => {
    // crc32c is what the BUCKET can answer from metadata; sha256 is what a
    // reader holding a local copy can answer with a standard library.
    assert.equal(manifest.files[0]!.checksum.algo, "crc32c");
    assert.match(manifest.files[0]!.sha256, /^[0-9a-f]{64}$/);
  });
});
