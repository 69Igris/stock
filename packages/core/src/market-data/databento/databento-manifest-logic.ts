/**
 * The harvest/append MANIFEST — MONEY-1373.
 *
 * `scripts/data/databento-manifest.json` is the versioned statement of what we
 * buy: which dataset, which schemas, which symbols, over which ranges, and
 * which of them become `Candle` rows rather than archive-only bytes. Both jobs
 * read it and nothing else decides those questions, so a change to the purchase
 * is a reviewable diff rather than an argument to a command nobody kept.
 *
 * ## The schema enum is the structural half of "no 1d harvest"
 *
 * `ohlcv-1d` is absent from `DATABENTO_SCHEMAS`, so a manifest entry naming it
 * fails validation before a quote is ever requested. Tiingo owns the daily
 * series; the displacement rule refuses a `D1` write at run time, and this
 * refuses it at edit time. Two guards, because the first one costs a failed job
 * and the second costs a failed test.
 */

import { z } from "zod";

import {
  DATABENTO_SCHEMAS,
  DATABENTO_MAX_SYMBOLS_PER_REQUEST,
  EQUS_MINI_HISTORY_FLOOR,
  isLoadableSchema,
} from "./databento-logic";
import {
  isUsTradingDay,
  lastCompletedUsSession,
  usMarketDayBoundsUtc,
} from "../us-market-hours";

/* ─────────────────────────────────────────────────────────────────────────
   Shape
   ──────────────────────────────────────────────────────────────────────── */

/** `historyFloor`, a trailing window, or an explicit ET calendar date. */
const rangeStart = z.union([
  z.literal("historyFloor"),
  z.literal("trailing-12mo"),
  z.literal("trailing-3mo"),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
]);
const rangeEnd = z.union([
  z.literal("latest"),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
]);

export const manifestEntrySchema = z
  .object({
    id: z.string().min(1),
    schema: z.enum(DATABENTO_SCHEMAS),
    symbolSets: z.array(z.string().min(1)).min(1),
    start: rangeStart,
    end: rangeEnd,
    /** Do these records become `Candle` rows? */
    load: z.boolean(),
    splitSymbols: z.boolean(),
    splitDuration: z.enum(["day", "week", "month", "year", "none"]),
    /** Does the daily append keep this entry current? */
    append: z.boolean(),
    /** Order the harvest submits entries in. Unique across the manifest. */
    order: z.number().int().positive(),
    /**
     * A DIFFERENT dataset for this one entry. Absent = the manifest's.
     *
     * Measured 2026-09-07 against the vendor: a schema is not a property of
     * the account, it is a property of the DATASET. `EQUS.MINI` carries
     * `[mbp-1, tbbo, trades, bbo-1s, bbo-1m, ohlcv-1s/1m/1h/1d, definition]`
     * and NOT `statistics`; `EQUS.SUMMARY` carries
     * `[ohlcv-1d, definition, statistics]`. A manifest with one dataset field
     * therefore could not express `statistics` at all, and the entry that
     * asked for it was answered 422 `dataset_schema_not_supported` — at QUOTE
     * time, so it failed before it could spend, but it also could never
     * succeed.
     *
     * Each dataset has its OWN available range: EQUS.MINI starts 2023-03-28,
     * EQUS.SUMMARY 2024-07-01. An entry that overrides the dataset must
     * therefore carry an explicit `start` rather than `historyFloor`, which is
     * the MANIFEST's floor — asking earlier is 422
     * `data_start_before_available_start`. Enforced below.
     */
    dataset: z.string().min(1).optional(),
    consumer: z.string().optional(),
    note: z.string().optional(),
  })
  .refine((e) => !e.load || isLoadableSchema(e.schema), {
    message:
      "load:true is only valid for a schema that produces bars (ohlcv-1m, " +
      "ohlcv-1h). bbo-1m and tbbo are quote/trade records the cost model reads " +
      "from the archive, and ohlcv-1s is archive-only by founder decision.",
  })
  .refine((e) => !(e.splitSymbols && e.symbolSets.includes("ALL_SYMBOLS")), {
    message: "split_symbols cannot be combined with ALL_SYMBOLS",
  })
  // REFUSED AT EDIT TIME, because the failure lands AFTER the money is spent.
  //
  // `split_symbols` with a day or week split multiplies the file count by the
  // symbol count, and every file becomes a `files[]` entry on ONE ledger
  // document. Measured on the first real harvest: 253,341 B for 867 entries =
  // 292 B each. BASELINE at a daily split is 507 symbols x 868 sessions =
  // 440,076 entries ~= 128 MB, well past MongoDB's 16 MB per-document cap — so
  // `replaceFileRecords` throws on a job the vendor has already been paid for,
  // and the ledger row cannot record what was bought.
  //
  // Month and year are fine at this scale: `ohlcv-1s` at a monthly split is
  // 507 x 42 = 21,294 entries ~= 6.2 MB.
  .refine(
    (e) =>
      !(
        e.splitSymbols &&
        (e.splitDuration === "day" || e.splitDuration === "week")
      ),
    {
      message:
        "split_symbols with a day or week split produces one files[] entry " +
        "per symbol-session — ~128 MB of inventory for a 507-symbol year, " +
        "past MongoDB's 16 MB document cap. Use month or year.",
    },
  )
  .refine((e) => e.dataset === undefined || e.start !== "historyFloor", {
    message:
      "an entry that overrides `dataset` must carry an explicit `start`. " +
      "`historyFloor` is the MANIFEST dataset's floor, and every dataset has " +
      "its own: EQUS.MINI begins 2023-03-28 and EQUS.SUMMARY 2024-07-01, so " +
      "the manifest's floor asks the other dataset for data it does not have " +
      "and is answered 422 data_start_before_available_start.",
  });

export const manifestSchema = z
  .object({
    version: z.number().int().positive(),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dataset: z.string().min(1),
    historyFloor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    symbolSets: z.record(
      z.string(),
      z.union([z.array(z.string()), z.string()]),
    ),
    entries: z.array(manifestEntrySchema).min(1),
  })
  .refine(
    (m) => new Set(m.entries.map((e) => e.order)).size === m.entries.length,
    {
      message: "entry `order` values must be unique — they decide submit order",
    },
  )
  .refine(
    (m) => new Set(m.entries.map((e) => e.id)).size === m.entries.length,
    {
      message: "entry `id` values must be unique — they key the inventory",
    },
  )
  .refine(
    (m) =>
      m.historyFloor >= EQUS_MINI_HISTORY_FLOOR || m.dataset !== "EQUS.MINI",
    {
      message:
        `EQUS.MINI carries nothing before ${EQUS_MINI_HISTORY_FLOOR}. A floor ` +
        "earlier than that asks for data the dataset does not have, and the " +
        "empty result is indistinguishable from a market holiday.",
    },
  );

export type DatabentoManifest = z.infer<typeof manifestSchema>;
export type DatabentoManifestEntry = z.infer<typeof manifestEntrySchema>;

export function parseManifest(json: unknown): DatabentoManifest {
  return manifestSchema.parse(json);
}

/**
 * The dataset this entry is bought from.
 *
 * One place, because the fallback is easy to forget at a call site and the
 * consequence is silent: a submission that names the manifest's dataset for an
 * entry that overrode it buys the wrong thing under the right id, and the
 * ledger row records the wrong provenance for a purchase that cannot be undone.
 */
export function datasetForEntry(
  entry: Pick<DatabentoManifestEntry, "dataset">,
  manifest: Pick<DatabentoManifest, "dataset">,
): string {
  return entry.dataset ?? manifest.dataset;
}

/* ─────────────────────────────────────────────────────────────────────────
   Ranges
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The entries in SUBMIT ORDER.
 *
 * `order` is a per-entry integer rather than the array position, so an editor
 * can reorder the file without renumbering it and a diff shows the intent. The
 * schema already refuses duplicate values; sorting here is what makes that
 * uniqueness mean something to a reader.
 *
 * The order is load-bearing: the last entry is the TB-scale `ohlcv-1s` archive,
 * and a harvest that walked entries in file order could reach it before the
 * cheap ones it gates on.
 */
export function orderedEntries(
  manifest: DatabentoManifest,
): DatabentoManifestEntry[] {
  return [...manifest.entries].sort((a, b) => a.order - b.order);
}

/** The entry ids in submit order — what the scope guard prints. */
export function orderedEntryIds(manifest: DatabentoManifest): string[] {
  return orderedEntries(manifest).map((e) => e.id);
}

export interface ResolvedRange {
  /** Inclusive. */
  startMs: number;
  /** EXCLUSIVE — Databento's own convention. */
  endMsExclusive: number;
}

const DAY_MS = 86_400_000;

/** Step forward to the next US trading day, bounded. */
function nextTradingDateKey(dateKey: string): string {
  let key = dateKey;
  for (let i = 0; i < 10; i++) {
    if (isUsTradingDay(key)) return key;
    const ms = Date.parse(`${key}T00:00:00Z`) + DAY_MS;
    key = new Date(ms).toISOString().slice(0, 10);
  }
  throw new RangeError(
    `nextTradingDateKey: no trading day within 10 of ${dateKey}`,
  );
}

/**
 * A manifest entry's window, as instants.
 *
 * `end` is clamped to what the VENDOR says it holds when that is known. The
 * append gates on the same fact, but the harvest benefits too: asking for a
 * session past the T+1 embargo returns an empty result, and an empty result is
 * indistinguishable from a market holiday or a broken query.
 */
export function resolveEntryRange(
  entry: Pick<DatabentoManifestEntry, "start" | "end">,
  args: { now: Date; historyFloor: string; datasetRangeEndMs?: number },
): ResolvedRange {
  const endKey =
    entry.end === "latest" ? lastCompletedUsSession(args.now) : entry.end;
  let endMsExclusive = usMarketDayBoundsUtc(endKey).endMs;
  if (
    typeof args.datasetRangeEndMs === "number" &&
    Number.isFinite(args.datasetRangeEndMs)
  ) {
    endMsExclusive = Math.min(endMsExclusive, args.datasetRangeEndMs);
  }

  let startKey: string;
  if (entry.start === "historyFloor") {
    startKey = args.historyFloor;
  } else if (
    entry.start === "trailing-12mo" ||
    entry.start === "trailing-3mo"
  ) {
    const days = entry.start === "trailing-12mo" ? 365 : 92;
    const raw = new Date(endMsExclusive - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    startKey = nextTradingDateKey(raw);
  } else {
    startKey = entry.start;
  }
  if (startKey < args.historyFloor) startKey = args.historyFloor;

  const startMs = usMarketDayBoundsUtc(startKey).startMs;
  if (startMs >= endMsExclusive) {
    throw new RangeError(
      `resolveEntryRange: ${startKey}..${endKey} is empty. A zero-width window ` +
        "would submit a job that costs money and returns nothing.",
    );
  }
  return { startMs, endMsExclusive };
}

/* ─────────────────────────────────────────────────────────────────────────
   Symbol sets
   ──────────────────────────────────────────────────────────────────────── */

/** Split a symbol list into request-sized chunks. */
export function chunkSymbols(
  symbols: readonly string[],
  size: number = DATABENTO_MAX_SYMBOLS_PER_REQUEST,
): string[][] {
  if (size < 1) throw new RangeError("chunkSymbols: size must be >= 1");
  const out: string[][] = [];
  for (let i = 0; i < symbols.length; i += size) {
    out.push([...symbols.slice(i, i + size)]);
  }
  return out;
}

/**
 * The symbols an entry covers, deduped and sorted.
 *
 * A LITERAL set comes straight from the manifest. `MASTER` is resolved at run
 * time from `us_instruments` by the caller and handed in through
 * `resolveMaster`, because a fourteen-thousand-symbol list checked into a JSON
 * file would be a second copy of a table that already exists — and one that
 * goes stale on every listing.
 *
 * Sorted so `symbolsHash` is stable: the hash is the idempotency key for a
 * purchase, and a set that hashed differently depending on iteration order
 * would buy the same window twice.
 */
export async function resolveSymbolSet(args: {
  names: readonly string[];
  manifest: DatabentoManifest;
  resolveMaster: () => Promise<string[]>;
}): Promise<string[]> {
  const out = new Set<string>();
  for (const name of args.names) {
    const declared = args.manifest.symbolSets[name];
    if (Array.isArray(declared)) {
      for (const s of declared) out.add(s.trim().toUpperCase());
      continue;
    }
    if (name === "MASTER") {
      for (const s of await args.resolveMaster())
        out.add(s.trim().toUpperCase());
      continue;
    }
    throw new RangeError(
      `resolveSymbolSet: symbol set "${name}" is not declared in the manifest ` +
        "and is not MASTER. Refusing rather than submitting an empty request.",
    );
  }
  if (out.size === 0) {
    throw new RangeError(
      `resolveSymbolSet: ${args.names.join(", ")} resolved to zero symbols. A ` +
        "job over no symbols costs a request and returns nothing, and reads as " +
        "a quiet market rather than a broken list.",
    );
  }
  return [...out].sort();
}

/**
 * The idempotency key for a purchase.
 *
 * A synchronous FNV-1a rather than `node:crypto`, so this module stays free of
 * Node built-ins and can be imported anywhere. Collision resistance is not the
 * property needed: the hash is one component of a compound key that already
 * carries purpose, entry, schema and both bounds — it exists to notice that the
 * SYMBOL LIST changed, not to be unforgeable.
 */
export function symbolsHash(symbols: readonly string[]): string {
  const text = [...symbols].sort().join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${symbols.length}-${h.toString(16).padStart(8, "0")}`;
}
