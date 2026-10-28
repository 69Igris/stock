/**
 * Backfill `InstrumentMapping.previousSymbols` from the feed archive —
 * MONEY-1177.
 *
 * ## Where the data comes from
 *
 * Nothing in the database records that ETERNAL used to be ZOMATO:
 * `syncInstruments` upserts on `(symbol, exchange)`, so a rename creates a NEW
 * row and the old one is merely deactivated. The retired ticker then matches
 * nothing at all.
 *
 * But every archived bhavcopy carries dated `(symbol, ISIN)` pairs, and ISIN
 * survives a rename — that is exactly what let `resolveInstrumentId` reattach
 * Zomato-era prices to ETERNAL during the MONEY-1175 re-parse. So the rename
 * history is already in the archive and only has to be read out. No external
 * source, no scraping, nothing to rate-limit.
 *
 * ## Monthly sampling, not every file
 *
 * A rename persists for months, so reading one file per month cannot miss one
 * while cutting ~9,000 downloads to ~380. What monthly sampling costs is
 * precision on the exact changeover date, which nothing here needs — the
 * succession test only compares whole spans.
 *
 * Pre-1998 NSE files have NO ISIN column at all, so they contribute nothing and
 * are skipped by the parser returning `isin: null`.
 *
 * ## The rule
 *
 * See `symbol-alias-logic.ts`: a rename is a SUCCESSION (old stops when new
 * starts), a variant is a COEXISTENCE (both trade the same day). Only the
 * former becomes an alias, which is what keeps rights entitlements and series
 * variants — CITIUSINVT vs CITIUSINVT-IV, same ISIN, same days — out of search.
 *
 * ## Env (this script does NOT read .env, same as feed-parse)
 *
 *   DATABASE_URL, GCP_PROJECT_ID, GCP_STORAGE_BUCKET=stockbook-content-prod,
 *   GOOGLE_APPLICATION_CREDENTIALS, FEED_ARCHIVE_MODE=replay
 *
 * `.env` carries GCP_STORAGE_BUCKET=stockbook-content-local, which would list
 * an EMPTY bucket and report a confident zero.
 *
 * Usage:
 *   node --import tsx scripts/data/backfill-symbol-aliases.ts
 *   node --import tsx scripts/data/backfill-symbol-aliases.ts --apply
 */

import { prisma } from "@usemoney/database";
import { listFiles, downloadFile } from "@usemoney/storage";
// MONEY-1206 (D2): the ONE archive decoder, shared with
// `scripts/jobs/feed-parse.ts`. This script used to declare its own `toCsv`
// that handled zip and plain text only — so the one archived object that is a
// GZIP stream under a `.csv` key decoded to mojibake here, yielded no ISINs,
// and contributed nothing to the rename history, silently. Imported by PATH
// because `@usemoney/core/market-data` does not re-export it.
import { decodeFeedText } from "@usemoney/core/market-data";
import {
  parseOldNseCmBhavcopy,
  parseUdiffBhavcopy,
  buildSymbolSpans,
  decideAliases,
  mergeWithSeed,
  aliasGroupKey,
  dateFromArchiveKey,
  type SymbolObservation,
} from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
const LIMIT = Number(arg("limit") ?? 0) || 0;

const log = (...a: unknown[]) => console.log("[alias-backfill]", ...a);

/**
 * Successors whose ISIN CHANGED, which ISIN-grouping cannot recover.
 *
 * The Tata Motors demerger split one company into two securities. TMPV kept
 * INE155A01022 and is therefore derivable; TMCV is a NEW security with a NEW
 * ISIN, so the only thing linking it to TATAMOTORS is knowledge of the event.
 *
 * Keep this list SHORT and only for events of this shape — anything derivable
 * should be derived, so the code stays the source of truth.
 */
const SEED: ReadonlyArray<[string, string[]]> = [
  ["TMCV::NSE", ["TATAMOTORS"]],
  ["TMCV::BSE", ["TATAMOTORS"]],
];

/** Archive families that carry (symbol, ISIN) pairs. */
const SOURCES: ReadonlyArray<{
  prefix: string;
  exchange: "NSE" | "BSE";
  era: "legacy" | "udiff";
}> = [
  { prefix: "feeds/NSE/cm-legacy/", exchange: "NSE", era: "legacy" },
  { prefix: "feeds/NSE/bhavcopy/", exchange: "NSE", era: "udiff" },
  { prefix: "feeds/BSE/bhavcopy/", exchange: "BSE", era: "udiff" },
];

/** One file per calendar month — the first, by sorted key. */
function sampleMonthly(keys: readonly string[]): string[] {
  const byMonth = new Map<string, string>();
  for (const key of [...keys].sort()) {
    const d = dateFromArchiveKey(key);
    if (!d) continue;
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(month)) byMonth.set(month, key);
  }
  return [...byMonth.values()];
}

async function collectObservations(): Promise<SymbolObservation[]> {
  const out: SymbolObservation[] = [];
  let unreadable = 0;

  for (const src of SOURCES) {
    const all = (await listFiles(src.prefix)).filter((k) => !k.endsWith("/"));
    let sampled = sampleMonthly(all);
    if (LIMIT) sampled = sampled.slice(0, LIMIT);
    log(
      `${src.prefix}: ${all.length} archived -> ${sampled.length} sampled (1/month)`,
    );

    let withIsin = 0;
    for (const key of sampled) {
      const day = dateFromArchiveKey(key);
      if (!day) continue;
      try {
        const csv = decodeFeedText(await downloadFile(key));
        // The two parsers have DIFFERENT return shapes — the legacy one yields
        // { rows, droppedBySeries, withoutIsin }, the UDiFF one a bare
        // BhavcopyRow[]. feed-parse normalises the same way; keep them in step.
        const rows =
          src.era === "legacy"
            ? parseOldNseCmBhavcopy(csv, day).rows
            : parseUdiffBhavcopy(csv, src.exchange, day);
        for (const row of rows) {
          if (!row.isin) continue;
          withIsin++;
          out.push({
            isin: row.isin,
            symbol: row.symbol,
            exchange: row.exchange,
            date: day.getTime(),
          });
        }
      } catch (err) {
        unreadable++;
        log(`  unreadable ${key}: ${err instanceof Error ? err.message : err}`);
      }
    }
    log(`  -> ${withIsin.toLocaleString()} rows carried an ISIN`);
  }

  if (unreadable > 0) log(`WARNING: ${unreadable} file(s) could not be read`);
  return out;
}

async function main(): Promise<void> {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const observations = await collectObservations();
  log(`total observations: ${observations.length.toLocaleString()}`);
  if (observations.length === 0) {
    // A confident zero here almost always means the wrong bucket or missing
    // credentials, not an empty archive.
    log("ABORT: zero observations — check GCP_STORAGE_BUCKET and credentials.");
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const spans = buildSymbolSpans(observations);
  log(`ISIN x exchange groups: ${spans.size.toLocaleString()}`);

  // Current state of the master.
  const instruments = await prisma.instrumentMapping.findMany({
    where: { isActive: true, exchange: { in: ["NSE", "BSE"] } },
    select: { id: true, symbol: true, exchange: true, isin: true, previousSymbols: true },
  });
  const currentByGroup = new Map<string, string>();
  const activeByExchange = new Map<string, Set<string>>();
  const idBySymbolExchange = new Map<string, string>();
  const existingAliases = new Map<string, string[]>();
  for (const i of instruments) {
    if (i.isin) currentByGroup.set(aliasGroupKey(i.isin, i.exchange), i.symbol);
    const set = activeByExchange.get(i.exchange) ?? new Set<string>();
    set.add(i.symbol);
    activeByExchange.set(i.exchange, set);
    idBySymbolExchange.set(`${i.symbol}::${i.exchange}`, i.id);
    existingAliases.set(`${i.symbol}::${i.exchange}`, i.previousSymbols ?? []);
  }
  log(`active instruments: ${instruments.length.toLocaleString()}`);

  const decisions = decideAliases(spans, currentByGroup, activeByExchange);
  const merged = mergeWithSeed(decisions, new Map(SEED), activeByExchange);

  const rejectReasons = new Map<string, number>();
  for (const d of decisions)
    for (const r of d.rejected)
      rejectReasons.set(r.reason, (rejectReasons.get(r.reason) ?? 0) + 1);

  log(
    `instruments gaining aliases: ${merged.size.toLocaleString()} ` +
      `(derived ${decisions.filter((d) => d.aliases.length > 0).length}, seeded ${SEED.length})`,
  );
  log(
    "rejected candidates: " +
      ([...rejectReasons].map(([k, v]) => `${k}=${v}`).join(" ") || "none"),
  );

  const sample = [...merged].slice(0, 12);
  for (const [k, v] of sample) log(`   ${k.padEnd(22)} <- ${v.join(", ")}`);

  // Acceptance checks, stated as expectations rather than hopes.
  for (const [key, expect] of [
    ["ETERNAL::NSE", "ZOMATO"],
    ["TMPV::NSE", "TATAMOTORS"],
    ["TMCV::NSE", "TATAMOTORS"],
  ] as const) {
    const got = merged.get(key) ?? [];
    log(
      `check ${key.padEnd(16)} contains ${expect}: ${got.includes(expect) ? "YES" : `NO (got [${got.join(", ")}])`}`,
    );
  }

  if (!APPLY) {
    log("dry-run: pass --apply to write. Nothing changed.");
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  let unchanged = 0;
  for (const [key, aliases] of merged) {
    const id = idBySymbolExchange.get(key);
    if (!id) continue;
    const current = existingAliases.get(key) ?? [];
    const next = [...new Set([...current, ...aliases])].sort();
    if (next.length === current.length && next.every((v, i) => v === current[i])) {
      unchanged++;
      continue;
    }
    await prisma.instrumentMapping.update({
      where: { id },
      data: { previousSymbols: next },
    });
    written++;
  }

  log(`DONE: updated ${written}, already-correct ${unchanged}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[alias-backfill] failed:", err);
  process.exitCode = 1;
});
