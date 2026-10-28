/**
 * The Databento entitlement probe — MONEY-1373. FOUNDER-RUN, TTY-gated.
 *
 * Buys the smallest thing the vendor sells — ONE symbol for ONE session — and
 * walks it the whole way: quote, submit, poll, download, checksum, load,
 * coverage. It exists because every question that decides whether the harvest
 * is safe to arm is a MEASUREMENT, and three of them cannot be answered from
 * the documentation:
 *
 *   1. IS THE SUBSCRIPTION LIVE? `metadata.get_cost` "respects any discounts
 *      provided by flat rate plans", so a window included in Standard quotes
 *      $0.00 and a metered one does not. That single number is the difference
 *      between a $199 month and an open-ended usage bill.
 *   2. DOES OUR SYMBOL NOTATION MATCH THEIRS? `symbology.resolve`'s `not_found`
 *      list is the useful half of the response, and it is what finishes the
 *      conversion table in `databento-logic.ts`.
 *   3. WHEN DOES A SESSION ACTUALLY LAND? The T+1 embargo is documented as
 *      "next day"; the append's cron is sized against ~09:00 UTC, which is an
 *      estimate until a real job is timed.
 *
 * ## Why it is TTY-gated and has no --yes
 *
 * The same anti-wrapper guard as `reclassify-instruments.ts`. This spends real
 * money, and a script that can be driven by a wrapper WILL be driven by one —
 * `run-market-data-job.sh` calls it, and a `--yes` would make an interactive
 * safeguard into a flag someone adds to a cron. There is deliberately no way to
 * answer the prompt except by typing at a terminal.
 *
 * ## The cap is a REFUSAL, not a trim
 *
 * A quote above {@link PROBE_MAX_USD} aborts. It does not shrink the window to
 * fit — a narrowed probe measures something nobody asked about and reports
 * success, which is the failure this whole ticket keeps guarding against. If a
 * one-symbol-day genuinely costs more than five cents, that IS the finding.
 *
 * ## Usage
 *
 *   node --import tsx scripts/data/databento-probe.ts                  # quote only, free
 *   node --import tsx scripts/data/databento-probe.ts --symbol=AAPL --date=2026-09-01
 *   node --import tsx scripts/data/databento-probe.ts --apply          # SPENDS. TTY only.
 *
 * Run it on QA. QA never spends at Databento in the steady state, and this is
 * the one deliberate exception — a probe against prod would put a PROBE row in
 * the production ledger for a window nothing reads.
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";

import prisma from "@usemoney/database";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import {
  PROBE_MAX_USD,
  mayPromptForSpend,
  quoteExceedsProbeCap,
} from "@usemoney/core/market-data/databento/databento-harvest-logic";
import {
  DEFAULT_DATABENTO_DATASET,
  EQUS_MINI_HISTORY_FLOOR,
  classifyFile,
  databentoArchiveKey,
  toDatabentoSymbol,
} from "@usemoney/core/market-data/databento/databento-logic";
import {
  downloadToArchive,
  getCost,
  getDatasetRange,
  getJobDetails,
  listFiles,
  resolveSymbology,
  submitBatchJob,
  resolveDatabentoEnv,
} from "@usemoney/core/market-data/databento/databento-client";
import { getDatabentoArchiveStore } from "@usemoney/core/market-data/databento/databento-archive";
import {
  formatBudgetLine,
  withDatabentoBudget,
} from "@usemoney/core/market-data/databento/databento-budget";
import { symbolsHash } from "@usemoney/core/market-data/databento/databento-manifest-logic";
import { createBudgetDeps } from "@usemoney/core/market-data/databento/databento-repo";
import {
  isUsTradingDay,
  lastCompletedUsSession,
  usMarketDayBoundsUtc,
} from "@usemoney/core/market-data/us-market-hours";

import { initDatabentoArchiveStore } from "../../workers/src/lib/databento-archive-gcs";


const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  {
    // `load` was declared here and READ BY NOTHING. A flag that parses,
    // reports success and changes no behaviour is the TIINGO_RT_BOATS shape:
    // it looks like it worked. The probe measures; loading is the harvest's
    // job and has its own arm. Removed, so `--load` now exits 1 as an unknown
    // flag rather than being silently accepted.
    bare: ["apply"],
    valued: ["symbol", "date", "schema", "dataset", "out"],
    numeric: [],
  },
  "databento-probe",
);

const APPLY = ARGS.has("apply");
const SYMBOL = (ARGS.value("symbol") ?? "AAPL").toUpperCase();
const SCHEMA = ARGS.value("schema") ?? "ohlcv-1m";
const DATASET = ARGS.value("dataset") ?? DEFAULT_DATABENTO_DATASET;
const OUT = ARGS.value("out");

const log = (...a: unknown[]) => console.log("[databento-probe]", ...a);

/** Everything the probe learned, for the runbook's step 0 answers. */
const findings: Record<string, unknown> = {};

function resolveProbeDate(now: Date): string {
  const asked = ARGS.value("date");
  if (asked === undefined) return lastCompletedUsSession(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) {
    throw new Error(`--date=${asked} must be YYYY-MM-DD`);
  }
  if (!isUsTradingDay(asked)) {
    // A probe on a closed day returns zero records and costs a request. Worse,
    // it would look exactly like an entitlement failure — which is the one
    // thing this script exists to distinguish.
    throw new Error(
      `--date=${asked} is not a US trading day. A probe there returns zero ` +
        "records, which is indistinguishable from the entitlement failure " +
        "this script exists to detect.",
    );
  }
  if (asked < EQUS_MINI_HISTORY_FLOOR) {
    throw new Error(
      `--date=${asked} is before ${EQUS_MINI_HISTORY_FLOOR}, which is where ` +
        `${DEFAULT_DATABENTO_DATASET} history begins. The empty result would ` +
        "read as a broken query.",
    );
  }
  return asked;
}

/**
 * Ask, at a terminal, and accept only "yes".
 *
 * No `--yes`, deliberately. A prompt that a wrapper can answer is not a
 * safeguard, and at EOF the callback never fires — `main()` never settles, its
 * `.finally` never runs, and node exits 0 having spent nothing while a
 * wrapper's `&&` reads that as success.
 */
async function confirmSpend(quoteUsd: number, window: string): Promise<void> {
  if (!mayPromptForSpend(process.stdin.isTTY)) {
    console.error(
      "\n  Refusing to spend: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n  This script is deliberately interactive — run it " +
        "from a terminal.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n⚠️  This SPENDS at Databento.\n` +
      `      dataset : ${DATASET}\n` +
      `      schema  : ${SCHEMA}\n` +
      `      symbol  : ${SYMBOL} (${toDatabentoSymbol(SYMBOL)})\n` +
      `      window  : ${window}\n` +
      `      quote   : $${quoteUsd.toFixed(4)}\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    // Non-zero: an abort is NOT success. With exit(0) a wrapper's `&&` treats
    // "the operator said no" as "step completed".
    console.log("Aborted.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const date = resolveProbeDate(now);
  const bounds = usMarketDayBoundsUtc(date);
  const request = {
    dataset: DATASET,
    schema: SCHEMA as never,
    symbols: [SYMBOL],
    start: new Date(bounds.startMs),
    end: new Date(bounds.endMs),
    // One symbol, one day: every split shape yields the same single file, so
    // these state the obvious rather than choosing anything. They are here
    // because the fields are REQUIRED (MONEY-1375) — the old `?? "day"`
    // fallback is what let a real purchase be shaped by an omission.
    splitSymbols: false,
    splitDuration: "none" as const,
  };
  const window = `${new Date(bounds.startMs).toISOString()} .. ${new Date(bounds.endMs).toISOString()}`;
  log(`probing ${SYMBOL} ${SCHEMA} on ${date}`);
  log(`window ${window}`);

  // ── 1. What the vendor holds ────────────────────────────────────────────
  const range = await getDatasetRange(DATASET);
  findings["datasetRange"] = {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    bySchema: Object.fromEntries(
      Object.entries(range.bySchema).map(([k, v]) => [
        k,
        { start: v.start.toISOString(), end: v.end.toISOString() },
      ]),
    ),
  };
  log(`dataset range ${range.start.toISOString()} .. ${range.end.toISOString()} (end EXCLUSIVE)`);
  const schemaRange = range.bySchema[SCHEMA];
  if (schemaRange) {
    log(`  ${SCHEMA}: .. ${schemaRange.end.toISOString()}`);
    // THE EMBARGO, measured. The append's 15:00 IST cron is sized against an
    // estimated ~09:00 UTC release; this is the number that confirms or moves
    // it.
    findings["embargoLagHours"] =
      (now.getTime() - schemaRange.end.getTime()) / 3_600_000;
  }

  // ── 2. Does our notation match theirs ───────────────────────────────────
  // `end_date` is EXCLUSIVE at the vendor and must be strictly after
  // `start_date` — the same day for both is a 422
  // (`data_date_range_start_on_or_after_end`), measured on the first live call.
  const symbology = await resolveSymbology({
    dataset: DATASET,
    symbols: [SYMBOL],
    startDate: date,
    endDate: new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10),
  });
  findings["symbology"] = symbology;
  log(
    `symbology: ${SYMBOL} -> ${toDatabentoSymbol(SYMBOL)}; ` +
      `notFound=${JSON.stringify(symbology.notFound)}`,
  );

  // ── 3. The quote — free, and the answer to "is the subscription live" ───
  // Clamp to the vendor's available end before quoting — measured: the ET
  // session end is 4 h past the vendor's UTC-midnight range end, and the
  // vendor 422s any `end` past it.
  const perSchema = range.bySchema[SCHEMA];
  const availableEnd = (perSchema ?? range).end.getTime();
  if (availableEnd < request.end.getTime()) {
    request.end = new Date(availableEnd);
    log(`window end clamped to the vendor's range end ${request.end.toISOString()}`);
  }
  if (request.start.getTime() >= request.end.getTime()) {
    throw new Error(
      `${date} is not yet published by the vendor (range end ` +
        `${new Date(availableEnd).toISOString()}). Pick an earlier --date.`,
    );
  }
  const quoteUsd = await getCost(request);
  findings["quoteUsd"] = quoteUsd;
  log(
    `quote $${quoteUsd.toFixed(4)} — ` +
      (quoteUsd === 0
        ? "ZERO, which means this window is INCLUDED in a flat-rate plan"
        : "NON-ZERO, so this window is billed at usage prices"),
  );

  if (!APPLY) {
    log("DRY RUN — nothing was submitted. Pass --apply (from a terminal) to spend.");
    writeFindings();
    return;
  }

  if (quoteExceedsProbeCap(quoteUsd)) {
    // REFUSED, not trimmed. A narrowed probe measures something nobody asked
    // about and reports success.
    throw new Error(
      `The quote is $${quoteUsd.toFixed(4)}, above the probe cap of ` +
        `$${PROBE_MAX_USD.toFixed(2)}. Refusing rather than narrowing the ` +
        "window — a one-symbol-day costing this much means the request is not " +
        "what it looks like (a mis-parsed range, the wrong schema, or a " +
        "symbol list that resolved to everything). Read the quote first.",
    );
  }

  const archiveReady = initDatabentoArchiveStore();
  const store = getDatabentoArchiveStore();
  if (!archiveReady || store === null) {
    throw new Error(
      "GCP_STORAGE_BUCKET is unset, so the downloaded bytes would land " +
        "nowhere. Refusing to spend.",
    );
  }

  await confirmSpend(quoteUsd, window);

  // ── 4. Submit — THROUGH THE LEDGER, not around it ───────────────────────
  //
  // The probe spends real money, so it counts against the same monthly budget
  // as the harvest and lands in the same inventory with `purpose: "PROBE"`.
  // Its own $0.05 cap and TTY prompt are ADDITIONAL guards, never a substitute:
  // a spending path outside the ledger is exactly the MONEY-1309 shape, where
  // a guard wired at one of five legs under-reported spend by ~80% and
  // manufactured headroom that did not exist.
  //
  // It also buys idempotency for free — a second probe of the same window
  // finds the existing row and reuses it instead of paying twice.
  const outcome = await withDatabentoBudget(
    {
      purpose: "PROBE",
      entryId: `probe:${SYMBOL}:${date}`,
      schema: SCHEMA,
      symbolsHash: symbolsHash([SYMBOL]),
      start: request.start,
      end: request.end,
      dataset: DATASET,
      symbolCount: 1,
      request,
      apply: true,
    },
    createBudgetDeps({
      // THE SAME RESOLVER THE TWO JOBS USE. It was
      // `process.env["DATABENTO_ENV"] ?? "qa"`, unvalidated — so a typo
      // (`DATABENTO_ENV=production`) wrote that string onto a ledger row, and
      // the env is what scopes the spend sum and the idempotent window lookup.
      // The probe writes into the SAME inventory as the harvest.
      env: resolveDatabentoEnv(),
      symbolSetLabel: () => `PROBE:${SYMBOL}`,
    }),
    async () => quoteUsd,
    () => submitBatchJob(request),
  );
  log(formatBudgetLine({ entryId: `probe:${SYMBOL}:${date}`, outcome }));

  const jobId =
    outcome.status === "submitted"
      ? outcome.job.id
      : outcome.status === "reused"
        ? outcome.row.jobId
        : null;
  if (jobId === null) {
    throw new Error(
      "The budget guard returned no job id. A dry-run outcome is impossible " +
        "here (apply is hard-coded true), and a reused row without one means " +
        "a previous probe died between the create and the submit — delete " +
        "that QUOTED row or re-run, which will re-quote it.",
    );
  }
  const job = { ...request, id: jobId, state: "received" as string };
  findings["jobId"] = jobId;
  findings["submittedAt"] = new Date().toISOString();
  log(`job ${jobId}, state ${job.state}`);

  const deadline = Date.now() + 30 * 60_000;
  let details = await getJobDetails(jobId);
  while (details.state !== "done" && details.state !== "expired") {
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not reach 'done' within 30 minutes. It is NOT lost` +
          " — batch output lives 30 days from submission, so re-run the probe" +
          " and it will find the job by id.",
      );
    }
    await new Promise((r) => setTimeout(r, 15_000));
    details = await getJobDetails(jobId);
    log(`  state ${details.state} progress ${details.progress ?? "?"}`);
  }
  findings["timeToDoneSeconds"] =
    (Date.now() - Date.parse(String(findings["submittedAt"]))) / 1000;
  findings["costUsd"] = details.costUsd;
  findings["recordCount"] = details.recordCount;
  findings["tsExpiration"] = details.tsExpiration;
  log(
    `done: cost=$${details.costUsd ?? "null"} records=${details.recordCount ?? "?"} ` +
      `expires=${details.tsExpiration ?? "?"}`,
  );

  const files = await listFiles(jobId);
  findings["files"] = files.map((f) => ({
    filename: f.filename,
    size: f.size,
    kind: classifyFile(f.filename),
  }));
  log(`${files.length} file(s): ${files.map((f) => f.filename).join(", ")}`);

  for (const file of files) {
    const key = databentoArchiveKey({
      dataset: DATASET,
      schema: SCHEMA,
      year: new Date(bounds.startMs).getUTCFullYear(),
      jobId,
      filename: file.filename,
    });
    const { bytes } = await downloadToArchive({ file, key, store });
    log(`  archived ${file.filename} -> ${key} (${bytes} bytes, sha256 verified)`);
  }
  findings["archived"] = true;

  writeFindings();
  log(
    "PROBE COMPLETE. Paste the findings into step 0 of " +
      "docs/reference/databento-harvest-runbook.md.",
  );
}

function writeFindings(): void {
  const json = JSON.stringify(findings, null, 2);
  if (OUT !== undefined) {
    writeFileSync(OUT, json + "\n");
    log(`findings written to ${OUT}`);
  } else {
    console.log(json);
  }
}

main()
  .catch((err) => {
    console.error("[databento-probe] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
