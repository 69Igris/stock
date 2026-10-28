/**
 * The financials-parse worker's selection and drain logic — MONEY-1255.
 *
 * Every symbol is the REAL export `stock-document-parse.ts` calls. The two
 * things this file exists to nail down, because both fail SILENTLY:
 *
 *   1. `parseStatus` is ABSENT — not null, not "PENDING" — on all ~43,105
 *      pre-existing `stock_documents` rows, so the obvious query matches zero
 *      of them and "nothing to parse" is indistinguishable from "the whole
 *      backlog is unreachable".
 *   2. The self-chain terminates. An async loop that re-publishes itself has to
 *      be PROVABLY bounded, not observably bounded.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PUBSUB_TOPICS } from "@usemoney/types/pubsub";
import {
  CONTAINER_DOC_MIME_TYPES,
  DIRECT_DOC_MIME_TYPES,
  EXTRACTABLE_DOC_MIME_TYPES,
} from "@usemoney/core/market-data/doc-mime";

import {
  DEFAULT_PARSE_BATCH_SIZE,
  FORCE_REPARSE_STATUSES,
  MAX_CHAIN_DEPTH,
  MAX_COVERED_SYMBOLS_FOR_PHASING,
  PARSEABLE_DOC_TYPES,
  PARSE_ORDER_BY,
  PARSE_PHASES,
  PENDING_OR_ABSENT_PARSE_STATUS,
  RUN_TIME_BUDGET_MS,
  STOCK_DOCUMENT_PARSE_TOPIC,
  buildParseQuery,
  buildPhaseQuery,
  canPhaseOnCoveredSymbols,
  describeCohortProgress,
  isWithinRunBudget,
  normalizeChainDepth,
  phasesToRun,
  resolveDocumentParseStatus,
  shouldChainAnotherBatch,
  tallyReasons,
} from "../../src/processors/stock-document-parse-logic";
import {
  DEFAULT_DOC_PARSE_BUDGET_MS,
  FILE_DELETE_TIMEOUT_MS,
  MAX_PDF_BYTES,
} from "../../src/lib/gemini-pdf";

// ══════════════════════════════════════════════════════════════════════
// THE ABSENT-FIELD TRAP
// ══════════════════════════════════════════════════════════════════════

describe("selection reaches rows whose parseStatus is ABSENT", () => {
  it("the OR carries BOTH the PENDING arm and the isSet:false arm", () => {
    const where = buildParseQuery({});
    const or = where["OR"] as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(or),
      "the status filter must be an OR, not a scalar",
    );
    assert.deepEqual(
      or,
      [{ parseStatus: "PENDING" }, { parseStatus: { isSet: false } }],
      "dropping the isSet arm makes the entire 43,105-row backlog unreachable",
    );
  });

  it("the exported arm is what the query uses — not a parallel copy", () => {
    const where = buildParseQuery({});
    assert.deepEqual(where["OR"], [...PENDING_OR_ABSENT_PARSE_STATUS]);
  });

  /**
   * A MODEL of Prisma-on-Mongo's matching, not Prisma itself — stated plainly
   * because a matcher that tests itself proves nothing. What it encodes is the
   * one semantic that caused MONEY-1050/1205/1234/1236: a document with NO
   * `parseStatus` key is matched by `{ isSet: false }` and by nothing else.
   *
   * Its job is to make the CONSEQUENCE executable — that the naive query
   * selects zero of the backlog — rather than to re-verify the driver.
   */
  function matchesStatusArm(
    doc: Record<string, unknown>,
    arm: Record<string, unknown>,
  ): boolean {
    const cond = arm["parseStatus"];
    const present = Object.prototype.hasOwnProperty.call(doc, "parseStatus");
    if (cond && typeof cond === "object") {
      const c = cond as { isSet?: boolean; in?: string[] };
      if (c.isSet === false) return !present;
      if (c.in) return present && c.in.includes(doc["parseStatus"] as string);
      return false;
    }
    return present && doc["parseStatus"] === cond;
  }

  const backlogRow = { id: "old", symbol: "TCS" }; // NO parseStatus key at all
  const freshRow = { id: "new", symbol: "INFY", parseStatus: "PENDING" };
  const doneRow = { id: "done", symbol: "WIPRO", parseStatus: "PARSED" };
  const corpus = [backlogRow, freshRow, doneRow];

  it("CEILING: the fixture really does contain an absent-field row", () => {
    // Without this, the selection assertion below could pass against a corpus
    // that has no backlog row in it — a silent empty result reading as success.
    assert.equal(
      corpus.filter((d) => !("parseStatus" in d)).length,
      1,
      "the fixture must contain exactly one row with the field absent",
    );
    assert.equal(corpus.length, 3);
  });

  it("the real query selects the absent-field row AND the PENDING row", () => {
    const or = buildParseQuery({})["OR"] as Array<Record<string, unknown>>;
    const selected = corpus.filter((d) =>
      or.some((arm) => matchesStatusArm(d, arm)),
    );
    assert.deepEqual(
      selected.map((d) => d.id).sort(),
      ["new", "old"],
      "the pre-existing backlog row must be reachable",
    );
  });

  it("the NAIVE query selects ZERO of the backlog — the defect, executably", () => {
    const naive = { parseStatus: "PENDING" };
    const selected = corpus.filter((d) => matchesStatusArm(d, naive));
    assert.deepEqual(
      selected.map((d) => d.id),
      ["new"],
      "`{ parseStatus: 'PENDING' }` misses every row written before the column existed",
    );
  });
});

describe("the rest of the selection", () => {
  it("orders OLDEST FIRST — a batch needs an ASC rotation marker", () => {
    // Literal, not read back off the constant: MONEY-1211 lost 681 of 781
    // symbols to a batch that never advanced, and `desc` here would push the
    // oldest rows further down on every sync.
    assert.deepEqual(PARSE_ORDER_BY, { fetchedAt: "asc" });
  });

  it("filters mimeType through the SHARED *direct* list", () => {
    const where = buildParseQuery({});
    assert.deepEqual(where["mimeType"], {
      in: [...DIRECT_DOC_MIME_TYPES],
    });
    assert.ok(
      DIRECT_DOC_MIME_TYPES.includes("application/pdf"),
      "CEILING: the shared list must actually contain the PDF type",
    );
  });

  it("never selects a CONTAINER — this lane cannot open one", () => {
    // MONEY-1319 review, H1. This query read the archive-inclusive
    // `EXTRACTABLE_DOC_MIME_TYPES` while `application/zip` was being added to
    // it, and `PARSEABLE_DOC_TYPES` includes `annual_report` — exactly the
    // 172-row NSE ZIP class. Every one would have been downloaded and its raw
    // archive bytes handed to the Gemini Files API, or its gs:// URI handed to
    // Vertex: a metered call for bytes no model can read.
    assert.ok(
      CONTAINER_DOC_MIME_TYPES.length > 0,
      "CEILING: with no container types this assertion proves nothing",
    );
    const selected = (buildParseQuery({}) as { mimeType: { in: string[] } })
      .mimeType.in;
    for (const container of CONTAINER_DOC_MIME_TYPES) {
      assert.ok(
        !selected.includes(container),
        `${container} is a container and this lane has no unwrapping step`,
      );
      assert.ok(
        EXTRACTABLE_DOC_MIME_TYPES.includes(container),
        "CONTROL: it IS readable by SOME lane, so this is a capability split " +
          "and not a coverage loss",
      );
    }
  });

  it("takes the statement doc types and NOT the narrative ones", () => {
    const where = buildParseQuery({});
    const docTypes = (where["docType"] as { in: string[] }).in;
    assert.ok(docTypes.length >= 3, "CEILING: the default list is non-empty");
    for (const wanted of [
      "annual_report",
      "quarterly_result",
      "financial_statement",
    ]) {
      assert.ok(docTypes.includes(wanted), `${wanted} must be parseable`);
    }
    for (const excluded of [
      "concall_transcript",
      "concall_ppt",
      "investor_presentation",
      "drhp",
      "credit_rating",
      "press_release",
      "announcement",
      "corporate_filing",
      "video_transcript",
    ]) {
      assert.equal(
        docTypes.includes(excluded),
        false,
        `${excluded} carries management-chosen or prose figures — never parse it`,
      );
    }
    assert.deepEqual(docTypes, [...PARSEABLE_DOC_TYPES]);
  });

  it("honours an explicit docTypes override", () => {
    const where = buildParseQuery({ docTypes: ["annual_report"] });
    assert.deepEqual(where["docType"], { in: ["annual_report"] });
  });

  it("upper-cases symbols, and omits the filter when none are named", () => {
    assert.deepEqual(buildParseQuery({ symbols: ["tcs", "Infy"] })["symbol"], {
      in: ["TCS", "INFY"],
    });
    assert.equal("symbol" in buildParseQuery({ symbols: [] }), false);
    assert.equal("symbol" in buildParseQuery({}), false);
  });

  it("force widens to terminal states WITHOUT losing the absent arm", () => {
    const or = buildParseQuery({ force: true })["OR"] as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(or.slice(0, 2), [...PENDING_OR_ABSENT_PARSE_STATUS]);
    assert.deepEqual(or[2], {
      parseStatus: { in: [...FORCE_REPARSE_STATUSES] },
    });
    assert.ok(
      FORCE_REPARSE_STATUSES.includes("FAILED_VALIDATION"),
      "a prompt change is exactly when a FAILED_VALIDATION row should be re-read",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// COHORT ORDERING
// ══════════════════════════════════════════════════════════════════════

/**
 * A MODEL of the connector's matching — stated plainly, because a matcher that
 * tests itself proves nothing. It exists to make the PARTITION property
 * executable: phase 1 and phase 2 must together cover every eligible document
 * exactly once. That is the property a phase-as-FILTER bug would break, and it
 * cannot be seen by looking at either query alone.
 */
function matchesSymbolArm(
  doc: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  const and = Array.isArray(where["AND"])
    ? (where["AND"] as Array<Record<string, unknown>>)
    : [];
  for (const clause of and) {
    const cond = clause["symbol"] as
      | { in?: string[]; notIn?: string[] }
      | undefined;
    if (!cond) continue;
    const sym = doc["symbol"] as string;
    if (cond.in && !cond.in.includes(sym)) return false;
    if (cond.notIn && cond.notIn.includes(sym)) return false;
  }
  return true;
}

describe("cohort ordering puts the no-data companies first", () => {
  const covered = ["TCS", "INFY", "RELIANCE"];
  const base = buildParseQuery({});

  // 3 covered symbols (the validation cohort) + 2 with nothing (the only-source
  // cohort). Documents are deliberately INTERLEAVED by fetchedAt so a plain
  // FIFO would mix them.
  const corpus = [
    { id: "d1", symbol: "TCS", fetchedAt: 1 },
    { id: "d2", symbol: "GOODYEAR", fetchedAt: 2 },
    { id: "d3", symbol: "INFY", fetchedAt: 3 },
    { id: "d4", symbol: "HAWKINS", fetchedAt: 4 },
    { id: "d5", symbol: "RELIANCE", fetchedAt: 5 },
    { id: "d6", symbol: "GOODYEAR", fetchedAt: 6 },
  ];

  it("CEILING: the fixture really does contain BOTH cohorts, interleaved", () => {
    // Without this, a partition assertion over a single-cohort corpus passes
    // while proving nothing.
    const inCovered = corpus.filter((d) => covered.includes(d.symbol));
    const notCovered = corpus.filter((d) => !covered.includes(d.symbol));
    assert.ok(inCovered.length >= 2 && notCovered.length >= 2, "both cohorts");
    assert.notEqual(
      corpus[0]!.symbol.startsWith("G"),
      corpus[1]!.symbol.startsWith("G"),
      "the two cohorts must interleave, or FIFO would look identical",
    );
  });

  it("PARTITION: phase1 ∪ phase2 = everything, phase1 ∩ phase2 = ∅", () => {
    // The property that makes phase an ORDERING key rather than an eligibility
    // filter. If it fails, some document is unreachable forever — the exact
    // silent-starvation shape MONEY-1211 was.
    const p1 = corpus.filter((d) =>
      matchesSymbolArm(d, buildPhaseQuery(base, covered, "NO_FINANCIALS")),
    );
    const p2 = corpus.filter((d) =>
      matchesSymbolArm(d, buildPhaseQuery(base, covered, "HAS_FINANCIALS")),
    );
    assert.deepEqual(
      [...p1, ...p2].map((d) => d.id).sort(),
      corpus.map((d) => d.id).sort(),
      "union must be the whole eligible set",
    );
    assert.deepEqual(
      p1.filter((d) => p2.includes(d)),
      [],
      "the phases must be disjoint",
    );
    assert.ok(p1.length > 0 && p2.length > 0, "CEILING: both phases non-empty");
  });

  it("phase 1 is exactly the symbols with NO financials", () => {
    const p1 = corpus.filter((d) =>
      matchesSymbolArm(d, buildPhaseQuery(base, covered, "NO_FINANCIALS")),
    );
    assert.deepEqual(
      p1.map((d) => d.id),
      ["d2", "d4", "d6"],
    );
  });

  it("PHASE 1 PRECEDES PHASE 2, and fetchedAt ASC holds WITHIN each", () => {
    // The two properties together. A run walks the phases in order and each
    // query carries `orderBy: fetchedAt asc`, so the drain order is phase-major,
    // fetchedAt-minor. Simulated here over the real query builders.
    const order: string[] = [];
    for (const phase of PARSE_PHASES) {
      const page = corpus
        .filter((d) =>
          matchesSymbolArm(d, buildPhaseQuery(base, covered, phase)),
        )
        .sort((a, b) => a.fetchedAt - b.fetchedAt);
      order.push(...page.map((d) => d.id));
    }
    // no-data cohort oldest-first, THEN covered cohort oldest-first
    assert.deepEqual(order, ["d2", "d4", "d6", "d1", "d3", "d5"]);

    const firstCoveredAt = order.findIndex((id) =>
      covered.includes(corpus.find((d) => d.id === id)!.symbol),
    );
    const lastNoDataAt = order.reduce(
      (acc, id, i) =>
        covered.includes(corpus.find((d) => d.id === id)!.symbol) ? acc : i,
      -1,
    );
    assert.ok(
      lastNoDataAt < firstCoveredAt,
      "every no-data document must precede every covered one",
    );
  });

  it("the phase arm goes under AND, so an operator-scoped run stays scoped", () => {
    // `buildParseQuery` may already have written `symbol: { in: [...] }`.
    // Overwriting it would silently widen a targeted run back to the whole
    // market — the opposite of what was asked for, and invisible.
    const scoped = buildParseQuery({ symbols: ["goodyear"] });
    const phased = buildPhaseQuery(scoped, covered, "NO_FINANCIALS");
    assert.deepEqual(phased["symbol"], { in: ["GOODYEAR"] }, "scope survives");
    assert.deepEqual(phased["AND"], [{ symbol: { notIn: covered } }]);
    // …and the status OR is untouched.
    assert.deepEqual(phased["OR"], scoped["OR"]);
  });

  it("keeps the status OR and the mime/docType arms intact", () => {
    const phased = buildPhaseQuery(base, covered, "HAS_FINANCIALS");
    assert.deepEqual(phased["OR"], base["OR"]);
    assert.deepEqual(phased["mimeType"], base["mimeType"]);
    assert.deepEqual(phased["docType"], base["docType"]);
  });
});

describe("cohort ordering degrades safely rather than failing", () => {
  it("NOTHING covered → one un-phased pass over the whole queue", () => {
    // Also the shape a FAILED covered-symbol lookup falls back to: slower to
    // deliver, but complete and correct. The second query is SKIPPED rather
    // than issued as a `symbol: { in: [] }` that scans to find nothing.
    assert.equal(canPhaseOnCoveredSymbols([]), false);
    assert.deepEqual(phasesToRun(0), ["NO_FINANCIALS"]);
    const base = buildParseQuery({});
    assert.deepEqual(buildPhaseQuery(base, [], "NO_FINANCIALS"), { ...base });
  });

  it("an absurd covered list stops shaping the query", () => {
    // The whole active instrument universe is ~10,444, so exceeding this does
    // not mean "a big market" — it means the distinct returned something
    // unexpected, and the safe answer is to stop building a query on it.
    assert.ok(MAX_COVERED_SYMBOLS_FOR_PHASING > 10_444);
    const huge = Array.from(
      { length: MAX_COVERED_SYMBOLS_FOR_PHASING + 1 },
      (_, i) => `S${i}`,
    );
    assert.equal(canPhaseOnCoveredSymbols(huge), false);
    const base = buildParseQuery({});
    assert.deepEqual(buildPhaseQuery(base, huge, "HAS_FINANCIALS"), {
      ...base,
    });
  });

  it("phasesToRun refuses a non-finite count instead of trusting it", () => {
    for (const bad of [NaN, Infinity, -1]) {
      assert.deepEqual(phasesToRun(bad), ["NO_FINANCIALS"]);
    }
    assert.deepEqual(phasesToRun(1373), ["NO_FINANCIALS", "HAS_FINANCIALS"]);
  });
});

describe("the cohort line an operator reads off the job-outcome", () => {
  it("names each phase with its selected / parsed / remaining", () => {
    const line = describeCohortProgress({
      phases: [
        { phase: "NO_FINANCIALS", selected: 25, parsed: 24, remaining: 3450 },
        { phase: "HAS_FINANCIALS", selected: 0, parsed: 0, remaining: 12255 },
      ],
      coveredSymbolCount: 1373,
      degraded: false,
    });
    assert.match(line, /1373 covered symbol/);
    assert.match(line, /NO_FINANCIALS sel=25 parsed=24 left=3450/);
    assert.match(line, /HAS_FINANCIALS sel=0 parsed=0 left=12255/);
  });

  it("prints an uncounted remaining as '?', never as 0", () => {
    // "we did not count" and "there are none left" are opposite facts, and the
    // second is the handover signal an operator is watching for.
    const line = describeCohortProgress({
      phases: [
        { phase: "NO_FINANCIALS", selected: 0, parsed: 0, remaining: null },
      ],
      coveredSymbolCount: 1373,
      degraded: false,
    });
    assert.match(line, /left=\?/);
    assert.equal(/left=0\b/.test(line), false);
  });

  it("says so, loudly, when it fell back to plain FIFO", () => {
    const line = describeCohortProgress({
      phases: [
        { phase: "NO_FINANCIALS", selected: 25, parsed: 25, remaining: null },
      ],
      coveredSymbolCount: 0,
      degraded: true,
    });
    assert.match(line, /DEGRADED to plain FIFO/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE 600s DEADLINE
// ══════════════════════════════════════════════════════════════════════

describe("the run budget fits inside the 600s Pub/Sub ack deadline", () => {
  const ACK_DEADLINE_MS = 600_000;

  it("budget + the worst in-flight document leaves real headroom", () => {
    // The whole point of the arithmetic in RUN_TIME_BUDGET_MS's doc comment,
    // made falsifiable. The budget is checked BETWEEN documents, so the true
    // wall is `budget + one document`, and the document term is bounded by the
    // shared per-document deadline in gemini-pdf.ts plus the out-of-budget
    // delete. Raising either constant without redoing the sum fails HERE
    // instead of causing a redelivery in production.
    const gcsDownloadMs = 30_000; // 50 MiB, costed cross-region
    const prismaWritesMs = 5_000; // ~4 upserts + the status flip
    const bookkeepingMs = 2_000; // findMany + reportJobOutcome + chain publish

    const worstInFlight =
      DEFAULT_DOC_PARSE_BUDGET_MS +
      FILE_DELETE_TIMEOUT_MS +
      gcsDownloadMs +
      prismaWritesMs;
    const worstRun = RUN_TIME_BUDGET_MS + worstInFlight + bookkeepingMs;

    assert.ok(
      worstRun < ACK_DEADLINE_MS,
      `worst run ${worstRun}ms must stay under the ${ACK_DEADLINE_MS}ms ack deadline`,
    );
    assert.ok(
      ACK_DEADLINE_MS - worstRun >= 60_000,
      `only ${ACK_DEADLINE_MS - worstRun}ms of headroom — overrunning DUPLICATES the run`,
    );
  });

  it("the page size stays above what one budget can consume", () => {
    // `selected < batchSize` is the chain's "queue drained" signal. If the page
    // were smaller than the throughput, a full page would mean "the page ran
    // out", the two would be indistinguishable, and the chain would stop a link
    // early every night.
    const typicalDocMs = 35_000;
    const affordable = Math.ceil(RUN_TIME_BUDGET_MS / typicalDocMs);
    assert.ok(
      DEFAULT_PARSE_BATCH_SIZE > affordable,
      `batch ${DEFAULT_PARSE_BATCH_SIZE} must exceed the ~${affordable} a budget affords`,
    );
  });

  it("the size ceiling clears the production distribution's body", () => {
    // 15,705 financial-statement PDFs: avg 5.7 MiB, 3.7% over 20 MiB, 34 over
    // 50 MiB. A 12 MiB inline ceiling would have dropped 12.2% of them —
    // biased toward the largest companies.
    assert.ok(
      MAX_PDF_BYTES >= 50 * 1024 * 1024,
      "the ceiling must clear the 20 MiB tail, not just the average",
    );
  });

  it("isWithinRunBudget is exclusive at the boundary", () => {
    assert.equal(isWithinRunBudget(1000, 1000, 500), true);
    assert.equal(isWithinRunBudget(1000, 1499, 500), true);
    assert.equal(isWithinRunBudget(1000, 1500, 500), false);
    assert.equal(isWithinRunBudget(1000, 9999, 500), false);
    // Defaults to the module's own budget when none is passed.
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS - 1), true);
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE SELF-CHAIN
// ══════════════════════════════════════════════════════════════════════

describe("normalizeChainDepth cannot be talked into extra links", () => {
  it("anything that is not a finite non-negative number reads as 0", () => {
    for (const bad of [
      undefined,
      null,
      NaN,
      Infinity,
      -Infinity,
      -1,
      "3",
      {},
      [],
      true,
    ]) {
      assert.equal(normalizeChainDepth(bad), 0, `${String(bad)} → 0`);
    }
  });

  it("floors a fraction and CLAMPS a forged large value to the ceiling", () => {
    assert.equal(normalizeChainDepth(0), 0);
    assert.equal(normalizeChainDepth(3), 3);
    assert.equal(normalizeChainDepth(3.9), 3);
    // Clamping UP to the ceiling is what makes a forged value END the chain
    // rather than wrap it — `shouldChainAnotherBatch` refuses at the ceiling.
    assert.equal(normalizeChainDepth(1e9), MAX_CHAIN_DEPTH);
    assert.equal(
      shouldChainAnotherBatch({
        selected: 25,
        batchSize: 25,
        chainDepth: normalizeChainDepth(1e9),
        leftPending: 25,
        force: false,
      }),
      false,
      "a forged depth must not buy links",
    );
  });
});

describe("the self-chain provably terminates", () => {
  it("ends within MAX_CHAIN_DEPTH against an ADVERSARIAL environment", () => {
    // The environment lies in the direction that keeps the chain going: the
    // queue is always full, every row always progressed, nothing is forced. The
    // ONLY thing that can stop it is the depth bound, which is a pure function
    // of a number carried on the message and consults no database, no clock and
    // no queue state.
    let depth = 0;
    let links = 0;
    const HARD_STOP = MAX_CHAIN_DEPTH * 10; // proves the loop, not the bound

    while (
      shouldChainAnotherBatch({
        selected: 25,
        batchSize: 25,
        chainDepth: depth,
        leftPending: 25,
        force: false,
      })
    ) {
      depth = normalizeChainDepth(depth + 1);
      links++;
      assert.ok(links <= HARD_STOP, "the chain did not terminate");
    }

    assert.ok(links > 0, "CEILING: the chain must actually have chained");
    assert.equal(
      links,
      MAX_CHAIN_DEPTH - 1,
      "the bound, and only the bound, ended it",
    );
  });

  it("stops SOONER when the queue drains", () => {
    assert.equal(
      shouldChainAnotherBatch({
        selected: 24,
        batchSize: 25,
        chainDepth: 0,
        leftPending: 24,
        force: false,
      }),
      false,
    );
  });

  it("stops when NOTHING left the pending set — the runaway shape", () => {
    // Every update threw, so the identical page would be re-selected forever.
    assert.equal(
      shouldChainAnotherBatch({
        selected: 25,
        batchSize: 25,
        chainDepth: 0,
        leftPending: 0,
        force: false,
      }),
      false,
    );
  });

  it("never chains a FORCED run — it has no fixpoint to reach", () => {
    // `force` re-selects terminal rows, so a deterministically failing document
    // is selected again on the next link.
    assert.equal(
      shouldChainAnotherBatch({
        selected: 25,
        batchSize: 25,
        chainDepth: 0,
        leftPending: 25,
        force: true,
      }),
      false,
    );
  });

  it("refuses a nonsensical batch size instead of dividing by it", () => {
    for (const batchSize of [0, -5]) {
      assert.equal(
        shouldChainAnotherBatch({
          selected: 25,
          batchSize,
          chainDepth: 0,
          leftPending: 25,
          force: false,
        }),
        false,
      );
    }
  });

  it("publishes to the DECLARED topic, not a hand-spelled name", () => {
    assert.equal(
      STOCK_DOCUMENT_PARSE_TOPIC,
      PUBSUB_TOPICS.STOCK_DOCUMENT_PARSE,
    );
    assert.equal(STOCK_DOCUMENT_PARSE_TOPIC, "stock-document-parse");
  });
});

// ══════════════════════════════════════════════════════════════════════
// PER-DOCUMENT OUTCOME
// ══════════════════════════════════════════════════════════════════════

describe("FAILED and FAILED_VALIDATION never collapse into one status", () => {
  const base = {
    callFailure: null as null,
    periodsReturned: 0,
    extractedRows: 0,
    invalidRows: 0,
    droppedReasons: [] as string[],
  };

  it("a transport failure is FAILED — retryable", () => {
    for (const f of ["CALL_FAILED", "UNCONFIGURED"] as const) {
      const out = resolveDocumentParseStatus({ ...base, callFailure: f });
      assert.equal(out.status, "FAILED");
      assert.equal(out.rowsWritten, 0);
    }
  });

  it("an oversized document is UNSUPPORTED — counted, not silently skipped", () => {
    const out = resolveDocumentParseStatus({
      ...base,
      callFailure: "TOO_LARGE",
    });
    assert.equal(out.status, "UNSUPPORTED");
    assert.match(out.reason ?? "", /ceiling/i);
  });

  it("a non-schema answer is FAILED_VALIDATION, NOT FAILED", () => {
    // The call succeeded. Re-running the same (model, prompt) pair produces the
    // same answer at the same cost, so it must not enter the retry population.
    const out = resolveDocumentParseStatus({
      ...base,
      callFailure: "UNPARSEABLE",
    });
    assert.equal(out.status, "FAILED_VALIDATION");
  });

  it("PARSED as soon as ONE reading survived validation", () => {
    const out = resolveDocumentParseStatus({
      ...base,
      periodsReturned: 4,
      extractedRows: 3,
      invalidRows: 1,
    });
    assert.equal(out.status, "PARSED");
    assert.equal(out.rowsWritten, 4, "invalid readings are stored too");
    assert.match(out.reason ?? "", /1 of 4/);
  });

  it("a clean PARSED carries no reason at all", () => {
    const out = resolveDocumentParseStatus({
      ...base,
      periodsReturned: 2,
      extractedRows: 2,
    });
    assert.equal(out.status, "PARSED");
    assert.equal(out.reason, null);
  });

  it("no periods at all is FAILED_VALIDATION with a distinguishable reason", () => {
    const none = resolveDocumentParseStatus({ ...base, periodsReturned: 0 });
    assert.equal(none.status, "FAILED_VALIDATION");
    assert.match(none.reason ?? "", /no periods/i);

    const allInvalid = resolveDocumentParseStatus({
      ...base,
      periodsReturned: 2,
      invalidRows: 0,
      droppedReasons: ["MISSING_PERIOD_END", "MISSING_PERIOD_END"],
    });
    assert.equal(allInvalid.status, "FAILED_VALIDATION");
    assert.match(allInvalid.reason ?? "", /MISSING_PERIOD_END x2/);
    assert.notEqual(
      none.reason,
      allInvalid.reason,
      "'read nothing' and 'read only unusable things' must not print the same line",
    );
  });

  it("tallyReasons is stable and ordered by count", () => {
    assert.equal(tallyReasons([]), "");
    assert.equal(
      tallyReasons(["B", "A", "A", "C", "A", "B"]),
      "A x3, B x2, C x1",
    );
  });
});
