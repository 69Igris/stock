/**
 * Events-sync PURE LOGIC — MONEY-1098 (P5.3).
 *
 * Everything in this file is a pure function: no Prisma, no fetch, no timers, no
 * `Date.now()` that isn't injected. The IO orchestration lives in
 * `events-sync.ts`; the shape decisions live here because they are the part that
 * is actually hard to get right and the only part worth pinning with tests.
 *
 * ## Why the source swapped (Yahoo -> NSE)
 *
 * `events-sync` used to resolve the next earnings date by asking Yahoo Finance
 * `calendarEvents` ONCE PER SYMBOL. That is N requests for N symbols, capped at
 * 200, against a source that reports Indian board-meeting dates late and
 * sometimes not at all. NSE publishes the same information as the primary
 * record — the board meeting itself — over TWO whole-universe endpoints that
 * take a date WINDOW:
 *
 *   - `/api/corporate-board-meetings` — every scheduled board meeting in the
 *     window, with the purpose text ("Financial Results", "Dividend", ...)
 *   - `/api/event-calendar`           — the same calendar keyed by event, which
 *     is where a results date shows up when the board meeting row is late
 *
 * Two requests now cover the ENTIRE listed market instead of 200 symbols, so
 * Yahoo demotes to a per-symbol FALLBACK for exactly the symbols the NSE window
 * did not mention ({@link selectFallbackSymbols}).
 *
 * ## Why the parsers are key-driven and never throw
 *
 * NSE's JSON field names are not documented and have changed under us before
 * (`bm_symbol` vs `symbol`, `bm_date` vs `date`), and the payload is sometimes a
 * bare array and sometimes wrapped. So the parsers look values up by a LIST of
 * candidate keys rather than a fixed shape, and anything they cannot key becomes
 * a COUNTED SKIP, not an exception and not a silently-dropped row. A scheduled
 * job that throws is a dead job; a scheduled job that silently drops rows is
 * worse, because the count still looks like a number.
 *
 * NOTE ON FIXTURES: the test fixtures for both endpoints are **SYNTHETIC** —
 * hand-written from the endpoint names and NSE's house style, not captured from
 * a live response (no live NSE calls during development). They pin the PARSER's
 * tolerance, not NSE's exact contract. The first live capture should be added
 * alongside them, not instead of them.
 */

const MS_PER_DAY = 86_400_000;

/** The `UpcomingEvent.category` vocabulary this job writes. */
export type EventCategory = "earnings" | "dividend" | "splits" | "corp_action";

/**
 * `UpcomingEvent.source` — MONEY-1098 narrows this to a two-value vocabulary so
 * "which feed produced this row" is answerable in a query instead of a LIKE.
 */
export type EventSource = "NSE" | "YAHOO";

/** A normalized row from either NSE events endpoint. */
export interface NseEventRow {
  /** Bare NSE symbol, upper-cased (e.g. "RELIANCE"). */
  symbol: string;
  /** Company long name when the payload carries one, else "". */
  company: string;
  /** Event date, floored to UTC midnight. */
  date: Date;
  /** Raw purpose text ("Financial Results", "Dividend", ...). */
  purpose: string;
  /** Longer descriptor when present, else "". */
  description: string;
}

/**
 * The outcome of parsing one endpoint response. `skipped` and
 * `unrecognizedPayload` exist so the caller can LOG a degradation instead of
 * mistaking it for an empty market.
 */
export interface NseEventParseResult {
  rows: NseEventRow[];
  /** Rows that were present but unusable (no symbol, or no parseable date). */
  skipped: number;
  /** True when the payload wasn't a recognised list container at all. */
  unrecognizedPayload: boolean;
}

/** A persist-ready `UpcomingEvent` row. */
export interface UpcomingEventRow {
  date: Date;
  symbol: string;
  title: string;
  category: EventCategory;
  source: EventSource;
}

// ── Date handling ────────────────────────────────────────────────────────────

const MONTH_ABBR: Record<string, number> = {
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

/**
 * Parse the date formats NSE's event endpoints emit into a UTC-midnight `Date`.
 *
 * Handled: `22-Apr-2026`, `22-APR-2026`, `22-04-2026` (DD-MM-YYYY, NSE's query
 * format echoed back), `2026-04-22`, and full ISO timestamps. Returns `null` for
 * anything else — never an Invalid Date.
 *
 * Hand-rolled rather than `new Date(raw)` because V8 parses `22-Apr-2026` in the
 * LOCAL zone (so a worker in UTC and a dev box in IST disagree about which day
 * it is) and reads a bare `04-22-2026`-shaped string as American. Both bugs are
 * invisible until an event lands on the wrong side of the "is it in the past"
 * cutoff.
 */
export function parseNseEventDate(raw: unknown): Date | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : startOfUtcDay(raw);
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // DD-MMM-YYYY (NSE's display format), separator - or space or /
  const abbr = /^(\d{1,2})[-/\s]([A-Za-z]{3})[A-Za-z]*[-/\s](\d{4})$/.exec(s);
  if (abbr) {
    const month = MONTH_ABBR[abbr[2]!.toLowerCase()];
    if (month === undefined) return null;
    return buildUtcDate(Number(abbr[3]), month, Number(abbr[1]));
  }

  // DD-MM-YYYY (NSE's own query format, echoed back by some rows).
  //
  // `\d{1,2}`, not `\d{2}`: NSE emits UNPADDED components ("9-07-2026") — the
  // same shape MONEY-1097 caught it both emitting and requiring, and the one
  // the sibling `parseEventDate` in ownership-logic already accepts. Requiring
  // padding silently dropped those rows into the generic `skipped` count,
  // where a parser gap is indistinguishable from an ordinary malformed row.
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) {
    return buildUtcDate(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  }

  // YYYY-MM-DD, optionally followed by a time component we don't need.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    return buildUtcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  return null;
}

/** Build a UTC date, rejecting values JS would silently roll over (31 Feb). */
function buildUtcDate(year: number, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d;
}

/**
 * Floor to UTC midnight.
 *
 * UTC, not local: the workers run in UTC on Cloud Run but a developer's box does
 * not, and this value is the "is this event in the past" cutoff. A cutoff that
 * moves with the machine's zone is a test that passes in CI and fails at 06:00
 * IST.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * The forward-looking `[from, to]` window the NSE endpoints are asked for.
 * `from` is today (so a meeting announced for today still lands) and `to` is
 * `forwardDays` days out.
 */
export function forwardWindow(
  now: Date,
  forwardDays: number,
): { from: Date; to: Date } {
  const from = startOfUtcDay(now);
  const days =
    Number.isFinite(forwardDays) && forwardDays > 0 ? forwardDays : 1;
  return { from, to: new Date(from.getTime() + Math.floor(days) * MS_PER_DAY) };
}

// ── Payload / row extraction (key-driven) ────────────────────────────────────

/**
 * Pull the row array out of whatever container NSE used. Bare array, or one of
 * the wrapper keys it has been observed to use. Returns `null` (not `[]`) when
 * nothing looks like a row list, so the caller can distinguish "empty window"
 * from "shape we don't recognise".
 */
export function extractEventRows(
  resp: unknown,
): Record<string, unknown>[] | null {
  if (Array.isArray(resp)) return resp as Record<string, unknown>[];
  if (resp && typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    for (const key of ["data", "rows", "Table", "records", "result"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return null;
}

/** First non-empty string/number value among `keys`, trimmed. "" when none. */
function pick(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/**
 * The candidate key lists for one endpoint. Explicit lists rather than a fuzzy
 * match: a fuzzy `includes("date")` would happily bind `bm_timestamp` (the
 * ANNOUNCEMENT time) to the meeting date, which is a wrong answer that looks
 * right.
 */
export interface EventKeyMap {
  symbol: readonly string[];
  company: readonly string[];
  date: readonly string[];
  purpose: readonly string[];
  description: readonly string[];
}

/** `/api/corporate-board-meetings` field names (+ tolerated aliases). */
export const BOARD_MEETING_KEYS: EventKeyMap = {
  symbol: ["bm_symbol", "symbol", "Symbol"],
  company: ["sm_name", "company", "companyName", "comp_name"],
  // `bm_date` is the MEETING date; `bm_timestamp` is when the intimation was
  // filed and is deliberately NOT in this list.
  date: ["bm_date", "meetingDate", "date"],
  purpose: ["bm_purpose", "purpose", "purposeOfMeeting"],
  description: ["bm_desc", "description", "attchmntText"],
};

/** `/api/event-calendar` field names (+ tolerated aliases). */
export const EVENT_CALENDAR_KEYS: EventKeyMap = {
  symbol: ["symbol", "bm_symbol", "Symbol"],
  company: ["company", "sm_name", "companyName"],
  date: ["date", "bm_date", "eventDate"],
  purpose: ["purpose", "bm_purpose"],
  description: ["bm_desc", "description"],
};

/**
 * Parse one NSE events payload into normalized rows using `keys`.
 *
 * Never throws. A row without a usable symbol OR without a parseable date is a
 * counted skip. A payload that isn't a recognised list container yields
 * `unrecognizedPayload: true` and zero rows — the signal that NSE changed shape,
 * which otherwise reads identically to a quiet week.
 */
export function parseNseEvents(
  resp: unknown,
  keys: EventKeyMap,
): NseEventParseResult {
  const raw = extractEventRows(resp);
  if (raw === null) {
    return { rows: [], skipped: 0, unrecognizedPayload: true };
  }

  const rows: NseEventRow[] = [];
  let skipped = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skipped++;
      continue;
    }
    const row = item as Record<string, unknown>;
    const symbol = pick(row, keys.symbol)
      .toUpperCase()
      .replace(/\.(NS|BO)$/i, "");
    const date = parseNseEventDate(row[firstPresent(row, keys.date)]);
    if (!symbol || !date) {
      skipped++;
      continue;
    }
    rows.push({
      symbol,
      company: pick(row, keys.company),
      date,
      purpose: pick(row, keys.purpose),
      description: pick(row, keys.description),
    });
  }
  return { rows, skipped, unrecognizedPayload: false };
}

/** First key in `keys` that the row actually carries (so `pick`-style lookup
 *  works for the date too, where the VALUE may legitimately be a Date). */
function firstPresent(
  row: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return k;
  }
  return keys[0] ?? "";
}

/** Convenience wrappers so call sites read as the endpoint they came from. */
export function parseBoardMeetings(resp: unknown): NseEventParseResult {
  return parseNseEvents(resp, BOARD_MEETING_KEYS);
}

export function parseEventCalendar(resp: unknown): NseEventParseResult {
  return parseNseEvents(resp, EVENT_CALENDAR_KEYS);
}

// ── Purpose -> category ──────────────────────────────────────────────────────

/**
 * Does this purpose text mean "the company is declaring results"?
 *
 * NSE writes it as "Financial Results", "Quarterly Results", "Audited Results",
 * "Results" and combinations ("Financial Results/Dividend"). Substring on
 * "result" is deliberately loose here: the cost of a false positive is one extra
 * earnings row on a calendar, while the cost of a false negative is a missed
 * earnings reminder — which is the entire point of the job.
 */
export function isFinancialResultsPurpose(purpose: string): boolean {
  return /result/i.test(purpose);
}

/**
 * Map a board-meeting purpose to an `UpcomingEvent.category`.
 *
 * Order matters: a combined "Financial Results/Dividend" purpose is primarily an
 * earnings event (that is the date users are alerted on); the dividend detail
 * survives in the title, and the authoritative ex-date row is written separately
 * by the corp-actions leg.
 */
export function nseEventCategory(purpose: string): EventCategory {
  if (isFinancialResultsPurpose(purpose)) return "earnings";
  if (/dividend/i.test(purpose)) return "dividend";
  if (/split|sub-?division|face value/i.test(purpose)) return "splits";
  return "corp_action";
}

/**
 * Build the human title stored on the row. Keeps the `${symbol} ${what}` shape
 * the alert notifications already render, and appends the purpose/description
 * detail bounded to a sane length (`UpcomingEvent.title` is displayed inline).
 */
export function buildNseEventTitle(
  row: NseEventRow,
  category: EventCategory,
): string {
  const head = category === "earnings" ? "earnings" : "corporate action";
  const detail = (row.purpose || row.description || "").trim();
  const suffix = detail ? ` — ${detail}`.slice(0, 120) : "";
  return `${row.symbol} ${head}${suffix}`;
}

// ── Row assembly ─────────────────────────────────────────────────────────────

/**
 * Turn parsed NSE rows into persist-ready `UpcomingEvent` rows, dropping
 * anything before `startOfToday`.
 *
 * FORWARD-ONLY is inherited, not invented: `UpcomingEvent` has always been a
 * forward calendar (the history lives in `CorporateAction`, which is
 * history-preserving on purpose). Keeping the same cutoff means the existing
 * delete-then-insert idempotency still describes the whole table.
 */
export function toUpcomingEventRows(
  rows: readonly NseEventRow[],
  startOfToday: Date,
  source: EventSource = "NSE",
): UpcomingEventRow[] {
  const out: UpcomingEventRow[] = [];
  for (const row of rows) {
    if (row.date.getTime() < startOfToday.getTime()) continue;
    const category = nseEventCategory(row.purpose || row.description);
    out.push({
      date: row.date,
      symbol: row.symbol,
      title: buildNseEventTitle(row, category),
      category,
      source,
    });
  }
  return out;
}

/** Stable identity of an event row: one symbol, one category, one day. */
export function upcomingEventKey(row: UpcomingEventRow): string {
  return `${row.symbol}|${row.category}|${row.date.toISOString()}`;
}

/**
 * Collapse duplicates across the two NSE endpoints (a results board meeting
 * appears in BOTH `corporate-board-meetings` and `event-calendar`) and across
 * the NSE/Yahoo boundary.
 *
 * Precedence: NSE beats YAHOO — NSE is the primary record and Yahoo is only a
 * fallback for symbols NSE never mentioned, so a collision means Yahoo guessed
 * at something NSE stated. Within the same source, the LONGER title wins (it
 * carries the purpose detail); ties keep the first occurrence, which makes the
 * function order-stable and therefore testable.
 */
export function dedupeUpcomingEvents(
  rows: readonly UpcomingEventRow[],
): UpcomingEventRow[] {
  const byKey = new Map<string, UpcomingEventRow>();
  for (const row of rows) {
    const key = upcomingEventKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    if (existing.source === row.source) {
      if (row.title.length > existing.title.length) byKey.set(key, row);
      continue;
    }
    if (existing.source === "YAHOO" && row.source === "NSE") {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

/**
 * The symbols Yahoo still has to be asked about: the tracked targets that the
 * whole-universe NSE window produced NO earnings row for.
 *
 * Only EARNINGS coverage counts. A symbol whose only NSE row is a dividend board
 * meeting still has an unknown results date, and that is exactly what the
 * EARNINGS_DATE alert path reads.
 */
export function selectFallbackSymbols(
  targets: readonly string[],
  nseRows: readonly UpcomingEventRow[],
): string[] {
  const covered = new Set(
    nseRows.filter((r) => r.category === "earnings").map((r) => r.symbol),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    const s = t.toUpperCase();
    if (covered.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Group rows by category so the writer can run ONE scoped delete + insert per
 * category — which is what makes the job idempotent (see `events-sync.ts`).
 */
export function groupByCategory(
  rows: readonly UpcomingEventRow[],
): Map<EventCategory, UpcomingEventRow[]> {
  const map = new Map<EventCategory, UpcomingEventRow[]>();
  for (const row of rows) {
    const arr = map.get(row.category);
    if (arr) arr.push(row);
    else map.set(row.category, [row]);
  }
  return map;
}

/**
 * Split an array into fixed-size batches.
 *
 * The whole-universe swap turned `symbol: { in: [...] }` from ~200 entries into
 * potentially a few thousand, and an unbounded `$in` is how a Mongo query goes
 * from fast to a timeout without ever being wrong. `size <= 0` degrades to one
 * batch rather than looping forever.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const n =
    Number.isFinite(size) && size >= 1 ? Math.floor(size) : items.length;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * The symbols one run fetches calendars for — MONEY-1217.
 *
 * ## Why this is a function and not a `[...a, ...b].slice()`
 *
 * The population it selects from grew by ~7.6x. `gatherTargetSymbols` used to
 * union alerts + holdings + watchlist, which is ~102 symbols on prod, and
 * sliced to `maxSymbols` (200) — so the cap never bound and the ORDER never
 * mattered. Widening to the warm sync tier (~781: + every index constituent)
 * makes both load-bearing at once:
 *
 *   - the cap now BINDS every run, so which symbols land in it is a real
 *     decision rather than an accident of `Set` insertion order;
 *   - the Yahoo fallback is per-symbol, so an unordered 781 is 781 requests a
 *     night at a source that rate-limits.
 *
 * ## The ordering rule
 *
 * ALERT targets first, unconditionally. An active `EARNINGS_DATE` alert is a
 * user explicitly asking to be told about one symbol; letting a rotation
 * postpone it for four nights is the one failure here a user would actually
 * notice. The old code put alerts into the same `Set` as everything else and
 * sliced, so a large enough holdings list could already silently drop them —
 * this is a fix, not just a re-ordering.
 *
 * `rotation` is expected to arrive stale-first (the caller orders on
 * `eventsSyncedAt asc`, nulls first). This function does not re-sort it: the
 * staleness lives in the database, and re-deriving it here from data we do not
 * have is how a pure helper starts lying about what it can know.
 *
 * @param alerts   symbols with an active earnings alert — never dropped unless
 *                 they alone exceed the cap.
 * @param rotation the tier population, stale-first.
 * @param maxSymbols per-run ceiling; `<= 0` or non-finite degrades to "no cap"
 *                 rather than to zero, because a zero-length target list is
 *                 indistinguishable from a dead job in the logs.
 */
export function selectEventTargets(
  alerts: readonly string[],
  rotation: readonly string[],
  maxSymbols: number,
): string[] {
  const cap =
    Number.isFinite(maxSymbols) && maxSymbols > 0
      ? Math.floor(maxSymbols)
      : Number.POSITIVE_INFINITY;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [alerts, rotation]) {
    for (const raw of list) {
      if (out.length >= cap) return out;
      // Upper-cased on the way in because both NSE's window and the alert rows
      // are compared against this set by exact string, and a lower-case symbol
      // would silently never match. Blanks are absence, never a symbol.
      const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
