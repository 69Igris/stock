/**
 * Re-link every synced collection whose `instrument` relation is REQUIRED —
 * MONEY-1220, generalising MONEY-1216.
 *
 * ## The bug this repairs, and why it is not one collection
 *
 * `instrument_mappings` is QA-DIRECT: QA mints its own ObjectIds and the
 * prod→QA sync never overwrites them. Every REFERENCE collection is copied from
 * prod carrying PROD's `instrumentId` values. So after every restore, each
 * copied row points at an id that exists only in prod.
 *
 * For a collection whose `instrument` relation is OPTIONAL that is cosmetic —
 * readers join on symbol and a dangling id is never dereferenced. The sync
 * script says exactly that, and it is right, for those.
 *
 * For a REQUIRED relation Prisma does not return null. It **throws**, and the
 * throw kills the whole query — so one orphaned row takes out every result the
 * caller asked for. MONEY-1216 found this on `stock_ratios`, where it blanked
 * every fundamental column in QA's screener with no visible error.
 *
 * That ticket's own closing note warned: *"Any future collection added to
 * REFERENCE_COLLECTIONS that carries a required relation to instrument_mappings
 * has this same defect."* Measured against the schema on 2026-08-19, FOUR
 * already did:
 *
 *     stock_documents      REQUIRED
 *     stock_financials     REQUIRED   <- the XBRL projection's target
 *     stock_peers          REQUIRED
 *     stock_ratios         REQUIRED   <- the only one 1216 repaired
 *     stock_shareholding   REQUIRED
 *
 * The fix is not five scripts. It is one driver plus a list that the test
 * derives FROM THE SCHEMA, so a sixth collection cannot be added without either
 * being covered or failing the suite.
 *
 * ## Direction matters more than anything else here
 *
 * This runs against QA. Pointed at prod it would rewrite PROD's instrument ids
 * from QA's — far worse than the bug, and unrecoverable without a restore. The
 * guard below refuses any DATABASE_URL that does not look like QA, and
 * `--apply` is opt-in on top of that.
 */

import prisma from "@usemoney/database";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv
  .find((a) => a.startsWith("--collection="))
  ?.split("=")[1];

/**
 * Collections with a REQUIRED `instrument` relation that the prod→QA sync
 * copies. Each entry names the Prisma delegate and how a row identifies the
 * instrument it should point at.
 *
 * Kept in sync with the schema by `sync-relink-required.test.ts`, which reads
 * `schema.prisma` and fails if a REQUIRED-relation REFERENCE collection is
 * missing from this list.
 */
const REPAIRABLE = [
  { table: "stock_ratios", delegate: "stockRatios" },
  { table: "stock_financials", delegate: "stockFinancials" },
  { table: "stock_documents", delegate: "stockDocument" },
  { table: "stock_peers", delegate: "stockPeers" },
  { table: "stock_shareholding", delegate: "stockShareholding" },
] as const;

type Row = {
  id: string;
  symbol: string;
  exchange: string;
  instrumentId: string;
};

function assertQaTarget(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (url === "") {
    throw new Error("DATABASE_URL is not set");
  }
  // Deliberately a positive test for QA rather than a negative one for prod: a
  // new environment name must fail closed, not sail through because it does not
  // happen to contain "prod".
  if (!/qa/i.test(url)) {
    throw new Error(
      "REFUSING TO RUN: DATABASE_URL does not look like QA. This script " +
        "rewrites instrumentId values, and running it against prod would " +
        "repoint PROD's rows at QA's ids — worse than the bug it repairs.",
    );
  }
}

async function repairOne(
  table: string,
  delegate: string,
): Promise<{
  table: string;
  total: number;
  orphans: number;
  fixed: number;
  unmatched: number;
}> {
  const model = (
    prisma as unknown as Record<
      string,
      {
        findMany: (a: unknown) => Promise<Row[]>;
        update: (a: unknown) => Promise<unknown>;
      }
    >
  )[delegate];
  if (!model) throw new Error(`no Prisma delegate named ${delegate}`);

  const rows = await model.findMany({
    select: { id: true, symbol: true, exchange: true, instrumentId: true },
  });

  const referenced = [...new Set(rows.map((r) => r.instrumentId))];
  const alive = await prisma.instrumentMapping.findMany({
    where: { id: { in: referenced } },
    select: { id: true },
  });
  const aliveIds = new Set(alive.map((a) => a.id));
  const orphans = rows.filter((r) => !aliveIds.has(r.instrumentId));

  if (orphans.length === 0) {
    return { table, total: rows.length, orphans: 0, fixed: 0, unmatched: 0 };
  }

  const symbols = [...new Set(orphans.map((o) => o.symbol))];
  const mappings = await prisma.instrumentMapping.findMany({
    where: { symbol: { in: symbols } },
    select: { id: true, symbol: true, exchange: true },
  });
  const byKey = new Map(
    mappings.map((m) => [`${m.symbol}_${m.exchange}`, m.id]),
  );

  let fixed = 0;
  let unmatched = 0;
  for (const o of orphans) {
    const target = byKey.get(`${o.symbol}_${o.exchange}`);
    if (!target) {
      // Not an error: the instrument may genuinely not exist in QA (a symbol
      // delisted after the last instrument sync). Counted, never guessed at —
      // pointing it at a NEAR match would silently attribute one company's
      // financials to another.
      unmatched++;
      continue;
    }
    if (APPLY) {
      await model.update({
        where: { id: o.id },
        data: { instrumentId: target },
      });
    }
    fixed++;
  }

  return {
    table,
    total: rows.length,
    orphans: orphans.length,
    fixed,
    unmatched,
  };
}

async function main(): Promise<void> {
  assertQaTarget();
  console.log(
    APPLY
      ? "MODE: APPLY — changes WILL be written\n"
      : "MODE: DRY RUN — no writes (pass --apply to write)\n",
  );

  const targets = ONLY
    ? REPAIRABLE.filter((r) => r.table === ONLY)
    : REPAIRABLE;
  if (targets.length === 0) {
    throw new Error(`--collection=${ONLY} is not a repairable collection`);
  }

  let anyUnmatched = 0;
  for (const { table, delegate } of targets) {
    const r = await repairOne(table, delegate);
    const verb = APPLY ? "re-linked" : "would re-link";
    console.log(
      `  ${r.table.padEnd(22)} total=${r.total} orphaned=${r.orphans} ` +
        `${verb}=${r.fixed} unmatched=${r.unmatched}`,
    );
    anyUnmatched += r.unmatched;
  }

  if (anyUnmatched > 0) {
    console.log(
      `\n${anyUnmatched} row(s) had no instrument in this environment and were ` +
        `left alone. That is expected for symbols delisted since the last ` +
        `instrument sync; it is NOT expected in bulk.`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(String(err instanceof Error ? err.message : err));
  await prisma.$disconnect();
  process.exit(1);
});
