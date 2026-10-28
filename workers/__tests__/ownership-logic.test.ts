/**
 * UNIT TEST — ownership parsers + the weekly sharder (MONEY-1098 / P5.4).
 *
 * Exercises the REAL exports from
 * packages/research/src/data-sources/ownership-logic.ts (no shadow copies):
 *   - `parsePct` / `parseQty` / `parseAmount`  — `-`/blank → null, NEVER 0
 *   - `parseEventDate` / `normalizeQuarter`    — NSE's date dialects
 *   - `parseShareholdingMaster`                — quarter rows + counted skips
 *   - `parseInsiderPit` / `parseSastReg29` / `parsePledgeData`
 *   - `insiderEventKey`                        — the all-fields dedupe identity
 *   - `weekShard` / `shardOf` / `rotateSlice` / `istDayOfWeek` / `istWeekIndex`
 *     (the SUPERSEDED sharder — kept because the failure it encodes is worth
 *     keeping legible)
 *   - `buildOwnershipQueue` / `resolveCursorIndex` / `sliceQueue` /
 *     `advanceCursor` / `projectedPassDays`  — the replacement, MONEY-1207
 *   - `decideRunStatus` / `mergeSyncMetadata` / `readStoredCursors`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH FIXTURES ARE REAL, AND WHY IT MATTERS (MONEY-1207)
 *
 * `REAL_SHP` / `REAL_SHP_EMPLOYEE_TRUST` are CAPTURED — copied verbatim from
 * prod's own `shareholding_patterns.raw` column on 2026-08-18. Everything else
 * in this file is still SYNTHETIC, hand-written to the shape the module guesses.
 *
 * The shareholding fixture was synthetic too, and that is exactly how the bug
 * shipped: it invented `period`, `pledged`, `fii`, `dii` and `public`, the
 * parser resolved all five, every assertion passed — and the live endpoint sends
 * none of those names. `publicPct` was NULL on 7,953 of 7,953 prod rows while
 * this suite was green. A fixture written to the same guess as the code cannot
 * falsify the guess; it can only agree with it.
 *
 * The remaining synthetic fixtures carry the same caveat. They prove the parsers
 * behave correctly GIVEN those shapes; only real payloads (or the prod run's
 * `keyHits` / `unmapped` counters) can prove the shapes. No call in this file,
 * or in the module under test, ever touches the network.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions only: no Prisma, no fetch, no timers — nothing here can orphan
 * the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parsePct,
  readPct,
  parseQty,
  parseAmount,
  parseEventDate,
  normalizeQuarter,
  normalizeAction,
  extractRows,
  parseShareholdingMaster,
  parseInsiderPit,
  parseSastReg29,
  parsePledgeData,
  normalizeCompanyName,
  insiderEventKey,
  weekShard,
  shardOf,
  rotateSlice,
  istDayOfWeek,
  istWeekIndex,
  buildOwnershipQueue,
  resolveCursorIndex,
  sliceQueue,
  advanceCursor,
  projectedPassDays,
  decideRunStatus,
  mergeSyncMetadata,
  readStoredCursors,
  FULL_PASS_ALERT_DAYS,
  OWNERSHIP_TIER,
  type InsiderEventRow,
  type OwnershipCursor,
} from "../../packages/research/src/data-sources/ownership-logic";

// ── SYNTHETIC fixtures ───────────────────────────────────────────────────────

/**
 * REAL — captured from prod's own `shareholding_patterns.raw` on 2026-08-18.
 *
 * NOT synthetic, and the distinction is the entire reason this suite exists.
 * The fixture it replaced was hand-written to the shape the parser GUESSED —
 * `period`, `pledged`, `fii`, `dii`, `public` — and every assertion against it
 * passed while the real endpoint sends none of those names. 7,953 prod rows had
 * `publicPct: null` and a green test suite at the same time.
 *
 * Two rows, both verbatim from stored payloads (AAKASH 2026-06 and ABREL
 * 2026-06, the latter picked because its `employeeTrusts` is non-zero — 771 of
 * 7,953 rows are). All 33 keys are kept, including the ones we do not map: a
 * trimmed fixture cannot catch the `unmapped` counter firing on a key we forgot,
 * and it would quietly become a re-statement of our own key list.
 *
 * Key facts this fixture pins:
 *   - the public float is `public_val`, not `public`
 *   - the period is `date` ("30-JUN-2026"), NOT `submissionDate` ("16-JUL-2026")
 *   - `employeeTrusts` is the STRING "0" on most rows — a reported zero
 *   - `underlyingDrs` is null, and must stay null rather than becoming 0
 *   - FII / DII / pledged are ABSENT from this endpoint entirely
 */
const REAL_SHP = {
  data: [
    {
      broadcastDate: "16-JUL-2026 15:15:07",
      cgTimeStamp: null,
      countString: null,
      date: "30-JUN-2026",
      desc: "NEW_1",
      employeeTrusts: "0",
      format: null,
      index: "-",
      industry: "-",
      isin: "INE087Z01016",
      name: "Aakash Exploration Services Limited",
      newColumn: true,
      pr_and_prgrp: "66.54",
      promoterDematNotes: "",
      publicShareholdingNotes: "",
      public_val: "33.46",
      recordId: "211464",
      remarksWeb: "N",
      revisedData: "N",
      revisedDate: null,
      revisedRemark: null,
      revisedStatus: "-",
      revisionDate: null,
      revisionRemark: null,
      shareholdingPatternNotes: "",
      submissionDate: "16-JUL-2026",
      symbol: "AAKASH",
      systemDate: "16-JUL-2026 15:15:12",
      timeDifference: "00:00:05",
      typeOfSubmission: null,
      underlyingDrs: null,
      xbrl: "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1694089_16072026031504_WEB.xml",
      xbrlFileSize: "143.13 KB",
    },
    {
      broadcastDate: "07-APR-2026 13:03:52",
      cgTimeStamp: null,
      countString: null,
      date: "31-MAR-2026",
      desc: "NEW_1",
      employeeTrusts: "0",
      format: null,
      index: "-",
      industry: "-",
      isin: "INE087Z01016",
      name: "Aakash Exploration Services Limited",
      newColumn: true,
      pr_and_prgrp: "66.54",
      promoterDematNotes: null,
      publicShareholdingNotes: null,
      public_val: "33.46",
      recordId: "207503",
      remarksWeb: "N",
      revisedData: "N",
      revisedDate: null,
      revisedRemark: null,
      revisedStatus: "-",
      revisionDate: null,
      revisionRemark: null,
      shareholdingPatternNotes: null,
      submissionDate: "07-APR-2026",
      symbol: "AAKASH",
      systemDate: "07-APR-2026 13:03:57",
      timeDifference: "00:00:05",
      typeOfSubmission: null,
      underlyingDrs: null,
      xbrl: "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1646581_07042026010349_WEB.xml",
      xbrlFileSize: "127.94 KB",
    },
  ],
};

/**
 * REAL — ABREL 2026-06, the shape where `employeeTrusts` is NOT zero. Kept as a
 * separate fixture so the "0 is a reported zero" and the "0.75 is a real ESOP
 * trust" cases cannot be satisfied by the same row.
 */
const REAL_SHP_EMPLOYEE_TRUST = {
  data: [
    {
      broadcastDate: "20-JUL-2026 17:01:34",
      cgTimeStamp: null,
      countString: null,
      date: "30-JUN-2026",
      desc: "NEW_1",
      employeeTrusts: "0.75",
      format: null,
      index: "-",
      industry: "-",
      isin: "INE044401011",
      name: "Aditya Birla Real Estate Limited",
      newColumn: true,
      pr_and_prgrp: "50.21",
      promoterDematNotes: "",
      publicShareholdingNotes: "",
      public_val: "49.04",
      recordId: "212294",
      remarksWeb: "N",
      revisedData: "N",
      revisedDate: null,
      revisedRemark: null,
      revisedStatus: "-",
      revisionDate: null,
      revisionRemark: null,
      shareholdingPatternNotes: "",
      submissionDate: "20-JUL-2026",
      symbol: "ABREL",
      systemDate: "20-JUL-2026 17:01:38",
      timeDifference: "00:00:04",
      typeOfSubmission: null,
      underlyingDrs: null,
      xbrl: "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1697008_20072026050127_WEB.xml",
      xbrlFileSize: "202.96 KB",
    },
  ],
};

/** SYNTHETIC — PIT rows in the guessed shape. */
const SYNTHETIC_PIT = {
  acqNameList: ["R. INVENTED"],
  data: [
    {
      symbol: "ACMECORP",
      acqName: "R. Invented",
      personCategory: "Promoters",
      acqfromDt: "01-Jul-2026",
      acqtoDt: "02-Jul-2026",
      intimDt: "04-Jul-2026",
      tdpTransactionType: "Buy",
      secAcq: "12,500",
      secVal: "1,562,500.50",
    },
    {
      symbol: "ACMECORP",
      acqName: "R. Invented",
      acqtoDt: "02-Jul-2026",
      tdpTransactionType: "Sell",
      secAcq: "500",
      secVal: "-",
    },
  ],
};

/** SYNTHETIC — SAST Reg-29 rows in the guessed shape. */
const SYNTHETIC_SAST = [
  {
    symbol: "ACMECORP",
    nameOfAcq: "Fictional Holdings Pvt Ltd",
    date: "9-07-2026", // unpadded day — the MONEY-1097 finding
    acqMode: "Market Purchase",
    noOfShareAcq: "1,00,000",
    totShareAcq: "98750000",
  },
];

/** SYNTHETIC — bulk pledge rows (each carries its OWN symbol). */
const SYNTHETIC_PLEDGE = {
  data: [
    {
      symbol: "ACMECORP",
      pledgor: "R. Invented",
      dateOfCreation: "15/06/2026",
      pledgeType: "Creation of pledge",
      noOfSharesPledged: "250000",
    },
    {
      symbol: "BOGUSLTD",
      pledgor: "Imaginary Family Trust",
      dateOfCreation: "16-Jun-2026",
      pledgeType: "Release",
      noOfSharesPledged: "-",
      value: "9,99,999.25",
    },
    {
      // no symbol → must be counted, never guessed at
      pledgor: "Nameless Entity",
      dateOfCreation: "17-Jun-2026",
      pledgeType: "Creation",
      noOfSharesPledged: "100",
    },
  ],
};

// ── Primitive readers ────────────────────────────────────────────────────────

describe("parsePct — blank is NEVER zero", () => {
  it("parses plain and percent-suffixed numbers", () => {
    assert.equal(parsePct("52.31"), 52.31);
    assert.equal(parsePct("52.31%"), 52.31);
    assert.equal(parsePct(52.31), 52.31);
    assert.equal(parsePct(" 7 "), 7);
  });

  it("returns null (not 0) for every not-reported sentinel", () => {
    for (const blank of [
      "",
      " ",
      "-",
      "--",
      "–",
      "—",
      "NA",
      "N/A",
      "N.A.",
      "nil",
      "NULL",
    ]) {
      assert.equal(
        parsePct(blank),
        null,
        `expected null for ${JSON.stringify(blank)}`,
      );
    }
    assert.equal(parsePct(null), null);
    assert.equal(parsePct(undefined), null);
  });

  it("keeps a genuine reported zero as 0", () => {
    assert.equal(parsePct("0"), 0);
    assert.equal(parsePct("0.00"), 0);
    assert.equal(parsePct(0), 0);
  });

  it("rejects non-finite numbers", () => {
    assert.equal(parsePct(Number.NaN), null);
    assert.equal(parsePct(Number.POSITIVE_INFINITY), null);
  });

  it("rejects out-of-range values and tags the reason (mis-mapped column signal)", () => {
    assert.equal(readPct("125").reason, "outOfRange");
    assert.equal(readPct("-3").reason, "outOfRange");
    assert.equal(readPct("98750000").value, null);
    assert.equal(readPct("abc").reason, "nonNumeric");
    assert.equal(readPct("-").reason, "absent");
    assert.equal(readPct("100").value, 100);
  });

  it("strips Indian digit grouping", () => {
    assert.equal(parsePct("1,00"), 100);
  });
});

describe("parseQty / parseAmount", () => {
  it("strips commas and rupee signs", () => {
    assert.equal(parseQty("1,00,000"), 100000);
    assert.equal(parseAmount("₹ 1,562,500.50"), 1562500.5);
  });

  it("returns null for not-reported, never 0", () => {
    assert.equal(parseQty("-"), null);
    assert.equal(parseQty(""), null);
    assert.equal(parseAmount("-"), null);
    assert.equal(parseQty("0"), 0); // a real zero survives
  });

  it("keeps negative quantities (a disposal's direction is data)", () => {
    assert.equal(parseQty("-500"), -500);
  });

  it("rounds a fractional share count rather than dropping the event", () => {
    assert.equal(parseQty("100.4"), 100);
    assert.equal(parseQty("100.6"), 101);
  });

  it("refuses quantities beyond exact integer range", () => {
    assert.equal(parseQty("1e300"), null);
  });
});

describe("parseEventDate", () => {
  it("parses ISO, named-month, DD-MM-YYYY and the UNPADDED day NSE emits", () => {
    const expect = Date.UTC(2026, 6, 9);
    for (const input of [
      "2026-07-09",
      "2026-07-09T11:22:33.000Z",
      "09-Jul-2026",
      "9 Jul 2026",
      "09-07-2026",
      "9-07-2026",
      "09/07/2026",
    ]) {
      const d = parseEventDate(input);
      assert.ok(d, `failed to parse ${input}`);
      assert.equal(d.getTime(), expect, `wrong day for ${input}`);
    }
  });

  it("normalizes to UTC midnight (no time component survives)", () => {
    const d = parseEventDate("2026-07-09T18:45:00Z");
    assert.equal(d?.toISOString(), "2026-07-09T00:00:00.000Z");
  });

  it("rejects a calendar day that does not exist instead of rolling forward", () => {
    // Date.UTC(2026, 1, 31) silently becomes 3 March — the round-trip check
    // is what stops an event being filed under a day that never happened.
    assert.equal(parseEventDate("31-02-2026"), null);
    assert.equal(parseEventDate("2026-02-31"), null);
  });

  it("rejects blanks, junk and implausible years", () => {
    for (const junk of [
      "",
      "-",
      "NA",
      "not a date",
      "09-Xyz-2026",
      "09-07-26",
    ]) {
      assert.equal(parseEventDate(junk), null, `expected null for ${junk}`);
    }
    assert.equal(parseEventDate("01-01-1899"), null);
  });

  it("accepts a Date and epoch millis", () => {
    assert.equal(
      parseEventDate(new Date("2026-07-09T05:00:00Z"))?.getTime(),
      Date.UTC(2026, 6, 9),
    );
    assert.equal(
      parseEventDate(Date.UTC(2026, 6, 9, 13))?.getTime(),
      Date.UTC(2026, 6, 9),
    );
    assert.equal(parseEventDate(Number.NaN), null);
  });
});

describe("normalizeQuarter — one quarter must not key twice", () => {
  it("collapses every date spelling of a quarter end to YYYY-MM", () => {
    for (const input of [
      "31-Mar-2026",
      "2026-03-31",
      "31/03/2026",
      "31-03-2026",
    ]) {
      assert.equal(normalizeQuarter(input), "2026-03", `wrong for ${input}`);
    }
  });

  it("keeps an unparseable-but-meaningful label instead of dropping the row", () => {
    assert.equal(normalizeQuarter(" q1  fy26 "), "Q1 FY26");
  });

  it("returns null only for genuinely empty input", () => {
    assert.equal(normalizeQuarter(""), null);
    assert.equal(normalizeQuarter("  "), null);
    assert.equal(normalizeQuarter("-"), null);
    assert.equal(normalizeQuarter(null), null);
  });

  it("caps an unparsed label so a free-text key cannot be unbounded", () => {
    assert.equal(normalizeQuarter("X".repeat(200))?.length, 32);
  });
});

describe("normalizeAction — precision WITH a catch-all", () => {
  it("normalizes the acquisition/disposal vocabulary", () => {
    assert.equal(normalizeAction("Buy", "PIT"), "BUY");
    assert.equal(normalizeAction("Market Purchase", "SAST"), "BUY");
    assert.equal(normalizeAction("Sell", "PIT"), "SELL");
    assert.equal(normalizeAction("Disposal", "SAST"), "SELL");
  });

  it("normalizes pledge event types", () => {
    assert.equal(
      normalizeAction("Creation of pledge", "PLEDGE"),
      "PLEDGE_CREATION",
    );
    assert.equal(normalizeAction("Creation", "PLEDGE"), "PLEDGE_CREATION");
    assert.equal(normalizeAction("Pledged", "PLEDGE"), "PLEDGE_CREATION");
    assert.equal(normalizeAction("Release", "PLEDGE"), "PLEDGE_RELEASE");
    assert.equal(normalizeAction("Revocation", "PLEDGE"), "PLEDGE_RELEASE");
    assert.equal(normalizeAction("Invocation", "PLEDGE"), "PLEDGE_INVOCATION");
    assert.equal(normalizeAction("Invoked", "PLEDGE"), "PLEDGE_INVOCATION");
  });

  it("does not record a release/invocation OF A PLEDGE as a new pledge", () => {
    // Both strings contain "PLEDG"; only the match ORDER keeps them apart, and
    // getting it wrong inverts the governance signal.
    assert.equal(
      normalizeAction("Release of pledge", "PLEDGE"),
      "PLEDGE_RELEASE",
    );
    assert.equal(
      normalizeAction("Invocation of pledged shares", "PLEDGE"),
      "PLEDGE_INVOCATION",
    );
  });

  it("keeps an UNKNOWN action verbatim rather than bucketing it into OTHER", () => {
    // A tight enum + OTHER would make every future SEBI transaction type
    // indistinguishable from every other unknown.
    assert.equal(normalizeAction("Gift Received", "PIT"), "GIFT RECEIVED");
    assert.equal(
      normalizeAction("Some New 2027 Type", "PLEDGE"),
      "SOME NEW 2027 TYPE",
    );
  });

  it("returns empty string when nothing was disclosed", () => {
    assert.equal(normalizeAction("-", "PIT"), "");
    assert.equal(normalizeAction(undefined, "PIT"), "");
  });
});

describe("extractRows — envelope tolerance", () => {
  it("accepts a bare array and the common wrapper keys", () => {
    assert.equal(extractRows([{ a: 1 }])?.length, 1);
    assert.equal(extractRows({ data: [{ a: 1 }] })?.length, 1);
    assert.equal(extractRows({ rows: [{ a: 1 }] })?.length, 1);
    assert.equal(extractRows({ records: [{ a: 1 }] })?.length, 1);
  });

  it("returns null (not []) for an unrecognized envelope so it can be COUNTED", () => {
    assert.equal(extractRows({ unexpected: { nested: 1 } }), null);
    assert.equal(extractRows("<html>"), null);
    assert.equal(extractRows(null), null);
  });

  it("drops non-object entries inside an array", () => {
    assert.equal(extractRows([{ a: 1 }, "junk", null])?.length, 1);
  });
});

// ── Shareholding ─────────────────────────────────────────────────────────────

describe("parseShareholdingMaster (REAL captured payload)", () => {
  it("builds one row per quarter, keyed off `date` and NOT `submissionDate`", () => {
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(out.rows.length, 2);
    // date = 30-JUN-2026 / 31-MAR-2026; submissionDate = 16-JUL / 07-APR. Keying
    // off the submission would file Q1 under July and Q4 under April.
    assert.deepEqual(
      out.rows.map((r) => r.quarter),
      ["2026-06", "2026-03"],
    );
    assert.equal(out.rows[0]?.symbol, "AAKASH");
  });

  it("maps `public_val` -> publicPct — the field that was null on 7,953/7,953 prod rows", () => {
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(out.rows[0]?.publicPct, 33.46);
    assert.equal(out.rows[1]?.publicPct, 33.46);
    assert.equal(out.keyHits["public:public_val"], 2);
  });

  it("maps `employeeTrusts` and keeps a REPORTED zero as 0, never null", () => {
    const zero = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(zero.rows[0]?.employeeTrustsPct, 0);
    const real = parseShareholdingMaster("ABREL", REAL_SHP_EMPLOYEE_TRUST);
    assert.equal(real.rows[0]?.employeeTrustsPct, 0.75);
    assert.equal(real.rows[0]?.publicPct, 49.04);
  });

  it("leaves a null `underlyingDrs` as null — an absent DR line is not 0%", () => {
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(out.rows[0]?.underlyingDrsPct, null);
    // and it must not have been counted as a hit either
    assert.equal(out.keyHits["underlyingDrs:underlyingDrs"], undefined);
  });

  it("leaves fii/dii/pledged null — this endpoint genuinely does not carry them", () => {
    // Documented boundary, not a gap in the parser: the split lives in the
    // linked XBRL. If a future payload DOES carry them, keyHits will say so.
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(out.rows[0]?.fiiPct, null);
    assert.equal(out.rows[0]?.diiPct, null);
    assert.equal(out.rows[0]?.pledgedPct, null);
  });

  it("records WHICH alias matched, per field (the falsification hook)", () => {
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(out.keyHits["promoter:pr_and_prgrp"], 2);
    assert.equal(out.keyHits["quarter:date"], 2);
    assert.equal(out.keyHits["public:public_val"], 2);
    assert.equal(out.keyHits["employeeTrusts:employeeTrusts"], 2);
  });

  it("reports NO unmapped verified keys on a payload we map completely", () => {
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.deepEqual(out.unmapped, {});
  });

  it("COUNTS a verified key that resolved to nothing — the counter keyHits cannot be", () => {
    // The regression this whole ticket is about, staged directly: the payload
    // carries `public_val` but the value will not parse as a percentage. keyHits
    // stays silent (nothing matched), `unmapped` speaks up.
    const out = parseShareholdingMaster("AAKASH", {
      data: [{ ...REAL_SHP.data[0], public_val: "not-a-number" }],
    });
    assert.equal(out.rows[0]?.publicPct, null);
    assert.equal(out.keyHits["public:public_val"], undefined);
    assert.equal(out.unmapped["public:public_val"], 1);
  });

  it("does NOT fire the unmapped counter when the verified key is genuinely blank", () => {
    // `underlyingDrs: null` on 7,854 of 7,953 prod rows. Firing here would bury
    // the real signal under a permanent 99% noise floor.
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    assert.equal(out.unmapped["underlyingDrs:underlyingDrs"], undefined);
  });

  it("stores the source row verbatim in raw, all 33 keys", () => {
    const out = parseShareholdingMaster("AAKASH", REAL_SHP);
    const raw = JSON.parse(out.rows[0]!.raw) as Record<string, unknown>;
    assert.deepEqual(raw, REAL_SHP.data[0]);
    assert.equal(Object.keys(raw).length, 33);
  });

  it("rejects a row with a quarter but no usable CORE percentage, and counts it", () => {
    const out = parseShareholdingMaster("AAKASH", {
      data: [{ date: "30-JUN-2026", pr_and_prgrp: "-", public_val: "" }],
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.skipped, 1);
    assert.equal(out.reasons.noPct, 1);
  });

  it("a reported employeeTrusts of 0 does NOT keep an otherwise-empty row alive", () => {
    // The gate counts CORE percentages only. `employeeTrusts:"0"` ships on ~90%
    // of live rows, so counting it would make the all-null guard vacuous and
    // re-open the "fetched but blank" vs "never fetched" confusion it exists to
    // prevent.
    const out = parseShareholdingMaster("AAKASH", {
      data: [
        {
          date: "30-JUN-2026",
          pr_and_prgrp: "-",
          public_val: "-",
          employeeTrusts: "0",
        },
      ],
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reasons.noPct, 1);
  });

  it("counts a mis-mapped column as pctOutOfRange instead of storing it", () => {
    const out = parseShareholdingMaster("AAKASH", {
      data: [
        { date: "30-JUN-2026", pr_and_prgrp: "98750000", public_val: "18.44" },
      ],
    });
    assert.equal(out.reasons.pctOutOfRange, 1);
    assert.equal(out.rows[0]?.promoterPct, null);
    assert.equal(out.rows[0]?.publicPct, 18.44);
  });

  it("counts a row with no period as noQuarter", () => {
    const out = parseShareholdingMaster("AAKASH", {
      data: [{ symbol: "AAKASH", pr_and_prgrp: "66.54" }],
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reasons.noQuarter, 1);
  });

  it("rejects a row whose symbol contradicts the per-symbol query", () => {
    const out = parseShareholdingMaster("AAKASH", {
      data: [{ symbol: "OTHERCO", date: "30-JUN-2026", pr_and_prgrp: "10" }],
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reasons.symbolMismatch, 1);
  });

  it("collapses a restated quarter to the LATER row and counts the restatement", () => {
    const out = parseShareholdingMaster("AAKASH", {
      data: [
        { date: "31-MAR-2026", pr_and_prgrp: "50.00" },
        { date: "2026-03-31", pr_and_prgrp: "52.31" },
      ],
    });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.promoterPct, 52.31);
    assert.equal(out.reasons.quarterRestated, 1);
  });

  it("counts an unrecognized envelope and returns no rows — never throws", () => {
    const out = parseShareholdingMaster("AAKASH", { surprise: true });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reasons.envelope, 1);
  });

  it("survives every hostile payload without throwing", () => {
    for (const payload of [
      null,
      undefined,
      "",
      42,
      "<html>error</html>",
      [],
      {},
    ]) {
      assert.doesNotThrow(() => parseShareholdingMaster("AAKASH", payload));
    }
    assert.doesNotThrow(() => parseShareholdingMaster("", REAL_SHP));
    assert.equal(
      parseShareholdingMaster("", REAL_SHP).reasons.noQuerySymbol,
      1,
    );
  });
});

// ── Insider events ───────────────────────────────────────────────────────────

describe("parseInsiderPit (SYNTHETIC fixtures)", () => {
  it("builds PIT rows keyed off the transaction date, not the intimation date", () => {
    const out = parseInsiderPit("ACMECORP", SYNTHETIC_PIT);
    assert.equal(out.rows.length, 2);
    const first = out.rows[0]!;
    assert.equal(first.category, "PIT");
    assert.equal(first.symbol, "ACMECORP");
    assert.equal(first.person, "R. Invented");
    assert.equal(first.action, "BUY");
    assert.equal(first.qty, 12500);
    assert.equal(first.value, 1562500.5);
    // acqtoDt (02-Jul) wins over intimDt (04-Jul).
    assert.equal(first.date.toISOString().slice(0, 10), "2026-07-02");
    assert.equal(out.keyHits["date:acqtoDt"], 2);
  });

  it("leaves an undisclosed value null rather than 0", () => {
    const out = parseInsiderPit("ACMECORP", SYNTHETIC_PIT);
    assert.equal(out.rows[1]?.value, null);
    assert.equal(out.rows[1]?.action, "SELL");
  });

  it("counts an undated row instead of inventing a date", () => {
    const out = parseInsiderPit("ACMECORP", {
      data: [{ symbol: "ACMECORP", acqName: "X", secAcq: "10" }],
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reasons.noDate, 1);
  });

  it("distinguishes a PRESENT-but-unparseable date from a missing one", () => {
    const out = parseInsiderPit("ACMECORP", {
      data: [{ symbol: "ACMECORP", acqName: "X", acqtoDt: "sometime in July" }],
    });
    assert.equal(out.reasons.unparsedDate, 1);
    assert.equal(out.reasons.noDate, undefined);
  });

  it("rejects a dated row carrying nothing else (an empty shell)", () => {
    const out = parseInsiderPit("ACMECORP", {
      data: [{ symbol: "ACMECORP", acqtoDt: "02-Jul-2026" }],
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.reasons.emptyRow, 1);
  });

  it("never throws on hostile payloads", () => {
    for (const payload of [
      null,
      undefined,
      0,
      "<html>",
      { data: "nope" },
      [1, 2],
    ]) {
      assert.doesNotThrow(() => parseInsiderPit("ACMECORP", payload));
    }
  });
});

describe("parseSastReg29 (SYNTHETIC fixtures)", () => {
  it("parses the unpadded-day format and tags the category SAST", () => {
    const out = parseSastReg29("ACMECORP", SYNTHETIC_SAST);
    assert.equal(out.rows.length, 1);
    const row = out.rows[0]!;
    assert.equal(row.category, "SAST");
    assert.equal(row.person, "Fictional Holdings Pvt Ltd");
    assert.equal(row.action, "BUY");
    assert.equal(row.qty, 100000);
    assert.equal(row.value, 98750000);
    assert.equal(row.date.toISOString().slice(0, 10), "2026-07-09");
  });

  it("accepts a bare-array envelope", () => {
    assert.equal(
      parseSastReg29("ACMECORP", SYNTHETIC_SAST).reasons.envelope,
      undefined,
    );
  });
});

describe("parsePledgeData — BULK, symbol comes off the row", () => {
  it("attributes each row to its own symbol", () => {
    const out = parsePledgeData(SYNTHETIC_PLEDGE);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["ACMECORP", "BOGUSLTD"],
    );
    assert.equal(out.rows[0]?.action, "PLEDGE_CREATION");
    assert.equal(out.rows[1]?.action, "PLEDGE_RELEASE");
    assert.equal(out.rows[0]?.qty, 250000);
    assert.equal(out.rows[1]?.qty, null); // "-" → null, not 0
    assert.equal(out.rows[1]?.value, 999999.25);
  });

  it("counts a row with no symbol rather than guessing one", () => {
    const out = parsePledgeData(SYNTHETIC_PLEDGE);
    assert.equal(out.skipped, 1);
    assert.equal(out.reasons.noSymbol, 1);
  });

  it("never throws on hostile payloads", () => {
    for (const payload of [null, undefined, "<html>", { data: 5 }]) {
      assert.doesNotThrow(() => parsePledgeData(payload));
    }
  });
});

// ── Dedupe identity ──────────────────────────────────────────────────────────

describe("insiderEventKey — insider filings have no stable id", () => {
  const base: InsiderEventRow = {
    symbol: "ACMECORP",
    date: new Date(Date.UTC(2026, 6, 2)),
    person: "R. Invented",
    category: "PIT",
    action: "BUY",
    qty: 12500,
    value: 1562500.5,
    raw: "{}",
  };

  it("is stable for the same event re-served by the rolling window", () => {
    assert.equal(
      insiderEventKey(base),
      insiderEventKey({ ...base, raw: '{"x":1}' }),
    );
  });

  it("ignores raw — volatile payload fields must not mint a new key", () => {
    const withUrl = {
      ...base,
      raw: JSON.stringify({ attachment: "?token=abc" }),
    };
    assert.equal(insiderEventKey(base), insiderEventKey(withUrl));
  });

  it("separates two same-day trades by the same person at different sizes", () => {
    assert.notEqual(
      insiderEventKey(base),
      insiderEventKey({ ...base, qty: 500 }),
    );
    assert.notEqual(
      insiderEventKey(base),
      insiderEventKey({ ...base, value: 1 }),
    );
  });

  it("separates every other business field", () => {
    const variants: Array<Partial<InsiderEventRow>> = [
      { symbol: "BOGUSLTD" },
      { date: new Date(Date.UTC(2026, 6, 3)) },
      { person: "Someone Else" },
      { category: "SAST" },
      { action: "SELL" },
    ];
    for (const v of variants) {
      assert.notEqual(
        insiderEventKey(base),
        insiderEventKey({ ...base, ...v }),
        `key collided on ${Object.keys(v)[0]}`,
      );
    }
  });

  it("escapes the separator so two different filings cannot collide", () => {
    // Unescaped, "Y|ACME" + "BUY" and "Y" + "ACME|BUY" join to the same string.
    const a = insiderEventKey({ ...base, person: "Y|ACME", action: "BUY" });
    const b = insiderEventKey({ ...base, person: "Y", action: "ACME|BUY" });
    assert.notEqual(a, b);
  });

  it("normalizes numerically — 1,000 and 1000 are one quantity", () => {
    assert.equal(
      insiderEventKey({ ...base, qty: 1000 }),
      insiderEventKey({ ...base, qty: 1000.0 }),
    );
  });

  it("ignores the time of day (the date is a calendar day)", () => {
    assert.equal(
      insiderEventKey(base),
      insiderEventKey({
        ...base,
        date: new Date(Date.UTC(2026, 6, 2, 18, 30)),
      }),
    );
  });
});

// ── The weekly sharder ───────────────────────────────────────────────────────

/** A deterministic synthetic universe of `n` invented symbols. */
function syntheticUniverse(n: number, prefix = "SYM"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe("weekShard — complete, disjoint, growth-stable", () => {
  const universe = syntheticUniverse(4200);

  it("covers the ENTIRE universe across the seven days", () => {
    const seen = new Set<string>();
    for (let day = 0; day < 7; day++) {
      for (const s of weekShard(universe, day)) seen.add(s);
    }
    assert.equal(seen.size, universe.length);
    for (const s of universe) assert.ok(seen.has(s), `${s} never scheduled`);
  });

  it("never schedules a symbol twice in a week", () => {
    const counts = new Map<string, number>();
    for (let day = 0; day < 7; day++) {
      for (const s of weekShard(universe, day)) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    for (const [symbol, count] of counts) {
      assert.equal(count, 1, `${symbol} scheduled ${count}x`);
    }
  });

  it("is STABLE under universe growth — no existing symbol moves days", () => {
    // The whole reason the sharder hashes the symbol instead of using `index % 7`:
    // one new listing must not reshuffle the calendar.
    const before = new Map<string, number>();
    for (let day = 0; day < 7; day++) {
      for (const s of weekShard(universe, day)) before.set(s, day);
    }

    const grown = [...universe, ...syntheticUniverse(500, "NEWLISTING")];
    const after = new Map<string, number>();
    for (let day = 0; day < 7; day++) {
      for (const s of weekShard(grown, day)) after.set(s, day);
    }

    for (const [symbol, day] of before) {
      assert.equal(after.get(symbol), day, `${symbol} moved from day ${day}`);
    }
    assert.equal(after.size, 4700);
  });

  it("is stable under universe SHRINKAGE and reordering too", () => {
    const shuffled = [...universe].reverse();
    for (let day = 0; day < 7; day++) {
      assert.deepEqual(weekShard(shuffled, day), weekShard(universe, day));
    }
    const trimmed = universe.slice(0, 1000);
    for (const s of trimmed) {
      assert.ok(weekShard(trimmed, shardOf(s)).includes(s));
    }
  });

  it("lands roughly ~600/day on a ~4,200-name universe", () => {
    const sizes = Array.from(
      { length: 7 },
      (_, d) => weekShard(universe, d).length,
    );
    const expected = universe.length / 7;
    for (const size of sizes) {
      assert.ok(
        Math.abs(size - expected) < expected * 0.25,
        `shard of ${size} is more than 25% off ${expected} (sizes: ${sizes.join(",")})`,
      );
    }
    assert.equal(
      sizes.reduce((a, b) => a + b, 0),
      universe.length,
    );
  });

  it("normalizes symbols: dedupes, upper-cases and strips the Yahoo suffix", () => {
    const shard = weekShard(
      ["acmecorp", "ACMECORP", "ACMECORP.NS", " ACMECORP "],
      shardOf("ACMECORP"),
    );
    assert.deepEqual(shard, ["ACMECORP"]);
  });

  it("returns sorted output so the walk order is reproducible", () => {
    const shard = weekShard(universe, 3);
    assert.deepEqual(shard, [...shard].sort());
  });

  it("wraps out-of-range and negative day values instead of throwing", () => {
    assert.deepEqual(weekShard(universe, 7), weekShard(universe, 0));
    assert.deepEqual(weekShard(universe, -1), weekShard(universe, 6));
    assert.deepEqual(weekShard(universe, Number.NaN), weekShard(universe, 0));
  });

  it("ignores blank entries in the universe", () => {
    assert.deepEqual(weekShard(["", "   ", ".NS"], 0), []);
  });
});

describe("rotateSlice — a budget cut must not blind the same tail forever", () => {
  const shard = syntheticUniverse(10, "S");

  it("returns everything when the cap does not bind", () => {
    assert.deepEqual(rotateSlice(shard, 0, 0), shard);
    assert.deepEqual(rotateSlice(shard, 10, 5), shard);
    assert.deepEqual(rotateSlice(shard, 99, 3), shard);
    assert.deepEqual(rotateSlice([], 5, 0), []);
  });

  it("takes `cap` items from the rotated start, wrapping around", () => {
    assert.deepEqual(rotateSlice(shard, 3, 0), ["S0", "S1", "S2"]);
    assert.deepEqual(rotateSlice(shard, 3, 3), ["S3", "S4", "S5"]);
    assert.deepEqual(rotateSlice(shard, 3, 9), ["S9", "S0", "S1"]);
  });

  it("reaches EVERY symbol within ceil(n/cap) rotations", () => {
    const cap = 3;
    const seen = new Set<string>();
    for (let week = 0; week < Math.ceil(shard.length / cap); week++) {
      for (const s of rotateSlice(shard, cap, week * cap)) seen.add(s);
    }
    assert.equal(seen.size, shard.length);
  });

  it("handles negative offsets", () => {
    assert.deepEqual(rotateSlice(shard, 2, -1), ["S9", "S0"]);
  });
});

describe("istDayOfWeek / istWeekIndex", () => {
  it("uses the IST calendar day, not UTC", () => {
    // 2026-07-09T20:00Z is still Thursday in UTC but already Friday in IST
    // (01:30 IST on the 10th). Sharding on UTC there would run the wrong shard.
    assert.equal(new Date("2026-07-09T20:00:00Z").getUTCDay(), 4);
    assert.equal(istDayOfWeek(new Date("2026-07-09T20:00:00Z")), 5);
  });

  it("agrees with UTC at the 20:30 IST cron hour (15:00 UTC)", () => {
    const cronInstant = new Date("2026-07-09T15:00:00Z");
    assert.equal(istDayOfWeek(cronInstant), cronInstant.getUTCDay());
  });

  it("returns a value in 0..6", () => {
    for (let h = 0; h < 24; h++) {
      const d = istDayOfWeek(new Date(Date.UTC(2026, 6, 9, h)));
      assert.ok(d >= 0 && d <= 6);
    }
  });

  it("advances the week index exactly once per week and is monotone", () => {
    const t0 = new Date("2026-07-09T15:00:00Z");
    const week = 7 * 24 * 60 * 60 * 1000;
    assert.equal(
      istWeekIndex(new Date(t0.getTime() + week)),
      istWeekIndex(t0) + 1,
    );
    assert.equal(
      istWeekIndex(new Date(t0.getTime() + 6 * 24 * 3600_000)),
      istWeekIndex(t0),
    );
    assert.ok(
      istWeekIndex(new Date("2026-08-09T15:00:00Z")) > istWeekIndex(t0),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Live-payload regressions (MONEY-1098 prod audit)
//
// Every case below is built from the REAL response NSE returned on
// 2026-08-11. These three parsers each dropped 100% of a non-empty payload
// in production, and all three would have been caught by one call against
// the live endpoint before shipping — which is exactly what did not happen.
// ══════════════════════════════════════════════════════════════════════

describe("SAST reg-29 — real payload shape", () => {
  // Verbatim field set from /api/corporate-sast-reg29?symbol=RELIANCE.
  const row = {
    acqSaleType: "Sale",
    acqType: "Equity shares",
    acquirerDate: "27-MAR-2024 to 27-MAR-2024",
    acquirerName: "SBICAP Trustee Company Limited",
    acquisitionMode: "Others",
    company: "Reliance Industries Limited",
    noOfShareAcq: null,
    noOfShareAft: "0",
    noOfShareSale: "5500",
    promoterType: "N",
  };

  it("parses a row whose date is a RANGE and whose qty is on the SALE side", () => {
    // Pre-fix: 0 of 20 rows survived — `acquirerDate` matched no date key, so
    // every row was counted `unparsedDate`.
    const out = parseSastReg29("RELIANCE", { data: [row] });
    assert.equal(out.rows.length, 1);
    assert.equal(out.skipped, 0);
    const r = out.rows[0]!;
    assert.equal(
      r.symbol,
      "RELIANCE",
      "no symbol on the row — falls back to the queried one",
    );
    assert.equal(r.date.toISOString().slice(0, 10), "2024-03-27");
    assert.equal(r.person, "SBICAP Trustee Company Limited");
    assert.equal(
      r.qty,
      5500,
      "a disposal carries its quantity in noOfShareSale",
    );
  });

  it("takes the START of a multi-day acquisition window", () => {
    const out = parseSastReg29("RELIANCE", {
      data: [{ ...row, acquirerDate: "25-MAR-2024 to 27-MAR-2024" }],
    });
    assert.equal(out.rows[0]!.date.toISOString().slice(0, 10), "2024-03-25");
  });
});

describe("pledge feed — name-only attribution", () => {
  // Verbatim field set from /api/corporate-pledgedata?index=equities.
  const row = {
    broadcastDt: "11-Aug-2026 16:31:32",
    comName: "20 Microns Limited",
    compBroadcastDate: "31-03-2015",
    numSharesPledged: "1558106",
    percSharesPledged: "4.42",
  };

  it("cannot attribute a row without a resolver — and says so", () => {
    // The feed has NO symbol field at all. Silently dropping was the bug;
    // counting it is the contract.
    const out = parsePledgeData({ data: [row] });
    assert.equal(out.rows.length, 0);
    assert.ok((out.reasons.unresolvedName ?? 0) > 0);
  });

  it("attributes via the company-name map", () => {
    const map = new Map([
      [normalizeCompanyName("20 Microns Ltd."), "20MICRONS"],
    ]);
    const out = parsePledgeData({ data: [row] }, map);
    assert.equal(out.rows.length, 1);
    const r = out.rows[0]!;
    assert.equal(r.symbol, "20MICRONS");
    assert.equal(
      r.date.toISOString().slice(0, 10),
      "2015-03-31",
      "compBroadcastDate, not the feed's broadcast time",
    );
    assert.equal(r.qty, 1558106);
  });

  it("falls back to broadcastDt when the disclosure date is null", () => {
    // 788 of 1,540 live rows carry compBroadcastDate: null.
    const map = new Map([
      [normalizeCompanyName("20 Microns Ltd."), "20MICRONS"],
    ]);
    const out = parsePledgeData(
      { data: [{ ...row, compBroadcastDate: null }] },
      map,
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.date.toISOString().slice(0, 10), "2026-08-11");
  });
});

describe("normalizeCompanyName", () => {
  it("collapses the corporate-suffix spellings that block the join", () => {
    assert.equal(
      normalizeCompanyName("20 Microns Limited"),
      normalizeCompanyName("20 Microns Ltd."),
    );
    assert.equal(
      normalizeCompanyName("Reliance Industries Limited"),
      normalizeCompanyName("RELIANCE INDUSTRIES LTD"),
    );
  });

  it("does not collapse genuinely different companies", () => {
    assert.notEqual(
      normalizeCompanyName("Tata Motors Ltd"),
      normalizeCompanyName("Tata Steel Ltd"),
    );
  });
});

describe("parseEventDate — shapes the live feeds actually emit", () => {
  it("accepts a trailing time (pledge broadcastDt)", () => {
    assert.equal(
      parseEventDate("11-Aug-2026 16:31:32")?.toISOString().slice(0, 10),
      "2026-08-11",
    );
  });

  it("accepts a date RANGE, taking the start (SAST acquirerDate)", () => {
    assert.equal(
      parseEventDate("27-MAR-2024 to 27-MAR-2024")?.toISOString().slice(0, 10),
      "2024-03-27",
    );
  });

  it("still rejects junk and rollovers", () => {
    assert.equal(parseEventDate("not a date"), null);
    assert.equal(parseEventDate("31-02-2026"), null);
  });
});

// ── The priority queue + resumable cursor (MONEY-1207) ───────────────────────

/**
 * A universe with the same SHAPE as prod: 10,437 NSE + 8,139 BSE-only, plus
 * 2,465 BSE rows that duplicate an NSE symbol. Symbols are generated, but the
 * counts and the overlap are the measured prod figures (2026-08-18), because the
 * numbers are what the coverage assertions are about.
 */
const NSE_COUNT = 10_437;
const BSE_ONLY_COUNT = 8_139;
const BSE_DUP_COUNT = 2_465;

function mkSymbols(n: number, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push(`${prefix}${String(i).padStart(6, "0")}`);
  return out;
}

const NSE_SYMBOLS = mkSymbols(NSE_COUNT, "N");
const BSE_ONLY_SYMBOLS = mkSymbols(BSE_ONLY_COUNT, "B");

function prodShapedUniverse(): Array<{ symbol: string; exchange: string }> {
  return [
    ...NSE_SYMBOLS.map((symbol) => ({ symbol, exchange: "NSE" })),
    // the duplicates: same symbol string, listed on BSE too
    ...NSE_SYMBOLS.slice(0, BSE_DUP_COUNT).map((symbol) => ({
      symbol,
      exchange: "BSE",
    })),
    ...BSE_ONLY_SYMBOLS.map((symbol) => ({ symbol, exchange: "BSE" })),
  ];
}

/**
 * Index membership in prod's shape. The Nifty 50 members are deliberately taken
 * from the MIDDLE of the alphabet, not the front: under the old sorted sharder
 * the reachable set was an alphabetical prefix, so a fixture whose index members
 * sort first would pass either way.
 */
function prodShapedIndexMembers(): Map<string, string[]> {
  return new Map<string, string[]>([
    ["nifty50", NSE_SYMBOLS.slice(5_000, 5_050)],
    ["nifty100", NSE_SYMBOLS.slice(5_000, 5_100)],
    ["nifty500", NSE_SYMBOLS.slice(5_000, 5_500)],
    // an id we do not tier — must be ignored, not crash
    ["niftyfmcg", NSE_SYMBOLS.slice(9_000, 9_015)],
  ]);
}

describe("buildOwnershipQueue — priority order and dedupe", () => {
  it("covers NSE + BSE, deduped by symbol, at the measured prod size", () => {
    const q = buildOwnershipQueue(
      prodShapedUniverse(),
      prodShapedIndexMembers(),
    );
    assert.equal(q.symbols.length, NSE_COUNT + BSE_ONLY_COUNT);
    assert.equal(q.symbols.length, 18_576);
    assert.equal(new Set(q.symbols).size, q.symbols.length);
  });

  it("puts the whole Nifty 50 at the HEAD, ahead of every other name", () => {
    const q = buildOwnershipQueue(
      prodShapedUniverse(),
      prodShapedIndexMembers(),
    );
    const head = new Set(q.symbols.slice(0, 50));
    for (const s of NSE_SYMBOLS.slice(5_000, 5_050)) {
      assert.ok(head.has(s), `${s} (Nifty 50) is not in the first 50`);
    }
  });

  it("reaches a Nifty 50 name before a random small cap — the whole point", () => {
    const q = buildOwnershipQueue(
      prodShapedUniverse(),
      prodShapedIndexMembers(),
    );
    const nifty = q.symbols.indexOf(NSE_SYMBOLS[5_010]!);
    const smallCap = q.symbols.indexOf(NSE_SYMBOLS[42]!);
    const bseOnly = q.symbols.indexOf(BSE_ONLY_SYMBOLS[0]!);
    assert.ok(nifty >= 0 && smallCap >= 0 && bseOnly >= 0);
    assert.ok(
      nifty < smallCap,
      `nifty50 at ${nifty} must precede small cap at ${smallCap}`,
    );
    assert.ok(
      smallCap < bseOnly,
      `NSE at ${smallCap} must precede BSE-only at ${bseOnly}`,
    );
  });

  it("orders the tiers nifty50 -> nifty100 -> nifty500 -> nseOther -> bseOnly", () => {
    const q = buildOwnershipQueue(
      prodShapedUniverse(),
      prodShapedIndexMembers(),
    );
    let last = -1;
    for (const s of q.symbols) {
      const tier = q.entries.get(s)!.tier;
      assert.ok(
        tier >= last,
        `tier went backwards at ${s} (${tier} after ${last})`,
      );
      last = tier;
    }
    assert.deepEqual(q.tierCounts, {
      nifty50: 50,
      nifty100: 50,
      nifty500: 400,
      nseOther: NSE_COUNT - 500,
      bseOnly: BSE_ONLY_COUNT,
    });
  });

  it("keeps the NSE identity when a symbol is listed on both exchanges", () => {
    const q = buildOwnershipQueue(
      prodShapedUniverse(),
      prodShapedIndexMembers(),
    );
    // NSE_SYMBOLS[0] appears twice in the input (NSE + BSE).
    assert.equal(q.entries.get(NSE_SYMBOLS[0]!)?.exchange, "NSE");
    assert.notEqual(
      q.entries.get(NSE_SYMBOLS[0]!)?.tier,
      OWNERSHIP_TIER.BSE_ONLY,
    );
    assert.equal(q.entries.get(BSE_ONLY_SYMBOLS[0]!)?.exchange, "BSE");
    assert.equal(
      q.entries.get(BSE_ONLY_SYMBOLS[0]!)?.tier,
      OWNERSHIP_TIER.BSE_ONLY,
    );
  });

  it("is stable under input order — the universe query has no guaranteed order", () => {
    const universe = prodShapedUniverse();
    const shuffled = [...universe].reverse();
    const a = buildOwnershipQueue(universe, prodShapedIndexMembers());
    const b = buildOwnershipQueue(shuffled, prodShapedIndexMembers());
    assert.deepEqual(a.symbols, b.symbols);
  });

  it("degrades to plain NSE-then-BSE order when index membership is unavailable", () => {
    // The processor swallows an index-load failure on purpose: it costs ORDER,
    // not coverage, and refusing to sync 18,576 symbols because the Nifty list
    // could not be read would be strictly worse.
    const q = buildOwnershipQueue(prodShapedUniverse(), new Map());
    assert.equal(q.symbols.length, 18_576);
    assert.deepEqual(q.tierCounts, {
      nseOther: NSE_COUNT,
      bseOnly: BSE_ONLY_COUNT,
    });
  });

  it("ignores blank symbols and normalises .NS / case", () => {
    const q = buildOwnershipQueue(
      [
        { symbol: "  hdfcbank.ns ", exchange: "NSE" },
        { symbol: "HDFCBANK", exchange: "NSE" },
        { symbol: "", exchange: "NSE" },
        { symbol: "   ", exchange: "BSE" },
      ],
      new Map([["nifty50", ["hdfcbank"]]]),
    );
    assert.deepEqual(q.symbols, ["HDFCBANK"]);
    assert.equal(q.entries.get("HDFCBANK")?.tier, OWNERSHIP_TIER.NIFTY50);
  });
});

describe("the resumable cursor — advance by CONSUMED, never by a stride", () => {
  const queue = mkSymbols(1_000, "S");

  it("starts at the head when there is no stored cursor", () => {
    assert.equal(resolveCursorIndex(queue, null), 0);
    assert.equal(resolveCursorIndex(queue, undefined), 0);
  });

  it("resumes immediately after the last symbol it actually consumed", () => {
    const cursor = advanceCursor(queue, 0, 137);
    assert.equal(cursor.index, 137);
    assert.equal(cursor.lastSymbol, queue[136]);
    assert.equal(resolveCursorIndex(queue, cursor), 137);
  });

  it("RESUMES BY SYMBOL, so a growing universe cannot shift its meaning", () => {
    // The failure `index % 7` had, restated: a new listing sorting in ahead of
    // the cursor shifts every position after it, and a bare index would then
    // silently skip or repeat. The prod universe moved 10,340 -> 10,506 in six
    // days, so this is the normal case, not an edge case.
    const cursor = advanceCursor(queue, 0, 300);
    const grown = ["AAA-NEW-LISTING", ...queue];
    assert.equal(resolveCursorIndex(grown, cursor), 301);
    assert.equal(grown[301], queue[300]);
  });

  it("falls back to the stored index when the symbol has been delisted", () => {
    const cursor = advanceCursor(queue, 0, 300);
    const shrunk = queue.filter((s) => s !== cursor.lastSymbol);
    assert.equal(resolveCursorIndex(shrunk, cursor), 300);
  });

  it("wraps: finishing the queue rolls straight into the next pass", () => {
    const cursor = advanceCursor(queue, 900, 100);
    assert.equal(cursor.index, 0);
    assert.equal(resolveCursorIndex(queue, cursor), 0);
  });

  it("does not move when nothing was consumed", () => {
    const cursor = advanceCursor(queue, 250, 0);
    assert.equal(cursor.index, 250);
    assert.equal(resolveCursorIndex(queue, cursor), 250);
  });

  it("sliceQueue never repeats a symbol inside one slice", () => {
    const slice = sliceQueue(queue, 950, 5_000);
    assert.equal(slice.length, queue.length);
    assert.equal(new Set(slice).size, queue.length);
    assert.equal(slice[0], queue[950]);
  });

  it("sliceQueue wraps and honours the cap", () => {
    assert.deepEqual(sliceQueue(queue, 998, 3), [
      queue[998],
      queue[999],
      queue[0],
    ]);
    assert.deepEqual(sliceQueue(queue, -1, 2), [queue[999], queue[0]]);
    assert.deepEqual(sliceQueue([], 0, 10), []);
    assert.deepEqual(sliceQueue(queue, 0, 0), []);
  });

  it("survives a corrupt stored cursor rather than throwing inside a cron job", () => {
    for (const bad of [
      { index: Number.NaN, lastSymbol: null },
      { index: -99_999, lastSymbol: null },
      { index: 1e9, lastSymbol: "GONE" },
    ] as OwnershipCursor[]) {
      const at = resolveCursorIndex(queue, bad);
      assert.ok(
        at >= 0 && at < queue.length,
        `${JSON.stringify(bad)} -> ${at}`,
      );
    }
  });
});

describe("weeks to full coverage — the regression the whole ticket is about", () => {
  /**
   * Walk the queue the way the processor does and report the DAY on which each
   * milestone is first reached. `consumedPerRun` is what the budget buys, and
   * the cursor advances by exactly that — which is the fix.
   */
  function daysToCover(
    symbols: readonly string[],
    consumedPerRun: number,
    runsPerDay: number,
    watch: readonly string[],
  ): { fullDay: number; watchDay: number } {
    const seen = new Set<string>();
    let cursor: OwnershipCursor | null = null;
    let watchDay = -1;
    for (let day = 1; day <= 400; day++) {
      for (let r = 0; r < runsPerDay; r++) {
        const from = resolveCursorIndex(symbols, cursor);
        for (const s of sliceQueue(symbols, from, 2_000).slice(
          0,
          consumedPerRun,
        )) {
          seen.add(s);
        }
        cursor = advanceCursor(symbols, from, consumedPerRun);
      }
      if (watchDay < 0 && watch.every((s) => seen.has(s))) watchDay = day;
      if (seen.size === symbols.length) return { fullDay: day, watchDay };
    }
    return { fullDay: Number.POSITIVE_INFINITY, watchDay };
  }

  const queue = buildOwnershipQueue(
    prodShapedUniverse(),
    prodShapedIndexMembers(),
  );
  const nifty50 = NSE_SYMBOLS.slice(5_000, 5_050);

  it("covers all 18,576 symbols within 7 days at the shipped cadence", () => {
    // The shipped schedule: one leg per job, 4 fires a day, ~760 symbols per
    // 420s run (measured single-endpoint throughput at 3 lanes / 600ms pace).
    const { fullDay } = daysToCover(queue.symbols, 760, 4, nifty50);
    assert.ok(
      fullDay <= FULL_PASS_ALERT_DAYS,
      `full pass took ${fullDay} days, past the ${FULL_PASS_ALERT_DAYS}-day target`,
    );
  });

  it("reaches the ENTIRE Nifty 50 on day one", () => {
    const { watchDay } = daysToCover(queue.symbols, 760, 4, nifty50);
    assert.equal(watchDay, 1);
  });

  it("still covers everything — just slower — when throughput collapses", () => {
    // The property that matters is that coverage does not DEPEND on throughput.
    // A run that only manages 50 symbols still loses nothing; it only takes
    // longer. Under the old fixed stride, a shortfall was a skip.
    const { fullDay } = daysToCover(queue.symbols, 50, 1, nifty50);
    assert.ok(Number.isFinite(fullDay));
    assert.equal(fullDay, Math.ceil(queue.symbols.length / 50));
  });

  it("the SUPERSEDED sharder leaves the same universe far outside the target", () => {
    // The measurement this replaces. 7 shards, cap 600, budget reaches 360 —
    // exactly what prod did — over the NSE half only (the old universe filter).
    const seen = new Set<string>();
    let weeks = 0;
    for (let w = 0; w < 400; w++) {
      weeks = w + 1;
      for (let d = 0; d < 7; d++) {
        for (const s of rotateSlice(
          weekShard(NSE_SYMBOLS, d),
          600,
          w * 600,
        ).slice(0, 360)) {
          seen.add(s);
        }
      }
      if (seen.size === NSE_SYMBOLS.length) break;
    }
    // Far past 7 DAYS, and this is the optimistic case: it excludes all 8,139
    // BSE-only names, which the old universe filter never fetched at all.
    assert.ok(
      weeks * 7 > FULL_PASS_ALERT_DAYS * 2,
      `old scheme took ${weeks} weeks`,
    );
  });
});

describe("projectedPassDays — 'could not determine' stays a distinct value", () => {
  it("projects days from the observed rate", () => {
    assert.equal(projectedPassDays(18_576, 760, 4), 18_576 / 3_040);
    assert.ok(projectedPassDays(18_576, 760, 4)! < FULL_PASS_ALERT_DAYS);
  });

  it("returns NULL, not 0 or Infinity, when it cannot be determined", () => {
    // A fabricated 0 reads as instant coverage; a fabricated Infinity fires the
    // alert on every targeted backfill. Neither is the truth, which is "unknown".
    assert.equal(projectedPassDays(18_576, 0, 4), null);
    assert.equal(projectedPassDays(18_576, 760, 0), null);
    assert.equal(projectedPassDays(18_576, Number.NaN, 4), null);
  });

  it("an empty queue is genuinely 0 days, not unknown", () => {
    assert.equal(projectedPassDays(0, 760, 4), 0);
  });

  it("flags a cadence that cannot make the target", () => {
    // The old cadence — one run a day — against the new universe.
    assert.ok(projectedPassDays(18_576, 760, 1)! > FULL_PASS_ALERT_DAYS);
  });
});

// ── Run status honesty (MONEY-1169 / MONEY-1189 class) ───────────────────────

describe("decideRunStatus — COMPLETED must mean COMPLETED", () => {
  const ok = {
    totalWritten: 1_200,
    writeFailed: 0,
    symbolsAttempted: 400,
    symbolsFailed: 0,
    missingModels: [] as string[],
  };

  it("reports COMPLETED for a healthy run", () => {
    const v = decideRunStatus({
      ...ok,
      legs: [
        {
          leg: "shareholding",
          fetched: 400,
          emptyResponses: 20,
          rows: 500,
          written: 500,
        },
        {
          leg: "pit",
          fetched: 400,
          emptyResponses: 20,
          rows: 400,
          written: 400,
        },
        {
          leg: "sast",
          fetched: 400,
          emptyResponses: 20,
          rows: 300,
          written: 300,
        },
      ],
    });
    assert.equal(v.status, "COMPLETED");
    assert.deepEqual(v.notes, []);
  });

  it("REFUSES to call the 2026-08-16 shape COMPLETED", () => {
    // The exact prod counters: 410 fetched per leg, ~22 empty, ZERO rows, and
    // the old code wrote status COMPLETED with recordsProcessed 0.
    const v = decideRunStatus({
      totalWritten: 0,
      writeFailed: 0,
      symbolsAttempted: 600,
      symbolsFailed: 0,
      missingModels: [],
      legs: [
        {
          leg: "shareholding",
          fetched: 410,
          emptyResponses: 22,
          rows: 0,
          written: 0,
        },
        { leg: "pit", fetched: 410, emptyResponses: 21, rows: 0, written: 0 },
        { leg: "sast", fetched: 410, emptyResponses: 23, rows: 0, written: 0 },
      ],
    });
    assert.notEqual(v.status, "COMPLETED");
    assert.equal(v.status, "FAILED");
    assert.deepEqual(v.barrenLegs, ["shareholding", "pit", "sast"]);
  });

  it("a stub answering {data:[]} for every symbol does NOT yield COMPLETED", () => {
    // NSE's silent-empty: a well-formed 200 carrying no rows. `payload !== null`
    // so it is NOT counted as an empty response — which is precisely why the
    // barren test is measured on payloads rather than on rows.
    const v = decideRunStatus({
      totalWritten: 0,
      writeFailed: 0,
      symbolsAttempted: 700,
      symbolsFailed: 0,
      missingModels: [],
      legs: [
        {
          leg: "shareholding",
          fetched: 700,
          emptyResponses: 0,
          rows: 0,
          written: 0,
        },
      ],
    });
    assert.notEqual(v.status, "COMPLETED");
    assert.ok(v.notes.join(" ").includes("parsed 0 rows"));
  });

  it("PARTIAL when only some legs are barren", () => {
    const v = decideRunStatus({
      ...ok,
      legs: [
        {
          leg: "shareholding",
          fetched: 400,
          emptyResponses: 20,
          rows: 500,
          written: 500,
        },
        { leg: "sast", fetched: 400, emptyResponses: 20, rows: 0, written: 0 },
      ],
    });
    assert.equal(v.status, "PARTIAL");
    assert.deepEqual(v.barrenLegs, ["sast"]);
  });

  it("does NOT cry wolf on a genuinely quiet handful of symbols", () => {
    // 5 non-empty payloads and no filings is a real answer, not a broken parser.
    const v = decideRunStatus({
      totalWritten: 0,
      writeFailed: 0,
      symbolsAttempted: 5,
      symbolsFailed: 0,
      missingModels: [],
      legs: [
        { leg: "pit", fetched: 5, emptyResponses: 0, rows: 0, written: 0 },
      ],
    });
    assert.equal(v.status, "COMPLETED");
  });

  it("holds a BULK leg to a threshold of one response", () => {
    // The pledge leg is a single market-wide call, so one well-formed empty
    // answer IS the whole signal. Prod's 2026-08-17 run returned exactly this
    // after six runs of ~1,540 rows, and was recorded COMPLETED.
    const v = decideRunStatus({
      ...ok,
      legs: [
        {
          leg: "shareholding",
          fetched: 400,
          emptyResponses: 20,
          rows: 500,
          written: 500,
        },
        {
          leg: "pledge",
          fetched: 1,
          emptyResponses: 0,
          rows: 0,
          written: 0,
          bulk: true,
        },
      ],
    });
    assert.equal(v.status, "PARTIAL");
    assert.deepEqual(v.barrenLegs, ["pledge"]);
    assert.ok(v.notes.join(" ").includes("market holiday"));
  });

  it("FAILED when the models are missing — nothing could be written", () => {
    const v = decideRunStatus({
      ...ok,
      totalWritten: 0,
      missingModels: ["ShareholdingPattern"],
      legs: [
        {
          leg: "shareholding",
          fetched: 400,
          emptyResponses: 20,
          rows: 500,
          written: 0,
        },
      ],
    });
    assert.equal(v.status, "FAILED");
    assert.ok(v.notes.join(" ").includes("ShareholdingPattern"));
  });

  it("FAILED when the queue came back empty", () => {
    // An empty universe query cannot be a real market state, and it presents as
    // a serene run with every counter at zero.
    const v = decideRunStatus({
      ...ok,
      totalWritten: 0,
      legs: [],
      emptyQueue: true,
    });
    assert.equal(v.status, "FAILED");
    assert.ok(v.notes.join(" ").includes("EMPTY"));
  });

  it("PARTIAL on write failures, and on losing 5% of the slice", () => {
    assert.equal(
      decideRunStatus({
        ...ok,
        writeFailed: 3,
        legs: [
          {
            leg: "pit",
            fetched: 400,
            emptyResponses: 20,
            rows: 400,
            written: 397,
          },
        ],
      }).status,
      "PARTIAL",
    );
    assert.equal(
      decideRunStatus({
        ...ok,
        symbolsAttempted: 400,
        symbolsFailed: 20,
        legs: [
          {
            leg: "pit",
            fetched: 400,
            emptyResponses: 20,
            rows: 400,
            written: 400,
          },
        ],
      }).status,
      "PARTIAL",
    );
    // ...but a couple of transient NSE timeouts in 400 symbols is normal.
    assert.equal(
      decideRunStatus({
        ...ok,
        symbolsAttempted: 400,
        symbolsFailed: 2,
        legs: [
          {
            leg: "pit",
            fetched: 400,
            emptyResponses: 20,
            rows: 400,
            written: 400,
          },
        ],
      }).status,
      "COMPLETED",
    );
  });
});

describe("mergeSyncMetadata — the completion write must not erase the start write", () => {
  it("KEEPS the coverage telemetry the create recorded", () => {
    // The prod defect: the completion `update` passed a fresh object, Prisma
    // replaces a Json column wholesale, and every one of the eight completed
    // logs lost `shardFull` / `skippedByCap` / `cycleWeeks`. The only instrument
    // that could show the starvation deleted itself on success.
    const started = {
      queueLength: 18_576,
      shardFull: 1_449,
      skippedByCap: 849,
      cycleWeeks: 3,
      tierCounts: { nifty50: 50 },
    };
    const merged = mergeSyncMetadata(started, {
      durationMs: 440_893,
      legStats: { shareholding: { rows: 120 } },
    });
    assert.equal(merged.shardFull, 1_449);
    assert.equal(merged.skippedByCap, 849);
    assert.equal(merged.cycleWeeks, 3);
    assert.equal(merged.queueLength, 18_576);
    assert.deepEqual(merged.tierCounts, { nifty50: 50 });
    assert.equal(merged.durationMs, 440_893);
  });

  it("lets the completion write OVERRIDE a key it owns", () => {
    assert.equal(
      mergeSyncMetadata({ status: "a" }, { status: "b" }).status,
      "b",
    );
  });

  it("is SHALLOW — a deep merge would double the per-leg counters", () => {
    const merged = mergeSyncMetadata(
      { legStats: { pit: { rows: 5 } } },
      { legStats: { pit: { rows: 9 } } },
    );
    assert.deepEqual(merged.legStats, { pit: { rows: 9 } });
  });

  it("tolerates a missing / non-object previous value", () => {
    for (const prev of [null, undefined, "junk", 42, ["a"]]) {
      assert.deepEqual(mergeSyncMetadata(prev, { a: 1 }), { a: 1 });
    }
  });
});

describe("readStoredCursors — reads what an EARLIER DEPLOY wrote", () => {
  it("reads a well-formed cursor map", () => {
    const out = readStoredCursors({
      cursors: {
        shareholding: { index: 760, lastSymbol: "HDFCBANK" },
        pit: { index: 12, lastSymbol: null },
      },
    });
    assert.deepEqual(out.shareholding, { index: 760, lastSymbol: "HDFCBANK" });
    assert.deepEqual(out.pit, { index: 12, lastSymbol: null });
  });

  it("degrades to empty rather than throwing inside a scheduled job", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "x",
      {},
      { cursors: null },
      { cursors: 7 },
    ]) {
      assert.deepEqual(readStoredCursors(bad), {});
    }
  });

  it("repairs a partially corrupt entry instead of dropping the whole map", () => {
    const out = readStoredCursors({
      cursors: {
        shareholding: { index: "not-a-number", lastSymbol: 42 },
        sast: { index: 5, lastSymbol: "ZEEL" },
      },
    });
    assert.deepEqual(out.shareholding, { index: 0, lastSymbol: null });
    assert.deepEqual(out.sast, { index: 5, lastSymbol: "ZEEL" });
  });
});
