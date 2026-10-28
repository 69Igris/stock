/**
 * UNIT TEST — the XBRL → StockFinancials WRITER seam (MONEY-1115, P10 F3).
 *
 * The pure decisions are covered next door in
 * `packages/core/__tests__/market-data/xbrl-projection-write.test.ts`. This file
 * covers the part that can only go wrong at the seam: whether the processor
 * actually HONOURS those decisions when it has a database in its hands.
 *
 * MONEY-1092/1093 is the reason this layer exists at all — a fix that was
 * correct in the unit and inert at the call site, because the narrowed payload
 * never reached the `update:` clause. So every case here drives the REAL
 * exported `processXbrlProjectionWrite` against an in-memory store and asserts
 * on the payloads that reached it.
 *
 * ## The interlocks, and what each one is holding back
 *
 * `StockFinancials` has no `source` in its unique key, so the first write for a
 * period destroys the Tickertape value permanently. Three of the cases below
 * are the switches that stop that happening by accident:
 *
 *   - `REGRESSION: a default run writes NOTHING` — `apply` defaults to false.
 *   - `REGRESSION: a period with no incumbent is not created by default` — a
 *     create is a row the reconciliation never compared, and is also exactly
 *     what a period-label join bug looks like.
 *   - `REGRESSION: a second run performs ZERO writes` — the fixpoint, and the
 *     integration form of "a refresh must not rewrite the displacement record".
 *
 * The store is a plain object; there is no DB, no network, no timer, nothing to
 * orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  countWithheldWrites,
  dropPartialTrailingSymbol,
  processXbrlProjectionWrite,
  describeNoWriteReason,
  observeScale,
  readFacts,
  toCroreDenominated,
  type FilingRow,
  type XbrlProjectionWriteResult,
} from "../../src/processors/xbrl-projection-writer";
// The JOB, not the writer — MONEY-1238. What a run REPORTS is decided here, one
// layer above every counter this file otherwise asserts on, and it was the
// layer that discarded them.
import { processXbrlProjection } from "../../src/processors/xbrl-projection";
// The REAL constant, not a local 1e7. If the conversion factor ever moves, the
// fixtures below move with it instead of quietly disagreeing with the writer.
import { RUPEES_PER_CRORE, reconcile } from "@usemoney/core/market-data";

const REPO_ROOT = repoRoot();

/* -------------------------------------------------------------------------- */
/* In-memory store                                                             */
/* -------------------------------------------------------------------------- */

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2026-08-14T09:30:00.000Z");

type Row = Record<string, unknown>;

/**
 * A filing with just enough real shape to project. `facts` mirrors what
 * `xbrl-sync` stores: the whole parsed `XbrlFinancials`, of which the projector
 * reads `family` and `values`.
 */
function filing(over: Partial<FilingRow> & { symbol: string }): FilingRow {
  return {
    id: `f-${over.symbol}-${String(over.periodEnd ?? "")}-${over.basis ?? "C"}`,
    instrumentId: "inst-1",
    exchange: "NSE",
    periodStart: utc("2025-07-01"),
    periodEnd: utc("2025-09-30"),
    periodType: "QUARTERLY",
    basis: "CONSOLIDATED",
    cumulative: false,
    coverage: 0.8,
    taxonomyVersion: "2020-03-31",
    sourceUrl: `https://nsearchives/${over.symbol}.xml`,
    filedAt: utc("2025-10-20"),
    // MONEY-1205 — XBRL facts are ABSOLUTE RUPEES; `StockFinancials` is
    // ₹ CRORE. These are ₹1,000 Cr of revenue and ₹100 Cr of profit expressed
    // the way a filing expresses them, so the assertions below (`revenue ===
    // 1000`) are the CRORE figures the writer must land — and they are now
    // directly comparable with `tickertapeRow()`'s 950, which is also crore.
    //
    // Before this ticket the fixture held a bare `1000` and the writer passed
    // it through unconverted, so the test compared ₹1,000 of XBRL against
    // ₹950 CRORE of Tickertape and called that a displacement. It asserted the
    // units bug rather than catching it.
    facts: {
      family: "ind-as",
      values: {
        revenueFromOperations: 1000 * RUPEES_PER_CRORE,
        profitForPeriod: 100 * RUPEES_PER_CRORE,
      },
    },
    ...over,
  } as FilingRow;
}

interface Store {
  filings: FilingRow[];
  financials: Row[];
  creates: Row[];
  updates: Array<{ where: unknown; data: Row }>;
  throwOnUpdate?: boolean;
  /**
   * The cursor `updateMany` THROWS — MONEY-1238.
   *
   * A Mongo error on the stamp, which the writer deliberately swallows (a
   * cursor that fails to advance costs a repeated read, never a wrong number).
   * The whole question this phase asks is whether that swallowed failure is
   * still VISIBLE afterwards.
   */
  throwOnStamp?: boolean;
  /**
   * The cursor `updateMany` reports a SMALLER `count` than the ids it was given
   * — MONEY-1238.
   *
   * The quieter half of the same defect and the one a try/catch cannot see:
   * Mongo raises nothing, it simply matched fewer rows. Indistinguishable from
   * a full stamp unless the count is read.
   */
  stampCount?: number;
  /** Filing ids whose `projectedAt` cursor was stamped. */
  stamped: string[];
  /**
   * `xbrlFiling.findMany` round-trips this run — MONEY-1237.
   *
   * The sibling-context fetch has to be ONE grouped query for the WHOLE page.
   * A per-symbol lookup is the N+1 that made the F3 reconcile un-runnable
   * (MONEY-1234: 6h20m at 0.0% CPU, killed unfinished) and this job runs
   * against a 600s Pub/Sub ack deadline that cannot be raised. Counting the
   * calls is the only way a unit test can tell those two implementations
   * apart — both return identical context.
   */
  filingQueries: number;
}

function fakePrisma(store: Store) {
  const keyOf = (r: Row): string =>
    [r.symbol, r.exchange, r.statementType, r.periodType, r.period].join("|");

  return {
    xbrlFiling: {
      findMany: async (args: {
        where?: {
          symbol?: { in: string[] };
          periodEnd?: { gte?: Date; lte?: Date };
          periodType?: { in: string[] };
          id?: { notIn: string[] };
          OR?: unknown;
        };
        take?: number;
      }) => {
        store.filingQueries++;
        let rows = [...store.filings];
        const inList = args.where?.symbol?.in;
        if (inList) rows = rows.filter((r) => inList.includes(r.symbol));
        const gte = args.where?.periodEnd?.gte;
        if (gte)
          rows = rows.filter((r) => r.periodEnd.getTime() >= gte.getTime());
        // `lte` and `notIn` are BOTH MONEY-1237's sibling-context query, and a
        // fake that ignored them was not a simplification — it was a defect
        // generator. `fetchScaleContext` excludes the page's own ids
        // server-side; ignoring `notIn` handed every candidate a SECOND copy of
        // each of its own siblings, which shifts a median made of an odd number
        // of points onto a different element. Measured on the SILGO fixture:
        // the oldest year's newer-side median moved from 33.1 (healthy) to
        // 31,892.57 (the mis-scaled year itself), and a correct filing came
        // back SCALE_UNCONFIRMED. The test would have "caught" a bug that only
        // its own store could produce.
        const lte = args.where?.periodEnd?.lte;
        if (lte)
          rows = rows.filter((r) => r.periodEnd.getTime() <= lte.getTime());
        const notIn = args.where?.id?.notIn;
        if (notIn) rows = rows.filter((r) => !notIn.includes(r.id));
        // MONEY-1235. Honouring this in the fake is the whole point: a filter
        // the store ignores is a filter the test cannot tell apart from one
        // applied after the eligibility verdict, and those two differ by
        // whether the nightly cursor advances at all.
        const pt = args.where?.periodType?.in;
        if (pt) rows = rows.filter((r) => pt.includes(r.periodType));
        // `unprojectedOnly` — mirrors OR[{null},{isSet:false}] over a store
        // where an unstamped row simply has no `projectedAt` key, which is
        // exactly the Mongo shape that broke the real filter.
        if (args.where?.OR)
          rows = rows.filter(
            (r) => (r as { projectedAt?: Date | null }).projectedAt == null,
          );
        // Mirror the processor's `orderBy: [symbol asc, periodEnd desc]` — the
        // pagination guard is only sound because the read is symbol-major.
        rows.sort(
          (a, b) =>
            a.symbol.localeCompare(b.symbol) ||
            b.periodEnd.getTime() - a.periodEnd.getTime(),
        );
        return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
      },
      updateMany: async (args: {
        where: { id: { in: string[] } };
        data: { projectedAt: Date };
      }) => {
        // MONEY-1238. A stamp that throws is the loud half of the
        // silent-cursor defect; the writer catches it on purpose, so the store
        // has to be able to produce it or the catch is untestable.
        if (store.throwOnStamp) throw new Error("stamp conflict");
        store.stamped.push(...args.where.id.in);
        for (const r of store.filings)
          if (args.where.id.in.includes(r.id))
            (r as { projectedAt?: Date }).projectedAt = args.data.projectedAt;
        // The QUIET half: Mongo matched fewer rows than we named and said so
        // only in `count`. Overridable, never invented — the default is the
        // honest full count.
        return {
          count:
            typeof store.stampCount === "number"
              ? store.stampCount
              : args.where.id.in.length,
        };
      },
    },
    stockFinancials: {
      findUnique: async (args: {
        where: { symbol_exchange_statementType_periodType_period: Row };
      }) => {
        const want = keyOf(
          args.where.symbol_exchange_statementType_periodType_period,
        );
        return store.financials.find((r) => keyOf(r) === want) ?? null;
      },
      create: async (args: { data: Row }) => {
        store.creates.push(args.data);
        store.financials.push({ ...args.data });
        return args.data;
      },
      update: async (args: {
        where: { symbol_exchange_statementType_periodType_period: Row };
        data: Row;
      }) => {
        if (store.throwOnUpdate) throw new Error("write conflict");
        store.updates.push({ where: args.where, data: args.data });
        const want = keyOf(
          args.where.symbol_exchange_statementType_periodType_period,
        );
        const row = store.financials.find((r) => keyOf(r) === want);
        assert.ok(row, "update targeted a row that does not exist");
        Object.assign(row, args.data);
        return row;
      },
    },
  } as never;
}

function emptyStore(over: Partial<Store> = {}): Store {
  return {
    filings: [],
    financials: [],
    creates: [],
    updates: [],
    stamped: [],
    filingQueries: 0,
    ...over,
  };
}

/** A Tickertape INCOME row for the period the fixtures project into. */
function tickertapeRow(over: Row = {}): Row {
  return {
    symbol: "TESTCO",
    exchange: "NSE",
    statementType: "INCOME",
    periodType: "QUARTERLY",
    period: "Q2-2026",
    source: "TICKERTAPE",
    fetchedAt: utc("2026-01-05"),
    rawData: { period: "Q2-2026", revenuef: 950 },
    revenue: 950,
    netIncome: 90,
    ebitda: 123,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* The interlocks                                                              */
/* -------------------------------------------------------------------------- */

describe("processXbrlProjectionWrite — the write interlocks", () => {
  it("REGRESSION: a default run writes NOTHING", async () => {
    // `apply` defaults to false. The first write for a period destroys the
    // Tickertape value with no second copy anywhere, so arming has to be a
    // deliberate act — not the consequence of invoking the job.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const res = await processXbrlProjectionWrite(
      { now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.apply, false);
    assert.deepEqual(store.creates, []);
    assert.deepEqual(store.updates, []);
    assert.equal(
      store.financials[0]!.revenue,
      950,
      "the row must be untouched",
    );
    assert.equal(store.financials[0]!.source, "TICKERTAPE");
    // …and it must still REPORT what it would have done, or a dry run is
    // useless as evidence.
    assert.equal(res.updated, 1);
    assert.equal(res.displaced, 1);
  });

  it("REGRESSION: a period with no incumbent is not created by default", async () => {
    // A create is a row the reconciliation never compared. It is also exactly
    // what a `periodLabel` join bug looks like: Tickertape's label is stored
    // verbatim from its feed, so if our derivation is wrong then EVERY period
    // looks like new ground and gets duplicated under a second label.
    const store = emptyStore({ filings: [filing({ symbol: "TESTCO" })] });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.deepEqual(store.creates, []);
    assert.equal(res.created, 0);
    assert.equal(res.skippedCreateSuppressed, 1);
  });

  it("creates only when explicitly asked, and stamps the projection", async () => {
    const store = emptyStore({ filings: [filing({ symbol: "TESTCO" })] });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.created, 1);
    const created = store.creates[0]!;
    assert.equal(created.source, "NSE_XBRL");
    assert.equal(created.instrumentId, "inst-1");
    assert.equal(created.period, "Q2-2026");
    assert.equal(created.periodType, "QUARTERLY");
    assert.equal(created.statementType, "INCOME");
    assert.equal(created.revenueFromOperations, 1000);
    assert.equal(created.netIncome, 100);
    // MONEY-1235 — whose accounts these are, on the row itself. `rawData` has
    // carried it since the first projection write, but a Json blob is not
    // something the Financials tab or a research tool can filter or display,
    // and consolidated-vs-standalone differs by a MULTIPLE for any holdco.
    assert.equal(created.basis, "CONSOLIDATED");
    // …and the stamp landed, because a create IS a decision.
    assert.deepEqual(store.stamped, [store.filings[0]!.id]);
  });

  it("REGRESSION: a filing with no instrument is counted, never created blank", async () => {
    // `StockFinancials.instrumentId` is a REQUIRED FK. A filing whose issuer is
    // not in `instrument_mappings` gets its own counter rather than being folded
    // into "skipped" — the two mean opposite things (a mapping gap versus a
    // deliberate suppression) and one number cannot say both.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO", instrumentId: null })],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.deepEqual(store.creates, []);
    assert.equal(res.created, 0);
    assert.equal(res.skippedNoInstrument, 1);
    // MONEY-1235 — and it is NOT stamped. `instrument-sync` fills that mapping
    // on its own schedule with nothing new arriving from NSE, so a stamp here
    // makes the filing invisible on the very night the gap closes.
    assert.deepEqual(store.stamped, []);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — the stamp said "decided" about two outcomes that were not      */
/* -------------------------------------------------------------------------- */

describe("processXbrlProjectionWrite — what may NOT advance the cursor", () => {
  /**
   * THE DEFECT, and why it blocked arming rather than merely being untidy.
   *
   * The writer adds EVERY row of a group to `decidedIds` before any statement
   * is written. The CREATE branch then returned after `skippedCreateSuppressed`
   * or `skippedNoInstrument` WITHOUT adding to `failedIds`, and the stamp block
   * stamps decided-minus-failed — so both outcomes advanced the cursor.
   *
   * Neither is a decision. A suppressed create flips the moment `createMissing`
   * is passed; a no-instrument skip flips when the mapping appears. So arming
   * `XBRL_PROJECTION_APPLY=true` with the nightly `{}` payload (`createMissing`
   * false) would burn 500 quarterly filings PER NIGHT into stamped-never-
   * created, and the later deliberate `createMissing` pilot would then select
   * NOTHING — recoverable only by a hand `$unset` against prod. Prod holds
   * 71,450 QUARTERLY filings against ZERO quarterly `stock_financials` rows, so
   * every quarterly write is a create and every one of them was exposed.
   *
   * The existing case `a period with no incumbent is not created by default`
   * runs `apply: true` and asserts nothing about stamping. That gap IS the bug.
   */
  it("REGRESSION: a create-suppressed filing is NOT stamped", async () => {
    const store = emptyStore({ filings: [filing({ symbol: "TESTCO" })] });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.skippedCreateSuppressed, 1);
    assert.deepEqual(
      store.stamped,
      [],
      "a filing skipped because a SWITCH is off has not been decided about",
    );
  });

  it("…and the very next run with createMissing:true still finds it", async () => {
    // The consequence, driven end to end. This is the run the whole interlock
    // exists to make possible, and under the bug it processed zero filings.
    const store = emptyStore({ filings: [filing({ symbol: "TESTCO" })] });
    const db = fakePrisma(store);

    await processXbrlProjectionWrite(
      { apply: true, unprojectedOnly: true, now: NOW },
      { prisma: db },
    );

    const pilot = await processXbrlProjectionWrite(
      {
        apply: true,
        createMissing: true,
        unprojectedOnly: true,
        now: new Date("2026-08-15T09:30:00.000Z"),
      },
      { prisma: db },
    );

    assert.equal(pilot.filingsRead, 1, "the filing was still selectable");
    assert.equal(pilot.created, 1);
    assert.equal(store.creates.length, 1);
    assert.deepEqual(store.stamped, [store.filings[0]!.id]);
  });

  it("REGRESSION: one suppressed statement un-stamps the WHOLE filing", async () => {
    // A filing projects up to TWO statements and they can disagree. Here the
    // INCOME row exists (so it UPDATEs) while the BALANCE_SHEET row does not
    // (so its create is suppressed). Stamping on "the last statement was
    // decided" would lose the balance sheet forever, silently, on a filing that
    // otherwise looks perfectly well handled.
    const store = emptyStore({
      filings: [
        filing({
          symbol: "TESTCO",
          facts: {
            family: "ind-as",
            values: {
              revenueFromOperations: 1000 * RUPEES_PER_CRORE,
              profitForPeriod: 100 * RUPEES_PER_CRORE,
              totalAssets: 5000 * RUPEES_PER_CRORE,
              totalEquity: 2000 * RUPEES_PER_CRORE,
            },
          },
        }),
      ],
      financials: [tickertapeRow()],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.updated, 1, "the INCOME row was updated");
    assert.equal(
      res.skippedCreateSuppressed,
      1,
      "the BALANCE_SHEET row would have been created",
    );
    assert.deepEqual(
      store.stamped,
      [],
      "a filing that still owes a create must come back for it",
    );
  });

  it("REGRESSION: …and in the OTHER order, so it cannot be last-statement-wins", async () => {
    // The same filing with the roles swapped: the BALANCE_SHEET row exists and
    // updates, the INCOME row does not and is suppressed. Statements are
    // processed income-first, so under a "whatever the last statement said"
    // implementation this one STAMPS and the previous case still passes — a
    // half-fixed writer that looks fully tested. Both orders are needed, and
    // only the pair pins the rule to "ANY statement, not the final one".
    const store = emptyStore({
      filings: [
        filing({
          symbol: "TESTCO",
          facts: {
            family: "ind-as",
            values: {
              revenueFromOperations: 1000 * RUPEES_PER_CRORE,
              profitForPeriod: 100 * RUPEES_PER_CRORE,
              totalAssets: 5000 * RUPEES_PER_CRORE,
              totalEquity: 2000 * RUPEES_PER_CRORE,
            },
          },
        }),
      ],
      financials: [
        tickertapeRow({
          statementType: "BALANCE_SHEET",
          revenue: undefined,
          netIncome: undefined,
          ebitda: undefined,
          totalAssets: 4800,
          totalEquity: 1900,
        }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.updated, 1, "the BALANCE_SHEET row was updated");
    assert.equal(res.skippedCreateSuppressed, 1, "the INCOME row was not");
    assert.deepEqual(store.stamped, []);
  });

  it("a filing whose statements ALL landed is stamped exactly once", async () => {
    // The control. If the un-stamping were over-broad the cursor would never
    // advance at all and the job would re-read its whole backlog nightly —
    // MONEY-1211 rebuilt, in the other direction.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.updated, 1);
    assert.deepEqual(store.stamped, [store.filings[0]!.id]);
  });
});

/* -------------------------------------------------------------------------- */
/* Displacement + idempotency, end to end                                      */
/* -------------------------------------------------------------------------- */

describe("processXbrlProjectionWrite — displacing Tickertape", () => {
  it("writes our numbers, our stamp, and the record of what it replaced", async () => {
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.updated, 1);
    assert.equal(res.displaced, 1);
    assert.equal(store.updates.length, 1);

    const data = store.updates[0]!.data;
    assert.equal(data.source, "NSE_XBRL");
    assert.equal(data.revenueFromOperations, 1000);
    assert.equal(data.netIncome, 100);
    // The filing disclosed no EBITDA, so OUR column is nulled: leaving a stale
    // figure of ours under a row stamped NSE_XBRL is the unattributable-row
    // state MONEY-1175 sat in.
    assert.equal(data.ebitdaBeforeExceptionalItems, null);
    // Tickertape's 123 is in a column we do not own — MONEY-1255 — so the patch
    // must not mention it at all and the vendor's figure survives in place.
    // Written as a `in` check rather than `assert.equal(data.ebitda, null)`,
    // which is `undefined == null` and therefore true of any patch whatsoever.
    assert.ok(!("ebitda" in data), "the vendor's ebitda must not be written");
    assert.equal(store.financials[0]!.ebitda, 123);

    const raw = data.rawData as {
      xbrl: { filing: { sourceUrl: string } };
      displacedByXbrl: {
        displacedSource: string;
        values: Record<string, number | null>;
      };
    };
    assert.equal(raw.xbrl.filing.sourceUrl, "https://nsearchives/TESTCO.xml");
    assert.equal(raw.displacedByXbrl.displacedSource, "TICKERTAPE");
    // Nulling is only safe because THIS survived it — and after MONEY-1255 the
    // record holds OWNED columns only, so `netIncome` is the one whose vendor
    // value this write actually destroys (90 -> 100). `revenue` and `ebitda`
    // are unowned: nothing destroys them, so recording them would claim a
    // displacement that did not happen (the `grossProfit` rule).
    assert.equal(raw.displacedByXbrl.values.netIncome, 90);
    assert.ok(!("revenue" in raw.displacedByXbrl.values));
    assert.ok(!("ebitda" in raw.displacedByXbrl.values));
    assert.equal(store.financials[0]!.revenue, 950, "the vendor's, untouched");
  });

  it("REGRESSION: a second run performs ZERO writes and keeps the original record", async () => {
    // Every nightly run after the first is a refresh. If a refresh rewrote the
    // record, run 2 would replace "TICKERTAPE said 950" with "NSE_XBRL said
    // 1000" — the only copy of the displaced numbers gone, no error, nothing to
    // compare against ever again.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const db = fakePrisma(store);

    const first = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: db },
    );
    assert.equal(first.updated, 1);

    const second = await processXbrlProjectionWrite(
      { apply: true, now: new Date("2026-08-15T09:30:00.000Z") },
      { prisma: db },
    );

    assert.equal(second.updated, 0, "the second run must write nothing");
    assert.equal(second.created, 0);
    assert.equal(second.skippedUnchanged, 1);
    assert.equal(store.updates.length, 1, "no second update reached the store");

    const raw = store.financials[0]!.rawData as {
      displacedByXbrl: {
        displacedSource: string;
        displacedAt: string;
        values: Record<string, number>;
      };
    };
    assert.equal(raw.displacedByXbrl.displacedSource, "TICKERTAPE");
    assert.equal(raw.displacedByXbrl.displacedAt, NOW.toISOString());
    assert.equal(raw.displacedByXbrl.values.netIncome, 90);
  });

  it("leaves a row alone when a higher-ranked source owns it", async () => {
    // There is nothing above NSE_XBRL today, so the observable form of the
    // authority check here is that OUR OWN stamp on an unchanged row produces
    // no write — and a differently-sourced row does.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow({ source: "YAHOO", revenue: 111 })],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.displaced, 1);
    const raw = store.updates[0]!.data.rawData as {
      displacedByXbrl: { displacedSource: string };
    };
    assert.equal(raw.displacedByXbrl.displacedSource, "YAHOO");
  });
});

/* -------------------------------------------------------------------------- */
/* Eligibility + selection reach the write path                                */
/* -------------------------------------------------------------------------- */

describe("processXbrlProjectionWrite — what never reaches a row", () => {
  it("REGRESSION: half-yearly and cumulative filings are refused, not written", async () => {
    // Six months and nine months of revenue in a three-month cell. Both write
    // cleanly and both are wrong by a multiple, with nothing in the row saying
    // so — which is why they are refused before a row is even addressed.
    const store = emptyStore({
      filings: [
        filing({
          symbol: "HALFCO",
          periodStart: utc("2025-04-01"),
          periodEnd: utc("2025-09-30"),
          periodType: "HALF_YEARLY",
        }),
        filing({
          symbol: "YTDCO",
          periodStart: utc("2025-04-01"),
          periodEnd: utc("2025-12-31"),
          periodType: "QUARTERLY",
          cumulative: true,
        }),
        filing({
          symbol: "SPANCO",
          periodStart: utc("2025-04-01"),
          periodEnd: utc("2026-03-31"),
          periodType: "QUARTERLY",
        }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.deepEqual(store.creates, []);
    assert.equal(res.periods, 0);
    assert.equal(res.refused.HALF_YEARLY_HAS_NO_BUCKET, 1);
    assert.equal(res.refused.CUMULATIVE_IS_NOT_A_QUARTER, 1);
    assert.equal(res.refused.PERIOD_SPAN_CONTRADICTS_TYPE, 1);
  });

  it("REGRESSION: consolidated wins the row, and standalone is not also written", async () => {
    // Both address the SAME StockFinancials row — its key has no basis. Writing
    // both is last-writer-wins between two numbers that differ by a multiple for
    // any holding company.
    const store = emptyStore({
      filings: [
        filing({
          symbol: "TESTCO",
          basis: "STANDALONE",
          coverage: 0.99,
          facts: {
            family: "ind-as",
            values: {
              revenueFromOperations: 400 * RUPEES_PER_CRORE,
              profitForPeriod: 40 * RUPEES_PER_CRORE,
            },
          },
        }),
        filing({
          symbol: "TESTCO",
          basis: "CONSOLIDATED",
          coverage: 0.5,
          facts: {
            family: "ind-as",
            values: {
              revenueFromOperations: 1000 * RUPEES_PER_CRORE,
              profitForPeriod: 100 * RUPEES_PER_CRORE,
            },
          },
        }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.periods, 1);
    assert.equal(res.supersededSiblings, 1);
    assert.equal(store.creates.length, 1);
    assert.equal(
      store.creates[0]!.revenueFromOperations,
      1000,
      "the consolidated figure",
    );
  });

  it("counts an unreadable `facts` blob and carries on", async () => {
    const store = emptyStore({
      filings: [
        filing({ symbol: "AAA", facts: "not an object" }),
        filing({ symbol: "BBB" }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.unreadableFacts, 1);
    assert.equal(res.created, 1, "the readable filing still landed");
  });

  it("counts a per-row failure without ending the run", async () => {
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
      throwOnUpdate: true,
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.failed, 1);
    // A run that meant to write a row and did not is NOT ok. Refusals have
    // their own counters and are explained; `failed` is the only bucket that
    // means "this should have landed and did not". Reporting success on it is
    // the completeness-at-the-wrong-granularity defect this repo has shipped
    // five times (MONEY-1189).
    assert.equal(res.ok, false);
    assert.ok(res.examples.some((e) => e.startsWith("FAILED ")));
  });

  it("a rejected write is NOT also counted as written — MONEY-1238", async () => {
    // THE DEFECT: `out.updated++` / `out.created++` sat ABOVE their awaits, so
    // a statement whose Prisma call REJECTED was counted in both buckets. One
    // filing producing one statement could report the arithmetically impossible
    // {"selected":1,"written":1,"failed":1}.
    //
    // It matters beyond tidiness: `written` is the series the zero-write
    // monitor keys on. A run in which EVERY write threw would still report a
    // healthy non-zero written count, so the alarm could not fire on the one
    // shape it exists to catch — a job that runs, succeeds, and writes nothing.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
      throwOnUpdate: true,
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.failed, 1, "the rejected write is a failure");
    assert.equal(res.updated, 0, "and must NOT also be counted as an update");
    assert.equal(res.displaced, 0, "nor as a displacement that never happened");
  });

  it("a DRY RUN still reports what would land", async () => {
    // The counters were moved after the awaits, so this is the case that could
    // regress: with `apply: false` no write is attempted, nothing can throw,
    // and the operator must still see the size of what the run WOULD do.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const res = await processXbrlProjectionWrite(
      { apply: false, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.failed, 0);
    assert.equal(res.updated, 1, "a dry run reports the update it would make");
  });
});

/* -------------------------------------------------------------------------- */
/* The pagination guard                                                        */
/* -------------------------------------------------------------------------- */

describe("dropPartialTrailingSymbol", () => {
  it("REGRESSION: a symbol cut by the page boundary is deferred, not half-processed", async () => {
    // The read is symbol-major, so a truncated page can only cut INSIDE the last
    // symbol. Processing that half means a STANDALONE filing can win a period
    // whose CONSOLIDATED sibling was simply not read — a wrong number produced
    // by a paging artefact, with nothing in the row to show for it.
    const rows = [
      filing({ symbol: "AAA", basis: "CONSOLIDATED" }),
      filing({ symbol: "BBB", basis: "STANDALONE" }),
    ];
    const split = dropPartialTrailingSymbol(rows);
    assert.deepEqual(
      split.kept.map((r) => r.symbol),
      ["AAA"],
    );
    assert.equal(split.deferred, 1);
  });

  it("does not stall when every row belongs to ONE symbol", () => {
    // Dropping "the trailing symbol" would drop everything and the job would
    // make no progress on any widening of the limit that still fills a page.
    const rows = [
      filing({ symbol: "AAA", basis: "CONSOLIDATED" }),
      filing({ symbol: "AAA", basis: "STANDALONE" }),
    ];
    const split = dropPartialTrailingSymbol(rows);
    assert.equal(split.kept.length, 2);
    assert.equal(split.deferred, 0);
  });

  it("handles an empty page", () => {
    assert.deepEqual(dropPartialTrailingSymbol([]), { kept: [], deferred: 0 });
  });

  it("the processor applies the guard when the read hits its limit", async () => {
    const store = emptyStore({
      filings: [filing({ symbol: "AAA" }), filing({ symbol: "BBB" })],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, limit: 2, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.truncatedByLimit, true);
    assert.equal(res.deferredByPagination, 1);
    assert.equal(res.created, 1);
    assert.deepEqual(
      store.creates.map((c) => c.symbol),
      ["AAA"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* readFacts                                                                   */
/* -------------------------------------------------------------------------- */

describe("readFacts", () => {
  it("returns null for everything that is not a parsed filing", () => {
    for (const v of [
      null,
      undefined,
      "x",
      7,
      [],
      {},
      { values: null },
      { values: 3 },
    ]) {
      assert.equal(
        readFacts(v),
        null,
        `expected null for ${JSON.stringify(v)}`,
      );
    }
  });

  it("returns the filing when `values` is there", () => {
    const f = { family: "ind-as", values: { revenueFromOperations: 1 } };
    assert.equal(readFacts(f), f);
  });
});

/* -------------------------------------------------------------------------- */
/* Units — MONEY-1205                                                          */
/* -------------------------------------------------------------------------- */

describe("toCroreDenominated — the StockFinancials units boundary", () => {
  it("converts rupee-denominated projections into ₹ crore", () => {
    // HDFCBANK-scale: ₹4,70,915.93 Cr of revenue as a filing states it.
    const out = toCroreDenominated({
      statementType: "INCOME",
      revenueFromOperations: 470_915.93 * RUPEES_PER_CRORE,
      netIncome: 79_012.77 * RUPEES_PER_CRORE,
    });
    assert.equal(out.statementType, "INCOME");
    assert.ok(Math.abs(out.revenueFromOperations! - 470_915.93) < 1e-6);
    assert.ok(Math.abs(out.netIncome! - 79_012.77) < 1e-6);
  });

  it("DIVIDES — it must not multiply, and must not leave rupees in place", () => {
    // The two ways to get the direction wrong, pinned. Before this ticket the
    // writer left rupees in place: a 10,000,000x overstatement in the one table
    // with no `source` in its unique key, so unrecoverable once written.
    const out = toCroreDenominated({
      statementType: "INCOME",
      revenueFromOperations: 1e10, // ₹1,000 Cr
    });
    assert.equal(out.revenueFromOperations, 1000);
    assert.notEqual(out.revenueFromOperations, 1e10);
    assert.notEqual(out.revenueFromOperations, 1e17);
  });

  it("OMITS a field the filing did not disclose — never 0, never NaN", () => {
    const out = toCroreDenominated({
      statementType: "INCOME",
      revenueFromOperations: 1e10,
    });
    // The OWNED column, not the vendor's — MONEY-1255. `hasOwn(out, "ebitda")`
    // is false for every statement this function can return, so it was no
    // longer asking anything.
    assert.equal(Object.hasOwn(out, "ebitdaBeforeExceptionalItems"), false);
    assert.equal(Object.hasOwn(out, "netIncome"), false);
    // …which is what lets `planFinancialsWrite` write an explicit NULL for an
    // undisclosed field rather than a fabricated zero.
  });

  it("only touches the fields the statement OWNS", () => {
    const out = toCroreDenominated({
      statementType: "BALANCE_SHEET",
      totalAssets: 4_915_597.5 * RUPEES_PER_CRORE,
      // An INCOME field on a BALANCE_SHEET statement is not owned by it and
      // must not be carried across — `planFinancialsWrite` would not write it.
      revenueFromOperations: 1e10,
    });
    assert.ok(Math.abs(out.totalAssets! - 4_915_597.5) < 1e-6);
    assert.equal(Object.hasOwn(out, "revenueFromOperations"), false);
  });

  it("preserves a genuine zero and a genuine loss", () => {
    const out = toCroreDenominated({
      statementType: "INCOME",
      revenueFromOperations: 0,
      netIncome: -50_000_000,
    });
    assert.equal(out.revenueFromOperations, 0);
    assert.equal(out.netIncome, -5);
  });

  it("makes XBRL and Tickertape COMPARABLE without defeating the gate", () => {
    // The gate must still block on an UNCONVERTED pair…
    const rupees = 470_915.93 * RUPEES_PER_CRORE;
    assert.equal(reconcile(rupees, 470_915.93).verdict, "SCALE_MISMATCH");
    // …and agree once the writer's conversion is applied.
    const converted = toCroreDenominated({
      statementType: "INCOME",
      revenueFromOperations: rupees,
    }).revenueFromOperations;
    assert.equal(reconcile(converted, 470_915.93).verdict, "MATCH");
    // …and still catch a real difference, so this is comparison, not laundering.
    assert.equal(reconcile(converted, 600_000).verdict, "DISAGREEMENT");
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1234 — an ABSENT field is not null on Mongo, and the queue looked dry */
/* -------------------------------------------------------------------------- */

describe("unprojectedOnly must match rows whose marker was never written", () => {
  const SRC = readFileSync(
    join(REPO_ROOT, "workers/src/processors/xbrl-projection-writer.ts"),
    "utf8",
  );
  /** LINE comments before BLOCK — MONEY-1143. */
  const CODE = SRC.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("does not filter on a bare `projectedAt: null`", () => {
    // THE DEFECT. `projectedAt` is a nullable column added by `db push`, and on
    // MongoDB a push creates INDEXES, never fields — so the field is ABSENT on
    // every row until something writes it. Prisma's Mongo connector does not
    // treat absent as null. Measured on prod 2026-08-21:
    //
    //     prisma.count()                                90,188
    //     prisma.count({ projectedAt: null })                0
    //     prisma.count({ projectedAt: { not: null } })       0
    //     prisma.count({ projectedAt: { isSet: false } })  90,188
    //
    // A filter AND its inverse both returning zero is the signature — the rows
    // are in neither set. Raw Mongo DOES match absent with `null`, which is why
    // a mongosh spot-check said 90,188 and the job still selected 0.
    //
    // Armed, this would have written NOTHING, nightly, on the flagship job of
    // the whole switchover, while reporting success.
    assert.doesNotMatch(
      CODE,
      /\{\s*projectedAt:\s*null\s*\}\s*:/,
      "a bare `projectedAt: null` filter matches no rows on MongoDB",
    );
  });

  it("uses isSet:false, and keeps null for rows stamped then cleared", () => {
    // Both shapes on purpose. `isSet: false` catches rows never stamped;
    // `null` catches a row explicitly reset later. Once the projection starts
    // stamping, both populations exist at once.
    assert.match(CODE, /isSet:\s*false/);
    assert.match(CODE, /OR:\s*\[/);
  });

  it("was caught by the job-outcome line, which is why that line exists", () => {
    // `selected: 0, written: 0` is the whole point of `reportJobOutcome` — a job
    // that finds no work and a job whose query is broken are indistinguishable
    // from the exit code, and identical in every dashboard.
    const processor = readFileSync(
      join(REPO_ROOT, "workers/src/processors/xbrl-projection.ts"),
      "utf8",
    );
    assert.match(processor, /reportJobOutcome\(/);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — one predicate, and the knobs that actually reach the writer    */
/* -------------------------------------------------------------------------- */

describe("MONEY-1235 — the interlocks had no OFF ramp", () => {
  const src = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8");
  /** LINE comments before BLOCK — MONEY-1143. */
  const strip = (s: string): string =>
    s.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const WRITER = strip(src("workers/src/processors/xbrl-projection-writer.ts"));
  const PROC = strip(src("workers/src/processors/xbrl-projection.ts"));
  const ROUTE = strip(src("workers/src/routes/xbrl-projection.ts"));

  it("the sibling FETCH window is never narrower than the detector's COMPARISON window", () => {
    // MONEY-1237. Two constants in two packages describe one thing:
    // `NEIGHBOUR_WINDOW` is how many adjacent periods `judgeFilingScale`
    // COMPARES against, `SIBLING_CONTEXT_PERIODS` is how far the writer's
    // context query REACHES. They cannot be shared today (the core barrel
    // re-exports the detector but does not name `NEIGHBOUR_WINDOW`), so this
    // reads both files off disk instead.
    //
    // Structural because the failure is silent by construction: raise the
    // detector's window without raising the fetch and the query returns fewer
    // siblings than the detector asked for, fewer siblings means
    // INSUFFICIENT_CONTEXT, and the scale check switches itself OFF while
    // `filingsRead`, `created` and `ok` all keep reporting a healthy run. There
    // is no exception, no wrong number, and nothing to notice — the same shape
    // as the drain-only context this ticket's FIX 3 exists to end.
    const DETECTOR = strip(
      src("packages/core/src/market-data/xbrl-scale-detector.ts"),
    );
    const compare = /export const NEIGHBOUR_WINDOW = (\d+);/.exec(DETECTOR);
    assert.ok(compare, "could not read NEIGHBOUR_WINDOW from the detector");
    // The writer no longer hand-copies a number — it DERIVES the fetch window
    // from the detector's own exported constant, so the invariant holds by
    // construction (MONEY-1237). This test's job shrinks accordingly: pin that
    // the derivation exists and that the import is real, so a future edit
    // cannot quietly reintroduce a literal that drifts.
    assert.match(
      WRITER,
      /const SIBLING_CONTEXT_PERIODS = NEIGHBOUR_WINDOW \+ \d+;/,
      "the fetch window must be DERIVED from NEIGHBOUR_WINDOW, not hand-copied",
    );
    assert.match(
      WRITER,
      /NEIGHBOUR_WINDOW,[\s\S]{0,400}\} from "@usemoney\/core\/market-data"/,
      "NEIGHBOUR_WINDOW must be imported from core, not shadowed locally",
    );
  });

  it("the PROCESSOR's count does not use a bare `projectedAt: null` either", () => {
    // THE DEFECT, second instance. MONEY-1234 fixed the writer's SELECTION and
    // left `countUnprojectedFilings` asking `{ projectedAt: null }` — which
    // matches nothing on Mongo and so returned 0 unconditionally.
    //
    // That count is not decoration. `routes/xbrl-projection.ts` calls it
    // precisely to tell "everything is projected" apart from "the selector is
    // broken" when a run selects zero, so a count wired to 0 always printed the
    // reassuring branch:
    //
    //     [xbrl-projection] selected 0 — 0 filing(s) still unprojected.
    //                                    Nothing to do.
    //
    // over a 90,188-filing backlog. The diagnostic built to catch the bug
    // carried the bug, and printed a false all-clear during the investigation
    // that found this.
    assert.doesNotMatch(
      PROC,
      /projectedAt:\s*null/,
      "a bare `projectedAt: null` matches no rows on MongoDB",
    );
  });

  it("selection and count share ONE exported predicate, not two copies", () => {
    // Two hand-copied filters is what let them drift. One is now definitional.
    assert.match(WRITER, /export const UNPROJECTED_FILING_WHERE/);
    assert.match(WRITER, /\?\s*UNPROJECTED_FILING_WHERE\s*:/);
    assert.match(PROC, /UNPROJECTED_FILING_WHERE/);
    assert.match(PROC, /where:\s*UNPROJECTED_FILING_WHERE/);
    assert.match(
      PROC,
      /import\s*\{[^}]*UNPROJECTED_FILING_WHERE[^}]*\}\s*from\s*"\.\/xbrl-projection-writer"/,
      "the count must import the predicate, not restate it",
    );
  });

  it("the route forwards createMissing and periodTypes instead of dropping them", () => {
    // The route rebuilt `msg` field by field from the raw body, so anything it
    // did not name was silently discarded before the processor ever saw it.
    assert.match(ROUTE, /createMissing:/);
    assert.match(ROUTE, /periodTypes:/);
  });

  it("the processor passes both on to the writer", () => {
    // Forwarding through the route is worth nothing if the call site drops
    // them one layer later — which is exactly what happened to `periodTypes`.
    assert.match(PROC, /createMissing:\s*msg\?\.createMissing === true/);
    assert.match(PROC, /periodTypes:\s*msg\?\.periodTypes/);
  });

  it("keeps createMissing DEFAULTED OFF — this ticket adds a switch, not a policy", () => {
    assert.match(WRITER, /const createMissing = opts\.createMissing === true;/);
  });

  it("filters periodTypes in the QUERY, never after the eligibility verdict", () => {
    // A post-verdict skip would stamp only the MATCHING filings, so every later
    // run would re-read the same unstamped page and the cursor would never
    // advance — MONEY-1211's constant-ordering defect rebuilt out of new parts.
    //
    // Structural, not textual: the filter has to sit inside the findMany
    // `where`, which is to say before `orderBy`.
    //
    // Anchored on the SELECTION query by its own assignment, not on the first
    // `findMany` in the file — MONEY-1237 added a SECOND one
    // (`fetchScaleContext`, the sibling-context fetch) ABOVE it, so a
    // first-index anchor silently re-pointed this whole assertion at a query
    // that has no business carrying a `periodTypes` filter and started failing
    // for a reason that had nothing to do with what it pins.
    const SELECTION = "const filings = (await db.xbrlFiling.findMany({";
    const find = WRITER.indexOf(SELECTION);
    assert.ok(find > 0, "could not locate the selection query");
    assert.equal(
      WRITER.indexOf(SELECTION, find + 1),
      -1,
      "the selection anchor must be unique, or this test pins the wrong query",
    );
    const order = WRITER.indexOf("orderBy:", find);
    const filter = WRITER.indexOf("periodType: { in: opts.periodTypes }");
    assert.ok(
      order > find,
      "the selection query has no orderBy to bound the where",
    );
    assert.ok(
      filter > find && filter < order,
      "periodTypes must be a column filter on selection, not a post-verdict skip",
    );
  });

  it("selects only the requested bucket", () => {
    const store = emptyStore({
      filings: [
        filing({ symbol: "TESTCO", periodType: "QUARTERLY" }),
        filing({
          symbol: "TESTCO",
          periodType: "ANNUAL",
          periodStart: utc("2024-04-01"),
          periodEnd: utc("2025-03-31"),
        }),
      ],
    });

    return processXbrlProjectionWrite(
      { periodTypes: ["ANNUAL"], now: NOW },
      { prisma: fakePrisma(store) },
    ).then((res) => {
      assert.equal(res.filingsRead, 1, "the quarterly filing was still read");
    });
  });

  it("stamps REFUSED filings, so the cursor drains instead of stalling on them", () => {
    // A refusal is a DECISION: all four refusals are pure functions of columns
    // already on the row, so a filing refused once is refused identically
    // forever. Left unstamped it is re-read every night for nothing.
    //
    // Prod has 357 HALF_YEARLY filings among 90,188. Once the real backlog is
    // projected, an unstamped refusal set means every future run reports
    // `selected: 357, written: 0` — permanently, and indistinguishably from a
    // broken selector at a glance. Manufacturing that signal is the exact thing
    // MONEY-1220 and MONEY-1234 exist to stop.
    const half = filing({
      symbol: "TESTCO",
      periodType: "HALF_YEARLY",
      cumulative: true,
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2025-09-30"),
    });
    const store = emptyStore({ filings: [half] });

    return processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    ).then((res) => {
      assert.equal(res.refused.HALF_YEARLY_HAS_NO_BUCKET, 1);
      assert.deepEqual(
        store.stamped,
        [half.id],
        "a permanently-refused filing must not be re-read forever",
      );
    });
  });

  it("still does NOT stamp on a dry run — a rehearsal must leave no trace", () => {
    // The stamp is gated on `apply` for both paths. If a dry run stamped
    // refusals, the first armed run would skip filings a rehearsal had decided.
    const store = emptyStore({
      filings: [
        filing({
          symbol: "TESTCO",
          periodType: "HALF_YEARLY",
          cumulative: true,
          periodStart: utc("2025-04-01"),
          periodEnd: utc("2025-09-30"),
        }),
      ],
    });

    return processXbrlProjectionWrite(
      { now: NOW },
      { prisma: fakePrisma(store) },
    ).then(() => {
      assert.deepEqual(store.stamped, []);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — the STANDALONE sibling that arrives a night late               */
/* -------------------------------------------------------------------------- */

describe("processXbrlProjectionWrite — the basis guards, run over two nights", () => {
  /**
   * The unit case lives in
   * `packages/core/__tests__/market-data/xbrl-projection-write.test.ts`. This
   * one exists because the defect is only VISIBLE across two runs of the real
   * processor: `selectFilingForPeriod` picks consolidated over standalone
   * correctly, and a single-run test therefore proves nothing at all.
   *
   * Night 1 projects the CONSOLIDATED filing and stamps it. Night 2's
   * `unprojectedOnly` filter hides that filing, so the STANDALONE sibling —
   * a separate `XbrlFiling` row with its own `sourceUrl`, which NSE routinely
   * publishes days later — arrives alone, forms a group of ONE, and wins the
   * selector trivially. `chooseAuthority` then sees NSE_XBRL against NSE_XBRL
   * and takes the equal-rank refresh branch.
   */
  function pair(): { consolidated: FilingRow; standalone: FilingRow } {
    return {
      consolidated: filing({
        symbol: "HOLDCO",
        basis: "CONSOLIDATED",
        facts: {
          family: "ind-as",
          values: {
            revenueFromOperations: 1000 * RUPEES_PER_CRORE,
            profitForPeriod: 100 * RUPEES_PER_CRORE,
          },
        },
      }),
      standalone: filing({
        symbol: "HOLDCO",
        basis: "STANDALONE",
        sourceUrl: "https://nsearchives/HOLDCO-standalone.xml",
        facts: {
          family: "ind-as",
          values: {
            revenueFromOperations: 400 * RUPEES_PER_CRORE,
            profitForPeriod: 40 * RUPEES_PER_CRORE,
          },
        },
      }),
    };
  }

  it("REGRESSION: night 2's late STANDALONE sibling cannot rewrite the group's row", async () => {
    const { consolidated, standalone } = pair();
    const store = emptyStore({ filings: [consolidated] });
    const db = fakePrisma(store);

    const night1 = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, unprojectedOnly: true, now: NOW },
      { prisma: db },
    );
    assert.equal(night1.created, 1);
    assert.equal(
      store.financials[0]!.revenueFromOperations,
      1000,
      "the GROUP's revenue",
    );

    // NSE publishes the standalone filing; xbrl-sync stores it, unstamped.
    store.filings.push(standalone);

    const night2 = await processXbrlProjectionWrite(
      {
        apply: true,
        createMissing: true,
        unprojectedOnly: true,
        now: new Date("2026-08-15T09:30:00.000Z"),
      },
      { prisma: db },
    );

    assert.equal(
      night2.filingsRead,
      1,
      "only the standalone sibling is unprojected — this is the SINGLETON group",
    );
    assert.equal(night2.updated, 0, "and it must not have won");
    assert.equal(night2.skippedBasisDowngrade, 1);
    assert.equal(
      night2.skippedAuthority,
      0,
      "counted apart from AUTHORITY, which means a SOURCE outranked us",
    );
    assert.deepEqual(store.updates, [], "no write reached the store");
    assert.equal(
      store.financials[0]!.revenueFromOperations,
      1000,
      "the consolidated figure survived",
    );
    assert.equal(store.financials[0]!.basis, "CONSOLIDATED");
    assert.ok(
      night2.examples.some((e) => e.startsWith("SKIP-BASIS-DOWNGRADE")),
    );
  });

  it("the refused sibling IS stamped — the verdict cannot change without new bytes", async () => {
    // It will lose to the same incumbent every night forever, so re-reading it
    // is pure cost against a 90,188-filing backlog. The UPGRADE path survives
    // this because a later CONSOLIDATED filing is a DIFFERENT `XbrlFiling` row
    // (`basis` is in that table's unique key) and arrives unstamped — which the
    // next case drives end to end.
    const { consolidated, standalone } = pair();
    const store = emptyStore({ filings: [consolidated] });
    const db = fakePrisma(store);

    await processXbrlProjectionWrite(
      { apply: true, createMissing: true, unprojectedOnly: true, now: NOW },
      { prisma: db },
    );
    store.filings.push(standalone);
    await processXbrlProjectionWrite(
      {
        apply: true,
        createMissing: true,
        unprojectedOnly: true,
        now: new Date("2026-08-15T09:30:00.000Z"),
      },
      { prisma: db },
    );

    assert.deepEqual(store.stamped, [consolidated.id, standalone.id]);
  });

  it("REGRESSION: stamping does NOT close the upgrade — consolidated still lands later", async () => {
    // The order reversed: the STANDALONE filing arrives first and creates the
    // row, then the CONSOLIDATED sibling is published. If the guard were
    // symmetric, or if stamping the standalone row somehow blocked the later
    // filing, the company would be frozen on parent-only numbers permanently.
    const { consolidated, standalone } = pair();
    const store = emptyStore({ filings: [standalone] });
    const db = fakePrisma(store);

    const night1 = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, unprojectedOnly: true, now: NOW },
      { prisma: db },
    );
    assert.equal(night1.created, 1);
    assert.equal(store.financials[0]!.revenueFromOperations, 400);
    assert.equal(store.financials[0]!.basis, "STANDALONE");

    store.filings.push(consolidated);
    const night2 = await processXbrlProjectionWrite(
      {
        apply: true,
        createMissing: true,
        unprojectedOnly: true,
        now: new Date("2026-08-15T09:30:00.000Z"),
      },
      { prisma: db },
    );

    assert.equal(night2.updated, 1);
    assert.equal(night2.skippedBasisDowngrade, 0);
    assert.equal(store.financials[0]!.revenueFromOperations, 1000);
    assert.equal(
      store.financials[0]!.basis,
      "CONSOLIDATED",
      "the basis column must move with the numbers",
    );
  });

  it("REGRESSION: a STANDALONE winner never displaces Tickertape", async () => {
    // The founder decision. 3,208 of 10,879 winner periods (29.5%) are
    // standalone-only while the vendor row is typically consolidated, so
    // writing standalone over it puts us in disagreement with every other site
    // for nearly a third of the universe.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO", basis: "STANDALONE" })],
      financials: [tickertapeRow()],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.updated, 0);
    assert.equal(res.displaced, 0);
    assert.equal(res.skippedStandaloneNoDisplace, 1);
    assert.equal(res.skippedAuthority, 0);
    assert.deepEqual(store.updates, []);
    assert.equal(store.financials[0]!.revenue, 950, "Tickertape's figure");
    assert.equal(store.financials[0]!.source, "TICKERTAPE");
  });

  it("…but a STANDALONE filing may still CREATE where nothing exists", async () => {
    // The refusal is about displacement. Extending it to creates would leave
    // 29.5% of periods permanently empty while we hold a good filing for them.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO", basis: "STANDALONE" })],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.created, 1);
    assert.equal(res.skippedStandaloneNoDisplace, 0);
    assert.equal(store.creates[0]!.basis, "STANDALONE");
  });

  it("REGRESSION: the 29.5% skip cannot swallow the whole example list", async () => {
    // `examples` is ONE shared list of 40. A standalone refusal fires on 3,208
    // of 10,879 winner periods, so an uncapped note fills every slot before the
    // first DISPLACE or NO-INSTRUMENT line is reached — the counter would still
    // be right and the list, whose only job is to show the SHAPE of the rare
    // outcomes, would report nothing but the one outcome we already count.
    //
    // Twelve standalone symbols against twelve vendor rows, plus one filing
    // that displaces. The rare line must survive.
    const symbols = Array.from({ length: 12 }, (_, i) => `SA${i}`);
    const store = emptyStore({
      filings: [
        ...symbols.map((symbol) => filing({ symbol, basis: "STANDALONE" })),
        filing({ symbol: "ZCONSOL", basis: "CONSOLIDATED" }),
      ],
      financials: [
        ...symbols.map((symbol) => tickertapeRow({ symbol })),
        tickertapeRow({ symbol: "ZCONSOL" }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(
      res.skippedStandaloneNoDisplace,
      12,
      "all twelve were counted",
    );
    const standaloneLines = res.examples.filter((e) =>
      e.startsWith("SKIP-STANDALONE"),
    );
    assert.ok(
      standaloneLines.length <= 5,
      `the common outcome must be budgeted, saw ${standaloneLines.length}`,
    );
    assert.ok(
      res.examples.some((e) => e.startsWith("DISPLACE ZCONSOL")),
      `the RARE outcome must still be visible: ${JSON.stringify(res.examples)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — the vendor-free scale quarantine                               */
/* -------------------------------------------------------------------------- */

describe("processXbrlProjectionWrite — the scale quarantine", () => {
  /**
   * A symbol whose FY2021 filing is 1000x its neighbours on two fields — the
   * SILGO shape, which the F3 reconcile found only because a vendor row existed
   * to compare against. 90.7% of winner periods have none, so without this
   * check the same defect in a CREATE-only period is written silently.
   */
  function annual(over: {
    symbol: string;
    year: number;
    revenueCr: number;
    profitCr: number;
    assetsCr?: number;
    equityCr?: number;
  }): FilingRow {
    return filing({
      symbol: over.symbol,
      periodType: "ANNUAL",
      periodStart: utc(`${over.year - 1}-04-01`),
      periodEnd: utc(`${over.year}-03-31`),
      sourceUrl: `https://nsearchives/${over.symbol}-${over.year}.xml`,
      facts: {
        family: "ind-as",
        values: {
          revenueFromOperations: over.revenueCr * RUPEES_PER_CRORE,
          profitForPeriod: over.profitCr * RUPEES_PER_CRORE,
          // Optional, because the balance-sheet half of the detector's input is
          // exactly what one of the cases below has to be able to observe.
          ...(over.assetsCr === undefined
            ? {}
            : { totalAssets: over.assetsCr * RUPEES_PER_CRORE }),
          ...(over.equityCr === undefined
            ? {}
            : { totalEquity: over.equityCr * RUPEES_PER_CRORE }),
        },
      },
    });
  }

  it("REGRESSION: a mis-scaled filing is refused, counted and never written", async () => {
    const suspect = annual({
      symbol: "SILGO",
      year: 2021,
      revenueCr: 31_892.57,
      profitCr: 1_204.3,
    });
    const store = emptyStore({
      filings: [
        suspect,
        annual({ symbol: "SILGO", year: 2020, revenueCr: 30.4, profitCr: 1.1 }),
        annual({
          symbol: "SILGO",
          year: 2022,
          revenueCr: 31.89,
          profitCr: 1.2,
        }),
        annual({ symbol: "SILGO", year: 2023, revenueCr: 33.1, profitCr: 1.3 }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.refusedScaleSuspect, 1);
    assert.equal(res.created, 3, "the three healthy years still landed");
    assert.ok(
      !store.creates.some((c) => c.period === "FY 2021"),
      "the suspect period must not have been written",
    );
    assert.ok(
      res.examples.some(
        (e) => e.startsWith("SCALE-SUSPECT SILGO") && e.includes("x1000"),
      ),
      `expected a SCALE-SUSPECT example line, got ${JSON.stringify(res.examples)}`,
    );
  });

  it("the quarantined filing is NOT stamped — and is RE-JUDGED, with context, the next night", async () => {
    // MONEY-1237 FIX 2, and it REVERSES this case. It used to assert the
    // suspect WAS stamped, justified by "a corrected filing is a NEW
    // `XbrlFiling` row, unstamped by construction, so the period stays open".
    // That escape hatch exists only for a filing that is WRONG. It is false of
    // a filing that is RIGHT: NSE will never republish a correct reverse-merger
    // year, so every false positive — and the whole-history median produced
    // them on reverse mergers, spin-offs and any company compounding >=
    // 3.16x/yr — was a real period lost PERMANENTLY and SILENTLY, recoverable
    // only by a hand `$unset` against prod. The verdict is a function of the
    // SIBLING SET, and the sibling set grows.
    //
    // The two halves of this ticket only work TOGETHER, which is why one test
    // drives both nights. Not-stamping WITHOUT the sibling fetch (FIX 3) is
    // strictly WORSE than stamping: night 2 selects the suspect alone, its
    // siblings were stamped on night 1 and are filtered out by
    // `unprojectedOnly`, the detector answers INSUFFICIENT_CONTEXT — and the
    // mis-scaled filing is WRITTEN, unchecked, into the one table with no
    // `source` in its unique key. So night 2 asserts the context arrived.
    const suspect = annual({
      symbol: "SILGO",
      year: 2021,
      revenueCr: 31_892.57,
      profitCr: 1_204.3,
    });
    // FOUR filings, not three. With only two siblings the "median" is their
    // MEAN, so the mis-scaled year drags it ~500x and the two HEALTHY years get
    // quarantined alongside it — measured, before `MIN_SIBLING_PERIODS` was
    // raised to 3: all three came back SCALE_SUSPECT. One bad document must not
    // take out a whole short-history symbol.
    const healthy = [
      annual({ symbol: "SILGO", year: 2020, revenueCr: 30.4, profitCr: 1.1 }),
      annual({ symbol: "SILGO", year: 2022, revenueCr: 31.89, profitCr: 1.2 }),
      annual({ symbol: "SILGO", year: 2023, revenueCr: 33.1, profitCr: 1.3 }),
    ];
    const store = emptyStore({ filings: [suspect, ...healthy] });
    const opts = {
      apply: true,
      createMissing: true,
      unprojectedOnly: true,
      now: NOW,
    } as const;

    // ── NIGHT 1 ──
    const night1 = await processXbrlProjectionWrite(opts, {
      prisma: fakePrisma(store),
    });
    // Asserted TOGETHER with the stamp, because a written filing is also
    // stamped: without the refusal count "not stamped" passes just as happily
    // when the quarantine is switched off entirely, which proves nothing.
    assert.equal(night1.refusedScaleSuspect, 1);
    assert.ok(
      !store.stamped.includes(suspect.id),
      "a quarantined filing must keep its null cursor, or a false positive is permanent",
    );
    assert.deepEqual(
      [...store.stamped].sort(),
      healthy.map((f) => f.id).sort(),
      "the three healthy years ARE decided and must advance the cursor",
    );

    // ── NIGHT 2 — the same job, nothing new from NSE ──
    const night2 = await processXbrlProjectionWrite(opts, {
      prisma: fakePrisma(store),
    });
    assert.equal(
      night2.filingsRead,
      1,
      "only the unstamped suspect is selected — the cursor did advance past the rest",
    );
    assert.equal(
      night2.scaleContextFetched,
      3,
      "FIX 3: the three siblings stamped on night 1 come back through the " +
        "context query, or the re-read is judged against nothing",
    );
    assert.equal(
      night2.skippedScaleCheck,
      0,
      "a re-read with NO context would write the mis-scale unchecked",
    );
    assert.equal(
      night2.refusedScaleSuspect,
      1,
      "convicted again, on the same bytes",
    );
    assert.equal(night2.created, 0);
    assert.ok(
      !store.stamped.includes(suspect.id),
      "still unstamped — the period stays open until the sibling set changes",
    );

    // The counter that makes the nightly repetition VISIBLE. A held filing is
    // re-read forever, so the operator needs the reason named rather than
    // inferred from a subtraction: measured, 15 of prod's 90,188 filings
    // (0.017%) are known mis-scales, and if this figure ever approaches `limit`
    // the job is starving itself behind its own quarantine.
    assert.match(describeNoWriteReason(night2), /refusedScaleSuspect=1/);
  });

  it("POST-DRAIN: scale cover survives the end of the backlog, on ONE extra query", async () => {
    // MONEY-1237 FIX 3, and the defect it closes is invisible by construction.
    //
    // `judgeFilingScale` needs the periods ADJACENT to the candidate. During
    // the DRAIN they are free: a page holds whole symbols with their whole
    // history. Afterwards it does not — every earlier filing was stamped on an
    // earlier night and `unprojectedOnly` filters it out — so every page holds
    // roughly ONE new filing per symbol, `siblingPeriods` is 0, the detector
    // answers INSUFFICIENT_CONTEXT and the filing is written with NO scale
    // check. Nothing fails. The check just quietly stops existing, on the one
    // protection the CREATE-only universe (71,450 QUARTERLY filings, zero
    // incumbent rows) will ever get.
    //
    // This is the steady state: three symbols, FY2020–FY2022 stamped on earlier
    // nights, only FY2023 new.
    const symbols = ["ACO", "BCO", "CCO"];
    const history = symbols.flatMap((symbol) =>
      [2020, 2021, 2022, 2023].map((year, i) => {
        const f = annual({
          symbol,
          year,
          revenueCr: 900 + i * 60,
          profitCr: 120 + i * 8,
        });
        // Everything but the newest year was decided on an earlier night.
        if (year < 2023) (f as { projectedAt?: Date }).projectedAt = NOW;
        return f;
      }),
    );
    const store = emptyStore({ filings: history });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, unprojectedOnly: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(
      res.filingsRead,
      3,
      "one new filing per symbol — the steady state",
    );
    // 3 symbols x 3 earlier years. Zero here alongside a non-zero
    // `skippedScaleCheck` IS the scale-cover-goes-dark defect returning, which
    // is exactly why the counter is on the result rather than only in a log.
    assert.equal(res.scaleContextFetched, 9);
    assert.equal(
      res.skippedScaleCheck,
      0,
      "every candidate must be JUDGED — this is the number that was silently 3",
    );
    assert.equal(res.created, 3);

    // ── ROUND-TRIP COST ──
    // TWO `xbrlFiling.findMany` calls, for ANY number of symbols: the selection,
    // plus ONE grouped context fetch for the whole page. A per-symbol lookup
    // returns identical context and is indistinguishable by any assertion on
    // the RESULT — it would read 1 + 3 = 4 here, and 1 + 500 on a real page.
    // That N+1 is what made the F3 reconcile un-runnable (MONEY-1234: 6h20m at
    // 0.0% CPU, killed unfinished), against a 600s Pub/Sub ack deadline that
    // cannot be raised — past which Pub/Sub redelivers and a SECOND copy of the
    // job starts concurrently.
    assert.equal(
      store.filingQueries,
      2,
      `the context fetch must be ONE grouped query for the page, saw ${store.filingQueries}`,
    );
    assert.ok(
      store.filingQueries < 1 + symbols.length,
      "a per-symbol fetch would pass every other assertion in this case",
    );
  });

  it("a symbol with too few siblings is NOT quarantined on a guess", async () => {
    // One sibling period is no oracle: a median over a single point IS that
    // point, so one mis-scaled neighbour would convict a healthy filing. The
    // detector answers INSUFFICIENT_CONTEXT and the writer proceeds — a gap
    // invented out of thin air is worse than a number we can still reconcile.
    const store = emptyStore({
      filings: [
        annual({
          symbol: "NEWCO",
          year: 2021,
          revenueCr: 31_892.57,
          profitCr: 1_204.3,
        }),
        annual({
          symbol: "NEWCO",
          year: 2022,
          revenueCr: 31.89,
          profitCr: 1.2,
        }),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.refusedScaleSuspect, 0);
    assert.equal(res.created, 2);
    // …but the absence of cover is COUNTED — MONEY-1237. This used to fall
    // through with no counter at all, so a run with ZERO scale coverage read
    // identically to a run with full coverage. "Written unchecked" is a real
    // outcome and has to be a number, not a silence.
    assert.equal(res.skippedScaleCheck, 2);
  });

  it("an ordinary symbol is never touched by the detector", async () => {
    // The control. A quarantine that fires on healthy data costs periods
    // permanently and invisibly, which is the failure mode nobody would notice.
    const store = emptyStore({
      filings: [2020, 2021, 2022, 2023].map((year, i) =>
        annual({
          symbol: "GOODCO",
          year,
          revenueCr: 1_000 + i * 80,
          profitCr: 140 + i * 10,
        }),
      ),
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.refusedScaleSuspect, 0);
    assert.equal(res.created, 4);
  });

  it("REGRESSION: a real collapse survives, because the writer feeds BOTH statements in", async () => {
    // A demerger: FY2021 revenue and profit fall ~40x while the balance sheet
    // barely moves (the operating business became cash). Two income fields
    // agreeing on 10^-2 is exactly what rule 1 flags, and the UNMOVED balance
    // sheet is the only thing that saves it.
    //
    // Which makes this the case that pins `observeScale` to reading BOTH
    // `projection.income` AND `projection.balanceSheet`. Drop the balance sheet
    // from the observation and `totalAssets`/`totalEquity` are absent from every
    // observation, so nothing can veto and this correct, ordinary period is
    // quarantined forever. Every other quarantine case here uses income-only
    // fixtures and stays green through that change — this one does not.
    const store = emptyStore({
      filings: [
        annual({
          symbol: "DEMERGECO",
          year: 2021,
          revenueCr: 30,
          profitCr: 4,
          assetsCr: 4_800,
          equityCr: 2_000,
        }),
        ...[2020, 2022, 2023].map((year, i) =>
          annual({
            symbol: "DEMERGECO",
            year,
            revenueCr: 1_180 + i * 20,
            profitCr: 165 + i * 5,
            assetsCr: 4_650 + i * 50,
            equityCr: 1_960 + i * 20,
          }),
        ),
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(
      res.refusedScaleSuspect,
      0,
      "the balance sheet did not move, so this is a business event",
    );
    assert.equal(res.created, 8, "four years x INCOME + BALANCE_SHEET");
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — the no-write reason must name EVERY door                      */
/* -------------------------------------------------------------------------- */

describe("describeNoWriteReason — a hand-written list is what failed", () => {
  /**
   * Typed as the REAL result, with NO `as unknown as` cast — MONEY-1237.
   *
   * The cast was the shadow underneath the shadow. The case below advertises
   * itself as iterating "the TYPE's own keys", but it iterates
   * `Object.keys(base())` — the keys of this LITERAL. Under the cast a counter
   * added to `XbrlProjectionWriteResult` and forgotten here compiled fine, was
   * never in the loop, and the guard built to stop exactly that reported
   * success. It had already happened: `skippedScaleUnconfirmed` and
   * `skippedScaleCheck` were both added to the result type by this ticket and
   * neither reached this fixture.
   *
   * DROPPING THE CAST IS NOT WHAT PROTECTS IT, and assuming it did would be the
   * same mistake one level up. `workers/tsconfig.json` includes only
   * `src/**\/*` and `report-templates/**\/*`, so `yarn workspace
   * @usemoney/workers type-check` never compiles this file at all, and `tsx
   * --test` strips types rather than checking them — a missing key here is
   * invisible to BOTH gates the repo actually runs. The cast is gone because it
   * lies, but the enforcement is the RUNTIME key-parity case immediately below.
   */
  const base = (): XbrlProjectionWriteResult => ({
    ok: true,
    apply: true,
    createMissing: false,
    filingsRead: 500,
    truncatedByLimit: false,
    deferredByPagination: 0,
    refused: {
      HALF_YEARLY_HAS_NO_BUCKET: 0,
      CUMULATIVE_IS_NOT_A_QUARTER: 0,
      PERIOD_SPAN_CONTRADICTS_TYPE: 0,
      NO_USABLE_PERIOD: 0,
    },
    periods: 262,
    supersededSiblings: 0,
    unreadableFacts: 0,
    statementsProjected: 333,
    created: 0,
    updated: 0,
    displaced: 0,
    refusedScaleSuspect: 0,
    refusedBasisConflict: 0,
    skippedScaleUnconfirmed: 0,
    skippedScaleCheck: 0,
    scaleContextFetched: 0,
    scaleContextTruncated: false,
    skippedAuthority: 0,
    skippedUnchanged: 0,
    skippedBasisDowngrade: 0,
    skippedStandaloneNoDisplace: 0,
    skippedNoInstrument: 0,
    skippedCreateSuppressed: 0,
    failed: 0,
    stampAttempted: 0,
    stamped: 0,
    stampFailed: false,
    examples: [],
  });

  it("the fixture IS the real result shape — checked at runtime, not by a cast", async () => {
    // What makes the scan below a guard instead of a decoration. Every other
    // case in this describe reasons about `base()`, so `base()` drifting from
    // `XbrlProjectionWriteResult` disables all of them AT ONCE and silently —
    // and no gate this repo runs would notice (see `base()`'s note). So the
    // shape is compared against a REAL result from the REAL processor.
    const real = await processXbrlProjectionWrite(
      { now: NOW },
      { prisma: fakePrisma(emptyStore()) },
    );
    assert.deepEqual(
      Object.keys(base()).sort(),
      Object.keys(real).sort(),
      "a counter was added to the result and not to this fixture — every case " +
        "in this describe is now blind to it",
    );
  });

  it("names the counters the old hand-written list forgot", () => {
    // THE DEFECT. The previous reason string enumerated seven counters by name.
    // This ticket added three more and none appeared — so on the first armed
    // run `written: 0` caused ENTIRELY by the standalone guard (29.5% of winner
    // periods) would have printed a line of zeros.
    const r = base();
    r.skippedStandaloneNoDisplace = 294;
    r.skippedBasisDowngrade = 12;
    r.refusedScaleSuspect = 3;
    const msg = describeNoWriteReason(r);
    assert.match(msg, /standaloneNoDisplace=294/);
    assert.match(msg, /basisDowngrade=12/);
    assert.match(msg, /ScaleSuspect=3/);
  });

  it("EVERY skipped*/refused* key on the result reaches the string", () => {
    // The real regression guard: this iterates the TYPE's own keys, so a
    // counter added later without touching the reason builder fails here rather
    // than going silently unreported.
    const r = base();
    const keys = Object.keys(r).filter((k) => /^(skipped|refused)/.test(k));
    assert.ok(keys.length >= 7, `expected the counters, saw ${keys.length}`);
    // Named explicitly as well as scanned — MONEY-1237. The scan proves every
    // key REACHES the string; it cannot prove the key was named so that the
    // scan would find it. `skippedScaleCheck` counts filings written with NO
    // scale check, so nothing about the outcome suggests a `skipped` prefix;
    // it carries one PRECISELY so this scan (and the reason builder's own,
    // which shares the regex) picks it up without anybody remembering to. Rename
    // it to `scaleInsufficientContext` — the obvious name — and it silently
    // stops being reported, on the one check that covers the CREATE-only 90.7%.
    for (const k of [
      "refusedScaleSuspect",
      "skippedScaleUnconfirmed",
      "skippedScaleCheck",
    ]) {
      assert.ok(keys.includes(k), `${k} must match the reason builder's scan`);
    }
    for (const k of keys) {
      if (k === "refused") continue; // the nested refusal-reason object
      const one = base();
      (one as unknown as Record<string, number>)[k] = 7;
      const msg = describeNoWriteReason(one);
      assert.match(msg, /=7\b/, `${k} set to 7 but did not appear in: ${msg}`);
    }
  });

  it("sorts biggest door first — the operator's actual next question", () => {
    const r = base();
    r.skippedAuthority = 5;
    r.skippedCreateSuppressed = 400;
    const msg = describeNoWriteReason(r);
    assert.ok(
      msg.indexOf("createSuppressed=400") < msg.indexOf("authority=5"),
      msg,
    );
  });

  it("names the REFUSAL bucket — the largest door on a HALF_YEARLY page", () => {
    // THE DEFECT, in this very function. `result.refused` is a Record, not a
    // number, so the numeric scan skipped it entirely. Measured before the fix:
    // 4,999 refusals plus one failure printed "failed=1" — attributing 5,000
    // filings to a single error — and refusals alone printed "unaccounted,
    // investigate" while the refusal counters accounted for every one.
    const r = base();
    r.refused.HALF_YEARLY_HAS_NO_BUCKET = 4999;
    r.failed = 1;
    const msg = describeNoWriteReason(r);
    assert.match(msg, /refusedHALF_YEARLY_HAS_NO_BUCKET=4999/);
    assert.ok(
      msg.indexOf("HALF_YEARLY") < msg.indexOf("failed=1"),
      `the 4,999-filing door must lead: ${msg}`,
    );
    assert.doesNotMatch(msg, /NO counter accounts for it/);
  });

  it("counts filings deferred with the trailing symbol", () => {
    // They are inside `filingsRead`, so omitting them makes the arithmetic fail
    // to close and the operator hunt for a door that is not missing.
    const r = base();
    r.deferredByPagination = 14;
    assert.match(describeNoWriteReason(r), /deferredByPagination=14/);
  });

  it("is LOUD when nothing accounts for it", () => {
    // Selected filings, no writes, and every counter zero is not a quiet
    // success — the filings produced no statements at all.
    const msg = describeNoWriteReason(base());
    assert.match(msg, /NO counter accounts for it/);
    assert.match(msg, /unaccounted, investigate/);
    assert.match(msg, /statementsProjected=333/);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — what the RUN reports, on every branch                          */
/* -------------------------------------------------------------------------- */

/**
 * Capture the `[job-outcome]` line a run emits.
 *
 * `reportJobOutcome` writes to `console.warn` on the zero-write branch and
 * `console.log` otherwise, so both are captured and the branch is inferred from
 * the text rather than assumed. Restored in a `finally`: a test that leaves
 * `console.log` replaced poisons every test that runs after it in this file,
 * and the failure would surface somewhere else entirely.
 */
async function captureOutcome<T>(
  run: () => Promise<T>,
): Promise<{ result: T; outcome: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const grab = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  console.log = grab as typeof console.log;
  console.warn = grab as typeof console.warn;
  let result: T;
  try {
    result = await run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const outcome = lines.filter((l) => l.includes("[job-outcome]")).join("\n");
  assert.ok(
    outcome.length > 0,
    `no [job-outcome] line was emitted:\n${lines.join("\n")}`,
  );
  return { result, outcome };
}

/** An ARMED environment. The env is the ONLY thing that can arm a run. */
const ARMED: NodeJS.ProcessEnv = { XBRL_PROJECTION_APPLY: "true" };

describe("MONEY-1238 — the outcome line reports on ALL THREE branches", () => {
  it("NOT ARMED: promises a dry run AND prints the counts", async () => {
    // THE DEFECT. The string was literally
    //   "not-armed (…); counts are a dry run"
    // and then no counts. A rehearsal exists to be read; one that announces
    // numbers and prints none is worth less than no line at all, because it
    // reads like a line that was checked.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const { result, outcome } = await captureOutcome(() =>
      processXbrlProjection(undefined, { prisma: fakePrisma(store), now: NOW }),
    );

    assert.equal(result.applied, false);
    assert.match(outcome, /not-armed/);
    assert.match(outcome, /selected=1/);
    assert.match(outcome, /stampAttempted=0/, "a rehearsal stamps nothing");
    assert.match(outcome, /stamped=0/);
    assert.deepEqual(store.stamped, [], "a dry run must leave no trace");
  });

  it("ARMED WITH WRITES: the normal armed run still says what it withheld", async () => {
    // THE DEFECT, and the one that matters most: `skippedReason` was
    // `undefined` on this branch, so the ONLY branch a healthy armed job ever
    // takes reported nothing but `selected`/`written`/`failed`. A run that
    // wrote 400 and withheld 100 had no answer anywhere to "what happened to
    // the other hundred".
    //
    // TESTCO has a vendor incumbent and is written. NEWCO has none, so its
    // create is suppressed (`createMissing` defaults false — the nightly
    // payload's actual configuration).
    const store = emptyStore({
      filings: [
        filing({ symbol: "TESTCO" }),
        filing({ symbol: "NEWCO", instrumentId: "inst-2" }),
      ],
      financials: [tickertapeRow()],
    });
    const { result, outcome } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );

    assert.equal(result.applied, true);
    assert.equal(result.written, 1, "TESTCO's update landed");
    assert.ok(result.written > 0, "this is the ARMED-PARTIAL branch");
    // The counters are present even though a write succeeded.
    assert.match(outcome, /selected=2/);
    assert.match(outcome, /written=1/);
    assert.match(outcome, /doors=\[[^\]]*createSuppressed=1/);
    assert.equal(result.blocked, 1, "NEWCO's suppressed create is a door");
  });

  it("ARMED WITH ZERO WRITES: keeps the loud reason AND adds the counts", async () => {
    // This branch already had `describeNoWriteReason`. It must keep it — the
    // fix appends the measurements, it does not replace the diagnosis.
    const half = filing({
      symbol: "TESTCO",
      periodType: "HALF_YEARLY",
      cumulative: true,
      periodStart: utc("2025-04-01"),
      periodEnd: utc("2025-09-30"),
    });
    const store = emptyStore({ filings: [half] });
    const { result, outcome } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );

    assert.equal(result.written, 0);
    assert.match(outcome, /no write from 1 filing\(s\)/);
    assert.match(outcome, /refusedHALF_YEARLY_HAS_NO_BUCKET=1/);
    // …and the measurements the branch never used to carry.
    assert.match(outcome, /stampAttempted=1 stamped=1/);
    assert.match(outcome, /statementsProjected=0/);
  });
});

describe("MONEY-1238 — `ok` from the writer must reach the job outcome", () => {
  it("a per-row failure makes the JOB not-ok, not just the writer", async () => {
    // THE DEFECT: `processXbrlProjection` returned a HARDCODED `ok: true`,
    // discarding `out.ok = out.failed === 0` — which the writer sets under a
    // comment naming "the completeness-signal-at-the-wrong-granularity defect
    // this repo has now shipped five times (MONEY-1189)". Hardcoding it one
    // layer up is the sixth.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
      throwOnUpdate: true,
    });
    const { result } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );

    assert.equal(result.failed, 1);
    assert.equal(result.ok, false, "the writer said not-ok and was overruled");
  });

  it("a clean run is still ok — the pass-through is not a permanent false", async () => {
    // The other half of the mutation surface: `ok: false` hardcoded would pass
    // the case above and fail here.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const { result } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );
    assert.equal(result.failed, 0);
    assert.equal(result.ok, true);
  });
});

describe("MONEY-1238 — the cursor stamp is the highest-value signal here", () => {
  it("a stamp that THROWS is visible in the outcome, and does NOT fail the run", async () => {
    // THE DEFECT. The stamp lives in a try/catch that only warns — correctly,
    // because a cursor that fails to advance costs a repeated read, never a
    // wrong number — and `out.ok` was settled ~50 lines earlier. So a stamp
    // failing EVERY night reported `written=1 failed=0 ok=true` while the next
    // run re-read and re-wrote the same page. Forever. That is MONEY-1211 by
    // another door, and the silent-cursor defect has now shipped three times
    // here.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
      throwOnStamp: true,
    });
    const { result, outcome } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );

    assert.equal(result.written, 1, "the row was written");
    assert.equal(result.failed, 0);
    assert.equal(result.ok, true, "a cursor failure must not fail the run");
    // …and yet the run is NOT healthy, and says so.
    assert.match(outcome, /stampFailed=true/);
    assert.match(outcome, /stampAttempted=1 stamped=0/);
    assert.deepEqual(store.stamped, [], "nothing was actually stamped");
  });

  it("a stamp that matches FEWER rows than it named is visible too", async () => {
    // The quieter half, and the one a try/catch cannot reach: Mongo raises
    // nothing, it just matched fewer rows and said so only in `count`. Reading
    // that count is the entire fix; discarding it — which is what the code did
    // — makes a partial advance identical to a full one.
    const store = emptyStore({
      filings: [
        filing({ symbol: "AAA" }),
        filing({ symbol: "BBB", instrumentId: "inst-2" }),
        filing({ symbol: "CCC", instrumentId: "inst-3" }),
      ],
      financials: [
        tickertapeRow({ symbol: "AAA" }),
        tickertapeRow({ symbol: "BBB" }),
        tickertapeRow({ symbol: "CCC" }),
      ],
      stampCount: 1,
    });
    const { result, outcome } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );

    assert.equal(result.written, 3);
    assert.equal(result.stamped, 1, "only one filing's cursor advanced");
    assert.match(outcome, /stampAttempted=3 stamped=1/);
    assert.match(outcome, /stampFailed=false/);
  });

  it("a healthy stamp reports stamped === stampAttempted", async () => {
    // The positive control. Without it every assertion above passes against a
    // `stamped` hardcoded to 0.
    const store = emptyStore({
      filings: [
        filing({ symbol: "AAA" }),
        filing({ symbol: "BBB", instrumentId: "inst-2" }),
      ],
      financials: [
        tickertapeRow({ symbol: "AAA" }),
        tickertapeRow({ symbol: "BBB" }),
      ],
    });
    const { result, outcome } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );

    assert.equal(result.stamped, 2);
    assert.match(outcome, /stampAttempted=2 stamped=2/);
    // Against the STORE, not against a list derived from the store — the
    // reported count has to agree with what the fake actually recorded, or
    // `stamped` is just the writer agreeing with itself.
    assert.deepEqual(
      [...store.stamped].sort(),
      store.filings.map((f) => f.id).sort(),
    );
  });

  it("`stamped` is deliberately NOT named `skipped*`, so the door scan cannot eat it", async () => {
    // A previous agent named a counter `skippedScaleCheck` rather than the
    // obvious `scaleInsufficientContext` PRECISELY so `describeNoWriteReason`'s
    // `/^(skipped|refused)/` scan would pick it up. The inverse constraint
    // applies here: a cursor count is not a door a write went out of, so it
    // must NOT match that scan — and therefore has to be surfaced by name in
    // the outcome line, which is what the branch tests above pin.
    const real = await processXbrlProjectionWrite(
      { now: NOW },
      { prisma: fakePrisma(emptyStore()) },
    );
    for (const key of ["stamped", "stampAttempted", "stampFailed"]) {
      assert.ok(key in real, `${key} must exist on the writer's result`);
      assert.doesNotMatch(
        key,
        /^(skipped|refused)/,
        `${key} would be reported as a write door by the reason scan`,
      );
    }
    const withStamp = { ...real, stamped: 7, stampAttempted: 7 };
    assert.doesNotMatch(
      describeNoWriteReason(withStamp),
      /stamp/i,
      "the door census must not claim the cursor as a door",
    );
  });
});

describe("MONEY-1238 — `blocked` must count every real door, not just AUTHORITY", () => {
  /**
   * A REAL result from the REAL writer, then mutated.
   *
   * Same reasoning as the key-parity case above: a hand-written literal drifts
   * from `XbrlProjectionWriteResult` silently, and neither `tsc` (workers'
   * tsconfig excludes `__tests__`) nor `tsx --test` (strips types) would say
   * so. Starting from a real result makes the shape correct by construction.
   */
  const realResult = (): Promise<XbrlProjectionWriteResult> =>
    processXbrlProjectionWrite(
      { now: NOW },
      { prisma: fakePrisma(emptyStore()) },
    );

  it("THE DEFECT: skippedAuthority alone is structurally ~0", async () => {
    // `FinancialsSkipReason` has FOUR members and `skippedAuthority` catches
    // one — the one the writer's own comment says "cannot happen while
    // NSE_XBRL leads FINANCIALS_AUTHORITY". So `blocked` was a metric that
    // could only ever read 0, next to `written`, on the number an operator
    // reads first. And it had zero readers, which is how it stayed that way.
    const r = await realResult();
    r.skippedStandaloneNoDisplace = 294; // 29.5% of winner periods, measured
    r.skippedCreateSuppressed = 400; // EVERY quarterly write, nightly payload
    r.refusedScaleSuspect = 3;
    r.skippedBasisDowngrade = 12;
    r.skippedNoInstrument = 2;
    r.skippedScaleUnconfirmed = 5;
    assert.equal(r.skippedAuthority, 0, "the old formula's whole numerator");
    assert.equal(countWithheldWrites(r), 294 + 400 + 3 + 12 + 2 + 5);
  });

  it("counts the REFUSAL record, which the numeric scan cannot see", async () => {
    // `refused` is a Record, not a number — the same blind spot that made
    // `describeNoWriteReason` print "unaccounted, investigate" over 4,999
    // perfectly accounted-for refusals.
    const r = await realResult();
    r.refused.HALF_YEARLY_HAS_NO_BUCKET = 4999;
    r.refused.NO_USABLE_PERIOD = 1;
    assert.equal(countWithheldWrites(r), 5000);
  });

  it("EXCLUDES the two counters that are not withheld writes", async () => {
    // `skippedUnchanged` — the row already holds this value; nothing was
    // withheld. On a steady-state page it is the LARGEST counter, so counting
    // it would make `blocked` track how much of the page is already DONE.
    // `skippedScaleCheck` — the result type's own comment: "the filings it
    // counts were written". It wears the `skipped` prefix only so the door
    // scan finds it, which is exactly the trap being disarmed here.
    const r = await realResult();
    r.skippedUnchanged = 480;
    r.skippedScaleCheck = 500;
    assert.equal(countWithheldWrites(r), 0);
  });

  it("a NEW counter is counted by DEFAULT — the list is exclusions, not inclusions", async () => {
    // The lesson from `describeNoWriteReason`: a hand-written INCLUSION list is
    // what failed, twice. Over-reporting a door is a question an operator asks;
    // under-reporting one is the silence MONEY-1220/1235 exist to remove.
    const r = await realResult();
    (r as unknown as Record<string, number>).skippedSomeFutureDoor = 9;
    assert.equal(countWithheldWrites(r), 9);
  });

  it("a clean armed write reports blocked=0 even though skippedScaleCheck is 1", async () => {
    // The live form of the exclusion. Every fixture in this file trips
    // `skippedScaleCheck` (one filing, no siblings, INSUFFICIENT_CONTEXT), so
    // without the exclusion a perfectly healthy single-row write would report
    // a non-zero `blocked` forever.
    const store = emptyStore({
      filings: [filing({ symbol: "TESTCO" })],
      financials: [tickertapeRow()],
    });
    const { result } = await captureOutcome(() =>
      processXbrlProjection(undefined, {
        prisma: fakePrisma(store),
        now: NOW,
        env: ARMED,
      }),
    );
    assert.equal(result.written, 1);
    assert.equal(result.blocked, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1250 (T3.2) — the cross-basis invariant, WIRED                        */
/* -------------------------------------------------------------------------- */

/**
 * The judgement is pure and lives in `@usemoney/core/market-data`, where it has
 * its own unit tests. What can only go wrong HERE is the wiring: the detector
 * reads `paidUpEquityShareCapital` off the `ScaleObservation`, and the
 * observation is built by `observeScale` in this file. An optional field that
 * is never populated compiles clean, unit-tests clean, and sees `undefined` on
 * every filing in production — the MONEY-1220 shape exactly.
 */
describe("observeScale — the cross-basis invariant's input reaches the detector", () => {
  it("carries the paid-up tag and the rounding label onto the observation", () => {
    const obs = observeScale(
      filing({
        symbol: "TRENT",
        facts: {
          family: "ind-as",
          roundingLabel: "Lakhs",
          values: {
            revenueFromOperations: 1000 * RUPEES_PER_CRORE,
            profitForPeriod: 100 * RUPEES_PER_CRORE,
            paidUpEquityShareCapital: 3_555_000,
          },
        },
      }),
    );
    assert.ok(obs, "a readable filing must produce an observation");
    // POPULATED, not merely typed. This is the assertion the ticket exists for.
    assert.equal(obs.paidUpEquityShareCapital, 3_555_000);
    assert.equal(obs.roundingLabel, "Lakhs");
  });

  it("leaves the tag ABSENT rather than defaulting a missing one to zero", () => {
    // A zero would be a number the filing never stated, and the invariant's own
    // floor treats zero as unevaluable for exactly that reason — so a default
    // would look like data while carrying none.
    const obs = observeScale(filing({ symbol: "NOPAIDUP" }));
    assert.ok(obs);
    assert.equal(obs.paidUpEquityShareCapital, undefined);
  });

  it("REGRESSION: a non-finite tag is absent, not NaN", () => {
    const obs = observeScale(
      filing({
        symbol: "POISON",
        facts: {
          family: "ind-as",
          values: {
            revenueFromOperations: 1000 * RUPEES_PER_CRORE,
            profitForPeriod: 100 * RUPEES_PER_CRORE,
            paidUpEquityShareCapital: Number.NaN,
          },
        },
      }),
    );
    assert.ok(obs);
    assert.equal(obs.paidUpEquityShareCapital, undefined);
  });
});

describe("processXbrlProjectionWrite — a cross-basis conflict is HELD, not written", () => {
  /** TRENT FY2022: CONS 0.3555 crore (Lakhs) against STAN 35.55 crore (Crores). */
  const conflictingPair = (): FilingRow[] => [
    filing({
      symbol: "TRENT",
      basis: "CONSOLIDATED",
      coverage: 0.9,
      facts: {
        family: "ind-as",
        roundingLabel: "Lakhs",
        values: {
          revenueFromOperations: 1000 * RUPEES_PER_CRORE,
          profitForPeriod: 100 * RUPEES_PER_CRORE,
          paidUpEquityShareCapital: 3_555_000,
        },
      },
    }),
    filing({
      symbol: "TRENT",
      basis: "STANDALONE",
      coverage: 0.9,
      facts: {
        family: "ind-as",
        roundingLabel: "Crores",
        values: {
          revenueFromOperations: 900 * RUPEES_PER_CRORE,
          profitForPeriod: 90 * RUPEES_PER_CRORE,
          paidUpEquityShareCapital: 355_500_000,
        },
      },
    }),
  ];

  it("writes nothing, counts its own door, and does NOT stamp the cursor", async () => {
    const store = emptyStore({ filings: conflictingPair() });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );

    assert.equal(res.refusedBasisConflict, 1);
    assert.equal(res.created, 0, "nothing may be written for this period");
    assert.equal(store.creates.length, 0);
    // NOT STAMPED — the whole group, winner and superseded sibling alike. A
    // stamped filing is never re-read, and unlike SCALE_UNCONFIRMED this
    // verdict does not resolve itself, so a stamp here is a period lost with
    // no recovery path but a hand `$unset` against prod.
    assert.deepEqual(store.stamped, []);
    // Its own counter, never folded into `refusedScaleSuspect`. That counter
    // means "we convicted THIS filing and named the factor"; this one means
    // "the PAIR is provably inconsistent and nothing says which half".
    assert.equal(res.refusedScaleSuspect, 0);
    assert.equal(res.skippedScaleUnconfirmed, 0);
    // And it is not silently absorbed into "written with no scale cover".
    assert.equal(res.skippedScaleCheck, 0);
  });

  it("the door census names it, so a starving job is visible", async () => {
    // This verdict is the only scale door that does NOT empty itself: neither
    // document will ever change, so these filings are re-read every night for
    // good — 155 winner periods on the prod snapshot of 2026-08-26 against a
    // 500-filing page. `listWriteDoors` scans the result's own keys, so the
    // counter has to be named `refused*` to appear at all.
    const store = emptyStore({ filings: conflictingPair() });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.match(describeNoWriteReason(res), /refusedBasisConflict=1/);
    assert.equal(
      countWithheldWrites(res) >= 1,
      true,
      "a held period is a withheld write, not a healthy no-op",
    );
  });

  it("REGRESSION: agreeing bases still write — the guard is not a blanket refusal", async () => {
    // The mutation that matters most: if the invariant fired on every pair,
    // every company that files both bases would stop being written and the
    // test above would still pass.
    const [cons, stan] = conflictingPair();
    const store = emptyStore({
      filings: [
        {
          ...cons!,
          facts: {
            family: "ind-as",
            roundingLabel: "Crores",
            values: {
              revenueFromOperations: 1000 * RUPEES_PER_CRORE,
              profitForPeriod: 100 * RUPEES_PER_CRORE,
              paidUpEquityShareCapital: 355_500_000,
            },
          },
        } as FilingRow,
        stan!,
      ],
    });
    const res = await processXbrlProjectionWrite(
      { apply: true, createMissing: true, now: NOW },
      { prisma: fakePrisma(store) },
    );
    assert.equal(res.refusedBasisConflict, 0);
    assert.equal(store.creates.length > 0, true, "the period must be written");
    assert.equal(
      store.creates[0]!.revenueFromOperations,
      1000,
      "the consolidated figure",
    );
  });
});
