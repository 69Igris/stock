/**
 * Databento's inventory -> lake ledger rows. MONEY-1472 (B1).
 *
 * The mapping is pure so it can be asserted without BigQuery — and it has to
 * be, because every failure it can have is silent: a wrong `state` makes a
 * corrupt download read as checked, a doubled slash makes two ledger rows for
 * one object whose `state` then disagrees, and a fabricated hash makes an
 * unhashed object invisible to the query that looks for them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toLedgerSourceObjects } from "../../src/market-data/databento/databento-repo";
import { bucketForPrefix } from "../../src/ops/lake-layout";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/** Drop `//` and block comments, so a scan reads CODE rather than prose. */
function stripComments(src: string): string {
  return (
    src
      // LINE FIRST, THEN BLOCK (MONEY-1143). The repo guard did not flag this
      // file — its detector matches one spelling of the line regex — but the
      // defect is the same: block-first lets `//` … `/*` swallow real code, and
      // every assertion here is an ABSENCE, which a swallow turns into a PASS.
      .split("\n")
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

const NOW = new Date("2026-09-16T12:00:00.000Z");
const ROW = { jobId: "db-job-1", dataset: "EQUS.MINI", costUsd: 12.5 };
const FILE = {
  filename: "ohlcv-1m-20260915.csv.zst",
  size: 4096,
  sha256: "deadbeef",
  archiveKey:
    "databento/EQUS.MINI/ohlcv-1m/2026/db-job-1/ohlcv-1m-20260915.csv.zst",
  kind: "data" as const,
  verified: true,
};

describe("PRESENT and VERIFIED are different facts", () => {
  it("a verified file is VERIFIED and carries verifiedAt", () => {
    const [r] = toLedgerSourceObjects(ROW, [FILE], { env: "qa", now: NOW });
    assert.equal(r!.state, "VERIFIED");
    assert.deepEqual(r!.verifiedAt, NOW);
  });

  it("an UNVERIFIED file is PRESENT with a NULL verifiedAt", () => {
    // `PRESENT` means bytes exist at that key; `VERIFIED` means the vendor's
    // checksum matched. The repo's own header draws this line for
    // `verified` vs `loadedAt`, and conflating them here would let a corrupt
    // download read as checked — permanently, since nothing re-checks an object
    // the ledger already calls verified.
    const [r] = toLedgerSourceObjects(ROW, [{ ...FILE, verified: false }], {
      env: "qa",
      now: NOW,
    });
    assert.equal(r!.state, "PRESENT");
    assert.equal(r!.verifiedAt, null);
  });
});

describe("the hash is the VENDOR's, or it is absent", () => {
  it("an empty sha256 becomes NULL, not an empty string", () => {
    // B1 forbids hashing the archive ourselves: it would mean downloading
    // terabytes to learn what the manifest states, against files that expire 30
    // days after submission. An empty STRING would satisfy `IS NOT NULL`, so
    // the "which objects are unhashed?" query would miss exactly these.
    const [r] = toLedgerSourceObjects(ROW, [{ ...FILE, sha256: "" }], {
      env: "qa",
      now: NOW,
    });
    assert.equal(r!.sha256, null);
  });

  it("a present hash is passed through unchanged", () => {
    const [r] = toLedgerSourceObjects(ROW, [FILE], { env: "qa", now: NOW });
    assert.equal(r!.sha256, "deadbeef");
  });
});

describe("the bucket is RESOLVED from the key, never named", () => {
  it("a databento key resolves to the CONTENT bucket, not the lake bucket", () => {
    // THE DEFECT THIS EXISTS FOR, and the worst kind: the first cut hardcoded
    // `stockbook-lake-{env}` and THIS TEST ASSERTED IT, so the defect was
    // green. `databento/` is in CONTENT_PREFIXES, and
    // `setup-databento-jobs.sh` passes `stockbook-content-{env}` as
    // GCP_STORAGE_BUCKET — so every `object_uri` named a bucket the object is
    // not in, and the one question this table exists to answer ("do we still
    // have this file?") would have answered NO for every object that is in
    // fact present.
    //
    // Derived from `bucketForPrefix`, not typed as a literal: naming the
    // bucket beside the resolver is the one-fact-two-spellings defect that
    // caused this in the first place.
    const [r] = toLedgerSourceObjects(ROW, [FILE], { env: "qa", now: NOW });
    assert.equal(
      r!.objectUri,
      `gs://${bucketForPrefix(FILE.archiveKey, "qa")}/${FILE.archiveKey}`,
    );
    assert.match(r!.objectUri, /^gs:\/\/stockbook-content-qa\//);
    assert.doesNotMatch(
      r!.objectUri,
      /stockbook-lake/,
      "databento is not a lake prefix",
    );

    const [prod] = toLedgerSourceObjects(ROW, [FILE], {
      env: "prod",
      now: NOW,
    });
    assert.match(prod!.objectUri, /^gs:\/\/stockbook-content-prod\//);
  });

  it("a leading key slash does not double the separator", () => {
    // Two spellings of one uri means TWO ledger rows for one object, whose
    // `state` then disagrees — and `recordSourceObject` MERGEs on
    // (object_uri, generation), so the duplicate is permanent.
    const [r] = toLedgerSourceObjects(
      ROW,
      [{ ...FILE, archiveKey: `/${FILE.archiveKey}` }],
      { env: "qa", now: NOW },
    );
    assert.equal(
      r!.objectUri,
      `gs://${bucketForPrefix(FILE.archiveKey, "qa")}/${FILE.archiveKey}`,
    );
  });
});

describe("acquiredAt is when the file ARRIVED, not when we wrote the row", () => {
  it("it prefers downloadedAt, then submittedAt, then now", () => {
    // It is the PARTITION column. Stamping `now()` during a backfill of two
    // years of purchases puts every row in ONE date partition — the day the
    // backfill ran — so "what did we buy in 2024?" returns nothing and
    // partition pruning buys nothing for any query.
    const downloaded = new Date("2024-03-01T00:00:00.000Z");
    const submitted = new Date("2024-02-01T00:00:00.000Z");

    const [a] = toLedgerSourceObjects(
      { ...ROW, downloadedAt: downloaded, submittedAt: submitted },
      [FILE],
      { env: "qa", now: NOW },
    );
    assert.deepEqual(a!.acquiredAt, downloaded);

    const [b] = toLedgerSourceObjects(
      { ...ROW, submittedAt: submitted },
      [FILE],
      { env: "qa", now: NOW },
    );
    assert.deepEqual(b!.acquiredAt, submitted);

    const [c] = toLedgerSourceObjects(ROW, [FILE], { env: "qa", now: NOW });
    assert.deepEqual(
      c!.acquiredAt,
      NOW,
      "last resort: we do not know when it arrived",
    );
  });
});

describe("provenance travels with the row", () => {
  it("the vendor job id and file name are carried, and the source is named", () => {
    const [r] = toLedgerSourceObjects(ROW, [FILE], { env: "qa", now: NOW });
    assert.equal(r!.source, "DATABENTO");
    assert.equal(r!.vendorJobId, "db-job-1");
    assert.equal(r!.vendorFileName, FILE.filename);
    assert.equal(r!.dataset, "EQUS.MINI");
    // `costUsd` is carried; `entitlement` is NOT — `DatabentoBatchJob` has no
    // such field, so the first cut read `undefined` on every row while this
    // test asserted "standard" travelled. A shadow test over a field no
    // production row can produce. Dropping the claim beats faking the column.
    assert.equal(r!.costUsd, 12.5);
  });

  it("an absent entitlement is NULL rather than undefined", () => {
    const [r] = toLedgerSourceObjects(
      { jobId: null, dataset: "EQUS.MINI" },
      [FILE],
      { env: "qa", now: NOW },
    );
    assert.equal(r!.costUsd, null);
    assert.equal(r!.vendorJobId, null);
  });

  it("an empty record list maps to an empty row list, not to one empty row", () => {
    assert.deepEqual(
      toLedgerSourceObjects(ROW, [], { env: "qa", now: NOW }),
      [],
    );
  });
});

describe("the backfill selects rows a `db push` left FIELDLESS", () => {
  it("it filters in RAW MONGO — no Prisma predicate matches an absent field", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS GREEN OVER A DEAD
    // QUERY FOR THE WHOLE LIFE OF THE DEFECT.
    //
    // It demanded `{ ledgerBacked: { not: true } }` on the belief that `not`
    // includes absent fields. MEASURED against PROD 2026-09-17 — 69 rows,
    // `ledgerBacked` absent on all 69:
    //
    //     raw    { ledgerBacked: { $ne: true } }      69
    //     raw    { ledgerBacked: { $exists: false } } 69
    //     prisma { ledgerBacked: { not: true } }       0   <- what shipped
    //     prisma { ledgerBacked: false }               0
    //
    // Prisma compiles `not` to `$and: [{$ne: [f, true]}, {$ne: [f,"$$REMOVE"]}]`
    // and the second clause excludes every absent field. So the job printed
    // "Nothing to do." and exited 0 with an empty ledger — the exact
    // MONEY-1050/1234/1235 failure the assertion was written to prevent.
    //
    // A SOURCE SCAN CANNOT SEE RUNTIME BEHAVIOUR. This one greps for the shape
    // that was MEASURED to work; the measurement is the evidence, the grep only
    // stops it being quietly reverted.
    const code = stripComments(
      readFileSync(
        join(REPO, "scripts", "jobs", "ledger-backfill-databento.ts"),
        "utf8",
      ),
    );
    assert.match(
      code,
      /\$ne:\s*true/,
      "selection must go to Mongo verbatim — only `$ne: true` matches an absent field",
    );
    assert.doesNotMatch(
      code,
      /ledgerBacked:\s*(false|\{\s*(not|equals):)/,
      "NO Prisma predicate on ledgerBacked selects a db-push row: `not` and " +
        "`equals: false` both return 0 against all 69 prod rows",
    );
  });

  it("a zero selection against non-zero rows REFUSES rather than reporting done", () => {
    // The defect above was invisible because its symptom is indistinguishable
    // from health: "0 rows to back up" is what a finished job says too. The
    // job now separates them and throws, so the next time a selector dies it
    // cannot present as a clean run.
    const code = stripComments(
      readFileSync(
        join(REPO, "scripts", "jobs", "ledger-backfill-databento.ts"),
        "utf8",
      ),
    );
    assert.match(code, /selector matched 0 of/);
    assert.match(code, /prisma\.databentoBatchJob\.count\(\)/);
  });

  it("it never LISTS the bucket to discover keys", () => {
    // `listFiles` fails open to `[]`, so a reader that asked GCS "what is
    // there?" would record an EMPTY inventory on any credentials blip — which
    // in a ledger is worse than no row, because a coverage query reads it as an
    // answer.
    //
    // COMMENTS ARE STRIPPED FIRST. The first cut scanned the raw file and
    // matched the word `listFiles` in the job's OWN doc comment explaining why
    // it does not list — a scan reading prose as code, which is the same
    // "a source scan cannot assert a policy" trap one layer down.
    //
    // And it proves only that this FILE names no lister. A transitive call
    // through a helper would pass; what actually keeps the guarantee is that
    // keys come from `readFileRecords`, asserted above by the mapping tests.
    const code = stripComments(
      readFileSync(
        join(REPO, "scripts", "jobs", "ledger-backfill-databento.ts"),
        "utf8",
      ),
    );
    assert.doesNotMatch(
      code,
      /listFiles|getFiles\(/,
      "keys come from the manifest, never a listing",
    );
  });
});
