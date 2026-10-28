/**
 * NSE filings — pure parsing/normalisation logic (no network).
 *
 * Extracted from `nse-filings.ts` so the response-mapping that turns raw NSE
 * JSON rows into `NSEFiling` / `NSECorporateAction` can be unit-tested by
 * importing the REAL symbol (the fetchers — which do `ky` I/O — call these).
 *
 * MONEY-620 bug fix (Invalid-Date class): the previous inline mapping did
 * `new Date((row.an_dt as string) || Date.now())`. A malformed NON-EMPTY date
 * string (`"garbage"`, a partial value, etc.) is truthy, so it skipped the
 * `Date.now()` fallback and produced an `Invalid Date`. That poisons everything
 * downstream — sorting by `getTime()` yields `NaN`, and any consumer that calls
 * `filingDate.toISOString()` throws `RangeError: Invalid time value`. The
 * `safeDate*` helpers below validate the parsed date and fall back to `now`
 * (for required dates) or `null` (for optional ex/record dates).
 */

import type {
  NSEFiling,
  NSECorporateAction,
  CorporateActionType,
} from "./nse-filings-types";

/** Strip a trailing `.NS` / `.BO` suffix and upper-case the symbol. */
export function normalizeFilingSymbol(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
}

// ── Corporate-action subject parsing (shared NSE + Screener) ──────────────
//
// NSE delivers corporate actions as a single free-text `subject` field
// ("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 1/- Per
// Share", "Bonus 1:1", "Dividend - Rs 5 Per Share", "Buyback of Shares", …).
// The old parser kept only the upper-cased subject as `actionType` and dropped
// the ratio entirely. These helpers turn the subject into a structured
// {type, ratio, faceValue, dividendPerShare} so a SPLIT/BONUS can adjust
// cost-basis in the FIFO pairing (MONEY-840/844). Screener's corp-action cells
// share the same vocabulary, so the same helpers parse both sources.

/**
 * A "bonus" of debentures, NCRPS or preference shares — MONEY-1599. It issues
 * no equity, so it is not a BONUS: prod typed ZEEL's "Bonus Preference Shares
 * 21:1" BONUS 22 and divided the pre-2014 history by 22, and TVSHLTD's "Bonus
 * Ncrps 1:116" BONUS 1.0086. Global, for `replace`: every such mention goes.
 */
const NON_SHARE_BONUS =
  /\bbon(?:us)?[\s\-:\d]*(?:ncrps?|nrcps|debentures?|preference|dvr)/gi;

/**
 * NSE's oldest subjects abbreviate a face-value split "Spl" — MONEY-1603
 * review: "Spl-Rs10 To Rs2/Bonus-1:2" (EIHOTEL), "Fv Spl 100 To 10/Div150%"
 * (LMW). "Spl" is ALSO their special-dividend abbreviation ("Div-Fin
 * Rs.3+Spl Re1"); what tells them apart is a face-value CHANGE: an amount,
 * "to", another amount. The "to" may be glued to both ("Rs10tors2") but not
 * inside a word ("Into"). CASTEXTECH writes a dash instead, "Spl Rs10-Rs2";
 * that counts only with "Rs" after the dash, and it is the only "Spl" subject
 * on prod with a dash between two amounts.
 */
const SPL_FACE_VALUE =
  /\bspl\b[\s.:-]*(?:r[se]\.?\s*)?\d+(?:\.\d+)?\s*(?:\/-?)?\s*(?:(?<![a-z])to\s*(?:r[se]\.?\s*)?\d|-\s*r[se]\.?\s*\d)/i;

/**
 * Normalize a free-text corporate-action subject into a {@link
 * CorporateActionType}. Order matters: "Face Value Split" must beat the bare
 * "split" check, and "bonus" must beat "issue" (rights issue vs bonus issue).
 */
export function normalizeActionType(subject: string): CorporateActionType {
  const s = (subject || "").toLowerCase();
  if (!s.trim()) return "OTHER";
  // Buyback first — "buy back of equity shares" contains "shares" which other
  // branches don't key on, but keep it explicit and early.
  if (/buy\s*-?\s*back|buyback/.test(s)) return "BUYBACK";
  if (/demerge|de-merge|scheme of arrangement|spin\s*-?\s*off/.test(s)) {
    return "DEMERGER";
  }
  if (/amalgamat|\bmerger\b|merge with/.test(s)) return "MERGER";
  // Split — includes "face value split" / "sub-division" / "stock split".
  if (
    /split|sub\s*-?\s*division|subdivision/.test(s) ||
    SPL_FACE_VALUE.test(s)
  ) {
    return "SPLIT";
  }
  // "Bon" is NSE's bonus abbreviation ("Div-Rs.4.20 Pr Sh/Bon 1:1").
  if (/bonus|\bbon(?![a-z])/.test(s.replace(NON_SHARE_BONUS, ""))) {
    return "BONUS";
  }
  // Rights, including NSE's older abbreviations and its two persistent
  // misspellings ("Rigths-Eq 3:10@Prem Rs.30", "Rigts-Eq 13:20@Prem Rs140").
  // Safe to widen: RIGHTS is NOT in QTY_CHANGING_TYPES, so nothing here can
  // reach chart adjustment — the worst case is a mark on the wrong day.
  if (/rights?\b|\brght\b|\brht\b|rigths|rigts/.test(s)) return "RIGHTS";
  if (isDividendSubject(s)) return "DIVIDEND";
  return "OTHER";
}

/**
 * Does this subject describe a dividend?
 *
 * The full word `dividend` alone was the test, and NSE's pre-~2010 wording
 * abbreviates: `Agm/Div-Re. 3.50/- Pr Shr`, `Agm/Fin Div-Rs.2/- Per Sh`,
 * `Annual General Meeting/Div.Rs.9/- Per Share`. Those rows were FETCHED and
 * then classified OTHER, which the backfill filters out — so they were
 * discarded after being paid for. It is why ITC's stored dividends started at
 * 2010 despite it paying annually for decades, and why the whole abbreviated
 * era is undercounted market-wide: a live sample of 18 two-month windows across
 * 2004-2012 put ~1,000 real dividends in OTHER (MONEY-1189).
 *
 * The abbreviation is matched as a WORD so the frequent look-alikes stay out:
 * `sub-division` (already SPLIT, checked earlier), `divestment`, `individual`.
 * `Div150%` needs the digit branch because there is no boundary after `div`.
 *
 * Deliberately NOT widened into a catch-all. `Annual General Meeting` and bare
 * `Agm` are 3,308 of the ~4,300 sampled OTHER rows and are NOT dividends — an
 * AGM is a meeting, and only `Agm/Div-…` pairs one with a payout. Matching
 * "agm" would triple DIVIDEND with meetings.
 */
function isDividendSubject(s: string): boolean {
  return (
    // Full word, plus NSE's own recurring typo ("Agm/ Divdend-60%").
    /dividend|divdend/.test(s) ||
    // `Div-` / `Div.` / `Div ` / `Div/` as a standalone token…
    /\bdiv\b/.test(s) ||
    // …and `Div150%`, where a digit follows immediately so \b does not apply.
    /\bdiv\d/.test(s)
  );
}

/**
 * Parse a `a:b` style ratio token out of a subject for the given action type and
 * return the POST:PRE share-count multiplier (what one pre-action share becomes).
 *
 *   - BONUS "1:1"  → holder gets 1 new per 1 held → 2 total per 1 → 2
 *     BONUS "a:b"  → (a + b) / b
 *   - SPLIT "1:5"  → 1 share of old FV becomes 5 of new FV → 5
 *     SPLIT "a:b"  → b / a   (NSE writes split ratios as old:new, e.g. "1:5")
 *
 * Returns `null` when no `a:b` token is present (face-value splits carry the
 * ratio in the FV change instead — see {@link parseFaceValueSplit}).
 */
export function parseRatioToken(
  subject: string,
  type: CorporateActionType,
): number | null {
  const s = subject || "";
  // Match the FIRST "a:b" / "a : b" token. Bounded integers so we don't pick up
  // a time ("10:00") — corp-action ratios are small whole numbers.
  const m = s.match(/(\d{1,4})\s*:\s*(\d{1,4})/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return null;
  }
  if (type === "BONUS") {
    // a new shares for every b held → (a + b) total per b held.
    return (a + b) / b;
  }
  if (type === "SPLIT") {
    // NSE convention "1:5" = 1 old share → 5 new shares → multiplier b/a.
    return b / a;
  }
  // Other types don't use a share multiplier.
  return null;
}

/** "From Rs 10/- ... To Rs 1/-", "from rs.10 to rs.2". */
const FROM_FACE_VALUE =
  /from\s+r(?:s|e)\.?\s*(\d+(?:\.\d+)?)[^\d]*?(?<![a-z])to\s+r(?:s|e)\.?\s*(\d+(?:\.\d+)?)/i;

/**
 * NSE's older wording, which names no "From" — MONEY-1598. The FIRST amount
 * after the split keyword is the old face value (no digit may come between
 * them), then "to", then the new one: "Fv Split Rs.10/- To Rs.2/", "Fv
 * Split-Rs.10/-To Rs.2/-", "Split-Rs.10tors.2", "Split From 10/- To Face Value
 * 2/-". Prod held 156 NSE SPLIT rows in these forms with ratio null, and JBMA
 * and SHARONBIO at 1 (taken from their bonus's "1:1").
 */
const SPLIT_FACE_VALUE =
  /(?:split|sub\s*-?\s*division|subdivision|\bspl\b)[^\d]*?(?:r[se]\.?\s*)?(\d+(?:\.\d+)?)[^\d]*?(?:(?<![a-z])to\s*(?:face\s*value\s*)?(?:r[se]\.?\s*)?|-\s*r[se]\.?\s*)(\d+(?:\.\d+)?)/i;

/**
 * Parse a face-value split out of the subject. Returns the old/new face values
 * and the resulting share multiplier (oldFV / newFV, e.g. Rs 10 → Rs 1 ⇒ 10×).
 * Returns nulls when the pattern isn't present. The "From" form is tried
 * first, so every subject it read before MONEY-1598 reads the same.
 *
 * Also null when the subject names two face-value changes that DISAGREE: that
 * is two events or a typo, and neither is the parser's to pick. There are none
 * on prod (2026-09-23). This is what makes a parsed ratio safe to correct a
 * stored one with.
 */
export function parseFaceValueSplit(subject: string): {
  oldFaceValue: number | null;
  newFaceValue: number | null;
  ratio: number | null;
} {
  const s = subject || "";
  const m = s.match(FROM_FACE_VALUE) ?? s.match(SPLIT_FACE_VALUE);
  if (!m) return { oldFaceValue: null, newFaceValue: null, ratio: null };
  const readings = new Set(
    [FROM_FACE_VALUE, SPLIT_FACE_VALUE].flatMap((re) =>
      [...s.matchAll(new RegExp(re.source, "gi"))].map((x) =>
        (Number(x[1]) / Number(x[2])).toFixed(6),
      ),
    ),
  );
  if (readings.size > 1) {
    return { oldFaceValue: null, newFaceValue: null, ratio: null };
  }
  const oldFv = Number(m[1]);
  const newFv = Number(m[2]);
  if (
    !Number.isFinite(oldFv) ||
    !Number.isFinite(newFv) ||
    oldFv <= 0 ||
    newFv <= 0
  ) {
    return { oldFaceValue: null, newFaceValue: null, ratio: null };
  }
  return { oldFaceValue: oldFv, newFaceValue: newFv, ratio: oldFv / newFv };
}

/** Where a dividend is named, as `isDividendSubject` recognises one. */
const DIVIDEND_WORD = /dividend|divdend|\bdiv\b|\bdiv\d/i;

/**
 * Parse a per-share cash dividend ("Dividend - Rs 5 Per Share", "Interim
 * Dividend Rs.2.50", "Final Dividend - Re 1", BSE's "Interim Dividend - Rs. -
 * 7.0000") out of the subject. Returns `null` when no rupee amount is present
 * (some dividend rows are percentage-of-FV only), and when the subject names
 * an amount this cannot account for (see {@link dividendReading}).
 *
 * MONEY-1535 — `Rs`/`Re` must START a word. Unanchored, the pattern read the
 * tail of any word ending in "rs"/"re" followed by a number: Screener's "TDS
 * Communication To Shareholders 6 Aug - Final dividend Rs. 5/share" parsed as
 * Rs 6 ("shareholde-RS 6"), and prod's SUDARSCHEM 2026-08-11 dividend holds 6
 * where NSE says 5. The optional dash is BSE's spelling, "Rs. - 7.0000", which
 * the old pattern could not reach at all, leaving every BSE dividend null.
 */
export function parseDividendPerShare(subject: string): number | null {
  const r = dividendReading(subject);
  return r.unread.length > 0 ? null : r.amount;
}

/**
 * Each dividend the subject names WITH its amount, after totals are separated
 * from their parts and repeats collapsed — MONEY-1603. Empty when the subject
 * names none, or names an amount it cannot account for.
 */
export function namedDividendAmounts(subject: string): number[] {
  const r = dividendReading(subject);
  return r.unread.length > 0 ? [] : r.named;
}

/**
 * What a subject says a dividend pays — MONEY-1603.
 *
 * The amounts each dividend names are read where they are named
 * ({@link BOUND_DIVIDEND}) and SUMMED, because a subject naming two dividends
 * pays both on the one ex-date. That fixed two defects: the "Div"
 * abbreviation was never read (1,665 prod rows null), and a subject naming two
 * dividends kept one, the first amount followed by "per share" ("Final
 * Dividend - Rs 7/- + Special Dividend -Rs 3/- Per Share" read 3; RAJPALAYAM
 * 7.50 where 15 is right).
 *
 * A sum must not count a dividend twice (review of MONEY-1603, three prod
 * shapes):
 *   - a TOTAL followed by its parts in parentheses, or after "including": ITC
 *     "Dividend-Rs.8.50 Per Share (Including Special Dividend Of Rs.2/-)" is
 *     8.50, and GSKCONS "Dividend Rs.50/- (Special Dividend Rs.25/- ... And
 *     Final Dividend Rs.25/-)" is 50;
 *   - with three or more amounts, one that equals the sum of the others is the
 *     total;
 *   - the same kind at the same amount, named twice, is one dividend.
 *
 * `unread` lists every rupee amount in the subject's dividend clauses that the
 * reading could not account for. A reading with any is not trusted: a partial
 * sum is worse than none, because a fill-only repair would never correct it.
 *
 * Only a subject that names no amount against a dividend word falls back to
 * the first rupee amount, read from the first dividend onward, so another
 * action's amount earlier in the subject is never taken ("Rights 7:5@Premium
 * Rs.55 Per Share/.../Dividend Re.1/-" is 1). A unit trust's distribution is
 * read whole, as MONEY-1535 read it.
 */
export function dividendReading(subject: string): {
  amount: number | null;
  named: number[];
  unread: string[];
} {
  // NSE's decimal typos, each one number: "Rs 62..50", "Re 0..30", "Rs 0 .70".
  const s = (subject || "")
    .replace(/(\d)\s*\.\.\s*(\d)/g, "$1.$2")
    .replace(/(\d)\s+\.(\d)/g, "$1.$2");
  const none = { amount: null, named: [], unread: [] };
  const first = s.search(DIVIDEND_WORD);
  if (first < 0) return none;
  if (UNIT_DISTRIBUTION.test(s)) {
    return { ...none, amount: fallbackAmount(s)?.value ?? null };
  }

  const kept: Array<{ amount: number; kind: string; at: number; end: number }> =
    [];
  const read: Array<[number, number]> = [];
  let lastEnd = -1;
  let prevEnd = 0;
  for (const m of s.matchAll(BOUND_DIVIDEND)) {
    const group = m[1] !== undefined ? 1 : 2;
    const amount = Number(m[group]);
    const [at, end] = m.indices![group]!;
    read.push([m.index, end]);
    const from = Math.max(m.index - 20, prevEnd);
    prevEnd = end;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // A part of a total already named: inside a parenthesis that opened after
    // it, or after "including" since it.
    const open = s.lastIndexOf("(", at);
    // Only when the parenthesis opens BEFORE this dividend's own word: in
    // "Final Dividend (Rs 5) And Special Dividend (Rs 3)" each parenthesis
    // holds its own dividend's amount, and both are paid.
    const inParens = open > s.lastIndexOf(")", at) && open < m.index;
    const breakdown =
      (inParens && kept.some((k) => k.end <= open)) ||
      (lastEnd >= 0 && INCLUDING.test(s.slice(lastEnd, m.index)));
    if (breakdown) continue;
    kept.push({ amount, kind: kindOf(s, from, at), at, end });
    lastEnd = end;
  }

  if (kept.length === 0) {
    const fb = /dividend/i.test(s) ? fallbackAmount(s.slice(first)) : null;
    if (fb === null) return none;
    read.push([first + fb.at, first + fb.end]);
    return {
      amount: fb.value,
      named: [],
      unread: strayAmounts(s, first, read),
    };
  }
  const unread = strayAmounts(s, first, read);
  const six = (v: number) => v.toFixed(6);
  const total = (xs: number[]) =>
    Number(xs.reduce((a, b) => a + b, 0).toFixed(6));
  const amounts = kept.map((k) => k.amount);
  if (amounts.length >= 3) {
    // A bare "Dividend Rs 50" beside a special and a final summing to 50 is
    // their total. An "Interim Dividend Rs 10" beside a special and a final of
    // 5 each is a third dividend: a kind of its own is never a total.
    const i = amounts.findIndex(
      (a, j) =>
        kept[j]!.kind === "" &&
        six(a) === six(total(amounts.filter((_, k) => k !== j))),
    );
    if (i >= 0) return { amount: amounts[i]!, named: [amounts[i]!], unread };
  }
  const seen = new Set<string>();
  const named = kept
    .filter((k) => {
      const key = `${k.kind}|${six(k.amount)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((k) => k.amount);
  return { amount: total(named), named, unread };
}

/**
 * "per share" first, else the first rupee amount — MONEY-1535's reading — and
 * where in `text` that amount sits.
 */
function fallbackAmount(
  text: string,
): { value: number; at: number; end: number } | null {
  const perShare = text.match(
    /\br[se]\.?\s*(?:-\s*)?(\d+(?:\.\d+)?)\s*(?:\/-)?\s*per\s+share/i,
  );
  const m = perShare ?? text.match(/\br[se]\.?\s*(?:-\s*)?(\d+(?:\.\d+)?)/i);
  if (!m || m.index === undefined) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return { value: v, at: m.index, end: m.index + m[0].length };
}

/**
 * A unit trust's distribution names each part AFTER its amount ("Rs 11.22 Per
 * Unit Taxable Dividend & Rs 1.38 Per Unit Exempt Dividend", "Rs 1.388 In The
 * Form Of Dividend And Re 0.030 In The Form Of Interest"), so reading forward
 * from a keyword would take the NEXT part's amount. It names no dividend here.
 */
const UNIT_DISTRIBUTION = /\bper\s+unit\b|^\s*distribution\b/i;

/** Words that introduce the parts of a total just named. */
const INCLUDING = /\binclud|\bincl\b|inclusive\s+of|compris|consist/i;

/**
 * The kind of dividend whose amount is at `amountAt`: the last kind words
 * between `from` (a few words back, never into the previous dividend) and its
 * amount ("1st Interim", "Final", "Special", "Gld Jub"), or "" for a bare
 * "Dividend".
 */
function kindOf(s: string, from: number, amountAt: number): string {
  const words =
    s
      .slice(from, amountAt)
      .toLowerCase()
      .match(
        /\b(?:1st|2nd|3rd|4th|first|second|third|fourth|interim|int|final|fin|special|spl|sp|jubilee|jub|additional|ad)\b/g,
      ) ?? [];
  return words.slice(-2).join(" ");
}

/**
 * Rupee amounts in the subject's dividend clauses that no named dividend
 * accounts for — MONEY-1603 review. A clause is a "/"-separated part of the
 * subject from the first dividend onward; the part of it after another
 * action's word (a bonus, a split, rights, a premium, a face value, a scheme)
 * is that action's, and a total ("Rs 100 total", "Rs 55.75 crore") is not a
 * per-share amount.
 */
function strayAmounts(
  s: string,
  first: number,
  read: ReadonlyArray<[number, number]>,
): string[] {
  const out: string[] = [];
  let from = first;
  for (const part of s.slice(first).split(/\/(?!-)/)) {
    const cut = part.search(OTHER_ACTION_WORD);
    const clause = cut >= 0 ? part.slice(0, cut) : part;
    for (const m of clause.matchAll(RUPEE_AMOUNT)) {
      const at = from + m.index;
      if (read.some(([a, b]) => at >= a && at < b)) continue;
      out.push(m[0].trim());
    }
    from += part.length + 1;
  }
  return out;
}

const OTHER_ACTION_WORD =
  /\bbon(?:us)?\b|split|\bspl\b[\s.:-]*(?:r[se]\.?\s*)?\d+(?:\.\d+)?\s*(?:\/-?)?\s*(?<![a-z])to|sub\s*-?\s*division|\bright|\brght|\brhs\b|rigths|rigts|\bprem|face\s*value|\bfv\b|buy\s*-?\s*back|scheme|merger|demerger|amalgamat|record|interest|income|capital/i;
const RUPEE_AMOUNT =
  /(?<!per\s+(?:equity\s+)?shares?\s+of\s+)\br[se]\.?\s*-?\s*\d+(?:\.\d+)?(?!\d|\.\d|\s*(?:\/-)?\s*(?:crores?|cr\b|lakhs?|lacs?|total|mn\b|million|billion|bn\b|each\b))|(?<!\br[se]\.?\s*-?\s*)\b\d+(?:\.\d+)?(?=\s*(?:\/-|p(?:e)?r\.?\s*sh))(?!\s*\/-\s*each\b)/gi;

/**
 * A dividend named WITH its amount — MONEY-1603: "Dividend - Rs 5", "Special
 * Dividend Of Rs 100", BSE's "Dividend - Rs. - 7.0000", NSE's abbreviations
 * "Int Div-Rs 0.5" and "Div.Rs.9/-", and its typos "Divdend" and "Divided - Rs
 * 3.50". "Div" counts ONLY here, bound to an amount: "Div-100%" names none.
 *
 * The oldest subjects put the kind after the word, sometimes in parentheses,
 * and chain a second dividend with "+", "&" or "And": "Div-Fin Rs.2+Spl Re.1",
 * "Div-(Fin-Rs4.5+Spl-Rs1.5)", "Agm/Div-Rs10+Gld Jub-Rs10", "Dividend - Final
 * Rs 4/- And Special Re 1/-". A qualifier counts as a dividend only in those
 * places, so the split abbreviation in "Fv Spl-Rs10tors2" is not read as a
 * special dividend.
 *
 * An amount may omit "Rs" only where a rupee marker follows it: "Div-7.5/-",
 * "Spl-18 Pr Sh", "Div - 0.50 Per Share". Never before "%": "Div-50%" is a
 * percentage of face value. A total is not a per-share amount: "Dividend Rs
 * 100 total, Rs 5 per share" names 5. No digit may follow an amount either,
 * or the match would back off to "Rs 10" of "Rs 100 crore".
 */
const DIVIDEND_KIND = "(?:fin(?:al)?|int(?:erim)?|f|spl|special)\\b\\.?";
const CHAIN_KIND =
  "(?:spl\\.?\\s*div(?:idend)?|special(?:\\s+div(?:idend)?)?|spl|sp" +
  "|int(?:erim)?(?:\\s+div(?:idend)?)?|fin(?:al)?(?:\\s+div(?:idend)?)?" +
  "|ad(?:ditional)?\\.?\\s*div(?:idend)?|gld\\.?\\s*jub(?:ilee)?" +
  "|(?:golden|silver|diamond)\\s+jubilee(?:\\s+(?:year\\s+)?div(?:idend)?)?|f)\\b\\.?";
// Plain `+` concatenation, NOT template literals: the admin app's Next/SWC
// compile of this file dropped the text after `${DIVIDEND_KIND}` in a template
// (`\s*\)?)?`), producing "Invalid regular expression: Unterminated group" at
// page-data collection while Node, tsc and the research dist all read it right.
const BOUND_DIVIDEND = new RegExp(
  "(?:(?:\\b(?:dividends?|divdend|divided)|\\bdiv\\b\\.?)" +
    "(?:\\s*[-:]?\\s*\\(?\\s*" +
    DIVIDEND_KIND +
    "\\s*\\)?)?" +
    "|(?:[+&]|\\band\\b)\\s*" +
    CHAIN_KIND +
    ")" +
    "\\s*[-:]?\\s*\\(?\\s*(?:of\\s+)?" +
    "(?:\\br[se]\\.?\\s*(?:-\\s*)?(\\d+(?:\\.\\d+)?)" +
    "(?!\\d|\\.\\d|\\s*(?:crores?|cr\\b|lakhs?|lacs?|total|mn\\b|million|billion|bn\\b))" +
    "|(\\d+(?:\\.\\d+)?)(?=\\s*(?:\\/-|p(?:e)?r\\.?\\s*sh)))",
  "gid",
);

/**
 * The `a:b` a keyword names, and no other — MONEY-1599. The first token in the
 * subject used to be every action's ratio, so "Rights 1:3 / Bonus 1:1" read as
 * a bonus of 1:3. Between the keyword and its ratio only filler may sit ("Bonus
 * 1:1", "Bonus - 1:1", "Bonus issue 1:1", "Intdiv-Rs 3persh/Bonus1:1"), never
 * another action's word, and never "Debentures", "Ncrps" or "Preference": a
 * bonus of those issues no shares.
 */
const BONUS_CLAUSE =
  /\bbon(?:us)?(?![a-z])(?:(?!rights?\b|rigths|rigts|split|\bspl\b|sub\s*-?\s*division|div|buy\s*-?\s*back|scheme|ncrp|debenture|preference|dvr)[^:\d])*?\d{1,4}\s*:\s*\d{1,4}/i;
/**
 * The ratio written BEFORE the word, "1:1 Bonus", which the parser read before
 * MONEY-1599 bound ratios to their keywords. Only a dash or spaces may sit
 * between, so "Rights 1:2 / Bonus" does not lend the bonus the rights ratio,
 * and a ratio another keyword already owns is refused: in "Stock Split 1:5
 * Bonus" the 1:5 is the split's. Tried only when {@link BONUS_CLAUSE} finds
 * nothing.
 */
const BONUS_CLAUSE_AFTER =
  /\d{1,4}\s*:\s*\d{1,4}\s*-?\s*\bbon(?:us)?(?![a-z])/i;
/** The same for a split: "Stock Split 1:5", "Split (Sub-Division) 1:5". */
const SPLIT_CLAUSE =
  /(?:split|sub\s*-?\s*division|subdivision)(?:(?!rights?\b|rigths|rigts|\bbon|div(?!ision)|buy\s*-?\s*back|scheme)[^:\d])*?\d{1,4}\s*:\s*\d{1,4}/i;

/**
 * The BONUS a split subject also names — MONEY-1542. NSE files one event as
 * one subject, and when a company bonuses and splits on one ex-date that
 * subject names both: "Bonus 1:1 / Face Value Split From Rs.10/- To Re.1/-".
 * `normalizeActionType` checks split first, so the row was typed SPLIT and the
 * bonus was dropped. Measured on prod 2026-09-23: 31 NSE SPLIT rows, and no
 * NSE BONUS row for any of them, so gold's NSE series under-adjust by the bonus
 * (TITAN 10 where 20 is right, ONGC 3 where 6 is right).
 *
 * Returns the bonus's post:pre ratio when the subject's type is SPLIT and it
 * names a share bonus with a ratio, else null. The parser emits it as a second
 * row with the same ex-date. `@@unique([symbol, exchange, type, exDate])`
 * allows a SPLIT and a BONUS on one day, and every consumer multiplies factors
 * per type, so TITAN composes to 10 x 2 = 20.
 */
export function combinedBonusRatio(subject: string): number | null {
  if (normalizeActionType(subject) !== "SPLIT") return null;
  return bonusRatio(subject);
}

/** A bonus's ratio, bound to its keyword on either side. */
function bonusRatio(subject: string): number | null {
  const bound = boundRatio(BONUS_CLAUSE, subject, "BONUS");
  if (bound !== null) return bound;
  const after = BONUS_CLAUSE_AFTER.exec(subject || "");
  if (!after) return null;
  if (OWNS_A_RATIO.test(subject.slice(0, after.index))) return null;
  return parseRatioToken(after[0], "BONUS");
}

/** Another action's keyword with nothing but filler before a ratio. */
const OWNS_A_RATIO =
  /(?:split|sub\s*-?\s*division|subdivision|\bspl\b|rights?\b|rigths|rigts|\brght|\brhs\b|scheme|buy\s*-?\s*back|bon(?:us)?(?![a-z]))[^:\d]*$/i;

/** The ratio in the clause `clause` finds, or null when it finds none. */
function boundRatio(
  clause: RegExp,
  subject: string,
  type: CorporateActionType,
): number | null {
  const m = clause.exec(subject || "");
  return m ? parseRatioToken(m[0], type) : null;
}

/**
 * The DIVIDEND a subject of another type also names — MONEY-1599. Like the
 * bonus above, it was dropped: "Bonus 1:1/Div-Rs.5 Per Sh" stored a BONUS and
 * nothing else. Prod held 56 NSE rows of this shape on 2026-09-23 (BONUS 32,
 * SPLIT 10, RIGHTS 7, DEMERGER 4, BUYBACK 3).
 *
 * Returns the leg, or null when there is none. Its amount is exactly what
 * `parseDividendPerShare` reads from the whole subject, which never takes
 * another action's amount ("Rights 7:5@Premium Rs.55 Per Share/.../Dividend
 * Re.1/-" is 1). So a leg stored from this, re-read later by any repair, reads
 * the same. Null for a percentage, exactly as for a stand-alone dividend row.
 */
export function combinedDividendLeg(
  subject: string,
): { dividendPerShare: number | null } | null {
  const s = subject || "";
  if (normalizeActionType(s) === "DIVIDEND") return null;
  if (s.search(DIVIDEND_WORD) < 0) return null;
  return { dividendPerShare: parseDividendPerShare(s) };
}

/**
 * Full structured parse of a free-text corporate-action subject. Combines the
 * helpers above into the normalized fields that map onto the `CorporateAction`
 * Prisma row. Shared by the NSE parser and the Screener scraper so both sources
 * normalize identically before they're merged + deduped.
 */
export function parseActionSubject(subject: string): {
  type: CorporateActionType;
  ratio: number | null;
  oldFaceValue: number | null;
  newFaceValue: number | null;
  dividendPerShare: number | null;
} {
  const type = normalizeActionType(subject);
  let ratio: number | null = null;
  let oldFaceValue: number | null = null;
  let newFaceValue: number | null = null;
  let dividendPerShare: number | null = null;

  if (type === "SPLIT") {
    // A face-value split carries the ratio in the FV change; a "stock split a:b"
    // carries it in the token. Try FV first, fall back to the token. The
    // fallback never reads a bonus's token (MONEY-1542): prod's JBMA subject
    // "Bonus 1:1 And Face Value Split Rs.10/- To Rs.5/-" stored SPLIT 1 from
    // it, where the split is 2.
    const fv = parseFaceValueSplit(subject);
    oldFaceValue = fv.oldFaceValue;
    newFaceValue = fv.newFaceValue;
    ratio = fv.ratio ?? boundRatio(SPLIT_CLAUSE, subject, type);
  } else if (type === "BONUS") {
    ratio = bonusRatio(subject);
  } else if (type === "DIVIDEND") {
    dividendPerShare = parseDividendPerShare(subject);
  }

  return { type, ratio, oldFaceValue, newFaceValue, dividendPerShare };
}

/**
 * Parse a required filing date. Accepts a raw value that may be a date string,
 * a number, undefined, or malformed. Returns a VALID `Date`, falling back to
 * `now` when the input is missing OR unparseable (the Invalid-Date guard).
 * Same rules as {@link safeOptionalDate}: NSE's zoneless `an_dt` /
 * `broadcastDt` are IST wall-clock (MONEY-1536).
 */
export function safeFilingDate(raw: unknown, now: number = Date.now()): Date {
  return safeOptionalDate(raw) ?? new Date(now);
}

/** Matched on the first three letters, so "Sept" and "March" resolve too. */
const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const IST_OFFSET_MS = 19_800_000;

/**
 * A ZONELESS exchange value as the instant it names — MONEY-1530, MONEY-1536.
 *
 * Every date NSE and BSE send is Indian wall-clock with no zone, and
 * ECMAScript resolves a zoneless value in the PROCESS'S LOCAL TIME, so the
 * instant stored depended on the machine that parsed it.
 *
 * DATE-ONLY values are calendar days and land on UTC midnight of that day,
 * where `isoDayToUtcDate` (Tiingo) and `parseScreenerActionDate` already anchor
 * theirs. Measured on prod `corporate_actions` 2026-09-23 the local-time parse
 * had written 11,000 ex-dates at 00:00Z (Cloud Run, TZ unset = UTC) and 48,224
 * at 18:30Z the day before (a laptop in IST), and 1,772 events TWICE, because
 * `@@unique([symbol, exchange, type, exDate])` keys on the instant:
 *
 *     "08-Sep-2026"   NSE exDate / recDate   9,142 of 9,142 archived rows
 *     "01 Sep 2026"   BSE Ex_date / RD_Date  3,270 of 3,270 rows, two live windows
 *     "2026-09-08"    ISO                    every fixture in this repo
 *     "08-09-2026"    NSE's own query format, read DAY-first as `parseNSEDate`
 *                     reads it. V8 reads it MONTH-first, in local time.
 *
 * DATE-AND-TIME values are the IST instant they name — on Cloud Run the local
 * parse stored them 5h30m late:
 *
 *     "22-Sep-2026 21:10:18"     NSE an_dt / broadcastDt  1,112 of 1,112 archived an_dt
 *     "2026-09-22T23:58:45.357"  BSE NEWS_DT              50 of 50 live rows
 *
 * `undefined` for anything else — a value with a zone, or not a date at all —
 * so it keeps the parse it always had. `null` for a shape naming a moment that
 * does not exist: V8 rolls "31-Feb-2024" over to 2 March and 25:00 into the
 * next day, which would store a date nobody announced.
 */
function parseExchangeDate(raw: string): Date | null | undefined {
  const s = raw.trim();
  const named =
    /^(\d{1,2})[-\s]([a-z]{3})[a-z]*\.?[-\s](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/i.exec(
      s,
    );
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(
      s,
    );
  const numeric = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  let day: [number, number, number];
  let time: Array<string | undefined> = [];
  if (named) {
    const month = MONTH_INDEX[named[2]!.toLowerCase()];
    if (month === undefined) return null;
    day = [Number(named[3]), month, Number(named[1])];
    time = named.slice(4, 8);
  } else if (iso) {
    day = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    time = iso.slice(4, 8);
  } else if (numeric) {
    day = [Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1])];
  } else {
    return undefined;
  }
  const [y, m, d] = day;
  const [hh, mm, ss, frac] = time;
  const parts = [y, m, d, Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0)];
  // Any precision, TRUNCATED to milliseconds (MONEY-1536 review): BSE's .NET
  // serialiser sends `…:45.3570000`, and a pattern capped at three digits sent
  // that value back to the process-local `new Date(raw)` this parser replaces.
  const ms = frac === undefined ? 0 : Number(frac.slice(0, 3).padEnd(3, "0"));
  const wall = Date.UTC(y, m, d, parts[3]!, parts[4]!, parts[5]!, ms);
  const back = new Date(wall);
  const real = [
    back.getUTCFullYear(),
    back.getUTCMonth(),
    back.getUTCDate(),
    back.getUTCHours(),
    back.getUTCMinutes(),
    back.getUTCSeconds(),
  ];
  if (real.some((v, i) => v !== parts[i])) return null;
  return hh === undefined ? back : new Date(wall - IST_OFFSET_MS);
}

/**
 * Parse an OPTIONAL date (ex-date / record-date / BSE `NEWS_DT`). Returns
 * `null` when the input is missing OR unparseable — never an `Invalid Date`. A
 * zoneless exchange value follows {@link parseExchangeDate}; anything else is
 * parsed as before.
 */
export function safeOptionalDate(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = typeof raw === "string" ? parseExchangeDate(raw) : undefined;
  if (parsed !== undefined) return parsed;
  const d = new Date(raw as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map the raw `corporates-announcements` rows into `NSEFiling[]`. */
export function parseAnnouncements(
  symbol: string,
  resp: unknown,
  now: number = Date.now(),
): NSEFiling[] {
  const clean = normalizeFilingSymbol(symbol);
  if (!Array.isArray(resp)) return [];

  return resp.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      symbol: clean,
      title: (row.desc as string) || "",
      description: (row.attchmntText as string) || "",
      attachmentUrl: (row.attchmntFile as string) || null,
      filingDate: safeFilingDate(row.an_dt, now),
      category: (row.smIndustry as string) || "General",
    };
  });
}

/** Map the raw `corporates-financial-results` payload into `NSEFiling[]`. */
export function parseFinancialResults(
  symbol: string,
  resp: { results?: unknown[] } | null | undefined,
  now: number = Date.now(),
): NSEFiling[] {
  const clean = normalizeFilingSymbol(symbol);
  if (!resp?.results || !Array.isArray(resp.results)) return [];

  return resp.results.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      symbol: clean,
      title: `Financial Results - ${row.period || ""}`,
      description: `${row.resultType || ""} results for ${row.period || ""}`,
      attachmentUrl: (row.pdfLink as string) || null,
      filingDate: safeFilingDate(row.broadcastDt, now),
      category: "Financial Results",
    };
  });
}

/**
 * Map the raw `corporates-corporateActions` rows into `NSECorporateAction[]`.
 * One raw row yields more than one action when its subject names a split and
 * a bonus ({@link combinedBonusRatio}) or a dividend beside another action
 * ({@link combinedDividendLeg}), so the result can be longer than `resp`.
 */
export function parseCorporateActions(
  symbol: string,
  resp: unknown,
): NSECorporateAction[] {
  const clean = normalizeFilingSymbol(symbol);
  if (!Array.isArray(resp)) return [];

  return resp.flatMap((item) => {
    const row = item as Record<string, unknown>;
    const subject = (row.subject as string) || "";
    const parsed = parseActionSubject(subject);
    const action: NSECorporateAction = {
      symbol: clean,
      actionType: subject.toUpperCase(),
      type: parsed.type,
      exDate: safeOptionalDate(row.exDate),
      recordDate: safeOptionalDate(row.recDate),
      ratio: parsed.ratio,
      oldFaceValue: parsed.oldFaceValue,
      newFaceValue: parsed.newFaceValue,
      dividendPerShare: parsed.dividendPerShare,
      details: subject,
      rawData: row,
    };
    const out: NSECorporateAction[] = [action];
    const bonus = combinedBonusRatio(subject);
    if (bonus !== null) {
      out.push({
        ...action,
        type: "BONUS",
        ratio: bonus,
        oldFaceValue: null,
        newFaceValue: null,
      });
    }
    const dividend = combinedDividendLeg(subject);
    if (dividend !== null) {
      out.push({
        ...action,
        type: "DIVIDEND",
        ratio: null,
        oldFaceValue: null,
        newFaceValue: null,
        dividendPerShare: dividend.dividendPerShare,
      });
    }
    return out;
  });
}

/**
 * MONEY-784 (P3b) — the useful NSE announcement docType buckets. `null` means
 * "not worth ingesting" (the announcement feed is mostly noise: board-meeting
 * intimations, trading-window closures, newspaper publications, etc.).
 *
 * Kept as plain strings (not the `StockDocType` import) so this logic file stays
 * free of the worker/path dependency; the worker maps the string straight onto
 * `StockDocType` (every value here is a member of that union).
 */
export type NseAnnouncementDocType =
  | "annual_report"
  | "investor_presentation"
  | "credit_rating"
  | "press_release"
  | "earnings_call_intimation";

/**
 * Classify an NSE announcement (by its subject/description text) into one of the
 * ingestible docType buckets, or `null` to drop it.
 *
 * The NSE `corporates-announcements` feed carries the FULL announcement stream —
 * investor presentations, credit-rating intimations, press/media releases and
 * earnings-call (concall) intimations alongside annual reports. The previous
 * `filterAnnualReports` keyword-dropped everything except "annual report"; this
 * generalises it so the high-value categories also flow into the P3 extract →
 * embed chain.
 *
 * Order matters: "annual report" is checked first because an AR announcement can
 * also mention "press release"; the most specific/valuable bucket wins.
 */
export function categorizeNseAnnouncement(
  subject: string,
  description: string,
): NseAnnouncementDocType | null {
  const text = `${subject} ${description}`.toLowerCase();

  // 1. Annual report (highest value; checked first so it isn't stolen by a
  //    looser "press release" / "rating" mention in the same announcement).
  if (text.includes("annual report")) return "annual_report";

  // 2. Investor / analyst presentations and meets.
  if (
    text.includes("investor presentation") ||
    text.includes("investor meet") ||
    text.includes("analyst meet") ||
    text.includes("analyst presentation") ||
    text.includes("investor/analyst")
  ) {
    return "investor_presentation";
  }

  // 3. Credit-rating intimations (CRISIL / ICRA / CARE / India Ratings / Fitch).
  //    The bare word "rating(s)" alone is too loose — ESG ratings, product/
  //    quality ratings and performance "ratings" all match it and get wrongly
  //    bucketed as credit-rating filings. So a bare "rating" only counts when it
  //    co-occurs with "credit", a rating-ACTION verb (assigned/revised/
  //    reaffirmed/affirmed/downgrade/upgrade), or a known rating-agency name.
  if (
    text.includes("credit rating") ||
    text.includes("crisil") ||
    text.includes("icra") ||
    text.includes("care ratings") ||
    text.includes("india ratings") ||
    (/\brating(s)?\b/.test(text) &&
      (text.includes("credit") ||
        /\b(?:assign(?:ed|s)?|revis(?:ed|es|ion)|reaffirm(?:ed|s)?|affirm(?:ed|s)?|downgrade[ds]?|upgrade[ds]?|withdraw(?:n|s)?)\b/.test(
          text,
        ) ||
        /\b(?:crisil|icra|care|fitch|moody'?s|s&p|brickwork|acuite|infomerics|india ratings)\b/.test(
          text,
        )))
  ) {
    return "credit_rating";
  }

  // 4. Earnings-call / concall / conference-call intimations.
  if (
    text.includes("earnings call") ||
    text.includes("concall") ||
    text.includes("conference call") ||
    text.includes("earnings conference")
  ) {
    return "earnings_call_intimation";
  }

  // 5. Press / media releases.
  if (text.includes("press release") || text.includes("media release")) {
    return "press_release";
  }

  // Everything else (board meetings, trading-window closures, etc.) → drop.
  return null;
}

/**
 * Annotate each announcement with its categorized docType, dropping the ones
 * `categorizeNseAnnouncement` rejects. Returns the original `NSEFiling` plus the
 * resolved `docType` so the worker can store each bucket under the right path.
 */
export function categorizeAnnouncements(
  announcements: NSEFiling[],
): Array<{ filing: NSEFiling; docType: NseAnnouncementDocType }> {
  const out: Array<{ filing: NSEFiling; docType: NseAnnouncementDocType }> = [];
  for (const filing of announcements) {
    const docType = categorizeNseAnnouncement(filing.title, filing.description);
    if (docType) out.push({ filing, docType });
  }
  return out;
}

/**
 * MONEY-852 — map the BULK `corporates-corporateActions` response (no `symbol`
 * filter, whole-market window) into `NSECorporateAction[]`.
 *
 * Unlike the per-symbol response, each bulk row carries its OWN ticker — NSE
 * uses the `symbol` field (some older payloads used `series`/`comp`; `symbol` is
 * the canonical one). Rows with no usable symbol are dropped (they can't be keyed
 * for upsert). Per row we reuse the SAME `parseCorporateActions` mapping so the
 * structured ratio/type/face-value/dividend extraction is identical to the
 * single-symbol path — the bulk fetch only changes WHERE the symbol comes from.
 */
export function parseBulkCorporateActions(resp: unknown): NSECorporateAction[] {
  if (!Array.isArray(resp)) return [];

  const out: NSECorporateAction[] = [];
  for (const item of resp) {
    const row = item as Record<string, unknown>;
    const rawSymbol =
      (typeof row.symbol === "string" && row.symbol) ||
      (typeof row.comp === "string" && row.comp) ||
      "";
    const clean = normalizeFilingSymbol(rawSymbol);
    if (!clean) continue;
    // Reuse the single-symbol mapper for ONE row so the parsing stays identical.
    // ALL of what it returns: a split-and-bonus subject is two actions.
    out.push(...parseCorporateActions(clean, [row]));
  }
  return out;
}

/**
 * Filter announcements down to the ones that look like annual reports.
 *
 * Uses the shared categorizer over title + description, but ALSO honours the NSE
 * `category` field (some annual-report filings carry the marker only in their
 * smIndustry/category, not the subject line) for back-compat with the legacy
 * `fetchAnnualReports` path.
 */
export function filterAnnualReports(announcements: NSEFiling[]): NSEFiling[] {
  return announcements.filter(
    (a) =>
      categorizeNseAnnouncement(a.title, a.description) === "annual_report" ||
      a.category.toLowerCase().includes("annual report"),
  );
}
