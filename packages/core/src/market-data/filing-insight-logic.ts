/**
 * WHAT WE ASK THE MODEL FOR when reading an SEC filing exhibit, and what we
 * check about the answer — MONEY-1324 (P17).
 *
 * The sibling of `document-financials-logic.ts`. That module extracts Indian
 * Schedule III statements out of a converted annual report, where the document
 * class is known in advance and the statement titles are fixed by regulation.
 * This one reads the text of a US 8-K / 6-K exhibit, where NEITHER holds.
 *
 * PURE LEAF: zero imports, no I/O, no clock, no randomness. Import it by
 * SUBPATH (`@usemoney/core/market-data/filing-insight-logic`), never through
 * the market-data barrel.
 *
 * ## Why there is a `documentClass` at all
 *
 * Measured on three real objects from `stockbook-content-prod` (2026-09-02),
 * all three filed as EX-99.x:
 *
 *   0000866829/0001193125-26-378529/11.txt   audited consolidated financial
 *                                            statements, attached to a MERGER
 *                                            8-K (items 1.01 / 2.01 / 5.01)
 *   0000719413/0001193125-26-374615/3.txt    a 10-K "Item 1. Business" section
 *   0001788348/0001104659-26-103589/3.txt    a notice of special meeting plus
 *                                            a joint management information
 *                                            circular
 *
 * NONE of them is an earnings release. A prompt that opens "you are reading an
 * earnings release" — the obvious thing to write, and what the exhibit number
 * suggests — is wrong for all three, and a model told the wrong thing about a
 * document does not decline: it finds the closest thing to what it was asked
 * for and returns it confidently. So the class is the FIRST thing the model
 * decides and the rest of the response is shaped by it.
 *
 * ## One shape, optional blocks
 *
 * There is exactly ONE response schema, not one per class. A discriminated
 * union across six classes would put the burden of picking a variant on the
 * model, and a wrong pick is an unparseable response rather than a thin one.
 * Instead every field except {@link FilingInsight.documentClass},
 * `classConfidence` and `summary` is optional, and
 * {@link normaliseFilingInsight} DEGRADES: an unrecognised class arrives as
 * `"OTHER"` with the blocks it could not fill simply absent. A document we
 * have never seen produces fewer fields; it never produces an error.
 *
 * ## What the checks here can and cannot do
 *
 * Stated up front, because a check believed to be stronger than it is costs
 * more than no check at all (MONEY-1234).
 *
 * The hazard being defended against is MIS-ATTRIBUTION, and it is not
 * hypothetical — it is the shape of this corpus. Verbatim from the HLX balance
 * sheet:
 *
 * ```
 *   Cash and cash equivalents           $        54,167       $        80,803
 *   Accounts receivable, net of
 *   allowance for credit losses of              164,695               145,527
 *   $7,511 and $7,929,
 *   respectively
 *   Prepaid expenses                              4,941                 4,490
 * ```
 *
 * `164,695` is Accounts receivable, net. It sits on the line that reads
 * "allowance for credit losses of", and `$7,511` one line below is the
 * allowance itself. A line-oriented reader attributes both wrongly, and the
 * result is not obviously broken — it is a balance sheet with plausible
 * numbers in it.
 *
 *   - {@link checkFactsGrounded} catches a value that is NOT IN THE DOCUMENT
 *     at all — a hallucinated or arithmetically-derived figure. It is cheap
 *     (a set membership test over the figures the text prints) and it is
 *     complete for what it claims. It does NOT catch mis-attribution: 7,511 is
 *     genuinely printed, so a response calling it Accounts receivable passes
 *     grounding.
 *   - {@link checkTotalsCrossFoot} is what catches the mis-attribution, and
 *     only when the mis-read figure participates in a printed total. On the
 *     balance sheet above it does: 54,167 + 164,695 + 4,941 + 19,026 + 14,180
 *     = 257,009, exactly the printed "Total current assets". Substitute the
 *     allowance and the sum is 99,825 against a printed 257,009 — a 61%
 *     miss, impossible to explain as rounding. Both measured columns
 *     cross-foot exactly (the 2024 column sums to the printed 256,951), which
 *     is why the tolerance can be tight.
 *   - NOTHING here catches a mis-attribution on a line that participates in no
 *     printed total, and nothing here checks that a label means what it says.
 *     That is the expensive half and it is deliberately NOT implemented — it
 *     needs either a second model pass or a real fixed-width column parser,
 *     and both are their own ticket.
 *
 * DETECT, NEVER REPAIR. No function here rewrites a value the model returned.
 * `detectOrphanDigits` in `doc-number-normaliser-logic.ts` established the rule
 * for exactly this reason: once a figure is known to be wrong, the neighbours
 * that were damaged with it still parse as perfectly valid numbers, so a
 * "repair" silently invents a second wrong answer on top of the first. An
 * issue is reported and the caller decides.
 */

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/**
 * What kind of document this exhibit is.
 *
 * The list is derived from the measured cohort plus the two classes an 8-K/6-K
 * exhibit most often is. `OTHER` is not a failure state — it is the correct
 * answer for a material-agreement exhibit, a credit agreement or a slide deck,
 * and a document that lands there still returns a class, a summary and key
 * points.
 */
export type FilingDocumentClass =
  | "EARNINGS_RELEASE"
  | "FINANCIAL_STATEMENTS"
  | "PRESS_RELEASE"
  | "PROXY_OR_MEETING"
  | "BUSINESS_DESCRIPTION"
  | "OTHER";

/** Every class the schema accepts, in schema order. */
export const FILING_DOCUMENT_CLASSES: readonly FilingDocumentClass[] = [
  "EARNINGS_RELEASE",
  "FINANCIAL_STATEMENTS",
  "PRESS_RELEASE",
  "PROXY_OR_MEETING",
  "BUSINESS_DESCRIPTION",
  "OTHER",
] as const;

/** How sure the model is of the class. LOW is a signal to a human, not an error. */
export type FilingClassConfidence = "HIGH" | "MEDIUM" | "LOW";

export const FILING_CLASS_CONFIDENCES: readonly FilingClassConfidence[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

/**
 * The multiplier the statement's own units header declares.
 *
 * Recorded, never applied. Figures are reported AS PRINTED — the same
 * convention `document-financials-logic.ts` uses — because a model that
 * multiplies is a model that can multiply wrongly, and a figure that has been
 * silently scaled can no longer be found in the source text, which would
 * defeat {@link checkFactsGrounded} on every value at once.
 */
export type FilingUnitScale =
  | "UNITS"
  | "THOUSANDS"
  | "MILLIONS"
  | "BILLIONS"
  | "UNKNOWN";

export const FILING_UNIT_SCALES: readonly FilingUnitScale[] = [
  "UNITS",
  "THOUSANDS",
  "MILLIONS",
  "BILLIONS",
  "UNKNOWN",
] as const;

/** Which statement a fact came off, when it came off one. */
export type FilingStatementType =
  | "BALANCE_SHEET"
  | "INCOME_STATEMENT"
  | "CASH_FLOW"
  | "EQUITY"
  | "COMPREHENSIVE_INCOME"
  | "OTHER";

export const FILING_STATEMENT_TYPES: readonly FilingStatementType[] = [
  "BALANCE_SHEET",
  "INCOME_STATEMENT",
  "CASH_FLOW",
  "EQUITY",
  "COMPREHENSIVE_INCOME",
  "OTHER",
] as const;

/**
 * One figure the document prints, with the provenance needed to check it.
 *
 * `sourceLine` is the load-bearing field and the reason this type exists
 * instead of a flat `Record<string, number>`. Requiring the model to copy the
 * line it read the figure off is what makes the wrapped-label hazard
 * INSPECTABLE: when the answer is wrong, the source line shows whether the
 * model read the wrong row or invented the number, and those need different
 * fixes. It also costs the model almost nothing — it is copying, not
 * reasoning.
 */
export interface FilingFact {
  /** The label AS PRINTED, joined across wrapped lines. Never invented. */
  label: string;
  /** The figure AS PRINTED (sign kept, scale NOT applied). Null if absent. */
  value: number | null;
  /** e.g. "December 31, 2025". Null when the document does not label it. */
  periodLabel: string | null;
  statementType: FilingStatementType;
  /** The VERBATIM line the figure was read from. Null if the model omits it. */
  sourceLine: string | null;
}

/**
 * A printed total together with the components that should add up to it.
 *
 * The components are what makes the check possible, so the model is asked for
 * them explicitly rather than left to imply them by ordering. `components` is
 * what the DOCUMENT prints under the total, not everything the model can find.
 */
export interface FilingTotal {
  /** The total's label AS PRINTED, e.g. "Total current assets". */
  label: string;
  /** The printed total. Null means the document does not print one. */
  value: number | null;
  periodLabel: string | null;
  statementType: FilingStatementType;
  components: FilingFact[];
  sourceLine: string | null;
}

/** A dated, material event the document announces. */
export interface FilingEvent {
  /** e.g. "merger agreement", "dividend declared", "special meeting". */
  kind: string;
  description: string;
  /** ISO 8601 date, or null. */
  date: string | null;
}

/**
 * The one response shape.
 *
 * `documentClass`, `classConfidence` and `summary` are the only fields the
 * model must always produce. Everything else is optional and absent when the
 * class does not support it — a proxy circular has no `statementTotals`, and
 * that is correct rather than missing.
 */
export interface FilingInsight {
  documentClass: FilingDocumentClass;
  classConfidence: FilingClassConfidence;
  /** One or two sentences. Always produced, for every class. */
  summary: string;
  /** Short factual bullets. Always produced, possibly empty. */
  keyPoints: string[];
  registrant: string | null;
  /** The period AS PRINTED, e.g. "Year ended December 31, 2025". */
  periodLabel: string | null;
  /** ISO 8601 (YYYY-MM-DD) if the document states one unambiguously. */
  periodEndDate: string | null;
  /** ISO 4217, e.g. "USD". Null when the document does not say. */
  reportingCurrency: string | null;
  unitScale: FilingUnitScale;
  facts: FilingFact[];
  statementTotals: FilingTotal[];
  events: FilingEvent[];
}

// ---------------------------------------------------------------------------
// RESPONSE SCHEMA
// ---------------------------------------------------------------------------

/** The OpenAPI-subset type names Gemini's `responseSchema` accepts. */
export type FilingSchemaType =
  | "OBJECT"
  | "ARRAY"
  | "STRING"
  | "NUMBER"
  | "INTEGER"
  | "BOOLEAN";

/**
 * A structural mirror of `@google/genai`'s `Schema`, declared locally so this
 * module stays a zero-dependency leaf — the same device
 * `document-financials-logic.ts` uses, and for the same reason.
 * `GenerateContentConfig["responseSchema"]` is `Schema | unknown`, so this
 * object is assignable to it as-is.
 */
export interface FilingResponseSchema {
  type: FilingSchemaType;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  format?: string;
  items?: FilingResponseSchema;
  properties?: Record<string, FilingResponseSchema>;
  required?: string[];
  propertyOrdering?: string[];
}

function str(description: string): FilingResponseSchema {
  return { type: "STRING", nullable: true, description };
}

function num(description: string): FilingResponseSchema {
  return { type: "NUMBER", nullable: true, description };
}

const FACT_SCHEMA: FilingResponseSchema = {
  type: "OBJECT",
  description:
    "One figure the document prints, with the line it was read from.",
  properties: {
    label: str(
      "The row label EXACTLY as printed. If the label wraps across several lines, join them with a single space and give the WHOLE label.",
    ),
    value: num(
      "The figure exactly as printed, with the printed sign. Parentheses mean negative. Do NOT apply the units multiplier.",
    ),
    periodLabel: str(
      "The column heading this figure sits under, e.g. 'December 31, 2025'.",
    ),
    statementType: {
      type: "STRING",
      description: "Which statement this figure came from.",
      enum: [...FILING_STATEMENT_TYPES],
    },
    sourceLine: str(
      "The VERBATIM line of the document the figure appears on. Copy it, do not paraphrase or re-align it.",
    ),
  },
  required: ["label", "value", "statementType"],
  propertyOrdering: [
    "label",
    "value",
    "periodLabel",
    "statementType",
    "sourceLine",
  ],
};

const TOTAL_SCHEMA: FilingResponseSchema = {
  type: "OBJECT",
  description:
    "A printed total together with the printed rows that make it up. Used to check the reading arithmetically.",
  properties: {
    label: str("The total's label EXACTLY as printed."),
    value: num("The printed total, as printed."),
    periodLabel: str("The column heading the total sits under."),
    statementType: {
      type: "STRING",
      description: "Which statement this total came from.",
      enum: [...FILING_STATEMENT_TYPES],
    },
    components: {
      type: "ARRAY",
      description:
        "The rows the document prints under this total, in printed order. Only rows the document actually prints.",
      items: FACT_SCHEMA,
    },
    sourceLine: str("The VERBATIM line the total appears on."),
  },
  required: ["label", "value", "statementType", "components"],
  propertyOrdering: [
    "label",
    "value",
    "periodLabel",
    "statementType",
    "components",
    "sourceLine",
  ],
};

const EVENT_SCHEMA: FilingResponseSchema = {
  type: "OBJECT",
  properties: {
    kind: str("Short event type, e.g. 'merger agreement', 'special meeting'."),
    description: str("One sentence describing the event."),
    date: str("ISO 8601 date (YYYY-MM-DD) if stated, otherwise null."),
  },
  required: ["kind", "description"],
  propertyOrdering: ["kind", "description", "date"],
};

/**
 * The `responseSchema` for the analysis call.
 *
 * `required` holds ONLY the three fields every class can produce. Marking
 * `facts` required would force a proxy circular to return an empty array
 * rather than omit the block, which is the same thing but invites the model to
 * fill it — the pressure to satisfy a required field is exactly how a
 * narrative document acquires a fabricated balance sheet.
 */
export const FILING_INSIGHT_SCHEMA: FilingResponseSchema = {
  type: "OBJECT",
  properties: {
    documentClass: {
      type: "STRING",
      description:
        "What kind of document this is. Decide this FIRST; everything else follows from it.",
      enum: [...FILING_DOCUMENT_CLASSES],
    },
    classConfidence: {
      type: "STRING",
      description:
        "How sure you are of documentClass. Say LOW rather than guessing HIGH.",
      enum: [...FILING_CLASS_CONFIDENCES],
    },
    summary: {
      type: "STRING",
      description:
        "One or two sentences saying what this document is and what it reports. Always produce this.",
    },
    keyPoints: {
      type: "ARRAY",
      description:
        "Up to six short factual bullets drawn from the document. No opinions, no outlook, no recommendations.",
      items: { type: "STRING" },
    },
    registrant: str("The filing company or entity name as printed."),
    periodLabel: str(
      "The reporting period AS PRINTED, e.g. 'Year ended December 31, 2025'.",
    ),
    periodEndDate: str(
      "The period end as ISO 8601 (YYYY-MM-DD), only if unambiguous.",
    ),
    reportingCurrency: str("ISO 4217 code, e.g. 'USD'. Null if not stated."),
    unitScale: {
      type: "STRING",
      description:
        "The multiplier the units header declares, e.g. '(in thousands)' is THOUSANDS. RECORD it; do NOT apply it.",
      enum: [...FILING_UNIT_SCALES],
    },
    facts: {
      type: "ARRAY",
      description:
        "Figures the document prints. Omit entirely for a document with no financial figures.",
      items: FACT_SCHEMA,
    },
    statementTotals: {
      type: "ARRAY",
      description:
        "Printed totals with their printed components. Omit entirely when the document prints no totals.",
      items: TOTAL_SCHEMA,
    },
    events: {
      type: "ARRAY",
      description: "Material events the document announces.",
      items: EVENT_SCHEMA,
    },
  },
  required: ["documentClass", "classConfidence", "summary"],
  propertyOrdering: [
    "documentClass",
    "classConfidence",
    "summary",
    "keyPoints",
    "registrant",
    "periodLabel",
    "periodEndDate",
    "reportingCurrency",
    "unitScale",
    "facts",
    "statementTotals",
    "events",
  ],
};

// ---------------------------------------------------------------------------
// THE PROMPT
// ---------------------------------------------------------------------------

export const FILING_INSIGHT_PROMPT_VERSION = "filing-insight-v1";

/**
 * Worked examples, all copied from real objects in `stockbook-content-prod`.
 *
 * They are worked examples rather than rules because every one of them is a
 * shape that a plainly-worded rule fails to convey: the wrapped label reads as
 * a normal row until you see which line the figure is on.
 */
const WORKED_EXAMPLES = `
────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 1 — THE WRAPPED LABEL. Read this one twice.
────────────────────────────────────────────────────────────────────────
This is real text from a filed balance sheet, copied exactly:

  Cash and cash equivalents           $        54,167       $        80,803
  Accounts receivable, net of
  allowance for credit losses of              164,695               145,527
  $7,511 and $7,929,
  respectively
  Prepaid expenses                              4,941                 4,490
  Taxes receivable                             19,026                13,755
  Other current assets                         14,180                12,376
  Total current assets                        257,009               256,951

There are SIX rows here, not nine. The second row's label wraps across FOUR
printed lines and its figures land on the SECOND of them:

  label   "Accounts receivable, net of allowance for credit losses of $7,511
           and $7,929, respectively"
  2025     164,695
  2024     145,527

The figures 7,511 and 7,929 are part of the LABEL. They are the allowance
amounts, they are printed inside the row's description, and they are NOT the
row's values. "respectively" is the tail of the label and is not a row.

WRONG, and it is the single most likely mistake on this kind of document:

  { "label": "allowance for credit losses of", "value": 164695 }   ← NO
  { "label": "Accounts receivable, net", "value": 7511 }           ← NO

RIGHT:

  { "label": "Accounts receivable, net of allowance for credit losses of
              $7,511 and $7,929, respectively",
    "value": 164695, "periodLabel": "December 31, 2025",
    "statementType": "BALANCE_SHEET",
    "sourceLine": "  allowance for credit losses of              164,695               145,527" }

The rule: a figure belongs to the row whose label STARTS above it and
continues through it. Read the whole wrapped label before deciding what a
figure is. When a line carries figures, look UPWARD for the start of its
label; when a line carries none, it is either the start or the tail of a
label, never a row of its own.

The same document does this repeatedly. All of these are ONE row each:

  Current maturities of long-term
  debt, net of original issue
  discount of $1,021 and $0, and               30,259                     —
  deferred financing costs of $334
  and $0, respectively

  Property, plant and equipment,              754,135               674,729
  net

  Operating lease                              17,802                20,748
  right-of-use assets

Note the last two: the label CONTINUES BELOW the figures. "net" and
"right-of-use assets" are the ends of their labels, not rows. So the correct
labels are "Property, plant and equipment, net" and "Operating lease
right-of-use assets".

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 2 — TOTALS, AND WHY WE ASK FOR COMPONENTS
────────────────────────────────────────────────────────────────────────
From the same balance sheet. The printed total and the printed rows above it:

  Total current assets                        257,009               256,951

  54,167 + 164,695 + 4,941 + 19,026 + 14,180 = 257,009   ✓
  80,803 + 145,527 + 4,490 + 13,755 + 12,376 = 256,951   ✓

Report it as ONE entry in statementTotals, with its components:

  { "label": "Total current assets", "value": 257009,
    "periodLabel": "December 31, 2025",
    "statementType": "BALANCE_SHEET",
    "components": [
      { "label": "Cash and cash equivalents", "value": 54167, ... },
      { "label": "Accounts receivable, net of allowance ...", "value": 164695, ... },
      { "label": "Prepaid expenses", "value": 4941, ... },
      { "label": "Taxes receivable", "value": 19026, ... },
      { "label": "Other current assets", "value": 14180, ... }
    ] }

Components must be the rows the DOCUMENT prints under that total, in printed
order, and they must all be from the SAME period column as the total. Do not
add rows from elsewhere to make a sum work, and do not drop a row that spoils
one. We check this arithmetic. A total whose components do not add up tells us
the reading is wrong, which is the entire point — a sum you have "fixed"
tells us nothing and hides a real error.

If the document prints a total whose components you cannot identify, give the
total with an EMPTY components array. That is honest and useful. An invented
component list is neither.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 3 — HOW FIGURES ARE PRINTED
────────────────────────────────────────────────────────────────────────
From a real statement of operations:

  Vessel          $               669,004       $  592,246       $  528,780
  revenues
  Non-vessel                       50,826           48,605           44,669
  revenues
                                  719,830          640,851          573,449
  Costs and
  expenses:
  Operating                       376,291          364,584          305,463
  expense
  General and
  administrat…                     74,461           71,110           66,108
  expense
  Provision
  for
  (recovery                        (418  )          1,622               551
  of) credit
  losses
  Deferred
  tax expense                    (6,049  )          4,607             1,340
  (benefit)

Five things to take from this:

1. THREE period columns. Report each figure once per period you report, with
   its own periodLabel. Never merge columns.
2. The unlabelled row "719,830 640,851 573,449" is the TOTAL of the two
   revenue rows above it (669,004 + 50,826 = 719,830). A total can be printed
   with NO label. Label it from context — "Total revenues" — and say so in
   sourceLine so we can see what you did.
3. "(418  )" is NEGATIVE four hundred and eighteen. Parentheses mean negative
   in every one of these documents, and the extractor leaves spaces inside
   them. Report -418.
4. "administrat…" is a TRUNCATED label. The ellipsis is extraction damage, not
   printed text. Reconstruct it from the surrounding words — "General and
   administrative expense" — and do not copy the ellipsis into the label.
5. "—" (an em dash) in a figure column means ZERO or nothing reported. Report
   0 when the document uses it as a zero in a column of figures. Never report
   the dash as a number and never treat it as a missing row.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 4 — A DOCUMENT WITH NO FINANCIAL STATEMENTS
────────────────────────────────────────────────────────────────────────
Real text from another EX-99 exhibit, filed under the same exhibit number as
the balance sheet above:

                    NOTICE OF SPECIAL MEETING OF UNITHOLDERS
                         TO BE HELD ON OCTOBER 14, 2026
                     JOINT MANAGEMENT INFORMATION CIRCULAR
                 WITH RESPECT TO A PROPOSED PLAN OF ARRANGEMENT
               INVOLVING BROOKFIELD INFRASTRUCTURE PARTNERS L.P., ...

This is PROXY_OR_MEETING. The correct response is SHORT:

  { "documentClass": "PROXY_OR_MEETING",
    "classConfidence": "HIGH",
    "summary": "Notice of a special meeting of unitholders and shareholders
                to be held on October 14, 2026, with a joint management
                information circular for a proposed plan of arrangement
                involving Brookfield Infrastructure Partners L.P.",
    "keyPoints": [ ... ],
    "registrant": "Brookfield Infrastructure Partners L.P.",
    "events": [ { "kind": "special meeting",
                  "description": "Special meeting of unitholders and
                                  shareholders to vote on a plan of
                                  arrangement.",
                  "date": "2026-10-14" } ] }

The fields "facts" and "statementTotals" are ABSENT. Not empty arrays with
apologies in them, not a table scraped out of the fee schedule — absent. A
document with no financial statements must not produce any.

The same applies to a 10-K "Item 1. Business" section (BUSINESS_DESCRIPTION):
it is prose about operations and it may quote production figures in passing.
Those are not financial statements. Put them in keyPoints, not in
statementTotals.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 5 — DECIDING THE CLASS
────────────────────────────────────────────────────────────────────────
EARNINGS_RELEASE       announces results for a period: has a headline, a
                       quote from an executive, and usually condensed
                       statements attached. The giveaway is the announcement
                       framing — "X Reports Fourth Quarter Results".
FINANCIAL_STATEMENTS   the statements themselves, with no announcement
                       wrapper. Often an auditor's report, then a balance
                       sheet, then operations, then cash flows, then notes.
                       The measured example above is this class, attached to
                       a merger 8-K.
PRESS_RELEASE          announces something that is not results: a contract, a
                       leadership change, a product, a completed offering.
PROXY_OR_MEETING       meeting notices, information circulars, proxy
                       statements, plans of arrangement.
BUSINESS_DESCRIPTION   a description of operations, properties or segments,
                       typically a section lifted from a 10-K or 20-F.
OTHER                  anything else — a credit agreement, a slide deck, an
                       indenture, an investor FAQ.

A document can look like two of these. Choose the one that describes the
DOCUMENT AS A WHOLE, not its largest table, and lower classConfidence to
MEDIUM or LOW to say so. An earnings release with statements attached is
EARNINGS_RELEASE, because the statements are attached to the announcement and
not the other way round.

If nothing fits, answer OTHER with a summary. OTHER is a correct answer and we
would much rather have it than a document forced into a class it is not.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 6 — THE CASH FLOW STATEMENT, WHERE WRAPPING IS WORST
────────────────────────────────────────────────────────────────────────
Cash flow statements have the longest labels in any filing, so they wrap the
hardest. Real text, copied exactly:

  CASH FLOWS
  FROM
  OPERATING
  ACTIVITIES:
  Net income     $              173,390       $    92,802       $    74,538
  Adjustments
  to
  reconcile
  net income
  to
  net cash
  provided by
  operating
  activities:
  Depreciati…                    41,554            37,812            26,355
  expense
  Amortizati…                    43,815            26,734            21,496
  expense
  Loss on
  early                              67                 —             1,236
  extinguish…
  of debt
  Provision
  for
  (recovery                        (418  )          1,622               551
  of) credit
  losses

Reading this correctly:

  - "CASH FLOWS FROM OPERATING ACTIVITIES:" is a SECTION HEADING spread over
    four lines. It is not a row and it has no value. Do not report it.
  - "Adjustments to reconcile net income to net cash provided by operating
    activities:" is likewise a heading, spread over EIGHT lines, ending in a
    colon. A label ending in a colon with no figures on any of its lines is a
    heading, every time.
  - "Depreciati… expense" is one row. The label is truncated by extraction;
    reconstruct it as "Depreciation expense".
  - "Loss on early extinguish… of debt" is ONE row whose label wraps around
    the figures on BOTH sides — "Loss on" and "early" above, "extinguish… of
    debt" below. Its 2025 value is 67, its 2024 value is 0 (printed as an em
    dash), its 2023 value is 1,236.
  - "Provision for (recovery of) credit losses" is one row with the figures on
    its THIRD line. 2025 is -418.

If you cannot tell whether a run of lines is a heading or a row, look for
figures. A run with no figures anywhere in it is a heading or a label tail. A
run with figures on exactly one line is one row.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 7 — WHAT NOT TO EXTRACT
────────────────────────────────────────────────────────────────────────
Filings carry a great deal of prose that contains figures and is not a
financial statement. None of the following belongs in facts or
statementTotals:

  - THE AUDITOR'S REPORT. It names note numbers, materiality thresholds and
    dates. "We have served as the Company's auditors since 2002" contains
    2002; it is not a financial fact.
  - THE NOTES, unless a note prints an actual statement table. A note saying
    "the Company recorded $7.5 million of expense" is prose. If you want to
    record it, it is a keyPoint.
  - FEE SCHEDULES, share counts in a meeting notice, record dates, page
    numbers, section numbers, exhibit numbers, phone numbers, CIK numbers,
    and street addresses.
  - ANYTHING FROM A TABLE OF CONTENTS. A contents entry looks like a heading
    followed by a page number. It is never a statement row.

And two more rules about periods, which are the other common way a reading
goes quietly wrong:

  - A statement of operations usually prints THREE years and a balance sheet
    usually prints TWO. Read the column headings and attach the right
    periodLabel to every figure. If you report only one period, report the
    MOST RECENT and say which it is.
  - "Year ended December 31, 2025" and "December 31, 2025" are different
    things — a period and an instant. Copy whichever the document prints
    above the column. Do not normalise it, do not shorten it, and do not
    convert it to a date; periodEndDate is the only ISO field and it is for
    the document's primary period only.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 8 — A SELECTION, NOT ALWAYS THE WHOLE DOCUMENT
────────────────────────────────────────────────────────────────────────
Large exhibits are sent to you as a SELECTION of sections in document order,
with spans removed. When that happens the context block below says so.

Two consequences:

  - Two sections that appear next to each other may not have been adjacent in
    the filing. Do not infer that a total immediately follows the rows above
    it on the page.
  - A figure being absent from what you were given does NOT mean the filing
    does not report it. Return null for what you cannot see, and never
    reconstruct a missing row from the ones around it.

Report only what is in front of you. That is always the correct behaviour and
it is especially so here.

────────────────────────────────────────────────────────────────────────
THE OUTPUT CONTRACT, FIELD BY FIELD
────────────────────────────────────────────────────────────────────────
documentClass       Required. One of EARNINGS_RELEASE, FINANCIAL_STATEMENTS,
                    PRESS_RELEASE, PROXY_OR_MEETING, BUSINESS_DESCRIPTION,
                    OTHER. Decide it first.
classConfidence     Required. HIGH, MEDIUM or LOW. Use LOW freely; it costs
                    nothing and a wrong HIGH costs a great deal.
summary             Required. One or two sentences, factual, describing what
                    the document is and what it reports. Never empty — every
                    document, however unusual, can be described in a sentence.
keyPoints           Up to six short factual bullets. Figures quoted in prose
                    belong here rather than in facts. No outlook, no
                    interpretation, no recommendation, no adjective the
                    document did not itself use.
registrant          The filing entity's name as printed. Null if unclear.
periodLabel         The reporting period AS PRINTED. Copy it verbatim.
periodEndDate       ISO 8601 (YYYY-MM-DD) for the primary period end, ONLY if
                    the document states it unambiguously. Null otherwise. Do
                    not infer a year end from a filing date.
reportingCurrency   ISO 4217, e.g. "USD". Null when the document does not say.
                    Do not infer it from the country of incorporation.
unitScale           UNITS, THOUSANDS, MILLIONS, BILLIONS or UNKNOWN, taken
                    from the statement's own units header — "(in thousands,
                    except per share data)" is THOUSANDS. Record it; never
                    apply it. UNKNOWN is correct when no header says.
facts               Individual printed figures. Omit the field entirely for a
                    document that prints no financial statements.
statementTotals     Printed totals with their printed components. Omit
                    entirely when there are none. This is the block we check
                    arithmetically, so it is the block where invention is
                    most costly and most visible.
events              Material events the document announces, with ISO dates
                    where stated. A meeting, a merger, a dividend, an
                    offering, a leadership change.

Every field not marked Required may be omitted or null. Omitting a field you
cannot fill honestly is ALWAYS preferred to filling it. We would rather have a
three-field answer that is true than a twelve-field answer that is mostly
plausible.

One last time, because it is the failure this whole prompt is built around:
BEFORE YOU ATTRIBUTE A FIGURE, READ THE WHOLE LABEL THAT WRAPS AROUND IT.
`.trim();

/**
 * The stable prefix: rules and worked examples, byte-identical for every
 * document.
 *
 * IT MUST LEAD THE REQUEST AND IT MUST BE LONG. Gemini 3.x gives an implicit
 * cache discount of ~90% on the input prefix that repeats across calls, but
 * only once that prefix clears {@link IMPLICIT_CACHE_MIN_TOKENS}. Below the
 * threshold there is no discount, no warning and no counter — the requests
 * keep succeeding at full price and the only symptom is a bill. That is why
 * the variable per-document context is appended AFTER this by
 * {@link buildFilingInsightPrompt}, never before.
 *
 * See {@link filingPrefixCacheStatus} for the size argument, which is a
 * character-based ESTIMATE here and deliberately says so.
 */
export const FILING_INSIGHT_FIXED_PREFIX = [
  "You are reading the text of an exhibit filed with the United States",
  "Securities and Exchange Commission — an 8-K or 6-K attachment. The text was",
  "extracted from HTML, so tables are FIXED-WIDTH: a label on the left and",
  "figures right-aligned in columns, sometimes with a horizontal rule under",
  "the column headings.",
  "",
  "DO NOT ASSUME WHAT KIND OF DOCUMENT THIS IS. Exhibit 99.1 is not a document",
  "class. Measured across real filings, the same exhibit number carries",
  "audited financial statements, sections lifted from a 10-K, meeting notices",
  "and ordinary press releases. Decide the class from what you actually read.",
  "",
  "Return ONLY what the document prints. Every rule below exists because the",
  "alternative produces an answer that looks right and is not.",
  "",
  "Rules:",
  "",
  "1. DECIDE `documentClass` FIRST, then fill only the blocks that class",
  "   supports. A document with no financial statements must return no",
  "   `facts` and no `statementTotals` at all.",
  "",
  "2. READ THE WHOLE WRAPPED LABEL BEFORE ATTRIBUTING A FIGURE. Labels in",
  "   these documents wrap across two, three or four printed lines, and the",
  "   figures very often land on a line that is NOT the first line of the",
  "   label. Worked example 1 is this and only this. Get it wrong and every",
  "   number on the statement shifts to the wrong row while still looking",
  "   entirely plausible.",
  "",
  "3. REPORT FIGURES AS PRINTED. Keep the printed sign. Parentheses mean",
  "   negative. Do NOT apply the units multiplier — record it in `unitScale`",
  "   and leave the figure alone. We convert; you transcribe. A figure you",
  "   have scaled can no longer be found in the document, and finding it is",
  "   how we check you.",
  "",
  "4. COPY `sourceLine` VERBATIM from the document for every figure you",
  "   report. Do not paraphrase it, do not re-align its spacing, do not tidy",
  "   it. It is how a wrong answer gets diagnosed rather than merely noticed.",
  "",
  "5. GIVE TOTALS THEIR PRINTED COMPONENTS. We check that they add up. Never",
  "   adjust a component, drop one, or borrow one from another column to make",
  "   a sum work — a corrected sum destroys the only check we have. If you",
  "   cannot identify the components, return the total with an empty",
  "   components array.",
  "",
  "6. NEVER COMPUTE A FIGURE THE DOCUMENT DOES NOT PRINT. No subtotals you",
  "   derived, no period-over-period changes, no margins, no per-share",
  "   figures you divided out. If it is not on the page, it is null or it is",
  "   absent.",
  "",
  "7. NEVER CARRY A FIGURE ACROSS PERIODS. Each period column is its own set",
  "   of values. A blank cell in one column is not the other column's number.",
  "",
  "8. `summary` and `keyPoints` are FACTUAL. Say what the document reports.",
  "   No outlook, no interpretation, no investment view, no adjectives the",
  "   document did not use.",
  "",
  "9. WHEN IN DOUBT, RETURN LESS. A null, an omitted block or an OTHER class",
  "   costs us nothing. A confident wrong figure is expensive and, unlike a",
  "   missing one, invisible.",
  "",
  WORKED_EXAMPLES,
].join("\n");

/** The variable tail. Never part of the cached prefix. */
export function buildFilingContext(ctx: FilingInsightContext): string {
  const lines = [
    "",
    "────────────────────────────────────────────────────────────────────────",
    "THE DOCUMENT TO READ",
    "────────────────────────────────────────────────────────────────────────",
  ];
  if (ctx.registrantHint)
    lines.push(`Filer (hint only): ${ctx.registrantHint}`);
  if (ctx.cik) lines.push(`CIK: ${ctx.cik}`);
  if (ctx.accession) lines.push(`Accession: ${ctx.accession}`);
  if (ctx.formType) lines.push(`Form type: ${ctx.formType}`);
  if (ctx.exhibitLabel) lines.push(`Exhibit: ${ctx.exhibitLabel}`);
  if (ctx.filedAt) lines.push(`Filed: ${ctx.filedAt}`);
  if (ctx.truncated) {
    lines.push(
      "",
      "NOTE: this document was too large to send whole. What follows is a",
      "SELECTION of its sections, in document order, with omitted spans",
      "removed. Do not infer that a figure is absent from the filing merely",
      "because it is absent here, and do not treat two adjacent sections as",
      "necessarily contiguous.",
    );
  }
  lines.push(
    "",
    "────────────────────────────────────────────────────────────────────────",
    "DOCUMENT TEXT",
    "────────────────────────────────────────────────────────────────────────",
    ctx.text,
  );
  return lines.join("\n");
}

/** What the caller knows about the document. All of it optional but `text`. */
export interface FilingInsightContext {
  text: string;
  cik?: string | null;
  accession?: string | null;
  formType?: string | null;
  exhibitLabel?: string | null;
  filedAt?: string | null;
  registrantHint?: string | null;
  /** True when the text is a selection rather than the whole document. */
  truncated?: boolean;
}

/** Fixed prefix first, variable context second. The order is the cache. */
export function buildFilingInsightPrompt(ctx: FilingInsightContext): string {
  return `${FILING_INSIGHT_FIXED_PREFIX}\n${buildFilingContext(ctx)}`;
}

// ---------------------------------------------------------------------------
// IMPLICIT CACHING
// ---------------------------------------------------------------------------

/** Gemini 3.x implicit-cache floor. Below this there is no discount at all. */
export const IMPLICIT_CACHE_MIN_TOKENS = 4_096;

/**
 * Chars per token on prompt prose of this kind.
 *
 * NOT a guess: MONEY-1314 measured its own fixed prefix at 16,073 chars =
 * 4,506 tokens on `gemini-3.7-flash` (`MEASURED_FIXED_PREFIX` in
 * `workers/src/lib/gemini-doc-request-logic.ts`), i.e. 3.567. This prefix is
 * the same kind of content — English instructions plus worked examples — on
 * the same model.
 */
export const MEASURED_PROMPT_CHARS_PER_TOKEN = 3.567;

/**
 * The ratio the size argument is actually made at.
 *
 * Deliberately WORSE than the measured 3.567. The threshold is a cliff with no
 * feedback on the wrong side of it, so the margin is sized to survive the
 * ratio being ~12% worse than measured rather than to be tight against it.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 4.0;

/**
 * Does the fixed prefix clear the implicit-caching threshold?
 *
 * `estimated: true` IS THE POINT AND MUST NOT BE QUIETLY DROPPED. There is no
 * local tokenizer for this model, and this module is a pure leaf that may not
 * make a network call, so unlike MONEY-1314's `MEASURED_FIXED_PREFIX` — which
 * pins a real `countTokens` result to a sha256 of the bytes it was taken on —
 * this is arithmetic over a character count. Reporting it as measured would be
 * a number vouching for a check nobody ran, which is the failure mode that
 * makes a tripwire worse than none.
 *
 * What makes the estimate load-bearing anyway is the MARGIN, not the ratio:
 * the prefix is sized so it clears 4,096 tokens even at
 * {@link CONSERVATIVE_CHARS_PER_TOKEN}, which is already worse than the
 * measured ratio on this model. `conservativeTokens` is the number to read.
 *
 * TO REPLACE THE ESTIMATE WITH A MEASUREMENT (worth doing once the lane runs):
 *   POST …/v1beta/models/<model>:countTokens
 *   { "contents": [{ "role": "user",
 *                    "parts": [{ "text": FILING_INSIGHT_FIXED_PREFIX }] }] }
 * then pin the result together with a sha256 of the prefix, exactly as
 * `MEASURED_FIXED_PREFIX` does.
 */
export function filingPrefixCacheStatus(): {
  chars: number;
  estimatedTokens: number;
  conservativeTokens: number;
  min: number;
  clears: boolean;
  estimated: true;
} {
  const chars = FILING_INSIGHT_FIXED_PREFIX.length;
  const conservativeTokens = Math.floor(chars / CONSERVATIVE_CHARS_PER_TOKEN);
  return {
    chars,
    estimatedTokens: Math.floor(chars / MEASURED_PROMPT_CHARS_PER_TOKEN),
    conservativeTokens,
    min: IMPLICIT_CACHE_MIN_TOKENS,
    clears: conservativeTokens >= IMPLICIT_CACHE_MIN_TOKENS,
    estimated: true,
  };
}

// ---------------------------------------------------------------------------
// PARSING THE RESPONSE — degrade, never throw
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A finite number, or null.
 *
 * A numeric STRING is accepted and parsed, because a model asked for a number
 * inside a JSON schema still occasionally returns `"164,695"`. Rejecting it
 * would drop a correct reading over a formatting slip; accepting it costs
 * nothing, because whatever comes out is still checked against the document by
 * {@link checkFactsGrounded}. NaN and Infinity are rejected outright — a
 * non-finite figure poisons every sum it reaches.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\s,$]/g, "");
  if (cleaned === "") return null;
  const negative = /^\(.*\)$/.test(cleaned);
  const bare = negative ? cleaned.slice(1, -1) : cleaned;
  if (!/^[-+]?\d*\.?\d+$/.test(bare)) return null;
  const parsed = Number(bare);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== "string") return fallback;
  const upper = value.trim().toUpperCase();
  return (allowed as readonly string[]).includes(upper)
    ? (upper as T)
    : fallback;
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = asString(entry);
    if (s !== null) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function normaliseFact(raw: unknown): FilingFact | null {
  if (!isRecord(raw)) return null;
  const label = asString(raw["label"]);
  if (label === null) return null;
  return {
    label,
    value: asNumber(raw["value"]),
    periodLabel: asString(raw["periodLabel"]),
    statementType: asEnum(
      raw["statementType"],
      FILING_STATEMENT_TYPES,
      "OTHER",
    ),
    sourceLine: asString(raw["sourceLine"]),
  };
}

function normaliseTotal(raw: unknown): FilingTotal | null {
  if (!isRecord(raw)) return null;
  const label = asString(raw["label"]);
  if (label === null) return null;
  const componentsRaw = raw["components"];
  const components: FilingFact[] = Array.isArray(componentsRaw)
    ? componentsRaw
        .map(normaliseFact)
        .filter((f): f is FilingFact => f !== null)
    : [];
  return {
    label,
    value: asNumber(raw["value"]),
    periodLabel: asString(raw["periodLabel"]),
    statementType: asEnum(
      raw["statementType"],
      FILING_STATEMENT_TYPES,
      "OTHER",
    ),
    components,
    sourceLine: asString(raw["sourceLine"]),
  };
}

function normaliseEvent(raw: unknown): FilingEvent | null {
  if (!isRecord(raw)) return null;
  const kind = asString(raw["kind"]);
  const description = asString(raw["description"]);
  if (kind === null && description === null) return null;
  return {
    kind: kind ?? "event",
    description: description ?? "",
    date: asString(raw["date"]),
  };
}

/** Most `keyPoints` kept. Beyond this the model is padding, not reporting. */
export const MAX_KEY_POINTS = 12;

/**
 * Turn whatever the model returned into a {@link FilingInsight}.
 *
 * DEGRADES, NEVER THROWS — that is the contract the sweep processor depends
 * on. A response missing every optional block is a valid insight with fewer
 * fields; an unrecognised `documentClass` becomes `"OTHER"` rather than an
 * error, because a new kind of exhibit is a thing we want recorded, not a
 * thing we want to crash a nightly sweep. Returns null ONLY when the input is
 * not an object at all, which is the one case where there is nothing to
 * degrade to.
 *
 * Note that an unrecognised class arrives with `classConfidence` degraded to
 * `"LOW"` as well: the model's own confidence referred to the class it named,
 * and that class is not one we accepted, so carrying its confidence forward
 * would be attaching a claim to a different answer.
 */
export function normaliseFilingInsight(raw: unknown): FilingInsight | null {
  if (!isRecord(raw)) return null;

  const rawClass = raw["documentClass"];
  const documentClass = asEnum(rawClass, FILING_DOCUMENT_CLASSES, "OTHER");
  const classRecognised =
    typeof rawClass === "string" &&
    (FILING_DOCUMENT_CLASSES as readonly string[]).includes(
      rawClass.trim().toUpperCase(),
    );

  const facts = Array.isArray(raw["facts"])
    ? raw["facts"].map(normaliseFact).filter((f): f is FilingFact => f !== null)
    : [];
  const statementTotals = Array.isArray(raw["statementTotals"])
    ? raw["statementTotals"]
        .map(normaliseTotal)
        .filter((t): t is FilingTotal => t !== null)
    : [];
  const events = Array.isArray(raw["events"])
    ? raw["events"]
        .map(normaliseEvent)
        .filter((e): e is FilingEvent => e !== null)
    : [];

  return {
    documentClass,
    classConfidence: classRecognised
      ? asEnum(raw["classConfidence"], FILING_CLASS_CONFIDENCES, "LOW")
      : "LOW",
    summary: asString(raw["summary"]) ?? "",
    keyPoints: asStringArray(raw["keyPoints"], MAX_KEY_POINTS),
    registrant: asString(raw["registrant"]),
    periodLabel: asString(raw["periodLabel"]),
    periodEndDate: asString(raw["periodEndDate"]),
    reportingCurrency: asString(raw["reportingCurrency"]),
    unitScale: asEnum(raw["unitScale"], FILING_UNIT_SCALES, "UNKNOWN"),
    facts,
    statementTotals,
    events,
  };
}

// ---------------------------------------------------------------------------
// VALIDATION — detect, never repair
// ---------------------------------------------------------------------------

export type FilingIssueKind =
  | "ungrounded-value"
  | "ungrounded-source-line"
  | "cross-foot-mismatch"
  | "class-block-mismatch";

export interface FilingIssue {
  kind: FilingIssueKind;
  /** Human-readable, and specific enough to act on without the payload. */
  message: string;
  /** The label the issue is about, when it is about one. */
  label: string | null;
  /** The value the issue is about, when it is about one. */
  value: number | null;
}

export interface FilingValidation {
  ok: boolean;
  issues: FilingIssue[];
  /** How many reported figures were checkable against the source text. */
  checkedValues: number;
  /** How many totals had enough components to cross-foot. */
  checkedTotals: number;
}

/**
 * Figures the source text prints, as numbers.
 *
 * Built by the SAME token rules the selector uses, so "grounded" means the
 * same thing on both sides of the pipeline. Parenthesised figures are indexed
 * under BOTH signs: the document prints "(418  )" and the model is instructed
 * to report -418, but a model reporting 418 for a row the document itself
 * labels as a deduction is a sign convention disagreement, not a hallucination,
 * and this check is about presence in the document. Sign is the cross-foot's
 * job.
 */
export function indexSourceFigures(sourceText: string): Set<number> {
  const out = new Set<number>();
  const token = /(?<![\w.,])\(?\s*-?\d[\d,]*(?:\.\d+)?\s*\)?%?(?![\w])/g;
  let match: RegExpExecArray | null = token.exec(sourceText);
  while (match !== null) {
    const raw = match[0].trim();
    if (/\d/.test(raw)) {
      const negative = raw.startsWith("(");
      const bare = raw.replace(/[()%\s,]/g, "");
      const parsed = Number(bare);
      if (Number.isFinite(parsed)) {
        out.add(parsed);
        out.add(-parsed);
        if (negative) out.add(-Math.abs(parsed));
      }
    }
    match = token.exec(sourceText);
  }
  return out;
}

/** Collapse runs of whitespace so a copied line matches despite re-alignment. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every fact in the insight, totals and their components included.
 *
 * A total is itself a figure that must be grounded — it is exactly the figure
 * a model is most tempted to compute rather than read.
 */
export function collectFacts(insight: FilingInsight): FilingFact[] {
  const out: FilingFact[] = [...insight.facts];
  for (const total of insight.statementTotals) {
    out.push({
      label: total.label,
      value: total.value,
      periodLabel: total.periodLabel,
      statementType: total.statementType,
      sourceLine: total.sourceLine,
    });
    out.push(...total.components);
  }
  return out;
}

/**
 * Is every reported figure actually printed in the source text?
 *
 * Catches a hallucinated figure and a computed one. Does NOT catch
 * mis-attribution — a figure read off the wrong row is still a figure the
 * document prints — which is what {@link checkTotalsCrossFoot} is for. Saying
 * so here rather than in a commit message, because a caller that believes this
 * covers attribution will stop looking for the thing that does.
 */
export function checkFactsGrounded(
  insight: FilingInsight,
  sourceText: string,
): { issues: FilingIssue[]; checkedValues: number } {
  const figures = indexSourceFigures(sourceText);
  const collapsedSource = collapse(sourceText);
  const issues: FilingIssue[] = [];
  let checkedValues = 0;

  for (const fact of collectFacts(insight)) {
    if (fact.value !== null) {
      checkedValues += 1;
      if (!figures.has(fact.value)) {
        issues.push({
          kind: "ungrounded-value",
          message: `"${fact.label}" reports ${fact.value}, which does not appear in the document text`,
          label: fact.label,
          value: fact.value,
        });
      }
    }
    if (fact.sourceLine !== null) {
      const line = collapse(fact.sourceLine);
      if (line !== "" && !collapsedSource.includes(line)) {
        issues.push({
          kind: "ungrounded-source-line",
          message: `"${fact.label}" cites a source line that is not in the document text`,
          label: fact.label,
          value: fact.value,
        });
      }
    }
  }

  return { issues, checkedValues };
}

/**
 * Relative tolerance for a total against the sum of its components.
 *
 * Tight, because it can be: both measured columns of the HLX balance sheet
 * cross-foot EXACTLY, and these documents print whole units. The tolerance
 * exists for rounding in a statement printed in millions to one decimal, not
 * to absorb a mis-read row — a 0.5% band still fails the 61% miss that a
 * wrapped-label mis-attribution produces.
 */
export const CROSS_FOOT_RELATIVE_TOLERANCE = 0.005;

/** Absolute floor, so a total of 0 does not make every tolerance 0. */
export const CROSS_FOOT_ABSOLUTE_TOLERANCE = 1;

/**
 * Do printed totals equal the sum of their printed components?
 *
 * Only totals with at least two components and a printed value are checked; a
 * total the model returned with an empty components array is honest and
 * uncheckable, and counting it as a failure would punish exactly the behaviour
 * the prompt asks for.
 *
 * Components are matched to the total's period when both carry a
 * `periodLabel`. Without that, a three-column statement of operations sums
 * across years and every total fails — which reads as a broken model rather
 * than a broken check, and is how a check gets deleted for being noisy.
 */
export function checkTotalsCrossFoot(insight: FilingInsight): {
  issues: FilingIssue[];
  checkedTotals: number;
} {
  const issues: FilingIssue[] = [];
  let checkedTotals = 0;

  for (const total of insight.statementTotals) {
    if (total.value === null) continue;

    const components = total.components.filter((c) => {
      if (c.value === null) return false;
      if (total.periodLabel === null || c.periodLabel === null) return true;
      return collapse(c.periodLabel) === collapse(total.periodLabel);
    });
    if (components.length < 2) continue;

    checkedTotals += 1;
    const sum = components.reduce((acc, c) => acc + (c.value ?? 0), 0);
    const tolerance = Math.max(
      CROSS_FOOT_ABSOLUTE_TOLERANCE,
      Math.abs(total.value) * CROSS_FOOT_RELATIVE_TOLERANCE,
    );
    if (Math.abs(sum - total.value) > tolerance) {
      issues.push({
        kind: "cross-foot-mismatch",
        message: `"${total.label}" is printed as ${total.value} but its ${components.length} components sum to ${sum}`,
        label: total.label,
        value: total.value,
      });
    }
  }

  return { issues, checkedTotals };
}

/**
 * Classes that must not carry financial blocks.
 *
 * A proxy circular with a balance sheet in it is a model that found a fee
 * table and treated it as a statement. Reported, not stripped — the blocks may
 * be genuinely present in an unusual document, and deleting data on a
 * heuristic is a repair.
 */
const CLASSES_WITHOUT_STATEMENTS: readonly FilingDocumentClass[] = [
  "PROXY_OR_MEETING",
  "BUSINESS_DESCRIPTION",
];

/** Does the response's shape agree with the class it claims? */
export function checkClassBlocks(insight: FilingInsight): FilingIssue[] {
  const issues: FilingIssue[] = [];
  if (
    CLASSES_WITHOUT_STATEMENTS.includes(insight.documentClass) &&
    insight.statementTotals.length > 0
  ) {
    issues.push({
      kind: "class-block-mismatch",
      message: `documentClass ${insight.documentClass} returned ${insight.statementTotals.length} statement total(s), which that class does not normally have`,
      label: null,
      value: null,
    });
  }
  return issues;
}

/**
 * Run every check. DETECT ONLY — the insight is returned to the caller
 * unchanged and no value is rewritten.
 *
 * `ok` is "no issues found", not "the reading is correct". The difference
 * matters and is the whole content of the block comment at the top of this
 * file: grounding cannot see mis-attribution, and cross-footing sees it only
 * where a printed total exists to catch it.
 */
export function validateFilingInsight(
  insight: FilingInsight,
  sourceText: string,
): FilingValidation {
  const grounded = checkFactsGrounded(insight, sourceText);
  const crossFoot = checkTotalsCrossFoot(insight);
  const classBlocks = checkClassBlocks(insight);
  const issues = [...grounded.issues, ...crossFoot.issues, ...classBlocks];
  return {
    ok: issues.length === 0,
    issues,
    checkedValues: grounded.checkedValues,
    checkedTotals: crossFoot.checkedTotals,
  };
}
