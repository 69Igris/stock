/**
 * Filings Sync Processor — DISARMED PENDING WIRING (MONEY-1238).
 *
 * ## What this job did, and what it never did
 *
 * It walked a hot-tier symbol set, called NSE for each symbol's financial
 * results and annual reports, logged `results.length` / `reports.length`, threw
 * both arrays away, stamped `instrument_mappings.filingsSyncedAt` — its rotation
 * cursor — and returned 200. `grep -c prisma
 * packages/research/src/data-sources/nse-filings.ts` is **0**: not one of the
 * fetchers persists anything, and the processor's ONLY database write was the
 * stamp. So the job advanced a cursor over work it does not do, on a weekly
 * schedule, while every dashboard stayed green. It also called
 * `reportJobOutcome` never, set no `ok`, and the route returned 200 regardless.
 *
 * ## Why this is disarmed instead of wired
 *
 * The destination is NOT ambiguous — it is `StockDocument`, the same table
 * `stock-document-sync` and `nse-announcements-sync` write; there is no
 * announcements/filings model in the schema at all. The problem is that the
 * destination is ALREADY OCCUPIED, from the same two endpoints:
 *
 *   - `stock-document-sync.ts` calls `fetchNSEFinancialResults(symbol)` and
 *     stores each attachment as a `quarterly_result` StockDocument.
 *   - it also calls `fetchCategorizedAnnouncements(symbol)`, whose
 *     `annual_report` bucket is drawn from the same
 *     `/api/corporates-announcements` feed `fetchAnnualReports` filters.
 *
 * Wiring this job would therefore add a THIRD per-symbol writer of the same
 * rows from the same rate-limited exchange — the exact duplication
 * `PROD_ONLY_JOBS` exists to prevent, and the shape of MONEY-853 (a per-IP wall
 * reached by one leg starves the others). The honest fix is to delete this job
 * and its scheduler entry, or to fold its hot-tier population INTO
 * `stock-document-sync`'s symbol resolution. Both touch
 * `scripts/ops/setup-scheduler.sh` and the Pub/Sub topic set, so both are a
 * separate ticket.
 *
 * ## What it does now
 *
 * It still RESOLVES its population, because `selected` is the honest half of
 * the outcome and it is one cheap indexed read. It then:
 *
 *   - fetches NOTHING (discarded requests against nseindia.com are indefensible),
 *   - stamps NOTHING (a cursor may not advance over work not done),
 *   - reports `written: 0` through `reportJobOutcome`, which downgrades the run
 *     to a WARNING whenever it selected symbols — the zero-write signal this
 *     job was structurally incapable of emitting before.
 *
 * The route keeps returning 200 deliberately. A 5xx would burn the
 * subscription's five delivery attempts and dead-letter a founder notification
 * every Sunday for a defect that is already known and written down — which is
 * how a DLQ gets muted. The alarm lives in the job outcome, and the way to
 * silence it is to remove the schedule, not to make the job lie again.
 *
 * Schedule: Weekly (`filings-sync-weekly`, Sunday 7 PM IST, prod-only)
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import {
  resolveFilingsSyncParams,
  needsSymbolDiscovery,
  buildFilingsDiscoveryWhere,
  computeHotTierCutoff,
} from "./filings-sync-logic";

export interface FilingsSyncMessage {
  symbols?: string[];
  batchSize?: number;
  delayMs?: number;
}

/** The Prisma surface this job touches, so a test can hand in a fake. */
type Db = typeof prisma;

/** Injectable seams — production passes none of them. */
export interface FilingsSyncDeps {
  prisma?: Db;
}

/** What the run did. `written` is 0 by construction until the job is wired. */
export interface FilingsSyncResult {
  selected: number;
  written: number;
  failed: number;
  /**
   * False while the job has no persistence layer. Exported rather than implied
   * so a caller (and a test) can assert the job is not pretending.
   */
  wired: boolean;
  skippedReason: string;
}

/**
 * The one sentence a reader of the logs needs. Exported + pure so the wording
 * is pinned by a test rather than drifting into something reassuring.
 */
export const FILINGS_SYNC_NOT_WIRED_REASON =
  "filings-sync has NO persistence layer — its NSE fetchers write nothing " +
  "(0 prisma calls in nse-filings.ts) and its only DB write was the rotation " +
  "stamp. Fetching + stamping are DISABLED so the cursor cannot advance over " +
  "work that is not done. Its two feeds are already ingested by " +
  "stock-document-sync (quarterly_result + annual_report -> StockDocument); " +
  "delete this job or fold its population into that one";

/**
 * The symbols this job WOULD work on, from our OWN tables — MONEY-1215.
 *
 * Still resolved: `selected` has to be the real population for the zero-write
 * signal to mean anything, and it is one indexed read with no egress.
 */
async function loadDiscoverySymbols(db: Db): Promise<string[]> {
  const [holdings, watchlist] = await Promise.all([
    db.holding
      .groupBy({ by: ["symbol"] })
      .then((r) => r.map((x) => x.symbol))
      .catch(() => [] as string[]),
    db.watchlistItem
      .groupBy({ by: ["symbol"] })
      .then((r) => r.map((x) => x.symbol))
      .catch(() => [] as string[]),
  ]);
  // Normalised the same way the financial tier does: trimmed, upper-cased,
  // de-duplicated, blanks dropped. A blank would become `{ in: [""] }` and
  // match nothing while looking like a real population.
  const out = new Set<string>();
  for (const s of [...holdings, ...watchlist]) {
    const t = (s ?? "").trim().toUpperCase();
    if (t) out.add(t);
  }
  return [...out];
}

export async function processFilingsSync(
  data: FilingsSyncMessage,
  deps: FilingsSyncDeps = {},
): Promise<FilingsSyncResult> {
  const db = deps.prisma ?? prisma;
  const { batchSize } = resolveFilingsSyncParams(data);

  // `symbols` is genuinely optional: the only scheduled publisher
  // (`filings-sync-weekly` in scripts/ops/setup-scheduler.sh) sends `{}`, so
  // auto-discovery is the PRIMARY path, not a fallback. `?? []` is the honest
  // seed — `needsSymbolDiscovery` already treats `undefined` and `[]`
  // identically (`!symbols || symbols.length === 0`), so discovery still fires
  // for exactly the same inputs and the `symbols.length` read below is exactly
  // the value it read before.
  let symbols: string[] = data.symbols ?? [];

  if (needsSymbolDiscovery(symbols)) {
    // Get hot-tier symbols (portfolio + recently analyzed)
    const instruments = await db.instrumentMapping.findMany({
      where: buildFilingsDiscoveryWhere(
        await loadDiscoverySymbols(db),
        computeHotTierCutoff(),
      ),
      select: { symbol: true },
      // MONEY-1215 — stale-first. See news-sync.ts for why `analysisCount`
      // ordering was a constant sort over a population that is entirely 0.
      //
      // MONEY-1238 — this ordering is now inert in the useful sense: nothing
      // stamps `filingsSyncedAt` any more, so every row keeps its null marker
      // and the sort degenerates to `symbol asc`. That is CORRECT for a job
      // that does no work — a stable head is honest, an advancing cursor is
      // not — and it means the day someone wires persistence, the rotation
      // starts from a clean slate instead of from months of false stamps.
      orderBy: [{ filingsSyncedAt: "asc" }, { symbol: "asc" }],
      take: batchSize,
    });
    symbols = instruments.map((i) => i.symbol);
  }

  // Loud, and on `console.error` so it survives a log level that drops info.
  console.error(
    `[filings-sync] NOT WIRED — selected ${symbols.length} symbols and will ` +
      `write 0. ${FILINGS_SYNC_NOT_WIRED_REASON}`,
  );

  reportJobOutcome({
    job: "filings-sync",
    selected: symbols.length,
    written: 0,
    failed: 0,
    skippedReason: FILINGS_SYNC_NOT_WIRED_REASON,
  });

  return {
    selected: symbols.length,
    written: 0,
    failed: 0,
    wired: false,
    skippedReason: FILINGS_SYNC_NOT_WIRED_REASON,
  };
}
