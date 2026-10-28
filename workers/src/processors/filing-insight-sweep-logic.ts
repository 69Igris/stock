/**
 * THE SWEEP that feeds the `us-filing-insight` lane — MONEY-1324 (P17).
 *
 * Pure half. No Prisma, no Pub/Sub, no clock: every decision here is a function
 * of its arguments, so the fan-out, the arming flag and the retry cooldown can
 * be driven from a test without booting a client.
 *
 * ## Why a sweep exists at all
 *
 * `us-filing-insight`'s route ACKs 200 on EVERY path including a throw, which
 * is right for a lane whose failures are either deterministic or expensive to
 * repeat — but it means Pub/Sub NEVER redelivers, so the transport is not the
 * retry channel. The retry channel is the `insightStatus` COLUMN, and something
 * has to read it. That something is this sweep.
 *
 * MONEY-1314's `FAILED` black hole is the shape being avoided: a status was
 * written that no query ever selected, so one model blip dropped a document
 * permanently. Here `FAILED` is explicitly re-selected — `SWEEPABLE_INSIGHT_STATUS`
 * in the selectors module names it — and this planner is the reader that makes
 * that true rather than aspirational.
 *
 * ## ONE TOPIC, TWO MESSAGE SHAPES
 *
 * The sweep and the per-document work share the topic `us-filing-insight`, the
 * same arrangement `broker-sync` uses for its shard fan-out (MONEY-841) and
 * `stock-document-parse` for its self-chain. A sweep message names no document
 * and fans out one message per document ONTO THE SAME TOPIC; a leaf message
 * names exactly one.
 *
 * A message carrying NEITHER is `ignore`, never `sweep`. Reading "no
 * documentId" as "sweep the whole cohort" would turn one malformed leaf into an
 * unintended whole-cohort fan-out — and paid model calls are the one thing that
 * must not happen by accident. The sweep says `mode: "sweep"` out loud.
 */

import {
  INSIGHT_STATUS,
  type CohortDocument,
} from "./us-filing-insight-selectors-logic";
import {
  decideInsightAction,
  type ExistingInsight,
} from "./us-filing-insight-logic";

/* ─────────────────────────────────────────────────────────────────────────
   ARMING
   ──────────────────────────────────────────────────────────────────────── */

/** The env var that arms the fan-out. Absent = OFF. */
export const US_FILING_INSIGHT_APPLY_ENV = "US_FILING_INSIGHT_APPLY";

/**
 * Armed ONLY by the literal string "true".
 *
 * Compared literally, never through `Boolean()` — `Boolean("false")` is true,
 * which would arm the one configuration meant to keep it off.
 *
 * READ PER CALL. `env` defaults to `process.env` in the PARAMETER LIST, which
 * is evaluated on every invocation; a module-scope const would freeze at import
 * and, on a warm Cloud Run container, turn a redeployed switch into no switch
 * at all (the bug already documented on `bse-client.ts`'s retry config and on
 * both XBRL arm flags).
 *
 * DISARMED IS NOT INERT. The sweep still SELECTS and still reports its queue
 * depth — it just publishes nothing. Measuring costs nothing and a lane whose
 * disarmed state emits no series at all is a lane nobody can see fill up.
 */
export function isFilingInsightArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[US_FILING_INSIGHT_APPLY_ENV] === "true";
}

/* ─────────────────────────────────────────────────────────────────────────
   SIZING
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How long a FAILED insight must sit before the sweep offers it again.
 *
 * The sweep runs every 10 minutes. Without a cooldown a permanently-failing
 * document buys 144 model calls a day, and a Gemini outage re-offers the WHOLE
 * cohort every tick — a thundering herd against a metered upstream, which is
 * the one failure where a retry is actively harmful (MONEY-853).
 *
 * Six hours costs freshness NOTHING, and that is what makes it affordable: a
 * newly-arrived document has no insight row at all, so it is published on the
 * very next tick regardless. The cooldown delays only RETRIES. Worst case at
 * the measured cohort size (477 readable EX-99* documents) is 4 attempts/day/document
 * rather than 144.
 *
 * `analysedAt` is the marker, and it is a real column: `buildInsightFailureWrite`
 * stamps it as `attemptedAt` on every FAILED row. No schema change was needed
 * and none was made.
 */
export const FAILED_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Messages one sweep tick may publish.
 *
 * Sized against the OVERLAP, not against the ack deadline — publishing is
 * cheap, the model calls are not. The sweep claims nothing in the database
 * (there is no in-flight row to write without inventing a shape the analyser
 * seam does not have), so a document published at tick N and not yet processed
 * is re-selected at tick N+1 and analysed twice.
 *
 * 100 leaves against a 10-minute gap is roughly two orders of magnitude of
 * headroom: one leaf is a GCS read of tens of KB plus one model call, and
 * Pub/Sub delivers them concurrently. The 477-document cohort drains in ~5
 * ticks; steady state is a handful a day.
 *
 * If a duplicate ever does slip through, the write is an UPSERT on
 * `@@unique([accession, sequence])`, so the cost is a model call and never a
 * second row.
 */
export const DEFAULT_FANOUT_LIMIT = 100;

/** Ceiling on a message-supplied limit. A manual drain may widen; not without bound. */
export const MAX_FANOUT_LIMIT = 500;

/**
 * How much of the cohort ONE tick may consider.
 *
 * The planner diffs the whole cohort in memory rather than paging it, and that
 * is deliberate: an ASC-ordered PAGE over a queue whose head fills with READY
 * rows never reaches the tail — the rotation defect measured twice (MONEY-1211,
 * 681 of 781 symbols; MONEY-1255, a ~2-year undrainable backlog). A full diff
 * has no head to get stuck behind.
 *
 * The cohort is 477 readable documents today against 3,509 rows, growing by tens a day,
 * so 20,000 is years of runway. It is a TRIPWIRE rather than a budget: the
 * caller reads one row past it and REPORTS the truncation, because
 * `PARSE_SCAN_CAP` was already found breached (48,322 against 40,000) by a job
 * that could not say so. When it trips, the fix is a watermark, not a bigger
 * number.
 */
export const SWEEP_SCAN_CAP = 20_000;

/**
 * How many ACCESSIONS one `us_filing_insights` read may name.
 *
 * The insight side used to be read with `take: SWEEP_SCAN_CAP + 1` and NOTHING
 * ELSE — no `where`, no `orderBy`, and no truncation check. That is not the
 * same shape as the document read one call above it, and the asymmetry was the
 * bug: past 20,000 insight rows MongoDB returns an ARBITRARY 20,000 of them,
 * and any READY row outside that slice makes its document look never-analysed.
 * The planner then publishes it, a leaf re-reads it, and a PAID model call is
 * spent — every ten minutes, forever, with every counter reading healthy.
 *
 * The fix is not a bigger cap. The rows the planner can possibly look up are
 * exactly those keyed to a document it SCANNED, so the read is narrowed to
 * those accessions and issued in chunks. It is then proportional to the scan —
 * which is already capped — rather than to the whole table, and completeness is
 * a property of the query instead of a hope about table size.
 *
 * 500 keeps the `$in` list far below any driver or BSON limit while costing
 * ~1 round trip per 500 accessions; the live cohort is ~470 accessions, so
 * steady state is one query.
 */
export const INSIGHT_READ_CHUNK = 500;

/**
 * The limit for this run.
 *
 * A non-finite, missing, zero or negative value resolves to the DEFAULT rather
 * than to zero: a malformed message must not silently disable the fan-out while
 * every log line reads as a successful tick.
 */
export function resolveFanoutLimit(requested?: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DEFAULT_FANOUT_LIMIT;
  }
  const n = Math.floor(requested);
  if (n < 1) return DEFAULT_FANOUT_LIMIT;
  return Math.min(n, MAX_FANOUT_LIMIT);
}

/* ─────────────────────────────────────────────────────────────────────────
   ROUTE DISPATCH
   ──────────────────────────────────────────────────────────────────────── */

export type FilingInsightRoute = "sweep" | "document" | "ignore";

/**
 * Which shape is this message?
 *
 * ORDER IS LOAD-BEARING. `documentId` is tested FIRST, so a leaf can never be
 * mistaken for a sweep; and the absence of both fields is `ignore`, never
 * `sweep`, so a malformed or truncated payload costs one ACK instead of a
 * whole-cohort fan-out.
 */
export function classifyFilingInsightMessage(
  data: unknown,
): FilingInsightRoute {
  if (data === null || typeof data !== "object") return "ignore";
  const d = data as Record<string, unknown>;
  if (typeof d.documentId === "string" && d.documentId.trim().length > 0) {
    return "document";
  }
  if (d.mode === "sweep") return "sweep";
  return "ignore";
}

/* ─────────────────────────────────────────────────────────────────────────
   THE PLAN
   ──────────────────────────────────────────────────────────────────────── */

/** The `us_filing_insights` columns the planner reads, plus its natural key. */
export interface SweepInsightRow extends ExistingInsight {
  readonly accession: string;
  readonly sequence: number;
  /** Stamped by `buildInsightFailureWrite` on every FAILED row. */
  readonly analysedAt?: Date | null;
}

/** A cohort document with the id a message must carry. */
export interface SweepDocument extends CohortDocument {
  readonly id?: string;
}

export interface FanoutPlan {
  /** `UsFilingDocument.id`s to publish, oldest filing first. */
  readonly publish: readonly string[];
  /** Documents the decision says to analyse, BEFORE the limit. The queue depth. */
  readonly owed: number;
  /** Documents already read, terminal-skipped, or out of cohort. */
  readonly upToDate: number;
  /** FAILED documents inside their retry cooldown. */
  readonly cooldownHeld: number;
  /** Rows carrying no id — unpublishable, and counted rather than dropped. */
  readonly missingId: number;
  readonly scanned: number;
}

/**
 * The accession lists to read `us_filing_insights` by, one per query.
 *
 * DISTINCT and ORDERED, so the chunking is deterministic and a submission's
 * exhibits — which share an accession — cost one lookup between them rather
 * than one each. An empty document set yields NO chunks, never one empty chunk:
 * `accession: { in: [] }` matches nothing, and issuing it would spend a round
 * trip to learn what the caller already knew.
 */
export function planInsightReadChunks(
  documents: readonly SweepDocument[],
  chunkSize: number = INSIGHT_READ_CHUNK,
): readonly (readonly string[])[] {
  const size =
    Number.isFinite(chunkSize) && chunkSize >= 1
      ? Math.floor(chunkSize)
      : INSIGHT_READ_CHUNK;
  const seen = new Set<string>();
  for (const doc of documents) {
    if (typeof doc.accession === "string" && doc.accession.length > 0) {
      seen.add(doc.accession);
    }
  }
  const all = [...seen].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < all.length; i += size)
    chunks.push(all.slice(i, i + size));
  return chunks;
}

/** `accession:sequence` — the natural key both tables share. */
export function insightKey(row: {
  accession: string;
  sequence: number;
}): string {
  return `${row.accession}:${row.sequence}`;
}

/** Index insight rows by their natural key. */
export function indexInsights(
  rows: readonly SweepInsightRow[],
): Map<string, SweepInsightRow> {
  const m = new Map<string, SweepInsightRow>();
  for (const row of rows) m.set(insightKey(row), row);
  return m;
}

/**
 * Is this FAILED row still inside its retry cooldown?
 *
 * A row with NO `analysedAt` is NOT held: an unstamped failure is a row whose
 * attempt time is unknown, and refusing to retry on an unknown timestamp would
 * strand it forever — the same "absent is not a value" trap the selectors module
 * documents for `textPath`.
 */
export function isCoolingDown(
  existing: SweepInsightRow | null,
  now: Date,
  cooldownMs: number = FAILED_RETRY_COOLDOWN_MS,
): boolean {
  if (existing === null) return false;
  if (existing.insightStatus !== INSIGHT_STATUS.FAILED) return false;
  const at = existing.analysedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() < cooldownMs;
}

/**
 * Which documents this tick should announce.
 *
 * The analyse/skip judgement is DELEGATED to `decideInsightAction` — the same
 * function the per-document processor runs — rather than restated here. A rule
 * stated twice is a rule that drifts, and MONEY-1255 paid for exactly that: one
 * job named a GCS object by a substring rule and selected the row by an exact
 * one, so the file was right and the row was unreachable for the life of the
 * table. The only thing this planner adds on top is the retry COOLDOWN, which
 * is a scheduling concern the leaf has no opinion about.
 */
export function planInsightFanout(input: {
  readonly documents: readonly SweepDocument[];
  readonly insights: readonly SweepInsightRow[];
  readonly now: Date;
  readonly limit: number;
  readonly cooldownMs?: number;
}): FanoutPlan {
  const byKey = indexInsights(input.insights);
  const publish: string[] = [];
  let owed = 0;
  let upToDate = 0;
  let cooldownHeld = 0;
  let missingId = 0;

  for (const doc of input.documents) {
    const existing = byKey.get(insightKey(doc)) ?? null;
    const decision = decideInsightAction(doc, existing);

    if (decision.action !== "analyse") {
      upToDate++;
      continue;
    }
    if (isCoolingDown(existing, input.now, input.cooldownMs)) {
      cooldownHeld++;
      continue;
    }
    if (typeof doc.id !== "string" || doc.id.length === 0) {
      missingId++;
      continue;
    }

    owed++;
    if (publish.length < input.limit) publish.push(doc.id);
  }

  return {
    publish,
    owed,
    upToDate,
    cooldownHeld,
    missingId,
    scanned: input.documents.length,
  };
}
