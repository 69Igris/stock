/**
 * The pure half of the Gemini PDF financials extractor — MONEY-1255.
 *
 * Every symbol here is the REAL export the worker calls
 * (`packages/core/src/market-data/document-financials-logic.ts`). No shadow
 * copies: the processor imports these same functions, so a mutation to the
 * source has to show up here.
 *
 * The suite is organised around what can go WRONG, not around what the
 * functions are named:
 *
 *   - scale, including a wrong and a missing declared scale
 *   - non-finite poisoning that `?? 0` cannot catch
 *   - every validation verdict
 *   - the LIMITS of each cross-check, asserted as tests so nobody later cites a
 *     symmetric identity as if it proved something it cannot
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DOCUMENT_FINANCIALS_SCHEMA,
  DOC_FINANCIALS_PROMPT_VERSION,
  BALANCE_ABS_TOLERANCE_CRORE,
  BALANCE_REL_TOLERANCE,
  MAX_PLAUSIBLE_CRORE,
  SCALE_FACTOR_TO_CRORE,
  SCALE_IDENTITY_REL_TOLERANCE,
  buildExtractWritePayload,
  applyScale,
  buildDocumentFinancialsPrompt,
  hasNonFiniteRawFigure,
  isDocFinancialsApplyArmed,
  isPeriodEndInRange,
  mapDocumentFinancials,
  type ScaleUnit,
  mapPeriodExtract,
  parsePeriodEnd,
  resolveScale,
  normaliseCapexSign,
  statementHasFigure,
  unscaled,
  type DocResponseSchema,
  type RawPeriodExtract,
} from "../../src/market-data/document-financials-logic";
// The projection agent owns WHICH columns this reader must not emit. Imported
// rather than restated: two independent encodings of one rule is the stale-copy
// drift this repo keeps paying for. Wired in the TEST only — the projection
// module does not import this one today, but it plausibly will (it consumes
// `MappedExtract`), and a production import here would make that a cycle.
import {
  DOC_DERIVED_FIELDS,
  DOC_UNOWNED_VENDOR_COLUMNS,
} from "../../src/market-data/document-financials-projection";

// ══════════════════════════════════════════════════════════════════════
// Helpers — a period that PASSES every check, so each test can break
// exactly one thing and attribute the failure to it.
// ══════════════════════════════════════════════════════════════════════

/** A clean consolidated FY2025 reading, stated in crore. */
function goodPeriod(over: Partial<RawPeriodExtract> = {}): RawPeriodExtract {
  return {
    fiscalYear: "FY2024-25",
    periodEnd: "2025-03-31",
    periodType: "ANNUAL",
    basis: "CONSOLIDATED",
    scale: {
      incomeStatement: "₹ in Crore",
      balanceSheet: "₹ in Crore",
      cashFlow: "₹ in Crore",
    },
    pageRefs: { incomeStatement: [112], balanceSheet: [114], cashFlow: [116] },
    incomeStatement: {
      revenueFromOperations: 1000,
      otherIncome: 50,
      totalIncome: 1050,
      netIncome: 120,
      eps: 12,
    },
    balanceSheet: {
      totalAssets: 2000,
      totalLiabilities: 1200,
      totalEquity: 800,
      paidUpCapital: 100,
      faceValue: 10,
      sharesOutstanding: 100_000_000,
    },
    cashFlow: { operatingCashFlow: 200, capitalExpenditure: 60 },
    lines: [],
    confidence: 0.9,
    ...over,
  };
}

/** Collect every `properties` key name anywhere in a schema tree. */
function schemaPropertyNames(node: DocResponseSchema, out = new Set<string>()) {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    out.add(key);
    schemaPropertyNames(child, out);
  }
  if (node.items) schemaPropertyNames(node.items, out);
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// THE RESPONSE SCHEMA
// ══════════════════════════════════════════════════════════════════════

describe("the response schema asks for everything the row needs", () => {
  const names = schemaPropertyNames(DOCUMENT_FINANCIALS_SCHEMA);

  it("FALSIFIABLE CEILING: the walk actually found a schema", () => {
    // Without this, every subset assertion below passes vacuously against an
    // empty set — a silent empty result reads as success.
    assert.ok(
      names.size > 25,
      `schema walk found only ${names.size} property names — the walk is broken, not the schema`,
    );
    assert.equal(DOCUMENT_FINANCIALS_SCHEMA.type, "OBJECT");
  });

  it("asks for EVERY period, BOTH bases, and the period end", () => {
    const periods = DOCUMENT_FINANCIALS_SCHEMA.properties?.["periods"];
    assert.equal(periods?.type, "ARRAY");
    const item = periods?.items;
    assert.ok(item, "periods.items must be declared or the array is untyped");
    // MONEY-1332 widened this from the four identity fields to include the
    // three statement OBJECTS. Kept as an exact deepEqual rather than relaxed
    // to `includes`: this list is the contract with the model, and a test that
    // only checks membership would not notice a field QUIETLY ADDED to it —
    // which is the direction that risks manufacturing data, since anything
    // required here must be produced whether or not the document states it.
    assert.deepEqual(item.required, [
      "fiscalYear",
      "periodEnd",
      "periodType",
      "basis",
      "incomeStatement",
      "balanceSheet",
      "cashFlow",
    ]);
    assert.deepEqual(item.properties?.["basis"]?.enum, [
      "CONSOLIDATED",
      "STANDALONE",
    ]);
    assert.deepEqual(item.properties?.["periodType"]?.enum, [
      "ANNUAL",
      "QUARTERLY",
    ]);
  });

  it("asks for the declared scale and page citations PER STATEMENT", () => {
    const item = DOCUMENT_FINANCIALS_SCHEMA.properties?.["periods"]?.items;
    for (const group of ["scale", "pageRefs"] as const) {
      const props = item?.properties?.[group]?.properties ?? {};
      assert.deepEqual(
        Object.keys(props).sort(),
        ["balanceSheet", "cashFlow", "incomeStatement"],
        `${group} must be per-statement — a report switches units between statements`,
      );
    }
  });

  it("asks for the line items behind each total", () => {
    const item = DOCUMENT_FINANCIALS_SCHEMA.properties?.["periods"]?.items;
    const lines = item?.properties?.["lines"];
    assert.equal(lines?.type, "ARRAY");
    assert.deepEqual(lines?.items?.required, ["statement", "label", "value"]);
  });

  it("asks for no column the projection DERIVES or leaves UNOWNED", () => {
    // Both lists come from the projection module, so a column moving category
    // there moves here in the same commit. `revenue` is derived (Schedule III
    // total income = the two components); operatingIncome / ebitda /
    // grossProfit are unowned because their vendor-side conventions were
    // established empirically against XBRL and there is no equivalent evidence
    // for a PDF reading.
    const banned = [
      ...Object.keys(DOC_DERIVED_FIELDS),
      ...Object.keys(DOC_UNOWNED_VENDOR_COLUMNS),
    ];
    assert.ok(
      banned.length >= 4 && banned.includes("revenue"),
      `CEILING: the imported rule lists look empty (${banned.join(",")}) — the test would assert nothing`,
    );
    for (const field of banned) {
      assert.equal(
        names.has(field),
        false,
        `"${field}" must not be a field the model fills`,
      );
    }
    for (const required of [
      "revenueFromOperations",
      "otherIncome",
      "totalIncome",
      "operatingIncomeExOtherIncome",
      "ebitdaBeforeExceptionalItems",
    ]) {
      assert.ok(names.has(required), `"${required}" must be in the schema`);
    }
  });

  it("the prompt names the three Schedule III rows and forbids inventing a total", () => {
    const prompt = buildDocumentFinancialsPrompt({
      symbol: "RELIANCE",
      docType: "annual_report",
      period: "2025",
    });
    assert.match(prompt, /revenueFromOperations/);
    assert.match(prompt, /otherIncome/);
    assert.match(prompt, /totalIncome/);
    assert.match(prompt, /never add the components together/i);
    assert.match(prompt, /RELIANCE/);
  });

  it("stamps a prompt version, because a systematic error belongs to the pair", () => {
    assert.equal(typeof DOC_FINANCIALS_PROMPT_VERSION, "string");
    assert.ok(DOC_FINANCIALS_PROMPT_VERSION.length > 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCALE
// ══════════════════════════════════════════════════════════════════════

describe("scale normalisation to crores", () => {
  it("maps every declared magnitude to the right factor", () => {
    // Literal expected values, NOT read back out of SCALE_FACTOR_TO_CRORE —
    // deriving the expectation from the table under test makes the table
    // unfalsifiable (change 0.01 to 0.1 and a self-referential test stays
    // green).
    const cases: Array<[string, number]> = [
      ["₹ in Crore", 1],
      ["(Rs. in Crores)", 1],
      ["₹ in Lakhs", 0.01],
      ["Rs. in Lacs", 0.01],
      ["₹ in Million", 0.1],
      ["Amounts in Rs. Mn", 0.1],
      ["₹ in Billion", 100],
      ["(Rs. in '000s)", 1e-4],
      ["Figures in thousands", 1e-4],
      ["Amount in Rupees", 1e-7],
    ];
    for (const [label, factor] of cases) {
      const r = resolveScale(label);
      assert.equal(r.resolved, true, `"${label}" should resolve`);
      assert.equal(r.scaleFactor, factor, `"${label}" → ${factor}`);
      assert.equal(r.scaleLabel, label.trim(), "verbatim label is preserved");
    }
  });

  it("a MAGNITUDE word beats a bare currency word", () => {
    // "Rupees in Lakhs" contains BOTH an absolute marker ("rupees") and a
    // magnitude ("lakhs"). Consulting the absolute table first would resolve it
    // to 1e-7 instead of 0.01 — a 1e5 error on every figure in the statement.
    const r = resolveScale("Rupees in Lakhs");
    assert.equal(r.scaleUnit, "LAKH");
    assert.equal(r.scaleFactor, 0.01);
  });

  it("an UNRECOGNISED label does not silently become crores", () => {
    // The single most expensive assumption available here. A statement printed
    // in lakhs but read as crores is 100x too big, internally consistent, and
    // passes every other check in the module.
    for (const label of ["figures in gazillions", "see note 3", "₹"]) {
      const r = resolveScale(label);
      assert.equal(r.resolved, false, `"${label}" must not resolve`);
      assert.equal(r.scaleFactor, null);
      assert.equal(r.scaleUnit, null);
      assert.equal(r.scaleLabel, label, "the raw label is still recorded");
    }
  });

  it("a MISSING label resolves to nothing, with a null label", () => {
    for (const label of [null, undefined, "", "   "]) {
      const r = resolveScale(label);
      assert.equal(r.resolved, false);
      assert.equal(r.scaleFactor, null);
      assert.equal(r.scaleLabel, null);
    }
  });

  it("the factor table is internally consistent with rupee arithmetic", () => {
    // 1 crore = 1e7 rupees. Each factor must be (unit in rupees) / 1e7.
    // Keyed by ScaleUnit rather than `string`: `keyof typeof rupees` is what
    // indexes SCALE_FACTOR_TO_CRORE below, and a `string` key cannot index a
    // Record<ScaleUnit, number>. Typing it this way also makes the fixture
    // EXHAUSTIVE — a new ScaleUnit fails to compile here until it is covered.
    const rupees: Record<ScaleUnit, number> = {
      UNIT: 1,
      THOUSAND: 1e3,
      LAKH: 1e5,
      MILLION: 1e6,
      CRORE: 1e7,
      BILLION: 1e9,
      TRILLION: 1e12,
    };
    for (const [unit, inRupees] of Object.entries(rupees)) {
      const factor = SCALE_FACTOR_TO_CRORE[unit as keyof typeof rupees];
      assert.ok(
        Math.abs(factor - inRupees / 1e7) < 1e-12,
        `${unit}: ${factor} !== ${inRupees}/1e7`,
      );
    }
  });

  it("applyScale returns NULL — never NaN, never 0 — for bad input", () => {
    assert.equal(applyScale(NaN, 1), null);
    assert.equal(applyScale(Infinity, 1), null);
    assert.equal(applyScale(-Infinity, 1), null);
    assert.equal(applyScale(null, 1), null);
    assert.equal(applyScale("100", 1), null);
    assert.equal(applyScale(100, null), null, "no factor → no figure");
    assert.equal(applyScale(100, NaN), null);
    assert.equal(applyScale(250000, 0.01), 2500);
  });

  it("unscaled passes finite numbers and rejects everything else", () => {
    assert.equal(unscaled(10), 10);
    assert.equal(unscaled(0), 0);
    assert.equal(unscaled(NaN), null);
    assert.equal(unscaled(Infinity), null);
    assert.equal(unscaled("10"), null);
    assert.equal(unscaled(null), null);
  });

  it("APPLIES the factor and records BOTH the label and the factor", () => {
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "₹ in Lakhs",
          balanceSheet: "₹ in Lakhs",
          cashFlow: "₹ in Lakhs",
        },
        incomeStatement: {
          revenueFromOperations: 100_000, // 1,00,000 lakh = 1,000 Cr
          otherIncome: 5_000,
          totalIncome: 105_000,
          netIncome: 12_000,
          eps: 12,
        },
        balanceSheet: {
          totalAssets: 200_000,
          totalLiabilities: 120_000,
          totalEquity: 80_000,
          paidUpCapital: 10_000,
          faceValue: 10,
          sharesOutstanding: 100_000_000,
        },
        cashFlow: { operatingCashFlow: 20_000, capitalExpenditure: 6_000 },
      }),
    );
    assert.ok(row);
    assert.equal(verdict.status, "EXTRACTED", verdict.reasons.join(","));
    assert.equal(row.revenueFromOperations, 1000);
    assert.equal(row.otherIncome, 50);
    assert.equal(row.totalAssets, 2000);
    assert.equal(row.paidUpCapital, 100);
    assert.equal(row.scaleLabel, "₹ in Lakhs");
    assert.equal(row.scaleFactor, 0.01);
  });

  it("does NOT scale eps, faceValue or sharesOutstanding", () => {
    // These three are rupees-per-share, rupees-per-share and a COUNT. Scaling a
    // ₹10 face value by the lakh factor yields ₹0.1, which still looks like a
    // plausible face value — an invisible bug.
    const { row } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "₹ in Lakhs",
          balanceSheet: "₹ in Lakhs",
          cashFlow: "₹ in Lakhs",
        },
      }),
    );
    assert.ok(row);
    assert.equal(row.eps, 12, "eps must not be scaled");
    assert.equal(row.faceValue, 10, "faceValue must not be scaled");
    assert.equal(
      row.sharesOutstanding,
      100_000_000,
      "share count must not be scaled",
    );
  });

  // ── UPDATED BY MONEY-1342, not relaxed ────────────────────────────────
  //
  // These two cases asserted FAILED_VALIDATION on fixtures where the DOCUMENT
  // states its units perfectly well somewhere else — a sibling statement in
  // the first, the balance sheet's own paid-up identity in the second. That
  // was the behaviour being changed: UNKNOWN_SCALE is 96.6% of all rejections
  // on prod, and refusing a document that contains its own answer is where
  // most of that comes from.
  //
  // The PROPERTY they existed for — an unreadable scale must never be assumed
  // to be crores — is unchanged and is asserted below, on fixtures where
  // nothing can supply it.

  it("borrows a SIBLING statement's units when a header is a cross-reference", () => {
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "see note 3",
          balanceSheet: "₹ in Crore",
          cashFlow: "₹ in Crore",
        },
      }),
    );
    assert.ok(row);
    assert.equal(verdict.status, "EXTRACTED");
    assert.ok(
      verdict.warnings.includes("SCALE_INFERRED_FROM_SIBLING"),
      "an inferred factor must be WARNED — it is weaker evidence than a " +
        "declared one and the row must say so",
    );
    assert.equal(row.revenueFromOperations, 1000);
    assert.equal(
      row.lines.validation.scaleInference?.incomeStatement?.method,
      "SIBLING_STATEMENT",
    );
  });

  it("resolves an entirely unheadered period from the paid-up-capital identity", () => {
    // 100,000,000 shares x ₹10 = ₹1e9 = 100 crore, and the balance sheet
    // prints 100. Only CRORE fits; LAKH would make it 1 crore.
    const { verdict, row } = mapPeriodExtract(
      goodPeriod({
        scale: { incomeStatement: null, balanceSheet: null, cashFlow: null },
      }),
    );
    assert.equal(verdict.status, "EXTRACTED");
    assert.ok(verdict.warnings.includes("SCALE_INFERRED_FROM_CAPITAL"));

    // The strongest available check: the inferred reading must equal the one
    // the SAME period produces when its header states crore outright. A magic
    // number here would pass for a factor that is merely non-null.
    const declared = mapPeriodExtract(goodPeriod());
    assert.equal(row?.totalAssets, declared.row?.totalAssets);
    assert.equal(
      row?.revenueFromOperations,
      declared.row?.revenueFromOperations,
    );
    assert.equal(row?.scaleFactor, declared.row?.scaleFactor);
  });

  it("STILL refuses when nothing in the document can supply the units", () => {
    // The property the two replaced cases existed for. No readable header on
    // any statement, and the identity's terms removed.
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "see note 3",
          balanceSheet: "see note 3",
          cashFlow: "see note 3",
        },
        balanceSheet: {
          totalAssets: 5000,
          totalLiabilities: 3000,
          totalEquity: 2000,
        },
      }),
    );
    assert.ok(row, "the reading is still recorded — it is a prompt signal");
    assert.equal(verdict.status, "FAILED_VALIDATION");
    assert.ok(verdict.reasons.includes("UNKNOWN_SCALE"));
    assert.equal(
      row.revenueFromOperations,
      null,
      "an unscalable figure is null, not a raw number in unknown units",
    );
  });

  it("[structural] the identity's candidate magnitudes are separable, so at most one can fit", () => {
    // This is why `inferScale` requires EXACTLY ONE fit and why no fixture can
    // exercise the two-fit branch: within a +/-2% band, two factors could both
    // fit only if they differed by at most 1.02/0.98 = 1.041x. The closest
    // pair here differs by 100x. If a magnitude is ever added inside that
    // ratio, this case fails and the uniqueness check stops being dead code.
    const factors = (["UNIT", "THOUSAND", "LAKH", "MILLION", "CRORE"] as const)
      .map((u) => SCALE_FACTOR_TO_CRORE[u])
      .sort((a, b) => a - b);
    const worst = Math.min(
      ...factors.slice(1).map((f, i) => f / (factors[i] as number)),
    );
    const ambiguousBelow =
      (1 + SCALE_IDENTITY_REL_TOLERANCE) / (1 - SCALE_IDENTITY_REL_TOLERANCE);
    assert.ok(
      worst > ambiguousBelow,
      `two candidate magnitudes are only ${worst}x apart, inside the ` +
        `${ambiguousBelow}x band where both can satisfy the identity`,
    );
  });

  it("a DECLARED header always beats the identity", () => {
    // The identity here implies CRORE (100,000,000 x 10 / 1e7 = 100 against a
    // printed 100), and the header says lakhs. The header wins: inference
    // widens what can be read, it never overrides what the document said.
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "₹ in Lakhs",
          balanceSheet: "₹ in Lakhs",
          cashFlow: "₹ in Lakhs",
        },
      }),
    );
    const declaredCrore = mapPeriodExtract(goodPeriod());
    assert.equal(verdict.status, "EXTRACTED");
    assert.equal(row?.scaleFactor, 0.01);
    assert.equal(
      row?.totalAssets,
      (declaredCrore.row?.totalAssets as number) * 0.01,
      "the identity overrode a stated header — a document that says lakhs " +
        "must be read in lakhs",
    );
    assert.ok(
      !verdict.warnings.some((w) => w.startsWith("SCALE_INFERRED")),
      "a declared header must not be reported as inferred",
    );
  });

  it("refuses when the identity does not DISCRIMINATE between magnitudes", () => {
    // Two candidate magnitudes both inside tolerance means the identity says
    // nothing here, and picking one is the 100x error the refusal exists for.
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        scale: { incomeStatement: null, balanceSheet: null, cashFlow: null },
        balanceSheet: {
          totalAssets: 5000,
          totalLiabilities: 3000,
          totalEquity: 2000,
          // 0 shares -> the identity has no expected value at all.
          paidUpCapital: 100,
          faceValue: 10,
          sharesOutstanding: 0,
        },
      }),
    );
    assert.equal(verdict.status, "FAILED_VALIDATION");
    assert.ok(verdict.reasons.includes("UNKNOWN_SCALE"));
  });

  it("warns when statements declare DIFFERENT units", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "₹ in Crore",
          balanceSheet: "₹ in Lakhs",
          cashFlow: "₹ in Crore",
        },
        balanceSheet: {
          totalAssets: 200_000,
          totalLiabilities: 120_000,
          totalEquity: 80_000,
          paidUpCapital: 10_000,
          faceValue: 10,
          sharesOutstanding: 100_000_000,
        },
      }),
    );
    assert.ok(verdict.warnings.includes("SCALE_DIFFERS_BETWEEN_STATEMENTS"));
    assert.equal(
      verdict.status,
      "EXTRACTED",
      "differing units are legitimate — each statement is scaled by its own",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// NON-FINITE
// ══════════════════════════════════════════════════════════════════════

describe("non-finite poisoning", () => {
  it("hasNonFiniteRawFigure sees NaN / Infinity, and ignores legitimate nulls", () => {
    assert.equal(hasNonFiniteRawFigure(goodPeriod()), false);
    assert.equal(
      hasNonFiniteRawFigure(
        goodPeriod({ incomeStatement: { netIncome: null, eps: null } }),
      ),
      false,
      "a null is 'the document does not state this', not corruption",
    );
    assert.equal(
      hasNonFiniteRawFigure(
        goodPeriod({ incomeStatement: { netIncome: NaN } }),
      ),
      true,
    );
    assert.equal(
      hasNonFiniteRawFigure(
        goodPeriod({ balanceSheet: { totalAssets: Infinity } }),
      ),
      true,
    );
    assert.equal(hasNonFiniteRawFigure(goodPeriod({ confidence: NaN })), true);
    assert.equal(
      hasNonFiniteRawFigure(
        goodPeriod({ lines: [{ statement: "X", label: "Y", value: NaN }] }),
      ),
      true,
    );
  });

  it("a NaN figure fails the row even though the COLUMN comes out null", () => {
    // This is the whole point. `applyScale` already maps NaN → null, so the
    // stored column looks innocent and every downstream comparison against it
    // is silently false. Without the RAW check the verdict would be EXTRACTED
    // and a corrupted reading would be marked good.
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: NaN,
          otherIncome: 50,
          totalIncome: 1050,
          netIncome: 120,
          eps: 12,
        },
      }),
    );
    assert.ok(row);
    assert.equal(row.revenueFromOperations, null, "column is null, not NaN");
    assert.equal(verdict.status, "FAILED_VALIDATION");
    assert.ok(verdict.reasons.includes("NON_FINITE_VALUE"));
  });

  it("`?? 0` would NOT have caught it — the coalesce is not a finiteness check", () => {
    // Pinned as an executable statement of the defect class rather than a
    // comment: `NaN ?? 0` is NaN, so the idiom this repo reaches for by reflex
    // passes the poison straight through.
    const poisoned: number | null = NaN;
    assert.ok(Number.isNaN(poisoned ?? 0));
    assert.equal(Number.isFinite(poisoned ?? 0), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// periodEnd
// ══════════════════════════════════════════════════════════════════════

describe("periodEnd is required and must be a real date", () => {
  it("parses a real ISO day", () => {
    const d = parsePeriodEnd("2025-03-31");
    assert.ok(d);
    assert.equal(d.toISOString(), "2025-03-31T00:00:00.000Z");
  });

  it("rejects garbage, wrong shapes, and non-strings", () => {
    for (const bad of [
      "not-a-date",
      "31/03/2025",
      "2025-3-31",
      "2025-03",
      "",
      null,
      undefined,
      20250331,
      {},
    ]) {
      assert.equal(parsePeriodEnd(bad), null, `${String(bad)} must not parse`);
    }
  });

  it("rejects a date that does not exist rather than rolling it over", () => {
    // `new Date(Date.UTC(2025, 1, 31))` is 2025-03-03. Accepting it would file
    // a February reading in March, in the one column every reader sorts on.
    assert.equal(parsePeriodEnd("2025-02-31"), null);
    assert.equal(parsePeriodEnd("2025-13-01"), null);
    assert.equal(parsePeriodEnd("2025-00-10"), null);
  });

  it("bounds the window at both ends", () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    assert.equal(isPeriodEndInRange(new Date("2025-03-31"), now), true);
    assert.equal(isPeriodEndInRange(new Date("1989-03-31"), now), false);
    assert.equal(isPeriodEndInRange(new Date("2030-03-31"), now), false);
  });

  it("a period with NO periodEnd is DROPPED, not defaulted", () => {
    // Both readers of the canonical table sort on periodEnd. A row without one
    // renders and reaches the LLM in the WRONG POSITION, which is worse than
    // being absent.
    const { row, verdict } = mapPeriodExtract(goodPeriod({ periodEnd: null }));
    assert.equal(row, null);
    assert.equal(verdict.persistable, false);
    assert.deepEqual(verdict.reasons, ["MISSING_PERIOD_END"]);
  });

  it("distinguishes MISSING from INVALID from OUT_OF_RANGE", () => {
    assert.deepEqual(
      mapPeriodExtract(goodPeriod({ periodEnd: "" })).verdict.reasons,
      ["MISSING_PERIOD_END"],
    );
    assert.deepEqual(
      mapPeriodExtract(goodPeriod({ periodEnd: "2025-02-31" })).verdict.reasons,
      ["INVALID_PERIOD_END"],
    );
    assert.deepEqual(
      mapPeriodExtract(goodPeriod({ periodEnd: "1899-03-31" })).verdict.reasons,
      ["PERIOD_END_OUT_OF_RANGE"],
    );
  });

  it("rejects an unusable periodType or basis rather than guessing one", () => {
    // Both are NOT NULL columns and both are in the unique key, so a guess
    // would collide two different readings onto one row.
    assert.deepEqual(
      mapPeriodExtract(goodPeriod({ periodType: "YEARLY" })).verdict.reasons,
      ["INVALID_PERIOD_TYPE"],
    );
    assert.deepEqual(
      mapPeriodExtract(goodPeriod({ basis: "COMBINED" })).verdict.reasons,
      ["INVALID_BASIS"],
    );
    // …but accepts the right values in any casing the model emits.
    const ok = mapPeriodExtract(
      goodPeriod({ periodType: "quarterly", basis: " standalone " }),
    );
    assert.equal(ok.row?.periodType, "QUARTERLY");
    assert.equal(ok.row?.basis, "STANDALONE");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ARITHMETIC CHECKS
// ══════════════════════════════════════════════════════════════════════

describe("the Schedule III cross-foot", () => {
  it("passes when totalIncome equals the two components", () => {
    const { verdict } = mapPeriodExtract(goodPeriod());
    assert.equal(verdict.status, "EXTRACTED", verdict.reasons.join(","));
    assert.equal(verdict.reasons.length, 0);
  });

  it("FAILS when a combined figure landed in revenueFromOperations", () => {
    // The exact failure this check exists for: the model read the printed
    // "Total income" row into `revenueFromOperations`.
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: 1050,
          otherIncome: 50,
          totalIncome: 1050,
          netIncome: 120,
          eps: 12,
        },
      }),
    );
    assert.equal(verdict.status, "FAILED_VALIDATION");
    assert.ok(verdict.reasons.includes("TOTAL_INCOME_MISMATCH"));
  });

  it("LIMIT: it is addition, so it cannot see the two components SWAPPED", () => {
    // Documented as a test rather than a comment so nobody later cites this
    // identity as proof of a component assignment. a+b=c is symmetric in a,b.
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: 50,
          otherIncome: 1000,
          totalIncome: 1050,
          netIncome: 120,
          eps: 12,
        },
      }),
    );
    assert.equal(
      verdict.reasons.includes("TOTAL_INCOME_MISMATCH"),
      false,
      "the sum still holds under a swap — this identity cannot detect it",
    );
    // What DOES speak to it is an independent magnitude signal, and only as a
    // warning: an investment holding company legitimately earns more other
    // income than operating revenue.
    assert.ok(
      verdict.warnings.includes("OTHER_INCOME_EXCEEDS_OPERATING_REVENUE"),
    );
  });

  it("records that the components were UNCHECKED when no total is printed", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: 1000,
          otherIncome: 50,
          netIncome: 120,
          eps: 12,
        },
      }),
    );
    assert.equal(verdict.status, "EXTRACTED");
    assert.ok(
      verdict.warnings.includes("TOTAL_INCOME_NOT_CROSS_CHECKED"),
      "'unchecked' must not read as 'verified' — that erasure is MONEY-1234",
    );
  });
});

describe("the balance-sheet identity", () => {
  it("passes inside the tolerance and fails outside it", () => {
    // Inside: a 5 Cr gap on 2,000 Cr of assets is 0.25%, under the 1% band.
    const near = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 1200,
          totalEquity: 795,
          faceValue: 10,
        },
      }),
    );
    assert.equal(
      near.verdict.status,
      "EXTRACTED",
      near.verdict.reasons.join(","),
    );

    // Outside: a 200 Cr gap is 10%.
    const far = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 1200,
          totalEquity: 600,
          faceValue: 10,
        },
      }),
    );
    assert.ok(far.verdict.reasons.includes("BALANCE_SHEET_IMBALANCE"));
  });

  it("the absolute floor protects a small issuer from rounding noise", () => {
    // 1% of a ₹5 Cr balance sheet is ₹0.05 Cr — below the rounding granularity
    // of a statement printed in lakhs. The floor is what carries it.
    assert.ok(BALANCE_ABS_TOLERANCE_CRORE > 0);
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 5,
          totalLiabilities: 3,
          totalEquity: 1.5,
          faceValue: 10,
        },
      }),
    );
    assert.equal(
      verdict.reasons.includes("BALANCE_SHEET_IMBALANCE"),
      false,
      `a 0.5 Cr gap must sit under the ${BALANCE_ABS_TOLERANCE_CRORE} Cr floor`,
    );
  });

  it("LIMIT: a UNIFORM scale error passes it — A=L+E is scale-invariant", () => {
    // The identity holds under multiplying all three terms by any constant, so
    // a statement wrongly read as crores when it was lakhs balances perfectly.
    // Only the plausibility ceiling can see that, and only above the band.
    const uniform = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 200_000, // the lakh figures, mislabelled as crore
          totalLiabilities: 120_000,
          totalEquity: 80_000,
          faceValue: 10,
        },
      }),
    );
    assert.equal(
      uniform.verdict.reasons.includes("BALANCE_SHEET_IMBALANCE"),
      false,
      "the identity is blind to a uniform multiple — stated, not claimed away",
    );
    assert.ok(
      BALANCE_REL_TOLERANCE > 0 && BALANCE_REL_TOLERANCE < 0.05,
      "the band must stay far tighter than the smallest scale confusion (10x)",
    );
  });

  it("records BALANCE_SHEET_INCOMPLETE rather than silently skipping", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({ balanceSheet: { totalAssets: 2000, faceValue: 10 } }),
    );
    assert.ok(verdict.warnings.includes("BALANCE_SHEET_INCOMPLETE"));
    assert.equal(verdict.status, "EXTRACTED");
  });
});

describe("the plausibility ceiling", () => {
  it("rejects a figure above the largest real Indian balance sheet", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: MAX_PLAUSIBLE_CRORE + 1,
          totalLiabilities: MAX_PLAUSIBLE_CRORE + 1,
          totalEquity: 0,
          faceValue: 10,
        },
      }),
    );
    assert.ok(verdict.reasons.includes("IMPLAUSIBLE_MAGNITUDE"));
  });

  it("leaves the largest genuine issuer alone", () => {
    // SBI / LIC print total assets around 6.8e6 Cr. The ceiling has to clear
    // them by a margin or it rejects the real data it exists to protect.
    assert.ok(
      MAX_PLAUSIBLE_CRORE > 6_800_000 * 2,
      "ceiling must clear the largest real balance sheet with headroom",
    );
    assert.ok(
      MAX_PLAUSIBLE_CRORE < 6_800_000 * 10,
      "…and still catch a 10x error on that same issuer",
    );
  });

  it("rejects negative total assets", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: -2000,
          totalLiabilities: -1200,
          totalEquity: -800,
          faceValue: 10,
        },
      }),
    );
    assert.ok(verdict.reasons.includes("NEGATIVE_TOTAL_ASSETS"));
  });
});

describe("share-structure cross-checks, and exactly what they prove", () => {
  it("EPS: the quotient IS asymmetric, so it DOES see a swap", () => {
    const clean = mapPeriodExtract(goodPeriod());
    assert.equal(
      clean.verdict.warnings.includes("EPS_INCONSISTENT_WITH_NET_INCOME"),
      false,
      "120 Cr / 1e8 shares = ₹12, which is the stated EPS",
    );
    // Swap netIncome and sharesOutstanding. A division notices; a product would
    // not.
    const swapped = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: 1000,
          otherIncome: 50,
          totalIncome: 1050,
          netIncome: 100_000_000,
          eps: 12,
        },
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 1200,
          totalEquity: 800,
          paidUpCapital: 100,
          faceValue: 10,
          sharesOutstanding: 120,
        },
      }),
    );
    assert.ok(
      swapped.verdict.warnings.includes("EPS_INCONSISTENT_WITH_NET_INCOME"),
    );
  });

  it("EPS: a share count read 'in lakhs' is caught — its real job", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 1200,
          totalEquity: 800,
          paidUpCapital: 100,
          faceValue: 10,
          sharesOutstanding: 1000, // 1,000 lakh, reported as 1,000
        },
      }),
    );
    assert.ok(
      verdict.warnings.includes("EPS_INCONSISTENT_WITH_NET_INCOME"),
      "1e5 out on the share count must not pass silently",
    );
  });

  it("EPS never rejects a row on its own — weighted-average shares differ", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: 1000,
          otherIncome: 50,
          totalIncome: 1050,
          netIncome: 120,
          eps: 40,
        },
      }),
    );
    assert.ok(verdict.warnings.includes("EPS_INCONSISTENT_WITH_NET_INCOME"));
    assert.equal(
      verdict.status,
      "EXTRACTED",
      "reported EPS uses weighted-average shares — a real gap is not a defect",
    );
  });

  it("LIMIT: paid-up capital is a PRODUCT and cannot see shares↔faceValue swapped", () => {
    // 1e8 shares × ₹10 = 100 Cr. Swap them: 10 shares × ₹1e8 = 100 Cr. The
    // identity is identical. Stated as a test so it is never cited as proof of
    // that assignment.
    const clean = mapPeriodExtract(goodPeriod());
    assert.equal(
      clean.verdict.warnings.includes("PAID_UP_CAPITAL_INCONSISTENT"),
      false,
    );
    const swapped = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 1200,
          totalEquity: 800,
          paidUpCapital: 100,
          faceValue: 100_000_000,
          sharesOutstanding: 10,
        },
      }),
    );
    assert.equal(
      swapped.verdict.warnings.includes("PAID_UP_CAPITAL_INCONSISTENT"),
      false,
      "the product is unchanged — this identity is blind to the swap",
    );
    // The INDEPENDENT magnitude bands are what actually separate the two.
    assert.ok(swapped.verdict.warnings.includes("IMPLAUSIBLE_FACE_VALUE"));
    assert.ok(swapped.verdict.warnings.includes("IMPLAUSIBLE_SHARE_COUNT"));
  });

  it("paid-up capital DOES catch a component that is simply wrong", () => {
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 1200,
          totalEquity: 800,
          paidUpCapital: 500, // should be 100
          faceValue: 10,
          sharesOutstanding: 100_000_000,
        },
      }),
    );
    assert.ok(verdict.warnings.includes("PAID_UP_CAPITAL_INCONSISTENT"));
  });

  it("warns when no statement cited a page", () => {
    const { verdict } = mapPeriodExtract(goodPeriod({ pageRefs: null }));
    assert.ok(verdict.warnings.includes("NO_PAGE_REFS"));
    const cited = mapPeriodExtract(goodPeriod());
    assert.equal(cited.verdict.warnings.includes("NO_PAGE_REFS"), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// SIGN CONVENTIONS
// ══════════════════════════════════════════════════════════════════════

describe("capex is stored POSITIVE, whatever the statement printed", () => {
  it("the schema TELLS the model the convention", () => {
    const cf =
      DOCUMENT_FINANCIALS_SCHEMA.properties?.["periods"]?.items?.properties?.[
        "cashFlow"
      ];
    const desc = cf?.properties?.["capitalExpenditure"]?.description ?? "";
    assert.match(desc, /POSITIVE/);
    assert.ok(desc.length > 40, "CEILING: the description was actually read");
  });

  it("and the prompt says it too, without licensing a blanket abs()", () => {
    const prompt = buildDocumentFinancialsPrompt({
      symbol: "TCS",
      docType: "annual_report",
      period: "2025",
    });
    assert.match(prompt, /capitalExpenditure/);
    assert.match(prompt, /magnitude POSITIVE/i);
    assert.match(prompt, /a loss, a cash burn and negative equity/i);
  });

  it("a NEGATIVE printed capex becomes a POSITIVE stored value", () => {
    // The whole point. `stock_financials` stores capex positive; a cash-flow
    // statement prints it negative. Copying the page's sign scores
    // SIGN_MISMATCH on EVERY row and blocks the reconcile gate.
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        cashFlow: { operatingCashFlow: 200, capitalExpenditure: -60 },
      }),
    );
    assert.ok(row);
    assert.equal(row.capitalExpenditure, 60);
    assert.equal(verdict.status, "EXTRACTED", verdict.reasons.join(","));
  });

  it("an already-positive capex is left alone", () => {
    const { row } = mapPeriodExtract(goodPeriod());
    assert.equal(row?.capitalExpenditure, 60);
  });

  it("normalises AFTER scaling, so the factor still applies", () => {
    const { row } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "₹ in Lakhs",
          balanceSheet: "₹ in Lakhs",
          cashFlow: "₹ in Lakhs",
        },
        cashFlow: { operatingCashFlow: 20_000, capitalExpenditure: -6_000 },
      }),
    );
    assert.equal(row?.capitalExpenditure, 60, "6,000 lakh → 60 Cr, positive");
  });

  it("records the printed sign, because normalising destroys the evidence", () => {
    // Without this, "the model copies the page's sign" and "the model followed
    // the instruction" are indistinguishable after the fact — and which is true
    // decides whether the prompt needs changing.
    const flipped = mapPeriodExtract(
      goodPeriod({
        cashFlow: { operatingCashFlow: 200, capitalExpenditure: -60 },
      }),
    );
    assert.equal(flipped.row?.lines.validation.capexAsPrinted, -60);
    assert.ok(flipped.verdict.warnings.includes("CAPEX_SIGN_NORMALISED"));

    const clean = mapPeriodExtract(goodPeriod());
    assert.equal(clean.row?.lines.validation.capexAsPrinted, 60);
    assert.equal(
      clean.verdict.warnings.includes("CAPEX_SIGN_NORMALISED"),
      false,
      "a correctly-signed reading must not raise the signal",
    );
  });

  it("normaliseCapexSign rejects non-finite rather than returning NaN", () => {
    assert.equal(normaliseCapexSign(-60), 60);
    assert.equal(normaliseCapexSign(60), 60);
    assert.equal(normaliseCapexSign(0), 0);
    assert.equal(normaliseCapexSign(null), null);
    assert.equal(normaliseCapexSign(NaN), null);
    assert.equal(normaliseCapexSign(Infinity), null);
  });
});

describe("every OTHER signed field keeps the sign the document printed", () => {
  it("a loss-making, cash-burning, negative-equity company survives intact", () => {
    // The sibling failure to capex, and the far more expensive direction: a
    // blanket "money is positive" normalisation would turn every loss-making
    // company profitable and every cash burn into cash generation. Asserted
    // field by field so a future abs() sweep fails here.
    const { row, verdict } = mapPeriodExtract(
      goodPeriod({
        incomeStatement: {
          revenueFromOperations: 1000,
          otherIncome: -20,
          totalIncome: 980,
          operatingIncomeExOtherIncome: -150,
          ebitdaBeforeExceptionalItems: -90,
          netIncome: -240,
          eps: -24,
        },
        balanceSheet: {
          totalAssets: 2000,
          totalLiabilities: 2100,
          totalEquity: -100,
          paidUpCapital: 100,
          faceValue: 10,
          sharesOutstanding: 100_000_000,
        },
        cashFlow: {
          operatingCashFlow: -300,
          capitalExpenditure: -60,
          freeCashFlow: -360,
        },
      }),
    );
    assert.ok(row);
    assert.equal(row.netIncome, -240, "a LOSS must stay negative");
    assert.equal(row.operatingCashFlow, -300, "cash BURN must stay negative");
    assert.equal(row.freeCashFlow, -360);
    assert.equal(row.operatingIncomeExOtherIncome, -150);
    assert.equal(row.ebitdaBeforeExceptionalItems, -90);
    assert.equal(row.totalEquity, -100, "negative equity is real");
    assert.equal(row.otherIncome, -20);
    assert.equal(row.eps, -24);
    // …and capex is STILL flipped, in the same reading.
    assert.equal(row.capitalExpenditure, 60);
    // The balance sheet still balances: 2000 ≈ 2100 + (-100).
    assert.equal(
      verdict.reasons.includes("BALANCE_SHEET_IMBALANCE"),
      false,
      verdict.reasons.join(","),
    );
  });

  it("negative total assets are REJECTED, never quietly flipped", () => {
    // The one other field with no valid negative reading. Flipping it would
    // manufacture a plausible number out of a broken reading; rejecting says so.
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        balanceSheet: {
          totalAssets: -2000,
          totalLiabilities: -1200,
          totalEquity: -800,
          faceValue: 10,
        },
      }),
    );
    assert.ok(verdict.reasons.includes("NEGATIVE_TOTAL_ASSETS"));
    assert.equal(verdict.status, "FAILED_VALIDATION");
  });
});

// ══════════════════════════════════════════════════════════════════════
// WHOLE-DOCUMENT MAPPING
// ══════════════════════════════════════════════════════════════════════

describe("mapDocumentFinancials", () => {
  it("keeps every persistable period and tallies what it dropped", () => {
    const mapped = mapDocumentFinancials({
      periods: [
        goodPeriod(),
        goodPeriod({ basis: "STANDALONE" }),
        goodPeriod({ periodEnd: null }),
        goodPeriod({ periodEnd: "bad" }),
      ],
    });
    assert.equal(
      mapped.periodsReturned,
      4,
      "the ceiling: the fixture was read",
    );
    assert.equal(mapped.rows.length, 2);
    assert.deepEqual(mapped.dropped.sort(), [
      "INVALID_PERIOD_END",
      "MISSING_PERIOD_END",
    ]);
  });

  it("drops a period with no figures at all rather than storing an empty row", () => {
    // An all-null row occupies the unique key and blocks a later re-parse that
    // DID find figures, while carrying nothing a reader could use.
    const mapped = mapDocumentFinancials({
      periods: [
        goodPeriod({
          incomeStatement: null,
          balanceSheet: null,
          cashFlow: null,
        }),
      ],
    });
    assert.equal(mapped.rows.length, 0);
    assert.deepEqual(mapped.dropped, ["NO_FIGURES"]);
  });

  it("survives a null / shapeless response without throwing", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { periods: null },
      { periods: 7 },
    ]) {
      const mapped = mapDocumentFinancials(bad as never);
      assert.equal(mapped.rows.length, 0);
      assert.equal(mapped.periodsReturned, 0);
    }
  });

  it("carries the verdict and the per-statement scales into `lines`", () => {
    // There is no reason column on the table. A FAILED_VALIDATION row whose
    // reason is not recorded is a row nobody can act on.
    // MONEY-1342: every header unreadable AND the identity's terms removed, so
    // nothing in the document can supply the units and the refusal stands.
    const mapped = mapDocumentFinancials({
      periods: [
        goodPeriod({
          scale: {
            incomeStatement: "see note 3",
            balanceSheet: "see note 3",
            cashFlow: "see note 3",
          },
          balanceSheet: {
            totalAssets: 5000,
            totalLiabilities: 3000,
            totalEquity: 2000,
          },
        }),
      ],
    });
    assert.equal(mapped.rows.length, 1);
    const v = mapped.rows[0]!.row.lines.validation;
    assert.equal(v.status, "FAILED_VALIDATION");
    assert.ok(v.reasons.includes("UNKNOWN_SCALE"));
    assert.equal(v.scales.incomeStatement.scaleLabel, "see note 3");
    assert.equal(v.scales.incomeStatement.resolved, false);
  });

  it("statementHasFigure ignores nulls and non-numbers", () => {
    assert.equal(statementHasFigure(null), false);
    assert.equal(statementHasFigure({}), false);
    assert.equal(statementHasFigure({ a: null, b: "12" }), false);
    assert.equal(statementHasFigure({ a: null, b: 0 }), true);
    assert.equal(statementHasFigure({ a: NaN }), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE ARMING FLAG (for the later projection, not this lane)
// ══════════════════════════════════════════════════════════════════════

describe("DOC_FINANCIALS_APPLY is compared against the LITERAL string", () => {
  it('only the exact string "true" arms it', () => {
    assert.equal(
      isDocFinancialsApplyArmed({ DOC_FINANCIALS_APPLY: "true" }),
      true,
    );
    for (const v of ["false", "TRUE", "True", "1", "yes", "", undefined]) {
      assert.equal(
        isDocFinancialsApplyArmed({ DOC_FINANCIALS_APPLY: v }),
        false,
        `"${String(v)}" must not arm the projection`,
      );
    }
    assert.equal(isDocFinancialsApplyArmed({}), false, "absent is not armed");
  });

  it("Boolean() would have armed the one configuration meant to be off", () => {
    // Pinned executably: this is why the comparison is a string comparison.
    assert.equal(Boolean("false"), true);
    assert.notEqual(
      isDocFinancialsApplyArmed({ DOC_FINANCIALS_APPLY: "false" }),
      Boolean("false"),
    );
  });
});

/**
 * THE STATEMENT OBJECTS ARE REQUIRED; THE FIGURES ARE NOT — MONEY-1332.
 *
 * Measured across a 22-document pilot: the model returned periods carrying
 * `incomeStatement` and NO `balanceSheet` key at all, for documents whose input
 * was verified to contain a balance sheet. 250 of 261 remaining disagreements
 * were a column the incumbent held and the batch never mentioned.
 *
 * Both halves are load-bearing and they pull in opposite directions, which is
 * why they are asserted TOGETHER: requiring the object stops silent omission,
 * and requiring a FIGURE inside it would turn "this quarterly has no balance
 * sheet" into pressure to invent one. A future edit that tightens the inner
 * schema would look like an improvement and would be the more expensive bug.
 */
describe("MONEY-1332 — required statements must not become required figures", () => {
  const period = (
    DOCUMENT_FINANCIALS_SCHEMA.properties?.periods as {
      items?: { required?: string[]; properties?: Record<string, unknown> };
    }
  )?.items;

  it("requires all three statement OBJECTS on every period", () => {
    for (const key of ["incomeStatement", "balanceSheet", "cashFlow"]) {
      assert.ok(
        period?.required?.includes(key),
        `period.required is missing "${key}" — the model may then omit the ` +
          "key entirely, which is indistinguishable from the document not " +
          "having that statement, and was 250 of 261 pilot disagreements",
      );
    }
  });

  it("requires NO figure inside any of them", () => {
    for (const key of ["incomeStatement", "balanceSheet", "cashFlow"]) {
      const st = period?.properties?.[key] as
        | { required?: string[] }
        | undefined;
      // ASSERT IT EXISTS FIRST. `!st?.required` is TRUE when `st` is undefined,
      // so a renamed key or a restructured schema made this whole loop pass
      // while checking nothing — it asserted the absence of a property on an
      // object that was itself absent.
      assert.ok(
        st !== undefined,
        `period.properties.${key} is missing — this test cannot say anything ` +
          "about required figures on a statement that is not there",
      );
      assert.ok(
        !st.required || st.required.length === 0,
        `${key} declares required figures — a period the document genuinely ` +
          "does not state would then have to be invented to satisfy the " +
          "schema. Requiring the OBJECT prevents silence; requiring a FIGURE " +
          "manufactures data",
      );
    }
  });

  it("still requires the period's own identity fields", () => {
    for (const key of ["fiscalYear", "periodEnd", "periodType", "basis"]) {
      assert.ok(period?.required?.includes(key), `period.required lost ${key}`);
    }
  });
});

describe("MONEY-1348 — a non-rupee document cannot be stored, so it is refused", () => {
  // Every figure here is normalised to CRORE and the table has no currency
  // column. Safe today by construction (`stock_documents` is 100% NSE/BSE,
  // measured), which is exactly why the guard is cheap now and expensive after
  // the first dollar document arrives.

  it("sees a currency SYMBOL that the tokeniser would have discarded", () => {
    // `scaleTokens` splits on non-alphanumerics, so "$ in millions" tokenises
    // to ["in","millions"], resolves to MILLION, and stores dollars as crores
    // of rupees with nothing recording it.
    assert.equal(resolveScale("$ in millions").currency, "NON_INR");
    assert.equal(resolveScale("€ in thousands").currency, "NON_INR");
    assert.equal(resolveScale("USD in millions").currency, "NON_INR");
    assert.equal(resolveScale("in US$ million").currency, "NON_INR");
  });

  it("does NOT flag the rupee spellings, or a header naming no currency", () => {
    for (const label of [
      "₹ in Lakhs",
      "Rs. in Lakhs",
      "(Rs. in Crore)",
      "Rupees in Lakhs",
      "in thousands",
      "Amount in Lakhs",
    ]) {
      assert.equal(
        resolveScale(label).currency,
        null,
        `${label} was flagged as non-INR — this refuses the corpus`,
      );
    }
  });

  it("still resolves the MAGNITUDE of a foreign header, and refuses the row", () => {
    // The scale is readable; the currency is the problem. Reporting
    // UNKNOWN_SCALE would name the wrong cause.
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "$ in millions",
          balanceSheet: "$ in millions",
          cashFlow: "$ in millions",
        },
      }),
    );
    assert.ok(verdict.reasons.includes("NON_INR_CURRENCY"));
    assert.ok(
      !verdict.reasons.includes("UNKNOWN_SCALE"),
      "a readable foreign header was reported as an unreadable one",
    );
    assert.equal(verdict.status, "FAILED_VALIDATION");
  });

  it("refuses on the DOCUMENT's declared reportingCurrency, symbol or not", () => {
    // The only signal available for a document that prints no symbol anywhere.
    const mapped = mapDocumentFinancials({
      reportingCurrency: "USD",
      periods: [goodPeriod()],
    });
    assert.equal(mapped.rows.length, 1);
    assert.ok(mapped.rows[0]!.verdict.reasons.includes("NON_INR_CURRENCY"));
    assert.equal(mapped.rows[0]!.verdict.status, "FAILED_VALIDATION");
  });

  it("treats INR, ₹, Rs and an ABSENT reportingCurrency as the rupee", () => {
    for (const cur of ["INR", "₹", "Rs", "Rs.", "rupees", undefined]) {
      const mapped = mapDocumentFinancials({
        ...(cur === undefined ? {} : { reportingCurrency: cur }),
        periods: [goodPeriod()],
      });
      assert.equal(
        mapped.rows[0]!.verdict.status,
        "EXTRACTED",
        `reportingCurrency ${String(cur)} was refused`,
      );
    }
  });

  it("accepts the SPELLINGS a model actually returns for the rupee", () => {
    // ── MONEY-1346: the whole-string whitelist was a permanent discard ─────
    //
    // `documentIsNonInr` was `!/^(?:inr|₹|rs\.?|rupees?|indian\s+rupees?)$/i`
    // — an ANCHORED match against free text a model produced from "ISO code
    // ... e.g. INR". Every string below therefore classified as a FOREIGN
    // currency, stamped NON_INR_CURRENCY on every period, and reached
    // `classifyIngestOutcome` as UNSUPPORTED — which is in
    // `TERMINAL_PARSE_STATUSES` with `retryable: false`. A correctly-read
    // Indian annual report was discarded forever over a bracket.
    for (const cur of [
      "INR (₹)",
      "Indian Rupee (INR)",
      "Rs. in Lakhs",
      "INR in Crores",
      "₹ (Indian Rupees)",
      "Rupees in millions",
      "inr",
    ]) {
      const mapped = mapDocumentFinancials({
        reportingCurrency: cur,
        periods: [goodPeriod()],
      });
      assert.equal(
        mapped.rows[0]!.verdict.status,
        "EXTRACTED",
        `reportingCurrency ${cur} was refused, and the refusal is terminal`,
      );
    }
  });

  it("still refuses the currencies that really are foreign", () => {
    // The control. A rule that answered "INR" to everything would pass every
    // case above and lose the check entirely — which is the over-correction,
    // and the one that stores dollars as crores of rupees.
    for (const cur of [
      "USD",
      "US Dollar",
      "$",
      "EUR",
      "€ (Euro)",
      "GBP",
      "USD in thousands",
      "AED",
    ]) {
      const mapped = mapDocumentFinancials({
        reportingCurrency: cur,
        periods: [goodPeriod()],
      });
      assert.ok(
        mapped.rows[0]!.verdict.reasons.includes("NON_INR_CURRENCY"),
        `reportingCurrency ${cur} was accepted as rupees`,
      );
    }
  });

  it("a rupee filing that MENTIONS a dollar translation is still rupees", () => {
    // The one shape the positive test alone gets wrong, and the reason the
    // rule carries a `!INR_CURRENCY` half. Refusing on ambiguity would be the
    // safe direction if the refusal were recoverable — UNSUPPORTED is not.
    for (const cur of ["INR (USD translation in note 42)", "Rs / USD"]) {
      const mapped = mapDocumentFinancials({
        reportingCurrency: cur,
        periods: [goodPeriod()],
      });
      assert.equal(mapped.rows[0]!.verdict.status, "EXTRACTED", cur);
    }
  });

  it("does not flag a statement the period does not carry", () => {
    // A quarterly result with a foreign header over an ABSENT cash flow must
    // not be refused for a statement it never printed.
    const { verdict } = mapPeriodExtract(
      goodPeriod({
        scale: {
          incomeStatement: "₹ in Lakhs",
          balanceSheet: "₹ in Lakhs",
          cashFlow: "$ in millions",
        },
        cashFlow: {},
      }),
    );
    assert.ok(!verdict.reasons.includes("NON_INR_CURRENCY"));
  });
});

describe("MONEY-1340 — one write payload, and the reasons are queryable", () => {
  const mapped = mapPeriodExtract(goodPeriod());
  const row = mapped.row!;

  it("carries the gate's reasons and warnings as COLUMNS", () => {
    // They have always been inside `lines.validation`. That is where they went
    // to die: the 96.6% UNKNOWN_SCALE finding took an aggregation over a
    // nested document to see, so nobody asked until somebody did.
    const payload = buildExtractWritePayload(
      row,
      {
        status: "FAILED_VALIDATION",
        reasons: ["UNKNOWN_SCALE"],
        warnings: ["BALANCE_SHEET_INCOMPLETE"],
      },
      "gemini-3.7-flash",
    );
    assert.deepEqual(payload.validationReasons, ["UNKNOWN_SCALE"]);
    assert.deepEqual(payload.validationWarnings, ["BALANCE_SHEET_INCOMPLETE"]);
    assert.equal(payload.status, "FAILED_VALIDATION");
  });

  it("COPIES the arrays rather than aliasing the verdict's", () => {
    // The verdict is mutated after mapping (the inference warnings are pushed
    // onto it), so an alias would let a later push change a row already built.
    const reasons: string[] = ["UNKNOWN_SCALE"];
    const payload = buildExtractWritePayload(
      row,
      { status: "FAILED_VALIDATION", reasons: reasons as never, warnings: [] },
      "m",
    );
    reasons.push("MUTATED_AFTER_THE_CALL");
    assert.deepEqual(payload.validationReasons, ["UNKNOWN_SCALE"]);
  });

  it("does NOT claim the three columns this reader cannot source", () => {
    // `revenue` is TOTAL INCOME in the canonical table while a filing's
    // headline "Revenue" is revenue FROM OPERATIONS — a different quantity.
    // `operatingIncome`/`ebitda` conventions were established against XBRL and
    // there is no equivalent evidence for a PDF reading.
    const payload = buildExtractWritePayload(
      row,
      { status: "EXTRACTED", reasons: [], warnings: [] },
      "m",
    );
    assert.equal("revenue" in payload, false);
    assert.equal("operatingIncome" in payload, false);
    assert.equal("ebitda" in payload, false);
  });

  it("stamps the prompt version and the model it was told", () => {
    const payload = buildExtractWritePayload(
      row,
      { status: "EXTRACTED", reasons: [], warnings: [] },
      "gemini-3.7-flash",
      new Date("2026-09-05T00:00:00Z"),
    );
    assert.equal(payload.model, "gemini-3.7-flash");
    assert.equal(payload.promptVersion, DOC_FINANCIALS_PROMPT_VERSION);
    assert.deepEqual(payload.extractedAt, new Date("2026-09-05T00:00:00Z"));
  });
});
