/**
 * Document-derived financials → the reader-facing table — MONEY-1255.
 *
 * Pure: no I/O, no DB, no clock. The sibling of
 * `xbrl-projection.ts`, one source further down the authority order.
 *
 * ## What this module is FOR
 *
 * `DocumentFinancialExtract` holds ONE MODEL'S READING of one PDF, per period,
 * per basis — both bases kept, because its key carries `basis`.
 * `StockFinancials` is what the product reads: one row per
 * (symbol, exchange, statementType, periodType, period), with NO `source` and
 * NO `basis` in that key. This module is the seam between them, and it does
 * three things:
 *
 *   1. PROJECT an extract into the flat `StockFinancials` shape.
 *   2. GRADE that reading against the incumbent, field by field, on the same
 *      verdict ladder the XBRL gate uses.
 *   3. PLAN the write, including what it must preserve of whatever it replaced.
 *
 * ## The one-way door, restated because it is the reason for every default here
 *
 * `StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
 * period])`. Two sources describing one period are ONE ROW. So the moment
 * anything writes a period, the previous value for it is gone and there is
 * nothing left to compare against. That is why:
 *
 *   - the grading (`gradeExtract`) has to happen BEFORE the write, and why
 *     {@link planDocumentFinancialsWrite} refuses an extract that has not been
 *     graded (`requireGraded`, default TRUE);
 *   - whatever IS displaced is preserved in the row that displaced it
 *     ({@link DOC_DISPLACEMENT_KEY}), written EXACTLY ONCE;
 *   - `null` means UNSOURCED and is never written as `0`.
 *
 * ## Where DOC_PDF sits, and why it is deliberately near the bottom
 *
 * `FINANCIALS_AUTHORITY` is the ONE declared order and this module never
 * restates it — {@link docAuthorityState} is a PREDICATE ABOUT that order, not
 * a second copy of it. `DOC_PDF` is declared SECOND — immediately below
 * `NSE_XBRL` and above both vendors — because an annual report is a PRIMARY
 * source and Tickertape and Screener are scrapes of that same document.
 *
 * This position means a document reading CAN displace a vendor value, and
 * `StockFinancials` carries no `source` in its key, so the displaced number is
 * gone. What makes that safe is not the rank but the interlock: the projection
 * refuses any extract the reconcile has not GRADED, and `DOC_FINANCIALS_APPLY`
 * ships present-and-"false".
 *
 * UNTIL that entry lands in the constant, `rankOf` ranks an unknown source LAST
 * and DOC_PDF cannot displace even Yahoo. That is a FAIL-SAFE degradation — it
 * can still fill empty cells, which is the ~821-symbol cohort this whole
 * pipeline exists for — and it is REPORTED on every run rather than inferred,
 * because "absent" and "declared" must never be the same observable state
 * (MONEY-1214).
 */

import {
  chooseAuthority,
  classifyIncomparable,
  existingDisplacement,
  reconcile,
  BALANCE_SHEET_FIELDS,
  FINANCIALS_AUTHORITY,
  INCOME_FIELDS,
  UNOWNED_VENDOR_COLUMNS,
  type DisplacementRecord,
  type FinancialsField,
  type IncomparableSide,
  type ReconcileVerdict,
} from "./xbrl-projection";

// ─── Identity ────────────────────────────────────────────────────────

/**
 * The `StockFinancials.source` value a document-derived row carries.
 *
 * A plain string, NOT a `FinancialsSource`, because that type is derived from
 * `FINANCIALS_AUTHORITY` and the constant does not carry this value yet. Typing
 * it as the union would either force the constant to change in a file this
 * change does not own, or force a cast at every use — and a cast that says
 * "trust me, this is in the list" is exactly the assertion that stops being
 * true silently.
 */
export const DOC_SOURCE = "DOC_PDF";

/**
 * WHERE a displacement record is stored on the row that displaced something.
 *
 * ## Why this reuses the XBRL writer's key instead of getting its own
 *
 * It looks wrong — `displacedByXbrl` on a row written by the PDF pipeline — and
 * it is nonetheless the only correct choice, for two independent reasons.
 *
 *  1. **`existingDisplacement()` reads exactly this key.** It is the function
 *     `planFinancialsWrite` calls to answer "has this row already been
 *     displaced?", and that answer is what makes the record write-once. Under a
 *     different key, a later XBRL write over one of OUR rows would find no
 *     prior record, build a fresh one saying "displacedSource: DOC_PDF", and
 *     the ORIGINAL vendor values — the only copy that ever existed — would be
 *     gone. The record's own `by` field already says which writer performed the
 *     displacement, so nothing is ambiguous; only the key name is inherited.
 *  2. **`planFinancialsWrite` rebuilds `rawData` from scratch** and copies
 *     forward ONLY this key. Any other key we invented would be silently
 *     erased by the next XBRL write over the same row — a second copy of the
 *     evidence that exists right up until the moment it is needed.
 *
 * The cost, stated plainly: a later XBRL write DOES destroy `rawData.doc` (our
 * extract provenance). That is the same cost the vendor's `rawData` already
 * pays today, it is recoverable from `document_financial_extracts` — which is a
 * separate table and is never rewritten — and it is strictly better than losing
 * the vendor numbers underneath.
 */
export const DOC_DISPLACEMENT_KEY = "displacedByXbrl";

/**
 * A displacement record as THIS module writes it.
 *
 * Structurally `DisplacementRecord` with `by` widened to `string`, because
 * `DisplacementRecord["by"]` is `FinancialsSource` and `"DOC_PDF"` is not a
 * member of that union yet. `FinancialsSource` extends `string`, so a record
 * read back by `existingDisplacement` assigns to this type without a cast —
 * which is the direction that matters, since the whole point is that the XBRL
 * writer and this one exchange the same object.
 */
export type DocDisplacementRecord = Omit<DisplacementRecord, "by"> & {
  by: string;
};

// ─── Authority ───────────────────────────────────────────────────────

/**
 * What the declared order currently says about `DOC_PDF`.
 *
 *   `BELOW_XBRL_ONLY`    the decided position: DOC_PDF sits immediately below
 *                        NSE_XBRL, so only an XBRL filing outranks it and it
 *                        CAN displace Tickertape, Screener and Yahoo.
 *   `PENDING_RANKS_LAST` the constant does not carry DOC_PDF, so `rankOf`
 *                        ranks it LAST. It can fill an empty cell and displace
 *                        nothing — fail-SAFE, and strictly less than decided.
 *                        Reported, never inferred: "absent" and "declared" must
 *                        not be the same observable state (MONEY-1214).
 *   `MISPLACED`          it IS in the list, somewhere nobody decided on. This
 *                        is the state that matters most, because it is the only
 *                        one that can be WORSE than intended rather than
 *                        merely weaker — a drift upward past NSE_XBRL would let
 *                        a model reading displace the company's own filing.
 */
export type DocAuthorityState =
  | "BELOW_XBRL_ONLY"
  | "PENDING_RANKS_LAST"
  | "MISPLACED";

/**
 * Read the state of {@link DOC_SOURCE} out of the ONE declared order.
 *
 * ## Why a parameter, when there is only ever one order
 *
 * So the two states are both TESTABLE. `FINANCIALS_AUTHORITY` is a module-level
 * `as const`; a test cannot mutate it, so a predicate that closed over it could
 * only ever assert whichever state the repo happens to be in today — and the
 * assertion would flip meaning the day the constant changes, which is the one
 * day it matters. Production passes the real constant and nothing else does.
 *
 * This is NOT a second copy of the ordering. It reads positions out of the
 * list; it does not restate them. The `MISPLACED` arm exists precisely so that
 * inserting DOC_PDF in the wrong place is a failing test rather than a quietly
 * different product.
 */
export function docAuthorityState(
  order: readonly string[] = FINANCIALS_AUTHORITY,
): DocAuthorityState {
  const doc = order.indexOf(DOC_SOURCE);
  if (doc === -1) return "PENDING_RANKS_LAST";
  const xbrl = order.indexOf("NSE_XBRL");
  // MONEY-1255 — SECOND: immediately below NSE_XBRL, and therefore above every
  // vendor. `NSE_XBRL` must exist for "below it" to mean anything, so an order
  // that has lost it is MISPLACED rather than accidentally satisfying this.
  //
  // Deliberately still an exact-position test rather than a range test like
  // `doc < indexOf("TICKERTAPE")`. A range would keep returning the healthy
  // state while DOC_PDF drifted anywhere in the upper half, and the whole point
  // of this predicate is that a position nobody decided on is REPORTED, not
  // tolerated.
  return xbrl !== -1 && doc === xbrl + 1 ? "BELOW_XBRL_ONLY" : "MISPLACED";
}

/** Human-readable line for a job's outcome, so the state is never inferred. */
export function describeDocAuthorityState(
  state: DocAuthorityState = docAuthorityState(),
): string {
  switch (state) {
    case "BELOW_XBRL_ONLY":
      return (
        `${DOC_SOURCE} is declared immediately below NSE_XBRL and above every ` +
        `vendor, so it CAN displace a Tickertape or Screener value`
      );
    case "PENDING_RANKS_LAST":
      return (
        `${DOC_SOURCE} is NOT in FINANCIALS_AUTHORITY, so it ranks LAST and ` +
        `can only fill an EMPTY cell — it cannot displace YAHOO. This is ` +
        `fail-safe and is less than decision D-a asks for; add it between ` +
        `SCREENER and YAHOO to complete the switchover`
      );
    case "MISPLACED":
      return (
        `${DOC_SOURCE} is in FINANCIALS_AUTHORITY but NOT immediately above ` +
        `YAHOO. Decision D-a is "above YAHOO only"; any other position lets a ` +
        `model's reading of a PDF displace a filing or a vendor`
      );
  }
}

// ─── The columns a document reading may write ────────────────────────

export type DocStatementType = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";

/**
 * The cash-flow columns, declared here because nothing else declares them.
 *
 * The XBRL projection produces INCOME and BALANCE_SHEET only — NSE's results
 * XBRL carries no cash-flow statement — so `ownedFields()` has no `CASH_FLOW`
 * arm to import. These three ARE read downstream (`stock-tabs-logic.ts` buckets
 * `CASH_FLOW` rows; the research agent's `fetch-cash-flow` tool reads them), so
 * this is real coverage rather than a column nobody looks at.
 *
 * `freeCashFlow` is INCLUDED and is deliberately NOT derived here. The vendor
 * stores all three such that `operatingCashFlow - capitalExpenditure =
 * freeCashFlow` (see `TICKERTAPE_FIELD_MAP` in
 * `packages/research/src/data-sources/db-store-logic.ts`); if a document
 * discloses only two of the three, the third stays NULL. Deriving it would put
 * a computed number in a column beside two read ones with nothing saying which
 * is which, and the derivation depends on the sign convention below being right
 * — so a convention bug would silently become a data bug.
 */
export const DOC_CASH_FLOW_FIELDS = [
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
] as const;

export type DocCashFlowField = (typeof DOC_CASH_FLOW_FIELDS)[number];
export type DocFinancialsField = FinancialsField | DocCashFlowField | "revenue";

/**
 * Columns this source writes but never READS off an extract — MONEY-1255.
 *
 * ## Why `revenue` is derived and not read
 *
 * A model reading a PDF cannot be trusted to tell us WHICH quantity it read.
 * `document_financial_extracts` carries `revenue` and `revenueFromOperations`
 * as separate columns, and which one a given row's `revenue` holds would be
 * decided by the extractor's prompt — a `promptVersion` string, not a taxonomy
 * element. Taking it directly would be asserting a convention we never
 * measured, into a vendor column of the same name, on a table whose `@@unique`
 * carries no `source`.
 *
 * Schedule III already removes the guess. It mandates "Revenue from operations"
 * and "Other income" as SEPARATE line items and states their sum as "Total
 * income" — the identity that cross-foots to the rupee on every taxonomy family
 * we carry, and the same one the F3 gate reconstructed the vendor's `revenue`
 * with on 2,529 of 4,772 comparable annual pairs. So the two COMPONENTS are
 * read (each named for exactly what it measures, with no convention to get
 * wrong) and the total is computed from them.
 *
 * ## BOTH components, or NULL. Never a partial sum
 *
 * `sumAllPresent` returns `undefined` if ANY part is missing rather than
 * treating it as zero. A total assembled from half its components is worse than
 * no total: it is plausible, it is wrong, and nothing about it says so. In this
 * specific case a partial sum would be a bare `revenueFromOperations` sitting
 * in a column that means TOTAL INCOME — the exact silent redefinition this
 * whole arrangement exists to prevent, arrived at by a different route.
 *
 * The extractor is pinned to the same contract from its side (`revenue` is not
 * a model output field), so this map is belt-and-braces. It is still enforced
 * here, because "the other side promised" is not a guard.
 */
export const DOC_DERIVED_FIELDS: Readonly<
  Record<string, { from: readonly string[]; label: string }>
> = Object.freeze({
  revenue: {
    from: ["revenueFromOperations", "otherIncome"],
    label: `Schedule III "Total income" = revenue from operations + other income`,
  },
});

/**
 * The income columns this source owns: the five whose names state what they
 * measure, plus the one derived total.
 *
 * The five are IMPORTED from `xbrl-projection`, never restated. That is not
 * tidiness: the F3 reconcile derives its field list from the same constants, so
 * a column added there is graded and written by both pipelines from that
 * commit, with no second edit to remember. The class of bug it removes is
 * documented at `FIELDS` in `scripts/data/xbrl-reconcile.ts` — four columns
 * written by the projection and never graded by the gate that authorises it,
 * while the gate's final line claimed to have graded the writer's output.
 */
export const DOC_INCOME_FIELDS: readonly DocFinancialsField[] = [
  ...INCOME_FIELDS,
  "revenue",
];

/**
 * The columns a document reading OWNS, by statement.
 */
export function docOwnedFields(
  statementType: DocStatementType,
): readonly DocFinancialsField[] {
  if (statementType === "INCOME") return DOC_INCOME_FIELDS;
  if (statementType === "BALANCE_SHEET") return BALANCE_SHEET_FIELDS;
  return DOC_CASH_FLOW_FIELDS;
}

/** Every column this source may write, across all three statements. */
export const DOC_ALL_FIELDS: readonly DocFinancialsField[] = [
  ...DOC_INCOME_FIELDS,
  ...BALANCE_SHEET_FIELDS,
  ...DOC_CASH_FLOW_FIELDS,
];

/** Which statement a column belongs to. Derived, so it cannot drift. */
export function docStatementOf(field: string): DocStatementType | null {
  if ((DOC_INCOME_FIELDS as readonly string[]).includes(field)) return "INCOME";
  if ((BALANCE_SHEET_FIELDS as readonly string[]).includes(field)) {
    return "BALANCE_SHEET";
  }
  if ((DOC_CASH_FLOW_FIELDS as readonly string[]).includes(field)) {
    return "CASH_FLOW";
  }
  return null;
}

/**
 * Vendor columns a document reading deliberately does NOT own.
 *
 * `revenue` is NOT in this list — see {@link DOC_DERIVED_FIELDS}. The XBRL
 * projection dropped it because a write DESTROYS the vendor's differently-defined
 * value on a key with no `source`; that premise does not hold for the cohort
 * this pipeline exists to serve, which has no incumbent at all, and the
 * authority ordering enforces the rest structurally — `DOC_PDF` fills an empty
 * cell or displaces YAHOO and can never reach a vendor cell. Refusing the
 * column there would have left the revenue line blank for exactly the companies
 * the pipeline is for, which is the feature failing quietly.
 *
 * The three below stay unowned, and for a reason that survives that argument:
 * their vendor-side definitions were established EMPIRICALLY, against XBRL, by
 * reconstructing one from the other over thousands of pairs. There is no
 * equivalent evidence for a PDF reading, and asserting an unmeasured convention
 * is what the whole `UNOWNED_VENDOR_COLUMNS` decision was about. The evidence is
 * carried verbatim from `xbrl-projection` rather than paraphrased, so the two
 * cannot drift; `revenue`'s entry is dropped because our reading of it is no
 * longer a different quantity from the vendor's.
 *
 * Revisit once the reconcile has produced a measured disagreement rate.
 *
 * The rule this follows is the repo's, stated in CLAUDE.md: prefer NOT-CLAIMING
 * over compensating. An unowned column is never mentioned by the patch, so the
 * incumbent value survives for the ordinary reason — not because a guard
 * remembered to protect it.
 */
export const DOC_UNOWNED_VENDOR_COLUMNS: Readonly<Record<string, string>> =
  Object.freeze({
    operatingIncome: UNOWNED_VENDOR_COLUMNS.operatingIncome as string,
    ebitda: UNOWNED_VENDOR_COLUMNS.ebitda as string,
    grossProfit:
      `no COGS line is reliably separable from an Indian P&L as filed, and the ` +
      `vendor's column is null in 100% of rows. Owning a column we can never ` +
      `fill means writing NULL into it on every row we touch`,
  });

/**
 * Conventions a reader of a verdict has to know, printed VERBATIM by the
 * reconcile rather than restated there.
 *
 * A declaration is not a suppression: every field below still scores on the
 * ordinary ladder and a `SIGN_MISMATCH` here still BLOCKS. What the
 * declaration buys is that a systematic block on one of these is read as "the
 * extractor's convention disagrees with the table's" — a one-line prompt fix —
 * instead of as a data-quality failure of the whole pipeline.
 */
export const DOC_DECLARED_CONVENTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    revenue:
      `DERIVED, never read: revenueFromOperations + otherIncome, the ` +
      `Schedule III "Total income" identity. The extract's own \`revenue\` ` +
      `column is NEVER consulted — a model cannot tell us which of the two ` +
      `quantities it read. If EITHER component is missing the column is NULL, ` +
      `because a partial sum would be a bare revenueFromOperations sitting in ` +
      `a column that means total income. See DOC_DERIVED_FIELDS`,
    capitalExpenditure:
      `stored POSITIVE in stock_financials, matching the incumbent's own ` +
      `identity operatingCashFlow - capitalExpenditure = freeCashFlow. A cash ` +
      `flow statement reports it as an OUTFLOW (negative), so an extractor ` +
      `that copies the sign off the page will score SIGN_MISMATCH on every ` +
      `single row. That is a prompt/parser bug with a one-line fix, and it is ` +
      `named here so the ladder's block is actionable rather than alarming`,
    freeCashFlow:
      `never derived by this pipeline. If the document discloses only two of ` +
      `the three cash-flow lines the third stays NULL — see DOC_CASH_FLOW_FIELDS`,
  });

// ─── The extract, as this module needs it ────────────────────────────

/**
 * One row of `document_financial_extracts`, structurally.
 *
 * Defined HERE against the Prisma model's own columns rather than imported from
 * the extractor's module. Two reasons, and the second is the load-bearing one:
 * this module must stay pure (no Prisma types), and a shape shared with the
 * WRITER would let a change on the extraction side silently redefine what the
 * projection persists. The columns are the contract; the extractor and this
 * file meet at the table.
 *
 * Every figure is `number | null | undefined` and every one of the three means
 * the same thing here — UNSOURCED. `undefined` additionally covers the MongoDB
 * case that has caused MONEY-1050 / 1205 / 1234 / 1236: a `prisma db push`
 * creates INDEXES, never FIELDS, so a column added after rows were written is
 * ABSENT on them, not null, and Prisma's Mongo connector does not treat the two
 * as the same. Nothing in this module ever filters on `null`.
 */
export interface DocumentExtractReading {
  id: string;
  documentId: string;
  instrumentId?: string | null;
  symbol: string;
  exchange: string;
  fiscalYear?: string | null;
  periodEnd: Date;
  periodType: string;
  /** CONSOLIDATED | STANDALONE. In the extract table's unique key. */
  basis: string;
  /** EXTRACTED | FAILED | FAILED_VALIDATION. Only EXTRACTED may be written. */
  status: string;
  /** Null until the reconcile has graded this row. See `requireGraded`. */
  reconcileVerdict?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  confidence?: number | null;
  scaleLabel?: string | null;
  scaleFactor?: number | null;
  extractedAt?: Date | null;

  // Income
  /**
   * NEVER READ BY THIS MODULE — see {@link DOC_DERIVED_FIELDS}.
   *
   * The column exists on the table and is typed here so a caller's row assigns
   * without a cast, but `docReadField` derives `revenue` from its two
   * Schedule III components and never consults this. The extractor is pinned to
   * the same contract from its side (it is not a model output field), so a
   * value arriving here would already be a contract violation — one that this
   * module refuses to act on rather than merely report.
   */
  revenue?: number | null;
  otherIncome?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  ebitda?: number | null;
  revenueFromOperations?: number | null;
  operatingIncomeExOtherIncome?: number | null;
  ebitdaBeforeExceptionalItems?: number | null;

  // Balance sheet
  totalAssets?: number | null;
  totalLiabilities?: number | null;
  totalEquity?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;

  // Cash flow
  operatingCashFlow?: number | null;
  capitalExpenditure?: number | null;
  freeCashFlow?: number | null;
}

/**
 * The incumbent `StockFinancials` row, structurally — no Prisma types.
 *
 * Deliberately a SUPERSET of `IncumbentFinancialsRow`: that interface predates
 * cash flow being written by anything of ours, so it carries no cash-flow
 * columns, and a displacement record built from it would record `null` for
 * three columns the row actually holds values in.
 */
export interface DocIncumbentRow {
  source?: string | null;
  fetchedAt?: Date | string | null;
  rawData?: unknown;
  basis?: string | null;

  revenue?: number | null;
  grossProfit?: number | null;
  otherIncome?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  ebitda?: number | null;
  revenueFromOperations?: number | null;
  operatingIncomeExOtherIncome?: number | null;
  ebitdaBeforeExceptionalItems?: number | null;

  totalAssets?: number | null;
  totalLiabilities?: number | null;
  totalEquity?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;

  operatingCashFlow?: number | null;
  capitalExpenditure?: number | null;
  freeCashFlow?: number | null;
}

/**
 * A finite read. `0` is a real disclosed value and is KEPT; NaN/Infinity are
 * not values a comparison or a column can use and become UNSOURCED.
 *
 * The asymmetry is deliberate and is the rule stated in the schema: `null`
 * means UNSOURCED, never zero. `ebitdaBeforeExceptionalItems = 0` is a factual
 * claim about a company that a screen would act on; `ebitdaBeforeExceptionalItems
 * = null` is the absence of one.
 */
function finite(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Sum, but ONLY when every part is present.
 *
 * Returns `undefined` if any input is missing, rather than treating a missing
 * part as zero. A total assembled from half its components is worse than no
 * total: it is plausible, it is wrong, and nothing about it says so.
 *
 * The distinction the schema draws — additive COMPONENTS may treat absence as
 * zero because that is a measurement, an OUTCOME may not because that is a
 * claim — puts this function firmly on the outcome side.
 */
function sumAllPresent(
  parts: readonly (number | undefined)[],
): number | undefined {
  let total = 0;
  for (const p of parts) {
    if (p === undefined) return undefined;
    total += p;
  }
  return Number.isFinite(total) ? total : undefined;
}

/**
 * Read ONE owned column off an extract — the single place that decides whether
 * a column is read or derived.
 *
 * ## Why every consumer goes through this
 *
 * The projector, the grader and the coverage tiebreak all need "what is our
 * value for this field", and the answer for `revenue` is NOT the extract's
 * `revenue` column. Three copies of that rule is three chances for one of them
 * to read the raw column — and the gate would then be grading a number the
 * writer never writes, which is the defect class this whole ticket family is
 * about (MONEY-1220 / 1234 / 1235).
 *
 * A derived field's raw column on the extract is NEVER consulted, even when it
 * holds a value. The extractor is pinned to the same contract from its side,
 * but "the other side promised" is not a guard.
 */
export function docReadField(
  reading: DocumentExtractReading,
  field: DocFinancialsField,
): number | undefined {
  const derived = DOC_DERIVED_FIELDS[field];
  if (derived) {
    return sumAllPresent(
      derived.from.map((part) =>
        finite(
          (reading as unknown as Record<string, unknown>)[part] as
            | number
            | null,
        ),
      ),
    );
  }
  return finite(
    (reading as unknown as Record<string, unknown>)[field] as number | null,
  );
}

// ─── Projection ──────────────────────────────────────────────────────

export interface DocProjectedStatement {
  statementType: DocStatementType;
  /**
   * Every OWNED column of this statement. A column the extract did not carry
   * is `null` — an explicit, visible absence — never `0` and never omitted.
   */
  values: Record<string, number | null>;
  /** Owned columns that came back UNSOURCED, so a null says why it is null. */
  unsourced: string[];
  /** Owned columns that carried a finite value. */
  sourced: string[];
}

/**
 * Project one extract into one statement, or `null` if there is nothing there.
 *
 * Returning `null` for an all-unsourced statement is not an optimisation. A row
 * created with every column null is indistinguishable from a row whose source
 * had nothing to say, it occupies the period's ONE slot on a table with no
 * `source` in its key, and — worst — it stamps `DOC_PDF` on a period so that a
 * later, better reading of the same document scores `UNCHANGED` against it.
 * Nothing is better than a claim to have read something.
 */
export function projectDocumentStatement(
  reading: DocumentExtractReading,
  statementType: DocStatementType,
): DocProjectedStatement | null {
  const fields = docOwnedFields(statementType);
  const values: Record<string, number | null> = {};
  const unsourced: string[] = [];
  const sourced: string[] = [];
  for (const f of fields) {
    // `docReadField`, never a direct index — `revenue` is DERIVED and its raw
    // column on the extract must never reach a `StockFinancials` row.
    const v = docReadField(reading, f);
    if (v === undefined) {
      values[f] = null;
      unsourced.push(f);
    } else {
      values[f] = v;
      sourced.push(f);
    }
  }
  return sourced.length > 0
    ? { statementType, values, unsourced, sourced }
    : null;
}

/** All three statements an extract can produce. Empty ones are dropped. */
export function projectDocumentExtract(
  reading: DocumentExtractReading,
): DocProjectedStatement[] {
  return (["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const)
    .map((t) => projectDocumentStatement(reading, t))
    .filter((s): s is DocProjectedStatement => s !== null);
}

// ─── One period, one row ─────────────────────────────────────────────

/**
 * Rank of a basis. CONSOLIDATED is the group, which is what a portfolio product
 * means by "the company" and what every vendor we sit beside reports.
 *
 * Byte-identical to `basisRank` in `xbrl-projection.ts`, which is private
 * there. It is restated rather than shared ONLY because it is not exported;
 * `docBasisRank` and that function returning different answers would make the
 * two pipelines fight over the same row, so if either ever changes they must
 * change together. Asserted by test rather than left to a comment.
 */
export function docBasisRank(basis: string | null | undefined): number {
  if (basis === "CONSOLIDATED") return 0;
  if (basis === "STANDALONE") return 1;
  return 2;
}

/**
 * Choose ONE extract for a period, out of everything we hold for it.
 *
 * `document_financial_extracts` is keyed `(documentId, periodEnd, periodType,
 * basis)`, so one period legitimately has SEVERAL rows: both bases, and one per
 * document that mentioned the period (an annual report states the prior year
 * too). `StockFinancials` has room for exactly one.
 *
 * Left alone that is last-writer-wins between numbers that differ by a MULTIPLE
 * for any holding company — and it is not even stable, because it flips with
 * whatever order the query returned, so the row can oscillate between two
 * truths on alternate nights and no run ever looks wrong. Every tie is
 * therefore broken to a TOTAL order, so the choice is a function of the
 * candidate SET and not of its order:
 *
 *   basis (CONSOLIDATED first) → confidence (higher) → coverage (more sourced
 *   columns) → extractedAt (newer) → id (lexical, the final tiebreak)
 *
 * Confidence outranks coverage on purpose: a reading the model is unsure of,
 * that happens to have filled more cells, is the worse evidence of the two.
 * `id` is last and exists so the order is total even for two rows identical in
 * every other respect — `selectFilingForPeriod` needs `sourceUrl` for exactly
 * the same reason, and its docstring says why: fetch three of four tiebreaks
 * and a tie resolves by row order, which is the instability the function exists
 * to remove.
 */
export function selectExtractForPeriod<T extends DocumentExtractReading>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestKey: [number, number, number, number, string] | null = null;
  for (const c of candidates) {
    // Counted through `docReadField` so "coverage" means the columns that would
    // actually be WRITTEN, not the columns the extract happens to hold. A
    // candidate carrying a raw `revenue` it read off the page must not win a
    // period on the strength of a value nothing will ever persist.
    const sourced = DOC_ALL_FIELDS.reduce(
      (n, f) => n + (docReadField(c, f) === undefined ? 0 : 1),
      0,
    );
    const key: [number, number, number, number, string] = [
      docBasisRank(c.basis),
      // Negated so "higher is better" sorts the same direction as the ranks.
      -(finite(c.confidence) ?? 0),
      -sourced,
      -(c.extractedAt instanceof Date &&
      Number.isFinite(c.extractedAt.getTime())
        ? c.extractedAt.getTime()
        : 0),
      c.id,
    ];
    if (bestKey === null || compareKeys(key, bestKey) < 0) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}

function compareKeys(
  a: [number, number, number, number, string],
  b: [number, number, number, number, string],
): number {
  for (let i = 0; i < 4; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av - bv;
  }
  return (a[4] as string) < (b[4] as string) ? -1 : 1;
}

// ─── Grading ─────────────────────────────────────────────────────────

/**
 * Below this many CRORES apart, two figures are the same figure.
 *
 * Identical to the F3 gate's `ABSOLUTE_EPSILON_CR` and for the identical
 * reason: everything here is in ₹ crore, the vendor rounds to two decimals of
 * one, and without a floor relative tolerance alone turns every near-zero value
 * into a coin flip (3PLAND FY2021 netIncome, −0.136 against −0.12, is 13%
 * relative on a ₹16,000 absolute gap). It is deliberately NOT a widened
 * relative tolerance — the 1% band still governs everything of material size,
 * so this cannot absorb a real 1% error on a large company.
 */
export const DOC_ABSOLUTE_EPSILON_CR = 0.5;

export interface DocFieldComparison {
  field: DocFinancialsField;
  statementType: DocStatementType;
  ours: number | undefined;
  theirs: number | undefined;
  verdict: ReconcileVerdict;
  /**
   * WHICH SIDE was empty. Populated for EVERY comparison, not just the
   * incomparable ones, so a caller cannot mis-filter and have graded pairs
   * counted as blanks — `classifyIncomparable` returns `COMPARABLE` for a pair
   * that had both, which is the value that makes that mistake visible.
   */
  side: IncomparableSide;
  relativeDiff?: number;
  scaleFactor?: number;
  /** True when the incumbent HAS a value and we do not — arming would NULL it. */
  wouldNullIncumbent: boolean;
}

/**
 * Grade one extract against the incumbent rows for its period.
 *
 * `incumbents` is keyed by statement type, because `StockFinancials` splits one
 * period across three rows and a caller holding only the INCOME row must not
 * silently grade balance-sheet columns against `undefined` — that reads as "the
 * vendor has no value" and is the exact defect the F3 gate's `select` had
 * (`totalDebt` scored `comparable 0 of 4516` while the table held 9,861 vendor
 * values for it). Pass `null` for a statement whose row genuinely does not
 * exist; pass `undefined` for one you did not fetch and this throws rather than
 * grading it.
 */
export function gradeExtract(
  reading: DocumentExtractReading,
  incumbents: Partial<Record<DocStatementType, DocIncumbentRow | null>>,
  opts?: { tolerance?: number; absoluteEpsilon?: number },
): DocFieldComparison[] {
  const out: DocFieldComparison[] = [];
  for (const statementType of [
    "INCOME",
    "BALANCE_SHEET",
    "CASH_FLOW",
  ] as const) {
    if (!(statementType in incumbents)) {
      throw new Error(
        `gradeExtract: no entry for ${statementType}. Pass null for "this row ` +
          `does not exist"; an absent key means the caller never fetched it, ` +
          `and grading that as "the incumbent has no value" is how a hardcoded ` +
          `select once printed "the vendor has nothing" for four columns the ` +
          `writer was already overwriting (MONEY-1250).`,
      );
    }
    const incumbent = incumbents[statementType] ?? null;
    for (const field of docOwnedFields(statementType)) {
      // THE GATE MUST GRADE WHAT THE WRITER WRITES. `docReadField` is the same
      // function `projectDocumentStatement` uses, so `revenue` is graded as the
      // DERIVED total and never as the extract's raw column — a second reading
      // here would measure a number that is never persisted.
      const ours = docReadField(reading, field);
      const theirs = incumbent
        ? finite((incumbent as Record<string, unknown>)[field] as number | null)
        : undefined;
      const r = reconcile(ours, theirs, {
        tolerance: opts?.tolerance ?? 0.01,
        absoluteEpsilon: opts?.absoluteEpsilon ?? DOC_ABSOLUTE_EPSILON_CR,
      });
      out.push({
        field,
        statementType,
        ours,
        theirs,
        verdict: r.verdict,
        side: classifyIncomparable({ ours, theirs }),
        ...(r.relativeDiff === undefined
          ? {}
          : { relativeDiff: r.relativeDiff }),
        ...(r.scaleFactor === undefined ? {} : { scaleFactor: r.scaleFactor }),
        wouldNullIncumbent: ours === undefined && theirs !== undefined,
      });
    }
  }
  return out;
}

/**
 * Ladder order for the ROW-LEVEL roll-up stored in
 * `DocumentFinancialExtract.reconcileVerdict`.
 *
 * The column holds ONE verdict for a row that produced up to thirteen field
 * comparisons, so the roll-up rule has to be declared rather than implied by
 * the order three `if`s happen to be written in.
 *
 * WORST WINS, and the two ends are the interesting ones:
 *
 *   SCALE_MISMATCH  a units bug. One occurrence implies a whole class of
 *   SIGN_MISMATCH   periods is wrong, so neither is a rate contributor.
 *   DISAGREEMENT    materially different and not explained by either.
 *   MATCH           ranks ABOVE incomparable: "at least one field agreed"
 *                   is evidence, and "nothing was comparable" is not.
 *   INCOMPARABLE    nothing on either side to compare. This is the verdict the
 *                   ~821-symbol no-coverage cohort gets, and it MUST NOT block
 *                   — those rows are the entire point of the pipeline.
 */
export const DOC_VERDICT_SEVERITY: readonly ReconcileVerdict[] = [
  "SCALE_MISMATCH",
  "SIGN_MISMATCH",
  "DISAGREEMENT",
  "MATCH",
  "INCOMPARABLE",
];

export function rollUpVerdict(
  comparisons: readonly { verdict: ReconcileVerdict }[],
): ReconcileVerdict {
  const seen = new Set(comparisons.map((c) => c.verdict));
  for (const v of DOC_VERDICT_SEVERITY) if (seen.has(v)) return v;
  // No comparisons at all. Not "everything agreed" — nothing was looked at.
  return "INCOMPARABLE";
}

/**
 * Roll-ups that must NOT be written into `stock_financials`.
 *
 * All three mean an INDEPENDENT reading of the same period contradicts this
 * one. The asymmetry that makes blocking cheap: `DOC_PDF` sits at the bottom of
 * the authority order, so the only rows it can reach are empty cells (which
 * grade INCOMPARABLE and are never blocked) and YAHOO rows. Blocking therefore
 * costs at most one row that keeps a Yahoo number; writing costs a value that
 * cannot be recovered, on a table with no `source` in its unique key.
 *
 * `DISAGREEMENT` is in the set today and is the one most likely to come OUT
 * later — once the reconcile has produced a disagreement rate low enough to
 * argue from. That is a founder decision with evidence attached, not a
 * threshold to loosen when the counter looks inconvenient.
 */
export const DOC_BLOCKING_VERDICTS: ReadonlySet<string> = new Set([
  "SCALE_MISMATCH",
  "SIGN_MISMATCH",
  "DISAGREEMENT",
]);

// ─── The write plan ──────────────────────────────────────────────────

export type DocWriteAction = "CREATE" | "UPDATE" | "SKIP";

/**
 * WHY a plan skipped, as a value rather than as prose.
 *
 * Every one of these has its own counter in the worker. Matching on `reason`
 * text instead would silently reclassify a skip the day somebody rewords a
 * message — and the reclassification lands in whichever bucket the match falls
 * through to, which is how a 29.5% policy outcome once wore the label of a case
 * that is structurally impossible.
 */
export type DocSkipReason =
  /** A strictly higher-ranked source already owns the row. */
  | "AUTHORITY"
  /** We own it, our numbers are already there, from this same extract. */
  | "UNCHANGED"
  /** Our own CONSOLIDATED-derived row would be rewritten with STANDALONE. */
  | "BASIS_DOWNGRADE"
  /** A non-consolidated reading may not displace another source's row. */
  | "STANDALONE_NO_DISPLACE"
  /** The extract is not `EXTRACTED` — a failed or invalid parse. */
  | "NOT_EXTRACTED"
  /** The reconcile has not graded this row yet. */
  | "NOT_GRADED"
  /** The reconcile graded it and the verdict blocks. */
  | "VERDICT_BLOCKS"
  /** Nothing sourced for this statement — see `projectDocumentStatement`. */
  | "NO_VALUES";

export interface DocProjectionRawData {
  doc: {
    extract: {
      extractId: string;
      documentId: string;
      periodEnd: string;
      periodType: string;
      basis: string;
      fiscalYear?: string;
      /**
       * WHICH (model, prompt) produced this. Both are required to interpret a
       * disagreement later — a systematic error is a property of the PAIR, and
       * without them a re-parse cannot be compared against its predecessor.
       */
      model?: string;
      promptVersion?: string;
      confidence?: number;
      /** What the document DECLARED, and the factor applied to reach crores. */
      scaleLabel?: string;
      scaleFactor?: number;
      /** The roll-up this write was authorised under. */
      reconcileVerdict?: string;
    };
    /** Exactly the columns written, so a null is auditable against the source. */
    projected: DocProjectedStatement;
  };
  /** Present only when this row displaced another source. See the key's doc. */
  displacedByXbrl?: DocDisplacementRecord;
}

export interface DocWritePlan {
  action: DocWriteAction;
  /** Set exactly when `action === "SKIP"`. A SKIP with no reason is unauditable. */
  skipReason?: DocSkipReason;
  /** Always populated. */
  reason: string;
  /** Column patch. Owned columns the extract did not source are explicit nulls. */
  values?: Record<string, number | null>;
  source?: string;
  rawData?: DocProjectionRawData;
  /** Non-null only on the write that actually displaced another source. */
  displaced?: DocDisplacementRecord | null;
}

/** Owned columns of the incumbent, normalised. Absent and NaN both become null. */
function incumbentValues(
  row: DocIncumbentRow,
  fields: readonly DocFinancialsField[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of fields) {
    out[f] =
      finite((row as Record<string, unknown>)[f] as number | null) ?? null;
  }
  return out;
}

function sameValues(
  a: Record<string, number | null>,
  b: Record<string, number | null>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

/**
 * The extract provenance already stored on a row, as SCALARS.
 *
 * Deliberately NOT a deep comparison of the stored blob against a freshly built
 * one: an object that has round-tripped through Mongo does not preserve our key
 * order, so `JSON.stringify` equality would differ every run in production
 * while matching perfectly against an injected test store. That is the
 * green-in-test-churns-in-prod shape.
 */
function storedExtract(
  rawData: unknown,
): Partial<DocProjectionRawData["doc"]["extract"]> | null {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return null;
  }
  const d = (rawData as Record<string, unknown>).doc;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const e = (d as Record<string, unknown>).extract;
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  return e as Partial<DocProjectionRawData["doc"]["extract"]>;
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (d instanceof Date) {
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof d === "string" && d.trim() !== "") return d;
  return null;
}

/**
 * Decide what a document-derived write does to one `StockFinancials` row.
 *
 * ## The gates, in the order they are applied, and why the order is that
 *
 *  1. **Not `EXTRACTED`** → SKIP. A `FAILED_VALIDATION` row means the model
 *     answered and the answer failed our own arithmetic; it is a prompt signal,
 *     never a number.
 *  2. **Not graded** → SKIP, when `requireGraded` (default TRUE). This is the
 *     F3 discipline applied one source down: the table has no `source` in its
 *     unique key, so the comparison has to happen BEFORE the write or it cannot
 *     happen at all.
 *  3. **Graded and blocking** → SKIP. See {@link DOC_BLOCKING_VERDICTS}.
 *  4. **Authority** → `chooseAuthority`, which is the ONE declared order. This
 *     function never second-guesses it and never restates it.
 *  5. **Basis**, two guards, deliberately asymmetric — the same pair
 *     `planFinancialsWrite` carries, and for the same reason: a company files
 *     BOTH bases for one period and they differ by a MULTIPLE for any holding
 *     company (360ONE FY2025 total assets, 19,768 Cr consolidated against
 *     7,332 Cr standalone).
 *  6. **CREATE**, and it sits BELOW the basis guards on purpose. With no
 *     incumbent every check above is provably inert, so the position changes no
 *     outcome today. What it buys is that the next guard added above cannot be
 *     bypassed by a row that happens not to exist yet — and here that is not
 *     hypothetical: ~821 symbols hold zero rows, so CREATE is the MAJORITY
 *     path, and a guard the majority path skips is not a guard. (This is the
 *     MONEY-1238 reorder, adopted rather than rediscovered.)
 *  7. **UNCHANGED** → SKIP, so the job is a fixpoint: run it twice and the
 *     second run touches nothing, which is also what keeps `updatedAt`
 *     meaningful.
 */
export function planDocumentFinancialsWrite(opts: {
  reading: DocumentExtractReading;
  statement: DocProjectedStatement;
  incumbent: DocIncumbentRow | null;
  now: Date;
  /**
   * Refuse an extract the reconcile has not graded. DEFAULT TRUE, and the
   * worker does not expose a way to turn it off — loosening it is a deploy,
   * which is a review.
   */
  requireGraded?: boolean;
  /** Overridable for tests only; production passes nothing. */
  blockingVerdicts?: ReadonlySet<string>;
  /** Overridable for tests only; production passes nothing. */
  source?: string;
}): DocWritePlan {
  const {
    reading,
    statement,
    incumbent,
    now,
    requireGraded = true,
    blockingVerdicts = DOC_BLOCKING_VERDICTS,
    source = DOC_SOURCE,
  } = opts;

  if (reading.status !== "EXTRACTED") {
    return {
      action: "SKIP",
      skipReason: "NOT_EXTRACTED",
      reason: `extract status is ${String(reading.status)}, not EXTRACTED`,
    };
  }

  if (statement.sourced.length === 0) {
    return {
      action: "SKIP",
      skipReason: "NO_VALUES",
      reason: `no owned column of ${statement.statementType} was sourced`,
    };
  }

  const verdict = reading.reconcileVerdict ?? null;
  if (requireGraded && verdict === null) {
    return {
      action: "SKIP",
      skipReason: "NOT_GRADED",
      reason:
        `not yet graded by the reconcile. stock_financials has no \`source\` ` +
        `in its unique key, so the comparison cannot be made after the write`,
    };
  }
  if (verdict !== null && blockingVerdicts.has(verdict)) {
    return {
      action: "SKIP",
      skipReason: "VERDICT_BLOCKS",
      reason: `reconcile verdict ${verdict} blocks the write`,
    };
  }

  const fields = docOwnedFields(statement.statementType);
  const values = statement.values;

  const rawData: DocProjectionRawData = {
    doc: {
      extract: {
        extractId: reading.id,
        documentId: reading.documentId,
        periodEnd: reading.periodEnd.toISOString(),
        periodType: reading.periodType,
        basis: reading.basis,
        ...(reading.fiscalYear ? { fiscalYear: reading.fiscalYear } : {}),
        ...(reading.model ? { model: reading.model } : {}),
        ...(reading.promptVersion
          ? { promptVersion: reading.promptVersion }
          : {}),
        ...(finite(reading.confidence) === undefined
          ? {}
          : { confidence: finite(reading.confidence) as number }),
        ...(reading.scaleLabel ? { scaleLabel: reading.scaleLabel } : {}),
        ...(finite(reading.scaleFactor) === undefined
          ? {}
          : { scaleFactor: finite(reading.scaleFactor) as number }),
        ...(verdict === null ? {} : { reconcileVerdict: verdict }),
      },
      projected: statement,
    },
  };

  const decision = chooseAuthority(source, incumbent?.source ?? null);
  if (decision.keepIncumbent) {
    return {
      action: "SKIP",
      skipReason: "AUTHORITY",
      reason:
        `incumbent source ${String(incumbent?.source)} outranks ${source} in ` +
        `FINANCIALS_AUTHORITY`,
    };
  }

  // `chooseAuthority` returns the incumbent as `displaced` on an EQUAL-rank
  // refresh too. A source replacing itself has displaced nothing.
  const isRefresh = decision.displaced === source;
  const prior = existingDisplacement(incumbent?.rawData);
  const stored = storedExtract(incumbent?.rawData);
  const ourBasis = docBasisRank(reading.basis);
  // `rawData` provenance FIRST, the `basis` COLUMN second. The column is ABSENT
  // — not null — on every row written before it existed, so a guard keyed on it
  // alone would be inert for exactly the population it protects.
  const incumbentBasis = stored?.basis ?? incumbent?.basis ?? null;

  if (isRefresh) {
    // A row of OURS carrying no basis evidence at all is deliberately left
    // writable: freezing it would be permanent, and "unknown" is not evidence
    // of a better basis. The column is consulted before we conclude we know
    // nothing.
    if (incumbentBasis !== null && ourBasis > docBasisRank(incumbentBasis)) {
      return {
        action: "SKIP",
        skipReason: "BASIS_DOWNGRADE",
        reason:
          `this row was projected from a ${String(incumbentBasis)} extract; ` +
          `${String(reading.basis)} would be a downgrade`,
      };
    }
  } else if (
    decision.displaced !== null &&
    ourBasis > docBasisRank("CONSOLIDATED")
  ) {
    // Anything not CONSOLIDATED, not just STANDALONE: an unrecognised basis
    // ranks below standalone and has even less claim to replace a row we can
    // still see. A non-consolidated reading may still CREATE where no row
    // exists — standalone beats nothing.
    return {
      action: "SKIP",
      skipReason: "STANDALONE_NO_DISPLACE",
      reason:
        `a ${String(reading.basis)} extract may not displace ` +
        `${String(decision.displaced)}, which reports the group`,
    };
  }

  if (incumbent === null) {
    return {
      action: "CREATE",
      reason: "no incumbent row for this period",
      values,
      source,
      rawData,
      displaced: null,
    };
  }

  const displaced: DocDisplacementRecord | null =
    isRefresh || decision.displaced === null
      ? null
      : {
          displacedSource: decision.displaced,
          by: source,
          displacedAt: now.toISOString(),
          // EVERY owned column of this statement, nulls included, so a restore
          // is complete rather than partial.
          values: incumbentValues(incumbent, fields),
          fetchedAt: isoOrNull(incumbent.fetchedAt),
          rawData: incumbent.rawData ?? null,
        };

  // FIRST DISPLACEMENT WINS. A later one would be recording the state THIS
  // writer created and would overwrite the only copy of what was there before.
  // `prior` may have been written by the XBRL projection or by this module —
  // same key, same shape, deliberately (see DOC_DISPLACEMENT_KEY).
  const keep = prior ?? displaced;
  if (keep) rawData.displacedByXbrl = keep;

  // "Already current" needs all three: our stamp, our numbers, and OUR extract.
  // Source alone is not enough — a row we wrote from a document that has since
  // been re-parsed under a better prompt would otherwise keep the superseded
  // provenance forever, and the numbers can be identical across a re-parse.
  const unchanged =
    incumbent.source === source &&
    sameValues(incumbentValues(incumbent, fields), values) &&
    stored !== null &&
    stored.extractId === reading.id &&
    stored.basis === reading.basis &&
    stored.periodEnd === reading.periodEnd.toISOString();
  if (unchanged) {
    return {
      action: "SKIP",
      skipReason: "UNCHANGED",
      reason: "already current — nothing would change",
    };
  }

  return {
    action: "UPDATE",
    reason: isRefresh
      ? "refreshing our own earlier projection"
      : `displacing ${String(decision.displaced)}`,
    values,
    source,
    rawData,
    displaced,
  };
}

// ─── The reconcile's census ──────────────────────────────────────────

/**
 * What a field's comparisons amounted to — and, critically, what they COULD
 * have amounted to.
 *
 * ## The ceiling, and the failure mode it is designed against
 *
 * A reconcile that compares ZERO rows and prints "no disagreements" is the
 * shape this whole family of tickets keeps rediscovering: MONEY-1220 (a job
 * returning 200 and writing nothing for five months), MONEY-1196 (a denominator
 * quietly draining until 60% read as 3.0%), MONEY-1250 (`totalDebt` scoring
 * `comparable 0 of 4516` because the `select` never asked for it, while the
 * table held 9,861 vendor values).
 *
 * A count alone cannot distinguish those. THREE numbers can, and they nest:
 *
 *   examined  every (extract, field) pair the run looked at
 *   joinable  those where an incumbent ROW existed for the period at all —
 *             the JOIN ceiling. `joinable === 0` with `examined > 0` is the
 *             signature of a period-LABEL bug, not of an empty table: it means
 *             we addressed rows that do not exist under the name we derived.
 *   comparable  those where BOTH sides carried a finite value — the only base
 *             a rate may use.
 *
 * Reporting `comparable X of joinable Y of examined Z` makes each zero say
 * something different, which is the entire ask. A single "compared N" cannot.
 */
export interface DocFieldCensus {
  field: DocFinancialsField;
  statementType: DocStatementType;
  examined: number;
  joinable: number;
  comparable: number;
  matched: number;
  disagreements: number;
  scaleMismatches: number;
  signMismatches: number;
  incomparable: number;
  /** Incomparable, split by WHICH side was empty. Never one folded number. */
  oursBlank: number;
  theirsBlank: number;
  bothBlank: number;
  /** Comparisons where arming would replace a populated cell with NULL. */
  wouldNullIncumbent: number;
}

export function emptyFieldCensus(
  field: DocFinancialsField,
  statementType: DocStatementType,
): DocFieldCensus {
  return {
    field,
    statementType,
    examined: 0,
    joinable: 0,
    comparable: 0,
    matched: 0,
    disagreements: 0,
    scaleMismatches: 0,
    signMismatches: 0,
    incomparable: 0,
    oursBlank: 0,
    theirsBlank: 0,
    bothBlank: 0,
    wouldNullIncumbent: 0,
  };
}

/**
 * Fold one comparison into a field's census.
 *
 * `joinable` is passed IN rather than inferred from `theirs !== undefined`,
 * and the distinction is the point of the whole structure: a row that exists
 * with a null column is JOINABLE and not comparable, while a row that does not
 * exist is neither. Inferring it from the value would collapse "the vendor has
 * no value for this column" into "we could not find the row" — the two readings
 * that this census exists to keep apart.
 */
export function foldComparison(
  census: DocFieldCensus,
  c: DocFieldComparison,
  incumbentRowExists: boolean,
): void {
  census.examined++;
  if (incumbentRowExists) census.joinable++;
  if (c.wouldNullIncumbent) census.wouldNullIncumbent++;
  switch (c.verdict) {
    case "MATCH":
      census.matched++;
      census.comparable++;
      break;
    case "DISAGREEMENT":
      census.disagreements++;
      census.comparable++;
      break;
    case "SCALE_MISMATCH":
      census.scaleMismatches++;
      census.comparable++;
      break;
    case "SIGN_MISMATCH":
      census.signMismatches++;
      census.comparable++;
      break;
    case "INCOMPARABLE":
      census.incomparable++;
      if (c.side === "OURS_BLANK") census.oursBlank++;
      else if (c.side === "THEIRS_BLANK") census.theirsBlank++;
      else if (c.side === "BOTH_BLANK") census.bothBlank++;
      break;
  }
}

/**
 * Whether a run produced enough evidence to be a statement about anything.
 *
 * ## Why this is a FLOOR and not a verdict
 *
 * `judgeSwitchoverReadiness` already decides readiness per field and refuses a
 * vacuous READY. What it cannot see is the run itself: a script whose query
 * matched nothing, whose join addressed rows under the wrong label, or whose
 * `select` omitted the columns, produces a perfectly well-formed report full of
 * zeros — and zeros read as "no disagreements".
 *
 * So the floor is checked ONCE, over the whole run, before any field verdict is
 * believed, and each failure names a DIFFERENT cause:
 *
 *   `NO_EXTRACTS`      nothing matched. The extractor has not run.
 *   `NO_JOIN`          extracts were graded and not ONE addressed an existing
 *                      incumbent row. Either the period-label derivation is
 *                      wrong (which would make every write a CREATE — the
 *                      signature `createMissing:false` exists to catch) or this
 *                      cohort genuinely has no coverage, which is a claim the
 *                      caller must make EXPLICITLY rather than have inferred.
 *   `BELOW_FLOOR`      the join worked and too few pairs were comparable to
 *                      judge anything.
 *   `OK`               enough to read the ladder.
 */
export type DocCeilingVerdict =
  | "OK"
  | "NO_EXTRACTS"
  | "NO_JOIN"
  | "BELOW_FLOOR";

export interface DocCeilingCheck {
  verdict: DocCeilingVerdict;
  reason: string;
  extracts: number;
  examined: number;
  joinable: number;
  comparable: number;
  floor: number;
}

/** Default floor, matching `judgeSwitchoverReadiness`'s `minComparable`. */
export const DOC_MIN_COMPARABLE = 20;

export function judgeDocCeiling(args: {
  extracts: number;
  census: readonly DocFieldCensus[];
  minComparable?: number;
  /**
   * The caller asserts, deliberately, that this population is expected to have
   * NO incumbent rows — the zero-coverage cohort. Turns `NO_JOIN` from a
   * failure into `OK`, and nothing else. It exists so "we are creating rows for
   * symbols that have none" is something a run has to SAY rather than something
   * a reader has to assume from a zero.
   */
  expectNoIncumbents?: boolean;
}): DocCeilingCheck {
  const floor = args.minComparable ?? DOC_MIN_COMPARABLE;
  const examined = args.census.reduce((n, c) => n + c.examined, 0);
  const joinable = args.census.reduce((n, c) => n + c.joinable, 0);
  const comparable = args.census.reduce((n, c) => n + c.comparable, 0);
  const base = {
    extracts: args.extracts,
    examined,
    joinable,
    comparable,
    floor,
  };

  if (args.extracts === 0 || examined === 0) {
    return {
      ...base,
      verdict: "NO_EXTRACTS",
      reason:
        `no extract rows were graded. This is NOT a passing reconciliation — ` +
        `it means there is nothing to reconcile. Run the extraction job first`,
    };
  }
  if (joinable === 0) {
    return {
      ...base,
      verdict: args.expectNoIncumbents ? "OK" : "NO_JOIN",
      reason: args.expectNoIncumbents
        ? `${examined} pair(s) examined, none joinable — asserted by ` +
          `--expect-no-incumbents, so this is the zero-coverage cohort and ` +
          `every write would be a CREATE`
        : `${examined} pair(s) examined and NOT ONE addressed an existing ` +
          `stock_financials row. Either the period-label derivation addresses ` +
          `rows that do not exist (every write would then be a CREATE, which ` +
          `is exactly what a join bug looks like) or this cohort has no ` +
          `coverage at all. Re-run with --expect-no-incumbents to assert the ` +
          `second reading deliberately`,
    };
  }
  if (comparable < floor) {
    return {
      ...base,
      verdict: "BELOW_FLOOR",
      reason:
        `only ${comparable} COMPARABLE pair(s) out of ${examined} examined ` +
        `(${joinable} joinable); need at least ${floor} before any field ` +
        `verdict means anything`,
    };
  }
  return {
    ...base,
    verdict: "OK",
    reason:
      `${comparable} comparable of ${joinable} joinable of ${examined} ` +
      `examined, across ${args.extracts} extract(s)`,
  };
}
