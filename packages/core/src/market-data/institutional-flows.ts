/**
 * FII/DII daily institutional flows — MONEY-1108 (Data Engine P8d).
 *
 * The "FII/DII bought/sold today" datum. NSE publishes the provisional
 * cash-market figures at `/api/fiidiiTradeReact`: for each institutional
 * category, the day's gross buy, gross sell and net, in ₹ CRORE.
 *
 * This module is the PURE half — payload → rows. All I/O (the cookie-gated
 * fetch, the archive, the upsert) lives in the worker, so every decision below
 * is unit-testable without a network or a database. Same split as
 * `stock-flags.ts`, whose surveillance parsers this deliberately mirrors.
 *
 * ## Why a missed day is permanent
 *
 * The endpoint takes NO date parameter. It serves the CURRENT reading and
 * nothing else — there is no window to walk and no backfill to write later, so
 * a day we do not fetch never enters the record. That is the same property that
 * makes `surveillance-sync` daily and prod-only, and it is why the schedule
 * (not the parser) is the part of this feature that carries the risk.
 *
 * ## Payload shape: BOTH are accepted, on purpose
 *
 * NSE has served this endpoint as a bare array AND wrapped as `{ data: [...] }`
 * at different times, and the shape could NOT be verified while writing this:
 * NSE's Akamai edge returns "Access Denied" to our dev egress, so the only
 * evidence available is the existing research client (which reads `raw.data`)
 * and the endpoint's public behaviour (a bare array). Rather than pick one and
 * ship a parser that silently returns zero rows if the guess is wrong — a
 * failure that looks exactly like a market holiday — {@link toRawRows} accepts
 * either and the worker treats zero parsed rows as a FAILURE, never as "no
 * flows today".
 *
 * Narrowing this to one shape later needs evidence from a real response, not a
 * tidier type. A loose accept here is accidentally complete; a precise one
 * turns an unrecognised envelope into a silent no-op.
 */

import { z } from "zod";

/** Provenance tag stored on every row. */
export const INSTITUTIONAL_FLOW_SOURCES = {
  /** NSE `/api/fiidiiTradeReact` — provisional cash-market flows. */
  nseCash: "NSE_FII_DII_CASH",
} as const;

/**
 * Market segment a flow row describes.
 *
 * Only `CASH` is produced today. The field exists now so the F&O participant
 * leg (`fao_participant_oi/vol`, already arriving through P2) and the NSDL FPI
 * leg can land as additional segments WITHOUT a schema migration or a
 * re-interpretation of the rows written before them.
 */
export type FlowSegment = "CASH" | "FNO";

/** Institutional category, normalised from NSE's decorated label text. */
export type FlowCategory = "FII" | "DII";

/** One parsed, validated flow row — the worker's write unit. */
export interface InstitutionalFlowRow {
  /** UTC midnight of the IST trading day the flow describes. */
  date: Date;
  category: FlowCategory;
  segment: FlowSegment;
  /** Gross purchases, ₹ CRORE — the unit NSE publishes, stored unconverted. */
  buyValue: number;
  /** Gross sales, ₹ CRORE. */
  sellValue: number;
  /** Net (buy − sell), ₹ CRORE. Negative means net selling. */
  netValue: number;
  source: string;
}

export interface InstitutionalFlowParseResult {
  rows: InstitutionalFlowRow[];
  /** Rows dropped: unparseable date, unknown category, non-finite money. */
  skipped: number;
}

/**
 * The raw row, validated structurally.
 *
 * Every field is optional and every numeric is `string | number`: NSE returns
 * money as a comma-grouped STRING ("1,234.56") but has returned bare numbers
 * too, and a schema that demanded one would reject live data. Zod's job here is
 * to reject things that are not row-shaped at all; the money and date coercions
 * are hand-rolled below because they are lossy and need their own guards.
 */
const RawFlowRowSchema = z.object({
  date: z.union([z.string(), z.number()]).optional(),
  category: z.string().optional(),
  buyValue: z.union([z.string(), z.number()]).optional(),
  sellValue: z.union([z.string(), z.number()]).optional(),
  netValue: z.union([z.string(), z.number()]).optional(),
});

export type RawFlowRow = z.infer<typeof RawFlowRowSchema>;

/** Bare array, or `{ data: [...] }`. Anything else yields no rows. */
const RawPayloadSchema = z.union([
  z.array(z.unknown()),
  z.object({ data: z.array(z.unknown()) }),
]);

/** Unwrap the envelope to a row list. Never throws. */
function toRawRows(payload: unknown): unknown[] {
  const parsed = RawPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Parse NSE's date text to UTC midnight of that IST calendar day.
 *
 * Primary form is `DD-Mon-YYYY` ("13-Aug-2026"); `DD Mon YYYY` and ISO
 * `YYYY-MM-DD` are also accepted because NSE is not consistent across its JSON
 * endpoints and an unparsed date costs the whole row.
 *
 * Returns null rather than guessing. A wrong date here is worse than a missing
 * one: it would land the day's flows on the wrong trading day and corrupt every
 * streak and monthly aggregate derived from the series.
 *
 * NOTE this is why the row cannot be sorted as a STRING. The existing research
 * client (`nse-fii-dii.ts`) sorts these with `localeCompare`, which orders
 * "02-Sep-2026" before "13-Aug-2026" — alphabetical on the day-of-month, not
 * chronological. The DB is ordered on a real `DateTime`, so nothing downstream
 * of this module inherits that bug.
 */
export function parseNseFlowDate(raw: unknown): Date | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const dmy = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/.exec(text);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = MONTHS[dmy[2]!.slice(0, 3).toUpperCase()];
    const year = Number(dmy[3]);
    if (month === undefined || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(year, month, day));
    // Rejects 31-Feb and friends: Date.UTC rolls them over silently, so the
    // round-trip check is the only thing that catches an impossible day.
    return d.getUTCDate() === day && d.getUTCMonth() === month ? d : null;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const d = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Normalise NSE's decorated category label to `FII` | `DII`.
 *
 * Live labels carry footnote markers and vary: `"FII/FPI *"`, `"DII **"`. The
 * markers are what the footnotes on NSE's own page reference, so they are not
 * noise to strip blindly — matching on the substring is both simpler and
 * survives NSE adding or removing an asterisk.
 *
 * FII and FPI are the same money under two regulatory names; NSE itself prints
 * them as one bucket, so they collapse to `FII`.
 */
export function normalizeFlowCategory(raw: unknown): FlowCategory | null {
  const text = String(raw ?? "").toUpperCase();
  if (!text.trim()) return null;
  if (text.includes("DII")) return "DII";
  if (text.includes("FII") || text.includes("FPI")) return "FII";
  return null;
}

/**
 * Parse a money field to a FINITE number of ₹ crore, or null.
 *
 * Null — never 0 — on anything unparseable. A 0 here is a claim ("institutions
 * traded nothing today") that a parse failure has no business making, and it
 * would flow straight into net-flow streaks and monthly aggregates as real
 * data. `parseFloat` returning NaN, and NaN propagating through a sum, is the
 * recurring money-poison defect class in this codebase; the finite check is the
 * guard, and the caller drops the row.
 */
export function parseFlowValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? "")
    .replace(/,/g, "")
    .trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `/api/fiidiiTradeReact` into flow rows.
 *
 * `fallbackDate` is used only when a row carries no usable date of its own —
 * which keeps an ARCHIVED response replayable later, when "today" is no longer
 * the day the bytes describe.
 *
 * Rows are dropped (and counted) when the category is unknown or the money does
 * not parse. A row we cannot interpret is worse than no row: it would render as
 * a real institutional flow figure on a sentiment panel.
 */
export function parseFiiDiiReport(
  payload: unknown,
  fallbackDate: Date,
): InstitutionalFlowParseResult {
  const rows: InstitutionalFlowRow[] = [];
  let skipped = 0;

  for (const candidate of toRawRows(payload)) {
    const parsed = RawFlowRowSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const raw: RawFlowRow = parsed.data;

    const category = normalizeFlowCategory(raw.category);
    const buyValue = parseFlowValue(raw.buyValue);
    const sellValue = parseFlowValue(raw.sellValue);
    if (category === null || buyValue === null || sellValue === null) {
      skipped++;
      continue;
    }

    // Prefer NSE's own net, which is authoritative for its own rounding, and
    // fall back to the identity when the field is absent or unparseable. Both
    // are correct to ~2dp; deriving unconditionally would silently discard a
    // publisher correction, and trusting unconditionally would drop the row.
    const published = parseFlowValue(raw.netValue);
    const netValue = published ?? buyValue - sellValue;
    if (!Number.isFinite(netValue)) {
      skipped++;
      continue;
    }

    rows.push({
      date: parseNseFlowDate(raw.date) ?? fallbackDate,
      category,
      segment: "CASH",
      buyValue,
      sellValue,
      netValue,
      source: INSTITUTIONAL_FLOW_SOURCES.nseCash,
    });
  }

  return { rows, skipped };
}

/**
 * Collapse duplicate (date, category, segment) rows, last one winning.
 *
 * The DB carries a unique on that triple, so a payload repeating a key would
 * fail the whole write. NSE has served multi-day windows on this endpoint, and
 * a windowed response containing the same day twice is exactly the shape that
 * would turn one duplicated row into a zero-row day.
 *
 * Deliberately NOT summing: two rows for one key are the SAME reading restated,
 * not two partial readings, so summing would double the day's flows.
 */
export function dedupeFlowRows(
  rows: readonly InstitutionalFlowRow[],
): InstitutionalFlowRow[] {
  const byKey = new Map<string, InstitutionalFlowRow>();
  for (const row of rows) {
    byKey.set(`${row.date.getTime()}|${row.category}|${row.segment}`, row);
  }
  return [...byKey.values()];
}
