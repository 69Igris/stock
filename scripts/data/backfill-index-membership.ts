/**
 * Build point-in-time index membership from the archived constituent snapshots
 * — MONEY-1189 (P4.3's headline benefit).
 *
 * ## Why this is needed
 *
 * `index-constituent-sync` writes TODAY's membership into `IndexConstituent`
 * (unique on `(indexId, symbol)`, rewritten by deleteMany+createMany each run),
 * so "who was in NIFTY 50 on <date>" is unanswerable from Mongo. Meanwhile the
 * dated `ind_*list.csv` snapshots have been accruing in
 * `feeds/NSE/index-constituents/{slug}/{YYYY}/{MM}/` since P2 — the data was
 * there, nothing read it beyond the newest file.
 *
 * ## What it will and will not claim
 *
 * `addedOn`/`removedOn` are set ONLY for changes actually OBSERVED between two
 * snapshots. Symbols present in the earliest snapshot get `addedOn: null` —
 * "already a member when we started looking" — because stamping them with the
 * first snapshot's date would tell a backtest that every constituent joined on
 * the same day. See index-membership-logic.ts for the full reasoning.
 *
 * The window is therefore short today (the archive starts 2026-08-07) and grows
 * on its own with every weekly sync. That is the honest starting point.
 *
 * ## Env (does NOT read .env — same rule as feed-parse)
 *   DATABASE_URL, GCP_PROJECT_ID, GCP_STORAGE_BUCKET=stockbook-content-prod,
 *   GOOGLE_APPLICATION_CREDENTIALS
 * `.env` carries the LOCAL bucket, which would list an empty archive and report
 * a confident zero. Prefer `./scripts/ops/run-market-data-job.sh`.
 *
 * Usage:
 *   node --import tsx scripts/data/backfill-index-membership.ts
 *   node --import tsx scripts/data/backfill-index-membership.ts --apply
 */

import { prisma } from "@usemoney/database";
import { listFiles, downloadFile } from "@usemoney/storage";
import {
  parseIndexConstituentList,
  constituentKeyDate,
  buildMembershipIntervals,
  CONSTITUENT_SLUG_TO_INDEX_ID,
  type MembershipSnapshot,
} from "@usemoney/core/market-data";

const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log("[index-membership]", ...a);

async function main(): Promise<void> {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const slugs = Object.keys(CONSTITUENT_SLUG_TO_INDEX_ID);
  let totalIntervals = 0;
  let totalWritten = 0;
  let observedJoins = 0;
  let observedExits = 0;

  for (const slug of slugs) {
    const indexId = CONSTITUENT_SLUG_TO_INDEX_ID[slug]!;
    const keys = (await listFiles(`feeds/NSE/index-constituents/${slug}/`)).filter(
      (k) => !k.endsWith("/"),
    );
    if (keys.length === 0) {
      log(`${slug}: no archived snapshots — skipped`);
      continue;
    }

    const snapshots: MembershipSnapshot[] = [];
    for (const key of keys) {
      const day = constituentKeyDate(key);
      if (!day) continue;
      const buf = await downloadFile(key);
      if (!buf) continue;
      const parsed = parseIndexConstituentList(buf.toString("utf8"));
      if (parsed.rows.length === 0) {
        // A file that parses to nothing is an HTML error page, not an empty
        // index. Treating it as an empty snapshot would record the ENTIRE
        // index as removed that day — a fabricated mass exit.
        log(`${slug}: ${key} parsed to 0 rows — skipping this snapshot`);
        continue;
      }
      snapshots.push({
        dateMs: new Date(day).getTime(),
        symbols: new Set(parsed.rows.map((r) => r.symbol)),
      });
    }

    const intervals = buildMembershipIntervals(indexId, snapshots);
    totalIntervals += intervals.length;
    const joins = intervals.filter((i) => i.addedOn !== null).length;
    const exits = intervals.filter((i) => i.removedOn !== null).length;
    observedJoins += joins;
    observedExits += exits;

    log(
      `${slug.padEnd(20)} snapshots=${snapshots.length} intervals=${intervals.length} ` +
        `observed joins=${joins} exits=${exits}`,
    );

    if (!APPLY) continue;

    for (const iv of intervals) {
      await prisma.indexMembership.upsert({
        where: {
          indexId_symbol_firstSeen: {
            indexId: iv.indexId,
            symbol: iv.symbol,
            firstSeen: new Date(iv.firstSeen),
          },
        },
        create: {
          indexId: iv.indexId,
          symbol: iv.symbol,
          firstSeen: new Date(iv.firstSeen),
          lastSeen: new Date(iv.lastSeen),
          addedOn: iv.addedOn === null ? null : new Date(iv.addedOn),
          removedOn: iv.removedOn === null ? null : new Date(iv.removedOn),
          source: "ARCHIVE",
        },
        update: {
          lastSeen: new Date(iv.lastSeen),
          removedOn: iv.removedOn === null ? null : new Date(iv.removedOn),
        },
      });
      totalWritten++;
    }
  }

  log(
    `DONE: intervals=${totalIntervals} observedJoins=${observedJoins} ` +
      `observedExits=${observedExits} written=${totalWritten}` +
      `${APPLY ? "" : " (dry-run, nothing written)"}`,
  );
  if (!APPLY) log("dry-run: pass --apply to write.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[index-membership] failed:", err);
  process.exitCode = 1;
});
