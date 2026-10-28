/**
 * One-off repair — MONEY-1100 postmortem: collapse the noon-dated DailyPrice
 * fork back onto the midnight date-series.
 *
 * ## What happened
 *
 * `dateFromArchiveKey` returns UTC NOON by design (the walk's parseDay
 * convention keeps +5:30 from crossing a day). Every price parser
 * re-normalizes to the IST trading day's UTC midnight — but the P4.1 delivery
 * writers stamped and queried with the raw noon value. Result: 3,237,416
 * DailyPrice rows created at T12:00:00Z — a parallel series 12 hours away
 * from every legitimate row — and a BSE delivery pass that matched ZERO price
 * rows across 15.9M parsed, because noon lookups can never hit midnight rows.
 *
 * ## Why PER-DATE + BULK (v4; the first three died of round-trip latency)
 *
 *   v1 walked noon rows by _id and repaired each with per-row round trips:
 *   ~33 rows/s ⇒ 27 hours.
 *   v2 batched the twin lookup as instrumentIds×dates IN-lists, assuming an
 *   _id-ordered batch spans few dates. False: the delivery runs upserted
 *   concurrently, so _id order interleaves dates and the IN×IN exploded into
 *   minutes per batch.
 *   v3 went per-date (indexed reads both sides) but kept per-row Prisma
 *   updates for the merges. The Atlas cluster is a long RTT away, Prisma is
 *   one round trip per op, and "150 concurrent" collapses onto the driver
 *   pool: ~13 merges/s ⇒ 58 hours. CPU sat at 2% — pure network wait.
 *
 *   Per-DATE, both sides of the join are single INDEXED range reads
 *   (`@@index([date])`), and every WRITE is one bulk command per day: one
 *   `update` with N statements for the merges, one `delete` for the merged
 *   noon rows, one multi-`update` shifting the twinless rest. ~4 round trips
 *   per day instead of ~1,800.
 *
 * ## BigInt under a raw bulk write — why this does not break the schema rule
 *
 * The schema's rule is "BigInt writes go through Prisma, never raw $set",
 * because a raw JSON number lands as a DOUBLE and poisons every later read.
 * The merge statements here are aggregation-PIPELINE updates using explicit
 * type operators — `$toLong` for `deliveryQty` (value carried as a string),
 * `$toInt` for `trades` — which store true int64/int32, which is the rule's
 * entire rationale. The run FAILS LOUD if the invariant slips: the final
 * summary counts `deliveryQty: {$type:"double"}` across BHAVCOPY_HIST and
 * exits 1 unless it is zero.
 *
 * ## Per noon day
 *
 *   twin at midnight  → MERGE: pipeline-$set the noon row's non-null delivery
 *                       fields onto the twin ($ifNull-free — a null noon value
 *                       is simply omitted so it can never erase twin data);
 *                       rows with nothing to contribute are deleted without an
 *                       update. Then one bulk delete of the day's merged rows.
 *   no twin           → SHIFT: one raw multi-update moving `date` noon →
 *                       midnight. Only `date` is written. Safe against
 *                       `@@unique([instrumentId, date])`: twins were removed
 *                       first, and any miscount dup-keys and aborts rather
 *                       than corrupting.
 *
 * The single non-indexed operation left is the date ENUMERATION (one
 * `distinct` over BHAVCOPY_HIST). DRY-RUN by default; --apply to write.
 * Idempotent: re-runs find fewer (finally zero) noon dates.
 *
 * Usage:
 *   node --import tsx scripts/migrations/fix-noon-dated-daily-prices.ts          # count + day list only
 *   node --import tsx scripts/migrations/fix-noon-dated-daily-prices.ts --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";

const APPLY = process.argv.includes("--apply");

const log = (...a: unknown[]) => console.log("[fix-noon-dates]", ...a);

function midnightOf(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** Every distinct BHAVCOPY_HIST date whose time-of-day is noon. */
async function noonDates(): Promise<Date[]> {
  const res = (await prisma.$runCommandRaw({
    distinct: "daily_prices",
    key: "date",
    query: { source: "BHAVCOPY_HIST" },
  })) as { values?: Array<{ $date: string } | string> };
  const dates = (res.values ?? [])
    .map((v) => (typeof v === "string" ? new Date(v) : new Date(v.$date)))
    .filter((d) => d.getUTCHours() === 12);
  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates;
}

interface DayTally {
  merged: number;
  shifted: number;
  failed: number;
}

async function repairDay(noonDate: Date): Promise<DayTally> {
  const midDate = midnightOf(noonDate);

  // Both reads ride @@index([date]).
  const noonRows = await prisma.dailyPrice.findMany({
    where: { date: noonDate, source: "BHAVCOPY_HIST" },
    select: {
      id: true,
      instrumentId: true,
      deliveryQty: true,
      deliveryPct: true,
      avgPrice: true,
      trades: true,
    },
  });
  if (noonRows.length === 0) return { merged: 0, shifted: 0, failed: 0 };

  const midRows = await prisma.dailyPrice.findMany({
    where: { date: midDate },
    select: { id: true, instrumentId: true },
  });
  const twinByInstrument = new Map(midRows.map((r) => [r.instrumentId, r.id]));

  const mergeCases = noonRows.filter((r) =>
    twinByInstrument.has(r.instrumentId),
  );

  let failed = 0;
  const deletableIds: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  for (const row of mergeCases) {
    // Only non-null noon values are set, so a null can never erase twin
    // data. Explicit type operators keep BigInt/Int honest through raw —
    // see the header. All-null rows contribute nothing: delete-only.
    const set: Record<string, unknown> = {};
    if (row.deliveryQty !== null)
      set.deliveryQty = { $toLong: row.deliveryQty.toString() };
    if (row.deliveryPct !== null) set.deliveryPct = row.deliveryPct;
    if (row.avgPrice !== null) set.avgPrice = row.avgPrice;
    if (row.trades !== null) set.trades = { $toInt: row.trades };
    if (Object.keys(set).length > 0) {
      updates.push({
        q: { _id: { $oid: twinByInstrument.get(row.instrumentId)! } },
        u: [{ $set: set }],
        multi: false,
      });
    }
    deletableIds.push(row.id);
  }

  if (updates.length > 0) {
    // One round trip for the whole day's merges.
    const res = (await prisma.$runCommandRaw({
      update: "daily_prices",
      updates,
      ordered: false,
    })) as { nModified?: number; writeErrors?: Array<{ index?: number }> };
    if (res.writeErrors && res.writeErrors.length > 0) {
      failed += res.writeErrors.length;
      // Failed statements must NOT have their noon rows deleted — drop those
      // ids from the deletable set so the data survives for a re-run.
      const failedTwinIds = new Set(
        res.writeErrors
          .map((e) => updates[e.index ?? -1])
          .filter(Boolean)
          .map((u) => ((u as { q: { _id: { $oid: string } } }).q._id.$oid)),
      );
      const failedInstrumentIds = new Set(
        [...twinByInstrument.entries()]
          .filter(([, twinId]) => failedTwinIds.has(twinId))
          .map(([instrumentId]) => instrumentId),
      );
      const keep = mergeCases
        .filter((r) => failedInstrumentIds.has(r.instrumentId))
        .map((r) => r.id);
      const keepSet = new Set(keep);
      for (let i = deletableIds.length - 1; i >= 0; i--) {
        if (keepSet.has(deletableIds[i]!)) deletableIds.splice(i, 1);
      }
      log(
        `merge ${noonDate.toISOString().slice(0, 10)}: ${res.writeErrors.length} statements failed — their noon rows kept`,
      );
    }
  }

  if (deletableIds.length > 0) {
    await prisma.$runCommandRaw({
      delete: "daily_prices",
      deletes: [
        {
          q: { _id: { $in: deletableIds.map((id) => ({ $oid: id })) } },
          limit: 0,
        },
      ],
    });
  }

  // Everything still noon-dated on this day is twinless — shift in place.
  // Raw multi-update writes only `date`; the compound unique is the net under
  // any miscount (a surviving twin dup-keys and aborts instead of corrupting).
  const res = (await prisma.$runCommandRaw({
    update: "daily_prices",
    updates: [
      {
        q: { date: { $date: noonDate.toISOString() }, source: "BHAVCOPY_HIST" },
        u: [{ $set: { date: { $date: midDate.toISOString() } } }],
        multi: true,
      },
    ],
  })) as { nModified?: number; writeErrors?: unknown[] };
  if (res.writeErrors && res.writeErrors.length > 0) {
    failed++;
    log(
      `shift ${noonDate.toISOString()}: ${JSON.stringify(res.writeErrors).slice(0, 300)}`,
    );
  }

  return {
    merged: deletableIds.length,
    shifted: res.nModified ?? 0,
    failed,
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const days = await noonDates();
  const total = days.length;
  log(
    `noon-dated BHAVCOPY_HIST days: ${total} — mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  if (!APPLY) {
    log(
      `dry-run: first/last noon days: ${days[0]?.toISOString() ?? "-"} .. ${days[total - 1]?.toISOString() ?? "-"}. Nothing written.`,
    );
    await prisma.$disconnect();
    return;
  }

  let merged = 0;
  let shifted = 0;
  let failed = 0;
  let done = 0;
  for (const day of days) {
    const t = await repairDay(day);
    merged += t.merged;
    shifted += t.shifted;
    failed += t.failed;
    done++;
    if (done % 50 === 0 || t.failed > 0) {
      const rate = done / ((Date.now() - started) / 60000);
      log(
        `progress: days=${done}/${total} merged=${merged} shifted=${shifted} failed=${failed} (${rate.toFixed(1)} days/min)`,
      );
    }
  }

  const remaining = (
    (await prisma.$runCommandRaw({
      count: "daily_prices",
      query: {
        source: "BHAVCOPY_HIST",
        $expr: { $eq: [{ $hour: "$date" }, 12] },
      },
    })) as { n?: number }
  ).n;
  // The BigInt invariant the raw bulk write must not have broken: a single
  // double-typed deliveryQty poisons later Prisma reads, so zero is the only
  // acceptable count. $toLong is the mechanism; this is the proof.
  const doubleQty = (
    (await prisma.$runCommandRaw({
      count: "daily_prices",
      query: { source: "BHAVCOPY_HIST", deliveryQty: { $type: "double" } },
    })) as { n?: number }
  ).n;
  log(
    `DONE: days=${done} merged=${merged} shifted=${shifted} failed=${failed} ` +
      `remaining=${remaining} deliveryQty-doubles=${doubleQty}`,
  );
  if (failed > 0 || (remaining ?? 0) > 0 || (doubleQty ?? 0) > 0)
    process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fix-noon-dates] failed:", err);
  process.exitCode = 1;
});
