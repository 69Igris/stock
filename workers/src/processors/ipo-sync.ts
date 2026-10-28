/**
 * IPO Sync (MONEY-1098 — P5.6). I/O seam only: the parsing, the merge
 * precedence and the status derivation all live in
 * `@usemoney/research/data-sources/issues-logic`, which this file imports and
 * CALLS (no shadow copies).
 *
 * Three NSE endpoints, one table:
 *   `/api/all-upcoming-issues?category=ipo`  → forthcoming issues
 *   `/api/ipo-current-issue`                 → issues open for bidding
 *   `/api/public-past-issues`                → closed / listed issues
 *
 * They overlap: an issue appears in `upcoming` before it opens, in `current`
 * while it is open, and in `past` after it closes — and for a day or two in
 * two of them at once, disagreeing. `mergeIpoIssues` resolves that with
 * `current > upcoming > past` precedence while still filling gaps from the
 * losers (only `past` reliably carries `listingDate`), so the row converges
 * instead of flapping as the issue moves through its lifecycle.
 *
 * ## Idempotency
 *
 * Upserted on `(symbol, issueStart)`. Re-running the job re-reads the same
 * three endpoints and updates the same rows; nothing is keyed on the run.
 * Because bands get revised and windows get EXTENDED mid-issue, every date and
 * price column is nullable and every run overwrites them — the latest read is
 * the truth.
 *
 * ## Rows that cannot be stored
 *
 * `issueStart` is half the unique key, so a row whose open date could not be
 * parsed CANNOT be upserted (Prisma requires both halves of a compound unique
 * in the `where`). Those rows are counted and named in the summary rather than
 * dropped quietly — a spike in that count is the signature of NSE renaming the
 * date field, which would otherwise look exactly like "no IPOs this week".
 *
 * @see packages/research/src/data-sources/nse-issues.ts (fetchers)
 * @see packages/research/src/data-sources/issues-logic.ts (pure merge/parse)
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import {
  fetchUpcomingIpos,
  fetchCurrentIpos,
  fetchPastIssues,
} from "@usemoney/research/data-sources/nse-issues";
import {
  mergeIpoIssues,
  type IpoIssue,
  type IpoSource,
} from "@usemoney/research/data-sources/issues-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[ipo-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[ipo-sync]", ...args),
};

export interface IpoSyncMessage {
  /** Which endpoints to read. Default: all three. */
  sources?: IpoSource[];
  /** Politeness delay between the three calls, in ms. */
  delayMs?: number;
  /** Override "now" for replay / deterministic runs (ISO string). */
  now?: string;
}

const DEFAULT_DELAY_MS = 1000;

/**
 * What one run did — MONEY-1238.
 *
 * The processor used to return `void`, so `skippedNoStartDate` — which the file
 * header names as the SIGNATURE OF AN NSE KEY RENAME — existed only inside a
 * log line, and the route caught everything and answered `success: true`. A
 * rename would therefore look exactly like "no IPOs this week" from every angle
 * that anything watches.
 */
export interface IpoSyncResult {
  /** False when the run found work and persisted none of it. Drives the route. */
  ok: boolean;
  /** Rows returned per endpoint. */
  fetched: Record<string, number>;
  /** Rows after `mergeIpoIssues`. The denominator that matters. */
  merged: number;
  upserted: number;
  skippedNoSymbol: number;
  /** Rows with no parseable `issueStart` — cannot be keyed, so cannot be stored. */
  skippedNoStartDate: number;
  failed: number;
  /**
   * True when EVERY merged row lacked `issueStart`. Nothing else produces that
   * shape: real issues always carry an open date, so a clean sweep means the
   * field moved (see IPO_KEYS).
   */
  keyDrift: boolean;
  /** True when the `UpcomingIpo` model is not in the generated client. */
  modelMissing: boolean;
  /** Why `ok` is false, or why nothing was written. */
  reason?: string;
}

// ── Forward-declared Prisma delegate ─────────────────────────────────────

/**
 * The `UpcomingIpo` model does not exist in `schema.prisma` yet — this wave
 * forbids editing it, and the model ships as a patch block in this task's
 * report. So the delegate is declared here, structurally, and looked up at
 * runtime.
 *
 * WHY NOT just call `prisma.upcomingIpo`: it would not compile until the schema
 * patch is applied and `prisma generate` has run, which would leave the workers
 * type-check red for the whole wave. WHY NOT `any`: `any` would also swallow a
 * genuine mistake in the field names.
 *
 * FOLLOW-UP (three lines, do it the moment the model lands): delete
 * {@link UpcomingIpoDelegate} and {@link getUpcomingIpoDelegate}, and call
 * `prisma.upcomingIpo.upsert(...)` directly. That is the point at which the
 * compiler starts checking these field names against the real model — until
 * then this file is pinned to the patch block by convention only, and the
 * runtime guard below is the safety net.
 */
interface UpcomingIpoUpsertArgs {
  where: { symbol_issueStart: { symbol: string; issueStart: Date } };
  create: UpcomingIpoFields;
  update: Omit<UpcomingIpoFields, "firstSeenAt">;
}

interface UpcomingIpoFields {
  symbol: string;
  companyName: string | null;
  series: string | null;
  isSme: boolean;
  issueStart: Date | null;
  issueEnd: Date | null;
  listingDate: Date | null;
  priceMin: number | null;
  priceMax: number | null;
  issueSize: number | null;
  lotSize: number | null;
  status: string;
  source: string;
  raw: Record<string, unknown>;
  firstSeenAt: Date;
  fetchedAt: Date;
}

interface UpcomingIpoDelegate {
  upsert(args: UpcomingIpoUpsertArgs): Promise<unknown>;
}

/**
 * Resolve the delegate, or `null` when the model has not been added yet.
 * Returning `null` (rather than throwing) keeps a scheduled job from crash-
 * looping in an environment whose schema has not caught up.
 */
function getUpcomingIpoDelegate(): UpcomingIpoDelegate | null {
  const client = prisma as unknown as {
    upcomingIpo?: UpcomingIpoDelegate;
  };
  return typeof client.upcomingIpo?.upsert === "function"
    ? client.upcomingIpo
    : null;
}

// ── Processor ────────────────────────────────────────────────────────────

/**
 * The two I/O seams, injectable — MONEY-1238. Both default to the production
 * path (`fetchBySource` over the three NSE endpoints, and the runtime Prisma
 * delegate lookup), so a test that overrides them runs the REAL merge, the REAL
 * counters and the REAL `ok` decision.
 */
export interface IpoSyncDeps {
  fetch?: (source: IpoSource, now: Date) => Promise<IpoIssue[]>;
  /** Returns null to simulate "the UpcomingIpo model is not generated yet". */
  getDelegate?: () => UpcomingIpoDelegate | null;
}

export async function processIpoSync(
  message: IpoSyncMessage = {},
  deps: IpoSyncDeps = {},
): Promise<IpoSyncResult> {
  const startedAt = Date.now();
  const now = resolveNow(message.now);
  const sources: IpoSource[] = message.sources ?? [
    "current",
    "upcoming",
    "past",
  ];
  const delayMs =
    typeof message.delayMs === "number" &&
    Number.isFinite(message.delayMs) &&
    message.delayMs >= 0
      ? Math.floor(message.delayMs)
      : DEFAULT_DELAY_MS;

  const groups: IpoIssue[][] = [];
  const fetched: Record<string, number> = {};

  // Sequential, not Promise.all: three simultaneous requests to a host that
  // Akamai-throttles is how a cheap job earns an IP block, and the cookie
  // handshake would run three times in parallel for no benefit.
  for (const source of sources) {
    const rows = await (deps.fetch ?? fetchBySource)(source, now);
    fetched[source] = rows.length;
    groups.push(rows);
    if (delayMs > 0) await sleep(delayMs);
  }

  const merged = mergeIpoIssues(...groups);

  const delegate = (deps.getDelegate ?? getUpcomingIpoDelegate)();
  if (!delegate) {
    logger.warn(
      `summary | fetched=${JSON.stringify(fetched)} merged=${merged.length} ` +
        `upserted=0 — the UpcomingIpo model is NOT in the generated Prisma ` +
        `client. Apply the schema patch (model UpcomingIpo, @@unique([symbol, ` +
        `issueStart])) and re-run \`prisma generate\`; nothing was written.`,
    );
    // NOT `ok: false`. A missing model fails identically on every delivery, so
    // NACKing it would burn five attempts and a dead-letter alert per scheduled
    // run until the schema lands — the exact cost CLAUDE.md records for the
    // retired financial-data-sync route. `modelMissing` carries the fact
    // instead, and the warn above names the fix.
    reportJobOutcome({
      job: "ipo-sync",
      selected: 0,
      written: 0,
      skippedReason: "IPO model missing on this deployment",
    });
    return {
      ok: true,
      fetched,
      merged: merged.length,
      upserted: 0,
      skippedNoSymbol: 0,
      skippedNoStartDate: 0,
      failed: 0,
      keyDrift: false,
      modelMissing: true,
      reason: "UpcomingIpo model absent from the generated Prisma client",
    };
  }

  let upserted = 0;
  let skippedNoSymbol = 0;
  let skippedNoStartDate = 0;
  let failed = 0;
  const noStartExamples: string[] = [];

  for (const issue of merged) {
    if (!issue.symbol) {
      skippedNoSymbol++;
      continue;
    }
    if (!issue.issueStart) {
      // Cannot be keyed — see the file header. Named, not just counted.
      skippedNoStartDate++;
      if (noStartExamples.length < 5) {
        noStartExamples.push(issue.symbol);
      }
      continue;
    }

    const fields: UpcomingIpoFields = {
      symbol: issue.symbol,
      companyName: issue.companyName,
      series: issue.series,
      isSme: issue.isSme,
      issueStart: issue.issueStart,
      issueEnd: issue.issueEnd,
      listingDate: issue.listingDate,
      priceMin: issue.priceMin,
      priceMax: issue.priceMax,
      issueSize: issue.issueSize,
      // Lot sizes are whole shares; a fractional parse is a mis-read, and
      // rounding here keeps it out of an Int column.
      lotSize: issue.lotSize === null ? null : Math.round(issue.lotSize),
      status: issue.status,
      source: issue.source,
      raw: issue.raw,
      firstSeenAt: now,
      fetchedAt: now,
    };

    try {
      await delegate.upsert({
        where: {
          symbol_issueStart: {
            symbol: issue.symbol,
            issueStart: issue.issueStart,
          },
        },
        create: fields,
        // `firstSeenAt` is create-only: it answers "when did this issue first
        // appear on our radar", which every update would otherwise reset to
        // today, erasing the only signal of how long an issue has been listed
        // as forthcoming.
        update: {
          symbol: fields.symbol,
          companyName: fields.companyName,
          series: fields.series,
          isSme: fields.isSme,
          issueStart: fields.issueStart,
          issueEnd: fields.issueEnd,
          listingDate: fields.listingDate,
          priceMin: fields.priceMin,
          priceMax: fields.priceMax,
          issueSize: fields.issueSize,
          lotSize: fields.lotSize,
          status: fields.status,
          source: fields.source,
          raw: fields.raw,
          fetchedAt: fields.fetchedAt,
        },
      });
      upserted++;
    } catch (err) {
      failed++;
      logger.warn(
        `${issue.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Every merged row lost its open date. Real issues always carry one, so this
  // is the field having been renamed upstream, not a quiet week.
  const keyDrift = merged.length > 0 && skippedNoStartDate === merged.length;
  // The repo's own zero-write rule (job-outcome.ts): found work, persisted
  // nothing. Never normal, and the only shape worth a retry here — a quiet week
  // has `merged === 0` and is not caught by it.
  const wroteNothing = merged.length > 0 && upserted === 0;
  // KEY DRIFT IS DETERMINISTIC, SO IT MUST NOT NACK — MONEY-1236.
  //
  // `keyDrift` implies every merged row lost its open date, which implies
  // `upserted === 0`, which used to set `ok: false` and therefore a 500. But an
  // upstream field rename rejects the SAME way on all five delivery attempts:
  // the route would burn the whole retry budget and dead-letter on EVERY
  // scheduled run, forever, for a condition no retry can fix.
  //
  // This is the rule `modelMissing` already follows sixty lines above ("a
  // missing model fails identically on every delivery"), and the one
  // `alert-evaluator` and `ownership-sync` follow: transient -> 500, DETERMINISTIC
  // -> 200 with the failure stated in the body and the job outcome. The signal
  // is not being softened — `keyDrift`, `reason` and the no-start examples all
  // still ride the response and the outcome row. What changes is that a
  // permanent condition stops being retried five times a night.
  const retriable = wroteNothing && !keyDrift;

  const summary =
    `fetched=${JSON.stringify(fetched)} merged=${merged.length} ` +
    `upserted=${upserted} skippedNoSymbol=${skippedNoSymbol} ` +
    `skippedNoStartDate=${skippedNoStartDate} failed=${failed} ` +
    `elapsed=${Math.round((Date.now() - startedAt) / 1000)}s` +
    (skippedNoStartDate > 0
      ? ` | no-start examples: ${noStartExamples.join(", ")} — if this is ` +
        `most of the payload, the issueStart key moved (see IPO_KEYS)`
      : "");

  const reason = keyDrift
    ? `KEY DRIFT: all ${merged.length} merged issue(s) had no issueStart — ` +
      `the NSE date key moved (see IPO_KEYS). ${summary}`
    : wroteNothing
      ? `no write from ${merged.length} merged issue(s): ${summary}`
      : undefined;

  if (reason) logger.warn(`summary | ${reason}`);
  else logger.info(`summary | ${summary}`);

  // `selected` is MERGED issues — deduped, ready to upsert. `fetched` counts raw
  // rows per source before merge, so it double-counts an issue both sources
  // carry. A quiet week is `merged: 0`, which reports selected 0 and cannot
  // alarm; KEY DRIFT is `merged > 0, upserted 0`, which is exactly what should.
  reportJobOutcome({
    job: "ipo-sync",
    selected: merged.length,
    written: upserted,
    failed: failed + skippedNoStartDate,
    ...(reason ? { skippedReason: reason } : {}),
  });
  return {
    ok: !retriable,
    fetched,
    merged: merged.length,
    upserted,
    skippedNoSymbol,
    skippedNoStartDate,
    failed,
    keyDrift,
    modelMissing: false,
    reason,
  };
}

function fetchBySource(source: IpoSource, now: Date): Promise<IpoIssue[]> {
  switch (source) {
    case "current":
      return fetchCurrentIpos({ now });
    case "upcoming":
      return fetchUpcomingIpos({ now });
    case "past":
      return fetchPastIssues({ now });
  }
}

function resolveNow(raw?: string): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
