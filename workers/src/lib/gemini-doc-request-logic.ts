/**
 * ONE request core, three callers — MONEY-1314.
 *
 * The online path, the Developer-API batch path and the Vertex batch path all
 * send the SAME prompt, the SAME response schema and the SAME arithmetic
 * expectations. Before this module the online path built its request inline in
 * `gemini-pdf.ts` and a batch path did not exist; adding one by copying would
 * have produced a second prompt and a second schema that drift apart silently —
 * and a drifted prompt is invisible, because both sides keep returning
 * plausible JSON.
 *
 * Everything here is PURE. No client, no network, no clock. The transports live
 * in `gemini-pdf.ts` (online) and the backfill job (batch).
 *
 * ## The prefix ordering is load-bearing, and it was backwards
 *
 * `buildDocumentFinancialsPrompt` put the VARIABLE context (symbol, docType,
 * period, title) FIRST and the fixed rules after it. Implicit caching keys on
 * the leading tokens of the request, so a prefix that starts with the symbol
 * name is a different prefix for every document and caches nothing. Reversing
 * the order — rules and worked examples first, document context last — is what
 * makes the discount reachable at all.
 *
 * Thresholds, verified against the live docs 2026-09-01: implicit caching needs
 * **≥4,096 tokens** of stable prefix on 3.x models (2,048 on 2.5), and gives
 * ~90% off the cached portion. Cache and batch discounts do NOT stack — cached
 * tokens bill at 10% of the STANDARD rate, and that takes precedence over the
 * 50% batch rate.
 *
 * `FIXED_PREFIX` therefore carries real worked examples rather than filler. The
 * examples earn their tokens twice: they lift the prefix over the threshold and
 * they are the few-shot grounding for the two mistakes the arithmetic gate
 * catches most often (a manufactured `totalIncome`, and a comparative period
 * silently dropped).
 */

import {
  DOCUMENT_FINANCIALS_SCHEMA,
  buildDocumentFinancialsPrompt,
} from "@usemoney/core/market-data/document-financials-logic";

/** Deterministic extraction: never sample. */
export const DOC_REQUEST_TEMPERATURE = 0;

/**
 * VISIBLE answer budget, guaranteed independent of thinking — MONEY-1334.
 *
 * The largest CLEANLY FINISHED answer in the MONEY-1332 pilot was 7,100 chars
 * (~1,800 tokens) over four periods. 8,192 is ~4.5x that, so a richer filing
 * still completes.
 */
export const DOC_REQUEST_VISIBLE_OUTPUT_TOKENS = 8_192;

/**
 * THINKING budget, set EXPLICITLY rather than left dynamic.
 *
 * Thinking is kept ON: the MONEY-1332 arms measured it carrying accuracy (17 vs
 * 13 extracted, 45 vs 40 periods, 6 vs 7 real conflicts against the
 * no-thinking arm). What is fixed here is that it was UNBOUNDED. With
 * `thinkingConfig` unset the model thinks dynamically, and on Gemini 2.5/3.x
 * `maxOutputTokens` caps thinking + visible output COMBINED — so the ceiling
 * was the only bound on thinking, and thinking bills at the OUTPUT rate.
 *
 * That is what MONEY-1332's flat 24,576 got wrong, and its docblock said so
 * out loud: "raising a ceiling costs nothing that is not generated". False for
 * this configuration. The pilot's own evidence: truncated answers had emitted
 * only 678-5,513 chars (~170-1,400 tokens) of text against an 8,192 budget, so
 * ~78% went to thinking. Tripling the ceiling triples the room thinking is free
 * to occupy, on every one of ~32,893 documents.
 *
 * 8,192 sits above the ~6,400 the pilot implied thinking was consuming, so it
 * does not squeeze what was measured working — it stops the unbounded case.
 */
export const DOC_REQUEST_THINKING_BUDGET = 8_192;

/**
 * Total per-request ceiling: visible + thinking, never a flat number.
 *
 * This is the MONEY-587 shape (`packages/core/src/gemini/models.ts`), where a
 * flat 8,192 on a thinking model left almost no room for the visible response
 * and silently truncated a 17-section research JSON to summary + score. Budget
 * the visible output as a constant ON TOP of the thinking budget and both are
 * guaranteed.
 *
 * 16,384 replaces MONEY-1332's 24,576, and being SMALLER is the point: bounding
 * thinking buys back more headroom than the flat raise did, while guaranteeing
 * strictly more visible output than the 8,192 that truncated 15 of 22 answers.
 *
 * It also matters for the ONLINE lane, which MONEY-1332 changed without saying
 * so: `parseMarkdownFinancials` builds its config from `buildGenerationConfig`
 * and runs inside a 240s `withDeadline`. At 24,576 a slow generation could
 * exhaust that deadline — converting a MAX_TOKENS failure into a TIMEOUT
 * failure, still billed in full. 16,384 at ~100 tok/s is ~164s, inside the
 * deadline with margin.
 *
 * STILL UNVERIFIED ON THE PRODUCTION MODEL. Every number above was measured on
 * `gemini-3.5-flash`, because the pilot ran with DOC_PARSE_MODEL unset and
 * `resolveDocParseModel` falls back to the PREMIUM chat model; both cloudbuild
 * specs run `gemini-3.7-flash`. The registry records that exact fallback as a
 * shipped incident (4x batch cost). Re-measure with the model PINNED before the
 * drain — the 200-document pilot is the place.
 */
export const DOC_REQUEST_MAX_OUTPUT_TOKENS =
  DOC_REQUEST_VISIBLE_OUTPUT_TOKENS + DOC_REQUEST_THINKING_BUDGET;

/** Implicit-caching threshold for 3.x models. Below this, no discount. */
export const IMPLICIT_CACHE_MIN_TOKENS = 4_096;

/**
 * Rough token count, for LOGS ONLY.
 *
 * ~4 chars/token is the standard English approximation and it is WRONG here by
 * enough to matter: measured against `countTokens`, FIXED_PREFIX is 16,073
 * chars and 4,506 real tokens — 3.57 chars/token, because JSON punctuation in
 * the worked examples tokenises far denser than prose. This function returns
 * 4,018 for the same string, which is BELOW the 4,096 threshold the prefix
 * actually clears.
 *
 * So it must never be the basis of the caching assertion. It underestimates by
 * ~12% on this content and would fail a healthy prefix; calibrate the divisor
 * to fix that and it silently PASSES an unhealthy one the moment the prose/JSON
 * mix shifts. `MEASURED_FIXED_PREFIX` is the authority — see below.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The two worked examples.
 *
 * Both are synthetic, both are stable, and both teach a rule the arithmetic
 * gate cannot express. Keeping them BYTE-STABLE is what keeps the cache warm:
 * any edit invalidates every cached prefix, so change them deliberately.
 */
const WORKED_EXAMPLES = `
────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 1 — the three Schedule III income rows are SEPARATE
────────────────────────────────────────────────────────────────────────
The statement prints:

  | Revenue from operations | 27,234 | 24,880 |
  | Other income            |    611 |    540 |
  | Total income            | 27,845 | 25,420 |

Correct: revenueFromOperations 27234, otherIncome 611, totalIncome 27845.

WRONG, and the most common failure: putting 27,845 into
revenueFromOperations because it is the larger number, or leaving
totalIncome null and expecting it to be inferred. The three rows are
checked against each other; a merged or manufactured figure destroys the
check while looking entirely reasonable.

If the statement prints only two of the three, report those two and null
the third. Never add the components to synthesise a total the document
does not print.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 2 — every period, every basis, including the comparative
────────────────────────────────────────────────────────────────────────
An annual report normally presents FOUR (period, basis) combinations:

  FY2025 CONSOLIDATED   FY2024 CONSOLIDATED
  FY2025 STANDALONE     FY2024 STANDALONE

All four are separate entries. The comparative prior year is data the
document prints and must not be dropped because it is "old"; the two
bases differ by a MULTIPLE for any holding company and must never be
merged. A quarterly result typically presents fewer — report exactly what
is printed, no more and no less.

Scale is copied VERBATIM from the statement's own units header ("Rs. in
crore", "₹ in lakhs", "in millions"). Do not convert. A figure reported
under the wrong scale is wrong by a factor of a hundred and reads as
perfectly ordinary.

────────────────────────────────────────────────────────────────────────
LABEL GLOSSARY — the same line, printed a dozen ways
────────────────────────────────────────────────────────────────────────
Indian filings do not agree on wording. Match on MEANING, not on an exact
string, and never invent a mapping for a label you do not recognise —
null is correct where the concept is genuinely absent.

revenueFromOperations
  "Revenue from operations" · "Revenue from operations (net)" · "Income
  from operations" · "Sales" · "Net sales" · "Turnover" · "Gross sales
  less excise duty" · "Revenue from contracts with customers"
  NOT: "Total income", "Total revenue", "Other income"

otherIncome
  "Other income" · "Other operating income" (only if presented OUTSIDE
  revenue from operations) · "Non-operating income" · "Other gains net"

totalIncome
  "Total income" · "Total revenue" · "Total income (I+II)" ·
  "Total revenue from operations and other income"

totalExpenses
  "Total expenses" · "Total expenditure" · "Total costs"

profitBeforeTax
  "Profit before tax" · "Profit/(loss) before tax" · "PBT" · "Profit
  before exceptional items and tax" (use this ONLY when no post-
  exceptional PBT line is printed) · "Earnings before tax"

profitAfterTax
  "Profit for the year" · "Profit for the period" · "Profit/(loss) for
  the year" · "Net profit" · "PAT" · "Profit after tax" · "Net income"
  For consolidated statements prefer the TOTAL profit line, and note that
  "attributable to owners of the parent" is a DIFFERENT figure — if both
  are printed, take the total and leave the attribution alone.

totalAssets
  "TOTAL ASSETS" · "Total assets" · "Total of assets"
  Balance-sheet totals are usually printed in capitals; the sub-totals
  "Total non-current assets" and "Total current assets" are NOT this.

totalEquity
  "Total equity" · "Total shareholders funds" · "Shareholders equity" ·
  "Equity attributable to owners" + "Non-controlling interests" summed
  ONLY when a combined "Total equity" is itself printed
  "Equity share capital" alone is NOT total equity.

totalLiabilities
  Rarely printed directly. Derive as (TOTAL EQUITY AND LIABILITIES) −
  (Total equity) — the ONE permitted derivation. Do not sum current and
  non-current liabilities yourself if a grand total is printed.

cashFlowFromOperations · cashFlowFromInvesting · cashFlowFromFinancing
  "Net cash generated from / (used in) operating activities" and its
  investing and financing siblings. Keep the printed sign: cash used is
  negative.

capitalExpenditure
  "Purchase of property, plant and equipment" · "Additions to fixed
  assets" · "Payments for PPE and intangibles". Report POSITIVE (rule 5).

eps
  "Basic EPS" · "Earnings per equity share — Basic". Prefer BASIC over
  diluted when both are printed. Rupees per share, never in the
  statement scale.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 7 — balance sheet and cash flow, with their sign rules
────────────────────────────────────────────────────────────────────────
INPUT (markdown, an annual report, Rs. in crore):

  ## Consolidated Balance Sheet as at 31 March 2025
  | Particulars | 2025 | 2024 |
  |---|---|---|
  | Property, plant and equipment | 8,410.20 | 7,905.60 |
  | Total non-current assets | 12,880.75 | 11,940.30 |
  | Inventories | 2,206.40 | 2,015.85 |
  | Trade receivables | 3,118.90 | 2,860.10 |
  | Cash and cash equivalents | 1,540.65 | 1,120.40 |
  | Total current assets | 8,890.25 | 7,880.15 |
  | TOTAL ASSETS | 21,771.00 | 19,820.45 |
  | Equity share capital | 200.00 | 200.00 |
  | Other equity | 12,455.30 | 10,890.75 |
  | Total equity | 12,655.30 | 11,090.75 |
  | Total non-current liabilities | 4,220.10 | 4,510.30 |
  | Total current liabilities | 4,895.60 | 4,219.40 |
  | TOTAL EQUITY AND LIABILITIES | 21,771.00 | 19,820.45 |

  ## Consolidated Cash Flow Statement
  | Particulars | 2025 |
  |---|---|
  | Net cash generated from operating activities | 2,940.55 |
  | Net cash used in investing activities | (1,880.20) |
  | Net cash used in financing activities | (640.10) |
  | Net increase in cash and cash equivalents | 420.25 |

OUTPUT (FY2025 entry; FY2024 follows the same shape):

  {
    "fiscalYear": "FY2025",
    "periodEnd": "2025-03-31",
    "periodType": "ANNUAL",
    "basis": "CONSOLIDATED",
    "scale": "Rs. in crore",
    "balanceSheet": {
      "propertyPlantEquipment": 8410.20,
      "totalNonCurrentAssets": 12880.75,
      "inventories": 2206.40,
      "tradeReceivables": 3118.90,
      "cashAndCashEquivalents": 1540.65,
      "totalCurrentAssets": 8890.25,
      "totalAssets": 21771.00,
      "equityShareCapital": 200.00,
      "otherEquity": 12455.30,
      "totalEquity": 12655.30,
      "totalNonCurrentLiabilities": 4220.10,
      "totalCurrentLiabilities": 4895.60,
      "totalLiabilities": 9115.70
    },
    "cashFlow": {
      "operatingCashFlow": 2940.55,
      "investingCashFlow": -1880.20,
      "financingCashFlow": -640.10,
      "netCashFlow": 420.25
    }
  }

Three rules are doing work here.

SIGNS. Parentheses mean NEGATIVE. "Net cash USED in investing activities
(1,880.20)" becomes -1880.20, not 1880.20. This is the single most common
extraction error in Indian filings and it inverts the meaning of the
statement: an outflow recorded as an inflow makes a company burning cash
look like a company generating it. The label alone is not enough — some
filings print "Net cash used in investing activities: -1,880.20" with an
explicit minus and NO parentheses, and a few print the outflow as a bare
positive under a "(Outflow)" column header. Read the number's own
notation first, the label second, and check the arithmetic third.

THE ARITHMETIC CHECK. operating + investing + financing must equal the
net change: 2940.55 - 1880.20 - 640.10 = 420.25. It does. When it does
not, a sign is wrong somewhere and the most likely culprit is an outflow
read as positive — re-read the statement rather than emitting numbers
that do not add up. The same check applies on the balance sheet:
totalAssets must equal totalEquity + totalLiabilities.

DERIVED LINES ARE ALLOWED WHEN THE ARITHMETIC IS EXACT AND STATED.
"totalLiabilities" is not printed in that balance sheet. It is
4220.10 + 4895.60 = 9115.70, and equivalently 21771.00 - 12655.30 =
9115.70. Two independent routes agreeing is what makes it safe to emit.
A line that requires an assumption, an estimate, or a single unverified
route is LEFT ABSENT — an absent field is a known gap, while a wrong
field is indistinguishable from a real one for everyone downstream.

Note also that both years appear in the balance sheet and only one in the
cash flow. Emit what each statement actually carries; do not manufacture
an FY2024 cash flow from a document that does not print one.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 5 — a complete quarterly result, in and out
────────────────────────────────────────────────────────────────────────
INPUT (markdown, as converted):

  # ACME INDUSTRIES LIMITED
  ## Unaudited Financial Results for the Quarter Ended 30 June 2025
  (Rs. in lakhs, except per share data)

  | Particulars | Q1 FY2026 | Q1 FY2025 |
  |---|---|---|
  | Revenue from operations | 4,120.55 | 3,880.10 |
  | Other income | 96.20 | 71.45 |
  | Total income | 4,216.75 | 3,951.55 |
  | Total expenses | 3,702.40 | 3,510.88 |
  | Profit before tax | 514.35 | 440.67 |
  | Tax expense | 132.10 | 115.02 |
  | Profit for the period | 382.25 | 325.65 |
  | Basic EPS (Rs.) | 3.82 | 3.26 |

  Notes: The above results were reviewed by the Audit Committee.
  Standalone results only; the company has no subsidiaries.

OUTPUT:

  {
    "companyName": "ACME INDUSTRIES LIMITED",
    "reportingCurrency": "INR",
    "periods": [
      {
        "fiscalYear": "FY2026",
        "periodEnd": "2025-06-30",
        "periodType": "QUARTERLY",
        "basis": "STANDALONE",
        "scale": "Rs. in lakhs, except per share data",
        "incomeStatement": {
          "revenueFromOperations": 4120.55,
          "otherIncome": 96.20,
          "totalIncome": 4216.75,
          "totalExpenses": 3702.40,
          "profitBeforeTax": 514.35,
          "profitAfterTax": 382.25,
          "eps": 3.82
        }
      },
      {
        "fiscalYear": "FY2025",
        "periodEnd": "2024-06-30",
        "periodType": "QUARTERLY",
        "basis": "STANDALONE",
        "scale": "Rs. in lakhs, except per share data",
        "incomeStatement": {
          "revenueFromOperations": 3880.10,
          "otherIncome": 71.45,
          "totalIncome": 3951.55,
          "totalExpenses": 3510.88,
          "profitBeforeTax": 440.67,
          "profitAfterTax": 325.65,
          "eps": 3.26
        }
      }
    ]
  }

Note what happened and what did not. BOTH quarters are returned — the
comparative is data. The basis is STANDALONE because the document says
so, not guessed. "scale" is the units header copied verbatim, including
the "except per share data" qualifier. EPS stays in rupees (3.82) and is
NOT scaled by lakhs. The balance sheet and cash flow are ABSENT from this
document, so those objects are simply not populated — no zeros, no
invented rows. The audit-committee note is prose and contributes nothing.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 6 — one annual report, two bases, and where they differ
────────────────────────────────────────────────────────────────────────
A holding company's annual report prints both bases and they differ by a
MULTIPLE, not by a rounding:

  Consolidated Balance Sheet — TOTAL ASSETS      19,768 (Rs. crore)
  Standalone Balance Sheet   — TOTAL ASSETS       7,332 (Rs. crore)

Both are correct. Both belong in the output as separate entries with the
same fiscalYear and different "basis". Merging them, or reporting only
the larger, silently misstates the company by 2.7x.

A reader downstream chooses which basis it wants; it cannot recover a
basis that was never emitted. When the document labels a statement
"Consolidated" anywhere in its heading or column header, that statement
is CONSOLIDATED. When it says nothing and the company reports no
subsidiaries, it is STANDALONE. When it genuinely cannot be determined,
null the basis rather than guessing — a wrong basis is worse than an
absent one, because it will be trusted.

Do not attempt to reconcile the two bases against each other. They are
different reporting entities and are not expected to agree on any line.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 4 — the document is markdown converted from a PDF
────────────────────────────────────────────────────────────────────────
The content you receive has been converted from the filed PDF, so it
carries conversion artefacts. Read through them:

  · A number may arrive with its digit groups separated by spaces —
    "11, 0 9 0" is 11,090 and "27, 2 3 4" is 27,234. Read the intended
    number. Never report the fragments as separate figures.
  · The rupee sign may render as a backtick or be missing entirely.
    Absence of a currency glyph does not change the reported currency.
  · A wide table may be split across two markdown tables with the header
    repeated. Those are ONE table continued, not two periods.
  · Footnote markers can be glued to figures ("4,935*"). Report 4935.
  · Column headers may be lost on a continuation page. Use the column
    ORDER established by the first fragment of that table.

If a figure is genuinely illegible after allowing for all of the above,
null it. A guessed digit is worse than a missing one: the arithmetic gate
cannot distinguish a wrong-but-internally-consistent number from a right
one, and it will pass.

────────────────────────────────────────────────────────────────────────
WORKED EXAMPLE 3 — signs, and what "null" means
────────────────────────────────────────────────────────────────────────
A loss is negative. A cash burn is negative. Negative equity is negative.
Every figure keeps the sign the document prints, with ONE exception:
capitalExpenditure is reported as a positive magnitude even though the
cash-flow statement shows it as an outflow.

Null means "the document does not state this". It does not mean zero, and
it does not mean "I could compute it". The single permitted derivation is
totalLiabilities = (total equity and liabilities) − (total equity), and
only when both of those are printed.
`.trim();

/**
 * The stable prefix: rules + worked examples, identical for every document.
 *
 * The variable document context is appended AFTER this by the builders below,
 * which is the whole point — see the module header.
 */
export const FIXED_PREFIX = [
  "You are reading a filed Indian company financial document and extracting",
  "the statements it contains. Return ONLY data the document actually prints.",
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
  "",
  WORKED_EXAMPLES,
].join("\n");

/** The variable tail: which document this is. Never part of the cached prefix. */
export function buildDocumentContext(ctx: {
  symbol: string;
  docType: string;
  period: string;
  title?: string | null;
}): string {
  return [
    "",
    "────────────────────────────────────────────────────────────────────────",
    "THE DOCUMENT TO READ",
    "────────────────────────────────────────────────────────────────────────",
    `Issuer symbol: ${ctx.symbol}`,
    `Document type: ${ctx.docType}`,
    `Filed period (as we catalogued it): ${ctx.period}`,
    ...(ctx.title ? [`Document title: ${ctx.title}`] : []),
  ].join("\n");
}

export interface DocRequestContext {
  symbol: string;
  docType: string;
  period: string;
  title?: string | null;
}

/** Shared generationConfig. One definition, so the paths cannot drift. */
export function buildGenerationConfig(opts?: {
  /**
   * Disable model thinking.
   *
   * MEASURED 2026-09-01: `thinkingBudget: 0` removes thinking tokens entirely
   * (188 → 0 on a probe) and cut total tokens 32%. Thinking bills at the OUTPUT
   * rate, so this is a real saving across 48k documents.
   *
   * It is NOT the default, and that is deliberate: thinking may be carrying
   * accuracy on dense multi-period statements, and trading correctness for ~18%
   * without evidence is the wrong direction on a lane whose whole purpose is
   * figures. The pilot measures both arms and the winner becomes the default.
   */
  disableThinking?: boolean;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  // `thinkingConfig` is now ALWAYS emitted, and that is the fix rather than a
  // tidy-up: omitting it leaves thinking DYNAMIC, which makes maxOutputTokens
  // the only thing bounding it. A budget stated here is a budget the vendor
  // enforces.
  const thinkingBudget = opts?.disableThinking
    ? 0
    : DOC_REQUEST_THINKING_BUDGET;
  // ── AN OVERRIDE BELOW THE THINKING BUDGET IS REFUSED — MONEY-1346 ────────
  //
  // `maxOutputTokens` caps thinking and visible output COMBINED, and
  // `thinkingConfig` is now emitted unconditionally, so an override at or below
  // `thinkingBudget` describes a request that CANNOT emit a visible token: the
  // model spends the whole ceiling reasoning and every document finishes
  // MAX_TOKENS with an empty body. The run does not fail — it reports
  // DOC_PARSE_TRUNCATED for 100% of its documents, which reads exactly like a
  // model that cannot answer rather than a flag that cannot work.
  //
  // REFUSED, not clamped, and not silently re-interpreted as a visible budget.
  // Clamping would run something the operator did not ask for; re-interpreting
  // would give one flag two meanings depending on its value. The same
  // refuse-don't-clamp rule `resolveShard` follows, for the same reason: a
  // number that cannot mean what it says is an error at the boundary, not a
  // guess in the middle.
  const override = opts?.maxOutputTokens;
  if (override !== undefined && override <= thinkingBudget) {
    throw new Error(
      `buildGenerationConfig: maxOutputTokens=${override} leaves no room for ` +
        `visible output — thinkingBudget=${thinkingBudget} is spent first and ` +
        `the ceiling covers both. Pass a value above ${thinkingBudget}, or ` +
        `disable thinking to reclaim the whole ceiling.`,
    );
  }
  return {
    temperature: DOC_REQUEST_TEMPERATURE,
    // The override stays absolute (an operator asking for N means N — it names
    // the vendor's own field); the DEFAULT is derived so visible output can
    // never be squeezed by thinking.
    maxOutputTokens:
      override ?? DOC_REQUEST_VISIBLE_OUTPUT_TOKENS + thinkingBudget,
    responseMimeType: "application/json",
    responseSchema: DOCUMENT_FINANCIALS_SCHEMA,
    thinkingConfig: { thinkingBudget },
  };
}

/**
 * The prompt text for a request: stable prefix, then this document's context.
 *
 * `buildDocumentFinancialsPrompt` is retained and re-exported by the core
 * module for the legacy online path; this is the cache-ordered replacement.
 */
export function buildPromptText(ctx: DocRequestContext): string {
  return `${FIXED_PREFIX}\n${buildDocumentContext(ctx)}`;
}

/**
 * ONLINE request — markdown (text) or a file reference (vision).
 *
 * The parts are ordered prompt-FIRST so the cached prefix leads the request in
 * both modes.
 */
export function buildOnlineRequest(input: {
  ctx: DocRequestContext;
  /** Page-selected markdown. Mutually exclusive with `file`. */
  markdown?: string;
  /** Whole-PDF vision. Mutually exclusive with `markdown`. */
  file?: { fileUri: string; mimeType: string };
  disableThinking?: boolean;
  /** Override the per-request output ceiling; undefined uses the default. */
  maxOutputTokens?: number;
}): Record<string, unknown> {
  if ((input.markdown == null) === (input.file == null)) {
    throw new Error(
      "buildOnlineRequest: exactly one of `markdown` or `file` is required",
    );
  }
  const prompt = buildPromptText(input.ctx);
  const parts: Record<string, unknown>[] = [{ text: prompt }];
  if (input.file) parts.push({ fileData: input.file });
  else
    parts.push({ text: `\n\nDOCUMENT CONTENT (markdown):\n${input.markdown}` });

  return {
    contents: [{ role: "user", parts }],
    generationConfig: buildGenerationConfig({
      disableThinking: input.disableThinking,
      maxOutputTokens: input.maxOutputTokens,
    }),
  };
}

/** Which batch dialect a JSONL line is written in. */
export type BatchShape = "developer" | "vertex";

/**
 * ONE JSONL line for a batch job.
 *
 * The two dialects differ in exactly one way and it is easy to get wrong:
 *
 *   developer  { "request": {...}, "metadata": { "key": "<id>" } }
 *   vertex     { "request": {...} }                     // NO key, anywhere
 *
 * The `developer` shape is the one this project uses and it is PROBED, not
 * read: a live `batchGenerateContent` accepted exactly this on 2026-09-01
 * (`batches/erdmxqj4t8ibqcgv4iijrmar1rdstg5dexzd`). Sources that place the key
 * at the top level describe a different revision of the API; the probe is the
 * authority.
 *
 * Vertex is implemented and tested but not currently taken — the ladder landed
 * on the Developer API, whose endpoint is the region-less one prod already
 * uses. It stays here so switching is a parameter and not a rewrite.
 */
export function buildBatchRequestLine(args: {
  shape: BatchShape;
  /** Correlates the response back to the document row. */
  documentId: string;
  ctx: DocRequestContext;
  markdown?: string;
  file?: { fileUri: string; mimeType: string };
  disableThinking?: boolean;
  /**
   * Override the per-request output ceiling.
   *
   * Declared on BOTH builders deliberately. A field a type accepts and a
   * builder forwards to nobody is silently inert — which is exactly what
   * happened to `createMissing` (MONEY-1235), documented as opt-in and
   * impossible to opt into for every production run that ever executed.
   */
  maxOutputTokens?: number;
}): string {
  const request = buildOnlineRequest({
    ctx: args.ctx,
    markdown: args.markdown,
    file: args.file,
    disableThinking: args.disableThinking,
    maxOutputTokens: args.maxOutputTokens,
  });
  const line =
    args.shape === "developer"
      ? { request, metadata: { key: args.documentId } }
      : { request };
  return JSON.stringify(line);
}

/**
 * Does the fixed prefix clear the implicit-caching threshold?
 *
 * Asserted by the suite rather than assumed. A prefix that silently drops below
 * 4,096 tokens loses ~90% off its input on every one of ~48,000 batch requests,
 * and nothing anywhere would report it — the requests keep succeeding at full
 * price.
 */
/**
 * The `countTokens` measurement, pinned to the exact bytes it was taken on.
 *
 * A token count cannot be recomputed offline — there is no local tokenizer for
 * this model and the char heuristic is off by 12% on this content (see
 * `approxTokens`). So the number is RECORDED, and the recording is bound to a
 * sha256 of the string it describes.
 *
 * That binding is the whole point. A test can then fail in the one way that
 * matters: someone edits FIXED_PREFIX, the digest stops matching, and the
 * suite says "re-measure" instead of quietly vouching for a count that was
 * taken against different bytes. Pinning a number WITHOUT pinning the artifact
 * it came from is how a tripwire ends up guarding the wrong file.
 *
 * To re-measure after an edit:
 *   POST …/v1beta/models/gemini-3.7-flash:countTokens
 *   { "contents": [{ "role": "user", "parts": [{ "text": FIXED_PREFIX }] }] }
 * then update BOTH fields below from the response and the digest.
 */
export const MEASURED_FIXED_PREFIX = {
  /** `totalTokens` from countTokens on the model named below. */
  tokens: 4_506,
  /** sha256 of FIXED_PREFIX, utf8, at the moment of measurement. */
  sha256: "956256aea9c4df250acdeb98355dd51a854acfd2e8a4bdb963aa226f45660ce9",
  chars: 16_073,
  model: "gemini-3.7-flash",
  measuredAt: "2026-09-01",
} as const;

/**
 * Does the fixed prefix clear the implicit-caching threshold?
 *
 * Asserted by the suite rather than assumed. A prefix that silently drops below
 * 4,096 tokens loses ~90% off its input on every one of ~48,000 batch requests,
 * and nothing anywhere would report it — the requests keep succeeding at full
 * price. There is no error, no warning and no counter; the only symptom is a
 * bill.
 *
 * `stale` is returned rather than thrown so the CALLER decides. A worker that
 * finds a stale digest should still run — losing a cache discount is a cost
 * problem, not a correctness one, and refusing to parse documents over it would
 * be the more expensive mistake.
 */
export function fixedPrefixClearsCacheThreshold(digest: string): {
  ok: boolean;
  stale: boolean;
  measured: number;
  min: number;
} {
  const stale = digest !== MEASURED_FIXED_PREFIX.sha256;
  return {
    ok: !stale && MEASURED_FIXED_PREFIX.tokens >= IMPLICIT_CACHE_MIN_TOKENS,
    stale,
    measured: MEASURED_FIXED_PREFIX.tokens,
    min: IMPLICIT_CACHE_MIN_TOKENS,
  };
}

export { DOCUMENT_FINANCIALS_SCHEMA, buildDocumentFinancialsPrompt };
