/**
 * MONEY-1530 — an exchange's date-only ex/record date lands on UTC midnight of
 * that day, whatever TZ the parsing process runs in.
 *
 * ## THE DEFECT
 *
 * `safeOptionalDate` was `new Date(raw)`. NSE sends `"08-Sep-2026"` and BSE
 * `"01 Sep 2026"`, and ECMAScript resolves both in the PROCESS'S LOCAL TIME. The
 * Cloud Run nightly (TZ unset = UTC) stored 00:00Z; the 2026-08-12/13 backfill,
 * run from a laptop in IST, stored 18:30Z the previous day — 48,224 prod rows —
 * and `@@unique([symbol, exchange, type, exDate])` keyed the two apart, so 1,772
 * events were stored twice, 58 of them SPLIT/BONUS.
 *
 * ## WHY THE SUITE THAT EXISTED NEVER SAW IT
 *
 * Every fixture spelled its dates in ISO (`"2024-03-15"`), which ECMAScript
 * already resolves as UTC — the ONE date-only shape that was never broken, and
 * one no exchange sends. And the suite ran in whatever TZ the machine had. The
 * fixtures below are the feeds' real spellings, copied from the prod NSE archive
 * and a live BSE window, and every assertion runs under several zones.
 *
 * ## THE HARNESS HAS TO PROVE IT CAN FAIL
 *
 * Switching `process.env.TZ` mid-process is honoured by Node, but a test that
 * only asserts "same instant under every zone" would pass VACUOUSLY on a runtime
 * that ignored the switch. The first case asserts the switch took effect, on the
 * exact shape the bug lives in.
 *
 * ## Mutation log
 *
 * Each case below was run against a deliberately broken source and confirmed
 * red before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseCorporateActions,
  safeOptionalDate,
} from "../src/data-sources/nse-filings-logic";
import { parseBseActionRow } from "../src/data-sources/bse-client";

/** West of UTC, UTC, IST, and two zones EAST of IST. */
const ZONES = [
  "America/New_York",
  "UTC",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Pacific/Auckland",
];

/** Run `fn` with the process TZ set to `tz`, always restoring it. */
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

/** ISO of a parse under every zone — one value per zone. */
function isoUnderEachZone(raw: string): string[] {
  return ZONES.map((tz) =>
    underTz(tz, () => safeOptionalDate(raw)?.toISOString() ?? "null"),
  );
}

describe("the harness really changes the process TZ", () => {
  it("V8 resolves the NSE shape in local time — the bug, reproduced", () => {
    // Not a test of our code. If this ever passes vacuously (a runtime that
    // ignores a mid-process TZ change), every "same under every zone" case
    // below would too.
    const utc = underTz("UTC", () => new Date("08-Sep-2026").toISOString());
    const ist = underTz("Asia/Kolkata", () =>
      new Date("08-Sep-2026").toISOString(),
    );
    assert.equal(utc, "2026-09-08T00:00:00.000Z");
    assert.equal(ist, "2026-09-07T18:30:00.000Z");
  });
});

describe("safeOptionalDate anchors a date-only value at UTC midnight", () => {
  // Mutation: `safeOptionalDate` back to `new Date(raw)` -> RED on the first
  // two (IST gives 18:30Z the day before, Tokyo 15:00Z, Auckland 11:00Z).
  it("NSE's DD-Mon-YYYY is the same instant in every zone", () => {
    for (const iso of isoUnderEachZone("08-Sep-2026")) {
      assert.equal(iso, "2026-09-08T00:00:00.000Z");
    }
  });

  it("BSE's DD Mon YYYY is the same instant in every zone", () => {
    for (const iso of isoUnderEachZone("01 Sep 2026")) {
      assert.equal(iso, "2026-09-01T00:00:00.000Z");
    }
  });

  // Mutation: drop the numeric branch -> RED (V8 reads "05-07-2005" as MAY 7,
  // in local time). The corp-actions-chunked-fetch fixtures spell NSE rows this
  // way and put "05-07-2005" inside a JULY 2005 window, i.e. day-first.
  it("NSE's numeric DD-MM-YYYY is read DAY-first", () => {
    for (const iso of isoUnderEachZone("05-07-2005")) {
      assert.equal(iso, "2005-07-05T00:00:00.000Z");
    }
  });

  it("ISO stays where it always was", () => {
    for (const iso of isoUnderEachZone("2026-09-08")) {
      assert.equal(iso, "2026-09-08T00:00:00.000Z");
    }
  });

  it("a spelled-out or dotted month resolves on its first three letters", () => {
    assert.equal(
      safeOptionalDate("15-March-2024")?.toISOString(),
      "2024-03-15T00:00:00.000Z",
    );
    assert.equal(
      safeOptionalDate("15 Sept. 2024")?.toISOString(),
      "2024-09-15T00:00:00.000Z",
    );
  });
});

describe("a date-only value naming no real day is refused, not rolled over", () => {
  // Mutation: remove the component round-trip check -> RED on all four (V8 and
  // Date.UTC both roll "31-Feb-2024" over to 2 March — an ex-date nobody
  // announced, stored as if one had been).
  it("impossible days in every shape are null", () => {
    for (const raw of [
      "31-Feb-2024",
      "30 Feb 2023",
      "2024-02-30",
      "31-04-2024",
    ]) {
      assert.equal(safeOptionalDate(raw), null, raw);
    }
  });

  // Mutation: `MONTH_INDEX[...] ?? 0` (an unknown month read as January) ->
  // RED: 2024-01-15.
  it("an unknown month is null", () => {
    assert.equal(safeOptionalDate("15-Foo-2024"), null);
  });
});

describe("a value carrying a ZONE keeps the parse it always had", () => {
  // A zoneless TIMESTAMP is MONEY-1536's, and is pinned to IST in
  // money1536-ist-timestamps.test.ts. What stays V8's is anything that names
  // its own zone.
  //
  // Mutation: let the ISO pattern accept a trailing zone and read the wall
  // clock as IST (`…(?:Z|[+-]\d{2}:\d{2})?$`) -> RED on every raw below.
  it("matches V8's own parse, in every zone", () => {
    const raws = [
      "2024-03-15T10:00:00Z",
      "2024-03-15T10:00:00+05:30",
      "2024-03-15T10:00:00.123Z",
    ];
    for (const tz of ZONES) {
      underTz(tz, () => {
        for (const raw of raws) {
          assert.equal(
            safeOptionalDate(raw)?.getTime(),
            new Date(raw).getTime(),
            `${raw} under ${tz}`,
          );
        }
      });
    }
    assert.equal(
      safeOptionalDate(1_710_496_800_000)?.toISOString(),
      "2024-03-15T10:00:00.000Z",
    );
  });

  it("missing and garbage stay null", () => {
    for (const raw of ["", null, undefined, "-", "not-a-date"]) {
      assert.equal(safeOptionalDate(raw), null, String(raw));
    }
  });
});

describe("the two corporate-action parsers, end to end, from an IST process", () => {
  // Real rows. NSE: prod archive
  // feeds/NSE/api/corporate-actions/2026/09/2026-09-23-…json, row 0. BSE: a live
  // DefaultData/w window, 2026-09-23, trimmed to the fields the parser reads.
  const NSE_ROW = {
    bcEndDate: "-",
    bcStartDate: "-",
    caBroadcastDate: null,
    comp: "Rushil Decor Limited",
    exDate: "08-Sep-2026",
    faceVal: "1",
    ind: "-",
    isin: "INE573K01017",
    ndEndDate: "-",
    ndStartDate: "-",
    recDate: "08-Sep-2026",
    series: "EQ",
    subject: "Dividend - Re 0.05 Per Share",
    symbol: "RUSHIL",
  };
  const BSE_ROW = {
    scrip_code: 977227,
    short_name: "1025MBFL27",
    Ex_date: "01 Sep 2026",
    Purpose: "Payment of Interest ",
    RD_Date: "01 Sep 2026",
    exdate: "20260901",
  };

  // Mutation: `safeOptionalDate` back to `new Date(raw)` -> RED on both (the
  // IST process stores 2026-09-07T18:30Z and 2026-08-31T18:30Z).
  it("NSE: exDate and recordDate are UTC midnight of the stated day", () => {
    const [a] = underTz("Asia/Kolkata", () =>
      parseCorporateActions("RUSHIL", [NSE_ROW]),
    );
    assert.equal(a?.exDate?.toISOString(), "2026-09-08T00:00:00.000Z");
    assert.equal(a?.recordDate?.toISOString(), "2026-09-08T00:00:00.000Z");
  });

  it("BSE: exDate and recordDate are UTC midnight of the stated day", () => {
    const a = underTz("Asia/Kolkata", () => parseBseActionRow(BSE_ROW));
    assert.equal(a?.exDate?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(a?.recordDate?.toISOString(), "2026-09-01T00:00:00.000Z");
  });
});
