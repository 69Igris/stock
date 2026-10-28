/**
 * Re-resolve `xbrl_filings.instrumentId` — MONEY-1299.
 *
 * ## What it repairs, and it is NOT what the ticket said
 *
 * The ticket was filed against 6,732 filings across 275 symbols that carry an
 * `isin` and a null `instrumentId`. Measured on prod 2026-08-30, **6,536 of them
 * (97.1%), over 269 symbols, have NO row in `instrument_mappings` bearing that
 * ISIN at all** — delisted or suspended issuers (RELCAPITAL, JPASSOCIAT,
 * TALWALKARS, TATACOFFEE post-merger). Verified with a control join and with
 * case-insensitive probes. Nothing this script can do will fill them; it reports
 * them as `unresolved` and leaves them null, which is what the nullable column
 * is for.
 *
 * The defect worth repairing is the one the same measurement turned up in the
 * rows that DID resolve. `resolveInstrumentId`'s ISIN leg was
 * `findFirst({ where: { isin } })` with no `orderBy`, and a dual listing puts
 * TWO `instrument_mappings` rows behind one ISIN — 2,155 of the 2,845 ISINs in
 * `xbrl_filings`, every one of them the same shape (NSE-active + BSE-active).
 * Mongo answered with the BSE row:
 *
 *     79,297 of 101,288 resolved filings (78.3%), across 2,172 symbols,
 *     are attached to the company's BSE listing —
 *     while xbrl_filings.exchange is "NSE" on all 108,020 rows.
 *
 * That is not cosmetic. `xbrl-ratios` reads filings by `instrumentId` and upserts
 * `stock_ratios` on `(symbol, exchange)` taken from the INSTRUMENT, so a
 * BSE-attached filing writes `(SYMBOL, "BSE")`. All 2,135 incumbent
 * `stock_ratios` rows and all 32,359 `stock_financials` rows are keyed to NSE
 * instruments, so there is no collision and no error — it creates a SECOND row
 * per company, and every reader asking for the NSE listing (the stock page's
 * default) keeps the stale one. 163 of those filings sit on a row whose symbol
 * belongs to a different company outright (GILLETTE on `PGHH/BSE`).
 *
 * ## How it decides
 *
 * It does not decide. It imports `rankIsinCandidates` from
 * `workers/src/processors/xbrl-sync-logic.ts` — the SAME pure ladder the nightly
 * writer now uses — so the repair and the writer cannot disagree. Running this
 * after the writer is deployed is a fixpoint: everything reports `unchanged`.
 *
 * ## Safety
 *
 *   - DRY RUN BY DEFAULT. `--apply` is required to write anything.
 *   - `--apply` REFUSES a non-TTY stdin and then prompts for "yes", echoing the
 *     masked target host. An agent runs dry runs; a human runs writes.
 *   - It writes ONE column, `instrumentId`, and never deletes a row. A filing
 *     whose ISIN matches nothing keeps its null rather than being re-pointed at
 *     a symbol match — the symbol leg is the nightly writer's fallback, not a
 *     repair authority, and 4 of the 6 symbol-only matches on prod sit on a BSE
 *     row whose own ISIN DIFFERS from the filing's.
 *   - `@usemoney/database` is imported LAZILY, after `--env` resolves. A static
 *     import bakes the ambient `DATABASE_URL` into the client at module
 *     evaluation and silently ignores `--env` (the trap documented at length on
 *     `reclassify-instruments.ts`).
 *
 * ## Usage
 *
 *   npx tsx scripts/data/reresolve-xbrl-instruments.ts --env prod
 *   npx tsx scripts/data/reresolve-xbrl-instruments.ts --env prod --apply
 *
 *   Options
 *     --apply          actually write (default: dry run)
 *     --env <qa|prod>  fetch DATABASE_URL from GCP Secret Manager
 *     --limit <n>      cap filings examined (dry run only)
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

// PURE, and that is why it can be a static import: the ladder module has no
// Prisma client, so importing it cannot construct a connection before `--env`
// has chosen one.
import {
  rankIsinCandidates,
  type InstrumentCandidate,
  type InstrumentRung,
} from "../../workers/src/processors/xbrl-sync-logic";

type PrismaLike = (typeof import("@usemoney/database"))["default"];
let prisma: PrismaLike | null = null;

interface Opts {
  apply: boolean;
  env: "qa" | "prod" | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Opts {
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };

  const env = val("--env");
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be "qa" or "prod", got "${env}".`);
  }

  let limit: number | null = null;
  const limitRaw = val("--limit");
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitRaw}".`);
    }
    limit = n;
  }

  const apply = has("--apply");
  // `--limit` takes a prefix of the collection, so the plan it prints is not the
  // plan `--apply` would execute. Refusing beats writing something the operator
  // did not review.
  if (apply && limit !== null) {
    throw new Error(
      "--limit cannot be combined with --apply: a limited prefix is not the " +
        "population the write would touch. Use --limit for the dry run, then " +
        "--apply without it.",
    );
  }
  // Fail FAST, before reading 108,020 rows. `--apply` on a closed stdin can
  // never succeed, and a hung prompt exits 0 — which a wrapper's `&&` reads as
  // success.
  if (apply && !process.stdin.isTTY) {
    throw new Error(
      "--apply requires an interactive terminal: the confirmation prompt " +
        "cannot be answered when stdin is not a TTY (a pipe, </dev/null, or a " +
        "CI runner). Refusing rather than hanging.",
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
      "--project=stock-book-483718",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!out) throw new Error(`Secret ${secret} resolved empty.`);
  return out;
}

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

async function confirmWrite(uri: string, envLabel: string): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    console.error(
      "\n  Refusing to write: could not determine the target host from " +
        "DATABASE_URL.\n",
    );
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "\n  Refusing to write: stdin is not a TTY, so the confirmation cannot " +
        "be answered.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `\n⚠️  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      source : ${envLabel}\n` +
      `   It re-points xbrl_filings.instrumentId at the ranked instrument.\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  if (answer !== "yes") {
    console.log("Aborted.");
    process.exit(1);
  }
}

type Verdict =
  | "unchanged"
  | "fill"
  | "reattach"
  /** ISIN matches no mapping AND the row is already null. The real gap. */
  | "unresolved-null"
  /**
   * ISIN matches no mapping but the row ALREADY has an instrumentId — it was
   * resolved by the nightly writer's SYMBOL leg. LEFT ALONE, never nulled:
   * measured on prod this is 18,284 filings, and clearing them to "repair" a
   * join would destroy a correct resolution to satisfy a tidier rule.
   */
  | "unresolved-kept"
  | "no-isin";

const PAGE = 5000;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const envLabel = opts.env ? `--env ${opts.env}` : "ambient DATABASE_URL";
  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set and no --env was given.");

  console.log(`\n  target : ${maskedHost(uri) ?? "<unknown>"}`);
  console.log(`  source : ${envLabel}`);
  console.log(`  mode   : ${opts.apply ? "APPLY (writes)" : "DRY RUN"}\n`);

  if (opts.apply) await confirmWrite(uri, envLabel);

  prisma = (await import("@usemoney/database")).default;
  const db = prisma;

  // The ISIN -> candidates map, ONCE. `instrument_mappings` holds ~10,187 rows
  // with a non-null ISIN, which fits in memory comfortably and turns 108,020
  // per-filing lookups into one read.
  const mappings = await db.instrumentMapping.findMany({
    where: { isin: { not: null } },
    select: {
      id: true,
      isin: true,
      exchange: true,
      isActive: true,
      symbol: true,
    },
  });
  const byIsin = new Map<string, InstrumentCandidate[]>();
  const symbolById = new Map<string, string>();
  const exchangeById = new Map<string, string>();
  for (const m of mappings) {
    if (!m.isin) continue;
    const list = byIsin.get(m.isin);
    if (list) list.push(m);
    else byIsin.set(m.isin, [m]);
    symbolById.set(m.id, m.symbol);
    exchangeById.set(m.id, m.exchange);
  }
  console.log(
    `  instrument_mappings : ${mappings.length} rows with an ISIN, ` +
      `${byIsin.size} distinct ISINs\n`,
  );

  const counts: Record<Verdict, number> = {
    unchanged: 0,
    fill: 0,
    reattach: 0,
    "unresolved-null": 0,
    "unresolved-kept": 0,
    "no-isin": 0,
  };
  const rungs: Partial<Record<InstrumentRung, number>> = {};
  /** target instrumentId -> filing ids to point at it. */
  const writes = new Map<string, string[]>();
  /** Reattachments that also change the instrument's SYMBOL — worth eyeballing. */
  const symbolChanges: string[] = [];
  const unresolvedSymbols = new Map<string, number>();

  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await db.xbrlFiling.findMany({
      take: opts.limit ? Math.min(PAGE, opts.limit - scanned) : PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        isin: true,
        instrumentId: true,
      },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    scanned += page.length;

    for (const f of page) {
      if (!f.isin) {
        counts["no-isin"]++;
        continue;
      }
      const choice = rankIsinCandidates(
        byIsin.get(f.isin) ?? [],
        f.exchange === "BSE" ? "BSE" : "NSE",
      );
      if (!choice) {
        // NEVER writes null. A row already carrying an id got it from the
        // symbol leg, which is a real resolution this script has no authority
        // to overturn.
        counts[
          f.instrumentId === null ? "unresolved-null" : "unresolved-kept"
        ]++;
        if (f.instrumentId === null) {
          unresolvedSymbols.set(
            f.symbol,
            (unresolvedSymbols.get(f.symbol) ?? 0) + 1,
          );
        }
        continue;
      }
      rungs[choice.rung] = (rungs[choice.rung] ?? 0) + 1;
      if (choice.id === f.instrumentId) {
        counts.unchanged++;
        continue;
      }
      counts[f.instrumentId === null ? "fill" : "reattach"]++;
      if (f.instrumentId) {
        const wasSym = symbolById.get(f.instrumentId);
        const wasEx = exchangeById.get(f.instrumentId);
        const nowSym = symbolById.get(choice.id);
        if (
          wasSym &&
          nowSym &&
          wasSym !== nowSym &&
          symbolChanges.length < 25
        ) {
          symbolChanges.push(
            `${f.symbol} (${f.exchange}) : ${wasSym}/${wasEx} -> ${nowSym}/${exchangeById.get(choice.id)}`,
          );
        }
      }
      const list = writes.get(choice.id);
      if (list) list.push(f.id);
      else writes.set(choice.id, [f.id]);
    }
    if (opts.limit && scanned >= opts.limit) break;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  filings scanned      : ${total}`);
  console.log(`  unchanged            : ${counts.unchanged}`);
  console.log(`  WOULD FILL (null->id): ${counts.fill}`);
  console.log(`  WOULD REATTACH       : ${counts.reattach}`);
  console.log(
    `  UNRESOLVED, still null : ${counts["unresolved-null"]} over ` +
      `${unresolvedSymbols.size} symbols  (no instrument_mappings row bears the ISIN)`,
  );
  console.log(
    `  unresolved, kept as-is : ${counts["unresolved-kept"]}  ` +
      `(ISIN unmatched, but the symbol leg already resolved them — untouched)`,
  );
  console.log(`  no isin on filing      : ${counts["no-isin"]}`);
  console.log(
    `  rungs                : ${
      Object.entries(rungs)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}:${v}`)
        .join(", ") || "none"
    }`,
  );
  if (symbolChanges.length) {
    console.log(
      `\n  reattachments that change the instrument's SYMBOL (sample):`,
    );
    for (const c of symbolChanges) console.log(`    ${c}`);
  }
  if (unresolvedSymbols.size) {
    const top = [...unresolvedSymbols.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    console.log(
      `\n  top unresolved symbols (ISIN in NO instrument_mappings row):`,
    );
    for (const [s, n] of top) console.log(`    ${s.padEnd(14)} ${n}`);
  }

  if (!opts.apply) {
    console.log(
      `\n  DRY RUN — nothing written. Re-run with --apply to write.\n`,
    );
    return;
  }

  let written = 0;
  for (const [instrumentId, ids] of writes) {
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      const res = await db.xbrlFiling.updateMany({
        where: { id: { in: slice } },
        data: { instrumentId },
      });
      written += res.count;
    }
  }
  console.log(
    `\n  WROTE ${written} filings across ${writes.size} instruments.\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
