/**
 * ONE REAL DOCUMENT, PENDING -> READY, OFFLINE — MONEY-1324 (P17).
 *
 * Source under test: `processUsFilingInsight` (the I/O shell),
 * `createFilingInsightAnalyser` (the adapter), and everything the adapter
 * calls — section selection, prompt assembly, response normalisation and BOTH
 * validators. The ONLY thing replaced is the Gemini round trip and the two
 * Prisma delegates.
 *
 * ## Why this file exists at all
 *
 * Every other test in this ticket drives a pure function or injects a fake at
 * the seam it is testing. Both are right, and neither can see the class of
 * defect that made this ticket an INTEGRATION rather than a build: a piece
 * that works perfectly and is connected to the wrong thing. The sweep stored
 * `earnings/guidance/statements/transaction`; the analyser produced and
 * checked `facts/statementTotals/events`; each half had passing tests; the
 * pair would have written rows that were never validated, and nothing in
 * either suite could have said so.
 *
 * So the seam here is pushed down as far as it can go while staying offline:
 * the ONE model call (`FilingAnalysisDeps.generate`). Everything above it runs
 * for real, against text SEC actually served.
 *
 * ## The fixtures are real documents
 *
 *   hlx-8k-ex991-statements.txt  Hornbeck Offshore's audited consolidated
 *                               statements attached to a MERGER 8-K — the
 *                               document that shaped the schema, because an
 *                               EX-99.1 is usually assumed to be an earnings
 *                               release and this one is not.
 *   bip-6k-ex992-circular.txt    a Brookfield 6-K meeting circular. `items` is
 *                               `[]`, as it is on all 1,256 6-K documents,
 *                               because a foreign private issuer files no item
 *                               numbers.
 *
 * The balance-sheet figures below are the document's own and they CROSS-FOOT
 * exactly: 54,167 + 164,695 + 4,941 + 19,026 + 14,180 = 257,009. That is not
 * decoration — a stub answer with invented numbers would be refused by the
 * grounding check, so the only stub that can reach the happy path is one that
 * reads the document correctly.
 *
 * MUTATION-VERIFIED. Each `MUTATION:` note names the source edit applied,
 * confirmed RED, and reverted.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "@usemoney/database";
import { SEC_SOURCE, buildEventId } from "@usemoney/core/events/event-types";
import {
  FILING_INSIGHT_PROMPT_VERSION,
  indexSourceFigures,
} from "@usemoney/core/market-data/filing-insight-logic";
import {
  normaliseFilingText,
  selectSectionsForAnalysis,
} from "@usemoney/core/market-data/filing-section-select-logic";

import { processUsFilingInsight } from "../../src/processors/us-filing-insight";
import { createFilingInsightAnalyser } from "../../src/processors/us-filing-insight-analyser";
import {
  INSIGHT_STATUS,
  type CohortDocument,
} from "../../src/processors/us-filing-insight-selectors-logic";

// ── the fixtures ────────────────────────────────────────────────────────────

const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "core",
  "__tests__",
  "fixtures",
  "edgar-text",
);

const HLX_TEXT = readFileSync(
  join(FIXTURES, "hlx-8k-ex991-statements.txt"),
  "utf8",
);
const BIP_TEXT = readFileSync(
  join(FIXTURES, "bip-6k-ex992-circular.txt"),
  "utf8",
);

const HLX_DOC: CohortDocument = {
  id: "doc-hlx",
  accession: "0001193125-26-378529",
  sequence: 11,
  cik10: "0000866829",
  symbol: "HOS",
  form: "8-K",
  documentType: "EX-99.1",
  filedAt: new Date("2026-08-29T00:00:00Z"),
  items: ["1.01", "2.01", "5.01"],
  textPath: "edgar/text/0000866829/0001193125-26-378529/11.txt",
  textBytes: HLX_TEXT.length,
  textHash: "sha256-hlx-v1",
  extractionStatus: "PENDING",
};

/** A 6-K. `items: []` — the case an item-gated filter excludes silently. */
const BIP_DOC: CohortDocument = {
  id: "doc-bip",
  accession: "0001193125-26-401122",
  sequence: 3,
  cik10: "0001406234",
  symbol: "BIP",
  form: "6-K",
  documentType: "EX-99.2",
  filedAt: new Date("2026-08-26T00:00:00Z"),
  items: [],
  textPath: "edgar/text/0001406234/0001193125-26-401122/3.txt",
  textBytes: BIP_TEXT.length,
  textHash: "sha256-bip-v1",
  extractionStatus: "PENDING",
};

const TEXT_BY_PATH: Record<string, string> = {
  [HLX_DOC.textPath as string]: HLX_TEXT,
  [BIP_DOC.textPath as string]: BIP_TEXT,
};

// ── the model's answers ─────────────────────────────────────────────────────

/** A correct reading of the Hornbeck balance sheet, in the document's own numbers. */
const HLX_ANSWER = {
  documentClass: "FINANCIAL_STATEMENTS",
  classConfidence: "HIGH",
  summary:
    "Audited consolidated financial statements of Hornbeck Offshore Services for the year ended December 31, 2025.",
  keyPoints: ["Unqualified audit opinion from Ernst & Young LLP"],
  registrant: "Hornbeck Offshore Services, Inc.",
  periodLabel: "Year ended December 31, 2025",
  periodEndDate: "2025-12-31",
  reportingCurrency: "USD",
  unitScale: "THOUSANDS",
  facts: [
    {
      label: "Cash and cash equivalents",
      value: 54167,
      periodLabel: "December 31, 2025",
      statementType: "BALANCE_SHEET",
      sourceLine: null,
    },
  ],
  statementTotals: [
    {
      label: "Total current assets",
      value: 257009,
      periodLabel: "December 31, 2025",
      statementType: "BALANCE_SHEET",
      sourceLine: null,
      components: [
        {
          label: "Cash and cash equivalents",
          value: 54167,
          periodLabel: "December 31, 2025",
          statementType: "BALANCE_SHEET",
          sourceLine: null,
        },
        {
          label: "Accounts receivable, net",
          value: 164695,
          periodLabel: "December 31, 2025",
          statementType: "BALANCE_SHEET",
          sourceLine: null,
        },
        {
          label: "Prepaid expenses",
          value: 4941,
          periodLabel: "December 31, 2025",
          statementType: "BALANCE_SHEET",
          sourceLine: null,
        },
        {
          label: "Taxes receivable",
          value: 19026,
          periodLabel: "December 31, 2025",
          statementType: "BALANCE_SHEET",
          sourceLine: null,
        },
        {
          label: "Other current assets",
          value: 14180,
          periodLabel: "December 31, 2025",
          statementType: "BALANCE_SHEET",
          sourceLine: null,
        },
      ],
    },
  ],
  events: [],
};

/** A meeting circular. No figures at all, which is the correct reading. */
const BIP_ANSWER = {
  documentClass: "PROXY_OR_MEETING",
  classConfidence: "HIGH",
  summary:
    "Joint management information circular for special meetings of Brookfield Infrastructure unitholders and shareholders.",
  keyPoints: ["Special meetings to be held on October 14, 2026"],
  registrant: "Brookfield Infrastructure Partners L.P.",
  periodLabel: null,
  periodEndDate: null,
  reportingCurrency: null,
  unitScale: "UNKNOWN",
  facts: [],
  statementTotals: [],
  events: [
    {
      kind: "special meeting",
      description:
        "Special meeting of unitholders regarding a proposed plan of arrangement.",
      date: "2026-10-14",
    },
  ],
};

/** The Gemini response envelope, in the shape `readUsage`/`extractResponseText` read. */
function modelResponse(payload: unknown): unknown {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: {
      promptTokenCount: 12_345,
      // Gemini spells output tokens `candidates`. The adapter maps it.
      candidatesTokenCount: 678,
      totalTokenCount: 13_023,
      // ...and spells the cache hit `cachedContentTokenCount`, not `cachedTokenCount`.
      cachedContentTokenCount: 9_000,
    },
  };
}

// ── the store ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const keyOf = (accession: string, sequence: number): string =>
  `${accession}#${sequence}`;

let insights: Map<string, Row>;
let upsertCalls: number;
let modelCalls: number;
let lastPrompt: string;

interface UpsertArgs {
  where: { accession_sequence: { accession: string; sequence: number } };
  create: Row;
  update: Row;
}

type DocFindUnique = typeof prisma.usFilingDocument.findUnique;
type InsightFindUnique = typeof prisma.usFilingInsight.findUnique;
type InsightUpsert = typeof prisma.usFilingInsight.upsert;

let realDocFindUnique: DocFindUnique;
let realInsightFindUnique: InsightFindUnique;
let realInsightUpsert: InsightUpsert;

before(() => {
  realDocFindUnique = prisma.usFilingDocument.findUnique;
  realInsightFindUnique = prisma.usFilingInsight.findUnique;
  realInsightUpsert = prisma.usFilingInsight.upsert;

  prisma.usFilingDocument.findUnique = (async (args: {
    where: { id: string };
  }) => {
    const byId: Record<string, CohortDocument> = {
      [HLX_DOC.id as string]: HLX_DOC,
      [BIP_DOC.id as string]: BIP_DOC,
    };
    return byId[args.where.id] ?? null;
  }) as unknown as DocFindUnique;

  prisma.usFilingInsight.findUnique = (async (args: {
    where: { accession_sequence: { accession: string; sequence: number } };
  }) => {
    const { accession, sequence } = args.where.accession_sequence;
    return insights.get(keyOf(accession, sequence)) ?? null;
  }) as unknown as InsightFindUnique;

  prisma.usFilingInsight.upsert = (async (args: UpsertArgs) => {
    upsertCalls += 1;
    const { accession, sequence } = args.where.accession_sequence;
    const key = keyOf(accession, sequence);
    const existing = insights.get(key);
    if (!existing) {
      const created = { ...args.create };
      insights.set(key, created);
      return created;
    }
    // MODELS `unset`. Without this the fake merges `{ unset: true }` in as a
    // VALUE, and the retraction test one layer up would pass while the real
    // upsert did something else entirely — the shadow-test shape. Mongo removes
    // the key; so does this.
    const next: Row = { ...existing };
    for (const [k, v] of Object.entries(args.update)) {
      if (v !== null && typeof v === "object" && (v as Row).unset === true) {
        delete next[k];
      } else {
        next[k] = v;
      }
    }
    insights.set(key, next);
    return next;
  }) as unknown as InsightUpsert;
});

after(() => {
  prisma.usFilingDocument.findUnique = realDocFindUnique;
  prisma.usFilingInsight.findUnique = realInsightFindUnique;
  prisma.usFilingInsight.upsert = realInsightUpsert;
});

/** MONEY-1507 — every `enrichEvent` call this run made. */
let enrichments: { eventId: string; summary: string; enrichedAt: Date }[] = [];
/** What the stubbed enricher answers. Flipped by the not-found case. */
let enrichResult: { enriched: boolean; reason?: "not-found" } = {
  enriched: true,
};

beforeEach(() => {
  insights = new Map();
  upsertCalls = 0;
  modelCalls = 0;
  lastPrompt = "";
  enrichments = [];
  enrichResult = { enriched: true };
});

/** The sweep, wired to the REAL adapter with only the model call replaced. */
function runWith(
  documentId: string,
  answer: unknown,
  opts: { maxChars?: number; force?: boolean } = {},
) {
  const analyser = createFilingInsightAnalyser({
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    deps: {
      generate: async (request) => {
        modelCalls += 1;
        lastPrompt = request.prompt;
        return modelResponse(answer);
      },
    },
  });

  return processUsFilingInsight(
    { documentId, ...(opts.force === true ? { force: true } : {}) },
    {
      analyser,
      readText: async (path: string) => {
        const text = TEXT_BY_PATH[path];
        if (text === undefined) throw new Error(`no such object: ${path}`);
        return text;
      },
      now: () => new Date("2026-09-02T04:00:00Z"),
      // MONEY-1507 — records the enrichment instead of reaching Mongo. Without
      // it every case here calls the real `enrichEvent`, which fails to
      // initialise Prisma and is swallowed by the processor's own fail-soft
      // catch: the cases would pass while proving nothing about the emission.
      enrichEvent: async (eventId, enrichment) => {
        enrichments.push({ eventId, ...enrichment });
        return enrichResult;
      },
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────

describe("MONEY-1324 — one real document, end to end", () => {
  it("PENDING -> READY: a real 8-K exhibit is read and stored", async () => {
    const outcome = await runWith("doc-hlx", HLX_ANSWER);

    assert.equal(outcome.ok, true, `run failed: ${outcome.reason}`);
    assert.equal(outcome.action, "analysed");
    assert.equal(outcome.reason, "never-analysed");
    assert.equal(outcome.insightStatus, INSIGHT_STATUS.READY);
    assert.equal(outcome.written, 1);
    assert.equal(
      modelCalls,
      1,
      "the model was asked more than once for one document",
    );

    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence));
    assert.ok(row, "no row was written");
    assert.equal(row.insightStatus, INSIGHT_STATUS.READY);
    assert.equal(row.documentClass, "FINANCIAL_STATEMENTS");
    assert.equal(row.classConfidence, "HIGH");
    // The document is NOT an earnings release, and the whole one-shape design
    // is here to let it say so.
    assert.equal(row.accession, HLX_DOC.accession);
    assert.equal(row.sequence, HLX_DOC.sequence);
    assert.equal(row.documentId, "doc-hlx");
    assert.equal(row.cik10, "0000866829");
    assert.equal(row.symbol, "HOS");
  });

  it("stores THE VALIDATED SHAPE — facts, statementTotals, events", async () => {
    await runWith("doc-hlx", HLX_ANSWER);
    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)) as Row;

    const facts = row.facts as { label: string; value: number }[];
    const totals = row.statementTotals as {
      label: string;
      value: number;
      components: { value: number }[];
    }[];

    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.value, 54167);
    assert.equal(totals.length, 1);
    assert.equal(totals[0]?.value, 257009);
    assert.equal(
      totals[0]?.components.length,
      5,
      "the components were dropped on the way to the row — the cross-foot " +
        "check reads them, so a row without them cannot be re-checked",
    );
    assert.deepEqual(row.events, []);

    // The columns the validators do NOT read must not be here at all.
    for (const gone of ["earnings", "guidance", "statements", "transaction"]) {
      assert.equal(gone in row, false, `${gone} is being written`);
    }
  });

  it("carries the UNITS, without which the figures are meaningless", async () => {
    await runWith("doc-hlx", HLX_ANSWER);
    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)) as Row;
    // The document's own header reads "(in thousands, except per share data)".
    // 257,009 means $257 million, and nothing else on the row says so.
    assert.equal(row.unitScale, "THOUSANDS");
    assert.equal(row.reportingCurrency, "USD");
    assert.equal(row.periodEndDate, "2025-12-31");
    assert.equal(row.registrant, "Hornbeck Offshore Services, Inc.");
  });

  it("stamps PROVENANCE: model, prompt version and the source hash", async () => {
    await runWith("doc-hlx", HLX_ANSWER);
    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)) as Row;

    assert.equal(typeof row.model, "string");
    assert.ok((row.model as string).length > 0, "no model id was recorded");
    assert.equal(
      row.promptVersion,
      FILING_INSIGHT_PROMPT_VERSION,
      "the prompt version on the row is not the one the prompt module " +
        "declares — a prompt change would no longer be a detectable cause of " +
        "a changed reading",
    );
    assert.equal(
      row.sourceTextHash,
      HLX_DOC.textHash,
      "the reading is not attributable to the bytes it was derived from",
    );
    assert.equal(row.analysedAt instanceof Date, true);
  });

  it("attributes SPEND to what was SENT, not to what was stored", async () => {
    await runWith("doc-hlx", HLX_ANSWER);
    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)) as Row;

    const selected = selectSectionsForAnalysis(HLX_TEXT);
    assert.equal(
      row.analysedBytes,
      selected.totalChars,
      "`analysedBytes` is not the selection's size. Storing the document's " +
        "size would attribute a cost we did not pay and hide a thin selection.",
    );

    // Gemini spells output tokens `candidatesTokenCount` and the cache hit
    // `cachedContentTokenCount`. Both are easy to map to the wrong column and
    // both then read 0 forever, indistinguishable from a genuine zero.
    assert.equal(row.outputTokens, 678);
    assert.equal(row.promptTokens, 12_345);
    assert.equal(row.cachedTokens, 9_000);
  });

  it("an EXISTING PENDING row transitions to READY", async () => {
    // The planner writes a PENDING row ahead of the sweep. Same key, so this
    // is an UPDATE — a second row for one document would be double-counted by
    // every reader while looking entirely normal.
    insights.set(keyOf(HLX_DOC.accession, HLX_DOC.sequence), {
      accession: HLX_DOC.accession,
      sequence: HLX_DOC.sequence,
      insightStatus: INSIGHT_STATUS.PENDING,
    });

    const outcome = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(outcome.action, "analysed");
    assert.equal(insights.size, 1, "a second row appeared for one document");
    assert.equal(
      insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence))?.insightStatus,
      INSIGHT_STATUS.READY,
    );
  });

  it("a FAILURE over a READY row RETRACTS the reading it no longer claims", async () => {
    // The JOIN for `buildInsightFailureUpdate`, driven through the real upsert
    // rather than asserted on a payload. `upsert({create: row, update: row})`
    // writes nothing for an omitted key, so before this the row read
    // `insightStatus: FAILED` / `documentClass: UNCLASSIFIED` while still
    // carrying the PREVIOUS reading's facts, summary and token counts — a row
    // claiming nothing and holding everything, which a reader that trusts
    // `facts` without re-checking the status cannot tell from a real reading.
    const first = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(first.insightStatus, "READY");
    const readyRow = insights.get(
      keyOf(HLX_DOC.accession, HLX_DOC.sequence),
    ) as Row;
    assert.ok(
      Array.isArray(readyRow.facts) && (readyRow.facts as unknown[]).length > 0,
      "[control] the READY row carries no facts, so the retraction below " +
        "would pass vacuously",
    );
    assert.ok(
      typeof readyRow.summary === "string" && readyRow.summary.length > 0,
    );

    // ...now the SAME document fails.
    const second = await processUsFilingInsight(
      { documentId: "doc-hlx", force: true },
      {
        analyser: createFilingInsightAnalyser({
          deps: {
            generate: async () => {
              throw new Error("vertex unreachable");
            },
          },
        }),
        readText: async () => HLX_TEXT,
        now: () => new Date("2026-09-02T05:00:00Z"),
      },
    );
    assert.equal(second.action, "failed");

    const failedRow = insights.get(
      keyOf(HLX_DOC.accession, HLX_DOC.sequence),
    ) as Row;
    assert.equal(failedRow.insightStatus, "FAILED");
    for (const retracted of [
      "facts",
      "statementTotals",
      "events",
      "summary",
      "model",
      "promptVersion",
      "sourceTextHash",
    ]) {
      assert.equal(
        retracted in failedRow,
        false,
        `the FAILED row still carries ${retracted} from the reading it no ` +
          "longer claims — UNCLASSIFIED/FAILED sitting on top of real facts",
      );
    }
    // `sourceTextHash` in particular: leaving it would be provenance for a
    // reading that was retracted, on the one column the retry path reads.
    assert.equal(failedRow.documentClass, "UNCLASSIFIED");
    assert.match(String(failedRow.failureReason), /analysis-failed/);
  });

  it("IDEMPOTENT: a second identical run writes NOTHING and asks nothing", async () => {
    // MUTATION: delete the `unchanged && READY` arm of `decideInsightAction`
    // -> RED here (written 1, upsertCalls 2, modelCalls 2).
    const first = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(first.written, 1);
    assert.equal(upsertCalls, 1);
    const snapshot = JSON.stringify(
      insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)),
    );

    const second = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(second.action, "skipped");
    assert.equal(second.reason, "unchanged-text");
    assert.equal(second.written, 0, "the second run wrote a row");
    assert.equal(upsertCalls, 1, "the second run touched the database");
    assert.equal(
      modelCalls,
      1,
      "the second run spent a model call on a document already read",
    );
    assert.equal(
      JSON.stringify(insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence))),
      snapshot,
      "the stored row changed on a run that was supposed to write nothing",
    );
  });

  it("a RE-EXTRACTION (new hash) IS re-read", async () => {
    // The other half of idempotency. Skipping on the STATUS alone would make a
    // corrected extraction permanently invisible.
    await runWith("doc-hlx", HLX_ANSWER);
    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)) as Row;
    row.sourceTextHash = "sha256-hlx-v0-superseded";

    const outcome = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(outcome.action, "analysed");
    assert.equal(outcome.reason, "text-changed-or-retry");
    assert.equal(upsertCalls, 2);
  });
});

describe("MONEY-1324 — the 6-K path", () => {
  it("a 6-K with items: [] is READ, not silently excluded", async () => {
    // 1,256 documents. An item-gated filter drops every one of them and looks
    // like a narrower filter rather than a missing form — there is no error
    // and no counter to reveal it.
    assert.deepEqual(
      BIP_DOC.items,
      [],
      "the fixture stopped being the 6-K case",
    );

    const outcome = await runWith("doc-bip", BIP_ANSWER);
    assert.equal(outcome.ok, true, `the 6-K was refused: ${outcome.reason}`);
    assert.equal(outcome.action, "analysed");
    assert.equal(outcome.insightStatus, INSIGHT_STATUS.READY);

    const row = insights.get(keyOf(BIP_DOC.accession, BIP_DOC.sequence)) as Row;
    assert.equal(row.documentClass, "PROXY_OR_MEETING");
    assert.equal(row.form, "6-K");
    assert.equal(row.documentType, "EX-99.2");
  });

  it("a circular with no figures stores `[]`, not an absent key", async () => {
    await runWith("doc-bip", BIP_ANSWER);
    const row = insights.get(keyOf(BIP_DOC.accession, BIP_DOC.sequence)) as Row;

    assert.deepEqual(row.facts, []);
    assert.deepEqual(row.statementTotals, []);
    assert.equal((row.events as unknown[]).length, 1);
    assert.ok(
      "facts" in row && "statementTotals" in row,
      "an empty reading was written as an absent key — on Mongo that is " +
        "unreachable in BOTH directions, so 'we read it and it had none' " +
        "becomes unqueryable",
    );
    // A proxy with no statements is the correct shape, and `checkClassBlocks`
    // would have refused it if the model had attached one.
    assert.equal(row.unitScale, "UNKNOWN");
    assert.equal("reportingCurrency" in row, false);
  });
});

describe("MONEY-1324 — a reading the checks refuse is NOT stored as one", () => {
  it("an UNGROUNDED figure is recorded FAILED, never READY", async () => {
    // MUTATION: make the adapter return `toFilingTextAnalysis` without the
    // `!result.ok` throw -> RED (insightStatus READY, and the row carries a
    // figure that is not in the document).
    const invented = {
      ...HLX_ANSWER,
      facts: [
        {
          label: "Total revenues",
          value: 987654321,
          periodLabel: "December 31, 2025",
          statementType: "INCOME_STATEMENT",
          sourceLine: null,
        },
      ],
    };

    const outcome = await runWith("doc-hlx", invented);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.action, "failed");
    assert.equal(outcome.insightStatus, INSIGHT_STATUS.FAILED);
    assert.match(outcome.reason, /analysis-failed/);
    assert.match(outcome.reason, /ungrounded-value/);

    const row = insights.get(keyOf(HLX_DOC.accession, HLX_DOC.sequence)) as Row;
    assert.equal(row.insightStatus, INSIGHT_STATUS.FAILED);
    assert.equal(row.documentClass, "UNCLASSIFIED");
    assert.equal(
      "facts" in row,
      false,
      "a refused reading was stored anyway — the row now carries a figure " +
        "the document does not print",
    );
    assert.equal(
      "sourceTextHash" in row,
      false,
      "a FAILED row stamped the hash, so the sweep will read 'same bytes, " +
        "already handled' and never retry",
    );
  });

  it("a total that does not CROSS-FOOT is refused", async () => {
    // Every figure here IS in the document, so grounding passes; the total is
    // simply not the sum of the components printed under it. That is the
    // wrapped-label mis-attribution the second check exists for, and it is
    // invisible to the first.
    const misattributed = structuredClone(HLX_ANSWER);
    misattributed.statementTotals[0]!.components[0]!.value = 80803; // the 2024 column

    const outcome = await runWith("doc-hlx", misattributed);
    assert.equal(outcome.action, "failed");
    assert.match(outcome.reason, /cross-foot-mismatch/);
  });

  it("[control] the SAME answer, uncorrupted, is accepted", async () => {
    // Without this the two cases above would pass against a validator that
    // refuses everything.
    const outcome = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(outcome.action, "analysed");
  });
});

describe("MONEY-1324 — validation runs against the SELECTED text", () => {
  /**
   * The property: a figure the model was NOT SHOWN must not be accepted just
   * because it appears somewhere else in the document.
   *
   * This is the one check that cannot be written against a whole document. A
   * 1.7 MB filing prints thousands of numbers; a hallucination that happens to
   * collide with one of them is indistinguishable from a reading unless the
   * check is scoped to what the model actually saw. The model is accountable
   * for what it was shown.
   */
  const MAX_CHARS = 3_000;

  function ghostFigure(): number {
    const selected = selectSectionsForAnalysis(HLX_TEXT, {
      maxChars: MAX_CHARS,
    });
    assert.equal(
      selected.reason,
      "scored",
      "the fixture now fits the budget whole, so there is no 'outside the " +
        "selection' left and this test proves nothing",
    );

    const inDocument = indexSourceFigures(normaliseFilingText(HLX_TEXT));
    const inSelection = indexSourceFigures(selected.text);
    // LARGEST first, deliberately. A four-digit candidate is as likely to be
    // a year or a page number as a statement figure, and one of those can
    // reappear inside the selection in another guise — which would make this
    // test flip on a fixture edit for a reason that has nothing to do with
    // the property it checks.
    const outside = [...inDocument]
      .filter((n) => !inSelection.has(n) && Math.abs(n) > 10_000)
      .sort((a, b) => Math.abs(b) - Math.abs(a));
    assert.ok(
      outside.length > 0,
      "[control] no figure is outside the selection; the fixture can no " +
        "longer distinguish the two texts",
    );
    return outside[0] as number;
  }

  it("a figure that is in the DOCUMENT but not in the SELECTION is refused", async () => {
    // MUTATION: `validateFilingInsight(insight, input.text)` in place of
    // `selected.text` -> RED (the run is "analysed", because the figure IS in
    // the document).
    const ghost = ghostFigure();
    const inDocument = indexSourceFigures(normaliseFilingText(HLX_TEXT));
    assert.ok(
      inDocument.has(ghost),
      "[control] the ghost figure is not in the document either, so this " +
        "test would pass against a check scoped to the whole document",
    );

    const answer = {
      ...HLX_ANSWER,
      facts: [
        {
          label: "A figure from a section that was never sent",
          value: ghost,
          periodLabel: null,
          statementType: "OTHER",
          sourceLine: null,
        },
      ],
      statementTotals: [],
    };

    const outcome = await runWith("doc-hlx", answer, { maxChars: MAX_CHARS });
    assert.equal(
      outcome.action,
      "failed",
      `${ghost} was accepted. It is in the document but not in the text the ` +
        "model was shown, so the grounding check is running against the " +
        "wrong string and can no longer fail honestly.",
    );
    assert.match(outcome.reason, /ungrounded-value/);
  });

  it("[control] a figure INSIDE the same selection is accepted", async () => {
    // The pair is what makes the case above about the SELECTION BOUNDARY
    // rather than about the checker refusing everything under a small budget.
    const answer = {
      ...HLX_ANSWER,
      facts: [
        {
          label: "Cash and cash equivalents",
          value: 54167,
          periodLabel: "December 31, 2025",
          statementType: "BALANCE_SHEET",
          sourceLine: null,
        },
      ],
      statementTotals: [],
    };
    const outcome = await runWith("doc-hlx", answer, { maxChars: MAX_CHARS });
    assert.equal(outcome.action, "analysed", `refused: ${outcome.reason}`);
  });

  it("the model is TOLD when it was handed a selection", async () => {
    // A model that believes it has the whole document reasons about what is
    // missing from it. The prompt carries the notice; without it a truncated
    // read is silently presented as a complete one.
    await runWith("doc-hlx", HLX_ANSWER, { maxChars: MAX_CHARS });
    assert.match(lastPrompt, /too large to send whole/);

    const full = await runWith("doc-bip", BIP_ANSWER);
    assert.equal(full.action, "analysed");
    assert.doesNotMatch(
      lastPrompt,
      /too large to send whole/,
      "a document that fitted whole was announced as a selection",
    );
  });
});

describe("MONEY-1324 — the outcome metric fires on EVERY exit", () => {
  /**
   * REACHABILITY, not presence.
   *
   * `packages/datadog/__tests__/job-outcome-coverage.test.ts` scans this
   * processor's SOURCE for a `reportJobOutcome` call, which is the right
   * ratchet for "a new writer must report" and cannot see WHERE the call
   * sits. `stock-document-extract` shipped its report below an early return
   * and emitted nothing on an idle night; the scan would have passed that
   * file every day. So the placement is asserted here, by running the paths.
   *
   * The metric is observed through the log line `reportJobOutcome` always
   * writes — `incrementCounter` is a no-op without `DD_API_KEY`, so the line
   * is the only observable in a test, and it is the same line an operator
   * reads in Cloud Logging.
   */
  async function capturing<T>(run: () => Promise<T>): Promise<{
    result: T;
    lines: string[];
  }> {
    const lines: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    const collect = (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    console.log = collect;
    console.warn = collect;
    try {
      const result = await run();
      return { result, lines };
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
  }

  const outcomeLines = (lines: string[]): string[] =>
    lines.filter(
      (l) => l.includes("[job-outcome]") && l.includes("us-filing-insight"),
    );

  it("emits on the ANALYSED path", async () => {
    const { lines } = await capturing(() => runWith("doc-hlx", HLX_ANSWER));
    const emitted = outcomeLines(lines);
    assert.equal(emitted.length, 1, "the analysed path emitted no metric");
    assert.match(emitted[0] as string, /"written":1/);
    assert.match(emitted[0] as string, /"failed":0/);
  });

  it("emits on the SKIP path — the ordinary case, and the easiest to lose", async () => {
    // MUTATION: move `reportJobOutcome` out of the `finally` and above the
    // final `return outcome` -> RED here and on the FAILED case below, while
    // the datadog coverage scan stays GREEN (it checks presence, not
    // placement).
    await runWith("doc-hlx", HLX_ANSWER);
    const { result, lines } = await capturing(() =>
      runWith("doc-hlx", HLX_ANSWER),
    );
    assert.equal(result.action, "skipped");

    const emitted = outcomeLines(lines);
    assert.equal(
      emitted.length,
      1,
      "an idle run emitted NO metric. A monitor with notify_no_data over a " +
        "series that never emits cannot fire, and most runs of this job are " +
        "skips.",
    );
    assert.match(emitted[0] as string, /"written":0/);
    assert.match(
      emitted[0] as string,
      /unchanged-text/,
      "0 written with no reason is exactly the silence this metric replaces",
    );
  });

  it("emits on the FAILED path, and names the UPSTREAM when it was one", async () => {
    const { result, lines } = await capturing(() =>
      processUsFilingInsight(
        { documentId: "doc-hlx" },
        {
          analyser: createFilingInsightAnalyser({
            deps: {
              generate: async () => {
                throw new Error("vertex unreachable");
              },
            },
          }),
          readText: async () => HLX_TEXT,
          now: () => new Date("2026-09-02T04:00:00Z"),
        },
      ),
    );

    assert.equal(result.action, "failed");
    const emitted = outcomeLines(lines);
    assert.equal(emitted.length, 1, "the failure path emitted no metric");
    assert.match(
      emitted[0] as string,
      /"transportFailures":1/,
      "a dead Gemini was not counted as a blocked upstream",
    );
    // AND NOT `failed`. This case used to assert BOTH — pinning the exact
    // conflation its own message described as the bug. `failed` and
    // `transportFailures` are different UNITS and one event is exactly one of
    // them: a blocked upstream is not a row we could not persist, it is a call
    // that did not answer (MONEY-1250/1255). `circulars-sync` and
    // `institutional-flow-sync` apply that discipline in this same branch.
    //
    // Reported as both, a dead Gemini is indistinguishable from a night of
    // filings the model read and disbelieved, and only the second is our
    // data's fault.
    assert.match(
      emitted[0] as string,
      /"failed":0/,
      "the upstream failure was ALSO counted as a row that failed to persist",
    );
  });

  it("a GCS read failure is transport, not a row failure", () => {
    // The second upstream path, and it had the same defect. The object could
    // not be read, so no reading was attempted — there is no row we failed to
    // persist.
    return capturing(() =>
      processUsFilingInsight(
        { documentId: "doc-hlx" },
        {
          readText: async () => {
            throw new Error("GCS 503");
          },
          now: () => new Date("2026-09-02T04:00:00Z"),
        },
      ),
    ).then(({ result, lines }) => {
      assert.equal(result.action, "failed");
      assert.equal(result.transportFailures, 1);
      const emitted = outcomeLines(lines);
      assert.equal(emitted.length, 1);
      assert.match(emitted[0] as string, /"transportFailures":1/);
      assert.match(
        emitted[0] as string,
        /"failed":0/,
        "a GCS outage was counted as a document we could not persist",
      );
      assert.match(emitted[0] as string, /gcs-read-failed/);
    });
  });

  it("a REFUSED reading is NOT an upstream failure", async () => {
    // The other side of the same counter. The model answered; we disbelieved
    // it. Counting that as transport would mute the one signal that says the
    // upstream is dark.
    const invented = {
      ...HLX_ANSWER,
      facts: [
        {
          label: "Total revenues",
          value: 987654321,
          periodLabel: null,
          statementType: "INCOME_STATEMENT",
          sourceLine: null,
        },
      ],
      statementTotals: [],
    };
    const { result, lines } = await capturing(() =>
      runWith("doc-hlx", invented),
    );
    const emitted = outcomeLines(lines);
    assert.equal(emitted.length, 1);
    // The call ANSWERED and we disbelieved it: a row we could not persist, and
    // no transport involved. This is the control that keeps the fix above from
    // being "never report failed".
    assert.match(emitted[0] as string, /"failed":1/);
    assert.doesNotMatch(emitted[0] as string, /"transportFailures"/);

    // ...and the tokens it SPENT are recorded. A rejection is a completed,
    // billed model call; reporting zero made a prompt regression that refused
    // every reading look free on the one surface that would have shown it.
    assert.ok(
      result.promptTokens > 0 || result.outputTokens > 0,
      "a REFUSED reading reported zero tokens — the call still billed, so " +
        `a prompt regression that refuses everything reads as free (got ` +
        `prompt=${result.promptTokens} output=${result.outputTokens})`,
    );
  });
});

describe("[MONEY-1507] the analysed reading enriches its InstrumentEvent", () => {
  it("calls enrichEvent with the SAME id the detector produced", async () => {
    // THE JOIN. `enrichEvent` is unit-tested on its own and that proves nothing
    // about whether this sweep ever calls it. The id must be derivable from the
    // ACCESSION alone — `sha1(SEC_EDGAR, accession)` — because the detector had
    // no document id when it emitted.
    const outcome = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(outcome.action, "analysed");
    assert.equal(enrichments.length, 1);
    assert.equal(
      enrichments[0]!.eventId,
      buildEventId(SEC_SOURCE, HLX_DOC.accession),
    );
  });

  it("sends the model's SUMMARY, not the class or the key points", async () => {
    await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(enrichments[0]!.summary, HLX_ANSWER.summary);
  });

  it("an ABSENT event is not a failure — the insight is this job's product", async () => {
    // The filing may predate C1, the detector's fail-soft emission may have
    // dropped it, or the 30-day TTL may have reaped it. None of those is a
    // reason to mark a perfectly good reading failed.
    enrichResult = { enriched: false, reason: "not-found" };
    const outcome = await runWith("doc-hlx", HLX_ANSWER);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.action, "analysed");
    assert.equal(outcome.written, 1);
  });

  it("a THROWING enricher never loses the insight row", async () => {
    // The insight is what this job spent a model call on. Losing it to an
    // events outage would re-spend that call on the sweep's next pass.
    const analyser = createFilingInsightAnalyser({
      deps: {
        generate: async () => modelResponse(HLX_ANSWER),
      },
    });
    const outcome = await processUsFilingInsight(
      { documentId: "doc-hlx" },
      {
        analyser,
        readText: async (path: string) => TEXT_BY_PATH[path] as string,
        now: () => new Date("2026-09-02T04:00:00Z"),
        enrichEvent: (async () => {
          throw new Error("mongo is down");
        }) as never,
      },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.insightStatus, INSIGHT_STATUS.READY);
    assert.equal(outcome.written, 1);
  });
});
