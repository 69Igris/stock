/**
 * MONEY-1324 (P17) — the filing analysis schema, prompt and checks.
 *
 * The source text in every check below is the REAL balance sheet excerpt from
 * `gs://stockbook-content-prod/edgar/text/0000866829/0001193125-26-378529/11.txt`,
 * checked in under `__tests__/fixtures/edgar-text/`. The wrapped-label hazard
 * is the whole reason this module exists, and it is a shape that only survives
 * as real bytes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FILING_INSIGHT_SCHEMA,
  FILING_INSIGHT_FIXED_PREFIX,
  FILING_DOCUMENT_CLASSES,
  buildFilingInsightPrompt,
  filingPrefixCacheStatus,
  normaliseFilingInsight,
  validateFilingInsight,
  checkFactsGrounded,
  checkTotalsCrossFoot,
  checkClassBlocks,
  indexSourceFigures,
  collectFacts,
  IMPLICIT_CACHE_MIN_TOKENS,
  MAX_KEY_POINTS,
  type FilingInsight,
  type FilingFact,
} from "../../src/market-data/filing-insight-logic";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "edgar-text");
const HLX = readFileSync(
  join(FIXTURE_DIR, "hlx-8k-ex991-statements.txt"),
  "utf-8",
);

/**
 * The five printed current-asset rows and their printed total, 2025 column.
 *
 * Verified against the fixture: 54,167 + 164,695 + 4,941 + 19,026 + 14,180
 * = 257,009, which is exactly what the document prints as "Total current
 * assets". Both columns cross-foot; the 2024 column sums to 256,951.
 */
const AR_SOURCE_LINE =
  "  allowance for credit losses of              164,695               145,527";

function fact(
  label: string,
  value: number | null,
  sourceLine: string | null = null,
): FilingFact {
  return {
    label,
    value,
    periodLabel: "December 31, 2025",
    statementType: "BALANCE_SHEET",
    sourceLine,
  };
}

/** A CORRECT reading of the balance sheet's current assets. */
function correctInsight(): FilingInsight {
  return {
    documentClass: "FINANCIAL_STATEMENTS",
    classConfidence: "HIGH",
    summary: "Audited consolidated financial statements.",
    keyPoints: [],
    registrant: "Hornbeck Offshore Services, Inc.",
    periodLabel: "December 31, 2025",
    periodEndDate: "2025-12-31",
    reportingCurrency: "USD",
    unitScale: "THOUSANDS",
    facts: [],
    statementTotals: [
      {
        label: "Total current assets",
        value: 257_009,
        periodLabel: "December 31, 2025",
        statementType: "BALANCE_SHEET",
        sourceLine: null,
        components: [
          fact("Cash and cash equivalents", 54_167),
          // THE ROW THE DESIGN EXISTS FOR — the value that sits on the
          // "allowance for credit losses of" line belongs to this label.
          fact(
            "Accounts receivable, net of allowance for credit losses of $7,511 and $7,929, respectively",
            164_695,
            AR_SOURCE_LINE,
          ),
          fact("Prepaid expenses", 4_941),
          fact("Taxes receivable", 19_026),
          fact("Other current assets", 14_180),
        ],
      },
    ],
    events: [],
  };
}

describe("the fixture carries the wrapped row", () => {
  it("prints the value on the allowance line, not the label line", () => {
    const lines = HLX.split("\n").map((l) => l.replace(/\s+$/, ""));
    const labelAt = lines.findIndex((l) =>
      l.includes("Accounts receivable, net of"),
    );
    assert.ok(labelAt >= 0);
    // The label line itself carries NO figures...
    assert.ok(!/\d{3}/.test(lines[labelAt] ?? ""));
    // ...and the NEXT line carries both period values.
    const next = lines[labelAt + 1] ?? "";
    assert.ok(next.includes("allowance for credit losses of"));
    assert.ok(next.includes("164,695"));
    assert.ok(next.includes("145,527"));
    // And the allowance amounts are on the line AFTER that, inside the label.
    assert.ok((lines[labelAt + 2] ?? "").includes("$7,511"));
  });
});

describe("indexSourceFigures", () => {
  it("finds the figures the document prints, commas and all", () => {
    const figures = indexSourceFigures(HLX);
    for (const value of [54_167, 164_695, 4_941, 19_026, 14_180, 257_009]) {
      assert.ok(figures.has(value), `${value} was not indexed`);
    }
  });

  it("indexes an accounting negative under both signs", () => {
    const figures = indexSourceFigures("  (recovery      (418  )     1,622");
    assert.ok(figures.has(-418));
    assert.ok(figures.has(418));
  });

  it("does NOT invent a figure that is absent", () => {
    assert.ok(!indexSourceFigures(HLX).has(999_999_123));
  });
});

describe("checkFactsGrounded", () => {
  it("passes a reading whose every figure is printed in the document", () => {
    const { issues, checkedValues } = checkFactsGrounded(correctInsight(), HLX);
    assert.deepEqual(issues, []);
    // 5 components + the total itself.
    assert.equal(checkedValues, 6);
  });

  it("CATCHES a hallucinated figure", () => {
    const insight = correctInsight();
    insight.statementTotals[0]!.components[0]!.value = 55_000;
    const { issues } = checkFactsGrounded(insight, HLX);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.kind, "ungrounded-value");
    assert.equal(issues[0]?.value, 55_000);
  });

  it("CATCHES a COMPUTED total the document does not print", () => {
    // The figure a model is most tempted to derive rather than read.
    const insight = correctInsight();
    insight.statementTotals[0]!.value = 257_008;
    const { issues } = checkFactsGrounded(insight, HLX);
    assert.ok(issues.some((i) => i.kind === "ungrounded-value"));
  });

  it("CATCHES a fabricated source line", () => {
    const insight = correctInsight();
    insight.statementTotals[0]!.components[1]!.sourceLine =
      "  Accounts receivable, net                164,695               145,527";
    const { issues } = checkFactsGrounded(insight, HLX);
    assert.ok(issues.some((i) => i.kind === "ungrounded-source-line"));
  });

  it("accepts a real source line despite whitespace re-alignment", () => {
    const insight = correctInsight();
    insight.statementTotals[0]!.components[1]!.sourceLine =
      "allowance for credit losses of 164,695 145,527";
    const { issues } = checkFactsGrounded(insight, HLX);
    assert.deepEqual(issues, []);
  });

  it("CANNOT catch mis-attribution — stated, not assumed", () => {
    // 7,511 IS printed in the document, so grounding passes. This test exists
    // so the limit is a fact in the suite rather than a claim in a comment:
    // a caller who believes grounding covers attribution will stop looking for
    // the check that does.
    const insight = correctInsight();
    insight.statementTotals[0]!.components[1]!.value = 7_511;
    const { issues } = checkFactsGrounded(insight, HLX);
    assert.deepEqual(
      issues.filter((i) => i.kind === "ungrounded-value"),
      [],
      "grounding unexpectedly caught mis-attribution",
    );
  });
});

describe("checkTotalsCrossFoot — THE wrapped-label defence", () => {
  it("passes the correct reading: components sum to the printed total", () => {
    const { issues, checkedTotals } = checkTotalsCrossFoot(correctInsight());
    assert.deepEqual(issues, []);
    assert.equal(checkedTotals, 1);
  });

  it("CATCHES the allowance being read as Accounts receivable", () => {
    // THE DEFECT THE DESIGN EXISTS TO SURVIVE.
    //
    // "164,695" sits on the line reading "allowance for credit losses of", and
    // "$7,511" one line below is the allowance itself. A line-oriented reader
    // attributes 7,511 to Accounts receivable — a figure that IS printed, on a
    // balance sheet that still looks entirely plausible.
    //
    // Grounding cannot see it (asserted above). Cross-footing can: the five
    // components then sum to 99,825 against a printed 257,009.
    const insight = correctInsight();
    insight.statementTotals[0]!.components[1]! = fact(
      "Accounts receivable, net",
      7_511,
    );

    const { issues } = checkTotalsCrossFoot(insight);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.kind, "cross-foot-mismatch");
    assert.equal(issues[0]?.label, "Total current assets");
    assert.match(issues[0]?.message ?? "", /99825/);
    assert.match(issues[0]?.message ?? "", /257009/);
  });

  it("the correct value is the one that reconciles — the positive control", () => {
    // Asserting the arithmetic directly, so this suite pins WHICH number
    // belongs to Accounts receivable rather than merely that something is
    // wrong when it changes.
    const components = [54_167, 164_695, 4_941, 19_026, 14_180];
    assert.equal(
      components.reduce((a, b) => a + b, 0),
      257_009,
    );
    const withAllowance = [54_167, 7_511, 4_941, 19_026, 14_180];
    assert.equal(
      withAllowance.reduce((a, b) => a + b, 0),
      99_825,
    );
  });

  it("the 2024 column cross-foots too", () => {
    assert.equal(
      [80_803, 145_527, 4_490, 13_755, 12_376].reduce((a, b) => a + b, 0),
      256_951,
    );
  });

  it("SKIPS a total whose components the model honestly could not identify", () => {
    // Punishing an empty components array would punish exactly the behaviour
    // the prompt asks for.
    const insight = correctInsight();
    insight.statementTotals[0]!.components = [];
    const { issues, checkedTotals } = checkTotalsCrossFoot(insight);
    assert.deepEqual(issues, []);
    assert.equal(checkedTotals, 0);
  });

  it("does NOT sum components from a different period column", () => {
    // A three-column statement of operations would otherwise fail every total
    // and the check would be deleted for being noisy.
    const insight = correctInsight();
    insight.statementTotals[0]!.components.push({
      label: "Cash and cash equivalents",
      value: 80_803,
      periodLabel: "December 31, 2024",
      statementType: "BALANCE_SHEET",
      sourceLine: null,
    });
    const { issues } = checkTotalsCrossFoot(insight);
    assert.deepEqual(issues, []);
  });

  it("tolerates rounding but not a mis-read row", () => {
    const insight = correctInsight();
    // 0.4% drift — inside the 0.5% band.
    insight.statementTotals[0]!.components[0]!.value = 54_167 + 900;
    assert.deepEqual(checkTotalsCrossFoot(insight).issues, []);
    // 2% drift — outside it.
    insight.statementTotals[0]!.components[0]!.value = 54_167 + 6_000;
    assert.equal(checkTotalsCrossFoot(insight).issues.length, 1);
  });

  it("does NOT repair the value it rejects", () => {
    // DETECT, NEVER REPAIR. The insight is returned untouched.
    const insight = correctInsight();
    insight.statementTotals[0]!.components[1]!.value = 7_511;
    checkTotalsCrossFoot(insight);
    assert.equal(insight.statementTotals[0]?.components[1]?.value, 7_511);
    validateFilingInsight(insight, HLX);
    assert.equal(insight.statementTotals[0]?.components[1]?.value, 7_511);
    assert.equal(insight.statementTotals[0]?.value, 257_009);
  });
});

describe("validateFilingInsight", () => {
  it("is ok for a correct reading", () => {
    const result = validateFilingInsight(correctInsight(), HLX);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.checkedValues, 6);
    assert.equal(result.checkedTotals, 1);
  });

  it("reports the wrapped-label mis-read through the full entry point", () => {
    const insight = correctInsight();
    insight.statementTotals[0]!.components[1]! = fact(
      "Accounts receivable, net",
      7_511,
    );
    const result = validateFilingInsight(insight, HLX);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.kind === "cross-foot-mismatch"));
  });

  it("flags a narrative class that returned statement totals", () => {
    const insight = correctInsight();
    insight.documentClass = "PROXY_OR_MEETING";
    const issues = checkClassBlocks(insight);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.kind, "class-block-mismatch");
    // Reported, NOT stripped — deleting data on a heuristic is a repair.
    assert.equal(insight.statementTotals.length, 1);
  });
});

describe("collectFacts", () => {
  it("includes the total itself, not only its components", () => {
    const facts = collectFacts(correctInsight());
    assert.equal(facts.length, 6);
    assert.ok(facts.some((f) => f.label === "Total current assets"));
  });
});

describe("normaliseFilingInsight — degrade, never throw", () => {
  it("THE DEGRADATION CASE: an unrecognised class becomes OTHER with fewer fields", () => {
    const insight = normaliseFilingInsight({
      documentClass: "MINERAL_RESERVE_REPORT",
      classConfidence: "HIGH",
      summary: "A technical report on mineral reserves.",
    });
    assert.ok(insight, "an unrecognised class threw away the whole response");
    assert.equal(insight.documentClass, "OTHER");
    // The model's HIGH referred to a class we did not accept, so carrying it
    // forward would attach a claim to a different answer.
    assert.equal(insight.classConfidence, "LOW");
    // FEWER FIELDS, not an error: the optional blocks are simply empty.
    assert.deepEqual(insight.facts, []);
    assert.deepEqual(insight.statementTotals, []);
    assert.deepEqual(insight.events, []);
    assert.deepEqual(insight.keyPoints, []);
    assert.equal(insight.registrant, null);
    assert.equal(insight.periodEndDate, null);
    assert.equal(insight.unitScale, "UNKNOWN");
    // ...while the fields it COULD produce survive intact.
    assert.equal(insight.summary, "A technical report on mineral reserves.");
  });

  it("keeps confidence when the class IS recognised", () => {
    const insight = normaliseFilingInsight({
      documentClass: "earnings_release",
      classConfidence: "HIGH",
      summary: "Q4 results.",
    });
    assert.equal(insight?.documentClass, "EARNINGS_RELEASE");
    assert.equal(insight?.classConfidence, "HIGH");
  });

  it("never throws on hostile shapes", () => {
    const hostile: unknown[] = [
      {},
      { documentClass: null },
      { documentClass: 42, summary: 7 },
      { facts: "not an array", statementTotals: 12, events: null },
      { facts: [null, 3, { label: null }, { label: "x", value: "nope" }] },
      { statementTotals: [{ label: "T", value: 1, components: "no" }] },
      { keyPoints: [1, null, "kept", {}] },
      { documentClass: "OTHER", classConfidence: "WILD" },
      // An unrecognised STRING class, which is the realistic shape — a model
      // inventing a plausible-sounding class rather than returning a number.
      { documentClass: "TOTALLY_MADE_UP", summary: "s" },
    ];
    for (const raw of hostile) {
      assert.doesNotThrow(() => normaliseFilingInsight(raw));
      const insight = normaliseFilingInsight(raw);
      assert.ok(insight);
      assert.ok(FILING_DOCUMENT_CLASSES.includes(insight.documentClass));
    }
  });

  it("returns null ONLY when there is nothing to degrade to", () => {
    for (const raw of [null, undefined, "text", 42, [], true]) {
      assert.equal(normaliseFilingInsight(raw), null);
    }
  });

  it("parses a numeric string the model returned instead of a number", () => {
    const insight = normaliseFilingInsight({
      documentClass: "FINANCIAL_STATEMENTS",
      facts: [
        { label: "Cash", value: "54,167", statementType: "BALANCE_SHEET" },
        { label: "Loss", value: "(418)", statementType: "INCOME_STATEMENT" },
        { label: "Junk", value: "n/a", statementType: "OTHER" },
      ],
    });
    assert.equal(insight?.facts[0]?.value, 54_167);
    assert.equal(insight?.facts[1]?.value, -418);
    assert.equal(insight?.facts[2]?.value, null);
  });

  it("rejects a non-finite figure outright", () => {
    const insight = normaliseFilingInsight({
      documentClass: "FINANCIAL_STATEMENTS",
      facts: [
        { label: "A", value: Number.NaN, statementType: "OTHER" },
        { label: "B", value: Number.POSITIVE_INFINITY, statementType: "OTHER" },
      ],
    });
    assert.equal(insight?.facts[0]?.value, null);
    assert.equal(insight?.facts[1]?.value, null);
  });

  it("caps keyPoints rather than storing whatever arrives", () => {
    const insight = normaliseFilingInsight({
      documentClass: "PRESS_RELEASE",
      keyPoints: Array.from({ length: 100 }, (_, i) => `point ${i}`),
    });
    assert.equal(insight?.keyPoints.length, MAX_KEY_POINTS);
  });

  it("a degraded insight still validates without throwing", () => {
    const insight = normaliseFilingInsight({ documentClass: "WHAT_IS_THIS" });
    assert.ok(insight);
    const result = validateFilingInsight(insight, HLX);
    assert.equal(result.ok, true);
    assert.equal(result.checkedValues, 0);
    assert.equal(result.checkedTotals, 0);
  });
});

describe("FILING_INSIGHT_SCHEMA", () => {
  it("requires only what every document class can produce", () => {
    assert.deepEqual(FILING_INSIGHT_SCHEMA.required, [
      "documentClass",
      "classConfidence",
      "summary",
    ]);
    // `facts` and `statementTotals` must NOT be required — the pressure to
    // satisfy a required field is how a narrative document acquires a
    // fabricated balance sheet.
    assert.ok(!FILING_INSIGHT_SCHEMA.required?.includes("facts"));
    assert.ok(!FILING_INSIGHT_SCHEMA.required?.includes("statementTotals"));
  });

  it("declares documentClass as a closed enum matching the type", () => {
    const declared = FILING_INSIGHT_SCHEMA.properties?.["documentClass"]?.enum;
    assert.deepEqual(declared, [...FILING_DOCUMENT_CLASSES]);
  });

  it("asks for sourceLine on every fact and on every component", () => {
    const factSchema = FILING_INSIGHT_SCHEMA.properties?.["facts"]?.items;
    assert.ok(factSchema?.properties?.["sourceLine"]);
    const totalSchema =
      FILING_INSIGHT_SCHEMA.properties?.["statementTotals"]?.items;
    assert.ok(
      totalSchema?.properties?.["components"]?.items?.properties?.[
        "sourceLine"
      ],
    );
  });

  it("asks a total for its components — the cross-foot depends on it", () => {
    const totalSchema =
      FILING_INSIGHT_SCHEMA.properties?.["statementTotals"]?.items;
    assert.ok(totalSchema?.required?.includes("components"));
  });
});

describe("the prompt and its cache prefix", () => {
  it("CLEARS the implicit-cache floor at a CONSERVATIVE ratio", () => {
    // Below 4,096 tokens the discount silently vanishes: no error, no warning,
    // no counter — the only symptom is a bill. So the margin is taken at 4.0
    // chars/token, already worse than the 3.567 measured on this model.
    const status = filingPrefixCacheStatus();
    assert.equal(status.clears, true);
    assert.ok(
      status.conservativeTokens >= IMPLICIT_CACHE_MIN_TOKENS,
      `conservative estimate ${status.conservativeTokens} < ${IMPLICIT_CACHE_MIN_TOKENS}`,
    );
    // A real margin, not a hair's breadth.
    assert.ok(status.conservativeTokens >= IMPLICIT_CACHE_MIN_TOKENS * 1.15);
  });

  it("REPORTS ITSELF AS AN ESTIMATE and must keep doing so", () => {
    // There is no local tokenizer and this is a pure leaf, so unlike
    // MONEY-1314's MEASURED_FIXED_PREFIX this is arithmetic over a character
    // count. Calling it measured would be a number vouching for a check nobody
    // ran.
    assert.equal(filingPrefixCacheStatus().estimated, true);
  });

  it("puts the FIXED prefix first — the ordering IS the cache", () => {
    const prompt = buildFilingInsightPrompt({
      text: "DOC",
      accession: "0001193125-26-378529",
    });
    assert.ok(prompt.startsWith(FILING_INSIGHT_FIXED_PREFIX));
    // ...and the variable part is strictly after it.
    assert.ok(
      prompt.indexOf("0001193125-26-378529") >
        FILING_INSIGHT_FIXED_PREFIX.length,
    );
  });

  it("is byte-identical across documents", () => {
    const a = buildFilingInsightPrompt({ text: "A", accession: "acc-a" });
    const b = buildFilingInsightPrompt({ text: "B", accession: "acc-b" });
    const n = FILING_INSIGHT_FIXED_PREFIX.length;
    assert.equal(a.slice(0, n), b.slice(0, n));
  });

  it("teaches the wrapped-label case with the real bytes", () => {
    // The single most consequential instruction in the prompt. If someone
    // trims the worked examples for length, this fails.
    assert.ok(FILING_INSIGHT_FIXED_PREFIX.includes("164,695"));
    assert.ok(
      FILING_INSIGHT_FIXED_PREFIX.includes("allowance for credit losses of"),
    );
    assert.ok(FILING_INSIGHT_FIXED_PREFIX.includes("$7,511"));
  });

  it("tells the model when it received a SELECTION rather than the document", () => {
    const whole = buildFilingInsightPrompt({ text: "X", truncated: false });
    const cut = buildFilingInsightPrompt({ text: "X", truncated: true });
    assert.ok(!whole.includes("too large to send whole"));
    assert.ok(cut.includes("too large to send whole"));
  });
});
