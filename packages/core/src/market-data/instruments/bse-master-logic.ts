/* =====================================================================
   BSE scrip master — pure parsing + enrichment planning  (MONEY-1093)
   ---------------------------------------------------------------------
   BSE's group letter is the only signal that can tell a bond from an
   equity on that exchange, and `classifyCashInstrument` reads it out of
   `InstrumentMapping.series`. The daily bhavcopy supplies it — but a
   bhavcopy only contains what TRADED that day: 4,845 rows against
   ~12,600 active BSE instruments. So coverage accumulates over ~10
   trading days, and the repair script has to keep being re-run until it
   does.

   The scrip master fixes that in one pass: it lists the whole active BSE
   universe with the group letter, the ISIN and the segment.

   ## Why this is an ENRICHER, not an InstrumentProvider

   `syncInstruments` upserts on `symbol_exchange`, so a provider whose
   symbols don't match ours CREATES rows rather than updating them. BSE
   hands us `scrip_id` (e.g. "ABB"); our BSE rows come from Kite's
   `tradingsymbol`. Those usually agree — but "usually" against 12,600
   rows is thousands of potential duplicate instruments, and the overlap
   could not be measured against prod here. An update-only enricher has
   no such failure mode: an unmatched master row is counted and reported,
   never written.

   ## What it deliberately does NOT write

   `Segment` states the class outright — measured on 2026-07-30:

     Debentures and Bonds  5,374
     Equity                4,994
     (blank)               1,119
     Commercial Papers       847
     MF                      265
     PreferenceShares         13

   That is better evidence than a group letter, and it is still not
   written to `instrumentType` here. This whole ticket exists because two
   writers quietly fought over one field (MONEY-1093: the nightly
   instrument sync reverting the price feed's series). Adding a second
   automatic `instrumentType` writer alongside the audited repair script
   would rebuild that exact shape.

   Writers to `instrumentType` on an EXISTING row, accurately (an earlier
   version of this note said "TWO", which was itself a correction of "ONE" and
   also wrong — so here they are, enumerated):

     1. the nightly bhavcopy metadata backfill — guarded, only ever moves a row
        OFF the stamped default, re-checked in the WHERE;
     2. `mintMissingTrustInstruments` — NSE series RR/IV only, guarded on
        isActive;
     3. `reclassify-instruments.ts` — the audited path: dry run, readiness gate,
        human confirmation, rollback snapshot.

   `ZerodhaInstrumentProvider.mapToUpdate` used to be a fourth and is no longer:
   it wrote any positively-identified type nightly, which flipped DEBT rows to
   ETF/REIT on a name match and oscillated against #3. It now writes neither
   `series` nor `instrumentType` on an existing row.

   The cost of that restraint is close to zero: groups F (6,489) and G
   (1,118) already account for 7,607 rows, which covers the non-equity
   population, so routing the decision through `series` loses almost no
   precision and keeps the audit trail intact.
   ===================================================================== */

import { classifyCashInstrument } from "./instrument-classification";
import type { CashInstrumentClass } from "./instrument-classification";

/** One row of BSE's `ListofScripData` response, normalised. */
export interface BseMasterRow {
  /** BSE trading symbol — matches our stored BSE `symbol` when it matches. */
  scripId: string;
  /** Numeric BSE scrip code, kept for diagnostics. */
  scripCode: string;
  name: string;
  /** Group letter: A/B/X/XT/T/M/MT/MS/Z/E/IF/P for equity, F/G for debt. */
  group: string;
  isin: string | null;
  /** BSE's own segment label — see the header note on why it is not written. */
  segment: string;
  status: string;
}

/** The raw JSON row shape, before normalisation. */
interface RawBseRow {
  SCRIP_CD?: unknown;
  Scrip_Name?: unknown;
  Status?: unknown;
  GROUP?: unknown;
  ISIN_NUMBER?: unknown;
  scrip_id?: unknown;
  Segment?: unknown;
}

/**
 * BSE wraps list payloads inconsistently: sometimes a bare array, sometimes
 * `{ Table: [...] }`, sometimes `{ Table: [...], Table1: [...] }` where Table1
 * holds paging metadata. The endpoint returns a bare array TODAY (measured
 * 2026-07-30), and the first version of this parser accepted only that — so the
 * day BSE wrapped it, the enricher would have reported "0 usable rows" forever
 * behind a `console.warn`.
 *
 * This knowledge already exists in `packages/research/src/data-sources/bse-client.ts`
 * and is duplicated here deliberately: `packages/research` depends on
 * `packages/core`, not the reverse, so core cannot import it. Hoisting the shared
 * helper INTO core (and having research import it) is the right follow-up; until
 * then these two must be kept in step.
 */
function extractBseRows(resp: unknown): Record<string, unknown>[] {
  if (Array.isArray(resp)) return resp as Record<string, unknown>[];
  if (!resp || typeof resp !== "object") return [];
  const obj = resp as Record<string, unknown>;
  // First non-empty `Table*` key, in declaration order.
  for (const key of Object.keys(obj)) {
    if (!/^Table\d*$/.test(key)) continue;
    const v = obj[key];
    if (Array.isArray(v) && v.length > 0) return v as Record<string, unknown>[];
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/**
 * Parse and normalise the scrip-master JSON.
 *
 * Drops rows with no `scrip_id` (nothing to match on) and rows that are not
 * Active. Never throws on a single bad row — a format wobble in one entry
 * should not lose the other 12,600.
 */
export function parseBseMasterJson(text: string): BseMasterRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const rows = extractBseRows(parsed);
  if (rows.length === 0) return [];

  const out: BseMasterRow[] = [];
  for (const raw of rows as RawBseRow[]) {
    if (!raw || typeof raw !== "object") continue;

    const scripId = str(raw.scrip_id).toUpperCase();
    if (!scripId) continue;

    const status = str(raw.Status);
    // We request status=Active, but never trust a filter we did not apply.
    if (status && status.toUpperCase() !== "ACTIVE") continue;

    const isin = str(raw.ISIN_NUMBER).toUpperCase();
    out.push({
      scripId,
      scripCode: str(raw.SCRIP_CD),
      name: str(raw.Scrip_Name),
      group: str(raw.GROUP).toUpperCase(),
      isin: isin || null,
      segment: str(raw.Segment),
      status,
    });
  }
  return out;
}

/**
 * BSE `Segment` → instrument class.
 *
 * NOT WIRED TO ANYTHING YET, and the previous comment overstated it by naming
 * a caller ("the repair script's diagnostics") that does not import it.
 *
 * It is kept rather than deleted because it encodes a real measurement — BSE's
 * own `Segment` field, which states the instrument class outright and is
 * stronger evidence than the group letter this module actually writes. When
 * `instrumentType` gains an audited automatic writer, this is the input it
 * should use. Until then it is exercised only by its tests, and calling that
 * out is more useful than a comment implying coverage it does not have.
 */
export const BSE_SEGMENT_CLASS: Record<string, CashInstrumentClass> = {
  Equity: "EQUITY",
  "Debentures and Bonds": "DEBT",
  "Commercial Papers": "DEBT",
  // Preference shares are equity in law and debt in behaviour (fixed coupon,
  // no upside). They are not comparable to ordinary shares on any per-share
  // metric, which is the thing misclassification breaks, so: DEBT. Only 13
  // rows either way.
  PreferenceShares: "DEBT",
};

/**
 * Best available class for a master row, for REPORTING.
 *
 * Order: a name-identifiable ETF/trust wins (it is true regardless of what
 * segment BSE files it under), then BSE's segment, then the group letter via
 * the shared classifier. Returns UNKNOWN rather than guessing — a blank
 * segment plus an unrecognised group is genuinely no information.
 */
export function classifyBseMasterRow(row: BseMasterRow): {
  klass: CashInstrumentClass;
  reason: string;
} {
  const viaClassifier = classifyCashInstrument({
    symbol: row.scripId,
    name: row.name,
    exchange: "BSE",
    series: row.group,
    // BSE's scrip master carries neither column, so `null` here is the honest
    // answer rather than an omission: it says "looked, not present", which is
    // what the rules need to distinguish from "the caller forgot".
    isin: null,
    segmentCode: null,
  });

  // Name-identifiable types are independent of the filing segment.
  if (
    viaClassifier.klass === "ETF" ||
    viaClassifier.klass === "REIT" ||
    viaClassifier.klass === "INVIT"
  ) {
    return viaClassifier;
  }

  const viaSegment = BSE_SEGMENT_CLASS[row.segment];
  if (viaSegment) {
    return { klass: viaSegment, reason: `bse-segment-${row.segment}` };
  }

  return viaClassifier;
}

/**
 * Is the BSE feed healthy, or did the group column change under us?
 *
 * Pure and exported because the wrong version of this shipped twice, both times
 * as an inline condition nobody could test:
 *
 *   1. It required `rejectedGroups > 0`, which cannot hold for the case it was
 *      written for — a renamed/removed GROUP column yields "" for every row, the
 *      shape check is skipped because the value is falsy, and nothing is ever
 *      rejected.
 *   2. It was then replaced with "matched rows but planned no writes", which is
 *      the signature of the CONVERGED steady state. Once every row has its
 *      series and ISIN there is nothing left to write, so that would have
 *      reported FAILED every night for ever after the system started working.
 *
 * The discriminator is whether the exchange still supplies a group letter at
 * all. A healthy converged run has groups on nearly every row and writes
 * nothing; a dead feed has groups on nearly none.
 *
 * Returns null when the feed looks healthy.
 */
export function diagnoseBseFeed(input: {
  rowCount: number;
  blankGroups: number;
  rejectedGroups: Map<string, number>;
  seriesGroupCount: number;
  /**
   * Rows that matched a stored instrument. The correct denominator for the
   * REJECTION share — see below.
   */
  matched: number;
}): string | null {
  const { rowCount, blankGroups, rejectedGroups, matched } = input;
  if (rowCount === 0) return null; // handled by the caller's 0-row branch

  const blankShare = blankGroups / rowCount;
  if (blankShare > 0.5) {
    return (
      `${blankGroups}/${rowCount} fetched rows have an EMPTY group ` +
      `(${Math.round(blankShare * 100)}%) — the GROUP column has probably been ` +
      `renamed or removed. That letter is the only signal separating a bond ` +
      `from an equity on BSE, so this run classified nothing even though it ` +
      `looks successful.`
    );
  }

  // Share of ROWS rejected, not `rejectedGroups.size > 0 && nothing written`.
  //
  // That earlier form was silenced by a single successful write: if BSE changes
  // the encoding and 12,611 rows are rejected while ONE row's new value happens
  // to be 1-2 uppercase letters and differs from stored, `seriesGroupCount`
  // becomes 1 and the check returned null — reported healthy with 99.99% of the
  // universe unclassifiable. The counts were already in the Map and were being
  // thrown away in favour of `.size`.
  const rejectedRows = [...rejectedGroups.values()].reduce((a, b) => a + b, 0);
  // Denominator is MATCHED rows, not fetched rows.
  //
  // `rejectedGroups` is only ever populated for a master row that matched a
  // stored instrument — the planner `continue`s on `!hit` before the shape check
  // runs — so dividing by every fetched row measures a numerator and a
  // denominator from different populations. With a low overlap the share is
  // diluted to nothing: 10 fetched, 2 matched, BOTH rejected is a 100% broken
  // encoding for everything this feed can actually see, and it scored 2/10 =
  // 20%, landing exactly on the threshold and returning null. Silent.
  const rejectedShare = matched > 0 ? rejectedRows / matched : 0;
  if (rejectedShare > 0.2) {
    return (
      `${rejectedRows}/${rowCount} rows (${Math.round(rejectedShare * 100)}%) ` +
      `had a group value the shape check rejected ` +
      `(${rejectedGroups.size} distinct, e.g. ` +
      `${[...rejectedGroups.keys()].slice(0, 3).join(", ")}) — BSE has probably ` +
      `changed the group encoding. Those rows cannot be classified.`
    );
  }

  // The two signals COMBINED.
  //
  // They were independent, so a split failure passed both: 50% blank groups plus
  // 20% rejected is 70% of the universe unclassifiable, and neither
  // single-signal threshold fired. A feed that cannot classify most of what it
  // sees is broken regardless of how the failure divides between "no group at
  // all" and "a group we do not recognise".
  //
  // Measured against MATCHED rows for the rejected half and fetched rows for the
  // blank half, since that is the population each is drawn from; the sum is an
  // upper bound on unusable share, which is the right side to err on for an
  // alert.
  const unusableShare = blankShare + rejectedShare;
  if (unusableShare > 0.5) {
    return (
      `${Math.round(unusableShare * 100)}% of the BSE master is unusable ` +
      `(${blankGroups}/${rowCount} rows blank, ${rejectedRows}/${matched} ` +
      `matched rows with an unrecognised group). Neither share alone crosses ` +
      `its own threshold, but together most of the feed cannot be classified.`
    );
  }

  return null;
}

/** The subset of a stored row this planner needs. */
export interface StoredBseInstrument {
  id: string;
  symbol: string;
  isin: string | null;
  series: string | null;
  /** Company name, used to corroborate the scrip_id/tradingsymbol identity. */
  name: string | null;
}

/**
 * Legal-form suffixes that differ between feeds and carry no identity.
 *
 * This is the whole reason a raw prefix comparison is not enough: BSE writes
 * "RELIANCE INDUSTRIES LTD" where our stored row says "Reliance Industries
 * Limited", and neither normalised form is a prefix of the other — they diverge
 * at LTD/LIMITED. An earlier revision of this function claimed that exact pair
 * as a case it tolerated. It did not: it rejected all five of the
 * same-company-different-spelling pairs it was tested against, which made
 * corroboration fail for essentially every row. Since a first run has no stored
 * ISIN either, that left the enricher writing NOTHING — an inert guard turned
 * into an inert feature.
 *
 * The unit tests did not catch it because the fixture used the SAME name string
 * on both sides, so every comparison was trivially equal.
 */
const LEGAL_SUFFIXES = [
  "PRIVATELIMITED",
  "PRIVATELTD",
  "PVTLIMITED",
  "PVTLTD",
  "LIMITED",
  "LTD",
  "CORPORATION",
  "CORP",
  "COMPANY",
  "INCORPORATED",
  "INC",
  "PLC",
];

/**
 * Company name reduced to its identifying part.
 *
 * Uppercase, drop everything that is not a letter or digit (so punctuation,
 * spacing and "&" vs "and" stop mattering), then strip a trailing legal form,
 * repeatedly — "FOO PRIVATE LIMITED" normalises through "FOOPRIVATELIMITED" to
 * "FOO".
 *
 * "AND" is folded to nothing along with the punctuation, which is what makes
 * "LARSEN & TOUBRO LTD" and "Larsen and Toubro Limited" agree.
 */
export function normaliseCompanyName(v: string | null | undefined): string {
  let out = (v ?? "")
    .toUpperCase()
    .replace(/\bAND\b/g, "")
    .replace(/[^A-Z0-9]/g, "");
  // Repeat: "PVT" + "LTD" arrive as separate suffixes on some feeds.
  for (let i = 0; i < 3; i++) {
    const before = out;
    for (const suffix of LEGAL_SUFFIXES) {
      if (out.length > suffix.length && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length);
        break;
      }
    }
    if (out === before) break;
  }
  return out;
}

/**
 * Do two company names, from two different feeds, describe the same company?
 *
 * Used to corroborate the `scrip_id === tradingsymbol` identity guess before
 * this feed is allowed to write `series` — a wrong `series` types a real equity
 * DEBT, after which the repair script clears its sector and industry.
 *
 * Deliberately STRICT: normalise away legal form and punctuation, then require
 * the results to be EQUAL. Verified against 16 real pairs of DIFFERENT
 * Indian listed companies that share a long prefix — RELIANCE INDUSTRIES vs
 * RELIANCE POWER, TATA STEEL vs TATA STEEL LONG PRODUCTS, BAJAJ FINANCE vs
 * BAJAJ FINSERV, JSW STEEL vs JSW ENERGY, HDFC BANK vs HDFC LIFE — none of
 * which corroborates.
 */
export function namesCorroborate(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = normaliseCompanyName(a);
  const y = normaliseCompanyName(b);
  // EQUALITY, not prefix.
  //
  // A prefix rule is wrong in both directions here, and both were measured:
  //   - it WRONGLY corroborated "TATA STEEL LTD" with "TATA STEEL LONG
  //     PRODUCTS LTD", and "TATA MOTORS LTD" with "TATA MOTORS FINANCE LTD" —
  //     genuinely different listed companies, where a false corroboration lets
  //     this feed write a wrong `series` and type a real equity DEBT;
  //   - and, combined with a 6-character floor, it REJECTED "ITC LTD" against
  //     "ITC Limited", because both normalise to a 3-character name.
  // Once the legal form is normalised away there is no reason to tolerate a
  // divergent tail: two feeds naming the same company produce the same string.
  if (x.length < 3 || y.length < 3) return false;
  return x === y;
}

/**
 * Shape a BSE group letter must have before it is written to `series`.
 *
 * `series` is what `classifyCashInstrument` reads, so writing an unvalidated
 * value across the whole BSE universe would be the module's own stated
 * anti-pattern: "a wrong default is more dangerous than a missing value,
 * because it cannot be detected by a null check". If BSE ever changes the
 * column's encoding, an unvalidated write puts garbage on ~12,600 rows, the
 * classifier then abstains on all of them, and only the ~4,845 that trade each
 * day can ever be repaired by the bhavcopy.
 *
 * Deliberately a SHAPE check rather than the known-groups allow-list: the live
 * master carries TS, ZP, IP, Y, R and SE, which the allow-list does not know
 * but which are real groups. Those should be stored (so the classifier can
 * abstain on them visibly and someone can read the circular), not discarded.
 */
const BSE_GROUP_SHAPE = /^[A-Z]{1,2}$/;

export interface BseMasterEnrichmentPlan {
  /** group letter → instrument ids to stamp with it. One updateMany each. */
  seriesGroups: Map<string, string[]>;
  /** ISIN writes, only where the stored value is absent. */
  isinUpdates: Array<{ id: string; isin: string }>;
  /**
   * Symbol matches whose `series` was withheld for lack of an independently
   * sourced ISIN to corroborate the scrip_id/tradingsymbol identity. Expected to
   * be LARGE on the first runs and to fall as bhavcopy fills ISINs for rows that
   * trade; a value that never falls means the feed is matching rows the price
   * path never sees.
   */
  uncorroborated: number;
  /** Master rows that matched nothing we store — reported, never created. */
  unmatched: number;
  /** Master rows that matched a stored row (whether or not anything changed). */
  matched: number;
  /**
   * Symbol matched but the ISINs disagree — positive evidence the match is
   * WRONG, so nothing is written for these. Reported, never guessed at.
   */
  isinConflicts: Array<{
    scripId: string;
    masterIsin: string;
    storedIsin: string;
  }>;
  /** Stored rows sharing one ISIN, so ISIN-fallback resolution is ambiguous. */
  duplicateStoredIsins: string[];
  /** Group values rejected by the shape check, with counts, for reporting. */
  rejectedGroups: Map<string, number>;
}

/**
 * Decide what to write. Pure, so the interesting properties are unit-tested
 * and the caller is only I/O.
 *
 * Matching is by symbol first, then ISIN — the same order the bhavcopy
 * resolver uses. UPDATE-ONLY by construction: every planned write names an id
 * that came out of `stored`, so an unmatched master row cannot become a row.
 */
export function planBseMasterEnrichment(
  rows: BseMasterRow[],
  stored: StoredBseInstrument[],
): BseMasterEnrichmentPlan {
  const bySymbol = new Map<string, StoredBseInstrument>();
  const byIsin = new Map<string, StoredBseInstrument>();
  const duplicateStoredIsins: string[] = [];
  /** ISINs shared by 2+ active rows — unusable for matching. */
  const ambiguousIsins = new Set<string>();
  for (const s of stored) {
    bySymbol.set(s.symbol.trim().toUpperCase(), s);
    const i = (s.isin ?? "").trim().toUpperCase();
    if (!i) continue;
    // A shared ISIN on the SAME exchange means a stale row was left active
    // after a rename, so which of the two is "the" row is genuinely unknown.
    //
    // The first version recorded the collision and then called `byIsin.set`
    // anyway — it reported the ambiguity and resolved it arbitrarily in the
    // same breath, and the last-wins entry was still used for matching. That
    // is not a guard. An ambiguous ISIN is now REMOVED from the map entirely,
    // so a master row falling back to ISIN simply does not match and is
    // counted as unmatched, which is the honest outcome.
    if (byIsin.has(i)) {
      duplicateStoredIsins.push(i);
      byIsin.delete(i);
      ambiguousIsins.add(i);
      continue;
    }
    if (ambiguousIsins.has(i)) continue;
    byIsin.set(i, s);
  }

  const seriesGroups = new Map<string, string[]>();
  const isinUpdates: Array<{ id: string; isin: string }> = [];
  /** Symbol matches with a usable group that could NOT be corroborated by a
   *  stored ISIN, so their `series` was deliberately not written. */
  let uncorroborated = 0;
  const seenSeries = new Set<string>();
  const seenIsin = new Set<string>();
  const isinConflicts: BseMasterEnrichmentPlan["isinConflicts"] = [];
  const rejectedGroups = new Map<string, number>();
  let unmatched = 0;
  let matched = 0;

  for (const row of rows) {
    const bySym = bySymbol.get(row.scripId);
    const hit = bySym ?? (row.isin ? byIsin.get(row.isin) : undefined);
    if (!hit) {
      unmatched++;
      continue;
    }

    // A symbol match with a DISAGREEING ISIN is evidence the match is wrong,
    // not a detail to ignore. This module's own header concedes that BSE's
    // `scrip_id` and Kite's `tradingsymbol` only "usually" agree and that the
    // overlap could not be measured — and both ISINs are already in hand here.
    //
    // Writing anyway is not a small error: a wrong `series` feeds
    // `classifyCashInstrument`, and if the mismatched group is F or G a REAL
    // EQUITY is typed DEBT, after which the repair script clears its
    // sector/industry — values that exist nowhere else and are excluded from
    // re-enrichment. Silent and unrecoverable. Skip and report.
    if (bySym && row.isin && bySym.isin) {
      const storedIsin = bySym.isin.trim().toUpperCase();
      if (storedIsin && storedIsin !== row.isin) {
        // Counted in `isinConflicts` only. It used to ALSO bump `unmatched`,
        // and the applier reports `recordsFailed: unmatched + isinConflicts` —
        // so every conflict was counted twice.
        isinConflicts.push({
          scripId: row.scripId,
          masterIsin: row.isin,
          storedIsin,
        });
        continue;
      }
    }
    matched++;

    // Series: only when it actually differs, so a settled universe is a no-op
    // rather than ~12k pointless writes a night.
    // Validate the SHAPE before it becomes `series`. Rejecting the group must
    // NOT also discard a perfectly valid ISIN, which a bare `continue` did.
    const groupUsable = !row.group || BSE_GROUP_SHAPE.test(row.group);
    if (!groupUsable) {
      rejectedGroups.set(row.group, (rejectedGroups.get(row.group) ?? 0) + 1);
    }

    // `series` requires POSITIVE corroboration of the symbol match.
    //
    // The identity here is `scrip_id === tradingsymbol`, which this module's own
    // header concedes only "usually" holds and could not be measured against
    // prod. The conflict check above is the corroboration — and it was INERT on
    // exactly the run that does the writing: it needs `bySym.isin`, and before
    // this ticket no BSE row had an ISIN at all (Kite's dump has no ISIN column;
    // only NSE got them, from EQUITY_L.csv). So on the first run the ~7,700 BSE
    // rows that did NOT trade that day — the illiquid bonds and stale listings,
    // precisely where a bad match is most likely — were written on an unverified
    // match, and from run 2 the stored ISIN equalled the master's by
    // construction, locking the identity in where the guard could never fire
    // again.
    //
    // So: no stored ISIN means the match is UNVERIFIED, and an unverified match
    // does not get to set `series`. That is the field a wrong match does real
    // damage through — it feeds `classifyCashInstrument`, and an F or G group on
    // a real equity types it DEBT, after which the repair script clears its
    // sector and industry, values that exist nowhere else.
    //
    // The corroborating ISIN must come from somewhere OTHER than this enricher,
    // or the check is circular. It does: `bhavcopy-sync` writes ISIN resolved by
    // symbol+exchange from the exchange's own daily file, which is authoritative.
    // Hence the ISIN write below was removed — see there.
    //
    // COVERAGE COST, stated plainly: a BSE row that has never traded since the
    // deploy has no ISIN, so it never gets a series from this enricher and stays
    // unclassified. It converges for anything that trades even once. The
    // alternative was classifying it on evidence we cannot check, which is how
    // a real equity ends up as a bond with its sector erased.
    const storedSeries = (hit.series ?? "").trim().toUpperCase();
    // Corroboration, by EITHER independent signal:
    //   - a stored ISIN that agrees (the conflict branch above already rejected
    //     the disagreeing case, so reaching here with both present IS agreement);
    //   - or the two feeds' company NAMES agreeing.
    // The name check is what keeps the documented design intact: BSE's master is
    // meant to give complete classification coverage after ONE run rather than
    // accumulating over ~10 trading days, and almost every row has a name on
    // both sides even when neither has an ISIN yet.
    const corroborated =
      Boolean(bySym?.isin && row.isin) || namesCorroborate(hit.name, row.name);
    if (
      groupUsable &&
      corroborated &&
      row.group &&
      row.group !== storedSeries &&
      !seenSeries.has(hit.id)
    ) {
      seenSeries.add(hit.id);
      const g = seriesGroups.get(row.group) ?? [];
      g.push(hit.id);
      seriesGroups.set(row.group, g);
    } else if (groupUsable && !corroborated && row.group) {
      uncorroborated++;
    }

    // ISIN: only when ABSENT, never overwritten, and only for a CORROBORATED
    // match.
    //
    // `DailyPrice` has no exchange column, so a wrong ISIN repoints an
    // instrument and writes another security's close onto it — the MONEY-1085
    // failure. Writing it on an unverified scrip_id/tradingsymbol guess is
    // exactly how that would happen, and it also used to make the conflict guard
    // circular: this feed supplied the very value the next run compared against,
    // so from run 2 `stored.isin === master.isin` held by construction and the
    // guard could never fire again.
    const storedIsin = (hit.isin ?? "").trim();
    if (corroborated && row.isin && !storedIsin && !seenIsin.has(hit.id)) {
      seenIsin.add(hit.id);
      isinUpdates.push({ id: hit.id, isin: row.isin });
    }
  }

  return {
    seriesGroups,
    isinUpdates,
    unmatched,
    matched,
    uncorroborated,
    isinConflicts,
    duplicateStoredIsins,
    rejectedGroups,
  };
}
