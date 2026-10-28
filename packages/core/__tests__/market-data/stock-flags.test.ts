/**
 * UNIT TEST — per-stock flag parsers (MONEY-1100 P4.5).
 *
 * Six of the seven families assert against REAL archived bytes, cut into
 * __tests__/fixtures/ from the repaired archive (post MONEY-1169):
 *   cm_52wk_high_low.sample.csv   eq_band_changes.sample.csv
 *   sec_list.sample.csv           fo_secban.sample.csv
 *   series_change.sample.csv      shortselling.sample.csv
 * so the assertions below are against bytes NSE actually published — quoting,
 * space padding, `-` placeholders, disclaimer preamble and all.
 *
 * REG_IND / REG1_IND have NOT been archived yet (both registered paths 404 as
 * of the 2026-08-08 probe). Their cases use SYNTHETIC input declared inline and
 * labelled as such — see SYNTHETIC_REG_IND below. Per the map's conflict rule
 * the archived file wins, so those cases must be re-derived from real bytes
 * when the family lands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseCm52WeekHighLow,
  parseEqBandChanges,
  parseSecList,
  parseSurveillanceIndicator,
  parseFoSecBan,
  parseSeriesChange,
  parseShortSelling,
  decodeSurveillanceCode,
  parseAsmReport,
  parseGsmReport,
  STOCK_FLAG_SOURCES,
  type StockFlagRow,
  type StockFlagParseResult,
} from "../../src/market-data/stock-flags";
import { familyById } from "../../src/market-data/report-registry";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf-8");

const WK52_CSV = read("cm_52wk_high_low.sample.csv");
const BAND_CHANGES_CSV = read("eq_band_changes.sample.csv");
const SEC_LIST_CSV = read("sec_list.sample.csv");
const SECBAN_CSV = read("fo_secban.sample.csv");
const SERIES_CHANGE_CSV = read("series_change.sample.csv");
const SHORTSELL_CSV = read("shortselling.sample.csv");

const AUG7 = new Date(Date.UTC(2026, 7, 7));
const AUG10 = new Date(Date.UTC(2026, 7, 10));

/** What an upstream error page / rate-limit block looks like in the archive. */
const HTML_GARBAGE =
  "<!DOCTYPE html>\n<html>\n<head><title>Access Denied</title></head>\n" +
  "<body>\n<h1>Access Denied</h1>\n<p>You don't have permission.</p>\n</body>\n</html>\n";

const day = (r: StockFlagRow): string => r.date.toISOString().slice(0, 10);
const val = (r: StockFlagRow): Record<string, unknown> =>
  JSON.parse(r.value) as Record<string, unknown>;

// ─── 52-week high/low ────────────────────────────────────────────────

describe("parseCm52WeekHighLow (real archived bytes)", () => {
  const out = parseCm52WeekHighLow(WK52_CSV, AUG7);

  it("skips the disclaimer preamble and finds the real header", () => {
    // Line 1 is the corporate-action disclaimer, line 2 is "Effective for
    // 07-Aug-2026", the header is line 3. A parser that trusted line 1 would
    // emit a row per column name; a header-driven one emits securities.
    assert.ok(
      WK52_CSV.startsWith('"Disclaimer'),
      "fixture must still start with the disclaimer, else this proves nothing",
    );
    assert.equal(out.rows.length, 6);
    assert.ok(
      out.rows.every((r) => r.kind === "WK52_HIGH_LOW"),
      "no preamble line may leak in as a row",
    );
    assert.ok(!out.rows.some((r) => /disclaimer|effective/i.test(r.symbol)));
  });

  it("reads adjusted extremes and their dates exactly as published", () => {
    const r = out.rows.find((x) => x.symbol === "20MICRONS")!;
    assert.equal(r.series, "EQ");
    assert.equal(day(r), "2026-08-07"); // no date column -> expectedDate stamps
    assert.equal(r.source, STOCK_FLAG_SOURCES.wk52HighLow);
    // Pin the exact encoding — downstream parses this string by `kind`.
    assert.equal(
      r.value,
      '{"high":246.61,"highDate":"2025-08-19","low":129.61,"lowDate":"2026-03-30"}',
    );
  });

  it("strips the space padding inside the quoted numerics", () => {
    // Published as `"  38030.00"` / `"  28730.00"`.
    const r = out.rows.find((x) => x.symbol === "3MINDIA")!;
    assert.deepEqual(val(r), {
      high: 38030,
      highDate: "2026-02-10",
      low: 28730,
      lowDate: "2026-04-02",
    });
  });

  it("skips all-`-` rows instead of writing zeros", () => {
    // 1STCUS$, 3BFILMS$, 3CIT$ have no 52-week window yet. Storing 0 would
    // read as "the low is ₹0" everywhere downstream.
    assert.equal(out.skipped, 3);
    for (const s of ["1STCUS$", "3BFILMS$", "3CIT$"]) {
      assert.equal(
        out.rows.find((r) => r.symbol === s),
        undefined,
        `${s} carries no data and must not produce a row`,
      );
    }
  });

  it("tolerates drifted header wording (map: 'wording drifts')", () => {
    const drifted =
      "SYMBOL,SERIES,52 Week High,52 Week High Dt,52 Week Low,52 Week Low Date\n" +
      "TATASTEEL,EQ,199.50,10-JAN-2026,120.10,03-APR-2026\n";
    const o = parseCm52WeekHighLow(drifted, AUG7);
    assert.equal(o.rows.length, 1);
    assert.deepEqual(val(o.rows[0]!), {
      high: 199.5,
      highDate: "2026-01-10",
      low: 120.1,
      lowDate: "2026-04-03",
    });
  });
});

// ─── Band changes ────────────────────────────────────────────────────

describe("parseEqBandChanges (real archived bytes)", () => {
  const out = parseEqBandChanges(BAND_CHANGES_CSV, AUG7);

  it("parses the verified header with NO date column", () => {
    // `Sr. No,Symbol,Series,Security Name,From,To` — correction #4. The
    // effective date is the file's date, supplied by the caller.
    assert.equal(out.rows.length, 9);
    assert.equal(out.skipped, 0);
    assert.ok(out.rows.every((r) => day(r) === "2026-08-07"));
  });

  it("keeps From/To as published strings, not numbers", () => {
    const r = out.rows[0]!;
    assert.equal(r.symbol, "ABMINTLLTD");
    assert.equal(r.series, "EQ");
    assert.equal(r.kind, "BAND_CHANGE");
    assert.equal(r.source, STOCK_FLAG_SOURCES.bandChanges);
    assert.equal(r.value, '{"from":"10","to":"20"}');
  });

  it("carries a non-numeric band through untouched", () => {
    // The sibling sec_list prints "No Band" for F&O names; Number() would make
    // that NaN. Strings keep every value the exchange can publish.
    const o = parseEqBandChanges(
      "Sr. No,Symbol,Series,Security Name,From,To\n1,RELIANCE,EQ,RELIANCE INDUSTRIES,20,No Band\n",
      AUG7,
    );
    assert.equal(o.rows[0]!.value, '{"from":"20","to":"No Band"}');
  });

  it("stamps nothing when the caller's date is unusable", () => {
    // An Invalid Date would otherwise be written into every row.
    const o = parseEqBandChanges(BAND_CHANGES_CSV, new Date("nonsense"));
    assert.equal(o.rows.length, 0);
    assert.ok(o.skipped > 0);
  });
});

// ─── Complete band list (+ the undocumented surveillance column) ─────

describe("parseSecList (real archived bytes)", () => {
  const out = parseSecList(SEC_LIST_CSV, AUG7);

  it("emits one PRICE_BAND row per security", () => {
    const bands = out.rows.filter((r) => r.kind === "PRICE_BAND");
    assert.equal(bands.length, 9);
    assert.equal(out.skipped, 0);
    const r = bands.find((x) => x.symbol === "21STCENMGM")!;
    assert.equal(r.series, "EQ");
    assert.equal(r.value, '{"band":"2"}');
    assert.equal(r.source, STOCK_FLAG_SOURCES.secList);
    assert.equal(day(r), "2026-08-07");
  });

  it("lifts the Remarks column into SURVEILLANCE rows, verbatim", () => {
    // FIXTURE FINDING: the map never mentions Remarks, but the archived file
    // carries GSM stage there — and it is the only archived surveillance
    // source we have while REG_IND/REG1_IND 404.
    const surv = out.rows.filter((r) => r.kind === "SURVEILLANCE");
    assert.equal(surv.length, 2);
    assert.deepEqual(surv.map((r) => r.symbol).sort(), [
      "ANSALAPI",
      "BLUECHIP",
    ]);
    const ansal = surv.find((r) => r.symbol === "ANSALAPI")!;
    assert.equal(ansal.value, "GSM STAGE - I", "stored exactly as published");
    assert.equal(ansal.series, "BZ");
    assert.equal(ansal.source, STOCK_FLAG_SOURCES.secList);
    // …and it decodes, without the decode being baked into storage.
    assert.deepEqual(decodeSurveillanceCode(ansal.value), {
      framework: "GSM",
      variant: null,
      stage: 1,
      label: "GSM Stage I",
    });
  });

  it("treats the `-` placeholder as absence, not a surveillance code", () => {
    const flagged = out.rows.filter(
      (r) => r.kind === "SURVEILLANCE" && r.value === "-",
    );
    assert.equal(flagged.length, 0);
  });
});

// ─── Surveillance (SYNTHETIC — family not archived yet) ──────────────

/**
 * SYNTHETIC FIXTURE — layout per docs/reference/per-file-derivable-map.md §4
 * ("symbol → surveillance indicator (ASM/GSM stage codes)").
 * REPLACE WITH AN ARCHIVED FIXTURE WHEN THE FAMILY LANDS: both registered
 * REG_IND / REG1_IND paths returned 404 on the 2026-08-08 registry probe, so
 * no real bytes exist to code against. The archived file wins over this guess.
 */
const SYNTHETIC_REG_IND =
  "Symbol,Series,Security Name,Surveillance Indicator\n" +
  "ANSALAPI,BZ,ANSAL PROPERTIES & INFRASTRUCTURE LIMITED,GSM Stage I\n" +
  "BLUECHIP,EQ,BLUE CHIP INDIA LIMITED,ST-ASM Stage II\n" +
  "ZEEMEDIA,EQ,ZEE MEDIA CORPORATION LIMITED,-\n";

/** SYNTHETIC — a plausible near-miss layout (no nameable indicator column). */
const SYNTHETIC_REG_IND_UNKNOWN_LAYOUT =
  "Symbol,Series,Security Name,Column4\n" +
  "ANSALAPI,BZ,ANSAL PROPERTIES,GSM Stage I\n" +
  "BLUECHIP,EQ,BLUE CHIP INDIA,ST-ASM Stage II\n";

describe("parseSurveillanceIndicator (SYNTHETIC input — family not archived)", () => {
  it("stores the indicator code verbatim", () => {
    const out = parseSurveillanceIndicator(SYNTHETIC_REG_IND, AUG7);
    assert.equal(out.rows.length, 2);
    assert.equal(out.skipped, 1, "the `-` row carries no code");
    const r = out.rows[0]!;
    assert.equal(r.symbol, "ANSALAPI");
    assert.equal(r.series, "BZ");
    assert.equal(r.kind, "SURVEILLANCE");
    assert.equal(r.value, "GSM Stage I");
    assert.equal(r.source, STOCK_FLAG_SOURCES.surveillance);
    assert.equal(day(r), "2026-08-07");
  });

  it("keeps REG1_IND distinguishable from REG_IND in storage", () => {
    const out = parseSurveillanceIndicator(
      SYNTHETIC_REG_IND,
      AUG7,
      STOCK_FLAG_SOURCES.surveillanceNew,
    );
    assert.ok(
      out.rows.every((r) => r.source === STOCK_FLAG_SOURCES.surveillanceNew),
    );
  });

  it("degrades to counted skips when no column names itself the indicator", () => {
    // The whole point of the header-driven design: an unrecognised layout must
    // produce NOTHING, not confidently wrong surveillance warnings appended to
    // a table nothing later reconciles.
    const out = parseSurveillanceIndicator(
      SYNTHETIC_REG_IND_UNKNOWN_LAYOUT,
      AUG7,
    );
    assert.equal(out.rows.length, 0);
    assert.ok(out.skipped > 0);
  });
});

describe("decodeSurveillanceCode", () => {
  it("decodes the ASM/GSM/ESM stage wordings NSE actually prints", () => {
    assert.deepEqual(decodeSurveillanceCode("GSM STAGE - I"), {
      framework: "GSM",
      variant: null,
      stage: 1,
      label: "GSM Stage I",
    });
    assert.deepEqual(decodeSurveillanceCode("GSM Stage 4"), {
      framework: "GSM",
      variant: null,
      stage: 4,
      label: "GSM Stage IV",
    });
    assert.deepEqual(decodeSurveillanceCode("ST-ASM Stage II"), {
      framework: "ASM",
      variant: "SHORT_TERM",
      stage: 2,
      label: "Short-term ASM Stage II",
    });
    assert.deepEqual(decodeSurveillanceCode("Long Term ASM - Stage IV"), {
      framework: "ASM",
      variant: "LONG_TERM",
      stage: 4,
      label: "Long-term ASM Stage IV",
    });
    assert.equal(decodeSurveillanceCode("ESM Stage 2")?.framework, "ESM");
    assert.equal(decodeSurveillanceCode("IBC")?.framework, "IBC");
    assert.equal(
      decodeSurveillanceCode("Trade for Trade")?.framework,
      "TRADE_FOR_TRADE",
    );
  });

  it("returns null for wording it does not know, never a guess", () => {
    assert.equal(decodeSurveillanceCode("SOME NEW FRAMEWORK 2029"), null);
    assert.equal(decodeSurveillanceCode(""), null);
    assert.equal(decodeSurveillanceCode("-"), null);
  });

  // MONEY-1189 — verbatim `survDesc` strings from /api/reportGSM on 2026-08-12.
  // NSE publishes COMBINED states, and the decoder used to take the first
  // `Stage` token anywhere in the string, so another framework's stage was
  // reported as GSM's. Every case erred the same direction — GSM 0 is the
  // mildest stage — so the retail warning surface systematically overstated
  // distress.
  describe("combined frameworks — the stage must belong to the framework", () => {
    const cases: Array<[string, number | null]> = [
      ["ESM Stage I and GSM Stage 0", 0],
      ["ESM Stage II and GSM Stage 0", 0],
      ["ASM IBC Stage I and GSM Stage 0", 0],
      ["LTASM Stage I and GSM Stage 0", 0],
      [
        "Company with high promoter as well as non-promoter Encumbrance and GSM Stage 0",
        0,
      ],
      [
        "Insolvency and Bankruptcy Code (IBC) - Receipt of Disclosure or Recommenced scrip and GSM stage 0",
        0,
      ],
      // GSM's own stage leads here — it must survive the fix unchanged.
      [
        "GSM stage II and Insolvency and Bankruptcy Code (IBC) - Receipt of Disclosure or Recommenced scrip",
        2,
      ],
      ["Graded Surveillance Measure - Stage VI", 6],
    ];

    for (const [raw, stage] of cases) {
      it(`${JSON.stringify(raw.slice(0, 46))} → GSM stage ${stage}`, () => {
        const d = decodeSurveillanceCode(raw);
        assert.equal(d?.framework, "GSM");
        assert.equal(d?.stage, stage);
      });
    }

    it("leaves stage null when NSE publishes no stage at all", () => {
      // "Shortlisted under Graded Surveillance Measure" — inventing a stage
      // here would be worse than admitting we do not have one.
      const d = decodeSurveillanceCode(
        "Shortlisted under Graded Surveillance Measure",
      );
      assert.equal(d?.framework, "GSM");
      assert.equal(d?.stage, null);
    });
  });

  // Verbatim `survDesc` from /api/reportASM — the feed T4 ingests. `\bASM\b`
  // does not match the single token LTASM/STASM, so both the framework and the
  // variant had to learn those spellings.
  describe("ASM long/short-term wordings from /api/reportASM", () => {
    it("decodes LTASM with its variant", () => {
      assert.deepEqual(
        decodeSurveillanceCode(
          "Long Term Additional Surveillance Measure (LTASM) - Stage IV",
        ),
        {
          framework: "ASM",
          variant: "LONG_TERM",
          stage: 4,
          label: "Long-term ASM Stage IV",
        },
      );
    });

    it("decodes STASM with its variant", () => {
      assert.deepEqual(
        decodeSurveillanceCode(
          "Short Term Additional Surveillance Measure (STASM) - Stage II",
        ),
        {
          framework: "ASM",
          variant: "SHORT_TERM",
          stage: 2,
          label: "Short-term ASM Stage II",
        },
      );
    });

    it("reads the bare LTASM/STASM tokens with no spelled-out words", () => {
      assert.equal(
        decodeSurveillanceCode("LTASM Stage I")?.variant,
        "LONG_TERM",
      );
      assert.equal(
        decodeSurveillanceCode("STASM Stage I")?.variant,
        "SHORT_TERM",
      );
    });
  });

  // The 25 distinct spellings prod actually holds for kind=SURVEILLANCE
  // (86,005 rows, all GSM via nse-sec-list). They must collapse to one decode
  // per stage — this is the "normalisation" the ticket asked for, and it is
  // already achieved at READ time, which is why the rows stay verbatim.
  it("collapses all 25 stored GSM spellings to 6 decodes", () => {
    const spellings = [
      "GSM STAGE - 0",
      "GSM Stage - 0",
      "GSM - Stage 0",
      "GSM STAGE - I",
      "GSM Stage - I",
      "GSM - Stage I",
      "GSM Stage I",
      "GSM Stage -I",
      "GSM Stage - 1",
      "GSM STAGE - II",
      "GSM Stage - II",
      "GSM - Stage II",
      "GSM Stage II",
      "GSM Stage -II",
      "GSM STAGE - III",
      "GSM Stage - III",
      "GSM - Stage III",
      "GSM Stage III",
      "GSM stage - III",
      "GSM STAGE - IV",
      "GSM Stage - IV",
      "GSM Stage IV",
      "GSM Stage -IV",
      "GSM stage - IV",
      "GSM Stage - VI",
    ];
    const decodes = new Set(
      spellings.map((s) => {
        const d = decodeSurveillanceCode(s);
        assert.ok(d, `${s} must decode`);
        return `${d.framework}/${d.stage}`;
      }),
    );
    assert.deepEqual([...decodes].sort(), [
      "GSM/0",
      "GSM/1",
      "GSM/2",
      "GSM/3",
      "GSM/4",
      "GSM/6",
    ]);
  });
});

// ─── ASM / GSM live JSON reports (MONEY-1189) ────────────────────────

describe("parseAsmReport / parseGsmReport", () => {
  const DAY = new Date(Date.UTC(2026, 7, 12));

  // Verbatim rows from /api/reportASM and /api/reportGSM on 2026-08-12.
  const ASM = {
    longterm: {
      data: [
        {
          asmSurvIndicator: "Stage I",
          asmTime: "12-Aug-2026",
          companyName: "21st Century Management Services Limited",
          isin: "INE253B01015",
          series: null,
          survCode: "LTASM - I (13)",
          survDesc:
            "Long Term Additional Surveillance Measure (LTASM) - Stage I",
          symbol: "21STCENMGM",
          srno: 1,
        },
      ],
    },
    shortterm: {
      data: [
        {
          asmSurvIndicator: "Stage I",
          asmTime: "12-Aug-2026",
          companyName: "3i Infotech Limited",
          isin: "INE748C01038",
          series: null,
          survCode: "STASM - I (11)",
          survDesc:
            "Short Term Additional Surveillance Measure (STASM) - Stage I",
          symbol: "3IINFOLTD",
          srno: 1,
        },
      ],
    },
  };

  const GSM = [
    {
      companyName: "AGS Transact Technologies Limited",
      gsmStage: "LXII",
      gsmTime: "12-Aug-2026 08:07:02",
      isin: "INE583L01014",
      survCode: "IBC - Receipt & GSM 0 (62)",
      survDesc:
        "Insolvency and Bankruptcy Code (IBC) - Receipt of Disclosure or Recommenced scrip and GSM stage 0",
      symbol: "AGSTRA",
      srno: 1,
    },
  ];

  it("reads BOTH ASM buckets, not just the first", () => {
    // longterm+shortterm are separate keys; taking only one silently halves
    // the framework NSE publishes.
    const out = parseAsmReport(ASM, DAY);
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows.map((r) => r.symbol).sort(), [
      "21STCENMGM",
      "3IINFOLTD",
    ]);
  });

  it("stores NSE's verbatim survDesc so the read-time decoder can work", () => {
    const out = parseAsmReport(ASM, DAY);
    const lt = out.rows.find((r) => r.symbol === "21STCENMGM")!;
    assert.equal(
      lt.value,
      "Long Term Additional Surveillance Measure (LTASM) - Stage I",
    );
    // The point of storing THAT string rather than survCode: it decodes.
    assert.deepEqual(decodeSurveillanceCode(lt.value), {
      framework: "ASM",
      variant: "LONG_TERM",
      stage: 1,
      label: "Long-term ASM Stage I",
    });
  });

  it("would NOT have been able to decode survCode — why the choice matters", () => {
    // Guards the decision: if someone switches `value` to survCode, every row
    // loses its stage. Neither code carries the word "Stage" — the Roman
    // numeral sits bare ("LTASM - I") or is the code number ("GSM - VI (6)"
    // is code 6, and the trailing "(6)" is not a stage either). The framework
    // still resolves, so the failure is silent: rows render as "Long-term ASM"
    // with no severity at all.
    assert.equal(decodeSurveillanceCode("LTASM - I (13)")?.stage, null);
    assert.equal(decodeSurveillanceCode("GSM - VI (6)")?.stage, null);
    // …whereas survDesc, which is what the parser stores, keeps it.
    assert.equal(
      decodeSurveillanceCode(
        "Long Term Additional Surveillance Measure (LTASM) - Stage I",
      )?.stage,
      1,
    );
  });

  it("dates rows from NSE's own list stamp, not the caller's clock", () => {
    // Keeps an archived response replayable: re-parsing yesterday's bytes must
    // reproduce yesterday's date, not today's.
    const out = parseAsmReport(ASM, new Date(Date.UTC(2030, 0, 1)));
    assert.equal(out.rows[0]!.date.getTime(), Date.UTC(2026, 7, 12));
  });

  it("falls back to the caller's day when NSE omits the stamp", () => {
    const noStamp = {
      longterm: { data: [{ ...ASM.longterm.data[0], asmTime: undefined }] },
    };
    const out = parseAsmReport(noStamp, DAY);
    assert.equal(out.rows[0]!.date.getTime(), DAY.getTime());
  });

  it("parses GSM and pins the stage to GSM, not the co-occurring IBC", () => {
    const out = parseGsmReport(GSM, DAY);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.symbol, "AGSTRA");
    assert.equal(decodeSurveillanceCode(out.rows[0]!.value)?.stage, 0);
  });

  it("IGNORES gsmStage — it is the surveillance code, not the stage", () => {
    // gsmStage "LXII" is Roman for 62, the code number in "(62)". Trusting it
    // would report this stock as GSM stage 62.
    const out = parseGsmReport(GSM, DAY);
    assert.ok(!out.rows[0]!.value.includes("LXII"));
  });

  it("drops and counts rows with no symbol or undecodable wording", () => {
    const junk = [
      { symbol: "", survDesc: "Graded Surveillance Measure - Stage I" },
      { symbol: "FOO", survDesc: "Some 2031 framework we have never seen" },
      { symbol: "BAR", survDesc: "" },
    ];
    const out = parseGsmReport(junk, DAY);
    assert.equal(out.rows.length, 0);
    assert.equal(out.skipped, 3);
  });

  it("tolerates a shape that is not what NSE documents", () => {
    // fetchNseApiJson can only promise "valid JSON", so the parsers must not
    // throw on anything else — a crash here fails a scheduled job.
    assert.deepEqual(parseGsmReport(null, DAY), { rows: [], skipped: 0 });
    assert.deepEqual(parseGsmReport({ data: [] }, DAY), {
      rows: [],
      skipped: 0,
    });
    assert.deepEqual(parseAsmReport(null, DAY), { rows: [], skipped: 0 });
    assert.deepEqual(parseAsmReport([], DAY), { rows: [], skipped: 0 });
  });

  it("tags rows with distinct, registry-resolvable sources", () => {
    assert.equal(parseAsmReport(ASM, DAY).rows[0]!.source, "nse-asm-api");
    assert.equal(parseGsmReport(GSM, DAY).rows[0]!.source, "nse-gsm-api");
    assert.ok(familyById("nse-asm-api"));
    assert.ok(familyById("nse-gsm-api"));
  });
});

// ─── F&O ban list ────────────────────────────────────────────────────

describe("parseFoSecBan (real archived bytes)", () => {
  it("parses the banner-plus-serial layout the archive actually has", () => {
    // FIXTURE FINDING: the map says "one symbol per row under a header". The
    // real file has NO column header — a banner sentence, then `1,SYMBOL`.
    const out = parseFoSecBan(SECBAN_CSV, AUG10);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["BANDHANBNK", "KAYNES", "LICI"],
    );
    assert.equal(out.skipped, 0);
    const r = out.rows[0]!;
    assert.equal(r.kind, "FO_BAN");
    assert.equal(r.value, "BAN");
    assert.equal(r.series, null);
    assert.equal(r.source, STOCK_FLAG_SOURCES.foSecBan);
  });

  it("believes the banner's trade date over the caller's date", () => {
    // The banner names the session the ban applies to; the archive key names
    // the day we fetched. Getting these backwards files the ban on the wrong
    // session, which is the whole signal.
    const out = parseFoSecBan(SECBAN_CSV, AUG7);
    assert.ok(out.rows.every((r) => day(r) === "2026-08-10"));
  });

  it("falls back to the caller's date when there is no banner", () => {
    const out = parseFoSecBan("1,TATAMOTORS\n2,IDEA\n", AUG7);
    assert.equal(out.rows.length, 2);
    assert.ok(out.rows.every((r) => day(r) === "2026-08-07"));
  });

  it("also parses the map's bare-symbol shape (older era)", () => {
    const out = parseFoSecBan("TATAMOTORS\nIDEA\n", AUG7);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["TATAMOTORS", "IDEA"],
    );
    assert.equal(out.skipped, 0);
  });

  it("refuses header words and stray dates as symbols", () => {
    const out = parseFoSecBan(
      "Sr No,Symbol\n1,TATAMOTORS\n,10-AUG-2026\n",
      AUG7,
    );
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["TATAMOTORS"],
    );
    assert.equal(out.skipped, 2);
  });
});

// ─── Series changes (rolling file) ───────────────────────────────────

describe("parseSeriesChange (real archived bytes)", () => {
  const out = parseSeriesChange(SERIES_CHANGE_CSV, AUG7);

  it("uses the row's own Change Date — the file is ROLLING", () => {
    // Fetched in 2026, every row is a 2023 change. Stamping the fetch day here
    // would invent three years of history.
    assert.equal(out.rows.length, 4);
    assert.equal(out.skipped, 0);
    assert.ok(
      out.rows.every((r) => day(r) === "2023-08-22"),
      "the caller's 2026 date must not reach the rows",
    );
  });

  it("records both ends and sets series to the RESULT", () => {
    const r = out.rows.find((x) => x.symbol === "KOTARISUG")!;
    assert.equal(r.kind, "SERIES_CHANGE");
    assert.equal(r.value, '{"from":"EQ","to":"BE"}');
    assert.equal(r.series, "BE", "series = what the stock is now");
    assert.equal(r.source, STOCK_FLAG_SOURCES.seriesChange);
  });

  it("skips a row whose date will not parse rather than dating it today", () => {
    const o = parseSeriesChange(
      "Symbol,Security,From Series,To Series,Change Date,Remarks\n" +
        'GOODROW,GOOD ROW LIMITED,EQ,BE,,"-"\n' +
        'BADROW,BAD ROW LIMITED,EQ,BE,31-FEB-2023,"-"\n',
      AUG7,
    );
    assert.equal(o.rows.length, 0);
    assert.equal(o.skipped, 2, "blank AND rollover dates are both unusable");
  });
});

// ─── Short selling ───────────────────────────────────────────────────

describe("parseShortSelling (real archived bytes)", () => {
  const out = parseShortSelling(SHORTSELL_CSV, AUG7);

  it("reads the quoted `Symbol Name` column and per-row trade date", () => {
    assert.equal(out.rows.length, 9);
    assert.equal(out.skipped, 0);
    const gail = out.rows.find((r) => r.symbol === "GAIL")!;
    assert.equal(gail.kind, "SHORT_SELLING");
    assert.equal(gail.value, '{"qty":91}');
    assert.equal(gail.series, null, "no series column in this family");
    assert.equal(day(gail), "2026-08-07");
    assert.equal(gail.source, STOCK_FLAG_SOURCES.shortSelling);
    assert.equal(val(out.rows.find((r) => r.symbol === "IREDA")!).qty, 13575);
  });

  it("trims the padding NSE leaves inside quoted names", () => {
    // `"JM FINANCIAL LIMITED    "` / `"REPCO HOME FINANCE LTD   "` — the SYMBOL
    // column is clean here, but the padding proves trimming is live.
    assert.ok(SHORTSELL_CSV.includes('LIMITED    "'));
    assert.ok(out.rows.some((r) => r.symbol === "JMFINANCIL"));
    assert.ok(out.rows.every((r) => r.symbol === r.symbol.trim()));
  });
});

// ─── Cross-cutting guarantees ────────────────────────────────────────

const ALL_PARSERS: ReadonlyArray<
  [string, (csv: string, d: Date) => StockFlagParseResult]
> = [
  ["parseCm52WeekHighLow", parseCm52WeekHighLow],
  ["parseEqBandChanges", parseEqBandChanges],
  ["parseSecList", parseSecList],
  ["parseSurveillanceIndicator", parseSurveillanceIndicator],
  ["parseFoSecBan", parseFoSecBan],
  ["parseSeriesChange", parseSeriesChange],
  ["parseShortSelling", parseShortSelling],
];

describe("every parser, on garbage", () => {
  for (const [name, parse] of ALL_PARSERS) {
    it(`${name}: HTML error page -> 0 rows, counted skips, no throw`, () => {
      const out = parse(HTML_GARBAGE, AUG7);
      assert.equal(out.rows.length, 0);
      assert.ok(
        out.skipped > 0,
        "an unusable non-empty file must be LOUD — silence looks like a holiday",
      );
    });

    it(`${name}: empty input -> 0 rows, 0 skips, no throw`, () => {
      const out = parse("", AUG7);
      assert.equal(out.rows.length, 0);
      assert.equal(out.skipped, 0);
    });

    it(`${name}: header-only / truncated file -> no rows, no throw`, () => {
      const out = parse("SYMBOL,SERIES,BAND\n", AUG7);
      assert.equal(out.rows.length, 0);
    });

    it(`${name}: never emits an Invalid Date or an empty value`, () => {
      for (const csv of [
        WK52_CSV,
        BAND_CHANGES_CSV,
        SEC_LIST_CSV,
        SECBAN_CSV,
        SERIES_CHANGE_CSV,
        SHORTSELL_CSV,
        SYNTHETIC_REG_IND,
      ]) {
        for (const r of parse(csv, AUG7).rows) {
          assert.ok(
            Number.isFinite(r.date.getTime()),
            `${name} emitted an Invalid Date`,
          );
          assert.ok(r.symbol.length > 0 && r.value.length > 0);
        }
      }
    });
  }
});

describe("append-only contract", () => {
  it("is pure — the same bytes parse identically twice", () => {
    const a = parseSecList(SEC_LIST_CSV, AUG7);
    const b = parseSecList(SEC_LIST_CSV, AUG7);
    assert.deepEqual(a, b);
  });

  it("re-emits an unchanged flag on the next day (no dedupe here or in the model)", () => {
    // A stock sitting in GSM Stage I for 40 sessions is 40 rows: the run length
    // IS the signal, and it is why StockFlag must carry NO unique on
    // (symbol,date,kind). Proven at the parser so the writer cannot "helpfully"
    // collapse it later without failing this.
    const d1 = parseSecList(SEC_LIST_CSV, AUG7);
    const d2 = parseSecList(SEC_LIST_CSV, AUG10);
    const surv = (o: StockFlagParseResult): StockFlagRow[] =>
      o.rows.filter((r) => r.kind === "SURVEILLANCE");
    assert.equal(surv(d1).length, 2);
    assert.equal(surv(d2).length, 2);
    assert.equal(surv(d1)[0]!.value, surv(d2)[0]!.value);
    assert.notEqual(day(surv(d1)[0]!), day(surv(d2)[0]!));
  });
});

describe("source ids", () => {
  it("every source resolves to a real report-registry family", () => {
    // `source` is the family id verbatim, so a stored row points back at the
    // exact archived family. A typo would silently orphan the provenance.
    for (const id of Object.values(STOCK_FLAG_SOURCES)) {
      assert.ok(familyById(id), `${id} is not a report-registry family id`);
    }
  });
});
