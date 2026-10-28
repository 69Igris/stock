/**
 * MONEY-1317 — fill `ingestedAt`/`updatedAt` on every EDGAR row that lacks them.
 *
 * ## What is broken
 *
 * Both fields are declared REQUIRED in `schema.prisma` with a CLIENT-SIDE
 * default — `@default(now())` and `@updatedAt` — and Prisma applies those in
 * its own client. `services/us-fundamentals` writes through pymongo, which
 * applies neither, so the columns are simply ABSENT and every Prisma read of
 * such a row raises:
 *
 *     PrismaClientKnownRequestError  P2032
 *     Error converting field "ingestedAt" of expected non-nullable type
 *
 * Measured on prod 2026-09-01: SEVEN of ten EDGAR collections unreadable,
 * 785,352 rows. `us_fundamentals` is the live one — it has a real reader
 * (`getStatements`) and a MIXED population, so it failed per-symbol and
 * INTERMITTENTLY, which is why it went unseen.
 *
 * ## Run it AFTER the writer fix is deployed
 *
 * The writer half of MONEY-1317 (`_with_storage_timestamps` in
 * `app/store/writers.py`) stops NEW rows arriving broken. Until that is live,
 * `edgar-detect` keeps writing them — measured, the newest broken row was
 * generated minutes before this script was written. A backfill run first is not
 * wrong, just incomplete: run it again after the deploy, or simply run it after.
 *
 * ## The value
 *
 * `{ $toDate: "$_id" }` — the ObjectId's own generation time, which IS when the
 * row was created. Verified against real rows: it always falls AFTER `filedAt`
 * (ingestion follows filing) and spans 2026-08-29 to 2026-09-01, matching a
 * table that is three days old.
 *
 * `filedAt` was the obvious alternative and is WRONG: it is when the company
 * filed with the SEC, not when we stored the row. For `us_cusip_map` and
 * `us_edgar_cursor` there is no `filedAt` at all.
 *
 * ## Run log
 *
 * PROD, 2026-09-01: `filled=785444 remaining=0` across the seven affected
 * collections (us_insider_transactions 737,149 · us_cusip_map 23,228 ·
 * us_fundamentals 21,725 · us_filing_documents 2,907 · us_13f_holdings 276 ·
 * us_beneficial_ownership 150 · us_13f_filings 9). Verified afterwards by a
 * real `findMany` on all seven plus `getStatements("AAPL")`, which returned 19
 * rows where it previously threw.
 *
 * `us_filing_documents` filled 2,907 against a dry run that counted 2,906 —
 * one row arrived broken BETWEEN the two commands, which is the deploy caveat
 * above showing up as a number rather than as a warning.
 *
 * ## FILL, never OVERRIDE
 *
 * `$ifNull` on both, so a row that already carries one keeps it. That mirrors
 * the writer exactly — this service's contract is that the ROW declares its
 * timestamps and only the absent ones are filled — and it makes the script
 * idempotent: a second run matches nothing.
 *
 * ## Usage
 *
 *   node --import tsx scripts/migrations/backfill-edgar-row-timestamps.ts
 *   node --import tsx scripts/migrations/backfill-edgar-row-timestamps.ts --apply
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import prisma from "@usemoney/database";

const APPLY = process.argv.includes("--apply");
// `fileURLToPath(import.meta.url)`, not `import.meta.dirname` — tsx transpiles
// this to CJS, where `import.meta.dirname` is undefined and the failure is a
// path TypeError at import time. Not `process.cwd()` either: that would make
// the script correct only when run from the repo root.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = path.join(ROOT, "packages", "database", "prisma", "schema.prisma");

const log = (...a: unknown[]): void => console.log("[edgar-timestamps]", ...a);

/**
 * Collections whose Prisma model declares BOTH timestamps as required.
 *
 * Derived from the schema rather than listed, so a model added later is covered
 * without anyone remembering this file — the same rule the Python-side guard
 * uses, so the two cannot disagree about which collections are in scope.
 */
function timestampModels(): { model: string; collection: string; fields: string[] }[] {
  const src = readFileSync(SCHEMA, "utf8");
  const out: { model: string; collection: string; fields: string[] }[] = [];
  // `Us[A-Z]`, not `Us\w+`. The lazy prefix also matched `UserDocument`
  // ("Us" + "erDocument"), which is not a US model at all.
  for (const m of src.matchAll(/\nmodel (Us[A-Z]\w+) \{([\s\S]*?)\n\}/g)) {
    const [, model, body] = m;
    if (!body || !model) continue;
    // PER MODEL, from what THAT model declares. A fixed
    // `ingestedAt`-or-`updatedAt` filter was the first version and it was
    // dangerous: models that use `createdAt` instead have no `ingestedAt` at
    // all, so `{ingestedAt: {$exists: false}}` matched EVERY row — 2,948,700 of
    // `us_corporate_actions` alone — and the update would have written a field
    // the model does not have onto healthy rows. Dry-run-by-default caught it.
    const fields = ["ingestedAt", "createdAt", "updatedAt"].filter((f) =>
      new RegExp(`^\\s{2}${f}\\s+DateTime\\s+(?!\\?)[^\\n?]*$`, "m").test(body),
    );
    if (fields.length === 0) continue;
    const map = /@@map\("([a-z0-9_]+)"\)/.exec(body)?.[1];
    if (map) out.push({ model, collection: map, fields });
  }
  return out;
}

/** Rows of `collection` missing any timestamp THAT MODEL declares. */
function needsFill(fields: string[]): object {
  return { $or: fields.map((f) => ({ [f]: { $exists: false } })) };
}

/** Fill only the declared fields, and only where absent. */
function fillStage(fields: string[]): object {
  const set: Record<string, unknown> = {};
  for (const f of fields) set[f] = { $ifNull: [`$${f}`, { $toDate: "$_id" }] };
  return { $set: set };
}

async function count(collection: string, query: object): Promise<number> {
  const r = (await prisma.$runCommandRaw({ count: collection, query } as never)) as {
    n?: number;
  };
  return r.n ?? 0;
}

async function main(): Promise<void> {
  const targets = timestampModels();
  if (targets.length === 0) {
    log("FATAL: parsed no Us* models out of schema.prisma — the regex drifted");
    process.exitCode = 1;
    return;
  }
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} collections=${targets.length}`);

  let before = 0;
  const plan: { collection: string; n: number; fields: string[] }[] = [];
  for (const { collection, fields } of targets) {
    const n = await count(collection, needsFill(fields));
    before += n;
    plan.push({ collection, n, fields });
    log(
      `  ${collection.padEnd(26)} ${String(n).padStart(9)} row(s)  [${fields.join(", ")}]`,
    );
  }
  log(`  ${"".padEnd(26)} ${"-".repeat(9)}`);
  log(`  ${"TOTAL".padEnd(26)} ${String(before).padStart(9)}`);

  if (!APPLY) {
    log("dry-run: pass --apply to write. Nothing changed.");
    return;
  }
  if (before === 0) {
    log("nothing to fill — already clean.");
    return;
  }

  let filled = 0;
  for (const { collection, n, fields } of plan) {
    if (n === 0) continue;
    const res = (await prisma.$runCommandRaw({
      update: collection,
      updates: [
        {
          q: needsFill(fields),
          // A PIPELINE update, so the value is computed per row SERVER-SIDE
          // from that row's own `_id`. The alternative — reading 785,352 rows
          // to the client to compute a date each — moves ~gigabytes to learn
          // something MongoDB already knows.
          u: [fillStage(fields)],
          multi: true,
        },
      ],
    } as never)) as { n?: number; nModified?: number };
    const mod = res.nModified ?? 0;
    filled += mod;
    log(`  ${collection.padEnd(26)} filled ${String(mod).padStart(9)} of ${n}`);
  }

  const after = (
    await Promise.all(targets.map((t) => count(t.collection, needsFill(t.fields))))
  ).reduce((a, b) => a + b, 0);

  log(`filled=${filled} remaining=${after}`);
  if (after > 0) {
    // Not necessarily a failure: `edgar-detect` runs every minute, so rows can
    // arrive between the update and this count. It IS a failure if the writer
    // fix is not deployed, because then they keep arriving forever.
    log(
      `WARNING ${after} row(s) still lack a timestamp. If the writer fix ` +
        "(app/store/writers.py::_with_storage_timestamps) is not deployed yet, " +
        "new rows are still being written broken — deploy it, then re-run.",
    );
  }
}

main()
  .catch((err) => {
    console.error("[edgar-timestamps] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
