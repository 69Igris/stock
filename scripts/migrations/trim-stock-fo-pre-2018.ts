/**
 * Trim pre-2018 STOCK F&O — MONEY-1100 (founder retention decision 2026-08-11).
 *
 * ## The decision
 *
 *   INDEX F&O  (FUTIDX / OPTIDX)  → keep the FULL history. Only 17.2M of
 *      154.5M rows (11%), and NIFTY/BANKNIFTY continuity back to 2000 is what
 *      makes PCR / max-pain / rollover PERCENTILES mean anything.
 *   STOCK F&O  (FUTSTK / OPTSTK)  → 2018 onward only. 137.3M rows (89%), of
 *      which 69.0M are pre-2018 — 44.7% of the whole table.
 *
 * Pre-2018 stock derivatives are not comparable to today's: options were
 * AMERICAN-style until Jan 2011, physical settlement phased in 2018-19, and
 * lot sizes were revised repeatedly so open interest in CONTRACTS does not
 * compare across eras.
 *
 * ## Why this is safe to run
 *
 * REVERSIBLE. Every deleted row was parsed from bytes that remain in the GCS
 * feed archive (`feeds/NSE/fo-legacy/`, 1.84 GB). Re-running feed-parse for
 * those families reconstructs them exactly. What would NOT be reversible is
 * deleting the archive itself — NSE prunes upstream — so this touches only the
 * database.
 *
 * ## Shape
 *
 * Deletes DAY BY DAY, descending, using the `[date]` index: one bounded
 * command per trading day instead of one 69M-document delete that would hold a
 * cursor for hours and bloat the oplog. Interruptible and resumable — a re-run
 * simply finds fewer days with matching rows.
 *
 * Also drops the matching `DerivativeSummary` rows: those were DERIVED from the
 * EODs being removed, so leaving them would publish analytics with no
 * underlying data behind them. Index-underlying summaries are untouched.
 *
 * Usage:
 *   node --import tsx scripts/migrations/trim-stock-fo-pre-2018.ts           # counts only
 *   node --import tsx scripts/migrations/trim-stock-fo-pre-2018.ts --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";

const APPLY = process.argv.includes("--apply");

/** Everything strictly before this instant is in scope. */
const CUTOFF_ISO = "2018-01-01T00:00:00.000Z";

/** The instrument types that ARE stock derivatives. */
const STOCK_INSTRUMENTS = ["FUTSTK", "OPTSTK"] as const;

/**
 * Index underlyings, for the DerivativeSummary pass only. `DerivativeSummary`
 * has no `instrument` column — it is one row per underlying per day — so stock
 * rows are identified as "not one of these". Kept in sync with
 * INDEX_UNDERLYING_SLUGS in scripts/jobs/fo-summary.ts.
 */
const INDEX_UNDERLYINGS = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
  "NIFTYIT",
  "CNXIT",
  "CNX100",
  "JUNIOR",
  "NFTYMCAP50",
  "NIFTYMID50",
  "CNXINFRA",
  "NIFTYINFRA",
  "CNXPSE",
  "NIFTYPSE",
  "NIFTYCPSE",
  "MINIFTY",
  "DEFTY",
  "DJIA",
  "FTSE100",
  "S&P500",
  "BANKEX",
  "SENSEX",
  "SENSEX50",
];

const log = (...a: unknown[]) => console.log("[trim-stock-fo]", ...a);

/**
 * Mongo errors that mean "the cluster moved under us", not "your command is
 * wrong". A multi-hour delete WILL meet at least one of these on Atlas: the
 * first run died at day 900/3439 on 11602 InterruptedDueToReplStateChange
 * (the primary stepped down mid-delete).
 */
const TRANSIENT = [
  "InterruptedDueToReplStateChange",
  "PrimarySteppedDown",
  "NotWritablePrimary",
  "NotPrimaryNoSecondaryOk",
  "InterruptedAtShutdown",
  "ShutdownInProgress",
  "HostUnreachable",
  "HostNotFound",
  "NetworkTimeout",
  "SocketException",
  "ExceededTimeLimit",
  "MaxTimeMSExpired",
  "PoolClearedError",
  "Connection closed",
];

const isTransient = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT.some((t) => msg.includes(t));
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Retry a transient failure with backoff. A NON-transient error still throws
 * immediately — a retry loop that swallows real errors would turn a broken
 * query into an infinite one.
 */
async function withRetry<T>(
  what: string,
  fn: () => Promise<T>,
  attempts = 6,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      const waitMs = Math.min(30_000, 1000 * 2 ** (i - 1));
      log(
        `${what}: transient failure (attempt ${i}/${attempts}), retrying in ` +
          `${waitMs / 1000}s — ${err instanceof Error ? err.message.slice(0, 90) : err}`,
      );
      await sleep(waitMs);
    }
  }
}

async function countRaw(
  collection: string,
  query: Record<string, unknown>,
): Promise<number> {
  const res = (await prisma.$runCommandRaw({
    count: collection,
    query,
  })) as { n?: number };
  return res.n ?? 0;
}

/** Distinct pre-cutoff trading days, newest first. */
async function preCutoffDays(): Promise<string[]> {
  const res = (await prisma.$runCommandRaw({
    distinct: "derivative_eod",
    key: "date",
    query: { date: { $lt: { $date: CUTOFF_ISO } } },
  })) as { values?: Array<{ $date: string } | string> };
  const days = (res.values ?? []).map((v) =>
    typeof v === "string" ? v : v.$date,
  );
  days.sort();
  days.reverse();
  return days;
}

async function main(): Promise<void> {
  const started = Date.now();

  const totalBefore = await countRaw("derivative_eod", {});
  const inScope = await countRaw("derivative_eod", {
    date: { $lt: { $date: CUTOFF_ISO } },
    instrument: { $in: [...STOCK_INSTRUMENTS] },
  });
  log(
    `derivative_eod: ${totalBefore.toLocaleString()} rows, ` +
      `${inScope.toLocaleString()} pre-2018 STOCK rows in scope — ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  const summariesInScope = await countRaw("derivative_summary", {
    date: { $lt: { $date: CUTOFF_ISO } },
    symbol: { $nin: INDEX_UNDERLYINGS },
  });
  log(
    `derivative_summary: ${summariesInScope.toLocaleString()} pre-2018 ` +
      `STOCK-underlying rows in scope`,
  );

  if (!APPLY) {
    log("dry-run: pass --apply to delete. Nothing written.");
    log(
      "REVERSIBLE — the source bytes stay in feeds/NSE/fo-legacy/; re-run " +
        "feed-parse to reconstruct.",
    );
    await prisma.$disconnect();
    return;
  }

  const days = await preCutoffDays();
  log(`walking ${days.length} pre-2018 trading days, newest first`);

  let deleted = 0;
  let done = 0;
  for (const day of days) {
    const res = await withRetry(
      `delete ${day.slice(0, 10)}`,
      async () =>
        (await prisma.$runCommandRaw({
          delete: "derivative_eod",
          deletes: [
            {
              q: {
                date: { $date: day },
                instrument: { $in: [...STOCK_INSTRUMENTS] },
              },
              limit: 0,
            },
          ],
        })) as { n?: number },
    );
    deleted += res.n ?? 0;
    done++;
    if (done % 100 === 0) {
      const rate = done / ((Date.now() - started) / 60000);
      log(
        `progress: days=${done}/${days.length} deleted=${deleted.toLocaleString()} ` +
          `(${rate.toFixed(0)} days/min)`,
      );
    }
  }

  const summaryRes = await withRetry(
    "delete summaries",
    async () =>
      (await prisma.$runCommandRaw({
        delete: "derivative_summary",
        deletes: [
          {
            q: {
              date: { $lt: { $date: CUTOFF_ISO } },
              symbol: { $nin: INDEX_UNDERLYINGS },
            },
            limit: 0,
          },
        ],
      })) as { n?: number },
  );

  const totalAfter = await countRaw("derivative_eod", {});
  const leftover = await countRaw("derivative_eod", {
    date: { $lt: { $date: CUTOFF_ISO } },
    instrument: { $in: [...STOCK_INSTRUMENTS] },
  });
  const indexKept = await countRaw("derivative_eod", {
    date: { $lt: { $date: CUTOFF_ISO } },
    instrument: { $in: ["FUTIDX", "OPTIDX"] },
  });

  log(
    `DONE: eod deleted=${deleted.toLocaleString()} ` +
      `summaries deleted=${(summaryRes.n ?? 0).toLocaleString()} ` +
      `remaining-in-scope=${leftover} ` +
      `pre-2018 INDEX rows KEPT=${indexKept.toLocaleString()} ` +
      `total ${totalBefore.toLocaleString()} -> ${totalAfter.toLocaleString()}`,
  );
  if (leftover > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[trim-stock-fo] failed:", err);
  process.exitCode = 1;
});
