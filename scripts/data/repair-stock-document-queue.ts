/**
 * Unstick the 1,211 `stock_documents` rows the extractor could never take
 * (MONEY-1255)
 * ==========================================================================
 *
 * NO NETWORK. NO GCS. This script reads `mimeType` off rows that already exist
 * and rewrites two columns. It fetches nothing and re-parses nothing.
 *
 * ## What was wrong
 *
 * `mimeType` is written from the raw `content-type` RESPONSE HEADER, which is
 * a media type PLUS PARAMETERS. The extract worker selects with
 * `mimeType: { in: ["application/pdf"] }` — an EXACT match — so a
 * parameterised spelling is stored, never selected, and the row sits `PENDING`
 * for the life of the table.
 *
 * Nothing looked broken. `inferExtension` named the GCS object with a
 * SUBSTRING test, so the file on disk was correctly called `.pdf` while the
 * column that decides eligibility said something the query could not match.
 *
 * Measured on prod 2026-08-26 — 43,105 rows, 36,001 of them PENDING:
 *
 *     application/pdf                34,790   selectable
 *     text/html; charset=UTF-8          863   never extractable
 *     text/html; charset=utf-8          228   never extractable
 *     text/html                          99   never extractable
 *     audio/mpeg                         13   never extractable
 *     application/zip                     5   never extractable
 *     text/html;charset=UTF-8             1   never extractable
 *     text/html;charset=utf-8             1   never extractable
 *     application/pdf;charset=UTF-8       1   IS a PDF, unreachable
 *
 * 1,211 rows in nine spellings of four media types.
 *
 * ## What this script does, and what it deliberately does not
 *
 *   NORMALIZE   a PDF stored under a parameterised spelling gets the canonical
 *               `application/pdf` and STAYS `PENDING`. It is now selectable and
 *               the next extract run takes it. (1 row on prod.)
 *
 *   UNSUPPORTED an HTML page, an MP3 or a ZIP gets the terminal `UNSUPPORTED`
 *               status and its parameters dropped. No extractor in this repo
 *               will ever read one, so `PENDING` was a claim about the future
 *               that could not come true; it made the backlog overstate itself
 *               by 1,210 and hid how deep the real PDF queue is. (1,210 rows.)
 *
 * It does NOT delete anything, does not touch `textContent`, does not move a
 * row out of `READY` or `FAILED`, and does not invent a status for anything it
 * cannot classify. The bytes stay in GCS either way — `UNSUPPORTED` says "we
 * hold this document and there is no text to get out of it", not "it is gone".
 *
 * `UNSUPPORTED` is a distinct value rather than `FAILED` on purpose: `FAILED`
 * means "we tried and it did not work" and `force:true` re-runs it, which would
 * put 1,210 guaranteed no-ops into every forced pass.
 *
 * ## It is a repair, not the fix
 *
 * The writers that produced these rows still run every week. The fix is at the
 * WRITE — `normalizeDocMimeType` / `initialProcessingStatus`, applied in
 * `workers/src/processors/stock-document-sync.ts` and
 * `packages/research/src/data-sources/stock-document-fetcher.ts` — and this
 * script imports the SAME two functions rather than restating the rule, so the
 * repair and the writers can never disagree about what a PDF is.
 *
 * ## Which environment
 *
 * Run it on **prod**. `stock_documents` is in `sync-prod-to-qa.sh`'s
 * `REFERENCE_COLLECTIONS`, so QA receives the corrected rows by copy and a QA
 * run would be undone by the next restore. `--env qa` still works for a
 * rehearsal.
 *
 * ## Verification does not reuse the selection's filter
 *
 * The post-write census goes through `$runCommandRaw`, not through the Prisma
 * predicate the write loop used. A verify that re-runs the selection's own
 * predicate can only ever confirm the selection's own blind spot — the
 * MONEY-1236 lesson, and the reason those three scripts printed a confident
 * zero for months. The raw `$facet` also re-counts the WHOLE collection and
 * compares it against Prisma's total, because `aggregate` against a collection
 * name that does not exist returns an empty result rather than an error, so a
 * future `@@map()` rename would otherwise turn the verify into a hard-coded
 * pass.
 *
 * Usage (dry run prints the full census and writes nothing):
 *   npx tsx scripts/data/repair-stock-document-queue.ts --env prod
 *   npx tsx scripts/data/repair-stock-document-queue.ts --env prod --apply
 *   DATABASE_URL=... npx tsx scripts/data/repair-stock-document-queue.ts
 *
 * Or through the wrapper, which pulls DATABASE_URL from Secret Manager and
 * echoes the masked target before the write:
 *   ./scripts/ops/run-market-data-job.sh docqueue prod
 *   ./scripts/ops/run-market-data-job.sh docqueue prod --apply
 *
 * Flags:
 *   --apply        actually write (default: dry run). ALWAYS prompts; needs a TTY.
 *   --env qa|prod  read DATABASE_URL from GCP Secret Manager
 *   --limit N      dry-run only — sample the first N PENDING rows
 */

import { execFileSync } from "child_process";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// The REAL production rule, imported rather than restated. A NARROW subpath:
// `doc-mime` is a zero-import pure leaf, so this cannot drag in
// `@usemoney/database`, whose PrismaClient is built at module scope from
// `process.env.DATABASE_URL` and would pin the client before `--env` resolves.
import {
  CANONICAL_PDF_MIME_TYPE,
  normalizeDocMimeType,
  isExtractableDocMimeType,
  planDocQueueRepair,
} from "@usemoney/core/market-data/doc-mime";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
});

const GCP_PROJECT = "stock-book-483718";

/** `StockDocument.@@map`. Used by the raw verification only. */
const COLLECTION = "stock_documents";

/** Rows per Prisma page while walking the queue. */
const PAGE_SIZE = 2000;

/** Ids per `updateMany`. Keeps a single command's filter document bounded. */
const WRITE_CHUNK = 500;

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
}

/**
 * Flags this script understands. Anything else is REFUSED rather than ignored:
 * `argv.includes()` silently drops what it does not recognise, which is how a
 * sibling script came to accept-and-ignore `--dry-run` alongside `--apply`
 * (i.e. it WROTE).
 */
const KNOWN_FLAGS = new Set(["--apply", "--env", "--limit"]);

function assertKnownFlags(argv: string[]): void {
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}.`,
    );
  }
  const eq = argv.filter((a) => /^--[a-z-]+=/.test(a));
  if (eq.length > 0) {
    throw new Error(
      `Use "--flag value", not "${eq[0]}". The equals form is not parsed, and an ` +
        `unparsed --env would leave APPLY mode pointed at the ambient DATABASE_URL.`,
    );
  }
}

function parseArgs(argv: string[]): Options {
  assertKnownFlags(argv);
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${f} was given with no value`);
    }
    return next;
  };

  const env = val("--env");
  if (env && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}"`);
  }

  const limitRaw = val("--limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
    }
    limit = n;
  }

  const apply = has("--apply");
  // A sampled census beside a whole-table write is the shape where the only
  // output an operator can judge the change by describes something else.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: the census would describe a " +
        "sample while the write covers the queue. Use --limit for the dry run, " +
        "then --apply without it.",
    );
  }
  // Fail FAST, before reading 36,000 rows. `--apply` on a closed stdin can
  // never succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success (the MONEY-1252 shape).
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt cannot " +
        "be answered when stdin is not a TTY (a pipe, </dev/null, or a CI runner).",
    );
  }

  return { apply, env: (env as "qa" | "prod" | null) ?? null, limit };
}

/** Fetch DATABASE_URL from Secret Manager, mirroring scripts/seed-env.sh. */
function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/** Host of a Mongo URI, for display. Never prints any credential. */
function maskedHost(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.host || null;
  } catch {
    const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, "");
    const authority = withoutScheme.split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return host.trim() || null;
  }
}

/** Confirm before ANY write, whichever database is targeted. */
async function confirmWrite(
  uri: string,
  envLabel: string,
  normalize: number,
  unsupported: number,
): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL. The prompt exists so you can SEE what you are about to " +
        "hit; a placeholder gives you nothing to check.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot be " +
        "answered. This script is deliberately interactive.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n⚠️  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `      change : ${normalize} row(s) -> mimeType "${CANONICAL_PDF_MIME_TYPE}" (stay PENDING)\n` +
      `               ${unsupported} row(s) -> processingStatus "UNSUPPORTED"\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    // Non-zero: an abort is NOT success.
    console.log("Aborted.");
    process.exit(1);
  }
}

interface QueueRow {
  id: string;
  mimeType: string | null;
  symbol: string;
  docType: string;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

function census(counter: Map<string, number>, indent = "    "): string {
  const rows = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  const width = Math.max(1, ...rows.map(([, n]) => String(n).length));
  return rows
    .map(([k, n]) => `${indent}${pad(n, width)}  ${k}`)
    .join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) {
    throw new Error(
      "No DATABASE_URL. Pass --env qa|prod, or export DATABASE_URL yourself.",
    );
  }

  const { prisma } = await import("@usemoney/database");

  console.log(
    `\nstock_documents queue repair — ${opts.apply ? "APPLY" : "DRY RUN"}` +
      `${opts.env ? ` (--env ${opts.env})` : ""}` +
      `${opts.limit ? ` [SAMPLE of ${opts.limit}]` : ""}\n` +
      `target: ${maskedHost(uri) ?? "<unknown host>"}\n`,
  );

  // ── read ────────────────────────────────────────────────────────────────
  //
  // Keyset pagination on `id` rather than skip/take: `skip` re-scans the prefix
  // on every page, and this walks ~36,000 rows.
  //
  // NO NEGATIVE mimeType FILTER, deliberately. `mimeType` carries a schema
  // DEFAULT, and `prisma db push` creates indexes rather than fields, so the
  // attribute can be ABSENT on rows that predate the column — the class that
  // has now cost MONEY-1050, 1205, 1234, 1235 and 1236. Selecting every PENDING
  // row and classifying in application code cannot have a blind spot: an absent
  // `mimeType` arrives as null, `normalizeDocMimeType` maps it to the canonical
  // PDF, and it is reported like any other row.
  const statusFilter = { processingStatus: "PENDING" as const };

  const plans = {
    normalize: [] as QueueRow[],
    unsupported: [] as QueueRow[],
  };
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  const byAction = new Map<string, number>();

  let cursor: string | null = null;
  let scanned = 0;
  for (;;) {
    const take: number = opts.limit
      ? Math.min(PAGE_SIZE, opts.limit - scanned)
      : PAGE_SIZE;
    if (take <= 0) break;

    const page: QueueRow[] = await prisma.stockDocument.findMany({
      where: statusFilter,
      select: { id: true, mimeType: true, symbol: true, docType: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;

    for (const row of page) {
      scanned++;
      const stored = row.mimeType ?? "<absent>";
      bump(before, stored);
      const plan = planDocQueueRepair(row.mimeType);
      bump(byAction, plan.action);
      bump(after, `${plan.mimeType}  [${plan.processingStatus}]`);
      if (plan.action === "normalize") plans.normalize.push(row);
      if (plan.action === "unsupported") plans.unsupported.push(row);
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < take) break;
  }

  const totalPending = await prisma.stockDocument.count({
    where: statusFilter,
  });

  console.log(`  PENDING rows scanned : ${scanned}`);
  if (!opts.limit) console.log(`  PENDING rows total   : ${totalPending}`);
  console.log(`\n  stored mimeType, as it is now:\n${census(before)}`);
  console.log(`\n  after this repair:\n${census(after)}`);
  console.log(
    `\n  plan:\n` +
      `    ${plans.normalize.length}  normalize  -> mimeType "${CANONICAL_PDF_MIME_TYPE}", stays PENDING (now selectable)\n` +
      `    ${plans.unsupported.length}  unsupported-> processingStatus "UNSUPPORTED" (terminal; no extractor reads these)\n` +
      `    ${byAction.get("unchanged") ?? 0}  unchanged\n`,
  );

  if (plans.normalize.length > 0) {
    console.log("  rows becoming selectable:");
    for (const r of plans.normalize.slice(0, 20)) {
      console.log(`    ${r.symbol}  ${r.docType}  ${r.mimeType}`);
    }
    if (plans.normalize.length > 20) {
      console.log(`    … and ${plans.normalize.length - 20} more`);
    }
    console.log("");
  }

  if (!opts.apply) {
    console.log(
      `  DRY RUN — nothing written. Re-run with --apply (prompts, needs a TTY).\n`,
    );
    await prisma.$disconnect();
    return;
  }

  if (plans.normalize.length === 0 && plans.unsupported.length === 0) {
    console.log("  Nothing to change.\n");
    await prisma.$disconnect();
    return;
  }

  await confirmWrite(
    uri,
    opts.env ?? "ambient DATABASE_URL",
    plans.normalize.length,
    plans.unsupported.length,
  );

  // ── write ───────────────────────────────────────────────────────────────
  //
  // `processingStatus: "PENDING"` stays in the filter. The extract worker runs
  // on a clock and may have flipped one of these rows to PROCESSING between the
  // read above and this write; re-asserting the status means such a row is left
  // alone rather than dragged back out of a run in flight.
  let written = 0;
  for (const [rows, data] of [
    [plans.normalize, { mimeType: CANONICAL_PDF_MIME_TYPE }],
    [plans.unsupported, null],
  ] as const) {
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      if (data) {
        const res = await prisma.stockDocument.updateMany({
          where: { id: { in: chunk.map((r) => r.id) }, ...statusFilter },
          data,
        });
        written += res.count;
      } else {
        // The unsupported bucket carries per-row mimeTypes (`text/html`,
        // `audio/mpeg`, `application/zip`), so it is grouped by target value
        // rather than written one statement per row.
        const byMime = new Map<string, string[]>();
        for (const r of chunk) {
          const m = normalizeDocMimeType(r.mimeType);
          byMime.set(m, [...(byMime.get(m) ?? []), r.id]);
        }
        for (const [mimeType, ids] of byMime) {
          const res = await prisma.stockDocument.updateMany({
            where: { id: { in: ids }, ...statusFilter },
            data: { mimeType, processingStatus: "UNSUPPORTED" },
          });
          written += res.count;
        }
      }
    }
  }
  console.log(`\n  wrote ${written} row(s).`);

  // ── verify, through a DIFFERENT route than the selection ────────────────
  //
  // Raw Mongo, not the Prisma predicate the write loop used. A verify that
  // re-runs the selection's own filter can only confirm the selection's own
  // blind spot (MONEY-1236). The `$facet` also re-counts the whole collection,
  // because `aggregate` against a name that does not exist returns an EMPTY
  // result rather than an error — so a future `@@map()` rename would otherwise
  // turn this check into a hard-coded pass.
  const raw = (await prisma.$runCommandRaw({
    aggregate: COLLECTION,
    pipeline: [
      {
        $facet: {
          pendingByMime: [
            { $match: { processingStatus: "PENDING" } },
            { $group: { _id: "$mimeType", n: { $sum: 1 } } },
          ],
          total: [{ $count: "n" }],
        },
      },
    ],
    cursor: {},
  })) as unknown as {
    cursor?: {
      firstBatch?: {
        pendingByMime?: { _id: string | null; n: number }[];
        total?: { n: number }[];
      }[];
    };
  };

  const facet = raw.cursor?.firstBatch?.[0];
  const rawTotal = facet?.total?.[0]?.n ?? 0;
  const prismaTotal = await prisma.stockDocument.count();
  if (rawTotal !== prismaTotal) {
    throw new Error(
      `Verification aborted: raw aggregate over "${COLLECTION}" counted ${rawTotal} ` +
        `documents, Prisma counted ${prismaTotal}. Either the @@map changed or the ` +
        `aggregate hit a collection that does not exist — an empty result reads ` +
        `as a clean bill and must never be trusted as one.`,
    );
  }

  const leftovers = (facet?.pendingByMime ?? []).filter(
    (g) => !isExtractableDocMimeType(g._id),
  );
  console.log("\n  post-write PENDING census (raw Mongo):");
  for (const g of (facet?.pendingByMime ?? []).sort((a, b) => b.n - a.n)) {
    console.log(`    ${pad(g.n, 6)}  ${g._id ?? "<absent>"}`);
  }
  if (leftovers.length > 0) {
    throw new Error(
      `Verification FAILED: ${leftovers.length} non-extractable mimeType(s) are ` +
        `still PENDING (${leftovers.map((g) => `${g._id}:${g.n}`).join(", ")}). ` +
        `They would sit in the queue forever.`,
    );
  }
  console.log("\n  verified: every PENDING row is now selectable.\n");

  await prisma.$disconnect();
}

// `import.meta.url` guard: keeps `main()` from running if this module is ever
// imported rather than executed (it would reach for a DATABASE_URL and shell
// out to gcloud). The pure decision it drives lives in
// `@usemoney/core/market-data/doc-mime` and is tested there directly.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
