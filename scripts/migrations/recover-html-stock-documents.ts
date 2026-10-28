/**
 * Recover the documents behind the 1,310 salvageable HTML-bodied
 * `stock_documents` rows — MONEY-1321.
 * ==========================================================================
 *
 * ## What this is for
 *
 * MONEY-1315 found 1,580 rows whose stored GCS object is a web page rather than
 * a document, and proposed quarantining all of them. Before paying that, the
 * pages we ALREADY HOLD were opened and measured. On prod 2026-09-02, by the
 * host of `sourceUrl`:
 *
 *     host                     rows  with bytes  what the bytes are
 *     www.sebi.gov.in           616         605  landing page; the prospectus is
 *                                               one hop on, in an <iframe>
 *     www.crisil.com            495         442  THE RATIONALE ITSELF
 *     www.icra.in               196         186  PDF.js viewer; one hop on
 *     www.indiaratings.co.in    146         135  JS shell — unrecoverable
 *     www.bseindia.com           74          74  BSE homepage — unrecoverable
 *     bcrisp.in                  69          69  THE RATIONALE ITSELF
 *     connect.acuite.in           9           9  THE RATIONALE ITSELF
 *     (61 company IR hosts)      61          61  unrecoverable
 *
 * **1,310 of 1,580 (82.9%) are salvageable with no new fetch strategy** — 790
 * one hop away, 520 already in hand.
 *
 * **1,320 as of MONEY-1321 H2** — re-measured by a full prod dry run on
 * 2026-09-02, after ICRA gained the `sourceUrl`-only recovery below: 800
 * one-hop (SEBI 604 + ICRA **196**) + 520 text, `readFailed 0`. The extra ten
 * are the ICRA rows carrying no readable object; they used to classify
 * `noBytes` and are now derived from the `Id` in their own URL. Both figures
 * carry their date rather than one quietly overwriting the other.
 *
 * ## TWO LANES, and conflating them is the expensive mistake
 *
 *   ONE-HOP  (SEBI 604 + ICRA 186 = 790)
 *     The page is chrome around a viewer. `recoverDocumentUrl` reads the
 *     viewer's own `file=` parameter, we fetch that, and the row points at a
 *     real PDF.
 *
 *   TEXT-IS-THE-DOCUMENT  (CRISIL 442 + Brickwork 69 + Acuité 9 = 520)
 *     There is nothing to fetch. CRISIL's `sourceUrl` ENDS IN `.html`; the
 *     rating rationale IS the page — median 17,177 characters against 455 for a
 *     SEBI landing page. These rows get their text extracted IN PLACE and go
 *     READY. Fetching anything for them would fetch the wrong thing: their
 *     `.pdf` links are METHODOLOGY BOILERPLATE (`Basics of Ratings…pdf`,
 *     `Criteria for manufacturing…pdf`), so a generic first-link parser swaps
 *     442 company rating rationales for a handful of generic criteria PDFs —
 *     the wrong document, stored confidently, with nothing in the row to reveal
 *     it.
 *
 * The routing is `recoverDocumentUrl`'s, not this file's. It selects by the
 * ROLE a link plays on a MEASURED host, never by "the first thing ending in
 * .pdf", and an unmeasured host is REFUSED rather than guessed — a guessed rule
 * stores another company's document under our symbol, which no downstream check
 * can detect.
 *
 * ## ORDER AGAINST THE QUARANTINE: RUN THIS ONE FIRST. It is not optional.
 *
 * This header used to say order does not matter, "because this script reads the
 * stored object when `gcsPath` is set and RE-FETCHES `sourceUrl` when it is
 * not". **There was no such branch** (MONEY-1321 H2). `planRecovery` returned
 * `noBytes` the moment the body was empty, and the ONE fetch in this file
 * derives its URL FROM THE BODY — so with no body there was nothing to fetch.
 * Quarantine-first would have blanked 604 SEBI + 186 ICRA `gcsPath`s, every one
 * would have classified `noBytes`, the census would have read clean and the run
 * would have exited 0 with the content unrecoverable.
 *
 * Both halves are fixed rather than only the sentence:
 *
 *   - **ICRA no longer needs bytes.** Its rationale id is the `Id` query
 *     parameter of `sourceUrl` itself, so `planRecovery` asks
 *     `recoverDocumentUrl` with an EMPTY body before giving up, and the 186
 *     ICRA rows recover from a blanked row. SEBI cannot: its viewer link is in
 *     the page, so those 604 rows are recoverable ONLY while they still hold
 *     their bytes.
 *   - **The quarantine now REFUSES `--apply`** while any row it would clear is
 *     one this job could still recover from the bytes it is about to destroy.
 *     The dangerous order is unreachable, not merely documented — a comment is
 *     not a guard.
 *
 * The 520 `htmlIsTheDocument` rows were never at risk from either order: the
 * quarantine does not select them at all.
 *
 * ## Safety properties
 *
 *   - **DRY RUN BY DEFAULT.** `--apply` needs an interactive terminal, so a
 *     wrapper cannot write by accident.
 *   - **ADDITIVE ONLY.** It never clears `gcsPath`, never deletes an object and
 *     never moves a row to a terminal state. Every failure leaves the row
 *     exactly as it was, so a bad run costs a re-run and nothing else. That is
 *     what lets the selection narrow (below) where the quarantine's could not.
 *   - **IDEMPOTENT.** A row whose bytes are no longer an HTML page, or which is
 *     already `READY` with text, is counted `alreadyRecovered` before any fetch.
 *     Re-running a completed pass reports nothing to do.
 *   - **SAME-HOST.** A recovered URL must live on the host that served the page.
 *     `recoverDocumentUrl` absolutises against `sourceUrl`, so a page could name
 *     an arbitrary absolute URL; requiring the same host closes that without a
 *     second allowlist to maintain, and the refusals are COUNTED rather than
 *     silently skipped.
 *
 * ## Why the selection may narrow here, when the quarantine's may not
 *
 * The quarantine walks the entire collection with `$ifNull` projections because
 * it DESTROYS: a row it fails to see is a row it might have cleared wrongly,
 * and a Prisma predicate on an absent attribute matches ZERO in both directions
 * (MONEY-1050 / 1205 / 1234 / 1235 / 1236). This job only ever FILLS a row in,
 * so a row it fails to see keeps exactly what it has. It still walks with
 * `$runCommandRaw` + `$ifNull` for the same absent-field reason — `sourceUrl`
 * and `gcsPath` are both projected, never filtered — and decides in CODE.
 *
 * ## Usage
 *
 *   node --import tsx scripts/migrations/recover-html-stock-documents.ts --env prod
 *   node --import tsx scripts/migrations/recover-html-stock-documents.ts --env prod --lane text
 *   node --import tsx scripts/migrations/recover-html-stock-documents.ts --env prod --apply
 *
 *   --apply          actually write (default: DRY RUN). Needs a TTY.
 *   --env qa|prod    read DATABASE_URL + the bucket for that environment
 *   --lane L         one-hop | text | all (default all)
 *   --host H         restrict to one sourceUrl host. Dry-run sampling only.
 *   --limit N        stop after N rows scanned. Dry-run only.
 *   --concurrency N  parallel object reads (default 16)
 *
 * Unknown flags are a hard ERROR — `argv.includes()` silently drops what it
 * does not recognise, and a dry-run-by-default job that swallows `--apply`
 * reads the corpus, writes nothing and exits 0.
 */

import { execFileSync } from "child_process";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import {
  buildFullDocPath,
  type StockDocType,
} from "@usemoney/research/data-sources/stock-document-paths";
import { stripMultipartEnvelope } from "@usemoney/storage/multipart-envelope";
import { resolveStoredMimeType } from "@usemoney/core/market-data/doc-container";
import { initialProcessingStatus } from "@usemoney/core/market-data/doc-mime";
import { safeFetch } from "@usemoney/core/import";
import { MAX_TEXT_LENGTH } from "../../workers/src/processors/document-process-logic";
// The WHOLE decision, pure and unit-tested. It is a separate module for the
// reason `xbrl-projection-drain-logic.mts` is: a decision inside a script is a
// decision no test can reach without executing the script, and this file's
// module scope calls `run()`.
import {
  planRecovery,
  recoveryLaneFor,
  recoveryHostOf,
  isMissingObjectError,
  RECOVERY_OUTCOMES,
  RECOVERY_RUN_FAULTS,
  type RecoveryOutcome,
  type RecoveryWritePlan,
} from "./recover-html-stock-documents-logic.mjs";

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

/** Rows per raw aggregate page. */
const PAGE_SIZE = 5000;

/** Bytes read per candidate object. Rating pages measure ~10-30 KB. */
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/** Ceiling on a fetched document. */
const MAX_FETCH_BYTES = 60 * 1024 * 1024;

type Lane = "one-hop" | "text" | "all";

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  lane: Lane;
  host: string | null;
  limit: number | null;
  concurrency: number;
}

const KNOWN_FLAGS = new Set([
  "--apply",
  "--env",
  "--lane",
  "--host",
  "--limit",
  "--concurrency",
]);

function assertKnownFlags(argv: string[]): void {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}.`,
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

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${f} was given with no value`);
    }
    return next;
  };

  const env = val("--env");
  if (env && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const laneRaw = val("--lane") ?? "all";
  if (laneRaw !== "one-hop" && laneRaw !== "text" && laneRaw !== "all") {
    throw new Error(`--lane must be one-hop | text | all, got "${laneRaw}"`);
  }

  const limitRaw = val("--limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
    }
    limit = n;
  }

  const concRaw = val("--concurrency");
  let concurrency = 16;
  if (concRaw !== null) {
    const n = Number(concRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 64) {
      throw new Error(`--concurrency must be 1..64, got "${concRaw}"`);
    }
    concurrency = n;
  }

  const apply = has("--apply");

  // A SAMPLED census beside a corpus-wide write is the shape where the only
  // output an operator can judge the change by describes something else.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the census would describe a " +
        "sample while the write covers the corpus. Use --limit for the dry run.",
    );
  }
  if (apply && val("--host") !== null) {
    throw new Error(
      "--host cannot be combined with --apply: the finding spans hosts and a " +
        "narrowed write leaves the rest unrecovered with nothing saying so. " +
        "Use --host for the dry run.",
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
    lane: laneRaw,
    host: val("--host"),
    limit,
    concurrency,
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

/** Host for DISPLAY. The decision uses `recoveryHostOf`; this only labels. */
function hostOf(url: string | null): string {
  if (!url) return "(none)";
  return recoveryHostOf(url) || "(unparseable)";
}

/* -------------------------------------------------------------------------- */
/* The census                                                                  */
/* -------------------------------------------------------------------------- */

interface DocRow {
  id: string;
  symbol: string;
  docType: string;
  period: string;
  exchange: string;
  gcsPath: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  processingStatus: string | null;
  textContent: string | null;
}

/** Alias so the census below reads as this script's own vocabulary. */
type RowOutcome = RecoveryOutcome;

/** The full outcome vocabulary, ordered for the report. */
const OUTCOMES: readonly RowOutcome[] = RECOVERY_OUTCOMES;

interface Census {
  scanned: number;
  candidates: number;
  byOutcome: Map<RowOutcome, number>;
  /** `host → outcome → n`. A total cannot show a dead host. */
  byHost: Map<string, Map<RowOutcome, number>>;
  examples: string[];
  /** The first few VERBATIM GCS errors, so a fault names itself (M13). */
  readErrors: string[];
}

function newCensus(): Census {
  return {
    scanned: 0,
    candidates: 0,
    byOutcome: new Map(OUTCOMES.map((o) => [o, 0])),
    byHost: new Map(),
    examples: [],
    readErrors: [],
  };
}

/**
 * The result of one object read — MONEY-1321 M13.
 *
 * `missing` and `failed` are separate members because they are separate
 * findings: the first is about the ROW (there are no bytes at that key), the
 * second is about the RUN (we could not ask). Collapsing them into `null` is
 * how a credential failure reports a clean census.
 */
type ObjectRead =
  | { kind: "bytes"; body: Buffer }
  | { kind: "missing" }
  | { kind: "failed" };

function record(census: Census, row: DocRow, outcome: RowOutcome): void {
  census.byOutcome.set(outcome, (census.byOutcome.get(outcome) ?? 0) + 1);
  const host = hostOf(row.sourceUrl);
  let per = census.byHost.get(host);
  if (!per) {
    per = new Map(OUTCOMES.map((o) => [o, 0]));
    census.byHost.set(host, per);
  }
  per.set(outcome, (per.get(outcome) ?? 0) + 1);
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

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(opts: Options): Promise<void> {
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
    throw new Error("GCP_STORAGE_BUCKET is not set (pass --env qa|prod).");
  }

  // Imported AFTER `--env` resolved DATABASE_URL: `@usemoney/database` builds
  // its PrismaClient at module scope from `process.env.DATABASE_URL`, so a
  // top-level import would pin the client to the ambient value.
  const { PrismaClient } = await import("@usemoney/database");
  const { Storage } = await import("@google-cloud/storage");

  const prisma = new PrismaClient();
  const bucket = new Storage({
    projectId: process.env.GCP_PROJECT_ID ?? GCP_PROJECT,
  }).bucket(bucketName);

  console.log(
    `\n${opts.apply ? "APPLY" : "DRY RUN"} — recover HTML-bodied stock_documents\n` +
      `  database ${maskedHost(dbUrl) ?? "(unparseable)"}\n` +
      `  bucket   ${bucketName}\n` +
      `  lane     ${opts.lane}` +
      (opts.host ? `\n  host     ${opts.host}` : "") +
      (opts.limit ? `\n  limit    ${opts.limit} row(s)` : "") +
      "\n",
  );

  const census = newCensus();

  /**
   * Read a whole object, peeling a MONEY-1169 multipart envelope if present.
   *
   * THE ERROR IS CLASSIFIED, NEVER SWALLOWED — MONEY-1321 M13. This used to be
   * `catch { return null }`, and `null` is the same value a legitimately
   * blanked `gcsPath` produces. So a wrong bucket, an expired credential or an
   * IAM change made every row report `noBytes`, the census read clean, and the
   * run exited 0 — with a cover story already in the report, because 604 SEBI
   * and 186 ICRA rows genuinely do carry an empty path. 404 is the only code
   * that means "the object is not there"; everything else is a fault of the
   * RUN and is reported as one.
   */
  const readObject = async (key: string): Promise<ObjectRead> => {
    try {
      const [raw] = await bucket
        .file(key)
        .download({ start: 0, end: MAX_OBJECT_BYTES - 1 });
      const buf = Buffer.from(raw);
      const stripped = stripMultipartEnvelope(buf);
      return {
        kind: "bytes",
        body: stripped ? Buffer.from(stripped.payload) : buf,
      };
    } catch (err) {
      if (isMissingObjectError(err)) return { kind: "missing" };
      const message = err instanceof Error ? err.message : String(err);
      if (census.readErrors.length < 5)
        census.readErrors.push(`${key}: ${message}`);
      return { kind: "failed" };
    }
  };

  try {
    let lastId: string | null = null;

    for (;;) {
      const page = (await prisma.$runCommandRaw({
        aggregate: COLLECTION,
        pipeline: [
          ...(lastId ? [{ $match: { _id: { $gt: { $oid: lastId } } } }] : []),
          { $sort: { _id: 1 } },
          { $limit: PAGE_SIZE },
          {
            $project: {
              // `$ifNull` on every field that can be ABSENT rather than null.
              // A Prisma predicate on an absent attribute matches ZERO in BOTH
              // directions (MONEY-1050 / 1205 / 1234 / 1235 / 1236), so nothing
              // here filters on one; the decision is made in code below.
              symbol: { $ifNull: ["$symbol", ""] },
              docType: { $ifNull: ["$docType", "(absent)"] },
              period: { $ifNull: ["$period", ""] },
              exchange: { $ifNull: ["$exchange", ""] },
              gcsPath: { $ifNull: ["$gcsPath", null] },
              sourceUrl: { $ifNull: ["$sourceUrl", null] },
              mimeType: { $ifNull: ["$mimeType", null] },
              processingStatus: { $ifNull: ["$processingStatus", null] },
              // Only its LENGTH is used; projecting the whole column over
              // 88,000 rows would ship ~100 KB per row across the wire.
              textContent: {
                $cond: [
                  {
                    $gt: [{ $strLenCP: { $ifNull: ["$textContent", ""] } }, 0],
                  },
                  "present",
                  null,
                ],
              },
            },
          },
        ],
        cursor: { batchSize: PAGE_SIZE },
      })) as {
        cursor: {
          firstBatch: Array<
            Omit<DocRow, "id"> & { _id: { $oid: string } | string }
          >;
        };
      };

      const batch = page.cursor.firstBatch;
      // An EMPTY batch is the ONLY end-of-collection signal. A SHORT one means
      // `cursor.firstBatch` hit its 16 MB wire cap, which is capped regardless
      // of `batchSize` — breaking on it ends the walk with the table part-read
      // while every total printed afterwards reads as a complete census
      // (MONEY-1189).
      if (batch.length === 0) break;

      const rows: DocRow[] = batch.map((r) => ({
        id: typeof r._id === "string" ? r._id : r._id.$oid,
        symbol: r.symbol,
        docType: r.docType,
        period: r.period,
        exchange: r.exchange,
        gcsPath: r.gcsPath,
        sourceUrl: r.sourceUrl,
        mimeType: r.mimeType,
        processingStatus: r.processingStatus,
        textContent: r.textContent,
      }));
      lastId = rows[rows.length - 1]!.id;
      census.scanned += rows.length;

      // Narrow to rows a MEASURED rule could act on, from the row alone — no
      // GCS call yet. `recoveryLaneFor` answers from the HOST alone, and that
      // is load-bearing: asking `recoverDocumentUrl` with an EMPTY BODY looks
      // equivalent and is not — for a SEBI or ICRA row the body carries the
      // viewer link, so an empty body reads `unrecoverable` and this filter
      // silently drops all 790 one-hop rows while the 520 text rows, which
      // short-circuit on host, keep routing perfectly. The body decides the
      // URL, and it is read below only for the rows this keeps.
      const candidates = rows.filter((row) => {
        if (!row.sourceUrl) return false;
        if (opts.host && hostOf(row.sourceUrl) !== opts.host.toLowerCase()) {
          return false;
        }
        const lane = recoveryLaneFor(row.sourceUrl);
        if (lane === null) return false;
        return opts.lane === "all" || opts.lane === lane;
      });
      census.candidates += candidates.length;

      for (let i = 0; i < candidates.length; i += opts.concurrency) {
        const slice = candidates.slice(i, i + opts.concurrency);
        const results = await Promise.all(
          slice.map((row) => planRow(row, readObject)),
        );
        for (let k = 0; k < slice.length; k++) {
          const row = slice[k]!;
          const plan = results[k]!;
          if (!opts.apply || plan.write === null) {
            record(census, row, plan.outcome);
            if (plan.example && census.examples.length < 12) {
              census.examples.push(plan.example);
            }
            continue;
          }
          const applied = await applyPlan(prisma, bucket, row, plan.write);
          record(census, row, applied);
        }
      }

      console.log(
        `  scanned ${census.scanned}  candidates ${census.candidates}  ` +
          `one-hop ${(census.byOutcome.get("oneHopPlanned") ?? 0) + (census.byOutcome.get("oneHopWritten") ?? 0)}  ` +
          `text ${(census.byOutcome.get("textPlanned") ?? 0) + (census.byOutcome.get("textWritten") ?? 0)}`,
      );

      if (opts.limit !== null && census.scanned >= opts.limit) break;
    }

    /* ---- Report ------------------------------------------------------- */
    console.log("\n=== CENSUS ===");
    console.log(`  scanned              ${census.scanned}`);
    console.log(`  candidates           ${census.candidates}`);
    for (const o of OUTCOMES) {
      const n = census.byOutcome.get(o) ?? 0;
      if (n > 0) console.log(`  ${o.padEnd(20)} ${n}`);
    }

    console.log("\n=== by sourceUrl host ===");
    for (const [host, per] of [...census.byHost.entries()].sort(
      (a, b) =>
        [...b[1].values()].reduce((x, y) => x + y, 0) -
        [...a[1].values()].reduce((x, y) => x + y, 0),
    )) {
      const parts = [...per.entries()]
        .filter(([, n]) => n > 0)
        .map(([o, n]) => `${o}:${n}`)
        .join(" ");
      console.log(`  ${host.padEnd(26)} ${parts}`);
    }

    if (census.examples.length > 0) {
      console.log("\n=== examples ===");
      for (const e of census.examples) console.log(`  ${e}`);
    }

    /* ---- A DEGRADED RUN SAYS SO, AND EXITS NON-ZERO — M13 -------------- */
    //
    // The count is printed even at zero: an operator reading "readFailed 0" has
    // been told the check ran, where a line that only appears on failure is
    // indistinguishable from a build that dropped it.
    const faults = RECOVERY_RUN_FAULTS.reduce(
      (n, o) => n + (census.byOutcome.get(o) ?? 0),
      0,
    );
    console.log(`\n=== run health ===\n  readFailed           ${faults}`);
    if (faults > 0) {
      for (const e of census.readErrors) console.log(`  ! ${e}`);
      console.log(
        `\n  ${faults} object read(s) FAILED — this is a fault of the RUN (auth, ` +
          `bucket,\n  transport), not a finding about those rows, and they are NOT ` +
          `counted\n  as noBytes. The census above is INCOMPLETE by that many rows. ` +
          `Exiting\n  non-zero so a wrapper cannot read this as a clean pass.`,
      );
      process.exitCode = 1;
    }

    if (!opts.apply) {
      const planned =
        (census.byOutcome.get("oneHopPlanned") ?? 0) +
        (census.byOutcome.get("textPlanned") ?? 0);
      console.log(
        `\nDRY RUN — nothing written and nothing fetched. ${planned} row(s) ` +
          `would be recovered. Re-run with --apply to write.`,
      );
      return;
    }

    console.log(
      `\nAPPLIED — ${census.byOutcome.get("oneHopWritten") ?? 0} document(s) ` +
        `fetched and stored, ${census.byOutcome.get("textWritten") ?? 0} page(s) ` +
        `extracted in place.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Per-row planning (no writes)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read one row's stored bytes and hand them to the pure planner.
 *
 * The I/O is exactly one GCS read; every decision is
 * {@link planRecovery}'s. Nothing is fetched from a third-party host here, so a
 * DRY RUN reaches no upstream at all and the counts it prints are safe to quote
 * before anyone commits to the write.
 */
async function planRow(
  row: DocRow,
  readObject: (key: string) => Promise<ObjectRead>,
): Promise<{
  outcome: RowOutcome;
  write: RecoveryWritePlan | null;
  example?: string;
}> {
  // The read is skipped entirely when the row is already done, so a completed
  // pass costs no GCS calls to re-run.
  const read: ObjectRead =
    row.processingStatus === "READY" && row.textContent !== null
      ? { kind: "missing" }
      : row.gcsPath && row.gcsPath.length > 0
        ? await readObject(row.gcsPath)
        : { kind: "missing" };

  const plan = planRecovery({
    sourceUrl: row.sourceUrl,
    gcsPath: row.gcsPath,
    processingStatus: row.processingStatus,
    hasText: row.textContent !== null,
    body: read.kind === "bytes" ? read.body : null,
    readFailed: read.kind === "failed",
  });

  const example = (() => {
    switch (plan.outcome) {
      case "noBytes":
        return `${row.symbol.padEnd(14)} noBytes  ${row.sourceUrl ?? "(no sourceUrl)"}`;
      case "readFailed":
        return `${row.symbol.padEnd(14)} readFail ${row.gcsPath ?? "(no gcsPath)"}`;
      case "crossHostRefused":
        return `${row.symbol.padEnd(14)} cross-host  ${row.sourceUrl}`;
      case "textTooShort":
        return `${row.symbol.padEnd(14)} tooShort  ${row.sourceUrl}`;
      case "oneHopPlanned":
        return `${row.symbol.padEnd(14)} one-hop  ${plan.write?.kind === "one-hop" ? plan.write.url : ""}`;
      case "textPlanned":
        return `${row.symbol.padEnd(14)} text     ${plan.write?.kind === "text" ? plan.write.text.length : 0}ch  ${row.sourceUrl}`;
      default:
        return undefined;
    }
  })();

  return example === undefined
    ? { outcome: plan.outcome, write: plan.write }
    : { outcome: plan.outcome, write: plan.write, example };
}

/* -------------------------------------------------------------------------- */
/* Per-row apply                                                               */
/* -------------------------------------------------------------------------- */

async function applyPlan(
  prisma: import("@usemoney/database").PrismaClient,
  bucket: import("@google-cloud/storage").Bucket,
  row: DocRow,
  plan: RecoveryWritePlan,
): Promise<RowOutcome> {
  if (plan.kind === "text") {
    // The object already holds the document, so `gcsPath` and `mimeType` are
    // left EXACTLY as they are: `text/html` is the honest media type for these
    // bytes, and re-typing it would make the row claim a PDF it does not have.
    let textContent = plan.text;
    if (plan.text.length > MAX_TEXT_LENGTH && row.gcsPath) {
      await bucket
        .file(`${row.gcsPath}.extracted.txt`)
        .save(Buffer.from(plan.text, "utf-8"), {
          contentType: "text/plain",
          resumable: false,
        });
      textContent = plan.text.slice(0, MAX_TEXT_LENGTH);
    }
    await prisma.stockDocument.update({
      where: { id: row.id },
      data: {
        textContent,
        processingStatus: "READY",
        // The embed lane keys on READY + non-null textContent + !isEmbedded.
        isEmbedded: false,
      },
    });
    return "textWritten";
  }

  // ONE-HOP. The fetch happens HERE and nowhere else, so a dry run reaches no
  // third-party host.
  let buffer: Buffer;
  try {
    const allowedHost = hostOf(row.sourceUrl);
    const res = await safeFetch(
      plan.url,
      {
        headers: {
          "User-Agent": "UseMoney/1.0 (Document Recovery; MONEY-1321)",
        },
      },
      {
        maxBytes: MAX_FETCH_BYTES,
        timeoutMs: 45_000,
        // Belt AND braces: `planRow` already refused a cross-host URL, and the
        // guard is repeated at the fetch because a redirect can move hosts
        // after the check.
        allowedHosts: [allowedHost],
      },
    );
    buffer = res.buffer;
  } catch {
    return "fetchFailed";
  }

  // The BYTES, not the response header — the whole reason these rows exist is
  // an upstream serving a page where a document was asked for. A recovered
  // "PDF" that is another landing page must not replace the one we have.
  const mimeType = resolveStoredMimeType({ body: buffer });
  if (mimeType === "text/html" || buffer.length < 1000) {
    return "fetchedNotADocument";
  }

  // A NEW key with the right extension. The stored HTML sits under a `.txt`
  // name (`inferExtension`'s `text/` branch), and writing a PDF over it would
  // leave a `.txt` object holding a PDF — the naming defect this ticket's
  // sibling exists to remove. The old object is LEFT ALONE: deleting bytes is a
  // separate, opt-in decision (`--delete-objects` on the quarantine).
  const gcsPath = buildFullDocPath(
    row.symbol,
    row.docType as StockDocType,
    row.period,
    mimeType === "application/zip" ? "zip" : "pdf",
  );
  await bucket.file(gcsPath).save(buffer, {
    contentType: mimeType,
    resumable: false,
  });

  await prisma.stockDocument.update({
    where: { id: row.id },
    data: {
      gcsPath,
      fileSize: buffer.length,
      mimeType,
      // From the media type the BYTES imply, so an unreadable container lands
      // UNSUPPORTED instead of joining the extraction queue forever.
      processingStatus: initialProcessingStatus(mimeType),
      textContent: null,
      isEmbedded: false,
      fetchedAt: new Date(),
    },
  });
  return "oneHopWritten";
}

/* -------------------------------------------------------------------------- */

async function run(): Promise<void> {
  // Parsed ONCE. Two parses would mean two independent readings of argv, and
  // the confirmation would then be about a different set of options than the
  // run — which is the shape where an operator approves one thing and another
  // happens.
  const opts = parseArgs(process.argv.slice(2));
  if (opts.apply) {
    const ok = await confirm(
      `\nThis WRITES to ${opts.env ?? "the ambient DATABASE_URL"}. Type "yes" to continue: `,
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }
  await main(opts);
}

run().catch((err) => {
  console.error("recover-html-stock-documents FAILED:", err);
  process.exit(1);
});
