/**
 * MONEY-1217 — the sector deep-dive's results calendar, UNHIDDEN.
 *
 * ## The state this file replaces
 *
 * The calendar was commented out (MONEY-1218) because it rendered a 30-day
 * month grid with a green "0 events" pill for essentially every sector. That
 * pill is the defect: a wall of blank cells captioned "0 events" asserts "this
 * sector has no earnings this month", and an empty query cannot support that
 * claim. NSE intimates board-meeting dates ~2-3 weeks ahead under LODR Reg. 29,
 * so an absent date means "not announced yet" far more often than it means
 * "nothing happens".
 *
 * ## The diagnosis that was half wrong — and is the reason for the canaries
 *
 * MONEY-1218 blamed the ~102-symbol tracked list. That is only half right, and
 * the wrong half is why this took a rewrite rather than a widened query:
 * `gatherTargetSymbols` bounds ONLY the Yahoo fallback; the NSE leg is
 * whole-universe and `upcoming_events` already held 766 NSE-sourced earnings
 * rows spanning the listed market. What was actually empty was the WINDOW —
 * 30 future earnings rows platform-wide on 2026-08-19, 7 of them inside 30 days
 * — because mid-August sits between two results seasons. Every sector's grid
 * was correctly reporting a real seasonal gap in a unit that made it look like
 * a data failure.
 *
 * So this suite inverts the hidden-state assertions ("renders the calendar")
 * and keeps a canary on each half of the diagnosis, so that if either the
 * schema or the window ever moves back, the failure names the conclusion rather
 * than leaving the next reader to re-derive it.
 *
 * Source-level assertions, matching the convention in
 * ./deep-dive-query-shape.test.ts and ./deep-dive-fii-dii-empty-state.test.ts
 * ("no DOM runtime in this suite"). The BEHAVIOUR — season boundaries, FY
 * rollover, leap day, and the empty-day omission — is unit-tested against the
 * real functions in
 * `packages/core/__tests__/market-data/results-season.test.ts`.
 *
 * Sources: apps/web/app/discover/sectors/SectorDeepDive.tsx
 *          apps/web/lib/actions/sector-deep-dive.ts
 *          packages/core/src/market-data/results-season.ts
 *          packages/database/prisma/schema.prisma
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const REPO = join(ROOT, "..", "..");

const panel = readFileSync(
  join(ROOT, "app/discover/sectors/SectorDeepDive.tsx"),
  "utf8"
);
const action = readFileSync(
  join(ROOT, "lib/actions/sector-deep-dive.ts"),
  "utf8"
);
const seasonModule = readFileSync(
  join(REPO, "packages/core/src/market-data/results-season.ts"),
  "utf8"
);
const schema = readFileSync(
  join(REPO, "packages/database/prisma/schema.prisma"),
  "utf8"
);

/**
 * Source with comments removed.
 *
 * Every scan about CODE or about USER-VISIBLE COPY must run on this, not on the
 * raw file: the block comments in both sources necessarily quote the strings the
 * fix removed ("0 events", "MonthGrid", "30 days"), so scanning prose would fail
 * on this suite's own documentation and the only way to keep it green would be
 * to delete the explanation.
 *
 * LINE first, then BLOCK — MONEY-1143, and the order is load-bearing (a `//`
 * comment containing a block opener otherwise swallows real code, and every
 * `doesNotMatch` below would then pass because the code is GONE). Enforced
 * repo-wide by `__tests__/meta/comment-strip-ordering.test.ts`.
 */
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const panelCode = stripComments(panel);
const actionCode = stripComments(action);

/** The body of the `model X { … }` block named `name`, or null. */
function prismaModel(name: string): string | null {
  const start = schema.indexOf(`model ${name} {`);
  if (start === -1) return null;
  const end = schema.indexOf("\n}", start);
  assert.notEqual(end, -1, `model ${name} is not closed — schema unparseable`);
  return schema.slice(start, end);
}

/** Field NAMES declared in a model body — not `@@…` attributes or `///` docs. */
function modelFields(model: string): string[] {
  return model
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("//") &&
        !l.startsWith("@@") &&
        !l.startsWith("model ")
    )
    .map((l) => l.split(/\s+/)[0]!);
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness — a static scan that reads the wrong file passes everything.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — liveness", () => {
  it("all four sources are readable and non-trivial", () => {
    assert.ok(panel.length > 2000, "panel source unexpectedly small");
    assert.ok(action.length > 2000, "action source unexpectedly small");
    assert.ok(seasonModule.length > 2000, "season module unexpectedly small");
    assert.ok(schema.length > 2000, "schema unexpectedly small");
    assert.match(panel, /ResultsCalendarCard/);
    assert.match(action, /getResultsCalendarAction/);
  });

  it("stripComments removes prose without eating the code", () => {
    for (const [name, raw, code] of [
      ["panel", panel, panelCode],
      ["action", action, actionCode],
    ] as const) {
      assert.ok(
        code.length < raw.length,
        `${name}: stripComments removed nothing — is the comment syntax what we think?`
      );
      assert.ok(
        code.length > raw.length * 0.4,
        `${name}: stripComments removed ${raw.length - code.length} of ${raw.length} ` +
          "chars — it is eating code, and the scans below are near-vacuous"
      );
    }
    // The anchors the scans rely on must survive stripping.
    assert.match(panelCode, /function ResultsCalendarCard/);
    assert.match(actionCode, /export async function getResultsCalendarAction/);

    // And the strip must genuinely remove PROSE quoting the banned terms — the
    // case that breaks this class of suite. Both sources' comments explain the
    // "0 events" pill and the "MonthGrid" they replaced.
    assert.match(
      panel,
      /0 events/,
      "the explaining comment should still quote the pill that was removed"
    );
    assert.equal(
      (panelCode.match(/0 events/g) ?? []).length,
      0,
      "stripComments left the comment's `0 events` mention in the code scan"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The calendar is mounted again. (The inverted hidden-state assertions.)
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — the calendar RENDERS", () => {
  it("the card is mounted, not commented out", () => {
    // The inverse of MONEY-1218's `assert.doesNotMatch(/<MonthGrid/)`. Scanned
    // on the stripped source specifically so a commented-out mount does not
    // satisfy it — that is exactly the state this replaces.
    assert.match(
      panelCode,
      /<ResultsCalendarCard/,
      "the results calendar is not mounted — a commented-out mount looks " +
        "identical to a shipped one in the raw file, which is why this scans " +
        "the stripped source"
    );
    assert.match(panelCode, /function ResultsCalendarCard/);
  });

  it("[regression] the month grid is gone entirely", () => {
    // Not merely unmounted: the grid drew a cell per calendar day, which is the
    // shape that makes an unannounced day indistinguishable from a quiet one.
    assert.doesNotMatch(
      panelCode,
      /MonthGrid/,
      "the 30-day month grid is back — the unit is a results SEASON now, and a " +
        "grid re-introduces a cell for every day we know nothing about"
    );
  });

  it("the payload still carries the calendar, so the mount is real", () => {
    assert.match(actionCode, /earnings: ResultsCalendar/);
    assert.match(panelCode, /initial=\{data\.earnings\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PRODUCT FIX — no count pill over an empty calendar.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — zero is never rendered as a count", () => {
  it("[regression] the count pill is guarded by a non-zero total", () => {
    // The literal defect. `{earnings.length} events` rendered "0 events" in an
    // emerald pill — the colour of a healthy state — over a month of blanks.
    assert.match(
      panelCode,
      /calendar\.total > 0 && \(/,
      "the count pill must be guarded on `total > 0`; an unguarded count " +
        "renders `0` as a positive claim about the sector"
    );
    // And the guard must actually wrap the pill, not sit somewhere else in the
    // file. 400 chars is comfortably more than the pill's own markup.
    assert.match(
      panelCode,
      /calendar\.total > 0 && \([\s\S]{0,400}?pf-pill emerald/,
      "the `total > 0` guard does not wrap the emerald pill"
    );
  });

  it("[regression] the panel never renders the string `0 events`", () => {
    assert.doesNotMatch(
      panelCode,
      /\b0 events\b/,
      "the exact copy this ticket removed is back"
    );
  });

  it("the empty state explains WHY, in the reader's language", () => {
    // Whitespace-tolerant: JSX wraps this sentence across lines and prettier
    // reflows it, so an exact-string match would fail on a reformat while the
    // copy is unchanged.
    const flat = panelCode.replace(/\s+/g, " ");
    assert.match(
      flat,
      /No results dates announced yet for \{seasonLabel\}\./,
      "the empty state must name the season it is empty FOR"
    );
    assert.match(
      flat,
      /NSE publishes board-meeting dates ~2–3 weeks before results\./,
      "the empty state must say why an absent date is not an absent event"
    );
  });

  it("empty is not an error affordance", () => {
    // A structural, seasonal absence must not offer a retry — that would tell a
    // user a correct answer is a transient failure. The error branch above it is
    // a different state and keeps its own message.
    const flat = panelCode.replace(/\s+/g, " ");
    assert.doesNotMatch(
      flat,
      /No results dates announced yet[\s\S]{0,400}?\b(Retry|Try again)\b/,
      "the empty state offers a retry"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The query is scoped to a SEASON, not a rolling window.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — the query window", () => {
  /** The `upcomingEvent.findMany` block that builds the calendar. */
  function calendarQueryBlock(): string {
    const start = actionCode.indexOf("prisma.upcomingEvent.findMany");
    assert.notEqual(start, -1, "the calendar query is gone — did it move?");
    const end = actionCode.indexOf('"results calendar fetch"', start);
    assert.notEqual(end, -1, "calendar query timeout label not found");
    return actionCode.slice(start, end);
  }

  it("[regression] queries the season window, not `now + 30 days`", () => {
    const block = calendarQueryBlock();
    assert.match(
      block,
      /date:\s*\{\s*gte:\s*season\.start,\s*lt:\s*season\.end\s*\}/,
      "the calendar must be bounded by the SELECTED season. A rolling window " +
        "is empty for most of the year by construction: measured 2026-08-19, " +
        "the next 30 days held 7 earnings rows for the entire market"
    );
    assert.doesNotMatch(
      block,
      /86_400_000|Date\.now\(\)/,
      "a rolling day-arithmetic window is back in the calendar query"
    );
  });

  it("uses a HALF-OPEN window, matching the season's own contract", () => {
    // `end` is exclusive. `lte: season.end` would pull in the first day of the
    // gap after the season closes — a date that belongs to no season at all.
    assert.doesNotMatch(calendarQueryBlock(), /lte:\s*season\.end/);
  });

  it("still filters to earnings", () => {
    assert.match(calendarQueryBlock(), /category:\s*"earnings"/);
  });

  it("the default season is current-or-NEXT, never a season that closed", () => {
    // On 19 Aug 2026 — the ticket's measurement date — Q1 FY27 closed five days
    // earlier. Defaulting to "the season containing today" would render an
    // empty window forever between seasons.
    assert.match(actionCode, /currentOrNextSeason\(new Date\(\)\)/);
  });

  it("the whole calendar comes from ONE shared loader", () => {
    // The cached deep-dive payload and the selector-driven action must not be
    // able to answer the same question differently.
    assert.match(actionCode, /async function loadResultsCalendar\(/);
    assert.ok(
      (actionCode.match(/loadResultsCalendar\(/g) ?? []).length >= 3,
      "loadResultsCalendar should have one declaration and both call sites"
    );
    assert.equal(
      (actionCode.match(/prisma\.upcomingEvent\.findMany/g) ?? []).length,
      1,
      "a second UpcomingEvent query appeared — the two surfaces can now drift"
    );
  });

  it("day grouping is delegated to the tested pure function", () => {
    // The omission of empty days is the product fix, and it is unit-tested in
    // packages/core. Re-implementing it here would put it back out of reach.
    assert.match(actionCode, /groupResultsByDay\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Scope selection.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — scopes", () => {
  it("the action accepts both a sector scope and a stock scope", () => {
    assert.match(actionCode, /scope:\s*"sector";\s*sector:\s*string/);
    assert.match(actionCode, /scope:\s*"stock";\s*symbol:\s*string/);
    assert.match(actionCode, /if \(args\.scope === "stock"\)/);
  });

  it("the sector scope queries by constituent and stays bounded", () => {
    // Same backstop as the deep-dive's own instrument fetch: an unbounded
    // findMany here is the defect class MONEY-1092 exists to remove.
    const start = actionCode.indexOf("getResultsCalendarAction");
    const block = actionCode.slice(start);
    assert.match(block, /prisma\.instrumentMapping\.findMany/);
    assert.match(block, /take:\s*SECTOR_INSTRUMENT_CAP/);
    assert.match(block, /exchange:\s*"NSE"/);
  });

  it("both scopes are reachable from the panel", () => {
    assert.match(panelCode, /scope:\s*"stock",\s*symbol/);
    assert.match(panelCode, /scope:\s*"sector",\s*sector/);
  });

  it("[regression] an empty stock selection is not sent as a query", () => {
    // `symbol: ""` would be rejected by the action, surfacing an error where
    // the honest answer is "nothing to show".
    assert.match(panelCode, /scope === "stock" && !symbol/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The season ordinal crosses a trust boundary.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — the client never supplies dates", () => {
  it("the window is re-derived server-side from the ordinal", () => {
    assert.match(actionCode, /seasonFromOrdinal\(args\.seasonOrdinal\)/);
    // A client-supplied start/end would let anyone ask the database for a
    // decade-wide scan of `upcoming_events`.
    assert.doesNotMatch(
      actionCode,
      /args\.(start|end|from|to)\b/,
      "the action reads a date directly off the client's arguments"
    );
  });

  it("[regression] an out-of-range ordinal is REJECTED, not clamped", () => {
    // Clamping a nonsense ordinal to a valid window hides the caller bug that
    // produced it and answers a question nobody asked.
    assert.match(
      actionCode,
      /isSeasonOrdinalInRange\(args\.seasonOrdinal, now\)/
    );
    assert.match(actionCode, /success: false, error: "Season out of range"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Canaries on the two halves of MONEY-1218's diagnosis.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-1217 — schema canaries", () => {
  it("[canary] UpcomingEvent still carries the columns this calendar reads", () => {
    // POSITIVE CONTROL first: prove the field extractor sees a field that is
    // definitely there, so its silence about a missing one means something.
    const model = prismaModel("UpcomingEvent");
    assert.ok(model, "UpcomingEvent model not found — did it move?");
    const fields = modelFields(model!);
    assert.ok(
      fields.includes("category") && fields.includes("date"),
      "the field extractor cannot see `category`/`date` on UpcomingEvent, " +
        "which definitely has both — the assertions below prove nothing"
    );
    for (const needed of ["symbol", "title", "source"]) {
      assert.ok(
        fields.includes(needed),
        `UpcomingEvent lost \`${needed}\` — the results calendar renders it`
      );
    }
  });

  it("[canary] UpcomingEvent.symbol stays NULLABLE, so the filter is required", () => {
    // Macro events (RBI policy) have no issuer. The loader drops them; if this
    // ever becomes required the filter is dead code, and if it silently became
    // required-with-a-default we would be rendering the string "null".
    assert.match(
      prismaModel("UpcomingEvent")!,
      /symbol\s+String\?/,
      "UpcomingEvent.symbol changed nullability — revisit the loader's filter"
    );
    assert.match(actionCode, /Boolean\(r\.symbol\)/);
  });

  it("[canary] the events-sync rotation marker exists", () => {
    // The other half of MONEY-1218's diagnosis. The Yahoo fallback population
    // was widened from ~102 to the warm sync tier (~781), which makes the
    // per-run cap bind every night — so WHICH symbols it picks is now a real
    // decision, and a stale-first rotation is what stops it handing the same
    // arbitrary 200 to every run forever.
    const model = prismaModel("InstrumentMapping");
    assert.ok(model, "InstrumentMapping model not found — did it move?");
    const fields = modelFields(model!);
    assert.ok(
      fields.includes("eventsSyncedAt"),
      "`eventsSyncedAt` was removed — events-sync's rotation has no marker and " +
        "will re-fetch the same slice of the warm tier every night"
    );
    // Separate per job, deliberately: a shared marker lets one job's run reset
    // another's rotation.
    for (const sibling of ["newsSyncedAt", "filingsSyncedAt"]) {
      assert.ok(
        fields.includes(sibling),
        `${sibling} vanished — the per-job marker convention has changed`
      );
    }
  });

  it("[canary] the season windows still match SEBI's filing deadlines", () => {
    // If someone edits the windows, the failure should name the reason they
    // exist rather than leaving the next reader to re-derive it from the dates.
    assert.match(seasonModule, /45 days/);
    assert.match(seasonModule, /60 days/);
    // The four documented start days, as they appear in the window table.
    for (const [month, day] of [
      ["startMonth: 6", "startDay: 15"], // 15 Jul
      ["startMonth: 9", "startDay: 15"], // 15 Oct
      ["startMonth: 0", "startDay: 15"], // 15 Jan
      ["startMonth: 3", "startDay: 15"], // 15 Apr
    ] as const) {
      const flat = seasonModule.replace(/\s+/g, " ");
      assert.ok(
        flat.includes(`${month}, ${day}`),
        `the ${month} window start moved — re-derive it from the SEBI deadline`
      );
    }
  });
});
