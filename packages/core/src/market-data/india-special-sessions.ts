/**
 * Weekend special sessions on the Indian exchanges — MONEY-1613.
 *
 * Muhurat, Budget Saturdays and the DR Saturday sessions trade on a weekend.
 * Every date walker in this repo skips weekends by construction
 * (`weekdaysDescending`, `enumerateSessionCandidates`), so no India table in
 * the lake held one, and nothing logged it.
 *
 * ## THIS IS A LIST OF DATES TO TRY, NEVER A LIST OF SESSIONS
 *
 * Measured 2026-09-24 on the prod archive (read-only): across consecutive
 * files, PREVCLOSE != prior CLOSE on 40-98% of rows across 45 weekends, against
 * 0% on an ordinary weekend. That proves a session happened somewhere in the
 * weekend, not on which day. So each entry carries its EVIDENCE CLASS and
 * expands to every day it could have been:
 *
 *   exact       the day is known — the only delivery copy sits under the next
 *               weekday's key and its DATE1 names it
 *   sat-or-sun  Saturday or Sunday; the archive cannot say which
 *   sat-to-mon  Saturday, Sunday or Monday — the Monday is missing in every
 *               family, so it may have been a holiday or the session itself
 *
 * A date here becomes a session only when a file fetched for it carries that
 * date in its OWN date column ({@link checkSessionDate}). A 404, an HTML page or
 * another day's file is not one.
 *
 * The weekday 2021-11-04 Muhurat is NOT here: it is a weekday, the walkers
 * already visit it, and its only copy is a stale file under 05112021 that
 * MONEY-1612 refuses.
 */

import { decodeFeedText } from "./bhavcopy";
import { splitCsvLine } from "./csv-line";

export type SpecialSessionEvidence = "exact" | "sat-or-sun" | "sat-to-mon";

export interface SpecialSessionWeekend {
  /** `exact`: the session date. Otherwise the weekend's Saturday. */
  anchor: string;
  evidence: SpecialSessionEvidence;
}

const exact = (anchor: string): SpecialSessionWeekend => ({
  anchor,
  evidence: "exact",
});
const satOrSun = (anchor: string): SpecialSessionWeekend => ({
  anchor,
  evidence: "sat-or-sun",
});
const satToMon = (anchor: string): SpecialSessionWeekend => ({
  anchor,
  evidence: "sat-to-mon",
});

export const INDIA_SPECIAL_SESSION_WEEKENDS: readonly SpecialSessionWeekend[] =
  [
    // Held under the next weekday's delivery key (sec_bhavdata_full).
    exact("2019-10-27"), // Sunday Muhurat — 28102019, 1,799 rows
    exact("2020-11-14"), // Saturday Muhurat — 16112020, 1,876 rows
    exact("2024-01-20"), // Saturday full session — 22012024, 2,549 rows
    exact("2024-05-18"), // Saturday DR session — 20052024, 2,449 rows

    satOrSun("1996-07-06"),
    satOrSun("1996-07-20"),
    satOrSun("1996-11-09"),
    satOrSun("1997-03-01"),
    satOrSun("1998-10-31"),
    satOrSun("1998-11-21"),
    satOrSun("1998-11-28"),
    satOrSun("1999-02-27"),
    satOrSun("1999-03-20"),
    satOrSun("1999-04-17"),
    satOrSun("1999-10-23"),
    satOrSun("2001-06-30"),
    satOrSun("2003-03-22"),
    satOrSun("2003-10-25"),
    satOrSun("2003-11-15"),
    satOrSun("2004-04-17"),
    satOrSun("2004-10-09"),
    satOrSun("2005-06-04"),
    satOrSun("2005-11-26"),
    satOrSun("2006-06-24"),
    satOrSun("2006-10-21"),
    satOrSun("2010-02-06"),
    satOrSun("2012-01-07"),
    satOrSun("2012-03-03"),
    satOrSun("2012-04-28"),
    satOrSun("2012-09-08"),
    satOrSun("2013-05-11"),
    satOrSun("2014-03-22"),
    satOrSun("2015-02-28"),
    satOrSun("2020-02-01"), // Budget Saturday
    satOrSun("2023-11-11"),
    satOrSun("2024-03-02"),
    satOrSun("2025-02-01"), // Budget Saturday
    satOrSun("2026-01-31"),

    satToMon("1995-09-02"),
    satToMon("1997-04-12"),
    satToMon("1999-11-06"),
    satToMon("2006-04-29"),
    satToMon("2009-10-17"),
    satToMon("2013-11-02"),
    satToMon("2016-10-29"),
  ];

const DAYS_TRIED: Readonly<Record<SpecialSessionEvidence, number>> = {
  exact: 1,
  "sat-or-sun": 2,
  "sat-to-mon": 3,
};

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every date to try, ascending, each once. */
export function specialSessionCandidateDates(): string[] {
  const out = new Set<string>();
  for (const w of INDIA_SPECIAL_SESSION_WEEKENDS) {
    for (let i = 0; i < DAYS_TRIED[w.evidence]; i++) {
      out.add(addDays(w.anchor, i));
    }
  }
  return [...out].sort();
}

/* ─────────────────────────────────────────────────────────────────────────
   Which session does a file hold? Its OWN date column says.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The date column of every family the four India lake tables read, by header
 * name. The same set the MONEY-1613 measurement read across 24,566 archived
 * objects in 9 families.
 *
 *   TRADDT        UDiFF cash + F&O, NSE and BSE      2024-01-20
 *   TIMESTAMP     NSE legacy cash + F&O              20-JAN-2024
 *   DATE1         sec_bhavdata_full                  20-Jan-2024
 *   INDEX DATE    ind_close_all (both prefixes)      20-01-2024
 *   TRADING_DATE  BSE EQ_ISINCODE, mid-2017 onward   20-Jan-24
 *
 * BSE's `eq{DDMMYY}_csv.zip` has NO date column, so it can never prove a
 * weekend session and is never archived as one.
 */
const DATE_COLUMNS: readonly string[] = [
  "TRADDT",
  "TIMESTAMP",
  "DATE1",
  "INDEX DATE",
  "TRADING_DATE",
];

const MONTHS = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC";

/**
 * The all-numeric `DD-MM-YYYY` shape (`Index Date`). ind_close_all wrote
 * MM-DD-YYYY for 06, 10 and 11 Apr 2023, so a day/month swap is possible here
 * and nowhere else.
 */
const NUMERIC_DM = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

/**
 * Families whose files carry NO date column — BSE `eq{DDMMYY}_csv.zip`. They
 * can never prove a weekend session, so the special-session walk skips them
 * by default rather than spend requests on a refusal.
 */
export const FAMILIES_WITHOUT_DATE_COLUMN: readonly string[] = [
  "bse-cm-legacy",
];

/** One date cell -> `YYYY-MM-DD`, or null. Rejects a day that rolls over. */
function parseDateCell(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (hit) {
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else if ((hit = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}|\d{2})$/.exec(s))) {
    const idx = MONTHS.indexOf(hit[2]!.toUpperCase());
    if (idx < 0 || idx % 3 !== 0) return null;
    const yy = Number(hit[3]);
    y = hit[3]!.length === 2 ? (yy < 70 ? 2000 + yy : 1900 + yy) : yy;
    [m, d] = [idx / 3 + 1, Number(hit[1])];
  } else if ((hit = NUMERIC_DM.exec(s))) {
    [y, m, d] = [Number(hit[3]), Number(hit[2]), Number(hit[1])];
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export interface FileSessionDates {
  /** The header the dates were read from. */
  column: string;
  /** Distinct dates the rows carry, ascending. */
  dates: string[];
  /** Data rows whose date cell did not parse. */
  unparsed: number;
  /**
   * Lines shorter than the header, skipped — NSE's `*Updated` trailer on a
   * regenerated legacy file (MONEY-1618). The parsers skip it too.
   */
  trailers: number;
  /** Some date was read from the all-numeric `DD-MM-YYYY` shape. */
  numericDayMonth: boolean;
}

/** The dates a CSV's own date column carries, or null when it has none. */
export function readFileSessionDates(text: string): FileSessionDates | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const header = splitCsvLine(lines[0]!).map((h) =>
    h
      .replace(/^\uFEFF/, "")
      .trim()
      .toUpperCase(),
  );
  const idx = header.findIndex((h) => DATE_COLUMNS.includes(h));
  if (idx < 0) return null;
  const dates = new Set<string>();
  let unparsed = 0;
  let trailers = 0;
  let numericDayMonth = false;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    if (cells.length < header.length) {
      trailers++;
      continue;
    }
    const cell = cells[idx]!.trim();
    const iso = parseDateCell(cell);
    if (!iso) {
      unparsed++;
      continue;
    }
    dates.add(iso);
    if (NUMERIC_DM.test(cell)) numericDayMonth = true;
  }
  return {
    column: header[idx]!,
    dates: [...dates].sort(),
    unparsed,
    trailers,
    numericDayMonth,
  };
}

/**
 * `terminal` is true when the file positively holds ANOTHER session and not
 * the requested one — a stale or next-day copy. Re-asking cannot change that,
 * so the walker records the date MISSING. Everything else it cannot prove is
 * retried.
 */
export type SessionDateCheck =
  | { ok: true }
  | { ok: false; reason: string; terminal: boolean };

/**
 * Is `body` the session of `requested` (`YYYY-MM-DD`)? Only when EVERY row's
 * own date is that day. Run on the bytes BEFORE the archive write, so a stale
 * copy is never archived under a weekend key.
 */
export function checkSessionDate(
  body: Buffer,
  requested: string,
): SessionDateCheck {
  let text: string;
  try {
    text = decodeFeedText(body);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, terminal: false, reason: `unreadable — ${why}` };
  }
  const read = readFileSessionDates(text);
  if (!read) {
    return {
      ok: false,
      terminal: false,
      reason: "no date column — the file cannot prove which session it holds",
    };
  }
  if (read.unparsed > 0) {
    return {
      ok: false,
      terminal: false,
      reason: `${read.unparsed} row(s) with an unreadable ${read.column}`,
    };
  }
  if (read.dates.length === 0) {
    return { ok: false, terminal: false, reason: "no data rows" };
  }
  if (read.dates.length === 1 && read.dates[0] === requested) {
    return { ok: true };
  }
  const other = read.dates.filter((d) => d !== requested);
  // A DD-MM date that reads as `requested` with day and month swapped may be
  // this very session written MM-DD — not provably another day, so retried.
  const swapped =
    read.numericDayMonth &&
    read.dates.some(
      (d) => `${d.slice(0, 4)}-${d.slice(8)}-${d.slice(5, 7)}` === requested,
    );
  return {
    ok: false,
    terminal: !read.dates.includes(requested) && !swapped,
    reason: `${read.column} holds ${other.join(", ")}, not ${requested}`,
  };
}
