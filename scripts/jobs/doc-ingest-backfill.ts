/**
 * THE DOC-INGEST BACKFILL — MONEY-1314.
 *
 * One Cloud Run JOB with five subcommands, walking the 79,884-row PDF archive
 * (309.8 GB, `docs/reference/doc-ingest-population.md`) from stored bytes to
 * `document_financial_extracts`:
 *
 *   scan-convert   GCS -> pdf-inspector -> `${gcsPath}.md` sidecar + stamps
 *   batch-build    converted markdown -> page-selected -> normalised -> JSONL
 *   batch-submit   JSONL -> Files API -> batchGenerateContent -> BATCHED rows
 *   batch-ingest   finished batch -> map + grade -> upsert (or COMPARE)
 *   sweep          the terminal-failure residue, back through the ONLINE path
 *
 * ## Why a JOB, and why the 600 s ack deadline does NOT apply
 *
 * Every batch size in this repo is set by Pub/Sub's un-raisable 600 s push ack
 * deadline (CLAUDE.md, "Job throughput"): a handler that runs past it gets its
 * message REDELIVERED and a second copy starts concurrently. `scan-convert`
 * reads 309.8 GB and `batch-ingest` walks a whole batch's results — neither
 * fits, and neither has to. A Cloud Run job has no subscription, no message and
 * no ack; the binding constraints here are MEMORY (peak RSS is 2.3–4.8x file
 * size, measured, worst case 618 MB on a 129.81 MB PDF) and this run's own
 * wall-clock budget. Both are explicit. Do not re-impose a 600 s bound out of
 * habit.
 *
 * ## Six rules, each of which is a defect this repo has already paid for
 *
 * 1. **DRY RUN IS THE DEFAULT and `--apply` is FORWARDED, never swallowed.**
 *    `feed-repair` once read 41,924 rows, wrote nothing and exited 0 because a
 *    wrapper consumed `--apply` on the job's behalf
 *    (`reference_wrapper_flag_opposite_contracts`). There is no wrapper here:
 *    `--apply` is parsed by THIS file and by nothing else, and
 *    `scripts/ops/setup-doc-ingest-backfill-job.sh` deliberately has no
 *    `--apply` case at all. The resolved state is printed on EVERY run, in the
 *    outcome line, whichever way it resolved.
 *
 * 2. **Counters are WRITES, not attempts.** `stock-document-sync` incremented
 *    every per-source counter BEFORE the call it counted, so a source that
 *    403s on every request still produced a full-looking number — which is how
 *    Tickertape's block hid for five months. Here the only place a write
 *    counter can move is inside {@link countedWrite}, AFTER the awaited
 *    operation resolves. `doc-ingest-backfill-job-setup.test.ts` asserts there
 *    is exactly one such mutation site in this file.
 *
 * 3. **An empty selection is not a drained queue.** They produce the same
 *    "nothing to do" log and the same exit 0, and telling them apart is the
 *    entire content of MONEY-1050 / 1205 / 1234 / 1236. Every run reports
 *    `selected` AND `remaining`, counted with the SAME predicate the selection
 *    used.
 *
 * 4. **The run is bounded by a WALL CLOCK, not a row count.** Per-document cost
 *    is a GCS read plus a conversion whose cost is dominated by a fixed
 *    ~150–200 ms per document and is not predictable from page count (a
 *    123-page image-based PDF ran 12.0 s). A row budget over that population is
 *    a guess; a clock is not. Checked BETWEEN documents, so the true wall is
 *    `budget + one document`, and the stop reason is named in the outcome.
 *
 * 5. **The cursor is the STAMP, and there is no checkpoint table.**
 *    `scannedPageCount: { isSet: false }` is `scan-convert`'s position;
 *    `batchJobId` is `batch-ingest`'s. The MONEY-1189 postmortem is a catalogue
 *    of checkpoints recording DONE for work that never happened, and
 *    `reference_resume_that_reverifies_has_a_ceiling` is what a differencing
 *    resume costs. Re-running is free and writes nothing it already wrote.
 *
 * 6. **Every selection goes through `doc-ingest-selectors-logic`.** A Mongo
 *    `prisma db push` creates INDEXES, never FIELDS, so `convertStatus`,
 *    `parsePath` and `batchJobId` are ABSENT — not null — on all ~79,884
 *    pre-existing rows, and `{ convertStatus: "PENDING" }` matches ZERO of
 *    them. The `{ isSet: false }` arms live in ONE module so a reviewer can
 *    check them; this file writes no query of its own over those fields.
 *
 * ## Two things in this repo are NOT ready, and this job fails closed on both
 *
 * - `@firecrawl/pdf-inspector` is not a declared dependency of any workspace
 *   and is not installed. `scan-convert` therefore refuses to run with exit
 *   {@link EXIT.FAILED} and names `workers/package.json`, rather than
 *   converting zero documents and exiting 0.
 * - `doc-ingest-backfill` is not an entry in `workers/tsup.config.ts`, so
 *   `dist/doc-ingest-backfill.js` does not exist in the workers image yet. The
 *   provisioning script preflights that and refuses; see its header.
 *
 * Usage (dry run is the default — nothing writes without --apply):
 *   npx tsx scripts/jobs/doc-ingest-backfill.ts scan-convert
 *   npx tsx scripts/jobs/doc-ingest-backfill.ts scan-convert --apply --limit=200
 *   npx tsx scripts/jobs/doc-ingest-backfill.ts batch-build \
 *       --pilot-from-parsed=25 --out=/tmp/pilot.jsonl --apply
 *   npx tsx scripts/jobs/doc-ingest-backfill.ts batch-submit --file=/tmp/pilot.jsonl --apply
 *   npx tsx scripts/jobs/doc-ingest-backfill.ts batch-ingest --batch-job=batches/xyz --compare
 *   npx tsx scripts/jobs/doc-ingest-backfill.ts sweep --apply --limit=50
 *
 * As a Cloud Run job (`scripts/ops/setup-doc-ingest-backfill-job.sh`):
 *   gcloud run jobs execute doc-ingest-backfill-prod --region=asia-south1 \
 *       --args="scan-convert,--apply,--budget-sec=21600"
 *
 * NOTE `--args` splits on COMMAS, so each comma starts a NEW argument. A stray
 * comma inside a flag is a routine mistake, which is why an unrecognised
 * argument is FATAL here: a mistyped `--apply` would otherwise run a silent dry
 * run and exit 0, indistinguishable from a deliberate rehearsal.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import prisma, { Prisma } from "@usemoney/database";
import { GoogleGenAI } from "@google/genai";

import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import {
  assessExtraction,
  joinPagesToMarkdown,
  looksLikePdf,
  describeNonPdf,
  estimatePeakRssBytes,
  sidecarIsPageIncomplete,
  type ExtractedPage,
} from "@usemoney/core/market-data/doc-convert-logic";
import {
  selectPagesForExtraction,
  statementEvidence,
  DEFAULT_MAX_CHARS,
  type DocPage,
} from "@usemoney/core/market-data/page-select-logic";
import { normaliseDocumentMarkdown } from "@usemoney/core/market-data/doc-number-normaliser-logic";
import {
  mapDocumentFinancials,
  DOC_FINANCIALS_PROMPT_VERSION,
  type MappedExtract,
  buildExtractWritePayload,
  type ExtractionVerdict,
} from "@usemoney/core/market-data/document-financials-logic";

// THE SELECTORS. Never a hand-written query over a MONEY-1314 field — see rule
// 6 in the header, and the module's own docstring for the four tickets the
// `isSet: false` arms exist because of.
import {
  buildConvertQuery,
  buildShardWhere,
  buildBatchIngestQuery,
  buildSweepQuery,
  CONVERT_STATUS,
  BATCH_PARSE_STATUS,
} from "../../workers/src/processors/doc-ingest-selectors-logic";
import {
  decideIngestLane,
  classifyIngestOutcome,
  INGEST_PARSE_STATUS,
} from "../../workers/src/processors/stock-document-ingest-logic";
import {
  buildBatchRequestLine,
  DOC_REQUEST_MAX_OUTPUT_TOKENS,
  buildPromptText,
} from "../../workers/src/lib/gemini-doc-request-logic";
import {
  parseMarkdownFinancials,
  parsePdfFinancials,
  parseDocFinancialsJson,
  extractResponseText,
  resolveDocParseModel,
  readUsage,
  DOC_PARSE_MAX_OUTPUT_TOKENS,
} from "../../workers/src/lib/gemini-pdf";
import { downloadFromGCS, uploadToGCS } from "../../workers/src/lib/gcs";
import {
  assertSafeObjectKey,
  buildGcsUri,
} from "../../workers/src/processors/stock-document-extract-logic";
import { PARSEABLE_DOC_TYPES } from "../../workers/src/processors/stock-document-parse-logic";
import { isMultipartEnvelope, stripMultipartEnvelope } from "@usemoney/storage";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB = "doc-ingest-backfill";

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

// ---------------------------------------------------------------------------
// EXIT CODES
// ---------------------------------------------------------------------------

/**
 * There is deliberately NO code for "nothing to do".
 *
 * An empty queue is a SUCCESS — once the corpus is converted, that is the
 * normal state of `scan-convert` and a non-zero exit would train an operator to
 * ignore the one signal that matters. What distinguishes "nothing to do" from
 * "the selector is broken" is not the exit code, it is `selected` beside
 * `remaining` in the outcome line (rule 3).
 *
 * INCOMPLETE is separated from FAILED because they call for opposite actions: a
 * budget stop means run it again (resume is free, the stamps are the cursor); a
 * failure means read the log first.
 */
const EXIT = {
  /** Finished the work in scope, or there was none. */
  OK: 0,
  /** Refused to run: a bad argument, a missing required flag. Nothing ran. */
  USAGE: 1,
  /** Something the run needs is absent or broke. Partial work may have landed. */
  FAILED: 2,
  /** Stopped on the wall-clock budget or the batch cap with work remaining. */
  INCOMPLETE: 3,
} as const;

// ---------------------------------------------------------------------------
// ARGUMENTS
// ---------------------------------------------------------------------------

const SUBCOMMANDS = [
  "scan-convert",
  "batch-build",
  "batch-submit",
  "batch-ingest",
  "sweep",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** Six hours. Cloud Run's task timeout is 24h and sits well above this. */
const DEFAULT_BUDGET_SEC = 6 * 60 * 60;
/** Rows read per database page. Not the run's bound — the clock is. */
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 5_000;
/** Runaway guard. A page that selects and stamps nothing must not spin. */
const DEFAULT_MAX_BATCHES = 500;

const BOOLEAN_FLAGS = new Set([
  "--apply",
  "--dry-run",
  "--rescan",
  "--compare",
  "--disable-thinking",
  "--help",
  "-h",
]);
const VALUE_FLAGS = new Set([
  "limit",
  "budget-sec",
  "max-batches",
  "symbols",
  "doc-types",
  "out",
  "file",
  "report",
  "batch-job",
  "model",
  "max-chars",
  "max-output-tokens",
  "chain-depth",
  "max-file-mb",
  "pilot-from-parsed",
  "shard",
  "concurrency",
  "pilot-max-per-symbol",
  "pilot-doc-types",
  "max-lines",
  "max-bytes",
  "files",
  "batch-jobs",
]);

interface Args {
  subcommand: Subcommand;
  apply: boolean;
  dryRun: boolean;
  rescan: boolean;
  compare: boolean;
  disableThinking: boolean;
  /** Override the per-request output ceiling. Undefined = the shipped default. */
  maxOutputTokens: number | undefined;
  /** Self-chain link number; 0 on an operator-launched run. */
  chainDepth: number;
  help: boolean;
  limit: number;
  budgetMs: number;
  maxBatches: number;
  symbols?: string[];
  docTypes?: string[];
  out?: string;
  file?: string;
  report?: string;
  batchJob?: string;
  model?: string;
  maxChars: number;
  maxFileMb: number;
  pilotFromParsed: number;
  /**
   * This task's slice of the corpus — MONEY-1339. Null = the whole corpus.
   *
   * Resolved from `--shard=i/n` or, when that is absent, from Cloud Run's own
   * `CLOUD_RUN_TASK_INDEX` / `CLOUD_RUN_TASK_COUNT`.
   */
  shard: { index: number; count: number } | null;
  /** Documents in flight inside ONE task. */
  concurrency: number;
  /** Cap on the documents ONE symbol may contribute to a pilot. */
  pilotMaxPerSymbol: number;
  /** Narrow the pilot to these docTypes; undefined = whatever the extracts cover. */
  pilotDocTypes?: string[];
  /** Request lines per submitted file. */
  maxLines: number;
  /** Bytes per submitted file. */
  maxBytes: number;
  /** Several JSONL files to submit in one run — the wave. */
  files?: string[];
  /** Several batch jobs to ingest in one run. */
  batchJobs?: string[];
}

interface ArgParse {
  args: Args;
  errors: string[];
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
  max?: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    errors.push(`--${name}=${raw} is not a positive integer`);
    return fallback;
  }
  if (max !== undefined && n > max) {
    errors.push(`--${name}=${n} exceeds the maximum of ${max}`);
    return fallback;
  }
  return n;
}

function parseCsv(
  raw: string | undefined,
  upper: boolean,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = [
    ...new Set(
      raw
        .split(",")
        .map((s) => (upper ? s.trim().toUpperCase() : s.trim()))
        .filter(Boolean),
    ),
  ];
  return list.length > 0 ? list : [];
}

/**
 * argv -> {@link Args}, with every default on the SAFE side.
 *
 * Both `--flag=value` and `--flag value` are accepted. gcloud splits `--args`
 * on commas, so the `=` form is the one that survives a Cloud Run execution;
 * the spaced form exists because a human types it and there is no reason to
 * reject it.
 *
 * An UNKNOWN argument is fatal. `xbrl-backfill.ts` ignores what it does not
 * recognise, which is survivable there because its expensive modes are opt-IN.
 * Here the polarity is inverted: `--apply` is the flag that makes the job do
 * anything at all, so `--aply` would parse as "no flags given", plan a dry run
 * and exit 0 looking exactly like a successful rehearsal.
 */
function parseArgs(argv: readonly string[]): ArgParse {
  const errors: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (BOOLEAN_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }

    const named = /^--([\w-]+)=([\s\S]*)$/.exec(token);
    if (named && VALUE_FLAGS.has(named[1] ?? "")) {
      values.set(named[1] ?? "", named[2] ?? "");
      continue;
    }

    const bare = /^--([\w-]+)$/.exec(token);
    if (bare && VALUE_FLAGS.has(bare[1] ?? "")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`--${bare[1]} needs a value`);
        continue;
      }
      values.set(bare[1] ?? "", next);
      i++;
      continue;
    }

    if (token.startsWith("-")) {
      errors.push(
        `unknown argument "${token}" — refusing to run rather than silently ` +
          "treating it as a dry run (a mistyped --apply is indistinguishable " +
          "from a deliberate rehearsal)",
      );
      continue;
    }
    positional.push(token);
  }

  const help = flags.has("--help") || flags.has("-h");
  const subRaw = positional[0];
  let subcommand: Subcommand = "scan-convert";
  if (positional.length > 1) {
    errors.push(
      `expected exactly one subcommand, got ${positional.length}: ` +
        positional.join(", "),
    );
  }
  if (subRaw === undefined) {
    if (!help) {
      errors.push(
        `a subcommand is required — one of ${SUBCOMMANDS.join(", ")}. There is ` +
          "no default: the five do very different amounts of work and " +
          "defaulting one of them is how the wrong one gets run.",
      );
    }
  } else if ((SUBCOMMANDS as readonly string[]).includes(subRaw)) {
    subcommand = subRaw as Subcommand;
  } else {
    errors.push(
      `unknown subcommand "${subRaw}" — one of ${SUBCOMMANDS.join(", ")}`,
    );
  }

  // `--apply` is read HERE and nowhere else in the pipeline. Nothing between
  // the command line and this line may consume it.
  const apply = flags.has("--apply");
  const compare = flags.has("--compare");

  if (apply && compare) {
    // Not a warning. `--compare` exists to judge a pilot against a known
    // answer, and an upsert would overwrite the very rows it is comparing
    // against — so "compare, and also write" is not a state that can be
    // honoured, and silently preferring one of them is worse than refusing.
    errors.push(
      "--compare and --apply are mutually exclusive. --compare NEVER writes: " +
        "it grades a batch against the extracts already on the row, and an " +
        "upsert would destroy the comparison's own baseline.",
    );
  }

  const symbols = parseCsv(values.get("symbols"), true);
  if (symbols !== undefined && symbols.length === 0) {
    errors.push(
      "--symbols was given but empty. Omit the flag for every symbol; an " +
        "empty list is never interpreted as one.",
    );
  }
  const docTypes = parseCsv(values.get("doc-types"), false);
  if (docTypes !== undefined && docTypes.length === 0) {
    errors.push("--doc-types was given but empty");
  }
  const pilotDocTypes = parseCsv(values.get("pilot-doc-types"), false);
  if (pilotDocTypes !== undefined && pilotDocTypes.length === 0) {
    errors.push("--pilot-doc-types was given but empty");
  }
  const files = parseCsv(values.get("files"), false);
  if (files !== undefined && files.length === 0) {
    errors.push("--files was given but empty");
  }
  const batchJobs = parseCsv(values.get("batch-jobs"), false);
  if (batchJobs !== undefined && batchJobs.length === 0) {
    errors.push("--batch-jobs was given but empty");
  }

  const budgetSec = parsePositiveInt(
    values.get("budget-sec"),
    DEFAULT_BUDGET_SEC,
    "budget-sec",
    errors,
  );

  const args: Args = {
    subcommand,
    apply,
    dryRun: flags.has("--dry-run"),
    rescan: flags.has("--rescan"),
    compare,
    disableThinking: flags.has("--disable-thinking"),
    // THINKING SHARES THIS CEILING, so the two knobs are measured together or
    // not at all — an arm that disables thinking and an arm that raises the
    // ceiling are testing the same budget from opposite ends. Undefined means
    // "use the shipped default" and is NOT the same as 0: parsePositiveInt
    // refuses 0 rather than treating it as unlimited, because a 0 ceiling
    // truncates every answer while looking like an off switch.
    maxOutputTokens: values.has("max-output-tokens")
      ? parsePositiveInt(
          values.get("max-output-tokens"),
          DOC_REQUEST_MAX_OUTPUT_TOKENS,
          "max-output-tokens",
          errors,
          // The model's hard ceiling, IMPORTED rather than restated. Asking for
          // more is refused HERE rather than by the vendor mid-batch, where it
          // would arrive as a per-line failure after the input file had already
          // been uploaded.
          DOC_PARSE_MAX_OUTPUT_TOKENS,
        )
      : undefined,
    chainDepth: parsePositiveInt(
      values.get("chain-depth"),
      0,
      "chain-depth",
      errors,
      SCAN_CONVERT_MAX_CHAIN_DEPTH,
    ),
    help,
    limit: parsePositiveInt(
      values.get("limit"),
      DEFAULT_LIMIT,
      "limit",
      errors,
      MAX_LIMIT,
    ),
    budgetMs: budgetSec * 1000,
    maxBatches: parsePositiveInt(
      values.get("max-batches"),
      DEFAULT_MAX_BATCHES,
      "max-batches",
      errors,
    ),
    ...(symbols && symbols.length > 0 ? { symbols } : {}),
    ...(docTypes && docTypes.length > 0 ? { docTypes } : {}),
    ...(values.get("out") ? { out: values.get("out") } : {}),
    ...(values.get("file") ? { file: values.get("file") } : {}),
    ...(values.get("report") ? { report: values.get("report") } : {}),
    ...(values.get("batch-job") ? { batchJob: values.get("batch-job") } : {}),
    ...(values.get("model") ? { model: values.get("model") } : {}),
    maxChars: parsePositiveInt(
      values.get("max-chars"),
      DEFAULT_MAX_CHARS,
      "max-chars",
      errors,
    ),
    // 0 = no ceiling, which is the right default: at 4.8x + a 68 MB Node
    // floor, a 2 GiB task absorbs a 433 MB PDF and the largest object in the
    // archive is 222.3 MB. The flag exists for a SMALLER instance, not for
    // this one.
    maxFileMb: values.get("max-file-mb")
      ? parsePositiveInt(values.get("max-file-mb"), 0, "max-file-mb", errors)
      : 0,
    pilotFromParsed: values.get("pilot-from-parsed")
      ? parsePositiveInt(
          values.get("pilot-from-parsed"),
          0,
          "pilot-from-parsed",
          errors,
          MAX_LIMIT,
        )
      : 0,
    shard: resolveShard(values.get("shard"), process.env, errors),
    // The DEFAULT comes from the environment the job was PROVISIONED with, not
    // from a literal here. `setup-doc-ingest-backfill-job.sh` sizes
    // `DOC_CONVERT_CONTAINER_MI` as container-memory / concurrency, so the two
    // numbers must be the same one: a job provisioned for 2 slots that ran 4
    // would give every slot half the memory it actually has to share.
    concurrency: parsePositiveInt(
      values.get("concurrency") ?? process.env["DOC_CONVERT_CONCURRENCY"],
      DEFAULT_CONCURRENCY,
      "concurrency",
      errors,
      MAX_CONCURRENCY,
    ),
    pilotMaxPerSymbol: parsePositiveInt(
      values.get("pilot-max-per-symbol"),
      PILOT_DEFAULT_MAX_PER_SYMBOL,
      "pilot-max-per-symbol",
      errors,
    ),
    ...(pilotDocTypes && pilotDocTypes.length > 0 ? { pilotDocTypes } : {}),
    maxLines: parsePositiveInt(
      values.get("max-lines"),
      DEFAULT_MAX_BATCH_LINES,
      "max-lines",
      errors,
    ),
    maxBytes: parsePositiveInt(
      values.get("max-bytes"),
      DEFAULT_MAX_BATCH_BYTES,
      "max-bytes",
      errors,
    ),
    ...(files && files.length > 0 ? { files } : {}),
    ...(batchJobs && batchJobs.length > 0 ? { batchJobs } : {}),
  };

  if (args.subcommand === "batch-submit" && !args.file && !args.files) {
    errors.push(
      "batch-submit needs --file=<path to the JSONL from batch-build>, or " +
        "--files=a,b,c for a wave",
    );
  }
  if (args.subcommand === "batch-ingest" && !args.batchJob && !args.batchJobs) {
    errors.push(
      "batch-ingest needs --batch-job=<the name batch-submit printed, e.g. " +
        "batches/xyz>, or --batch-jobs=j1,j2 for a wave",
    );
  }
  if (args.compare && args.subcommand !== "batch-ingest") {
    errors.push("--compare is only meaningful for batch-ingest");
  }

  return { args, errors };
}

/**
 * Does this run write?
 *
 * `--dry-run` WINS over `--apply`. A flag can always narrow a run and never
 * widen one, which is the same polarity `xbrl-projection-drain` uses for its
 * environment arm — and it means a wrapper, a runbook or a muscle-memory
 * `--dry-run` appended to a copied command can never be defeated by an
 * `--apply` earlier in the line.
 */
function resolveApply(args: Args): boolean {
  return args.apply && !args.dryRun;
}

function describeApply(args: Args): string {
  const on = resolveApply(args);
  if (on) return "apply=true (WRITING)";
  if (args.apply && args.dryRun) {
    return "apply=false (DRY RUN — --apply was given but --dry-run narrows it)";
  }
  return "apply=false (DRY RUN — nothing is written; pass --apply to write)";
}

// ---------------------------------------------------------------------------
// COUNTERS — writes on one side of a wall, observations on the other
// ---------------------------------------------------------------------------

/**
 * Durable effects that LANDED. Nothing here may be incremented anywhere but
 * inside {@link countedWrite}.
 */
interface Writes {
  /** `scan-convert`: `${gcsPath}.md` objects written to GCS. */
  sidecars: number;
  /** `scan-convert`: rows whose convert stamps landed. */
  converted: number;
  /** `batch-build`: JSONL request lines flushed to disk. */
  lines: number;
  /** `batch-submit`: rows stamped BATCHED with the job id. */
  batched: number;
  /** `batch-ingest` / `sweep`: extract rows upserted. */
  extracts: number;
  /** `batch-ingest` / `sweep`: parse-status stamps that landed. */
  statuses: number;
}

function newWrites(): Writes {
  return {
    sidecars: 0,
    converted: 0,
    lines: 0,
    batched: 0,
    extracts: 0,
    statuses: 0,
  };
}

/**
 * Run a durable operation and count it — IN THAT ORDER.
 *
 * The one and only place a {@link Writes} counter may move. `op()` is awaited
 * FIRST and the counter advances only after it RESOLVES, so a throw leaves the
 * count where it was and a run that fails on every object reports zero rather
 * than reporting the number it attempted.
 *
 * That ordering is the whole point and it is not hypothetical:
 * `stock-document-sync` incremented each per-source counter before the call it
 * counted, so a source that 403s on every request kept producing a full-looking
 * number — which is how Tickertape's block went unnoticed for five months.
 * `doc-ingest-backfill-job-setup.test.ts` asserts that this file contains
 * EXACTLY ONE `writes` mutation and that it sits after the await.
 */
async function countedWrite<T>(
  writes: Writes,
  key: keyof Writes,
  /**
   * A number, or a function of the RESULT — because the honest count for a
   * `updateMany` is the driver's own `count`, which does not exist until the
   * call has returned. Taking `slice.length` instead would count what we asked
   * for rather than what landed, which is the defect this helper exists to
   * make impossible.
   */
  amount: number | ((result: T) => number),
  op: () => Promise<T>,
): Promise<T> {
  const result = await op();
  writes[key] += typeof amount === "function" ? amount(result) : amount;
  return result;
}

/** Observations. Deliberately a DIFFERENT object from {@link Writes}. */
type Tally = Record<string, number>;

function bump(tally: Tally, key: string, amount = 1): void {
  tally[key] = (tally[key] ?? 0) + amount;
}

// ---------------------------------------------------------------------------
// THE RUN
// ---------------------------------------------------------------------------

type StopReason =
  | "drained"
  | "budget"
  | "max-batches"
  | "dry-run"
  | "limit"
  | "failed";

interface RunOutcome {
  stop: StopReason;
  /** Rows this run took on. */
  selected: number;
  /** Rows the SAME predicate still matches after the run. */
  remaining: number;
  failed: number;
  transportFailures: number;
  writes: Writes;
  tally: Tally;
  /** Named so a reader does not have to infer it from the counters. */
  note?: string;
}

/**
 * WHY A RESPONSE PRODUCED NO JSON — MONEY-1332.
 *
 * `extractResponseText` returns the concatenated part text and nothing else,
 * which is right for the happy path and useless for a post-mortem: an EMPTY
 * string is returned for a truncated answer, a safety block, a refusal and a
 * malformed part list alike. The pilot hit 14 of 22 `unparseable` and the
 * compare could not say which of those four it was.
 *
 * `finishReason` distinguishes them at the source, and it is on the CANDIDATE,
 * not on the response — reading it off the wrong level yields undefined for
 * every answer, healthy or not, which reads as "the vendor does not send it".
 */
function readFinishDiagnostics(response: unknown): {
  finishReason: string | null;
  blockReason: string | null;
  candidateCount: number;
} {
  const r = response as
    | {
        candidates?: Array<{ finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
      }
    | undefined;
  return {
    finishReason: r?.candidates?.[0]?.finishReason ?? null,
    blockReason: r?.promptFeedback?.blockReason ?? null,
    candidateCount: r?.candidates?.length ?? 0,
  };
}

/* chain-decision:begin
 * SHOULD THIS RUN TRIGGER THE NEXT ONE — MONEY-1334.
 *
 * The conversion drain STALLED on 2026-09-02 and nobody noticed for a day: it
 * has no Cloud Scheduler entry, so it moved only while a hand-driven loop was
 * alive, and when that loop died the queue simply stopped draining. 44,028 PDFs
 * remained. A stall that produces no error, no alert and no metric is the
 * failure shape this repo has paid for repeatedly.
 *
 * ## The termination proof, which is NOT the BSE one
 *
 * `backfill-bse-results.ts` chains across a FIXED array of shards, so its bound
 * is the array length and it consults nothing. This drains an OPEN queue that
 * the weekly sync keeps adding to, so length is not available as a bound and a
 * naive "chain while work remains" never terminates.
 *
 * Three independent stops, and the FIRST is structural:
 *
 *   1. `depth + 1 >= MAX` — a fixed ceiling that consults no database, clock or
 *      queue. This alone bounds the chain at 20 links WHATEVER the data does.
 *   2. `converted === 0` — a run that made NO progress must not chain. Without
 *      this a permanently-failing head (a corrupt object, an expired
 *      credential) re-triggers itself 20 times, converting nothing and paying
 *      for 20 container starts to do it.
 *   3. `remaining === 0` — the queue is drained; nothing to continue.
 *
 * Only `budget` chains. `drained` means finished; `failed` must not re-run into
 * the same failure; `dry-run`, `limit` and `max-batches` are all operator
 * intent — a person asked for a bounded piece of work and a chain would
 * silently exceed what they asked for.
 */

/** A chain is at most this many links, whatever the queue does. */
export const SCAN_CONVERT_MAX_CHAIN_DEPTH = 20;

/**
 * Run `worker` over `items` with at most `limit` in flight — MONEY-1339.
 *
 * The conversion loop was strictly serial and measured 1.6 s per document
 * (13,570 documents in a 6 h run), almost all of it waiting: a GCS download, a
 * sidecar upload, two Mongo writes. 48,092 documents at that rate is ~21 h.
 * Overlapping the waits is the whole speed-up; the CPU parse is a small part
 * of each document.
 *
 * `shouldStop` is consulted BEFORE each item is claimed, so a budget that
 * expires mid-page stops new work without abandoning what is already running —
 * an abandoned document would have downloaded its bytes and paid its parse and
 * then not stamped, so the next run would do all of it again.
 *
 * NO ordering guarantee, and none is needed: the cursor is the
 * `scannedPageCount` STAMP on each row, not the position in this list. Two
 * workers can never claim the same document because the index is taken
 * synchronously — there is no `await` between reading `next` and incrementing
 * it, and this runtime is single-threaded, so the claim is atomic.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  shouldStop: () => boolean,
  worker: (item: T) => Promise<void>,
): Promise<{ started: number; stoppedEarly: boolean }> {
  let next = 0;
  let started = 0;
  let stoppedEarly = false;
  const slots = Math.max(1, Math.floor(limit));

  const runner = async (): Promise<void> => {
    for (;;) {
      if (shouldStop()) {
        stoppedEarly = true;
        return;
      }
      const index = next;
      if (index >= items.length) return;
      next = index + 1;
      started += 1;
      await worker(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: slots }, runner));
  return { started, stoppedEarly };
}

/** Documents in flight inside ONE task when `--concurrency` is not given. */
export const DEFAULT_CONCURRENCY = 4;
/**
 * Ceiling on in-flight documents — MONEY-1339.
 *
 * Peak RSS is 2.3-4.8x file size and the largest object in the archive is
 * 222.3 MB, so four slots against an 8Gi task is ~4.3 GB worst case. The
 * converter's own OOM refusal is sized PER SLOT by the provisioning script
 * (`DOC_CONVERT_CONTAINER_MI` = container MiB / concurrency), so raising this
 * without raising memory shrinks the largest document the job will accept —
 * the opposite of the intent. 8 is the point where that trade stops being
 * obviously safe on the sizes we provision.
 */
export const MAX_CONCURRENCY = 8;

/**
 * This task's shard, from the flag or from Cloud Run's own task variables.
 *
 * `--shard=i/n` wins when present. Otherwise Cloud Run sets
 * `CLOUD_RUN_TASK_INDEX` (0-based) and `CLOUD_RUN_TASK_COUNT` on EVERY task of
 * a multi-task execution, so a job provisioned with `--tasks=4` shards itself
 * with no argument at all — which matters because `gcloud run jobs execute`
 * passes ONE argument list to every task, so a per-task flag is not expressible
 * there in the first place.
 *
 * A single-task run resolves to `null`, meaning the whole corpus. That is the
 * unsharded behaviour this job has always had, and it stays the default: an
 * execution that reads `CLOUD_RUN_TASK_COUNT=1` is not sharded, it is one task.
 */
export function resolveShard(
  raw: string | undefined,
  env: Record<string, string | undefined>,
  errors: string[],
): { index: number; count: number } | null {
  const fromFlag = typeof raw === "string" && raw.trim() !== "";
  const text = fromFlag
    ? raw.trim()
    : `${env["CLOUD_RUN_TASK_INDEX"] ?? ""}/${env["CLOUD_RUN_TASK_COUNT"] ?? ""}`;

  const m = /^(\d+)\/(\d+)$/.exec(text);
  if (!m) {
    if (fromFlag) errors.push(`--shard=${raw} is not of the form i/n`);
    return null;
  }
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1) {
    if (fromFlag) errors.push(`--shard=${raw} has a count below 1`);
    return null;
  }
  if (index >= count) {
    // REFUSED, never clamped. A clamp would silently hand two tasks the same
    // slice and leave another slice unconverted, and the run would report a
    // drained queue on both.
    errors.push(
      `--shard=${text} is out of range: index must be 0..${count - 1}`,
    );
    return null;
  }
  return count === 1 ? null : { index, count };
}

export function shouldChainScanConvert(opts: {
  depth: number;
  converted: number;
  remaining: number;
  stop: string;
  apply: boolean;
  /** Tasks in this execution. > 1 means the run is SHARDED. */
  taskCount: number;
}): { chain: boolean; reason: string } {
  if (!opts.apply) {
    // A dry run must never start a real one. It is the one mode whose whole
    // contract is that nothing happens.
    return { chain: false, reason: "dry-run" };
  }
  // A SHARDED RUN DOES NOT CHAIN — MONEY-1339.
  //
  // `triggerNextScanConvert` posts ONE `jobs:run` with a container override,
  // and an override carries no task index: the follow-up execution would run
  // its full `--tasks` fan-out again, so N tasks chaining once produce N full
  // executions, each of N tasks. At depth 20 that is exponential, against a
  // metered container budget, for a queue four parallel tasks drain inside a
  // single 24h task timeout anyway.
  //
  // Checked BEFORE `stop`, deliberately: a sharded task that exhausts its
  // budget must say "sharded" rather than "budget-exhausted-with-work-
  // remaining", or the log would recommend exactly the thing this refuses.
  if (opts.taskCount > 1) {
    return { chain: false, reason: `sharded (${opts.taskCount} tasks)` };
  }
  if (opts.stop !== "budget") {
    return { chain: false, reason: `stop=${opts.stop}` };
  }
  if (opts.converted <= 0) {
    return { chain: false, reason: "no-progress" };
  }
  if (opts.remaining <= 0) {
    return { chain: false, reason: "queue-empty" };
  }
  if (opts.depth + 1 >= SCAN_CONVERT_MAX_CHAIN_DEPTH) {
    return { chain: false, reason: "max-depth" };
  }
  return { chain: true, reason: "budget-exhausted-with-work-remaining" };
}
/* chain-decision:end */

/* pilot-decisions:begin
 * THE TWO DECISIONS THAT MADE THE 2026-09-02 PILOT REPORT SUCCESS ON NOTHING.
 *
 * Both are pure and both are lifted and EXECUTED by
 * `doc-ingest-pilot-decisions.test.ts` — a source-text assertion could not
 * promise what these need to promise, which is that mutating them fails a test.
 *
 * MEASURED, and the reason this region exists: of 1,404 `parseStatus: PARSED`
 * documents on prod, only 202 carry a markdown sidecar. 1,201 have
 * `convertStatus` ABSENT. The pilot selected 25 from the wrong 1,201, built
 * ZERO lines, and exited 0.
 */

/** `stock_documents` values these decisions compare against. Local by design —
 * the region is lifted into a standalone module, so it may not import. */
export const PILOT_REQUIRED_CONVERT_STATUS = "CONVERTED";

/**
 * Narrow pilot candidates to the ones a batch line can actually be built from.
 *
 * An EXTRACTED row proves the OLD lane read the document; the SIDECAR is what
 * the BATCH lane reads. They are different facts and only the second is a
 * precondition here.
 *
 * The equality is deliberate and its DIRECTION is the safe one. On Mongo an
 * absent attribute matches neither `{f: v}` nor `{f: {not: v}}`, so absent rows
 * are dropped either way — and dropping them is what this gate wants. Do NOT
 * rewrite it as a negation ("everything that is not PENDING"): that spelling
 * reads as wider and is not, and it is how MONEY-1050/1205/1234/1236 happened.
 */
export function buildPilotSidecarWhere(
  candidateIds: readonly string[],
  docTypes?: readonly string[],
): Record<string, unknown> {
  return {
    id: { in: [...candidateIds] },
    convertStatus: PILOT_REQUIRED_CONVERT_STATUS,
    ...(docTypes && docTypes.length > 0
      ? { docType: { in: [...docTypes] } }
      : {}),
  };
}

/** Documents one symbol may contribute to a pilot when nothing says otherwise. */
export const PILOT_DEFAULT_MAX_PER_SYMBOL = 2;

/**
 * Request lines per submitted batch file, and bytes per file — MONEY-1345.
 *
 * The drain is ~50,800 documents against a lane that takes ONE input file per
 * job, so the whole corpus cannot be one submission. These are the shipped
 * defaults; the live per-job ceilings must be READ from the vendor's own
 * documentation and set here before the tail waves run, never carried over
 * from memory — this repo's own EOD parser swapped open and close for exactly
 * that reason.
 */
export const DEFAULT_MAX_BATCH_LINES = 20_000;
export const DEFAULT_MAX_BATCH_BYTES = 900 * 1024 * 1024;

/**
 * Split built request lines into files that fit BOTH ceilings.
 *
 * A line is never split and never dropped: each is one document's whole
 * request, and half a request is a paid call that cannot be attributed. A
 * single line larger than `maxBytes` therefore gets a file of its own rather
 * than being discarded — the submission will fail loudly on that one document
 * instead of the drain silently losing it.
 *
 * The byte count includes the newline each line carries in the written file,
 * so the sum this computes is the size the file actually has. Counting the
 * payload alone would understate a 20,000-line file by 20 KB, which is the
 * kind of small, systematic undercount that only shows up at the ceiling.
 */
export function splitBatchLines(
  lines: readonly string[],
  opts: { maxLines: number; maxBytes: number },
): string[][] {
  const maxLines = Math.max(1, Math.floor(opts.maxLines));
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes));

  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf-8") + 1;
    const wouldOverflow =
      current.length > 0 &&
      (current.length + 1 > maxLines || bytes + size > maxBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** `out.jsonl` -> `out-000.jsonl`. One file keeps the caller's name. */
export function batchChunkPath(
  out: string,
  index: number,
  total: number,
): string {
  if (total <= 1) return out;
  const dot = out.lastIndexOf(".");
  const stem = dot > out.lastIndexOf("/") && dot > 0 ? out.slice(0, dot) : out;
  const ext = dot > out.lastIndexOf("/") && dot > 0 ? out.slice(dot) : "";
  return `${stem}-${String(index).padStart(3, "0")}${ext}`;
}

/**
 * Deal `n` documents across as many SYMBOLS as possible — MONEY-1344.
 *
 * ## Why a pilot needs this at all
 *
 * The 2026-09-02 pilot drew 25 documents from SIX companies. BONLON alone
 * contributed 5 of the 10 that failed on scanned statement pages, and
 * GOYALALUM 3. Its headline rates were therefore a property of a handful of
 * small-cap filers, not of the corpus — and the pilot is the gate that decides
 * whether to spend a four-figure drain.
 *
 * The cause is structural rather than unlucky: candidates are paged from
 * `document_financial_extracts` ordered by `id`, and one document contributes
 * ~4 rows (two periods x two bases) while one SYMBOL contributes as many
 * documents as it has annual reports. Taking the first `n` therefore
 * concentrates on whoever happens to sit early in the key space.
 *
 * ## Round-robin, not "first n under a cap"
 *
 * Both bound a symbol's share, but they differ when `n` is smaller than the
 * candidate pool — which is the normal case. A greedy cap fills from the front
 * and still returns 100 documents from 50 symbols when 400 symbols were
 * available; dealing one document per symbol per pass reaches 100 symbols
 * first and only doubles up once every symbol has one.
 *
 * Ordering INSIDE a symbol is preserved (the caller's page order), and symbols
 * are visited in first-seen order, so the result is deterministic for a given
 * input — a pilot that samples differently on a re-run cannot be compared with
 * its predecessor.
 */
export function pickRoundRobin(
  rows: ReadonlyArray<{ id: string; symbol: string }>,
  n: number,
  maxPerSymbol: number,
): string[] {
  if (n <= 0 || maxPerSymbol <= 0) return [];

  const bySymbol = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = bySymbol.get(row.symbol);
    if (bucket) bucket.push(row.id);
    else bySymbol.set(row.symbol, [row.id]);
  }

  const picked: string[] = [];
  for (let pass = 0; pass < maxPerSymbol && picked.length < n; pass++) {
    for (const bucket of bySymbol.values()) {
      if (picked.length >= n) break;
      const id = bucket[pass];
      if (id !== undefined) picked.push(id);
    }
  }
  return picked;
}

/**
 * Did a PILOT run select work and produce nothing?
 *
 * A pilot exists to be compared against a known answer. Zero lines means there
 * is nothing to compare, so the run proves nothing and must not exit 0 —
 * whatever the cause. That is the point: the missing sidecar gate is ONE cause,
 * and a GCS outage, a renamed sidecar key or a new tally bucket are three more
 * that no query-shape test would ever catch.
 *
 * Scoped to pilots on purpose. An ORDINARY run selecting rows and building no
 * lines can be legitimate — a page of genuinely unconvertible documents — and
 * failing it would cry wolf during a real drain.
 */
export function pilotBuiltNothing(opts: {
  pilot: boolean;
  selected: number;
  linesBuilt: number;
}): boolean {
  // `selected > 0` USED TO BE HERE and it was a hole — MONEY-1334.
  //
  // The MONEY-1332 selector repair moved the very failure this guards into the
  // `selected === 0` branch: `pickPilotDocumentIds` now returns [] when no
  // candidate carries a sidecar, `where` becomes `{ id: { in: [] } }`, and the
  // run reported stop:"drained" -> EXIT.OK. So the predicate excused the exact
  // shape its own docblock forbids, and a test pinned the gap as intended
  // behaviour ("passes when a pilot legitimately selected nothing").
  //
  // On prod only 202 of 1,404 PARSED documents are CONVERTED, so an empty
  // intersection is ordinary rather than hypothetical.
  //
  // There is no such thing as a pilot that legitimately built nothing. A pilot
  // exists to be compared against a known answer; zero lines means there is
  // nothing to compare and the run proved nothing, whether it selected 25
  // documents or none. WHICH failure it was belongs in the warning — the caller
  // already reports "no EXTRACTED rows at all" and "EXTRACTED rows exist, none
  // converted" separately — never in the exit code.
  return opts.pilot && opts.linesBuilt === 0;
}
/* pilot-decisions:end */

function exitCodeFor(outcome: RunOutcome): number {
  if (outcome.stop === "failed") return EXIT.FAILED;
  if (outcome.stop === "budget" || outcome.stop === "max-batches") {
    return EXIT.INCOMPLETE;
  }
  return EXIT.OK;
}

function gb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(3);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A clock the loops check BETWEEN documents. */
class Budget {
  private readonly startedAt = Date.now();
  private batches = 0;

  constructor(
    private readonly budgetMs: number,
    private readonly maxBatches: number,
  ) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Null while there is room; a stop reason when there is not. */
  check(): StopReason | null {
    if (this.elapsedMs() >= this.budgetMs) return "budget";
    if (this.batches >= this.maxBatches) return "max-batches";
    return null;
  }

  countBatch(): void {
    this.batches += 1;
  }
}

// ---------------------------------------------------------------------------
// THE CONVERTER SEAM
// ---------------------------------------------------------------------------

/**
 * The specifier is a CONST rather than a literal in the `import()` so this file
 * type-checks in a tree where the package is not installed — which is the tree
 * we are in. TypeScript does not resolve a non-literal dynamic import, so the
 * absence is a RUNTIME failure with a named cause instead of a compile error
 * that would have to be suppressed.
 */
const CONVERTER_SPECIFIER = "@firecrawl/pdf-inspector";

/** `(bytes) -> pages`, 0-indexed `page`, `""` markdown on an OCR-bound page. */
type ConvertFn = (bytes: Buffer) => Promise<ExtractedPage[]>;

/**
 * Coerce whatever the library returned into {@link ExtractedPage}[].
 *
 * Validated rather than cast. Three shapes from the measurement matter and each
 * would be silently wrong if assumed:
 *
 *   - `markdown` is `""` on an OCR-bound page, NEVER null/undefined, so a
 *     `?? null` normalisation would erase the only signal the empty-string test
 *     in `pageNeedsOcr` has;
 *   - `ocrReason` is ABSENT from the object on the garbage-text-layer scans
 *     (keys are exactly `["page","markdown","needsOcr"]`), so it is optional
 *     here and is never required;
 *   - `pages[].page` is 0-INDEXED while `extractPagesMarkdown().pagesNeedingOcr`
 *     is 1-indexed. Nothing here reads the latter — `assessExtraction` derives
 *     the OCR list from `pages` so the two index bases can never be crossed.
 */
function toExtractedPages(raw: unknown): ExtractedPage[] | null {
  const container = Array.isArray(raw)
    ? raw
    : (raw as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(container)) return null;

  const out: ExtractedPage[] = [];
  for (const entry of container) {
    if (!entry || typeof entry !== "object") return null;
    const rec = entry as Record<string, unknown>;
    const page = rec["page"];
    const markdown = rec["markdown"];
    const needsOcr = rec["needsOcr"];
    if (typeof page !== "number" || !Number.isFinite(page)) return null;
    if (typeof markdown !== "string") return null;
    const reason = rec["ocrReason"];
    out.push({
      page,
      markdown,
      needsOcr: needsOcr === true,
      ...(typeof reason === "string" ? { ocrReason: reason } : {}),
    });
  }
  return out;
}

/**
 * Load the converter, or explain precisely why there is none.
 *
 * FAILS CLOSED. `@firecrawl/pdf-inspector` is not declared in any workspace
 * package.json at the time of writing, so this throws on every environment
 * today — which is the correct outcome. The alternative, a `scan-convert` that
 * treats a missing converter as "no pages" and stamps 79,884 documents
 * SCANNED_ONLY, is unrecoverable without a hand `$unset`.
 */
async function loadConverter(): Promise<ConvertFn> {
  let mod: unknown;
  try {
    mod = await import(CONVERTER_SPECIFIER);
  } catch (err) {
    throw new Error(
      `${CONVERTER_SPECIFIER} could not be loaded (${errText(err)}). It is ` +
        "NOT a declared dependency of any workspace in this repo — add it to " +
        "workers/package.json (measured at 1.17.0, ~10 MB, prebuilt napi " +
        "binary on musl/x64, see docs/reference/doc-convert-decision.md) and " +
        "rebuild the workers image. Refusing to run rather than stamping the " +
        "corpus SCANNED_ONLY from an absent converter.",
    );
  }

  const rec = mod as Record<string, unknown>;
  const candidate =
    rec["extractPagesMarkdownAsync"] ?? rec["extractPagesMarkdown"];
  if (typeof candidate !== "function") {
    throw new Error(
      `${CONVERTER_SPECIFIER} loaded but exports neither ` +
        "extractPagesMarkdownAsync nor extractPagesMarkdown. Routing on " +
        "classifyPdf is NOT an acceptable fallback: it reported " +
        "TextBased/1.00 on five of twenty-two documents that then extracted " +
        "to zero characters, four of them BSE quarterly_result — the largest " +
        "docType in the archive.",
    );
  }
  const fn = candidate as (bytes: Uint8Array) => unknown;

  return async (bytes: Buffer): Promise<ExtractedPage[]> => {
    const raw: unknown = await fn(bytes);
    const pages = toExtractedPages(raw);
    if (pages === null) {
      throw new Error(
        "the converter returned a shape this job does not recognise — " +
          "expected an array of { page:number, markdown:string, " +
          "needsOcr:boolean } or an object carrying one at `pages`",
      );
    }
    return pages;
  };
}

// ---------------------------------------------------------------------------
// MARKDOWN SIDECARS
// ---------------------------------------------------------------------------

/**
 * `${gcsPath}.md`, from the STORED path.
 *
 * Never recomputed from symbol/docType/period: `buildFullDocPath`'s filename
 * sanitizer strips `.` and `-` while its directory sanitizer keeps them, so a
 * recomputed key is not guaranteed to land beside the object it belongs to.
 */
function sidecarKey(gcsPath: string): string {
  return `${gcsPath}.md`;
}

/** The marker `joinPagesToMarkdown` writes. Split and join must agree. */
const PAGE_MARKER = /^<!-- page (\d+) -->$/gm;

/**
 * Sidecar -> pages, the inverse of `joinPagesToMarkdown`.
 *
 * The sidecar is ONE markdown document, so page selection has to recover the
 * page boundaries from the markers the converter wrote. That coupling is real
 * and is stated here rather than discovered: if `joinPagesToMarkdown` ever
 * changes its marker, this returns a single page and the selector silently
 * degrades from "the four statement pages" to "the first 40,000 characters of a
 * 300-page annual report" — plausible, cheap, and wrong.
 *
 * Returns 1-INDEXED page numbers, as `DocPage` requires.
 */
function splitMarkdownPages(markdown: string): DocPage[] {
  const pages: DocPage[] = [];
  const marks: Array<{ index: number; end: number; page: number }> = [];
  PAGE_MARKER.lastIndex = 0;
  for (
    let m = PAGE_MARKER.exec(markdown);
    m !== null;
    m = PAGE_MARKER.exec(markdown)
  ) {
    marks.push({
      index: m.index,
      end: m.index + m[0].length,
      page: Number(m[1]),
    });
  }
  if (marks.length === 0) {
    const body = markdown.trim();
    return body ? [{ pageNumber: 1, markdown: body }] : [];
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark === undefined) continue;
    const next = marks[i + 1];
    const body = markdown
      .slice(mark.end, next?.index ?? markdown.length)
      .trim();
    if (body) pages.push({ pageNumber: mark.page, markdown: body });
  }
  return pages;
}

/** Selected pages -> one markdown blob, markers intact so page refs survive. */
function joinDocPages(pages: readonly DocPage[]): string {
  return pages
    .map((p) => `\n\n<!-- page ${p.pageNumber} -->\n\n${p.markdown.trim()}`)
    .join("")
    .trim();
}

// ---------------------------------------------------------------------------
// SHARED PERSISTENCE
// ---------------------------------------------------------------------------

/** The row shape every subcommand reads. */
const DOC_SELECT = {
  id: true,
  instrumentId: true,
  symbol: true,
  exchange: true,
  docType: true,
  period: true,
  title: true,
  gcsPath: true,
  mimeType: true,
  fileSize: true,
  convertStatus: true,
  markdownGcsPath: true,
  scannedPageCount: true,
  textPageCount: true,
  parseStatus: true,
} as const;

type DocRow = {
  id: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  docType: string;
  period: string;
  title: string | null;
  gcsPath: string;
  mimeType: string;
  fileSize: number;
  convertStatus: string | null;
  markdownGcsPath: string | null;
  scannedPageCount: number | null;
  textPageCount: number | null;
  parseStatus: string | null;
};

function whereOf(q: Record<string, unknown>): Prisma.StockDocumentWhereInput {
  return q as unknown as Prisma.StockDocumentWhereInput;
}

/**
 * Upsert one reading, keyed `(documentId, periodEnd, periodType, basis)`.
 *
 * Deliberately the SAME key and the SAME figure set as the parse worker's
 * private `upsertExtract`, because an upsert here must REPLACE that writer's
 * row rather than collide with it. It is safe in a way a `stock_financials`
 * write is not: this table's key carries `documentId` and `basis`, so the row
 * being replaced is a reading of the SAME document under the SAME basis and is
 * reproducible from the stamped `(model, promptVersion)` pair.
 *
 * The duplication is a known cost and the mitigation is that both sides stamp
 * `DOC_FINANCIALS_PROMPT_VERSION` from the one exported constant, so a prompt
 * change cannot leave the two writers claiming the same provenance for
 * different prompts. Collapsing them into one exported helper is a
 * workers/-side change and is out of this job's scope.
 */
async function upsertExtract(input: {
  documentId: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  model: string;
  row: MappedExtract;
  /** The gate's whole verdict — see `buildExtractWritePayload` (MONEY-1340). */
  verdict: Pick<ExtractionVerdict, "status" | "reasons" | "warnings">;
}): Promise<void> {
  const { row } = input;
  // ONE payload, built in core. The online worker calls the same builder, so a
  // column cannot be added to one writer and missed by the other.
  const figures = buildExtractWritePayload(row, input.verdict, input.model);

  await prisma.documentFinancialExtract.upsert({
    where: {
      documentId_periodEnd_periodType_basis: {
        documentId: input.documentId,
        periodEnd: row.periodEnd,
        periodType: row.periodType,
        basis: row.basis,
      },
    },
    create: {
      documentId: input.documentId,
      instrumentId: input.instrumentId,
      symbol: input.symbol,
      exchange: input.exchange,
      periodEnd: row.periodEnd,
      periodType: row.periodType,
      basis: row.basis,
      ...figures,
    },
    update: figures,
  });
}

// ---------------------------------------------------------------------------
// 1. scan-convert
// ---------------------------------------------------------------------------

/**
 * GCS -> markdown sidecar, and the stamps that ARE the cursor.
 *
 * `scannedPageCount: { isSet: false }` is the resume position — an O(1) index
 * seek, not a walk that re-verifies finished work. Nothing here writes a
 * checkpoint row and none is wanted.
 *
 * The magic-byte check comes BEFORE the conversion, not after: four of the six
 * largest objects in the archive are not PDFs at all (a raw multipart upload
 * envelope stored verbatim, twice; a ZIP; a truncated PDF), all stored under
 * `mimeType: "application/pdf"` with plausible metadata. Rejecting them on the
 * header costs nothing and saves up to 618 MB of RSS each. Magic bytes CANNOT
 * catch the truncated one — only the library's own "Invalid PDF structure"
 * does, which is why the conversion is also wrapped.
 */
async function runScanConvert(args: Args, writes: Writes): Promise<RunOutcome> {
  const apply = resolveApply(args);
  const tally: Tally = {};
  const budget = new Budget(args.budgetMs, args.maxBatches);

  // `AND`, never a spread — MONEY-1339. Both objects carry a top-level `OR`
  // (the convert query's status arms; the shard's prefix arms), so merging them
  // key-by-key would drop the status arms and select the whole corpus.
  const convertWhere = buildConvertQuery({
    unscannedOnly: !args.rescan,
    // `--rescan` means "look again at what was already decided", and a
    // FAILED stamp is the decision most worth revisiting: the backfill used
    // to write it on documents the worker converts fine. Without this the
    // flag dropped only the scan cursor and re-read none of the stamped
    // rows, so its own help text ("re-reads all") was false.
    includeFailed: args.rescan === true,
    ...(args.docTypes ? { docTypes: args.docTypes } : {}),
    ...(args.symbols ? { symbols: args.symbols } : {}),
  });
  const where = whereOf(
    args.shard
      ? {
          AND: [
            convertWhere,
            buildShardWhere(args.shard.index, args.shard.count),
          ],
        }
      : convertWhere,
  );

  const remainingBefore = await prisma.stockDocument.count({ where });
  log.info(
    `scan-convert: ${remainingBefore} document(s) match the convert selector ` +
      `(unscannedOnly=${!args.rescan}). Corpus reference: 79,884 PDF rows, ` +
      "72,650 with a usable gcsPath, 309.8 GB.",
  );

  let convert: ConvertFn;
  try {
    convert = await loadConverter();
  } catch (err) {
    log.error(errText(err));
    return {
      stop: "failed",
      selected: 0,
      remaining: remainingBefore,
      failed: 0,
      transportFailures: 0,
      writes,
      tally,
      note: "the converter could not be loaded — nothing was read or written",
    };
  }

  let selected = 0;
  let failed = 0;
  let stop: StopReason = "drained";
  let cursorId: string | undefined;

  while (true) {
    const stopNow = budget.check();
    if (stopNow) {
      stop = stopNow;
      break;
    }
    budget.countBatch();

    const page: DocRow[] = await prisma.stockDocument.findMany({
      where,
      select: DOC_SELECT,
      take: args.limit,
      orderBy: { id: "asc" },
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (page.length === 0) {
      stop = "drained";
      break;
    }
    cursorId = page[page.length - 1]?.id;

    // ONE DOCUMENT, start to finish. Extracted from the serial loop so a pool
    // can overlap the waits — MONEY-1339. Every former `continue` is a
    // `return`: this function IS one iteration.
    const convertOne = async (doc: DocRow): Promise<void> => {
      selected++;
      const label = `${doc.symbol} (${doc.docType}/${doc.period})`;

      try {
        assertSafeObjectKey(doc.gcsPath);
      } catch (err) {
        bump(tally, "unsafeKey");
        log.warn(`${label}: ${errText(err)}`);
        return;
      }

      if (args.maxFileMb > 0 && doc.fileSize > args.maxFileMb * 1024 * 1024) {
        // Peak RSS is 2.3-4.8x file size, measured. This flag exists for an
        // instance SMALLER than the 2 GiB the job ships with; the default is
        // off because the largest object (222.3 MB) needs ~1.13 GB.
        bump(tally, "skippedTooLarge");
        log.info(
          `${label}: ${doc.fileSize} bytes would peak near ` +
            `${estimatePeakRssBytes(doc.fileSize)} — over --max-file-mb`,
        );
        return;
      }

      let bytes: Buffer;
      try {
        bytes = await downloadFromGCS(doc.gcsPath);
      } catch (err) {
        failed++;
        bump(tally, "downloadFailed");
        log.warn(`${label}: GCS read failed — ${errText(err)}`);
        return;
      }
      bump(tally, "downloaded");
      bump(tally, "bytesRead", bytes.length);

      // PEEL BEFORE TESTING. A stored MONEY-1169 multipart envelope begins
      // `--<uuid>` and the INTACT PDF starts 38 bytes further in — two of the
      // six largest objects sampled are exactly that. Testing the envelope's
      // own first bytes calls a 212 MB perfectly good annual report "not a
      // PDF" and, because that verdict is written as `convertStatus: FAILED`
      // (which no query selects and `--rescan` cannot reach), loses it
      // permanently. The worker peels first; this did not.
      if (isMultipartEnvelope(bytes)) {
        const stripped = stripMultipartEnvelope(bytes);
        if (stripped) {
          bump(tally, "envelopePeeled");
          bytes = stripped.payload;
        }
      }

      // MAGIC BYTES — after the peel, before the conversion and any RSS.
      if (!looksLikePdf(bytes)) {
        bump(tally, "notPdf");
        log.warn(`${label}: not a PDF — ${describeNonPdf(bytes)}`);
        if (apply) {
          await countedWrite(writes, "converted", 1, () =>
            prisma.stockDocument.update({
              where: { id: doc.id },
              data: {
                convertStatus: CONVERT_STATUS.FAILED,
                scannedPageCount: 0,
                textPageCount: 0,
                convertedAt: new Date(),
              },
            }),
          );
        }
        return;
      }

      let extracted: ExtractedPage[];
      try {
        extracted = await convert(bytes);
      } catch (err) {
        failed++;
        bump(tally, "convertThrew");
        log.warn(`${label}: conversion failed — ${errText(err)}`);
        if (apply) {
          await countedWrite(writes, "converted", 1, () =>
            prisma.stockDocument.update({
              where: { id: doc.id },
              data: {
                convertStatus: CONVERT_STATUS.FAILED,
                scannedPageCount: 0,
                textPageCount: 0,
                convertedAt: new Date(),
              },
            }),
          );
        }
        return;
      }

      // ROUTED ON EXTRACTION OUTPUT, never on classifyPdf. See the header of
      // doc-convert-logic.ts: classify reported TextBased/1.00 on five of
      // twenty-two documents that extracted to zero characters.
      const assessment = assessExtraction(extracted);
      bump(tally, `status:${assessment.status}`);
      bump(tally, "pagesSeen", assessment.totalPageCount);
      bump(tally, "pagesOcrBound", assessment.scannedPageCount);

      if (!apply) {
        log.info(
          `${label}: WOULD stamp ${assessment.status} ` +
            `(${assessment.textPageCount} text / ${assessment.scannedPageCount} ` +
            `OCR of ${assessment.totalPageCount})`,
        );
        return;
      }

      let sidecar: string | null = null;
      if (assessment.status === "CONVERTED") {
        const key = sidecarKey(doc.gcsPath);
        const body = joinPagesToMarkdown(extracted);
        try {
          await countedWrite(writes, "sidecars", 1, () =>
            uploadToGCS(key, Buffer.from(body, "utf-8"), "text/markdown"),
          );
          sidecar = key;
        } catch (err) {
          failed++;
          bump(tally, "sidecarWriteFailed");
          log.warn(`${label}: sidecar write failed — ${errText(err)}`);
          return;
        }
      }

      // The stamp lands LAST. A row that claims CONVERTED with no sidecar is
      // the one state `decideIngestLane` cannot trust — it re-converts on the
      // grounds that "the artifact wins" — so writing the status before the
      // object would manufacture exactly that disagreement on every failure.
      try {
        await countedWrite(writes, "converted", 1, () =>
          prisma.stockDocument.update({
            where: { id: doc.id },
            data: {
              convertStatus: assessment.status,
              textPageCount: assessment.textPageCount,
              scannedPageCount: assessment.scannedPageCount,
              convertedAt: new Date(),
              ...(sidecar ? { markdownGcsPath: sidecar } : {}),
            },
          }),
        );
      } catch (err) {
        failed++;
        bump(tally, "stampFailed");
        log.warn(`${label}: stamp failed — ${errText(err)}`);
      }
    };

    // Budget is consulted BEFORE each document is claimed, so an expiring run
    // stops taking new work and still finishes what is in flight — an
    // abandoned document would have paid its download and parse and stamped
    // nothing, so the next run would repeat all of it.
    let midStop: StopReason | null = null;
    await runPool(
      page,
      args.concurrency,
      () => {
        const s = budget.check();
        if (s) midStop = s;
        return s !== null;
      },
      convertOne,
    );
    if (midStop !== null) {
      stop = midStop;
      break;
    }

    log.info(
      `page done: selected ${selected}, converted ${writes.converted}, ` +
        `sidecars ${writes.sidecars}, read ${gb(tally["bytesRead"] ?? 0)} GB, ` +
        `elapsed ${Math.round(budget.elapsedMs() / 1000)}s`,
    );

    if (!apply) {
      // Nothing was stamped, so the identical page would be selected again.
      // Saying so beats spinning to the task timeout and calling it a drain.
      stop = "dry-run";
      break;
    }
  }

  const remaining = await prisma.stockDocument.count({ where });
  return {
    stop,
    selected,
    remaining,
    failed,
    transportFailures: 0,
    writes,
    tally,
    ...(apply
      ? {}
      : {
          note:
            "DRY RUN: one page only. Nothing was stamped, so `remaining` has " +
            "not moved and a second page would select the same rows.",
        }),
  };
}

// ---------------------------------------------------------------------------
// 2. batch-build
// ---------------------------------------------------------------------------

/**
 * Documents that ALREADY hold a successful extract — the pilot population.
 *
 * The point of a pilot is a KNOWN ANSWER to compare against, and the only
 * durable record of one is an `EXTRACTED` row. Selected from the extract table
 * rather than from `parseStatus`, because the status is a claim about the rows
 * and the rows are the evidence.
 *
 * Scanned with a bounded `take` and de-duplicated in JS: this table holds one
 * row per (document, period, basis), so the raw rows outnumber the documents
 * several-fold, and Prisma's Mongo `distinct` de-duplicates in the CLIENT
 * anyway — it would stream the same rows and hide the cost.
 */
async function pickPilotDocumentIds(
  n: number,
  opts: { maxPerSymbol: number; docTypes?: readonly string[] },
): Promise<{ ids: string[]; extractedSeen: number; symbols: number }> {
  // PAGE THE INTERSECTION; NEVER SAMPLE THEN INTERSECT.
  //
  // This function used to take the newest `n * 25` EXTRACTED rows and filter
  // them. MEASURED on prod 2026-09-02, that returns NOTHING: the 202 documents
  // that hold both a sidecar and a ground-truth answer were extracted on
  // 2026-08-27, while the newest-625 window floors at 2026-09-01. `scan-convert`
  // ran once, on one day; the old parse lane has produced extracts every day
  // since. A recency window intersected with a population that does not
  // correlate with recency is a SAMPLING bug wearing a filter's clothes, and it
  // fails exactly the way the missing `convertStatus` gate did — an empty
  // selection and a clean exit.
  //
  // So the walk is ordered by a STABLE key and continues until it has `n` or the
  // extracts are exhausted. `MAX_SCAN` is a runaway guard, not a window: it is
  // ~10x the live population (4,983 EXTRACTED rows), and reaching it is reported
  // rather than silently treated as "none exist".
  const PAGE = 1_000;
  const MAX_SCAN = 50_000;

  // ELIGIBLE ROWS ARE ACCUMULATED, then dealt — MONEY-1344. The old loop
  // pushed greedily per page, which cannot spread across symbols: the deal has
  // to see the whole pool to give each symbol a turn before any symbol gets a
  // second document.
  const eligible: Array<{ id: string; symbol: string }> = [];
  const candidates = new Set<string>();
  let picked: string[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  while (picked.length < n && scanned < MAX_SCAN) {
    const rows = await prisma.documentFinancialExtract.findMany({
      where: { status: "EXTRACTED" },
      select: { id: true, documentId: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1]?.id;

    const fresh = rows
      .map((r) => r.documentId)
      .filter((id) => !candidates.has(id));
    for (const id of fresh) candidates.add(id);
    if (fresh.length === 0) continue;

    // THE SIDECAR IS A PRECONDITION, not a detail. An EXTRACTED row proves the
    // OLD lane read this document; it says nothing about whether the BATCH lane
    // can. batch-build reads `${gcsPath}.md`, which only scan-convert writes.
    const converted = await prisma.stockDocument.findMany({
      where: buildPilotSidecarWhere(fresh, opts.docTypes),
      select: { id: true, symbol: true },
      // NO `take` sized from what is still MISSING. Under a per-symbol cap the
      // shortfall is not a document count — 40 more documents from one symbol
      // fills nothing — so the page is read whole and the deal decides.
    });
    for (const row of converted) eligible.push(row);

    // Stop as soon as the deal can actually be satisfied, so a pilot that
    // reaches its breadth on page one does not walk the rest of the table.
    picked = pickRoundRobin(eligible, n, opts.maxPerSymbol);
  }

  const symbols = new Set(
    picked
      .map((id) => eligible.find((r) => r.id === id)?.symbol)
      .filter((sym): sym is string => sym !== undefined),
  ).size;
  return { ids: picked, extractedSeen: candidates.size, symbols };
}

/**
 * Converted markdown -> one JSONL of `buildBatchRequestLine` lines.
 *
 * The correlation key rides at `metadata.key` and carries the `documentId` —
 * PROBED, not read: a live `batchGenerateContent` accepted exactly that shape
 * on 2026-09-01. `batch-submit` reads the ids back out of this file, so the
 * JSONL is its own manifest and there is no second artifact to keep in step.
 */
/**
 * Record that the BATCH lane refused this document — MONEY-1373.
 *
 * The refusal is a real, terminal outcome for THIS lane and has to be written
 * as one. Leaving the row untouched is what made the two refusal branches
 * re-select the same documents on every wave: `fetchedAt asc` ordering plus a
 * row that never changes is a queue head that never moves.
 *
 * `FAILED_BATCH` rather than a new status, because the vocabulary already
 * means this: "the batch lane could not produce an answer; sweepable through
 * the ONLINE path". Three things follow from that one word and all three are
 * load-bearing:
 *
 *   - `buildSweepQuery` ALREADY admits FAILED_BATCH, so these documents gain a
 *     selector without one being written (MONEY-1369 for this cohort);
 *   - the selector above now EXCLUDES it, so the batch lane stops re-reading
 *     what it has already judged;
 *   - `runSweep` passes `untrustedMarkdown` for it, so `decideIngestLane` sends
 *     it to whole-PDF vision rather than back to the markdown it just refused.
 *
 * NOT stamped on a dry run. A dry run's whole contract is that nothing happens,
 * and stamping here would burn the corpus on a rehearsal — the same shape as
 * the create-suppression bug in the XBRL projection.
 */
async function stampRefusedByBatchLane(
  id: string,
  writes: Writes,
  apply: boolean,
): Promise<void> {
  if (!apply) return;
  try {
    await countedWrite(writes, "statuses", 1, () =>
      prisma.stockDocument.update({
        where: { id },
        data: { parseStatus: BATCH_PARSE_STATUS.FAILED_BATCH },
      }),
    );
  } catch (err) {
    // BEST EFFORT. A failed stamp costs one re-read next wave, which is the
    // state before this fix; throwing would fail a run that did all its work.
    log.warn(`could not stamp ${id} as batch-refused: ${errText(err)}`);
  }
}

async function runBatchBuild(args: Args, writes: Writes): Promise<RunOutcome> {
  const apply = resolveApply(args);
  const tally: Tally = {};
  const budget = new Budget(args.budgetMs, args.maxBatches);

  const pilot = args.pilotFromParsed > 0;
  const picked = pilot
    ? await pickPilotDocumentIds(args.pilotFromParsed, {
        maxPerSymbol: args.pilotMaxPerSymbol,
        ...(args.pilotDocTypes ? { docTypes: args.pilotDocTypes } : {}),
      })
    : { ids: [], extractedSeen: 0, symbols: 0 };
  const pilotIds = picked.ids;
  if (pilot && pilotIds.length === 0) {
    // TWO DIFFERENT FAILURES, said differently. Reporting both as "matched no
    // document" sent an operator looking for missing extracts when the real
    // answer was that the extracts exist and are unconverted.
    if (picked.extractedSeen === 0) {
      log.warn(
        `--pilot-from-parsed=${args.pilotFromParsed} matched no document with an ` +
          "EXTRACTED row. There is no known answer to compare against, so this " +
          "would be an ordinary batch wearing a pilot's name.",
      );
    } else {
      log.warn(
        `--pilot-from-parsed=${args.pilotFromParsed} found ${picked.extractedSeen} ` +
          "document(s) with an EXTRACTED row, but NONE of them carries a markdown " +
          "sidecar (convertStatus CONVERTED). batch-build reads `${gcsPath}.md`, " +
          "so there is nothing to build a line from. Run scan-convert over these " +
          "documents first, then re-run the pilot.",
      );
    }
  }

  const where: Prisma.StockDocumentWhereInput = pilot
    ? { id: { in: pilotIds } }
    : {
        convertStatus: CONVERT_STATUS.CONVERTED,
        markdownGcsPath: { isSet: true },
        mimeType: "application/pdf",
        gcsPath: { notIn: [""] },
        // MONEY-1314 — EXCLUDE WHAT THE PIPELINE HAS ALREADY PAID FOR.
        //
        // Without this the selector had no rotation marker at all: `fetchedAt`
        // is immutable, nothing in the where-clause is written by
        // batch-submit or batch-ingest, and there is no cursor. Wave 2 built a
        // byte-identical JSONL to wave 1 and paid Gemini a second time for the
        // same rows; at 250 a wave against 48,322 documents the drain needed
        // ~192 waves and could never advance past the first page. `remaining`
        // is the whole converted-set count, so it stayed flat and read as
        // "more work to do". That is MONEY-1211/1255's rotation defect on the
        // most expensive job here.
        //
        // The `isSet: false` arm is load-bearing: `parseStatus` is genuinely
        // ABSENT on the ~43,105 pre-existing rows, and a bare `notIn` would
        // match none of them.
        OR: [
          { parseStatus: { isSet: false } },
          {
            parseStatus: {
              notIn: [
                BATCH_PARSE_STATUS.BATCHED,
                INGEST_PARSE_STATUS.EXTRACTED,
                // MONEY-1373 — WHAT THIS LANE HAS ALREADY REFUSED.
                //
                // The two refusals below (`sidecarPageIncomplete`,
                // `failOverToVision`) used to `continue` and leave the row
                // UNTOUCHED, on the reasoning that the sweep would collect it.
                // The sweep never admits PENDING, so it did not — and because
                // selection is `fetchedAt asc` and nothing moved, the refused
                // rows sat at the HEAD of the queue and were re-selected by
                // every wave, forever.
                //
                // MEASURED over ten waves: the same ~2,000 documents were
                // re-read each time, 0.89 GB of GCS per wave, `failedOverToVision`
                // climbing 1,246 -> 1,687 of 2,000 (84% of the page) while
                // usable lines fell 607 -> 133 and `remaining` moved 1,599 in
                // total. ~25,000 documents further back were never reached.
                //
                // That is MONEY-1211's rotation defect for the FIFTH time, by
                // omission rather than by a wrong sort key: the marker is
                // written for documents that succeed and simply was not
                // written for the ones that do not.
                BATCH_PARSE_STATUS.FAILED_BATCH,
              ],
            },
          },
        ],
        // MONEY-1314 — the docType gate the old lane always applied, restored.
        // `PARSEABLE_DOC_TYPES` exists because an investor presentation
        // carries MANAGEMENT-CHOSEN figures with no Schedule III discipline and
        // is "indistinguishable from filed ones once stored". Making it
        // opt-in put ~24,300 press releases and presentations into the batch —
        // roughly 1.5x the measured budget, and adjusted-EBITDA landing in
        // `document_financial_extracts` under the same key and status as a
        // filed statement.
        docType: { in: args.docTypes ?? [...PARSEABLE_DOC_TYPES] },
        ...(args.symbols ? { symbol: { in: args.symbols } } : {}),
      };

  const remainingBefore = await prisma.stockDocument.count({ where });
  const rows: DocRow[] = await prisma.stockDocument.findMany({
    where,
    select: DOC_SELECT,
    take: pilot ? Math.max(pilotIds.length, 1) : args.limit,
    orderBy: pilot ? { id: "asc" } : { fetchedAt: "asc" },
  });

  const out = args.out ?? `./${JOB}-${Date.now()}.jsonl`;
  const lines: string[] = [];
  let failed = 0;
  let stop: StopReason = rows.length < args.limit ? "drained" : "limit";

  for (const doc of rows) {
    const stopNow = budget.check();
    if (stopNow) {
      stop = stopNow;
      break;
    }
    const label = `${doc.symbol} (${doc.docType}/${doc.period})`;

    if (!doc.markdownGcsPath) {
      bump(tally, "noSidecar");
      continue;
    }

    // REFUSE AN INCOMPLETE SIDECAR BEFORE PAYING FOR IT — MONEY-1334.
    //
    // Checked here rather than after the download because the decision needs
    // only counters already on the row: an incomplete document costs zero GCS
    // reads and zero model tokens on this lane.
    //
    // The document is NOT failed and NOT stamped. It is left exactly where it
    // is, so the sweep selects it on its own predicate and reads the whole PDF
    // through vision — which sees the scanned pages this sidecar is missing.
    // That is the same disposition `failOverToVision` already gets below; the
    // difference is only in what made the sidecar untrustworthy. There the
    // text lies, here it is silent.
    const pageCoverage = sidecarIsPageIncomplete(doc);
    if (pageCoverage.incomplete) {
      bump(tally, "sidecarPageIncomplete");
      log.info(
        `${label}: ${((pageCoverage.scannedShare ?? 0) * 100).toFixed(0)}% of ` +
          "pages produced no text — the sidecar cannot be a complete reading; " +
          "handing it to the vision lane",
      );
      await stampRefusedByBatchLane(doc.id, writes, apply);
      continue;
    }

    let raw: string;
    try {
      assertSafeObjectKey(doc.markdownGcsPath);
      raw = (await downloadFromGCS(doc.markdownGcsPath)).toString("utf-8");
    } catch (err) {
      failed++;
      bump(tally, "sidecarReadFailed");
      log.warn(`${label}: sidecar read failed — ${errText(err)}`);
      continue;
    }
    bump(tally, "sidecarsRead");
    bump(tally, "bytesRead", Buffer.byteLength(raw));

    // NORMALISE THE WHOLE DOCUMENT FIRST. The rupee repair has to run before
    // any table is parsed: the stray backticks pair into inline code spans that
    // swallow the pipes of whatever table falls between two amounts, so page
    // scoring on the raw text measures tables that are not there.
    const normalised = normaliseDocumentMarkdown(raw);
    if (normalised.failOverToVision) {
      // ONE orphan digit is enough. The damaged cells still parse as valid
      // numbers — `196.82` and `160.64` in the measured case — so there is no
      // "a few is fine" policy available. The document goes to the vision lane,
      // which the sweep runs.
      bump(tally, "failedOverToVision");
      log.info(`${label}: ${normalised.reason}`);
      await stampRefusedByBatchLane(doc.id, writes, apply);
      continue;
    }

    const pages = splitMarkdownPages(normalised.markdown);

    // MEASURED, NOT ROUTED ON — MONEY-1343. The >=20% scanned-share rule
    // catches a document whose statement block is scanned in bulk; it cannot
    // see one at 0-1% scanned that is missing exactly the statement pages
    // (HARDWYN and AHLWEST are the known shapes). This counts that class so
    // the pilot can size it.
    //
    // It is deliberately NOT a router yet, and the measurement says why: on
    // BONLON FY2025 — the document MONEY-1334 was diagnosed on, whose pages
    // 92-135 emit no page marker at all — it reports `partial` rather than
    // `none`, because two corporate-governance pages mention "balance sheets"
    // beside a committee ATTENDANCE table and an AGM date list, and
    // `isNumericCell` cannot tell `28.09.2024` from a decimal. So it
    // UNDER-counts the class it exists to size, which is the safe direction
    // for a counter and the wrong one for a gate.
    bump(tally, `statementEvidence:${statementEvidence(pages).class}`);

    const selection = selectPagesForExtraction(pages, {
      maxChars: args.maxChars,
    });
    bump(tally, `select:${selection.reason}`);
    bump(tally, "pagesSelected", selection.pages.length);
    bump(tally, "pagesDroppedForBudget", selection.droppedForBudget);

    if (selection.pages.length === 0) {
      // An empty selection is a failure, never a successful parse of nothing.
      bump(tally, "emptySelection");
      continue;
    }

    lines.push(
      buildBatchRequestLine({
        shape: "developer",
        documentId: doc.id,
        ctx: {
          symbol: doc.symbol,
          docType: doc.docType,
          period: doc.period,
          title: doc.title,
        },
        markdown: joinDocPages(selection.pages),
        disableThinking: args.disableThinking,
        maxOutputTokens: args.maxOutputTokens,
      }),
    );
    bump(tally, "linesBuilt");
    bump(tally, "chars", selection.totalChars);
  }

  // ONE FILE PER SUBMISSION, and ~50,800 documents do not fit in one — the
  // drain is waves by construction (MONEY-1345). The manifest is printed per
  // file because `batch-submit --files=` is driven from it.
  const chunks = splitBatchLines(lines, {
    maxLines: args.maxLines,
    maxBytes: args.maxBytes,
  });
  const manifest = chunks.map((chunk, i) => ({
    file: batchChunkPath(out, i, chunks.length),
    lines: chunk.length,
    bytes: Buffer.byteLength(`${chunk.join("\n")}\n`, "utf-8"),
  }));

  if (lines.length > 0 && apply) {
    try {
      for (const [i, chunk] of chunks.entries()) {
        const entry = manifest[i];
        if (!entry) continue;
        const body = `${chunk.join("\n")}\n`;
        await countedWrite(writes, "lines", chunk.length, async () =>
          writeFileSync(entry.file, body, "utf-8"),
        );
        log.info(
          `wrote ${chunk.length} line(s), ${entry.bytes} bytes -> ${entry.file}`,
        );
      }
      if (chunks.length > 1) {
        log.info(
          `MANIFEST ${chunks.length} file(s): ` +
            `--files=${manifest.map((m) => m.file).join(",")}`,
        );
      }
    } catch (err) {
      failed++;
      log.error(`could not write ${out}: ${errText(err)}`);
      return {
        stop: "failed",
        selected: rows.length,
        remaining: remainingBefore,
        failed,
        transportFailures: 0,
        writes,
        tally,
      };
    }
  } else if (lines.length > 0) {
    log.info(
      `DRY RUN: ${lines.length} line(s) would be written as ` +
        `${chunks.length} file(s): ` +
        manifest
          .map((m) => `${m.file} (${m.lines} lines, ${m.bytes} B)`)
          .join(", ") +
        ". Pass --apply to write them.",
    );
  }

  // A PILOT THAT BUILT NOTHING IS A FAILED PILOT, whatever the cause.
  //
  // This guards the PROPERTY rather than the predicate above it. The missing
  // `convertStatus` gate is one way to select documents and produce zero lines;
  // a GCS outage, a renamed sidecar key and a new tally bucket are three more,
  // and none of them would trip a test written against the query shape. What
  // they share is observable here: a pilot exists to be COMPARED against a
  // known answer, so zero lines means there is nothing to compare and the run
  // did not do its job.
  //
  // `stop: "drained"` maps to EXIT.OK, which is how the 2026-09-02 run reported
  // `selected=25 ... lines:0` and exited 0. An operator reading only the exit
  // code would have gone on to `batch-submit` an empty file.
  //
  // Scoped to the pilot deliberately. An ORDINARY run that selects rows and
  // builds no lines can be legitimate — a page where every document is
  // genuinely unconvertible — and failing it would cry wolf on a real drain.
  const builtNothing = pilotBuiltNothing({
    pilot,
    selected: rows.length,
    linesBuilt: lines.length,
  });
  if (builtNothing) {
    log.error(
      `PILOT FAILED: selected ${rows.length} document(s) and built ZERO batch ` +
        `lines (tally=${JSON.stringify(tally)}). There is nothing to compare ` +
        "against, so this run proves nothing. Fix the cause named in the tally " +
        "before submitting a batch.",
    );
  }

  return {
    stop: builtNothing ? "failed" : stop,
    selected: rows.length,
    remaining: remainingBefore,
    failed,
    transportFailures: 0,
    writes,
    tally,
    note: pilot
      ? `PILOT over ${pilotIds.length} document(s) across ${picked.symbols} ` +
        `symbol(s), max ${args.pilotMaxPerSymbol} each, that already hold an ` +
        "EXTRACTED row — batch-ingest --compare grades the result against them. " +
        // BREADTH IS THE NUMBER TO READ. The 2026-09-02 pilot drew 25
        // documents from SIX companies, so its failure rates described those
        // six rather than the corpus.
        `docTypes=${args.pilotDocTypes?.join("+") ?? "any"}`
      : `out=${out}`,
  };
}

// ---------------------------------------------------------------------------
// 3. batch-submit
// ---------------------------------------------------------------------------

/** The document ids a built JSONL carries, read back from `metadata.key`. */
function readBatchKeys(path: string): { keys: string[]; malformed: number } {
  const keys: string[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const key = (parsed as { metadata?: { key?: unknown } })?.metadata?.key;
      if (typeof key === "string" && key) keys.push(key);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { keys, malformed };
}

function genaiClient(): GoogleGenAI | null {
  const apiKey = process.env.GOOGLE_GENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

/**
 * Upload the JSONL and create the batch job, then stamp every row it carries.
 *
 * The stamp is `batchJobId` + `parseStatus: "BATCHED"` and it is written with
 * `updateMany` over the ids the FILE carries. If the stamp partially lands, the
 * rows are still reachable: `buildBatchIngestQuery` matches on `batchJobId` AND
 * a BATCHED-or-ABSENT status arm, precisely so a half-written pair is not
 * stranded in a state no sweep looks at.
 */
async function runBatchSubmit(args: Args, writes: Writes): Promise<RunOutcome> {
  const apply = resolveApply(args);
  const tally: Tally = {};
  const file = args.file ?? "";

  let keys: string[];
  let malformed: number;
  try {
    ({ keys, malformed } = readBatchKeys(file));
  } catch (err) {
    log.error(`could not read ${file}: ${errText(err)}`);
    return {
      stop: "failed",
      selected: 0,
      remaining: 0,
      failed: 1,
      transportFailures: 0,
      writes,
      tally,
    };
  }
  bump(tally, "linesRead", keys.length);
  bump(tally, "linesMalformed", malformed);

  if (malformed > 0) {
    // A line with no `metadata.key` still COSTS a request and its answer can
    // never be attributed to a document. Refuse rather than submit a batch
    // whose results are partly unmappable.
    log.error(
      `${malformed} line(s) in ${file} carry no metadata.key. The key is what ` +
        "correlates a response back to a document row; a batch containing " +
        "unkeyed lines is paid for and partly unreadable.",
    );
    return {
      stop: "failed",
      selected: keys.length,
      remaining: 0,
      failed: malformed,
      transportFailures: 0,
      writes,
      tally,
    };
  }
  if (keys.length === 0) {
    log.info(`${file} carries no request lines — nothing to submit.`);
    return {
      stop: "drained",
      selected: 0,
      remaining: 0,
      failed: 0,
      transportFailures: 0,
      writes,
      tally,
    };
  }

  const model = resolveDocParseModel(args.model ?? null);
  if (!apply) {
    log.info(
      `DRY RUN: would upload ${file} (${keys.length} requests) and create a ` +
        `batch on ${model}, then stamp ${keys.length} row(s) BATCHED.`,
    );
    return {
      stop: "dry-run",
      selected: keys.length,
      remaining: keys.length,
      failed: 0,
      transportFailures: 0,
      writes,
      tally,
      note: `model=${model} file=${file}`,
    };
  }

  const client = genaiClient();
  if (!client) {
    log.error(
      "GOOGLE_GENAI_API_KEY is not set. The Developer-API batch path is the " +
        "rung this branch took (probed 2026-09-01); there is no fallback here.",
    );
    return {
      stop: "failed",
      selected: keys.length,
      remaining: keys.length,
      failed: 0,
      transportFailures: 1,
      writes,
      tally,
    };
  }

  let jobName: string;
  try {
    const uploaded = await client.files.upload({
      file,
      config: { mimeType: "application/jsonl", displayName: `${JOB}-input` },
    });
    const fileName = uploaded.name;
    if (!fileName) throw new Error("the Files API returned no file name");
    log.info(`uploaded ${file} -> ${fileName}`);

    const created = await client.batches.create({
      model,
      // `fileName` ONLY — never `format`, and never `gcsUri`.
      //
      // `BatchJobSource` is ONE type serving TWO backends, so the compiler
      // accepts every field for either. It is the RUNTIME that splits them:
      // `format`/`gcsUri`/`bigqueryUri`/`vertexDatasetName` are Vertex
      // (Gemini Enterprise Agent Platform) fields, `fileName`/`inlinedRequests`
      // are Gemini Developer API fields, and we authenticate with
      // GOOGLE_GENAI_API_KEY — the Developer API.
      //
      // MEASURED 2026-09-02: `format: "jsonl"` is rejected with "format
      // parameter is only supported in Gemini Enterprise Agent Platform mode,
      // not in Gemini Developer API mode" — AFTER the input file has already
      // been uploaded, so the failure costs an upload every attempt. The format
      // is implied by the file; there was never anything for this field to say.
      src: { fileName },
      config: { displayName: `${JOB}-${Date.now()}` },
    });
    if (!created.name) throw new Error("batches.create returned no job name");
    jobName = created.name;
  } catch (err) {
    log.error(`batch submission failed: ${errText(err)}`);
    return {
      stop: "failed",
      selected: keys.length,
      remaining: keys.length,
      failed: 0,
      transportFailures: 1,
      writes,
      tally,
    };
  }

  log.info(
    `batch created: ${jobName} (model ${model}, ${keys.length} requests)`,
  );

  // Stamped in chunks so one oversized `in` does not fail the whole set, and
  // counted from the DRIVER's own `count` — the number of rows the database
  // says it changed, not the number we asked it to change.
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    try {
      // The amount is a FUNCTION of the result: `res.count` is the number of
      // rows the database says it changed. `slice.length` is the number we
      // asked about, and the two differ whenever a row was deleted, re-scoped,
      // or claimed by another run.
      await countedWrite(
        writes,
        "batched",
        (res) => res.count,
        () =>
          prisma.stockDocument.updateMany({
            where: { id: { in: slice } },
            data: {
              batchJobId: jobName,
              parseStatus: BATCH_PARSE_STATUS.BATCHED,
              parsePath: "markdown",
            },
          }),
      );
    } catch (err) {
      log.warn(
        `stamping rows ${i}..${i + slice.length} failed: ${errText(err)}`,
      );
    }
  }

  return {
    stop: "drained",
    selected: keys.length,
    remaining: keys.length - writes.batched,
    failed: 0,
    transportFailures: 0,
    writes,
    tally,
    note:
      `batchJobId=${jobName} — ingest with: ${JOB} batch-ingest ` +
      `--batch-job=${jobName}`,
  };
}

// ---------------------------------------------------------------------------
// 4. batch-ingest
// ---------------------------------------------------------------------------

interface BatchResultLine {
  documentId: string;
  /** The model's answer, or null when the line carried an error. */
  response: unknown;
  error: string | null;
}

/**
 * One results line -> a document id and a response.
 *
 * TOLERANT ON PURPOSE. The request shape was probed; the RESPONSE shape was
 * not, and this repo's own rule is that a positional or key-name assumption
 * taken from documentation is how an EOD parser ends up swapping open and
 * close on every US security. So the key is looked for at `metadata.key` (the
 * shape the request used), then `key`, then `custom_id`; anything else counts
 * as unattributable and is REPORTED rather than guessed at.
 */
function readResultLine(line: string): BatchResultLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const rec = parsed as {
    metadata?: { key?: unknown };
    key?: unknown;
    custom_id?: unknown;
    response?: unknown;
    error?: unknown;
  };
  const key = rec?.metadata?.key ?? rec?.key ?? rec?.custom_id;
  if (typeof key !== "string" || !key) return null;
  const err = rec?.error;
  return {
    documentId: key,
    response: rec?.response ?? null,
    error:
      err == null
        ? null
        : typeof err === "string"
          ? err
          : JSON.stringify(err).slice(0, 400),
  };
}

/** Download a finished batch's result file and split it into lines. */
async function fetchBatchResults(
  client: GoogleGenAI,
  batchJob: string,
): Promise<{
  lines: BatchResultLine[];
  state: string;
  unattributable: number;
}> {
  const job = await client.batches.get({ name: batchJob });
  const state = String(job.state ?? "JOB_STATE_UNSPECIFIED");
  if (state !== "JOB_STATE_SUCCEEDED") {
    throw new Error(
      `batch ${batchJob} is ${state}, not JOB_STATE_SUCCEEDED — ` +
        (job.error ? `error: ${JSON.stringify(job.error)}` : "wait, or cancel"),
    );
  }

  const lines: BatchResultLine[] = [];
  let unattributable = 0;

  const inlined = job.dest?.inlinedResponses;
  if (Array.isArray(inlined) && inlined.length > 0) {
    // An inlined batch has no per-line key at all — the API documents the
    // responses as being "in the same order as the input requests". This job
    // never SUBMITS inlined (it uploads a file), so reaching here means the
    // batch was created elsewhere and the correlation is positional, which is
    // not something to guess at silently.
    throw new Error(
      `batch ${batchJob} returned ${inlined.length} INLINED responses. This ` +
        "job only submits file-based batches, whose lines carry " +
        "metadata.key; an inlined batch correlates POSITIONALLY and this " +
        "path refuses to infer that mapping.",
    );
  }

  const fileName = job.dest?.fileName;
  if (!fileName) {
    throw new Error(
      `batch ${batchJob} succeeded but names no destination file — nothing to read`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), `${JOB}-`));
  const localPath = join(dir, "results.jsonl");
  await client.files.download({ file: fileName, downloadPath: localPath });

  for (const raw of readFileSync(localPath, "utf-8").split("\n")) {
    if (!raw.trim()) continue;
    const parsed = readResultLine(raw);
    if (parsed === null) unattributable++;
    else lines.push(parsed);
  }

  return { lines, state, unattributable };
}

interface CompareRow {
  documentId: string;
  symbol: string;
  periodEnd: string;
  periodType: string;
  basis: string;
  column: string;
  incumbent: number | null;
  batch: number | null;
  relDiff: number | null;
}

/** Columns the comparison grades. Every numeric column the mapper produces. */
const COMPARE_COLUMNS = [
  "revenueFromOperations",
  "otherIncome",
  "operatingIncomeExOtherIncome",
  "ebitdaBeforeExceptionalItems",
  "netIncome",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "totalDebt",
  "totalCash",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
  "eps",
] as const;

function relDiff(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

/**
 * A finished batch -> mapped, graded rows -> upserts, or a COMPARISON report.
 *
 * `--compare` is how the pilot is judged: the batch's answer is graded against
 * the extracts already on the row rather than replacing them. It writes NOTHING
 * to the database, which is why `--compare` and `--apply` are refused together
 * — an upsert would destroy the baseline the comparison is measured against.
 *
 * A grade is NOT re-derived here. `mapDocumentFinancials` runs
 * `validateMappedExtract` internally, per period, and returns the verdict it
 * produced; calling the validator a second time would need the internal
 * `ValidationContext` (resolved scales, per-statement presence, the printed
 * total income) that the mapper builds and does not export. Re-deriving that
 * context by hand would be a SECOND arithmetic gate that agrees with the first
 * only by luck.
 */
async function runBatchIngest(args: Args, writes: Writes): Promise<RunOutcome> {
  const apply = resolveApply(args);
  const tally: Tally = {};
  const budget = new Budget(args.budgetMs, args.maxBatches);
  const batchJob = args.batchJob ?? "";

  const where = whereOf(buildBatchIngestQuery(batchJob));
  const remainingBefore = await prisma.stockDocument.count({ where });
  log.info(
    `batch-ingest ${batchJob}: ${remainingBefore} row(s) still carry this job`,
  );

  const client = genaiClient();
  if (!client) {
    log.error("GOOGLE_GENAI_API_KEY is not set — cannot read the batch");
    return {
      stop: "failed",
      selected: 0,
      remaining: remainingBefore,
      failed: 0,
      transportFailures: 1,
      writes,
      tally,
    };
  }

  let lines: BatchResultLine[];
  let unattributable: number;
  try {
    ({ lines, unattributable } = await fetchBatchResults(client, batchJob));
  } catch (err) {
    log.error(errText(err));
    return {
      stop: "failed",
      selected: 0,
      remaining: remainingBefore,
      failed: 0,
      transportFailures: 1,
      writes,
      tally,
    };
  }
  bump(tally, "resultLines", lines.length);
  bump(tally, "unattributableLines", unattributable);
  if (unattributable > 0) {
    log.warn(
      `${unattributable} result line(s) carried no usable correlation key and ` +
        "cannot be attributed to a document — they are counted, never guessed",
    );
  }

  const docs: DocRow[] = await prisma.stockDocument.findMany({
    where: { id: { in: lines.map((l) => l.documentId) } },
    select: DOC_SELECT,
  });
  const byId = new Map(docs.map((d) => [d.id, d]));

  const model = resolveDocParseModel(args.model ?? null);
  const comparisons: CompareRow[] = [];

  /**
   * PER-DOCUMENT OUTCOMES, with a CAUSE — MONEY-1314.
   *
   * The compare used to emit only `disagreements`, so a run where 14 of 22
   * documents FAILED reported the count in the tally and NOTHING about why.
   * A 64% failure rate with no recorded cause is not a gate: it grades the
   * documents that succeeded and stays silent about the ones that did not,
   * which is the half that decides whether the lane is fit to drain.
   *
   * `disagreements` answers "is the batch answer WRONG". This answers "did the
   * batch produce an answer AT ALL, and if not, at which step it stopped".
   */
  const documentOutcomes: Array<Record<string, unknown>> = [];
  let selected = 0;
  let failed = 0;
  let stop: StopReason = "drained";

  for (const line of lines) {
    const stopNow = budget.check();
    if (stopNow) {
      stop = stopNow;
      break;
    }
    const doc = byId.get(line.documentId);
    if (!doc) {
      bump(tally, "unknownDocumentId");
      continue;
    }
    selected++;
    const label = `${doc.symbol} (${doc.docType}/${doc.period})`;

    if (line.error) {
      bump(tally, "perRowError");
      failed++;
      log.warn(`${label}: batch error — ${line.error}`);
      if (apply) {
        try {
          await countedWrite(writes, "statuses", 1, () =>
            prisma.stockDocument.update({
              where: { id: doc.id },
              data: { parseStatus: BATCH_PARSE_STATUS.FAILED_BATCH },
            }),
          );
        } catch (err) {
          log.warn(`${label}: status write failed — ${errText(err)}`);
        }
      }
      continue;
    }

    const text = extractResponseText(line.response);
    const raw = parseDocFinancialsJson(text);
    const usage = readUsage(line.response);
    bump(tally, "promptTokens", usage.promptTokens);
    bump(tally, "outputTokens", usage.candidatesTokens);
    bump(tally, "cachedTokens", usage.cachedTokens);

    const mapped = raw
      ? mapDocumentFinancials(raw)
      : { rows: [], dropped: [], periodsReturned: 0 };
    bump(tally, "periodsReturned", mapped.periodsReturned);
    for (const reason of mapped.dropped) bump(tally, `dropped:${reason}`);

    const outcome = classifyIngestOutcome({
      failure: raw ? null : "UNPARSEABLE",
      gatePassed: mapped.rows.some((r) => r.verdict.status === "EXTRACTED"),
      // MONEY-1314 — zero periods means the model READ the document and
      // found no statements, which is common and legitimate (a "quarterly
      // result" attachment that is really a covering letter). It must NOT
      // earn a whole-PDF vision retry, once per such document across the
      // eligible corpus.
      periodsReturned: mapped.periodsReturned,
      wasRetry: false,
      // Every reason the gate gave, across all rejected periods — MONEY-1348.
      // The classifier needs them to tell "declined for a currency we cannot
      // store" from "read and disbelieved", which take opposite dispositions.
      rejectionReasons: mapped.rows
        .filter((r) => r.verdict.status !== "EXTRACTED")
        .flatMap((r) => r.verdict.reasons),
    });
    bump(tally, `outcome:${outcome.parseStatus}`);

    if (args.compare) {
      const finish = readFinishDiagnostics(line.response);
      documentOutcomes.push({
        documentId: doc.id,
        symbol: doc.symbol,
        // Vendor-side reasons an answer can be absent. `finishReason` is on the
        // CANDIDATE; `blockReason` is on promptFeedback and is the only place a
        // refused PROMPT is reported at all.
        finishReason: finish.finishReason,
        blockReason: finish.blockReason,
        candidateCount: finish.candidateCount,
        responseChars: text.length,
        // Only when there is nothing to parse: enough of the answer to tell a
        // truncated JSON object from prose from an empty string, bounded so a
        // report over thousands of documents stays readable.
        rawPrefix: raw ? null : text.slice(0, 240),
        docType: doc.docType,
        period: doc.period ?? null,
        parseStatus: outcome.parseStatus,
        // The three inputs the classification is a function of. Recorded
        // SEPARATELY rather than as one summary string, because they separate
        // failures that are indistinguishable from the status alone:
        //   unparseable          the model returned no readable JSON
        //   periodsReturned 0    it read the document and found no statements
        //   periods > 0, !gate   it read statements and OUR arithmetic gate
        //                        rejected them — our defect, not the model's
        unparseable: !raw,
        periodsReturned: mapped.periodsReturned,
        gatePassed: mapped.rows.some((r) => r.verdict.status === "EXTRACTED"),
        droppedReasons: [...mapped.dropped],
        // Why a page-budget problem is visible HERE and not in the tally: a
        // thin selection produces a real answer over the wrong pages, so it
        // fails as "no statements found" rather than as an error.
        // THE REASONS, not just the status — MONEY-1334.
        //
        // This recorded `verdict.status` alone, which is FAILED_VALIDATION for
        // every rejection and therefore says only "the gate refused it". The
        // gate has TWELVE distinct rules, and they call for opposite responses:
        // UNKNOWN_SCALE is a units header the converter lost, TOTAL_INCOME_
        // MISMATCH is the model mis-reading a statement, BALANCE_SHEET_
        // IMBALANCE may be OUR tolerance being wrong. Reporting the class and
        // not the rule is the same blind spot this ticket fixed for model-side
        // failures, one layer over — a rejection count with no cause is not a
        // gate, it is a number.
        rejectedVerdicts: mapped.rows
          .filter((r) => r.verdict.status !== "EXTRACTED")
          .map((r) => ({
            status: r.verdict.status,
            reasons: [...r.verdict.reasons],
            warnings: [...r.verdict.warnings],
          })),
      });

      const incumbent = await prisma.documentFinancialExtract.findMany({
        where: { documentId: doc.id },
      });
      const incumbentByKey = new Map(
        incumbent.map((r) => [
          `${r.periodEnd.toISOString()}|${r.periodType}|${r.basis}`,
          r as unknown as Record<string, number | null>,
        ]),
      );
      for (const { row } of mapped.rows) {
        const key = `${row.periodEnd.toISOString()}|${row.periodType}|${row.basis}`;
        const prev = incumbentByKey.get(key) ?? null;
        bump(tally, prev ? "comparedPeriods" : "newPeriods");
        for (const column of COMPARE_COLUMNS) {
          const batchValue = row[column] ?? null;
          const incumbentValue = prev ? (prev[column] ?? null) : null;
          const diff = relDiff(incumbentValue, batchValue);
          if (diff !== null && diff <= 0.001) {
            bump(tally, "columnsAgree");
            continue;
          }
          if (incumbentValue === null && batchValue === null) continue;
          bump(tally, "columnsDisagree");
          comparisons.push({
            documentId: doc.id,
            symbol: doc.symbol,
            periodEnd: row.periodEnd.toISOString().slice(0, 10),
            periodType: row.periodType,
            basis: row.basis,
            column,
            incumbent: incumbentValue,
            batch: batchValue,
            relDiff: diff,
          });
        }
      }
      continue;
    }

    if (!apply) {
      log.info(
        `${label}: WOULD write ${mapped.rows.length} row(s), status ` +
          outcome.parseStatus,
      );
      continue;
    }

    for (const { row, verdict } of mapped.rows) {
      try {
        await countedWrite(writes, "extracts", 1, () =>
          upsertExtract({
            documentId: doc.id,
            instrumentId: doc.instrumentId,
            symbol: doc.symbol,
            exchange: doc.exchange,
            model,
            row,
            verdict,
          }),
        );
      } catch (err) {
        failed++;
        log.error(`${label}: extract write failed — ${errText(err)}`);
      }
    }

    try {
      await countedWrite(writes, "statuses", 1, () =>
        prisma.stockDocument.update({
          where: { id: doc.id },
          data: {
            parseStatus: outcome.parseStatus,
            parsePath: "markdown",
            ...(outcome.parseStatus === INGEST_PARSE_STATUS.EXTRACTED
              ? { parsedAt: new Date() }
              : {}),
          },
        }),
      );
    } catch (err) {
      failed++;
      log.warn(`${label}: status write failed — ${errText(err)}`);
    }
  }

  if (args.compare) {
    const report = {
      job: JOB,
      mode: "compare",
      batchJob,
      generatedAt: new Date().toISOString(),
      documents: selected,
      tally,
      documentOutcomes,
      disagreements: comparisons,
    };
    const body = `${JSON.stringify(report, null, 2)}\n`;
    if (args.report) {
      // The report is the ONLY output of compare mode and it touches no
      // database, so it is written without --apply — which is refused in this
      // mode anyway.
      writeFileSync(args.report, body, "utf-8");
      log.info(`comparison report -> ${args.report}`);
    } else {
      log.info(body);
    }
  }

  const remaining = await prisma.stockDocument.count({ where });
  return {
    stop,
    selected,
    remaining,
    failed,
    transportFailures: 0,
    writes,
    tally,
    note: args.compare
      ? `COMPARE: ${comparisons.length} column disagreement(s) over ${selected} ` +
        "document(s). Nothing was written to the database."
      : apply
        ? undefined
        : "DRY RUN: results were read and graded; nothing was written.",
  };
}

// ---------------------------------------------------------------------------
// 5. sweep
// ---------------------------------------------------------------------------

/**
 * The terminal-failure residue, back through the ONLINE path.
 *
 * `buildSweepQuery` re-opens FAILED_BATCH and FAILED_VALIDATION. The lane each
 * row takes is `decideIngestLane`'s decision, not this loop's: a
 * FAILED_VALIDATION row is the ONE case where spending vision tokens on a
 * document we can already read is worth it — a gate failure often means a table
 * the converter flattened wrongly, and vision reads what is visually on the
 * page. A FAILED_BATCH row never got an answer at all, so it takes its ordinary
 * lane.
 *
 * ONLINE, not batched, and deliberately so: this population is small, it is the
 * one that needs a per-document decision, and the vision lane cannot be
 * page-selected or cached.
 */
async function runSweep(args: Args, writes: Writes): Promise<RunOutcome> {
  const apply = resolveApply(args);
  const tally: Tally = {};
  const budget = new Budget(args.budgetMs, args.maxBatches);

  const where = whereOf(buildSweepQuery({ now: new Date() }));
  const scoped: Prisma.StockDocumentWhereInput = {
    ...where,
    ...(args.symbols ? { symbol: { in: args.symbols } } : {}),
    ...(args.docTypes ? { docType: { in: args.docTypes } } : {}),
  };

  const remainingBefore = await prisma.stockDocument.count({ where: scoped });
  const rows: DocRow[] = await prisma.stockDocument.findMany({
    where: scoped,
    select: DOC_SELECT,
    take: args.limit,
    orderBy: { fetchedAt: "asc" },
  });
  log.info(
    `sweep: ${rows.length} selected of ${remainingBefore} sweepable row(s)`,
  );

  const model = resolveDocParseModel(args.model ?? null);
  let selected = 0;
  let failed = 0;
  let transportFailures = 0;
  let stop: StopReason = rows.length < args.limit ? "drained" : "limit";

  for (const doc of rows) {
    const stopNow = budget.check();
    if (stopNow) {
      stop = stopNow;
      break;
    }
    selected++;
    const label = `${doc.symbol} (${doc.docType}/${doc.period})`;

    let decision = decideIngestLane(
      {
        gcsPath: doc.gcsPath,
        mimeType: doc.mimeType,
        // 0 means the sync never recorded a size, not "an empty file".
        // `exceedsVisionCeiling` treats null as TOO LARGE on purpose — the
        // cost of guessing large is the markdown lane, which is the lane we
        // wanted; the cost of guessing small is a 222 MB upload at a 50 MB
        // endpoint, paid for and then rejected.
        fileBytes: doc.fileSize > 0 ? doc.fileSize : null,
        convertStatus: doc.convertStatus,
        markdownGcsPath: doc.markdownGcsPath,
        scannedPageCount: doc.scannedPageCount,
        textPageCount: doc.textPageCount,
      },
      {
        retryAfterGateFailure: doc.parseStatus === "FAILED_VALIDATION",
        // MONEY-1373 — a FAILED_BATCH row is one the batch lane REFUSED on the
        // markdown itself: either the normaliser found digits that migrated
        // across a column boundary, or too many pages produced no text. Both
        // mean the sidecar cannot be trusted, so re-offering it the same
        // markdown would reproduce the refusal. `untrustedMarkdown` is exactly
        // this signal — "the normaliser rejected the markdown before any model
        // saw it" — and routes to whole-PDF vision.
        untrustedMarkdown: doc.parseStatus === BATCH_PARSE_STATUS.FAILED_BATCH,
      },
    );
    bump(tally, `lane:${decision.lane}`);

    if (decision.lane === "skip") {
      log.info(`${label}: skip — ${decision.reason}`);
      if (apply && decision.parseStatus) {
        try {
          const status = decision.parseStatus;
          await countedWrite(writes, "statuses", 1, () =>
            prisma.stockDocument.update({
              where: { id: doc.id },
              data: { parseStatus: status },
            }),
          );
        } catch (err) {
          log.warn(`${label}: status write failed — ${errText(err)}`);
        }
      }
      continue;
    }

    if (decision.lane === "convert") {
      // The sweep does not convert. Leaving the row where it is keeps the two
      // lanes' cursors honest — `scan-convert` selects it on its own predicate,
      // and a status written here would remove it from that selection.
      bump(tally, "needsConvertFirst");
      log.info(`${label}: needs scan-convert first — ${decision.reason}`);
      continue;
    }

    if (!apply) {
      log.info(`${label}: WOULD take the ${decision.lane} lane`);
      continue;
    }

    let result;
    if (decision.lane === "markdown" && doc.markdownGcsPath) {
      let markdown = "";
      try {
        assertSafeObjectKey(doc.markdownGcsPath);
        const raw = (await downloadFromGCS(doc.markdownGcsPath)).toString(
          "utf-8",
        );
        const normalised = normaliseDocumentMarkdown(raw);
        if (normalised.failOverToVision) {
          // MONEY-1314 — the verdict was computed and DISCARDED here, while
          // both other consumers honour it (batch-build skips the document;
          // the worker takes the vision lane). The cells this flags are
          // neighbours like `196.82` that are silently truncated AND still
          // parse as valid numbers, so they pass the arithmetic gate, get
          // stamped EXTRACTED, and land in `document_financial_extracts` with
          // nothing downstream able to detect the corruption.
          log.info(
            `${label}: sidecar UNTRUSTWORTHY (${normalised.reason}) — vision instead`,
          );
          decision = {
            ...decision,
            lane: "vision",
            reason: "sidecar re-judged",
          };
        }
        const selection = selectPagesForExtraction(
          splitMarkdownPages(normalised.markdown),
          { maxChars: args.maxChars },
        );
        markdown = joinDocPages(selection.pages);
      } catch (err) {
        failed++;
        log.warn(`${label}: sidecar read failed — ${errText(err)}`);
        continue;
      }
      result = await parseMarkdownFinancials({
        markdown,
        ctx: {
          symbol: doc.symbol,
          docType: doc.docType,
          period: doc.period,
          title: doc.title,
        },
        label,
        modelOverride: args.model ?? null,
        disableThinking: args.disableThinking,
      });
    } else {
      let bytes: Buffer;
      try {
        bytes = await downloadFromGCS(doc.gcsPath);
      } catch (err) {
        failed++;
        log.warn(`${label}: GCS read failed — ${errText(err)}`);
        continue;
      }
      let gcsUri: string | null = null;
      try {
        gcsUri = buildGcsUri(doc.gcsPath);
      } catch {
        gcsUri = null;
      }
      result = await parsePdfFinancials({
        bytes,
        gcsUri,
        mimeType: doc.mimeType || "application/pdf",
        prompt: buildPromptText({
          symbol: doc.symbol,
          docType: doc.docType,
          period: doc.period,
          title: doc.title,
        }),
        label,
        modelOverride: args.model ?? null,
        // MONEY-1334 — the sweep runs BOTH lanes, so an arm flag applied to
        // only one of them names a configuration the run did not have.
        disableThinking: args.disableThinking,
      });
    }

    bump(tally, "promptTokens", result.usage.promptTokens);
    bump(tally, "outputTokens", result.usage.candidatesTokens);
    bump(tally, "cachedTokens", result.usage.cachedTokens);
    if (result.failure === "CALL_FAILED" || result.failure === "UNCONFIGURED") {
      transportFailures++;
    }

    const mapped = result.ok
      ? mapDocumentFinancials(result.data)
      : { rows: [], dropped: [], periodsReturned: 0 };
    const outcome = classifyIngestOutcome({
      failure: result.failure,
      gatePassed: mapped.rows.some((r) => r.verdict.status === "EXTRACTED"),
      // MONEY-1314 — zero periods means the model READ the document and
      // found no statements, which is common and legitimate (a "quarterly
      // result" attachment that is really a covering letter). It must NOT
      // earn a whole-PDF vision retry, once per such document across the
      // eligible corpus.
      periodsReturned: mapped.periodsReturned,
      wasRetry: doc.parseStatus === "FAILED_VALIDATION",
      // Every reason the gate gave, across all rejected periods — MONEY-1348.
      // The classifier needs them to tell "declined for a currency we cannot
      // store" from "read and disbelieved", which take opposite dispositions.
      rejectionReasons: mapped.rows
        .filter((r) => r.verdict.status !== "EXTRACTED")
        .flatMap((r) => r.verdict.reasons),
    });
    bump(tally, `outcome:${outcome.parseStatus}`);

    for (const { row, verdict } of mapped.rows) {
      try {
        await countedWrite(writes, "extracts", 1, () =>
          upsertExtract({
            documentId: doc.id,
            instrumentId: doc.instrumentId,
            symbol: doc.symbol,
            exchange: doc.exchange,
            model: result.model || model,
            row,
            verdict,
          }),
        );
      } catch (err) {
        failed++;
        log.error(`${label}: extract write failed — ${errText(err)}`);
      }
    }

    try {
      await countedWrite(writes, "statuses", 1, () =>
        prisma.stockDocument.update({
          where: { id: doc.id },
          data: {
            parseStatus: outcome.parseStatus,
            parsePath: decision.lane === "markdown" ? "markdown" : "pdf",
            ...(outcome.parseStatus === INGEST_PARSE_STATUS.EXTRACTED
              ? { parsedAt: new Date() }
              : {}),
          },
        }),
      );
    } catch (err) {
      failed++;
      log.warn(`${label}: status write failed — ${errText(err)}`);
    }
  }

  const remaining = await prisma.stockDocument.count({ where: scoped });
  return {
    stop,
    selected,
    remaining,
    failed,
    transportFailures,
    writes,
    tally,
    ...(apply ? {} : { note: "DRY RUN: no model call was made." }),
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

const HELP = `
${JOB} <subcommand> [flags]   — MONEY-1314

SUBCOMMANDS
  scan-convert   GCS PDF -> pdf-inspector -> \${gcsPath}.md sidecar + stamps.
                 The cursor is the scannedPageCount stamp; resume is free.
  batch-build    converted markdown -> page-selected + normalised -> JSONL.
  batch-submit   JSONL -> Files API -> batchGenerateContent -> BATCHED rows.
  batch-ingest   a finished batch -> map + grade -> upsert, or --compare.
  sweep          FAILED_BATCH / FAILED_VALIDATION rows, via the ONLINE path.

GLOBAL FLAGS
  --apply                write. DEFAULT IS A DRY RUN.
  --dry-run              force a dry run; NARROWS --apply, never widens it.
  --limit=N              rows per database page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).
  --budget-sec=N         wall-clock budget (default ${DEFAULT_BUDGET_SEC}). The run's bound.
  --max-batches=N        runaway guard (default ${DEFAULT_MAX_BATCHES}).
  --symbols=A,B          scope by symbol.
  --doc-types=a,b        scope by docType.
  --model=ID             override DOC_PARSE_MODEL (must be registry-known).
  --max-chars=N          page-selection budget (default ${DEFAULT_MAX_CHARS}).

PER SUBCOMMAND
  scan-convert   --rescan            drop the unscanned-only cursor (re-reads all)
                 --max-file-mb=N     skip objects above N MB (default off)
                 --shard=i/n         this task's slice of the corpus. Defaults to
                                     Cloud Run's CLOUD_RUN_TASK_INDEX/_COUNT, so a
                                     --tasks=4 job shards itself with no flag
                 --concurrency=N     documents in flight (default from
                                     DOC_CONVERT_CONCURRENCY, else 4). A sharded
                                     run does NOT self-chain
  batch-build    --out=PATH          JSONL destination
                 --pilot-from-parsed=N  select N documents that ALREADY hold an
                                     EXTRACTED row, so the pilot has a known answer
                 --pilot-max-per-symbol=N  documents ONE symbol may contribute
                                     (default 2). The 2026-09-02 pilot drew 25
                                     documents from SIX companies
                 --pilot-doc-types=a,b  narrow the pilot to these docTypes
                 --disable-thinking  thinkingBudget 0 (measured -32% total tokens)
  batch-build    --max-lines=N        request lines per file (default 20000)
                 --max-bytes=N        bytes per file (default 900 MB)
  batch-submit   --file=PATH         the JSONL from batch-build  (REQUIRED)
                 --files=a,b,c       submit a WAVE, sequentially. Stops at the
                                     first failure and names what is left
  batch-ingest   --batch-job=NAME    the name batch-submit printed (REQUIRED)
                 --batch-jobs=j1,j2  ingest a WAVE. Does NOT stop on a failure:
                                     each job's results are already paid for
                 --compare           grade against the incumbent extracts and
                                     write a report. NEVER writes; refuses --apply.
                 --report=PATH       where the comparison report goes

EXIT CODES
  ${EXIT.OK}  finished the work in scope — INCLUDING "there was none to do"
  ${EXIT.USAGE}  refused to run: a bad or missing argument. Nothing ran.
  ${EXIT.FAILED}  something the run needs is absent or broke
  ${EXIT.INCOMPLETE}  stopped on the wall clock or the batch cap; work remains. Re-run.
`;

/**
 * Ask Cloud Run to run THIS job again, one link deeper.
 *
 * The Admin API rather than gcloud, which is not in the runtime image; the
 * token comes from the metadata server, so it is the job's own service account.
 * Same shape as `backfill-bse-results.ts`'s shard chain, and the same
 * discipline: BEST EFFORT. A failed chain leaves a COMPLETED run plus a command
 * to continue by hand — exactly the state an operator was in before chaining
 * existed. Throwing here would fail a run that did all of its work, which is
 * strictly worse than not chaining.
 */
async function triggerNextScanConvert(nextDepth: number): Promise<void> {
  const job = process.env["CLOUD_RUN_JOB"];
  const project = process.env["GCP_PROJECT_ID"];
  const handoff = `  continue by hand: --args=scan-convert,--apply,--chain-depth=${nextDepth}`;
  if (!job || !project) {
    log.warn(
      `chain: not running as a Cloud Run job — not chaining.\n${handoff}`,
    );
    return;
  }
  const MD = "http://metadata.google.internal/computeMetadata/v1";
  const H = { "Metadata-Flavor": "Google" };
  try {
    const [tokenRes, regionRes] = await Promise.all([
      fetch(`${MD}/instance/service-accounts/default/token`, { headers: H }),
      fetch(`${MD}/instance/region`, { headers: H }),
    ]);
    const token = ((await tokenRes.json()) as { access_token?: string })
      ?.access_token;
    // "projects/<num>/regions/asia-south1" -> "asia-south1"
    const region = (await regionRes.text()).split("/").pop();
    if (!token || !region) {
      log.warn(
        `chain: could not resolve token/region — not chaining.\n${handoff}`,
      );
      return;
    }
    const res = await fetch(
      `https://${region}-run.googleapis.com/v2/projects/${project}` +
        `/locations/${region}/jobs/${job}:run`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                args: ["scan-convert", "--apply", `--chain-depth=${nextDepth}`],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      log.warn(
        `chain: jobs:run returned ${res.status} — not chained.\n${handoff}`,
      );
      return;
    }
    log.info(`CHAINED -> link ${nextDepth} triggered on ${job}`);
  } catch (err) {
    log.warn(`chain: failed (${errText(err)}) — not chained.\n${handoff}`);
  }
}

/**
 * Run one subcommand over several inputs and fold the outcomes — MONEY-1345.
 *
 * The single-input path is preserved EXACTLY: one item returns that item's own
 * outcome object untouched, so nothing about the existing behaviour is routed
 * through new code. Only a genuine wave folds.
 *
 * `stop` reports the FIRST non-drained reason rather than the last, because
 * the first is what an operator has to act on; `remaining` and `failed` sum.
 */
async function runWave(
  inputs: readonly string[],
  run: (input: string) => Promise<RunOutcome>,
  opts: { stopOnFailure?: boolean } = {},
): Promise<RunOutcome> {
  const stopOnFailure = opts.stopOnFailure !== false;
  const outcomes: RunOutcome[] = [];

  for (const [i, input] of inputs.entries()) {
    if (inputs.length > 1) {
      log.info(`wave ${i + 1}/${inputs.length}: ${input}`);
    }
    const outcome = await run(input);
    outcomes.push(outcome);
    if (stopOnFailure && outcome.stop === "failed") {
      const left = inputs.slice(i + 1);
      if (left.length > 0) {
        log.error(
          `wave STOPPED at ${input}. ${left.length} input(s) NOT submitted — ` +
            `resume with ${left.join(",")}`,
        );
      }
      break;
    }
  }

  const first = outcomes[0];
  if (outcomes.length === 1 && first) return first;

  const merged: RunOutcome = {
    stop: outcomes.find((o) => o.stop !== "drained")?.stop ?? "drained",
    selected: outcomes.reduce((a, o) => a + o.selected, 0),
    remaining: outcomes.reduce((a, o) => a + Math.max(0, o.remaining), 0),
    failed: outcomes.reduce((a, o) => a + o.failed, 0),
    transportFailures: outcomes.reduce((a, o) => a + o.transportFailures, 0),
    writes: outcomes[outcomes.length - 1]?.writes ?? newWrites(),
    tally: {},
    note: `wave of ${outcomes.length}/${inputs.length} input(s)`,
  };
  for (const o of outcomes) {
    for (const [k, v] of Object.entries(o.tally)) {
      merged.tally[k] = (merged.tally[k] ?? 0) + v;
    }
  }
  return merged;
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  // The LITERAL, not `JOB`, and that is required rather than sloppy:
  // `job-build-provenance.test.ts` matches
  // `reportBuildProvenance(log, "<entrypoint>")` in source, so a name passed
  // through a const reads as "this job does not report its build" — which is
  // the one signal that tells you a Cloud Run JOB is running weeks-old code.
  reportBuildProvenance(log, "doc-ingest-backfill");

  const { args, errors } = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    await prisma.$disconnect();
    return;
  }
  if (errors.length > 0) {
    for (const e of errors) log.warn(`ARGUMENT ERROR: ${e}`);
    log.warn(HELP);
    process.exitCode = EXIT.USAGE;
    await prisma.$disconnect();
    return;
  }

  log.info(
    `${args.subcommand} ${describeApply(args)} limit=${args.limit} ` +
      `budgetSec=${args.budgetMs / 1000} maxBatches=${args.maxBatches} ` +
      `symbols=${args.symbols?.length ?? "all"} ` +
      `docTypes=${args.docTypes?.join("+") ?? "all"} ` +
      // NAMED on every run, including the unsharded one. A task that silently
      // took 1/4 of the corpus and reported a drained queue is the failure
      // this whole mechanism has to stay visible to.
      `shard=${args.shard ? `${args.shard.index}/${args.shard.count}` : "none"} ` +
      `concurrency=${args.concurrency}`,
  );

  const writes = newWrites();
  let outcome: RunOutcome;
  try {
    switch (args.subcommand) {
      case "scan-convert":
        outcome = await runScanConvert(args, writes);
        break;
      case "batch-build":
        outcome = await runBatchBuild(args, writes);
        break;
      case "batch-submit":
        // A WAVE IS SEQUENTIAL, and stops at the first failure. Each file is a
        // separate metered submission, so continuing past a refusal would
        // spend the rest of the wave against whatever refused the first —
        // typically an enqueued-token ceiling, which the next file hits too.
        // The unsubmitted files are NAMED so the operator resumes rather than
        // re-running the whole wave and paying twice for what landed.
        outcome = await runWave(args.files ?? [args.file ?? ""], (file) =>
          runBatchSubmit({ ...args, file }, writes),
        );
        break;
      case "batch-ingest":
        // Ingest is NOT stopped by a failure: each job's results are
        // independent, already paid for, and a job that cannot be read must
        // not strand the ones that can.
        outcome = await runWave(
          args.batchJobs ?? [args.batchJob ?? ""],
          (batchJob) => runBatchIngest({ ...args, batchJob }, writes),
          { stopOnFailure: false },
        );
        break;
      case "sweep":
        outcome = await runSweep(args, writes);
        break;
    }
  } catch (err) {
    log.error(`FAILED: ${errText(err)}`);
    outcome = {
      stop: "failed",
      selected: 0,
      remaining: -1,
      failed: 1,
      transportFailures: 0,
      writes,
      tally: {},
      note: errText(err),
    };
  }

  // ── ONE structured summary, always — including the zero case ──
  //
  // `selected` BESIDE `remaining` is the whole point: an empty selection and a
  // drained queue produce the same exit code, and this line is the only thing
  // that tells them apart. `apply` is restated here because a run whose flag
  // was narrowed reads identically to one that was never armed.
  log.info(
    `SUMMARY ${args.subcommand} ${describeApply(args)} ` +
      `stop=${outcome.stop} selected=${outcome.selected} ` +
      `remaining=${outcome.remaining} failed=${outcome.failed} ` +
      `gbRead=${gb(outcome.tally["bytesRead"] ?? 0)} ` +
      `writes=${JSON.stringify(outcome.writes)} ` +
      `tally=${JSON.stringify(outcome.tally)}`,
  );
  if (outcome.note) log.info(outcome.note);

  reportJobOutcome({
    job: JOB,
    selected: outcome.selected,
    // WRITES, never attempts. Zero here beside a positive `selected` is the
    // alert condition, and it must not be satisfiable by a counter that moved
    // before the call it counted.
    written: Object.values(outcome.writes).reduce((a, b) => a + b, 0),
    failed: outcome.failed,
    transportFailures: outcome.transportFailures,
    ...(outcome.note ? { skippedReason: outcome.note } : {}),
  });

  // SELF-CONTINUE. Only scan-convert: it is the one subcommand that drains an
  // open queue on a wall clock, and the one that silently stalled.
  if (args.subcommand === "scan-convert") {
    const chain = shouldChainScanConvert({
      depth: args.chainDepth,
      converted: outcome.writes.converted ?? 0,
      remaining: outcome.remaining,
      stop: outcome.stop,
      apply: resolveApply(args),
      taskCount: args.shard?.count ?? 1,
    });
    if (chain.chain) {
      await triggerNextScanConvert(args.chainDepth + 1);
    } else {
      log.info(
        `not chaining (${chain.reason}) — depth ${args.chainDepth}/${SCAN_CONVERT_MAX_CHAIN_DEPTH}`,
      );
    }
  }

  process.exitCode = exitCodeFor(outcome);
  // MONEY-1278 — flush before the process ends. `datadog-metrics` batches on a
  // 15-second timer, so a job that exits first takes the outcome above with it:
  // the counters die in the buffer, nothing reaches Datadog, and the job's
  // monitor reads NO DATA — which is indistinguishable from health once its
  // no-data notification is muted. Never throws (see flushMetrics).
  await flushMetrics();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(`[${JOB}] FAILED`, err);
  await flushMetrics();
  await prisma.$disconnect();
  process.exit(EXIT.FAILED);
});
