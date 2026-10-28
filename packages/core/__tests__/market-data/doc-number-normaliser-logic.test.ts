/**
 * MONEY-1314 — the normaliser, and the rule it must never grow.
 *
 * Every string below is VERBATIM from the extracted markdown of real filings
 * (ITC, AXISBANK, TCS, BHATIA, MUKTA annual reports and BSE quarterlies),
 * measured across 20,267 numeric cells in 1,307 tables.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseRupeeSign,
  repairBrokenDecimal,
  detectOrphanDigits,
  detectMergedColumns,
  assessTable,
  normaliseDocumentMarkdown,
} from "../../src/market-data/doc-number-normaliser-logic";

describe("MONEY-1314 D1 — the rupee sign arrives as an ASCII backtick", () => {
  it("repairs the real forms, verbatim from the corpus", () => {
    // 99.5% of ITC's rupee signs, 88.8% of AXISBANK's, 92.3% of TCS's. The
    // legacy `RupeeForadian` font maps U+20B9 onto U+0060 — but the MAJORITY
    // of corrupted occurrences come from ordinary runs (Lato, Helvetica), so
    // font detection alone is insufficient and the rule is contextual.
    const cases: [string, string][] = [
      ["(` in crores)", "(₹ in crores)"],
      [
        "`3,00,000 crores (Rupees three lakh crores)",
        "₹3,00,000 crores (Rupees three lakh crores)",
      ],
      ["EBITDA : ` 24, 025 cr", "EBITDA : ₹ 24, 025 cr"],
      ["`30 per equity share", "₹30 per equity share"],
      ["amount less than `50,000/-", "amount less than ₹50,000/-"],
      ["Amount (` per annum)", "Amount (₹ per annum)"],
      [
        "` 1,00,000/- for each meeting of the Board, ` 50,000/- for each meeting",
        "₹ 1,00,000/- for each meeting of the Board, ₹ 50,000/- for each meeting",
      ],
    ];
    for (const [input, want] of cases) {
      assert.equal(normaliseRupeeSign(input), want, `failed on: ${input}`);
    }
  });

  it("closes the spurious markdown code spans as a side effect", () => {
    // Backticks PAIR. Two rupee amounts in a sentence turn the prose between
    // them into an inline code span, which swallows any pipe characters — so
    // this must run BEFORE table parsing, not after.
    const before = "paid ` 5,000 to the Board and ` 3,000 to the Committee";
    const after = normaliseRupeeSign(before);
    assert.equal((after.match(/`/g) ?? []).length, 0);
    assert.ok(after.includes("₹ 5,000") && after.includes("₹ 3,000"));
  });

  it("[control] leaves a backtick that is NOT a rupee sign alone", () => {
    // Proves the rule is contextual rather than a blanket replace. Without
    // this, "delete every backtick" passes every assertion above.
    for (const s of [
      "use the `parseStatus` column",
      "run `yarn test` first",
      "``",
    ]) {
      assert.equal(normaliseRupeeSign(s), s, `wrongly rewrote: ${s}`);
    }
  });
});

describe("MONEY-1314 D3 — the rejoin rule, kept narrow on purpose", () => {
  it("repairs a number whose DECIMAL POINT was split", () => {
    const cases: [string, string][] = [
      ["37. 5 4", "37.54"],
      ["3 5 47. 28", "3547.28"],
      ["6 67. 27", "667.27"],
      ["17 7. 32", "177.32"],
      // Digit-PRESERVING: the leading zero is kept rather than dropped, and
      // the value is identical either way (Number("07516.") === 7516). The
      // guard that keeps it is the one that refuses any repair changing the
      // digit count, which is what stops a two-number cell being merged.
      ["07 5 16.", "07516."],
    ];
    for (const [input, want] of cases) {
      assert.equal(repairBrokenDecimal(input), want, `failed on: ${input}`);
    }
  });

  it("REFUSES a cell holding two complete numbers", () => {
    // THE case the narrowness exists for. A rule written on spaces alone
    // produces "21,88,211.3027,77,153.30" — wrong by a factor of a hundred
    // million, and still parsing as a number.
    const two = "21,88,211.30 27,77,153.30";
    assert.equal(repairBrokenDecimal(two), two);
  });

  it("a repaired leading zero is numerically identical", () => {
    assert.equal(Number(repairBrokenDecimal("07 5 16.")), 7516);
  });

  it("never invents or loses a digit", () => {
    for (const s of ["37. 5 4", "3 5 47. 28", "21,88,211.30 27,77,153.30"]) {
      const out = repairBrokenDecimal(s);
      assert.equal(
        (out.match(/\d/g) ?? []).length,
        (s.match(/\d/g) ?? []).length,
        `digit count changed on: ${s}`,
      );
    }
  });
});

describe("MONEY-1314 — the rule this module must NEVER contain", () => {
  it("does NOT collapse `digit, space, digit` — it is dates and page lists", () => {
    // The expected "11, 0 9 0" -> 11,090 shape is essentially ABSENT from the
    // real corpus (~15-20 cells, 0.1%). What a \d,\s\d rule actually matches:
    const mustSurvive = [
      "31, 2025", // "March 31, 2025"
      "27, 2025",
      "128, 129", // page-reference list in a contents table
      "130, 138, 141, 147",
      "96, 98",
      "12003, 21002, 46307", // ITC NIC product codes
      "+91 33 2288 9371", // phone number
      "+91 22 48867000",
    ];
    for (const s of mustSurvive) {
      assert.equal(
        repairBrokenDecimal(s),
        s,
        `a digit-collapse rule has been added and corrupted: ${s}`,
      );
      assert.equal(normaliseDocumentMarkdown(s).markdown, s);
    }
  });
});

describe("MONEY-1314 D4 — orphan digits: detect, never repair", () => {
  it("recognises both mirrored shapes, verbatim from BHATIA and TCS", () => {
    for (const s of [
      "9,391.26 0",
      "44,271.73 6",
      "8,327.921 5",
      "106.812 0",
      "386.331 6",
      "2 8,679.12",
      "2 6,797.36",
      "4 311.58",
    ]) {
      assert.equal(detectOrphanDigits(s), true, `missed orphan in: ${s}`);
    }
  });

  it("[control] a clean number is NOT flagged", () => {
    // This is the assertion that makes the detector meaningful — 0.17% of
    // cells match, so a detector returning true always would look identical on
    // the positive cases above.
    for (const s of ["196.82", "160.64", "12,680.65", "-1,880.20", "0", ""]) {
      assert.equal(detectOrphanDigits(s), false, `false positive on: ${s}`);
    }
  });

  it("ONE orphan fails the whole document over to vision", () => {
    // The cell that SHOWS the defect is not the cell damaged by it. `196.82`
    // and `160.64` in this very row are silently truncated and still parse as
    // valid numbers, so "a few is tolerable" is not available as a policy.
    const md = [
      "|Particulars|Q1|Q2|Q3|Q4|",
      "|---|---|---|---|---|",
      "|Revenue from Operations|12,680.65 10,377.010|9,391.26 0|44,271.73 6|9 41,379.386|",
      "|Other Income|52.977 72.154|41.424|196.82|160.64|",
    ].join("\n");
    const r = normaliseDocumentMarkdown(md);
    assert.equal(r.failOverToVision, true);
    assert.ok(r.findings.orphanDigitCells > 0);
    assert.match(r.reason ?? "", /migrated across a column boundary/);
  });

  it("[control] a clean table does NOT fail over", () => {
    const md = [
      "|Particulars|Q1|Q2|",
      "|---|---|---|",
      "|Revenue from Operations|12,680.65|10,377.01|",
      "|Other Income|52.977|72.154|",
    ].join("\n");
    const r = normaliseDocumentMarkdown(md);
    assert.equal(r.failOverToVision, false);
    assert.equal(r.reason, null);
    assert.equal(r.findings.orphanDigitCells, 0);
  });
});

describe("MONEY-1314 D2 — merged columns are reported, not split", () => {
  it("recognises the real merged cells", () => {
    for (const s of [
      "2183.04 7.22 158.23 60.57 70.07 4.26 295.20 595.55 1587.49 10.51 1576.98",
      "5,23,810 76,719 36,796 30,056 4,276 1,303 1,10,405 2,64,255 0.00000021 0.82",
      "127 1,256,589 1,369,593 1,236,293 133,300 1,41,189 121,699 19,490 55,341 51,332 2,875,648",
    ]) {
      assert.equal(detectMergedColumns(s), true, `missed merge in: ${s}`);
    }
  });

  it("[control] one or two numbers is not a merge", () => {
    // Two numbers in a cell is D4's territory or a legitimate range; three is
    // the threshold. Splitting these would need the column assignment the
    // extractor lost, which is why nothing here repairs them.
    for (const s of [
      "12,680.65",
      "9,391.26 0",
      "1,000 2,000",
      "Revenue from Operations",
    ]) {
      assert.equal(detectMergedColumns(s), false, `false positive on: ${s}`);
    }
  });
});

describe("MONEY-1314 D5 — ragged tables are counted, never a gate", () => {
  it("counts rows that disagree with the header width", () => {
    const md = [
      "|A|B|C|",
      "|---|---|---|",
      "|1|2|3|",
      "|1|2|", // ragged
    ].join("\n");
    const f = assessTable(md);
    assert.equal(f.raggedRows, 1);
  });

  it("raggedness alone does NOT fail a document over", () => {
    // 67.6% of emitted tables are ragged. Treating it as disqualifying would
    // reject two thirds of the corpus — it is a confidence signal and an
    // operator-facing count, not a gate.
    const md = ["|A|B|C|", "|---|---|---|", "|1|2|"].join("\n");
    const r = normaliseDocumentMarkdown(md);
    assert.ok(r.findings.raggedRows > 0);
    assert.equal(r.failOverToVision, false);
  });

  it("the `|---|` separator row is structure, not a ragged data row", () => {
    const md = ["|A|B|", "|:---|---:|", "|1|2|"].join("\n");
    assert.equal(assessTable(md).raggedRows, 0);
  });
});
