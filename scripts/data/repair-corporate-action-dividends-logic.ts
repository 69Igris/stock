/**
 * The pure decisions behind `scripts/data/repair-corporate-action-dividends.ts`
 * — MONEY-1535.
 *
 * ## What the parser wrote
 *
 * `parseDividendPerShare` matched `Rs`/`Re` inside words and could not read
 * BSE's `Rs. - 7.0000`. Measured on prod `corporate_actions` 2026-09-23, over
 * the 44,261 DIVIDEND rows, re-parsing each row's OWN stored subject:
 *
 *   WRONG    2        the old parser's value, which the fixed one does not give:
 *                     SUDARSCHEM 6 (from "Shareholde-RS 6 Aug"; the text says
 *                     Rs. 5) and KCP 28 (from "book closu-RE 28 Jul"; the text
 *                     names no amount at all)
 *   MISSING  14,461   null, and the subject states an amount: 14,412 BSE
 *                     ("Interim Dividend - Rs. - 7.0000") and 49 NSE, whose
 *                     older spelling puts the same dash in ("Dividend Rs - 1.2
 *                     Per Share")
 *
 * ## What it deliberately leaves alone
 *
 * A stored value that NEITHER parser derives from the row's stored subject —
 * 11 on prod — came in with a DIFFERENT subject: two dividends on one ex-date
 * collapse into one row under `@@unique([symbol, exchange, type, exDate])`, the
 * merge keeps the first row's amount and the longer subject. Neither parser
 * produced it from what is stored, so this repair has no standing to change it
 * and REPORTS it instead.
 *
 * Only DIVIDEND rows are touched, because only a DIVIDEND gets a
 * `dividendPerShare` from the writer (`parseActionSubject`). A BONUS subject
 * that mentions a dividend keeps its null.
 *
 * ## The restore is FIELD-LEVEL, and that is what makes the order safe
 *
 * It puts back `dividendPerShare` and `updatedAt` only, and only on a row that
 * still holds the value this repair wrote. So it cannot undo, or collide with,
 * anything the MONEY-1530 re-anchor did to the same rows, in whichever order the
 * two were applied or are reversed. The field is present on all 44,261 DIVIDEND
 * rows (22,651 as null), so a `$set` restores it exactly; a row without the
 * field is refused rather than given one.
 */
import {
  dividendReading,
  parseDividendPerShare,
} from "../../packages/research/src/data-sources/nse-filings-logic";

/** Every row this repair writes is copied here first. */
export const BACKUP_COLLECTION = "corporate_actions_money1535_backup";

export type RawDoc = Record<string, unknown>;

/**
 * The parser as it stood BEFORE MONEY-1535, verbatim. Kept for one purpose
 * only: recognising a stored value that it, and nothing else, produced from
 * the row's own subject. It never decides a value.
 */
export function legacyDividendPerShare(subject: string): number | null {
  const s = subject || "";
  if (!/dividend/i.test(s)) return null;
  const perShare = s.match(
    /r(?:s|e)\.?\s*(\d+(?:\.\d+)?)\s*(?:\/-)?\s*per\s+share/i,
  );
  const m = perShare ?? s.match(/r(?:s|e)\.?\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export type DividendFix = "CORRECT" | "FILL";

export interface DividendChange {
  id: string;
  /** `SYMBOL|EXCHANGE|exDate` for the report. */
  key: string;
  fix: DividendFix;
  from: number | null;
  to: number | null;
  source: string | null;
}

export interface DividendRepairPlan {
  changes: DividendChange[];
  /** Compare-and-set writes, guarded on the `updatedAt` that was read. */
  ops: Array<{ id: string; expect: RawDoc; set: RawDoc }>;
  /** Every written row, verbatim, with the value written. */
  backup: Array<{ id: string; role: DividendFix; doc: RawDoc; wrote: RawDoc }>;
  /** A stored value neither parser derives from the stored subject. */
  unattributed: Array<{
    id: string;
    key: string;
    stored: number;
    parsed: number | null;
  }>;
  /** DIVIDEND rows with NO `dividendPerShare` field: refused, never given one. */
  refusedNoField: string[];
}

function idOf(doc: RawDoc): string {
  return (doc._id as { $oid: string }).$oid;
}

function keyOf(doc: RawDoc): string {
  const ex = (doc.exDate as { $date?: string } | undefined)?.$date ?? "?";
  return `${String(doc.symbol)}|${String(doc.exchange)}|${ex.slice(0, 10)}`;
}

export function planDividendRepair(
  docs: readonly RawDoc[],
  now: Date,
): DividendRepairPlan {
  const plan: DividendRepairPlan = {
    changes: [],
    ops: [],
    backup: [],
    unattributed: [],
    refusedNoField: [],
  };
  const stamp = { $date: now.toISOString() };
  for (const doc of docs) {
    if (doc.type !== "DIVIDEND" || typeof doc.details !== "string") continue;
    if (!("dividendPerShare" in doc)) {
      plan.refusedNoField.push(idOf(doc));
      continue;
    }
    const raw = doc.dividendPerShare;
    const stored = typeof raw === "number" ? raw : null;
    const parsed = parseDividendPerShare(doc.details);
    if (stored === parsed) continue;

    let fix: DividendFix;
    if (stored === null) fix = "FILL";
    // "Cannot read it" is not "there is none". Since MONEY-1603 the parser
    // returns null when a dividend clause holds a rupee amount it cannot
    // account for (`unread`), so a re-run of this repair would otherwise null
    // every such value the old parser happened to read. A DEFINITE null — no
    // amount stated at all, KCP's 28 — still corrects.
    else if (
      dividendReading(doc.details).unread.length === 0 &&
      stored === legacyDividendPerShare(doc.details)
    )
      fix = "CORRECT";
    else {
      plan.unattributed.push({
        id: idOf(doc),
        key: keyOf(doc),
        stored,
        parsed,
      });
      continue;
    }
    const id = idOf(doc);
    plan.changes.push({
      id,
      key: keyOf(doc),
      fix,
      from: stored,
      to: parsed,
      source: typeof doc.source === "string" ? doc.source : null,
    });
    plan.ops.push({
      id,
      expect: { dividendPerShare: raw, updatedAt: doc.updatedAt ?? null },
      set: { dividendPerShare: parsed, updatedAt: stamp },
    });
    plan.backup.push({
      id,
      role: fix,
      doc,
      wrote: { dividendPerShare: parsed },
    });
  }
  return plan;
}

/** The collection after `plan` is applied, in memory. */
export function simulateDividendRepair(
  docs: readonly RawDoc[],
  plan: DividendRepairPlan,
): RawDoc[] {
  const set = new Map(plan.ops.map((op) => [op.id, op.set]));
  return docs.map((d) => {
    const s = set.get(idOf(d));
    return s ? { ...d, ...s } : d;
  });
}

/** A document in {@link BACKUP_COLLECTION}, as read back. */
export interface DividendBackupDoc {
  _id: unknown;
  doc: RawDoc;
  role: string;
  wrote: RawDoc;
}

/**
 * The reversal: `dividendPerShare` and `updatedAt` back to what was read, on
 * every row that STILL holds the value this repair wrote. A row something else
 * has changed since is left as it is and listed — putting back a value over a
 * newer one is not a restore.
 */
export function planDividendRestore(
  backup: readonly DividendBackupDoc[],
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
    const wrote = b.wrote.dividendPerShare ?? null;
    if ((now.dividendPerShare ?? null) !== wrote) {
      changedSince.push(id);
      continue;
    }
    ops.push({
      id,
      expect: { dividendPerShare: wrote },
      set: {
        dividendPerShare: b.doc.dividendPerShare ?? null,
        updatedAt: b.doc.updatedAt ?? null,
      },
    });
  }
  return { ops, changedSince, gone };
}
