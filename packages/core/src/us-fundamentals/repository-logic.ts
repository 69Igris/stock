/**
 * Every DECISION the US fundamentals seam makes, as pure functions
 * (MONEY-979, T10).
 *
 * NO Prisma, NO clock, NO network, NO environment. Each function is total over
 * plain objects, so `repository-logic.test.ts` drives the REAL implementation
 * rather than a re-declared copy of it — a test that restates the rule inline
 * is a shadow test and stays green when this file is deleted.
 *
 * `repository.ts` is the wiring: it queries, hands the rows here, and returns
 * what comes back.
 */

import type {
  UsCoverageFiler,
  UsCoverageJudgement,
  UsHolderDelta,
  UsHoldingRow,
  UsInsiderActivitySummary,
  UsInsiderClassTotal,
  UsInsiderCodeClass,
  UsInsiderRow,
  UsStatementRow,
} from "./types";

/* ─────────────────────────────────────────────────────────────────────────
   Small shared helpers
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A number, or `null` for anything that is not one.
 *
 * `NaN` and `Infinity` are rejected explicitly. This repo has chased non-finite
 * money poison ("₹NaN") through five subsystems; a `NaN` that reaches an
 * aggregate makes the WHOLE aggregate `NaN`, so one bad row silently voids a
 * portfolio total.
 *
 * ## `Number()` is NOT the coercion to use here
 *
 * `Number(null)` is **0**, and so are `Number("")`, `Number([])` and
 * `Number(false)`. A bare `Number.isFinite(Number(x))` therefore turns "this
 * filing reported no value" into "this filing reported zero" — which is the
 * exact distinction `UsInsiderRow.value` exists to preserve (a gift, code G,
 * has no price, and a 0 reads as a free transfer of nothing rather than an
 * untold value). Only a real number, or a non-blank numeric string, is a
 * number.
 */
function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ISO-8601, or `null`. Accepts `Date`, string and epoch ms alike. */
export function isoOrNull(
  value: Date | string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Epoch ms, or `null` for an unparseable date. */
function ms(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/* ═════════════════════════════════════════════════════════════════════════
   1. POINT-IN-TIME — the acceptance property of this whole branch
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Forms that report a FISCAL YEAR. `/A` is stripped before the lookup, so
 * `10-K/A` ranks as annual and loses the amendment tiebreak instead — which is
 * the documented order (form first, amendment second).
 */
const ANNUAL_FORM_BASES: ReadonlySet<string> = new Set([
  "10-K",
  "10-KT",
  "20-F",
  "40-F",
  "11-K",
]);

/** Forms that report a fiscal QUARTER. */
const QUARTERLY_FORM_BASES: ReadonlySet<string> = new Set(["10-Q", "10-QT"]);

/**
 * 2 for an annual form, 1 for a quarterly one, 0 for anything else.
 *
 * Higher wins. A 10-K and a 10-Q can carry the same `periodEnd` — the fourth
 * quarter's numbers appear in both — and when they were filed at the same
 * instant the ANNUAL one is the audited statement.
 */
export function usFormRank(form: string | null | undefined): number {
  const base = String(form ?? "")
    .trim()
    .toUpperCase()
    .replace(/\/A$/, "");
  if (ANNUAL_FORM_BASES.has(base)) return 2;
  if (QUARTERLY_FORM_BASES.has(base)) return 1;
  return 0;
}

/** The minimum a row must carry for `pickPointInTime` to rank it. */
export type PointInTimeRow = Pick<
  UsStatementRow,
  "periodEnd" | "filedAt" | "form" | "isAmendment" | "accession" | "isLatest"
>;

/**
 * ## The point-in-time read
 *
 * Given every `us_fundamentals` row for ONE `(cik10, statementType,
 * periodType)` across several `periodEnd`s and several `accession`s, return the
 * one row per period that a reader would have seen ON `asOf`.
 *
 * The acceptance test of this branch, stated as a property: **asked for a date
 * between two 10-Qs, this must return the OLDER filing's numbers.** Restatements
 * are not corrections to be applied over the old value — they are a second true
 * statement about the same period, made later. A backtest asking "what did the
 * market know on 2024-05-01" must see the number as filed THEN, which is
 * impossible once a writer has overwritten it. That is why `accession` is in
 * the unique key and why this function exists at all.
 *
 * Order of decision, exactly:
 *
 *   1. Drop everything with `filedAt > asOf`. A filing that had not happened
 *      yet is not information anyone had.
 *   2. Group what remains by `periodEnd`.
 *   3. Within a group, keep ONE: latest `filedAt` wins; on a tie a 10-K beats a
 *      10-Q; on a further tie a non-amendment beats an amendment; on a further
 *      tie the lexically greatest `accession`, purely so the answer is
 *      deterministic rather than dependent on Mongo's return order.
 *   4. Newest `periodEnd` first.
 *
 * With NO `asOf`, the question is "what is true now", and the writer has
 * already answered it: `isLatest` is recomputed for the affected group on every
 * write. The filter is applied HERE as well as in the query, so a caller that
 * hands over an unfiltered array gets the same answer as one that let Prisma
 * narrow it.
 *
 * A row whose `periodEnd` or `filedAt` will not parse is DROPPED, not thrown
 * on: one damaged row must not cost a whole company's history.
 */
export function pickPointInTime<T extends PointInTimeRow>(
  rows: readonly T[],
  asOf?: Date | string | null,
): T[] {
  const cutoff = asOf === undefined || asOf === null ? null : ms(asOf);

  const best = new Map<number, T>();
  for (const row of rows) {
    const periodEnd = ms(row.periodEnd);
    const filedAt = ms(row.filedAt);
    if (periodEnd === null || filedAt === null) continue;

    if (cutoff === null) {
      if (row.isLatest !== true) continue;
    } else if (filedAt > cutoff) {
      continue;
    }

    const incumbent = best.get(periodEnd);
    if (incumbent === undefined || beats(row, incumbent)) {
      best.set(periodEnd, row);
    }
  }

  return [...best.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => row);
}

/** True when `challenger` should replace `incumbent` for the same `periodEnd`. */
function beats(challenger: PointInTimeRow, incumbent: PointInTimeRow): boolean {
  const cf = ms(challenger.filedAt) ?? 0;
  const inf = ms(incumbent.filedAt) ?? 0;
  if (cf !== inf) return cf > inf;

  const cr = usFormRank(challenger.form);
  const ir = usFormRank(incumbent.form);
  if (cr !== ir) return cr > ir;

  // A non-amendment beats an amendment filed at the same instant.
  const ca = challenger.isAmendment === true ? 1 : 0;
  const ia = incumbent.isAmendment === true ? 1 : 0;
  if (ca !== ia) return ca < ia;

  return String(challenger.accession) > String(incumbent.accession);
}

/* ═════════════════════════════════════════════════════════════════════════
   2. 13F QUARTER-ON-QUARTER
   ════════════════════════════════════════════════════════════════════════ */

/**
 * The match key for a QoQ pairing.
 *
 * `cusip` ALONE is wrong for the read this exists to serve. "Top holders of
 * AAPL" is many managers against ONE cusip — keyed on cusip alone every
 * manager would collapse into a single row and the answer would be one
 * meaningless aggregate. The manager is therefore part of the key, which
 * degrades to plain cusip for `getManagerHoldings` (one manager, many cusips)
 * where every row shares a manager.
 */
function holderKey(
  row: Pick<UsHoldingRow, "managerCik10" | "cusip" | "putCall" | "sharesType">,
): string {
  // `putCall` and `sharesType` ARE part of the identity, and leaving them out
  // was a defect the docblock above already argued against.
  //
  // A 13F row is keyed `(accession, rowIndex)`, and one manager legitimately
  // files SEVERAL rows for one CUSIP: the share position, a Put, a Call, and —
  // for a bond — a PRN row whose "shares" are dollars of face value. Keyed on
  // manager|cusip alone they collide, and the collision does not merely
  // aggregate: `resolveQoQ` pairs the FIRST current row against the FIRST prior
  // row, so an unchanged share position gets diffed against an unchanged
  // options position.
  //
  // Measured on two quarters where nothing changed — 1,000,000 shares and
  // 50,000 calls in both — the call row reported `sharesDelta: -950,000`. The
  // mirror case is worse: a manager who exits the calls but keeps the shares
  // produces NO exit row at all, because the share row already claimed the key.
  //
  // ## This key is correct, and it is NOT unique per filed row
  //
  // SEC lets one manager file the same CUSIP once per `otherManagers`
  // combination — the co-managers who share investment discretion. Measured on
  // this repo's own Berkshire fixture (`thirteenf_post2023.txt.gz`): 89 filed
  // rows collapse to 29 keys, and 19 keys cover more than one row. Apple alone
  // is TWELVE rows under one key, identical in every field this key reads,
  // differing only in `otherManagers`, and totalling 227,917,808 shares.
  //
  // So rows sharing a key must be SUMMED, not de-duplicated — see
  // `aggregateHolders`. Adding `otherManagers` to the key instead would
  // "resolve" the collision by reporting Berkshire twelve separate times with
  // fractional stakes, which is technically distinct and useless: a 13F holder
  // IS the manager's total position in the security, and the row split is an
  // internal breakdown of who shares discretion over it.
  return `${row.managerCik10}|${row.cusip}|${row.putCall ?? ""}|${row.sharesType ?? ""}`;
}

/** One manager's whole position in one instrument, summed across filed rows. */
interface UsHolderPosition {
  /** A row of the winning accession, for the fields that do not vary. */
  row: UsHoldingRow;
  shares: number;
  valueUsd: number;
  /** How many filed rows this position sums. `> 1` is normal, not suspicious. */
  rowsAggregated: number;
}

/**
 * Filed rows → one position per `holderKey`. PURE and order-independent.
 *
 * TWO reductions, and conflating them is what produced the defect:
 *
 *   1. **Across accessions — newest WINS WHOLESALE.** A manager may amend a
 *      period. The amendment replaces the original filing entirely, so its rows
 *      must not be summed with the ones they supersede.
 *   2. **Within one accession — rows are SUMMED.** They are one position broken
 *      out by `otherManagers`.
 *
 * The previous code did only a degenerate form of (1) — newest row per key —
 * which silently performed (2) as "keep one, discard the rest": 60 of Berkshire's
 * 89 rows, 67%, never reached the diff.
 *
 * Ties on `filedAt` break on `accession` so the answer cannot depend on the
 * order MongoDB happened to return rows in.
 */
function aggregateHolders(
  rows: readonly UsHoldingRow[],
): Map<string, UsHolderPosition> {
  const positions = new Map<string, UsHolderPosition>();
  for (const row of rows) {
    const key = holderKey(row);
    const shares = finite(row.shares) ?? 0;
    const valueUsd = finite(row.valueUsd) ?? 0;
    const held = positions.get(key);

    if (held === undefined) {
      positions.set(key, { row, shares, valueUsd, rowsAggregated: 1 });
      continue;
    }
    if (row.accession === held.row.accession) {
      held.shares += shares;
      held.valueUsd += valueUsd;
      held.rowsAggregated += 1;
      continue;
    }
    const heldMs = ms(held.row.filedAt) ?? 0;
    const rowMs = ms(row.filedAt) ?? 0;
    const supersedes =
      rowMs > heldMs ||
      (rowMs === heldMs && row.accession > held.row.accession);
    if (supersedes) {
      positions.set(key, { row, shares, valueUsd, rowsAggregated: 1 });
    }
  }
  return positions;
}

/**
 * Pair a period's holdings against the previous period's.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   - present in both  → `sharesDelta` / `valueDelta`, possibly zero
 *   - present only now → `isNew`, deltas equal the whole position
 *   - **present only BEFORE → `isExited`, with NEGATIVE deltas and a zero
 *     position.** Dropping it is how a "top holders" list silently hides the
 *     seller: the manager who liquidated is exactly the manager a reader wants
 *     to know about, and an inner join makes them invisible.
 *
 * A PUT/CALL row is kept as its own row rather than folded into the share
 * position — an options position is not a share position, and aggregating them
 * misstates a stake.
 *
 * Sorted by current `valueUsd` descending, then by `|valueDelta|` descending.
 * Exits carry `valueUsd === 0` so they cluster at the end ranked by the size of
 * the exit; `getTopHolders` applies its limit PER BUCKET so a truncation can
 * never remove every seller.
 */
export function resolveQoQ(
  current: readonly UsHoldingRow[],
  previous: readonly UsHoldingRow[],
): UsHolderDelta[] {
  // Both sides are AGGREGATED first. Diffing filed rows directly compares one
  // arbitrary row against another arbitrary row: on the real Berkshire filing,
  // two IDENTICAL quarters reported a 740-million-share, $145-billion phantom
  // disposal, `reason: null`, `degraded: false`.
  const prior = aggregateHolders(previous);
  const now = aggregateHolders(current);

  const out: UsHolderDelta[] = [];

  for (const [key, position] of now) {
    const before = prior.get(key);
    const beforeShares = before?.shares ?? 0;
    const beforeValue = before?.valueUsd ?? 0;
    const row = position.row;

    out.push({
      managerCik10: row.managerCik10,
      managerName: row.managerName,
      cusip: row.cusip,
      symbol: row.symbol,
      issuerName: row.issuerName,
      // Carried because they are part of the identity: one manager can file a
      // share row AND a Call row for the same CUSIP, so two output rows can
      // share every other field. Without these a reader sees "APPLE INC" twice
      // with different numbers and no way to tell which is which.
      putCall: row.putCall,
      sharesType: row.sharesType,
      shares: position.shares,
      valueUsd: position.valueUsd,
      sharesDelta: position.shares - beforeShares,
      valueDelta: position.valueUsd - beforeValue,
      isNew: before === undefined,
      isExited: false,
      rowsAggregated: position.rowsAggregated,
      accession: row.accession,
      filedAt: row.filedAt,
      periodOfReport: row.periodOfReport,
      currency: "USD",
    });
  }

  for (const [key, before] of prior) {
    if (now.has(key)) continue;
    const row = before.row;
    out.push({
      managerCik10: row.managerCik10,
      managerName: row.managerName,
      cusip: row.cusip,
      symbol: row.symbol,
      issuerName: row.issuerName,
      putCall: row.putCall,
      sharesType: row.sharesType,
      shares: 0,
      valueUsd: 0,
      sharesDelta: -before.shares,
      valueDelta: -before.valueUsd,
      isNew: false,
      isExited: true,
      rowsAggregated: before.rowsAggregated,
      // The prior filing is the only evidence an exit has; citing the current
      // period's accession would cite a filing this row does not appear in.
      accession: row.accession,
      filedAt: row.filedAt,
      periodOfReport: row.periodOfReport,
      currency: "USD",
    });
  }

  // The last three terms are a TIE-BREAKER, not a business rule. Value and
  // |delta| alone are not a total order — two holders with identical positions
  // and identical (often zero) deltas then come back in whatever order MongoDB
  // returned the rows in, so the same data renders two different lists. The
  // components of `holderKey` make it total, because that key is unique per
  // position by construction. Same reasoning as `latest_rank` on the Python
  // side, which spells out why an answer must not depend on row order.
  return out.sort(
    (a, b) =>
      b.valueUsd - a.valueUsd ||
      Math.abs(b.valueDelta) - Math.abs(a.valueDelta) ||
      a.managerCik10.localeCompare(b.managerCik10) ||
      a.cusip.localeCompare(b.cusip) ||
      (a.putCall ?? "").localeCompare(b.putCall ?? "") ||
      a.sharesType.localeCompare(b.sharesType),
  );
}

/* ═════════════════════════════════════════════════════════════════════════
   3. SYMBOL NORMALISATION
   ════════════════════════════════════════════════════════════════════════ */

/**
 * SEC's spelling of a symbol → ours.
 *
 * SEC spells share classes with a SLASH (`BRK/B`) and so does OpenFIGI;
 * Tiingo's security master — which `us_instruments.symbol` mirrors — uses a
 * DASH (`BRK-B`, `SPG-P-J`), and carries no periods at all. Verified 2026-08-29
 * against prod: OpenFIGI returns ticker `BRK/B` for CUSIP 084670702 while our
 * row reads `BRK-B`.
 *
 * A DOT is normalised too (`BRK.B` → `BRK-B`), because that spelling arrives
 * from users and from most price vendors and would otherwise resolve to
 * nothing at all. The consequence is deliberate and worth stating: an Indian
 * symbol like `RELIANCE.NS` becomes `RELIANCE-NS`, which is in no US listing,
 * so it returns an EMPTY result with a named reason. That is the honest
 * outcome — the alternative, matching it to something, is how one company's
 * insider activity gets attached to another.
 */
export function normalizeSymbolForUs(
  symbol: string | null | undefined,
): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[/.]/g, "-");
}

/**
 * A CIK in any spelling → the zero-padded 10-digit form every EDGAR URL, bulk
 * filename and API path uses. Returns `null` for anything with no digits, so a
 * caller can never build a query out of an empty string (which in Prisma+Mongo
 * would simply match nothing, silently).
 */
export function padCik10(
  cik: string | number | null | undefined,
): string | null {
  const digits = String(cik ?? "").replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length > 10) return null;
  return digits.padStart(10, "0");
}

/* ═════════════════════════════════════════════════════════════════════════
   4. INSIDER ACTIVITY
   ════════════════════════════════════════════════════════════════════════ */

/**
 * SEC's `TransCodeList` → the class it belongs to.
 *
 * The 20 codes are the SEC spec's own, not the library's table (which is
 * missing K and L). `K` is not here at all because it is not a code: EDGAR
 * APPENDS it to a displayed code when `<equitySwapInvolved>` is true, and it
 * rides on `UsInsiderRow.equitySwap` as the flag it actually is.
 */
export const US_INSIDER_CODE_CLASS: Readonly<
  Record<string, UsInsiderCodeClass>
> = {
  P: "OPEN_MARKET_BUY",
  S: "OPEN_MARKET_SELL",
  A: "AWARD",
  F: "TAX_WITHHOLDING",
  G: "GIFT",
  M: "EXERCISE",
  X: "EXERCISE",
  // Everything else in the spec, named so a reader can see the list is
  // complete rather than truncated: C conversion · D disposition to issuer ·
  // E expiration of short derivative · H expiration of long derivative ·
  // I discretionary transaction · J other · L small acquisition · O
  // out-of-the-money exercise · U tender · W will/descent · Z voting trust.
  C: "OTHER",
  D: "OTHER",
  E: "OTHER",
  H: "OTHER",
  I: "OTHER",
  J: "OTHER",
  L: "OTHER",
  O: "OTHER",
  U: "OTHER",
  W: "OTHER",
  Z: "OTHER",
};

const ALL_CLASSES: readonly UsInsiderCodeClass[] = [
  "OPEN_MARKET_BUY",
  "OPEN_MARKET_SELL",
  "AWARD",
  "TAX_WITHHOLDING",
  "GIFT",
  "EXERCISE",
  "OTHER",
];

/** One class's code letter → its class. Unknown letters land in `OTHER`. */
export function classifyInsiderCode(
  code: string | null | undefined,
): UsInsiderCodeClass | null {
  const c = String(code ?? "")
    .trim()
    .toUpperCase();
  if (c === "") return null;
  return US_INSIDER_CODE_CLASS[c] ?? "OTHER";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Net shares and value by code CLASS over a trailing window.
 *
 * ## Why this is not one number
 *
 * "Net insider activity" summed across every code is meaningless, and worse
 * than meaningless because it looks authoritative. An `F` is shares WITHHELD BY
 * THE ISSUER to pay the tax on a vesting grant — a mechanical consequence of
 * compensation that the insider does not choose and does not sell into the
 * market. An `S` is an open-market sale. A `G` is a gift with no price at all.
 * Adding them turns every routine vesting event into "insider selling", which
 * is the single most common way this data is misread.
 *
 * `netOpenMarketShares` is therefore P minus S ONLY, and every other class is
 * reported beside it rather than folded into it.
 *
 * ## No clock
 *
 * This function has no access to `now` by design (a pure function that reads a
 * clock cannot be driven by a test). The window is anchored on the NEWEST
 * `transactionDate` in the input; `repository.ts` supplies the date filter when
 * a caller wants a window relative to today. With an empty input the anchor is
 * `null` and every total is zero — never `NaN`, never a throw.
 *
 * Signs come from `acquiredDisposed` (`A` positive, `D` negative). When it is
 * missing the code decides — P/A/M/X acquire, S/F/D/G dispose — and a row that
 * neither field can sign contributes 0 shares while still being COUNTED, so
 * `rowsCounted` never overstates what the totals are built from.
 */
export function summarizeInsiderActivity(
  rows: readonly UsInsiderRow[],
  windowDays: number,
): UsInsiderActivitySummary {
  const byClass = {} as Record<UsInsiderCodeClass, UsInsiderClassTotal>;
  const codeSets = {} as Record<UsInsiderCodeClass, Set<string>>;
  for (const cls of ALL_CLASSES) {
    byClass[cls] = { codes: [], rows: 0, shares: 0, value: null };
    codeSets[cls] = new Set<string>();
  }

  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 0;

  // Anchor: newest transaction date present. Holdings have none and never
  // move it.
  let anchor: number | null = null;
  for (const row of rows) {
    if (row.isHolding === true) continue;
    const t = ms(row.transactionDate);
    if (t !== null && (anchor === null || t > anchor)) anchor = t;
  }
  const floor =
    anchor === null || days === 0 ? null : anchor - days * MS_PER_DAY;

  let counted = 0;
  let skipped = 0;
  let earliest: number | null = null;
  const valueSeen = {} as Record<UsInsiderCodeClass, boolean>;
  for (const cls of ALL_CLASSES) valueSeen[cls] = false;

  for (const row of rows) {
    if (row.isHolding === true) {
      skipped++;
      continue;
    }
    const cls = classifyInsiderCode(row.transactionCode);
    if (cls === null) {
      skipped++;
      continue;
    }
    const t = ms(row.transactionDate);
    if (floor !== null && (t === null || t < floor)) {
      skipped++;
      continue;
    }

    counted++;
    if (t !== null && (earliest === null || t < earliest)) earliest = t;

    const bucket = byClass[cls];
    bucket.rows++;
    codeSets[cls].add(
      String(row.transactionCode ?? "")
        .trim()
        .toUpperCase(),
    );

    const sign = signForRow(row);
    const shares = finite(row.shares);
    if (shares !== null) bucket.shares += sign * Math.abs(shares);

    const value = finite(row.value);
    if (value !== null) {
      bucket.value = (bucket.value ?? 0) + sign * Math.abs(value);
      valueSeen[cls] = true;
    }
  }

  for (const cls of ALL_CLASSES) {
    byClass[cls].codes = [...codeSets[cls]].sort();
    if (!valueSeen[cls]) byClass[cls].value = null;
  }

  const buys = byClass.OPEN_MARKET_BUY;
  const sells = byClass.OPEN_MARKET_SELL;
  const netValue =
    buys.value === null && sells.value === null
      ? null
      : (buys.value ?? 0) + (sells.value ?? 0);

  return {
    windowDays: days,
    anchor: isoOrNull(anchor),
    from: isoOrNull(earliest),
    to: isoOrNull(anchor),
    rowsCounted: counted,
    rowsSkipped: skipped,
    byClass,
    netOpenMarketShares: buys.shares + sells.shares,
    netOpenMarketValue: netValue,
    currency: "USD",
  };
}

/** Acquisitions positive, disposals negative. `acquiredDisposed` first. */
const ACQUIRING_CODES: ReadonlySet<string> = new Set([
  "P",
  "A",
  "M",
  "X",
  "C",
  "W",
]);
const DISPOSING_CODES: ReadonlySet<string> = new Set(["S", "F", "D", "G", "U"]);

function signForRow(row: UsInsiderRow): number {
  const ad = String(row.acquiredDisposed ?? "")
    .trim()
    .toUpperCase();
  if (ad === "A") return 1;
  if (ad === "D") return -1;
  const code = String(row.transactionCode ?? "")
    .trim()
    .toUpperCase();
  if (ACQUIRING_CODES.has(code)) return 1;
  if (DISPOSING_CODES.has(code)) return -1;
  return 0;
}

/* ═════════════════════════════════════════════════════════════════════════
   5. COVERAGE
   ════════════════════════════════════════════════════════════════════════ */

/** How many fiscal years of statements a filer must have to count as covered. */
export const US_COVERAGE_TARGET_YEARS = 5;

/**
 * The coverage gate.
 *
 * ## Why the denominator is ELIGIBLE filers and not all of them
 *
 * Straight from the schema comment on `UsFiler.eligibleForCoverage`: a gate
 * that reads "95% of filers have 5+ years" fails every quarter a batch of SPACs
 * lists, because a company that IPO'd last year cannot have five years of
 * filings and no amount of engineering will give it any. That gate measures the
 * MARKET. A gate that reads "95% of filers who have 5+ years AT SEC have 5+
 * years HERE" measures US, which is the only thing a release can act on.
 *
 * So `pct` — the gate — is `eligibleCovered / eligible`. An ineligible filer is
 * SATISFIED when it has every year it has, and it is reported in
 * `ineligibleWithAllAvailable` rather than dragged into the gate.
 *
 * `overallPct` counts both buckets and exists so that "the ineligible filers
 * are fine too" is a MEASURED claim rather than an assumed one — an ineligible
 * filer that is missing years shows up there and nowhere else.
 *
 * ## Empty populations
 *
 * `eligible === 0` scores **100**, not 0 and not `NaN`. There is nothing in the
 * gate's population to fail, so the gate is vacuously satisfied. The other two
 * answers are both worse: 0 fails a release for a market condition, and `NaN`
 * fails SILENTLY in both directions — `NaN >= 95` is false and so is
 * `NaN < 95`, so a threshold check written either way reports the wrong thing
 * without erroring.
 */
export function judgeCoverage(
  filers: readonly UsCoverageFiler[],
): UsCoverageJudgement {
  let eligible = 0;
  let eligibleCovered = 0;
  let ineligible = 0;
  let ineligibleWithAllAvailable = 0;

  for (const f of filers) {
    const held = Math.max(0, finite(f.statementYears) ?? 0);
    const atSec = Math.max(0, finite(f.fiscalYearsOnFile) ?? 0);
    if (f.eligibleForCoverage === true) {
      eligible++;
      if (held >= US_COVERAGE_TARGET_YEARS) eligibleCovered++;
    } else {
      ineligible++;
      // "All the years it has" — an ineligible filer with 2 fiscal years at SEC
      // and 2 here is complete. A filer SEC shows zero years for is complete by
      // the same rule; there is nothing to fetch.
      if (held >= atSec) ineligibleWithAllAvailable++;
    }
  }

  const total = eligible + ineligible;
  const satisfied = eligibleCovered + ineligibleWithAllAvailable;

  return {
    eligible,
    eligibleCovered,
    ineligible,
    ineligibleWithAllAvailable,
    pct: eligible === 0 ? 100 : (eligibleCovered / eligible) * 100,
    overallPct: total === 0 ? 100 : (satisfied / total) * 100,
    filers: total,
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   6. 13F AMENDMENT RESOLUTION
   ════════════════════════════════════════════════════════════════════════ */

/** The cover-page facts `selectThirteenFAccessions` needs. */
export interface ThirteenFFilingRef {
  accession: string;
  filedAt: Date | string;
  isAmendment: boolean;
  /** `"RESTATEMENT"` | `"NEW HOLDINGS"` | null, as filed. */
  amendmentType: string | null;
  tier: string;
  coldPath: string | null;
}

/**
 * Which accessions make up ONE manager's portfolio for ONE period.
 *
 * A manager can file an original 13F-HR and then amend it, and the two
 * amendment types mean OPPOSITE things — straight from the schema: "RESTATEMENT
 * replaces the original's holdings; NEW HOLDINGS adds to them. Applying the
 * wrong one either doubles a portfolio or erases most of it."
 *
 * So: walk the filings oldest-first; a RESTATEMENT resets the set to itself,
 * anything else is added. An amendment whose type is UNKNOWN (null, or a
 * spelling we do not recognise) is treated as ADDITIVE and reported through
 * `ambiguous`, because the additive reading over-counts at worst while the
 * restating reading DELETES holdings that were really there — and a caller can
 * see the ambiguity instead of inheriting it silently.
 */
export function selectThirteenFAccessions(
  filings: readonly ThirteenFFilingRef[],
): {
  accessions: string[];
  /** Accessions whose amendment type could not be read. */
  ambiguous: string[];
  /** True when any contributing filing is COLD. */
  hasCold: boolean;
  coldPaths: string[];
} {
  const ordered = [...filings].sort(
    (a, b) =>
      (ms(a.filedAt) ?? 0) - (ms(b.filedAt) ?? 0) ||
      String(a.accession).localeCompare(String(b.accession)),
  );

  let active: ThirteenFFilingRef[] = [];
  const ambiguous: string[] = [];

  for (const f of ordered) {
    const type = String(f.amendmentType ?? "")
      .trim()
      .toUpperCase()
      .replace(/[_-]+/g, " ");
    if (f.isAmendment === true) {
      if (type === "RESTATEMENT") {
        active = [f];
        continue;
      }
      if (type !== "NEW HOLDINGS") ambiguous.push(f.accession);
      active.push(f);
      continue;
    }
    // A second ORIGINAL for the same period is not a thing the form allows;
    // treat the newer one as the portfolio rather than doubling it.
    active = [f];
  }

  const cold = active.filter((f) => String(f.tier).toUpperCase() === "COLD");
  return {
    accessions: active.map((f) => f.accession),
    ambiguous,
    hasCold: cold.length > 0,
    coldPaths: cold
      .map((f) => f.coldPath)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   7. STANDARDIZED CONCEPTS -> the research `FinancialStatement` shape
   ════════════════════════════════════════════════════════════════════════ */

/**
 * edgartools' STANDARD TAG → the `FinancialStatement` field it fills.
 *
 * ## The left-hand side is the TAG vocabulary, not the display vocabulary
 *
 * edgartools carries THREE vocabularies and they are easy to confuse, because
 * two of them are human-readable and one of those is not the one we store:
 *
 *   1. the raw us-gaap tag a filer used   — `CostOfGoodsAndServicesSold`
 *   2. `standard_tags`, its normalisation — `CostOfGoodsAndServicesSold`
 *   3. `display_name`, its English label  — `Cost of Revenue`
 *
 * The Python writer keys the stored `standardized` blob on `standard_concept`,
 * which is vocabulary (2) — see `app/parsers/financials_logic.py`, which skips
 * any line without one. So THIS TABLE MUST BE SPELLED IN VOCABULARY (2).
 *
 * It was originally written in vocabulary (3), sourced from
 * `edgar/xbrl/standardization/concept_mappings.json`. That file is real and the
 * spellings were genuinely verified against it — they were simply verified
 * against the wrong file, because the file that decides what gets STORED is the
 * 3.7 MB `gaap_mappings.json`. The two vocabularies overlap in exactly ONE
 * string, `Revenue`, so the defect rendered every US statement as revenue and
 * nothing else, while every fixture-based test stayed green because the
 * fixtures were written in the reader's own spelling.
 *
 * `US_EDGARTOOLS_STANDARD_TAGS` pins the membership: every key below is
 * asserted to exist in the 235-tag universe extracted from the pinned
 * edgartools build. That assertion fails loudly on all 32 keys against the
 * original table, and is what makes this table safe to hand-edit.
 *
 * Several tags map to one field on purpose, and the FIRST PRESENT one wins in
 * the order listed.
 *
 * ## `totalCash` is ordered by FEEDERS, and the bucket NAMES argue the opposite
 *
 * Both candidate buckets are impure, in opposite directions, and neither name
 * says so. Measured from `gaap_mappings.json`:
 *
 *   `CashAndMarketableSecurities`  <- `CashAndCashEquivalentsAtCarryingValue`
 *                                     conf 1.00, used by 74.4% of filers —
 *                                     plain, unrestricted cash. 58 feeders in
 *                                     total, some of them securities.
 *   `CashAndCashEquivalents`       <- `CashCashEquivalentsRestrictedCash...`
 *                                     conf 1.00, occ 72.7% — cash INCLUDING
 *                                     RESTRICTED cash. The plain
 *                                     `CashAndCashEquivalents` tag is only 8.1%.
 *
 * So the bucket whose name promises exactly cash is dominated by a
 * restricted-inclusive tag, and the bucket whose name mentions securities is
 * dominated by plain cash. `CashAndMarketableSecurities` is therefore FIRST: it
 * is exactly-cash more often, and the companyfacts writer resolves within a
 * bucket by upstream confidence (`app/sec/standardize.py`), which prefers the
 * cash tag over any security.
 *
 * This block previously said the reverse and called `CashAndCashEquivalents`
 * "the precise bucket". That was reasoning from the NAME — the identical
 * mistake that produced the vocabulary defect this whole table exists to fix.
 * Residual risk, stated rather than left to be rediscovered: a filer tagging
 * securities and no cash concept at all gets an upper bound.
 *
 * `_fallbacks` in the stored `standardized` blob records where a chain fired
 * upstream (`SalesRevenueNet` was deprecated 2018-01-31 and
 * `RevenueFromContractWithCustomerExcludingAssessedTax` replaced it, while
 * `Revenues` remains the sanctioned total for banks and insurers). It is
 * carried through to the tool's metadata rather than flattened away.
 */
export const US_CONCEPT_TO_STATEMENT_FIELD: ReadonlyArray<
  readonly [string, string]
> = [
  // ── income ──
  ["Revenue", "revenue"],
  ["CostOfGoodsAndServicesSold", "costOfRevenue"],
  ["GrossProfit", "grossProfit"],
  ["OperatingIncomeLoss", "operatingIncome"],
  ["NetIncome", "netIncome"],
  ["IncomeLossContinuingOperations", "netIncome"],
  ["ProfitLoss", "netIncome"],
  ["SellingGeneralAndAdminExpenses", "sga"],
  // ── balance sheet ──
  ["Assets", "totalAssets"],
  ["Liabilities", "totalLiabilities"],
  ["AllEquityBalance", "totalEquity"],
  ["CashAndMarketableSecurities", "totalCash"],
  ["CashAndCashEquivalents", "totalCash"],
  ["CurrentAssetsTotal", "currentAssets"],
  ["CurrentLiabilitiesTotal", "currentLiabilities"],
  ["Inventories", "inventory"],
  ["TradeReceivables", "receivables"],
  ["TradePayables", "payables"],
  ["RetainedEarnings", "retainedEarnings"],
  ["PlantPropertyEquipmentNet", "propertyPlantEquipment"],
  // ── cash flow ──
  ["DepreciationAmortizationCF", "depreciation"],
  ["DepreciationExpense", "depreciation"],
  ["NetCashFromOperatingActivities", "operatingCashFlow"],
  ["CapitalExpenses", "capitalExpenditure"],
];

/**
 * `LongTermDebt` + `ShortTermDebt` → `totalDebt`.
 *
 * There is no single standard tag for total debt, so it is a SUM of the two
 * that exist. Kept out of the table above because the table's rule is
 * first-present-wins and this one is additive; conflating the two rules is how
 * a total silently becomes whichever half happened to be listed first.
 *
 * THREE components, not two. `CurrentPortionOfLongTermDebt` is its own bucket,
 * fed by `LongTermDebtCurrent` (conf 0.987, 18.4% of filers), and omitting it
 * understated Apple by 12.5% — 86.3B against a true 98.7B. Current maturities
 * are debt; a filer that classifies them separately is the normal case, not an
 * edge case.
 *
 * They CANNOT double-count each other: each raw us-gaap tag resolves to exactly
 * one bucket, so one filed fact reaches at most one term of this sum. An
 * earlier version of this note worried about double counting, which was the
 * wrong direction entirely — the defect was an omission.
 *
 * PRECISION CAVEAT, measured rather than assumed: the buckets are OVERLOADED
 * upstream. `LongTermDebt` is reached from feeders whose `display_name` is any
 * of `Long-Term Debt`, `Long-Term Investments`, `Other Non-Operating
 * Non-Current Assets` and `Short-Term Debt`; `ShortTermDebt` likewise absorbs
 * `Other Non-Operating Current Assets`. That is edgartools' own mapping noise,
 * not ours, and it means `totalDebt` is an upper bound for a filer whose
 * balance sheet leans on those feeders.
 */
export const US_TOTAL_DEBT_CONCEPTS: readonly string[] = [
  "LongTermDebt",
  "ShortTermDebt",
  "CurrentPortionOfLongTermDebt",
];

/**
 * Fields of `FinancialStatement` that a SEC filing cannot supply, named so the
 * gap is LOUD.
 *
 * `ebitda` is not a GAAP concept, appears in no taxonomy, and edgartools has no
 * standard concept for it. It could be approximated as operating income plus
 * D&A — and that is exactly the "compensating" this repo has decided against:
 * if a writer cannot fill a column it drops the column and says so, rather than
 * building machinery to synthesise, attribute and guard a number nobody filed.
 * The tool ships this list in its metadata so the model states the absence
 * instead of quoting a derived figure as reported.
 */
export const US_STATEMENT_FIELDS_NOT_FILED: readonly string[] = ["ebitda"];

/** A `FinancialStatement`-shaped row, structurally typed to avoid a package cycle. */
export interface UsMappedStatement {
  period: string;
  endDate: string;
  accession: string;
  filedAt: string;
  form: string;
  fiscalYear: number;
  fiscalPeriod: string;
  currency: "USD";
  [field: string]: string | number | boolean | undefined;
}

/**
 * One `us_fundamentals` row → the `FinancialStatement` shape the existing
 * compute tools bind to (`packages/research/src/types.ts`).
 *
 * Two fields are DERIVED, and only these two, because each is an arithmetic
 * identity rather than an estimate:
 *
 *   - `grossProfit` = revenue - costOfRevenue, when the concept itself is
 *     absent and both inputs are present. Mirrors what `fetch-income-statement`
 *     already does for Yahoo, which nulls it for pure-services filers.
 *   - `freeCashFlow` = operatingCashFlow - |capitalExpenditure|.
 *
 * ## The capex SIGN
 *
 * SEC files `PaymentsToAcquirePropertyPlantAndEquipment` as a POSITIVE payment;
 * Yahoo reports capex NEGATIVE, and every existing consumer of
 * `FinancialStatement` was written against Yahoo. This emits it NEGATIVE so a
 * consumer that adds it to OCF gets the right answer, and the consumers that
 * `Math.abs()` it (`compute_fcf_yield`, `compute_capex_intensity`) are
 * unaffected either way.
 */
export function mapStandardizedToStatement(
  row: Pick<
    UsStatementRow,
    | "standardized"
    | "periodEnd"
    | "accession"
    | "filedAt"
    | "form"
    | "fiscalYear"
    | "fiscalPeriod"
  >,
): UsMappedStatement {
  const std = (row.standardized ?? {}) as Record<string, unknown>;
  const out: UsMappedStatement = {
    period: `${row.fiscalPeriod} ${row.fiscalYear}`.trim(),
    endDate: isoOrNull(row.periodEnd) ?? "",
    accession: row.accession,
    filedAt: isoOrNull(row.filedAt) ?? "",
    form: row.form,
    fiscalYear: row.fiscalYear,
    fiscalPeriod: row.fiscalPeriod,
    currency: "USD",
  };

  for (const [concept, field] of US_CONCEPT_TO_STATEMENT_FIELD) {
    if (out[field] !== undefined) continue; // first present concept wins
    const v = finite(std[concept]);
    if (v !== null) out[field] = v;
  }

  let debt: number | null = null;
  for (const concept of US_TOTAL_DEBT_CONCEPTS) {
    const v = finite(std[concept]);
    if (v !== null) debt = (debt ?? 0) + v;
  }
  if (debt !== null) out.totalDebt = debt;

  const revenue = numberOrUndefined(out.revenue);
  const costOfRevenue = numberOrUndefined(out.costOfRevenue);
  if (
    out.grossProfit === undefined &&
    revenue !== undefined &&
    costOfRevenue !== undefined
  ) {
    out.grossProfit = revenue - costOfRevenue;
  }

  const capex = numberOrUndefined(out.capitalExpenditure);
  if (capex !== undefined) out.capitalExpenditure = -Math.abs(capex);
  const ocf = numberOrUndefined(out.operatingCashFlow);
  if (
    out.freeCashFlow === undefined &&
    ocf !== undefined &&
    capex !== undefined
  ) {
    out.freeCashFlow = ocf - Math.abs(capex);
  }

  return out;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Newest `filedAt` across rows, ISO. `null` for an empty list. */
export function newestFiledAt(
  rows: ReadonlyArray<{ filedAt: Date | string }>,
): string | null {
  let best: number | null = null;
  for (const r of rows) {
    const t = ms(r.filedAt);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return isoOrNull(best);
}
