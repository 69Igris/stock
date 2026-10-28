/**
 * The pure decisions behind `scripts/data/repair-corporate-action-bonus.ts` —
 * MONEY-1542.
 *
 * ## What the parser dropped
 *
 * NSE files a bonus and a split on the same ex-date as ONE subject: "Bonus 1:1
 * / Face Value Split From Rs.10/- To Re.1/-". `normalizeActionType` checks
 * split first, so the row was stored as SPLIT and the bonus was lost. Measured
 * on prod `corporate_actions` on 2026-09-23:
 *
 *   31 NSE SPLIT rows whose stored subject also names a share bonus with its
 *      ratio, 2010-2018. None has an NSE BONUS row on the same day. 27 have a
 *      BSE BONUS on the same day with the SAME ratio (BSE files the two
 *      separately); DPSCLTD, RESURGERE, STER and MINDACORP have none.
 *    2 BONUS rows whose subject names a split, in NSE's "Spl" abbreviation
 *      ("Spl-Rs10 To Rs2/Bonus-1:2", EIHOTEL; "Bonus-1:1 Spl-Rs 5/ To 2/",
 *      BSOFT). The parser did not know "Spl" meant a split, so it typed them
 *      BONUS. They are not this repair's: `repair-corporate-action-subjects.ts`
 *      inserts their SPLIT (MONEY-1603 review).
 *    0 BSE rows with a combined subject.
 *
 * Gold's NSE series only reads NSE rows, so it drops the bonus: TITAN:NSE
 * adjusts by 10 where 20 is right, ONGC:NSE by 3 where 6 is right. The chart is
 * right only where BSE filed the bonus, because it reads both exchanges.
 *
 * ## The repair: one BONUS row per event, never a composed factor
 *
 * `@@unique([symbol, exchange, type, exDate])` allows one SPLIT and one BONUS
 * per day. Gold partitions on `action_type`, and `actionFactor` and
 * `dedupeActions` multiply per type. So the fix is a SECOND row, and the SPLIT
 * row is not changed. The row copies the SPLIT row's listing, ex-date, record
 * date, subject and `createdAt` (the lake reads that as `published_at`, and the
 * event was known when the split was first stored). Its ratio comes from the
 * same function the fixed parser uses, `combinedBonusRatio`, so this repair and
 * the nightly always agree.
 *
 * `source` is {@link REPAIR_SOURCE}, a single token that marks the row as
 * parsed from a stored subject rather than filed by a feed. It is not in
 * `SOURCE_RANK`, so the TypeScript and the SQL both rank it 20 (their exact-token
 * rules agree on unknown tokens). It only loses a tie with another row for the
 * same event, and such a row carries the same ratio (see below).
 *
 * ## When it does NOT insert
 *
 *   PRESENT   the listing already has a BONUS on that IST day, from any source
 *             and at either time anchor. The row it would add already exists,
 *             so there is nothing to add; a differing ratio is reported.
 *   REFUSED   another exchange files a BONUS for the symbol on that IST day with
 *             a DIFFERENT ratio. The chart reads both exchanges and would apply
 *             both. None on prod; a refusal gets a human decision, not a guess.
 *
 * Where BSE filed the same ratio (27 of 31), the row is still inserted. BSE's row
 * sits on the BSE listing, and gold's NSE series never reads it. On the chart,
 * `dedupeActions` treats the two as one filing (same type, same day, equal
 * factor), keeps BSE's row (rank 90 against 20), and the factor stays as it is.
 *
 * ## Run it after MONEY-1530's re-anchor
 *
 * The ex-date is copied as stored. If this runs first, the new rows are at 18:30Z
 * like their SPLIT rows, and the re-anchor moves them with everything else.
 * Either order ends in the same state. Days are compared as IST calendar days,
 * so neither anchor hides an existing BONUS.
 */
import { combinedBonusRatio } from "../../packages/research/src/data-sources/nse-filings-logic";
import { readDate } from "./reanchor-corporate-action-dates-logic";

/** A record of every row this repair inserts, written and counted BEFORE the insert. */
export const BACKUP_COLLECTION = "corporate_actions_money1542_backup";

/** `source` of an inserted row: a leg parsed from a stored NSE subject. */
export const REPAIR_SOURCE = "NSE_REPARSE";

export type RawDoc = Record<string, unknown>;

const IST_OFFSET_MS = 19_800_000;

export interface BonusInsert {
  /** The new row's `_id`. */
  id: string;
  /** `SYMBOL|EXCHANGE|YYYY-MM-DD` (IST day), for the report. */
  key: string;
  splitRatio: unknown;
  ratio: number;
  /** The same-day BONUS another exchange files for the symbol, if any. */
  twin: { exchange: string; ratio: unknown } | null;
  doc: RawDoc;
}

export interface BonusRepairPlan {
  inserts: BonusInsert[];
  present: Array<{ key: string; stored: unknown; parsed: number }>;
  refused: Array<{
    key: string;
    reason: "NO_EX_DATE" | "OTHER_EXCHANGE_DISAGREES";
    parsed: number;
    twins: string[];
  }>;
}

function idOf(doc: RawDoc): string {
  return (doc._id as { $oid: string }).$oid;
}

function istDay(v: unknown): string | null {
  const t = readDate(v);
  return t === null || !Number.isFinite(t)
    ? null
    : new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A ratio as gold compares one: NUMERIC(18,6). */
function sameRatio(a: unknown, b: number): boolean {
  return typeof a === "number" && a.toFixed(6) === b.toFixed(6);
}

/**
 * `newId` supplies each inserted row's `_id` (24 hex), which is injected so the
 * plan is deterministic under test.
 */
export function planBonusRepair(
  docs: readonly RawDoc[],
  now: Date,
  newId: () => string,
): BonusRepairPlan {
  const plan: BonusRepairPlan = { inserts: [], present: [], refused: [] };
  const stamp = { $date: now.toISOString() };

  const bonuses = new Map<string, RawDoc[]>();
  for (const d of docs) {
    const day = d.type === "BONUS" ? istDay(d.exDate) : null;
    if (day === null) continue;
    const k = `${String(d.symbol)}|${day}`;
    bonuses.set(k, [...(bonuses.get(k) ?? []), d]);
  }

  for (const split of docs) {
    if (split.type !== "SPLIT" || typeof split.details !== "string") continue;
    // The NSE writer is the one that emits the second leg. A BSE subject goes
    // through bse-client, which never files one event as two.
    if (
      !String(split.source ?? "")
        .split("+")
        .includes("NSE")
    )
      continue;
    const ratio = combinedBonusRatio(split.details);
    if (ratio === null) continue;

    const day = istDay(split.exDate);
    const key = `${String(split.symbol)}|${String(split.exchange)}|${day ?? "?"}`;
    if (day === null) {
      plan.refused.push({
        key,
        reason: "NO_EX_DATE",
        parsed: ratio,
        twins: [],
      });
      continue;
    }
    const sameDay = bonuses.get(`${String(split.symbol)}|${day}`) ?? [];
    const own = sameDay.find((b) => b.exchange === split.exchange);
    if (own) {
      plan.present.push({ key, stored: own.ratio, parsed: ratio });
      continue;
    }
    const others = sameDay.filter((b) => b.exchange !== split.exchange);
    if (others.some((b) => !sameRatio(b.ratio, ratio))) {
      plan.refused.push({
        key,
        reason: "OTHER_EXCHANGE_DISAGREES",
        parsed: ratio,
        twins: others.map((b) => `${String(b.exchange)} ${String(b.ratio)}`),
      });
      continue;
    }

    const id = newId();
    const doc: RawDoc = {
      _id: { $oid: id },
      symbol: split.symbol,
      isin: split.isin ?? null,
      exchange: split.exchange,
      type: "BONUS",
      exDate: split.exDate,
      recordDate: split.recordDate ?? null,
      ratio,
      oldFaceValue: null,
      newFaceValue: null,
      dividendPerShare: null,
      source: REPAIR_SOURCE,
      details: split.details,
      gcsPath: split.gcsPath ?? null,
      createdAt: split.createdAt ?? stamp,
      updatedAt: stamp,
    };
    // Seen by the next SPLIT row of this event: the same split stored at both
    // time anchors gets ONE bonus.
    bonuses.set(`${String(split.symbol)}|${day}`, [...sameDay, doc]);
    plan.inserts.push({
      id,
      key,
      splitRatio: split.ratio,
      ratio,
      twin: others[0]
        ? { exchange: String(others[0].exchange), ratio: others[0].ratio }
        : null,
      doc,
    });
  }
  return plan;
}

/** The collection after `plan` is applied, in memory. */
export function simulateBonusRepair(
  docs: readonly RawDoc[],
  plan: BonusRepairPlan,
): RawDoc[] {
  return [...docs, ...plan.inserts.map((i) => i.doc)];
}

/** A document in {@link BACKUP_COLLECTION}, as read back. */
export interface BonusBackupDoc {
  _id: unknown;
  doc: RawDoc;
  role: string;
}

/**
 * The reversal deletes each inserted row that is STILL exactly as inserted, a
 * check made on `source` and `updatedAt`. A row something has written to since
 * is kept and listed; for example, an NSE re-walk that merges into it makes its
 * source "NSE+NSE_REPARSE". Deleting it then would remove NSE's own filing.
 */
export function planBonusRestore(
  backup: readonly BonusBackupDoc[],
  current: ReadonlyMap<string, RawDoc>,
): {
  ops: Array<{ id: string; expect: RawDoc; set: RawDoc }>;
  changedSince: string[];
  gone: string[];
} {
  const ops: Array<{ id: string; expect: RawDoc; set: RawDoc }> = [];
  const changedSince: string[] = [];
  const gone: string[] = [];
  for (const b of backup) {
    const id = idOf(b.doc);
    const now = current.get(id);
    if (!now) {
      gone.push(id);
      continue;
    }
    const expect = { source: b.doc.source, updatedAt: b.doc.updatedAt };
    if (
      now.source !== expect.source ||
      readDate(now.updatedAt) !== readDate(expect.updatedAt)
    ) {
      changedSince.push(id);
      continue;
    }
    ops.push({ id, expect, set: {} });
  }
  return { ops, changedSince, gone };
}
