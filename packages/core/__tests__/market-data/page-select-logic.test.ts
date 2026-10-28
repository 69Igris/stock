/**
 * Page selection for the doc-ingest lane — MONEY-1314.
 *
 * Every symbol under test is the REAL export
 * (`packages/core/src/market-data/page-select-logic.ts`). No shadow copies and
 * no re-implementation of the scorer in the fixtures: a mutation to the source
 * has to show up here.
 *
 * The suite is organised around what can go WRONG, because that is what the
 * module is shaped around:
 *
 *   - the strongest signal (a Schedule III heading) firing on a table of
 *     contents, a section divider or a sentence — the three places those exact
 *     words appear WITHOUT a statement under them;
 *   - a detector that only ever says yes (tagged `[control]` below — this repo
 *     has shipped those);
 *   - a narrative page outranking a statement page, and the opposite error of
 *     BANNING narrative pages, which loses the only table in a results filing;
 *   - a selection whose page order, or whose set, depends on something other
 *     than the score — input order, sort stability, a float tie;
 *   - `droppedForBudget` reporting a number an operator cannot act on.
 *
 * The main fixture is a 40-page annual report with the real section structure.
 * It is built from parts rather than pasted so the SHAPE is explicit — which
 * pages are narrative, which are statements, which are continuations — and the
 * assertions can be stated over those sets rather than over page numbers a
 * reader has to trust.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTINUATION_BONUS,
  CONTINUATION_MAX_RUN,
  DEFAULT_MAX_CHARS,
  DENSITY_POINTS_MAX,
  HEADING_UNCORROBORATED_POINTS,
  NARRATIVE_PENALTY,
  compareCandidates,
  findNarrativeSection,
  findStatementHeading,
  isContinuationCandidate,
  isContinuationSeed,
  isNumericCell,
  isSeparatorRow,
  matchNarrativeSection,
  matchStatementHeading,
  HEADING_CORROBORATION_MIN_NUMERIC_CELLS,
  measureTables,
  scorePages,
  selectPagesForExtraction,
  statementEvidence,
  splitTableRow,
  stripHeadingDecoration,
  type DocPage,
  type PageScore,
} from "../../src/market-data/page-select-logic";

// ══════════════════════════════════════════════════════════════════════
// FIXTURE — a 40-page Indian annual report
// ══════════════════════════════════════════════════════════════════════

const PROSE_LINES = [
  "The Board of your Company continues to focus on long-term value creation for all stakeholders across the markets in which it operates.",
  "During the year under review the Company strengthened its distribution footprint, deepened customer relationships and invested in capability building.",
  "Your Directors remain committed to the highest standards of governance, transparency and disclosure in all dealings with shareholders and regulators.",
  "The macroeconomic environment remained constructive through the year, with domestic demand resilient and input cost pressures easing in the second half.",
];

/** Narrative body text. Paragraph breaks every third line, as a converter emits. */
function prose(lines: number, seed = 0): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(PROSE_LINES[(i + seed) % PROSE_LINES.length]);
    if (i % 3 === 2) out.push("");
  }
  return out.join("\n");
}

const STATEMENT_ROW_LABELS = [
  "Property, plant and equipment",
  "Capital work-in-progress",
  "Investment property",
  "Goodwill",
  "Other intangible assets",
  "Investments",
  "Trade receivables",
  "Cash and cash equivalents",
  "Other bank balances",
  "Loans",
  "Other financial assets",
  "Inventories",
  "Current tax assets (net)",
  "Other current assets",
  "Equity share capital",
  "Other equity",
  "Borrowings",
  "Lease liabilities",
  "Trade payables",
  "Other financial liabilities",
  "Provisions",
  "Deferred tax liabilities (net)",
  "Other current liabilities",
];

/** A Schedule III style two-period table: label, note reference, two figures. */
function statementTable(rows: number, seed = 0): string {
  const out = [
    "| Particulars | Note | 31 March 2025 | 31 March 2024 |",
    "| --- | --- | ---: | ---: |",
  ];
  for (let i = 0; i < rows; i += 1) {
    const label =
      STATEMENT_ROW_LABELS[(i + seed) % STATEMENT_ROW_LABELS.length];
    const current = (1000 + i * 137 + seed * 11) * 3;
    const prior = (900 + i * 129 + seed * 7) * 3;
    out.push(
      `| ${label} | ${(i % 30) + 3} | ${current.toLocaleString("en-IN")} | ${prior.toLocaleString("en-IN")} |`,
    );
  }
  return out.join("\n");
}

function page(pageNumber: number, markdown: string): DocPage {
  return { pageNumber, markdown };
}

/** A statement's FIRST page: heading, scale note, table. */
function statementPage(n: number, heading: string, rows: number): DocPage {
  return page(
    n,
    `## ${heading}\n\n(₹ in crore)\n\n${statementTable(rows, n)}\n\nThe accompanying notes form an integral part of these financial statements.`,
  );
}

/** A statement's continuation page: the table alone, no heading at all. */
function continuationPage(n: number, rows: number): DocPage {
  return page(n, statementTable(rows, n));
}

function narrativePage(n: number, heading: string, lines: number): DocPage {
  return page(n, `## ${heading}\n\n${prose(lines, n)}`);
}

/** A notes page: schedule table plus explanatory prose, which is how they read. */
function notesPage(n: number, heading: string | null, rows: number): DocPage {
  const head = heading === null ? "" : `## ${heading}\n\n`;
  return page(
    n,
    `${head}### Note ${n - 27}: Property, plant and equipment\n\n${statementTable(rows, n)}\n\n${prose(4, n)}`,
  );
}

/** Pages 21-36. The statements and their continuations — what we came for. */
const STATEMENT_PAGES = new Set([
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
]);

/** Continuation pages: dense, and carrying NO heading of their own. */
const CONTINUATION_PAGES = new Set([22, 24, 26, 29, 30, 31, 32]);

function buildAnnualReport(): DocPage[] {
  return [
    page(1, "# ACME INDUSTRIES LIMITED\n\nAnnual Report 2024-25"),
    // Contents, with dot leaders — every statement title in the document
    // appears here, under no statement whatsoever.
    page(
      2,
      [
        "## Contents",
        "",
        "Corporate Overview ............................... 3",
        "Directors' Report ................................ 12",
        "Management Discussion and Analysis ............... 24",
        "Corporate Governance ............................. 33",
        "Independent Auditor's Report ..................... 41",
        "Balance Sheet .................................... 52",
        "Statement of Profit and Loss ..................... 54",
        "Cash Flow Statement .............................. 56",
        "Notes to the Financial Statements ................ 60",
        "Notice of Annual General Meeting ................. 96",
      ].join("\n"),
    ),
    narrativePage(3, "Directors' Report", 14),
    // The Directors' Report's own "Financial Results" summary table. A real
    // Schedule III heading on an unmistakably narrative page.
    page(
      4,
      [
        "Directors' Report (Contd.)",
        "",
        "### Financial Results",
        "",
        "| Particulars | 2024-25 | 2023-24 |",
        "| --- | ---: | ---: |",
        "| Revenue from operations | 27,234 | 24,880 |",
        "| Profit before tax | 4,120 | 3,540 |",
        "| Profit after tax | 3,090 | 2,655 |",
        "",
        prose(8, 4),
      ].join("\n"),
    ),
    narrativePage(5, "Directors' Report (Contd.)", 14),
    narrativePage(6, "Directors' Report (Contd.)", 14),
    narrativePage(7, "Management Discussion and Analysis", 14),
    narrativePage(8, "Management Discussion and Analysis (Contd.)", 14),
    narrativePage(9, "Management Discussion and Analysis (Contd.)", 14),
    narrativePage(10, "Corporate Governance Report", 14),
    narrativePage(11, "Corporate Governance Report (Contd.)", 14),
    narrativePage(12, "Corporate Governance Report (Contd.)", 14),
    narrativePage(13, "Business Responsibility and Sustainability Report", 14),
    // The BRSR's emissions table — dense numbers, zero financial content.
    page(
      14,
      [
        "Business Responsibility and Sustainability Report (Contd.)",
        "",
        "### Principle 6 — Environment",
        "",
        statementTable(14, 14),
      ].join("\n"),
    ),
    narrativePage(
      15,
      "Business Responsibility and Sustainability Report (Contd.)",
      14,
    ),
    narrativePage(16, "Independent Auditor's Report", 16),
    narrativePage(17, "Independent Auditor's Report (Contd.)", 16),
    // Key Audit Matters, tabulated. The auditor's report DOES carry tables.
    page(
      18,
      [
        "Independent Auditor's Report (Contd.)",
        "",
        "### Key Audit Matters",
        "",
        statementTable(6, 18),
        "",
        prose(6, 18),
      ].join("\n"),
    ),
    narrativePage(19, "Annexure A to the Independent Auditor's Report", 16),
    // The section divider: all heading, no table.
    page(20, "# FINANCIAL STATEMENTS"),
    statementPage(21, "Consolidated Balance Sheet as at 31 March 2025", 22),
    continuationPage(22, 20),
    statementPage(
      23,
      "Consolidated Statement of Profit and Loss for the year ended 31 March 2025",
      22,
    ),
    continuationPage(24, 18),
    statementPage(
      25,
      "Consolidated Cash Flow Statement for the year ended 31 March 2025",
      22,
    ),
    continuationPage(26, 18),
    statementPage(27, "Consolidated Statement of Changes in Equity", 16),
    notesPage(28, "Notes to the Consolidated Financial Statements", 18),
    notesPage(29, null, 18),
    notesPage(30, null, 18),
    notesPage(31, null, 18),
    notesPage(32, null, 18),
    statementPage(33, "Standalone Balance Sheet as at 31 March 2025", 22),
    statementPage(
      34,
      "Standalone Statement of Profit and Loss for the year ended 31 March 2025",
      22,
    ),
    statementPage(
      35,
      "Standalone Cash Flow Statement for the year ended 31 March 2025",
      22,
    ),
    notesPage(36, "Notes to the Standalone Financial Statements", 18),
    narrativePage(37, "Business Responsibility and Sustainability Report", 14),
    narrativePage(38, "Corporate Governance Report", 14),
    narrativePage(39, "Notice of the 31st Annual General Meeting", 16),
    narrativePage(40, "Notice of the 31st Annual General Meeting (Contd.)", 16),
  ];
}

const REPORT = buildAnnualReport();
const REPORT_CHARS = REPORT.reduce((n, p) => n + p.markdown.length, 0);

function scoreOf(scores: PageScore[], pageNumber: number): PageScore {
  const hit = scores.find((s) => s.pageNumber === pageNumber);
  assert.ok(hit, `no score for page ${pageNumber}`);
  return hit;
}

// ══════════════════════════════════════════════════════════════════════
// The fixture itself has to be worth trusting
// ══════════════════════════════════════════════════════════════════════

describe("the annual-report fixture", () => {
  it("is 40 pages and comfortably exceeds the default cap", () => {
    assert.equal(REPORT.length, 40);
    assert.ok(
      REPORT_CHARS > DEFAULT_MAX_CHARS,
      `fixture is ${REPORT_CHARS} chars — it must exceed ${DEFAULT_MAX_CHARS} or every selection test degenerates to "all-fit"`,
    );
  });

  it("has page numbers 1..40 with no gaps", () => {
    assert.deepEqual(
      REPORT.map((p) => p.pageNumber),
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Schedule III headings
// ══════════════════════════════════════════════════════════════════════

describe("matchStatementHeading", () => {
  it("matches the Schedule III titles with their real qualifiers and date clauses", () => {
    const cases: Array<[string, string]> = [
      ["Balance Sheet", "balance-sheet"],
      ["## Consolidated Balance Sheet as at 31 March 2025", "balance-sheet"],
      ["**STANDALONE BALANCE SHEET AS AT 31ST MARCH, 2025**", "balance-sheet"],
      ["Balance Sheet (₹ in crore)", "balance-sheet"],
      [
        "Statement of Profit and Loss for the year ended 31 March 2025",
        "profit-and-loss",
      ],
      ["Consolidated Statement of Profit & Loss", "profit-and-loss"],
      ["Statement of Profit or Loss", "profit-and-loss"],
      ["Profit and Loss Account", "profit-and-loss"],
      [
        "Statement of Profit and Loss and Other Comprehensive Income",
        "profit-and-loss",
      ],
      ["Cash Flow Statement", "cash-flow"],
      ["Statement of Cash Flows", "cash-flow"],
      ["Consolidated Statement of Changes in Equity", "changes-in-equity"],
      ["Notes to the Financial Statements", "notes"],
      ["Notes to the Consolidated Financial Statements", "notes"],
      [
        "Notes forming part of the financial statements for the year ended 31 March 2025",
        "notes",
      ],
      ["Financial Results", "financial-results"],
      ["Unaudited Financial Results", "financial-results"],
      ["Audited Financial Results", "financial-results"],
      [
        "Statement of Consolidated Unaudited Financial Results",
        "financial-results",
      ],
      ["Statement of Assets and Liabilities", "assets-and-liabilities"],
    ];
    for (const [line, expected] of cases) {
      assert.equal(matchStatementHeading(line), expected, `line: ${line}`);
    }
  });

  it("[control] returns null for prose, for narrative headings, and for a blank line", () => {
    // A detector that cannot say "no" is not a detector. Each of these is a
    // line that WILL appear in a real filing.
    const negatives = [
      "",
      "   ",
      "Our people are our greatest asset",
      "Independent Auditor's Report",
      "Notice of the 31st Annual General Meeting",
      "Corporate Governance Report",
      "# ACME INDUSTRIES LIMITED",
      "The accompanying notes form an integral part of these financial statements.",
    ];
    for (const line of negatives) {
      assert.equal(matchStatementHeading(line), null, `line: ${line}`);
    }
  });

  it("[control] returns null for a contents entry, whose dot leader is the tell", () => {
    // The single most dangerous false positive: a contents page names EVERY
    // statement in the document, so a matcher that accepts these ranks page 2
    // of a 300-page report above the balance sheet.
    assert.equal(
      matchStatementHeading(
        "Balance Sheet .................................... 52",
      ),
      null,
    );
    assert.equal(
      matchStatementHeading("Notes to the Financial Statements ....... 60"),
      null,
    );
    // The bare title still matches — it is the LEADER that disqualifies, not
    // the brevity, so this is not an accident of length.
    assert.equal(matchStatementHeading("Balance Sheet"), "balance-sheet");
  });

  it("[control] returns null for a sentence that merely contains the title", () => {
    assert.equal(
      matchStatementHeading(
        "The Balance Sheet as at 31 March 2025 has been prepared on a going concern basis and reflects total assets of ₹19,768 crore, an increase over the prior year driven by capital expenditure.",
      ),
      null,
    );
  });

  it("[control] returns null for a title inside a table cell", () => {
    // A contents page rendered as a markdown table would otherwise match every
    // statement heading at once.
    assert.equal(matchStatementHeading("| Balance Sheet | 52 |"), null);
    assert.equal(
      matchStatementHeading("| Statement of Profit and Loss | 54 |"),
      null,
    );
  });

  it("findStatementHeading reports the first heading on a page, or null", () => {
    assert.equal(findStatementHeading(REPORT[20].markdown), "balance-sheet");
    // The divider page carries no Schedule III title at all.
    assert.equal(findStatementHeading(REPORT[19].markdown), null);
    // A continuation page has no heading — this is why density is a term.
    assert.equal(findStatementHeading(REPORT[21].markdown), null);
  });
});

describe("stripHeadingDecoration", () => {
  it("removes markdown decoration but not dot leaders, pipes or bullets", () => {
    assert.equal(stripHeadingDecoration("## Balance Sheet"), "Balance Sheet");
    assert.equal(stripHeadingDecoration("**Balance Sheet**"), "Balance Sheet");
    assert.equal(stripHeadingDecoration("> Balance Sheet:"), "Balance Sheet");
    assert.equal(stripHeadingDecoration("Balance Sheet *"), "Balance Sheet");
    // Preserved, because each is the evidence that this is NOT a heading.
    assert.equal(
      stripHeadingDecoration("Balance Sheet ..... 52"),
      "Balance Sheet ..... 52",
    );
    assert.equal(stripHeadingDecoration("- Balance Sheet"), "- Balance Sheet");
    assert.equal(
      stripHeadingDecoration("| Balance Sheet |"),
      "| Balance Sheet |",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Narrative sections
// ══════════════════════════════════════════════════════════════════════

describe("matchNarrativeSection", () => {
  it("matches every listed narrative section, in the spellings filings use", () => {
    const cases: Array<[string, string]> = [
      ["Independent Auditor's Report", "auditors-report"],
      ["INDEPENDENT AUDITORS' REPORT", "auditors-report"],
      ["Independent Auditors Report (Contd.)", "auditors-report"],
      ["Notice of the 31st Annual General Meeting", "agm-notice"],
      ["NOTICE OF ANNUAL GENERAL MEETING", "agm-notice"],
      ["Directors' Report", "directors-report"],
      ["Director's Report to the Members", "directors-report"],
      ["Board's Report", "directors-report"],
      ["Report of the Board of Directors", "directors-report"],
      ["Corporate Governance Report", "corporate-governance"],
      ["Report on Corporate Governance", "corporate-governance"],
      ["Management Discussion and Analysis", "management-discussion"],
      ["Management Discussion & Analysis", "management-discussion"],
      [
        "Business Responsibility and Sustainability Report",
        "business-responsibility",
      ],
    ];
    for (const [line, expected] of cases) {
      assert.equal(matchNarrativeSection(line), expected, `line: ${line}`);
    }
  });

  it("[control] returns null for statement headings and for statement prose", () => {
    const negatives = [
      "Consolidated Balance Sheet as at 31 March 2025",
      "Notes to the Financial Statements",
      "Statement of Cash Flows",
      "| Provisions | 12 | 4,120 | 3,540 |",
      "",
    ];
    for (const line of negatives) {
      assert.equal(matchNarrativeSection(line), null, `line: ${line}`);
    }
  });

  it("[control] does not demote a notes page for CITING the auditor's report", () => {
    // Anchoring at the start of a line is what buys this. A substring search
    // over the page text would demote a genuine notes page for one sentence.
    const notes = [
      "## Notes to the Consolidated Financial Statements",
      "",
      "The matter described in the Emphasis of Matter paragraph of the Independent Auditor's Report has been settled during the year.",
    ].join("\n");
    assert.equal(findNarrativeSection(notes), null);
    assert.equal(findStatementHeading(notes), "notes");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Table density and numeric cells
// ══════════════════════════════════════════════════════════════════════

describe("isNumericCell", () => {
  it("accepts figures, including the conversion damage the converter emits", () => {
    const positives = [
      "27,234",
      "4,935",
      "(1,234)",
      "-1,234",
      "12.5%",
      "0",
      "11, 0 9 0", // digit groups split by the PDF text layer
      "`4,935", // rupee glyph rendered as a backtick
      "₹ 27,234",
      "Rs. 27,234",
      "4,935*", // footnote marker glued on
    ];
    for (const cell of positives) {
      assert.equal(isNumericCell(cell), true, `cell: ${cell}`);
    }
  });

  it("[control] rejects labels, dates, note references and em-dashes", () => {
    // Every one of these sits in a real statement table. If any were accepted,
    // numeric weight would just be re-counting rows.
    const negatives = [
      "",
      "Revenue from operations",
      "Particulars",
      "31 March 2025",
      "Note 3",
      "—",
      "-",
      "N/A",
      "FY2025",
      "2 crore shares", // a number followed by words is not a figure
    ];
    for (const cell of negatives) {
      assert.equal(isNumericCell(cell), false, `cell: ${cell}`);
    }
  });
});

describe("splitTableRow / isSeparatorRow", () => {
  it("splits a row into trimmed cells with the outer empties dropped", () => {
    assert.deepEqual(splitTableRow("| Provisions | 12 | 4,120 | 3,540 |"), [
      "Provisions",
      "12",
      "4,120",
      "3,540",
    ]);
  });

  it("[control] separator rows are recognised, data rows are not", () => {
    assert.equal(isSeparatorRow("| --- | --- | ---: |"), true);
    assert.equal(isSeparatorRow("| :---: | ---: |"), true);
    assert.equal(isSeparatorRow("| Provisions | 12 | 4,120 |"), false);
  });
});

describe("measureTables", () => {
  it("measures a statement page as almost entirely table", () => {
    const measure = measureTables(REPORT[20].markdown);
    assert.ok(
      measure.tableRatio > 0.8,
      `statement page ratio was ${measure.tableRatio}`,
    );
    assert.ok(
      measure.numericCells > 40,
      `statement page cells were ${measure.numericCells}`,
    );
  });

  it("[control] measures a prose page as zero table, zero numbers", () => {
    const measure = measureTables(REPORT[6].markdown);
    assert.equal(measure.tableLines, 0);
    assert.equal(measure.tableRatio, 0);
    assert.equal(measure.numericCells, 0);
    assert.ok(measure.nonBlankLines > 0);
  });

  it("[control] a blank page measures 0 and does not divide by zero", () => {
    const measure = measureTables("\n\n   \n");
    assert.equal(measure.nonBlankLines, 0);
    assert.equal(measure.tableRatio, 0);
    assert.ok(Number.isFinite(measure.tableRatio));
  });
});

// ══════════════════════════════════════════════════════════════════════
// Scoring the report
// ══════════════════════════════════════════════════════════════════════

describe("scorePages over the annual report", () => {
  const scores = scorePages(REPORT);

  it("ranks EVERY statement page above EVERY narrative page", () => {
    // The central claim of the module, asserted as a separation rather than as
    // a selection, so it is independent of whatever budget a caller passes.
    const statements = scores.filter((s) => STATEMENT_PAGES.has(s.pageNumber));
    const narrative = scores.filter((s) => !STATEMENT_PAGES.has(s.pageNumber));
    assert.equal(statements.length, 16);
    assert.equal(narrative.length, 24);

    const worstStatement = Math.min(...statements.map((s) => s.score));
    const bestNarrative = Math.max(...narrative.map((s) => s.score));
    assert.ok(
      worstStatement > bestNarrative,
      `worst statement page scored ${worstStatement}, best narrative page scored ${bestNarrative}`,
    );
  });

  it("scores continuation pages on density alone — they carry no heading", () => {
    for (const pageNumber of CONTINUATION_PAGES) {
      const score = scoreOf(scores, pageNumber);
      assert.equal(
        score.headingMatched,
        null,
        `page ${pageNumber} should have no heading`,
      );
      assert.ok(
        score.score > 0,
        `page ${pageNumber} scored ${score.score} — a headingless statement page must still be wanted`,
      );
    }
  });

  it("does not let a section divider outrank a real statement page", () => {
    // Page 20 is "# FINANCIAL STATEMENTS" and nothing else.
    const divider = scoreOf(scores, 20);
    const balanceSheet = scoreOf(scores, 21);
    assert.ok(divider.score < balanceSheet.score);
    assert.ok(divider.score < scoreOf(scores, 22).score, "even a continuation");
  });

  it("does not let the contents page outrank anything, despite naming every statement", () => {
    const contents = scoreOf(scores, 2);
    assert.equal(contents.headingMatched, null);
    assert.ok(contents.score <= 0);
  });

  it("demotes the Directors' Report's own Financial Results table without banning it", () => {
    const directorsResults = scoreOf(scores, 4);
    // It IS a real Schedule III heading and it IS corroborated by numbers...
    assert.equal(directorsResults.headingMatched, "financial-results");
    assert.equal(directorsResults.headingCorroborated, true);
    assert.equal(directorsResults.narrativeMatched, "directors-report");
    // ...so it stays selectable — for a results filing this table can be the
    // only statement in the document...
    assert.ok(
      directorsResults.score > 0,
      "a narrative page carrying a real statement table must not be banned",
    );
    // ...and it still loses to every real statement page.
    assert.ok(directorsResults.score < scoreOf(scores, 21).score);
    assert.equal(
      directorsResults.score,
      directorsResults.baseScore,
      "a narrative page must not receive a continuation bonus",
    );
  });

  it("demotes a dense table inside the auditor's report below zero", () => {
    // Key Audit Matters is a real table of real numbers about the company. It
    // is still not a financial statement.
    const keyAuditMatters = scoreOf(scores, 18);
    assert.equal(keyAuditMatters.narrativeMatched, "auditors-report");
    assert.ok(keyAuditMatters.numericCells > 10);
    assert.ok(
      keyAuditMatters.score < 0,
      `Key Audit Matters scored ${keyAuditMatters.score}`,
    );
  });

  it("awards the continuation bonus to the pages after a statement heading", () => {
    // 21 is the balance sheet's heading page (a seed, so no bonus of its own);
    // 22 is its table continuing onto the next page.
    assert.equal(scoreOf(scores, 21).continuationBonus, 0);
    assert.equal(scoreOf(scores, 22).continuationBonus, CONTINUATION_BONUS);
    assert.equal(
      scoreOf(scores, 22).score,
      scoreOf(scores, 22).baseScore + CONTINUATION_BONUS,
    );
  });

  it("bounds the continuation run — the notes do not drag in the whole document", () => {
    // Page 28 is the notes heading. 29, 30, 31 are its run (CONTINUATION_MAX_RUN
    // = 3); page 32 is just as dense and gets NOTHING, because a page pulled in
    // by a run is never itself a seed.
    assert.equal(CONTINUATION_MAX_RUN, 3);
    for (const pageNumber of [29, 30, 31]) {
      assert.equal(
        scoreOf(scores, pageNumber).continuationBonus,
        CONTINUATION_BONUS,
        `page ${pageNumber}`,
      );
    }
    assert.equal(scoreOf(scores, 32).continuationBonus, 0);
    assert.ok(
      scoreOf(scores, 32).score > 0,
      "page 32 must still stand on its own density",
    );
  });

  it("does not continue a statement into a narrative section, however dense", () => {
    // Statements END. A page that announces a new narrative section is not the
    // continuation of the one before it, and adjacency must not be able to
    // rescue a page the penalty just demoted.
    const seed = statementPage(
      1,
      "Consolidated Balance Sheet as at 31 March 2025",
      20,
    );
    const governance = page(
      2,
      ["Corporate Governance Report", "", statementTable(20, 2)].join("\n"),
    );
    const mini = scorePages([seed, governance]);
    assert.ok(isContinuationSeed(scoreOf(mini, 1)), "page 1 must be a seed");
    // [control] on density alone this page WOULD qualify — so the assertion
    // below is the narrative check doing the work, not the density floor.
    assert.equal(isContinuationCandidate(scoreOf(mini, 2)), true);
    assert.equal(scoreOf(mini, 2).narrativeMatched, "corporate-governance");
    assert.equal(scoreOf(mini, 2).continuationBonus, 0);
  });

  it("only continues onto the IMMEDIATELY following page number", () => {
    // A caller may hand over a subset with gaps in it. "The next array entry"
    // is not "the next page".
    const seed = statementPage(
      1,
      "Consolidated Balance Sheet as at 31 March 2025",
      20,
    );
    const faraway = continuationPage(5, 20);
    const mini = scorePages([seed, faraway]);
    assert.ok(isContinuationSeed(scoreOf(mini, 1)));
    // [control] again: it clears the density floor and is still not adjacent.
    assert.equal(isContinuationCandidate(scoreOf(mini, 5)), true);
    assert.equal(scoreOf(mini, 5).continuationBonus, 0);

    // The same page at number 2 DOES receive it, which is what makes the
    // assertion above about adjacency rather than about the page.
    const adjacent = scorePages([seed, continuationPage(2, 20)]);
    assert.equal(scoreOf(adjacent, 2).continuationBonus, CONTINUATION_BONUS);
  });

  it("stops a continuation run at the first page that is not table-dense", () => {
    // The bound is not only CONTINUATION_MAX_RUN. A run also ENDS the moment
    // the tables do — otherwise "the three pages after a balance sheet" would
    // drag in prose that merely happens to sit within three pages of one.
    const seed = statementPage(
      1,
      "Consolidated Balance Sheet as at 31 March 2025",
      20,
    );
    const interlude = page(2, prose(12, 2));
    const denseAgain = continuationPage(3, 20);
    const mini = scorePages([seed, interlude, denseAgain]);

    // [control] page 2 is not demoted by a narrative marker — it is refused on
    // density alone, which is the term under test.
    assert.equal(scoreOf(mini, 2).narrativeMatched, null);
    assert.equal(isContinuationCandidate(scoreOf(mini, 2)), false);
    assert.equal(scoreOf(mini, 2).continuationBonus, 0);

    // ...and the run is BROKEN, not merely skipped: page 3 is table-dense and
    // within CONTINUATION_MAX_RUN of the seed, and still gets nothing.
    assert.equal(isContinuationCandidate(scoreOf(mini, 3)), true);
    assert.equal(scoreOf(mini, 3).continuationBonus, 0);
  });

  it("every score is an integer, so two scores compare exactly", () => {
    for (const score of scores) {
      assert.ok(
        Number.isInteger(score.score),
        `page ${score.pageNumber} scored ${score.score}`,
      );
      assert.ok(Number.isInteger(score.baseScore));
    }
  });
});

describe("the scoring terms, isolated", () => {
  it("a heading page outranks its own continuation page", () => {
    // Same table, same numbers; the only difference is the heading.
    const withHeading = statementPage(1, "Consolidated Balance Sheet", 20);
    const withoutHeading = continuationPage(2, 20);
    const [first, second] = scorePages([withHeading, withoutHeading]);
    assert.equal(first.headingMatched, "balance-sheet");
    assert.equal(second.headingMatched, null);
    assert.ok(
      first.score > second.score,
      `heading page ${first.score} vs continuation ${second.score}`,
    );
  });

  it("density separates two pages carrying the SAME count of numbers", () => {
    // Identical numeric weight, opposite shapes. Without a density term these
    // two score the same and a page of prose ranks with a statement.
    const dense = page(1, statementTable(10));
    const sparse = page(2, [statementTable(10), "", prose(40, 1)].join("\n"));
    const [denseScore, sparseScore] = scorePages([dense, sparse]);
    assert.equal(
      denseScore.numericCells,
      sparseScore.numericCells,
      "fixture must hold numeric weight constant for this to isolate density",
    );
    assert.ok(
      denseScore.tableRatio > sparseScore.tableRatio,
      "fixture must actually differ in density",
    );
    assert.ok(
      denseScore.score > sparseScore.score,
      `dense ${denseScore.score} vs sparse ${sparseScore.score}`,
    );
  });

  it("an uncorroborated heading scores far below a corroborated one", () => {
    const divider = page(1, "# Consolidated Balance Sheet");
    const real = statementPage(2, "Consolidated Balance Sheet", 20);
    const [dividerScore, realScore] = scorePages([divider, real]);
    assert.equal(dividerScore.headingMatched, "balance-sheet");
    assert.equal(dividerScore.headingCorroborated, false);
    assert.equal(dividerScore.score, HEADING_UNCORROBORATED_POINTS);
    assert.equal(realScore.headingCorroborated, true);
    assert.ok(realScore.score > dividerScore.score);
    // The relationship the constant exists to preserve: ANY genuinely dense
    // page beats ANY heading-only page, even one with no heading at all.
    assert.ok(HEADING_UNCORROBORATED_POINTS < DENSITY_POINTS_MAX);
    const headless = continuationPage(3, 20);
    const [headlessScore] = scorePages([headless]);
    assert.ok(headlessScore.score > dividerScore.score);
  });

  it("the narrative penalty is applied ONCE, however many markers appear", () => {
    // Each page is paired with a NEUTRAL twin of identical line structure —
    // headings that match neither vocabulary — so the density and numeric
    // terms cancel and the whole difference is the penalty. Comparing against
    // a bare table instead would fold a density change into the delta and
    // "prove" a penalty of 75.
    const table = statementTable(10);
    const oneMarker = ["Directors' Report", "", table];
    const oneNeutral = ["Product Performance", "", table];
    const threeMarkers = [
      "Directors' Report",
      "",
      "Corporate Governance Report",
      "",
      "Management Discussion and Analysis",
      "",
      table,
    ];
    const threeNeutral = [
      "Product Performance",
      "",
      "Customer Experience Initiatives",
      "",
      "Talent and Culture Highlights",
      "",
      table,
    ];

    const [one, oneControl, three, threeControl] = scorePages([
      page(1, oneMarker.join("\n")),
      page(2, oneNeutral.join("\n")),
      page(3, threeMarkers.join("\n")),
      page(4, threeNeutral.join("\n")),
    ]);

    // [control] the neutral twins really are neutral — otherwise both sides of
    // each subtraction carry a penalty and the test proves nothing.
    assert.equal(oneControl.narrativeMatched, null);
    assert.equal(threeControl.narrativeMatched, null);
    assert.equal(one.narrativeMatched, "directors-report");
    assert.equal(three.narrativeMatched, "directors-report");

    assert.equal(oneControl.baseScore - one.baseScore, NARRATIVE_PENALTY);
    assert.equal(
      threeControl.baseScore - three.baseScore,
      NARRATIVE_PENALTY,
      "three markers on one page must cost one penalty, not three",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// compareCandidates — the total order
// ══════════════════════════════════════════════════════════════════════

describe("compareCandidates", () => {
  function stub(overrides: Partial<PageScore>): PageScore {
    return {
      pageNumber: 1,
      order: 0,
      chars: 100,
      score: 100,
      baseScore: 100,
      headingMatched: null,
      headingCorroborated: false,
      tableRatio: 0,
      numericCells: 0,
      narrativeMatched: null,
      continuationBonus: 0,
      ...overrides,
    };
  }

  it("orders by score descending", () => {
    const high = stub({ score: 200, pageNumber: 9, order: 1 });
    const low = stub({ score: 100, pageNumber: 4, order: 0 });
    assert.ok(compareCandidates(high, low) < 0);
    assert.ok(compareCandidates(low, high) > 0);
  });

  it("breaks a score tie by pageNumber ascending", () => {
    const later = stub({ score: 100, pageNumber: 9, order: 1 });
    const earlier = stub({ score: 100, pageNumber: 4, order: 0 });
    assert.ok(
      compareCandidates(later, earlier) > 0,
      "page 9 must sort after page 4 at equal score",
    );
    assert.ok(compareCandidates(earlier, later) < 0);
  });

  it("[control] never returns 0 for two distinct pages, even at the same pageNumber", () => {
    // Sort stability makes an incomplete comparator LOOK deterministic while
    // leaving the outcome dependent on how the caller built its array.
    const a = stub({ score: 100, pageNumber: 7, order: 3 });
    const b = stub({ score: 100, pageNumber: 7, order: 4 });
    assert.notEqual(compareCandidates(a, b), 0);
    assert.ok(compareCandidates(a, b) < 0);
    assert.ok(compareCandidates(b, a) > 0);
    // ...and it does return 0 for a page against itself, which is what makes
    // the assertion above a real constraint rather than "always non-zero".
    assert.equal(compareCandidates(a, a), 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// selectPagesForExtraction
// ══════════════════════════════════════════════════════════════════════

describe("selectPagesForExtraction — the three reasons", () => {
  it("reports 'empty' for no pages and measures nothing", () => {
    const selection = selectPagesForExtraction([]);
    assert.equal(selection.reason, "empty");
    assert.deepEqual(selection.pages, []);
    assert.deepEqual(selection.selectedPageNumbers, []);
    assert.equal(selection.totalChars, 0);
    assert.equal(selection.droppedForBudget, 0);
  });

  it("reports 'all-fit' and returns EVERY page when the document fits", () => {
    // Including the pages the heuristic would have scored at or below zero:
    // when there is nothing to gain by dropping a page, dropping one can only
    // lose a statement whose heading the converter mangled.
    const small = [
      page(1, "# ACME LIMITED\n\nAnnual Report"),
      narrativePage(2, "Directors' Report", 4),
      statementPage(3, "Balance Sheet as at 31 March 2025", 6),
    ];
    const selection = selectPagesForExtraction(small);
    assert.equal(selection.reason, "all-fit");
    assert.deepEqual(selection.selectedPageNumbers, [1, 2, 3]);
    assert.equal(selection.droppedForBudget, 0);
    assert.equal(
      selection.totalChars,
      small.reduce((n, p) => n + p.markdown.length, 0),
    );
  });

  it("reports 'scored' when the document does not fit", () => {
    const selection = selectPagesForExtraction(REPORT);
    assert.equal(selection.reason, "scored");
  });

  it("reports 'scored' with NO pages when nothing scored above zero", () => {
    // An all-narrative document over the cap. The caller's signal to fall back
    // to the whole-PDF path — silently sending an empty selection would be a
    // model call that cannot succeed.
    const narrativeOnly = Array.from({ length: 30 }, (_, i) =>
      narrativePage(i + 1, "Directors' Report", 14),
    );
    const selection = selectPagesForExtraction(narrativeOnly, {
      maxChars: 5_000,
    });
    assert.equal(selection.reason, "scored");
    assert.deepEqual(selection.pages, []);
    assert.equal(selection.totalChars, 0);
    assert.equal(
      selection.droppedForBudget,
      0,
      "nothing scored above zero, so nothing was dropped FOR BUDGET",
    );
  });
});

describe("selectPagesForExtraction — what it picks out of the annual report", () => {
  it("selects the statements and refuses the narrative sections at a real budget", () => {
    // 20k rather than the 40k default so the budget genuinely binds; at 40k
    // there is room left over and the two table-bearing narrative pages are
    // correctly allowed in behind everything else.
    const selection = selectPagesForExtraction(REPORT, { maxChars: 20_000 });

    for (const pageNumber of [21, 22, 23, 24, 25, 26, 27, 28, 33, 34, 35, 36]) {
      assert.ok(
        selection.selectedPageNumbers.includes(pageNumber),
        `statement page ${pageNumber} was not selected: ${selection.selectedPageNumbers.join(",")}`,
      );
    }
    // Cover, contents, directors' report prose, MD&A, governance, auditor's
    // report, divider, AGM notice.
    for (const pageNumber of [
      1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 37, 38,
      39, 40,
    ]) {
      assert.ok(
        !selection.selectedPageNumbers.includes(pageNumber),
        `narrative page ${pageNumber} was selected`,
      );
    }
    assert.ok(selection.totalChars <= 20_000);
  });

  it("emits ASCENDING by page number, not by score", () => {
    const selection = selectPagesForExtraction(REPORT, { maxChars: 20_000 });
    const numbers = selection.selectedPageNumbers;
    assert.deepEqual(
      numbers,
      [...numbers].sort((a, b) => a - b),
      "a statement's page 2 arriving before its page 1 is a reading error we would be introducing",
    );
    assert.deepEqual(
      selection.pages.map((p) => p.pageNumber),
      numbers,
      "pages and selectedPageNumbers must agree",
    );

    // And the score order is genuinely DIFFERENT, so this is not a test that
    // passes by coincidence: the top-scoring page is not the lowest-numbered.
    const scores = scorePages(REPORT).filter((s) =>
      numbers.includes(s.pageNumber),
    );
    const byScore = [...scores]
      .sort(compareCandidates)
      .map((s) => s.pageNumber);
    assert.notDeepEqual(byScore, numbers);
    assert.notEqual(byScore[0], numbers[0]);
  });

  it("selects the same set however the caller ordered its array", () => {
    const shuffled = [...REPORT].reverse();
    const interleaved = [
      ...REPORT.filter((p) => p.pageNumber % 2 === 1),
      ...REPORT.filter((p) => p.pageNumber % 2 === 0),
    ];
    const base = selectPagesForExtraction(REPORT, { maxChars: 20_000 });
    for (const variant of [shuffled, interleaved]) {
      const selection = selectPagesForExtraction(variant, { maxChars: 20_000 });
      assert.deepEqual(selection.selectedPageNumbers, base.selectedPageNumbers);
      assert.equal(selection.totalChars, base.totalChars);
      assert.equal(selection.droppedForBudget, base.droppedForBudget);
    }
  });

  it("is deterministic across repeated runs", () => {
    const first = selectPagesForExtraction(REPORT, { maxChars: 12_000 });
    for (let i = 0; i < 5; i += 1) {
      const again = selectPagesForExtraction(REPORT, { maxChars: 12_000 });
      assert.deepEqual(again.selectedPageNumbers, first.selectedPageNumbers);
    }
  });

  it("does not mutate the caller's array", () => {
    const input = buildAnnualReport();
    const before = input.map((p) => p.pageNumber);
    selectPagesForExtraction(input, { maxChars: 12_000 });
    assert.deepEqual(
      input.map((p) => p.pageNumber),
      before,
    );
  });

  it("returns the page markdown verbatim", () => {
    const selection = selectPagesForExtraction(REPORT, { maxChars: 20_000 });
    for (const selected of selection.pages) {
      const original = REPORT.find((p) => p.pageNumber === selected.pageNumber);
      assert.ok(original);
      assert.equal(selected.markdown, original.markdown);
    }
  });
});

describe("selectPagesForExtraction — the budget", () => {
  it("never exceeds maxChars, and totalChars is the sum of what it returned", () => {
    for (const maxChars of [40_000, 20_000, 12_000, 6_000, 2_000, 900]) {
      const selection = selectPagesForExtraction(REPORT, { maxChars });
      const summed = selection.pages.reduce((n, p) => n + p.markdown.length, 0);
      assert.equal(selection.totalChars, summed, `at maxChars=${maxChars}`);
      assert.ok(
        selection.totalChars <= maxChars,
        `at maxChars=${maxChars} the selection was ${selection.totalChars}`,
      );
    }
  });

  it("counts droppedForBudget as scored-but-unfitted, never as unwanted", () => {
    const scores = scorePages(REPORT);
    const wanted = scores.filter((s) => s.score > 0).length;
    const selection = selectPagesForExtraction(REPORT, { maxChars: 12_000 });
    assert.equal(
      selection.droppedForBudget,
      wanted - selection.pages.length,
      "droppedForBudget must be the number an operator can act on",
    );
    assert.ok(selection.droppedForBudget > 0, "12k must actually bind");

    // The 24 narrative pages are not "dropped" — they were never wanted.
    assert.ok(
      selection.droppedForBudget < 24,
      `droppedForBudget was ${selection.droppedForBudget}; unwanted pages are being counted as starvation`,
    );
  });

  it("a tighter budget drops more and selects a subset of the looser one's intent", () => {
    const loose = selectPagesForExtraction(REPORT, { maxChars: 20_000 });
    const tight = selectPagesForExtraction(REPORT, { maxChars: 8_000 });
    assert.ok(tight.pages.length < loose.pages.length);
    assert.ok(tight.droppedForBudget > loose.droppedForBudget);
  });

  it("DROPS an oversized page rather than truncating it", () => {
    // Half a table produces a plausible, internally consistent, wrong extract,
    // and nothing downstream can tell it from a whole one.
    const huge = statementPage(1, "Consolidated Balance Sheet", 200);
    const small = statementPage(2, "Consolidated Statement of Cash Flows", 4);
    assert.ok(huge.markdown.length > 4_000);
    const selection = selectPagesForExtraction([huge, small], {
      maxChars: 4_000,
    });
    assert.equal(selection.reason, "scored");
    assert.deepEqual(selection.selectedPageNumbers, [2]);
    assert.equal(selection.pages[0].markdown, small.markdown);
    assert.equal(selection.droppedForBudget, 1);
  });

  it("returns nothing when no single page fits, and says so", () => {
    const a = statementPage(1, "Consolidated Balance Sheet", 60);
    const b = statementPage(2, "Consolidated Statement of Cash Flows", 60);
    const selection = selectPagesForExtraction([a, b], { maxChars: 100 });
    assert.deepEqual(selection.pages, []);
    assert.equal(selection.totalChars, 0);
    assert.equal(selection.droppedForBudget, 2);
    assert.equal(selection.reason, "scored");
  });

  it("defaults to DEFAULT_MAX_CHARS when no options are passed", () => {
    assert.equal(DEFAULT_MAX_CHARS, 40_000);
    const explicit = selectPagesForExtraction(REPORT, {
      maxChars: DEFAULT_MAX_CHARS,
    });
    const implicit = selectPagesForExtraction(REPORT);
    assert.deepEqual(
      implicit.selectedPageNumbers,
      explicit.selectedPageNumbers,
    );
  });
});

describe("selectPagesForExtraction — refusing nonsense loudly", () => {
  it("throws on a non-finite or non-positive maxChars instead of substituting the default", () => {
    // A silent fall back to a working value hides the caller's arithmetic bug
    // forever behind a selection that looks fine.
    for (const maxChars of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      assert.throws(
        () => selectPagesForExtraction(REPORT, { maxChars }),
        /maxChars must be a finite positive number/,
        `maxChars=${String(maxChars)}`,
      );
    }
  });

  it("throws on a non-finite page number rather than silently losing the page", () => {
    // NaN poisons every comparison it touches, so one bad entry would make the
    // whole sort meaningless rather than making one page wrong.
    assert.throws(
      () =>
        selectPagesForExtraction([
          page(Number.NaN, statementTable(4)),
          page(2, statementTable(4)),
        ]),
      /pageNumber must be a finite integer/,
    );
    assert.throws(
      () => selectPagesForExtraction([page(1.5, statementTable(4))]),
      /pageNumber must be a finite integer/,
    );
  });

  it("handles a single-page document and a blank page without dividing by zero", () => {
    const single = selectPagesForExtraction([
      statementPage(1, "Balance Sheet", 4),
    ]);
    assert.equal(single.reason, "all-fit");
    assert.equal(single.pages.length, 1);

    const blank = scorePages([page(1, "")]);
    assert.equal(blank[0].score, 0);
    assert.equal(blank[0].tableRatio, 0);
  });
});

describe("MONEY-1314 — a continuation is never selected without its heading", () => {
  // The greedy packer skips an over-budget candidate and keeps scanning, so a
  // later SMALLER page is taken instead. Heading pages score higher than
  // continuations but are LARGER — they carry the header plus the first rows —
  // so the packer systematically preferred the small orphan and dropped the
  // heading that gives it meaning.
  //
  // The orphan then reaches the model as bare rows with no heading, no column
  // labels and no period, immediately after several DIFFERENT statements —
  // inviting attribution to the wrong one. This module's contract is already
  // "a half table is worse than no table"; it was enforced at PAGE granularity
  // and not at the STATEMENT granularity Schedule III spans.

  /** A page of exactly `rows` data rows under an optional heading. */
  const table = (rows: number): string =>
    [
      "| Particulars | 2025 | 2024 | 2023 |",
      "|---|---|---|---|",
      ...Array.from(
        { length: rows },
        (_, i) =>
          `| Line item ${i + 1} | ${1234.5 + i} | ${987.6 + i} | ${456.7 + i} |`,
      ),
    ].join("\n");

  const withHeading = (p: number, heading: string, rows: number) => ({
    pageNumber: p,
    markdown: `## ${heading}\n\n${table(rows)}`,
  });
  const bare = (p: number, rows: number) => ({
    pageNumber: p,
    markdown: table(rows),
  });

  it("never selects a continuation whose heading page did not fit", () => {
    // Sized so the heading CANNOT fit at any point — it alone exceeds the
    // budget — while its small continuation fits easily. Before the fix the
    // packer took the continuation alone.
    const heading = withHeading(
      20,
      "Notes to the Consolidated Financial Statements",
      400,
    );
    const continuation = bare(21, 3);
    const maxChars = continuation.markdown.length + 200;

    assert.ok(
      heading.markdown.length > maxChars,
      "[premise] the heading must not fit at all, or this tests nothing",
    );
    assert.ok(
      continuation.markdown.length <= maxChars,
      "[premise] the continuation must fit on its own",
    );

    const sel = selectPagesForExtraction([heading, continuation], { maxChars });

    // THE INVARIANT: 21 may appear only behind 20. Asserting "21 is never
    // selected" would be wrong — it is perfectly good when its heading is
    // there — and a first draft of this case did exactly that and failed on a
    // selection ([20,21]) that was correct.
    assert.ok(
      !sel.selectedPageNumbers.includes(21) ||
        sel.selectedPageNumbers.includes(20),
      `page 21 was selected without its heading (page 20): ` +
        `${JSON.stringify(sel.selectedPageNumbers)}. Bare rows with no heading, ` +
        "no column labels and no period — unattributable to any statement",
    );
    assert.deepEqual(sel.selectedPageNumbers, []);
  });

  it("the invariant holds across a whole document, at every budget", () => {
    // The property stated once, checked over a range rather than at one
    // hand-picked size — the orphan only appears in the band where the heading
    // does not fit and the continuation does, and hard-coding a budget can
    // miss it.
    const pages = [
      ...Array.from({ length: 6 }, (_, i) =>
        withHeading(i + 1, "Consolidated Balance Sheet", 14),
      ),
      withHeading(10, "Notes to the Financial Statements", 220),
      bare(11, 4),
      bare(12, 4),
    ];
    const total = pages.reduce((n, p) => n + p.markdown.length, 0);
    for (let maxChars = 500; maxChars <= total + 500; maxChars += 250) {
      const sel = selectPagesForExtraction(pages, { maxChars });
      const set = new Set(sel.selectedPageNumbers);
      for (const cont of [11, 12]) {
        if (set.has(cont)) {
          assert.ok(
            set.has(cont - 1),
            `at maxChars=${maxChars}, page ${cont} was selected without ` +
              `page ${cont - 1}: ${JSON.stringify(sel.selectedPageNumbers)}`,
          );
        }
      }
    }
  });

  it("[control] it DOES take the continuation when the heading fits", () => {
    // Without this, "never select page 21" satisfies the assertion above and
    // silently discards every statement's second page.
    const heading = withHeading(1, "Consolidated Balance Sheet", 10);
    const continuation = bare(2, 8);
    const sel = selectPagesForExtraction([heading, continuation], {
      maxChars: 100_000,
    });
    assert.deepEqual(sel.selectedPageNumbers, [1, 2]);
  });

  it("a page with its OWN heading is not a continuation of the one above", () => {
    // A Cash Flow statement after a Balance Sheet is the NEXT statement, not
    // page 2 of the previous one — so it must survive the balance sheet not
    // fitting. This is what the prune exposed: the adjacency pass awarded the
    // bonus to any dense page following a seed, heading or not, which was
    // harmless as a score nudge and stopped being harmless once a continuation
    // became DEPENDENT for selection.
    const huge = withHeading(1, "Consolidated Balance Sheet", 200);
    const own = withHeading(2, "Consolidated Statement of Cash Flows", 4);
    const sel = selectPagesForExtraction([huge, own], {
      maxChars: own.markdown.length + 100,
    });
    assert.deepEqual(sel.selectedPageNumbers, [2]);
  });

  it("pruning frees budget, and the refill SPENDS it", () => {
    // The review measured 4,699 chars left unspent alongside a dropped
    // heading. Dropping an orphan must not simply waste its allowance.
    //
    // Sized from a real run so the refill is the ONLY thing that can produce
    // the result: the continuation (score 119) is packed first and fits; the
    // isolated page (score 27) then does NOT fit alongside it; the prune drops
    // the continuation; and only a refill pass can pick the isolated page up.
    // A first draft of this case had the extra page already selected in the
    // greedy pass, so removing the refill entirely changed nothing — a
    // mutation proved it.
    const heading = withHeading(
      20,
      "Notes to the Consolidated Financial Statements",
      400,
    );
    const continuation = bare(21, 6);
    // Dense enough to score, diluted with prose so it scores BELOW the
    // continuation's adjacency bonus, and larger than it.
    const isolated = {
      pageNumber: 40,
      markdown: `${table(6)}\n\n${Array.from(
        { length: 30 },
        (_, i) =>
          `The Company has evaluated matters described in paragraph ${i + 1} of this note in accordance with applicable standards.`,
      ).join("\n\n")}`,
    };

    const maxChars =
      continuation.markdown.length + isolated.markdown.length - 10;
    assert.ok(
      isolated.markdown.length <= maxChars,
      "[premise] the isolated page must fit on its own",
    );
    assert.ok(
      continuation.markdown.length + isolated.markdown.length > maxChars,
      "[premise] the two must NOT fit together, or the refill is not needed",
    );

    const sel = selectPagesForExtraction([heading, continuation, isolated], {
      maxChars,
    });

    assert.ok(!sel.selectedPageNumbers.includes(21), "the orphan was kept");
    assert.deepEqual(
      sel.selectedPageNumbers,
      [40],
      "the budget freed by pruning the orphan was not re-spent",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// STATEMENT EVIDENCE — MONEY-1343
// ══════════════════════════════════════════════════════════════════════

/**
 * The job's own page splitter, mirrored from
 * `scripts/jobs/doc-ingest-backfill.ts` (`PAGE_MARKER` / `splitMarkdownPages`).
 *
 * Copied rather than imported because that file is a script, not a package
 * export. The copy is only load-bearing for the FIXTURE: what is under test is
 * `statementEvidence`, and the three real sidecars below were measured through
 * this exact shape before they were trimmed, so a drift in the real splitter
 * would change the fixture's page list and the counts asserted here would move.
 */
const FIXTURE_PAGE_MARKER = /^<!-- page (\d+) -->$/gm;

function splitMarkdownPages(markdown: string): DocPage[] {
  const pages: DocPage[] = [];
  const marks: Array<{ index: number; end: number; page: number }> = [];
  FIXTURE_PAGE_MARKER.lastIndex = 0;
  for (
    let m = FIXTURE_PAGE_MARKER.exec(markdown);
    m !== null;
    m = FIXTURE_PAGE_MARKER.exec(markdown)
  ) {
    marks.push({
      index: m.index,
      end: m.index + m[0].length,
      page: Number(m[1]),
    });
  }
  if (marks.length === 0) {
    const body = markdown.trim();
    return body ? [{ pageNumber: 1, markdown: body }] : [];
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark === undefined) continue;
    const next = marks[i + 1];
    const body = markdown
      .slice(mark.end, next?.index ?? markdown.length)
      .trim();
    if (body) pages.push({ pageNumber: mark.page, markdown: body });
  }
  return pages;
}

function loadSidecar(symbol: string): DocPage[] {
  const path = join(
    import.meta.dirname,
    "..",
    "fixtures",
    "doc-ingest",
    `${symbol}-annual_report-FY2025.trimmed.md`,
  );
  return splitMarkdownPages(readFileSync(path, "utf8"));
}

/** A markdown table row whose numeric cell count is exactly `numerics`. */
function numericRow(label: string, numerics: number): string {
  return `| ${label} | ${Array.from({ length: numerics }, (_, i) => `${i + 1}.00`).join(" | ")} |`;
}

describe("statementEvidence — real converted sidecars (MONEY-1343)", () => {
  /**
   * BONLON FY2025 is the document MONEY-1334 was diagnosed on. Its pages
   * 92-135 are scanned images the converter emitted NOTHING for — not even a
   * `<!-- page N -->` marker — so the statement block is simply absent. The
   * committed fixture is trimmed to pages 72-136 precisely so that gap is
   * visible in the bytes: page 91 is followed by page 136.
   *
   * The whole document classifies "partial", and the brief for this work
   * expected "none". BOTH corroborated hits are FALSE POSITIVES on the
   * corporate-governance report, and this test pins that rather than hiding
   * it — see the `statementEvidence` docblock for the two pages and the two
   * mechanisms. A detector's known false positives belong in its suite: that
   * is what makes a later tightening show up as a test change instead of a
   * silent shift in what the pilot measures.
   */
  it("BONLON FY2025 — statements absent, yet measures partial from governance-page false positives", () => {
    const pages = loadSidecar("BONLON");

    assert.equal(pages.length, 21, "[premise] fixture page count");
    assert.equal(pages[0]?.pageNumber, 72, "[premise] fixture starts at 72");
    const numbers = pages.map((p) => p.pageNumber);
    assert.ok(
      numbers.includes(91) && numbers.includes(136),
      "[premise] the fixture straddles the scanned void",
    );
    assert.ok(
      !numbers.some((n) => n > 91 && n < 136),
      "[premise] pages 92-135 produced no page marker at all — that IS the defect",
    );

    assert.deepEqual(statementEvidence(pages), {
      "balance-sheet": 2,
      "profit-and-loss": 1,
      "cash-flow": 0,
      class: "partial",
    });
  });

  /**
   * The false positives, isolated to the two pages that produce them, so a
   * change in either mechanism fails HERE with a page number rather than as a
   * count that moved by one in the test above.
   */
  it("BONLON — page 72 counts on an attendance table, page 74 on AGM dates", () => {
    const pages = loadSidecar("BONLON");
    const page72 = pages.find((p) => p.pageNumber === 72);
    const page74 = pages.find((p) => p.pageNumber === 74);
    assert.ok(page72 && page74, "[premise] both pages are in the fixture");

    // Page 72: "balance sheets of the Company" in an investor-grievance
    // bullet, corroborated by a committee attendance table.
    assert.match(page72.markdown, /balance sheets of the Company/i);
    assert.ok(
      measureTables(page72.markdown).numericCells >=
        HEADING_CORROBORATION_MIN_NUMERIC_CELLS,
      "[premise] the attendance table clears the corroboration floor",
    );
    assert.equal(statementEvidence([page72])["balance-sheet"], 1);

    // Page 74: the phrase sits inside a related-party sentence, and the cells
    // that corroborate it are DATES — isNumericCell cannot tell 28.09.2024
    // from a decimal figure.
    assert.match(page74.markdown, /Balance Sheet and Profit and Loss Account/i);
    assert.ok(
      isNumericCell("28.09.2024"),
      "[premise] a dotted date reads as a figure",
    );
    assert.deepEqual(statementEvidence([page74]), {
      "balance-sheet": 1,
      "profit-and-loss": 1,
      "cash-flow": 0,
      class: "partial",
    });

    // And neither page is reachable by demoting narrative sections: the
    // section title was pages earlier, so there is no marker on these two.
    assert.equal(findNarrativeSection(page72.markdown), null);
    assert.equal(findNarrativeSection(page74.markdown), null);
  });

  /** HARDWYN FY2025 renders its statements. All three are present. */
  it("HARDWYN FY2025 — full", () => {
    const pages = loadSidecar("HARDWYN");

    assert.equal(pages.length, 11, "[premise] fixture page count");
    assert.deepEqual(statementEvidence(pages), {
      "balance-sheet": 1,
      "profit-and-loss": 1,
      "cash-flow": 1,
      class: "full",
    });
  });

  /**
   * HARDWYN is also the proof that the HEADING matcher cannot do this job.
   * Pages 81/82/83 are a real balance sheet, P&L and cash flow; the converter
   * glued each title to the company name and the column headers on one
   * ~200-char line, which is over HEADING_LINE_MAX_CHARS and does not begin
   * with the title, so the whole-line matcher fails twice and hits the
   * NEIGHBOURING pages instead.
   */
  it("HARDWYN — findStatementHeading misses the very pages that carry the statements", () => {
    const pages = loadSidecar("HARDWYN");
    const byNumber = new Map(pages.map((p) => [p.pageNumber, p]));

    for (const n of [81, 82, 83]) {
      const page = byNumber.get(n);
      assert.ok(page, `[premise] page ${n} is in the fixture`);
      assert.equal(
        findStatementHeading(page.markdown),
        null,
        `the heading matcher found nothing on real statement page ${n}`,
      );
      assert.ok(
        measureTables(page.markdown).numericCells >= 25,
        `[premise] page ${n} is a dense statement page`,
      );
    }

    // ...while it does fire on 84, which is the statement of changes in
    // equity, whose title the converter happened to put on its own line.
    assert.equal(
      findStatementHeading(byNumber.get(84)?.markdown ?? ""),
      "changes-in-equity",
    );

    // Which is the whole point: evidence-by-heading reports "no statements"
    // for a document whose statements are right there.
    const headingOnly = pages.filter(
      (p) => findStatementHeading(p.markdown) !== null,
    );
    assert.ok(
      headingOnly.length < 3,
      "the heading matcher cannot even reach three distinct statements here",
    );
    assert.equal(statementEvidence(pages).class, "full");
  });

  /**
   * SAHLIBHFI FY2025 was left unpredicted by the brief. Measured: "partial" —
   * it renders a balance sheet and a cash flow statement and produces NO
   * corroborated profit-and-loss page anywhere in the document. That is the
   * MONEY-1343 shape: a document that is not bulk-scanned and is still
   * missing a statement.
   */
  it("SAHLIBHFI FY2025 — partial, with no profit-and-loss evidence at all", () => {
    const pages = loadSidecar("SAHLIBHFI");

    assert.equal(pages.length, 14, "[premise] fixture page count");
    const evidence = statementEvidence(pages);
    assert.deepEqual(evidence, {
      "balance-sheet": 1,
      "profit-and-loss": 0,
      "cash-flow": 1,
      class: "partial",
    });
    assert.equal(evidence["profit-and-loss"], 0);
  });
});

describe("statementEvidence — the corroboration gate", () => {
  /**
   * THE CONTENTS TRAP, and the reason the numeric-cell gate exists at all. A
   * table of contents names all three statements on one page and is the single
   * most common place all three phrases co-occur.
   */
  it("a page naming all three statements with no table counts for nothing", () => {
    const contents: DocPage = {
      pageNumber: 3,
      markdown: [
        "# <u>CONTENTS</u>",
        "",
        "Balance Sheet ................................ 84",
        "Statement of Profit and Loss ................. 86",
        "Cash Flow Statement .......................... 88",
      ].join("\n"),
    };

    assert.equal(
      measureTables(contents.markdown).numericCells,
      0,
      "[premise] a contents page carries no table",
    );
    for (const { pattern } of [
      { pattern: /balance\s+sheet/i },
      { pattern: /statement\s+of\s+profit\s+and\s+loss/i },
      { pattern: /cash\s+flow\s+statement/i },
    ]) {
      assert.match(
        contents.markdown,
        pattern,
        "[premise] all three phrases are present",
      );
    }

    assert.deepEqual(statementEvidence([contents]), {
      "balance-sheet": 0,
      "profit-and-loss": 0,
      "cash-flow": 0,
      class: "none",
    });
  });

  it(`a phrase with ${HEADING_CORROBORATION_MIN_NUMERIC_CELLS - 1} numeric cells does not count`, () => {
    const page: DocPage = {
      pageNumber: 10,
      markdown: [
        "Balance Sheet as at 31 March 2025",
        "",
        // The header row carries NO figures on purpose: "| ... | 2025 | 2024 |"
        // would contribute three numeric cells of its own and the boundary
        // under test would be off by three. The premise assertion below is
        // what caught exactly that while this test was being written.
        "| Particulars | Current year | Previous year |",
        "|---|---|---|",
        numericRow("Total assets", HEADING_CORROBORATION_MIN_NUMERIC_CELLS - 1),
      ].join("\n"),
    };

    assert.equal(
      measureTables(page.markdown).numericCells,
      HEADING_CORROBORATION_MIN_NUMERIC_CELLS - 1,
      "[premise] the page sits exactly one cell below the floor",
    );
    assert.deepEqual(statementEvidence([page]), {
      "balance-sheet": 0,
      "profit-and-loss": 0,
      "cash-flow": 0,
      class: "none",
    });
  });

  it(`a phrase with exactly ${HEADING_CORROBORATION_MIN_NUMERIC_CELLS} numeric cells DOES count`, () => {
    const page: DocPage = {
      pageNumber: 10,
      markdown: [
        "Balance Sheet as at 31 March 2025",
        "",
        // The header row carries NO figures on purpose: "| ... | 2025 | 2024 |"
        // would contribute three numeric cells of its own and the boundary
        // under test would be off by three. The premise assertion below is
        // what caught exactly that while this test was being written.
        "| Particulars | Current year | Previous year |",
        "|---|---|---|",
        numericRow("Total assets", HEADING_CORROBORATION_MIN_NUMERIC_CELLS),
      ].join("\n"),
    };

    assert.equal(
      measureTables(page.markdown).numericCells,
      HEADING_CORROBORATION_MIN_NUMERIC_CELLS,
      "[premise] the page sits exactly ON the floor",
    );
    assert.deepEqual(statementEvidence([page]), {
      "balance-sheet": 1,
      "profit-and-loss": 0,
      "cash-flow": 0,
      class: "partial",
    });
  });
});

describe("statementEvidence — classification", () => {
  /** A corroborated page for exactly one statement. */
  function statementPage(pageNumber: number, title: string): DocPage {
    return {
      pageNumber,
      markdown: [
        `**ACME LIMITED** **${title} as at 31 March 2025** **(Rs in Lakhs)**`,
        "",
        "| Particulars | 2025 | 2024 |",
        "|---|---|---|",
        numericRow("Line one", 6),
        numericRow("Line two", 6),
      ].join("\n"),
    };
  }

  it("no pages at all -> none, every count zero", () => {
    assert.deepEqual(statementEvidence([]), {
      "balance-sheet": 0,
      "profit-and-loss": 0,
      "cash-flow": 0,
      class: "none",
    });
  });

  it("nothing corroborated -> none", () => {
    const prose: DocPage = {
      pageNumber: 4,
      markdown:
        "The Directors present the Annual Report together with the audited accounts for the year.",
    };
    assert.deepEqual(statementEvidence([prose]), {
      "balance-sheet": 0,
      "profit-and-loss": 0,
      "cash-flow": 0,
      class: "none",
    });
  });

  it("one of three -> partial", () => {
    const evidence = statementEvidence([statementPage(84, "Balance Sheet")]);
    assert.equal(evidence.class, "partial");
    assert.deepEqual(
      [
        evidence["balance-sheet"],
        evidence["profit-and-loss"],
        evidence["cash-flow"],
      ],
      [1, 0, 0],
    );
  });

  it("two of three -> partial", () => {
    const evidence = statementEvidence([
      statementPage(84, "Balance Sheet"),
      statementPage(86, "Statement of Profit and Loss"),
    ]);
    assert.equal(evidence.class, "partial");
    assert.equal(evidence["cash-flow"], 0);
  });

  it("all three -> full", () => {
    const evidence = statementEvidence([
      statementPage(84, "Balance Sheet"),
      statementPage(86, "Statement of Profit and Loss"),
      statementPage(88, "Cash Flow Statement"),
    ]);
    assert.deepEqual(evidence, {
      "balance-sheet": 1,
      "profit-and-loss": 1,
      "cash-flow": 1,
      class: "full",
    });
  });

  it("counts pages, not documents — a statement spanning several pages counts each", () => {
    const evidence = statementEvidence([
      statementPage(84, "Balance Sheet"),
      statementPage(85, "Balance Sheet"),
      statementPage(86, "Statement of Profit and Loss"),
      statementPage(88, "Cash Flow Statement"),
    ]);
    assert.equal(evidence["balance-sheet"], 2);
    assert.equal(evidence.class, "full");
  });

  /**
   * The phrases are searched ANYWHERE on the page, not line-anchored. That is
   * the deliberate difference from matchStatementHeading and it is what makes
   * the glued-title conversion shape reachable at all.
   */
  it("a title glued to the company name and the units still counts", () => {
    const glued: DocPage = {
      pageNumber: 81,
      markdown: [
        "**HARDWYN INDIA LIMITED** **Consolidated Balance Sheet as at 31st March, 2025** **(Rs in Lakhs) (Rs in Lakhs)** **Particulars Note No. As at 31.03.2025 As at 31.03.2024**",
        "",
        "| Particulars | 2025 | 2024 |",
        "|---|---|---|",
        numericRow("Property, plant and equipment", 6),
      ].join("\n"),
    };

    assert.equal(
      findStatementHeading(glued.markdown),
      null,
      "[premise] the whole-line heading matcher cannot see this",
    );
    assert.equal(statementEvidence([glued])["balance-sheet"], 1);
  });

  /** No `g` flag on the phrase patterns: a repeated call must not alternate. */
  it("is stateless across calls on the same page", () => {
    const page = statementPage(84, "Balance Sheet");
    const first = statementEvidence([page]);
    const second = statementEvidence([page]);
    const third = statementEvidence([page]);
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
  });
});
