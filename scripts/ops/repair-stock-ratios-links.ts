/**
 * repair-stock-ratios-links.ts — re-link orphaned StockRatios rows to their
 * InstrumentMapping records.
 *
 * ── The bug this repairs ────────────────────────────────────────────────
 * `StockRatios.instrument` is a REQUIRED Prisma relation:
 *
 *     instrumentId String            @unique @db.ObjectId
 *     instrument   InstrumentMapping @relation(fields: [instrumentId], references: [id])
 *
 * When a StockRatios row points at an instrumentId that no longer exists,
 * Prisma does not return null for the relation — it THROWS:
 *
 *     Inconsistent query result: Field instrument is required to return
 *     data, got `null` instead.
 *
 * The screener's fundamental path (`ratiosFirstPath` in
 * apps/web/lib/actions/screener.ts) selects that relation, so the throw takes
 * out the WHOLE query. `screenStocksAction` catches it and returns
 * `{ success: false }`, which the client silently ignores — so every
 * fundamental filter (P/E, ROE, market cap, D/E, revenue growth, dividend
 * yield) returns 0 results with no visible error.
 *
 * Observed 2026-07-21: 2,135 / 2,135 StockRatios rows orphaned. The
 * InstrumentMapping collection had been re-seeded with fresh ObjectIds
 * (`698ab3…`) while StockRatios still referenced the previous generation
 * (`699bc2…`). Sector and text search were unaffected — they take the
 * instruments-first path and never touch the relation.
 *
 * ── The repair ──────────────────────────────────────────────────────────
 * Both collections carry `symbol` + `exchange`, so the correct instrument is
 * recoverable without any external data: match on (symbol, exchange) and
 * rewrite `instrumentId`.
 *
 * SAFETY:
 *   - DRY RUN by default. Pass `--apply` to write.
 *   - UPDATE-only. Never deletes, never creates.
 *   - Rows that already resolve are left untouched.
 *   - Rows with no (symbol, exchange) match are reported, never guessed.
 *   - `instrumentId` is @unique, so a target already claimed by another
 *     ratios row is reported as a conflict and skipped rather than blindly
 *     written (the write would fail anyway).
 *
 * Usage (from the repo root):
 *   node --import tsx --env-file=apps/web/.env scripts/ops/repair-stock-ratios-links.ts
 *   node --import tsx --env-file=apps/web/.env scripts/ops/repair-stock-ratios-links.ts --apply
 *
 * Point --env-file at whichever environment you intend to repair. Run the
 * dry run first and read the summary before applying.
 */

import { writeFile } from "node:fs/promises";
import { prisma } from "@usemoney/database";

const APPLY = process.argv.includes("--apply");

interface Plan {
  id: string;
  symbol: string;
  exchange: string;
  from: string;
  to: string;
}

async function main() {
  console.log(
    APPLY
      ? "MODE: APPLY — changes WILL be written\n"
      : "MODE: DRY RUN — no writes (pass --apply to write)\n",
  );

  const ratios = await prisma.stockRatios.findMany({
    select: { id: true, symbol: true, exchange: true, instrumentId: true },
  });
  console.log(`StockRatios rows: ${ratios.length}`);

  // Which referenced instrument ids actually exist?
  const referenced = [...new Set(ratios.map((r) => r.instrumentId))];
  const alive = await prisma.instrumentMapping.findMany({
    where: { id: { in: referenced } },
    select: { id: true },
  });
  const aliveIds = new Set(alive.map((a) => a.id));

  const orphans = ratios.filter((r) => !aliveIds.has(r.instrumentId));
  console.log(`  already valid: ${ratios.length - orphans.length}`);
  console.log(`  orphaned:      ${orphans.length}`);
  if (orphans.length === 0) {
    console.log("\nNothing to repair.");
    await prisma.$disconnect();
    return;
  }

  // Resolve the correct instrument by (symbol, exchange).
  const symbols = [...new Set(orphans.map((o) => o.symbol))];
  const mappings = await prisma.instrumentMapping.findMany({
    where: { symbol: { in: symbols } },
    select: { id: true, symbol: true, exchange: true },
  });
  const byKey = new Map(
    mappings.map((m) => [`${m.symbol}\u0000${m.exchange}`, m.id]),
  );

  // Instrument ids already claimed by a ratios row (the column is @unique).
  const claimed = new Set(
    ratios
      .filter((r) => aliveIds.has(r.instrumentId))
      .map((r) => r.instrumentId),
  );

  const plan: Plan[] = [];
  const unmatched: { symbol: string; exchange: string }[] = [];
  const conflicts: { symbol: string; exchange: string; target: string }[] = [];

  for (const o of orphans) {
    const target = byKey.get(`${o.symbol}\u0000${o.exchange}`);
    if (!target) {
      unmatched.push({ symbol: o.symbol, exchange: o.exchange });
      continue;
    }
    if (claimed.has(target)) {
      conflicts.push({ symbol: o.symbol, exchange: o.exchange, target });
      continue;
    }
    claimed.add(target); // reserve within this run too
    plan.push({
      id: o.id,
      symbol: o.symbol,
      exchange: o.exchange,
      from: o.instrumentId,
      to: target,
    });
  }

  console.log(`\nRepair plan:`);
  console.log(`  re-linkable:   ${plan.length}`);
  console.log(`  unmatched:     ${unmatched.length}`);
  console.log(`  conflicts:     ${conflicts.length}`);

  if (plan.length > 0) {
    console.log("\n  sample re-links (first 5):");
    for (const p of plan.slice(0, 5)) {
      console.log(
        `    ${p.symbol.padEnd(14)} ${p.exchange.padEnd(4)} ${p.from} -> ${p.to}`,
      );
    }
  }
  if (unmatched.length > 0) {
    console.log(
      `\n  UNMATCHED (no InstrumentMapping for symbol+exchange) — left untouched:`,
    );
    for (const u of unmatched.slice(0, 15)) {
      console.log(`    ${u.symbol} (${u.exchange})`);
    }
    if (unmatched.length > 15) {
      console.log(`    …and ${unmatched.length - 15} more`);
    }
  }
  if (conflicts.length > 0) {
    console.log(`\n  CONFLICTS (target already linked to another row):`);
    for (const c of conflicts.slice(0, 15)) {
      console.log(`    ${c.symbol} (${c.exchange}) -> ${c.target}`);
    }
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing written. Re-run with --apply to perform ${plan.length} update(s).`,
    );
    await prisma.$disconnect();
    return;
  }

  // Rollback journal: record every (id, from, to) BEFORE writing, so the
  // exact prior instrumentId of each row can be restored if anything is
  // wrong. Written to the repo root; gitignored via scripts/ops naming.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const journalPath = `stock-ratios-repair-rollback-${stamp}.json`;
  await writeFile(
    journalPath,
    JSON.stringify(
      plan.map((p) => ({ id: p.id, from: p.from, to: p.to })),
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Rollback journal written: ${journalPath}`);

  console.log(`\nApplying ${plan.length} update(s)…`);
  let ok = 0;
  const failures: { symbol: string; error: string }[] = [];
  for (const p of plan) {
    try {
      await prisma.stockRatios.update({
        where: { id: p.id },
        data: { instrumentId: p.to },
      });
      ok++;
      if (ok % 250 === 0) console.log(`  …${ok}/${plan.length}`);
    } catch (e) {
      failures.push({
        symbol: p.symbol,
        error: String((e as Error).message).slice(0, 160),
      });
    }
  }
  console.log(`\nUpdated: ${ok}`);
  if (failures.length > 0) {
    console.log(`Failed:  ${failures.length}`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  ${f.symbol}: ${f.error}`);
    }
  }

  // Verify by re-running the exact query shape the screener uses — the one
  // that was throwing. If this succeeds, the fundamental filters work.
  console.log(`\nVerifying with the screener's own query shape…`);
  try {
    // NO `take` — MONEY-1238. A dangling REQUIRED relation throws when the row
    // carrying it is RESOLVED, so `take: 5` only ever proved the first five
    // rows were healthy: five orphans sitting at row 6 produced
    // "OK — query succeeded", the ticket was closed, and the screener stayed
    // blank. Resolving every matching row is what actually reproduces the
    // failure this script exists to repair. The sample is sliced afterwards.
    const all = await prisma.stockRatios.findMany({
      where: { pe: { lte: 20 } },
      select: {
        symbol: true,
        pe: true,
        instrument: { select: { name: true, sector: true } },
      },
    });
    const check = all.slice(0, 5);
    const count = await prisma.stockRatios.count({
      where: { pe: { lte: 20 } },
    });
    console.log(`  OK — query succeeded. pe<=20 matches: ${count}`);
    console.log(
      `  sample: ${check.map((c) => `${c.symbol}(${c.pe?.toFixed(1)})`).join(", ")}`,
    );
  } catch (e) {
    console.log(
      `  STILL FAILING: ${String((e as Error).message).slice(0, 240)}`,
    );
    console.log(
      `  (orphans may remain — re-run the dry run to see what's left)`,
    );
    // A verification that FAILED must not exit 0 — MONEY-1238. Both branches
    // used to end the same way, so "OK" and "STILL FAILING" were the same
    // outcome to any caller, and to CI.
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("FATAL:", String((e as Error).message).slice(0, 400));
  await prisma.$disconnect();
  process.exit(1);
});
