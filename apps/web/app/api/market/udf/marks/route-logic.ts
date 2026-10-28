/**
 * Pure helpers for the TradingView UDF `marks` endpoint — MONEY-1176.
 *
 * ## Why marks exist
 *
 * `DailyPrice` holds raw exchange prices, so a chart gaps down at every split
 * and bonus. That gap is CORRECT — the price really did halve — but with no
 * label a user reads it as a crash. A mark turns the cliff into an explained
 * event, and it stays useful even once serve-time adjustment smooths the line,
 * because the event still happened.
 *
 * ## The response shape is column-oriented, not row-oriented
 *
 * TradingView wants PARALLEL ARRAYS — `{ id: [...], time: [...], text: [...] }`
 * — where index i of each array describes one mark. Returning an array of
 * objects renders nothing, silently. `time` is unix SECONDS, the same trap as
 * the history endpoint.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#marks
 */

/** The subset of a CorporateAction row a mark needs. */
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";

export interface MarkableAction {
  id: string;
  type: string;
  exDate: Date;
  ratio?: number | null;
  dividendPerShare?: number | null;
  oldFaceValue?: number | null;
  newFaceValue?: number | null;
}

export interface UdfMarks {
  id: string[];
  time: number[];
  color: Array<string | { border: string; background: string }>;
  text: string[];
  label: string[];
  labelFontColor: string[];
  minSize: number[];
}

/**
 * Types that get a mark in v1.
 *
 * DIVIDEND is deliberately EXCLUDED: there are 1,589 of them and they cluster
 * every year, so a 5Y chart would carry a solid band of marks that hides the
 * three events that actually moved the price basis. It needs its own toggle,
 * not a place in the default set.
 */
export const MARKED_TYPES = new Set([
  "SPLIT",
  "BONUS",
  "DEMERGER",
  "MERGER",
  "RIGHTS",
  "CAPITAL_ADJUSTMENT",
]);

/** Single-letter chart glyph per type. */
const LABEL: Readonly<Record<string, string>> = {
  SPLIT: "S",
  BONUS: "B",
  DEMERGER: "D",
  MERGER: "M",
  RIGHTS: "R",
  CAPITAL_ADJUSTMENT: "A",
};

/**
 * Colour by ECONOMIC EFFECT, not by type name: everything here except RIGHTS
 * mechanically lowers the quoted price, and a reader scanning a chart benefits
 * far more from "this dip was structural" than from telling a split apart from
 * a bonus at a glance.
 */
const COLOR: Readonly<Record<string, { border: string; background: string }>> =
  {
    SPLIT: { border: "#2962FF", background: "#2962FF" },
    BONUS: { border: "#2962FF", background: "#2962FF" },
    CAPITAL_ADJUSTMENT: { border: "#2962FF", background: "#2962FF" },
    DEMERGER: { border: "#9C27B0", background: "#9C27B0" },
    MERGER: { border: "#9C27B0", background: "#9C27B0" },
    RIGHTS: { border: "#FF9800", background: "#FF9800" },
  };

/**
 * An ex-date's calendar day, in IST — MONEY-1527.
 *
 * WAS `toISOString().slice(0, 10)`, and that was wrong in two ways at once on
 * this surface. Prod stores `exDate` in TWO conventions — 48,224 rows at
 * 18:30Z (IST midnight) and 10,863 at 00:00Z — so a UTC slice read the
 * majority one calendar day EARLY. The glyph's LABEL said the wrong date, and
 * the NSE/BSE dedupe below keyed on the same string, so one event filed by
 * both exchanges under different conventions produced TWO keys and rendered
 * two glyphs — exactly the "rendering bug" that dedupe exists to prevent.
 *
 * IST renders both conventions to the same correct day with no branch.
 */
const iso = (d: Date): string => toIstDateKey(d);

/**
 * The BAR the glyph sits on: UTC midnight of the ex-date's IST day.
 *
 * TradingView positions a mark by epoch seconds and India's bars are written
 * at UTC midnight (`bhavcopy.ts` `tradingDateUtcMidnight`). Passing the raw
 * instant put an 18:30Z ex-date 5h30m BEFORE the bar it belongs to, so the
 * glyph rendered on the PREVIOUS candle. Normalising through the same IST day
 * key makes the mark, the label and the dedupe agree on one day.
 */
const barSecForExDate = (d: Date): number =>
  Math.floor(Date.parse(`${toIstDateKey(d)}T00:00:00.000Z`) / 1000);

/**
 * FAIL CLOSED on a date that cannot be represented.
 *
 * `toIstDateKey` does arithmetic and then `getUTCFullYear()`, with no validity
 * guard — an Invalid Date renders as the literal "NaN-NaN-NaN" and a year
 * under 1000 as "999-06-15". `Date.parse` returns NaN for both, and NaN fails
 * BOTH `sec < fromSec` and `sec > toSec`, so the row would sail through the
 * window test and reach TradingView as `time: null` beside the text
 * "ex-date NaN-NaN-NaN".
 *
 * The previous `toISOString()` THREW here, which route.ts's catch turned into
 * a clean `emptyMarks()`. Moving to a renderer that does not throw silently
 * converted a loud failure into a malformed payload, so the check the old code
 * got for free is now explicit. (`packages/lake`'s mirrored `istDateKey` does
 * guard; the core copy does not — see MONEY-1527.)
 */
const isRenderableExDate = (d: Date): boolean =>
  Number.isFinite(barSecForExDate(d));

/**
 * Human text for one action.
 *
 * Falls back progressively: an exact ratio when we have one, the face-value
 * change when that is what was recorded, and a bare type name when the action
 * arrived unclassified. A mark with a vague label still earns its place — it
 * tells the reader the dip was structural rather than a crash.
 */
export function markText(a: MarkableAction): string {
  const when = `ex-date ${iso(a.exDate)}`;

  if (a.type === "SPLIT") {
    if (a.oldFaceValue && a.newFaceValue && a.newFaceValue !== a.oldFaceValue) {
      return `Stock split — face value ₹${a.oldFaceValue} → ₹${a.newFaceValue} (${when})`;
    }
    if (a.ratio && a.ratio > 1) {
      return `Stock split 1:${trim(a.ratio)} (${when})`;
    }
    return `Stock split (${when})`;
  }

  if (a.type === "BONUS") {
    // A bonus is quoted a:b where the holder receives `a` new shares for every
    // `b` held, so the stored post:pre ratio R maps back as a:b = (R-1):1.
    if (a.ratio && a.ratio > 1) {
      return `Bonus issue ${trim(a.ratio - 1)}:1 (${when})`;
    }
    return `Bonus issue (${when})`;
  }

  if (a.type === "RIGHTS") return `Rights issue (${when})`;
  if (a.type === "DEMERGER") return `Demerger (${when})`;
  if (a.type === "MERGER") return `Merger (${when})`;
  return `Capital adjustment (${when})`;
}

/** Drop a trailing ".0" so 2 renders as "2" and 1.5 stays "1.5". */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/**
 * The price-basis change an action declares, or null when it declares none.
 *
 * NOT a key component on its own — see `buildMarks`. A row that declares
 * NOTHING must not split a group: NSE and BSE are always separate rows
 * (`@@unique` carries `exchange`) and the route deliberately does not scope by
 * exchange, so PARTIALLY POPULATED twins are the normal input — one side with
 * face values, the other with nulls. Treating a null as a disagreement renders
 * one split as two glyphs, which is the exact bug the dedupe exists to stop.
 */
function declaredFactor(a: MarkableAction): number | null {
  if (
    a.type === "SPLIT" &&
    a.oldFaceValue &&
    a.newFaceValue &&
    a.newFaceValue !== a.oldFaceValue
  ) {
    return a.oldFaceValue / a.newFaceValue;
  }
  if (a.ratio && a.ratio > 1) return a.ratio;
  if (a.dividendPerShare && a.dividendPerShare > 0) return a.dividendPerShare;
  return null;
}

/** Two declared factors that a reader could not tell apart. */
function sameFactor(x: number, y: number): boolean {
  // Ratios are DERIVED, not stored verbatim — `1 + 2/3` and `5/3` differ in
  // the last bit and `trim()` prints both as "0.67". A string compare would
  // emit two byte-identical glyphs on one candle.
  return Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1);
}

/**
 * Build the UDF marks payload.
 *
 * Filters to `MARKED_TYPES`, clips to `[fromSec, toSec]` on the NORMALISED bar
 * second, collapses actions describing the same event with the same declared
 * factor on the same day (the same split legitimately arrives
 * from NSE and BSE, and two identical glyphs on one bar look like a rendering
 * bug), and caps the count so a pathological symbol cannot flood the chart.
 */
export function buildMarks(
  actions: readonly MarkableAction[],
  fromSec: number,
  toSec: number,
  maxMarks = 200
): UdfMarks {
  const seen = new Map<string, number[]>();
  const chosen: MarkableAction[] = [];

  for (const a of [...actions].sort(
    (x, y) => x.exDate.getTime() - y.exDate.getTime()
  )) {
    if (!MARKED_TYPES.has(a.type)) continue;
    // The WINDOW is tested on the normalised bar second too — clipping on the
    // raw instant would drop an action whose bar is inside the range while its
    // 18:30Z stamp falls outside it.
    if (!isRenderableExDate(a.exDate)) continue;
    const sec = barSecForExDate(a.exDate);
    if (sec < fromSec || sec > toSec) continue;
    // ONE GLYPH PER (type, day, DISTINCT DECLARED FACTOR).
    //
    // The key was (type, day) alone, which was right while the two exDate
    // conventions rendered to two different days and wrong once IST collapsed
    // them: a genuine NSE-10-vs-BSE-2 disagreement became one glyph whose
    // ratio depended on row order. Adding the raw factor fields to the key
    // over-corrected — a null is not a disagreement, and partially populated
    // twins are the NORMAL input, so 42 groups measured in QA split into two
    // glyphs that had always been one.
    //
    // So: a row that declares NO factor joins whatever group it lands in; two
    // rows that declare factors split only when those factors actually
    // differ, compared with a tolerance because they are computed.
    const day = `${a.type}::${iso(a.exDate)}`;
    const f = declaredFactor(a);
    const group = seen.get(day);
    if (group) {
      if (f === null || group.some((g) => sameFactor(g, f))) continue;
      group.push(f);
    } else {
      seen.set(day, f === null ? [] : [f]);
    }
    chosen.push(a);
    if (chosen.length >= maxMarks) break;
  }

  return {
    id: chosen.map((a) => a.id),
    time: chosen.map((a) => barSecForExDate(a.exDate)),
    color: chosen.map(
      (a) => COLOR[a.type] ?? { border: "#787B86", background: "#787B86" }
    ),
    text: chosen.map(markText),
    label: chosen.map((a) => LABEL[a.type] ?? "•"),
    labelFontColor: chosen.map(() => "#FFFFFF"),
    minSize: chosen.map(() => 14),
  };
}

/** The empty payload. TradingView expects the arrays, not `null`. */
export function emptyMarks(): UdfMarks {
  return {
    id: [],
    time: [],
    color: [],
    text: [],
    label: [],
    labelFontColor: [],
    minSize: [],
  };
}
