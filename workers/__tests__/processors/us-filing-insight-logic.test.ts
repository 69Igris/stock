/**
 * The sweep's DECISION and its idempotency — MONEY-1324 (P17).
 *
 * These assertions are on the PURE functions, not on the processor with a fake
 * analyser injected. That is deliberate: a test that injects a fake for the
 * unit under test cannot see mutations to what it replaced, and this repo has
 * already shipped nine assertions that passed against broken source for exactly
 * that reason. The processor's own seam behaviour is checked separately, and
 * only for the things a seam can be wrong about.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  decideInsightAction,
  isSameKnownHash,
  buildInsightWrite,
  buildInsightFailureWrite,
  buildInsightFailureUpdate,
  filingTextPath,
  notImplementedFilingAnalyser,
  readSeamUsage,
  FilingAnalyserNotWiredError,
  INSIGHT_READING_FIELDS,
  type FilingTextAnalysis,
  type InsightDecision,
} from "../../src/processors/us-filing-insight-logic";
import {
  INSIGHT_STATUS,
  SWEEP_ONLY_DOCUMENT_CLASS,
  type CohortDocument,
} from "../../src/processors/us-filing-insight-selectors-logic";
import {
  normaliseFilingInsight,
  type FilingInsight,
} from "@usemoney/core/market-data/filing-insight-logic";

/**
 * Fixtures go through the REAL normaliser.
 *
 * A hand-built `FilingInsight` literal can describe a shape the analyser
 * could never return — an absent array, a class outside the response schema —
 * and every assertion downstream would then be about a document that cannot
 * exist. `normaliseFilingInsight` is the only producer of this type in
 * production, so it is the only honest producer of it here.
 */
function insightOf(raw: Record<string, unknown>): FilingInsight {
  const insight = normaliseFilingInsight(raw);
  assert.ok(insight !== null, "fixture is not a readable insight");
  return insight;
}

/** The real document read from GCS while designing this. */
const DOC: CohortDocument = {
  id: "d1",
  accession: "0001193125-26-378529",
  sequence: 11,
  cik10: "0000866829",
  symbol: "HOS",
  form: "8-K",
  documentType: "EX-99.1",
  filedAt: new Date("2026-08-29"),
  items: ["1.01", "2.01", "5.01"],
  textPath: "edgar/text/0000866829/0001193125-26-378529/11.txt",
  textHash: "hash-A",
  extractionStatus: "PENDING",
};

/** A 6-K: no item numbers at all. */
const DOC_6K: CohortDocument = {
  ...DOC,
  id: "d2",
  form: "6-K",
  items: [],
  textHash: "hash-B",
};

/**
 * As prod ACTUALLY stores a GRAPHIC row: `textPath` and `textHash` are
 * EXPLICIT NULLS, present and holding null.
 *
 * This fixture used to omit both keys, on the (wrong) premise that
 * `Row.to_doc()` drops `None` for this collection. Measured on prod
 * 2026-09-02: 3,509 rows, `textPath` `$exists: true` on ALL of them, BSON null
 * on 1,963. See `us-filing-insight-isset-arms.test.ts` for the full census and
 * the root cause. `hasExtractedText`'s `typeof` test covers null and undefined
 * together, so the predicate was right for the wrong stated reason — which is
 * exactly why the fixture had to be corrected rather than the function.
 */
const DOC_NO_TEXT: CohortDocument = {
  id: "d3",
  accession: "0001193125-26-378529",
  sequence: 20,
  cik10: "0000866829",
  symbol: "HOS",
  form: "8-K",
  documentType: "GRAPHIC",
  filedAt: new Date("2026-08-29"),
  items: ["1.01"],
  textPath: null,
  textBytes: null,
  textHash: null,
  extractionStatus: "PENDING",
};

/**
 * Does this decision ask the processor to write a row?
 *
 * `InsightDecision` deliberately has NO channel for that any more, so this
 * reads the shape rather than a field: any key beyond `action`/`reason` is a
 * request the type is not supposed to be able to make. Written this way so
 * re-introducing `insightStatus` — or any other write-request field — turns
 * the cases below RED instead of silently passing on `undefined`.
 */
function hasWriteRequest(d: InsightDecision): boolean {
  return Object.keys(d).some((k) => k !== "action" && k !== "reason");
}

const ANALYSIS: FilingTextAnalysis = {
  insight: insightOf({
    documentClass: "FINANCIAL_STATEMENTS",
    classConfidence: "HIGH",
    summary: "Audited consolidated financial statements for FY2025.",
    keyPoints: ["Unqualified audit opinion"],
    registrant: "Hornbeck Offshore Services, Inc.",
    periodLabel: "Year ended December 31, 2025",
    periodEndDate: "2025-12-31",
    reportingCurrency: "USD",
    unitScale: "THOUSANDS",
    facts: [
      {
        label: "Total current assets",
        value: 257_009,
        periodLabel: "December 31, 2025",
        statementType: "BALANCE_SHEET",
        sourceLine: "  Total current assets   257,009   256,951",
      },
    ],
    statementTotals: [],
    events: [],
  }),
  modelId: "gemini-3-pro-preview",
  promptVersion: "p17-v1",
  analysedBytes: 42_000,
  usage: { promptTokens: 10_000, cachedTokens: 8_000, outputTokens: 900 },
};

describe("MONEY-1324 — decideInsightAction", () => {
  it("analyses a cohort document that has never been read", () => {
    const d = decideInsightAction(DOC, null);
    assert.equal(d.action, "analyse");
    assert.equal(d.reason, "never-analysed");
  });

  it("analyses a 6-K with EMPTY items — the founder decision", () => {
    // 1,256 6-K documents carry `items: []`. Any item-derived gate excludes
    // every one of them while looking like a narrower filter.
    const d = decideInsightAction(DOC_6K, null);
    assert.equal(
      d.action,
      "analyse",
      "the 6-K was refused; items must not gate",
    );
  });

  it("IDEMPOTENCY: the same textHash twice writes NOTHING", () => {
    // The headline requirement. Second delivery of the same message, or the
    // next night's sweep over an unchanged document.
    const d = decideInsightAction(DOC, {
      insightStatus: INSIGHT_STATUS.READY,
      sourceTextHash: "hash-A",
    });
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "unchanged-text");
    // A skip on unchanged text must write nothing at all — the row is already
    // correct and rewriting it moves `updatedAt` for nothing. That used to be
    // asserted as `d.insightStatus === undefined`, which was vacuous: the field
    // was never set on ANY path, so the assertion held for reasons unrelated to
    // unchanged text. It is now a property of the TYPE — see the decision-shape
    // case below.
    assert.equal(hasWriteRequest(d), false);
  });

  it("a CHANGED textHash re-analyses — a re-extraction is detectable", () => {
    const d = decideInsightAction(DOC, {
      insightStatus: INSIGHT_STATUS.READY,
      sourceTextHash: "hash-OLD",
    });
    assert.equal(d.action, "analyse");
    assert.equal(d.reason, "text-changed-or-retry");
  });

  it("a FAILED insight over unchanged text is RETRIED", () => {
    // FAILED is transient by construction. If unchanged-text skipped it too,
    // one model blip would drop the document permanently — the exact black
    // hole MONEY-1314 had to dig `stock_documents` out of.
    const d = decideInsightAction(DOC, {
      insightStatus: INSIGHT_STATUS.FAILED,
      sourceTextHash: "hash-A",
    });
    assert.equal(d.action, "analyse");
  });

  it("a SKIPPED insight over unchanged text is NOT retried", () => {
    // Terminal by content: re-reading identical bytes cannot change the answer,
    // so retrying buys the same non-answer on every sweep forever.
    const d = decideInsightAction(DOC, {
      insightStatus: INSIGHT_STATUS.SKIPPED,
      sourceTextHash: "hash-A",
    });
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "terminal-skipped");
  });

  it("a SKIPPED insight over CHANGED text IS retried", () => {
    // Separates "terminal" from "terminal forever". New bytes are a new
    // question.
    const d = decideInsightAction(DOC, {
      insightStatus: INSIGHT_STATUS.SKIPPED,
      sourceTextHash: "hash-OLD",
    });
    assert.equal(d.action, "analyse");
  });

  it("TWO ABSENT HASHES ARE NOT 'UNCHANGED'", () => {
    // The trap. `textHash` is `str | None` on the Python row and `to_doc()`
    // drops None, so absent is ordinary. If `undefined === undefined` counted
    // as unchanged, the FIRST sweep would write READY, the second would skip,
    // and every hash-less document would be permanently marked read with
    // nothing behind it.
    const hashless: CohortDocument = { ...DOC, textHash: undefined };
    const d = decideInsightAction(hashless, {
      insightStatus: INSIGHT_STATUS.READY,
      sourceTextHash: undefined,
    });
    assert.equal(
      d.action,
      "analyse",
      "two unknown hashes were treated as equal — a hash-less document would " +
        "be skipped forever with a READY row and no reading behind it",
    );
  });

  it("[control] isSameKnownHash rejects every absent/empty combination", () => {
    assert.equal(isSameKnownHash("a", "a"), true);
    assert.equal(isSameKnownHash("a", "b"), false);
    assert.equal(isSameKnownHash(undefined, undefined), false);
    assert.equal(isSameKnownHash(null, null), false);
    assert.equal(isSameKnownHash("", ""), false);
    assert.equal(isSameKnownHash("a", undefined), false);
    assert.equal(isSameKnownHash(undefined, "a"), false);
    assert.equal(isSameKnownHash("a", ""), false);
  });

  it("a document with no extracted text is skipped, and gets NO row", () => {
    const d = decideInsightAction(DOC_NO_TEXT, null);
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "no-extracted-text");
    assert.equal(
      hasWriteRequest(d),
      false,
      "a GRAPHIC row must not get an insight row — the table would stop " +
        "meaning 'documents we read' and its counts would stop being coverage",
    );
  });

  it("a missing document is skipped without a row", () => {
    const d = decideInsightAction(null, null);
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "document-not-found");
    assert.equal(hasWriteRequest(d), false);
  });

  it("NO skip path can request a row — the decision has no channel for one", () => {
    // The dead-capability finding, asserted structurally. `InsightDecision`
    // used to declare `insightStatus?: InsightStatus`, described as "the status
    // to record when the skip is a fact worth storing" — and nothing ever set
    // it, so `us-filing-insight.ts`'s `if (decision.insightStatus !== undefined)`
    // branch was unreachable code guarding a capability nobody wanted.
    //
    // Deleting the field turns "a skip writes nothing" from a claim in a
    // comment into a property of the type. This case is what keeps it deleted:
    // re-adding the field and setting it on any skip path turns this RED.
    const skips = [
      decideInsightAction(null, null),
      decideInsightAction(DOC_NO_TEXT, null),
      decideInsightAction({ ...DOC, documentType: "EX-10.1" }, null),
      decideInsightAction(DOC, {
        insightStatus: INSIGHT_STATUS.READY,
        sourceTextHash: "hash-A",
      }),
      decideInsightAction(DOC, {
        insightStatus: INSIGHT_STATUS.SKIPPED,
        sourceTextHash: "hash-A",
      }),
    ];
    for (const d of skips) {
      assert.equal(d.action, "skip", `expected a skip, got ${d.action}`);
      assert.equal(
        hasWriteRequest(d),
        false,
        `the decision for "${d.reason}" asks the processor to write a row. ` +
          "Every skip here is a reason NOT to write; the one skip that does " +
          "record a row (empty-text) is decided in the processor from the " +
          "bytes it read, which is the only place that fact exists.",
      );
    }
    // [control] the ANALYSE decisions are still analyse, so the loop above is
    // not passing because everything collapsed to one branch.
    assert.equal(decideInsightAction(DOC, null).action, "analyse");
  });

  it("an out-of-cohort document names WHY in the reason", () => {
    const d = decideInsightAction({ ...DOC, documentType: "EX-10.1" }, null);
    assert.equal(d.action, "skip");
    assert.match(d.reason, /out-of-cohort/);
    assert.match(d.reason, /EX-10\.1/);
  });

  it("`force` re-reads unchanged text but CANNOT conjure missing text", () => {
    // Order matters: force sits after the cohort gates and before staleness.
    assert.equal(
      decideInsightAction(
        DOC,
        { insightStatus: INSIGHT_STATUS.READY, sourceTextHash: "hash-A" },
        { force: true },
      ).action,
      "analyse",
    );
    assert.equal(
      decideInsightAction(DOC_NO_TEXT, null, { force: true }).action,
      "skip",
      "force reached a document with no text — there is nothing to read",
    );
  });

  it("force is compared to LITERAL true, so stray JSON cannot arm it", () => {
    // A Pub/Sub body is untrusted JSON. `force?: boolean` read as
    // `if (opts.force)` is armed by ANY truthy value the message carries —
    // "false", "off", 0.5, {} — and this job's force path re-pays for a
    // document that is already correctly read.
    //
    // `force: false` alone does NOT test this: it is falsy under both
    // spellings, so a test using it passes against the broken comparison.
    // Mutation-verified — `=== true` -> truthy left all 27 cases green until
    // this case existed.
    const unchanged = {
      insightStatus: INSIGHT_STATUS.READY,
      sourceTextHash: "hash-A",
    };
    for (const stray of ["false", "off", 1, {}, []] as unknown[]) {
      assert.equal(
        decideInsightAction(DOC, unchanged, {
          force: stray as boolean,
        }).action,
        "skip",
        `a stray ${JSON.stringify(stray)} armed force — the comparison is ` +
          "truthiness, not `=== true`",
      );
    }
    // ...and the real thing still works.
    assert.equal(
      decideInsightAction(DOC, unchanged, { force: true }).action,
      "analyse",
    );
    assert.equal(
      decideInsightAction(DOC, unchanged, { force: false }).action,
      "skip",
    );
  });
});

describe("MONEY-1324 — the write payload", () => {
  it("carries provenance: model, promptVersion and the SOURCE hash", () => {
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: ANALYSIS,
      analysedAt: new Date("2026-09-02T00:00:00Z"),
    });
    assert.equal(row.model, "gemini-3-pro-preview");
    assert.equal(row.promptVersion, "p17-v1");
    assert.equal(
      row.sourceTextHash,
      "hash-A",
      "without the source hash the next sweep cannot tell an unchanged " +
        "document from a re-extracted one, and idempotency is gone",
    );
    assert.equal(row.insightStatus, INSIGHT_STATUS.READY);
    assert.equal(row.documentClass, "FINANCIAL_STATEMENTS");
  });

  it("keys the row on (accession, sequence) — the document's own key", () => {
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: ANALYSIS,
      analysedAt: new Date(),
    });
    assert.equal(row.accession, "0001193125-26-378529");
    assert.equal(row.sequence, 11);
    // `documentId` rides along for tracing and is NOT the key — a required
    // relation whose target is missing throws and blanks every result.
    assert.equal(row.documentId, "objid-1");
  });

  it("stores the VALIDATED shape — facts/statementTotals/events, unaltered", () => {
    // THE ALIGNMENT THIS INTEGRATION EXISTS FOR. The row must carry the same
    // three collections the analyser's two validators operate on
    // (`checkFactsGrounded` reads `facts` and each total's `components`;
    // `checkTotalsCrossFoot` reads `statementTotals`). Re-shaping them into
    // per-class blocks on the way to the database would leave a row that
    // looks validated and was not — the validation would then protect
    // nothing, invisibly from both ends.
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: ANALYSIS,
      analysedAt: new Date(),
    });

    assert.deepEqual(row.facts, ANALYSIS.insight.facts);
    assert.deepEqual(row.statementTotals, ANALYSIS.insight.statementTotals);
    assert.deepEqual(row.events, ANALYSIS.insight.events);

    // The shape that could not be checked, gone for good. A reader who
    // "improves" these back into typed blocks silently un-validates the table.
    for (const gone of ["earnings", "guidance", "statements", "transaction"]) {
      assert.equal(
        gone in row,
        false,
        `${gone} is being written again. That column shape is NOT what either ` +
          "validator reads, so storing it makes the checks decorative.",
      );
    }

    // ...and nothing the analyser cannot produce is invented for the row.
    for (const unfillable of ["headline", "tickersMentioned"]) {
      assert.equal(
        unfillable in row,
        false,
        `${unfillable} was written, but nothing produces it — the response ` +
          "schema has no such field. A column its only writer cannot fill is " +
          "a permanent null that reads as a real, negative answer.",
      );
    }
  });

  it("an EMPTY list is written, not omitted — `[]` is a real answer", () => {
    // A proxy circular genuinely prints no statement totals. `[]` says that
    // and is queryable; an absent key is indistinguishable from a row written
    // before the column existed, which on Mongo is unreachable in BOTH
    // directions (MONEY-1050/1205/1234/1235/1236).
    const row = buildInsightWrite({
      doc: DOC_6K,
      documentId: "objid-2",
      analysis: {
        ...ANALYSIS,
        insight: insightOf({
          documentClass: "PROXY_OR_MEETING",
          summary: "Notice of special meeting.",
        }),
      },
      analysedAt: new Date(),
    });
    assert.deepEqual(row.facts, []);
    assert.deepEqual(row.statementTotals, []);
    assert.deepEqual(row.events, []);
    assert.ok("facts" in row && "statementTotals" in row && "events" in row);
  });

  it("carries the UNITS, because figures are stored AS PRINTED", () => {
    // `FilingFact` has no per-value currency or scale — the document states
    // them once, in its units header, and so does the row. Without these two
    // columns a `facts` array is a column of numbers that may be off by
    // 1,000x with nothing on the row to reveal it.
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: ANALYSIS,
      analysedAt: new Date(),
    });
    assert.equal(row.unitScale, "THOUSANDS");
    assert.equal(row.reportingCurrency, "USD");
    assert.equal(row.classConfidence, "HIGH");
    assert.equal(row.periodEndDate, "2025-12-31");
    assert.equal(row.registrant, "Hornbeck Offshore Services, Inc.");
  });

  it("a document that states no units still carries a NAMED scale", () => {
    // "UNKNOWN", never absent. A missing scale would be read as "units" by
    // the first consumer that assumes a default, which is the same class of
    // defect as a currency-less amount.
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: {
        ...ANALYSIS,
        insight: insightOf({ documentClass: "PRESS_RELEASE", summary: "s" }),
      },
      analysedAt: new Date(),
    });
    assert.equal(row.unitScale, "UNKNOWN");
    // ...while a field the document genuinely did not state is ABSENT.
    assert.equal("reportingCurrency" in row, false);
    assert.equal("periodEndDate" in row, false);
    assert.equal("registrant" in row, false);
  });

  it("a MISCLASSIFIED document degrades to fewer fields, never an error", () => {
    // The founder decision, exercised through the REAL degradation path: a
    // response the normaliser could barely read becomes OTHER/LOW with three
    // empty lists, and that is a legal, storable answer.
    const bare: FilingTextAnalysis = {
      insight: insightOf({ documentClass: "NOT_A_REAL_CLASS" }),
      modelId: "m",
      promptVersion: "p17-v1",
    };
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: bare,
      analysedAt: new Date(),
    });
    assert.equal(row.documentClass, "OTHER");
    assert.equal(
      row.classConfidence,
      "LOW",
      "an unrecognised class kept the model's confidence — that confidence " +
        "referred to a class we did not accept",
    );
    assert.equal(row.insightStatus, INSIGHT_STATUS.READY);
    assert.deepEqual(row.keyPoints, []);
    assert.equal(row.summary, "");
    // The sweep's sentinel is NOT reachable from a reading: it marks an
    // attempt with nothing behind it, and the model's schema cannot emit it.
    assert.notEqual(row.documentClass, SWEEP_ONLY_DOCUMENT_CLASS);
    for (const absent of ["registrant", "periodLabel", "periodEndDate"]) {
      assert.equal(absent in row, false, `${absent} appeared from nowhere`);
    }
  });

  it("omits sourceTextHash when the document has none", () => {
    // A fabricated empty string would make the NEXT sweep read "same bytes"
    // against another hash-less document and skip it.
    const row = buildInsightWrite({
      doc: { ...DOC, textHash: undefined },
      documentId: "objid-1",
      analysis: ANALYSIS,
      analysedAt: new Date(),
    });
    assert.equal("sourceTextHash" in row, false);
  });

  it("lists are always set — `[]` is queryable where null is not", () => {
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "objid-1",
      analysis: {
        insight: insightOf({ documentClass: "OTHER" }),
        modelId: "m",
        promptVersion: "v",
      },
      analysedAt: new Date(),
    });
    assert.deepEqual(row.keyPoints, []);
    assert.deepEqual(row.facts, []);
  });

  it("a FAILED row does NOT stamp the source hash", () => {
    // The whole point. Stamping it would make the next sweep read "same bytes,
    // already handled" and never retry — a transient model error becoming
    // permanent, silently.
    const row = buildInsightFailureWrite({
      doc: DOC,
      documentId: "objid-1",
      status: INSIGHT_STATUS.FAILED,
      reason: "model call timed out",
      attemptedAt: new Date(),
    });
    assert.equal(row.insightStatus, INSIGHT_STATUS.FAILED);
    assert.equal(
      "sourceTextHash" in row,
      false,
      "a FAILED attempt stamped the hash — the retry path is now dead",
    );
    assert.equal(row.failureReason, "model call timed out");
    assert.equal(row.documentClass, SWEEP_ONLY_DOCUMENT_CLASS);
    // NO reading at all — absent, not `[]`. An empty list is a reading that
    // found nothing; this row is not a reading, and the two must stay
    // distinguishable or "we read it and it was empty" becomes the same
    // query result as "the model call blew up".
    for (const absent of ["facts", "statementTotals", "events"]) {
      assert.equal(
        absent in row,
        false,
        `a FAILED row carries ${absent} — an attempt is claiming a reading`,
      );
    }
  });

  it("the UPDATE payload RETRACTS a previous reading; the create omits it", () => {
    // The finding: "no facts/totals/events at all" holds on a CREATE and is
    // FALSE on an UPDATE. `upsert({create: row, update: row})` writes nothing
    // for an omitted key, so re-failing a document that was previously READY
    // left `insightStatus: FAILED` and `documentClass: UNCLASSIFIED` sitting on
    // top of the OLD `facts`, `summary` and token counts — a row claiming
    // nothing while carrying everything.
    const create = buildInsightFailureWrite({
      doc: DOC,
      documentId: "objid-1",
      status: INSIGHT_STATUS.FAILED,
      reason: "model call timed out",
      attemptedAt: new Date(),
    });
    const update = buildInsightFailureUpdate(create);

    // The CREATE is unchanged: absent, never `[]`, never null.
    for (const field of ["facts", "statementTotals", "events", "summary"]) {
      assert.equal(field in create, false, `create carries ${field}`);
    }
    // The UPDATE retracts every one of them, with Mongo's `unset` so the
    // cleared row has the same ABSENT shape a fresh failure row has — a null
    // would be unqueryable in both directions, which is the shape
    // `buildInsightWrite` goes out of its way never to store.
    for (const field of INSIGHT_READING_FIELDS) {
      assert.deepEqual(
        update[field],
        { unset: true },
        `the failure UPDATE does not retract ${field}; a previously-READY row ` +
          "keeps it under UNCLASSIFIED/FAILED",
      );
    }
    // Everything the failure row DOES claim survives verbatim.
    assert.equal(update.insightStatus, INSIGHT_STATUS.FAILED);
    assert.equal(update.documentClass, SWEEP_ONLY_DOCUMENT_CLASS);
    assert.equal(update.failureReason, "model call timed out");
    assert.deepEqual(update.keyPoints, []);
  });

  it("a SKIPPED row's legitimate hash SURVIVES the retraction", () => {
    // The clear is driven by what the CREATE payload omits, not by a second
    // list — so the one field a SKIPPED row is entitled to keep is kept, and
    // the rule is stated once. A hardcoded "always unset sourceTextHash" would
    // make every SKIPPED document re-discovered on every sweep forever.
    const create = buildInsightFailureWrite({
      doc: DOC,
      documentId: "objid-1",
      status: INSIGHT_STATUS.SKIPPED,
      reason: "empty-text",
      attemptedAt: new Date(),
    });
    const update = buildInsightFailureUpdate(create);
    assert.equal(update.sourceTextHash, "hash-A");
    assert.notDeepEqual(update.sourceTextHash, { unset: true });
    // ...while the reading fields it does NOT carry are still retracted.
    assert.deepEqual(update.facts, { unset: true });
  });

  it("[derived] INSIGHT_READING_FIELDS is exactly what a READING adds", () => {
    // The list is not hand-maintained against memory: it is checked against
    // the two builders. A new column on `buildInsightWrite` that nobody adds
    // here turns this RED on the day it lands, rather than a quarter later
    // when somebody notices a FAILED row carrying facts.
    const reading = buildInsightWrite({
      doc: DOC,
      documentId: "o",
      analysis: ANALYSIS,
      analysedAt: new Date(),
    });
    const failure = buildInsightFailureWrite({
      doc: DOC,
      documentId: "o",
      status: INSIGHT_STATUS.FAILED,
      reason: "boom",
      attemptedAt: new Date(),
    });
    const extra = Object.keys(reading)
      .filter((k) => !(k in failure))
      .sort();
    assert.deepEqual(
      [...INSIGHT_READING_FIELDS].sort(),
      extra,
      "INSIGHT_READING_FIELDS and the builders disagree. Every column a " +
        "reading sets and a failure does not MUST be retracted on an update, " +
        "or a re-failed row keeps it.",
    );
    assert.ok(extra.length > 0, "[control] the two payloads are identical");
  });

  it("readSeamUsage recovers what a REFUSED call already spent", () => {
    // A rejection is a completed, BILLED model call — the checks refused its
    // answer, the tokens are gone either way. Dropping the usage made the
    // FAILED row and its metric report zero, so a prompt regression that
    // refused every reading read as FREE on the one surface that would show it.
    assert.deepEqual(
      readSeamUsage(
        Object.assign(new Error("refused"), {
          usage: {
            promptTokens: 12_000,
            cachedTokens: 4_000,
            outputTokens: 900,
          },
        }),
      ),
      { promptTokens: 12_000, cachedTokens: 4_000, outputTokens: 900 },
    );
  });

  it("readSeamUsage answers null rather than a fabricated zero", () => {
    // "the call spent nothing" and "we do not know what the call spent" are
    // different claims, and a transport throw that never got an answer must
    // make the second one. A zero here would be a measurement we did not take.
    assert.equal(readSeamUsage(new Error("vertex unreachable")), null);
    assert.equal(readSeamUsage(null), null);
    assert.equal(readSeamUsage("boom"), null);
    assert.equal(
      readSeamUsage(Object.assign(new Error("x"), { usage: null })),
      null,
    );
    assert.equal(
      readSeamUsage(Object.assign(new Error("x"), { usage: {} })),
      null,
    );
    // Non-finite and negative counts are not measurements either.
    assert.equal(
      readSeamUsage(
        Object.assign(new Error("x"), { usage: { promptTokens: Number.NaN } }),
      ),
      null,
    );
    assert.equal(
      readSeamUsage(
        Object.assign(new Error("x"), { usage: { promptTokens: -1 } }),
      ),
      null,
    );
    // A PARTIAL usage is still a measurement of the part it names.
    assert.deepEqual(
      readSeamUsage(
        Object.assign(new Error("x"), { usage: { outputTokens: 7 } }),
      ),
      { promptTokens: undefined, cachedTokens: undefined, outputTokens: 7 },
    );
  });

  it("a SKIPPED row DOES stamp the source hash", () => {
    // Terminal by content: the hash is what makes "these exact bytes are not
    // analysable" a durable finding rather than a nightly re-discovery.
    const row = buildInsightFailureWrite({
      doc: DOC,
      documentId: "objid-1",
      status: INSIGHT_STATUS.SKIPPED,
      reason: "no analysable content",
      attemptedAt: new Date(),
    });
    assert.equal(row.sourceTextHash, "hash-A");
  });

  it("[join] a FAILED row is re-selected and a SKIPPED row is not", () => {
    // The two builders and the decision function, checked TOGETHER. Each half
    // can be right while the pair is wrong.
    const failed = buildInsightFailureWrite({
      doc: DOC,
      documentId: "o",
      status: INSIGHT_STATUS.FAILED,
      reason: "boom",
      attemptedAt: new Date(),
    });
    const skipped = buildInsightFailureWrite({
      doc: DOC,
      documentId: "o",
      status: INSIGHT_STATUS.SKIPPED,
      reason: "nothing to read",
      attemptedAt: new Date(),
    });

    assert.equal(
      decideInsightAction(DOC, {
        insightStatus: failed.insightStatus as string,
        sourceTextHash: failed.sourceTextHash as string | undefined,
      }).action,
      "analyse",
    );
    assert.equal(
      decideInsightAction(DOC, {
        insightStatus: skipped.insightStatus as string,
        sourceTextHash: skipped.sourceTextHash as string | undefined,
      }).action,
      "skip",
    );
  });

  it("[join] a READY row written by buildInsightWrite skips on re-read", () => {
    // Round-trip: what the writer stores must satisfy the decision's
    // unchanged-text test, or the sweep re-analyses everything every night.
    const row = buildInsightWrite({
      doc: DOC,
      documentId: "o",
      analysis: ANALYSIS,
      analysedAt: new Date(),
    });
    const d = decideInsightAction(DOC, {
      insightStatus: row.insightStatus as string,
      sourceTextHash: row.sourceTextHash as string,
    });
    assert.equal(
      d.action,
      "skip",
      "a freshly-written row does not satisfy its own skip test",
    );
    assert.equal(d.reason, "unchanged-text");
  });

  it("truncates an unbounded failure reason", () => {
    const row = buildInsightFailureWrite({
      doc: DOC,
      documentId: "o",
      status: INSIGHT_STATUS.FAILED,
      reason: "x".repeat(5000),
      attemptedAt: new Date(),
    });
    assert.equal((row.failureReason as string).length, 500);
  });
});

describe("MONEY-1324 — the analysis seam", () => {
  it("the stub THROWS rather than returning an empty reading", () => {
    // Returning `{documentClass: UNCLASSIFIED}` would be friendlier and wrong:
    // the sweep would stamp READY over the whole cohort, the queue would
    // drain, the counters would look healthy, and the table would fill with
    // rows nothing had read.
    assert.throws(
      () =>
        notImplementedFilingAnalyser({
          accession: "a",
          sequence: 1,
          cik10: "c",
          symbol: null,
          form: "8-K",
          documentType: "EX-99.1",
          filedAt: new Date(),
          items: [],
          text: "x",
          textHash: null,
        }),
      FilingAnalyserNotWiredError,
    );
  });

  it("filingTextPath returns the object key, or null when there is none", () => {
    assert.equal(
      filingTextPath(DOC),
      "edgar/text/0000866829/0001193125-26-378529/11.txt",
    );
    assert.equal(filingTextPath(DOC_NO_TEXT), null);
    assert.equal(filingTextPath({ ...DOC, textPath: "" }), null);
  });
});

describe("MONEY-1324 — the seam boundary holds", () => {
  // The sibling that owns the prompt and the section selection implements
  // `FilingTextAnalyser`. This ticket owns everything on THIS side of it.
  //
  // A scan, not a convention, because the failure is invisible: a direct model
  // import in the sweep would work perfectly and quietly make the cohort,
  // idempotency and provenance behaviour untestable without a model — which is
  // the property the seam exists to buy. Same shape as this repo's other
  // boundary scans (`no-feed-fetch-bypass`, the screener robots.txt scan).
  const SRC = join(import.meta.dirname, "..", "..", "src", "processors");

  /** Strip comments, so PROSE naming a forbidden import cannot fail the scan
   *  and a commented-out one cannot pass it. This file's own siblings describe
   *  the things they forbid, at length. */
  const codeOf = (f: string): string =>
    readFileSync(join(SRC, f), "utf8")
      .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  const FORBIDDEN = [
    /from\s+["'][^"']*gemini[^"']*["']/i,
    /from\s+["'][^"']*model-registry[^"']*["']/i,
    /from\s+["']@google\//i,
    /from\s+["'][^"']*page-select[^"']*["']/i,
  ];

  for (const file of [
    "us-filing-insight.ts",
    "us-filing-insight-logic.ts",
    "us-filing-insight-selectors-logic.ts",
  ]) {
    it(`${file} does not reach around the analyser seam`, () => {
      const code = codeOf(file);
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(
          code,
          pattern,
          `${file} imports a model/prompt module (${pattern}). The analysis ` +
            "is behind FilingTextAnalyser; importing it here couples the " +
            "sweep to a prompt and makes its own behaviour untestable " +
            "without a model.",
        );
      }
    });
  }

  it("the ADAPTER is the only file allowed to touch both sides", () => {
    // `us-filing-insight-analyser.ts` imports the model lane BY DESIGN — that
    // is what an adapter is. The property worth checking is that it is the
    // ONLY one, and that it stays on the analysis side of the sweep: no
    // Prisma, no GCS, no decision of its own. A second bridging file is how a
    // seam stops being a seam.
    const adapter = codeOf("us-filing-insight-analyser.ts");
    assert.match(
      adapter,
      /from\s+["']\.\.\/lib\/gemini-filing-insight["']/,
      "the adapter no longer calls the analyser — the seam is unwired",
    );
    for (const forbidden of [
      /from\s+["']@usemoney\/database["']/,
      /from\s+["']\.\.\/lib\/gcs["']/,
    ]) {
      assert.doesNotMatch(
        adapter,
        forbidden,
        `the adapter took on I/O (${forbidden}). Reading rows and objects is ` +
          "the processor's job; mixing them here puts the sweep's own " +
          "behaviour back behind a model call.",
      );
    }
  });

  it("[control] the scan detects a forbidden import when one is present", () => {
    // Without this, a broken regex would report every file clean while
    // checking nothing — the vacuity these scans exist to avoid.
    const planted = 'import { x } from "../lib/gemini-pdf";';
    assert.ok(
      FORBIDDEN.some((p) => p.test(planted)),
      "the scan cannot detect the very shape it forbids",
    );
  });

  it("the PURE modules import no I/O at all", () => {
    // `-logic.ts` files in this repo are pure by contract: no Prisma, no GCS,
    // no clock. That is what lets the decision tests run without a database.
    for (const file of [
      "us-filing-insight-logic.ts",
      "us-filing-insight-selectors-logic.ts",
    ]) {
      const code = codeOf(file);
      for (const pattern of [
        /from\s+["']@usemoney\/database["']/,
        /from\s+["']\.\.\/lib\/gcs["']/,
        /\bDate\.now\(\)/,
      ]) {
        assert.doesNotMatch(
          code,
          pattern,
          `${file} took on I/O or a clock (${pattern})`,
        );
      }
    }
  });

  it("the I/O shell DOES default the analyser to the throwing stub", () => {
    // The one thing that keeps an unwired deployment from stamping READY over
    // the whole cohort. Asserted against the source because wiring it up in a
    // test would require Prisma.
    const shell = codeOf("us-filing-insight.ts");
    assert.match(
      shell,
      /analyser\s*\?\?\s*notImplementedFilingAnalyser/,
      "the processor no longer defaults to the stub — an unwired deploy would " +
        "write insights nothing had read",
    );
  });
});
