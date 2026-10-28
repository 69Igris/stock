/**
 * THE ABSENT-FIELD TEST, written before the selectors it guards — MONEY-1314.
 *
 * A Mongo `prisma db push` creates INDEXES, never FIELDS. Every one of the
 * ~79,884 `stock_documents` rows that existed before this branch carries NO
 * `convertStatus`, `parsePath` or `batchJobId` attribute at all, and Prisma's
 * Mongo connector does not treat absent as null: `{ convertStatus: "PENDING" }`
 * matches ZERO of them, `@default` notwithstanding — a default applies only to
 * rows Prisma itself creates.
 *
 * The failure has no symptom. "Nothing to convert" and "the entire 79,884-row
 * corpus is unreachable" produce the identical log line, an empty selection and
 * a successful exit. That is why this file is written FIRST and why its
 * assertions are about the SHAPE of the query rather than about any result:
 * the query is the thing that is wrong, and it is wrong before it touches data.
 *
 * This class has now caused MONEY-1050, MONEY-1205, MONEY-1234 and MONEY-1236.
 * A fifth would be the same shape one field over.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// MONEY-1346 — imported under an alias so the two lanes can be compared by
// IDENTITY rather than by two copies of the same literal.
import { STALE_PROCESSING_MS as EXTRACT_LANE_STALE_PROCESSING_MS } from "../../src/processors/stock-document-extract-logic";

import {
  PENDING_OR_ABSENT_CONVERT_STATUS,
  BATCHED_OR_ABSENT_PARSE_STATUS,
  buildConvertQuery,
  buildBatchIngestQuery,
  buildSweepQuery,
  CONVERT_STATUS,
  BATCH_PARSE_STATUS,
  SWEEPABLE_PARSE_STATUS,
  buildShardWhere,
  SHARD_ALPHABET,
  STALE_BATCHED_MS,
  STALE_PROCESSING_MS,
} from "../../src/processors/doc-ingest-selectors-logic";

/** A row as it exists on prod TODAY: no key for any field this branch adds. */
const LEGACY_ROW = {
  id: "legacy",
  symbol: "TCS",
  gcsPath: "stocks/TCS/annual_report/2024.pdf",
  mimeType: "application/pdf",
  docType: "annual_report",
} as const;

/** Does an `OR` arm list actually admit a row with the key ABSENT? */
function admitsAbsent(
  arms: readonly Record<string, unknown>[],
  field: string,
): boolean {
  return arms.some((arm) => {
    const v = arm[field] as { isSet?: boolean } | string | undefined;
    return typeof v === "object" && v !== null && v.isSet === false;
  });
}

describe("MONEY-1314 — every new-field selector carries the isSet:false arm", () => {
  it("convertStatus: the PENDING-or-absent arm admits a row with NO such key", () => {
    // The whole backfill hangs off this. Without the arm, `scan-convert`
    // selects nothing and reports success.
    assert.ok(
      admitsAbsent(PENDING_OR_ABSENT_CONVERT_STATUS, "convertStatus"),
      "PENDING_OR_ABSENT_CONVERT_STATUS has no { isSet: false } arm — the " +
        `${Object.keys(LEGACY_ROW).length}-key legacy row shape (which has no ` +
        "convertStatus at all) would be unreachable, silently",
    );
    assert.ok(
      PENDING_OR_ABSENT_CONVERT_STATUS.some(
        (a) => a.convertStatus === CONVERT_STATUS.PENDING,
      ),
      "the arm list must also admit rows Prisma itself created with the default",
    );
  });

  it("parseStatus BATCHED: the arm list admits absent, for the sweep", () => {
    // `batch-ingest` and `sweep` select rows this branch stamped, so absence
    // is less likely — but a row stamped by an older revision, or a partial
    // write, is exactly the case a sweep exists to catch.
    assert.ok(
      admitsAbsent(BATCHED_OR_ABSENT_PARSE_STATUS, "parseStatus"),
      "BATCHED_OR_ABSENT_PARSE_STATUS has no { isSet: false } arm",
    );
  });

  it("buildConvertQuery puts the arms in an OR, not a bare equality", () => {
    const q = buildConvertQuery({}) as { OR?: unknown[] };
    assert.ok(Array.isArray(q.OR), "buildConvertQuery must select via OR");
    assert.ok(
      admitsAbsent(q.OR as Record<string, unknown>[], "convertStatus"),
      "buildConvertQuery lost the isSet arm on its way into the query",
    );
  });

  it("the scan cursor is `scannedPageCount: { isSet: false }`, not a null test", () => {
    // The stamp IS the checkpoint — there is no checkpoint table. A `null`
    // test matches nothing in either direction on an absent field, so a scan
    // written that way re-reads the whole corpus forever OR reads none of it.
    const q = buildConvertQuery({ unscannedOnly: true }) as Record<
      string,
      unknown
    >;
    const cursor = q.scannedPageCount as { isSet?: boolean } | null | undefined;
    assert.ok(
      typeof cursor === "object" && cursor !== null && cursor.isSet === false,
      `the unscanned cursor must be { isSet: false }, got ${JSON.stringify(cursor)}`,
    );
  });

  it("buildBatchIngestQuery carries the arm — SCOPED by batchJobId", () => {
    const q = buildBatchIngestQuery("jobs/x") as {
      OR?: Record<string, unknown>[];
      batchJobId?: string;
    };
    assert.ok(Array.isArray(q.OR));
    assert.ok(admitsAbsent(q.OR, "parseStatus"));
    // The scope is what makes the wide arm safe here: it only ever matches
    // rows this batch is carrying.
    assert.equal(q.batchJobId, "jobs/x");
  });

  it("buildSweepQuery deliberately carries NO isSet arm", () => {
    // CORRECTED by the MONEY-1314 review. This case used to assert that the
    // sweep DID carry one — encoding the defect as a requirement, which is the
    // same shape as MONEY-1255, where the old suite asserted a non-rotating
    // batch as intended behaviour.
    //
    // `parseStatus` is genuinely ABSENT on ~43,105 pre-existing rows, and
    // after scan-convert every one of them is CONVERTED with a sidecar and
    // still has no parseStatus. An unscoped arm therefore matched the WHOLE
    // CORPUS and ran the ONLINE per-document path — the most expensive lane,
    // no batch discount — over rows that were never the residue this
    // subcommand exists for.
    //
    // MONEY-1341 gave the sweep an OR — for the STALE in-flight claims, which
    // are scoped by an age. The property this case protects is unchanged and
    // is now asserted directly: no arm may select on `parseStatus` being
    // ABSENT. Asserting `OR === undefined` would have made the shape the
    // requirement rather than the reason.
    const q = buildSweepQuery({ now: new Date() }) as Record<string, unknown>;
    const arms = q.OR as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(arms), "the sweep lost its status arms entirely");
    for (const arm of arms) {
      assert.notDeepEqual(
        arm.parseStatus,
        { isSet: false },
        "the sweep matches rows with NO parseStatus again — after " +
          "scan-convert that is the whole corpus, on the most expensive lane " +
          "there is",
      );
    }
    assert.ok(
      arms.some(
        (a) =>
          JSON.stringify(a.parseStatus) ===
          JSON.stringify({ in: [...SWEEPABLE_PARSE_STATUS] }),
      ),
      "the terminal-residue arm is gone",
    );
  });

  it("re-opens a STALE batch claim, and leaves a live one alone (MONEY-1341)", () => {
    // 22 rows sit BATCHED on prod from two compare-mode pilot batches —
    // compare grades a batch and deliberately writes nothing, so it never
    // releases the status it was handed. No query selected them.
    const now = new Date("2026-09-05T12:00:00Z");
    const arms = (buildSweepQuery({ now }).OR ?? []) as Array<
      Record<string, unknown>
    >;
    const batched = arms.find(
      (a) => a.parseStatus === BATCH_PARSE_STATUS.BATCHED,
    );
    assert.ok(batched, "no stale-BATCHED arm — the 22 rows stay unreachable");
    const cutoff = (batched.updatedAt as { lt: Date }).lt;
    assert.equal(
      now.getTime() - cutoff.getTime(),
      STALE_BATCHED_MS,
      "the batch staleness cutoff is not the declared constant",
    );
    // A batch legitimately runs for hours — there is no SLA — so a claim made
    // an hour ago must NOT be stolen.
    assert.ok(new Date(now.getTime() - 60 * 60 * 1000) > cutoff);
    assert.ok(new Date(now.getTime() - 72 * 60 * 60 * 1000) < cutoff);
  });

  it("re-opens a STALE PROCESSING claim on a much shorter fuse", () => {
    // A PROCESSING document is ONE online call inside a 600s ack deadline, so
    // six hours is already far past its worst case — unlike a batch.
    const now = new Date("2026-09-05T12:00:00Z");
    const arms = (buildSweepQuery({ now }).OR ?? []) as Array<
      Record<string, unknown>
    >;
    const processing = arms.find((a) => a.parseStatus === "PROCESSING");
    assert.ok(processing, "no stale-PROCESSING arm (MONEY-1329)");
    const cutoff = (processing.updatedAt as { lt: Date }).lt;
    assert.equal(now.getTime() - cutoff.getTime(), STALE_PROCESSING_MS);
    assert.ok(
      STALE_PROCESSING_MS < STALE_BATCHED_MS,
      "a PROCESSING claim must go stale sooner than a BATCHED one — it is a " +
        "single call, not a job with no SLA",
    );
  });

  it("scopes both in-flight arms by AGE, never by status alone", () => {
    // Without the age term the sweep would re-run every document a batch is
    // CURRENTLY carrying: the same rows paid for twice, and the batch's own
    // ingest would then overwrite the sweep's answer.
    const arms = (buildSweepQuery({ now: new Date() }).OR ?? []) as Array<
      Record<string, unknown>
    >;
    for (const arm of arms) {
      const st = arm.parseStatus;
      if (st === BATCH_PARSE_STATUS.BATCHED || st === "PROCESSING") {
        assert.ok(
          arm.updatedAt,
          `the ${String(st)} arm has no age bound — it would re-run in-flight work`,
        );
      }
    }
  });

  it("the sweep can recover a FAILED document — the route never redelivers", () => {
    // `FAILED` is transient by construction (CALL_FAILED / UNCONFIGURED), and
    // the ingest route ACKs 200 on every path including a throw. Pub/Sub will
    // never redeliver, so the sweep is the ONLY way back: without it one
    // Gemini blip drops a document permanently, with a terminal-looking status
    // and no alert.
    assert.ok(SWEEPABLE_PARSE_STATUS.includes("FAILED"));
    assert.ok(SWEEPABLE_PARSE_STATUS.includes("FAILED_VALIDATION"));
    assert.ok(SWEEPABLE_PARSE_STATUS.includes(BATCH_PARSE_STATUS.FAILED_BATCH));
  });

  it("[control] the sweep does NOT re-open a successful read", () => {
    // Without this, "sweep everything" would satisfy every assertion above and
    // re-pay for the whole corpus.
    assert.ok(!SWEEPABLE_PARSE_STATUS.includes("EXTRACTED"));
    assert.ok(!SWEEPABLE_PARSE_STATUS.includes("UNREADABLE"));
    assert.ok(!SWEEPABLE_PARSE_STATUS.includes(BATCH_PARSE_STATUS.BATCHED));
  });

  it("[premise] the legacy row genuinely lacks every new key", () => {
    // If this ever fails, the fixture drifted and every assertion above became
    // a test of a row shape that does not exist on prod.
    for (const f of [
      "convertStatus",
      "parsePath",
      "batchJobId",
      "markdownGcsPath",
      "scannedPageCount",
      "textPageCount",
      "convertedAt",
    ]) {
      assert.ok(
        !(f in LEGACY_ROW),
        `the legacy fixture has a ${f} key — it no longer represents prod`,
      );
    }
  });

  it("[control] a selector WITHOUT the arm is detected as unsafe", () => {
    // Proves `admitsAbsent` can return false. Without this, a broken helper
    // would report every selector safe while checking nothing — which is the
    // vacuity that lets this bug class through in the first place.
    assert.equal(
      admitsAbsent([{ convertStatus: "PENDING" }], "convertStatus"),
      false,
    );
    assert.equal(
      admitsAbsent([{ convertStatus: { isSet: false } }], "convertStatus"),
      true,
    );
  });

  it("the status vocabularies are the ones the schema comment documents", () => {
    assert.deepEqual(Object.values(CONVERT_STATUS).sort(), [
      "CONVERTED",
      "FAILED",
      "PENDING",
      "SCANNED_ONLY",
    ]);
    assert.deepEqual(Object.values(BATCH_PARSE_STATUS).sort(), [
      "BATCHED",
      "FAILED_BATCH",
    ]);
  });
});

describe("MONEY-1373 — the batch lane must not re-select what it refused", () => {
  const SRC = new URL(
    "../../../scripts/jobs/doc-ingest-backfill.ts",
    import.meta.url,
  );
  const read = async () => (await import("node:fs")).readFileSync(SRC, "utf8");

  it("batch-build EXCLUDES FAILED_BATCH from its own selector", async () => {
    // THE DEFECT, measured over ten waves on prod 2026-09-06: the two refusal
    // branches (`sidecarPageIncomplete`, `failOverToVision`) left the row
    // untouched. Selection is `fetchedAt asc`, so an unchanged row stays at the
    // HEAD of the queue and is re-selected by every wave — the same ~2,000
    // documents re-read at 0.89 GB per wave, usable lines falling 607 -> 133,
    // `remaining` moving 1,599 in total while ~25,000 behind them were never
    // reached.
    //
    // A value assertion cannot see this: the query is built inside a 3,000-line
    // function against a live Prisma client. The SOURCE is the observable.
    const src = (await import("node:fs")).readFileSync(SRC, "utf8");
    const notIn = src.match(
      /parseStatus:\s*\{\s*notIn:\s*\[([\s\S]*?)\],\s*\}/,
    );
    assert.ok(notIn, "batch-build's parseStatus notIn list not found");
    assert.match(
      notIn[1]!,
      /BATCH_PARSE_STATUS\.FAILED_BATCH/,
      "a refused document must leave the batch selector, or the queue head never moves",
    );
  });

  it("both refusal branches STAMP before they continue", async () => {
    // Mutation target: delete either `stampRefusedByBatchLane` call and the
    // rotation defect returns for that branch alone — which is how it hid, since
    // the OTHER branch kept working and every wave still reported success.
    const src = await read();
    for (const marker of ["sidecarPageIncomplete", "failedOverToVision"]) {
      const at = src.indexOf(`bump(tally, "${marker}")`);
      assert.ok(at > 0, `${marker} branch not found`);
      const branch = src.slice(at, src.indexOf("continue;", at));
      assert.match(
        branch,
        /stampRefusedByBatchLane\(/,
        `${marker} refuses the document but does not stamp it`,
      );
    }
  });

  it("the stamp is skipped on a dry run", async () => {
    const src = await read();
    const fn = src.slice(src.indexOf("async function stampRefusedByBatchLane"));
    assert.match(
      fn.slice(0, 400),
      /if \(!apply\) return;/,
      "a dry run must not stamp — its whole contract is that nothing happens",
    );
  });

  it("the sweep sends a refused document to VISION, not back to markdown", async () => {
    // Without this the fix is a slower loop rather than a fix: the sweep admits
    // FAILED_BATCH, `decideIngestLane` sees CONVERTED + a sidecar, and hands it
    // the same markdown the batch lane just refused.
    const src = await read();
    assert.match(
      src,
      /untrustedMarkdown:\s*\n?\s*doc\.parseStatus === BATCH_PARSE_STATUS\.FAILED_BATCH/,
      "the sweep must mark a batch-refused document's markdown untrusted",
    );
  });
});

describe("MONEY-1346 — one PROCESSING staleness, not one per lane", () => {
  it("the ingest selectors DECLARE no STALE_PROCESSING_MS of their own", async () => {
    // A value assertion cannot see this defect: the constant was declared
    // TWICE, in this module and in `stock-document-extract-logic.ts`, with the
    // same name and the same 6h value. Every equality check passed while a
    // change to either one moved only half the codebase — the drift class this
    // module argues against three times over (`decideTextSource`,
    // `SCANNED_SHARE_VISION_THRESHOLD`). So the assertion is on the SOURCE.
    const src = (await import("node:fs")).readFileSync(
      new URL(
        "../../src/processors/doc-ingest-selectors-logic.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(
      !/^export const STALE_PROCESSING_MS\s*=/m.test(src),
      "STALE_PROCESSING_MS must be imported, not re-declared",
    );
    assert.match(
      src,
      /import \{ STALE_PROCESSING_MS \} from "\.\/stock-document-extract-logic"/,
    );
  });

  it("both lanes see the same object", () => {
    // The other half. A source scan alone would pass if the import were
    // removed and the query inlined its own number.
    assert.equal(STALE_PROCESSING_MS, EXTRACT_LANE_STALE_PROCESSING_MS);
  });

  it("STALE_BATCHED_MS stays local, and larger", () => {
    // Not everything collapses. A BATCHED claim is a Vertex batch job with no
    // SLA where 24h is normal; a PROCESSING claim is one online call inside a
    // 600s ack deadline. Different mechanisms, different numbers.
    assert.ok(STALE_BATCHED_MS > STALE_PROCESSING_MS);
  });
});

describe("MONEY-1339 — the conversion shard is a PARTITION, not a filter", () => {
  const prefixesOf = (w: Record<string, unknown>): string[] =>
    (w.OR as Array<{ symbol: { startsWith: string } }>).map(
      (a) => a.symbol.startsWith,
    );

  it("covers the whole alphabet exactly once across four shards", () => {
    // A shard that DROPS a letter loses those documents silently: every task
    // reports a drained queue and the symbols starting with it are never
    // converted. A shard that DUPLICATES one pays twice and races two writers
    // onto the same row.
    const seen = [0, 1, 2, 3].flatMap((i) => prefixesOf(buildShardWhere(i, 4)));
    assert.deepEqual(
      [...seen].sort().join(""),
      [...SHARD_ALPHABET].sort().join(""),
      "the four shards are not a partition of the shard alphabet",
    );
    assert.equal(new Set(seen).size, seen.length, "a prefix appears twice");
  });

  it("is a partition for every task count from 1 to the alphabet length", () => {
    for (let n = 1; n <= SHARD_ALPHABET.length; n++) {
      const seen = Array.from({ length: n }, (_, i) =>
        prefixesOf(buildShardWhere(i, n)),
      ).flat();
      assert.equal(
        [...seen].sort().join(""),
        [...SHARD_ALPHABET].sort().join(""),
        `n=${n} is not a partition`,
      );
    }
  });

  it("gives every shard work — none may be empty", () => {
    // An empty shard selects nothing and reports `selected=0 remaining=0`,
    // which is exactly what a drained queue looks like.
    for (let i = 0; i < 4; i++) {
      assert.ok(
        prefixesOf(buildShardWhere(i, 4)).length > 0,
        `shard ${i}/4 is empty`,
      );
    }
  });

  it("deals the alphabet round-robin rather than in contiguous blocks", () => {
    // Contiguous blocks would hand one task every symbol beginning with a
    // common letter. Round-robin mixes the heavy letters across tasks.
    const first = prefixesOf(buildShardWhere(0, 4));
    assert.deepEqual(first.slice(0, 3), ["0", "4", "8"]);
  });

  it("REFUSES more tasks than letters instead of returning an empty selection", () => {
    assert.throws(
      () => buildShardWhere(36, 37),
      /shard alphabet/,
      "a task past the alphabet was allowed — it would select nothing and " +
        "report a drained queue",
    );
  });

  it("refuses an out-of-range or non-integer shard", () => {
    assert.throws(() => buildShardWhere(4, 4), /outside/);
    assert.throws(() => buildShardWhere(-1, 4), /outside/);
    assert.throws(() => buildShardWhere(0, 0), />= 1/);
    assert.throws(() => buildShardWhere(1.5, 4), /integers/);
  });
});
