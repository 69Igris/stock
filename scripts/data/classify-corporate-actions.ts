/**
 * Retype unclassified `OTHER` corporate actions — MONEY-1176.
 *
 * ## What this does NOT do, stated first
 *
 * It does not improve a single chart. The ticket's premise was that 4,172
 * `OTHER` rows (71% of the table) were "invisible to marks and adjustment" and
 * might be hiding real splits. They are not: sampling all 4,000+ of them found
 * ZERO mentioning split, bonus, sub-division or face value. The top subjects
 * are "Payment of Interest" (3,383), "Redemption(Part) of NCD" (256), "Payment
 * of Interest for Bonds" (194) — debt servicing from BSE's much larger bond
 * universe. They are invisible to charts because they SHOULD be.
 *
 * What is left is a real but smaller problem: the table calls them nothing at
 * all. `OTHER` is a shrug, and a shrug that covers 71% of a table makes every
 * future "what corporate actions do we have?" question unanswerable without
 * re-reading free text. This gives them their actual names.
 *
 * Deliberately conservative: anything the patterns do not recognise STAYS
 * `OTHER` and is reported with samples, because a wrong type is worse than an
 * honest unknown — `price-adjust` keys on type, and a debt event mistyped as
 * SPLIT would rescale a price history.
 *
 * Usage:
 *   node --import tsx scripts/data/classify-corporate-actions.ts
 *   node --import tsx scripts/data/classify-corporate-actions.ts --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";

const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log("[classify-actions]", ...a);

/**
 * Subject -> type. Ordered: the FIRST match wins, so the more specific
 * patterns must come first ("Payment of Interest for Bonds" before a bare
 * /interest/).
 */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Structural equity events first — if one of these ever appears in OTHER it
  // matters far more than the rest, and it must not be swallowed by a looser
  // pattern below.
  [/\b(sub-?division|stock\s*split|face\s*value)\b/i, "SPLIT"],
  [/\bbonus\b/i, "BONUS"],
  [/\brights?\b/i, "RIGHTS"],
  [/\b(de-?merger|spin-?off)\b/i, "DEMERGER"],
  [/\b(amalgamation|merger)\b/i, "MERGER"],
  [/\bbuy-?back\b/i, "BUYBACK"],
  // Debt servicing — the actual bulk.
  [/\bredemption\b|\broll\s*over\b/i, "REDEMPTION"],
  [/\binterest\b|\bcoupon\b/i, "INTEREST_PAYMENT"],
  [/\bincome\s*distribution\b/i, "INCOME_DISTRIBUTION"],
  [/\bdividend\b/i, "DIVIDEND"],
  [/\b(suspension|suspended)\b/i, "SUSPENSION"],
  [/\b(annual\s*general\s*meeting|\bagm\b|egm)\b/i, "AGM"],
];

function classify(text: string): string | null {
  for (const [re, type] of PATTERNS) if (re.test(text)) return type;
  return null;
}

async function main(): Promise<void> {
  const rows = await prisma.corporateAction.findMany({
    where: { type: "OTHER" },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      exDate: true,
      details: true,
    },
  });
  log(
    `OTHER rows: ${rows.length.toLocaleString()} — mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  const byType = new Map<string, number>();
  const unmatched = new Map<string, number>();
  const plan: Array<{
    id: string;
    type: string;
    symbol: string;
    exchange: string;
    exDate: Date;
  }> = [];

  for (const r of rows) {
    const text =
      typeof r.details === "string"
        ? r.details
        : JSON.stringify(r.details ?? "");
    const type = classify(text);
    if (!type) {
      const k = text.replace(/[0-9.]+/g, "#").slice(0, 50);
      unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
      continue;
    }
    byType.set(type, (byType.get(type) ?? 0) + 1);
    plan.push({
      id: r.id,
      type,
      symbol: r.symbol,
      exchange: r.exchange,
      exDate: r.exDate,
    });
  }

  log("would reclassify:");
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]))
    log(`   ${t.padEnd(20)} ${n}`);
  log(`still unclassifiable: ${rows.length - plan.length}`);
  for (const [k, v] of [...unmatched]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)) {
    log(`   ${String(v).padStart(5)}  ${k}`);
  }

  const structural = plan.filter((p) =>
    ["SPLIT", "BONUS", "RIGHTS", "DEMERGER", "MERGER"].includes(p.type),
  );
  log(
    `STRUCTURAL rows rescued (the ones that would change a chart): ${structural.length}`,
  );
  for (const s of structural.slice(0, 10)) {
    log(`   ${s.symbol}/${s.exchange} ${toIstDateKey(s.exDate)} -> ${s.type}`);
  }

  if (!APPLY) {
    log("dry-run: pass --apply to write. Nothing changed.");
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let collided = 0;
  // try/finally: the loop can now THROW, and both the counters and the
  // disconnect sit after it. A rethrow at row 8,000 would otherwise report
  // NOTHING about the rows already retyped or deleted and leak the Prisma
  // engine — `main().catch()` only logs and sets an exit code.
  try {
    for (const p of plan) {
      try {
        await prisma.corporateAction.update({
          where: { id: p.id },
          data: { type: p.type },
        });
        updated++;
      } catch (err) {
        // ONLY a unique violation. This used to be a bare `catch {}` followed by
        // an unconditional DELETE, so EVERY update failure was answered by
        // destroying the row — a WriteConflict on a busy collection, a commit
        // timeout, an Atlas primary step-down. `plan` carries structural
        // SPLIT/BONUS/RIGHTS/DEMERGER/MERGER rows, so the ones that move a chart
        // went too, the delete's own failure was swallowed, no id was logged,
        // and the script exited 0 reporting "collided-and-removed". There is no
        // backup of this collection.
        //
        // P2002 is Prisma's unique-constraint code. Anything else RETHROWS and
        // stops the run, because "I could not write this row" is not "this row
        // is a duplicate".
        // THREE CODES, not one. `P2002` is Prisma's unique-constraint
        // violation; `11000` is MongoDB's own DuplicateKey, which surfaces —
        // as a NUMBER or a string — when a raw driver error escapes Prisma's
        // mapping. `classifyCandleRowWriteError` in packages/core matches all
        // three and its header records why; `apps/web/app/api/[[...path]]`
        // records a LIVE PROD observation of an index throwing E11000 with no
        // P2002 handler.
        //
        // Matching only P2002 would rethrow on this branch's own designed-for
        // case and abort an --apply run at its FIRST collision — worse than the
        // bug it replaced, which at least finished.
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== "P2002" && code !== 11000 && code !== "11000") {
          log(`   FAILED ${p.id} (${p.symbol}/${p.exchange}) — rethrowing`);
          throw err;
        }
        // The unique is (symbol, exchange, type, exDate): retyping can collide
        // with a correctly-typed row for the SAME event. That row is the better
        // record, so the OTHER duplicate goes. NAMED, and the delete's own
        // failure is no longer swallowed.
        log(
          `   collided ${p.id} (${p.symbol}/${p.exchange} -> ${p.type}), removing the duplicate`,
        );
        try {
          await prisma.corporateAction.delete({ where: { id: p.id } });
        } catch (delErr) {
          // P2025 is "record not found" — a concurrent run already removed it,
          // which is the outcome we wanted. Anything else is real and must not
          // be swallowed the way the original `.catch(() => {})` did.
          if ((delErr as { code?: unknown } | null)?.code !== "P2025") {
            throw delErr;
          }
        }
        collided++;
      }
    }
  } finally {
    log(`DONE: retyped ${updated}, collided-and-removed ${collided}`);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[classify-actions] failed:", err);
  process.exitCode = 1;
});
