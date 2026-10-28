/**
 * MONEY-1324 (P17) — section selection over real SEC filing text.
 *
 * Every fixture under `__tests__/fixtures/edgar-text/` is a verbatim excerpt of
 * an object pulled from `gs://stockbook-content-prod/edgar/text/...` on
 * 2026-09-02. Nothing is fetched at test time and nothing is hand-written:
 * the wrapped-label hazard these tests exist for is a shape no one would
 * invent, and a synthetic fixture would quietly stop reproducing it the first
 * time someone "tidied" the alignment.
 *
 *   hlx-8k-ex991-statements.txt   0000866829/0001193125-26-378529/11.txt L176-300
 *                                 audited consolidated financial statements
 *                                 (merger 8-K) — the balance sheet with the
 *                                 wrapped Accounts-receivable row
 *   hecla-8k-ex991-business.txt   0000719413/0001193125-26-374615/3.txt  L1-120
 *                                 a 10-K "Item 1. Business" section
 *   bip-6k-ex992-circular.txt     0001788348/0001104659-26-103589/3.txt  L1-110
 *                                 notice of special meeting + circular
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  selectSectionsForAnalysis,
  cutIntoSections,
  segmentBlocks,
  normaliseFilingText,
  scoreSections,
  measureFiguresIn,
  isTableLine,
  findFigures,
  matchFilingHeading,
  matchFilingNarrative,
  splitOversizedSection,
  resolveSectionCap,
  DEFAULT_MAX_CHARS,
  MAX_SECTION_CHARS,
  NARRATIVE_PENALTY,
  type FilingBlock,
} from "../../src/market-data/filing-section-select-logic";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "edgar-text");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURE_DIR, name), "utf-8");

const HLX = fixture("hlx-8k-ex991-statements.txt");
const HECLA = fixture("hecla-8k-ex991-business.txt");
const BIP = fixture("bip-6k-ex992-circular.txt");

/** The four printed lines of the wrapped Accounts-receivable row. */
const AR_LABEL_HEAD = "Accounts receivable, net of";
const AR_LABEL_WRAP = "allowance for credit losses of";
const AR_VALUE_2025 = "164,695";
const AR_VALUE_2024 = "145,527";
const ALLOWANCE_IN_LABEL = "$7,511";

describe("filing text — the fixtures are what we think they are", () => {
  it("carries the wrapped Accounts-receivable row verbatim", () => {
    // If this fails, the fixture was re-cut and every assertion below is
    // measuring something else.
    assert.ok(HLX.includes(AR_LABEL_HEAD));
    assert.ok(HLX.includes(AR_LABEL_WRAP));
    assert.ok(HLX.includes(AR_VALUE_2025));
    assert.ok(HLX.includes(ALLOWANCE_IN_LABEL));
    assert.ok(HLX.includes("Total current assets"));
  });

  it("has NO markdown table pipes — page-select's measure would read zero", () => {
    // The reason this module exists rather than reusing measureTables().
    for (const text of [HLX, HECLA, BIP]) {
      const pipeLines = text
        .split("\n")
        .filter((l) => l.trimStart().startsWith("|"));
      assert.equal(pipeLines.length, 0);
    }
  });

  it("has no form feeds — there are no page markers to select on", () => {
    for (const text of [HLX, HECLA, BIP]) {
      assert.ok(!text.includes("\f"));
    }
  });
});

describe("normaliseFilingText", () => {
  it("removes the extractor's trailing padding, losslessly", () => {
    const normalised = normaliseFilingText(HLX);
    assert.ok(normalised.length < HLX.length);
    // Every line's CONTENT survives.
    for (const line of normalised.split("\n")) {
      assert.equal(line, line.replace(/[ \t]+$/, ""));
    }
    assert.ok(normalised.includes(AR_VALUE_2025));
    assert.ok(normalised.includes("Total current assets"));
  });

  it("saves a material fraction of the budget on real bytes", () => {
    // Measured 25.8% / 35.5% / 28.1% across the three source objects. Asserted
    // as a floor rather than a point so a re-cut fixture does not fail it.
    const saved = 1 - normaliseFilingText(HLX).length / HLX.length;
    assert.ok(saved > 0.15, `expected >15% padding, got ${saved}`);
  });
});

describe("isTableLine / findFigures", () => {
  it("accepts a fixed-width statement row", () => {
    assert.ok(
      isTableLine(
        "  Cash and cash equivalents           $        54,167       $        80,803",
      ),
    );
  });

  it("accepts the accounting negative the extractor prints with spaces", () => {
    assert.ok(
      isTableLine("  (recovery                        (418  )          1,622"),
    );
    assert.deepEqual(findFigures("(418  )").length, 1);
  });

  it("REJECTS a sentence that merely contains figures", () => {
    // No column gap. This is the check that stops prose scoring as a table.
    assert.ok(
      !isTableLine(
        "We acquired 3 vessels in 2025 for $54,167 thousand under the agreement.",
      ),
    );
  });

  it("REJECTS a bare label line inside a wrapped row", () => {
    assert.ok(!isTableLine("  Accounts receivable, net of"));
    assert.ok(!isTableLine("  respectively"));
  });

  it("counts a box-drawing rule as table structure but not as data", () => {
    const rule = " " + "─".repeat(78);
    assert.ok(isTableLine(rule));
    assert.equal(measureFiguresIn(rule).figureCount, 0);
    assert.equal(measureFiguresIn(rule).tableLines, 1);
  });
});

describe("matchFilingHeading / matchFilingNarrative", () => {
  it("matches the running header with the registrant name inline", () => {
    assert.equal(
      matchFilingHeading(
        "HORNBECK OFFSHORE SERVICES, INC. AND SUBSIDIARIES CONSOLIDATED BALANCE SHEETS",
      ),
      "balance-sheet",
    );
  });

  it("matches a form item", () => {
    assert.equal(matchFilingHeading("Item 1. Business"), "form-item");
  });

  it("does NOT match the same words inside a sentence", () => {
    assert.equal(
      matchFilingHeading(
        "The balance sheet impact of the arrangement is described in Note 14 below.",
      ),
      null,
    );
  });

  it("demotes a meeting notice, and only at the start of a line", () => {
    assert.equal(
      matchFilingNarrative("NOTICE OF SPECIAL MEETING OF UNITHOLDERS"),
      "meeting-notice",
    );
    assert.equal(
      matchFilingNarrative(
        "as described in the notice of special meeting delivered to holders",
      ),
      null,
    );
  });
});

describe("segmentBlocks — table integrity", () => {
  const blocks = segmentBlocks(normaliseFilingText(HLX));

  const blockWith = (needle: string): FilingBlock => {
    const hit = blocks.find((b) => b.text.includes(needle));
    assert.ok(hit, `no block contains ${JSON.stringify(needle)}`);
    return hit;
  };

  it("THE DEFECT THIS DESIGN EXISTS FOR: the wrapped row is never split", () => {
    // "Accounts receivable, net of" carries no figures. "allowance for credit
    // losses of  164,695  145,527" carries the row's real values. "$7,511 and
    // $7,929," and "respectively" are the tail of the same label.
    //
    // All four MUST land in one block. A block boundary anywhere inside them
    // hands the model an orphaned figure with the wrong label above it, and
    // the result is a balance sheet that is wrong and looks fine.
    const head = blockWith(AR_LABEL_HEAD);
    assert.equal(head.kind, "table");
    assert.ok(head.text.includes(AR_LABEL_WRAP), "wrap line left the block");
    assert.ok(head.text.includes(AR_VALUE_2025), "2025 value left the block");
    assert.ok(head.text.includes(AR_VALUE_2024), "2024 value left the block");
    assert.ok(
      head.text.includes(ALLOWANCE_IN_LABEL),
      "allowance left the block",
    );
    assert.ok(head.text.includes("respectively"), "label tail left the block");
  });

  it("keeps the whole balance sheet — headers, rows and total — together", () => {
    const block = blockWith(AR_LABEL_HEAD);
    // The column headings the model needs to attach a period to a figure...
    assert.ok(block.text.includes("December 31,"));
    // ...and the total that makes the reading checkable.
    assert.ok(block.text.includes("Total current assets"));
    assert.ok(block.text.includes("257,009"));
  });

  it("keeps a label that continues BELOW its figures", () => {
    // "Property, plant and equipment,  754,135  674,729" / "net"
    const block = blockWith("Property, plant and equipment,");
    assert.ok(block.text.includes("754,135"));
    const lines = block.text.split("\n");
    const at = lines.findIndex((l) =>
      l.includes("Property, plant and equipment,"),
    );
    assert.ok(at >= 0);
    // The word "net" on its own line is inside the SAME block.
    assert.ok(
      lines.slice(at, at + 3).some((l) => l.trim() === "net"),
      "label tail 'net' was cut off the row",
    );
  });

  it("separates the statement heading from the table it names", () => {
    // Heading and table are distinct BLOCKS (so the heading can start a
    // section) but must end up in the SAME section — asserted below.
    const heading = blocks.find((b) =>
      b.text.includes("CONSOLIDATED BALANCE SHEETS"),
    );
    assert.ok(heading);
    assert.equal(heading.kind, "heading");
    assert.ok(!heading.text.includes(AR_VALUE_2025));
  });

  it("blocks tile the document with no overlap and no gaps in order", () => {
    let previousEnd = -1;
    for (const block of blocks) {
      assert.ok(block.startLine > previousEnd, "blocks overlap");
      assert.ok(block.endLine >= block.startLine);
      previousEnd = block.endLine;
    }
  });
});

describe("buildSections", () => {
  it("puts a statement heading in the same section as its table", () => {
    const sections = cutIntoSections(HLX);
    const withAr = sections.find((s) => s.text.includes(AR_VALUE_2025));
    assert.ok(withAr);
    assert.ok(
      withAr.text.includes("CONSOLIDATED BALANCE SHEETS"),
      "the balance sheet's figures were separated from its title",
    );
  });

  it("never splits a block across two sections", () => {
    for (const text of [HLX, HECLA, BIP]) {
      const sections = cutIntoSections(text);
      const seen = new Set<string>();
      for (const section of sections) {
        for (const block of section.blocks) {
          const key = `${block.startLine}:${block.endLine}`;
          assert.ok(!seen.has(key), "a block appears in two sections");
          seen.add(key);
          // The block's text survives whole inside its section.
          assert.ok(section.text.includes(block.text));
        }
      }
    }
  });

  it("splits an oversized run on block boundaries, never inside a block", () => {
    const big: FilingBlock[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "prose" as const,
      startLine: i,
      endLine: i,
      text: "x".repeat(2_000),
    }));
    const pieces = splitOversizedSection(big);
    assert.ok(pieces.length > 1, "an oversized run was not split");
    for (const piece of pieces) {
      const chars = piece.reduce((n, b) => n + b.text.length, 0);
      assert.ok(
        chars <= MAX_SECTION_CHARS,
        `piece of ${chars} exceeds the cap`,
      );
    }
    // Every block survives exactly once, in order.
    assert.equal(pieces.flat().length, big.length);
  });

  it("keeps a single block larger than the cap WHOLE rather than cutting it", () => {
    // Table integrity outranks the size target. A cut table is the failure
    // this module refuses; an oversized section merely competes as one unit.
    const huge: FilingBlock[] = [
      {
        kind: "table",
        startLine: 0,
        endLine: 0,
        text: "y".repeat(MAX_SECTION_CHARS * 2),
      },
    ];
    const pieces = splitOversizedSection(huge);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0]?.length, 1);
    assert.equal(pieces[0]?.[0]?.text.length, MAX_SECTION_CHARS * 2);
  });
});

describe("scoreSections", () => {
  it("ranks the balance sheet far above the auditor's-report prose", () => {
    const sections = cutIntoSections(HLX);
    const scores = scoreSections(sections);
    const statement = scores.find((s) => s.headingMatched === "balance-sheet");
    assert.ok(statement);
    assert.ok(
      statement.headingCorroborated,
      "heading was not backed by figures",
    );
    assert.ok(
      statement.figureCount > 40,
      `only ${statement.figureCount} figures`,
    );

    const others = scores.filter((s) => s.index !== statement.index);
    for (const other of others) {
      assert.ok(
        other.score < statement.score,
        `section ${other.index} outscored the balance sheet`,
      );
    }
  });

  it("DEMOTES a meeting notice without banning it", () => {
    const scores = scoreSections(cutIntoSections(BIP));
    const notice = scores.find((s) => s.narrativeMatched === "meeting-notice");
    assert.ok(notice, "the circular's meeting notice was not recognised");
    assert.ok(notice.score < 0, "narrative was not demoted");
    // ...but the penalty is FINITE. A narrative section carrying a real
    // statement table must still clear zero, because for a results filing the
    // table under a narrative header can be the only statement in the
    // document. Built from the REAL balance sheet with a narrative header
    // prepended, rather than a hand-written five-row table — the penalty is
    // sized against a full statement's density, and a toy table under-states
    // it and would make this assertion measure the fixture instead of the
    // rule.
    const realTable = normaliseFilingText(HLX)
      .split("\n")
      .filter((l) => isTableLine(l))
      .join("\n");
    const withTable = scoreSections(
      cutIntoSections(
        `NOTICE OF SPECIAL MEETING OF UNITHOLDERS\n\n${realTable}`,
      ),
    );
    const demotedWithTable = withTable.find(
      (s) => s.narrativeMatched === "meeting-notice",
    );
    assert.ok(
      demotedWithTable,
      "the narrative header stopped being recognised",
    );
    assert.ok(
      demotedWithTable.score > 0,
      `a demoted section carrying a real table was banned outright (score ${demotedWithTable.score})`,
    );
  });

  it("the penalty is sized so density alone can outweigh it", () => {
    // The arithmetic the constant depends on, asserted directly so a future
    // tweak to any of the three cannot silently turn "demote" into "ban".
    const maxPositive = 60 + 40; // DENSITY_POINTS_MAX + FIGURE_POINTS_MAX
    assert.ok(
      NARRATIVE_PENALTY < maxPositive,
      "NARRATIVE_PENALTY can no longer be outweighed — narrative is now banned",
    );
  });
});

describe("selectSectionsForAnalysis", () => {
  it("CONTROL: a document under the budget is passed whole", () => {
    const selection = selectSectionsForAnalysis(HLX);
    assert.equal(selection.reason, "all-fit");
    assert.equal(selection.droppedForBudget, 0);
    assert.equal(selection.sections.length, selection.totalSections);
    // Nothing was scored away — the whole normalised document is present.
    assert.ok(selection.text.includes(AR_VALUE_2025));
    assert.ok(selection.text.includes("Total current assets"));
    assert.ok(selection.totalChars <= DEFAULT_MAX_CHARS);
  });

  it("returns 'empty' for blank input without measuring anything", () => {
    const selection = selectSectionsForAnalysis("   \n\n  \n");
    assert.equal(selection.reason, "empty");
    assert.equal(selection.sections.length, 0);
    assert.equal(selection.totalChars, 0);
    assert.equal(selection.text, "");
  });

  it("throws on a budget the caller computed wrongly", () => {
    // Never a silent fall back to the default: a NaN budget is a caller bug
    // and substituting a working value hides it behind a selection that looks
    // fine.
    assert.throws(() => selectSectionsForAnalysis(HLX, { maxChars: NaN }));
    assert.throws(() => selectSectionsForAnalysis(HLX, { maxChars: 0 }));
  });

  it("keeps the balance sheet when the budget forces a choice", () => {
    const selection = selectSectionsForAnalysis(HLX, { maxChars: 4_500 });
    assert.equal(selection.reason, "scored");
    assert.ok(selection.totalChars <= 4_500);
    // The statement won the budget; the auditor's-report prose lost it.
    assert.ok(selection.text.includes(AR_VALUE_2025));
    assert.ok(selection.text.includes("Total current assets"));
  });

  it("never emits a partial table row when the budget bites", () => {
    // Sweep every budget from tiny to whole. At NO budget may a selection
    // contain the wrapped row's figures without the head of its label — that
    // is the mid-row split this module is built to make impossible.
    const whole = normaliseFilingText(HLX).length;
    for (let budget = 500; budget <= whole + 500; budget += 250) {
      const selection = selectSectionsForAnalysis(HLX, { maxChars: budget });
      assert.ok(
        selection.totalChars <= budget,
        `budget ${budget} overspent: ${selection.totalChars}`,
      );
      if (selection.text.includes(AR_VALUE_2025)) {
        assert.ok(
          selection.text.includes(AR_LABEL_HEAD),
          `budget ${budget} kept the figure and dropped its label`,
        );
        assert.ok(
          selection.text.includes("respectively"),
          `budget ${budget} cut the row's label tail`,
        );
      }
    }
  });

  it("emits sections in document order, never re-ordered by score", () => {
    const selection = selectSectionsForAnalysis(HLX, { maxChars: 5_000 });
    const indexes = selection.selectedSectionIndexes;
    assert.deepEqual(
      indexes,
      [...indexes].sort((a, b) => a - b),
    );
  });
});

describe("selectSectionsForAnalysis — a 1.7 MB document", () => {
  /**
   * Built by repeating the real excerpts to the size of the largest object
   * measured (1,748,415 bytes). The BYTES are real; only the repetition is
   * synthetic, which keeps a 1.7 MB blob out of the repository while still
   * exercising the path that blob is the reason for.
   */
  const huge = (() => {
    const unit = [HLX, HECLA, BIP].join("\n\n");
    const copies = Math.ceil(1_748_415 / unit.length);
    return Array.from({ length: copies }, () => unit).join("\n\n");
  })();

  it("the fixture really is ~1.7 MB", () => {
    assert.ok(huge.length >= 1_700_000, `only ${huge.length} bytes`);
  });

  it("reduces it to within the default budget", () => {
    const selection = selectSectionsForAnalysis(huge);
    assert.equal(selection.reason, "scored");
    assert.ok(
      selection.totalChars <= DEFAULT_MAX_CHARS,
      `sent ${selection.totalChars} > ${DEFAULT_MAX_CHARS}`,
    );
    assert.ok(selection.totalChars > 0, "reduced the document to nothing");
    // A 97%+ reduction is the point of the module.
    assert.ok(selection.totalChars / huge.length < 0.05);
  });

  it("is DETERMINISTIC — byte-identical across repeated runs", () => {
    const a = selectSectionsForAnalysis(huge);
    const b = selectSectionsForAnalysis(huge);
    assert.deepEqual(a.selectedSectionIndexes, b.selectedSectionIndexes);
    assert.equal(a.text, b.text);
    assert.equal(a.totalChars, b.totalChars);
    assert.equal(a.droppedForBudget, b.droppedForBudget);
  });

  it("reports what it dropped instead of silently sending a thin selection", () => {
    const selection = selectSectionsForAnalysis(huge);
    assert.ok(
      selection.droppedForBudget > 0,
      "dropped nothing from a 1.7 MB document",
    );
    assert.ok(selection.totalSections > selection.sections.length);
    assert.ok(
      selection.selectedSectionIndexes.length === selection.sections.length,
    );
  });

  it("still spends its budget on statements, not prose", () => {
    const selection = selectSectionsForAnalysis(huge);
    // The balance sheet outranks everything else in the corpus, so a correct
    // selection is dominated by it even at 1.7 MB.
    assert.ok(selection.text.includes("Total current assets"));
    assert.ok(selection.text.includes(AR_VALUE_2025));
  });

  it("never emits a partial table row at 1.7 MB either", () => {
    const selection = selectSectionsForAnalysis(huge);
    if (selection.text.includes(AR_VALUE_2025)) {
      assert.ok(selection.text.includes(AR_LABEL_HEAD));
      assert.ok(selection.text.includes("respectively"));
    }
  });
});

describe("selectSectionsForAnalysis — the narrative documents", () => {
  it("returns SOMETHING for a business description with no statements", () => {
    // A selector that banned narrative would return nothing for two of the
    // three real documents measured. Demote, never ban.
    const selection = selectSectionsForAnalysis(HECLA, { maxChars: 2_000 });
    assert.ok(selection.sections.length > 0, "the Business section was banned");
  });

  it("REGRESSION: a small budget does not silently select nothing", () => {
    // Found by this suite, not in review. The Hecla excerpt is ONE 6,618-char
    // section, so with a fixed 12,000-char section cap every section was over
    // a 2,000-char budget and the selection came back EMPTY — no error, no
    // counter, just a document that quietly produced no analysis.
    //
    // resolveSectionCap now keeps the cap under the budget. Swept, because the
    // failure was budget-dependent and a single spot check would have missed
    // it at most sizes.
    for (let budget = 800; budget <= 12_000; budget += 400) {
      const selection = selectSectionsForAnalysis(HECLA, { maxChars: budget });
      assert.ok(
        selection.sections.length > 0,
        `budget ${budget} selected nothing from a 6.6 KB document`,
      );
      assert.ok(selection.totalChars <= budget);
      assert.ok(selection.totalChars > 0);
    }
  });

  it("resolveSectionCap never exceeds the budget it is given", () => {
    for (const budget of [1, 100, 1_000, 24_000, 60_000, 1_000_000]) {
      const cap = resolveSectionCap(budget);
      assert.ok(cap >= 1);
      assert.ok(cap <= MAX_SECTION_CHARS);
      assert.ok(cap <= Math.max(1, budget), `cap ${cap} > budget ${budget}`);
    }
  });

  it("passes a small circular whole rather than scoring it to nothing", () => {
    const selection = selectSectionsForAnalysis(BIP);
    assert.equal(selection.reason, "all-fit");
    assert.ok(selection.text.includes("NOTICE OF SPECIAL MEETING"));
  });
});
