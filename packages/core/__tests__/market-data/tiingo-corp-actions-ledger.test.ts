/**
 * What a listed Tiingo corp-action object means — MONEY-1474.
 *
 * The defect this replaces was one-directional in BOTH directions at once. The
 * first cut derived keys from `BackfillCheckpoint`, and its first prod dry run
 * measured the result: 93 candidates against 28 real objects, 71 recorded
 * MISSING (63 of them ex-dates in the FUTURE) while 6 real objects were never
 * candidates at all. Every checkpoint was written on one day by one historical
 * walk; every object was written later by the nightly leg, which writes no
 * checkpoints. The two are causally unrelated.
 *
 * So these tests are about the ARCHIVE, which is the only thing that knows what
 * the archive holds.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CORP_ACTION_FEEDS,
  MIN_ARCHIVED_BYTES,
  prefixFor,
  scanArchiveKeys,
  vendorFileNameFor,
  type ListedObject,
} from "../../src/market-data/tiingo/tiingo-corp-actions-ledger";
import { buildFeedArchiveKey } from "../../src/market-data/feed-archive";
import {
  buildCorpActionsUrl,
  corpActionsDescriptor,
} from "../../src/market-data/tiingo/tiingo-corp-actions";
import { bucketForPrefix } from "../../src/ops/lake-layout";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/** A key built the way the ARCHIVE builds it, never hand-spelled. */
const realKey = (feed: string, exDate: string): string =>
  buildFeedArchiveKey(
    corpActionsDescriptor(feed, exDate),
    buildCorpActionsUrl(feed, exDate),
  );

const obj = (name: string, over: Partial<ListedObject> = {}): ListedObject => ({
  name,
  generation: 1758000000000000,
  size: 4096,
  contentType: "text/csv",
  timeCreated: new Date("2026-09-04T21:05:00.000Z"),
  ...over,
});

describe("the prefix is the archive's own, and it ends in a slash", () => {
  it("both feeds resolve under feeds/TIINGO and into the CONTENT bucket", () => {
    assert.deepEqual([...CORP_ACTION_FEEDS], ["distributions", "splits"]);
    for (const feed of CORP_ACTION_FEEDS) {
      // ANCHORED to a key the ARCHIVE builds, never re-spelled. Asserting
      // `feeds/TIINGO/${feed}/` against itself would pass while the writer's
      // own slug drifted, and the job would then list a prefix holding nothing.
      assert.ok(
        realKey(feed, "2026-09-04").startsWith(prefixFor(feed)),
        `${feed}: the prefix must contain the key the writer produces`,
      );
      // `feeds/` is a CONTENT prefix, never a lake one. The Databento mapper
      // shipped this wrong once, naming a bucket its objects were not in.
      assert.equal(
        bucketForPrefix(prefixFor(feed), "prod"),
        "stockbook-content-prod",
      );
    }
  });

  it("the trailing slash is present, so a sibling directory cannot match", () => {
    // GCS prefix matching is a plain string prefix: without the slash,
    // `feeds/TIINGO/splits` would also sweep in a future `…/splits-v2/`.
    for (const feed of CORP_ACTION_FEEDS) {
      assert.ok(prefixFor(feed).endsWith("/"), `${feed} prefix must end in /`);
    }
  });
});

describe("a real archive key round-trips", () => {
  it("a key the ARCHIVE built is parsed back to its feed and ex-date", () => {
    const key = realKey("splits", "2026-09-04");
    const { rows, rejected } = scanArchiveKeys([obj(key)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.feed, "splits");
    assert.equal(rows[0]!.exDate, "2026-09-04");
    assert.deepEqual(Object.values(rejected), [0, 0, 0, 0]);
  });

  it("the six objects the checkpoint approach MISSED are all recordable", () => {
    // Measured on prod 2026-09-17: splits for these dates are in the bucket and
    // were never candidates, because their checkpoints were written 2026-08-29
    // when the dates were still in the future and Tiingo returned nothing.
    const missed = [
      "2026-09-04",
      "2026-09-07",
      "2026-09-11",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
    ];
    const { rows } = scanArchiveKeys(
      missed.map((d) => obj(realKey("splits", d))),
    );
    assert.deepEqual(
      rows.map((r) => r.exDate),
      missed,
    );
  });

  it("metadata from the listing is carried through, not re-fetched", () => {
    // One listing replaces one HEAD per object. If these stop being carried,
    // `generation` goes null and the MERGE loses its version pin.
    const { rows } = scanArchiveKeys([
      obj(realKey("distributions", "2026-09-02"), {
        generation: 42,
        size: 777,
        contentType: "text/csv; charset=utf-8",
      }),
    ]);
    assert.equal(rows[0]!.object.generation, 42);
    assert.equal(rows[0]!.object.size, 777);
    assert.equal(rows[0]!.object.contentType, "text/csv; charset=utf-8");
  });
});

describe("rejections are NAMED, because they mean different things", () => {
  it("a key from another feed family is not a corp-action key", () => {
    const { rows, rejected } = scanArchiveKeys([
      obj("feeds/NSE/bhavcopy/2026/09/x.csv"),
      obj("databento/EQUS.MINI/ohlcv-1m/2026/j/x.csv.zst"),
      obj("feeds/TIINGO/splits/notayear/09/x.csv"),
    ]);
    assert.equal(rows.length, 0);
    assert.equal(rejected["unparsable-key"], 3);
  });

  it("a zero-byte or unsized object is NOT recorded PRESENT", () => {
    // PRESENT asserts bytes exist at that key, and this leg writes no other
    // state. A finalized-but-empty upload or a Console placeholder would
    // otherwise become a healthy row and be re-MERGEd for ever — the shape that
    // left 6,125 `stock_documents` rows carrying `gcsPath: ""`.
    //
    // `size: null` counts too: "we did not learn the size" is not evidence of a
    // healthy object.
    const { rows, rejected } = scanArchiveKeys([
      obj(realKey("splits", "2026-09-04"), { size: 0 }),
      obj(realKey("splits", "2026-09-07"), { size: null }),
      obj(realKey("splits", "2026-09-11"), { size: MIN_ARCHIVED_BYTES - 1 }),
    ]);
    assert.equal(rows.length, 0);
    assert.equal(rejected["below-min-bytes"], 3);
  });

  it("exactly at the minimum IS recorded — the guard is >=", () => {
    const { rows } = scanArchiveKeys([
      obj(realKey("splits", "2026-09-04"), { size: MIN_ARCHIVED_BYTES }),
    ]);
    assert.equal(rows.length, 1);
  });

  it("an object with no ex-date in its STEM was not written by this writer", () => {
    const { rows, rejected } = scanArchiveKeys([
      obj("feeds/TIINGO/splits/2026/09/splits-current.csv"),
    ]);
    assert.equal(rows.length, 0);
    assert.equal(rejected["no-ex-date"], 1);
  });

  it("the ex-date is read from the STEM, not the query label", () => {
    // MEASURED: `corpActionsDescriptor("splits","2026-09-04").basename` is
    // `splits-2026-09-04.csv` — it carries NO `exDate-` token. The
    // `exDate-2026-09-04` visible in the full key comes from
    // `queryDiscriminator` sanitising the query string, sorted alphabetically
    // and SLICED at QUERY_LABEL_MAX. An earlier cut parsed THAT, so one extra
    // param sorting before `exDate` would push the date past the cap and make
    // every object unparsable at once.
    //
    // Here the stem says 09-04 and the query label says 09-11. The stem wins.
    const { rows } = scanArchiveKeys([
      obj(
        "feeds/TIINGO/splits/2026/09/splits-2026-09-04__exDate-2026-09-11_format-csv-dead.csv",
      ),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.exDate, "2026-09-04", "the STEM is authoritative");
  });

  it("a path month disagreeing with the ex-date is refused, not guessed", () => {
    // `buildFeedArchiveKey` files an object under the {YYYY}/{MM} of its own
    // date. If they ever disagree the grammar has changed, and picking either
    // one would be a guess that lands a row on the wrong partition.
    const { rows, rejected } = scanArchiveKeys([
      // STEM says September, PATH says August.
      obj(
        "feeds/TIINGO/splits/2026/08/splits-2026-09-04__exDate-2026-09-04_f.csv",
      ),
    ]);
    assert.equal(rows.length, 0);
    assert.equal(rejected["path-date-disagrees"], 1);
  });
});

describe("ordering and the operator-facing name", () => {
  it("rows come back deterministically ordered", () => {
    const { rows } = scanArchiveKeys([
      obj(realKey("splits", "2026-09-07")),
      obj(realKey("splits", "2026-09-04")),
      obj(realKey("distributions", "2026-09-04")),
    ]);
    assert.deepEqual(
      rows.map((r) => `${r.exDate}:${r.feed}`),
      ["2026-09-04:distributions", "2026-09-04:splits", "2026-09-07:splits"],
    );
  });

  it("vendorFileName is the DAY, not the request digest", () => {
    // The GCS basename carries a query-string digest identifying the REQUEST.
    // Nobody reading `vendor_file_name` in a coverage query wants that.
    assert.equal(
      vendorFileNameFor("splits", "2026-09-04"),
      "splits-2026-09-04.csv",
    );
    assert.doesNotMatch(
      vendorFileNameFor("splits", "2026-09-04"),
      /format-csv-/,
    );
  });

  it("an empty listing yields no rows — the JOB decides that is a refusal", () => {
    assert.deepEqual(scanArchiveKeys([]).rows, []);
  });
});

describe("the job lists FAIL-CLOSED and never claims MISSING", () => {
  const code = stripComments(
    readFileSync(
      join(REPO, "scripts", "jobs", "ledger-backfill-tiingo.ts"),
      "utf8",
    ),
  );

  it("it uses the lister that THROWS, never the one that returns []", () => {
    // `listFiles` fails open, so a credentials blip would record an EMPTY
    // inventory — which in a ledger is worse than no row, because a coverage
    // query reads it as an answer. That is the whole reason B1 said never list.
    // `streamObjectSummaries` already existed for exactly this, and pages.
    assert.match(code, /streamObjectSummaries\(/);
    assert.doesNotMatch(code, /\blistFiles\(/);
    assert.doesNotMatch(
      code,
      /\blistObjects\(/,
      "the duplicate lister is gone",
    );
  });

  it("an empty feed THROWS — and the throw is asserted, not the prose", () => {
    // THIS TEST WAS VACUOUS AND A REVIEWER PROVED IT: changing `throw new
    // Error(` to `log.warn(` left all 19 cases green, because the assertion
    // grepped only for the message text — which a warn satisfies identically.
    // The one fail-closed property of this leg was protected by nothing.
    //
    // Anchored to the STATEMENT now. A source scan still cannot execute the
    // job, but it can at least require the control flow rather than the string.
    assert.match(
      code,
      /throw new Error\(\s*`no objects under feeds\/TIINGO/,
      "the empty-feed refusal must THROW, not log",
    );
    assert.match(code, /Refusing to report a clean run/);
  });

  it("the refusal is PER FEED, not over the union of both", () => {
    // Testing `listed.length === 0` lets one dark feed hide behind the other:
    // distributions 404ing while splits returns 14 gives a non-empty union, a
    // SUCCESS run, and a ledger silently covering half the source. That is
    // MONEY-1255's per-source zero inside an aggregate counter, one level up.
    assert.match(code, /emptyFeeds\.push\(feed\)/);
    assert.match(code, /if \(emptyFeeds\.length > 0\)/);
    assert.doesNotMatch(
      code,
      /if \(listed\.length === 0\)/,
      "a union check would hide a single dark feed",
    );
  });

  it("endRun ALWAYS fires, and its status reflects what was refused", () => {
    // Two defects the sibling leg did not have. An unguarded write throws past
    // `endRun` and leaves `finished_at` NULL for ever — which the DDL defines
    // as "STILL RUNNING or killed" — and `runId` mints a new id per attempt so
    // nothing reconciles the orphan. And an unconditional SUCCESS made a run
    // that dropped objects read green in BigQuery and in Cloud Run.
    assert.match(code, /status: ok \? "SUCCESS" : "FAILED"/);
    assert.match(code, /process\.exitCode = 1/);
    assert.doesNotMatch(
      code,
      /status:\s*"SUCCESS",/,
      "must not be unconditional",
    );
  });

  it("MISSING is unreachable — there is no manifest to prove a loss", () => {
    // Absence here is either "no corporate actions that day" or "the PUT
    // failed", and nothing distinguishes them. Databento may write MISSING
    // because a vendor manifest proves delivery; this leg has none.
    assert.doesNotMatch(code, /"MISSING"/);
    assert.match(code, /state:\s*"PRESENT"/);
  });

  it("verifiedAt is null — these feeds carry no vendor checksum", () => {
    assert.match(code, /verifiedAt:\s*null/);
    assert.doesNotMatch(code, /"VERIFIED"/);
  });

  it("it no longer reads BackfillCheckpoint at all", () => {
    // The whole defect: a checkpoint records one walk's ATTEMPT, and the
    // archive is written by a different producer on a different schedule.
    assert.doesNotMatch(code, /backfillCheckpoint|BackfillCheckpoint/);
    assert.doesNotMatch(code, /archiving-since/);
  });

  it("acquired_at is ARRIVAL time, matching the only other writer", () => {
    // `acquired_at` means "when the file arrived" everywhere else in this table
    // (`toLedgerSourceObjects` computes `downloadedAt ?? submittedAt ?? now`),
    // and one column in one PARTITION BY DATE(acquired_at) table must not carry
    // two different facts keyed by `source`.
    //
    // The ex-date was wrong twice: the nightly leg fetches the NEXT trading
    // day, so the stamp would sit in the FUTURE of the PUT on every row; and
    // over 1990-2026 it would occupy ~9,600 of BigQuery's 10,000 partitions per
    // table for this leg alone.
    assert.match(code, /acquiredAt:\s*r\.object\.timeCreated \?\? startedAt/);
    assert.doesNotMatch(code, /acquiredAt:\s*new Date\(`\$\{r\.exDate\}/);
  });
});

/**
 * Drop comments so a scan reads CODE rather than prose.
 *
 * LINE FIRST, THEN BLOCK — MONEY-1143, enforced repo-wide by
 * apps/web/__tests__/meta/comment-strip-ordering.test.ts. Block-first lets a
 * `//` comment containing an open-block marker swallow every line to the next
 * close, and every assertion above is an ABSENCE, so eaten code reads as a PASS.
 *
 * The `[^:]` guard stops a URL being read as a line comment: without it
 * `const u = "https://x"; listFiles();` truncates at the scheme and a
 * `doesNotMatch` passes because the code was eaten, not because it is absent.
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the stripper itself", () => {
  it("does not eat a URL, and strips a line comment before a block marker", () => {
    assert.equal(
      stripComments(
        'const u = "https://api.tiingo.com/x"; listFiles();',
      ).trim(),
      'const u = "https://api.tiingo.com/x"; listFiles();',
    );
    assert.equal(stripComments("foo(); // listFiles()").trim(), "foo();");
    assert.match(
      stripComments("// see /* note\nlistFiles();"),
      /listFiles\(\);/,
    );
  });
});
