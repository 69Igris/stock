/**
 * THE SWEEP that feeds the `us-filing-insight` lane — MONEY-1324 (P17), I/O half.
 *
 * Cloud Scheduler fires `{"mode":"sweep"}` every 10 minutes. This selects the
 * cohort, diffs it against `us_filing_insights`, and publishes ONE MESSAGE PER
 * DOCUMENT back onto the SAME topic. It writes no row of its own.
 *
 * ## Why the sweep is the retry channel
 *
 * `routes/us-filing-insight.ts` ACKs 200 on every path including a throw, so
 * Pub/Sub never redelivers. That is correct for this lane — a model call that
 * already spent tokens must not be re-run by a redelivery, and a document with
 * no readable text fails identically forever — but it means the ONLY way back
 * into the queue is a status the sweep re-selects.
 *
 * That status is `FAILED`. `buildSweepableInsightWhere()` names it,
 * `decideInsightAction` returns `analyse` for it ("text-changed-or-retry"), and
 * this job is the reader that makes both true. `SKIPPED` is deliberately NOT
 * re-selected: it is terminal by CONTENT, and re-offering it would buy the same
 * non-answer on every tick forever. MONEY-1314's `FAILED` black hole — a status
 * no query selected, so one model blip dropped a document permanently — is the
 * defect this arrangement exists to avoid.
 *
 * ## Why the whole cohort is diffed rather than paged
 *
 * A page ordered `filedAt ASC` fills its head with READY rows and never reaches
 * the tail. That is the rotation defect measured twice in this repo
 * (MONEY-1211: 681 of 781 symbols never selected; MONEY-1255: a growing queue
 * with ~2 years of undrainable backlog). A full in-memory diff has no head to
 * get stuck behind. `SWEEP_SCAN_CAP` bounds it and the breach is REPORTED
 * rather than silently truncating — `PARSE_SCAN_CAP` was already found breached
 * by a job that had no way to say so.
 *
 * ## TWO READS, AND THEY ARE NOT SYMMETRIC
 *
 * The cohort read is capped, ordered, filtered and its truncation is checked.
 * The INSIGHT read below it was `take: SWEEP_SCAN_CAP + 1` and nothing else —
 * no `where`, no `orderBy`, no check — so past 20,000 rows it returned an
 * ARBITRARY slice, and any READY row outside it read as never-analysed. The
 * document would be re-published, re-read and re-ANALYSED, PAID, every ten
 * minutes, with `owed` climbing and every counter healthy.
 *
 * It is now narrowed to the accessions the cohort read actually produced, in
 * chunks of `INSIGHT_READ_CHUNK`, so its size is bounded by the scan rather
 * than by the table. It is NOT narrowed by `insightStatus`: dropping the READY
 * rows is the same bug written on purpose.
 *
 * The remaining ceiling breach SUPPRESSES the fan-out instead of merely being
 * reported, and that asymmetry with `scanTruncated` is deliberate. A truncated
 * COHORT scan is a degradation — the tick considered the oldest N, which is the
 * right N. A truncated INSIGHT read is a correctness failure that costs money
 * in the direction it fails.
 *
 * ## Arming
 *
 * `US_FILING_INSIGHT_APPLY` must be the literal string "true". It ships PRESENT
 * and "false" in both cloudbuild specs, because absent and explicitly-false must
 * not be the same state — that is how `MF_METADATA_PROVIDER` disabled its job
 * silently for months (MONEY-1214).
 *
 * DISARMED STILL RUNS. The tick selects, diffs and reports its queue depth; it
 * only stops short of publishing. A lane whose off state emits no series at all
 * is a lane nobody can watch fill up, and the queue depth is the number the
 * arming decision will be made on.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { getTopicName, PUBSUB_TOPICS } from "@usemoney/types/pubsub";

import {
  buildInsightCohortOrderBy,
  buildInsightCohortWhere,
} from "./us-filing-insight-selectors-logic";
import {
  isFilingInsightArmed,
  planInsightFanout,
  planInsightReadChunks,
  resolveFanoutLimit,
  SWEEP_SCAN_CAP,
  US_FILING_INSIGHT_APPLY_ENV,
  type FanoutPlan,
  type SweepDocument,
  type SweepInsightRow,
} from "./filing-insight-sweep-logic";

/** The job id the metrics carry. Its own series, separate from the leaves'. */
export const FILING_INSIGHT_SWEEP_JOB = "us-filing-insight-sweep";

const logger = {
  info: (m: string) => console.log(`[${FILING_INSIGHT_SWEEP_JOB}] ${m}`),
  warn: (m: string) => console.warn(`[${FILING_INSIGHT_SWEEP_JOB}] ${m}`),
};

export interface FilingInsightSweepMessage {
  /** Literal "sweep". The route refuses to infer this from an absent field. */
  mode: "sweep";
  /** Messages this tick may publish. Clamped to `MAX_FANOUT_LIMIT`. */
  limit?: number;
  /** Narrow to a hand-checked pilot. Forwarded to `buildInsightCohortWhere`. */
  symbols?: string[];
  /** ISO date; only documents filed on or after it. The backfill's window. */
  filedFrom?: string;
}

export interface FilingInsightSweepOutcome {
  ok: boolean;
  armed: boolean;
  /** Documents owed an analysis — the queue depth, before the limit. */
  owed: number;
  /** Messages actually published. Zero whenever the lane is disarmed. */
  published: number;
  upToDate: number;
  cooldownHeld: number;
  missingId: number;
  scanned: number;
  /** True when the cohort read hit `SWEEP_SCAN_CAP`. See the docblock. */
  scanTruncated: boolean;
  /** `us_filing_insights` rows loaded for the scanned accessions. */
  insightsRead: number;
  /**
   * True when the INSIGHT read hit its ceiling — a different and much worse
   * failure than `scanTruncated`, and the reason they are two fields.
   *
   * A truncated DOCUMENT scan is a degradation: the tick considered the oldest
   * N of the cohort, which is the right N, and the rest arrive next tick. A
   * truncated INSIGHT read is a CORRECTNESS failure: a row we failed to load
   * makes an already-READY document look never-analysed, so the tick would
   * publish it and buy a PAID re-reading of a document it has already read.
   * The sweep therefore refuses to publish at all while this is true.
   */
  insightScanTruncated: boolean;
  publishFailures: number;
  reason: string;
}

export interface FilingInsightSweepDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Overridable so the fan-out can be asserted without a Pub/Sub client. */
  publish?: (documentId: string) => Promise<void>;
}

/** Only the columns the planner reads. A cohort diff must not pull text. */
const DOCUMENT_SELECT = {
  id: true,
  accession: true,
  sequence: true,
  cik10: true,
  symbol: true,
  form: true,
  documentType: true,
  filedAt: true,
  textPath: true,
  textHash: true,
} as const;

const INSIGHT_SELECT = {
  accession: true,
  sequence: true,
  insightStatus: true,
  sourceTextHash: true,
  promptVersion: true,
  analysedAt: true,
} as const;

async function defaultPublish(documentId: string): Promise<void> {
  const topic = getPubSubClient().topic(
    getTopicName(PUBSUB_TOPICS.US_FILING_INSIGHT),
  );
  await topic.publishMessage({ json: { documentId } });
}

export async function processFilingInsightSweep(
  message: FilingInsightSweepMessage,
  deps: FilingInsightSweepDeps = {},
): Promise<FilingInsightSweepOutcome> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const publish = deps.publish ?? defaultPublish;
  const limit = resolveFanoutLimit(message.limit);
  const armed = isFilingInsightArmed(env);

  const outcome: FilingInsightSweepOutcome = {
    ok: true,
    armed,
    owed: 0,
    published: 0,
    upToDate: 0,
    cooldownHeld: 0,
    missingId: 0,
    scanned: 0,
    scanTruncated: false,
    insightsRead: 0,
    insightScanTruncated: false,
    publishFailures: 0,
    reason: "not-started",
  };

  try {
    const filedFrom = parseFiledFrom(message.filedFrom);
    const where = buildInsightCohortWhere({
      ...(filedFrom ? { filedAtFrom: filedFrom } : {}),
      ...(message.symbols && message.symbols.length > 0
        ? { symbols: message.symbols }
        : {}),
    });

    // ONE PAST THE CAP, so a truncation is a fact this run can REPORT rather
    // than a silent short read that looks like a small cohort.
    const rows = (await prisma.usFilingDocument.findMany({
      where: where as never,
      orderBy: buildInsightCohortOrderBy() as never,
      take: SWEEP_SCAN_CAP + 1,
      select: DOCUMENT_SELECT,
    })) as unknown as SweepDocument[];

    outcome.scanTruncated = rows.length > SWEEP_SCAN_CAP;
    const documents = outcome.scanTruncated
      ? rows.slice(0, SWEEP_SCAN_CAP)
      : rows;

    // THE INSIGHT SIDE, NARROWED TO WHAT THE PLANNER CAN ACTUALLY LOOK UP.
    //
    // It must NOT be narrowed by STATUS — dropping the READY rows would make
    // every document the sweep has already read look owed, and it would
    // re-publish the whole cohort into paid model calls. But it can be narrowed
    // by KEY, because the only rows the planner ever asks for are those keyed
    // to a document it just scanned. That is a superset-free narrowing: same
    // answer, bounded by the scan instead of by the table.
    //
    // Read whole, this was `take: SWEEP_SCAN_CAP + 1` with no `where`, no
    // `orderBy` and no truncation check — so past 20,000 rows MongoDB returned
    // an arbitrary slice and any READY row outside it read as never-analysed.
    // Chunking by accession removes the arbitrary slice; the ceiling below is
    // what remains of the tripwire, and it is CHECKED rather than assumed.
    const insights: SweepInsightRow[] = [];
    for (const accessions of planInsightReadChunks(documents)) {
      const page = (await prisma.usFilingInsight.findMany({
        where: { accession: { in: [...accessions] } } as never,
        // TOTAL and deterministic, so a ceiling breach truncates the same rows
        // on every tick rather than a different arbitrary set each time.
        orderBy: [{ accession: "asc" }, { sequence: "asc" }] as never,
        take: SWEEP_SCAN_CAP + 1 - insights.length,
        select: INSIGHT_SELECT,
      })) as unknown as SweepInsightRow[];
      insights.push(...page);
      if (insights.length > SWEEP_SCAN_CAP) {
        outcome.insightScanTruncated = true;
        break;
      }
    }
    outcome.insightsRead = insights.length;

    const plan: FanoutPlan = planInsightFanout({
      documents,
      insights,
      now: now(),
      limit,
    });

    outcome.owed = plan.owed;
    outcome.upToDate = plan.upToDate;
    outcome.cooldownHeld = plan.cooldownHeld;
    outcome.missingId = plan.missingId;
    outcome.scanned = plan.scanned;

    if (outcome.insightScanTruncated) {
      // FAIL-SAFE, and asymmetric with `scanTruncated` on purpose. An
      // incomplete insight index does not make the fan-out smaller, it makes it
      // WRONG in the direction that spends money: every READY row we failed to
      // load reads as never-analysed. Publishing anyway would buy a paid
      // re-reading of documents already read, every ten minutes, while `owed`
      // climbed and looked like honest backlog.
      outcome.ok = false;
      outcome.reason =
        `insight read hit SWEEP_SCAN_CAP=${SWEEP_SCAN_CAP} — NOT PUBLISHING. ` +
        "An unread READY row is indistinguishable from a never-analysed " +
        "document, so the fan-out would re-buy readings we already hold. Fix " +
        "with a watermark, not a bigger cap.";
      logger.warn(
        `${outcome.reason} (scanned=${plan.scanned} owed=${plan.owed})`,
      );
      return outcome;
    }

    if (!armed) {
      outcome.reason = `disarmed (${US_FILING_INSIGHT_APPLY_ENV} is not "true")`;
      logger.info(
        `${outcome.reason} — owed=${plan.owed} upToDate=${plan.upToDate} ` +
          `cooldownHeld=${plan.cooldownHeld} scanned=${plan.scanned}` +
          truncationNote(outcome),
      );
      return outcome;
    }

    for (const documentId of plan.publish) {
      try {
        await publish(documentId);
        outcome.published++;
      } catch (err) {
        // A publish failure loses ONE document for ONE tick; the next sweep
        // re-selects it, because nothing was written to take it out of the
        // queue. Counted rather than thrown, so one bad message does not
        // abandon the rest of the fan-out.
        outcome.publishFailures++;
        logger.warn(`publish failed for ${documentId}: ${errText(err)}`);
      }
    }

    outcome.reason =
      plan.owed === 0
        ? "queue-empty"
        : `published ${outcome.published} of ${plan.owed} owed`;
    if (outcome.publishFailures > 0) outcome.ok = false;
    logger.info(
      `${outcome.reason} (limit=${limit} upToDate=${plan.upToDate} ` +
        `cooldownHeld=${plan.cooldownHeld} scanned=${plan.scanned} ` +
        `insightsRead=${outcome.insightsRead})` +
        truncationNote(outcome),
    );
    return outcome;
  } catch (err) {
    outcome.ok = false;
    outcome.reason = `unhandled: ${errText(err)}`;
    logger.warn(outcome.reason);
    return outcome;
  } finally {
    // In a `finally` on EVERY path, so an idle tick still emits a metric. A
    // monitor with `notify_no_data` that has never been green is a monitor
    // somebody mutes (MONEY-1238, and `stock-document-extract` had its report
    // below an empty-queue early return for exactly this reason).
    //
    // `written` is MESSAGES PUBLISHED. This job persists nothing — its product
    // IS the fan-out — so that is the honest analogue, and `selected > 0 &&
    // written === 0` still means what the alert says: work was found and none
    // of it moved.
    reportJobOutcome({
      job: FILING_INSIGHT_SWEEP_JOB,
      selected: outcome.owed,
      written: outcome.published,
      failed: outcome.missingId,
      transportFailures: outcome.publishFailures,
      // Required reading whenever selected > 0 and written === 0 — which is
      // the NORMAL disarmed state, and must say so rather than look like a
      // dead job.
      // COMPOSED, never CHOSEN. This was a ternary whose truncation arm sat in
      // the ELSE branch of `owed > 0 && published === 0` — and that condition
      // is exactly the SHIPPING state: `US_FILING_INSIGHT_APPLY` ships "false",
      // so a disarmed tick with a non-empty queue always took the first arm and
      // the tripwire was unreachable in the only configuration running. A
      // tripwire that cannot fire in production is not a tripwire, and no log
      // line printed it either. Both facts now travel together.
      skippedReason: composeSkippedReason(outcome),
    });
  }
}

/**
 * The truncation facts, as a log suffix. Empty when neither tripped, so an
 * ordinary tick's log line is unchanged.
 */
function truncationNote(outcome: FilingInsightSweepOutcome): string {
  const notes: string[] = [];
  if (outcome.scanTruncated) {
    notes.push(
      `COHORT SCAN TRUNCATED at SWEEP_SCAN_CAP=${SWEEP_SCAN_CAP} — the cohort ` +
        "outgrew the full diff; fix with a watermark, not a bigger cap",
    );
  }
  if (outcome.insightScanTruncated) {
    notes.push(
      `INSIGHT READ TRUNCATED at SWEEP_SCAN_CAP=${SWEEP_SCAN_CAP} — fan-out ` +
        "SUPPRESSED to avoid re-buying readings we already hold",
    );
  }
  return notes.length > 0 ? ` [${notes.join(" | ")}]` : "";
}

/**
 * Why this tick wrote less than its queue depth — every reason that applies,
 * not the first one a ternary happens to reach.
 *
 * `undefined` only when there is genuinely nothing to say: nothing owed that
 * went unpublished, and neither scan truncated.
 */
export function composeSkippedReason(
  outcome: Pick<
    FilingInsightSweepOutcome,
    "owed" | "published" | "reason" | "scanTruncated" | "insightScanTruncated"
  >,
): string | undefined {
  const parts: string[] = [];
  if (outcome.owed > 0 && outcome.published === 0) parts.push(outcome.reason);
  if (outcome.scanTruncated) {
    parts.push(
      `cohort scan hit SWEEP_SCAN_CAP=${SWEEP_SCAN_CAP}; the cohort outgrew the full diff`,
    );
  }
  if (outcome.insightScanTruncated) {
    parts.push(
      `insight read hit SWEEP_SCAN_CAP=${SWEEP_SCAN_CAP}; fan-out suppressed — ` +
        "an unread READY row reads as never-analysed and would be re-bought",
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** An unparseable `filedFrom` is IGNORED, never treated as the epoch. */
function parseFiledFrom(value?: string): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
