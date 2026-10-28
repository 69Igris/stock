/**
 * Lift the gate's reasons out of `lines.validation` into their own columns —
 * MONEY-1340.
 *
 * ## Why this is a backfill rather than a re-parse
 *
 * The reasons were never lost. Every `document_financial_extracts` row has
 * carried them since the lane shipped, inside the `lines.validation` JSON, and
 * `buildExtractWritePayload` now also writes them to `validationReasons` /
 * `validationWarnings`. This copies what is already stored; it calls no model
 * and re-reads no document, so it costs nothing but the writes.
 *
 * What it buys is the question being ASKABLE. Answering "what is the dominant
 * failure on this lane" previously meant an aggregation over a nested
 * document, so nobody asked — and when somebody finally did, the answer was
 * that ONE rule accounts for almost all of it: 1,821 of 1,885 rejected rows
 * carry UNKNOWN_SCALE (96.6%), 1,804 of them as the sole reason, measured on
 * prod 2026-09-05. That single number redirected the whole branch.
 *
 * ## DRY RUN BY DEFAULT. `--apply` opts in.
 *
 * Same contract as `repair-stock-document-queue.ts` and
 * `doc-financials-reconcile.ts`, and the OPPOSITE of `xbrl-backfill.ts` (which
 * applies by default and takes `--dry-run`). If this is ever registered in
 * `scripts/ops/run-market-data-job.sh` the row MUST declare
 * `APPLY_FLAG="--apply"`: that wrapper CONSUMES `--apply` and re-emits only the
 * declared flag, so a missing declaration makes the flag reach the job as
 * NEITHER flag — which is how `xbrl-reparse` read 41,924 rows, reported 24,165
 * as changed, wrote nothing, and exited 0.
 *
 * ## The absent-vs-null direction that is safe here
 *
 * `validationReasons` ships `@default([])`, and a Mongo `db push` creates
 * indexes rather than fields, so pre-existing rows carry NO attribute at all.
 * The selection is therefore `$exists: false` on the raw command — never
 * `{ validationReasons: null }`, which matches nothing in either direction on
 * a field that was never created (MONEY-1050 / 1205 / 1234 / 1236).
 *
 * ## Why every command here is RAW, and why there is no paging loop
 *
 * This used to walk the collection with `prisma.findMany` and update row by
 * row. The walk had NO `where` at all — the header above described a
 * `$exists: false` selection that only the COUNT ever used — so `--apply`
 * rewrote every row in the collection, including the ones already backfilled,
 * and reported that total against a `total` that had counted only the rows
 * missing the attribute. The two numbers could never be compared.
 *
 * The selection cannot be expressed in Prisma: `validationReasons` is a
 * non-optional `String[]`, so there is no `isSet` filter for it, and
 * `{ equals: [] }` cannot tell an ABSENT attribute from a backfilled-and-empty
 * one — the exact distinction the columns exist to make. So the write is one
 * `update` command carrying an aggregation pipeline, which does the copy
 * server-side for precisely the rows that need it, and the census is one
 * `aggregate`. No paging, no per-row round trip, and the code now does what
 * the header says.
 *
 * Usage:
 *   node --import tsx scripts/data/backfill-extract-validation-columns.ts
 *   node --import tsx scripts/data/backfill-extract-validation-columns.ts --apply
 */

import { prisma, Prisma } from "@usemoney/database";

const APPLY = process.argv.includes("--apply");
const COLLECTION = "document_financial_extracts";

/** Rows that never received the attribute — the ONLY rows this touches. */
const MISSING = { validationReasons: { $exists: false } };

/**
 * Read one stored array out of `lines.validation`, server-side.
 *
 * The column is `String[]`, so a non-string member would be rejected by the
 * driver and take the whole write with it. `$filter` on `$type` keeps the
 * malformed member out instead, and a non-array (or absent) `lines.validation`
 * yields `[]` rather than failing the pipeline — which is what makes
 * "backfilled and had none" a real, distinguishable state.
 */
// Typed as Prisma's own JSON input rather than `Record<string, unknown>`:
// `$runCommandRaw` takes `InputJsonValue`, and a loose record is not
// assignable to it once it is nested inside the command literal.
function storedArray(field: "reasons" | "warnings"): Prisma.InputJsonObject {
  return {
    $let: {
      vars: { v: `$lines.validation.${field}` },
      in: {
        $cond: [
          { $isArray: "$$v" },
          {
            $filter: {
              input: "$$v",
              as: "x",
              cond: { $eq: [{ $type: "$$x" }, "string"] },
            },
          },
          [],
        ],
      },
    },
  };
}

/** The reason census over the rows still missing the attribute. */
async function census(): Promise<Array<[string, number]>> {
  const res = (await prisma.$runCommandRaw({
    aggregate: COLLECTION,
    pipeline: [
      { $match: MISSING },
      { $project: { r: storedArray("reasons") } },
      { $unwind: "$r" },
      { $group: { _id: "$r", n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
    ],
    cursor: {},
    allowDiskUse: true,
  })) as {
    cursor?: {
      firstBatch?: Array<{ _id?: unknown; n?: unknown }>;
      id?: unknown;
    };
  };

  // A `firstBatch` that did not exhaust the cursor is a TRUNCATED census that
  // looks exactly like a short one — the MONEY-1189 defect. There is no reason
  // vocabulary large enough to fill a batch, so this is a tripwire rather than
  // a paging loop: if it ever fires, the census below is incomplete and must
  // not be read as the distribution.
  const cursorId = res.cursor?.id;
  const exhausted =
    cursorId === undefined ||
    cursorId === null ||
    Number(cursorId as number) === 0;
  if (!exhausted) {
    console.warn(
      "[backfill-extract-validation] WARNING: the census cursor was not " +
        "exhausted in one batch, so the distribution below is TRUNCATED.",
    );
  }

  return (res.cursor?.firstBatch ?? []).map((r) => [
    typeof r._id === "string" ? r._id : String(r._id),
    typeof r.n === "number" ? r.n : 0,
  ]);
}

async function main(): Promise<void> {
  const counted = (await prisma.$runCommandRaw({
    count: COLLECTION,
    query: MISSING,
  })) as { n?: number };
  const total = counted.n ?? 0;

  console.log(
    `[backfill-extract-validation] ${total} row(s) carry no validationReasons ` +
      `attribute. ${APPLY ? "WRITING" : "DRY RUN — pass --apply to write"}.`,
  );

  // The census is read BEFORE the write, because the write is what removes
  // these rows from the selection. Running it afterwards would report zero and
  // look like a collection with no rejections in it.
  const distribution = total > 0 ? await census() : [];

  let modified = 0;
  if (APPLY && total > 0) {
    const res = (await prisma.$runCommandRaw({
      update: COLLECTION,
      updates: [
        {
          q: MISSING,
          u: [
            {
              $set: {
                validationReasons: storedArray("reasons"),
                validationWarnings: storedArray("warnings"),
              },
            },
          ],
          multi: true,
        },
      ],
    })) as { n?: number; nModified?: number };
    modified = res.nModified ?? res.n ?? 0;
  }

  console.log(
    `[backfill-extract-validation] missingBefore=${total} modified=${modified}`,
  );
  if (APPLY && modified !== total) {
    // Both numbers count the SAME selection, one before and one after, so they
    // are comparable — which is the property the old row-walk did not have.
    console.warn(
      `[backfill-extract-validation] WARNING: ${total - modified} row(s) ` +
        "matched the count but were not modified.",
    );
  }
  for (const [reason, n] of distribution) console.log(`  ${reason}: ${n}`);
  if (!APPLY) {
    console.log(
      "DRY RUN: nothing was written. The census above is what --apply would " +
        "make queryable.",
    );
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfill-extract-validation] FAILED", err);
  await prisma.$disconnect();
  process.exit(1);
});
