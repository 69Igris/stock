/**
 * UNIT TEST — the document-financials projection SEAM (MONEY-1255).
 *
 * The pure decisions are covered next door in
 * `packages/core/__tests__/market-data/document-financials-projection.test.ts`.
 * This file covers the part that can only go wrong once there is a database in
 * hand: whether the processor HONOURS those decisions, whether the arming
 * switch is a value check rather than a truthiness check, and — the one that
 * has cost this repo the most — whether the cursor stamps only what the run
 * actually decided.
 *
 * MONEY-1092/1093 is why this layer exists at all: a fix that was correct in
 * the unit and inert at the call site, because the narrowed payload never
 * reached the `update:` clause. So every case here drives the REAL exported
 * functions against an in-memory store and asserts on the payloads that reached
 * it.
 *
 * The store is a plain object. There is no DB, no network, no timer, nothing to
 * orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  countWithheldWrites,
  describeNoWriteReason,
  dropPartialTrailingSymbol,
  processDocumentFinancialsProjectionWrite,
  summariseWriteDoors,
  UNPROJECTED_EXTRACT_WHERE,
} from "../../src/processors/document-financials-projection-logic";
// The JOB, not the writer. What a run REPORTS is decided one layer above every
// counter this file otherwise asserts on, and that is the layer the sibling
// XBRL job once discarded them at.
import {
  isDocProjectionArmed,
  processDocumentFinancialsProjection,
  resolveDocApply,
} from "../../src/processors/document-financials-projection";
import { DOC_SOURCE } from "@usemoney/core/market-data/document-financials-projection";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const FY2025_END = new Date("2025-03-31T00:00:00.000Z");

interface ExtractRow {
  id: string;
  documentId: string;
  instrumentId: string | null;
  symbol: string;
  exchange: string;
  fiscalYear: string;
  periodEnd: Date;
  periodType: string;
  basis: string;
  status: string;
  reconcileVerdict: string | null;
  projectedAt: Date | null;
  model: string;
  promptVersion: string;
  confidence: number | null;
  scaleLabel: string | null;
  scaleFactor: number | null;
  extractedAt: Date;
  [col: string]: unknown;
}

function extract(over: Partial<ExtractRow> = {}): ExtractRow {
  return {
    id: "e1",
    documentId: "d1",
    instrumentId: "i1",
    symbol: "AAA",
    exchange: "NSE",
    fiscalYear: "FY2025",
    periodEnd: FY2025_END,
    periodType: "ANNUAL",
    basis: "CONSOLIDATED",
    status: "EXTRACTED",
    reconcileVerdict: "INCOMPARABLE",
    projectedAt: null,
    model: "m",
    promptVersion: "v1",
    confidence: 0.9,
    scaleLabel: null,
    scaleFactor: null,
    extractedAt: new Date("2026-08-20T00:00:00.000Z"),
    revenueFromOperations: 100,
    otherIncome: 5,
    operatingIncomeExOtherIncome: 20,
    netIncome: 15,
    ebitdaBeforeExceptionalItems: 25,
    totalAssets: 500,
    totalLiabilities: 200,
    totalEquity: 300,
    totalDebt: 40,
    totalCash: 60,
    operatingCashFlow: 30,
    capitalExpenditure: 4,
    freeCashFlow: 26,
    ...over,
  };
}

interface FinancialsRow {
  symbol: string;
  exchange: string;
  statementType: string;
  periodType: string;
  period: string;
  source: string;
  fetchedAt?: Date;
  rawData?: unknown;
  basis?: string | null;
  [col: string]: unknown;
}

/**
 * A store that implements only the queries this job issues.
 *
 * `unprojectedOnly` is implemented as "projectedAt is null OR absent", which is
 * what `UNPROJECTED_EXTRACT_WHERE` means on Mongo. Getting that wrong in the
 * FAKE would make the test agree with a broken selector, so the shape is
 * asserted separately against the exported constant.
 */
function makeStore(
  extracts: ExtractRow[],
  financials: FinancialsRow[] = [],
  opts: { stampCount?: (named: number) => number } = {},
) {
  const created: FinancialsRow[] = [];
  const updated: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const stamps: Array<{ ids: string[]; projectedAt: unknown }> = [];

  const db = {
    documentFinancialExtract: {
      findMany: async (q: Record<string, unknown>) => {
        const where = (q.where ?? {}) as Record<string, unknown>;
        let rows = extracts.filter((r) => {
          if (where.status && r.status !== where.status) return false;
          const sym = where.symbol as
            | { in?: string[]; gt?: string }
            | undefined;
          if (sym?.in && !sym.in.includes(r.symbol)) return false;
          if (sym?.gt !== undefined && !(r.symbol > sym.gt)) return false;
          const pt = where.periodType as { in?: string[] } | undefined;
          if (pt?.in && !pt.in.includes(r.periodType)) return false;
          if (Array.isArray(where.OR)) {
            if (r.projectedAt !== null && r.projectedAt !== undefined) {
              return false;
            }
          }
          return true;
        });
        rows = rows.sort(
          (a, b) =>
            a.symbol.localeCompare(b.symbol) ||
            b.periodEnd.getTime() - a.periodEnd.getTime() ||
            a.basis.localeCompare(b.basis) ||
            a.id.localeCompare(b.id),
        );
        const take = q.take as number | undefined;
        return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
      },
      updateMany: async (q: {
        where: { id: { in: string[] } };
        data: { projectedAt: unknown };
      }) => {
        const ids = q.where.id.in;
        stamps.push({ ids: [...ids], projectedAt: q.data.projectedAt });
        const count = opts.stampCount ? opts.stampCount(ids.length) : ids.length;
        for (const id of ids.slice(0, count)) {
          const row = extracts.find((r) => r.id === id);
          if (row) row.projectedAt = q.data.projectedAt as Date;
        }
        return { count };
      },
      count: async () => extracts.length,
    },
    stockFinancials: {
      findMany: async (q: Record<string, unknown>) => {
        const where = (q.where ?? {}) as Record<string, unknown>;
        const sym = where.symbol as { in?: string[] } | undefined;
        const st = where.statementType as { in?: string[] } | undefined;
        return financials
          .filter(
            (r) =>
              (!sym?.in || sym.in.includes(r.symbol)) &&
              (!st?.in || st.in.includes(r.statementType)),
          )
          .map((r) => ({ ...r }));
      },
      create: async (q: { data: FinancialsRow }) => {
        created.push(q.data);
        financials.push(q.data);
        return q.data;
      },
      update: async (q: {
        where: unknown;
        data: Record<string, unknown>;
      }) => {
        updated.push({ where: q.where, data: q.data });
        return q.data;
      },
    },
  };

  return {
    // NonNullable: the second parameter is OPTIONAL, so `Parameters<…>[1]` is
    // `{prisma?: …} | undefined` and indexing `["prisma"]` on it is an error
    // (MONEY-1326). Unwrapping the optionality is what the expression always
    // meant — "the type of the `prisma` field of the options object".
    db: db as unknown as NonNullable<
      Parameters<typeof processDocumentFinancialsProjectionWrite>[1]
    >["prisma"],
    created,
    updated,
    stamps,
    extracts,
    financials,
  };
}

/**
 * Capture the structured `job-outcome` lines `reportJobOutcome` writes.
 *
 * It emits one JSON line through `console.log` or `console.warn` (a job that
 * found work and wrote none is a WARNING even when it succeeded), so both are
 * intercepted. Always restored in a `finally` — a test that leaks a console
 * patch corrupts every test after it in the same process.
 */
function captureOutcomes() {
  const seen: Array<Record<string, unknown>> = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const grab = (...args: unknown[]) => {
    for (const a of args) {
      if (typeof a !== "string" || !a.includes('"job-outcome"')) continue;
      // The emitted line is `[job-outcome] {json}` — and on the wrote-zero
      // branch it is a whole sentence with the json appended, so the JSON is
      // taken from the FIRST `{` rather than parsing the argument whole.
      const start = a.indexOf("{");
      if (start === -1) continue;
      try {
        seen.push(JSON.parse(a.slice(start)) as Record<string, unknown>);
      } catch {
        /* not the line we want */
      }
    }
  };
  console.log = grab as typeof console.log;
  console.warn = grab as typeof console.warn;
  return {
    outcomes: () => seen,
    restore: () => {
      console.log = realLog;
      console.warn = realWarn;
    },
  };
}

// ─── The arming flag ─────────────────────────────────────────────────

describe("DOC_FINANCIALS_APPLY is compared against the LITERAL string", () => {
  it('arms ONLY on exactly "true"', () => {
    assert.equal(isDocProjectionArmed({ DOC_FINANCIALS_APPLY: "true" }), true);
  });

  it('does NOT arm on "false" — Boolean("false") is true, and that is the whole point', () => {
    // The MONEY-1214 class: a truthiness check arms the job in the ONE
    // configuration meant to keep it off, and the spec ships PRESENT-and-false
    // precisely so an operator can see the switch exists.
    assert.equal(isDocProjectionArmed({ DOC_FINANCIALS_APPLY: "false" }), false);
    assert.equal(
      Boolean("false"),
      true,
      "if this ever stops being true the comment above is stale",
    );
  });

  it("does not arm on any near-miss spelling", () => {
    for (const v of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""]) {
      assert.equal(
        isDocProjectionArmed({ DOC_FINANCIALS_APPLY: v }),
        false,
        `${JSON.stringify(v)} must not arm the write`,
      );
    }
  });

  it("does not arm when the variable is ABSENT", () => {
    assert.equal(isDocProjectionArmed({}), false);
  });

  it("a MESSAGE can narrow the arm and can NEVER set it", () => {
    const armed = { DOC_FINANCIALS_APPLY: "true" };
    const disarmed = { DOC_FINANCIALS_APPLY: "false" };
    assert.equal(resolveDocApply(undefined, armed), true);
    assert.equal(resolveDocApply({ apply: false }, armed), false, "narrows");
    assert.equal(
      resolveDocApply({ apply: true }, disarmed),
      false,
      "a message must not be able to arm a run the environment has not armed",
    );
    assert.equal(resolveDocApply({ apply: true }, {}), false);
  });
});

// ─── The cursor ──────────────────────────────────────────────────────

describe("the projectedAt cursor", () => {
  it("selects on BOTH null and ABSENT — a bare `null` matches nothing on Mongo", () => {
    // MONEY-1050 / 1205 / 1234 / 1236: a `db push` creates indexes, never
    // fields, so a column added after rows exist is ABSENT on them and Prisma's
    // Mongo connector does not treat absent as null.
    const or = UNPROJECTED_EXTRACT_WHERE.OR as ReadonlyArray<
      Record<string, unknown>
    >;
    assert.equal(or.length, 2);
    assert.deepEqual(or[0], { projectedAt: null });
    assert.deepEqual(or[1], { projectedAt: { isSet: false } });
  });

  it("a DRY RUN stamps nothing, so the first armed run does not skip a rehearsal's work", async () => {
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: false, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.created, 3, "a dry run still reports what WOULD land");
    assert.equal(store.created.length, 0, "and writes nothing");
    assert.equal(store.stamps.length, 0, "and stamps nothing");
    assert.equal(r.stampAttempted, 0);
    assert.equal(r.stamped, 0);
  });

  it("a CREATE-SUPPRESSED extract is NOT stamped — the bug that burns a page per night", async () => {
    // The XBRL writer filled its decided-set for a whole group BEFORE any
    // statement was written, and its CREATE branch returned without recording a
    // failure. Armed with `createMissing:false` that stamps every row it just
    // declined to create; the later deliberate pilot then selects none of them,
    // recoverable only by a hand `$unset`.
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: false, now: NOW },
      { prisma: store.db },
    );
    assert.ok(r.skippedCreateSuppressed > 0, "the create must be suppressed");
    assert.equal(store.created.length, 0);
    assert.equal(
      store.stamps.length,
      0,
      "a suppressed create is a property of the RUN, not of the extract",
    );
    assert.equal(r.stamped, 0);
    assert.equal(
      store.extracts[0]!.projectedAt,
      null,
      "the row must come back on the next run",
    );
  });

  it("an UNGRADED extract is NOT stamped — the verdict flips with nothing new arriving", async () => {
    const store = makeStore([extract({ reconcileVerdict: null })]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.ok(r.skipped.NOT_GRADED > 0);
    assert.equal(store.created.length, 0);
    assert.equal(store.stamps.length, 0);
    assert.equal(store.extracts[0]!.projectedAt, null);
  });

  it("a BLOCKED verdict IS stamped — that is a property of the extract and will not change", async () => {
    const store = makeStore([extract({ reconcileVerdict: "SCALE_MISMATCH" })]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.ok(r.skipped.VERDICT_BLOCKS > 0);
    assert.equal(store.created.length, 0, "nothing may be written");
    assert.equal(r.stamped, 1, "but re-reading it nightly forever is pure cost");
  });

  it("an armed CREATE stamps the WHOLE group, winner and superseded sibling alike", async () => {
    // Stamping the winner alone would leave a STANDALONE loser to form a group
    // of ONE on the next run and win it trivially, writing parent-only numbers
    // over the consolidated row.
    const store = makeStore([
      extract({ id: "cons", basis: "CONSOLIDATED" }),
      extract({ id: "stand", basis: "STANDALONE", totalAssets: 111 }),
    ]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.supersededSiblings, 1);
    assert.equal(r.stamped, 2);
    assert.deepEqual(store.stamps[0]?.ids.sort(), ["cons", "stand"]);
    // And the CONSOLIDATED numbers are the ones that landed.
    const bs = store.created.find((c) => c.statementType === "BALANCE_SHEET");
    assert.equal(bs?.totalAssets, 500);
  });

  it("reads the stamp COUNT back rather than assuming it", async () => {
    // A stamp that silently matched zero rows is otherwise indistinguishable
    // from one that moved the whole page: the run reports written/failed/ok
    // identically either way, and the next night re-reads the same page.
    const store = makeStore([extract()], [], { stampCount: () => 0 });
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.stampAttempted, 1);
    assert.equal(r.stamped, 0, "the store's own count, not the attempt count");
  });

  it("dropPartialTrailingSymbol defers a page that ended mid-symbol", () => {
    const rows = [
      { symbol: "AAA", id: 1 },
      { symbol: "AAA", id: 2 },
      { symbol: "BBB", id: 3 },
    ];
    const { kept, deferred } = dropPartialTrailingSymbol(rows);
    assert.deepEqual(
      kept.map((r) => r.id),
      [1, 2],
    );
    assert.equal(deferred, 1);
  });

  it("dropPartialTrailingSymbol never empties the page, which would stall the cursor forever", () => {
    const rows = [
      { symbol: "AAA", id: 1 },
      { symbol: "AAA", id: 2 },
    ];
    const { kept, deferred } = dropPartialTrailingSymbol(rows);
    assert.equal(kept.length, 2);
    assert.equal(deferred, 0);
    assert.deepEqual(dropPartialTrailingSymbol([]), { kept: [], deferred: 0 });
  });

  it("pages through the population and reports whether it DRAINED", async () => {
    const rows = ["AAA", "BBB", "CCC", "DDD"].map((s) =>
      extract({ id: s, symbol: s }),
    );
    const store = makeStore(rows);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, limit: 2, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.drained, true);
    assert.equal(r.nextAfterSymbol, null);
    assert.equal(r.extractsRead, 4, "every symbol was eventually read");
    assert.equal(r.periods, 4);
  });

  it("stops on the PAGE budget and hands back a resume point rather than silently truncating", async () => {
    const rows = ["AAA", "BBB", "CCC", "DDD"].map((s) =>
      extract({ id: s, symbol: s }),
    );
    const store = makeStore(rows);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: false, createMissing: true, limit: 2, maxPages: 1, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.drained, false);
    assert.equal(
      r.nextAfterSymbol,
      "AAA",
      "the trailing symbol was deferred, so the cursor stops before it",
    );
    assert.equal(r.deferredByPagination, 1);
  });
});

// ─── The write ───────────────────────────────────────────────────────

describe("what actually reaches the store", () => {
  it("an armed run CREATES all three statements, stamped DOC_PDF, with periodEnd and basis", async () => {
    const store = makeStore([extract()]);
    await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(store.created.length, 3);
    for (const row of store.created) {
      assert.equal(row.source, DOC_SOURCE);
      assert.equal(row.instrumentId, "i1");
      assert.deepEqual(row.periodEnd, FY2025_END);
      assert.equal(row.basis, "CONSOLIDATED");
      assert.equal(
        row.period,
        "FY 2025",
        "the period label must match what the reconcile joined on",
      );
    }
    const income = store.created.find((c) => c.statementType === "INCOME");
    // The DERIVED total, not a raw column.
    assert.equal(income?.revenue, 105);
    assert.equal(income?.revenueFromOperations, 100);
    // And no unowned vendor column is mentioned at all.
    for (const col of ["operatingIncome", "ebitda", "grossProfit"]) {
      assert.ok(!(col in (income ?? {})), `${col} must not appear in the patch`);
    }
  });

  it("writes NULL, never 0, for an owned column the extract did not source", async () => {
    const store = makeStore([extract({ netIncome: null })]);
    await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    const income = store.created.find((c) => c.statementType === "INCOME");
    assert.equal(income?.netIncome, null);
    assert.notEqual(income?.netIncome, 0);
  });

  it("does NOT create when the extract has no instrument, and does NOT stamp it either", async () => {
    const store = makeStore([extract({ instrumentId: null })]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(store.created.length, 0);
    assert.equal(r.skippedNoInstrument, 3);
    assert.equal(
      store.stamps.length,
      0,
      "instrument-sync fills that gap on its own schedule, with nothing new " +
        "arriving from the extractor",
    );
  });

  it("REGRESSION: a default run writes NOTHING", async () => {
    const store = makeStore([extract()]);
    await processDocumentFinancialsProjectionWrite({}, { prisma: store.db });
    assert.equal(store.created.length, 0);
    assert.equal(store.updated.length, 0);
    assert.equal(store.stamps.length, 0);
  });

  it("REGRESSION: a period with no incumbent is not created by default", async () => {
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(store.created.length, 0);
    assert.ok(r.skippedCreateSuppressed > 0);
  });

  it("REGRESSION: a second run performs ZERO writes — the job is a fixpoint", async () => {
    const store = makeStore([extract()]);
    await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(store.created.length, 3);
    // Un-stamp so the same rows are re-selected, isolating the WRITE decision
    // from the cursor. Both must independently be no-ops.
    for (const e of store.extracts) e.projectedAt = null;
    const before = store.created.length;
    const r2 = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(store.created.length, before, "no second create");
    assert.equal(store.updated.length, 0, "and no identical update");
    assert.equal(r2.skipped.UNCHANGED, 3);
  });

  it("never writes over NSE_XBRL — the only source that outranks DOC_PDF", async () => {
    const store = makeStore(
      [extract()],
      [
        {
          symbol: "AAA",
          exchange: "NSE",
          statementType: "INCOME",
          periodType: "ANNUAL",
          period: "FY 2025",
          source: "NSE_XBRL",
          revenue: 1,
        },
      ],
    );
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.skipped.AUTHORITY, 1);
    assert.equal(
      store.updated.length,
      0,
      "NSE_XBRL outranks DOC_PDF and the row must be untouched",
    );
    // The other two statements have no incumbent and are still created.
    assert.equal(store.created.length, 2);
  });

  it("DOES write over a vendor, and preserves what it displaced", async () => {
    // MONEY-1255. This behaviour CHANGED with the rank-2 promotion: TICKERTAPE
    // used to be skipped here. It is now displaced, which is the point of the
    // promotion and also its only real risk — `stock_financials` has no
    // `source` in its unique key, so the vendor's number is gone the instant
    // this write lands. The displacement record is the sole reason a wrong
    // reading is recoverable, so asserting the WRITE without asserting the
    // RECORD would pass against an implementation that destroys the evidence.
    const store = makeStore(
      [extract()],
      [
        {
          symbol: "AAA",
          exchange: "NSE",
          statementType: "INCOME",
          periodType: "ANNUAL",
          period: "FY 2025",
          source: "TICKERTAPE",
          revenue: 1,
        },
      ],
    );
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.skipped.AUTHORITY ?? 0, 0, "a vendor must not be skipped");
    assert.equal(store.updated.length, 1, "the vendor row must be updated");
    const patch = store.updated[0]?.data ?? store.updated[0];
    assert.equal(
      (patch as Record<string, unknown>).source,
      DOC_SOURCE,
      "the row must be re-stamped DOC_PDF",
    );
    const raw = (patch as Record<string, any>).rawData;
    assert.equal(
      raw?.displacedByXbrl?.displacedSource,
      "TICKERTAPE",
      "the displaced TICKERTAPE value must be preserved in rawData",
    );
    assert.equal(store.created.length, 2);
  });
});

// ─── Reporting ───────────────────────────────────────────────────────

describe("the outcome report", () => {
  it("names EVERY door that closed, so `written 0` is never reported bare", async () => {
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: false, now: NOW },
      { prisma: store.db },
    );
    const reason = describeNoWriteReason(r);
    assert.match(reason, /createSuppressed=3/);
    assert.ok(countWithheldWrites(r) >= 3);
    const doors = summariseWriteDoors(r);
    for (const k of [
      "createSuppressed",
      "noInstrument",
      "AUTHORITY",
      "UNCHANGED",
      "NOT_GRADED",
      "VERDICT_BLOCKS",
      "BASIS_DOWNGRADE",
      "STANDALONE_NO_DISPLACE",
      "NO_VALUES",
      "NOT_EXTRACTED",
    ]) {
      assert.ok(doors.includes(k), `${k} must appear in the door summary`);
    }
  });

  it("an ALL-ZERO door set with rows selected is called out as a selector defect", () => {
    const r = {
      extractsRead: 500,
      skippedCreateSuppressed: 0,
      skippedNoInstrument: 0,
      skipped: {
        AUTHORITY: 0,
        UNCHANGED: 0,
        BASIS_DOWNGRADE: 0,
        STANDALONE_NO_DISPLACE: 0,
        NOT_EXTRACTED: 0,
        NOT_GRADED: 0,
        VERDICT_BLOCKS: 0,
        NO_VALUES: 0,
      },
    } as Parameters<typeof describeNoWriteReason>[0];
    assert.match(describeNoWriteReason(r), /selector or grouping defect/);
  });

  it("a per-row failure sets ok=false and is COUNTED — it never aborts the run", async () => {
    // `ok` is the writer's own judgement. Hardcoding it one layer up is the
    // completeness-signal-at-the-wrong-granularity defect this repo has shipped
    // six times (MONEY-1189 / MONEY-1238), and it is invisible in every other
    // number: the run still reports rows selected and rows written.
    const store = makeStore([extract()]);
    let calls = 0;
    const inner = store.db as unknown as {
      stockFinancials: { create: (q: unknown) => Promise<unknown> };
    };
    const realCreate = inner.stockFinancials.create;
    inner.stockFinancials.create = async (q: unknown) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return realCreate(q as never);
    };
    const r = await processDocumentFinancialsProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: store.db },
    );
    assert.equal(r.failed, 1);
    assert.equal(r.ok, false, "one failed row must fail the run's ok");
    assert.equal(r.created, 2, "the other statements still landed");
    assert.equal(
      store.stamps.length,
      0,
      "a failed row keeps its null stamp so the next run retries it",
    );
  });

  it("the JOB layer propagates the writer's ok rather than hardcoding it", async () => {
    const store = makeStore([extract()]);
    const inner = store.db as unknown as {
      stockFinancials: { create: (q: unknown) => Promise<unknown> };
    };
    inner.stockFinancials.create = async () => {
      throw new Error("boom");
    };
    const r = await processDocumentFinancialsProjection(
      { createMissing: true },
      { prisma: store.db, now: NOW, env: { DOC_FINANCIALS_APPLY: "true" } },
    );
    assert.equal(r.failed, 3);
    assert.equal(r.ok, false);
  });

  it("emits an outcome even when the run THROWS — the run most needing a metric is the one that died", async () => {
    // `reportJobOutcome` on the happy path is exactly the one that does not
    // fire when it matters. It is emitted from a `finally`.
    const store = makeStore([extract()]);
    const inner = store.db as unknown as {
      documentFinancialExtract: { findMany: () => Promise<unknown> };
    };
    inner.documentFinancialExtract.findMany = async () => {
      throw new Error("atlas is down");
    };
    const lines = captureOutcomes();
    try {
      await assert.rejects(
        () =>
          processDocumentFinancialsProjection(
            {},
            { prisma: store.db, now: NOW, env: {} },
          ),
        /atlas is down/,
        "the throw must PROPAGATE so the route 500s and Pub/Sub retries",
      );
    } finally {
      lines.restore();
    }
    const outcome = lines.outcomes()[0];
    assert.ok(outcome, "an outcome must be emitted on the throwing path");
    assert.equal(outcome.job, "document-financials-projection");
    assert.equal(outcome.selected, 0);
    assert.equal(outcome.written, 0);
    assert.equal(outcome.failed, 1);
    assert.match(String(outcome.skippedReason), /THREW/);
  });

  it("an IDLE run reports 0/0 and SAYS it is idle — silence is how a dead job hides", async () => {
    // stock-document-extract put its report below an empty-queue early return,
    // so a night with nothing to do emitted nothing — and a freshness monitor
    // with notify_no_data would have gone red the moment the backlog drained,
    // then been muted as a false alarm.
    const store = makeStore([]);
    const lines = captureOutcomes();
    let r;
    try {
      r = await processDocumentFinancialsProjection(
        {},
        {
          prisma: store.db,
          now: NOW,
          env: { DOC_FINANCIALS_APPLY: "true" },
        },
      );
    } finally {
      lines.restore();
    }
    assert.equal(r.selected, 0);
    assert.equal(r.written, 0);
    const outcome = lines.outcomes()[0];
    assert.ok(outcome, "an idle run must still emit an outcome");
    assert.equal(outcome.selected, 0);
    assert.equal(outcome.written, 0);
    assert.equal(outcome.failed, 0);
    assert.match(String(outcome.skippedReason), /idle/);
  });

  it("the reason string carries the PER-DECISION counts, so `written 0` is never ambiguous", async () => {
    // "wrote 0 rows" is ambiguous between a fixpoint and an incident, and the
    // two need opposite responses.
    const store = makeStore([extract()]);
    const lines = captureOutcomes();
    try {
      await processDocumentFinancialsProjection(
        { createMissing: false },
        { prisma: store.db, now: NOW, env: { DOC_FINANCIALS_APPLY: "true" } },
      );
    } finally {
      lines.restore();
    }
    const reason = String(lines.outcomes()[0]?.skippedReason ?? "");
    for (const k of [
      "created=",
      "updated=",
      "displaced=",
      "AUTHORITY=",
      "createSuppressed=",
      "stamped=",
      "drained=",
      "authority=",
    ]) {
      assert.ok(reason.includes(k), `${k} must travel with the outcome`);
    }
  });

  it("the JOB layer keeps the writer's `ok` instead of hardcoding it", async () => {
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjection(
      { createMissing: true },
      { prisma: store.db, now: NOW, env: {} },
    );
    assert.equal(r.applied, false, "an empty env must not arm the run");
    assert.equal(r.ok, true);
    assert.equal(r.written, 3, "a dry run reports what WOULD land");
    assert.equal(store.created.length, 0, "and writes nothing");
    assert.equal(r.stamped, 0);
  });

  it("the JOB layer cannot be armed by an injected env that says anything but 'true'", async () => {
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjection(
      { createMissing: true },
      {
        prisma: store.db,
        now: NOW,
        env: { DOC_FINANCIALS_APPLY: "false" },
      },
    );
    assert.equal(r.applied, false);
    assert.equal(store.created.length, 0);
  });

  it("the JOB layer writes when the env says exactly 'true'", async () => {
    const store = makeStore([extract()]);
    const r = await processDocumentFinancialsProjection(
      { createMissing: true },
      { prisma: store.db, now: NOW, env: { DOC_FINANCIALS_APPLY: "true" } },
    );
    assert.equal(r.applied, true);
    assert.equal(store.created.length, 3);
    assert.equal(r.stamped, 1);
    assert.equal(r.drained, true);
  });
});
