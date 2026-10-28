/**
 * WHICH PAGES of a converted filing get sent to the model — MONEY-1314.
 *
 * An Indian annual report runs 100-300 pages. The financial statements occupy
 * maybe 10-25 of them; the rest is the Directors' Report, the Management
 * Discussion, the Business Responsibility & Sustainability Report and the
 * notice of AGM. Sending the whole document spends input tokens on prose that
 * cannot contain a single figure we extract, and — the part that is easy to
 * forget — it also spends ACCURACY: every distractor table is another thing the
 * model can read a number out of.
 *
 * So this module ranks pages and hands back the best {@link DEFAULT_MAX_CHARS}
 * worth. Its output is the `markdown` field of the online request built by
 * `workers/src/lib/gemini-doc-request-logic.ts`.
 *
 * PURE LEAF, and deliberately the purest one in this directory: ZERO imports,
 * no I/O, no clock, no randomness. Every function is a function of its
 * arguments, so the worker's production path and the tests run the same code
 * and a fixture is a complete description of a run.
 *
 * ## What this heuristic can and cannot do
 *
 * Stated up front, because a check believed to be stronger than it is costs
 * more than no check at all (MONEY-1234):
 *
 *   - It selects PAGES, never parts of pages. A half table is worse than no
 *     table: the model reads the surviving rows confidently and the arithmetic
 *     gate downstream cannot tell a truncated statement from a complete one —
 *     the numbers it does see are internally consistent. So a page is in or
 *     out, and a page larger than the whole budget is simply out. See
 *     {@link selectPagesForExtraction}.
 *   - Mis-selection is NOT caught downstream. The validation gate catches
 *     arithmetic nonsense; it cannot catch a wrong-but-consistent period read
 *     off the wrong statement. The caller's retry path (whole-PDF vision) is
 *     what covers a bad selection, and it can only fire if it is told the
 *     selection was thin — hence {@link PageSelection.droppedForBudget} and
 *     `reason`, which exist to be READ, not to be logged and ignored.
 *   - It is a heuristic over conversion output, so it inherits conversion
 *     damage. A statement page whose heading was lost in conversion is scored
 *     on table density alone, which is exactly why density is a term and not a
 *     tie-break.
 *
 * ## Why several signals, none of them sufficient
 *
 *   1. HEADINGS are the strongest signal — Schedule III fixes the statement
 *      titles, so "Consolidated Balance Sheet as at 31 March 2025" is not a
 *      phrase that occurs by accident. But headings alone rank a table of
 *      contents and a section divider above a real statement.
 *   2. TABLE DENSITY covers the continuation pages, which carry no heading at
 *      all. A statement running to four pages has one heading and three pages
 *      that look like nothing but numbers.
 *   3. ADJACENCY covers the continuation page that is dense but sits just under
 *      whatever density threshold you pick. Bounded, because "the next page
 *      too" applied without a bound is "the whole document".
 *   4. NEGATIVE MARKERS demote the narrative sections. They must DEMOTE and
 *      never BAN: the Directors' Report routinely prints a "Financial Results"
 *      summary table, and for a results filing (as opposed to an annual report)
 *      that table can be the only statement in the document.
 *
 * ## Scoring, in one place
 *
 * All four terms are integers, so a score is an integer and two scores are
 * compared exactly. No float accumulates across pages, and there is no
 * ordering that depends on the tenth decimal of a ratio.
 *
 *   heading    {@link HEADING_POINTS} when a Schedule III heading is present
 *              AND the page carries enough numeric cells to corroborate it;
 *              {@link HEADING_UNCORROBORATED_POINTS} when it does not.
 *   density    tableRatio x {@link DENSITY_POINTS_MAX}, rounded.
 *   numbers    numericCells / {@link NUMERIC_SATURATION_CELLS} x
 *              {@link NUMERIC_POINTS_MAX}, rounded, saturating.
 *   narrative  minus {@link NARRATIVE_PENALTY}, once, however many markers
 *              matched.
 *   adjacency  plus {@link CONTINUATION_BONUS} for a table-dense page directly
 *              after a statement page, at most {@link CONTINUATION_MAX_RUN} in
 *              a row.
 */

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/** One converted page. `pageNumber` is 1-based and comes from the converter. */
export interface DocPage {
  pageNumber: number;
  markdown: string;
}

/**
 * Why a selection looks the way it does.
 *
 *   "empty"    the caller passed no pages. Nothing was measured.
 *   "all-fit"  the whole document fits under the cap, so nothing was scored
 *              and nothing was dropped. See {@link selectPagesForExtraction}
 *              for why the heuristic is skipped entirely in this case.
 *   "scored"   the document did not fit; pages were ranked and cut.
 */
export type PageSelectionReason = "all-fit" | "scored" | "empty";

export interface PageSelection {
  /** The chosen pages, ALWAYS in ascending `pageNumber`. */
  pages: DocPage[];
  /** Sum of `markdown.length` over {@link PageSelection.pages}. Joining
   *  separators are the caller's and are not counted here. */
  totalChars: number;
  /** `pages.map(p => p.pageNumber)`, ascending. Carried separately so a caller
   *  can log or persist the selection without holding the markdown. */
  selectedPageNumbers: number[];
  /**
   * Pages that scored ABOVE ZERO and still did not fit.
   *
   * This is the number an operator uses to decide whether the cap is too
   * tight, so it is deliberately not "pages not selected": a page that scored
   * zero was never wanted and counting it would make every 300-page report
   * look starved. Always 0 for "all-fit" and "empty".
   */
  droppedForBudget: number;
  reason: PageSelectionReason;
}

/** The Schedule III / results-filing statement titles this module knows. */
export type StatementHeadingId =
  | "balance-sheet"
  | "profit-and-loss"
  | "cash-flow"
  | "changes-in-equity"
  | "notes"
  | "financial-results"
  | "assets-and-liabilities";

/** The narrative sections that are demoted (never banned). */
export type NarrativeSectionId =
  | "auditors-report"
  | "directors-report"
  | "agm-notice"
  | "corporate-governance"
  | "management-discussion"
  | "business-responsibility";

/** What {@link measureTables} found on one page. */
export interface TableMeasure {
  /** Lines with any non-whitespace content. */
  nonBlankLines: number;
  /** Non-blank lines that begin with a `|`, separator rows included. */
  tableLines: number;
  /** `tableLines / nonBlankLines`, or 0 for a blank page. */
  tableRatio: number;
  /** Cells that {@link isNumericCell} accepts, separator rows excluded. */
  numericCells: number;
}

/** The full, inspectable reasoning for one page. Also the operator's log line. */
export interface PageScore {
  pageNumber: number;
  /**
   * Position in the page-number-ascending ordering.
   *
   * The final tie-break, and the only one guaranteed distinct: a converter can
   * in principle emit two entries for one `pageNumber`, and a comparator that
   * returns 0 for two distinct entries is not a total order.
   */
  order: number;
  /** `markdown.length`. The budget is spent in these units. */
  chars: number;
  /** `baseScore + continuationBonus`. Integer. */
  score: number;
  /** Heading + density + numbers + narrative penalty. Integer, may be < 0. */
  baseScore: number;
  headingMatched: StatementHeadingId | null;
  /** Whether the heading was backed by numbers on the same page. */
  headingCorroborated: boolean;
  tableRatio: number;
  numericCells: number;
  narrativeMatched: NarrativeSectionId | null;
  continuationBonus: number;
}

// ---------------------------------------------------------------------------
// CONSTANTS — every one of these is a tuning knob, so every one is exported
// and named. A magic number inside the scorer is a number nobody can test
// against.
// ---------------------------------------------------------------------------

/**
 * ~40,000 chars ≈ ~10k tokens on this content.
 *
 * Sized against the measured alternative rather than picked: the whole-PDF path
 * is ~77.4k input tokens per document (docs/reference/doc-ingest-population.md),
 * so a ~10k selection is the ~8x saving the page-selected lane exists for. It is
 * a CHARACTER cap, not a token cap, because this module must stay free of a
 * tokenizer — and the chars/token ratio on converted statement markdown is
 * denser than prose (3.57 measured on the request prefix, not the 4.0
 * approximation), so a char cap converted at 4.0 UNDERSTATES the tokens. Treat
 * 40k as "about 10-11k tokens", never as an exact budget.
 */
export const DEFAULT_MAX_CHARS = 40_000;

/** A corroborated Schedule III heading. The strongest single signal. */
export const HEADING_POINTS = 100;

/**
 * A heading with no numbers under it: a section divider ("FINANCIAL
 * STATEMENTS"), a running header, or a contents entry.
 *
 * Deliberately small but NOT zero. Such a page is nearly worthless on its own,
 * yet it must still rank above pure prose — and it must never outrank a real
 * statement page, which is the whole reason corroboration exists. The
 * relationship that has to hold is
 * `HEADING_UNCORROBORATED_POINTS < DENSITY_POINTS_MAX`, so that any genuinely
 * table-dense page beats any heading-only page.
 */
export const HEADING_UNCORROBORATED_POINTS = 15;

/** Numeric cells needed before a heading is believed. Four is one small row. */
export const HEADING_CORROBORATION_MIN_NUMERIC_CELLS = 4;

/** Weight of the table-line ratio. */
export const DENSITY_POINTS_MAX = 60;

/** Weight of the raw count of numeric cells. */
export const NUMERIC_POINTS_MAX = 40;

/**
 * Where the numeric-cell term saturates.
 *
 * A real statement page carries 100+ numeric cells (4 columns x 30 rows), so
 * the term must top out well below that or it would just re-measure density. 60
 * is "a substantial table", reached by any real statement page and by no
 * narrative page.
 */
export const NUMERIC_SATURATION_CELLS = 60;

/**
 * The demotion for a narrative section marker. Applied ONCE per page, however
 * many markers match — three matches on one page is one page, and letting it
 * accumulate would make the penalty depend on how chatty a running header is.
 *
 * Sized so that a narrative page carrying a summary table lands BELOW a real
 * continuation page but ABOVE zero, i.e. it stays selectable when the budget
 * has room. That is the "de-prioritise, never ban" requirement expressed as
 * arithmetic: for a results filing the Directors'-Report-adjacent "Financial
 * Results" table can be the only statement in the document.
 */
export const NARRATIVE_PENALTY = 70;

/** Awarded to a table-dense page immediately after a statement page. */
export const CONTINUATION_BONUS = 45;

/**
 * How far a continuation run may reach past ONE statement heading.
 *
 * Bounded because unbounded adjacency is just "send everything": each pulled-in
 * page would be a fresh seed and a document of contiguous tables would cascade
 * to the end. Three is a balance sheet, a P&L or a cash flow in full; the notes
 * run far longer than three pages, and their later pages compete on density
 * like anything else rather than being dragged in by an ancestor 20 pages back.
 */
export const CONTINUATION_MAX_RUN = 3;

/** Density floor for a page to count as a continuation. */
export const CONTINUATION_MIN_TABLE_RATIO = 0.35;

/** Numeric floor for a page to count as a continuation. */
export const CONTINUATION_MIN_NUMERIC_CELLS = 6;

/**
 * Longest line still considered a possible heading.
 *
 * A heading is a heading because it is SHORT. Without this, a paragraph that
 * happens to begin "Balance Sheet as at the reporting date has been prepared
 * on..." matches the same pattern as the heading it is describing. Real
 * headings, including the "(₹ in crore, except per share data)" tail, sit
 * comfortably under this.
 */
export const HEADING_LINE_MAX_CHARS = 160;

// ---------------------------------------------------------------------------
// LINE NORMALISATION
// ---------------------------------------------------------------------------

/** Trim, and fold the non-breaking spaces the PDF converter emits. */
function normaliseLine(line: string): string {
  return line.replace(/\u00a0/g, " ").trim();
}

/**
 * Strip the markdown decoration around a candidate heading.
 *
 * What is deliberately NOT stripped:
 *
 *   - a leading `|`. A line starting with a pipe is a TABLE ROW, and a heading
 *     never lives in a table cell. Stripping it would make a contents page
 *     rendered as a table ("| Balance Sheet | 84 |") match every statement
 *     heading in the document at once.
 *   - a leading `-`/`*` bullet. Same reason from the other direction: a
 *     navigation list is not a statement.
 *   - trailing dot leaders. "Balance Sheet ......... 84" must NOT reduce to
 *     "Balance Sheet"; the leader is the evidence that this is a contents
 *     entry.
 */
export function stripHeadingDecoration(line: string): string {
  let s = normaliseLine(line);
  s = s.replace(/^(?:>\s*)+/, ""); // blockquote
  s = s.replace(/^#{1,6}\s+/, ""); // atx heading
  s = s.replace(/^#{1,6}(?=\S)/, ""); // atx heading with no space after the #
  s = s.replace(/\s*#+$/, ""); // closing atx
  s = s.replace(/^(?:\*\*|__)/, "").replace(/(?:\*\*|__)$/, ""); // bold
  s = s.replace(/[\s:*]+$/, ""); // trailing colon / emphasis / footnote star
  return s.trim();
}

// ---------------------------------------------------------------------------
// SCHEDULE III HEADINGS
// ---------------------------------------------------------------------------

/**
 * Qualifiers that may precede a statement title, in any run of up to three:
 * "Consolidated Unaudited Financial Results" is three words of qualifier.
 */
const QUALIFIER = String.raw`(?:(?:consolidated|standalone|unaudited|audited|abridged|condensed|interim|reviewed|summarised|summarized)\s+){0,3}`;

/**
 * What may follow a statement title.
 *
 * Exactly two shapes are allowed, and the restriction is the point — this is
 * what separates a heading from a contents entry and from a sentence:
 *
 *   - a date clause: "as at 31 March 2025", "for the year ended ...";
 *   - an annotation opened by punctuation: " (₹ in crore)", " - Contd.",
 *     ": Consolidated".
 *
 * " ......... 84" opens with neither, so a contents line does not match. Nor
 * does " reflects total assets of ₹19,768 crore", which is how the same words
 * appear inside the Directors' Report.
 */
const HEADING_TAIL = String.raw`(?:\s*[-–—:,(\[/].*|\s+(?:as\s+at|as\s+on|as\s+of|for\s+the|for\s+quarter|for\s+year|for\s+period|of\s+the)\b.*)?`;

const STATEMENT_HEADING_BODIES: ReadonlyArray<{
  id: StatementHeadingId;
  body: string;
}> = [
  { id: "balance-sheet", body: String.raw`balance\s+sheets?` },
  {
    id: "profit-and-loss",
    body: String.raw`(?:statements?\s+of\s+profit\s+(?:and|&|or)\s+loss(?:\s+and\s+other\s+comprehensive\s+income)?(?:\s+account)?|profit\s+(?:and|&)\s+loss\s+(?:account|statement))`,
  },
  {
    id: "cash-flow",
    body: String.raw`(?:cash\s+flows?\s+statements?|statements?\s+of\s+cash\s+flows?)`,
  },
  {
    id: "changes-in-equity",
    body: String.raw`statements?\s+of\s+changes\s+in\s+equity`,
  },
  {
    // "Notes to the Consolidated Financial Statements" puts the basis INSIDE
    // the title, where the leading QUALIFIER run cannot reach it.
    id: "notes",
    body: String.raw`notes?\s+(?:to|forming\s+part\s+of)(?:\s+and\s+forming\s+part\s+of)?\s+(?:the\s+)?(?:consolidated\s+|standalone\s+)?(?:financial\s+statements?|accounts|financial\s+information)`,
  },
  { id: "financial-results", body: String.raw`financial\s+results` },
  {
    id: "assets-and-liabilities",
    body: String.raw`statements?\s+of\s+assets\s+and\s+liabilities`,
  },
];

/**
 * Compiled once at module load.
 *
 * The `(?:statements? of )?` between the two QUALIFIER runs is what makes
 * "Statement of Unaudited Financial Results" reachable — the qualifier sits
 * between "Statement of" and the title, not before it.
 */
const STATEMENT_HEADING_PATTERNS: ReadonlyArray<{
  id: StatementHeadingId;
  pattern: RegExp;
}> = STATEMENT_HEADING_BODIES.map(({ id, body }) => ({
  id,
  pattern: new RegExp(
    `^${QUALIFIER}(?:statements?\\s+of\\s+)?${QUALIFIER}${body}${HEADING_TAIL}$`,
    "i",
  ),
}));

/**
 * The Schedule III title this line IS, or null.
 *
 * Note the word IS. This is a whole-line test, not a search: the line must be
 * the heading, not merely contain the words. Returns the first match in
 * declaration order, so the result is deterministic when two patterns could
 * both match.
 */
export function matchStatementHeading(line: string): StatementHeadingId | null {
  const normalised = normaliseLine(line);
  // A table row is never a heading — see stripHeadingDecoration.
  if (normalised.startsWith("|")) return null;
  if (normalised.length > HEADING_LINE_MAX_CHARS) return null;
  const stripped = stripHeadingDecoration(normalised);
  if (stripped === "") return null;
  for (const { id, pattern } of STATEMENT_HEADING_PATTERNS) {
    if (pattern.test(stripped)) return id;
  }
  return null;
}

/** The first Schedule III heading on the page, or null. */
export function findStatementHeading(
  markdown: string,
): StatementHeadingId | null {
  for (const raw of markdown.split(/\r?\n/)) {
    const hit = matchStatementHeading(raw);
    if (hit !== null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// NARRATIVE SECTIONS (negative signals)
// ---------------------------------------------------------------------------

/**
 * Anchored at the START of a stripped line, deliberately.
 *
 * Matching anywhere in the page text would demote a genuine notes page for
 * saying "as reported in the Independent Auditor's Report" — a sentence that
 * appears in real notes. What identifies a narrative PAGE is the section title
 * or the running header, both of which begin their line.
 *
 * The tail is left open (no `$`), because these headers carry continuations
 * ("Independent Auditor's Report (Contd.)") and addressees ("Directors' Report
 * to the Members").
 */
const NARRATIVE_SECTION_PATTERNS: ReadonlyArray<{
  id: NarrativeSectionId;
  pattern: RegExp;
}> = [
  {
    id: "auditors-report",
    pattern: /^(?:the\s+)?independent\s+auditor(?:['’]s|s['’]?)?\s+report\b/i,
  },
  {
    id: "auditors-report",
    pattern: /^report\s+of\s+the\s+independent\s+auditors?\b/i,
  },
  {
    id: "directors-report",
    pattern: /^(?:board(?:['’]s)?\s+)?directors?(?:['’]s?)?\s+report\b/i,
  },
  {
    id: "directors-report",
    pattern: /^report\s+of\s+the\s+(?:board\s+of\s+)?directors\b/i,
  },
  { id: "directors-report", pattern: /^board(?:['’]s)?\s+report\b/i },
  { id: "agm-notice", pattern: /^notice\b.*annual\s+general\s+meeting/i },
  { id: "agm-notice", pattern: /^notice\s+of\s+(?:the\s+)?agm\b/i },
  {
    id: "corporate-governance",
    pattern: /^(?:report\s+on\s+)?corporate\s+governance\b/i,
  },
  { id: "management-discussion", pattern: /^management\s+discussion\b/i },
  {
    id: "business-responsibility",
    pattern: /^business\s+responsibility\b/i,
  },
];

/** The narrative section this line announces, or null. */
export function matchNarrativeSection(line: string): NarrativeSectionId | null {
  const normalised = normaliseLine(line);
  if (normalised.startsWith("|")) return null;
  if (normalised.length > HEADING_LINE_MAX_CHARS) return null;
  const stripped = stripHeadingDecoration(normalised);
  if (stripped === "") return null;
  for (const { id, pattern } of NARRATIVE_SECTION_PATTERNS) {
    if (pattern.test(stripped)) return id;
  }
  return null;
}

/** The first narrative section marker on the page, or null. */
export function findNarrativeSection(
  markdown: string,
): NarrativeSectionId | null {
  for (const raw of markdown.split(/\r?\n/)) {
    const hit = matchNarrativeSection(raw);
    if (hit !== null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TABLE DENSITY
// ---------------------------------------------------------------------------

/** `| --- | :--: |` and friends: structure, never data. */
export function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]*\|?$/.test(normaliseLine(line));
}

/** Cells of a markdown table row, outer empties dropped, each trimmed. */
export function splitTableRow(line: string): string[] {
  const parts = normaliseLine(line).split("|");
  if (parts.length > 0 && (parts[0] ?? "").trim() === "") parts.shift();
  if (parts.length > 0 && (parts[parts.length - 1] ?? "").trim() === "") {
    parts.pop();
  }
  return parts.map((p) => p.trim());
}

/**
 * Does this cell hold a FIGURE?
 *
 * The cleanup ahead of the test is not cosmetic — it is the conversion damage
 * catalogued in the request prompt's worked example 4, and each item is a cell
 * that would otherwise be scored as prose:
 *
 *   - "11, 0 9 0" — digit groups split by the PDF text layer (1.21% of table
 *     numbers, measured). Hence spaces are permitted INSIDE the number.
 *   - "`4,935" / "₹4,935" — the rupee glyph renders as a backtick or vanishes.
 *   - "4,935*" — a footnote marker glued to the figure.
 *   - "(1,234)" — the accounting negative.
 *
 * What must stay REJECTED, and why the test is anchored rather than a search:
 * "Note 3" and "31 March 2025" both contain digits and neither is a figure. A
 * `\d` test alone would score a statement's own column headers as data and,
 * worse, would make a page of prose with numbered paragraphs look like a table.
 */
export function isNumericCell(cell: string): boolean {
  const cleaned = cell
    .replace(/\u00a0/g, " ")
    .replace(/[₹`$]/g, "")
    .replace(/\b(?:rs|inr)\.?/gi, "")
    .replace(/[*†‡]/g, "")
    .trim();
  if (!/\d/.test(cleaned)) return false;
  return /^\(?\s*[-–—+]?\s*\d[\d,\s.]*\)?\s*%?$/.test(cleaned);
}

/**
 * Table density and numeric weight of one page.
 *
 * Separator rows COUNT as table lines (they are table structure and their
 * presence is evidence of a table) but contribute no numeric cells.
 */
export function measureTables(markdown: string): TableMeasure {
  let nonBlankLines = 0;
  let tableLines = 0;
  let numericCells = 0;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = normaliseLine(raw);
    if (line === "") continue;
    nonBlankLines += 1;
    if (!line.startsWith("|")) continue;
    tableLines += 1;
    if (isSeparatorRow(line)) continue;
    for (const cell of splitTableRow(line)) {
      if (isNumericCell(cell)) numericCells += 1;
    }
  }

  return {
    nonBlankLines,
    tableLines,
    tableRatio: nonBlankLines === 0 ? 0 : tableLines / nonBlankLines,
    numericCells,
  };
}

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------

/** Density term. Integer. */
export function densityPoints(measure: TableMeasure): number {
  return Math.round(measure.tableRatio * DENSITY_POINTS_MAX);
}

/** Numeric-weight term, saturating. Integer. */
export function numericPoints(measure: TableMeasure): number {
  const capped = Math.min(measure.numericCells, NUMERIC_SATURATION_CELLS);
  return Math.round((capped / NUMERIC_SATURATION_CELLS) * NUMERIC_POINTS_MAX);
}

/**
 * Is this page dense enough to be a statement's continuation?
 *
 * Both floors, not either: a page of ten one-cell table lines clears the ratio
 * and carries no data, and a paragraph quoting six figures clears the cell
 * count and is prose.
 */
export function isContinuationCandidate(score: PageScore): boolean {
  return (
    score.tableRatio >= CONTINUATION_MIN_TABLE_RATIO &&
    score.numericCells >= CONTINUATION_MIN_NUMERIC_CELLS
  );
}

/**
 * May this page START a continuation run?
 *
 * Only a corroborated statement heading with no narrative marker on it. Two
 * consequences worth being explicit about:
 *
 *   - A page pulled in BY a run is never itself a seed. Seeds are computed
 *     from base scores before any bonus is awarded, so a run can never exceed
 *     CONTINUATION_MAX_RUN pages by chaining through its own output.
 *   - The Directors' Report page carrying a "Financial Results" table does not
 *     seed. It is a real heading, but the page after it is more Directors'
 *     Report, and dragging that in is the exact waste this module exists to
 *     avoid.
 */
export function isContinuationSeed(score: PageScore): boolean {
  return (
    score.headingMatched !== null &&
    score.headingCorroborated &&
    score.narrativeMatched === null
  );
}

/**
 * Total order over candidates: score DESC, then pageNumber ASC, then order ASC.
 *
 * Never returns 0 for two distinct pages. That is the property, not an
 * implementation detail — `Array.prototype.sort` being stable in modern V8
 * makes an incomplete comparator LOOK deterministic while leaving the outcome
 * dependent on the order the caller happened to build its array in. The
 * `order` term is the guarantee, because two entries can legitimately share a
 * `pageNumber` if the converter emitted one.
 */
export function compareCandidates(a: PageScore, b: PageScore): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
  return a.order - b.order;
}

interface OrderedPage {
  page: DocPage;
  order: number;
}

/**
 * Ascending by pageNumber, ties by input position (Array#sort is stable).
 *
 * A converter emits pages in order, but this module must not DEPEND on that:
 * adjacency and the emit order are both defined in terms of page numbers, so
 * a caller that concatenated two ranges out of order still gets a correct
 * selection instead of a silently different one.
 */
function orderPages(pages: readonly DocPage[]): OrderedPage[] {
  for (const page of pages) {
    if (
      !Number.isFinite(page.pageNumber) ||
      !Number.isInteger(page.pageNumber)
    ) {
      // Loud, because the alternative is a page silently missing from a
      // financial statement. NaN also poisons every comparison it touches:
      // NaN - x is NaN, so a single bad entry makes the whole sort meaningless
      // rather than making one page wrong.
      throw new TypeError(
        `page-select: pageNumber must be a finite integer, received ${String(page.pageNumber)}`,
      );
    }
    if (typeof page.markdown !== "string") {
      throw new TypeError(
        `page-select: page ${page.pageNumber} has no markdown string`,
      );
    }
  }
  return [...pages]
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page, order) => ({ page, order }));
}

function scoreOrdered(ordered: readonly OrderedPage[]): PageScore[] {
  const scores: PageScore[] = ordered.map(({ page, order }) => {
    const measure = measureTables(page.markdown);
    const headingMatched = findStatementHeading(page.markdown);
    const narrativeMatched = findNarrativeSection(page.markdown);
    const headingCorroborated =
      measure.numericCells >= HEADING_CORROBORATION_MIN_NUMERIC_CELLS;

    let baseScore = 0;
    if (headingMatched !== null) {
      baseScore += headingCorroborated
        ? HEADING_POINTS
        : HEADING_UNCORROBORATED_POINTS;
    }
    baseScore += densityPoints(measure);
    baseScore += numericPoints(measure);
    // Once per page, not once per marker.
    if (narrativeMatched !== null) baseScore -= NARRATIVE_PENALTY;

    return {
      pageNumber: page.pageNumber,
      order,
      chars: page.markdown.length,
      score: baseScore,
      baseScore,
      headingMatched,
      headingCorroborated,
      tableRatio: measure.tableRatio,
      numericCells: measure.numericCells,
      narrativeMatched,
      continuationBonus: 0,
    };
  });

  // ADJACENCY, second pass. Seeds come from the base scores above, so nothing
  // awarded here can create a new seed.
  const bonus = new Array<number>(scores.length).fill(0);
  for (const seed of scores) {
    if (!isContinuationSeed(seed)) continue;
    let previous = seed;
    for (let step = 1; step <= CONTINUATION_MAX_RUN; step += 1) {
      const next = scores[seed.order + step];
      if (next === undefined) break;
      // "Immediately following" means page N+1, not "the next array entry" —
      // a caller may hand us a subset with gaps in it.
      if (next.pageNumber !== previous.pageNumber + 1) break;
      // A page that announces a narrative section is not a continuation of a
      // statement, however dense it is. Statements end.
      if (next.narrativeMatched !== null) break;
      // Nor is a page that announces a STATEMENT OF ITS OWN. It follows the
      // seed and it is dense, but it stands on its own heading — a Cash Flow
      // statement after a Balance Sheet is the next statement, not page 2 of
      // the previous one.
      //
      // Awarding it the adjacency bonus was harmless while the bonus was only
      // a score nudge. It stops being harmless the moment a continuation is
      // treated as DEPENDENT on its predecessor for selection: this page would
      // be dropped whenever the (larger) statement above it did not fit, which
      // is precisely when it is most needed.
      if (next.headingMatched !== null) break;
      if (!isContinuationCandidate(next)) break;
      // SET, never accumulate: two statements ending back to back must not
      // pay a page twice for one adjacency.
      bonus[next.order] = CONTINUATION_BONUS;
      previous = next;
    }
  }

  return scores.map((score) => {
    const continuationBonus = bonus[score.order] ?? 0;
    return {
      ...score,
      continuationBonus,
      score: score.baseScore + continuationBonus,
    };
  });
}

/**
 * Score every page, ascending by page number. Exported for operators and for
 * tests: the selection below is nothing but a budget applied to this.
 */
export function scorePages(pages: readonly DocPage[]): PageScore[] {
  return scoreOrdered(orderPages(pages));
}

function resolveMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined) return DEFAULT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    // Not a silent fall back to the default. A NaN or 0 budget means the
    // caller computed one wrongly, and quietly substituting a working value
    // would hide that forever behind a selection that looks fine.
    throw new TypeError(
      `page-select: maxChars must be a finite positive number, received ${String(maxChars)}`,
    );
  }
  return maxChars;
}

/**
 * Choose the pages worth sending.
 *
 * Three behaviours, in the order they are decided:
 *
 *   1. NO PAGES → `reason: "empty"`. Nothing measured, nothing claimed.
 *   2. THE WHOLE DOCUMENT FITS → every page, ascending, `reason: "all-fit"`,
 *      and the heuristic is not consulted at all. This is deliberate: when
 *      there is nothing to gain by dropping a page, dropping one can only
 *      lose — a two-page results filing whose statement heading was mangled in
 *      conversion still arrives complete.
 *   3. OTHERWISE → score, take the best that fit, `reason: "scored"`.
 *
 * The budget walk is first-fit over the score ranking: a page that does not fit
 * is SKIPPED and the walk continues, rather than stopping the walk. Both
 * choices lose something and this one loses less — stopping early leaves budget
 * unspent and drops strictly more pages, and the pages that then fill the tail
 * are the smaller ones, which is what a statement's continuation pages tend to
 * be.
 *
 * A page is NEVER truncated to fit. Half a table produces a plausible,
 * internally consistent, wrong extract, and nothing downstream can tell it from
 * a whole one. A page bigger than the entire budget is therefore simply
 * dropped, and counted in `droppedForBudget` so the caller can fall back to the
 * whole-PDF path instead of sending a selection it does not know is thin.
 */
export function selectPagesForExtraction(
  pages: DocPage[],
  opts?: { maxChars?: number },
): PageSelection {
  const maxChars = resolveMaxChars(opts?.maxChars);

  if (pages.length === 0) {
    return {
      pages: [],
      totalChars: 0,
      selectedPageNumbers: [],
      droppedForBudget: 0,
      reason: "empty",
    };
  }

  const ordered = orderPages(pages);
  const totalChars = ordered.reduce(
    (sum, entry) => sum + entry.page.markdown.length,
    0,
  );

  if (totalChars <= maxChars) {
    return {
      pages: ordered.map((entry) => entry.page),
      totalChars,
      selectedPageNumbers: ordered.map((entry) => entry.page.pageNumber),
      droppedForBudget: 0,
      reason: "all-fit",
    };
  }

  const scores = scoreOrdered(ordered);
  // Score > 0 is the candidacy line. A page at or below zero is one the
  // heuristic actively does not want; spending leftover budget on it is how a
  // 300-page report ends up sending the Directors' Report after all.
  const candidates = scores
    .filter((score) => score.score > 0)
    .sort(compareCandidates);

  // ── PACK, then repair the orphans the greedy pass creates ──────────────
  //
  // First-fit skips an over-budget candidate and keeps scanning, so a later
  // SMALLER page is taken instead. Heading pages score higher than
  // continuations but are also LARGER — they carry the header plus the first
  // rows — so the packer systematically prefers the small orphan and drops the
  // heading that gives it meaning.
  //
  // Measured against this module before the repair: an 8-statement fixture
  // plus a "Notes to the Consolidated Financial Statements" heading (12,240
  // chars) and its unlabelled 3-row continuation selected
  // [1..8, 21] at maxChars 40,000 — heading 20 dropped, continuation 21 kept,
  // and 4,699 chars of budget left UNSPENT. Page 21 would reach the model as
  // three bare rows with no heading, no column labels and no period,
  // immediately after eight DIFFERENT statements, inviting attribution to the
  // wrong one.
  //
  // This module's contract is already "a half table is worse than no table —
  // nothing downstream can tell it from a whole one". It was enforced at PAGE
  // granularity and not at the STATEMENT granularity Schedule III actually
  // spans.
  const chosen: PageScore[] = [];
  const inSet = new Set<number>();
  let used = 0;

  const take = (candidate: PageScore): void => {
    chosen.push(candidate);
    inSet.add(candidate.order);
    used += candidate.chars;
  };

  for (const candidate of candidates) {
    if (used + candidate.chars > maxChars) continue;
    take(candidate);
  }

  // PRUNE to a fixpoint. A continuation is meaningful only behind the page it
  // continues, transitively back to the heading that seeded the run — so
  // dropping one page can orphan the next, and the loop runs until nothing
  // moves. Bounded: each pass removes at least one page or stops.
  for (;;) {
    const orphanAt = chosen.findIndex(
      (page) => page.continuationBonus > 0 && !inSet.has(page.order - 1),
    );
    if (orphanAt < 0) break;
    const [orphan] = chosen.splice(orphanAt, 1);
    /* c8 ignore next */
    if (orphan === undefined) break;
    inSet.delete(orphan.order);
    used -= orphan.chars;
  }

  // REFILL with what the prune freed, highest score first, admitting only
  // pages that cannot themselves be orphans. Taking one page can make a later
  // one admissible, so this also runs to a fixpoint — and because it never
  // admits an orphan, it cannot undo the prune.
  for (;;) {
    const next = candidates.find(
      (candidate) =>
        !inSet.has(candidate.order) &&
        used + candidate.chars <= maxChars &&
        (candidate.continuationBonus === 0 || inSet.has(candidate.order - 1)),
    );
    if (next === undefined) break;
    take(next);
  }

  // EMIT ASCENDING. The model reads the selection as one document, and a cash
  // flow statement arriving before the balance sheet it follows — or worse, a
  // statement's page 2 before its page 1 — is a reading error we would be
  // introducing ourselves.
  chosen.sort((a, b) => a.pageNumber - b.pageNumber || a.order - b.order);

  const selectedPages = chosen.map((score) => {
    const entry = ordered[score.order];
    /* c8 ignore next */
    if (entry === undefined) throw new Error("page-select: lost page ordering");
    return entry.page;
  });

  return {
    pages: selectedPages,
    totalChars: used,
    selectedPageNumbers: selectedPages.map((page) => page.pageNumber),
    droppedForBudget: candidates.length - chosen.length,
    reason: "scored",
  };
}

// ---------------------------------------------------------------------------
// STATEMENT EVIDENCE — MONEY-1343
// ---------------------------------------------------------------------------

/**
 * The three statements this detector looks for.
 *
 * `satisfies` is the join, not decoration: these are the first three members of
 * {@link StatementHeadingId} and the compiler now says so. If one is ever
 * renamed there, this array stops compiling instead of quietly keying the
 * counts by a vocabulary the selector no longer speaks. The pilot report and
 * the page scorer have to name a statement the same way or two measurements of
 * one document cannot be compared.
 */
const STATEMENT_EVIDENCE_IDS = [
  "balance-sheet",
  "profit-and-loss",
  "cash-flow",
] as const satisfies readonly StatementHeadingId[];

/** One of the three statements {@link statementEvidence} counts. */
export type StatementEvidenceId = (typeof STATEMENT_EVIDENCE_IDS)[number];

/**
 * How much of the statement block a converted document appears to carry.
 *
 *   "none"     no statement produced corroborated evidence anywhere.
 *   "partial"  at least one did and at least one did not.
 *   "full"     all three did.
 */
export type StatementEvidenceClass = "none" | "partial" | "full";

export interface StatementEvidence {
  "balance-sheet": number;
  "profit-and-loss": number;
  "cash-flow": number;
  class: StatementEvidenceClass;
}

/**
 * Phrases, searched ANYWHERE on the page and deliberately NOT line-anchored.
 *
 * No `g` flag, on purpose. A module-scope global regex carries `lastIndex`
 * across calls, so `.test()` on one would alternate true and false down a
 * document — the failure would depend on how many pages preceded this one,
 * which is the least debuggable shape a detector can have.
 */
const STATEMENT_EVIDENCE_PHRASES: ReadonlyArray<{
  id: StatementEvidenceId;
  pattern: RegExp;
}> = [
  { id: "balance-sheet", pattern: /balance\s+sheet/i },
  {
    id: "profit-and-loss",
    pattern:
      /statement\s+of\s+profit\s+(?:and|&)\s+loss|profit\s+(?:and|&)\s+loss\s+(?:account|statement)/i,
  },
  {
    id: "cash-flow",
    pattern: /cash\s+flow\s+statement|statement\s+of\s+cash\s+flows?/i,
  },
];

/**
 * Does this converted document appear to CONTAIN its financial statements?
 *
 * MEASUREMENT, not routing. `sidecarIsPageIncomplete` (MONEY-1334) routes a
 * document to whole-PDF vision when 20%+ of its pages produced no text, which
 * catches a statement block scanned in bulk. It cannot see the document at
 * 0-1% scanned that is missing exactly the statement pages — HARDWYN and
 * AHLWEST are the known shapes and the SIZE of that class is what this exists
 * to count. Routing on it is opt-in until a pilot reports the false-positive
 * rate, and the paragraph below is why that caution is not ceremonial.
 *
 * ## Why not the heading matcher
 *
 * {@link findStatementHeading} is the obvious reach and it is the WRONG tool
 * here, measured rather than assumed. {@link matchStatementHeading} is a
 * WHOLE-LINE test under a {@link HEADING_LINE_MAX_CHARS} ceiling — correct for
 * page SCORING, where a line that merely mentions a balance sheet must not
 * score as one. But the converter routinely emits a statement's title glued to
 * the company name and the column headers as one ~200-char line:
 *
 *     **HARDWYN INDIA LIMITED** **Consolidated Balance Sheet as at 31st March,
 *     2025** **(Rs in Lakhs)** **Particulars Note No. As at 31.03.2025 ...**
 *
 * That line is over the ceiling AND does not begin with the title, so it fails
 * twice. Measured across the three real sidecars in
 * `__tests__/fixtures/doc-ingest/`, the heading matcher fires on 3 pages per
 * document and MISSES every real statement page: on HARDWYN it skips the true
 * balance sheet, P&L and cash flow (81, 82, 83) and hits their neighbours
 * (84, 85). A detector built on it reports "no statements" for a document that
 * plainly has them. Hence: search the page, do not parse a heading.
 *
 * ## Why the numeric-cell gate is the load-bearing half
 *
 * The phrase alone is worthless — the three titles appear together on pages
 * that hold no statement at all:
 *
 *   - a CONTENTS page lists all three and carries no table;
 *   - an AOC-1 associate-company annex prints a "Total Assets" for a DIFFERENT
 *     legal entity.
 *
 * So a page counts only when it ALSO carries
 * {@link HEADING_CORROBORATION_MIN_NUMERIC_CELLS} numeric cells.
 *
 * ## What that gate still does NOT catch — measured, not hypothetical
 *
 * It is a floor of four cells, which is one small row, and plenty of prose
 * pages clear it. On BONLON FY2025 — the document MONEY-1334 was diagnosed on,
 * whose pages 92-135 are scanned images the converter emitted nothing for, not
 * even a page marker — this function returns "partial" and every one of those
 * hits is FALSE:
 *
 *   - page 72 says "balance sheets of the Company" in a bullet about investor
 *     grievances; its 9 numeric cells are a committee ATTENDANCE table
 *     (`| Vineet Garg | 1 | 1 | 100 | Yes |`);
 *   - page 74 says "Balance Sheet and Profit and Loss Account" inside a
 *     related-party-transactions sentence; its 5 numeric cells are AGM DATES.
 *     {@link isNumericCell} accepts `28.09.2024` because a dotted Indian date
 *     is indistinguishable from a decimal figure under `\d[\d,\s.]*`.
 *
 * Neither page carries a narrative marker ({@link findNarrativeSection} returns
 * null on both — the section title was pages earlier), so demoting narrative
 * pages would not rescue it either.
 *
 * The direction of that error is the one that matters: a false POSITIVE makes
 * a document that has no statements look like it has some, so this function
 * UNDER-counts the class it exists to size. Treat a "partial" as an upper
 * bound on evidence, never as proof a statement is present. What does separate
 * cleanly on the same three documents is MAGNITUDE — real statement pages
 * carry 25-84 numeric cells at a table ratio of 0.70-0.96, while every false
 * positive above sits at 5-12 cells and 0.34-0.59 — so a higher floor is the
 * lever the pilot should reach for. It is deliberately not chosen here: the
 * pilot measures the rate first.
 */
export function statementEvidence(
  pages: readonly DocPage[],
): StatementEvidence {
  const counts: Record<StatementEvidenceId, number> = {
    "balance-sheet": 0,
    "profit-and-loss": 0,
    "cash-flow": 0,
  };

  for (const page of pages) {
    // Once per page, not once per phrase: measuring is the expensive half and
    // the three phrases are asked of the same measurement.
    const measure = measureTables(page.markdown);
    if (measure.numericCells < HEADING_CORROBORATION_MIN_NUMERIC_CELLS) {
      continue;
    }
    for (const { id, pattern } of STATEMENT_EVIDENCE_PHRASES) {
      if (pattern.test(page.markdown)) counts[id] += 1;
    }
  }

  const values = STATEMENT_EVIDENCE_IDS.map((id) => counts[id]);
  const evidenceClass: StatementEvidenceClass = values.every((n) => n >= 1)
    ? "full"
    : values.every((n) => n === 0)
      ? "none"
      : "partial";

  return { ...counts, class: evidenceClass };
}
