/**
 * THE ADAPTER's own mapping — MONEY-1324 (P17).
 *
 * `us-filing-insight-e2e.test.ts` drives this module through the real
 * processor and the real analyser, which is where the wiring is proved. This
 * file covers the parts of the mapping that a happy path never reaches: the
 * failure classification, the issue summary an operator reads off a FAILED
 * row, and the date guard.
 *
 * They are small and they are exactly the kind of code that is written once
 * and never executed again until the night it matters.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseFilingInsight,
  FILING_INSIGHT_PROMPT_VERSION,
  type FilingIssue,
} from "@usemoney/core/market-data/filing-insight-logic";

import {
  FilingAnalysisRejectedError,
  MAX_REPORTED_ISSUES,
  createFilingInsightAnalyser,
  describeFilingIssues,
  isRetryableFilingFailure,
  isoFilingDate,
  toFilingTextAnalysis,
} from "../../src/processors/us-filing-insight-analyser";
import { isUpstreamSeamFailure } from "../../src/processors/us-filing-insight-logic";
import type { FilingAnalysisResult } from "../../src/lib/gemini-filing-insight";

const INSIGHT = normaliseFilingInsight({
  documentClass: "PRESS_RELEASE",
  classConfidence: "MEDIUM",
  summary: "A press release.",
})!;

function resultOf(over: Partial<FilingAnalysisResult>): FilingAnalysisResult {
  return {
    ok: true,
    insight: INSIGHT,
    validation: { ok: true, issues: [], checkedValues: 0, checkedTotals: 0 },
    selection: {
      reason: "all-fit",
      totalSections: 3,
      selectedSectionIndexes: [0, 1, 2],
      sentChars: 4_200,
      documentChars: 4_200,
      droppedForBudget: 0,
      truncated: false,
    },
    model: "gemini-3.5-flash",
    usage: {
      promptTokens: 1_000,
      candidatesTokens: 200,
      totalTokens: 1_200,
      cachedTokens: 800,
      thinkingTokens: 0,
    },
    failure: null,
    error: null,
    elapsedMs: 12,
    ...over,
  };
}

describe("MONEY-1324 — the adapter's mapping", () => {
  it("forwards the VALIDATED insight untouched", () => {
    const mapped = toFilingTextAnalysis(resultOf({}));
    assert.equal(
      mapped.insight,
      INSIGHT,
      "the insight was copied or re-shaped. The row must be the object the " +
        "checks passed, not a reconstruction of it.",
    );
  });

  it("maps candidatesTokens -> outputTokens and sentChars -> analysedBytes", () => {
    // Two renames that read as cosmetic and are not. Gemini spells output
    // tokens `candidates`; a wrong mapping reads 0 forever, which is
    // indistinguishable from a model that emitted nothing.
    const mapped = toFilingTextAnalysis(resultOf({}));
    assert.equal(mapped.usage?.outputTokens, 200);
    assert.equal(mapped.usage?.promptTokens, 1_000);
    assert.equal(mapped.usage?.cachedTokens, 800);
    assert.equal(mapped.analysedBytes, 4_200);
  });

  it("stamps the prompt version the PROMPT MODULE declares", () => {
    // Restating the string here would be one fact in two places, and the copy
    // that drifts is always the one stamped onto the rows.
    assert.equal(
      toFilingTextAnalysis(resultOf({})).promptVersion,
      FILING_INSIGHT_PROMPT_VERSION,
    );
  });

  it("THROWS on ok:false, even with an insight in hand", () => {
    // The whole contract. A refused reading is the easy thing to store: the
    // row looks completely normal and the only trace is a `validation` object
    // nobody keeps.
    const issues: FilingIssue[] = [
      {
        kind: "ungrounded-value",
        message: '"Total revenues" reports 1 which does not appear',
        label: "Total revenues",
        value: 1,
      },
    ];
    assert.throws(
      () =>
        toFilingTextAnalysis(
          resultOf({
            ok: false,
            validation: { ok: false, issues, checkedValues: 4, checkedTotals: 1 },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof FilingAnalysisRejectedError);
        assert.match(err.message, /ungrounded-value/);
        assert.match(err.message, /checkedValues=4/);
        return true;
      },
    );
  });

  it("THROWS when there is no insight at all", () => {
    assert.throws(
      () =>
        toFilingTextAnalysis(
          resultOf({
            ok: false,
            insight: null,
            validation: null,
            failure: "FILING_ANALYSIS_UNPARSEABLE",
            error: "response was not a JSON object",
          }),
        ),
      FilingAnalysisRejectedError,
    );
  });

  it("tags an UPSTREAM failure so a dead Gemini is not a bad document", () => {
    // `transportFailures` vs `failed`. Only one of them means our data is at
    // fault, and a blocked upstream reported as row failures is the shape that
    // hid Tickertape's block for five months.
    for (const failure of [
      "FILING_ANALYSIS_CALL_FAILED",
      "FILING_ANALYSIS_UNCONFIGURED",
    ] as const) {
      try {
        toFilingTextAnalysis(resultOf({ ok: false, insight: null, failure }));
        assert.fail(`${failure} did not throw`);
      } catch (err) {
        assert.equal(isUpstreamSeamFailure(err), true, `${failure} not tagged`);
      }
    }

    // ...and a reading we simply disbelieved is NOT the upstream's fault.
    for (const failure of [
      "FILING_ANALYSIS_UNPARSEABLE",
      "FILING_ANALYSIS_EMPTY_INPUT",
      null,
    ] as const) {
      try {
        toFilingTextAnalysis(resultOf({ ok: false, insight: null, failure }));
        assert.fail("did not throw");
      } catch (err) {
        assert.equal(
          isUpstreamSeamFailure(err),
          false,
          `${failure} was blamed on the upstream`,
        );
      }
    }
  });

  it("[control] a plain Error is never read as an upstream failure", () => {
    // The duck-type must not accept anything that merely throws — an
    // unclassified failure counts as a row failure, which is the safe answer.
    assert.equal(isUpstreamSeamFailure(new Error("boom")), false);
    assert.equal(isUpstreamSeamFailure(null), false);
    assert.equal(isUpstreamSeamFailure({ upstreamFailure: "yes" }), false);
    assert.equal(isUpstreamSeamFailure({ upstreamFailure: true }), true);
  });

  it("classifies which failures a retry could help", () => {
    assert.equal(isRetryableFilingFailure("FILING_ANALYSIS_CALL_FAILED"), true);
    assert.equal(isRetryableFilingFailure("FILING_ANALYSIS_UNCONFIGURED"), true);
    assert.equal(isRetryableFilingFailure("FILING_ANALYSIS_UNPARSEABLE"), false);
    assert.equal(isRetryableFilingFailure("FILING_ANALYSIS_EMPTY_INPUT"), false);
    assert.equal(isRetryableFilingFailure(null), true);
  });

  it("bounds the issue summary — it lands in a 500-char column", () => {
    const many: FilingIssue[] = Array.from({ length: 9 }, (_, i) => ({
      kind: "ungrounded-value",
      message: `issue ${i}`,
      label: `l${i}`,
      value: i,
    }));
    const described = describeFilingIssues(many);
    assert.match(described, /issue 0/);
    assert.match(described, new RegExp(`\\+${9 - MAX_REPORTED_ISSUES} more`));
    assert.doesNotMatch(described, /issue 8/);
    assert.equal(describeFilingIssues([]), "no issues reported");
  });
});

describe("MONEY-1324 — the adapter's date guard", () => {
  it("an INVALID date becomes absent, never a date the filing never had", () => {
    // `toISOString()` on an Invalid Date THROWS, so without the guard one
    // malformed `filedAt` fails a document whose text is perfectly readable.
    // Absent is a state the prompt already handles — `buildFilingContext`
    // omits the line — and a wrong date is one it cannot.
    assert.equal(isoFilingDate(new Date("not a date")), null);
    assert.equal(isoFilingDate(null), null);
    assert.equal(isoFilingDate(undefined), null);
    assert.equal(
      isoFilingDate("2026-08-29" as unknown as Date),
      null,
      "a string was accepted as a Date",
    );
    assert.equal(isoFilingDate(new Date("2026-08-29T00:00:00Z")), "2026-08-29");
  });

  it("a document with an unreadable filedAt is still ANALYSED", () => {
    // The join: the guard is only worth having if the document survives it.
    let sawFiledAt: unknown = "unset";
    const analyser = createFilingInsightAnalyser({
      deps: {
        generate: async (request) => {
          sawFiledAt = /Filed: /.test(request.prompt);
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        documentClass: "PRESS_RELEASE",
                        classConfidence: "HIGH",
                        summary: "A press release about nothing in particular.",
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: {},
          };
        },
      },
    });

    return analyser({
      accession: "0001193125-26-000001",
      sequence: 2,
      cik10: "0000320193",
      symbol: null,
      form: "8-K",
      documentType: "EX-99.1",
      filedAt: new Date("not a date"),
      items: [],
      text: "A press release about nothing in particular. It says very little.",
      textHash: null,
    }).then((analysis) => {
      assert.equal(analysis.insight.documentClass, "PRESS_RELEASE");
      assert.equal(
        sawFiledAt,
        false,
        "the prompt carried a Filed: line built from an unreadable date",
      );
    });
  });
});
