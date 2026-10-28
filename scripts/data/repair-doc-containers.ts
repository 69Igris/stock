/**
 * Re-type `stock_documents` rows whose BYTES are not the container the column
 * claims — MONEY-1319.
 * ==========================================================================
 *
 * ## What was measured, and why this is a re-type rather than a cleanup
 *
 * Prod, 2026-09-02, over all 74,373 `.pdf` keys under `stocks/`:
 *
 *     %PDF at offset 0        74,164
 *     ZIP (PK)                   179   <- annual_report 172, announcement 7
 *     multipart envelope          27
 *     HTML ("Access Denied")       3
 *
 * All 179 ZIPs come from ONE upstream — `nsearchives.nseindia.com`, 100% — and
 * every one holds a REAL document. Verified by opening two of them:
 *
 *     ACCELYA-annual_report-FY2023.pdf  ->  AR_23907_ACCELYA_2022_2023_…pdf   1,752,887 B
 *     AERON-announcement-2026.pdf       ->  RESIGNATION_LETTER_CCP_1.pdf         88,706 B
 *                                           + ROID_…_WebXMLFile_….xml
 *
 * So the expensive mistake available here is to read "the extractor cannot
 * open it" as "this is not a document". That clears the row, and the
 * enrichment pipeline never revisits a cleared row — 172 real annual reports
 * would be gone with no path back. This script therefore only ever CORRECTS
 * `mimeType`; it never clears `gcsPath` and never deletes an object.
 *
 * ## Why the rows are not merely idle — they are burning money
 *
 * 172 of the 179 carry `mimeType: "application/pdf"`, which is not the
 * upstream's claim but OURS: `storeNSEFiling`, `annual-reports-sync` and
 * `nse-announcements-sync` hardcode it at the upload. So the rows PASS
 * `buildExtractQuery`'s filter, get selected every cycle, and fail — 126 of the
 * 179 are already `FAILED`, 46 `PENDING`. The extract lane has been spending
 * Document AI round trips on ZIP bytes. Re-typing them to `application/zip`
 * takes them out of that loop without asserting anything about their content.
 *
 * ## Two other classes this surfaces, deliberately reported and NOT written
 *
 *   - SIX annual reports (ADVANIHOTR, AMRUTANJAN, INDOTHAI, SKYGOLD,
 *     SURYALAXMI, TECHM) are 11–20 MB of NUL: no `%PDF` in the first megabyte,
 *     no `%%EOF` in the last 2 KB, 98% NUL at the tail. Allocated, never
 *     written. They are reported as `refetch` and left untouched — there is no
 *     correct `mimeType` for bytes that do not exist, and rewriting the column
 *     would only hide them.
 *
 *     WHAT A RE-FETCH ACTUALLY NEEDS — measured 2026-09-02, and it is not
 *     "run the sync again". All six are `sourceType: "SCREENER"` with a live
 *     `sourceUrl` on `bseindia.com/bseplus/AnnualReport/<scrip>/…pdf`, which
 *     is inside BSE's served window (CLAUDE.md: 2019-2025 is 0-1% empty), and
 *     `fileSize` records the full 11–20 MB — a byte count for bytes that are
 *     not there. TWO things block the re-fetch, and only the second is obvious:
 *
 *       1. FIVE OF THE SIX ARE `PROCESSING`, not `FAILED`. Only INDOTHAI is
 *          `FAILED`. `buildExtractQuery` selects `PENDING`, or `PENDING` +
 *          `FAILED` under `force` — never `PROCESSING` — so those five rows are
 *          selected by NOTHING and no amount of re-running any job reaches
 *          them. The extract worker flips a row to `PROCESSING` before it reads
 *          the bytes, so a run that died mid-document (an 11-20 MB buffer
 *          through pdf-parse is the obvious candidate) leaks the status
 *          permanently. Same black-hole shape as MONEY-1314.
 *       2. `shouldFetchFromSource` fires only when the GCS object is ABSENT —
 *          it is the recovery path for placeholder `gcsPath` rows and keys on
 *          the download THROWING. Here the object exists and downloads fine;
 *          it is simply empty. So even a row returned to `PENDING` would
 *          re-read the same 20 MB of NUL forever.
 *
 *     So a fix is: move the five out of `PROCESSING`, and either delete the
 *     objects (making `shouldFetchFromSource` true) or add a "the object is
 *     present but carries no document" arm beside it. Neither is this script's
 *     job — it corrects `mimeType`, and there is no `mimeType` that makes an
 *     empty object into a document. Filed as the finding rather than fixed
 *     here, because the `PROCESSING` leak is a lane defect with a population
 *     far wider than these six.
 *   - HTML bodies are reported and left alone. That verdict belongs to
 *     `mayStoreDocumentBody` / the MONEY-1315 quarantine, and two modules
 *     issuing verdicts on the same bytes is the drift this repo keeps paying
 *     for.
 *
 * ## SAFETY — MONEY-1321 M10, and what this file was missing
 *
 * This was the only write script in the doc-ingest set with none of the guards
 * its siblings carry, and each gap was independently reachable:
 *
 *   - **`--apply` had no TTY gate.** Both migrations refuse a write when stdin
 *     is not a terminal, because a hung prompt exits 0 and a wrapper's `&&`
 *     reads that as success. This one wrote from a pipe or a CI runner.
 *   - **`--limit` and `--doc-type` were allowed ALONGSIDE `--apply`.** A
 *     sampled census beside a corpus write is the shape where the only output
 *     an operator can judge the change by describes something else. Both are
 *     now dry-run-only, as in the siblings.
 *   - **THE DATABASE AND THE BUCKET CAME FROM DIFFERENT PLACES.** There was no
 *     `--env`: rows came from the ambient `DATABASE_URL` while the bucket
 *     defaulted to the literal `stockbook-content-prod`. So the ordinary local
 *     invocation read PROD BYTES and wrote its conclusions into QA ROWS,
 *     silently and with a confident-looking census. `--env qa|prod` now
 *     resolves both from one source, and a WRITE requires it — a dry run may
 *     still use an explicit ambient pair, but there is no default bucket at
 *     all.
 *   - **`gcsPath: { not: "" }`** — a Prisma predicate on an attribute that may
 *     be ABSENT matches ZERO rows in BOTH directions on Mongo (MONEY-1050,
 *     1205, 1234, 1235, 1236), and this file's own sibling calls that class out
 *     by name. The selection is now a `$runCommandRaw` keyset walk with
 *     `$ifNull` projections that decides in CODE, so a row whose attribute was
 *     never created is SEEN and counted rather than silently outside the query.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/repair-doc-containers.ts --env prod              # DRY RUN
 *   npx tsx scripts/data/repair-doc-containers.ts --env prod --doc-type annual_report
 *   npx tsx scripts/data/repair-doc-containers.ts --env prod --limit 500
 *   npx tsx scripts/data/repair-doc-containers.ts --env prod --apply      # WRITES
 *
 *   --apply        actually write (default: DRY RUN). Needs --env and a TTY.
 *   --env qa|prod  read DATABASE_URL + the bucket for that environment
 *   --doc-type T   restrict to one docType. Dry-run only.
 *   --limit N      stop after N rows scanned. Dry-run only.
 *   --concurrency  parallel ranged GETs (default 32)
 *
 * Without `--env`, BOTH `DATABASE_URL` and `GCP_STORAGE_BUCKET` must be set
 * explicitly and the run is a dry run. Data questions are answered against
 * PROD; `.env` is QA.
 *
 * Unknown flags are a hard ERROR rather than a shrug — `argv.includes()`
 * silently drops what it does not recognise, and a dry-run-by-default job that
 * swallows `--apply` reads 41,924 rows, writes nothing and exits 0.
 */

import { execFileSync } from "child_process";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  sniffDocumentContainer,
  planContainerRepair,
  type DocumentContainer,
  type ContainerRepairAction,
} from "@usemoney/core/market-data/doc-container";
import { stripMultipartEnvelope } from "@usemoney/storage/multipart-envelope";

// Loaded at module scope, as both sibling migrations do, and BEFORE `--env`
// gets a chance to override — so `--env` always wins and an un-flagged run gets
// the repo's own consistent local pair rather than a half-resolved one. It is
// also where `GOOGLE_APPLICATION_CREDENTIALS` comes from: without it this
// script fell through to gcloud ADC, and a prod dry run on 2026-09-02 answered
// `invalid_grant` on all 5,000 reads it attempted.
dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** `StockDocument.@@map`. */
const COLLECTION = "stock_documents";

/** Rows per raw aggregate page while walking the collection. */
const PAGE_SIZE = 5000;

/**
 * Bytes read per object.
 *
 * Double the archive audit's 1 KB window, for the reason
 * `DOCUMENT_SNIFF_HEAD_BYTES` gives: an object may carry a MONEY-1169
 * multipart envelope whose preamble is 209–239 bytes and is not structurally
 * bounded, and the sniff must get a FULL window on the recovered payload
 * rather than the remainder of one.
 */
const HEAD_BYTES = 2048;

const KNOWN_FLAGS = new Set([
  "--apply",
  "--env",
  "--doc-type",
  "--limit",
  "--concurrency",
]);

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  docType: string | null;
  limit: number;
  concurrency: number;
}

function assertKnownFlags(argv: string[]): void {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}`,
    );
  }
  const eq = argv.filter((a) => /^--[a-z-]+=/.test(a));
  if (eq.length > 0) {
    throw new Error(
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and an ` +
        `unparsed --env would leave APPLY mode pointed at the ambient DATABASE_URL.`,
    );
  }
}

function value(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`${flag} needs a value (got ${raw ?? "nothing"})`);
  }
  return raw;
}

function numericArg(argv: string[], flag: string, fallback: number): number {
  const raw = value(argv, flag);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);

  const env = value(argv, "--env");
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const docType = value(argv, "--doc-type");
  const limit = numericArg(argv, "--limit", 0);
  const apply = argv.includes("--apply");

  // A sampled census beside a corpus-wide write is the shape where the only
  // output an operator can judge the change by describes something else.
  if (apply && limit > 0) {
    throw new Error(
      "--limit cannot be combined with --apply: the census would describe a " +
        "sample while the write covers the corpus. Use --limit for the dry run.",
    );
  }
  if (apply && docType !== null) {
    throw new Error(
      "--doc-type cannot be combined with --apply: the finding spans docTypes " +
        "and a narrowed write leaves the rest mistyped with nothing saying so. " +
        "Use --doc-type for the dry run.",
    );
  }
  // A WRITE must name its environment, so the rows and the bytes come from ONE
  // source. Without this the DB was ambient and the bucket was a literal
  // `stockbook-content-prod`, i.e. prod bytes deciding QA rows.
  if (apply && env === null) {
    throw new Error(
      "--apply requires --env qa|prod: the rows and the bucket must come from " +
        "the same environment. Without it the database is whatever DATABASE_URL " +
        "happens to be while the bucket is something else entirely.",
    );
  }
  // Fail FAST, before reading the corpus. `--apply` on a closed stdin can never
  // succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or CI).",
    );
  }

  return {
    apply,
    env: (env as "qa" | "prod" | null) ?? null,
    docType,
    limit,
    concurrency: numericArg(argv, "--concurrency", 32) || 32,
  };
}

/** Fetch a secret from Secret Manager, mirroring scripts/seed-env.sh. */
function secret(name: string): string {
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${name}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${name} from Secret Manager`);
  return out;
}

/** Host of a Mongo URI, for display. Never prints any credential. */
function maskedHost(uri: string): string | null {
  try {
    return new URL(uri).host || null;
  } catch {
    const authority = uri.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    return (at >= 0 ? authority.slice(at + 1) : authority).trim() || null;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((res) =>
    rl.question(question, (a) => res(a)),
  );
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

interface Row {
  id: string;
  gcsPath: string | null;
  mimeType: string | null;
  docType: string;
  symbol: string;
  processingStatus: string | null;
}

interface Finding extends Row {
  container: DocumentContainer;
  enveloped: boolean;
  action: ContainerRepairAction;
  newMimeType: string;
  /** `"PENDING"` when the re-type should also re-queue the row; `null` = leave it. */
  newProcessingStatus: "PENDING" | null;
  reason: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.env) {
    process.env.DATABASE_URL = secret(
      opts.env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD",
    );
    process.env.GCP_PROJECT_ID ??= GCP_PROJECT;
    process.env.GCP_STORAGE_BUCKET = `stockbook-content-${opts.env}`;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set (pass --env qa|prod).");
  const bucketName = process.env.GCP_STORAGE_BUCKET;
  if (!bucketName) {
    // NO DEFAULT. A literal `stockbook-content-prod` here is how prod bytes
    // came to decide QA rows: the two halves of one question resolved from two
    // different places, and nothing in the output said so.
    throw new Error(
      "GCP_STORAGE_BUCKET is not set and there is no default: the bucket must " +
        "match the database this run reads. Pass --env qa|prod, or set both " +
        "DATABASE_URL and GCP_STORAGE_BUCKET explicitly.",
    );
  }

  // Imported AFTER `--env` resolved DATABASE_URL: `@usemoney/database` builds
  // its PrismaClient at module scope from `process.env.DATABASE_URL`, so a
  // top-level import would pin the client to the ambient value — which is
  // exactly the mismatch above, one layer down.
  const { PrismaClient } = await import("@usemoney/database");
  const { Storage } = await import("@google-cloud/storage");

  const prisma = new PrismaClient();
  const b = new Storage({
    projectId: process.env.GCP_PROJECT_ID ?? GCP_PROJECT,
  }).bucket(bucketName);

  console.log("=".repeat(72));
  console.log(
    `  repair-doc-containers  —  MODE: ${opts.apply ? "APPLY (WRITES)" : "DRY RUN"}`,
  );
  console.log(
    `  database=${maskedHost(dbUrl) ?? "(unparseable)"}  bucket=${bucketName}`,
  );
  console.log(
    `  docType=${opts.docType ?? "(all)"}  limit=${opts.limit || "none"}`,
  );
  console.log("=".repeat(72));

  const findings: Finding[] = [];
  const containerTally = new Map<DocumentContainer, number>();
  let scanned = 0;
  let noGcsPath = 0;
  let missing = 0;
  let readErrors = 0;
  const readErrorExamples: string[] = [];

  try {
    let lastId: string | null = null;

    for (;;) {
      const page = (await prisma.$runCommandRaw({
        aggregate: COLLECTION,
        pipeline: [
          ...(lastId ? [{ $match: { _id: { $gt: { $oid: lastId } } } }] : []),
          ...(opts.docType ? [{ $match: { docType: opts.docType } }] : []),
          { $sort: { _id: 1 } },
          { $limit: PAGE_SIZE },
          {
            $project: {
              // `$ifNull` on every field that can be ABSENT rather than null.
              // A Prisma predicate on an absent attribute matches ZERO in BOTH
              // directions, so nothing here filters on one — the empty-path
              // decision is made in code below and the row is COUNTED either
              // way.
              symbol: { $ifNull: ["$symbol", ""] },
              docType: { $ifNull: ["$docType", "(absent)"] },
              gcsPath: { $ifNull: ["$gcsPath", null] },
              mimeType: { $ifNull: ["$mimeType", null] },
              processingStatus: { $ifNull: ["$processingStatus", null] },
            },
          },
        ],
        cursor: { batchSize: PAGE_SIZE },
      })) as {
        cursor: {
          firstBatch: Array<
            Omit<Row, "id"> & { _id: { $oid: string } | string }
          >;
        };
      };

      const batch = page.cursor.firstBatch;
      // An EMPTY batch is the ONLY end-of-collection signal. A SHORT one means
      // `cursor.firstBatch` hit its 16 MB wire cap, which applies regardless of
      // the requested `batchSize` — breaking on it ends the walk with the table
      // part-read while every total printed afterwards reads as a complete
      // census (MONEY-1189).
      if (batch.length === 0) break;

      const rows: Row[] = batch.map((r) => ({
        id: typeof r._id === "string" ? r._id : r._id.$oid,
        symbol: r.symbol,
        docType: r.docType,
        gcsPath: r.gcsPath,
        mimeType: r.mimeType,
        processingStatus: r.processingStatus,
      }));
      lastId = rows[rows.length - 1]!.id;
      scanned += rows.length;

      // Decided in CODE, never in the query: a row with no `gcsPath` attribute
      // at all arrives as null here and is COUNTED.
      const withBytes = rows.filter((r) => {
        if (!r.gcsPath || r.gcsPath.length === 0) {
          noGcsPath++;
          return false;
        }
        return true;
      });

      let cursor = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(opts.concurrency, withBytes.length) },
          async () => {
            while (cursor < withBytes.length) {
              const row = withBytes[cursor++]!;
              try {
                const [raw] = await b
                  .file(row.gcsPath!)
                  .download({ start: 0, end: HEAD_BYTES - 1 });
                let head = Buffer.from(raw);
                const stripped = stripMultipartEnvelope(head);
                const enveloped = stripped !== null;
                if (stripped) head = Buffer.from(stripped.payload);

                const container = sniffDocumentContainer(head);
                containerTally.set(
                  container,
                  (containerTally.get(container) ?? 0) + 1,
                );

                const plan = planContainerRepair({
                  storedMimeType: row.mimeType,
                  container,
                  // MONEY-1319 — the row's CURRENT status is an input, because
                  // a re-type alone does not recover the document. 126 of the
                  // 179 ZIPs are already `FAILED`, and `FAILED` is only
                  // re-selected under `force: true`; correcting the column and
                  // leaving them there takes them out of the wasteful loop and
                  // out of the useful one at once.
                  storedProcessingStatus: row.processingStatus,
                });
                if (plan.action !== "none") {
                  findings.push({
                    ...row,
                    container,
                    enveloped,
                    action: plan.action,
                    newMimeType: plan.mimeType,
                    newProcessingStatus: plan.processingStatus,
                    reason: plan.reason,
                  });
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // A read failure is NOT a clean row. Counting it as ok would
                // let a permissions or transport problem masquerade as a
                // healthy table.
                if (/No such object|404/i.test(msg)) missing++;
                else {
                  readErrors++;
                  if (readErrorExamples.length < 5) {
                    readErrorExamples.push(`${row.gcsPath}: ${msg}`);
                  }
                }
              }
            }
          },
        ),
      );

      console.log(
        `  scanned ${scanned}  withBytes ${scanned - noGcsPath}  ` +
          `findings ${findings.length}  missing ${missing}  readError ${readErrors}`,
      );

      if (opts.limit > 0 && scanned >= opts.limit) break;
    }

    console.log(
      "\n=== container census (by BYTES, not by the mimeType column) ===",
    );
    for (const [k, v] of [...containerTally].sort((a, c) => c[1] - a[1])) {
      console.log(`  ${k.padEnd(10)} ${v}`);
    }
    console.log(`  ${"noGcsPath".padEnd(10)} ${noGcsPath}`);
    console.log(`  ${"missing".padEnd(10)} ${missing}`);
    console.log(`  ${"readError".padEnd(10)} ${readErrors}`);
    for (const e of readErrorExamples) console.log(`    ! ${e}`);

    const retype = findings.filter((f) => f.action === "retype");
    const refetch = findings.filter((f) => f.action === "refetch");
    // MONEY-1319 — the column is already right and the ROW is stranded. 13 prod
    // rows are honestly `application/zip` and terminally `UNSUPPORTED`, because
    // that was the correct verdict while nothing could open an archive. Unzip
    // support does not move them on its own; no query selects a terminal row.
    const stranded = findings.filter((f) => f.action === "requeue");

    console.log(
      "\n=== findings by action | container | docType | stored -> corrected ===",
    );
    const grouped = new Map<string, number>();
    for (const f of findings) {
      const k = `${f.action} | ${f.container} | ${f.docType} | ${f.mimeType} -> ${f.newMimeType}`;
      grouped.set(k, (grouped.get(k) ?? 0) + 1);
    }
    for (const [k, v] of [...grouped].sort((a, c) => c[1] - a[1])) {
      console.log(`  ${String(v).padStart(5)}  ${k}`);
    }

    if (refetch.length > 0) {
      console.log(
        `\n=== ${refetch.length} rows need a RE-FETCH (left untouched by this script) ===`,
      );
      for (const f of refetch.slice(0, 40)) {
        console.log(
          `  ${f.symbol.padEnd(14)} ${String(f.processingStatus).padEnd(12)} ${f.gcsPath}  — ${f.reason}`,
        );
      }
      // A row stuck in PROCESSING is selected by NO query — not by the nightly
      // extract, not by a `force` run — so "re-fetch" is not something any
      // existing job can be asked to do for it. Named at the point an operator
      // reads the list, not only in the header.
      const stuck = refetch.filter((f) => f.processingStatus === "PROCESSING");
      if (stuck.length > 0) {
        console.log(
          `\n  NOTE: ${stuck.length} of those are stuck in PROCESSING, which\n` +
            `  buildExtractQuery never selects (PENDING, or PENDING+FAILED under\n` +
            `  --force). They are unreachable by every job until the status is\n` +
            `  moved, and the object is PRESENT-but-empty, so shouldFetchFromSource\n` +
            `  (which keys on the download THROWING) would not fire either.`,
        );
      }
    }

    const requeue = retype.filter((f) => f.newProcessingStatus !== null);

    if (stranded.length > 0) {
      console.log(
        `\n=== ${stranded.length} rows are correctly typed but STRANDED in a terminal status ===`,
      );
      for (const f of stranded.slice(0, 25)) {
        console.log(
          `  ${f.symbol.padEnd(14)} ${String(f.processingStatus)} -> PENDING  ${f.mimeType}  ${f.gcsPath}`,
        );
      }
    }

    if (retype.length > 0) {
      console.log(
        `\n=== ${retype.length} rows would be RE-TYPED (first 25) ===`,
      );
      for (const f of retype.slice(0, 25)) {
        const status =
          f.newProcessingStatus === null
            ? String(f.processingStatus)
            : `${f.processingStatus} -> ${f.newProcessingStatus}`;
        console.log(
          `  ${f.symbol.padEnd(14)} ${status.padEnd(24)} ${f.mimeType} -> ${f.newMimeType}  ${f.gcsPath}`,
        );
      }
      console.log(
        `\n  ${requeue.length} of those would ALSO be re-queued to PENDING — the ` +
          `corrected type is one the extract lane can read, and leaving a FAILED ` +
          `row FAILED means it never produces text.`,
      );
    }

    if (readErrors > 0) {
      // Not a finding about the rows — a fault of the RUN. Reported as one, and
      // the process exits non-zero so a wrapper cannot read it as a clean pass.
      console.log(
        `\n${readErrors} object read(s) FAILED (auth / bucket / transport). The ` +
          `census above is INCOMPLETE by that many rows.`,
      );
      process.exitCode = 1;
    }

    if (!opts.apply) {
      console.log(
        `\nDRY RUN — nothing written. ${retype.length} row(s) would change mimeType, ` +
          `${stranded.length} would be re-queued without a type change; ` +
          `${refetch.length} need a re-fetch. Re-run with --apply to write.`,
      );
      return;
    }

    const ok = await confirm(
      `\nRe-type ${retype.length} row(s) and re-queue ${requeue.length + stranded.length} ` +
        `on ${maskedHost(dbUrl)} (bucket ${bucketName})? Type "yes": `,
    );
    if (!ok) {
      console.log("Aborted; nothing written.");
      return;
    }

    console.log(
      `\nAPPLYING — updating mimeType on ${retype.length} row(s), of which ` +
        `${requeue.length} also return to PENDING; plus ${stranded.length} ` +
        `re-queued with no type change…`,
    );
    let updated = 0;
    for (const f of [...retype, ...stranded]) {
      await prisma.stockDocument.update({
        where: { id: f.id },
        data: {
          mimeType: f.newMimeType,
          // Only when the plan asked for it. `null` leaves the column alone —
          // `READY` already has its text and `PROCESSING` belongs to a run still
          // in flight, and this script must not disturb either.
          ...(f.newProcessingStatus === null
            ? {}
            : { processingStatus: f.newProcessingStatus }),
        },
      });
      updated++;
      if (updated % 50 === 0) {
        console.log(`  updated ${updated}/${retype.length + stranded.length}`);
      }
    }
    console.log(
      `\nDONE — ${retype.length} row(s) re-typed, ` +
        `${requeue.length + stranded.length} returned to PENDING. ` +
        `${refetch.length} still need a re-fetch.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(
    "repair-doc-containers FAILED:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
