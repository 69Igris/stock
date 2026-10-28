#!/usr/bin/env tsx
/**
 * Relabel US D1 candles filed under a listing whose window does not cover
 * them — MONEY-1617.
 *
 * Three writer defects left 62,769 bars under the wrong `listingId` (the lake
 * US replay refuses them as LISTING_MISMATCH): whole-ticker series stamped with
 * one id (CADE, WNS), bars Tiingo's master later SPLIT away into a new row (RAM,
 * VAL, INCR), and a one-day PHANTOM row taking a session (GAB 2026-09-21). The
 * writers are fixed (`clipBarsToListingWindows`); this repairs what they
 * already wrote, in BOTH stores — `candles` (Mongo) and the cold shards
 * `candles/US/D1/{symbol}/{year}` — using the rules in
 * `./relabel-us-candles-logic.ts`.
 *
 * ## SAFETY
 *
 *   - DRY RUN BY DEFAULT. It reads, plans, proves on the in-memory result that
 *     a second run plans nothing, prints the counts, and writes nothing.
 *   - Writing needs BOTH `--apply` (asks) AND `RELABEL_US_CANDLES_APPLY=true`
 *     (arms, compared to the literal string). `--apply` without the arm stays a
 *     dry run and says so. `--yes` is the non-interactive consent.
 *   - `--env=qa|prod` is REQUIRED; `pinJobEnv` resolves the URI and the client
 *     is built from it here. A dry run reads with `secondaryPreferred`.
 *   - BACKUP FIRST: every hot row it will change is copied to
 *     `candles_money1617_backup` and counted back; every shard it will rewrite
 *     is copied (at the generation read) under `backups/money-1617/{runId}/`
 *     and verified before the rewrite.
 *   - Writes are compare-and-set: a hot row only while it still carries the id
 *     and venue that were read; a shard only while its generation is unchanged.
 *   - A shard is rewritten in the FORMAT IT WAS READ IN (magic bytes), never
 *     `CANDLE_COLD_FORMAT`'s. A gzipped-JSONL shard with a line the decoder
 *     drops is REFUSED rather than rewritten one bar short.
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
 *   npx tsx scripts/data/relabel-us-candles.ts --env=prod
 *   npx tsx scripts/data/relabel-us-candles.ts --env=prod --symbols=RAM,GAB
 *   RELABEL_US_CANDLES_APPLY=true \
 *     npx tsx scripts/data/relabel-us-candles.ts --env=prod --apply --yes
 */
import { gunzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { Storage } from "@google-cloud/storage";
import {
  buildCandleColdKey,
  coldShardContentType,
  decodeColdShard,
  encodeColdShard,
  sniffColdShardFormat,
} from "@usemoney/core/market-data/candles/candle-logic";
import {
  buildListingIndex,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
import { mapWithConcurrency } from "@usemoney/core/market-data/databento/databento-harvest-logic";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { redactUri } from "@usemoney/core/ops/atlas-heatmap";
import { bucketForPrefix } from "@usemoney/core/ops/lake-layout";
import { planShardYears } from "@usemoney/lake/price-bar-logic";
import {
  backupVerified,
  consent,
  deleteOps,
  fmt as n,
  oid,
  updateOps,
  type RawDoc,
  type Run,
} from "./corporate-action-repair-io";
import {
  ARM_ENV,
  BACKUP_COLLECTION,
  SHARD_BACKUP_PREFIX,
  applyStorePlan,
  isArmed,
  planSize,
  planStore,
  type Move,
  type StoredBar,
  type StorePlan,
} from "./relabel-us-candles-logic";

const SCRIPT = "relabel-us-candles";
const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: ["apply", "yes"], valued: ["env", "symbols"], numeric: [] },
  SCRIPT,
);
const log = (...a: unknown[]): void => console.log(`[${SCRIPT}]`, ...a);

interface ShardWork {
  key: string;
  generation: string;
  format: "JSONL_GZ" | "PARQUET";
  bars: StoredBar[];
  plan: StorePlan;
}
interface SymbolWork {
  symbol: string;
  hot: StorePlan;
  /** Kept only when the hot plan changes something — for the re-plan proof. */
  hotBars: StoredBar[];
  shards: ShardWork[];
  shardsRefused: string[];
}

/** One tally line per class x store, so the report reconciles by construction. */
function tally(works: readonly SymbolWork[]): void {
  const t = new Map<string, number>();
  const bump = (k: string, by = 1): void => {
    t.set(k, (t.get(k) ?? 0) + by);
  };
  const symbols = new Set<string>();
  const months = new Set<string>();
  const hotMonths = new Set<string>();
  const coldMonths = new Set<string>();
  for (const w of works) {
    const stores: Array<[string, StorePlan]> = [
      ["hot", w.hot],
      ...w.shards.map((s): [string, StorePlan] => ["cold", s.plan]),
    ];
    for (const [store, p] of stores) {
      for (const m of p.moves) {
        bump(`MOVE ${m.cls}${m.venueChange ? " +venue" : ""} [${store}]`);
      }
      for (const m of p.removes) bump(`REMOVE identical duplicate [${store}]`);
      for (const [r, c] of Object.entries(p.left)) {
        if (c > 0) bump(`LEFT ${r} [${store}]`, c);
      }
      bump(`ok [${store}]`, p.ok);
      for (const m of [...p.moves, ...p.removes]) {
        symbols.add(w.symbol);
        const month = `US/${m.from.ts.toISOString().slice(0, 7)}`;
        months.add(month);
        if (store === "hot") hotMonths.add(month);
      }
    }
    // Every month a REWRITTEN shard has a bar in gets a new generation in its
    // lake source hash — not only the months whose bars changed.
    for (const sh of w.shards) {
      for (const b of sh.bars)
        coldMonths.add(`US/${b.ts.toISOString().slice(0, 7)}`);
    }
    for (const k of w.shardsRefused) bump(`SHARD REFUSED (lossy decode) ${k}`);
  }
  for (const [k, v] of [...t.entries()].sort())
    log(`  ${k.padEnd(44)} ${n(v)}`);
  log(`symbols touched (${n(symbols.size)}): ${[...symbols].sort().join(" ")}`);
  log(`lake months to reload (${months.size}): ${ranges(months)}`);
  // A rewritten shard gets a new GCS generation, so every month it feeds gets
  // a new lake source hash and reloads on its own. A HOT relabel changes no
  // generation and no max ts, so its month's hash is UNCHANGED and an
  // ACCEPTED month would be skipped. `lake-replay-us` has no force flag: run
  // this relabel BEFORE the `price-bar-v2` reload, which then picks these up.
  const hotOnly = new Set([...hotMonths].filter((m) => !coldMonths.has(m)));
  log(
    `  of which HOT-ONLY — hash unchanged; relabel BEFORE the price-bar-v2 reload so it picks them up (${hotOnly.size}): ` +
      ranges(hotOnly),
  );
}

/** Months as contiguous RANGES — a per-month list for CADE alone is 400 entries. */
function ranges(months: ReadonlySet<string>): string {
  const sorted = [...months].sort();
  const out: string[] = [];
  const next = (m: string): string => {
    const [y, mo] = m.slice(3).split("-").map(Number) as [number, number];
    return `US/${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}`;
  };
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === next(sorted[j]!)) j++;
    out.push(i === j ? sorted[i]! : `${sorted[i]}..${sorted[j]!.slice(3)}`);
    i = j;
  }
  return out.join(" ");
}

function examples(works: readonly SymbolWork[], symbols: string[]): void {
  for (const sym of symbols) {
    const w = works.find((x) => x.symbol === sym);
    if (!w) continue;
    const all: Array<[string, Move]> = [
      ...w.hot.moves.map((m): [string, Move] => ["hot", m]),
      ...w.hot.removes.map((m): [string, Move] => ["hot-dup", m]),
      ...w.shards.flatMap((s) => [
        ...s.plan.moves.map((m): [string, Move] => ["cold", m]),
        ...s.plan.removes.map((m): [string, Move] => ["cold-dup", m]),
      ]),
    ];
    const byPair = new Map<string, string[]>();
    for (const [store, m] of all) {
      const k = `${store} ${m.from.listingId} -> ${m.listingId} (${m.cls})`;
      (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(
        m.from.ts.toISOString().slice(0, 10),
      );
    }
    for (const [k, days] of byPair) {
      days.sort();
      log(
        `  ${sym}: ${k} ${days.length} session(s) ${days[0]}..${days.at(-1)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const env = ARGS.value("env");
  if (env !== "qa" && env !== "prod") {
    console.error(`[${SCRIPT}] --env=qa|prod is required`);
    process.exit(1);
  }
  const wantApply = ARGS.has("apply");
  const apply = wantApply && isArmed();
  if (wantApply && !apply) {
    log(`--apply without ${ARM_ENV}=true — continuing as a DRY RUN.`);
  }
  const { databaseUrl } = pinJobEnv(env);
  // A dry run reads a secondary; an apply reads what it will compare-and-set.
  const url = apply
    ? databaseUrl
    : `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}readPreference=secondaryPreferred`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const run: Run = (c) => prisma.$runCommandRaw(c as never) as Promise<RawDoc>;
  const bucket = new Storage().bucket(bucketForPrefix("candles/", env));
  const target = `${redactUri(databaseUrl)} + gs://${bucket.name}`;
  log(`env=${env} ${apply ? "APPLY" : "DRY RUN"} target=${target}`);

  const master: ListingRow[] = await prisma.usInstrument.findMany({
    where: { assetType: { in: ["Stock", "ETF"] } },
    select: {
      symbol: true,
      exchange: true,
      listingId: true,
      listingStartDate: true,
      listingEndDate: true,
      listingStatus: true,
    },
  });
  const index = buildListingIndex(master);
  const only = ARGS.value("symbols")
    ?.split(",")
    .map((s) => s.trim());
  // A single-window symbol cannot hold a MISMATCH the master resolves to a
  // different id, so the walk is the multi-window symbols (1,067 on prod).
  const symbols =
    only ?? [...index.keys()].filter((s) => index.get(s)!.length > 1);
  log(
    `master ${n(master.length)} windows; walking ${n(symbols.length)} symbol(s)`,
  );
  const currentYear = new Date().getUTCFullYear();

  let done = 0;
  const works = await mapWithConcurrency(symbols, 16, async (symbol) => {
    const windows = index.get(symbol) ?? [];
    const hotRows = await prisma.candle.findMany({
      where: { symbol, timeframe: "D1" },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        timeframe: true,
        ts: true,
        listingId: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        divCash: true,
        splitFactor: true,
        source: true,
      },
    });
    const hotBars: StoredBar[] = hotRows.map((r) => ({
      ...r,
      volume: Number(r.volume),
    }));
    const hot = planStore(hotBars, windows);
    const work: SymbolWork = {
      symbol,
      hot,
      hotBars: planSize(hot) > 0 ? hotBars : [],
      shards: [],
      shardsRefused: [],
    };
    const years = new Set<number>();
    for (const w of windows) {
      for (const y of planShardYears({
        listingStartYear: w.listingStartDate?.getUTCFullYear() ?? 0,
        listingEndYear: w.listingEndDate?.getUTCFullYear() ?? null,
        currentYear,
      })) {
        years.add(y);
      }
    }
    for (const year of [...years].sort()) {
      let key: string;
      try {
        key = buildCandleColdKey({
          market: "US",
          timeframe: "D1",
          symbol,
          year,
        });
      } catch {
        continue;
      }
      const file = bucket.file(key);
      let body: Buffer;
      let generation: string;
      try {
        const [meta] = await file.getMetadata();
        generation = String(meta.generation);
        [body] = await bucket.file(key, { generation }).download();
      } catch (e) {
        if ((e as { code?: number }).code === 404) continue;
        throw e;
      }
      const format = sniffColdShardFormat(body);
      if (format === "UNKNOWN") {
        work.shardsRefused.push(key);
        continue;
      }
      const bars: StoredBar[] = await decodeColdShard(body);
      const plan = planStore(bars, windows);
      if (planSize(plan) === 0) continue;
      if (format === "JSONL_GZ") {
        const lines = gunzipSync(body)
          .toString("utf8")
          .split("\n")
          .filter((l) => l.trim() !== "").length;
        if (lines !== bars.length) {
          work.shardsRefused.push(key);
          continue;
        }
      }
      work.shards.push({ key, generation, format, bars, plan });
    }
    if (++done % 100 === 0) log(`  … ${done}/${symbols.length}`);
    return work;
  });

  // IDEMPOTENCY, proven on the in-memory result before anything is written.
  for (const w of works) {
    const idx = index.get(w.symbol) ?? [];
    const again = [
      planStore(applyStorePlan(w.hotBars, w.hot), idx),
      ...w.shards.map((s) => planStore(applyStorePlan(s.bars, s.plan), idx)),
    ];
    const left = again.reduce((a, p) => a + planSize(p), 0);
    if (left > 0) {
      throw new Error(
        `${w.symbol}: a second run would still change ${left} bar(s) — refusing a plan that does not converge.`,
      );
    }
  }
  log("idempotency: re-planning the simulated result finds nothing to do");

  tally(works);
  examples(works, ["RAM", "GAB", "DSPC", "CADE", "VAL", "OKE"]);

  const hotMoves = works.flatMap((w) => w.hot.moves);
  const hotRemoves = works.flatMap((w) => w.hot.removes);
  const shards = works.flatMap((w) => w.shards);
  log(
    `writes: hot ${n(hotMoves.length)} relabel + ${n(hotRemoves.length)} remove; ` +
      `cold ${n(shards.length)} shard rewrite(s)`,
  );
  if (!apply) {
    log(
      `DRY RUN — nothing written. Arm with ${ARM_ENV}=true and pass --apply.`,
    );
    await prisma.$disconnect();
    return;
  }
  await consent(
    ARGS,
    target,
    `relabel ${n(hotMoves.length)} + remove ${n(hotRemoves.length)} candles, rewrite ${n(shards.length)} shards`,
  );

  // ── Mongo: backup (counted back), then compare-and-set ─────────────────
  const touched = [...hotMoves, ...hotRemoves].map((m) => m.from.id!);
  const backup: Array<{ id: string; role: string; doc: RawDoc }> = [];
  for (let i = 0; i < touched.length; i += 500) {
    const res = await run({
      find: "candles",
      filter: { _id: { $in: touched.slice(i, i + 500).map(oid) } },
      batchSize: 500,
      singleBatch: true,
    });
    for (const doc of (res.cursor as { firstBatch: RawDoc[] }).firstBatch) {
      backup.push({
        id: (doc._id as { $oid: string }).$oid,
        role: "candle",
        doc,
      });
    }
  }
  const held = await backupVerified(run, BACKUP_COLLECTION, backup);
  log(`backup: ${n(held)} candles in ${BACKUP_COLLECTION}, verified`);
  const expect = (m: Move): RawDoc => ({
    listingId: m.from.listingId,
    exchange: m.from.exchange,
  });
  await deleteOps(
    run,
    "candles",
    hotRemoves.map((m) => ({ id: m.from.id!, expect: expect(m), set: {} })),
    "remove identical duplicates",
  );
  await updateOps(
    run,
    "candles",
    hotMoves.map((m) => ({
      id: m.from.id!,
      expect: expect(m),
      set: { listingId: m.listingId, exchange: m.exchange },
    })),
    "relabel",
  );
  log(`hot: removed ${n(hotRemoves.length)}, relabelled ${n(hotMoves.length)}`);

  // ── GCS: backup at the read generation, verify, rewrite if unchanged ────
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  for (const s of shards) {
    const backupKey = `${SHARD_BACKUP_PREFIX}/${runId}/${s.key}`;
    await bucket
      .file(s.key, { generation: s.generation })
      .copy(bucket.file(backupKey));
    const [exists] = await bucket.file(backupKey).exists();
    if (!exists)
      throw new Error(
        `backup ${backupKey} not found after copy — nothing rewritten for ${s.key}`,
      );
    const body = await encodeColdShard(
      applyStorePlan(s.bars, s.plan),
      s.format,
    );
    await bucket.file(s.key).save(body, {
      contentType: coldShardContentType(s.format),
      resumable: false,
      preconditionOpts: { ifGenerationMatch: Number(s.generation) },
    });
  }
  log(
    `cold: ${n(shards.length)} shard(s) rewritten; originals under ${SHARD_BACKUP_PREFIX}/${runId}/`,
  );
  log("the cold-shard read cache (6h TTL) clears itself; nothing else to do.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(
    `[${SCRIPT}]`,
    String(err instanceof Error ? err.message : err).replace(
      /mongodb(\+srv)?:\/\/\S+/g,
      "<uri>",
    ),
  );
  process.exit(1);
});
