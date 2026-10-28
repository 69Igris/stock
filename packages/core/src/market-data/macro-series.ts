/**
 * Official Indian macro series — RBI / MOSPI / OEA — MONEY-1106 (Data Engine P8b).
 *
 * PURE: this module names the sources, parses their HTML, and decides what a
 * row means. It never fetches and never writes. The I/O lives in
 * `workers/src/processors/macro-sync.ts`, which pulls the bytes through
 * `getFeedAsset` so the archive-first contract (MONEY-1085) holds for these
 * feeds exactly as it does for the bhavcopies.
 *
 * ## What was VERIFIED, and what was not
 *
 * The governing rule of this phase (MONEY-1096, and restated all over
 * `report-registry.ts`) is that a guessed URL 404s identically to a real
 * absence, so an unverified path can never announce itself as wrong. Every
 * source below was fetched from our own egress on **2026-08-13** and its table
 * structure was dumped cell-by-cell before a line of this parser was written.
 * The per-source `verifiedOn` field records that; do not add a source without
 * one.
 *
 * Deliberately NOT shipped — see the TODO block at the foot of this file:
 *   - IIP (Index of Industrial Production). MOSPI's data API was located but
 *     could not be CALLED successfully. No fetcher, on purpose.
 *   - The OEA full WPI commodity tree (~1,140 sub-indices). The URL and sheet
 *     layout were verified, but prior months are NOT addressable — see the TODO.
 *
 * ## Why RBI's NSDP pages, and not DBIE
 *
 * RBI's Database on Indian Economy (`data.rbi.org.in`) is the obvious home for
 * this data, and it is the wrong tool. It is an Angular SPA over a TCS "CIMS"
 * enterprise gateway (`/CIMS_Gateway_DBIE/GATEWAY/SERVICES/dbie_*`) with a
 * `security_generateSessionToken` handshake, ~90 undocumented RPC endpoints and
 * no published contract. The ticket's own instruction was "keep the scraper
 * thin — these are stable CSV/XLS downloads".
 *
 * The National Summary Data Page (`BS_NSDPDisplay.aspx?param=N`) is the thin
 * version of the same data: a fixed URL per table, plain server-rendered HTML,
 * no cookies, no session, no JS. It is the IMF SDDS disclosure page, so RBI is
 * externally committed to maintaining it. It republishes the Weekly Statistical
 * Supplement tables plus — via `param=15` — MOSPI's CPI and the OEA's WPI, and
 * it says so in the table's own footer ("Sources: Ministry of Statistics and
 * Program Implementation; Office of Economic Adviser; and Labour Bureau"). One
 * host, one shape, three publishers.
 *
 * ## The trap in this param space, found by probing
 *
 * Probing all of `param=1..30` on 2026-08-13 returned **HTTP 200 for every
 * one**. That is not the same as "every one has data":
 *
 *   param=2,4,7,8,13,14,15,17,22,23,25,26   stamped `Date : Aug 07, 2026` — live
 *   param=5,6,9,10,16,18,19,20,24           stamped 2012–2014 — DISCONTINUED
 *   param=11,12,21                          stamped 2003–2005 — DISCONTINUED
 *   param=27..30                            200 with no table at all
 *
 * A discontinued table serves thirteen-year-old numbers under a 200 forever. So
 * two guards are structural here rather than optional:
 *
 *   1. {@link parseNsdpPeriodTable} / {@link parseNsdpAsOnTable} return `null`
 *      — never `[]` — when the page has no recognisable table. A failure and an
 *      empty window MUST be different values (MONEY-1189 B2: two fetchers that
 *      returned `[]` for both "asked, never answered" and "answered, nothing
 *      there" hid 37 failed windows behind a `DONE` line).
 *   2. Every source declares {@link MacroSource.maxAgeDays}, and
 *      {@link judgeMacroFreshness} compares the NEWEST parsed period against
 *      it. A frozen page is then visible as `STALE` instead of being re-ingested
 *      into its own decade forever.
 *
 * ## Rolling windows — why the cadence is what it is
 *
 * None of these pages is date-addressable; each serves a rolling window and the
 * older columns fall off. Measured 2026-08-13:
 *
 *   `rbi-nsdp-rates`   6 week-ended columns (5 current-year + 1 year-ago)
 *   `rbi-nsdp-prices`  3 month columns (2 current-year + 1 year-ago)
 *   `rbi-nsdp-forex`   ONE "as on" column
 *
 * So the rates and prices pages self-heal across several missed runs, and the
 * forex page does not: a week we never fetch is a week that never enters the
 * record. That asymmetry is why the archive matters more here than for a dated
 * bhavcopy (which can always be re-walked) and why the schedules are set with
 * overlap rather than run-once-and-hope.
 */

// ─── Types ───────────────────────────────────────────────────────────

/** Publication cadence of a series. Drives how a column label becomes a period. */
export type MacroFrequency = "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";

/**
 * Unit of a stored value. Kept explicit on every observation because these
 * series mix percentages, index points and two different currency magnitudes on
 * ONE page — a bare number would be uninterpretable downstream.
 */
export type MacroUnit =
  | "PERCENT"
  | "INDEX"
  | "INR_CRORE"
  | "USD_MILLION"
  /** Rupees per one unit of a foreign currency (the FBIL reference spot rates). */
  | "INR_PER_UNIT";

/** What one upstream row label means. */
export interface MacroSeriesDef {
  /** Canonical, stable id. This is half the DB unique key — never renumber it. */
  seriesId: string;
  unit: MacroUnit;
  frequency: MacroFrequency;
}

/** How a source's HTML is laid out. Two shapes cover all three pages. */
export type MacroLayout =
  /** Year row + date row above value columns (rates, prices). */
  | "period-columns"
  /** A single "As on <date>" snapshot with unit columns (forex reserves). */
  | "as-on-snapshot";

export interface MacroSource {
  /** Stable id; the `source` column value and the run's log key. */
  id: string;
  /**
   * The `{feed}` segment of the archive key `feeds/RBI/{feed}/{YYYY}/{MM}/`,
   * and the second half of this feed's `FEED_SHAPES` key in `feed-payload.ts`.
   *
   * Declared, NOT derived from `id`. Deriving it (a `replace(/^rbi-/, "")` in
   * the worker) would put the archive key and the payload-shape lookup on
   * opposite sides of a string edit: drift the edit and `feedShapeFor` misses,
   * silently falls back to the generic guard — which REJECTS HTML — and every
   * macro page stops being archived, with the ingest still green because the
   * live fetch keeps working. A pinned test asserts the pairing.
   */
  archiveFeed: string;
  /** The exact URL that was probed. */
  url: string;
  layout: MacroLayout;
  /**
   * ISO date this URL AND its table structure were last confirmed against the
   * live host. Required — a source without one has not been verified, and this
   * phase's whole discipline is that an unverified path is inventory, not a
   * feed.
   */
  verifiedOn: string;
  /**
   * How stale the newest observation may get before the source is reported
   * STALE. Sized at roughly three publication intervals plus slack, so an
   * ordinary late release does not cry wolf but a DISCONTINUED table does.
   */
  maxAgeDays: number;
  /**
   * Row labels this source publishes, keyed by {@link normaliseMacroLabel}.
   *
   * Per-source rather than global on purpose: `param=15` publishes bare `Rural`
   * and `Urban` rows that only mean "CPI rural/urban" in the context of that
   * page. A global label map would make them ambiguous the moment a second
   * source uses the same word.
   *
   * It also doubles as the row filter. `param=4` renders TWO stacked blocks —
   * a FORTNIGHT-ended set of banking ratios and the WEEK-ended set of policy
   * rates — and only the week block's labels appear here, so the fortnight
   * block is skipped without the parser needing to know it exists. If you ever
   * map a fortnight row, give it `frequency: "FORTNIGHTLY"`: the period is
   * derived per-SERIES, not per-source, precisely so that stays correct.
   */
  series: Readonly<Record<string, MacroSeriesDef>>;
}

/** One datum: a series, a period, a finite value. */
export interface MacroObservation {
  seriesId: string;
  /**
   * UTC midnight. For WEEKLY/FORTNIGHTLY this is the period-END date exactly as
   * published ("week ended Jul. 31"); for MONTHLY it is the FIRST of the month,
   * because the page names a month and not a day.
   */
  period: Date;
  /** Guaranteed finite — see {@link parseMacroNumber}. */
  value: number;
  unit: MacroUnit;
  frequency: MacroFrequency;
  /** {@link MacroSource.id} this came from. */
  source: string;
  /**
   * The upstream row label VERBATIM, base-year parenthetical and all
   * ("Wholesale Price Index (2022-23=100)").
   *
   * {@link normaliseMacroLabel} strips that parenthetical for MATCHING, so a
   * rebase keeps feeding the same `seriesId` instead of silently going dark.
   * The tradeoff is that a rebase makes the level series discontinuous, so the
   * base has to survive somewhere — it survives here, on every row.
   */
  label: string;
}

/**
 * Outcome of parsing ONE page.
 *
 * `rows: []` with a non-null result means "the table parsed and matched no
 * series we track" — a real, reportable state. A page that could not be
 * recognised at all returns `null` instead. Keeping those two apart is the
 * point of this type.
 */
export interface MacroParseResult {
  rows: MacroObservation[];
  /** Value cells rejected by {@link parseMacroNumber} (blanks, ranges, "..."). */
  skipped: number;
  /** Row labels seen but not in the source's map. Bounded; for logging only. */
  unmapped: string[];
  /** The page's own `Date : Aug 07, 2026` stamp, when present. */
  releaseDate: Date | null;
  /** Newest period across `rows`; the input to {@link judgeMacroFreshness}. */
  newestPeriod: Date | null;
}

// ─── Number + label normalisation ────────────────────────────────────

/**
 * Parse a value cell, or `null` if it is not a usable number.
 *
 * Every rejection below was observed on the live pages on 2026-08-13, not
 * imagined:
 *
 *   `"8.50/10.30"`  Base Rate, MCLR and Term Deposit Rate are published as a
 *                   RANGE across banks. `Number("8.50/10.30")` is NaN, and a
 *                   NaN reaching Mongo is the money-poison class this codebase
 *                   has been bitten by repeatedly — so ranges are rejected at
 *                   the parse boundary and those rows are simply not mapped.
 *   `"6,612,148"`   thousands separators appear in some tables.
 *   `"-1.7"`        legitimately negative (forex variation, WPI m/m).
 *   `"–" ".." "N.A." ""`  RBI's several spellings of "no observation".
 *
 * The `Number.isFinite` gate at the end is the catch-all: `Number("")` is 0 and
 * `Number("Infinity")` is Infinity, and neither may ever be stored as a value.
 */
export function parseMacroNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/ /g, " ")
    .replace(/[,\s]/g, "")
    .replace(/^[*#@]+|[*#@]+$/g, "")
    .trim();

  if (cleaned === "") return null;
  // A range ("8.50/10.30") is two numbers wearing one cell. There is no single
  // value to store, so it is not a datum — dropping it is the honest outcome.
  if (cleaned.includes("/")) return null;
  // RBI's absence markers, including the en/em dashes it uses interchangeably.
  if (/^(?:[-–—.]+|n\.?a\.?|nil)$/i.test(cleaned)) return null;
  // Anything that is not a plain signed decimal. Guards against "1.2e400"
  // (which parses to Infinity) and stray footnote glyphs alike.
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * A base-year parenthetical: `(2024=100)`, `(2022-23=100)`, `(Base : 1993-94 = 100)`.
 * Stripped for matching so a rebase does not orphan the series.
 */
const BASE_YEAR_PARENTHETICAL =
  /\((?:\s*base\s*:?\s*)?\d{4}(?:\s*-\s*\d{2,4})?\s*=\s*100\s*\)/gi;

/**
 * Canonical matching key for an upstream row label.
 *
 * Strips, in order: the outline number RBI prefixes every row with
 * (`1.1 Foreign Currency Assets`), footnote markers (`#`, `*`, `@`), ALL
 * parentheticals, and case/whitespace.
 *
 * Dropping every parenthetical rather than only base years is deliberate: the
 * live labels carry `(SDF)`, `(FBIL)`, `(Weighted Average)`, `(2024=100)` and
 * `(₹ Per Foreign Currency)`. Keeping any of them in the key would put a
 * non-ASCII rupee sign and a base year into a source constant, both of which
 * change without notice. The verbatim label is preserved on every observation,
 * so nothing is lost — only the MATCHING is made robust.
 */
export function normaliseMacroLabel(raw: string): string {
  return raw
    .replace(/ /g, " ")
    .replace(BASE_YEAR_PARENTHETICAL, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/^\s*\d+(?:\.\d+)*\s+/, "")
    .replace(/[*#@]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ─── HTML table extraction (pure, regex — no DOM in workers) ─────────

const MONTH_ABBR: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Minimal entity decode — these pages use a small, fixed set. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
}

/** Strip tags from a cell's inner HTML and collapse whitespace. */
function cellText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** One cell: its text and how many grid columns it occupies. */
interface Cell {
  text: string;
  span: number;
}

/**
 * Rows of the page's data table, as `Cell[]`.
 *
 * The NSDP data table is the one carrying `class="tablebg"`; everything before
 * it is chrome. We slice from there to the end of the document rather than
 * trying to find the matching `</table>` — a regex cannot balance nested tables,
 * and it does not need to: every row is matched against the source's explicit
 * label map, so trailing footer markup contributes `unmapped` noise at worst,
 * never a value.
 *
 * Returns `null` when the marker is absent, which is how a moved/emptied page
 * (params 27..30 serve exactly that) becomes a FAILURE rather than zero rows.
 */
export function extractNsdpRows(html: string): Cell[][] | null {
  const start = html.indexOf('class="tablebg"');
  if (start === -1) return null;

  const segment = html.slice(start);
  const rows: Cell[][] = [];

  for (const rowMatch of segment.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: Cell[] = [];
    for (const cellMatch of rowMatch[1]!.matchAll(
      /<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi,
    )) {
      const colspan = /colspan\s*=\s*["']?(\d+)/i.exec(cellMatch[2]!);
      const span = colspan ? Number(colspan[1]) : 1;
      cells.push({
        text: cellText(cellMatch[3]!),
        // A colspan of 0 or NaN would silently delete a column from the grid,
        // which is how a year would end up attached to the wrong date.
        span: Number.isInteger(span) && span > 0 && span <= 64 ? span : 1,
      });
    }
    if (cells.length > 0) rows.push(cells);
  }

  return rows.length === 0 ? null : rows;
}

/**
 * Expand a row into one entry per GRID column, repeating a spanned cell.
 *
 * This is what makes the year→date mapping correct. RBI writes the year row as
 * `Item/Week Ended | 2025 | 2026(colspan 5)` above six date cells; reading the
 * cells positionally would hand `Jul. 10` the year 2026 by luck and `Jul. 31`
 * nothing at all.
 */
export function expandCells(cells: readonly Cell[]): string[] {
  const out: string[] = [];
  for (const cell of cells) {
    for (let i = 0; i < cell.span; i++) out.push(cell.text);
  }
  return out;
}

/** The page's `Date : Aug 07, 2026` release stamp, or null. */
export function parseNsdpReleaseDate(html: string): Date | null {
  const m = /Date\s*:\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(
    decodeEntities(html.replace(/<[^>]+>/g, " ")),
  );
  if (!m) return null;
  const month = MONTH_ABBR[m[1]!.toLowerCase()];
  if (month === undefined) return null;
  return utcDay(Number(m[3]), month, Number(m[2]));
}

/** UTC midnight for a Y/M/D, or null when the triple is not a real date. */
function utcDay(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31-Feb and friends: the Date constructor rolls them over silently.
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/** A parsed column header: a year plus a month, and a day when one is given. */
interface PeriodColumn {
  year: number;
  month: number;
  /** Null for a month-only header ("Jun."), i.e. a monthly series' column. */
  day: number | null;
}

/** `"Jul. 31"` / `"Jul 3"` / `"Jun."` / `"May"` → month (+ day), else null. */
function parseColumnLabel(
  raw: string,
): { month: number; day: number | null } | null {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})?$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTH_ABBR[m[1]!.toLowerCase()];
  if (month === undefined) return null;
  return { month, day: m[2] ? Number(m[2]) : null };
}

/**
 * Pair a year row with the date row beneath it.
 *
 * Two behaviours here are load-bearing and both come from the live markup:
 *
 *   - **Forward-fill.** `param=4`'s fortnight header is
 *     `2025(x2) | 2026(x2) | ''(x2)` over three dates. RBI prints a year once
 *     and leaves the continuation blank; an empty year cell means "same year as
 *     the column to its left", not "no year".
 *   - **A column is DATA only if its year token is a bare 4-digit year.**
 *     `param=15`'s header is `2025 | 2026(x2) | Percentage Variation of Current
 *     Month(x3)`, so the last three columns are derived percentages, not
 *     observations. Requiring the date cell to parse as well means a column
 *     needs BOTH halves to be real before anything is read from it.
 */
function buildPeriodColumns(
  yearCells: readonly Cell[],
  dateCells: readonly Cell[],
): (PeriodColumn | null)[] | null {
  // The year row leads with the stub label ("Item", "Item/Week Ended"); the
  // date row beneath it does not. Verified on all three pages 2026-08-13.
  const years = expandCells(yearCells).slice(1);
  const dates = expandCells(dateCells);
  if (years.length !== dates.length || years.length === 0) return null;

  const columns: (PeriodColumn | null)[] = [];
  let carriedYear: number | null = null;
  let anyData = false;

  for (let i = 0; i < years.length; i++) {
    const token = years[i]!.trim();
    if (token === "") {
      // Blank = continuation of the previous year (see above).
    } else if (/^\d{4}$/.test(token)) {
      carriedYear = Number(token);
    } else {
      // A non-year heading ("Percentage Variation…") ends the data block and
      // must NOT inherit the carried year.
      carriedYear = null;
    }

    const parsed = carriedYear === null ? null : parseColumnLabel(dates[i]!);
    if (parsed === null || carriedYear === null) {
      columns.push(null);
      continue;
    }
    columns.push({ year: carriedYear, month: parsed.month, day: parsed.day });
    anyData = true;
  }

  return anyData ? columns : null;
}

// ─── Layout A: period-columns (rates, prices) ────────────────────────

/** Cap on `unmapped` so a footer full of markup cannot bloat a log line. */
const MAX_UNMAPPED = 24;

/**
 * Parse a `period-columns` NSDP page.
 *
 * Returns `null` — never an empty result — when the page carries no table at
 * all, so the caller can tell "RBI moved this page" apart from "no series we
 * track appeared this week". See the header for why that distinction is not
 * optional here.
 */
export function parseNsdpPeriodTable(
  source: MacroSource,
  html: string,
): MacroParseResult | null {
  const rows = extractNsdpRows(html);
  if (rows === null) return null;

  const out: MacroObservation[] = [];
  const unmapped: string[] = [];
  let skipped = 0;
  let columns: (PeriodColumn | null)[] | null = null;
  let sawHeader = false;

  // A colspan-widened block repeats each column, so the same (series, period)
  // can be read more than once from ONE row. `param=4`'s fortnight block is
  // laid out that way — every cell spans 2 — and although none of its labels is
  // mapped today, a future mapping would emit each value twice. The DB upsert
  // would absorb that silently and the run counts would lie about it, so the
  // duplicates are dropped here where they can still be seen.
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    // A header pair re-arms the column map. `param=4` has TWO of them (the
    // fortnight block then the week block), so this is a re-assignment inside
    // the loop rather than a one-shot before it.
    if (i + 1 < rows.length && row.length >= 2) {
      const candidate = buildPeriodColumns(row, rows[i + 1]!);
      if (candidate !== null) {
        columns = candidate;
        sawHeader = true;
        i++; // consume the date row
        continue;
      }
    }

    if (columns === null) continue;

    const values = expandCells(row);
    const label = values[0] ?? "";
    if (label === "") continue;

    const def = source.series[normaliseMacroLabel(label)];
    if (def === undefined) {
      if (unmapped.length < MAX_UNMAPPED) unmapped.push(label);
      continue;
    }

    const cells = values.slice(1);
    if (cells.length !== columns.length) {
      // The row does not line up with the header it sits under. Reading it
      // positionally anyway would attach values to the wrong weeks, which is
      // silent and unrecoverable — so the row is dropped and counted.
      skipped += cells.length;
      continue;
    }

    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      // `== null` covers BOTH the explicit "not a data column" null and the
      // `undefined` that `noUncheckedIndexedAccess` gives every index read.
      if (column == null) continue;

      const value = parseMacroNumber(cells[c]!);
      if (value === null) {
        skipped++;
        continue;
      }

      // The period comes from the SERIES' frequency, not the source's: one page
      // can stack a fortnightly block above a weekly one.
      const period =
        def.frequency === "MONTHLY"
          ? utcDay(column.year, column.month, 1)
          : column.day === null
            ? null
            : utcDay(column.year, column.month, column.day);

      if (period === null) {
        skipped++;
        continue;
      }

      const key = `${def.seriesId}|${period.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        seriesId: def.seriesId,
        period,
        value,
        unit: def.unit,
        frequency: def.frequency,
        source: source.id,
        label,
      });
    }
  }

  if (!sawHeader) return null;

  return {
    rows: out,
    skipped,
    unmapped,
    releaseDate: parseNsdpReleaseDate(html),
    newestPeriod: newestPeriodOf(out),
  };
}

// ─── Layout B: as-on snapshot (forex reserves) ───────────────────────

/**
 * Column indices that carry LEVELS on the forex reserves page.
 *
 * Verified 2026-08-13: the table is
 * `Item | As on <date> (₹ Cr., US$ Mn.) | Variation over Week / End-March /
 * Year (₹ Cr., US$ Mn. each)` — eight value columns, of which only the first
 * two are levels. The other six are DIFFERENCES; storing them as observations
 * would put "+10,512" into a reserves series next to "692,866".
 */
const AS_ON_LEVEL_COLUMNS: ReadonlyArray<{
  index: number;
  unit: MacroUnit;
  suffix: string;
}> = [
  { index: 0, unit: "INR_CRORE", suffix: "_INR_CR" },
  { index: 1, unit: "USD_MILLION", suffix: "_USD_MN" },
];

/** `"As on Jul. 31, 2026"` → that day, or null. */
export function parseAsOnDate(text: string): Date | null {
  const m = /as\s+on\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/i.exec(
    text,
  );
  if (!m) return null;
  const month = MONTH_ABBR[m[1]!.toLowerCase()];
  if (month === undefined) return null;
  return utcDay(Number(m[3]), month, Number(m[2]));
}

/**
 * Parse an `as-on-snapshot` NSDP page.
 *
 * One period for the whole table, taken from the `As on <date>` header cell.
 * `null` when no table or no such header — the header IS the period, so without
 * it there is nothing to key on and guessing "this week" would silently
 * mis-date the entire snapshot.
 */
export function parseNsdpAsOnTable(
  source: MacroSource,
  html: string,
): MacroParseResult | null {
  const rows = extractNsdpRows(html);
  if (rows === null) return null;

  let period: Date | null = null;
  for (const row of rows) {
    for (const cell of row) {
      period = parseAsOnDate(cell.text);
      if (period !== null) break;
    }
    if (period !== null) break;
  }
  if (period === null) return null;

  const out: MacroObservation[] = [];
  const unmapped: string[] = [];
  let skipped = 0;

  for (const row of rows) {
    const values = expandCells(row);
    const label = values[0] ?? "";
    if (label === "") continue;

    const def = source.series[normaliseMacroLabel(label)];
    if (def === undefined) {
      if (unmapped.length < MAX_UNMAPPED) unmapped.push(label);
      continue;
    }

    const cells = values.slice(1);
    for (const column of AS_ON_LEVEL_COLUMNS) {
      const raw = cells[column.index];
      if (raw === undefined) {
        skipped++;
        continue;
      }
      const value = parseMacroNumber(raw);
      if (value === null) {
        skipped++;
        continue;
      }
      out.push({
        // The def's `seriesId` is the BASE; the unit suffix completes it, so
        // "total reserves in ₹ crore" and "in US$ million" are two series
        // rather than one series whose unit changes per row.
        seriesId: `${def.seriesId}${column.suffix}`,
        period,
        value,
        unit: column.unit,
        frequency: def.frequency,
        source: source.id,
        label,
      });
    }
  }

  return {
    rows: out,
    skipped,
    unmapped,
    releaseDate: parseNsdpReleaseDate(html),
    newestPeriod: newestPeriodOf(out),
  };
}

/** Newest `period` across observations, or null when there are none. */
function newestPeriodOf(rows: readonly MacroObservation[]): Date | null {
  let newest: number | null = null;
  for (const row of rows) {
    const t = row.period.getTime();
    if (newest === null || t > newest) newest = t;
  }
  return newest === null ? null : new Date(newest);
}

/** Dispatch to the right parser for a source's declared layout. */
export function parseMacroSource(
  source: MacroSource,
  html: string,
): MacroParseResult | null {
  return source.layout === "as-on-snapshot"
    ? parseNsdpAsOnTable(source, html)
    : parseNsdpPeriodTable(source, html);
}

// ─── Freshness ───────────────────────────────────────────────────────

export type MacroFreshness = "FRESH" | "STALE" | "UNKNOWN";

/**
 * Is this source's newest observation recent enough to believe?
 *
 * The guard exists because of what the param sweep found: nine NSDP tables
 * serve 2012 data under a permanent HTTP 200. Without this, RBI freezing
 * `param=4` would look exactly like a normal run forever — same 200, same row
 * count, same "COMPLETED" log — while the newest week silently stopped moving.
 *
 * `UNKNOWN` (no rows at all) is deliberately NOT folded into `STALE`: "we
 * cannot tell" and "we can tell, and it is old" are different findings, and
 * collapsing them is the habit this phase keeps paying for.
 */
export function judgeMacroFreshness(
  newestPeriod: Date | null,
  now: Date,
  maxAgeDays: number,
): MacroFreshness {
  if (newestPeriod === null) return "UNKNOWN";
  const ageDays = (now.getTime() - newestPeriod.getTime()) / 86_400_000;
  return ageDays <= maxAgeDays ? "FRESH" : "STALE";
}

// ─── The verified source registry ────────────────────────────────────

const NSDP = "https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx";

/** Referer for RBI fetches — same-origin, matching the NSE/BSE convention. */
export const RBI_REFERER = "https://www.rbi.org.in/";

/**
 * `param=4` — "Cash Reserve Ratio and Interest Rates" (WSS table 5T).
 *
 * VERIFIED 2026-08-13 from our own egress:
 *   GET https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=4
 *   → 200, text/html, ~112 KB, stamped `Date : Aug 07, 2026`
 *   → week-ended columns 2025 Aug. 01 | 2026 Jul. 03, 10, 17, 24, 31
 *   → rows incl. Cash Reserve Ratio 3.00, Statutory Liquidity Ratio 18.00,
 *     Policy Repo Rate 5.25, Call Money Rate (Weighted Average) 5.30
 *
 * NOT mapped, on purpose: `Base Rate`, `MCLR (Overnight)` and
 * `Term Deposit Rate >1 Year` are published as bank RANGES ("8.40/10.00").
 * There is no single value to store, and {@link parseMacroNumber} rejects them
 * anyway — mapping them would only convert a clean skip into a counted one.
 */
const RBI_NSDP_RATES: MacroSource = {
  id: "rbi-nsdp-rates",
  archiveFeed: "nsdp-rates",
  url: `${NSDP}?param=4`,
  layout: "period-columns",
  verifiedOn: "2026-08-13",
  // Weekly, with 5 current-year columns in view. Three weeks of slack covers a
  // delayed WSS without letting a frozen page pass.
  maxAgeDays: 21,
  series: {
    "cash reserve ratio": {
      seriesId: "RBI_CRR",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "statutory liquidity ratio": {
      seriesId: "RBI_SLR",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "policy repo rate": {
      seriesId: "RBI_REPO_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "fixed reverse repo rate": {
      seriesId: "RBI_REVERSE_REPO_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    // Live label: "Standing Deposit Facility (SDF) Rate *".
    "standing deposit facility rate": {
      seriesId: "RBI_SDF_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "marginal standing facility rate": {
      seriesId: "RBI_MSF_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "bank rate": {
      seriesId: "RBI_BANK_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "savings deposit rate": {
      seriesId: "RBI_SAVINGS_DEPOSIT_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    // Live label: "Call Money Rate (Weighted Average)".
    "call money rate": {
      seriesId: "RBI_CALL_MONEY_RATE",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    // Live labels: "91-Day Treasury Bill (Primary) Yield" etc. — the
    // "(Primary)" is a stripped parenthetical, so it is absent from the key.
    "91-day treasury bill yield": {
      seriesId: "RBI_TBILL_91D_YIELD",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "182-day treasury bill yield": {
      seriesId: "RBI_TBILL_182D_YIELD",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    "364-day treasury bill yield": {
      seriesId: "RBI_TBILL_364D_YIELD",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    // Live label: "10-Year G-Sec Par Yield (FBIL)".
    "10-year g-sec par yield": {
      seriesId: "RBI_GSEC_10Y_PAR_YIELD",
      unit: "PERCENT",
      frequency: "WEEKLY",
    },
    // Live label: "INR-US$ Spot Rate (₹ Per Foreign Currency)". The rupee sign
    // lives only in the stripped parenthetical, never in this key.
    "inr-us$ spot rate": {
      seriesId: "RBI_INR_USD_SPOT",
      unit: "INR_PER_UNIT",
      frequency: "WEEKLY",
    },
    "inr-euro spot rate": {
      seriesId: "RBI_INR_EUR_SPOT",
      unit: "INR_PER_UNIT",
      frequency: "WEEKLY",
    },
  },
};

/**
 * `param=15` — the price-index table (WSS table 9T).
 *
 * VERIFIED 2026-08-13:
 *   GET https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=15
 *   → 200, text/html, ~96 KB, stamped `Date : Aug 07, 2026`
 *   → month columns 2025 Jun. | 2026 May, Jun. + three variation columns
 *   → rows: Consumer Price Index (2024=100) 107.0 · Rural 107.2 · Urban 106.7 ·
 *     CPI for Industrial Workers (2016=100) 151.9 ·
 *     Wholesale Price Index (2022-23=100) 110.2 · Primary Articles 116.1 ·
 *     Fuel and Power 111.1 · Manufactured Products 107.8
 *   → footer: "Sources: Ministry of Statistics and Program Implementation;
 *     Office of Economic Adviser; and Labour Bureau."
 *
 * That footer is why this one page satisfies the MOSPI and OEA halves of the
 * ticket: it is RBI republishing MOSPI's CPI and the OEA's WPI, attributed.
 *
 * The page's own `<th>` still reads "(Base : 1993 - 94 = 100)" while every row
 * carries its own current base — the heading is stale decoration, and nothing
 * here reads it.
 */
const RBI_NSDP_PRICES: MacroSource = {
  id: "rbi-nsdp-prices",
  archiveFeed: "nsdp-prices",
  url: `${NSDP}?param=15`,
  layout: "period-columns",
  verifiedOn: "2026-08-13",
  // Monthly, published with a ~5-week lag (Aug 07 release carries June). Two
  // months of slack on top of that.
  maxAgeDays: 100,
  series: {
    "consumer price index": {
      seriesId: "MOSPI_CPI_COMBINED",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    // Bare "Rural"/"Urban" rows — unambiguous only because `series` is scoped
    // to this source. See MacroSource.series.
    rural: {
      seriesId: "MOSPI_CPI_RURAL",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    urban: {
      seriesId: "MOSPI_CPI_URBAN",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    "consumer price index for industrial workers": {
      seriesId: "LABOURBUREAU_CPI_IW",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    "wholesale price index": {
      seriesId: "OEA_WPI_ALL_COMMODITIES",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    "primary articles": {
      seriesId: "OEA_WPI_PRIMARY_ARTICLES",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    "fuel and power": {
      seriesId: "OEA_WPI_FUEL_AND_POWER",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
    "manufactured products": {
      seriesId: "OEA_WPI_MANUFACTURED_PRODUCTS",
      unit: "INDEX",
      frequency: "MONTHLY",
    },
  },
};

/**
 * `param=2` — "Foreign Exchange Reserves" (WSS table 2T).
 *
 * VERIFIED 2026-08-13:
 *   GET https://www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=2
 *   → 200, text/html, ~98 KB, stamped `Date : Aug 07, 2026`
 *   → header `Item | As on Jul. 31, 2026 (₹ Cr., US$ Mn.) | Variation over
 *     Week / End-March 2026 / Year`
 *   → rows: 1 Total Reserves 6,612,148 ₹Cr / 692,866 US$Mn ·
 *     1.1 Foreign Currency Assets # · 1.2 Gold · 1.3 SDRs ·
 *     1.4 Reserve Position in the IMF
 *
 * This is the ONE-column page: it shows the latest week and nothing else, so a
 * missed run is a permanently missing week. That is why its schedule carries no
 * "we'll catch it next time" assumption.
 */
const RBI_NSDP_FOREX: MacroSource = {
  id: "rbi-nsdp-forex",
  archiveFeed: "nsdp-forex",
  url: `${NSDP}?param=2`,
  layout: "as-on-snapshot",
  verifiedOn: "2026-08-13",
  maxAgeDays: 21,
  series: {
    "total reserves": {
      seriesId: "RBI_FOREX_RESERVES_TOTAL",
      unit: "USD_MILLION",
      frequency: "WEEKLY",
    },
    // Live label: "1.1 Foreign Currency Assets #".
    "foreign currency assets": {
      seriesId: "RBI_FOREX_RESERVES_FCA",
      unit: "USD_MILLION",
      frequency: "WEEKLY",
    },
    gold: {
      seriesId: "RBI_FOREX_RESERVES_GOLD",
      unit: "USD_MILLION",
      frequency: "WEEKLY",
    },
    sdrs: {
      seriesId: "RBI_FOREX_RESERVES_SDR",
      unit: "USD_MILLION",
      frequency: "WEEKLY",
    },
    "reserve position in the imf": {
      seriesId: "RBI_FOREX_RESERVES_IMF_POSITION",
      unit: "USD_MILLION",
      frequency: "WEEKLY",
    },
  },
};

/**
 * Every macro source the worker may fetch.
 *
 * Mirrors `REPORT_REGISTRY`'s posture: this table is DATA, it holds only
 * live-verified entries, and anything unconfirmed belongs in the TODO block
 * below rather than here with an optimistic URL.
 */
export const MACRO_SOURCES: readonly MacroSource[] = [
  RBI_NSDP_RATES,
  RBI_NSDP_PRICES,
  RBI_NSDP_FOREX,
];

/** Look a source up by id; undefined for an unknown id. */
export function macroSourceById(id: string): MacroSource | undefined {
  return MACRO_SOURCES.find((s) => s.id === id);
}

/**
 * The sources a run should cover.
 *
 * An explicit `ids` list wins (operator re-run of one page); an id that matches
 * nothing is dropped rather than silently widening the run to everything, which
 * is the failure mode of a `length ? filtered : all` fallback.
 */
export function selectMacroSources(ids?: readonly string[]): MacroSource[] {
  if (ids === undefined || ids.length === 0) return [...MACRO_SOURCES];
  const wanted = new Set(ids);
  return MACRO_SOURCES.filter((s) => wanted.has(s.id));
}

// ─── NOT SHIPPED — written TODOs, with what is unknown ───────────────
//
// Both entries below were probed on 2026-08-13. Neither has a fetcher, because
// a fetcher pointed at a guessed endpoint returns `[]` and an empty window
// returns `[]`, and this phase has already paid for that confusion once
// (MONEY-1189 B2). Everything recorded here is an OBSERVATION, not a plan.
//
// ── TODO(MONEY-1106): IIP — Index of Industrial Production ───────────
//
// UNKNOWN: the `SECTION` identifier that MOSPI's data API expects for IIP.
//
// What was established:
//   * `https://cpi.mospi.gov.in/` — connection TIMED OUT after 30s from our
//     egress. Not a 404: the host did not answer at all.
//   * `https://www.mospi.gov.in/` and `https://esankhyiki.mospi.gov.in/` are
//     both SPAs (2.6 KB / 953 B shells). No server-rendered table to parse.
//   * eSankhyiki's bundle names its data API:
//       base   https://api.mospi.gov.in/api/esankhyiki/
//       route  GET records?SECTION=<id>&PAGE_NUMBER=&LIMIT=&filterData=
//   * That API is LIVE and unauthenticated —
//     `GET /api/esankhyiki/cms/getDashBoardData` returns real JSON.
//   * But `GET /api/esankhyiki/records?SECTION=IIP&PAGE_NUMBER=1&LIMIT=2` (with
//     and without `filterData={}`) returns **HTTP 200 with `text/html`** — the
//     swagger-ui SPA shell, 486 bytes. So `SECTION=IIP` is not the right id and
//     the endpoint answers a bad request with a 200 HTML page, which is exactly
//     the shape that must never be handed to an ingester.
//
// To finish it: capture the real XHR from https://esankhyiki.mospi.gov.in/viz/iip
// (the `SECTION` constant lives in a lazily-loaded chunk, not `main.js`), then
// add a source with `layout: "json"` and a `verifiedOn` date. Note the swagger
// index at https://esankhyiki.mospi.gov.in/EC/swagger-ui/index.html as a second
// lead.
//
// ── TODO(MONEY-1106): the OEA full WPI commodity tree ────────────────
//
// UNKNOWN: how to address any month other than the current one.
//
// What was established (URL and layout BOTH verified, so this is a depth
// upgrade rather than a missing series — headline WPI plus Primary Articles /
// Fuel and Power / Manufactured Products already ship via `rbi-nsdp-prices`):
//   * `https://eaindustry.nic.in/indx_download_2223/wpi_monthly_index_202607.xlsx`
//     → 200, `application/vnd.openxmlformats-…sheet`, 307,785 bytes.
//   * Sheet layout: one flat sheet, `Commodity Code | Commodity Name | <month
//     columns…>`, ~1,140 rows covering the whole 2022-23-base tree down to
//     individual commodities (Paddy, Wheat, Maize…). `xlsx` (SheetJS 0.20.3) is
//     already a dependency of both `@usemoney/core` and `@usemoney/workers`.
//   * The filename's `YYYYMM` token is NOT a date parameter. The prior month,
//     `wpi_monthly_index_202606.xlsx`, returns **HTTP 200 with 1,006 bytes** —
//     an error page, not a spreadsheet. So the site keeps only the current file
//     and a backfill loop would archive ~1 KB of HTML per month while reporting
//     success.
//
// To finish it: discover the current month's filename from the links on
// `https://eaindustry.nic.in/download_data_2223.asp` rather than constructing
// it, treat the feed as strictly forward-accruing (`backfillable: false`, the
// same call `report-registry.ts` makes for its rolling families), and add a
// `validateFeedPayload` shape that rejects the 1 KB HTML stand-in.
