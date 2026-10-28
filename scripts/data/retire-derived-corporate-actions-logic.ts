/**
 * Which price-derived corporate actions to retire — MONEY-1600. Pure.
 *
 * `derive-corporate-actions.ts` writes a `source: "DERIVED"` row for a cliff it
 * reads in one listing's raw exchange series, and only ever ADDS: nothing
 * re-reads a row once written, so a row whose evidence was never sound, or has
 * since left the series, keeps adjusting every chart that admits it. This
 * re-reads each row against its OWN listing's series with the detector's own
 * test (`verifyCliff`) and retires what that test now refuses.
 *
 * ## What retires, and what stays
 *
 *   REFUTED        both closes are there and their move is not the row's ratio
 *   GAP            the close on the row's day is there and the close before it
 *                  is more than `MAX_CLIFF_GAP_DAYS` back — the "cliff" was
 *                  drift across a trading gap
 *   CONFIRMED      stays
 *   NO_BAR_BEFORE  stays: no close precedes the row's day at all — a truncated
 *                  series, or history under another instrument
 *   NO_BAR_ON_DAY  stays: the series holds no close on that day, so it says
 *                  nothing about the row
 *   NO_LISTING     stays: no instrument trades under the row's (symbol,
 *                  exchange), so there is no series to read
 *   NO_RATIO       stays: nothing to compare against
 *
 * The four "stays" verdicts are UNKNOWN, not confirmed, and they are counted.
 * Retiring on absence would drop rows another listing depends on: ZEEL:NSE and
 * DOLPHIN:NSE are adjusted only by BSE's DERIVED row, because their own
 * detector run was reconciled away as "already known" by it.
 *
 * Measured on prod 2026-09-23 over all 156 DERIVED rows: 154 CONFIRMED, 2 GAP
 * (SAYAJIHOTL:NSE 2026-04-22, 4,114 days after its previous NSE close;
 * KANORICHEM:NSE 1996-06-04, 132 days), 0 REFUTED, 0 unknown. No row's evidence
 * has LEFT its series — SAYAJIHOTL's 138.70 is still there, in 2015.
 */
import {
  verifyCliff,
  type CliffVerdict,
  type DetectBar,
} from "../../packages/core/src/market-data/corporate-action-detect";
import { readDate } from "./reanchor-corporate-action-dates-logic";

export const BACKUP_COLLECTION = "corporate_actions_money1600_backup";

type RawDoc = Record<string, unknown>;

/** The two closes `verifyCliff` reads, or null when no instrument trades the row. */
export interface Evidence {
  onDay: DetectBar | null;
  before: DetectBar | null;
}

export type Verdict = CliffVerdict | "NO_LISTING" | "NO_RATIO";

const RETIRES: ReadonlySet<Verdict> = new Set<Verdict>(["REFUTED", "GAP"]);

export interface Judged {
  id: string;
  /** `SYMBOL:EXCHANGE yyyy-mm-dd`, for the log. */
  key: string;
  symbol: string;
  exchange: string;
  ratio: number | null;
  verdict: Verdict;
  observedRatio: number | null;
  gapDays: number | null;
}

export interface RetirePlan {
  judged: Judged[];
  backup: { id: string; role: string; doc: RawDoc }[];
  /** Delete ops, compare-and-set on the `updatedAt` read and on the source. */
  deletes: { id: string; expect: RawDoc; set: RawDoc }[];
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The IST session day a row's `exDate` names, as [start, end) in epoch ms of
 * the UTC midnights `daily_prices.date` is stamped at. MONEY-1530 put every
 * row at 00:00Z of its IST day; an older 18:30Z stamp lands on the same day.
 */
export function sessionDay(
  exDate: unknown,
): { start: number; end: number } | null {
  const t = readDate(exDate);
  if (t === null || !Number.isFinite(t)) return null;
  const ist = t + IST_OFFSET_MS;
  const start = ist - (((ist % DAY_MS) + DAY_MS) % DAY_MS);
  return { start, end: start + DAY_MS };
}

export function idOfDoc(doc: RawDoc): string {
  return (doc._id as { $oid: string }).$oid;
}

/**
 * Judge every DERIVED row; plan a backup and a delete for each one retired.
 * A row that is not DERIVED is never judged — the delete also re-checks the
 * source, so a feed row can never be named here.
 */
export function planRetire(
  rows: readonly RawDoc[],
  evidence: ReadonlyMap<string, Evidence | null>,
): RetirePlan {
  const plan: RetirePlan = { judged: [], backup: [], deletes: [] };
  for (const row of rows) {
    if (row.source !== "DERIVED") continue;
    const id = idOfDoc(row);
    const symbol = String(row.symbol);
    const exchange = String(row.exchange);
    const t = readDate(row.exDate);
    const day =
      t !== null && Number.isFinite(t)
        ? new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10)
        : "?";
    const ratio =
      typeof row.ratio === "number" &&
      Number.isFinite(row.ratio) &&
      row.ratio > 0
        ? row.ratio
        : null;
    const ev = evidence.get(id) ?? null;
    const base = {
      id,
      key: `${symbol}:${exchange} ${day}`,
      symbol,
      exchange,
      ratio,
    };
    let judged: Judged;
    if (ratio === null) {
      judged = {
        ...base,
        verdict: "NO_RATIO",
        observedRatio: null,
        gapDays: null,
      };
    } else if (ev === null) {
      judged = {
        ...base,
        verdict: "NO_LISTING",
        observedRatio: null,
        gapDays: null,
      };
    } else {
      judged = { ...base, ...verifyCliff(ev, ratio) };
    }
    plan.judged.push(judged);
    if (!RETIRES.has(judged.verdict)) continue;
    plan.backup.push({ id, role: `retired:${judged.verdict}`, doc: row });
    plan.deletes.push({
      id,
      expect: { source: "DERIVED", updatedAt: row.updatedAt },
      set: {},
    });
  }
  return plan;
}

/** The DERIVED rows once `plan` is applied — to prove a second run finds nothing. */
export function simulateRetire(
  rows: readonly RawDoc[],
  plan: RetirePlan,
): RawDoc[] {
  const gone = new Set(plan.deletes.map((d) => d.id));
  return rows.filter((r) => !gone.has(idOfDoc(r)));
}

/** A document in {@link BACKUP_COLLECTION}, as read back. */
export interface RetireBackupDoc {
  _id: unknown;
  doc: RawDoc;
  role: string;
}

/**
 * Put every retired row back, verbatim. A row whose `_id` is present again is
 * left alone and named: the restore never overwrites what is there now.
 */
export function planRetireRestore(
  backup: readonly RetireBackupDoc[],
  presentIds: ReadonlySet<string>,
): { insert: RawDoc[]; present: string[] } {
  const insert: RawDoc[] = [];
  const present: string[] = [];
  for (const b of backup) {
    const id = idOfDoc(b.doc);
    if (presentIds.has(id)) present.push(id);
    else insert.push(b.doc);
  }
  return { insert, present };
}
