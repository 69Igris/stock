/**
 * MONEY-1536 — an exchange's zoneless wall-clock timestamp is the IST instant
 * it names, whatever TZ the parsing process runs in.
 *
 * NSE's `an_dt` / `broadcastDt` ("22-Sep-2026 21:10:18", 1,112 of 1,112
 * archived `an_dt`) and BSE's `NEWS_DT` ("2026-09-22T23:58:45.357", 50 of 50
 * live rows) carry no zone. `safeFilingDate` and `safeOptionalDate` handed them
 * to `new Date`, which reads a zoneless date-time in the PROCESS'S LOCAL TIME,
 * so on Cloud Run (UTC) every one landed 5h30m late.
 *
 * Nothing on prod stored the instant itself (measured 2026-09-23: 0 stock
 * documents carry a date-derived period; every BSE key is its NEWSID), which is
 * why the two key builders that read these instants move to the IST day in the
 * same change — their cases are in processor-stock-document-sync.test.ts and
 * bse-announcements-sync-logic.test.ts.
 *
 * ## Mutation log
 *
 * Each case below was run against a deliberately broken source and confirmed
 * red before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseAnnouncements,
  parseFinancialResults,
  safeFilingDate,
  safeOptionalDate,
} from "../src/data-sources/nse-filings-logic";
import { parseBseAnnouncementRow } from "../src/data-sources/bse-client";

const ZONES = [
  "America/New_York",
  "UTC",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Pacific/Auckland",
];

function underTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

function everyZone(fn: () => string | undefined): string[] {
  return ZONES.map((tz) => underTz(tz, fn) ?? "null");
}

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("the harness really changes the process TZ", () => {
  it("V8 reads NSE's timestamp in local time — the bug, reproduced", () => {
    const raw = "22-Sep-2026 21:10:18";
    assert.equal(
      underTz("UTC", () => new Date(raw).toISOString()),
      "2026-09-22T21:10:18.000Z",
    );
    assert.equal(
      underTz("Asia/Kolkata", () => new Date(raw).toISOString()),
      "2026-09-22T15:40:18.000Z",
    );
  });
});

describe("a zoneless exchange timestamp is IST, in every zone", () => {
  // Mutation: drop `- IST_OFFSET_MS` -> RED on all four (the wall clock read
  // as UTC: 21:10:18Z, 23:58:45.357Z …).
  it("NSE an_dt / broadcastDt", () => {
    for (const iso of everyZone(() =>
      safeFilingDate("22-Sep-2026 21:10:18", NOW).toISOString(),
    )) {
      assert.equal(iso, "2026-09-22T15:40:18.000Z");
    }
    for (const iso of everyZone(() =>
      safeOptionalDate("22-Sep-2026 21:10")?.toISOString(),
    )) {
      assert.equal(iso, "2026-09-22T15:40:00.000Z");
    }
  });

  // Mutation: drop the fractional-seconds group from the ISO pattern -> RED
  // (the value falls through to V8, local time, and differs per zone).
  it("BSE NEWS_DT, with any number of fractional digits", () => {
    const cases: Array<[string, string]> = [
      ["2026-09-22T23:58:45.357", "2026-09-22T18:28:45.357Z"],
      ["2026-09-22T23:58:45.35", "2026-09-22T18:28:45.350Z"],
      ["2026-09-22T23:58:45.3", "2026-09-22T18:28:45.300Z"],
      // .NET's seven-digit ticks — truncated to ms, never handed to V8.
      ["2026-09-22T23:58:45.3570000", "2026-09-22T18:28:45.357Z"],
      ["2026-09-22 23:58:45", "2026-09-22T18:28:45.000Z"],
    ];
    for (const [raw, want] of cases) {
      for (const iso of everyZone(() => safeOptionalDate(raw)?.toISOString())) {
        assert.equal(iso, want, raw);
      }
    }
  });

  it("a filing just after IST midnight is on its IST day, the UTC day before", () => {
    for (const iso of everyZone(() =>
      safeFilingDate("23-Sep-2026 02:00:00", NOW).toISOString(),
    )) {
      assert.equal(iso, "2026-09-22T20:30:00.000Z");
    }
  });

  it("a date-only filing date stays a calendar day at UTC midnight (MONEY-1530)", () => {
    for (const iso of everyZone(() =>
      safeFilingDate("22-Sep-2026", NOW).toISOString(),
    )) {
      assert.equal(iso, "2026-09-22T00:00:00.000Z");
    }
  });

  // Mutation: compare only the DATE parts in the round-trip check -> RED on
  // the two mid-day values (10:60 and :61 roll into a real, wrong instant on
  // the SAME day, so only the time half of the check can see them; the 23:xx
  // ones roll into the next day and a date check alone catches those).
  it("a time that does not exist is refused, not rolled over", () => {
    for (const raw of [
      "22-Sep-2026 24:00:00",
      "2026-09-22T23:60:00",
      "2026-09-22T23:59:60",
      "22-Sep-2026 10:60:00",
      "2026-09-22T10:30:61",
    ]) {
      assert.equal(safeOptionalDate(raw), null, raw);
      assert.equal(safeFilingDate(raw, NOW).getTime(), NOW, raw);
    }
  });
});

describe("the three parsers that read these fields, end to end, on Cloud Run's TZ", () => {
  // Mutation: `safeFilingDate` back to `new Date(raw)` -> RED on the first two
  // (UTC process: 21:10:18Z, 5h30m late).
  it("NSE announcements: filingDate from an_dt", () => {
    const [f] = underTz("UTC", () =>
      parseAnnouncements("RUSHIL", [
        { desc: "Outcome of Board Meeting", an_dt: "22-Sep-2026 21:10:18" },
      ]),
    );
    assert.equal(f?.filingDate.toISOString(), "2026-09-22T15:40:18.000Z");
  });

  it("NSE financial results: filingDate from broadcastDt", () => {
    const [f] = underTz("UTC", () =>
      parseFinancialResults("RUSHIL", {
        results: [{ period: "Quarterly", broadcastDt: "14-Aug-2026 18:31:02" }],
      }),
    );
    assert.equal(f?.filingDate.toISOString(), "2026-08-14T13:01:02.000Z");
  });

  // Mutation: `safeOptionalDate` delegating to `new Date(raw)` for a time-bearing
  // value -> RED (23:58:45.357Z).
  it("BSE announcements: publishedAt from NEWS_DT", () => {
    const a = underTz("UTC", () =>
      parseBseAnnouncementRow({
        SCRIP_CD: "500325",
        NEWSSUB: "Board Meeting Outcome",
        NEWS_DT: "2026-09-22T23:58:45.357",
        NEWSID: "e5501245-f5cd-45b3-954a-a89c294e2241",
      }),
    );
    assert.equal(a?.publishedAt?.toISOString(), "2026-09-22T18:28:45.357Z");
  });
});
