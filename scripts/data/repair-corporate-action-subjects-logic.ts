/**
 * The pure decisions behind `scripts/data/repair-corporate-action-subjects.ts`
 * — MONEY-1598, MONEY-1599 and MONEY-1603. Each re-reads rows' OWN stored
 * subjects with the fixed parser and writes what it would have written. Each
 * ticket's changes are counted apart.
 *
 * ## MONEY-1598: split ratios the face-value parser could not read
 *
 * `parseFaceValueSplit` needed the word "From", and NSE's older wording has
 * none: "Fv Split Rs.10/- To Rs.2/". Measured on prod `corporate_actions` on
 * 2026-09-23:
 *
 *   FILL      156   NSE SPLIT rows at ratio null; the subject names the change
 *                   (ratio 5 x89, 10 x40, 2 x24, 4, 6, 2.5)
 *   CORRECT     2   JBMA 1 -> 2 and SHARONBIO 1 -> 5. The old parser read their
 *                   BONUS's "1:1" as the split's ratio
 *   confirmed   1   ASHOKA's 2 was also taken from its bonus's "1:2"; the face
 *                   value (Rs 10 -> Rs 5) says 2 as well, so it is left alone
 *
 * A stored ratio is CORRECTED only when `parseFaceValueSplit` reads one, i.e.
 * the value comes from a face-value change and the subject names no second
 * change that disagrees (the parser returns null for that). A ratio from an
 * `a:b` token never overrides a stored one; a disagreement of that kind is
 * reported, not written (none on prod).
 *
 * Checked against the prices: 91 of the 158 have NSE prints on both sides of
 * the ex-date, and 89 of those cliffs sit within 25% of the parsed factor
 * (median 3.7%). The two others are JINDALSTEL 2008-01-21 (5 against 6.83; 21
 * January 2008 was a market-wide crash) and KMSUGAR (481 days without a print).
 * BSE files the same ratio for all 38 of its same-day SPLITs.
 *
 * ## MONEY-1599: the dividend a combined subject dropped, and non-share bonuses
 *
 *   DIVIDEND   56   NSE rows of another type whose subject also names a dividend
 *                   (BONUS 32, SPLIT 10, RIGHTS 7, DEMERGER 4, BUYBACK 3). 47 get
 *                   an amount from `parseDividendPerShare` (after MONEY-1603,
 *                   which reads "Div-Rs.5" too), which never reads another
 *                   action's amount. 9 stay null, as a stand-alone dividend in
 *                   the same words would: 8 are percentages ("Div-100%") and
 *                   MARICO's names no amount.
 *   RETYPE      4   BONUS rows that issued no shares: ZEEL "Bonus Preference
 *                   Shares 21:1" (stored 22, dividing the pre-2014 history by
 *                   22), TVSHLTD "Bonus Ncrps 1:116" (1.0086), BRITANNIA x2 "Bonus
 *                   - 1 Debenture" (null)
 *
 * A DIVIDEND row is inserted only when the listing has none on that IST day.
 *
 * RETYPED TO OTHER, NOT DELETED. OTHER is exactly what the fixed parser writes
 * for those subjects. It keeps the event in the corporate-actions list and keeps
 * the row's `_id`, and OTHER is neither a price-basis type nor a cash type, so
 * it cannot adjust a price. It also clears the lake as a side effect of the
 * pending v3 reload: silver holds these rows only at v2, keyed by `_id`, and the
 * reload's superseded arm prunes a v2 row once its `_id` has a v3 row. A delete
 * would rely on the orphan arm instead, which refuses on a short read. If this
 * runs AFTER a v3 reload, the sink's FOURTH arm (MONEY-1607, review round)
 * deletes the moved v3 BONUS row by its old `(listing, type, ex_date)` key on
 * the next `--apply`. It is still ordered before the reload, so one run settles
 * it.
 *
 * ## MONEY-1603: dividend amounts the parser could not read or added up wrong
 *
 * `parseDividendPerShare` required the word "dividend", so NSE's "Int Div-Rs
 * 0.5 Per Sh" read null, and it kept ONE amount from a subject that names two
 * dividends. Measured on prod DIVIDEND rows on 2026-09-23, against the parser
 * as it stood (HEAD, after MONEY-1535):
 *
 *   FILL      1,694   null; the subject names an amount (1,665 via "Div", 5
 *                     via NSE's "Divdend" typo, the rest from the review
 *                     round's compressed forms and decimal typos)
 *   CORRECT     405   390 SUMS ("Final Dividend - Rs 7/- + Special Dividend -Rs
 *                     3/-" stored 3, reads 10); 12 the earlier parser
 *                     under-read (10 Rs-less specials, GDL, GLAXO 62 -> 62.5);
 *                     and 3 rows that stored another amount (an InvIT's
 *                     interest, 1.2, where its dividend is 0.92; a Screener
 *                     profit figure, 0.48, where the dividend is 0.50). A TOTAL
 *                     stated with its parts is the total: ITC 8.5 and GSKCONS
 *                     50 are NOT corrected (review round, 2026-09-23).
 *
 * Every DIVIDEND row a feed wrote (NSE, BSE, SCREENER) is re-read, not only
 * NSE's. A stored amount is CORRECTED only when the new value comes from
 * amounts named against a dividend (`namedDividendAmounts`) AND the stored
 * value is exactly what the previous parser read from this row's own subject.
 * Anything else was merged in from another subject (8 on prod, e.g. NESTLEIND
 * 2026-07-10 stores 5 where its subject says 2) and is reported, not written.
 * The pre-MONEY-1535 values need no arm of their own: that repair has run, and
 * none of the 405 corrections is attributable only to them.
 *
 * The 56 MONEY-1599 legs (source `NSE_REPARSE`) are not re-read here. They are
 * written from this same parser in the same run, so a later run finds them
 * equal. MONEY-1535's own repair, if run again, now reads through the same
 * parser too, so the two agree on every row. `repair-corporate-action-subjects.test.ts`
 * runs both planners over each other's result.
 */
import {
  dividendReading,
  namedDividendAmounts,
  parseActionSubject,
  parseCorporateActions,
  parseDividendPerShare,
  parseFaceValueSplit,
} from "../../packages/research/src/data-sources/nse-filings-logic";
import { readDate } from "./reanchor-corporate-action-dates-logic";
import { REPAIR_SOURCE } from "./repair-corporate-action-bonus-logic";

/** Every row this repair updates or inserts is recorded here first. */
export const BACKUP_COLLECTION = "corporate_actions_money1598_1599_1603_backup";

/**
 * `parseDividendPerShare` as it stood before MONEY-1603 (after MONEY-1535),
 * verbatim. It never decides a value; it recognises a stored amount this
 * parser, and nothing else, produced from the row's own subject.
 */
export function previousDividendPerShare(subject: string): number | null {
  const s = subject || "";
  if (!/dividend/i.test(s)) return null;
  const perShare = s.match(
    /\br[se]\.?\s*(?:-\s*)?(\d+(?:\.\d+)?)\s*(?:\/-)?\s*per\s+share/i,
  );
  const m = perShare ?? s.match(/\br[se]\.?\s*(?:-\s*)?(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export type RawDoc = Record<string, unknown>;

export type Role =
  | "SPLIT_FILL"
  | "SPLIT_CORRECT"
  | "RETYPE"
  | "DIVIDEND_INSERT"
  | "SPLIT_INSERT"
  | "BONUS_INSERT"
  | "DIVIDEND_FILL"
  | "DIVIDEND_CORRECT";

/** The leg types this repair inserts, and the role each is counted under. */
const LEG_ROLE: Partial<Record<string, Role>> = {
  DIVIDEND: "DIVIDEND_INSERT",
  SPLIT: "SPLIT_INSERT",
  BONUS: "BONUS_INSERT",
};
/** The roles `--restore` undoes by deleting the row. */
const INSERT_ROLES: ReadonlySet<string> = new Set(
  Object.values(LEG_ROLE).filter((r): r is Role => r !== undefined),
);

export interface Change {
  role: Role;
  id: string;
  /** `SYMBOL|EXCHANGE|YYYY-MM-DD` (IST day), for the report. */
  key: string;
  from: unknown;
  to: unknown;
  details: string;
}

export interface SubjectRepairPlan {
  changes: Change[];
  /** Compare-and-set `$set`s: SPLIT_FILL, SPLIT_CORRECT, RETYPE. */
  updates: Array<{ id: string; expect: RawDoc; set: RawDoc }>;
  inserts: RawDoc[];
  backup: Array<{ id: string; role: Role; doc: RawDoc; wrote: RawDoc }>;
  /** A stored split ratio the face value confirms (ASHOKA). */
  confirmed: string[];
  /** A stored ratio that differs from an `a:b` token, not a face value. */
  unattributed: Array<{ key: string; stored: unknown; parsed: number }>;
  /** The listing already has a row of the leg's type that day. */
  legPresent: Array<{
    key: string;
    type: string;
    stored: unknown;
    parsed: number | null;
  }>;
  /** The retype's target key is taken. */
  refused: Array<{ key: string; reason: string }>;
  /** MONEY-1603: a stored amount no parser of ours read from this subject. */
  dividendUnattributed: Array<{
    key: string;
    stored: unknown;
    parsed: number;
  }>;
  /** MONEY-1603: `NSE_REPARSE` legs, left to the repair that wrote them. */
  legsSkipped: number;
  /**
   * MONEY-1603 review: DIVIDEND rows whose subject names an amount the parser
   * cannot account for ("Rs 62..50"). Never filled or corrected with a part.
   */
  dividendUnread: Array<{ key: string; stored: unknown; unread: string[] }>;
}

const IST_OFFSET_MS = 19_800_000;

function idOf(doc: RawDoc): string {
  return (doc._id as { $oid: string }).$oid;
}

function istDay(v: unknown): string | null {
  const t = readDate(v);
  return t === null || !Number.isFinite(t)
    ? null
    : new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const six = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(6) : null;

function tokens(doc: RawDoc): string[] {
  return String(doc.source ?? "").split("+");
}

/** Only rows the NSE writer produced; this re-reads THEIR subjects. */
function fromNse(doc: RawDoc): boolean {
  return tokens(doc).includes("NSE");
}

/** A row a feed's parser wrote — MONEY-1603 re-reads every feed's dividend. */
function fromFeed(doc: RawDoc): boolean {
  return tokens(doc).some(
    (t) => t === "NSE" || t === "BSE" || t === "SCREENER",
  );
}

export function planSubjectRepair(
  docs: readonly RawDoc[],
  now: Date,
  newId: () => string,
): SubjectRepairPlan {
  const plan: SubjectRepairPlan = {
    changes: [],
    updates: [],
    inserts: [],
    backup: [],
    confirmed: [],
    unattributed: [],
    legPresent: [],
    refused: [],
    dividendUnattributed: [],
    legsSkipped: 0,
    dividendUnread: [],
  };
  const stamp = { $date: now.toISOString() };
  const taken = new Map<string, RawDoc>();
  const slot = (d: RawDoc, type: unknown): string | null => {
    const day = istDay(d.exDate);
    return day === null
      ? null
      : `${String(d.symbol)}|${String(d.exchange)}|${String(type)}|${day}`;
  };
  for (const d of docs) {
    const k = slot(d, d.type);
    if (k !== null) taken.set(k, d);
  }
  const update = (
    role: Role,
    doc: RawDoc,
    set: RawDoc,
    from: unknown,
    to: unknown,
  ): void => {
    const id = idOf(doc);
    const expect: RawDoc = { updatedAt: doc.updatedAt ?? null };
    for (const f of Object.keys(set)) expect[f] = doc[f] ?? null;
    const wrote = { ...set, updatedAt: stamp };
    plan.updates.push({ id, expect, set: wrote });
    plan.backup.push({ id, role, doc, wrote });
    plan.changes.push({
      role,
      id,
      key: keyOf(doc),
      from,
      to,
      details: String(doc.details),
    });
  };

  for (const doc of docs) {
    if (typeof doc.details !== "string") continue;
    const subject = doc.details;

    // ── MONEY-1603 ────────────────────────────────────────────────────────
    if (doc.type === "DIVIDEND") {
      if (!fromFeed(doc)) {
        if (tokens(doc).includes(REPAIR_SOURCE)) plan.legsSkipped++;
      } else {
        const parsed = parseDividendPerShare(subject);
        const stored = doc.dividendPerShare ?? null;
        const { unread } = dividendReading(subject);
        if (unread.length > 0) {
          plan.dividendUnread.push({ key: keyOf(doc), stored, unread });
        }
        if (parsed !== null && six(stored) !== six(parsed)) {
          const ours = six(previousDividendPerShare(subject)) === six(stored);
          if (stored === null) {
            update(
              "DIVIDEND_FILL",
              doc,
              { dividendPerShare: parsed },
              null,
              parsed,
            );
          } else if (ours && namedDividendAmounts(subject).length > 0) {
            update(
              "DIVIDEND_CORRECT",
              doc,
              { dividendPerShare: parsed },
              stored,
              parsed,
            );
          } else {
            plan.dividendUnattributed.push({
              key: keyOf(doc),
              stored,
              parsed,
            });
          }
        }
      }
    }
    if (!fromNse(doc)) continue;

    // ── MONEY-1598 ────────────────────────────────────────────────────────
    if (doc.type === "SPLIT") {
      const p = parseActionSubject(subject);
      const stored = six(doc.ratio);
      const parsed = six(p.ratio);
      const fields = {
        ratio: p.ratio,
        oldFaceValue: p.oldFaceValue,
        newFaceValue: p.newFaceValue,
      };
      if (parsed === null || stored === parsed) {
        if (
          parsed !== null &&
          doc.oldFaceValue == null &&
          p.oldFaceValue !== null
        ) {
          plan.confirmed.push(keyOf(doc));
        }
      } else if (stored === null) {
        update("SPLIT_FILL", doc, fields, null, p.ratio);
      } else if (parseFaceValueSplit(subject).ratio !== null) {
        update("SPLIT_CORRECT", doc, fields, doc.ratio, p.ratio);
      } else {
        plan.unattributed.push({
          key: keyOf(doc),
          stored: doc.ratio,
          parsed: p.ratio as number,
        });
      }
    }

    // ── MONEY-1599 ────────────────────────────────────────────────────────
    const emitted = parseCorporateActions(String(doc.symbol), [{ subject }]);
    if (doc.type === "BONUS" && !emitted.some((a) => a.type === "BONUS")) {
      const to = emitted[0]?.type ?? "OTHER";
      const target = slot(doc, to);
      if (target === null || taken.has(target)) {
        plan.refused.push({
          key: keyOf(doc),
          reason: `RETYPE_TARGET_TAKEN ${to}`,
        });
      } else {
        update("RETYPE", doc, { type: to, ratio: null }, "BONUS", to);
        taken.set(target, doc);
      }
    }
    for (const leg of emitted) {
      const role = LEG_ROLE[leg.type];
      if (role === undefined || leg.type === doc.type) continue;
      // A SPLIT row's bonus is MONEY-1542's, inserted by
      // repair-corporate-action-bonus.ts; counting it here too would make the
      // same row two tickets' work.
      if (leg.type === "BONUS" && doc.type === "SPLIT") continue;
      const target = slot(doc, leg.type);
      if (target === null) continue;
      const existing = taken.get(target);
      const value = leg.type === "DIVIDEND" ? leg.dividendPerShare : leg.ratio;
      if (existing) {
        plan.legPresent.push({
          key: keyOf(doc),
          type: leg.type,
          stored:
            leg.type === "DIVIDEND"
              ? existing.dividendPerShare
              : existing.ratio,
          parsed: value,
        });
        continue;
      }
      const id = newId();
      const row: RawDoc = {
        _id: { $oid: id },
        symbol: doc.symbol,
        isin: doc.isin ?? null,
        exchange: doc.exchange,
        type: leg.type,
        exDate: doc.exDate,
        recordDate: doc.recordDate ?? null,
        ratio: leg.ratio,
        oldFaceValue: leg.oldFaceValue,
        newFaceValue: leg.newFaceValue,
        dividendPerShare: leg.dividendPerShare,
        source: REPAIR_SOURCE,
        details: subject,
        gcsPath: doc.gcsPath ?? null,
        createdAt: doc.createdAt ?? stamp,
        updatedAt: stamp,
      };
      taken.set(target, row);
      plan.inserts.push(row);
      plan.backup.push({ id, role, doc: row, wrote: {} });
      plan.changes.push({
        role,
        id,
        key: keyOf(doc),
        from: doc.type,
        to: value,
        details: subject,
      });
    }
  }
  return plan;
}

function keyOf(doc: RawDoc): string {
  return `${String(doc.symbol)}|${String(doc.exchange)}|${istDay(doc.exDate) ?? "?"}`;
}

/**
 * The statements that record `entries` in {@link BACKUP_COLLECTION} —
 * MONEY-1603 review. The row as first read (`doc`, `role`) is written ONCE, so
 * a re-run after a failure never replaces the original with a half-repaired
 * copy. What this repair wrote (`wrote`) is written on EVERY run, because
 * `--restore` recognises a row by it: with `$setOnInsert` it kept the first
 * run's `updatedAt`, a re-run then wrote the rows the first had not reached
 * with its own, and every one of them read as changed-since and could not be
 * restored.
 */
export function backupStatements(
  entries: SubjectRepairPlan["backup"],
  now: Date,
): RawDoc[] {
  const stamp = { $date: now.toISOString() };
  return entries.map((b) => ({
    q: { _id: { $oid: b.id } },
    u: {
      $setOnInsert: { doc: b.doc, role: b.role, backedUpAt: stamp },
      $set: { wrote: b.wrote },
    },
    upsert: true,
  }));
}

/** The collection after `plan` is applied, in memory. */
export function simulateSubjectRepair(
  docs: readonly RawDoc[],
  plan: SubjectRepairPlan,
): RawDoc[] {
  const set = new Map(plan.updates.map((u) => [u.id, u.set]));
  return [
    ...docs.map((d) => {
      const s = set.get(idOf(d));
      return s ? { ...d, ...s } : d;
    }),
    ...plan.inserts,
  ];
}

/** A document in {@link BACKUP_COLLECTION}, as read back. */
export interface SubjectBackupDoc {
  _id: unknown;
  doc: RawDoc;
  role: string;
  wrote?: RawDoc;
}

/** Equal as stored: dates by instant, whatever their spelling. */
function same(a: unknown, b: unknown): boolean {
  const isDate = (v: unknown) =>
    v !== null && typeof v === "object" && "$date" in (v as object);
  if (isDate(a) || isDate(b)) return readDate(a) === readDate(b);
  return (a ?? null) === (b ?? null);
}

/**
 * The reversal. An update is put back field by field, and an insert is
 * deleted, only while the row still holds exactly what this repair wrote. A
 * row something has written to since is kept and listed.
 */
export function planSubjectRestore(
  backup: readonly SubjectBackupDoc[],
  current: ReadonlyMap<string, RawDoc>,
): {
  updates: Array<{ id: string; expect: RawDoc; set: RawDoc }>;
  deletes: Array<{ id: string; expect: RawDoc; set: RawDoc }>;
  changedSince: string[];
  gone: string[];
} {
  const out = {
    updates: [] as Array<{ id: string; expect: RawDoc; set: RawDoc }>,
    deletes: [] as Array<{ id: string; expect: RawDoc; set: RawDoc }>,
    changedSince: [] as string[],
    gone: [] as string[],
  };
  for (const b of backup) {
    const id = idOf(b.doc);
    const now = current.get(id);
    if (!now) {
      out.gone.push(id);
      continue;
    }
    // Every inserted leg is undone by deleting it, whatever its type: a
    // SPLIT_INSERT restored as an update would `$set` nothing and still count
    // as put back.
    if (INSERT_ROLES.has(b.role)) {
      const expect = { source: b.doc.source, updatedAt: b.doc.updatedAt };
      if (
        !same(now.source, expect.source) ||
        !same(now.updatedAt, expect.updatedAt)
      ) {
        out.changedSince.push(id);
      } else out.deletes.push({ id, expect, set: {} });
      continue;
    }
    const wrote = b.wrote ?? {};
    if (Object.keys(wrote).length === 0) {
      throw new Error(
        `backup entry ${id} (${b.role}) records no write — refusing to count it as restored.`,
      );
    }
    if (Object.keys(wrote).some((f) => !same(now[f], wrote[f]))) {
      out.changedSince.push(id);
      continue;
    }
    const set: RawDoc = {};
    for (const f of Object.keys(wrote)) set[f] = b.doc[f] ?? null;
    out.updates.push({ id, expect: wrote, set });
  }
  return out;
}
