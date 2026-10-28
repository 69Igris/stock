/**
 * Reduce `DerivativeEOD` to a rolling window — MONEY-1100 (founder decision
 * 2026-08-12).
 *
 * ## Why this table does not need to be here
 *
 * Nothing in the product reads it. Verified across apps/web, apps/api,
 * packages/services, packages/core and the workers: the ONLY readers are
 * `feed-parse` (its own dedupe pre-filter) and `fo-summary` (which derives
 * `DerivativeSummary` from it). The platform does not list derivatives today.
 *
 * It is also not a source of truth. The chain is
 *
 *     GCS feed archive  ->  DerivativeEOD  ->  DerivativeSummary
 *
 * and the SOURCE is GCS: `feeds/NSE/fo-*` holds the same history in 1.84 GB of
 * compressed exchange files, versus ~26 GB for the parsed documents plus their
 * indexes in Mongo — 89% of the whole database. Deleting rows here destroys
 * nothing permanent; it costs a re-parse if they are ever wanted back.
 *
 * `DerivativeSummary` (0.35 GB) is KEPT in full. It is the distilled layer a
 * future F&O feature would query, and re-deriving it is cheap.
 *
 * ## The invariant
 *
 * A day is pruned ONLY if `DerivativeSummary` already has rows for it. Pruning
 * an unsummarised day would throw away the input before its output existed —
 * recoverable from GCS, but only by re-parsing, and silently wrong until
 * someone noticed. Days without a summary are SKIPPED and reported.
 *
 * Deletes day by day on the `[date]` index with retry-on-failover, the shape
 * that survived an Atlas primary step-down during the pre-2018 stock trim.
 *
 * Usage:
 *   node --import tsx scripts/migrations/prune-derivative-eod-window.ts
 *   node --import tsx scripts/migrations/prune-derivative-eod-window.ts --apply
 *   node --import tsx scripts/migrations/prune-derivative-eod-window.ts --days=180 --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";

const APPLY = process.argv.includes("--apply");
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

/**
 * Rolling window in days. 90 is generous: `fo-summary` only needs the target
 * day plus the previous TRADING day to compute day-over-day OI change, so the
 * functional minimum is ~2. 90 leaves room to re-derive a quarter without
 * touching GCS.
 */
const WINDOW_DAYS = Number(arg("days") ?? 90) || 90;

const log = (...a: unknown[]) => console.log("[prune-eod]", ...a);

const TRANSIENT = [
  "InterruptedDueToReplStateChange",
  "PrimarySteppedDown",
  "NotWritablePrimary",
  "InterruptedAtShutdown",
  "ShutdownInProgress",
  "HostUnreachable",
  "NetworkTimeout",
  "SocketException",
  "ExceededTimeLimit",
  "PoolClearedError",
];
const isTransient = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return TRANSIENT.some((t) => m.includes(t));
};
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 6 || !isTransient(err)) throw err;
      const wait = Math.min(30_000, 1000 * 2 ** (i - 1));
      log(`${what}: transient, retry ${i}/6 in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

/** Distinct `date` values in a collection, as ISO strings. */
async function distinctDates(collection: string): Promise<string[]> {
  const res = (await prisma.$runCommandRaw({
    distinct: collection,
    key: "date",
  })) as { values?: Array<{ $date: string } | string> };
  return (res.values ?? []).map((v) => (typeof v === "string" ? v : v.$date));
}

async function main(): Promise<void> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const cutoffIso = cutoff.toISOString();
  log(
    `window=${WINDOW_DAYS}d  cutoff=${cutoffIso.slice(0, 10)}  ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  const eodDays = await distinctDates("derivative_eod");
  const summarised = new Set(
    (await distinctDates("derivative_summary")).map((d) => d.slice(0, 10)),
  );

  const old = eodDays.filter((d) => d < cutoffIso).sort();
  const prunable = old.filter((d) => summarised.has(d.slice(0, 10)));
  const unsummarised = old.filter((d) => !summarised.has(d.slice(0, 10)));

  log(
    `EOD days total ${eodDays.length}, older than window ${old.length}, ` +
      `of those summarised ${prunable.length}, NOT summarised ${unsummarised.length}`,
  );
  if (unsummarised.length > 0) {
    log(
      `SKIPPING ${unsummarised.length} unsummarised day(s) — their summary must ` +
        `exist before their input is discarded. First few: ` +
        unsummarised
          .slice(0, 5)
          .map((d) => d.slice(0, 10))
          .join(", "),
    );
  }

  const inScope = (await prisma.$runCommandRaw({
    count: "derivative_eod",
    query: { date: { $lt: { $date: cutoffIso } } },
  })) as { n?: number };
  log(`rows older than the window: ${(inScope.n ?? 0).toLocaleString()}`);

  if (!APPLY) {
    log("dry-run: pass --apply to prune. Nothing written.");
    log(
      "REVERSIBLE — the exchange files stay in feeds/NSE/fo-*; re-run " +
        "feed-parse to reconstruct any day.",
    );
    await prisma.$disconnect();
    return;
  }

  let deleted = 0;
  let done = 0;
  const started = Date.now();
  for (const day of prunable) {
    const res = await withRetry(`prune ${day.slice(0, 10)}`, async () =>
      (await prisma.$runCommandRaw({
        delete: "derivative_eod",
        deletes: [{ q: { date: { $date: day } }, limit: 0 }],
      })) as { n?: number },
    );
    deleted += res.n ?? 0;
    done++;
    if (done % 200 === 0) {
      const rate = done / ((Date.now() - started) / 60000);
      log(
        `progress: days=${done}/${prunable.length} ` +
          `deleted=${deleted.toLocaleString()} (${rate.toFixed(0)} days/min)`,
      );
    }
  }

  const after = (await prisma.$runCommandRaw({
    count: "derivative_eod",
  })) as { n?: number };
  log(
    `DONE: pruned ${deleted.toLocaleString()} rows across ${done} days; ` +
      `derivative_eod now ${(after.n ?? 0).toLocaleString()} rows; ` +
      `${unsummarised.length} unsummarised day(s) left intact`,
  );
  log(
    "NOTE: WiredTiger does not return freed pages to the filesystem. Run " +
      "compact on derivative_eod to reclaim the disk (and possibly a cheaper " +
      "Atlas tier) once the nightly chain is idle.",
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[prune-eod] failed:", err);
  process.exitCode = 1;
});
