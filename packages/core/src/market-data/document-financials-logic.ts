/**
 * Reading FINANCIAL STATEMENTS out of a filed PDF — the pure half (MONEY-1255).
 *
 * The response schema handed to Gemini, the scale normalisation that turns
 * whatever the document declared into CRORES, and the arithmetic that decides
 * whether an answer is usable. NO I/O, no SDK, no Prisma — everything here is a
 * function of its arguments, so the worker's production path and its tests run
 * the SAME code (`workers/src/processors/stock-document-parse.ts` imports and
 * calls every export below).
 *
 * PURE LEAF. Import it by SUBPATH
 * (`@usemoney/core/market-data/document-financials-logic`), never through the
 * market-data barrel.
 *
 * ## The failure mode this module is shaped around
 *
 * A model reading a 200-page annual report does not usually return nonsense —
 * it returns something plausible and confidently wrong. The three ways it goes
 * wrong that a downstream reader can never detect are:
 *
 *   1. **SCALE.** Indian filings declare their own units in a header — "₹ in
 *      Lakhs", "₹ in Millions", "(Rs. in '000s)" — and routinely switch between
 *      statements inside one report (the P&L in crore, the cash-flow in lakh).
 *      A figure that is 100x wrong looks exactly like a figure that is right.
 *      So: the declared label is mapped to a factor, the factor is APPLIED, and
 *      BOTH the verbatim label and the applied factor are recorded on the row.
 *      An unrecognised label is NOT assumed to be crores — it is rejected.
 *   2. **NON-FINITE.** `NaN` / `Infinity` reaching a money column poisons every
 *      aggregate downstream of it and `?? 0` does not catch either (`NaN ?? 0`
 *      is `NaN`). This repo's most-repeated defect class. Every numeric field is
 *      checked with `Number.isFinite` before it can be persisted.
 *   3. **CONVENTION.** Two different quantities share one English word. See the
 *      next section — this is why there is no `revenue` field here at all.
 *
 * ## Ask for the COMPONENTS the filing prints; derive our totals elsewhere
 *
 * The canonical `stock_financials.revenue` is TOTAL INCOME, but a filing's
 * headline "Revenue" line is almost always "Revenue from operations" — a
 * different quantity. A model asked for "revenue" returns one or the other
 * confidently and there is no way, after the fact, to tell which it returned.
 * The gap between them flips the sign of a derived EBITDA on a measurable
 * fraction of filings, and it is unrecoverable once stored.
 *
 * Schedule III removes the guesswork: it MANDATES "Revenue from operations" and
 * "Other income" as SEPARATE line items and states their sum as "Total income".
 * So this schema asks for the two components by their Schedule III names, and
 * `revenue` is derived downstream by the projection — and only where BOTH
 * components were read. There is no `revenue` field for the model to fill and
 * no `revenue` key on {@link MappedExtract}: a column this reader cannot source
 * is a column it does not claim.
 *
 * `operatingIncome`, `ebitda` and `grossProfit` are left unowned for the same
 * reason. Their vendor-side conventions were established empirically against
 * XBRL and there is no equivalent evidence for a PDF reading, so no prompt
 * budget is spent on them. `operatingIncomeExOtherIncome` and
 * `ebitdaBeforeExceptionalItems` ARE captured — they are named for what they
 * measure and carry no convention ambiguity.
 *
 * ## What the checks here can and cannot prove
 *
 * Stated up front because a check believed to be stronger than it is costs more
 * than no check at all (MONEY-1234):
 *
 *   - `totalIncome ≈ revenueFromOperations + otherIncome` is read as THREE
 *     independent values, so it does catch the conflation it exists for — a
 *     "Total income" figure landing in `revenueFromOperations`, a component
 *     omitted, or the three read out of different columns of the table. It is
 *     addition, so it is SYMMETRIC under swapping the two components and cannot
 *     detect THAT. A separate magnitude warning, not this identity, is what
 *     speaks to a swap.
 *   - The balance-sheet identity `A ≈ L + E` catches a scale error only when
 *     the document switched scale BETWEEN statements. It is INVARIANT under
 *     multiplying all three terms by the same constant, so a uniformly-wrong
 *     scale sails through it. Only {@link MAX_PLAUSIBLE_CRORE} sees that, and
 *     only when the result lands outside the band.
 *   - The paid-up-capital identity `paidUp = shares × faceValue` is a PRODUCT
 *     and is therefore SYMMETRIC under swapping `shares` and `faceValue`. It
 *     cannot detect that swap. What separates those two fields is the
 *     independent magnitude band on `faceValue`, not the identity.
 *   - The EPS identity `eps ≈ netIncome / shares` is a QUOTIENT and is NOT
 *     symmetric, so it does detect a swap — but reported EPS is computed on
 *     WEIGHTED-AVERAGE shares and, in a consolidated statement, on profit
 *     ATTRIBUTABLE TO OWNERS, so a genuine few-percent disagreement is normal.
 *     It is a WARNING and must never reject a row on its own.
 */

// ---------------------------------------------------------------------------
// PROMPT / SCHEMA VERSIONING
// ---------------------------------------------------------------------------

/**
 * Stamped onto every row as `DocumentFinancialExtract.promptVersion`.
 *
 * A systematic reading error is a property of the (model, prompt) PAIR, so a
 * re-parse cannot be compared against its predecessor without it. BUMP THIS
 * whenever {@link DOCUMENT_FINANCIALS_SCHEMA} or
 * {@link buildDocumentFinancialsPrompt} changes in a way that could move a
 * number — not for a typo in a description.
 */
export const DOC_FINANCIALS_PROMPT_VERSION = "doc-fin-v1";

// ---------------------------------------------------------------------------
// RESPONSE SCHEMA
// ---------------------------------------------------------------------------

/** The OpenAPI-subset type names Gemini's `responseSchema` accepts. */
export type DocSchemaType =
  | "OBJECT"
  | "ARRAY"
  | "STRING"
  | "NUMBER"
  | "INTEGER"
  | "BOOLEAN";

/**
 * A structural mirror of `@google/genai`'s `Schema`, declared locally so this
 * module stays a zero-dependency leaf. `GenerateContentConfig["responseSchema"]`
 * is `Schema | unknown`, so this object is assignable to it as-is.
 */
export interface DocResponseSchema {
  type: DocSchemaType;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  format?: string;
  items?: DocResponseSchema;
  properties?: Record<string, DocResponseSchema>;
  required?: string[];
  propertyOrdering?: string[];
}

/** `{ type: NUMBER, nullable: true }` with a description. Money AS PRINTED. */
function num(description: string): DocResponseSchema {
  return { type: "NUMBER", nullable: true, description };
}

/**
 * Statement of profit and loss.
 *
 * NOTE what is deliberately ABSENT: `revenue`, `operatingIncome`, `ebitda`,
 * `grossProfit`. See the module header — a total whose convention we would have
 * to guess is worse than no total, and Schedule III already prints the
 * components we need.
 */
const INCOME_STATEMENT_SCHEMA: DocResponseSchema = {
  type: "OBJECT",
  description:
    "Statement of profit and loss, in the units declared by scale.incomeStatement. Null any figure the document does not state — never estimate one.",
  properties: {
    revenueFromOperations: num(
      "The Schedule III line item literally labelled 'Revenue from operations'. EXCLUDES other income. If the statement prints only a combined 'Revenue' or 'Total income' figure, leave this null rather than guessing which one it is.",
    ),
    otherIncome: num(
      "The Schedule III line item literally labelled 'Other income'.",
    ),
    totalIncome: num(
      "The Schedule III line item literally labelled 'Total income' or 'Total revenue', when the statement prints it as its own row. Report it ONLY if it is printed — do not add the two lines above together yourself.",
    ),
    operatingIncomeExOtherIncome: num(
      "Operating profit with other income excluded, i.e. revenue from operations minus operating expenses, when the statement presents it.",
    ),
    ebitdaBeforeExceptionalItems: num(
      "EBITDA before exceptional / one-off items, when separately stated.",
    ),
    netIncome: num(
      "Profit for the period AFTER tax. For a consolidated statement use the TOTAL profit for the period, not the portion attributable to owners.",
    ),
    eps: num(
      "Basic earnings per share, in RUPEES PER SHARE. This is NOT in the statement's scale — do not convert it.",
    ),
  },
};

const BALANCE_SHEET_SCHEMA: DocResponseSchema = {
  type: "OBJECT",
  description:
    "Balance sheet, in the units declared by scale.balanceSheet. Null any figure the document does not state.",
  properties: {
    totalAssets: num("Total assets."),
    totalLiabilities: num(
      "Total liabilities, EXCLUDING equity. If the document only prints 'Total equity and liabilities', subtract total equity yourself and report the difference here.",
    ),
    totalEquity: num(
      "Total equity INCLUDING non-controlling interests when the statement is consolidated.",
    ),
    totalDebt: num("Total borrowings, current plus non-current."),
    totalCash: num(
      "Cash and cash equivalents plus other bank balances / current investments the document groups with them.",
    ),
    paidUpCapital: num("Equity share capital (paid-up)."),
    faceValue: num(
      "Face / par value of ONE equity share, in RUPEES. Typically 1, 2, 5 or 10. This is NOT in the statement's scale — do not convert it.",
    ),
    sharesOutstanding: num(
      "The ABSOLUTE number of equity shares outstanding. If the document prints it in lakhs or millions, multiply it out yourself and report the absolute count. This is NOT in the statement's scale.",
    ),
  },
};

const CASH_FLOW_SCHEMA: DocResponseSchema = {
  type: "OBJECT",
  description:
    "Cash-flow statement, in the units declared by scale.cashFlow. Null any figure the document does not state.",
  properties: {
    operatingCashFlow: num("Net cash generated from operating activities."),
    capitalExpenditure: num(
      "Purchase of property, plant and equipment plus intangibles. Report the MAGNITUDE as a POSITIVE number even though the statement prints it as a negative (cash out) — e.g. a line reading '(1,234)' is 1234. Report the GROSS purchase line, not a figure netted against proceeds from sale.",
    ),
    freeCashFlow: num(
      "Operating cash flow minus capital expenditure. Only if the document states it; otherwise null.",
    ),
  },
};

/** A per-statement page-citation list. */
function pages(description: string): DocResponseSchema {
  return {
    type: "ARRAY",
    description,
    items: { type: "INTEGER" },
  };
}

/**
 * The full structured response.
 *
 * Every requirement the ticket names is a field here: EVERY period the document
 * presents (a report shows the current AND the comparative year), BOTH
 * accounting bases, the DECLARED SCALE per statement, per-statement PAGE
 * CITATIONS, and the LINE ITEMS behind each total.
 */
export const DOCUMENT_FINANCIALS_SCHEMA: DocResponseSchema = {
  type: "OBJECT",
  required: ["periods"],
  propertyOrdering: ["companyName", "reportingCurrency", "periods"],
  properties: {
    companyName: {
      type: "STRING",
      nullable: true,
      description: "The issuer's name exactly as the document prints it.",
    },
    reportingCurrency: {
      type: "STRING",
      nullable: true,
      description: "ISO code of the reporting currency, e.g. INR.",
    },
    periods: {
      type: "ARRAY",
      description:
        "One entry per (period, accounting basis) the document actually presents. An annual report normally yields FOUR: current and comparative year, consolidated and standalone. Do NOT merge bases and do NOT omit the comparative year.",
      items: {
        type: "OBJECT",
        // THE THREE STATEMENTS ARE REQUIRED OBJECTS — MONEY-1332.
        //
        // They were optional, and the model exercised that: measured across a
        // 22-document pilot, it returned a period carrying `incomeStatement`
        // and NO `balanceSheet` or `cashFlow` key at all, for documents whose
        // input demonstrably contained both (every one of the 22 was verified
        // to have been SENT balance-sheet and cash-flow text). 250 of 261
        // remaining disagreements were this: a column the incumbent had and the
        // batch simply never mentioned.
        //
        // Requiring the OBJECT does not require a FIGURE. Every property inside
        // `BALANCE_SHEET_SCHEMA` and `CASH_FLOW_SCHEMA` is optional and
        // nullable, and their own descriptions say "Null any figure the document
        // does not state" — so a P&L-only quarterly can still answer
        // `balanceSheet: {}`, honestly, without inventing anything.
        //
        // This is the repo's own recurring lesson applied to a model's output
        // instead of to Mongo: ABSENT AND NULL MUST NOT BE THE SAME STATE. An
        // omitted key cannot be told apart from "this document has no balance
        // sheet"; an emitted object full of nulls is a POSITIVE claim that the
        // model looked and found nothing. Only the second is falsifiable, and
        // only the second can be told apart from the model skipping the work.
        //
        // NOT extended to a fabrication risk: nothing here asks for a number.
        // The failure it prevents is silence, not honesty.
        required: [
          "fiscalYear",
          "periodEnd",
          "periodType",
          "basis",
          "incomeStatement",
          "balanceSheet",
          "cashFlow",
        ],
        propertyOrdering: [
          "fiscalYear",
          "periodEnd",
          "periodType",
          "basis",
          "scale",
          "pageRefs",
          "incomeStatement",
          "balanceSheet",
          "cashFlow",
          "lines",
          "confidence",
        ],
        properties: {
          fiscalYear: {
            type: "STRING",
            description:
              "The period label exactly as the document prints it, e.g. 'FY2024-25' or 'Q3 FY2024-25'.",
          },
          periodEnd: {
            type: "STRING",
            format: "date",
            description:
              "The LAST day of the period as YYYY-MM-DD. An Indian financial year ending March 2025 is 2025-03-31. Required — omit the whole period entry if you cannot determine it.",
          },
          periodType: {
            type: "STRING",
            enum: ["ANNUAL", "QUARTERLY"],
            description: "ANNUAL for a full year, QUARTERLY for one quarter.",
          },
          basis: {
            type: "STRING",
            enum: ["CONSOLIDATED", "STANDALONE"],
            description:
              "CONSOLIDATED includes subsidiaries; STANDALONE is the parent alone. They differ by a MULTIPLE for a holding company — never guess, read the statement heading.",
          },
          scale: {
            type: "OBJECT",
            description:
              "The units header printed above EACH statement, copied VERBATIM (e.g. '₹ in Lakhs', '(Rs. in Crore)'). Report each statement separately — a single report frequently uses different units for different statements. Null a statement's scale only when it is genuinely absent.",
            properties: {
              incomeStatement: {
                type: "STRING",
                nullable: true,
                description: "Verbatim units header above the P&L.",
              },
              balanceSheet: {
                type: "STRING",
                nullable: true,
                description: "Verbatim units header above the balance sheet.",
              },
              cashFlow: {
                type: "STRING",
                nullable: true,
                description:
                  "Verbatim units header above the cash-flow statement.",
              },
            },
          },
          pageRefs: {
            type: "OBJECT",
            description:
              "1-based PDF page numbers each statement was read from, so a human can check a figure in seconds instead of re-reading the report.",
            properties: {
              incomeStatement: pages("Pages the P&L was read from."),
              balanceSheet: pages("Pages the balance sheet was read from."),
              cashFlow: pages("Pages the cash-flow statement was read from."),
            },
          },
          incomeStatement: INCOME_STATEMENT_SCHEMA,
          balanceSheet: BALANCE_SHEET_SCHEMA,
          cashFlow: CASH_FLOW_SCHEMA,
          lines: {
            type: "ARRAY",
            description:
              "The individual line items that make up the totals above, as printed. This is what makes a mapping mistake fixable without paying for the document to be read again.",
            items: {
              type: "OBJECT",
              required: ["statement", "label", "value"],
              properties: {
                statement: {
                  type: "STRING",
                  enum: ["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"],
                  description: "Which statement the line belongs to.",
                },
                label: {
                  type: "STRING",
                  description: "The row label exactly as printed.",
                },
                value: num(
                  "The row's value in that statement's declared units.",
                ),
                page: {
                  type: "INTEGER",
                  nullable: true,
                  description: "1-based page the line was read from.",
                },
              },
            },
          },
          confidence: {
            type: "NUMBER",
            nullable: true,
            description:
              "0..1 — how confident you are that these figures are the ones the document states, for THIS period and THIS basis.",
          },
        },
      },
    },
  },
};

/**
 * The instruction sent alongside the PDF.
 *
 * Deliberately short: everything structural lives in the schema's own
 * `description` fields, which the model sees as part of the constrained decode
 * and which cannot drift away from the shape they describe.
 */
export function buildDocumentFinancialsPrompt(ctx: {
  symbol: string;
  docType: string;
  period: string;
  title?: string | null;
}): string {
  return [
    "You are reading a filed Indian company financial document and extracting the",
    "statements it contains. Return ONLY data the document actually prints.",
    "",
    `Issuer symbol: ${ctx.symbol}`,
    `Document type: ${ctx.docType}`,
    `Filed period (as we catalogued it): ${ctx.period}`,
    ...(ctx.title ? [`Document title: ${ctx.title}`] : []),
    "",
    "Rules:",
    "1. Return EVERY period the document presents, including the comparative",
    "   prior year, and BOTH accounting bases when both are printed.",
    "2. Copy each statement's units header VERBATIM into `scale`. Do not convert",
    "   anything to a different unit yourself — report figures exactly as",
    "   printed and let us apply the conversion.",
    "3. `eps`, `faceValue` and `sharesOutstanding` are the ONLY exceptions: EPS",
    "   and face value are rupees per share, and share count must be the",
    "   absolute number of shares.",
    "4. Report `revenueFromOperations`, `otherIncome` and `totalIncome` as the",
    "   THREE SEPARATE Schedule III rows they are. Match them on the labels the",
    "   statement actually prints. Never put a combined figure into",
    "   `revenueFromOperations`, and never add the components together to",
    "   manufacture a `totalIncome` the statement does not print — we check the",
    "   three against each other and a manufactured total destroys the check.",
    "5. `capitalExpenditure` is the one figure whose SIGN we do not take from",
    "   the page: report the magnitude POSITIVE even though the statement shows",
    "   it as cash out. Every other figure keeps the sign the document prints —",
    "   a loss, a cash burn and negative equity are all real and must stay",
    "   negative.",
    "6. Null anything the document does not state. Never estimate, never carry a",
    "   figure across from another period, never compute a subtotal the document",
    "   does not print — except `totalLiabilities`, which you may derive as",
    "   'total equity and liabilities' minus 'total equity'.",
    "7. Cite the page each statement came from.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// SCALE NORMALISATION → CRORES
// ---------------------------------------------------------------------------

/** The magnitudes an Indian filing declares. */
export type ScaleUnit =
  | "UNIT"
  | "THOUSAND"
  | "LAKH"
  | "MILLION"
  | "CRORE"
  | "BILLION"
  | "TRILLION";

/**
 * Multiply a figure printed in this unit by this factor to reach CRORES.
 *
 *   1 crore    = 1e7 ₹  → 1
 *   1 lakh     = 1e5 ₹  → 1e5/1e7 = 0.01
 *   1 thousand = 1e3 ₹  → 1e-4
 *   1 rupee    = 1e0 ₹  → 1e-7
 *   1 million  = 1e6 ₹  → 0.1
 *   1 billion  = 1e9 ₹  → 100
 *   1 trillion = 1e12 ₹ → 1e5
 */
export const SCALE_FACTOR_TO_CRORE: Readonly<Record<ScaleUnit, number>> = {
  UNIT: 1e-7,
  THOUSAND: 1e-4,
  LAKH: 0.01,
  MILLION: 0.1,
  CRORE: 1,
  BILLION: 100,
  TRILLION: 1e5,
};

/**
 * Whole-word aliases, checked in the order a magnitude word beats a bare
 * currency word. "Rs. in Lakhs" must resolve to LAKH, not to UNIT, so the
 * magnitude table is consulted first and the absolute markers only after.
 */
const MAGNITUDE_ALIASES: ReadonlyArray<
  readonly [ScaleUnit, readonly string[]]
> = [
  ["CRORE", ["crore", "crores", "cr", "crs", "cro"]],
  ["LAKH", ["lakh", "lakhs", "lac", "lacs"]],
  ["MILLION", ["million", "millions", "mn", "mio", "mln"]],
  ["BILLION", ["billion", "billions", "bn", "bln"]],
  ["TRILLION", ["trillion", "trillions", "tn", "trn"]],
  ["THOUSAND", ["thousand", "thousands", "000", "000s", "k"]],
];

/**
 * Markers that mean "absolute rupees, no multiplier". Only reachable when NO
 * magnitude word was found, and only for an EXPLICIT phrasing — a bare "Rs." or
 * "₹" is a currency symbol, not a declaration of scale, and treating it as one
 * would silently divide every figure by 1e7.
 */
const ABSOLUTE_MARKERS: readonly string[] = [
  "rupee",
  "rupees",
  "absolute",
  "actual",
  "actuals",
  "unit",
  "units",
];

/**
 * Split a units header into comparable lowercase tokens.
 *
 * Apostrophes are stripped so "'000" becomes "000", and "₹"/"Rs."/parentheses
 * fall out as separators. Whole-token matching (rather than `includes`) is what
 * stops "cr" matching inside an unrelated word.
 */
function scaleTokens(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** The outcome of reading a declared units header. */
export interface ResolvedScale {
  /** The header exactly as the document stated it, trimmed. Null when absent. */
  scaleLabel: string | null;
  /** The canonical magnitude, or null when the label could not be read. */
  scaleUnit: ScaleUnit | null;
  /**
   * The factor APPLIED to reach crores, or null when nothing could be applied.
   *
   * NOTE a deliberate reading of the schema's doc comment ("Null factor means
   * the document stated crores or nothing and none was applied"): an explicit
   * "₹ in Crore" stores `1` rather than null. `1` IS "none applied", and
   * reserving null for UNRESOLVED keeps the two states — "the document said
   * crore" and "we could not tell" — distinguishable on the stored row. They
   * have opposite trust levels and collapsing them would be exactly the
   * absent-vs-null conflation this repo keeps paying for.
   */
  scaleFactor: number | null;
  /** True when a factor was determined. */
  resolved: boolean;
  /**
   * Whether the header names a currency that is NOT the rupee — MONEY-1348.
   *
   * `null` means the header named no currency at all, which is the ordinary
   * case and is treated as INR: every document in this lane is an NSE or BSE
   * filing (measured, 0 non-India rows in `stock_documents`), and the whole
   * module normalises to CRORE with no currency column to record anything
   * else. A dollar figure stored here would be a rupee figure as far as every
   * reader is concerned.
   */
  currency: "INR" | "NON_INR" | null;
}

/**
 * Read a declared units header into a factor.
 *
 * An unrecognised or absent label resolves to `{ resolved: false }` and is NOT
 * quietly assumed to be crores. That assumption is the single most expensive
 * mistake available here: a statement printed in lakhs but read as crores is
 * 100x too large, is internally consistent, and passes every other check in
 * this module.
 */
/** How a factor was arrived at when the header alone could not supply it. */
export type ScaleInferenceMethod =
  | "SIBLING_STATEMENT"
  | "SIBLING_PERIOD"
  | "PAID_UP_CAPITAL";

/** What a rung concluded, and from what. Stored on the row for audit. */
export interface ScaleInference {
  method: ScaleInferenceMethod;
  unit: ScaleUnit;
  /** The label whose reading was borrowed, or the identity that decided it. */
  from: string;
}

/**
 * Tolerance on the paid-up-capital identity when it is used to DECIDE a scale.
 *
 * Tighter than {@link PAID_UP_REL_TOLERANCE} (5%), which grades a figure we
 * already believe. Here the residual is being used to pick between magnitudes
 * that differ by 10x or more, so a 2% band separates them with enormous margin
 * while refusing a company whose printed capital genuinely disagrees with
 * shares x face value — a bonus issue mid-year, a partly-paid share.
 */
export const SCALE_IDENTITY_REL_TOLERANCE = 0.02;

/** The magnitudes the identity rung will consider. */
const SCALE_IDENTITY_CANDIDATES: readonly ScaleUnit[] = [
  "UNIT",
  "THOUSAND",
  "LAKH",
  "MILLION",
  "CRORE",
];

/**
 * Decide a scale the header could not state — MONEY-1342.
 *
 * ## Why this exists
 *
 * Measured on prod 2026-09-05: of 1,885 rejected extract rows, **1,821 (96.6%)
 * carry UNKNOWN_SCALE**, 1,804 of them as the SOLE reason. It is not a long
 * tail of problems; it is one problem with a long tail attached.
 *
 * `resolveScale` refuses a bare "Rs." deliberately and that refusal is
 * correct: assuming crores on a statement printed in lakhs is 100x, internally
 * consistent, and passes every other check in this module. What it also does
 * is throw away an answer the DOCUMENT already contains — the same filing
 * prints "Rs. in Lakhs" over the P&L and a bare "Rs." over the balance sheet,
 * or states the units on the current year and not the comparative.
 *
 * ## The three rungs, in order, and why that order
 *
 *   SIBLING_STATEMENT  another statement of the SAME period resolved. Closest
 *                      possible evidence: one page of one filing.
 *   SIBLING_PERIOD     the same statement type resolved in another period of
 *                      the same document. A comparative column is printed in
 *                      the units of the statement it sits in.
 *   PAID_UP_CAPITAL    the filing's own arithmetic decides:
 *                      `paidUpCapital x factor == sharesOutstanding x faceValue`
 *                      (to crores). Shares are a count and face value is
 *                      rupees per share — NEITHER is scaled — so this is an
 *                      independent measurement rather than a second reading of
 *                      the same header.
 *
 * A rung fires only if the one above it did not. UNKNOWN_SCALE remains for
 * everything none of them reaches: this widens what can be read, it does not
 * remove the refusal.
 *
 * ## What it refuses
 *
 * The identity rung requires EXACTLY ONE candidate magnitude inside the
 * tolerance. Two candidates means the identity does not discriminate here —
 * which happens when the numbers are small enough that neighbouring magnitudes
 * both "fit" — and guessing between them is the 100x error this whole module
 * exists to prevent.
 */
export function inferScale(
  ctx: {
    /** The other two statements of THIS period, already resolved. */
    siblings?: ReadonlyArray<{ statement: string; scale: ResolvedScale }>;
    /** Same statement type, resolved elsewhere in the document. */
    documentUnit?: { unit: ScaleUnit; from: string } | undefined;
    /** The identity's three terms, AS PRINTED (paidUp) and absolute (the rest). */
    identity?: {
      paidUpPrinted: number | null;
      shares: number | null;
      faceValue: number | null;
    };
  } = {},
): ScaleInference | null {
  for (const sib of ctx.siblings ?? []) {
    if (sib.scale.resolved && sib.scale.scaleUnit !== null) {
      return {
        method: "SIBLING_STATEMENT",
        unit: sib.scale.scaleUnit,
        from: sib.scale.scaleLabel ?? sib.statement,
      };
    }
  }

  if (ctx.documentUnit) {
    return {
      method: "SIBLING_PERIOD",
      unit: ctx.documentUnit.unit,
      from: ctx.documentUnit.from,
    };
  }

  const id = ctx.identity;
  if (
    id &&
    typeof id.paidUpPrinted === "number" &&
    Number.isFinite(id.paidUpPrinted) &&
    id.paidUpPrinted !== 0 &&
    typeof id.shares === "number" &&
    Number.isFinite(id.shares) &&
    id.shares > 0 &&
    typeof id.faceValue === "number" &&
    Number.isFinite(id.faceValue) &&
    id.faceValue > 0
  ) {
    // Shares x face value is rupees of paid-up capital; /1e7 makes it crores.
    const expectedCrore = (id.shares * id.faceValue) / 1e7;
    if (expectedCrore > 0) {
      const fits = SCALE_IDENTITY_CANDIDATES.filter((unit) => {
        const asCrore = id.paidUpPrinted! * SCALE_FACTOR_TO_CRORE[unit];
        return (
          Math.abs(asCrore - expectedCrore) <=
          SCALE_IDENTITY_REL_TOLERANCE * expectedCrore
        );
      });
      // EXACTLY ONE, and today that is a STRUCTURAL guarantee rather than a
      // live discriminator — said plainly because the check reads like one.
      //
      // Two candidates can both sit inside a +/-2% band only if their factors
      // differ by at most 1.02/0.98 = 1.041x. The closest pair in
      // SCALE_IDENTITY_CANDIDATES differs by 100x (THOUSAND to LAKH), so
      // `fits.length > 1` is unreachable for the set as it stands. A mutation
      // relaxing this to `>= 1` therefore kills no test, and rather than write
      // a fixture that cannot exist, `scale-identity-candidates-are-separable`
      // asserts the SEPARATION that makes it unreachable.
      //
      // The check stays because the separation is the thing that could change:
      // adding a magnitude within 4.1% of another turns this from dead code
      // into the guard that stops a coin-flip between them.
      if (fits.length === 1 && fits[0] !== undefined) {
        return {
          method: "PAID_UP_CAPITAL",
          unit: fits[0],
          from: `paidUpCapital x ${fits[0]} == shares x faceValue`,
        };
      }
    }
  }

  return null;
}

/** Turn an inference into the resolved shape the mapper consumes. */
export function applyScaleInference(
  base: ResolvedScale,
  inference: ScaleInference,
): ResolvedScale {
  return {
    // The LABEL stays verbatim. It is what the document printed, and a reader
    // comparing the row against the page must see the same words.
    currency: base.currency,
    scaleLabel: base.scaleLabel,
    scaleUnit: inference.unit,
    scaleFactor: SCALE_FACTOR_TO_CRORE[inference.unit],
    resolved: true,
  };
}

/**
 * Currencies that are not the rupee, matched on the RAW label — MONEY-1348.
 *
 * Read BEFORE `scaleTokens`, which splits on non-alphanumerics and would
 * silently discard `$`, `€`, `£` and `¥` entirely. So a header reading
 * "$ in millions" tokenises to `["in","millions"]`, resolves to MILLION, and
 * the figures are stored as crores of rupees with nothing anywhere recording
 * that they are dollars.
 *
 * `₹` and `Rs` are deliberately NOT in this set. Their ABSENCE is the normal
 * case — most headers name only a magnitude — so treating "no currency named"
 * as suspicious would refuse the corpus.
 */
const NON_INR_CURRENCY =
  /[$€£¥]|\b(?:usd|us\$|dollars?|eur|euros?|gbp|pounds?|aed|sgd|jpy|yen|cad|aud)\b/i;

/**
 * The rupee, named ANYWHERE in a free-text string — MONEY-1346.
 *
 * The mirror of the constant above, and it exists for exactly one job: to stop
 * a document that names BOTH currencies from being refused. `₹` is U+20B9 and
 * is deliberately absent from `NON_INR_CURRENCY`'s `[$€£¥]` class, so the two
 * sets do not overlap.
 *
 * Not used by `resolveScale`, whose comment above explains why the ABSENCE of a
 * rupee marker must stay the normal case there: most headers name only a
 * magnitude, and treating "no currency named" as suspicious would refuse the
 * corpus.
 */
const INR_CURRENCY = /₹|\b(?:inr|rs|rupees?)\b/i;

export function resolveScale(label: string | null | undefined): ResolvedScale {
  const trimmed = typeof label === "string" ? label.trim() : "";
  const currency: "INR" | "NON_INR" | null = NON_INR_CURRENCY.test(trimmed)
    ? "NON_INR"
    : null;
  if (trimmed.length === 0) {
    return {
      currency: null,
      scaleLabel: null,
      scaleUnit: null,
      scaleFactor: null,
      resolved: false,
    };
  }

  const tokens = scaleTokens(trimmed);

  for (const [unit, aliases] of MAGNITUDE_ALIASES) {
    if (tokens.some((t) => aliases.includes(t))) {
      return {
        currency,
        scaleLabel: trimmed,
        scaleUnit: unit,
        scaleFactor: SCALE_FACTOR_TO_CRORE[unit],
        resolved: true,
      };
    }
  }

  if (tokens.some((t) => ABSOLUTE_MARKERS.includes(t))) {
    return {
      currency,
      scaleLabel: trimmed,
      scaleUnit: "UNIT",
      scaleFactor: SCALE_FACTOR_TO_CRORE.UNIT,
      resolved: true,
    };
  }

  return {
    currency,
    scaleLabel: trimmed,
    scaleUnit: null,
    scaleFactor: null,
    resolved: false,
  };
}

/**
 * Apply a scale factor to a raw figure.
 *
 * Returns null — never NaN, never 0 — for anything that is not a finite number
 * or when no factor was resolved. `?? 0` at a call site would turn a missing
 * figure into a REAL ZERO, which reads as "this company earned nothing" rather
 * than "we do not know", and a `NaN` slips straight through `??`.
 */
export function applyScale(
  value: unknown,
  factor: number | null,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (typeof factor !== "number" || !Number.isFinite(factor)) return null;
  const scaled = value * factor;
  return Number.isFinite(scaled) ? scaled : null;
}

/**
 * Pass a figure through unchanged when it is a finite number.
 *
 * For the three fields that are NOT in the statement's scale — `eps` and
 * `faceValue` (rupees per share) and `sharesOutstanding` (a count). Scaling any
 * of them is a bug that would be invisible: a face value of ₹10 read as "in
 * lakhs" becomes ₹0.1 and still looks like a plausible face value.
 */
export function unscaled(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Force capital expenditure to the POSITIVE convention `stock_financials` uses.
 *
 * ## Why this cannot be left to the prompt
 *
 * A cash-flow statement prints capex NEGATIVE — it is cash out — and
 * `stock_financials.capitalExpenditure` stores it POSITIVE. If the sign is
 * copied off the page, EVERY row this pipeline produces scores SIGN_MISMATCH in
 * the reconcile and the gate blocks. That failure would present as a deep
 * data-quality problem across the whole extractor while actually being a
 * one-line convention mismatch, so the convention is stated in the schema
 * description AND enforced here. Depending on the model to have read the sign
 * our way is depending on it for something we can simply guarantee.
 *
 * `Math.abs` is right for THIS field specifically because the schema asks for
 * the GROSS purchase line, which is an outflow by definition and has no
 * meaningful negative reading.
 *
 * ## The fields this must NEVER be extended to
 *
 * A blanket "money is positive" sweep would be a far worse bug than the one it
 * fixes, so the audit is written down rather than left to be re-derived:
 *
 *   netIncome                     a LOSS is negative. Flipping it turns every
 *                                 loss-making company profitable.
 *   operatingCashFlow             cash burn is negative and is the single most
 *                                 important signal for an early-stage issuer.
 *   freeCashFlow                  negative whenever capex exceeds operating cash.
 *   operatingIncomeExOtherIncome  an operating loss is negative.
 *   ebitdaBeforeExceptionalItems  likewise.
 *   totalEquity                   negative when accumulated losses exceed capital.
 *   eps                           negative for a loss-making year.
 *   otherIncome                   a net "other income/(expense)" line can be
 *                                 negative.
 *
 * `totalAssets` is the one other field with no valid negative reading, and it
 * is deliberately REJECTED ({@link ValidationReason} NEGATIVE_TOTAL_ASSETS)
 * rather than flipped: a negative total-assets figure means the reading is
 * wrong, not that the sign convention differs, and silently flipping it would
 * manufacture a plausible number out of a broken one.
 */
export function normaliseCapexSign(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.abs(value);
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

/**
 * Terminal status for one reading — mirrors `DocumentFinancialExtract.status`.
 *
 * FAILED_VALIDATION means the model ANSWERED and the answer failed OUR
 * arithmetic. That is a prompt-or-parser signal and must never be blind-retried
 * the way a transport FAILED should be — the same call will produce the same
 * answer and the same failure, at the same cost.
 */
export type ExtractStatus = "EXTRACTED" | "FAILED_VALIDATION";

/** Why a reading was rejected. Every one of these is fatal to the row. */
export type ValidationReason =
  | "MISSING_PERIOD_END"
  | "INVALID_PERIOD_END"
  | "PERIOD_END_OUT_OF_RANGE"
  | "INVALID_PERIOD_TYPE"
  | "INVALID_BASIS"
  | "UNKNOWN_SCALE"
  | "NON_FINITE_VALUE"
  | "TOTAL_INCOME_MISMATCH"
  | "BALANCE_SHEET_IMBALANCE"
  | "IMPLAUSIBLE_MAGNITUDE"
  | "NEGATIVE_TOTAL_ASSETS"
  | "NON_INR_CURRENCY"
  | "NO_FIGURES";

/** Recorded on the row but never fatal — see the header note on each. */
export type ValidationWarning =
  | "EPS_INCONSISTENT_WITH_NET_INCOME"
  | "PAID_UP_CAPITAL_INCONSISTENT"
  | "IMPLAUSIBLE_FACE_VALUE"
  | "IMPLAUSIBLE_SHARE_COUNT"
  | "OTHER_INCOME_EXCEEDS_OPERATING_REVENUE"
  | "TOTAL_INCOME_NOT_CROSS_CHECKED"
  | "CAPEX_SIGN_NORMALISED"
  | "SCALE_DIFFERS_BETWEEN_STATEMENTS"
  | "SCALE_INFERRED_FROM_SIBLING"
  | "SCALE_INFERRED_FROM_DOCUMENT"
  | "SCALE_INFERRED_FROM_CAPITAL"
  | "BALANCE_SHEET_INCOMPLETE"
  | "NO_PAGE_REFS";

export interface ExtractionVerdict {
  status: ExtractStatus;
  reasons: ValidationReason[];
  warnings: ValidationWarning[];
  /**
   * Whether the row can be written AT ALL.
   *
   * False when a REQUIRED column could not be produced — `periodEnd`,
   * `periodType`, `basis` — or when the reading carried no figures. Everything
   * else is persisted with `status: "FAILED_VALIDATION"`, because a wrong
   * answer that is recorded is a prompt signal and a wrong answer that is
   * dropped is nothing.
   */
  persistable: boolean;
}

/**
 * Relative tolerance on `totalIncome ≈ revenueFromOperations + otherIncome`.
 *
 * Schedule III mandates the three as separate rows and they cross-foot TO THE
 * RUPEE in the filing, so the only slack this band has to absorb is print
 * rounding on three lines — 0.005 Cr each for a statement printed in lakhs.
 * 0.1% is therefore generous, and generous is right: the thing it is hunting
 * (a "Total income" figure landing in `revenueFromOperations`) is off by the
 * whole of other income, typically 1–10% of total income and never 0.1%.
 */
export const TOTAL_INCOME_REL_TOLERANCE = 0.001;

/** Absolute floor on that tolerance, in crores — see the balance-sheet floor. */
export const TOTAL_INCOME_ABS_TOLERANCE_CRORE = 0.05;

/**
 * Relative tolerance on `totalAssets ≈ totalLiabilities + totalEquity`.
 *
 * ## Why 1%
 *
 * The band has to be wide enough to absorb two things that are NOT errors, and
 * narrow enough to catch the one that is.
 *
 *   - PRESENTATION. "Total equity" in a consolidated Ind AS balance sheet is
 *     sometimes printed as "Equity attributable to owners of the Company",
 *     with non-controlling interests on their own line below. A reading that
 *     takes the first line and misses NCI is off by the NCI, which for most
 *     listed issuers is well under 1% of total assets. That is a real
 *     disagreement, but it is not a reason to throw the other fifteen columns
 *     away.
 *   - ROUNDING. Statements print rounded figures. A balance sheet printed "₹ in
 *     Lakhs" and converted to crore carries 0.005 Cr of rounding per line and a
 *     balance sheet has roughly thirty lines a side.
 *
 * And what it must catch: a scale error. The SMALLEST scale confusion actually
 * in play is million↔crore (10x, i.e. 900% off) or lakh↔crore (100x). 1% is two
 * orders of magnitude tighter than the smallest thing it is hunting, so the
 * band could be loosened a long way before it stopped working — which is the
 * right shape for a tolerance that also has to not cry wolf.
 */
export const BALANCE_REL_TOLERANCE = 0.01;

/**
 * Absolute floor on that tolerance, in crores.
 *
 * A pure percentage collapses for a small issuer: for a ₹5 Cr SME balance
 * sheet, 1% is ₹0.05 Cr — BELOW the rounding granularity of a statement printed
 * in lakhs (₹0.01 Cr) times a few lines. The floor is what stops the check
 * failing every SME on arithmetic noise, and 1 Cr is ~100 lakh-rounding units,
 * comfortably above the accumulated rounding of a full statement.
 */
export const BALANCE_ABS_TOLERANCE_CRORE = 1;

/**
 * Ceiling on any single money figure, in crores. ₹200 lakh crore.
 *
 * Sized off the largest real Indian balance sheets rather than off a round
 * number: SBI and LIC both report total assets in the ₹55–70 lakh crore range
 * (5.5e6–6.8e6 Cr). 2e7 leaves ~3x headroom above the largest genuine figure
 * while still catching a 10x error on the very largest issuer (6.8e6 × 10 =
 * 6.8e7, rejected) and a 100x error on anything above ₹2,000 Cr.
 *
 * This is the ONLY check that can see a scale error applied uniformly to a
 * whole statement, and it only sees the ones that overflow the band — a 100x
 * error on a ₹50 Cr company lands at ₹5,000 Cr and looks entirely normal. It is
 * a backstop, not a guarantee.
 */
export const MAX_PLAUSIBLE_CRORE = 20_000_000;

/** Earliest `periodEnd` we will accept. Before Indian XBRL/Ind-AS filing. */
export const MIN_PERIOD_END_ISO = "1990-01-01";

/** How far into the FUTURE a `periodEnd` may sit, in days. */
export const MAX_PERIOD_END_FUTURE_DAYS = 370;

/** Plausible face value of one equity share, in rupees. */
export const FACE_VALUE_BAND: readonly [number, number] = [0.01, 1000];

/** Plausible absolute equity share count for a listed issuer. */
export const SHARE_COUNT_BAND: readonly [number, number] = [1e3, 1e12];

/** Relative tolerance on `paidUpCapital ≈ shares × faceValue`. */
export const PAID_UP_REL_TOLERANCE = 0.05;

/** Relative tolerance on `eps ≈ netIncome / shares`. */
export const EPS_REL_TOLERANCE = 0.25;

/** Absolute floor on the EPS tolerance, in rupees per share. */
export const EPS_ABS_TOLERANCE = 0.5;

/**
 * Parse a model-supplied `periodEnd` into a real UTC Date.
 *
 * `periodEnd` is REQUIRED on the row and the reason is downstream: both readers
 * of the canonical table sort on it, so a row without one renders and reaches
 * the LLM in the WRONG POSITION — strictly worse than being absent. A row we
 * cannot date is therefore dropped, not defaulted.
 *
 * Returns null for anything that is not a real calendar date. `new Date(...)`
 * alone is not enough: it yields an Invalid Date (whose `getTime()` is `NaN`)
 * for garbage, and happily accepts "2025-02-31" by rolling it into March, so the
 * round-trip back to YYYY-MM-DD is checked as well.
 */
export function parsePeriodEnd(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  // Reject a rolled-over date ("2025-02-31" → 2025-03-03).
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** True when a parsed `periodEnd` sits inside the acceptable window. */
export function isPeriodEndInRange(d: Date, now: Date = new Date()): boolean {
  const min = new Date(`${MIN_PERIOD_END_ISO}T00:00:00.000Z`).getTime();
  const max = now.getTime() + MAX_PERIOD_END_FUTURE_DAYS * 86_400_000;
  const t = d.getTime();
  return Number.isFinite(t) && t >= min && t <= max;
}

// ---------------------------------------------------------------------------
// THE RAW MODEL SHAPE
// ---------------------------------------------------------------------------

export interface RawStatementScale {
  incomeStatement?: string | null;
  balanceSheet?: string | null;
  cashFlow?: string | null;
}

export interface RawPageRefs {
  incomeStatement?: number[] | null;
  balanceSheet?: number[] | null;
  cashFlow?: number[] | null;
}

export interface RawLineItem {
  statement?: string | null;
  label?: string | null;
  value?: number | null;
  page?: number | null;
}

export interface RawPeriodExtract {
  fiscalYear?: string | null;
  periodEnd?: string | null;
  periodType?: string | null;
  basis?: string | null;
  scale?: RawStatementScale | null;
  pageRefs?: RawPageRefs | null;
  incomeStatement?: Record<string, unknown> | null;
  balanceSheet?: Record<string, unknown> | null;
  cashFlow?: Record<string, unknown> | null;
  lines?: RawLineItem[] | null;
  confidence?: number | null;
}

export interface RawDocumentFinancials {
  companyName?: string | null;
  reportingCurrency?: string | null;
  periods?: RawPeriodExtract[] | null;
}

/**
 * The row shape written to `document_financial_extracts`. All money in CRORES.
 *
 * `revenue`, `operatingIncome` and `ebitda` are ABSENT BY DESIGN — see the
 * module header. A column this reader cannot source without guessing a
 * convention is a column it does not claim, rather than one it fills with a
 * guess and annotates.
 */
export interface MappedExtract {
  fiscalYear: string;
  periodEnd: Date;
  periodType: "ANNUAL" | "QUARTERLY";
  basis: "CONSOLIDATED" | "STANDALONE";

  revenueFromOperations: number | null;
  otherIncome: number | null;
  operatingIncomeExOtherIncome: number | null;
  ebitdaBeforeExceptionalItems: number | null;
  netIncome: number | null;

  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  totalCash: number | null;

  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  freeCashFlow: number | null;

  eps: number | null;
  sharesOutstanding: number | null;
  paidUpCapital: number | null;
  faceValue: number | null;

  scaleLabel: string | null;
  scaleFactor: number | null;
  confidence: number | null;
  pageRefs: RawPageRefs | null;
  /**
   * The line items as read, PLUS a `validation` sibling carrying this row's
   * verdict, the per-statement scales that produced it, and the printed
   * `totalIncome` the components were cross-footed against.
   *
   * There is no reason column on the table, and a FAILED_VALIDATION row whose
   * reason is not recorded is a row nobody can act on — which is how
   * INCOMPARABLE came to hide two broken pipes in MONEY-1234. `totalIncome`
   * rides here rather than in a column of its own because it is EVIDENCE for
   * the check, not a figure any reader consumes.
   */
  lines: {
    items: RawLineItem[];
    validation: {
      status: ExtractStatus;
      reasons: ValidationReason[];
      /** Which scale-inference rung fired per statement, and on what — MONEY-1342. */
      scaleInference?: Partial<
        Record<"incomeStatement" | "balanceSheet" | "cashFlow", ScaleInference>
      >;
      warnings: ValidationWarning[];
      /** The printed "Total income" row, in CRORES. Null when not printed. */
      totalIncomeAsPrinted: number | null;
      /**
       * Capex EXACTLY as the document printed it (scaled, sign untouched).
       *
       * Kept because {@link normaliseCapexSign} destroys the only evidence of
       * how the model read the sign. Without it, "the model returns capex
       * negative, as statements print it" and "the model returns it positive,
       * as we asked" are indistinguishable after the fact — and which one is
       * true decides whether the prompt needs changing.
       */
      capexAsPrinted: number | null;
      scales: {
        incomeStatement: ResolvedScale;
        balanceSheet: ResolvedScale;
        cashFlow: ResolvedScale;
      };
    };
  };
}

/** Money columns, in crores, that the plausibility ceiling applies to. */
const CRORE_COLUMNS = [
  "revenueFromOperations",
  "otherIncome",
  "operatingIncomeExOtherIncome",
  "ebitdaBeforeExceptionalItems",
  "netIncome",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "totalDebt",
  "totalCash",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
  "paidUpCapital",
] as const;

/** Every numeric column, crore-scaled or not. The finiteness sweep covers all. */
const NUMERIC_COLUMNS = [
  ...CRORE_COLUMNS,
  "eps",
  "sharesOutstanding",
  "faceValue",
  "confidence",
] as const;

/** Read a numeric field off a raw statement object without trusting its type. */
function rawNum(
  statement: Record<string, unknown> | null | undefined,
  key: string,
): unknown {
  if (!statement || typeof statement !== "object") return null;
  return (statement as Record<string, unknown>)[key];
}

/**
 * True when at least one raw statement field is a NON-FINITE number.
 *
 * Distinct from "absent": a null the model returned is a legitimate "the
 * document does not state this", and {@link applyScale} maps it to null. A
 * `NaN` or `Infinity` is a corrupted reading, and the difference has to be
 * detected on the RAW value because scaling collapses both to null.
 */
export function hasNonFiniteRawFigure(raw: RawPeriodExtract): boolean {
  const statements = [raw.incomeStatement, raw.balanceSheet, raw.cashFlow];
  for (const st of statements) {
    if (!st || typeof st !== "object") continue;
    for (const v of Object.values(st)) {
      if (typeof v === "number" && !Number.isFinite(v)) return true;
    }
  }
  if (typeof raw.confidence === "number" && !Number.isFinite(raw.confidence)) {
    return true;
  }
  for (const line of raw.lines ?? []) {
    if (typeof line?.value === "number" && !Number.isFinite(line.value)) {
      return true;
    }
  }
  return false;
}

/** Everything {@link validateMappedExtract} needs beyond the row itself. */
export interface ValidationContext {
  row: Omit<MappedExtract, "lines"> & { lines?: unknown };
  scales: {
    incomeStatement: ResolvedScale;
    balanceSheet: ResolvedScale;
    cashFlow: ResolvedScale;
  };
  /** True when the corresponding raw statement carried at least one figure. */
  present: {
    incomeStatement: boolean;
    balanceSheet: boolean;
    cashFlow: boolean;
  };
  /** The printed "Total income" row, already scaled to crores. */
  totalIncomeAsPrinted: number | null;
  /** Capex as printed (scaled, sign untouched), for the normalisation signal. */
  capexAsPrinted: number | null;
  hasNonFiniteRaw: boolean;
}

/**
 * Grade a mapped row.
 *
 * Split out from {@link mapPeriodExtract} so the arithmetic can be driven
 * directly with hand-built rows in tests, and so the worker can re-grade a row
 * it did not itself map.
 */
export function validateMappedExtract(
  input: ValidationContext,
): ExtractionVerdict {
  const {
    row,
    scales,
    present,
    totalIncomeAsPrinted,
    capexAsPrinted,
    hasNonFiniteRaw,
  } = input;
  const reasons: ValidationReason[] = [];
  const warnings: ValidationWarning[] = [];

  // ── 1. Non-finite. Checked FIRST because every later comparison against a
  //       NaN is silently false, so a poisoned row would otherwise pass the
  //       balance check by failing to fail it.
  if (hasNonFiniteRaw) reasons.push("NON_FINITE_VALUE");
  for (const col of NUMERIC_COLUMNS) {
    const v = row[col];
    if (v !== null && v !== undefined && !Number.isFinite(v)) {
      if (!reasons.includes("NON_FINITE_VALUE")) {
        reasons.push("NON_FINITE_VALUE");
      }
      break;
    }
  }

  // ── 2. Scale. A statement that carried figures but whose units header could
  //       not be read is unusable — assuming crores is the 100x mistake.
  const scaleUnresolved =
    (present.incomeStatement && !scales.incomeStatement.resolved) ||
    (present.balanceSheet && !scales.balanceSheet.resolved) ||
    (present.cashFlow && !scales.cashFlow.resolved);
  if (scaleUnresolved) reasons.push("UNKNOWN_SCALE");

  // ── 2b. Currency — MONEY-1348 ────────────────────────────────────────────
  //
  // Every figure in this module is normalised to CRORE and the table has no
  // currency column, so a non-rupee statement cannot be stored correctly at
  // all. It is refused rather than converted: an FX rate is a second data
  // source with its own date, and inventing one here would put a made-up
  // number inside a figure that reads as filed.
  //
  // Safe today by construction — `stock_documents` is 100% NSE/BSE, measured —
  // which is exactly why the guard is cheap now and expensive to add after the
  // first non-INR document arrives.
  const nonInr =
    (present.incomeStatement &&
      scales.incomeStatement.currency === "NON_INR") ||
    (present.balanceSheet && scales.balanceSheet.currency === "NON_INR") ||
    (present.cashFlow && scales.cashFlow.currency === "NON_INR");
  if (nonInr) reasons.push("NON_INR_CURRENCY");

  const resolvedUnits = [
    present.incomeStatement ? scales.incomeStatement.scaleUnit : null,
    present.balanceSheet ? scales.balanceSheet.scaleUnit : null,
    present.cashFlow ? scales.cashFlow.scaleUnit : null,
  ].filter((u): u is ScaleUnit => u !== null);
  if (new Set(resolvedUnits).size > 1) {
    warnings.push("SCALE_DIFFERS_BETWEEN_STATEMENTS");
  }

  // ── 3. Magnitude ceiling — the only check that can see a UNIFORM scale
  //       error, and only when the result overflows the band.
  for (const col of CRORE_COLUMNS) {
    const v = row[col];
    if (typeof v === "number" && Number.isFinite(v)) {
      if (Math.abs(v) > MAX_PLAUSIBLE_CRORE) {
        reasons.push("IMPLAUSIBLE_MAGNITUDE");
        break;
      }
    }
  }
  if (typeof row.totalAssets === "number" && row.totalAssets < 0) {
    reasons.push("NEGATIVE_TOTAL_ASSETS");
  }

  // ── 4. Schedule III cross-foot: totalIncome = revenueFromOperations +
  //       otherIncome. THREE independently read values, which is what makes
  //       this discriminating for the failure it exists for — a combined
  //       "Total income" figure landing in `revenueFromOperations`, a component
  //       omitted, or the three read out of different columns of the table.
  //
  //       It is ADDITION, so it is symmetric under swapping the two components
  //       and cannot detect THAT. The magnitude warning below is what speaks to
  //       a swap, and it is only a warning because an investment holding
  //       company legitimately earns more other income than operating revenue.
  const rfo = row.revenueFromOperations;
  const oi = row.otherIncome;
  const haveComponents =
    typeof rfo === "number" &&
    Number.isFinite(rfo) &&
    typeof oi === "number" &&
    Number.isFinite(oi);

  if (
    haveComponents &&
    typeof totalIncomeAsPrinted === "number" &&
    Number.isFinite(totalIncomeAsPrinted)
  ) {
    const sum = (rfo as number) + (oi as number);
    const tol = Math.max(
      TOTAL_INCOME_ABS_TOLERANCE_CRORE,
      TOTAL_INCOME_REL_TOLERANCE * Math.abs(totalIncomeAsPrinted),
    );
    if (Math.abs(sum - totalIncomeAsPrinted) > tol) {
      reasons.push("TOTAL_INCOME_MISMATCH");
    }
  } else if (haveComponents) {
    // Both components read, no printed total to check them against. The
    // components are still usable — but "unchecked" must not read as
    // "verified", which is the distinction INCOMPARABLE erased in MONEY-1234.
    warnings.push("TOTAL_INCOME_NOT_CROSS_CHECKED");
  }

  if (
    haveComponents &&
    Math.abs(oi as number) > Math.abs(rfo as number) &&
    (rfo as number) !== 0
  ) {
    warnings.push("OTHER_INCOME_EXCEEDS_OPERATING_REVENUE");
  }

  // ── 5. Balance-sheet identity. See BALANCE_REL_TOLERANCE for the tolerance
  //       argument AND for what this check provably cannot see.
  const { totalAssets, totalLiabilities, totalEquity } = row;
  const haveAll =
    typeof totalAssets === "number" &&
    Number.isFinite(totalAssets) &&
    typeof totalLiabilities === "number" &&
    Number.isFinite(totalLiabilities) &&
    typeof totalEquity === "number" &&
    Number.isFinite(totalEquity);
  if (haveAll) {
    const diff = Math.abs(
      (totalAssets as number) -
        ((totalLiabilities as number) + (totalEquity as number)),
    );
    const tol = Math.max(
      BALANCE_ABS_TOLERANCE_CRORE,
      BALANCE_REL_TOLERANCE * Math.abs(totalAssets as number),
    );
    if (diff > tol) reasons.push("BALANCE_SHEET_IMBALANCE");
  } else if (present.balanceSheet) {
    // Not fatal — a quarterly result routinely prints no balance sheet at all,
    // and a partial one still carries usable columns. But an UNCHECKED balance
    // sheet must not be mistaken for a VERIFIED one, so it is recorded.
    warnings.push("BALANCE_SHEET_INCOMPLETE");
  }

  // ── 6. Share-structure cross-checks. All advisory — see the module header
  //       for exactly which swaps each one can and cannot detect.
  const shares = row.sharesOutstanding;
  const faceValue = row.faceValue;
  const paidUp = row.paidUpCapital;

  if (typeof faceValue === "number" && Number.isFinite(faceValue)) {
    if (faceValue < FACE_VALUE_BAND[0] || faceValue > FACE_VALUE_BAND[1]) {
      warnings.push("IMPLAUSIBLE_FACE_VALUE");
    }
  }
  if (typeof shares === "number" && Number.isFinite(shares)) {
    if (shares < SHARE_COUNT_BAND[0] || shares > SHARE_COUNT_BAND[1]) {
      warnings.push("IMPLAUSIBLE_SHARE_COUNT");
    }
  }

  if (
    typeof shares === "number" &&
    Number.isFinite(shares) &&
    typeof faceValue === "number" &&
    Number.isFinite(faceValue) &&
    typeof paidUp === "number" &&
    Number.isFinite(paidUp) &&
    paidUp !== 0
  ) {
    // paid-up capital in CRORES = shares × faceValue(₹) / 1e7.
    //
    // SYMMETRIC under swapping `shares` and `faceValue` — it is a product, so
    // it cannot detect that swap and this comment exists so nobody later cites
    // it as if it could. The band on `faceValue` above is the check that can.
    const implied = (shares * faceValue) / 1e7;
    if (Math.abs(implied - paidUp) > PAID_UP_REL_TOLERANCE * Math.abs(paidUp)) {
      warnings.push("PAID_UP_CAPITAL_INCONSISTENT");
    }
  }

  if (
    typeof shares === "number" &&
    Number.isFinite(shares) &&
    shares > 0 &&
    typeof row.netIncome === "number" &&
    Number.isFinite(row.netIncome) &&
    typeof row.eps === "number" &&
    Number.isFinite(row.eps)
  ) {
    // eps(₹/share) = netIncome(Cr) × 1e7 / shares.
    //
    // A QUOTIENT, so — unlike the paid-up identity — it IS asymmetric and does
    // detect a netIncome/shares swap. Its weakness is different: reported EPS
    // uses WEIGHTED-AVERAGE shares and, when consolidated, profit attributable
    // to owners rather than total profit. A few percent of genuine
    // disagreement is normal, so this is a warning and the tolerance is wide.
    // Its real job is catching order-of-magnitude errors — a share count read
    // "in lakhs" instead of absolute is 1e5 out.
    const implied = (row.netIncome * 1e7) / shares;
    const tol = Math.max(
      EPS_ABS_TOLERANCE,
      EPS_REL_TOLERANCE * Math.abs(implied),
    );
    if (Math.abs(implied - row.eps) > tol) {
      warnings.push("EPS_INCONSISTENT_WITH_NET_INCOME");
    }
  }

  // ── 6b. Capex sign. NOT a failure — the statement is right to print it
  //        negative and we are right to store it positive. It is recorded so a
  //        SYSTEMATIC negative (the model copying the page) is measurable, which
  //        is what tells us whether the prompt is landing.
  if (
    typeof capexAsPrinted === "number" &&
    Number.isFinite(capexAsPrinted) &&
    capexAsPrinted < 0
  ) {
    warnings.push("CAPEX_SIGN_NORMALISED");
  }

  // ── 7. Citations. A figure with no page reference is weaker evidence and
  //       cannot be spot-checked by a human in seconds, which is the whole
  //       point of storing them.
  const refs = row.pageRefs;
  const anyRef =
    (refs?.incomeStatement?.length ?? 0) +
      (refs?.balanceSheet?.length ?? 0) +
      (refs?.cashFlow?.length ?? 0) >
    0;
  if (!anyRef) warnings.push("NO_PAGE_REFS");

  return {
    status: reasons.length === 0 ? "EXTRACTED" : "FAILED_VALIDATION",
    reasons,
    warnings,
    persistable: true,
  };
}

/** A verdict for a reading that cannot be written at all. */
function rejected(reasons: ValidationReason[]): ExtractionVerdict {
  return {
    status: "FAILED_VALIDATION",
    reasons,
    warnings: [],
    persistable: false,
  };
}

/**
 * Turn ONE raw period from the model into a row, scaled to crores and graded.
 *
 * `row` is null exactly when `verdict.persistable` is false. The two are
 * returned together so a caller cannot act on one without seeing the other.
 */
export function mapPeriodExtract(
  raw: RawPeriodExtract,
  opts: {
    now?: Date;
    /**
     * Units resolved elsewhere in the SAME document, per statement type — the
     * SIBLING_PERIOD rung of {@link inferScale}. Supplied by
     * {@link mapDocumentFinancials}, which is the only caller that can see the
     * other periods.
     */
    documentUnits?: Partial<
      Record<
        "incomeStatement" | "balanceSheet" | "cashFlow",
        { unit: ScaleUnit; from: string }
      >
    >;
    /** The DOCUMENT declared a currency that is not the rupee — MONEY-1348. */
    documentIsNonInr?: boolean;
  } = {},
): { row: MappedExtract | null; verdict: ExtractionVerdict } {
  const now = opts.now ?? new Date();

  // ── Required columns first. These are rejections, not gradings: `periodEnd`,
  //    `periodType` and `basis` are NOT NULL on the table and `periodEnd` is
  //    what every downstream reader sorts on.
  const periodEnd = parsePeriodEnd(raw.periodEnd);
  if (!periodEnd) {
    return {
      row: null,
      verdict: rejected([
        raw.periodEnd == null || String(raw.periodEnd).trim() === ""
          ? "MISSING_PERIOD_END"
          : "INVALID_PERIOD_END",
      ]),
    };
  }
  if (!isPeriodEndInRange(periodEnd, now)) {
    return { row: null, verdict: rejected(["PERIOD_END_OUT_OF_RANGE"]) };
  }

  const periodType = String(raw.periodType ?? "")
    .trim()
    .toUpperCase();
  if (periodType !== "ANNUAL" && periodType !== "QUARTERLY") {
    return { row: null, verdict: rejected(["INVALID_PERIOD_TYPE"]) };
  }
  const basis = String(raw.basis ?? "")
    .trim()
    .toUpperCase();
  if (basis !== "CONSOLIDATED" && basis !== "STANDALONE") {
    return { row: null, verdict: rejected(["INVALID_BASIS"]) };
  }

  const declared = {
    incomeStatement: resolveScale(raw.scale?.incomeStatement),
    balanceSheet: resolveScale(raw.scale?.balanceSheet),
    cashFlow: resolveScale(raw.scale?.cashFlow),
  };

  // ── SCALE INFERENCE — MONEY-1342 ────────────────────────────────────────
  //
  // Only ever consulted for a statement whose own header could not be read.
  // A declared header always wins: this widens what is readable, it never
  // overrides what the document said.
  const bs0 = raw.balanceSheet ?? null;
  // `unscaled` is the existing finite-number reader: it returns null for
  // anything that is not a finite number, so a string or a NaN cannot reach
  // the identity and silently satisfy it.
  const identity = {
    paidUpPrinted: unscaled(rawNum(bs0, "paidUpCapital")),
    shares: unscaled(rawNum(bs0, "sharesOutstanding")),
    faceValue: unscaled(rawNum(bs0, "faceValue")),
  };
  const STATEMENTS = ["incomeStatement", "balanceSheet", "cashFlow"] as const;
  const scales = { ...declared };
  const inferences: Partial<
    Record<(typeof STATEMENTS)[number], ScaleInference>
  > = {};
  for (const key of STATEMENTS) {
    if (declared[key].resolved) continue;
    const inference = inferScale({
      siblings: STATEMENTS.filter((k) => k !== key).map((k) => ({
        statement: k,
        scale: declared[k],
      })),
      ...(opts.documentUnits?.[key]
        ? { documentUnit: opts.documentUnits[key] }
        : {}),
      // ── THE IDENTITY CROSSES STATEMENTS, AND THAT IS MEASURED ──────────
      //
      // `paidUpCapital x factor == shares x faceValue` reads three BALANCE
      // SHEET lines, so handing its conclusion to the income statement or the
      // cash flow assumes the document prints all three at one magnitude. A
      // LAKHS P&L taking a CRORES balance-sheet identity would be a silent
      // 100x on revenue and profit, and this module records the differing case
      // as real (`SCALE_DIFFERS_BETWEEN_STATEMENTS`). Restricting the rung to
      // `key === "balanceSheet"` was tried and REVERTED, on the numbers.
      //
      // MEASURED on prod 2026-09-05 across all 6,868 extract rows:
      //
      //   income + balance sheet BOTH resolved      4,104 rows
      //     ...and they DISAGREE                        6 rows (0.15%)
      //   any two statements resolved               4,293 rows
      //     ...and they DISAGREE                       28 rows (0.65%)
      //   NOTHING resolved anywhere (this rung)       251 rows (3.65%)
      //
      // So the restriction would refuse 251 real readings to avoid a
      // transfer that goes wrong in 0.15% of the comparable population —
      // roughly forty rejections per averted error, all of them landing in
      // exactly the UNKNOWN_SCALE bucket this ticket exists to shrink.
      //
      // It would also be INCONSISTENT: the SIBLING_STATEMENT rung above
      // transfers a magnitude across statements too, at the same 0.15%, on the
      // strength of a DECLARED header rather than a derived one. The risk is a
      // property of the transfer, not of how the balance sheet's unit was
      // learned, so gating one rung and not the other buys nothing.
      //
      // What bounds it instead: every such row is warned
      // `SCALE_INFERRED_FROM_CAPITAL`, so the 251 are a queryable set rather
      // than an invisible one, and the disagreement that DOES show up is
      // concentrated in the cash flow (22 of the 28 differing rows) rather
      // than spread evenly.
      identity,
    });
    if (inference) {
      scales[key] = applyScaleInference(declared[key], inference);
      inferences[key] = inference;
    }
  }

  const is = raw.incomeStatement ?? null;
  const bs = raw.balanceSheet ?? null;
  const cf = raw.cashFlow ?? null;

  const present = {
    incomeStatement: statementHasFigure(is),
    balanceSheet: statementHasFigure(bs),
    cashFlow: statementHasFigure(cf),
  };

  if (!present.incomeStatement && !present.balanceSheet && !present.cashFlow) {
    // Dropped rather than persisted: a row of nothing but nulls carries no
    // information a reader could use and would still occupy the unique key,
    // blocking a later re-parse that DID find figures. The signal that the
    // model read nothing lands on the DOCUMENT's parseStatus instead.
    return { row: null, verdict: rejected(["NO_FIGURES"]) };
  }

  const isF = scales.incomeStatement.scaleFactor;
  const bsF = scales.balanceSheet.scaleFactor;
  const cfF = scales.cashFlow.scaleFactor;

  // The representative (label, factor) pair stored on the row. The income
  // statement wins when it has one, because it is the statement every reader
  // touches first; the per-statement detail is kept in `lines.validation`.
  const representative = present.incomeStatement
    ? scales.incomeStatement
    : present.balanceSheet
      ? scales.balanceSheet
      : scales.cashFlow;

  const totalIncomeAsPrinted = applyScale(rawNum(is, "totalIncome"), isF);
  // Scaled, sign UNTOUCHED — the evidence `normaliseCapexSign` is about to erase.
  const capexAsPrinted = applyScale(rawNum(cf, "capitalExpenditure"), cfF);

  const base: Omit<MappedExtract, "lines"> = {
    fiscalYear: String(raw.fiscalYear ?? "").trim() || isoDay(periodEnd),
    periodEnd,
    periodType,
    basis,

    revenueFromOperations: applyScale(rawNum(is, "revenueFromOperations"), isF),
    otherIncome: applyScale(rawNum(is, "otherIncome"), isF),
    operatingIncomeExOtherIncome: applyScale(
      rawNum(is, "operatingIncomeExOtherIncome"),
      isF,
    ),
    ebitdaBeforeExceptionalItems: applyScale(
      rawNum(is, "ebitdaBeforeExceptionalItems"),
      isF,
    ),
    netIncome: applyScale(rawNum(is, "netIncome"), isF),

    totalAssets: applyScale(rawNum(bs, "totalAssets"), bsF),
    totalLiabilities: applyScale(rawNum(bs, "totalLiabilities"), bsF),
    totalEquity: applyScale(rawNum(bs, "totalEquity"), bsF),
    totalDebt: applyScale(rawNum(bs, "totalDebt"), bsF),
    totalCash: applyScale(rawNum(bs, "totalCash"), bsF),

    operatingCashFlow: applyScale(rawNum(cf, "operatingCashFlow"), cfF),
    // POSITIVE by convention — `stock_financials` stores capex positive while
    // every cash-flow statement prints it negative. Enforced here rather than
    // trusted to the prompt: getting it wrong scores SIGN_MISMATCH on EVERY row
    // and blocks the reconcile gate. See `normaliseCapexSign` for the list of
    // fields this must never be extended to.
    capitalExpenditure: normaliseCapexSign(capexAsPrinted),
    freeCashFlow: applyScale(rawNum(cf, "freeCashFlow"), cfF),

    // NOT scaled — rupees per share, rupees per share, and a COUNT.
    eps: unscaled(rawNum(is, "eps")),
    sharesOutstanding: unscaled(rawNum(bs, "sharesOutstanding")),
    faceValue: unscaled(rawNum(bs, "faceValue")),
    // Paid-up capital IS money on the balance sheet, so it IS scaled.
    paidUpCapital: applyScale(rawNum(bs, "paidUpCapital"), bsF),

    scaleLabel: representative.scaleLabel,
    scaleFactor: representative.scaleFactor,
    confidence: unscaled(raw.confidence),
    pageRefs: normalizePageRefs(raw.pageRefs),
  };

  const verdict = validateMappedExtract({
    row: base,
    scales,
    present,
    totalIncomeAsPrinted,
    capexAsPrinted,
    hasNonFiniteRaw: hasNonFiniteRawFigure(raw),
  });

  // An inferred factor is a WARNING, never silent — the row is weaker evidence
  // than one whose header stated its own units, and a reader comparing it
  // against the page has to know which it is holding. Only warn for a
  // statement that actually carries figures; inferring a scale for an absent
  // statement would report work that changed nothing.
  const WARNING_BY_METHOD: Record<ScaleInferenceMethod, ValidationWarning> = {
    SIBLING_STATEMENT: "SCALE_INFERRED_FROM_SIBLING",
    SIBLING_PERIOD: "SCALE_INFERRED_FROM_DOCUMENT",
    PAID_UP_CAPITAL: "SCALE_INFERRED_FROM_CAPITAL",
  };
  if (opts.documentIsNonInr && !verdict.reasons.includes("NON_INR_CURRENCY")) {
    verdict.reasons.push("NON_INR_CURRENCY");
    verdict.status = "FAILED_VALIDATION";
  }

  for (const key of STATEMENTS) {
    const inference = inferences[key];
    if (!inference || !present[key]) continue;
    const warning = WARNING_BY_METHOD[inference.method];
    if (!verdict.warnings.includes(warning)) verdict.warnings.push(warning);
  }

  return {
    row: {
      ...base,
      lines: {
        items: Array.isArray(raw.lines) ? raw.lines : [],
        validation: {
          status: verdict.status,
          reasons: verdict.reasons,
          warnings: verdict.warnings,
          // WHICH rung fired and on what evidence. Without it an inferred
          // factor is indistinguishable from a declared one on the stored row,
          // and the whole point is that they are not equally strong.
          scaleInference: inferences,
          totalIncomeAsPrinted,
          capexAsPrinted,
          scales,
        },
      },
    },
    verdict,
  };
}

/** True when a raw statement object carries at least one finite number. */
export function statementHasFigure(
  statement: Record<string, unknown> | null | undefined,
): boolean {
  if (!statement || typeof statement !== "object") return false;
  return Object.values(statement).some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

/** Keep only finite, positive page numbers. */
function normalizePageRefs(
  refs: RawPageRefs | null | undefined,
): RawPageRefs | null {
  if (!refs || typeof refs !== "object") return null;
  const clean = (arr: number[] | null | undefined): number[] =>
    (Array.isArray(arr) ? arr : []).filter(
      (n) => typeof n === "number" && Number.isFinite(n) && n > 0,
    );
  return {
    incomeStatement: clean(refs.incomeStatement),
    balanceSheet: clean(refs.balanceSheet),
    cashFlow: clean(refs.cashFlow),
  };
}

/** `YYYY-MM-DD` for a UTC date — the fiscalYear fallback label. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Map a whole model response into rows.
 *
 * Returns the persistable rows AND a per-reason tally of everything that was
 * dropped, because "the model returned 4 periods and we wrote 0" and "the model
 * returned 0 periods" produce the same row count and must not produce the same
 * log line.
 */
export interface MappedDocument {
  rows: Array<{ row: MappedExtract; verdict: ExtractionVerdict }>;
  dropped: ValidationReason[];
  /** Periods the model returned, before any of ours were dropped. */
  periodsReturned: number;
}

export function mapDocumentFinancials(
  raw: RawDocumentFinancials | null | undefined,
  opts: { now?: Date } = {},
): MappedDocument {
  const periods = Array.isArray(raw?.periods) ? raw.periods : [];
  const rows: MappedDocument["rows"] = [];
  const dropped: ValidationReason[] = [];

  // ── PASS ONE: what did ANY period manage to state? — MONEY-1342 ─────────
  //
  // A document commonly prints its units once, over the current year, and
  // leaves the comparative column bare. Only a caller that can see every
  // period can supply that, which is why the rung lives here and not in
  // `mapPeriodExtract`. FIRST declaration wins — later periods are
  // comparatives of the first, not independent statements.
  const documentUnits: Partial<
    Record<
      "incomeStatement" | "balanceSheet" | "cashFlow",
      { unit: ScaleUnit; from: string }
    >
  > = {};
  for (const period of periods) {
    for (const key of [
      "incomeStatement",
      "balanceSheet",
      "cashFlow",
    ] as const) {
      if (documentUnits[key]) continue;
      const resolved = resolveScale(period?.scale?.[key]);
      if (resolved.resolved && resolved.scaleUnit !== null) {
        documentUnits[key] = {
          unit: resolved.scaleUnit,
          from: resolved.scaleLabel ?? key,
        };
      }
    }
  }

  // ── The DOCUMENT's own declared currency — MONEY-1348 ──────────────────
  //
  // The response schema already asks for `reportingCurrency`, and it is the
  // only place a document that never prints a currency SYMBOL can still say it
  // reports in dollars. Absent is INR by construction (this lane holds only
  // NSE/BSE filings); a stated non-rupee currency refuses every period.
  const declaredCurrency =
    typeof raw?.reportingCurrency === "string"
      ? raw.reportingCurrency.trim()
      : "";
  //
  // TESTED POSITIVELY, and that direction is the whole point. This was an
  // ANCHORED WHITELIST of INR spellings — anything not matching `^inr|₹|rs\.?|
  // rupees?|indian\s+rupees?$` exactly was non-INR — and `reportingCurrency`
  // is FREE TEXT from a model prompted with "ISO code ... e.g. INR". So
  // "INR (₹)", "Indian Rupee (INR)" and "Rs. in Lakhs" were all classified as
  // foreign currency, every period was stamped NON_INR_CURRENCY, and
  // `classifyIngestOutcome` returned UNSUPPORTED — which is in
  // `TERMINAL_PARSE_STATUSES` and carries `retryable: false`. A correctly-read
  // Indian filing was therefore discarded PERMANENTLY, by no lane, on the
  // strength of a punctuation mark.
  //
  // The failure direction decides the test direction. A false NON_INR verdict
  // is unrecoverable; a false INR verdict on this lane is nearly impossible,
  // because it holds only NSE/BSE filings. So the rule is the same POSITIVE
  // detector the per-statement labels already use, and an unrecognised string
  // means "not stated" rather than "not rupees" — which is what the sentence
  // above already promised ("Absent is INR by construction").
  //
  // The `!INR_CURRENCY` half covers the one shape the positive test alone gets
  // wrong: a filing that reports in rupees and mentions a dollar translation in
  // the same field. Refusing on ambiguity would be the safe direction if the
  // refusal were recoverable, and it is not.
  const documentIsNonInr =
    NON_INR_CURRENCY.test(declaredCurrency) &&
    !INR_CURRENCY.test(declaredCurrency);

  for (const period of periods) {
    const { row, verdict } = mapPeriodExtract(period ?? {}, {
      ...opts,
      documentUnits,
      documentIsNonInr,
    });
    if (row && verdict.persistable) {
      rows.push({ row, verdict });
    } else {
      dropped.push(...verdict.reasons);
    }
  }

  return { rows, dropped, periodsReturned: periods.length };
}

// ---------------------------------------------------------------------------
// ARMING — for the PROJECTION that comes later, not for this lane
// ---------------------------------------------------------------------------

/**
 * The env var that will gate the LATER projection of these readings into
 * `stock_financials`. NOTHING in the extraction lane consults it: writing to
 * `document_financial_extracts` is always safe because that table's unique key
 * carries `documentId` and `basis`, so a write never destroys a value it cannot
 * reproduce. `stock_financials` has no `source` in its key and a write there
 * ERASES the incumbent, which is what needs an arm.
 */
/**
 * The figure payload BOTH writers persist — MONEY-1340.
 *
 * There are two `upsertExtract` implementations, in packages that cannot
 * import each other's callers: `workers/src/processors/doc-extract-persist.ts`
 * (online worker) and `scripts/jobs/doc-ingest-backfill.ts` (batch-ingest and
 * the sweep). Both hand-built this same object, so adding a column meant
 * remembering two places — and a column added to one is a column that is
 * present on some rows and absent on others, which is the shape this repo
 * keeps paying for.
 *
 * THE DELIBERATE ABSENCES, moved here with the payload rather than left behind
 * in one of the two copies: `revenue`, `operatingIncome` and `ebitda` are NOT
 * written by this reader. The canonical `revenue` is TOTAL INCOME while a
 * filing's headline "Revenue" is usually revenue FROM OPERATIONS — a different
 * quantity — so the components are stored separately and the total is derived
 * by the projection, only where both were read. The `operatingIncome` and
 * `ebitda` conventions were established empirically against XBRL and there is
 * no equivalent evidence for a PDF reading. A column this reader cannot source
 * is a column it does not claim.
 */
export function buildExtractWritePayload(
  row: MappedExtract,
  verdict: Pick<ExtractionVerdict, "status" | "reasons" | "warnings">,
  model: string,
  now: Date = new Date(),
) {
  // RETURN TYPE INFERRED, deliberately. An explicit `Record<string, unknown>`
  // compiles here and then defeats Prisma's own check at both call sites: the
  // spread into `create` no longer proves the required columns are present, so
  // a field dropped from this builder becomes a RUNTIME failure instead of a
  // type error. Inference keeps the literal shape and the callers keep their
  // guarantee.
  return {
    revenueFromOperations: row.revenueFromOperations,
    otherIncome: row.otherIncome,
    operatingIncomeExOtherIncome: row.operatingIncomeExOtherIncome,
    ebitdaBeforeExceptionalItems: row.ebitdaBeforeExceptionalItems,
    netIncome: row.netIncome,

    totalAssets: row.totalAssets,
    totalLiabilities: row.totalLiabilities,
    totalEquity: row.totalEquity,
    totalDebt: row.totalDebt,
    totalCash: row.totalCash,

    operatingCashFlow: row.operatingCashFlow,
    capitalExpenditure: row.capitalExpenditure,
    freeCashFlow: row.freeCashFlow,

    eps: row.eps,
    sharesOutstanding: row.sharesOutstanding,
    paidUpCapital: row.paidUpCapital,
    faceValue: row.faceValue,

    scaleLabel: row.scaleLabel,
    scaleFactor: row.scaleFactor,
    confidence: row.confidence,
    pageRefs: row.pageRefs as unknown as object,
    lines: row.lines as unknown as object,

    model,
    promptVersion: DOC_FINANCIALS_PROMPT_VERSION,
    status: verdict.status,
    // QUERYABLE, not just recorded. The same reasons are inside `lines` too and
    // that is where they were unreachable: the 96.6% UNKNOWN_SCALE finding took
    // an aggregation over a nested document to see.
    validationReasons: [...verdict.reasons],
    validationWarnings: [...verdict.warnings],
    fiscalYear: row.fiscalYear,
    extractedAt: now,
  };
}

export const DOC_FINANCIALS_APPLY_ENV = "DOC_FINANCIALS_APPLY";

/**
 * Compare against the LITERAL string, never `Boolean()`.
 *
 * `Boolean("false")` is `true`, which would arm the job in the one
 * configuration meant to keep it off — and "absent" must not be the same state
 * as "false", because absent is exactly how MF_METADATA_PROVIDER disabled its
 * job silently for months (MONEY-1214).
 */
export function isDocFinancialsApplyArmed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[DOC_FINANCIALS_APPLY_ENV] === "true";
}
