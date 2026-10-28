/**
 * UNIT TEST — events-sync pure logic (MONEY-1098 / P5.3).
 *
 * Exercises the REAL exports from `workers/src/processors/events-sync-logic.ts`
 * (no shadow copies): the two NSE response parsers, the purpose->category
 * mapper, the forward-only row assembly, the NSE-beats-Yahoo dedupe, and the
 * fallback-set selection.
 *
 * ## The fixtures are SYNTHETIC
 *
 * No live NSE calls were made building this. Every payload below is
 * hand-written from the endpoint names and NSE's house field-naming style
 * (`bm_symbol`, `bm_date`, `sm_name`, ...) — they pin the PARSER's TOLERANCE,
 * not NSE's exact contract. Treat a real capture as an ADDITION to these, never
 * a replacement: the aliases and the malformed rows are the cases a happy-path
 * capture will not contain.
 *
 * Pure functions only: no Prisma, no fetch, no timers — nothing here can orphan
 * the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseNseEventDate,
  startOfUtcDay,
  forwardWindow,
  extractEventRows,
  parseNseEvents,
  parseBoardMeetings,
  parseEventCalendar,
  BOARD_MEETING_KEYS,
  isFinancialResultsPurpose,
  nseEventCategory,
  buildNseEventTitle,
  toUpcomingEventRows,
  upcomingEventKey,
  dedupeUpcomingEvents,
  selectFallbackSymbols,
  selectEventTargets,
  groupByCategory,
  chunk,
  type UpcomingEventRow,
} from "../../src/processors/events-sync-logic";

const utc = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d));

// ── SYNTHETIC fixtures ───────────────────────────────────────────────────────

/**
 * SYNTHETIC `/api/corporate-board-meetings` payload. Row 3 deliberately uses the
 * ALIAS key names, row 4 has no symbol, row 5 has an unparseable date, row 6 is
 * not an object at all — every one of those must be a counted skip, not a throw.
 */
const BOARD_MEETINGS_FIXTURE: unknown = [
  {
    bm_symbol: "RELIANCE",
    sm_name: "Reliance Industries Limited",
    bm_purpose: "Financial Results",
    bm_desc: "Quarterly Results for Q1 FY27",
    bm_date: "22-Apr-2026",
    bm_timestamp: "10-Apr-2026 18:04:11",
    attchmntFile: "",
  },
  {
    bm_symbol: "HDFCBANK",
    sm_name: "HDFC Bank Limited",
    bm_purpose: "Dividend",
    bm_desc: "Consideration of dividend",
    bm_date: "05-May-2026",
    bm_timestamp: "20-Apr-2026 12:00:00",
  },
  {
    // Alias shape: bare `symbol` / `date` / `purpose`.
    symbol: "tcs",
    company: "Tata Consultancy Services Limited",
    purpose: "Financial Results/Dividend",
    date: "15-04-2026",
  },
  {
    sm_name: "No Symbol Ltd",
    bm_purpose: "Financial Results",
    bm_date: "01-May-2026",
  },
  {
    bm_symbol: "BADDATE",
    bm_purpose: "Financial Results",
    bm_date: "not a date",
  },
  "definitely not a row",
];

/** SYNTHETIC `/api/event-calendar` payload, wrapped in the `data` container. */
const EVENT_CALENDAR_FIXTURE: unknown = {
  data: [
    {
      symbol: "INFY",
      company: "Infosys Limited",
      purpose: "Financial Results",
      bm_desc: "Audited Financial Results",
      date: "17-Apr-2026",
    },
    {
      symbol: "ITC",
      company: "ITC Limited",
      purpose: "Buy Back of Shares",
      date: "02-Jun-2026",
    },
  ],
};

// ── Date handling ────────────────────────────────────────────────────────────

describe("parseNseEventDate", () => {
  it("parses NSE's DD-MMM-YYYY display format as UTC midnight", () => {
    assert.strictEqual(
      parseNseEventDate("22-Apr-2026")!.toISOString(),
      "2026-04-22T00:00:00.000Z",
    );
    assert.strictEqual(
      parseNseEventDate("05-MAY-2026")!.toISOString(),
      "2026-05-05T00:00:00.000Z",
    );
    assert.strictEqual(
      parseNseEventDate("5-Jun-2026")!.toISOString(),
      "2026-06-05T00:00:00.000Z",
    );
  });

  it("parses DD-MM-YYYY (NSE's own query format echoed back)", () => {
    assert.strictEqual(
      parseNseEventDate("15-04-2026")!.toISOString(),
      "2026-04-15T00:00:00.000Z",
    );
  });

  it("parses ISO dates and ISO timestamps, keeping the calendar day", () => {
    assert.strictEqual(
      parseNseEventDate("2026-04-22")!.toISOString(),
      "2026-04-22T00:00:00.000Z",
    );
    assert.strictEqual(
      parseNseEventDate("2026-04-22T09:30:00.000Z")!.toISOString(),
      "2026-04-22T00:00:00.000Z",
    );
  });

  it("accepts a Date and floors it to UTC midnight", () => {
    assert.strictEqual(
      parseNseEventDate(new Date("2026-04-22T23:59:59Z"))!.toISOString(),
      "2026-04-22T00:00:00.000Z",
    );
  });

  it("returns null (never Invalid Date) for junk, wrong types and rollovers", () => {
    assert.strictEqual(parseNseEventDate("not a date"), null);
    assert.strictEqual(parseNseEventDate(""), null);
    assert.strictEqual(parseNseEventDate("   "), null);
    assert.strictEqual(parseNseEventDate(null), null);
    assert.strictEqual(parseNseEventDate(undefined), null);
    assert.strictEqual(parseNseEventDate(1745270400), null);
    assert.strictEqual(parseNseEventDate(new Date("nope")), null);
    // 31 Feb would silently become 2 Mar via Date.UTC.
    assert.strictEqual(parseNseEventDate("31-Feb-2026"), null);
    assert.strictEqual(parseNseEventDate("31-02-2026"), null);
    // A month abbreviation that isn't one.
    assert.strictEqual(parseNseEventDate("22-Xyz-2026"), null);
  });
});

describe("startOfUtcDay / forwardWindow", () => {
  it("floors to UTC midnight regardless of the host zone", () => {
    assert.strictEqual(
      startOfUtcDay(new Date("2026-08-08T21:15:00.000Z")).toISOString(),
      "2026-08-08T00:00:00.000Z",
    );
  });

  it("builds a [today, today+N] window", () => {
    const { from, to } = forwardWindow(new Date("2026-08-08T13:00:00Z"), 30);
    assert.strictEqual(from.toISOString(), "2026-08-08T00:00:00.000Z");
    assert.strictEqual(to.toISOString(), "2026-09-07T00:00:00.000Z");
  });

  it("clamps a nonsense forwardDays to at least one day", () => {
    for (const bad of [0, -5, Number.NaN]) {
      const { from, to } = forwardWindow(new Date("2026-08-08T00:00:00Z"), bad);
      assert.strictEqual(to.getTime() - from.getTime(), 86_400_000);
    }
  });
});

// ── Container extraction ─────────────────────────────────────────────────────

describe("extractEventRows", () => {
  it("accepts a bare array and every observed wrapper key", () => {
    assert.deepStrictEqual(extractEventRows([{ a: 1 }]), [{ a: 1 }]);
    for (const key of ["data", "rows", "Table", "records", "result"]) {
      assert.deepStrictEqual(extractEventRows({ [key]: [{ a: 1 }] }), [
        { a: 1 },
      ]);
    }
  });

  it("returns null — not [] — for a shape it doesn't recognise", () => {
    // The distinction is the whole point: [] means "quiet week", null means
    // "NSE changed and we are now blind".
    assert.strictEqual(extractEventRows(null), null);
    assert.strictEqual(extractEventRows(undefined), null);
    assert.strictEqual(extractEventRows("<html>challenge</html>"), null);
    assert.strictEqual(extractEventRows({ message: "no data" }), null);
    assert.strictEqual(extractEventRows(42), null);
  });
});

// ── Parsers ──────────────────────────────────────────────────────────────────

describe("parseBoardMeetings (SYNTHETIC fixture)", () => {
  const out = parseBoardMeetings(BOARD_MEETINGS_FIXTURE);

  it("keeps the three usable rows and COUNTS the three unusable ones", () => {
    assert.strictEqual(out.rows.length, 3);
    assert.strictEqual(out.skipped, 3); // no symbol + bad date + non-object
    assert.strictEqual(out.unrecognizedPayload, false);
  });

  it("normalizes the symbol (upper-case, exchange suffix stripped)", () => {
    assert.deepStrictEqual(
      out.rows.map((r) => r.symbol),
      ["RELIANCE", "HDFCBANK", "TCS"],
    );
  });

  it("reads the MEETING date, not the intimation timestamp", () => {
    // `bm_timestamp` (10-Apr) is when the filing landed; `bm_date` (22-Apr) is
    // the meeting. Binding the wrong one is a wrong answer that looks right.
    assert.strictEqual(
      out.rows[0]!.date.toISOString(),
      "2026-04-22T00:00:00.000Z",
    );
  });

  it("tolerates the alias key shape (symbol / date / purpose)", () => {
    const tcs = out.rows.find((r) => r.symbol === "TCS")!;
    assert.strictEqual(tcs.date.toISOString(), "2026-04-15T00:00:00.000Z");
    assert.strictEqual(tcs.purpose, "Financial Results/Dividend");
    assert.strictEqual(tcs.company, "Tata Consultancy Services Limited");
  });

  it("degrades an unknown payload to a flagged empty result, never a throw", () => {
    const bad = parseBoardMeetings("<html>Access Denied</html>");
    assert.deepStrictEqual(bad, {
      rows: [],
      skipped: 0,
      unrecognizedPayload: true,
    });
    assert.strictEqual(parseBoardMeetings(null).unrecognizedPayload, true);
  });

  it("treats an empty list as a quiet window, NOT a degradation", () => {
    assert.deepStrictEqual(parseBoardMeetings([]), {
      rows: [],
      skipped: 0,
      unrecognizedPayload: false,
    });
  });

  it("counts a null/array element as a skip instead of crashing", () => {
    const res = parseNseEvents(
      [null, [], { bm_symbol: "X" }],
      BOARD_MEETING_KEYS,
    );
    assert.strictEqual(res.rows.length, 0);
    assert.strictEqual(res.skipped, 3);
  });
});

describe("parseEventCalendar (SYNTHETIC fixture)", () => {
  const out = parseEventCalendar(EVENT_CALENDAR_FIXTURE);

  it("unwraps the `data` container and parses both rows", () => {
    assert.strictEqual(out.rows.length, 2);
    assert.strictEqual(out.skipped, 0);
    assert.strictEqual(out.unrecognizedPayload, false);
    assert.deepStrictEqual(
      out.rows.map((r) => r.symbol),
      ["INFY", "ITC"],
    );
  });

  it("carries the purpose text through for the category mapper", () => {
    assert.strictEqual(out.rows[0]!.purpose, "Financial Results");
    assert.strictEqual(out.rows[1]!.purpose, "Buy Back of Shares");
  });
});

// ── purpose -> category ──────────────────────────────────────────────────────

describe("isFinancialResultsPurpose / nseEventCategory", () => {
  it("recognises every wording NSE uses for a results meeting", () => {
    for (const p of [
      "Financial Results",
      "Quarterly Results",
      "Audited Results",
      "Results",
      "Financial Results/Dividend",
      "financial results",
    ]) {
      assert.ok(isFinancialResultsPurpose(p), p);
      assert.strictEqual(nseEventCategory(p), "earnings");
    }
  });

  it("routes a results+dividend meeting to earnings, not dividend", () => {
    // The results date is what the EARNINGS_DATE alert reads; the authoritative
    // ex-date row is written separately by the corp-actions leg.
    assert.strictEqual(
      nseEventCategory("Financial Results/Dividend"),
      "earnings",
    );
  });

  it("maps the non-results purposes", () => {
    assert.strictEqual(nseEventCategory("Dividend"), "dividend");
    assert.strictEqual(nseEventCategory("Interim Dividend"), "dividend");
    assert.strictEqual(nseEventCategory("Stock Split"), "splits");
    assert.strictEqual(nseEventCategory("Sub-Division of shares"), "splits");
    assert.strictEqual(nseEventCategory("Face Value Split"), "splits");
    assert.strictEqual(nseEventCategory("Buy Back of Shares"), "corp_action");
    assert.strictEqual(nseEventCategory("Bonus Issue"), "corp_action");
    assert.strictEqual(nseEventCategory(""), "corp_action");
  });
});

describe("buildNseEventTitle", () => {
  const row = {
    symbol: "RELIANCE",
    company: "Reliance Industries Limited",
    date: utc(2026, 4, 22),
    purpose: "Financial Results",
    description: "Quarterly Results for Q1 FY27",
  };

  it("keeps the `${symbol} ${what}` shape the alert notifications render", () => {
    assert.strictEqual(
      buildNseEventTitle(row, "earnings"),
      "RELIANCE earnings — Financial Results",
    );
    assert.strictEqual(
      buildNseEventTitle({ ...row, purpose: "Dividend" }, "dividend"),
      "RELIANCE corporate action — Dividend",
    );
  });

  it("falls back to the description and omits the dash when both are empty", () => {
    assert.strictEqual(
      buildNseEventTitle({ ...row, purpose: "" }, "earnings"),
      "RELIANCE earnings — Quarterly Results for Q1 FY27",
    );
    assert.strictEqual(
      buildNseEventTitle({ ...row, purpose: "", description: "" }, "earnings"),
      "RELIANCE earnings",
    );
  });

  it("bounds the detail so a runaway purpose can't blow up the title", () => {
    const title = buildNseEventTitle(
      { ...row, purpose: "x".repeat(500) },
      "earnings",
    );
    assert.ok(title.length <= "RELIANCE earnings".length + 120);
  });
});

// ── Row assembly ─────────────────────────────────────────────────────────────

describe("toUpcomingEventRows", () => {
  const parsed = parseBoardMeetings(BOARD_MEETINGS_FIXTURE).rows;

  it("maps rows to their category and tags the source", () => {
    const rows = toUpcomingEventRows(parsed, utc(2026, 1, 1), "NSE");
    assert.deepStrictEqual(
      rows.map((r) => [r.symbol, r.category, r.source]),
      [
        ["RELIANCE", "earnings", "NSE"],
        ["HDFCBANK", "dividend", "NSE"],
        ["TCS", "earnings", "NSE"],
      ],
    );
  });

  it("is FORWARD-ONLY: rows before the cutoff are dropped", () => {
    const rows = toUpcomingEventRows(parsed, utc(2026, 5, 1), "NSE");
    assert.deepStrictEqual(
      rows.map((r) => r.symbol),
      ["HDFCBANK"], // 05-May survives; 22-Apr and 15-Apr do not
    );
  });

  it("keeps an event dated EXACTLY today (the boundary is inclusive)", () => {
    const rows = toUpcomingEventRows(parsed, utc(2026, 4, 22), "NSE");
    assert.ok(rows.some((r) => r.symbol === "RELIANCE"));
  });
});

describe("dedupeUpcomingEvents", () => {
  const day = utc(2026, 4, 22);
  const row = (
    symbol: string,
    source: "NSE" | "YAHOO",
    title: string,
  ): UpcomingEventRow => ({
    date: day,
    symbol,
    title,
    category: "earnings",
    source,
  });

  it("collapses the SAME event reported by both NSE endpoints", () => {
    const out = dedupeUpcomingEvents([
      row("INFY", "NSE", "INFY earnings"),
      row("INFY", "NSE", "INFY earnings — Financial Results"),
    ]);
    assert.strictEqual(out.length, 1);
    // Same source -> the richer (longer) title wins.
    assert.strictEqual(out[0]!.title, "INFY earnings — Financial Results");
  });

  it("lets NSE win over the Yahoo fallback in either arrival order", () => {
    const nseFirst = dedupeUpcomingEvents([
      row("INFY", "NSE", "INFY earnings — Financial Results"),
      row("INFY", "YAHOO", "INFY earnings (est. EPS 18.00)"),
    ]);
    assert.strictEqual(nseFirst[0]!.source, "NSE");

    const yahooFirst = dedupeUpcomingEvents([
      row("INFY", "YAHOO", "INFY earnings (est. EPS 18.00)"),
      row("INFY", "NSE", "INFY earnings"),
    ]);
    assert.strictEqual(yahooFirst[0]!.source, "NSE");
    assert.strictEqual(yahooFirst[0]!.title, "INFY earnings");
  });

  it("keeps rows that differ in symbol, category or day", () => {
    const out = dedupeUpcomingEvents([
      row("INFY", "NSE", "a"),
      row("TCS", "NSE", "b"),
      { ...row("INFY", "NSE", "c"), category: "dividend" },
      { ...row("INFY", "NSE", "d"), date: utc(2026, 4, 23) },
    ]);
    assert.strictEqual(out.length, 4);
  });

  it("keys on symbol + category + day", () => {
    assert.strictEqual(
      upcomingEventKey(row("INFY", "NSE", "x")),
      "INFY|earnings|2026-04-22T00:00:00.000Z",
    );
  });

  it("returns [] for an empty batch", () => {
    assert.deepStrictEqual(dedupeUpcomingEvents([]), []);
  });
});

describe("selectFallbackSymbols", () => {
  const earnings = (symbol: string): UpcomingEventRow => ({
    date: utc(2026, 4, 22),
    symbol,
    title: `${symbol} earnings`,
    category: "earnings",
    source: "NSE",
  });

  it("returns only the tracked symbols the NSE window never mentioned", () => {
    assert.deepStrictEqual(
      selectFallbackSymbols(
        ["RELIANCE", "TCS", "INFY"],
        [earnings("RELIANCE"), earnings("INFY")],
      ),
      ["TCS"],
    );
  });

  it("does NOT count a non-earnings NSE row as earnings coverage", () => {
    // A dividend board meeting says nothing about the results date, which is
    // exactly what the EARNINGS_DATE alert path reads.
    const dividendOnly: UpcomingEventRow = {
      ...earnings("HDFCBANK"),
      category: "dividend",
    };
    assert.deepStrictEqual(
      selectFallbackSymbols(["HDFCBANK"], [dividendOnly]),
      ["HDFCBANK"],
    );
  });

  it("upper-cases and de-duplicates the target list", () => {
    assert.deepStrictEqual(selectFallbackSymbols(["tcs", "TCS", "Infy"], []), [
      "TCS",
      "INFY",
    ]);
  });

  it("falls back to everything when NSE returned nothing at all", () => {
    assert.deepStrictEqual(selectFallbackSymbols(["A", "B"], []), ["A", "B"]);
  });
});

describe("groupByCategory", () => {
  it("buckets rows so each category gets ONE scoped delete + insert", () => {
    const rows = toUpcomingEventRows(
      parseBoardMeetings(BOARD_MEETINGS_FIXTURE).rows,
      utc(2026, 1, 1),
      "NSE",
    );
    const grouped = groupByCategory(rows);
    assert.deepStrictEqual([...grouped.keys()].sort(), [
      "dividend",
      "earnings",
    ]);
    assert.strictEqual(grouped.get("earnings")!.length, 2);
    assert.strictEqual(grouped.get("dividend")!.length, 1);
  });

  it("returns an empty map for no rows", () => {
    assert.strictEqual(groupByCategory([]).size, 0);
  });
});

describe("chunk", () => {
  it("splits into fixed-size batches, last one short", () => {
    assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepStrictEqual(chunk([1, 2], 5), [[1, 2]]);
  });

  it("returns [] for an empty input and never loops on a bad size", () => {
    assert.deepStrictEqual(chunk([], 10), []);
    assert.deepStrictEqual(chunk([1, 2, 3], 0), [[1, 2, 3]]);
    assert.deepStrictEqual(chunk([1, 2, 3], Number.NaN), [[1, 2, 3]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1217 — the widened fallback population.
// ─────────────────────────────────────────────────────────────────────────────

describe("selectEventTargets", () => {
  it("puts alert targets first, ahead of the rotation", () => {
    // An active EARNINGS_DATE alert is a user explicitly asking about one
    // symbol. A rotation must never postpone it.
    assert.deepStrictEqual(
      selectEventTargets(["ALERTA", "ALERTB"], ["ROT1", "ROT2"], 10),
      ["ALERTA", "ALERTB", "ROT1", "ROT2"],
    );
  });

  it("[regression] an alert target survives a full rotation slate", () => {
    // The pre-MONEY-1217 code unioned alerts and holdings into one Set and
    // sliced, so a long enough holdings list silently dropped alert symbols.
    // With the population widened from ~102 to ~781 the cap BINDS every run,
    // which turns that latent bug into a nightly one.
    const rotation = Array.from({ length: 200 }, (_, i) => `ROT${i}`);
    const out = selectEventTargets(["MUSTHAVE"], rotation, 5);
    assert.strictEqual(out[0], "MUSTHAVE");
    assert.strictEqual(out.length, 5);
  });

  it("preserves the caller's rotation order — it does not re-sort", () => {
    // Staleness lives in the database (`eventsSyncedAt asc`). Re-deriving an
    // order here from data this function does not have is how a pure helper
    // starts lying about what it can know.
    const rotation = ["ZZZ", "AAA", "MMM"];
    assert.deepStrictEqual(selectEventTargets([], rotation, 10), [
      "ZZZ",
      "AAA",
      "MMM",
    ]);
  });

  it("[regression] the cap is enforced — the Yahoo fallback is per-symbol", () => {
    // 781 warm-tier symbols x one Yahoo request each is how a nightly job gets
    // throttled, and a throttled fetch returns nothing in a way that looks
    // exactly like "no calendar published".
    const rotation = Array.from({ length: 781 }, (_, i) => `S${i}`);
    assert.strictEqual(selectEventTargets([], rotation, 200).length, 200);
  });

  it("de-duplicates across the two lists and within each", () => {
    assert.deepStrictEqual(
      selectEventTargets(["RELIANCE", "RELIANCE"], ["RELIANCE", "TCS"], 10),
      ["RELIANCE", "TCS"],
    );
  });

  it("upper-cases, because every downstream comparison is exact-string", () => {
    // NSE's window and the alert rows are matched against this set by exact
    // string; a lower-case symbol would silently never match.
    assert.deepStrictEqual(
      selectEventTargets(["reliance"], ["tcs", " Infy "], 10),
      ["RELIANCE", "TCS", "INFY"],
    );
  });

  it("drops blanks — absence is never a symbol", () => {
    assert.deepStrictEqual(selectEventTargets(["", "   "], ["TCS", ""], 10), [
      "TCS",
    ]);
  });

  it("[regression] a bad cap degrades to NO cap, never to zero", () => {
    // A zero-length target list is indistinguishable from a dead job in the
    // logs, so a nonsense `maxSymbols` must not produce one.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepStrictEqual(
        selectEventTargets(["A"], ["B", "C"], bad),
        ["A", "B", "C"],
        `maxSymbols=${bad} should not empty the target list`,
      );
    }
  });

  it("returns [] only when both inputs are empty", () => {
    assert.deepStrictEqual(selectEventTargets([], [], 10), []);
  });
});
