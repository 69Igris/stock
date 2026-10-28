/**
 * The G0 gate's arithmetic, and the one policy a source scan CAN settle.
 *
 * `scripts/ops/atlas-heatmap.ts` runs against PRODUCTION and, under
 * `--allow-rw`, with the read-WRITE application credential. Every assertion
 * here is aimed at a failure that would look like a clean run:
 *
 *   - a DB-wide index ranking that is secretly per-collection,
 *   - a `$collStats` fold that reads `docs[0]` and under-counts a sharded
 *     cluster by a factor of the shard count,
 *   - an `avgObjSize` averaged from per-shard averages,
 *   - a cube fold that drops rows whose `source` attribute is ABSENT — the
 *     MONEY-1050 / 1234 / 1235 class,
 *   - a renderer that quietly stops emitting the two things the gate was
 *     commissioned for (the fillable invoice, the `$indexStats` epoch caveat),
 *   - and a future edit that adds a write call to a read-only script.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CollectionStats,
  type CubeRow,
  foldCube,
  formatBytes,
  observedWindowDays,
  rankIndexes,
  redactUri,
  renderMarkdown,
  summariseCollStats,
} from "../../src/ops/atlas-heatmap";

const SOURCE_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "ops",
  "atlas-heatmap.ts",
);
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

/**
 * Comments stripped before any scan.
 *
 * The script DOCUMENTS the stages it forbids — its header names `$out`,
 * `$merge` and "three separate `$group` stages" while explaining why none of
 * them appear — so a match against raw text finds every prohibition in the
 * prose that forbids it and asserts the exact opposite of the truth. Same
 * reason `qa-sample-plan.test.ts` strips `#` comments from the sync script
 * before asserting its collection coverage.
 */
const CODE = SOURCE.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function collection(
  name: string,
  indexSizes: Record<string, number>,
): CollectionStats {
  return {
    name,
    type: "collection",
    count: 1,
    avgObjSize: 1,
    storageSize: 1,
    totalIndexSize: Object.values(indexSizes).reduce((a, b) => a + b, 0),
    indexCount: Object.keys(indexSizes).length,
    indexSizes,
  };
}

test("rankIndexes ranks across the DATABASE, not within each collection", () => {
  // `candles` owns the three biggest indexes AND the smallest; a per-collection
  // top-N concatenated would return candles' three and never reach `trades`.
  const cols = [
    collection("candles", { a: 100, b: 90, c: 80, d: 10 }),
    collection("trades", { e: 95, f: 85 }),
  ];

  const top = rankIndexes(cols, 4);

  assert.deepEqual(
    top.map((t) => `${t.collection}.${t.index}`),
    ["candles.a", "trades.e", "candles.b", "trades.f"],
    "the ranking must INTERLEAVE collections — this is the assertion that fails if the flatten is replaced by a per-collection slice",
  );
  assert.equal(top.length, 4, "slice honours n");
});

test("summariseCollStats SUMS shard documents and RECOMPUTES avgObjSize", () => {
  // Two shards holding the same bytes but very different document counts.
  // Averaging the per-shard averages gives (100 + 25) / 2 = 62.5; the truth is
  // 400 bytes over 10 documents = 40.
  const stats = summariseCollStats("candles", "collection", [
    {
      storageStats: {
        count: 2,
        size: 200,
        storageSize: 1_000,
        totalIndexSize: 50,
        nindexes: 3,
        indexSizes: { _id_: 20, ts_1: 30 },
      },
    },
    {
      storageStats: {
        count: 8,
        size: 200,
        storageSize: 3_000,
        totalIndexSize: 70,
        nindexes: 3,
        indexSizes: { _id_: 25, ts_1: 45 },
      },
    },
  ]);

  assert.equal(stats.count, 10, "counts sum — docs[0] would report 2");
  assert.equal(stats.storageSize, 4_000);
  assert.equal(stats.totalIndexSize, 120);
  assert.equal(
    stats.avgObjSize,
    40,
    "recomputed from summed bytes, NOT the mean of the shard averages (62.5)",
  );
  assert.deepEqual(
    stats.indexSizes,
    { _id_: 45, ts_1: 75 },
    "same-named index sums across shards",
  );
  assert.equal(
    stats.indexCount,
    3,
    "nindexes is per-shard identical, so max not sum",
  );
});

test("summariseCollStats survives an EMPTY collection without producing NaN", () => {
  // avgObjSize is ABSENT from $collStats on an empty collection. `size / count`
  // is 0/0 = NaN, and a NaN reaching the markdown renders as a real-looking
  // cell.
  const stats = summariseCollStats("empty", "collection", [
    {
      storageStats: {
        count: 0,
        size: 0,
        storageSize: 4_096,
        totalIndexSize: 4_096,
        nindexes: 1,
        indexSizes: { _id_: 4_096 },
      },
    },
  ]);
  assert.equal(stats.avgObjSize, 0);
  assert.ok(Number.isFinite(stats.avgObjSize));
});

test("foldCube counts every row once into EACH breakdown, and the three totals agree", () => {
  const cube: CubeRow[] = [
    { timeframe: "D1", source: "TIINGO", year: 2025, docs: 10 },
    { timeframe: "D1", source: "DATABENTO", year: 2025, docs: 5 },
    { timeframe: "M1", source: "DATABENTO", year: 2026, docs: 7 },
    { timeframe: "D1", source: "TIINGO", year: 2026, docs: 3 },
  ];

  const b = foldCube(cube);
  const sum = (rows: Array<{ docs: number }>) =>
    rows.reduce((s, r) => s + r.docs, 0);

  assert.equal(sum(b.byTimeframe), 25);
  assert.equal(sum(b.bySource), 25);
  assert.equal(
    sum(b.byYear),
    25,
    "all three foldings of one cube must total the same",
  );

  // D1 spans two sources and two years: a fold that `set`s instead of adding
  // would report 3 here (last write wins) rather than 18.
  assert.deepEqual(b.byTimeframe, [
    { key: "D1", docs: 18 },
    { key: "M1", docs: 7 },
  ]);
  assert.deepEqual(
    b.bySource,
    [
      { key: "DATABENTO", docs: 12 },
      { key: "TIINGO", docs: 13 },
    ].sort((x, y) => y.docs - x.docs),
  );
  assert.deepEqual(
    b.byYear,
    [
      { key: "2025", docs: 15 },
      { key: "2026", docs: 10 },
    ],
    "years sort ASCENDING by key, so a reader sees the history in order",
  );
});

test("foldCube NAMES an absent source/timeframe instead of dropping the rows", () => {
  // A Mongo `db push` creates indexes, not fields: on every row predating a
  // column the attribute is ABSENT. Dropping those rows would under-report the
  // collection while every percentage still summed to 100%.
  const cube = [
    {
      timeframe: "D1",
      source: undefined as unknown as string,
      year: null,
      docs: 9,
    },
    { timeframe: "D1", source: "TIINGO", year: 2026, docs: 1 },
  ];

  const b = foldCube(cube);
  assert.equal(
    b.bySource.reduce((s, r) => s + r.docs, 0),
    10,
    "no row is silently discarded",
  );
  assert.ok(
    b.bySource.some((r) => r.key === "(absent)" && r.docs === 9),
    "an absent source is a NAMED bucket, never a filter",
  );
  assert.ok(b.byYear.some((r) => r.key === "(no ts)" && r.docs === 9));
});

test("redactUri FAILS CLOSED — no input may pass a credential through", () => {
  // The first version matched userinfo as `[^@/]*`, i.e. "anything but a slash
  // or an at-sign". A MongoDB password may legally contain an UNENCODED `/`,
  // and on one the pattern did not match at all, so `.replace` returned the
  // string UNCHANGED and printed the full credential. Measured, not theorised —
  // and it is the same defect `run-market-data-job.sh` already carries a note
  // about. A redactor whose failure mode is DISCLOSURE is worse than none,
  // because the caller believes it worked.
  const cases = [
    "mongodb+srv://heatmap_ro:s3cr3t@cluster0.abc.mongodb.net/usemoney?retryWrites=false",
    "mongodb+srv://user:p%2Fss@h.mongodb.net/db", // percent-encoded slash
    "mongodb+srv://user:pa/ss@h.mongodb.net/db", // RAW slash — the fail-open case
    "mongodb://user:pa/ss@h:27017/db",
    "mongodb+srv://u:p@ss@h.mongodb.net/db", // `@` in the password: LAST one wins
    "mongodb://a:b@h1:27017,h2:27017/db?replicaSet=rs0", // seed list
  ];
  for (const uri of cases) {
    const out = redactUri(uri);
    // The generic invariant: nothing between "://" and the host may survive.
    assert.ok(
      !/:\/\/[^@]*:[^@]*@/.test(out),
      `credential survived redaction of ${uri} -> ${out}`,
    );
    for (const leak of [
      "s3cr3t",
      "heatmap_ro",
      "pa/ss",
      "p%2Fss",
      "p@ss",
      "a:b",
    ]) {
      assert.ok(!out.includes(leak), `"${leak}" leaked from ${uri} -> ${out}`);
    }
  }

  // The host IS the point of the field and must survive.
  assert.equal(
    redactUri(
      "mongodb+srv://heatmap_ro:s3cr3t@cluster0.abc.mongodb.net/usemoney?retryWrites=false",
    ),
    "mongodb+srv://<credentials>@cluster0.abc.mongodb.net/usemoney",
  );
  // A credential-less URI is not decorated with a credential marker.
  assert.equal(
    redactUri("mongodb+srv://h.mongodb.net/db"),
    "mongodb+srv://h.mongodb.net/db",
  );
  // Unparseable input yields NOTHING, never the input.
  assert.equal(redactUri("not-a-uri"), "<unparseable connection string>");
  assert.ok(
    !redactUri("mongodb://\u0000:x@weird\u0000host/db").includes("weird"),
  );
});

test("formatBytes is human at every scale and never emits NaN", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(80 * 1024 ** 3), "80.0 GiB");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("the markdown always carries the invoice table and the $indexStats epoch caveat", () => {
  const md = renderMarkdown(
    "2026-09",
    "2026-09-14T00:00:00.000Z",
    "deadbee",
    [
      {
        label: "stockbook — PROD",
        hostRedacted: "mongodb+srv://<credentials>@c0.mongodb.net/usemoney",
        credential: "test",
        dbName: "usemoney",
        serverVersion: "8.0.0",
        dbStats: {
          collections: 1,
          objects: 10,
          dataSize: 100,
          storageSize: 200,
          indexes: 2,
          indexSize: 50,
        },
        collections: [collection("candles", { _id_: 10, ts_1: 40 })],
        candles: null,
        candlesNote: "`--skip-candles` was passed",
        indexStats: [
          {
            collection: "candles",
            index: "_id_",
            host: "shard-00-01:27017",
            ops: 5,
            since: "2026-08-01T00:00:00.000Z",
          },
          {
            collection: "candles",
            index: "ts_1",
            host: "shard-00-01:27017",
            ops: 0,
            since: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    ],
    ["claude-algo cluster not measured"],
  );

  // The invoice ships EMPTY — a pre-filled plausible number is the one thing
  // that would make this document lie.
  assert.ok(md.includes("## Invoice"));
  assert.ok(
    md.includes("| Storage (GB-month) |  |  |  |  |"),
    "invoice rows are blank cells, not guesses",
  );
  assert.ok(
    md.includes("Tier-hours".toLowerCase()) ||
      md.includes("Instance (tier-hours)"),
  );

  // The caveat that makes B6's 30-day diff falsifiable.
  assert.match(md, /accesses\.since/);
  assert.match(md, /VOID, not clean/);
  assert.ok(
    md.includes("shard-00-01:27017"),
    "the host the counters came from is named",
  );

  // A skipped cluster and a skipped cube are NAMED absences.
  assert.ok(md.includes("claude-algo cluster not measured"));
  assert.ok(md.includes("NOT CAPTURED"));

  // The credential section must name BOTH roles, BOTH secrets, and the
  // coupling: these secrets embed the datadog_monitor password, so a rotation
  // of DD_MONGO_MONITOR_PASSWORD_PROD silently strands them on the old value.
  // The rotation path has nothing in it that says so — only this does.
  assert.ok(md.includes("clusterMonitor"));
  assert.ok(md.includes("readAnyDatabase"));
  assert.ok(md.includes("MONGODB_URI_RO_PROD"));
  assert.ok(md.includes("ALGO_MONGODB_URI_RO_PROD"));
  assert.match(
    md,
    /DD_MONGO_MONITOR_PASSWORD_PROD/,
    "the shared-password coupling must be stated",
  );
  assert.match(
    md,
    /create-ro-secrets\.mjs/,
    "…together with the command that repairs it",
  );
  assert.match(
    md,
    /Unauthorized/,
    "and the evidence that the user cannot write",
  );
});

test("a SHORT observed window is stated loudly, because it is the zero-op count's denominator", () => {
  // Measured on the first real prod run: the counter epoch was three days old,
  // not thirty — that mongod had restarted. "25 of 73 indexes at zero ops" is
  // evidence over 30 days and noise over 3, and nothing in the raw count says
  // which. Same defect shape as a ratio with an unverified denominator.
  assert.equal(
    observedWindowDays("2026-09-11T00:00:00.000Z", "2026-09-14T00:00:00.000Z"),
    3,
  );
  assert.equal(
    observedWindowDays("bad", "2026-09-14T00:00:00.000Z"),
    0,
    "unparseable -> 0, never NaN",
  );
  assert.equal(
    observedWindowDays("2026-09-20T00:00:00.000Z", "2026-09-14T00:00:00.000Z"),
    0,
    "a since in the FUTURE is not a negative window",
  );

  const render = (since: string) =>
    renderMarkdown(
      "2026-09",
      "2026-09-14T00:00:00.000Z",
      "c0ffee",
      [
        {
          label: "x",
          hostRedacted: "h",
          credential: "t",
          dbName: "d",
          serverVersion: "8.0",
          dbStats: {
            collections: 1,
            objects: 1,
            dataSize: 1,
            storageSize: 1,
            indexes: 1,
            indexSize: 1,
          },
          collections: [collection("candles", { _id_: 1 })],
          candles: null,
          candlesNote: "skipped",
          indexStats: [
            {
              collection: "candles",
              index: "dead_idx",
              host: "h:27017",
              ops: 0,
              since,
            },
          ],
        },
      ],
      [],
    );

  const short = render("2026-09-11T00:00:00.000Z");
  assert.match(short, /OBSERVED WINDOW: 3\.0 DAYS/);
  assert.match(
    short,
    /is not evidence that they are unused/,
    "a 3-day window must disclaim its own zero-op count",
  );
  assert.match(short, /BASELINE, not a verdict/);

  const long = render("2026-07-14T00:00:00.000Z");
  assert.match(long, /OBSERVED WINDOW: 62\.0 DAYS/);
  assert.ok(
    !/is not evidence that they are unused/.test(long),
    "a long window carries no disclaimer",
  );
});

test("the observed window is graded from the SHORTEST counter run, not the longest", () => {
  // `accesses.since` differs per index: a newly created index starts counting
  // from its creation, an old one from the last mongod restart. `sinces` is
  // sorted ASCENDING, so `[0]` is the OLDEST epoch — grading against it gives
  // the LONGEST window and suppresses the disclaimer exactly when it is most
  // needed. An index created yesterday would be judged over 62 days and its
  // zero ops read as evidence, which is how B6 ends up proposing a drop of a
  // brand-new index: the outcome the PRIMARY pinning exists to prevent.
  const md = renderMarkdown(
    "2026-09",
    "2026-09-14T00:00:00.000Z",
    "c0ffee",
    [
      {
        label: "x",
        hostRedacted: "h",
        credential: "test",
        dbName: "d",
        serverVersion: "8.0",
        dbStats: {
          collections: 1,
          objects: 1,
          dataSize: 1,
          storageSize: 1,
          indexes: 2,
          indexSize: 2,
        },
        collections: [collection("candles", { _id_: 1, fresh_idx: 1 })],
        candles: null,
        candlesNote: "skipped",
        indexStats: [
          // Counting since July — 62 days.
          {
            collection: "candles",
            index: "_id_",
            host: "h:27017",
            ops: 900,
            since: "2026-07-14T00:00:00.000Z",
          },
          // Created yesterday — ONE day of evidence, and zero ops so far.
          {
            collection: "candles",
            index: "fresh_idx",
            host: "h:27017",
            ops: 0,
            since: "2026-09-13T00:00:00.000Z",
          },
        ],
      },
    ],
    [],
  );

  assert.match(
    md,
    /OBSERVED WINDOW: 1\.0 DAYS/,
    "the shortest run is the only one every index has had",
  );
  assert.ok(
    !/OBSERVED WINDOW: 62/.test(md),
    "grading from the oldest epoch overstates the evidence",
  );
  assert.match(
    md,
    /is not evidence that they are unused/,
    "…so the disclaimer must fire",
  );
});

test("atlas-heatmap.ts contains NO Mongo write call", () => {
  // A source scan cannot usually assert a policy. It settles this one exactly,
  // because the policy IS "this file contains no write call" — and the script
  // can be handed the read-write production credential via --allow-rw.
  const forbidden = [
    "insertOne",
    "insertMany",
    "updateOne",
    "updateMany",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndUpdate",
    "findOneAndDelete",
    "findOneAndReplace",
    "bulkWrite",
    "renameCollection",
    "createIndex",
    "createIndexes",
    "dropIndex",
    "dropIndexes",
    "dropDatabase",
  ];
  for (const verb of forbidden) {
    assert.ok(
      !new RegExp(`\\.${verb}\\s*\\(`).test(CODE),
      `atlas-heatmap.ts calls .${verb}() — this script is READ-ONLY and runs against production`,
    );
  }
  assert.ok(!/\$out\b/.test(CODE), "an aggregation may not write via $out");
  assert.ok(!/\$merge\b/.test(CODE), "an aggregation may not write via $merge");

  // `db.command()` can issue anything, so enumerate what is actually sent.
  const commands = [...CODE.matchAll(/\.command\(\s*\{\s*([A-Za-z]+)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set(commands)].sort(),
    ["buildInfo", "dbStats"],
    "only read commands may be issued; a new one must be reviewed here",
  );
});

test("the PURE module never touches a Mongo client", () => {
  // The write-call scan above covers the script. It does not need to cover the
  // renderer, and must not: the renderer's markdown legitimately contains the
  // words `createIndex` and `dropIndex` as B6's rollback instructions. What
  // keeps that safe is that the pure module has no client to write WITH.
  const pure = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "ops", "atlas-heatmap.ts"),
    "utf8",
  );
  assert.ok(
    !/from\s+"mongodb"/.test(pure),
    "the pure module must not import the driver",
  );
  assert.ok(
    /from\s+"mongodb"/.test(CODE),
    "…and the script is the only place that does",
  );
});

test("the candles cube is ONE pass and $indexStats is pinned to the PRIMARY", () => {
  // Three $group stages would be three scans of a collection in the hundreds of
  // millions of rows; and $indexStats counters are per-node, so reading them
  // from a secondary reports near-zero ops for every index and would invite B6
  // to drop the hottest indexes on the cluster.
  assert.equal(
    (CODE.match(/\$group/g) ?? []).length,
    1,
    "exactly one $group — the compound cube, folded client-side",
  );
  assert.match(
    CODE,
    /\$indexStats[^]{0,200}readPreference:\s*"primary"/,
    "$indexStats must be read from the PRIMARY",
  );
  assert.match(
    CODE,
    /\$group[^]{0,400}allowDiskUse:\s*true/,
    "the cube needs allowDiskUse",
  );
});
