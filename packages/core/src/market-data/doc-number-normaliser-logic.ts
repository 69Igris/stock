/**
 * Repairing what pdf-inspector's markdown gets wrong — MONEY-1314.
 *
 * PURE. Every rule below comes from MEASURING 20,267 numeric table cells
 * across 1,307 tables in 26 real filings, and the two most important
 * conclusions are NEGATIVE — rules that seemed obviously right and would have
 * corrupted more than they fixed.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE RULE THIS MODULE DELIBERATELY DOES NOT CONTAIN
 * ═══════════════════════════════════════════════════════════════════════
 *
 * "A digit, a comma, a space, a digit is a broken number — rejoin it."
 * (`11, 0 9 0` -> `11,090`.) That shape is essentially ABSENT from the real
 * corpus. Searching the extracted markdown for it returns, overwhelmingly:
 *
 *     "31, 2025"  "27, 2025"                 <- "March 31, 2025"
 *     "128, 129"  "130, 138, 141, 147"       <- page-reference lists
 *     "12003, 21002, 46307"                  <- NIC product codes
 *     "+91 33 2288 9371"                     <- phone numbers
 *
 * True digit-splits total ~15-20 cells, about 0.1%. So the rule would have
 * silently rewritten dates, contents pages and telephone numbers into
 * nonsense across the entire corpus in order to fix one cell in a thousand.
 * It is named here so it does not get "added back" as an oversight.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DEFECT THAT CANNOT BE REPAIRED, ONLY DETECTED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Digits migrate ACROSS cell boundaries — 33 cells, 0.17%:
 *
 *     |Revenue from Operations|12,680.65 10,377.010|9,391.26 0|44,271.73 6|
 *     |Other Income|52.977 72.154|41.424|196.82|160.64|8|4|
 *
 * `196.82` and `160.64` are left looking like perfectly valid numbers. There
 * is NO local signal that they are truncated — only the orphan `8` and `4` in
 * a neighbouring cell reveal it.
 *
 * And it cannot be fixed from the markdown, because the fragmentation is in
 * the PDF's OWN TEXT RUNS: `extractTextWithPositions` shows two different
 * columns reporting x-coordinates within 1.4 pt of each other, and the whole
 * content stream drawn twice at a 0.003 pt y-offset. Arithmetic cross-checks
 * fail on any naive rejoin — concatenating the orphans gives 9,432.684 against
 * a printed total of 9,432.689.
 *
 * So `detectOrphanDigits` returns a FINDING, and a table carrying one is
 * marked low-confidence and failed over to the vision lane, which rasterises
 * and reads what is visually on the page. Repairing it would produce numbers
 * that are wrong in a way nothing downstream could ever notice.
 */

/** U+0060. What the legacy `RupeeForadian` font emits instead of U+20B9. */
export const BACKTICK = "`";
export const RUPEE = "₹";

/**
 * Words that follow a currency symbol in an Indian filing's scale header.
 * Used as context, because the backtick is not distinguishable by font: the
 * MAJORITY of corrupted occurrences come from ordinary runs (`Lato-Regular`,
 * `Helvetica`), not from the Rupee font itself.
 */
const SCALE_WORDS =
  "crores?|crs?|lakhs?|lacs?|millions?|billions?|thousands?|mn|bn|per\\s+share|per\\s+annum|each";

/**
 * Replace the backtick-as-rupee, in context.
 *
 * MEASURED: 89-99.5% of rupee signs arrive as U+0060 (ITC 1,094 of 1,100;
 * AXISBANK 840 of 946; TCS 578 of 626). Zero U+FFFD anywhere, so this is a
 * font-mapping artefact rather than an encoding failure.
 *
 * CONTEXT-GATED, never a blanket replace. A backtick is also legitimate
 * markdown, and the corpus contains code-like fragments. The gate is: a
 * backtick immediately followed by a digit, an opening paren, or a scale word
 * — which covers 90.1% (ITC) / 94.0% (AXISBANK) of all backticks present.
 *
 * This ALSO repairs the markdown itself. Backticks pair into inline code
 * spans, so the prose between two rupee amounts was silently becoming
 * `<code>`; replacing them removes the spurious span as a side effect, which
 * is why this runs BEFORE any table parsing.
 */
export function normaliseRupeeSign(text: string): string {
  return (
    text
      // `1,234  `(  `30 per equity share
      .replace(new RegExp(BACKTICK + "(?=\\s*[\\d(])", "g"), RUPEE)
      // `in crores)   ` per annum   ` Crs
      //
      // The optional `in\s+` matters: the single most common scale header in
      // the corpus is "(` in crores)", where the backtick is followed by the
      // word "in" and not by the scale word itself. A pattern anchored straight
      // onto the scale word misses it — and misses the one occurrence that
      // determines how every figure on the page is interpreted.
      .replace(
        new RegExp(
          BACKTICK + "(?=\\s*(?:in\\s+)?(?:" + SCALE_WORDS + ")\\b)",
          "gi",
        ),
        RUPEE,
      )
  );
}

/**
 * Rejoin a number whose DECIMAL POINT was split by spaces.
 *
 * The ONE repair that is safe, and it is narrow on purpose:
 *
 *     "37. 5 4"    -> "37.54"
 *     "3 5 47. 28" -> "3547.28"
 *     "6 67. 27"   -> "667.27"
 *     "07 5 16."   -> "7516."
 *
 * REFUSED, and this is the case the narrowness exists for:
 *
 *     "21,88,211.30 27,77,153.30"  -> unchanged (TWO numbers, not one broken)
 *
 * The discriminator is the decimal-point COUNT. A cell holding two complete
 * numbers has two of them; a cell holding one broken number has at most one.
 * A rule written on spaces alone concatenates the pair into
 * `21,88,211.3027,77,153.30`, which is not merely wrong but wrong by a factor
 * of a hundred million while still parsing as a number.
 *
 * Returns the input unchanged when it does not match — never null, so callers
 * cannot accidentally drop a cell they meant to keep.
 */
export function repairBrokenDecimal(cell: string): string {
  const s = cell.trim();
  if (!s) return cell;

  // Exactly one decimal point, only digits/commas/spaces/sign otherwise, and
  // at least one internal space to repair.
  if ((s.match(/\./g) ?? []).length !== 1) return cell;
  if (
    !/^-?[\d,]+(?:\s+[\d,]+)*\s*\.\s*[\d\s]*$|^-?[\d,\s]+\.\s*\d[\d\s]*$/.test(
      s,
    )
  ) {
    return cell;
  }
  if (!/\d\s+\d|\d\s+\.|\.\s+\d/.test(s)) return cell;

  const joined = s.replace(/\s+/g, "");
  // Sanity: the repair must not invent or lose digits.
  const digitsBefore = (s.match(/\d/g) ?? []).length;
  const digitsAfter = (joined.match(/\d/g) ?? []).length;
  return digitsBefore === digitsAfter ? joined : cell;
}

/**
 * Does this cell show a digit that migrated across a column boundary?
 *
 * Two mirrored shapes, both measured:
 *
 *     "9,391.26 0"    a complete number with 1-2 orphan digits AFTER it
 *     "2 8,679.12"    1-2 orphan digits BEFORE a complete number
 *
 * A match means the TABLE is untrustworthy, not just the cell: the digits went
 * somewhere, and the cells they left are the ones that still look valid.
 */
export function detectOrphanDigits(cell: string): boolean {
  const s = cell.trim();
  if (!s) return false;
  // trailing orphan: <number with decimals> <1-2 digits>
  if (/^-?[\d,]+\.\d+\s+\d{1,2}$/.test(s)) return true;
  // leading orphan: <1-2 digits> <number with decimals>
  if (/^\d{1,2}\s+-?[\d,]+\.\d+$/.test(s)) return true;
  return false;
}

/**
 * Does this cell hold SEVERAL columns merged into one?
 *
 * 587 cells, 2.90% of numeric cells — the dominant table defect. Three or more
 * whitespace-separated complete numbers in one cell is the signal:
 *
 *     "2183.04 7.22 158.23 60.57 70.07 4.26 295.20 595.55 1587.49 10.51 1576.98"
 *
 * NOT repaired. Splitting them requires knowing which column each belongs to,
 * which is exactly the information the extractor lost. Reported so the table's
 * confidence reflects it.
 */
export function detectMergedColumns(cell: string): boolean {
  const s = cell.trim();
  if (!s) return false;
  const parts = s.split(/\s+/);
  if (parts.length < 3) return false;
  return parts.every((p) => /^-?\(?[\d,]+(?:\.\d+)?\)?$/.test(p));
}

export interface TableFinding {
  orphanDigitCells: number;
  mergedColumnCells: number;
  /** Rows whose cell count disagrees with the header's. 67.6% of tables. */
  raggedRows: number;
  totalCells: number;
}

/**
 * Assess one markdown table.
 *
 * `ragged` is measured but is NOT on its own a reason to distrust a table —
 * 67.6% of emitted tables are ragged, so treating it as disqualifying would
 * reject two thirds of the corpus. It is reported for the confidence score and
 * for the operator, not used as a gate.
 */
export function assessTable(tableMarkdown: string): TableFinding {
  const rows = tableMarkdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));

  const cellsOf = (row: string): string[] =>
    row.replace(/^\||\|$/g, "").split("|");

  const headerWidth = rows[0] !== undefined ? cellsOf(rows[0]).length : 0;
  let orphanDigitCells = 0;
  let mergedColumnCells = 0;
  let raggedRows = 0;
  let totalCells = 0;

  for (const row of rows) {
    // The `|---|---|` separator is structure, not data.
    if (/^\|[\s:|-]+\|?$/.test(row)) continue;
    const cells = cellsOf(row);
    if (cells.length !== headerWidth) raggedRows++;
    for (const c of cells) {
      totalCells++;
      if (detectOrphanDigits(c)) orphanDigitCells++;
      if (detectMergedColumns(c)) mergedColumnCells++;
    }
  }

  return { orphanDigitCells, mergedColumnCells, raggedRows, totalCells };
}

export interface NormalisedDocument {
  markdown: string;
  findings: TableFinding;
  /**
   * True when the document should go to the VISION lane instead, because a
   * value somewhere in it is silently truncated.
   */
  failOverToVision: boolean;
  reason: string | null;
}

/**
 * Normalise a whole converted document.
 *
 * Order matters: the rupee repair runs FIRST, over the raw text, because it
 * also closes the spurious markdown code spans that the stray backticks open —
 * and a code span swallows the pipes of any table caught inside it.
 */
export function normaliseDocumentMarkdown(raw: string): NormalisedDocument {
  const markdown = normaliseRupeeSign(raw);
  const findings = assessTable(markdown);

  // ONE orphan is enough. The cell that shows the defect is not the cell that
  // was damaged by it — the damaged cells still parse as valid numbers — so
  // "a few is fine" is not available as a policy here.
  const failOverToVision = findings.orphanDigitCells > 0;

  return {
    markdown,
    findings,
    failOverToVision,
    reason: failOverToVision
      ? `${findings.orphanDigitCells} cell(s) show digits that migrated across a ` +
        "column boundary — other cells in this table are silently truncated and " +
        "still parse as valid numbers, so the markdown cannot be trusted"
      : null,
  };
}
