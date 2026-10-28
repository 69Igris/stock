/**
 * The pure decisions behind `scripts/data/reanchor-corporate-action-dates.ts` —
 * MONEY-1530.
 *
 * ## What is wrong with the stored dates
 *
 * `exDate` and `recordDate` are CALENDAR DAYS, and the parser that produced most
 * of them resolved NSE's `"08-Sep-2026"` / BSE's `"01 Sep 2026"` in the
 * process's LOCAL time. Measured on prod `corporate_actions` 2026-09-23:
 *
 *     exDate      18:30Z  48,224   a laptop in IST, the 2026-08-12/13 backfill
 *                 00:00Z  11,000   Cloud Run (UTC), the nightly
 *     recordDate  18:30Z  33,735 · 00:00Z 10,809 · null 14,524 · absent 156
 *
 * No other time of day exists, and no row mixes the two. So the rule is exact
 * for every stored value: UTC midnight of the IST calendar day the instant
 * falls on — 18:30Z moves forward 5h30m, 00:00Z stays put.
 *
 * ## Why it has to DEDUPE, not just rewrite
 *
 * `@@unique([symbol, exchange, type, exDate])` keyed the two anchors apart, so
 * the backfill never found the nightly's row for the same event and wrote a
 * second one: 1,772 pairs (1,650 DIVIDEND, 31 BUYBACK, 30 BONUS, 28 SPLIT, 20
 * RIGHTS, 8 DEMERGER, 5 MERGER). Rewriting only the 18:30Z row would collide on
 * the index. One row per event survives, chosen by:
 *
 *   1. SOURCE AUTHORITY — `price-adjust.ts`'s `SOURCE_RANK`, where a `+`-joined
 *      composite scores its best token. It is asked through `dedupeActions`
 *      rather than copied: see {@link outranks}.
 *   2. RICHER DATA — more populated fields.
 *   3. LATER `updatedAt` — the more recent confirmation.
 *   4. LATER `_id` — so the choice is total, never an input-order accident.
 *
 * Authority ties in all 1,772 on prod (every pair is one exchange writing the
 * same event twice). 1,000 are decided by richness — the nightly row carries
 * `isin` (980) or `gcsPath` (53) that the backfill row lacks — and 772 by
 * `updatedAt`.
 *
 * ## The losing row is merged in, never just dropped
 *
 * A survivor's EMPTY fields are filled from its losers — the same "incoming
 * only fills nulls, sources are unioned" rule `mergeCorporateActions` applies
 * when two feeds describe one event, so the result is what one correctly
 * anchored history would have held. `createdAt` keeps the EARLIEST of the group:
 * the lake reads it as `published_at`, and the event was known from the first
 * row, not the second. Where both rows hold DIFFERENT non-null values the
 * survivor's is kept and the pair is reported as a CONFLICT; the loser is in the
 * backup either way.
 *
 * ## Refusal, not guessing
 *
 * A date at any time of day OTHER than the two measured anchors is not
 * something this rule understands: a process in Tokyo would have written 15:00Z
 * the day BEFORE, and "UTC midnight of its IST day" would keep that wrong day.
 * Such a row — and every row sharing its event key — is left untouched and
 * reported, never rewritten.
 */
import { dedupeActions } from "../../packages/core/src/market-data/price-adjust";

/** Every document this migration writes or deletes is copied here first. */
export const BACKUP_COLLECTION = "corporate_actions_money1530_backup";

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 19_800_000;

/** Time of day (ms past UTC midnight) of the two anchors measured on prod. */
export const ANCHORS: ReadonlyMap<number, string> = new Map([
  [0, "00:00Z (a UTC process)"],
  [DAY_MS - IST_OFFSET_MS, "18:30Z (an IST process)"],
]);

/** A `corporate_actions` document exactly as `$runCommandRaw` returns it. */
export type RawDoc = Record<string, unknown>;

/** Its date fields as epoch ms, for the decisions. */
interface Row {
  id: string;
  raw: RawDoc;
  exDate: number | null;
  recordDate: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

function timeOfDay(t: number): number {
  return ((t % DAY_MS) + DAY_MS) % DAY_MS;
}

/**
 * UTC midnight of the IST calendar day `t` falls on, or null when `t` is not
 * at one of the {@link ANCHORS}. Idempotent: an anchored value maps to itself.
 */
export function istDayAnchor(t: number): number | null {
  if (!ANCHORS.has(timeOfDay(t))) return null;
  const ist = t + IST_OFFSET_MS;
  return ist - timeOfDay(ist);
}

/**
 * Epoch ms of a relaxed-EJSON date — `{ $date: "…" }`, which is what
 * `$runCommandRaw` returns (measured), or `{ $date: { $numberLong } }`.
 * `null` for null or absent; NaN for anything else, which no anchor matches,
 * so an unreadable date is REFUSED rather than read as some other day.
 */
export function readDate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const inner =
    typeof v === "object" ? (v as { $date?: unknown }).$date : undefined;
  if (typeof inner === "string") return Date.parse(inner);
  if (inner !== null && typeof inner === "object") {
    return Number((inner as { $numberLong?: unknown }).$numberLong);
  }
  return NaN;
}

export function ejsonDate(ms: number): { $date: string } {
  return { $date: new Date(ms).toISOString() };
}

function readId(doc: RawDoc): string {
  const oid = (doc._id as { $oid?: unknown } | undefined)?.$oid;
  if (typeof oid !== "string" || !/^[0-9a-f]{24}$/.test(oid)) {
    throw new Error(
      `document without a readable _id: ${JSON.stringify(doc._id)}`,
    );
  }
  return oid;
}

function toRow(raw: RawDoc): Row {
  return {
    id: readId(raw),
    raw,
    exDate: readDate(raw.exDate),
    recordDate: readDate(raw.recordDate),
    createdAt: readDate(raw.createdAt),
    updatedAt: readDate(raw.updatedAt),
  };
}

const present = (v: unknown): boolean => v !== null && v !== undefined;

/**
 * Does source `a` STRICTLY outrank `b` under `price-adjust.ts`'s `SOURCE_RANK`?
 *
 * The rank is module-private there and that file is not this ticket's to edit,
 * so it is asked through the one exported function that applies it: two
 * records of one event, same day and factor, `b` first — `dedupeActions`
 * replaces the incumbent only when the challenger's rank is strictly higher. A
 * copied table would be a second spelling of the rule the chart uses, free to
 * disagree with it. Export `sourceRank` and this becomes a direct call.
 */
export function outranks(a: string | null, b: string | null): boolean {
  const exDate = new Date(0);
  const incumbent = { type: "SPLIT", exDate, ratio: 2, source: b };
  const challenger = { type: "SPLIT", exDate, ratio: 2, source: a };
  return dedupeActions([incumbent, challenger])[0] === challenger;
}

/** Fields a survivor takes from a loser when its own is empty. */
const FILL_FIELDS = [
  "isin",
  "ratio",
  "oldFaceValue",
  "newFaceValue",
  "dividendPerShare",
  "gcsPath",
  "details",
] as const;

function richness(r: Row): number {
  return (
    FILL_FIELDS.filter((f) => present(r.raw[f])).length +
    (r.recordDate === null ? 0 : 1)
  );
}

export type SurvivorReason =
  | "AUTHORITY"
  | "RICHER"
  | "LATER_UPDATE"
  | "LATER_ID";

/** Negative when `a` should survive over `b`, with the rule that decided. */
function compare(a: Row, b: Row): [number, SurvivorReason] {
  const sa = (a.raw.source as string | null | undefined) ?? null;
  const sb = (b.raw.source as string | null | undefined) ?? null;
  if (outranks(sa, sb)) return [-1, "AUTHORITY"];
  if (outranks(sb, sa)) return [1, "AUTHORITY"];
  const rich = richness(b) - richness(a);
  if (rich !== 0) return [rich, "RICHER"];
  const ua = a.updatedAt ?? 0;
  const ub = b.updatedAt ?? 0;
  if (ua !== ub) return [ua > ub ? -1 : 1, "LATER_UPDATE"];
  return [a.id > b.id ? -1 : a.id < b.id ? 1 : 0, "LATER_ID"];
}

/** The `+`-union `mergeCorporateActions` writes: split, dedupe, sort, join. */
function unionSources(rows: readonly Row[]): string | null {
  const tags = new Set(
    rows.flatMap((r) =>
      typeof r.raw.source === "string" ? r.raw.source.split("+") : [],
    ),
  );
  tags.delete("");
  return tags.size ? [...tags].sort().join("+") : null;
}

export interface Conflict {
  field: string;
  kept: unknown;
  dropped: unknown;
  loser: string;
}

export interface Group {
  /** `SYMBOL|EXCHANGE|TYPE|YYYY-MM-DD`, the day in IST. */
  key: string;
  type: string;
  survivor: string;
  losers: string[];
  reason: SurvivorReason;
  /** Fields the survivor took from a loser. */
  carried: string[];
  /** Both held a value and they differ: the survivor's was kept. */
  conflicts: Conflict[];
}

export interface WriteOp {
  id: string;
  /** Compare-and-set guard: the write applies only while this still matches. */
  expect: RawDoc;
  set: RawDoc;
}

export interface BackupEntry {
  id: string;
  role: "survivor" | "loser" | "moved";
  doc: RawDoc;
}

export interface ReanchorPlan {
  /** Per date-only field: anchor label -> row count. */
  census: Record<"exDate" | "recordDate", Record<string, number>>;
  /** Rows left untouched because a date is not at a known anchor. */
  refused: Array<{ id: string; field: string; value: unknown }>;
  groups: Group[];
  /** Survivors' merged fields — applied BEFORE their losers are deleted. */
  fills: WriteOp[];
  /** Losers, guarded on their read `updatedAt`. */
  deletes: WriteOp[];
  /** Date re-anchors — applied AFTER the deletes free the target keys. */
  moves: WriteOp[];
  /** Every document a fill, delete or move touches, verbatim. */
  backup: BackupEntry[];
}

function anchorLabel(t: number | null): string {
  if (t === null) return "null or absent";
  return ANCHORS.get(timeOfDay(t)) ?? "UNRECOGNISED";
}

/**
 * Plan the re-anchor over the whole collection.
 *
 * The phases are ordered so a run killed at ANY point is finished by running it
 * again: the fills land on the survivor before its loser is deleted (so a crash
 * cannot lose a carried field), and the moves come last because the target key
 * is only free once the loser is gone. Re-planning the post-apply state yields
 * nothing, which is what makes a second run a no-op.
 */
export function planReanchor(docs: readonly RawDoc[], now: Date): ReanchorPlan {
  const plan: ReanchorPlan = {
    census: { exDate: {}, recordDate: {} },
    refused: [],
    groups: [],
    fills: [],
    deletes: [],
    moves: [],
    backup: [],
  };
  const stamp = ejsonDate(now.getTime());

  // Units share the unique key AFTER re-anchoring. A row whose exDate is
  // unreadable or off-anchor can never share one with a moved row — its exDate
  // is not at a UTC midnight — so it is refused on its own.
  const units = new Map<string, Row[]>();
  for (const raw of docs) {
    const row = toRow(raw);
    for (const field of ["exDate", "recordDate"] as const) {
      const label = anchorLabel(row[field]);
      plan.census[field][label] = (plan.census[field][label] ?? 0) + 1;
    }
    const day = row.exDate === null ? null : istDayAnchor(row.exDate);
    if (day === null) {
      plan.refused.push({ id: row.id, field: "exDate", value: raw.exDate });
      continue;
    }
    const key = [
      raw.symbol,
      raw.exchange,
      raw.type,
      new Date(day).toISOString().slice(0, 10),
    ].join("|");
    const unit = units.get(key);
    if (unit) unit.push(row);
    else units.set(key, [row]);
  }

  for (const [key, rows] of units) {
    // An off-anchor recordDate anywhere in the unit stops the WHOLE unit: that
    // row still sits on the key, so moving its twin onto the key would collide.
    const badRecord = rows.filter(
      (r) => r.recordDate !== null && istDayAnchor(r.recordDate) === null,
    );
    if (badRecord.length > 0) {
      for (const r of badRecord) {
        plan.refused.push({
          id: r.id,
          field: "recordDate",
          value: r.raw.recordDate,
        });
      }
      continue;
    }

    const ranked = [...rows].sort((a, b) => compare(a, b)[0]);
    const survivor = ranked[0]!;
    const losers = ranked.slice(1);
    let survivorTouched = false;

    if (losers.length > 0) {
      const set: RawDoc = {};
      const carried: string[] = [];
      const conflicts: Conflict[] = [];
      // Each loser is compared with what the survivor WILL hold — its own
      // value, or one an earlier (higher-ranked) loser already filled in.
      for (const f of FILL_FIELDS) {
        for (const l of losers) {
          const theirs = l.raw[f];
          if (!present(theirs)) continue;
          const held = present(survivor.raw[f]) ? survivor.raw[f] : set[f];
          if (!present(held)) {
            set[f] = theirs;
            carried.push(f);
          } else if (JSON.stringify(theirs) !== JSON.stringify(held)) {
            conflicts.push({
              field: f,
              kept: held,
              dropped: theirs,
              loser: l.id,
            });
          }
        }
      }
      // recordDate is compared and carried as a DAY, re-anchored on the way in.
      let heldRecord =
        survivor.recordDate === null ? null : istDayAnchor(survivor.recordDate);
      for (const l of losers) {
        if (l.recordDate === null) continue;
        const theirs = istDayAnchor(l.recordDate)!;
        if (heldRecord === null) {
          heldRecord = theirs;
          set.recordDate = ejsonDate(theirs);
          carried.push("recordDate");
        } else if (theirs !== heldRecord) {
          conflicts.push({
            field: "recordDate",
            kept: ejsonDate(heldRecord),
            dropped: l.raw.recordDate,
            loser: l.id,
          });
        }
      }
      const source = unionSources(ranked);
      if (
        source !== ((survivor.raw.source as string | null | undefined) ?? null)
      ) {
        set.source = source;
        carried.push("source");
      }
      const created = ranked
        .map((r) => r.createdAt)
        .filter((t): t is number => t !== null && Number.isFinite(t));
      const earliest = created.length ? Math.min(...created) : null;
      if (
        earliest !== null &&
        (survivor.createdAt === null || earliest < survivor.createdAt)
      ) {
        set.createdAt = ejsonDate(earliest);
        carried.push("createdAt");
      }
      if (Object.keys(set).length > 0) {
        set.updatedAt = stamp;
        plan.fills.push({
          id: survivor.id,
          expect: { updatedAt: survivor.raw.updatedAt ?? null },
          set,
        });
        survivorTouched = true;
      }
      for (const l of losers) {
        plan.deletes.push({
          id: l.id,
          expect: { updatedAt: l.raw.updatedAt ?? null },
          set: {},
        });
        plan.backup.push({ id: l.id, role: "loser", doc: l.raw });
      }
      plan.groups.push({
        key,
        type: String(survivor.raw.type),
        survivor: survivor.id,
        losers: losers.map((l) => l.id),
        reason: compare(survivor, losers[0]!)[1],
        carried,
        conflicts,
      });
    }

    // The survivor's own dates. A recordDate it just took from a loser was
    // re-anchored on the way in, so only its OWN non-null one can move here.
    const move: RawDoc = {};
    const ex = istDayAnchor(survivor.exDate!)!;
    if (ex !== survivor.exDate) move.exDate = ejsonDate(ex);
    if (survivor.recordDate !== null) {
      const rd = istDayAnchor(survivor.recordDate)!;
      if (rd !== survivor.recordDate) move.recordDate = ejsonDate(rd);
    }
    if (Object.keys(move).length > 0) {
      move.updatedAt = stamp;
      plan.moves.push({
        id: survivor.id,
        expect: { exDate: survivor.raw.exDate },
        set: move,
      });
      survivorTouched = true;
    }
    if (survivorTouched) {
      plan.backup.push({
        id: survivor.id,
        role: losers.length > 0 ? "survivor" : "moved",
        doc: survivor.raw,
      });
    }
  }
  return plan;
}

/**
 * The collection after `plan` is applied, in memory — the same three phases in
 * the same order. Used to prove, before anything is written, that re-planning
 * the result yields no work.
 */
export function simulateApply(
  docs: readonly RawDoc[],
  plan: ReanchorPlan,
): RawDoc[] {
  const byId = new Map(docs.map((d) => [readId(d), { ...d }]));
  for (const op of plan.fills) Object.assign(byId.get(op.id)!, op.set);
  for (const op of plan.deletes) byId.delete(op.id);
  for (const op of plan.moves) Object.assign(byId.get(op.id)!, op.set);
  return [...byId.values()];
}

/** A document in {@link BACKUP_COLLECTION}, as read back. */
export interface BackupDoc {
  _id: unknown;
  doc: RawDoc;
  role: string;
  backedUpAt: unknown;
}

/**
 * The reversal: every backed-up document back exactly as it was read.
 *
 * REPLACE the ones still present first — a survivor moved onto a loser's key
 * must move off it before the loser can come back — then INSERT the deleted.
 * A row the nightly enriched after the migration is returned to its
 * pre-migration state too; that is what "restore" means.
 */
export function planRestore(
  backup: readonly BackupDoc[],
  presentIds: ReadonlySet<string>,
): { replace: RawDoc[]; insert: RawDoc[] } {
  const replace: RawDoc[] = [];
  const insert: RawDoc[] = [];
  for (const b of backup) {
    (presentIds.has(readId(b.doc)) ? replace : insert).push(b.doc);
  }
  return { replace, insert };
}
