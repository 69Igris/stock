/**
 * WHICH SECTIONS of an extracted SEC filing exhibit get sent to the model —
 * MONEY-1324 (P17).
 *
 * The sibling of `page-select-logic.ts`, and deliberately its sibling rather
 * than its reuse. That module selects PAGES of a converted PDF; this one
 * selects SECTIONS of the plain text the EDGAR extractor writes to
 * `edgar/text/{cik10}/{accession}/{seq}.txt`. The packing algorithm is the
 * same and is copied on purpose — greedy first-fit, prune orphans to a
 * fixpoint, refill — because it is the part that was argued out once and
 * should not be re-argued. Everything BELOW the packer differs, and the
 * measurements are why.
 *
 * PURE LEAF: ZERO imports, no I/O, no clock, no randomness. A fixture is a
 * complete description of a run.
 *
 * ## Why the page selector's measurements do not transfer
 *
 * Measured on three real objects pulled from `stockbook-content-prod`
 * (2026-09-02):
 *
 *   edgar/text/0000866829/0001193125-26-378529/11.txt    194,085 B
 *   edgar/text/0000719413/0001193125-26-374615/3.txt     756,642 B
 *   edgar/text/0001788348/0001104659-26-103589/3.txt   1,748,415 B
 *
 *   - **There are no page markers.** Zero form feeds in all three. So the
 *     page selector's unit does not exist here and had to be replaced rather
 *     than ported.
 *   - **There are no markdown tables.** `measureTables()` in the page
 *     selector counts lines beginning with `|`. Across all three files that
 *     count is ZERO, so every one of its signals would read 0 and every
 *     section would score identically. Tables here are FIXED-WIDTH: a label
 *     column on the left, figures right-aligned in columns (the numeric start
 *     columns cluster at 47-50 and 67-72 in the balance sheet), with
 *     box-drawing `─` rules under the column headers.
 *   - **Document class is not predictable from the exhibit number.** The
 *     three samples are, in order: audited consolidated financial statements
 *     attached to a merger 8-K, a 10-K "Item 1. Business" section, and a
 *     notice of special meeting + management information circular. All three
 *     are EX-99.x. None is an earnings release. A selector tuned only for
 *     statements would return nothing useful for two of the three, which is
 *     why the narrative markers here DEMOTE and never BAN, and why the
 *     scoring floor admits prose when there is budget for it.
 *
 * ## The unit: a SECTION, and why not a block or a window
 *
 * Three candidate units were considered against the real bytes:
 *
 *   1. A SLIDING WINDOW with overlap. Rejected: a window boundary lands
 *      inside a table roughly wherever it likes, and the failure is the one
 *      the page selector already named — half a table produces a plausible,
 *      internally consistent, wrong extract that nothing downstream can tell
 *      from a whole one.
 *   2. A BLOCK (a run of lines between blank lines). Rejected as the
 *      SELECTABLE unit: it is correct but too small. The heading
 *      "CONSOLIDATED BALANCE SHEETS (in thousands...)" is its own block, one
 *      line above the table it names, and selecting the table without it
 *      hands the model an unlabelled grid of figures immediately after a
 *      different company's statement. Blocks remain the ATOMIC unit — a
 *      section boundary may never fall inside one — but they are not what is
 *      ranked.
 *   3. A SECTION: a contiguous run of blocks that begins at a heading block
 *      and runs to the next heading. CHOSEN. It is the unit the document
 *      itself is written in, it carries a table together with the title that
 *      gives it meaning, and because it is assembled out of whole blocks a
 *      table can never straddle two sections.
 *
 * The wrapped-label hazard is the reason blocks absorb their continuation
 * lines instead of ending at them. Measured, verbatim, from the HLX balance
 * sheet:
 *
 * ```
 *   Accounts receivable, net of
 *   allowance for credit losses of              164,695               145,527
 *   $7,511 and $7,929,
 *   respectively
 * ```
 *
 * `164,695` is Accounts receivable, net — but it sits on the line reading
 * "allowance for credit losses of", and `$7,511` on the next line is a
 * different quantity entirely. A block that ended at the first line carrying
 * no figures would cut this row into three, and every one of the pieces would
 * be wrong on its own. So a table block extends ACROSS non-figure lines for
 * up to {@link TABLE_CONTINUATION_LOOKAHEAD} lines, and only a blank line or
 * a genuine run of prose closes it. This is not a rare shape: the same
 * document's statements of operations wraps "General and / administrat… /
 * expense" around `74,461` and "Provision / for / (recovery / of) credit /
 * losses" around `(418  )`.
 *
 * ## What this module does NOT do
 *
 *   - It does not repair the wrapped label. It keeps the row intact so the
 *     model can read it, and the arithmetic check in
 *     `filing-insight-logic.ts` is what catches the model reading it wrong.
 *     Selection and validation are separate jobs and this is the first.
 *   - It does not truncate a block to fit. A block larger than the whole
 *     budget is dropped and counted in {@link FilingSectionSelection.droppedForBudget},
 *     for the same reason the page selector never truncates a page.
 *   - It is a heuristic over extractor output and inherits extraction damage.
 *     A statement whose heading was mangled is scored on table density alone,
 *     which is why density is a term and not a tie-break.
 */

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/**
 * What a block is made of.
 *
 *   "table"    carries right-aligned figure columns, plus any wrapped label
 *              lines absorbed into it.
 *   "heading"  a short line that titles what follows.
 *   "prose"    everything else.
 */
export type FilingBlockKind = "table" | "heading" | "prose";

/** One atomic run of lines. A section boundary never falls inside a block. */
export interface FilingBlock {
  kind: FilingBlockKind;
  /** 0-based index of the first line, into the normalised line array. */
  startLine: number;
  /** 0-based index of the last line, inclusive. */
  endLine: number;
  /** The block's lines, joined with "\n". Trailing whitespace already gone. */
  text: string;
}

/** The statement titles this module knows, US-filing flavoured. */
export type FilingHeadingId =
  | "balance-sheet"
  | "income-statement"
  | "cash-flow"
  | "changes-in-equity"
  | "comprehensive-income"
  | "notes"
  | "financial-highlights"
  | "form-item";

/** Narrative sections that are demoted (never banned). */
export type FilingNarrativeId =
  | "auditors-report"
  | "risk-factors"
  | "forward-looking"
  | "meeting-notice"
  | "legal-proceedings"
  | "exhibit-index"
  | "signatures";

/** A contiguous run of whole blocks, ranked and packed as one unit. */
export interface FilingSection {
  /** 0-based, ascending, assigned in document order. The stable identity. */
  index: number;
  /** 0-based index of the first line. */
  startLine: number;
  /** 0-based index of the last line, inclusive. */
  endLine: number;
  /** The section's text, blocks joined by a blank line. */
  text: string;
  blocks: FilingBlock[];
}

/**
 * Why a selection looks the way it does.
 *
 *   "empty"    the text held nothing. Nothing was measured.
 *   "all-fit"  the whole document fits under the cap, so it is passed through
 *              WHOLE and the heuristic is never consulted.
 *   "scored"   the document did not fit; sections were ranked and cut.
 */
export type FilingSelectionReason = "all-fit" | "scored" | "empty";

export interface FilingSectionSelection {
  /** Chosen sections, ALWAYS ascending by {@link FilingSection.index}. */
  sections: FilingSection[];
  /** The text to send: `sections` joined by {@link SECTION_JOINER}. */
  text: string;
  /** Sum of `section.text.length`. Joiners are NOT counted. */
  totalChars: number;
  /** `sections.map(s => s.index)`, ascending. Loggable without the text. */
  selectedSectionIndexes: number[];
  /**
   * Sections that scored ABOVE ZERO and still did not fit.
   *
   * Deliberately not "sections not selected": a section that scored zero was
   * never wanted, and counting it would make every long circular look
   * starved. Always 0 for "all-fit" and "empty".
   */
  droppedForBudget: number;
  /** Total sections the document was cut into, selected or not. */
  totalSections: number;
  reason: FilingSelectionReason;
}

/** What {@link measureFiguresIn} found. */
export interface FigureMeasure {
  /** Lines with any non-whitespace content. */
  nonBlankLines: number;
  /** Non-blank lines that look like a fixed-width table row. */
  tableLines: number;
  /** `tableLines / nonBlankLines`, or 0 when blank. */
  tableRatio: number;
  /** Count of figure tokens on table lines. */
  figureCount: number;
}

/** The full, inspectable reasoning for one section. Also the operator log line. */
export interface FilingSectionScore {
  index: number;
  /** `section.text.length`. The budget is spent in these units. */
  chars: number;
  /** `baseScore + continuationBonus`. Integer. */
  score: number;
  /** heading + density + figures + narrative penalty. Integer, may be < 0. */
  baseScore: number;
  headingMatched: FilingHeadingId | null;
  /** Whether the heading was backed by figures in the same section. */
  headingCorroborated: boolean;
  tableRatio: number;
  figureCount: number;
  narrativeMatched: FilingNarrativeId | null;
  continuationBonus: number;
}

// ---------------------------------------------------------------------------
// CONSTANTS — every one is a tuning knob, so every one is exported and named.
// ---------------------------------------------------------------------------

/**
 * ~60,000 chars.
 *
 * Sized from the measured content rather than picked, and stated in the same
 * units the packer spends:
 *
 *   - The parent's measurement on this corpus is 1,748,415 bytes ≈ 425k
 *     tokens, i.e. **~4.1 chars/token** on filing text. 60,000 chars is
 *     therefore ~14.6k tokens of input per document.
 *   - The TABLE MASS of a real filing fits inside it. Measured after
 *     {@link normaliseFilingText}: the HLX financial statements hold 35,138
 *     chars of table blocks and the Brookfield circular 34,601 — so a 60k
 *     budget admits 100% of the figure-bearing content of both, plus the
 *     headings and the surrounding context that give it meaning. Hecla's
 *     Business section holds 113,609 and genuinely must be cut; that document
 *     is what the selector exists for.
 *   - It is a CHARACTER cap, not a token cap, because this module must stay
 *     free of a tokenizer. Treat 60k as "about 15k tokens", never as exact.
 *
 * Larger than `page-select-logic.ts`'s 40,000 deliberately: that budget buys
 * the pages of ONE statement out of a converted PDF, while this one buys a
 * whole exhibit whose relevant span is not concentrated on a few pages and
 * whose class is not known in advance.
 */
export const DEFAULT_MAX_CHARS = 60_000;

/**
 * The largest section the cutter will emit before forcing a split.
 *
 * Without it a document with one heading and 400 KB under it is a single
 * section, which is either the entire budget or nothing — the selector would
 * degenerate to a coin flip on the biggest documents, which are exactly the
 * ones it exists for. Hecla's Business section is that shape: three
 * ALLCAPS-style headings across 726,868 bytes.
 *
 * A fifth of the DEFAULT budget, so at least five sections can coexist. The
 * split lands on a BLOCK boundary, never inside one, which is why this is a
 * target and not a guarantee — see {@link splitOversizedSection}.
 *
 * IT IS A DEFAULT, NOT A FIXED VALUE, and that is load-bearing:
 * {@link resolveSectionCap} lowers it whenever the caller's budget is small
 * enough that a 12,000-char section could never fit. Measured while writing
 * the tests: the Hecla Business excerpt is ONE 6,618-char section, so a
 * caller asking for 2,000 chars got an EMPTY selection — every section over
 * budget, nothing to fall back to, and no error. A fixed cap larger than the
 * budget is a silent no-op on exactly the documents the selector exists for.
 */
export const MAX_SECTION_CHARS = 12_000;

/**
 * How much of the budget one section may occupy when the cap has to adapt.
 *
 * A section that IS the whole budget leaves no room for the heading or the
 * continuation beside it, so the packer would select one section and stop. A
 * half lets at least two coexist, which is the minimum that makes ranking
 * mean anything.
 */
export const SECTION_CAP_BUDGET_FRACTION = 0.5;

/**
 * The section cap to use for a given budget.
 *
 * Never larger than the budget can accommodate. Returns at least 1 so a
 * pathologically small budget still cuts sections rather than dividing by
 * zero — the packer will then drop them all and report it through
 * `droppedForBudget`, which is a visible outcome rather than a silent one.
 */
export function resolveSectionCap(maxChars: number): number {
  return Math.max(
    1,
    Math.min(
      MAX_SECTION_CHARS,
      Math.floor(maxChars * SECTION_CAP_BUDGET_FRACTION),
    ),
  );
}

/** A corroborated statement heading. The strongest single signal. */
export const HEADING_POINTS = 100;

/**
 * A heading with no figures under it: a divider, a running header, a contents
 * entry, or a letter's salutation.
 *
 * Small but NOT zero — such a section must still rank above pure prose, and
 * must never outrank a real statement. The relationship that has to hold is
 * `HEADING_UNCORROBORATED_POINTS < DENSITY_POINTS_MAX`.
 */
export const HEADING_UNCORROBORATED_POINTS = 15;

/** Figures needed before a heading is believed. Four is one small row. */
export const HEADING_CORROBORATION_MIN_FIGURES = 4;

/** Weight of the table-line ratio. */
export const DENSITY_POINTS_MAX = 60;

/** Weight of the raw count of figures. */
export const FIGURE_POINTS_MAX = 40;

/**
 * Where the figure term saturates.
 *
 * A real statement section carries well over a hundred figures (three
 * year-columns x forty rows), so the term must top out far below that or it
 * would merely re-measure density. 60 is "a substantial table", reached by
 * any real statement and by no narrative section.
 */
export const FIGURE_SATURATION_COUNT = 60;

/**
 * The demotion for a narrative marker. Applied ONCE per section however many
 * markers match, so the penalty does not depend on how chatty a running
 * header is.
 *
 * Sized so a narrative section carrying a summary table lands BELOW a real
 * statement continuation but ABOVE zero — it stays selectable when there is
 * budget. That is "demote, never ban" as arithmetic, and it is load-bearing
 * here: two of the three measured documents are narrative end to end, and
 * banning would return an empty selection for both.
 */
export const NARRATIVE_PENALTY = 70;

/** Awarded to a table-dense section immediately after a statement section. */
export const CONTINUATION_BONUS = 45;

/**
 * How far a continuation run may reach past ONE statement heading.
 *
 * Bounded because unbounded adjacency is "send everything": each pulled-in
 * section would be a fresh seed and a run of contiguous tables would cascade
 * to the end of the document. Three covers a statement split by
 * {@link MAX_SECTION_CHARS} into several pieces.
 */
export const CONTINUATION_MAX_RUN = 3;

/** Density floor for a section to count as a continuation. */
export const CONTINUATION_MIN_TABLE_RATIO = 0.35;

/** Figure floor for a section to count as a continuation. */
export const CONTINUATION_MIN_FIGURES = 6;

/**
 * Longest line still considered a possible heading.
 *
 * A heading is a heading partly because it is SHORT. Generous compared with
 * the page selector's 160 because these headings carry the registrant's full
 * legal name inline — "HORNBECK OFFSHORE SERVICES, INC. AND SUBSIDIARIES
 * CONSOLIDATED BALANCE SHEETS" is 76 characters before the parenthetical.
 */
export const HEADING_LINE_MAX_CHARS = 200;

/** Most lines a heading block may span. Two, for the "(in thousands)" tail. */
export const HEADING_BLOCK_MAX_LINES = 2;

/**
 * How far past a non-figure line a table block will look for the table to
 * resume.
 *
 * This is the wrapped-label window and it is the single most consequential
 * constant in the file. Measured against the HLX balance sheet, where a
 * logical row spans up to FOUR lines and carries figures on only one of them
 * ("Accounts receivable, net of" / "allowance for credit losses of  164,695"
 * / "$7,511 and $7,929," / "respectively"). Two is enough to bridge every
 * wrap measured while still closing the block at a genuine paragraph of
 * prose: three consecutive figure-free lines ends the table.
 */
export const TABLE_CONTINUATION_LOOKAHEAD = 2;

/** Minimum gap of spaces that separates a fixed-width column from its label. */
export const COLUMN_GAP_MIN_SPACES = 3;

/** What sections are joined by when the selection is rendered to text. */
export const SECTION_JOINER = "\n\n";

// ---------------------------------------------------------------------------
// NORMALISATION
// ---------------------------------------------------------------------------

/**
 * Fold the extractor's padding.
 *
 * Every line arrives padded with spaces to a fixed column width. That padding
 * carries NO information — fixed-width alignment is expressed by LEADING and
 * INTERNAL spacing, never trailing — and it is not free: measured across the
 * three sample objects it is 25.8%, 35.5% and 28.1% of the bytes. Removing it
 * is the cheapest budget the module has, and it is lossless.
 *
 * Line endings are folded to "\n" and non-breaking spaces to ordinary ones so
 * that every downstream test is on one representation.
 */
export function normaliseFilingText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// ---------------------------------------------------------------------------
// FIGURES AND TABLE LINES
// ---------------------------------------------------------------------------

/**
 * A figure token: an optionally parenthesised, optionally signed, optionally
 * currency-prefixed number with thousands separators and an optional percent.
 *
 * The shapes it must accept are all measured from the sample objects, and
 * each is a token that would otherwise be scored as prose:
 *
 *   - `164,695`          the ordinary case.
 *   - `$        54,167`  the currency mark is separated from its figure by
 *                        the column gap, so `$` is not glued on.
 *   - `(418  )`          the accounting negative, with the extractor's spaces
 *                        before the closing paren.
 *   - `(6,049  )`        the same with separators.
 *   - `1,152,787`        a three-group figure.
 *   - `—`                is NOT a figure. An em dash is a rendered zero and
 *                        carries no digits; counting it would score a column
 *                        of blanks as data.
 *
 * What must stay REJECTED: "Note 14", "December 31, 2025" and "Item 1" all
 * carry digits and none is a figure. Hence the token is anchored on a digit
 * boundary and a bare year in prose does not survive the table-line test
 * below, which additionally requires the column gap.
 */
const FIGURE_TOKEN = /(?<![\w.,])\(?\s*-?\d[\d,]*(?:\.\d+)?\s*\)?%?(?![\w])/g;

/** Every figure token on a line, in order. */
export function findFigures(line: string): string[] {
  const out: string[] = [];
  FIGURE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null = FIGURE_TOKEN.exec(line);
  while (match !== null) {
    const token = match[0].trim();
    if (/\d/.test(token)) out.push(token);
    match = FIGURE_TOKEN.exec(line);
  }
  return out;
}

/**
 * A box-drawing or ASCII rule: structure, never data.
 *
 * The extractor draws these under a statement's column headers, so their
 * presence is positive evidence of a table even though they hold no figures.
 */
export function isRuleLine(line: string): boolean {
  return /[─━—_=-]{8,}/.test(line.trim());
}

/**
 * Does this line carry a fixed-width figure column?
 *
 * BOTH conditions, not either:
 *
 *   - at least one figure token, and
 *   - a run of {@link COLUMN_GAP_MIN_SPACES} or more spaces between two
 *     non-space characters, which is what right-aligning a column into a
 *     fixed grid produces.
 *
 * The gap is what separates a table row from a sentence. "We acquired 3
 * vessels in 2025 for $54,167" carries two figure tokens and no column gap;
 * "Cash and cash equivalents           $        54,167" carries the gap. A
 * figure test alone would score a paragraph of prose with numbered clauses as
 * a table, which is the failure that makes density useless.
 */
export function isTableLine(line: string): boolean {
  if (line.trim() === "") return false;
  if (isRuleLine(line)) return true;
  if (findFigures(line).length === 0) return false;
  return new RegExp(`\\S {${COLUMN_GAP_MIN_SPACES},}\\S`).test(line);
}

/** Table density and figure weight of a span of text. */
export function measureFiguresIn(text: string): FigureMeasure {
  let nonBlankLines = 0;
  let tableLines = 0;
  let figureCount = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    nonBlankLines += 1;
    if (!isTableLine(line)) continue;
    tableLines += 1;
    if (isRuleLine(line)) continue;
    figureCount += findFigures(line).length;
  }

  return {
    nonBlankLines,
    tableLines,
    tableRatio: nonBlankLines === 0 ? 0 : tableLines / nonBlankLines,
    figureCount,
  };
}

// ---------------------------------------------------------------------------
// HEADINGS
// ---------------------------------------------------------------------------

/** Qualifiers that may precede a statement title, in any run of up to four. */
const QUALIFIER = String.raw`(?:(?:consolidated|combined|condensed|unaudited|audited|interim|standalone|reviewed|abridged)\s+){0,4}`;

/**
 * What may follow a statement title: a date clause, or an annotation opened
 * by punctuation. " ......... 84" opens with neither, so a contents line does
 * not match, and neither does the same words inside a sentence.
 */
const HEADING_TAIL = String.raw`(?:\s*[-–—:,(\[/].*|\s+(?:as\s+at|as\s+on|as\s+of|for\s+the|for\s+each|for\s+year|for\s+quarter|for\s+period|of\s+the)\b.*)?`;

const HEADING_BODIES: ReadonlyArray<{ id: FilingHeadingId; body: string }> = [
  { id: "balance-sheet", body: String.raw`balance\s+sheets?` },
  {
    id: "balance-sheet",
    body: String.raw`statements?\s+of\s+financial\s+(?:position|condition)`,
  },
  {
    id: "income-statement",
    body: String.raw`statements?\s+of\s+(?:operations|income|earnings|loss|operations\s+and\s+comprehensive\s+(?:income|loss))`,
  },
  {
    id: "income-statement",
    body: String.raw`(?:income|earnings)\s+statements?`,
  },
  {
    id: "cash-flow",
    body: String.raw`statements?\s+of\s+cash\s+flows?`,
  },
  {
    id: "changes-in-equity",
    body: String.raw`statements?\s+of\s+(?:changes\s+in\s+)?(?:stockholders|shareholders|members|unitholders)[’']?\s*(?:equity|deficit)`,
  },
  {
    id: "comprehensive-income",
    body: String.raw`statements?\s+of\s+comprehensive\s+(?:income|loss)`,
  },
  {
    id: "notes",
    body: String.raw`notes?\s+to\s+(?:the\s+)?(?:consolidated\s+|combined\s+|condensed\s+|unaudited\s+)*financial\s+statements?`,
  },
  {
    id: "financial-highlights",
    body: String.raw`(?:financial\s+(?:highlights|results|summary)|selected\s+financial\s+data|summary\s+financial\s+information)`,
  },
];

const HEADING_PATTERNS: ReadonlyArray<{ id: FilingHeadingId; re: RegExp }> =
  HEADING_BODIES.map(({ id, body }) => ({
    id,
    // The registrant's legal name is printed INLINE before the title in every
    // running header measured ("HORNBECK OFFSHORE SERVICES, INC. AND
    // SUBSIDIARIES CONSOLIDATED BALANCE SHEETS"), so the title is allowed a
    // prefix — but only one made of name-shaped characters, never a verb.
    // That is what keeps "...which reflects the balance sheet impact of..."
    // from matching while the running header does.
    re: new RegExp(
      `^(?:[A-Za-z0-9 ,.&'’()-]{0,90}?\\s)?${QUALIFIER}${body}${HEADING_TAIL}$`,
      "i",
    ),
  }));

/** `Item 1. Business`, `Item 7A. Quantitative and Qualitative Disclosures`. */
const FORM_ITEM_RE = /^item\s+\d{1,2}[A-Z]?\.?\s+\S/i;

/** Strip decoration around a candidate heading. */
export function stripHeadingDecoration(line: string): string {
  let s = line.replace(/ /g, " ").trim();
  s = s.replace(/^(?:>\s*)+/, "");
  s = s.replace(/^#{1,6}\s*/, "");
  s = s.replace(/^(?:\*\*|__)/, "").replace(/(?:\*\*|__)$/, "");
  s = s.replace(/[\s:*]+$/, "");
  return s.trim();
}

/**
 * Is this line ALLCAPS in the way a title is?
 *
 * Requires at least two words and no lowercase letters outside a
 * parenthetical, which is how the extractor renders every centred title in
 * the circular ("NOTICE OF SPECIAL MEETING OF UNITHOLDERS", "LETTER TO
 * SECURITYHOLDERS"). Deliberately NOT sufficient on its own to claim a
 * STATEMENT heading — it only makes a block a heading block.
 */
export function isAllCapsTitle(line: string): boolean {
  const s = stripHeadingDecoration(line);
  if (s.length < 4 || s.length > HEADING_LINE_MAX_CHARS) return false;
  const withoutParens = s.replace(/\([^)]*\)/g, "");
  if (!/[A-Z]/.test(withoutParens)) return false;
  if (/[a-z]/.test(withoutParens)) return false;
  return /\S+\s+\S+/.test(s);
}

/**
 * The statement title this line IS, or null.
 *
 * A whole-line test, not a search: the line must BE the heading, not merely
 * contain the words. Returns the first match in declaration order, so the
 * result is deterministic when two patterns could both match.
 */
export function matchFilingHeading(line: string): FilingHeadingId | null {
  const normalised = line.replace(/ /g, " ").trim();
  if (normalised.length > HEADING_LINE_MAX_CHARS) return null;
  const stripped = stripHeadingDecoration(normalised);
  if (stripped === "") return null;
  for (const { id, re } of HEADING_PATTERNS) {
    if (re.test(stripped)) return id;
  }
  if (FORM_ITEM_RE.test(stripped)) return "form-item";
  return null;
}

/** The first statement heading in a span, or null. */
export function findFilingHeading(text: string): FilingHeadingId | null {
  for (const line of text.split("\n")) {
    const hit = matchFilingHeading(line);
    if (hit !== null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// NARRATIVE SECTIONS (negative signals)
// ---------------------------------------------------------------------------

/**
 * Anchored at the START of a stripped line. Matching anywhere in the text
 * would demote a genuine notes section for saying "as described in our Risk
 * Factors", a sentence that appears in real notes. What identifies a
 * narrative SECTION is its title or running header, and both begin a line.
 */
const NARRATIVE_PATTERNS: ReadonlyArray<{ id: FilingNarrativeId; re: RegExp }> =
  [
    {
      id: "auditors-report",
      re: /^report\s+of\s+independent\s+registered\s+public\s+accounting\s+firm\b/i,
    },
    {
      id: "auditors-report",
      re: /^(?:the\s+)?report\s+of\s+(?:the\s+)?independent\s+auditors?\b/i,
    },
    {
      id: "auditors-report",
      re: /^independent\s+auditor(?:['’]s|s['’]?)?\s+report\b/i,
    },
    { id: "risk-factors", re: /^(?:item\s+1a\.?\s+)?risk\s+factors\b/i },
    {
      id: "forward-looking",
      re: /^(?:cautionary\s+(?:note|statement)s?\s+(?:regarding|on)\s+)?forward[-\s]looking\s+statements\b/i,
    },
    {
      id: "meeting-notice",
      re: /^notice\s+of\s+(?:the\s+)?(?:special|annual|extraordinary)\s+(?:general\s+)?meeting\b/i,
    },
    {
      id: "meeting-notice",
      re: /^letter\s+to\s+(?:the\s+)?(?:security|share|unit|stock)holders\b/i,
    },
    {
      id: "meeting-notice",
      re: /^(?:joint\s+)?management\s+(?:information|proxy)\s+circular\b/i,
    },
    {
      id: "legal-proceedings",
      re: /^(?:item\s+3\.?\s+)?legal\s+proceedings\b/i,
    },
    { id: "exhibit-index", re: /^(?:index\s+to\s+)?exhibits?\s+index\b/i },
    { id: "signatures", re: /^signatures?\s*$/i },
  ];

/** The narrative section this line announces, or null. */
export function matchFilingNarrative(line: string): FilingNarrativeId | null {
  const normalised = line.replace(/ /g, " ").trim();
  if (normalised.length > HEADING_LINE_MAX_CHARS) return null;
  const stripped = stripHeadingDecoration(normalised);
  if (stripped === "") return null;
  for (const { id, re } of NARRATIVE_PATTERNS) {
    if (re.test(stripped)) return id;
  }
  return null;
}

/** The first narrative marker in a span, or null. */
export function findFilingNarrative(text: string): FilingNarrativeId | null {
  for (const line of text.split("\n")) {
    const hit = matchFilingNarrative(line);
    if (hit !== null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// BLOCK SEGMENTATION — the atomic unit
// ---------------------------------------------------------------------------

/**
 * Cut normalised text into blocks.
 *
 * A blank line always closes a block. A table block additionally absorbs up
 * to {@link TABLE_CONTINUATION_LOOKAHEAD} consecutive figure-free lines when
 * the table resumes after them, which is what keeps a wrapped label attached
 * to its figure — the defect this whole design exists to survive.
 *
 * A block is classified `heading` when it is at most
 * {@link HEADING_BLOCK_MAX_LINES} lines and its first line is either a
 * recognised statement title or an ALLCAPS title. A heading block is where a
 * section may begin.
 */
export function segmentBlocks(normalisedText: string): FilingBlock[] {
  const lines = normalisedText.split("\n");
  const blocks: FilingBlock[] = [];

  let startLine = -1;
  let kindIsTable = false;
  let buffer: string[] = [];

  const flush = (endLine: number): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    blocks.push({
      kind: kindIsTable ? "table" : classifyNonTable(buffer),
      startLine,
      endLine,
      text,
    });
    buffer = [];
    startLine = -1;
    kindIsTable = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      flush(i - 1);
      continue;
    }

    if (isTableLine(line)) {
      // A prose block that runs into a table ends here: the table starts its
      // own block so a heading immediately above a statement stays separable
      // from it.
      if (buffer.length > 0 && !kindIsTable) flush(i - 1);
      if (buffer.length === 0) startLine = i;
      kindIsTable = true;
      buffer.push(line);
      continue;
    }

    // Non-blank, no figure column. Absorb it into an OPEN table block only if
    // the table resumes within the lookahead window.
    if (kindIsTable && buffer.length > 0 && tableResumes(lines, i)) {
      buffer.push(line);
      continue;
    }

    if (kindIsTable && buffer.length > 0) flush(i - 1);
    if (buffer.length === 0) startLine = i;
    buffer.push(line);
  }

  flush(lines.length - 1);
  return blocks;
}

/** Does a table line appear within the lookahead, with no blank line first? */
function tableResumes(lines: readonly string[], from: number): boolean {
  const limit = Math.min(from + TABLE_CONTINUATION_LOOKAHEAD, lines.length - 1);
  for (let j = from + 1; j <= limit; j += 1) {
    const candidate = lines[j] ?? "";
    if (candidate.trim() === "") return false;
    if (isTableLine(candidate)) return true;
  }
  return false;
}

/** Heading or prose, for a block with no figure columns. */
function classifyNonTable(buffer: readonly string[]): FilingBlockKind {
  if (buffer.length > HEADING_BLOCK_MAX_LINES) return "prose";
  const first = buffer[0] ?? "";
  if (matchFilingHeading(first) !== null) return "heading";
  if (isAllCapsTitle(first)) return "heading";
  return "prose";
}

// ---------------------------------------------------------------------------
// SECTION ASSEMBLY
// ---------------------------------------------------------------------------

/**
 * Group blocks into sections.
 *
 * A section begins at a heading block and runs until the next heading block.
 * Leading blocks before the first heading form their own section, so nothing
 * is silently dropped for arriving before a title — the HLX exhibit opens
 * mid-auditor's-report with no heading at all.
 *
 * Sections longer than {@link MAX_SECTION_CHARS} are split, on BLOCK
 * boundaries only. That is the guarantee that matters: a table block is never
 * cut, so a statement row and its wrapped label always travel together, and a
 * section boundary can only ever fall between two blocks.
 */
export function buildSections(
  blocks: readonly FilingBlock[],
  maxSectionChars: number = MAX_SECTION_CHARS,
): FilingSection[] {
  const groups: FilingBlock[][] = [];
  let current: FilingBlock[] = [];

  for (const block of blocks) {
    if (block.kind === "heading" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) groups.push(current);

  const sections: FilingSection[] = [];
  for (const group of groups) {
    for (const piece of splitOversizedSection(group, maxSectionChars)) {
      sections.push(materialise(piece, sections.length));
    }
  }
  return sections;
}

/**
 * Split a run of blocks so each piece is under {@link MAX_SECTION_CHARS}.
 *
 * A block LARGER than the cap becomes its own piece and is NOT split. Table
 * integrity outranks the size target — a truncated statement is the failure
 * this module refuses, while an oversized section merely competes for budget
 * as one unit and may lose. The largest table block measured across the three
 * samples is 3,071 chars, comfortably under the cap, so this is a bound on
 * pathological input rather than a routine path.
 */
export function splitOversizedSection(
  blocks: readonly FilingBlock[],
  maxSectionChars: number = MAX_SECTION_CHARS,
): FilingBlock[][] {
  const pieces: FilingBlock[][] = [];
  let piece: FilingBlock[] = [];
  let used = 0;

  for (const block of blocks) {
    const cost =
      block.text.length + (piece.length > 0 ? SECTION_JOINER.length : 0);
    if (piece.length > 0 && used + cost > maxSectionChars) {
      pieces.push(piece);
      piece = [];
      used = 0;
    }
    piece.push(block);
    used += block.text.length + (piece.length > 1 ? SECTION_JOINER.length : 0);
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

function materialise(blocks: FilingBlock[], index: number): FilingSection {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  /* c8 ignore next */
  if (first === undefined || last === undefined) {
    throw new Error("filing-section-select: empty section");
  }
  return {
    index,
    startLine: first.startLine,
    endLine: last.endLine,
    text: blocks.map((b) => b.text).join(SECTION_JOINER),
    blocks,
  };
}

/**
 * Normalise, segment and group in one step.
 *
 * `maxSectionChars` defaults to {@link MAX_SECTION_CHARS}; the selector passes
 * {@link resolveSectionCap} of its budget instead, so a small budget produces
 * proportionally finer sections rather than sections that can never fit.
 */
export function cutIntoSections(
  text: string,
  maxSectionChars: number = MAX_SECTION_CHARS,
): FilingSection[] {
  return buildSections(
    segmentBlocks(normaliseFilingText(text)),
    maxSectionChars,
  );
}

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------

/** Density term. Integer. */
export function densityPoints(measure: FigureMeasure): number {
  return Math.round(measure.tableRatio * DENSITY_POINTS_MAX);
}

/** Figure-weight term, saturating. Integer. */
export function figurePoints(measure: FigureMeasure): number {
  const capped = Math.min(measure.figureCount, FIGURE_SATURATION_COUNT);
  return Math.round((capped / FIGURE_SATURATION_COUNT) * FIGURE_POINTS_MAX);
}

/**
 * Is this section dense enough to continue a statement?
 *
 * Both floors, not either: ten one-figure rule lines clear the ratio and
 * carry no data, and a paragraph quoting six figures clears the count and is
 * prose.
 */
export function isContinuationCandidate(score: FilingSectionScore): boolean {
  return (
    score.tableRatio >= CONTINUATION_MIN_TABLE_RATIO &&
    score.figureCount >= CONTINUATION_MIN_FIGURES
  );
}

/**
 * May this section START a continuation run?
 *
 * Only a corroborated statement heading with no narrative marker. A section
 * pulled in BY a run is never itself a seed — seeds come from base scores
 * computed before any bonus — so a run can never exceed
 * {@link CONTINUATION_MAX_RUN} by chaining through its own output.
 */
export function isContinuationSeed(score: FilingSectionScore): boolean {
  return (
    score.headingMatched !== null &&
    score.headingCorroborated &&
    score.narrativeMatched === null
  );
}

/**
 * Total order: score DESC, then index ASC. Never returns 0 for two distinct
 * sections — `index` is assigned uniquely in document order, so this is a
 * genuine total order rather than a comparator that merely looks
 * deterministic because `Array#sort` is stable.
 */
export function compareSections(
  a: FilingSectionScore,
  b: FilingSectionScore,
): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.index - b.index;
}

/** Score every section, in document order. */
export function scoreSections(
  sections: readonly FilingSection[],
): FilingSectionScore[] {
  const scores: FilingSectionScore[] = sections.map((section) => {
    const measure = measureFiguresIn(section.text);
    const headingMatched = findFilingHeading(section.text);
    const narrativeMatched = findFilingNarrative(section.text);
    const headingCorroborated =
      measure.figureCount >= HEADING_CORROBORATION_MIN_FIGURES;

    let baseScore = 0;
    if (headingMatched !== null) {
      baseScore += headingCorroborated
        ? HEADING_POINTS
        : HEADING_UNCORROBORATED_POINTS;
    }
    baseScore += densityPoints(measure);
    baseScore += figurePoints(measure);
    if (narrativeMatched !== null) baseScore -= NARRATIVE_PENALTY;

    return {
      index: section.index,
      chars: section.text.length,
      score: baseScore,
      baseScore,
      headingMatched,
      headingCorroborated,
      tableRatio: measure.tableRatio,
      figureCount: measure.figureCount,
      narrativeMatched,
      continuationBonus: 0,
    };
  });

  // ADJACENCY, second pass. Seeds come from the base scores above, so nothing
  // awarded here can create a new seed.
  const bonus = new Array<number>(scores.length).fill(0);
  for (const seed of scores) {
    if (!isContinuationSeed(seed)) continue;
    for (let step = 1; step <= CONTINUATION_MAX_RUN; step += 1) {
      const next = scores[seed.index + step];
      if (next === undefined) break;
      // A section announcing a narrative section is not a continuation of a
      // statement, however dense. Statements end.
      if (next.narrativeMatched !== null) break;
      // Nor is one that announces a STATEMENT OF ITS OWN — a cash flow
      // statement after a balance sheet is the next statement, not page two
      // of the previous one. Awarding it the bonus would make it DEPENDENT on
      // its predecessor for selection, so it would be pruned exactly when the
      // larger statement above it did not fit, which is when it is most
      // needed.
      if (next.headingMatched !== null) break;
      if (!isContinuationCandidate(next)) break;
      // SET, never accumulate: two statements ending back to back must not
      // pay one section twice for one adjacency.
      bonus[next.index] = CONTINUATION_BONUS;
    }
  }

  return scores.map((score) => {
    const continuationBonus = bonus[score.index] ?? 0;
    return {
      ...score,
      continuationBonus,
      score: score.baseScore + continuationBonus,
    };
  });
}

function resolveMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined) return DEFAULT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    // Not a silent fall back to the default. A NaN or 0 budget means the
    // caller computed one wrongly, and quietly substituting a working value
    // would hide that forever behind a selection that looks fine.
    throw new TypeError(
      `filing-section-select: maxChars must be a finite positive number, received ${String(maxChars)}`,
    );
  }
  return maxChars;
}

// ---------------------------------------------------------------------------
// SELECTION
// ---------------------------------------------------------------------------

/**
 * Choose the sections worth sending.
 *
 * Three behaviours, in the order they are decided:
 *
 *   1. NO CONTENT → `reason: "empty"`. Nothing measured, nothing claimed.
 *   2. THE WHOLE DOCUMENT FITS → the normalised text, whole, `"all-fit"`, and
 *      the heuristic is never consulted. Deliberate: when there is nothing to
 *      gain by dropping a section, dropping one can only lose — a short
 *      earnings release whose heading the extractor mangled still arrives
 *      complete.
 *   3. OTHERWISE → score, take the best that fit, `"scored"`.
 *
 * The budget walk is first-fit over the ranking: a section that does not fit
 * is SKIPPED and the walk continues rather than stopping. Both choices lose
 * something and this one loses less — stopping early leaves budget unspent
 * and drops strictly more.
 *
 * A section is NEVER truncated to fit, and a block is never split at all.
 * Half a statement produces a plausible, internally consistent, wrong
 * extract, and nothing downstream can tell it from a whole one.
 */
export function selectSectionsForAnalysis(
  text: string,
  opts?: { maxChars?: number },
): FilingSectionSelection {
  const maxChars = resolveMaxChars(opts?.maxChars);
  const normalised = normaliseFilingText(text);

  if (normalised.trim() === "") {
    return {
      sections: [],
      text: "",
      totalChars: 0,
      selectedSectionIndexes: [],
      droppedForBudget: 0,
      totalSections: 0,
      reason: "empty",
    };
  }

  const sections = cutIntoSections(normalised, resolveSectionCap(maxChars));
  const wholeChars = sections.reduce((sum, s) => sum + s.text.length, 0);

  if (wholeChars <= maxChars) {
    return {
      sections,
      text: sections.map((s) => s.text).join(SECTION_JOINER),
      totalChars: wholeChars,
      selectedSectionIndexes: sections.map((s) => s.index),
      droppedForBudget: 0,
      totalSections: sections.length,
      reason: "all-fit",
    };
  }

  const scores = scoreSections(sections);
  // Score > 0 is the candidacy line. A section at or below zero is one the
  // heuristic actively does not want; spending leftover budget on it is how a
  // 400-page circular ends up sending its risk factors after all.
  const candidates = scores
    .filter((score) => score.score > 0)
    .sort(compareSections);

  const chosen: FilingSectionScore[] = [];
  const inSet = new Set<number>();
  let used = 0;

  const take = (candidate: FilingSectionScore): void => {
    chosen.push(candidate);
    inSet.add(candidate.index);
    used += candidate.chars;
  };

  // ── PACK ───────────────────────────────────────────────────────────────
  // First-fit skips an over-budget candidate and keeps scanning, so a later
  // SMALLER section is taken instead. Heading sections score higher than
  // continuations but are also LARGER, so the packer systematically prefers
  // the small orphan and drops the heading that gives it meaning. The two
  // passes below repair that; see page-select-logic.ts, where the same
  // asymmetry was measured.
  for (const candidate of candidates) {
    if (used + candidate.chars > maxChars) continue;
    take(candidate);
  }

  // ── PRUNE to a fixpoint ────────────────────────────────────────────────
  // A continuation is meaningful only behind the section it continues,
  // transitively back to the heading that seeded the run, so dropping one can
  // orphan the next. Bounded: each pass removes at least one section or stops.
  for (;;) {
    const orphanAt = chosen.findIndex(
      (s) => s.continuationBonus > 0 && !inSet.has(s.index - 1),
    );
    if (orphanAt < 0) break;
    const [orphan] = chosen.splice(orphanAt, 1);
    /* c8 ignore next */
    if (orphan === undefined) break;
    inSet.delete(orphan.index);
    used -= orphan.chars;
  }

  // ── REFILL with what the prune freed ───────────────────────────────────
  // Highest score first, admitting only sections that cannot themselves be
  // orphans. Taking one can make a later one admissible, so this runs to a
  // fixpoint too; because it never admits an orphan it cannot undo the prune.
  for (;;) {
    const next = candidates.find(
      (c) =>
        !inSet.has(c.index) &&
        used + c.chars <= maxChars &&
        (c.continuationBonus === 0 || inSet.has(c.index - 1)),
    );
    if (next === undefined) break;
    take(next);
  }

  // EMIT IN DOCUMENT ORDER. The model reads the selection as one document,
  // and a cash flow statement arriving before the balance sheet it follows is
  // a reading error we would be introducing ourselves.
  chosen.sort((a, b) => a.index - b.index);

  const selected = chosen.map((score) => {
    const section = sections[score.index];
    /* c8 ignore next */
    if (section === undefined) {
      throw new Error("filing-section-select: lost section ordering");
    }
    return section;
  });

  return {
    sections: selected,
    text: selected.map((s) => s.text).join(SECTION_JOINER),
    totalChars: used,
    selectedSectionIndexes: selected.map((s) => s.index),
    droppedForBudget: candidates.length - chosen.length,
    totalSections: sections.length,
    reason: "scored",
  };
}
