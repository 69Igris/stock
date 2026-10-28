/**
 * UNIT TEST — NSE participant-wise F&O positioning (MONEY-1187, Data Engine P11).
 *
 * Fixtures are REAL published bytes, not hand-built:
 *   __tests__/fixtures/nse-positioning/fao_participant_oi_13082026.csv
 *   __tests__/fixtures/nse-positioning/fao_participant_vol_13082026.csv
 * so the padding, the doubled-quote title row and NSE's own off-by-one
 * arithmetic are all exercised exactly as they arrive.
 *
 * Three cases carry most of the weight:
 *
 *   1. `the doubled-quote title row does not swallow the file` — the sibling
 *      parsers' `toGrid` idiom returns ONE row containing the whole document on
 *      these bytes. That failure is silent and looks like a market holiday.
 *   2. `an unrecognised header returns null, not an empty result` — `[]` must
 *      never stand for both "not this report" and "no participants".
 *   3. `a bucket with a non-finite cell is dropped, not zeroed` — 0 is a claim
 *      about the market that a parse failure has no standing to make.
 *
 * Everything here is synchronous: no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

import {
  POSITIONING_BUCKETS,
  POSITIONING_PARTICIPANTS,
  diffPositioning,
  netContracts,
  parseContractCount,
  parseParticipantPositioning,
  parseParticipantTitleDate,
  parseParticipantTitleMeasure,
  type ParticipantPositioningRow,
  type PositioningBucket,
  type ParticipantType,
} from "../../src/market-data/market-positioning-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "nse-positioning");
const OI_CSV = readFileSync(
  join(FIXTURES, "fao_participant_oi_13082026.csv"),
  "utf-8",
);
const VOL_CSV = readFileSync(
  join(FIXTURES, "fao_participant_vol_13082026.csv"),
  "utf-8",
);

const AUG13 = new Date(Date.UTC(2026, 7, 13));

/** The live header, verbatim — trailing padding included. */
const REAL_HEADER = [
  "Client Type",
  "Future Index Long",
  "Future Index Short",
  "Future Stock Long",
  "Future Stock Short       ",
  "Option Index Call Long",
  "Option Index Put Long",
  "Option Index Call Short",
  "Option Index Put Short",
  "Option Stock Call Long",
  "Option Stock Put Long",
  "Option Stock Call Short",
  "Option Stock Put Short",
  "Total Long Contracts      ",
  "Total Short Contracts",
];

const TITLE =
  '""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Aug 13, 2026"",,,,,,,,,,,,,,';

/**
 * Build a file in the live column order from per-participant leg values.
 * `legs` is [futIdxL, futIdxS, futStkL, futStkS, optIdxCL, optIdxPL, optIdxCS,
 * optIdxPS, optStkCL, optStkPL, optStkCS, optStkPS] — NSE's order, which is NOT
 * the emit order, on purpose.
 */
function buildCsv(
  bodies: readonly (readonly [string, ...(string | number)[]])[],
  opts: { header?: readonly string[]; title?: string | null } = {},
): string {
  const header = (opts.header ?? REAL_HEADER).join(",");
  const title = opts.title === undefined ? TITLE : opts.title;
  const lines = title === null ? [] : [title];
  lines.push(header);
  for (const body of bodies) lines.push(body.join(","));
  return lines.join("\r\n") + "\r\n";
}

/** A row whose legs are all `n`, with correct totals. */
function uniformRow(
  label: string,
  n: number,
): readonly [string, ...(string | number)[]] {
  return [label, ...Array<number>(12).fill(n), n * 6, n * 6];
}

function rowFor(
  rows: readonly ParticipantPositioningRow[],
  participant: ParticipantType,
  bucket: PositioningBucket,
): ParticipantPositioningRow | undefined {
  return rows.find((r) => r.participant === participant && r.bucket === bucket);
}

// ─── Real fixtures ───────────────────────────────────────────────────

describe("parseParticipantPositioning — real NSE bytes", () => {
  it("unpivots to 4 participants x 6 buckets = 24 rows", () => {
    for (const csv of [OI_CSV, VOL_CSV]) {
      const parsed = parseParticipantPositioning(csv);
      assert.ok(parsed, "must not be null");
      assert.equal(parsed.rows.length, 24);
      assert.deepEqual(
        [...new Set(parsed.rows.map((r) => r.participant))].sort(),
        [...POSITIONING_PARTICIPANTS].sort(),
      );
      assert.deepEqual(
        [...new Set(parsed.rows.map((r) => r.bucket))].sort(),
        [...POSITIONING_BUCKETS].sort(),
      );
    }
  });

  it("takes the trading date from the TITLE row (no data row has one)", () => {
    const parsed = parseParticipantPositioning(OI_CSV);
    assert.ok(parsed);
    assert.equal(parsed.tradingDate?.toISOString(), AUG13.toISOString());
    assert.equal(parsed.tradingDate?.toISOString().slice(0, 10), "2026-08-13");
  });

  it("discriminates OI from VOLUME — the only difference between the files", () => {
    // Structurally identical files. Writing volume into the OI series would be
    // invisible downstream and would corrupt every positioning ratio built on
    // it, so the title is the in-band discriminator the caller checks.
    assert.equal(parseParticipantPositioning(OI_CSV)?.measure, "OI");
    assert.equal(parseParticipantPositioning(VOL_CSV)?.measure, "VOLUME");
  });

  it("maps every column by meaning, including the interleaved option legs", () => {
    // NSE's option block runs call-long, put-long, call-SHORT, put-SHORT. A
    // parser that assumed (call-long, call-short, put-long, put-short) reads
    // plausible numbers into the wrong buckets and nothing ever complains.
    const parsed = parseParticipantPositioning(OI_CSV);
    assert.ok(parsed);
    // FII row: 27487,196189,3528485,2900054,477249,895305,766090,421189,
    //          206855,367494,399690,200281
    assert.deepEqual(rowFor(parsed.rows, "FII", "FUT_IDX"), {
      participant: "FII",
      bucket: "FUT_IDX",
      longQty: 27487,
      shortQty: 196189,
    });
    assert.deepEqual(rowFor(parsed.rows, "FII", "FUT_STK"), {
      participant: "FII",
      bucket: "FUT_STK",
      longQty: 3528485,
      shortQty: 2900054,
    });
    assert.deepEqual(rowFor(parsed.rows, "FII", "OPT_IDX_CALL"), {
      participant: "FII",
      bucket: "OPT_IDX_CALL",
      longQty: 477249,
      shortQty: 766090,
    });
    assert.deepEqual(rowFor(parsed.rows, "FII", "OPT_IDX_PUT"), {
      participant: "FII",
      bucket: "OPT_IDX_PUT",
      longQty: 895305,
      shortQty: 421189,
    });
    assert.deepEqual(rowFor(parsed.rows, "FII", "OPT_STK_CALL"), {
      participant: "FII",
      bucket: "OPT_STK_CALL",
      longQty: 206855,
      shortQty: 399690,
    });
    assert.deepEqual(rowFor(parsed.rows, "FII", "OPT_STK_PUT"), {
      participant: "FII",
      bucket: "OPT_STK_PUT",
      longQty: 367494,
      shortQty: 200281,
    });
  });

  it("excludes the TOTAL row from the participant rows", () => {
    // It is the market-wide aggregate. Kept as a fifth participant it would
    // double every sum computed over `rows`.
    const parsed = parseParticipantPositioning(OI_CSV);
    assert.ok(parsed);
    assert.equal(
      parsed.rows.some((r) => String(r.participant) === "TOTAL"),
      false,
    );
    assert.equal(parsed.reasons.noTotalRow, undefined, "TOTAL row was seen");
  });

  it("parses without a single dropped cell (reasons stay empty)", () => {
    for (const csv of [OI_CSV, VOL_CSV]) {
      assert.deepEqual(parseParticipantPositioning(csv)?.reasons, {});
    }
  });

  it("the doubled-quote title row does not swallow the file", () => {
    // REGRESSION. `""…as on Aug 13, 2026""` opens a quoted field that never
    // legally closes, so the sibling `toGrid` idiom collapses the ENTIRE file
    // into one cell — proved here so nobody "simplifies" this parser into it.
    const naive = Papa.parse<string[]>(OI_CSV, { skipEmptyLines: "greedy" });
    assert.equal(naive.data.length, 1, "the trap still exists upstream");
    assert.ok(naive.errors.length > 0);

    assert.equal(parseParticipantPositioning(OI_CSV)?.rows.length, 24);
  });
});

// ─── Header resolution ───────────────────────────────────────────────

describe("parseParticipantPositioning — header matching", () => {
  it("matches header cells carrying trailing spaces", () => {
    // REGRESSION: the live file pads "Future Stock Short       " and
    // "Total Long Contracts      ". Exact-string matching drops both.
    const parsed = parseParticipantPositioning(
      buildCsv([uniformRow("FII", 5)]),
    );
    assert.ok(parsed);
    assert.equal(parsed.rows.length, 6);
    assert.equal(rowFor(parsed.rows, "FII", "FUT_STK")?.shortQty, 5);
    // Not inferred from an empty discrepancy list: `noTotalsColumns` is the
    // counter that fires when "Total Long Contracts      " fails to match, and
    // an unmatched totals column reports no discrepancies either.
    assert.equal(parsed.reasons.noTotalsColumns, undefined);
    assert.deepEqual(parsed.discrepancies, [], "padded totals column matched");
  });

  it("matches regardless of case and internal whitespace", () => {
    const header = REAL_HEADER.map((h) =>
      h.toUpperCase().replace(/ /g, "   ").concat("\t"),
    );
    const parsed = parseParticipantPositioning(
      buildCsv([uniformRow("FII", 7)], { header }),
    );
    assert.equal(parsed?.rows.length, 6);
  });

  it("matches by MEANING, not by position — a shuffled header still maps", () => {
    // Column order drifts across NSE report families; positional parsing is how
    // the earlier findings died.
    const order = [0, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const header = order.map((i) => REAL_HEADER[i]!);
    const body: (string | number)[] = new Array<string | number>(15);
    const live = uniformRow("FII", 9);
    order.forEach((src, dst) => {
      body[dst] = live[src]!;
    });
    const parsed = parseParticipantPositioning(
      buildCsv([body as [string, ...(string | number)[]]], { header }),
    );
    assert.equal(parsed?.rows.length, 6);
    assert.deepEqual(parsed?.discrepancies, []);
  });

  it("returns null — NOT an empty result — on an unrecognised header", () => {
    // REGRESSION. `[]` standing for both "not this report" and "no
    // participants" is the defect class this contract exists to prevent.
    const html = "<html><body>Access Denied</body></html>";
    assert.equal(parseParticipantPositioning(html), null);
    assert.equal(parseParticipantPositioning(""), null);
    assert.equal(parseParticipantPositioning("a,b,c\n1,2,3\n"), null);
  });

  it("returns null when even one leg column is missing", () => {
    // A file without "Option Stock Put Short" is not this report. Emitting five
    // buckets from it would look like a real day with a hole in it.
    const header = REAL_HEADER.filter((h) => h !== "Option Stock Put Short");
    assert.equal(
      parseParticipantPositioning(buildCsv([uniformRow("FII", 1)], { header })),
      null,
    );
  });

  it("distinguishes 'recognised but empty' from 'not this report'", () => {
    const parsed = parseParticipantPositioning(buildCsv([]));
    assert.notEqual(parsed, null, "the header WAS recognised");
    assert.deepEqual(parsed?.rows, []);
    assert.equal(parsed?.tradingDate?.toISOString(), AUG13.toISOString());
  });

  it("assumes column 0 for a renamed label column, and says so", () => {
    const header = [...REAL_HEADER];
    header[0] = "Who";
    const parsed = parseParticipantPositioning(
      buildCsv([uniformRow("FII", 3)], { header }),
    );
    assert.equal(parsed?.reasons.labelColumnAssumed, 1);
    assert.equal(parsed?.rows.length, 6, "still readable");
  });

  it("skips a preamble of several lines", () => {
    const csv = ["disclaimer line", "", TITLE, REAL_HEADER.join(",")].join(
      "\r\n",
    );
    const parsed = parseParticipantPositioning(csv);
    assert.ok(parsed);
    assert.equal(parsed.tradingDate?.toISOString(), AUG13.toISOString());
  });
});

// ─── Checksums ───────────────────────────────────────────────────────

describe("totals are a checksum, never a bucket", () => {
  it("never emits a TOTAL bucket", () => {
    const parsed = parseParticipantPositioning(OI_CSV);
    assert.ok(parsed);
    for (const row of parsed.rows) {
      assert.ok(
        (POSITIONING_BUCKETS as readonly string[]).includes(row.bucket),
        `unexpected bucket ${row.bucket}`,
      );
    }
  });

  it("the VOLUME fixture balances exactly — no discrepancies", () => {
    assert.deepEqual(parseParticipantPositioning(VOL_CSV)?.discrepancies, []);
  });

  it("the OI fixture does NOT balance, and says exactly where", () => {
    // NSE's own arithmetic, verified by hand against the published file:
    // Client's six long legs sum to 12,729,369 against a stated 12,729,368 and
    // Pro's to 4,918,610 against 4,918,609. The column-wise check catches a
    // third, independent off-by-one the row-wise check cannot see. All three
    // are ±1 — reported, not thrown, because a day's positioning is worth far
    // more than one contract of rounding.
    const parsed = parseParticipantPositioning(OI_CSV);
    assert.ok(parsed);
    assert.deepEqual(parsed.discrepancies, [
      {
        code: "TOTAL_LONG",
        participant: "CLIENT",
        column: "TOTAL_LONG",
        stated: 12729368,
        computed: 12729369,
        delta: 1,
      },
      {
        code: "TOTAL_LONG",
        participant: "PRO",
        column: "TOTAL_LONG",
        stated: 4918609,
        computed: 4918610,
        delta: 1,
      },
      {
        code: "PARTICIPANT_SUM",
        participant: null,
        column: "OPT_IDX_CALL_LONG",
        stated: 4609398,
        computed: 4609399,
        delta: 1,
      },
    ]);
    assert.equal(parsed.rows.length, 24, "a failed checksum drops nothing");
  });

  it("reports a hand-built mismatch instead of swallowing or throwing it", () => {
    const bad = [...uniformRow("FII", 100)] as [string, ...(string | number)[]];
    bad[13] = 999; // stated Total Long, against a real 600
    const parsed = parseParticipantPositioning(buildCsv([bad]));
    assert.ok(parsed);
    assert.deepEqual(parsed.discrepancies, [
      {
        code: "TOTAL_LONG",
        participant: "FII",
        column: "TOTAL_LONG",
        stated: 999,
        computed: 600,
        delta: -399,
      },
    ]);
    assert.equal(parsed.rows.length, 6, "the rows are still returned");
  });

  it("catches a column-down mismatch against NSE's own TOTAL row", () => {
    const rows = POSITIONING_PARTICIPANTS.map((p) => uniformRow(p, 10));
    const total = [...uniformRow("TOTAL", 40)] as [
      string,
      ...(string | number)[],
    ];
    total[1] = 41; // Future Index Long: participants sum to 40
    total[13] = 241; // keep the TOTAL row internally consistent with itself
    const parsed = parseParticipantPositioning(buildCsv([...rows, total]));
    assert.ok(parsed);
    assert.deepEqual(
      parsed.discrepancies.map((d) => [d.code, d.column, d.delta]),
      [["PARTICIPANT_SUM", "FUT_IDX_LONG", -1]],
    );
  });

  it("flags the TOTAL row disagreeing with its own stated total", () => {
    const rows = POSITIONING_PARTICIPANTS.map((p) => uniformRow(p, 10));
    const total = [...uniformRow("TOTAL", 40)] as [
      string,
      ...(string | number)[],
    ];
    total[14] = 1; // stated Total Short, against a real 240
    const parsed = parseParticipantPositioning(buildCsv([...rows, total]));
    assert.deepEqual(
      parsed?.discrepancies.map((d) => d.code),
      ["GRAND_TOTAL_SHORT"],
    );
  });

  it("counts a missing totals column instead of inventing a checksum", () => {
    // "Could not check" and "checked and it failed" are different facts.
    const header = REAL_HEADER.filter((h) => !/^Total/.test(h.trim()));
    const body = [...uniformRow("FII", 4)].slice(0, 13) as [
      string,
      ...(string | number)[],
    ];
    const parsed = parseParticipantPositioning(buildCsv([body], { header }));
    assert.ok(parsed);
    assert.equal(parsed.reasons.noTotalsColumns, 1);
    assert.deepEqual(parsed.discrepancies, []);
    assert.equal(parsed.rows.length, 6);
  });
});

// ─── Non-finite guard ────────────────────────────────────────────────

describe("non-finite and malformed cells", () => {
  it("parseContractCount returns null, never 0, for junk", () => {
    assert.equal(parseContractCount("12345"), 12345);
    assert.equal(parseContractCount("1,234"), 1234);
    assert.equal(parseContractCount(" 42 "), 42);
    assert.equal(parseContractCount(42), 42);
    for (const junk of [
      "",
      "   ",
      "-",
      "NA",
      "abc",
      "NaN",
      "Infinity",
      "1e999",
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.equal(parseContractCount(junk), null, `${String(junk)} -> null`);
    }
  });

  it("drops a bucket with a non-finite cell — it never becomes 0", () => {
    // The documented decision: long and short are one observation, so a bucket
    // missing either leg is dropped WHOLE and counted. 0 would render as a real
    // flat position and as a vast day-over-day swing.
    const row = [...uniformRow("FII", 50)] as [string, ...(string | number)[]];
    row[3] = "-"; // Future Stock Long
    const parsed = parseParticipantPositioning(buildCsv([row]));
    assert.ok(parsed);
    assert.equal(parsed.rows.length, 5);
    assert.equal(rowFor(parsed.rows, "FII", "FUT_STK"), undefined);
    assert.equal(parsed.reasons.nonFiniteLeg, 1);
    assert.equal(
      parsed.rows.some((r) => r.longQty === 0 || r.shortQty === 0),
      false,
      "no cell was zeroed",
    );
  });

  it("keeps the participant's other five buckets", () => {
    const row = [...uniformRow("DII", 8)] as [string, ...(string | number)[]];
    row[12] = "abc"; // Option Stock Put Short
    const parsed = parseParticipantPositioning(buildCsv([row]));
    assert.deepEqual(
      parsed?.rows.map((r) => r.bucket).sort(),
      POSITIONING_BUCKETS.filter((b) => b !== "OPT_STK_PUT")
        .slice()
        .sort(),
    );
  });

  it("skips — never fabricates — the checksum for a partial row", () => {
    // Summing five legs against a total that covers six would report a huge
    // fake discrepancy and bury the real ones.
    const row = [...uniformRow("PRO", 100)] as [string, ...(string | number)[]];
    row[5] = ""; // Option Index Call Long
    const parsed = parseParticipantPositioning(buildCsv([row]));
    assert.ok(parsed);
    assert.deepEqual(parsed.discrepancies, []);
    assert.equal(parsed.reasons.checksumSkipped, 1);
  });

  it("keeps a negative quantity but counts it", () => {
    // A loose accept is accidentally complete; narrowing it would turn an
    // unforeseen value into a silent absence.
    const row = [...uniformRow("FII", 5)] as [string, ...(string | number)[]];
    row[1] = -5;
    row[13] = 25;
    const parsed = parseParticipantPositioning(buildCsv([row]));
    assert.equal(rowFor(parsed?.rows ?? [], "FII", "FUT_IDX")?.longQty, -5);
    assert.equal(parsed?.reasons.negativeQty, 1);
  });

  it("counts an unknown or duplicated participant label", () => {
    const parsed = parseParticipantPositioning(
      buildCsv([
        uniformRow("Robots", 1),
        uniformRow("FII", 2),
        uniformRow("FII", 3),
      ]),
    );
    assert.ok(parsed);
    assert.equal(parsed.reasons.unknownParticipant, 1);
    assert.equal(parsed.reasons.duplicateParticipant, 1);
    assert.equal(parsed.rows.length, 6);
    assert.equal(
      rowFor(parsed.rows, "FII", "FUT_IDX")?.longQty,
      2,
      "first won",
    );
  });
});

// ─── Title parsing ───────────────────────────────────────────────────

describe("parseParticipantTitleDate", () => {
  it("reads the live 'as on Mon DD, YYYY' form out of the quoted title", () => {
    assert.equal(
      parseParticipantTitleDate(TITLE)?.toISOString(),
      AUG13.toISOString(),
    );
  });

  it("accepts NSE's other spellings of the same day", () => {
    for (const form of ["13-Aug-2026", "13 Aug 2026", "2026-08-13"]) {
      assert.equal(
        parseParticipantTitleDate(`Report as on ${form}`)?.toISOString(),
        AUG13.toISOString(),
        form,
      );
    }
  });

  it("finds a date even without an 'as on' clause", () => {
    assert.equal(
      parseParticipantTitleDate(
        "Participant OI for Aug 13, 2026",
      )?.toISOString(),
      AUG13.toISOString(),
    );
  });

  it("rejects an impossible day rather than rolling it over", () => {
    assert.equal(parseParticipantTitleDate("as on Feb 31, 2026"), null);
    assert.equal(parseParticipantTitleDate("as on Smarch 3, 2026"), null);
  });

  it("returns null when there is no date — the file is still parseable", () => {
    assert.equal(parseParticipantTitleDate(""), null);
    assert.equal(parseParticipantTitleDate("Participant wise OI"), null);

    // A missing date must NOT cost the day's rows: the caller knows which day
    // it requested and can fall back to it. Guessing one here would land the
    // positioning on the wrong day.
    const parsed = parseParticipantPositioning(
      buildCsv([uniformRow("FII", 2)], { title: "Participant wise OI,,," }),
    );
    assert.ok(parsed);
    assert.equal(parsed.tradingDate, null);
    assert.equal(parsed.reasons.noTitleDate, 1);
    assert.equal(parsed.rows.length, 6);
  });
});

describe("parseParticipantTitleMeasure", () => {
  it("reads OI and VOLUME from the live titles", () => {
    assert.equal(parseParticipantTitleMeasure(TITLE), "OI");
    assert.equal(
      parseParticipantTitleMeasure(
        '""Participant wise Trading Volume (no. of contracts) in Equity Derivatives as on Aug 13, 2026""',
      ),
      "VOLUME",
    );
  });

  it("returns null when the title does not say", () => {
    assert.equal(parseParticipantTitleMeasure("Participant wise report"), null);
    const parsed = parseParticipantPositioning(
      buildCsv([uniformRow("FII", 2)], { title: "as on Aug 13, 2026,,," }),
    );
    assert.equal(parsed?.measure, null);
    assert.equal(parsed?.reasons.noTitleMeasure, 1);
  });
});

// ─── Derivations ─────────────────────────────────────────────────────

describe("netContracts", () => {
  it("is long minus short, sign preserved", () => {
    const parsed = parseParticipantPositioning(OI_CSV);
    const fut = rowFor(parsed?.rows ?? [], "FII", "FUT_IDX")!;
    assert.equal(netContracts(fut), 27487 - 196189);
    assert.ok(netContracts(fut) < 0, "FII were net short index futures");
  });
});

describe("diffPositioning", () => {
  const today = parseParticipantPositioning(OI_CSV)!.rows;

  it("computes long, short and net change per (participant, bucket)", () => {
    const prev = today.map((r) => ({
      ...r,
      longQty: r.longQty - 100,
      shortQty: r.shortQty + 50,
    }));
    const changes = diffPositioning(today, prev);
    assert.equal(changes.length, 24);
    for (const c of changes) {
      assert.equal(c.longChange, 100);
      assert.equal(c.shortChange, -50);
      assert.equal(c.netChange, 150);
      assert.equal(c.net, c.longQty - c.shortQty);
    }
  });

  it("uses null — never 0 — when the previous day has no such row", () => {
    // 0 would print "FII added 3.5M index-future longs today" on the first day
    // of the series and after every gap: a headline number out of an absence.
    const changes = diffPositioning(today, []);
    assert.equal(changes.length, 24);
    for (const c of changes) {
      assert.equal(c.prevLongQty, null);
      assert.equal(c.prevShortQty, null);
      assert.equal(c.prevNet, null);
      assert.equal(c.longChange, null);
      assert.equal(c.netChange, null);
    }
  });

  it("mixes known and unknown previous rows in one pass", () => {
    const prev = today.filter((r) => r.participant === "FII");
    const changes = diffPositioning(today, prev);
    const fii = changes.filter((c) => c.participant === "FII");
    assert.equal(fii.length, 6);
    for (const c of fii) assert.equal(c.netChange, 0);
    for (const c of changes.filter((x) => x.participant !== "FII")) {
      assert.equal(c.netChange, null);
    }
  });

  it("ignores keys present only in the previous day", () => {
    // A bucket that vanished today is a hole in today's parse (already counted
    // in `reasons`), not a positioning change. Emitting it with qty 0 would
    // turn a parser problem into a market claim.
    const changes = diffPositioning(
      today.filter((r) => r.bucket === "FUT_IDX"),
      today,
    );
    assert.equal(changes.length, 4);
    assert.equal(
      changes.every((c) => c.bucket === "FUT_IDX"),
      true,
    );
  });

  it("is empty for an empty day, and does not throw", () => {
    assert.deepEqual(diffPositioning([], today), []);
    assert.deepEqual(diffPositioning([], []), []);
  });
});

// ─── Purity ──────────────────────────────────────────────────────────

describe("purity", () => {
  it("parseParticipantPositioning does not mutate or memoise its input", () => {
    const input = String(OI_CSV);
    const a = parseParticipantPositioning(input);
    const b = parseParticipantPositioning(input);
    assert.equal(input, OI_CSV, "input string untouched");
    assert.deepEqual(a, b, "same bytes, same answer");
    assert.notEqual(a?.rows, b?.rows, "no shared array between calls");
    a?.rows.push({
      participant: "FII",
      bucket: "FUT_IDX",
      longQty: 1,
      shortQty: 1,
    });
    assert.equal(parseParticipantPositioning(input)?.rows.length, 24);
  });

  it("diffPositioning does not mutate either argument", () => {
    // Frozen: an in-place sort or a field write would throw in module scope.
    const today = parseParticipantPositioning(OI_CSV)!.rows.map((r) =>
      Object.freeze({ ...r }),
    );
    const prev = parseParticipantPositioning(VOL_CSV)!.rows.map((r) =>
      Object.freeze({ ...r }),
    );
    const frozenToday = Object.freeze([...today]);
    const frozenPrev = Object.freeze([...prev]);
    const snapshotToday = structuredClone(today);
    const snapshotPrev = structuredClone(prev);

    const changes = diffPositioning(frozenToday, frozenPrev);

    assert.equal(changes.length, 24);
    assert.deepEqual([...frozenToday], snapshotToday);
    assert.deepEqual([...frozenPrev], snapshotPrev);
  });
});
