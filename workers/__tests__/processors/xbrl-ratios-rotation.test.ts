/**
 * BEHAVIOURAL TEST — `processXbrlRatios` against an in-memory store
 * (MONEY-1235).
 *
 * ## Why a source assertion was not enough
 *
 * The bug this file exists for was invisible to every layer above it. The
 * processor ordered its nightly batch by `symbol asc` under a comment
 * describing a stale-first marker cursor, and the wired test asserted only that
 * the string `ratiosDerivedAt:` appeared somewhere in the file — which pinned
 * the WRITE and said nothing about the READ. `ratiosDerivedAt` was written
 * every night and read by nothing, the `@@index([ratiosDerivedAt])` whose
 * schema doc says it "serves the nightly stale-first select" served a query
 * that did not exist, and with ~2,108 filing-bearing symbols against a limit of
 * 1,000 the same alphabetical first thousand were re-derived nightly while
 * roughly M–Z was never derived at all. The `[job-outcome]` line was healthy
 * every single run.
 *
 * A rotation defect only shows up ACROSS runs. So these tests run the real
 * exported `processXbrlRatios` twice against the same store and assert the
 * SECOND run reaches an instrument the first could not.
 *
 * The store is a plain object: no DB, no network, no timer, nothing to orphan.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  processXbrlRatios,
  ttmBasisOrder,
  type XbrlRatiosResult,
} from "../../src/processors/xbrl-ratios";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const NOW = utc("2026-08-21");
const day = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

type Row = Record<string, unknown>;

interface FilingFixture extends Row {
  id: string;
  instrumentId: string;
  /**
   * The FILING's own exchange — MONEY-1401 F22.
   *
   * DECLARED and DEFAULTED now, because it is `String` (non-nullable) in the
   * schema and `"NSE"` on all 108,073 prod rows, and because the candidate
   * query joins on it: with the fake honouring `where.OR`, a fixture that omits
   * it is not selectable at all. Pass `exchange: undefined` explicitly for the
   * absent-column case — the spread keeps it.
   */
  exchange: string | undefined;
  periodEnd: Date;
  periodType: string;
  cumulative: boolean;
  basis: string;
  coverage: number;
  filedAt: Date;
  sourceUrl: string;
  facts: unknown;
}

/**
 * A filing rich enough to clear `isPlanWorthWriting`: revenue + profit give
 * `netMargin`, and the two balance-sheet lines give `roe` and `roa`. That is
 * three FILING-derived fields, which is the floor — valuation fields are
 * excluded from it by design, because they come from a price, not a filing.
 */
function filing(over: Partial<FilingFixture>): FilingFixture {
  const periodEnd = over.periodEnd ?? utc("2025-03-31");
  const basis = over.basis ?? "CONSOLIDATED";
  // Consolidated is 2x standalone, mirroring the real gap the old code
  // mistook for growth (AMBUJACEM: 13,964.95 standalone, 28,965.46
  // consolidated). `over.facts` overrides this wholesale.
  const scale = basis === "CONSOLIDATED" ? 1 : 0.5;
  const revenue = 1_000_000_000 * scale;
  return {
    id: `f-${over.instrumentId ?? "i"}-${periodEnd.toISOString().slice(0, 10)}-${basis}`,
    instrumentId: "i-a",
    exchange: "NSE",
    periodEnd,
    periodType: "ANNUAL",
    cumulative: false,
    basis,
    coverage: 0.8,
    filedAt: new Date(periodEnd.getTime() + 60 * 86_400_000),
    sourceUrl: `https://nse/${basis}.xml`,
    facts: {
      family: "ind-as",
      basis,
      period: {
        start: new Date(periodEnd.getTime() - 364 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        end: periodEnd.toISOString().slice(0, 10),
        days: 365,
      },
      values: {
        revenueFromOperations: revenue,
        profitForPeriod: revenue * 0.1,
        totalAssets: revenue * 2,
        totalEquity: revenue,
        // The paid-up route `deriveShareCount` prefers. Without a share count
        // there is no market cap, and the price-freshness assertions below
        // would pass for the wrong reason.
        paidUpEquityShareCapital: revenue / 1_000,
        faceValuePerShare: 10,
      },
    },
    ...over,
  };
}

interface Store {
  instruments: Array<{ id: string; symbol: string; exchange: string }>;
  ratios: Row[];
  filings: FilingFixture[];
  prices: Array<{ instrumentId: string; date: Date; close: number }>;
  indexCloses: Array<{ date: Date; close: number }>;
  /**
   * `document_financial_extracts` rows, for the DOC arm of the selection OR —
   * MONEY-1401 F22.
   *
   * THIS COMMENT USED TO SAY "nothing in this suite reaches
   * `deriveFromExtracts`", and a later case falsified it without updating it:
   * "the DOC arm still selects an instrument with NO filing at all" seeds
   * `filings: []`, so the derive loop DOES call it. With no
   * `documentFinancialExtract` model on the fake, that call died with
   * `TypeError: Cannot read properties of undefined (reading 'findMany')`, the
   * loop's catch counted it `failed`, and the case's `assert.equal(selected, 1)`
   * passed anyway — measured `selected=1 failed=1 written=0`. The assertion was
   * about SELECTION so it was not false; it simply could never observe anything
   * past it, which left the doc arm's whole write path untested here.
   *
   * The financial fields are OPTIONAL so the selection-only cases stay as terse
   * as they were — a fixture that has to state sixteen columns to exercise one
   * `OR` clause is a fixture nobody adds a case to.
   */
  extracts: Array<
    {
      instrumentId: string;
      status: string;
      periodType: string;
    } & Partial<{
      periodEnd: Date;
      basis: string;
      revenueFromOperations: number;
      otherIncome: number;
      operatingIncomeExOtherIncome: number;
      ebitdaBeforeExceptionalItems: number;
      netIncome: number;
      totalAssets: number;
      totalLiabilities: number;
      totalEquity: number;
      totalDebt: number;
      totalCash: number;
      eps: number;
      faceValue: number;
      paidUpCapital: number;
    }>
  >;
  actions: Array<{
    symbol: string;
    exchange: string;
    exDate: Date;
    dividendPerShare: number | null;
    type: string;
  }>;
  /** Symbols handed to the derive loop, one entry per run. */
  selections: string[][];
  /** How many times the ~490-row nifty series was fetched. */
  indexCloseReads: number;
  upserts: Array<{ symbol: string; create: Row; update: Row }>;
}

function emptyStore(over: Partial<Store> = {}): Store {
  return {
    instruments: [],
    ratios: [],
    filings: [],
    prices: [],
    indexCloses: [],
    extracts: [],
    actions: [],
    selections: [],
    indexCloseReads: 0,
    upserts: [],
    ...over,
  };
}

/** A dense 730-day close series, so beta and the freshness bound both work. */
function closes(instrumentId: string, ageOfNewestDays = 1): Store["prices"] {
  const out: Store["prices"] = [];
  for (let k = 500; k >= 0; k--) {
    out.push({
      instrumentId,
      date: day(ageOfNewestDays + k),
      close: 100 + (k % 7),
    });
  }
  return out;
}

function indexSeries(): Store["indexCloses"] {
  const out: Store["indexCloses"] = [];
  for (let k = 500; k >= 0; k--) {
    out.push({ date: day(1 + k), close: 20_000 + (k % 5) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The fake                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One arm of the candidate query's `OR`, evaluated against the store —
 * MONEY-1401 F22.
 *
 * THE FAKE USED TO IGNORE `where.OR` ENTIRELY. It honoured only `symbol.in` and
 * `take`, so every instrument in the store was selected whatever the query
 * said — and nothing anywhere asserted that `XBRL_ARM_WHERE` was spread into
 * `OR` rather than `AND`, or that it reached the query at all. Verified by
 * mutation on 2026-09-13: deleting `XBRL_ARM_WHERE` from the production query
 * outright left all 107 worker xbrl-ratios cases and all 139 core ones GREEN.
 *
 * `AND` now falls out for free: two arms requiring `exchange: "NSE"` and
 * `exchange: "BSE"` of ONE row are unsatisfiable, so an `AND` spread selects
 * nothing and every case in this file goes red.
 */
function matchesSelectionArm(
  store: Store,
  inst: { id: string; exchange: string },
  clause: Record<string, unknown>,
): boolean {
  const c = clause as {
    exchange?: string;
    // MONEY-1401 F3 — a nested `OR`, which the not-stale exclusion is. Without
    // this arm the fake reads `{OR:[…]}` as a clause with no recognised key and
    // matches everything, so `staleAnnualExclusion` could be deleted from the
    // query outright and every case here would stay green.
    OR?: ReadonlyArray<Record<string, unknown>>;
    xbrlFilings?: {
      some?: {
        exchange?: string;
        periodType?: string;
        periodEnd?: { gte: Date };
      };
      none?: { periodType?: string };
    };
    documentFinancialExtracts?: {
      some?: { status?: string; periodType?: string };
    };
  };
  if (c.OR !== undefined) {
    return c.OR.some((sub) => matchesSelectionArm(store, inst, sub));
  }
  if (c.exchange !== undefined && inst.exchange !== c.exchange) return false;
  const mine = store.filings.filter((f) => f.instrumentId === inst.id);
  // Every field of ONE `some` must be satisfied by ONE filing — that is Prisma's
  // semantics, and it is what makes "has an ANNUAL inside the bound" a different
  // question from "has an ANNUAL, and has something inside the bound".
  if (c.xbrlFilings?.some !== undefined) {
    const want = c.xbrlFilings.some;
    if (
      !mine.some(
        (f) =>
          (want.exchange === undefined || f["exchange"] === want.exchange) &&
          (want.periodType === undefined || f.periodType === want.periodType) &&
          (want.periodEnd === undefined ||
            f.periodEnd.getTime() >= want.periodEnd.gte.getTime()),
      )
    ) {
      return false;
    }
  }
  // `{ none: {} }` — no filing AT ALL on this instrument, which is exactly the
  // condition under which `deriveFromExtracts` is reachable. `{ none: {
  // periodType: "ANNUAL" } }` is the narrower "has never filed an annual".
  const noneOf = c.xbrlFilings?.none;
  if (noneOf !== undefined) {
    const hit = mine.filter(
      (f) =>
        noneOf.periodType === undefined || f.periodType === noneOf.periodType,
    );
    if (hit.length > 0) return false;
  }
  const wantExtract = c.documentFinancialExtracts?.some;
  if (wantExtract !== undefined) {
    const hit = store.extracts.some(
      (x) =>
        x.instrumentId === inst.id &&
        (wantExtract.status === undefined || x.status === wantExtract.status) &&
        (wantExtract.periodType === undefined ||
          x.periodType === wantExtract.periodType),
    );
    if (!hit) return false;
  }
  return true;
}

function fakePrisma(store: Store) {
  return {
    // THE DOC ARM'S OWN MODEL. Absent until now, so `deriveFromExtracts` threw a
    // TypeError that the derive loop's catch counted as a failed INSTRUMENT —
    // a programming error wearing a data error's clothes. Present, the doc arm's
    // write path is reachable from this suite for the first time.
    documentFinancialExtract: {
      findMany: async (args: {
        where?: { instrumentId?: string; status?: string; periodType?: string };
        orderBy?: unknown;
        take?: number;
        select?: Record<string, boolean>;
      }) => {
        const w = args.where ?? {};
        let rows = store.extracts.filter(
          (e) =>
            (w.instrumentId === undefined ||
              e.instrumentId === w.instrumentId) &&
            (w.status === undefined || e.status === w.status) &&
            (w.periodType === undefined || e.periodType === w.periodType),
        );
        // The real query orders `periodEnd: "desc"`, and the TAKE is counted in
        // ROWS over a table where one period can occupy several — the
        // duplication-factor rule (MONEY-1207). Ordering here rather than
        // returning insertion order is what lets a fixture prove the newest
        // period wins.
        rows = [...rows].sort(
          (a, b) =>
            (b.periodEnd?.getTime() ?? 0) - (a.periodEnd?.getTime() ?? 0),
        );
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows;
      },
    },
    instrumentMapping: {
      findMany: async (args: {
        where?: {
          symbol?: { in: string[] };
          OR?: ReadonlyArray<Record<string, unknown>>;
          AND?: ReadonlyArray<Record<string, unknown>>;
        };
        take?: number;
      }) => {
        let rows = [...store.instruments];
        const inList = args.where?.symbol?.in;
        if (inList) rows = rows.filter((r) => inList.includes(r.symbol));
        const or = args.where?.OR;
        // The clause the fake used to drop on the floor.
        if (or !== undefined) {
          rows = rows.filter((r) =>
            or.some((clause) => matchesSelectionArm(store, r, clause)),
          );
        }
        // `AND` is honoured too, and it is not speculative: without it, spreading
        // the arms into `AND` leaves `where.OR` ABSENT, which the fake reads as
        // "no clause at all" — so the mutation would be caught for the wrong
        // reason and an `AND` that legitimately matched something would not be
        // caught at all. With it, two arms demanding `exchange: "NSE"` and
        // `exchange: "BSE"` of ONE row are unsatisfiable and every case goes red.
        const and = args.where?.AND;
        if (and !== undefined) {
          rows = rows.filter((r) =>
            and.every((clause) => matchesSelectionArm(store, r, clause)),
          );
        }
        rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
        return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
      },
    },
    stockRatios: {
      findMany: async (args: { take?: number }) => {
        // Mirrors Mongo's DESC ordering: null/ABSENT sorts LAST, which is what
        // makes the `MARKER_SCAN_CAP` degradation safe. Absent is modelled as
        // absent (the key is simply not on the object), because that is the
        // shape all 2,135 Tickertape-era rows really have.
        const rows = [...store.ratios].sort((a, b) => {
          const ta = a.ratiosDerivedAt as Date | undefined;
          const tb = b.ratiosDerivedAt as Date | undefined;
          if (!ta && !tb) return 0;
          if (!ta) return 1;
          if (!tb) return -1;
          return tb.getTime() - ta.getTime();
        });
        const cut =
          typeof args.take === "number" ? rows.slice(0, args.take) : rows;
        // MONEY-1235 — projects (symbol, exchange), mirroring the real `select`.
        // The cursor is read by the SAME tuple the upsert writes on; reading it
        // by `instrumentId` while writing by `symbol_exchange` is how the
        // rotation silently stopped advancing, and this fake could not show it
        // while it seeded `instrumentId` consistently.
        return cut.map((r) => ({
          symbol: r.symbol,
          exchange: r.exchange,
          ratiosDerivedAt: (r.ratiosDerivedAt as Date | undefined) ?? null,
        }));
      },
      findUnique: async (args: {
        where: { symbol_exchange: { symbol: string; exchange: string } };
      }) =>
        store.ratios.find(
          (r) =>
            r.symbol === args.where.symbol_exchange.symbol &&
            r.exchange === args.where.symbol_exchange.exchange,
        ) ?? null,
      upsert: async (args: {
        where: { symbol_exchange: { symbol: string; exchange: string } };
        create: Row;
        update: Row;
      }) => {
        const { symbol, exchange } = args.where.symbol_exchange;
        store.upserts.push({
          symbol,
          create: args.create,
          update: args.update,
        });
        const row = store.ratios.find(
          (r) => r.symbol === symbol && r.exchange === exchange,
        );
        if (row) Object.assign(row, args.update);
        else store.ratios.push({ ...args.create });
        return {};
      },
      updateMany: async (args: {
        where: { symbol: string; exchange: string };
        data: Row;
      }) => {
        // `count: 0` on a missing row rather than a P2025 throw — which is
        // exactly why the processor uses `updateMany` here, and why that count
        // is the honest measure of the rotation tax.
        let count = 0;
        for (const r of store.ratios) {
          if (
            r.symbol === args.where.symbol &&
            r.exchange === args.where.exchange
          ) {
            Object.assign(r, args.data);
            count++;
          }
        }
        return { count };
      },
    },
    xbrlFiling: {
      findMany: async (args: {
        where: { instrumentId: string; periodType?: string };
        take?: number;
      }) => {
        let rows = store.filings.filter(
          (f) => f.instrumentId === args.where.instrumentId,
        );
        // Honouring this in the fake is the point: a filter the store ignores
        // is a filter the test cannot tell apart from one applied afterwards,
        // and those two differ by whether the CAGR feed reaches FY(n-5).
        if (args.where.periodType) {
          rows = rows.filter((f) => f.periodType === args.where.periodType);
        }
        rows.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
        return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
      },
    },
    dailyPrice: {
      findMany: async (args: {
        where: { instrumentId: string; date: { gte: Date } };
      }) =>
        store.prices
          .filter(
            (p) =>
              p.instrumentId === args.where.instrumentId &&
              p.date.getTime() >= args.where.date.gte.getTime(),
          )
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .map((p) => ({ date: p.date, close: p.close })),
    },
    indexClose: {
      findMany: async (args: { where: { date: { gte: Date } } }) => {
        store.indexCloseReads++;
        return store.indexCloses
          .filter((c) => c.date.getTime() >= args.where.date.gte.getTime())
          .sort((a, b) => a.date.getTime() - b.date.getTime());
      },
    },
    corporateAction: {
      findMany: async (args: {
        where: { symbol: string; exchange: string; exDate: { gte: Date } };
      }) =>
        store.actions
          .filter(
            (a) =>
              a.symbol === args.where.symbol &&
              a.exchange === args.where.exchange &&
              a.exDate.getTime() >= args.where.exDate.gte.getTime(),
          )
          .sort((a, b) => b.exDate.getTime() - a.exDate.getTime())
          .map((a) => ({
            exDate: a.exDate,
            dividendPerShare: a.dividendPerShare,
            type: a.type,
          })),
    },
  } as never;
}

/**
 * `processXbrlRatios` records nothing about WHICH instruments it chose, so the
 * selection is recovered from the filing reads — the first query every derived
 * instrument makes.
 */
function trackSelections(store: Store) {
  const seen: string[] = [];
  const byId = new Map(store.instruments.map((i) => [i.id, i.symbol]));
  return {
    seen,
    wrap(db: ReturnType<typeof fakePrisma>) {
      const real = (db as unknown as { xbrlFiling: { findMany: unknown } })
        .xbrlFiling.findMany as (a: {
        where: { instrumentId: string; periodType?: string };
      }) => Promise<unknown>;
      (
        db as unknown as { xbrlFiling: { findMany: unknown } }
      ).xbrlFiling.findMany = async (a: {
        where: { instrumentId: string; periodType?: string };
      }) => {
        // Only the MIXED query (no periodType) marks an instrument as selected;
        // the ANNUAL query fires for the same instrument in the same tick.
        if (!a.where.periodType) {
          const sym = byId.get(a.where.instrumentId);
          if (sym && !seen.includes(sym)) seen.push(sym);
        }
        return real(a);
      };
      return db;
    },
  };
}

async function run(
  store: Store,
  msg: {
    limit?: number;
    symbols?: string[];
    docApply?: boolean;
    /**
     * A MESSAGE field (`resolveRatiosApply` narrows on it), unlike `docApply`
     * which is an env arm. It can only ever narrow: `apply: true` on an unarmed
     * env is still a dry run.
     */
    apply?: boolean;
  } = {},
): Promise<{ result: XbrlRatiosResult; selected: string[] }> {
  const tracker = trackSelections(store);
  const db = tracker.wrap(fakePrisma(store));
  // `docApply` is an ENV arm, not a message field — MONEY-1401 F22. Restored in
  // a `finally` so one case cannot leak the arm into the next.
  const { docApply, ...job } = msg;
  const saved = process.env.DOC_RATIOS_APPLY;
  if (docApply !== undefined) {
    process.env.DOC_RATIOS_APPLY = docApply ? "true" : "false";
  }
  let result: XbrlRatiosResult;
  try {
    result = await processXbrlRatios(job, { prisma: db, now: NOW });
  } finally {
    if (docApply !== undefined) {
      if (saved === undefined) delete process.env.DOC_RATIOS_APPLY;
      else process.env.DOC_RATIOS_APPLY = saved;
    }
  }
  store.selections.push(tracker.seen);
  return { result, selected: tracker.seen };
}

/* -------------------------------------------------------------------------- */
/* Arming                                                                      */
/* -------------------------------------------------------------------------- */

let savedArm: string | undefined;
before(() => {
  savedArm = process.env.XBRL_RATIOS_APPLY;
  // The cursor only advances when the run WRITES, which is correct: a dry run
  // must not mutate. That is why the rotation test has to be an armed one.
  //
  // MONEY-1286 — this job's arm is `XBRL_RATIOS_APPLY`, not the projection's
  // flag. It is set here and NEVER cleaned up by name elsewhere, so a revert to
  // the shared flag makes every armed case below go dry-run and the rotation
  // assertions go red rather than quietly passing on an unarmed run.
  process.env.XBRL_RATIOS_APPLY = "true";
});
after(() => {
  if (savedArm === undefined) delete process.env.XBRL_RATIOS_APPLY;
  else process.env.XBRL_RATIOS_APPLY = savedArm;
});

/* -------------------------------------------------------------------------- */

describe("processXbrlRatios — the batch advances across nights", () => {
  let store: Store;

  beforeEach(() => {
    store = emptyStore({
      instruments: [
        { id: "i-a", symbol: "AAA", exchange: "NSE" },
        { id: "i-b", symbol: "BBB", exchange: "NSE" },
        { id: "i-c", symbol: "CCC", exchange: "NSE" },
      ],
      filings: [
        filing({ instrumentId: "i-a" }),
        filing({ instrumentId: "i-b" }),
        filing({ instrumentId: "i-c" }),
      ],
      prices: [...closes("i-a"), ...closes("i-b"), ...closes("i-c")],
      indexCloses: indexSeries(),
    });
  });

  it("REGRESSION: the third instrument IS reached on the second run", () => {
    // THE headline assertion. Under `orderBy: [{ symbol: "asc" }]` CCC is
    // selected on neither run, forever — which for the real population meant
    // roughly symbols M–Z were never derived at all.
    return (async () => {
      const first = await run(store, { limit: 2 });
      assert.deepEqual(first.selected, ["AAA", "BBB"]);
      assert.equal(first.result.written, 2);

      const second = await run(store, { limit: 2 });
      assert.ok(
        second.selected.includes("CCC"),
        `run 2 selected ${JSON.stringify(second.selected)} — the cursor did not advance`,
      );
      // …and it leads, because it is the only never-derived instrument left.
      assert.equal(second.selected[0], "CCC");
    })();
  });

  it("sweeps the whole universe over ceil(N / limit) runs", () => {
    return (async () => {
      const reached = new Set<string>();
      for (let n = 0; n < 2; n++) {
        const r = await run(store, { limit: 2 });
        for (const s of r.selected) reached.add(s);
      }
      assert.deepEqual([...reached].sort(), ["AAA", "BBB", "CCC"]);
    })();
  });

  it("re-derives least-recently-first once every row has been stamped", () => {
    return (async () => {
      await run(store, { limit: 3 }); // everything stamped at NOW
      // Age two of them so the ordering has something to say.
      const ratio = (sym: string): Row =>
        store.ratios.find((r) => r.symbol === sym)!;
      (ratio("AAA") as { ratiosDerivedAt: Date }).ratiosDerivedAt =
        utc("2026-01-01");
      (ratio("CCC") as { ratiosDerivedAt: Date }).ratiosDerivedAt =
        utc("2026-04-01");
      const next = await run(store, { limit: 2 });
      assert.deepEqual(next.selected, ["AAA", "CCC"]);
    })();
  });

  it("an instrument the run REFUSES is still cursor-stamped, so it cannot starve the queue", () => {
    return (async () => {
      // BBB's filing carries nothing worth writing. Left unstamped it would sit
      // at the head of rank 1 forever and consume a slot every single night —
      // the same starvation the ordering bug caused, by a different door.
      store.filings = store.filings.filter((f) => f.instrumentId !== "i-b");
      store.filings.push(
        filing({
          instrumentId: "i-b",
          facts: { family: "ind-as", basis: "CONSOLIDATED", values: {} },
        }),
      );
      store.ratios.push({
        instrumentId: "i-b",
        symbol: "BBB",
        exchange: "NSE",
        source: "TICKERTAPE",
      });

      const first = await run(store, { limit: 3 });
      assert.equal(first.result.skippedNotWorthWriting, 1);
      // All three cursors advanced: two by the ratios upsert, BBB by the
      // cursor-only stamp. `cursorStamped`, not `written`, is what says
      // tomorrow's run will move on.
      assert.equal(
        first.result.cursorStamped,
        3,
        "the refusal was not stamped",
      );
      assert.equal(first.result.cursorUnstampable, 0);

      const bbb = store.ratios.find((r) => r.symbol === "BBB")!;
      assert.ok(
        bbb.ratiosDerivedAt instanceof Date,
        "a refused instrument must still carry a cursor",
      );
      // The stamp touched the cursor and NOTHING else — not the source, not a
      // ratio column. `ratiosDerivedAt` is documented on the model as a cursor.
      assert.equal(bbb.source, "TICKERTAPE");
      assert.equal(bbb.pe, undefined);
    })();
  });

  it("counts a refused instrument with NO ratios row as unstampable rather than hiding it", () => {
    return (async () => {
      store.filings = store.filings.filter((f) => f.instrumentId !== "i-b");
      store.filings.push(
        filing({
          instrumentId: "i-b",
          facts: { family: "ind-as", basis: "CONSOLIDATED", values: {} },
        }),
      );
      const r = await run(store, { limit: 3 });
      assert.equal(r.result.written, 2);
      assert.equal(r.result.cursorStamped, 2, "the two writes advanced");
      assert.equal(
        r.result.cursorUnstampable,
        1,
        "an unstampable row must be COUNTED, never silent",
      );
      // This assertion is correct for what it tests — one unstampable row out
      // of three, at `limit: 3`. Its old wording called that "the residual
      // starvation tax", and that characterisation was wrong: measured on prod
      // 2026-09-13, the unstampable cohort is 2,164 of 2,807 instruments
      // (77.1%) against a nightly limit of 1,000, so it is not residual and it
      // does not merely tax the rotation — it stops it dead by night 5
      // (MONEY-1396).
      //
      // Counting it here can never reveal that: starvation is a property of the
      // POPULATION against the LIMIT, and these interlock cases run at `limit:
      // 3` with three instruments, a scale at which a starving rotation and a
      // healthy one are identical. `xbrl-ratios-starvation.test.ts` simulates
      // the real ratio across eight nights; this case stays as the per-row
      // counter check it always was.
    })();
  });
});

describe("processXbrlRatios — the per-run reads happen once", () => {
  it("fetches the nifty series ONCE for the whole batch", () => {
    return (async () => {
      const store = emptyStore({
        instruments: [
          { id: "i-a", symbol: "AAA", exchange: "NSE" },
          { id: "i-b", symbol: "BBB", exchange: "NSE" },
          { id: "i-c", symbol: "CCC", exchange: "NSE" },
        ],
        filings: [
          filing({ instrumentId: "i-a" }),
          filing({ instrumentId: "i-b" }),
          filing({ instrumentId: "i-c" }),
        ],
        prices: [...closes("i-a"), ...closes("i-b"), ...closes("i-c")],
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 3 });
      assert.equal(r.result.selected, 3);
      assert.equal(
        store.indexCloseReads,
        1,
        "the ~490-row index series was re-read per instrument — ~1,000 " +
          "identical Atlas round-trips a night against a 600s ack deadline",
      );
    })();
  });

  it("reports its own wall clock, so the ack-deadline budget stops being a guess", () => {
    return (async () => {
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [filing({ instrumentId: "i-a" })],
        prices: closes("i-a"),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(typeof r.result.durationMs, "number");
      assert.ok(r.result.durationMs >= 0);
    })();
  });
});

describe("processXbrlRatios — basis selection", () => {
  function dualBasisStore(years: number): Store {
    const filings: FilingFixture[] = [];
    for (let y = 0; y < years; y++) {
      for (const basis of ["CONSOLIDATED", "STANDALONE"]) {
        filings.push(
          filing({
            instrumentId: "i-a",
            periodEnd: utc(`${2025 - y}-03-31`),
            basis,
          }),
        );
      }
    }
    return emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings,
      prices: closes("i-a"),
      indexCloses: indexSeries(),
    });
  }

  it("stamps the CONSOLIDATED filing, whatever order the store returns", () => {
    return (async () => {
      const store = dualBasisStore(2);
      await run(store, { limit: 1 });
      const write = store.upserts[0]!;
      assert.match(
        String(write.create.ratiosFilingId),
        /CONSOLIDATED$/,
        "the standalone filing won the period — 70.5% of symbols file both",
      );
    })();
  });

  it("REGRESSION: growth is YoY, not the consolidation GAP", () => {
    return (async () => {
      // Consolidated is 2x standalone in the fixture, mirroring AMBUJACEM
      // (13,964.95 standalone vs 28,965.46 consolidated). Under the old
      // `annualFilings[0]/[1]` the "prior year" was frequently the SAME year's
      // other basis, so `revenueGrowth` reported the consolidation gap — and it
      // WAS written, because an ANNUAL periodType clears the refusal.
      const store = dualBasisStore(2);
      await run(store, { limit: 1 });
      const set = store.upserts[0]!.create;
      assert.equal(
        set.revenueGrowth,
        0,
        "two equal consolidated years must yield 0% growth, not the C-vs-S gap",
      );
    })();
  });

  it("REGRESSION: 5Y CAGR is reachable for a dual-basis filer", () => {
    return (async () => {
      // Seven fiscal years, each filed on both bases = 14 rows. The old
      // newest-24 MIXED query could not see FY(n-5); the ANNUAL-only take can.
      const store = dualBasisStore(7);
      await run(store, { limit: 1 });
      const set = store.upserts[0]!.create;
      assert.notEqual(
        set.revenueGrowth5Y,
        undefined,
        "the 5Y CAGR point sat outside the query window, not outside the table",
      );
      assert.notEqual(set.revenueGrowth3Y, undefined);
    })();
  });

  it("four years of history yields a 3Y CAGR and NO 5Y — the honest null", () => {
    return (async () => {
      // `cagr()` needs `years + 1` points, so four fiscal years is exactly a
      // 3Y CAGR and one short of nothing else. The 5Y null here is a genuine
      // `insufficient-history`, which is the case the old query window made
      // indistinguishable from a starved feed.
      const store = dualBasisStore(4);
      await run(store, { limit: 1 });
      const set = store.upserts[0]!.create;
      assert.equal(set.revenueGrowth5Y, undefined);
      assert.notEqual(set.revenueGrowth3Y, undefined);
    })();
  });
});

describe("processXbrlRatios — price hygiene", () => {
  function storeWithPriceAge(ageDays: number): Store {
    return emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [filing({ instrumentId: "i-a" })],
      prices: closes("i-a", ageDays),
      indexCloses: indexSeries(),
    });
  }

  it("uses a close from a holiday weekend", () => {
    return (async () => {
      const store = storeWithPriceAge(4);
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.stalePrice, 0);
      assert.notEqual(
        store.upserts[0]!.create.marketCap,
        undefined,
        "a four-day-old close is Friday's, and Friday's close is correct",
      );
    })();
  });

  it("REGRESSION: refuses a close from a suspended counter and COUNTS it", () => {
    return (async () => {
      // The read had no lower bound at all, so an `isActive` instrument that
      // stopped trading kept collecting a P/E and a market cap off an
      // arbitrarily old close, stamped with a fresh `ratiosDerivedAt`. The only
      // trace was `ratiosPriceDate`, which nothing reads.
      const store = storeWithPriceAge(45);
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.stalePrice, 1);
      const create = store.upserts[0]!.create;
      assert.equal(create.marketCap, undefined);
      assert.equal(create.pe, undefined);
      assert.equal(create.ratiosPriceDate, null);
    })();
  });

  it("omits ratiosPriceDate from the UPDATE rather than nulling it", () => {
    return (async () => {
      const store = storeWithPriceAge(45);
      store.ratios.push({
        instrumentId: "i-a",
        symbol: "AAA",
        exchange: "NSE",
        source: "TICKERTAPE",
        pe: 12,
        ratiosPriceDate: utc("2026-08-01"),
      });
      await run(store, { limit: 1 });
      const update = store.upserts[0]!.update;
      assert.ok(
        !("ratiosPriceDate" in update),
        "nulling the stamp beside a surviving pe leaves that pe unattributable",
      );
      assert.equal(
        (store.ratios[0] as Row).ratiosPriceDate instanceof Date,
        true,
      );
    })();
  });

  it("drops the beta return on a SPLIT ex-date and counts the drop", () => {
    return (async () => {
      const store = storeWithPriceAge(1);
      const exDate = day(100);
      store.actions.push({
        symbol: "AAA",
        exchange: "NSE",
        exDate,
        dividendPerShare: null,
        type: "SPLIT",
      });
      const r = await run(store, { limit: 1 });
      assert.equal(
        r.result.betaReturnsDropped,
        1,
        "a split inside the window injects a ~ln(2) fake return into the OLS " +
          "slope, and adjClose is populated on 0 of 10,615,160 rows",
      );
    })();
  });

  it("does NOT drop a dividend ex-date — that return is real", () => {
    return (async () => {
      const store = storeWithPriceAge(1);
      store.actions.push({
        symbol: "AAA",
        exchange: "NSE",
        exDate: day(100),
        dividendPerShare: 5,
        type: "DIVIDEND",
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.betaReturnsDropped, 0);
    })();
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1238                                                                  */
/* -------------------------------------------------------------------------- */

/** A DISCRETE quarterly filing, the shape `deriveTtm` will accept. */
function quarter(over: {
  instrumentId: string;
  periodEnd: Date;
  basis: string;
  eps?: number;
}): FilingFixture {
  const scale = over.basis === "CONSOLIDATED" ? 1 : 0.5;
  const revenue = 250_000_000 * scale;
  const end = over.periodEnd;
  return {
    id: `q-${over.instrumentId}-${end.toISOString().slice(0, 10)}-${over.basis}`,
    instrumentId: over.instrumentId,
    // NSE, like every one of the 108,073 prod rows — and like `filing()`.
    // The candidate query joins on this column now (MONEY-1401 F22), so a
    // fixture that omits it is not selectable at all.
    exchange: "NSE",
    periodEnd: end,
    periodType: "QUARTERLY",
    cumulative: false,
    basis: over.basis,
    coverage: 0.8,
    filedAt: new Date(end.getTime() + 40 * 86_400_000),
    sourceUrl: `https://nse/q-${over.basis}.xml`,
    facts: {
      family: "ind-as",
      basis: over.basis,
      period: {
        start: new Date(end.getTime() - 89 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        end: end.toISOString().slice(0, 10),
        days: 90,
      },
      values: {
        revenueFromOperations: revenue,
        profitForPeriod: revenue * 0.1,
        basicEps: (over.eps ?? 5) * scale,
        profitBeforeTax: revenue * 0.13,
        financeCosts: revenue * 0.01,
        depreciationAndAmortisation: revenue * 0.02,
      },
    },
  };
}

/**
 * The `filing()` fixture reports neither `borrowings` nor
 * `cashAndCashEquivalents`, so `deriveValuation` correctly refuses an
 * enterprise value — and `evToEbitda` is then undefined for a reason that has
 * nothing to do with basis. A fixture that cannot tell the two code paths apart
 * makes the assertion vacuous, which is exactly how the first version of the
 * `evToEbitda` guard survived its own mutation test. This one CAN.
 */
function annualWithEv(over: {
  instrumentId: string;
  basis: string;
}): FilingFixture {
  const base = filing({ instrumentId: over.instrumentId, basis: over.basis });
  const facts = base.facts as { values: Record<string, number> };
  return {
    ...base,
    facts: {
      ...(base.facts as object),
      values: {
        ...facts.values,
        borrowings: facts.values.totalAssets! * 0.2,
        cashAndCashEquivalents: facts.values.totalAssets! * 0.05,
      },
    },
  };
}

/** The four discrete quarter-ends preceding a 31-March year end. */
const Q_ENDS = [
  utc("2025-03-31"),
  utc("2024-12-31"),
  utc("2024-09-30"),
  utc("2024-06-30"),
];

describe("MONEY-1238 — the TTM basis is chosen BEFORE the winners", () => {
  it("computes a TTM the per-period winners would have made MIXED", () => {
    return (async () => {
      // Both bases for three quarters, STANDALONE only for the fourth. Picking
      // the best filing PER PERIOD yields CONSOLIDATED, CONSOLIDATED,
      // CONSOLIDATED, STANDALONE — refused as mixed-basis, and `pe` is null —
      // while four coherent STANDALONE quarters sat in the same page.
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [
          filing({ instrumentId: "i-a", basis: "STANDALONE" }),
          ...Q_ENDS.map((e) =>
            quarter({ instrumentId: "i-a", periodEnd: e, basis: "STANDALONE" }),
          ),
          ...Q_ENDS.slice(0, 3).map((e) =>
            quarter({
              instrumentId: "i-a",
              periodEnd: e,
              basis: "CONSOLIDATED",
            }),
          ),
        ],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.ttmRefusals["mixed-basis"], 0);
      assert.notEqual(
        store.upserts[0]!.create.pe,
        undefined,
        "four coherent standalone quarters must produce a P/E",
      );
    })();
  });

  it("prefers the basis the BALANCE SHEET half of the row uses", () => {
    return (async () => {
      // Four quarters on BOTH bases and a CONSOLIDATED annual: the TTM must
      // come from the consolidated quarters, so `evToEbitda` is not withheld.
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [
          annualWithEv({ instrumentId: "i-a", basis: "CONSOLIDATED" }),
          ...Q_ENDS.flatMap((e) => [
            quarter({
              instrumentId: "i-a",
              periodEnd: e,
              basis: "CONSOLIDATED",
            }),
            quarter({ instrumentId: "i-a", periodEnd: e, basis: "STANDALONE" }),
          ]),
        ],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.ttmBasisFallback, 0);
      assert.notEqual(store.upserts[0]!.create.pe, undefined);
      // The POSITIVE CONTROL for the withholding test below: with the bases
      // agreeing, this fixture DOES produce an evToEbitda. Without it, "the
      // ratio is absent" proves nothing — it is absent in both worlds.
      assert.notEqual(store.upserts[0]!.create.evToEbitda, undefined);
    })();
  });

  it("REGRESSION: withholds evToEbitda when the TTM basis differs", () => {
    return (async () => {
      // The mixed ratio that passed every existing guard: a CONSOLIDATED annual
      // supplies equity/debt/cash to enterprise value while the only quarters
      // filed are STANDALONE. Homogeneous, so `deriveTtm` accepted them, and
      // `evToEbitda` was written as a group EV over a parent EBITDA.
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [
          annualWithEv({ instrumentId: "i-a", basis: "CONSOLIDATED" }),
          ...Q_ENDS.map((e) =>
            quarter({ instrumentId: "i-a", periodEnd: e, basis: "STANDALONE" }),
          ),
        ],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.ttmBasisFallback, 1, "the fallback is COUNTED");
      assert.equal(
        store.upserts[0]!.create.evToEbitda,
        undefined,
        "a group EV over a parent EBITDA must not be written",
      );
      assert.notEqual(
        store.upserts[0]!.create.pe,
        undefined,
        "P/E has no balance-sheet leg and must still be computed",
      );
    })();
  });
});

describe("MONEY-1238 — every selected instrument reaches a counter", () => {
  it("counts a no-input instrument instead of losing it", () => {
    return (async () => {
      // `written + skippedNotWorthWriting + failed + noInputs` must equal
      // `selected`. Before this the `no-inputs` arm incremented nothing and the
      // shortfall was silent.
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [
          { ...filing({ instrumentId: "i-a" }), facts: "not decodable" },
        ],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.selected, 1);
      assert.equal(r.result.noInputs, 1);
      assert.equal(
        r.result.written +
          r.result.skippedNotWorthWriting +
          r.result.failed +
          r.result.noInputs,
        r.result.selected,
        "the outcome counters must sum to the selection",
      );
    })();
  });

  it("REGRESSION: an undecodable instrument does not squat at the head", () => {
    return (async () => {
      // MONEY-1211's shape through a third door. `rankRatiosTargets` ranks
      // never-derived FIRST, so an instrument whose `facts` will never decode
      // was selected first, produced nothing, went unstamped, and was selected
      // first again — forever, consuming a slot a real instrument needed.
      const store = emptyStore({
        instruments: [
          { id: "i-a", symbol: "AAA", exchange: "NSE" },
          { id: "i-b", symbol: "BBB", exchange: "NSE" },
        ],
        ratios: [
          { symbol: "AAA", exchange: "NSE", source: "TICKERTAPE" },
          { symbol: "BBB", exchange: "NSE", source: "TICKERTAPE" },
        ],
        filings: [
          { ...filing({ instrumentId: "i-a" }), facts: "not decodable" },
          filing({ instrumentId: "i-b" }),
        ],
        prices: [...closes("i-a", 1), ...closes("i-b", 1)],
        indexCloses: indexSeries(),
      });
      const first = await run(store, { limit: 1 });
      assert.deepEqual(first.selected, ["AAA"]);
      assert.equal(first.result.cursorStamped, 1, "the squatter is stamped");

      const second = await run(store, { limit: 1 });
      assert.deepEqual(
        second.selected,
        ["BBB"],
        "the batch must move on to the instrument that can be derived",
      );
    })();
  });

  it("does NOT stamp on an unarmed run", () => {
    return (async () => {
      const saved = process.env.XBRL_RATIOS_APPLY;
      process.env.XBRL_RATIOS_APPLY = "false";
      try {
        const store = emptyStore({
          instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
          ratios: [{ symbol: "AAA", exchange: "NSE", source: "TICKERTAPE" }],
          filings: [
            { ...filing({ instrumentId: "i-a" }), facts: "not decodable" },
          ],
          prices: closes("i-a", 1),
          indexCloses: indexSeries(),
        });
        const r = await run(store, { limit: 1 });
        assert.equal(r.result.noInputs, 1);
        assert.equal(r.result.cursorStamped, 0);
        assert.equal(store.ratios[0]!.ratiosDerivedAt, undefined);
      } finally {
        process.env.XBRL_RATIOS_APPLY = saved;
      }
    })();
  });

  it("stamps over an UNKNOWN incumbent source — unknown ranks LAST", () => {
    return (async () => {
      // The authority guard on the no-input stamp is asserted STRUCTURALLY in
      // `xbrl-ratios-wired.test.ts` ("the cursor-only stamp sits BEHIND the
      // same authority guard as the write"), because it cannot be exercised
      // behaviourally: NSE_XBRL leads `FINANCIALS_AUTHORITY`, so no incumbent
      // can outrank it and the refusal branch is unreachable today.
      //
      // What IS checkable is the direction the guard must NOT drift in. An
      // unrecognised source ranks LAST (`rankOf` returns the table length), so
      // it may only ever fill a gap — never block us. A guard "hardened" into
      // failing closed on an unknown source would park every such row at the
      // head of the rotation permanently, which is the starvation this stamp
      // exists to end.
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        ratios: [{ symbol: "AAA", exchange: "NSE", source: "SOME_NEW_VENDOR" }],
        filings: [
          { ...filing({ instrumentId: "i-a" }), facts: "not decodable" },
        ],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.noInputs, 1);
      assert.equal(r.result.cursorStamped, 1);
      assert.deepEqual(store.ratios[0]!.ratiosDerivedAt, NOW);
      // …and ONLY the cursor. Not the source, not a ratio column.
      assert.equal(store.ratios[0]!.source, "SOME_NEW_VENDOR");
    })();
  });
});

describe("MONEY-1238 — the planner's diagnostics reach the result", () => {
  it("aggregates unfilled columns with their REASON", () => {
    return (async () => {
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [filing({ instrumentId: "i-a" })],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      // `grossMargin` needs an expense breakdown this fixture does not carry,
      // so it is the column the module's own promise is written about.
      // The COLUMN alone is not the point — the REASON is. An assertion on the
      // key set alone survives a mutation that keeps the column and drops the
      // reason, which is exactly what `planRatiosWrite` computes and what
      // nothing used to read. (Mutation-checked: the weaker version DID
      // survive.)
      //
      // `revenueGrowth` is the module's own example shape: a column refused for
      // a stated, actionable cause rather than an unexplained null. This
      // fixture supplies ONE annual filing, so there is no prior year.
      assert.deepEqual(r.result.unfilledByColumn["revenueGrowth"], {
        "no prior-year filing supplied": 1,
      });
      // …and `grossMargin`, the column the module's promise is literally
      // written about ("gross margin null for 3,900 lenders").
      assert.deepEqual(r.result.unfilledByColumn["grossMargin"], {
        "no-input": 1,
      });
      // Every reported column must carry at least one counted reason. An empty
      // reason map is a column that reached the report having explained
      // nothing.
      for (const [column, reasons] of Object.entries(
        r.result.unfilledByColumn,
      )) {
        const entries = Object.entries(reasons);
        assert.ok(entries.length > 0, `${column} was reported with no reason`);
        for (const [reason, count] of entries) {
          assert.ok(reason.length > 0, "an unfilled column must say why");
          assert.ok(count > 0);
        }
      }
    })();
  });

  it("every new counter reaches the [job-outcome] LINE, not just the result", () => {
    return (async () => {
      // "Computed and never wired to anything that decides" is the defect this
      // whole ticket family is about, and an object property a test reads is
      // not a signal an OPERATOR reads. `reportJobOutcome`'s `skippedReason` is
      // the only free-text channel this job has, so the counters must land in
      // it — otherwise they are a nicer-looking version of the same silence.
      const lines: string[] = [];
      const realLog = console.log;
      const realWarn = console.warn;
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
      console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
      try {
        const base = filing({ instrumentId: "i-a" });
        const facts = base.facts as { values: Record<string, number> };
        const store = emptyStore({
          instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
          filings: [
            {
              ...base,
              facts: {
                ...(base.facts as object),
                values: { ...facts.values, grossNpaRatio: 2.1 },
              },
            },
          ],
          prices: closes("i-a", 1),
          indexCloses: indexSeries(),
        });
        await run(store, { limit: 1 });
        const outcome = lines.find((l) => l.includes("[job-outcome]"));
        assert.ok(outcome, "the run reported no job outcome at all");
        for (const key of [
          "noInputs=",
          "ttmBasisFallback=",
          "unfilled=[",
          "unstorable=",
        ]) {
          assert.ok(
            outcome.includes(key),
            `${key} never reaches the job-outcome line`,
          );
        }
        // `reportJobOutcome` JSON-stringifies the whole payload, so the inner
        // JSON arrives with escaped quotes. Matched loosely on the quote so the
        // assertion is about the VALUE reaching an operator, not about a
        // reporting-layer encoding detail.
        assert.match(outcome, /unstorable=\{\\?"grossNpaRatio\\?":1\}/);
      } finally {
        console.log = realLog;
        console.warn = realWarn;
      }
    })();
  });

  it("reports a computed number with no column to store it in", () => {
    return (async () => {
      // A lender's disclosed NPA ratios: computed by `deriveRatios` on every
      // bank filing, with nowhere on `StockRatios` to put them.
      const base = filing({ instrumentId: "i-a" });
      const facts = base.facts as { values: Record<string, number> };
      const store = emptyStore({
        instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
        filings: [
          {
            ...base,
            facts: {
              ...(base.facts as object),
              values: { ...facts.values, grossNpaRatio: 2.1 },
            },
          },
        ],
        prices: closes("i-a", 1),
        indexCloses: indexSeries(),
      });
      const r = await run(store, { limit: 1 });
      assert.equal(r.result.computedButUnstorable.grossNpaRatio, 1);
    })();
  });
});

describe("ttmBasisOrder", () => {
  const rows = (...b: string[]) => b.map((basis) => ({ basis }));

  it("puts the PREFERRED basis first", () => {
    assert.deepEqual(
      ttmBasisOrder("STANDALONE", rows("CONSOLIDATED", "STANDALONE")),
      ["STANDALONE", "CONSOLIDATED"],
    );
  });

  it("omits a basis the company does not file", () => {
    // Attempting it costs nothing but emits a `no-quarters` refusal for a basis
    // that was never going to exist — noise in the one counter that is supposed
    // to say why `pe` is null.
    assert.deepEqual(ttmBasisOrder("CONSOLIDATED", rows("STANDALONE")), [
      "STANDALONE",
    ]);
    assert.deepEqual(ttmBasisOrder("CONSOLIDATED", []), []);
  });

  it("ranks the tail CONSOLIDATED, STANDALONE, then unknown by name", () => {
    // An unrecognised basis sorts LAST for the same reason `basisRank` and
    // `rankOf` put unknowns last: a vocabulary we have not seen may fill a gap,
    // never displace something we understand.
    assert.deepEqual(
      ttmBasisOrder("IFRS-SEGMENT", rows("STANDALONE", "ZZZ", "CONSOLIDATED")),
      ["CONSOLIDATED", "STANDALONE", "ZZZ"],
    );
  });

  it("is a TOTAL order — independent of the row order Mongo returned", () => {
    const a = ttmBasisOrder(
      "CONSOLIDATED",
      rows("ZZZ", "STANDALONE", "CONSOLIDATED", "AAA"),
    );
    const b = ttmBasisOrder(
      "CONSOLIDATED",
      rows("AAA", "CONSOLIDATED", "ZZZ", "STANDALONE"),
    );
    assert.deepEqual(a, b);
    assert.deepEqual(a, ["CONSOLIDATED", "STANDALONE", "AAA", "ZZZ"]);
  });

  it("never repeats a basis", () => {
    // The preferred basis is in `present`, so a naive `[preferred, ...present]`
    // would try it twice — one wasted `selectPeriodWinners` pass per instrument
    // and a duplicated refusal in the counters.
    const out = ttmBasisOrder(
      "CONSOLIDATED",
      rows("CONSOLIDATED", "CONSOLIDATED", "STANDALONE"),
    );
    assert.deepEqual(out, ["CONSOLIDATED", "STANDALONE"]);
    assert.equal(new Set(out).size, out.length);
  });
});

describe("the ANNUAL reaches the WRITE — MONEY-1401 F10", () => {
  /* ──────────────────────────────────────────────────────────────────────────
     `xbrl-ratios-annual-period.test.ts` asserts `chooseRatioDerivationInputs`
     and a hand-written `planFor` that re-states `deriveOne`'s composition. The
     defect MONEY-1401 fixed was at the CALL SITE, and a copy of the call site
     cannot see a change to it: verified by mutation on 2026-09-13, reverting
     `deriveOne` to pass `latestFinancials` / `latest.periodType` left all 107
     worker xbrl-ratios cases GREEN.

     So the composition is asserted HERE, through the real `processXbrlRatios`
     against the real store, on the shape prod actually has — the newest filing
     is QUARTERLY for 2,504 of 2,607 symbols, with an annual sitting right
     there.
     ────────────────────────────────────────────────────────────────────────── */

  /** A quarterly with income lines and NO balance sheet — the prod coin-flip's "no" face. */
  function quarterly(over: Partial<FilingFixture> = {}): FilingFixture {
    const periodEnd = over.periodEnd ?? utc("2025-06-30");
    return filing({
      instrumentId: "i-a",
      periodEnd,
      periodType: "QUARTERLY",
      facts: {
        family: "ind-as",
        basis: "CONSOLIDATED",
        period: {
          start: new Date(periodEnd.getTime() - 90 * 86_400_000)
            .toISOString()
            .slice(0, 10),
          end: periodEnd.toISOString().slice(0, 10),
          days: 91,
        },
        values: {
          revenueFromOperations: 250_000_000,
          profitForPeriod: 25_000_000,
          paidUpEquityShareCapital: 1_000_000,
          faceValuePerShare: 10,
        },
      },
      ...over,
    });
  }

  it("derives roe/roa/roce from the ANNUAL when the newest filing is QUARTERLY", async () => {
    // MUT: in `deriveOne`, pass `latestAnnualFinancials: undefined` to
    // `chooseRatioDerivationInputs` (the pre-MONEY-1401 call site) -> the
    // quarterly has no balance sheet, `isPlanWorthWriting` refuses the row,
    // `written` is 0 and this goes red.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [filing({ instrumentId: "i-a" }), quarterly()],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(r.result.written, 1);
    const row = store.upserts[0]!.create;
    // `roe` and `roa` only. `roce` needs EBIT and capital employed, which means
    // `profitBeforeTax` + `financeCosts` + `currentLiabilities`, and the shared
    // `filing()` fixture carries none of them — enriching it would change what
    // every other case in this file is measuring. These two are enough: both
    // are `undefined` without a balance sheet, which is the whole claim.
    for (const col of ["roe", "roa"] as const) {
      assert.equal(
        typeof row[col],
        "number",
        `${col} must come from the ANNUAL; the quarterly carries no balance sheet`,
      );
    }
  });

  it("ratiosFilingId names the ANNUAL the ratios came from, not the newest quarterly", async () => {
    // MUT: write `ratiosFilingId: latest.id` (the pre-MONEY-1401 upsert) ->
    // this goes red on the quarterly's id.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [filing({ instrumentId: "i-a" }), quarterly()],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    await run(store, { limit: 5 });
    const created = store.upserts[0]!.create;
    assert.equal(
      created["ratiosFilingId"],
      "f-i-a-2025-03-31-CONSOLIDATED",
      "the column names an XbrlFiling, and a reader joining it would be told " +
        "the wrong period",
    );
    assert.notEqual(created["ratiosFilingId"], "f-i-a-2025-06-30-CONSOLIDATED");
  });

  it("a symbol with NO annual still falls back to the newest filing", async () => {
    // The 195 instruments on prod with no annual at all: the planner's existing
    // period refusal is correct for them and must stay REACHABLE.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [quarterly()],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(r.result.staleAnnual, 0, "ABSENT is not STALE");
    assert.equal(r.result.written, 0);
    assert.equal(r.result.skippedNotWorthWriting, 1);
  });

  it("REFUSES an annual older than ANNUAL_MAX_AGE_DAYS, and says so", async () => {
    // MUT: delete the `annualRecencyVerdict(...) === "STALE"` branch from
    // `deriveOne` -> the FY2022 balance sheet is written with
    // `ratiosDerivedAt: now` beside a this-week price, and this goes red.
    //
    // NOW is 2026-08-21, so FY2022 (2022-03-31) is ~1,604 days — past the
    // 730-day bound with no ambiguity.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [
        filing({ instrumentId: "i-a", periodEnd: utc("2022-03-31") }),
        quarterly(),
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    // UNARMED, so the exclusion is not applied and the refusal is REACHABLE —
    // which is what a dry run is for. See `staleAnnualSelectable`.
    const r = await run(store, { limit: 5, apply: false });
    assert.equal(r.result.staleAnnual, 1);
    assert.equal(r.result.written, 0, "stale fundamentals must not be written");
    assert.equal(store.upserts.length, 0);
    // NAMED and COUNTED, never silent.
    assert.equal(
      r.result.skippedNotWorthWriting,
      0,
      "it is not the same thing",
    );
  });

  it("an annual it cannot DATE is refused, not derived — MONEY-1401", async () => {
    // The half of the retired `ABSENT` verdict that was a real hazard. The
    // function carefully answered `ABSENT` for an unparseable `periodEnd`, its
    // docstring warned that "a NaN compares false against every threshold,
    // which is how a missing bound reads as a satisfied one" — and then both
    // call sites branched on `=== "STALE"` alone, so the careful answer took
    // the permissive path. An undated balance sheet beside a this-week price.
    //
    // MUT: `annualRecencyVerdict`'s non-finite branch `return "STALE"` ->
    // `return "FRESH"` -> the filing is derived and `staleAnnual` reads 0.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [
        // Corrupted AFTER construction, not through the override: `filing()`
        // derives its id and its `facts.period` from `periodEnd`, so passing an
        // Invalid Date in would throw in the FIXTURE. One bad column on an
        // otherwise ordinary row is also the real shape of this.
        { ...filing({ instrumentId: "i-a" }), periodEnd: new Date("nope") },
        quarterly(),
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5, apply: false });
    assert.equal(r.result.staleAnnual, 1);
    assert.equal(r.result.written, 0);
  });

  it("does not SELECT a stale filer on an armed run — MONEY-1401 F3", async () => {
    // THE COUNTER THIS CASE USED TO ASSERT WAS THE WRONG ONE. Its predecessor's
    // comment read "the cursor still advances, or the refusal becomes
    // MONEY-1211's head-of-queue squat" and then asserted
    // `skippedNotWorthWriting === 0`, which says nothing about the cursor.
    // Measured on the committed source: `cursorStamped=0 cursorUnstampable=1`.
    // The refusal WAS the squat, and the test that named it passed.
    //
    // MUT: delete `staleAnnualExclusion` from the candidate query (or flip
    // `staleAnnualSelectable` to `true`) -> AAA is selected on all three nights,
    // BBB never, `written` 0/0/0.
    const store = emptyStore({
      instruments: [
        { id: "i-a", symbol: "AAA", exchange: "NSE" },
        { id: "i-b", symbol: "BBB", exchange: "NSE" },
      ],
      filings: [
        filing({ instrumentId: "i-a", periodEnd: utc("2022-03-31") }),
        // AAA is the F10 shape exactly: it stopped filing ANNUALS and kept
        // filing quarterlies. Load-bearing, not scenery — without a RECENT
        // non-annual filing on the stale instrument, dropping `periodType`
        // from the exclusion's `some` (so any recent filing satisfies it)
        // still withdraws AAA and the mutation survives.
        quarterly(),
        filing({ instrumentId: "i-b" }),
      ],
      prices: [...closes("i-a"), ...closes("i-b")],
      indexCloses: indexSeries(),
    });

    // `limit: 1` is the whole point: one slot, and the stale filer is the one
    // `rankRatiosTargets` puts first (neither has a `stock_ratios` row, so both
    // are rank 1 and `symbol asc` breaks the tie in AAA's favour).
    const n1 = await run(store, { limit: 1 });
    assert.deepEqual(
      n1.selected,
      ["BBB"],
      "the stale filer must not be picked",
    );
    assert.equal(n1.result.written, 1);
    assert.equal(n1.result.staleAnnual, 0, "withdrawn, not refused");
    assert.equal(n1.result.cursorUnstampable, 0);

    // And the rotation still turns: BBB now has a marker, and the only other
    // candidate is withdrawn, so night 2 reaches BBB again rather than stalling.
    const n2 = await run(store, { limit: 1 });
    assert.deepEqual(n2.selected, ["BBB"]);
    assert.equal(n2.result.written, 1);
  });

  it("a fresh annual beside an ancient one is NOT withdrawn", async () => {
    // The other half of the bound, at the QUERY layer. Without it the exclusion
    // could be satisfied by withdrawing every filer that has ever filed an old
    // annual — which is every filer alive. Prisma's `some` requires ONE filing
    // to satisfy EVERY field of the clause, and a fake that checked the two
    // fields independently would pass this while the real query failed it.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [
        filing({ instrumentId: "i-a", periodEnd: utc("2022-03-31") }),
        filing({ instrumentId: "i-a", periodEnd: day(700) }),
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.deepEqual(r.selected, ["AAA"]);
    assert.equal(r.result.written, 1);
  });

  it("a filer with NO annual at all is NOT withdrawn", async () => {
    // The second arm of `staleAnnualExclusion`, and it is load-bearing: a
    // symbol that never filed an annual derives from the newest filing and CAN
    // be written from three quarterly margins, so "has a fresh annual" alone
    // would withdraw a cohort that still earns its slot.
    //
    // MUT: drop the `{ xbrlFilings: { none: { periodType: "ANNUAL" } } }` arm
    // -> AAA is never selected and `selected` is [].
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [quarterly()],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.deepEqual(r.selected, ["AAA"]);
  });

  it("ACCEPTS an annual just inside the bound", async () => {
    // The other half. Without it the bound could be satisfied by refusing
    // everything — the failure mode of every threshold.
    //
    // NOW - 700 days = 2024-09-20, comfortably inside 730.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [
        filing({ instrumentId: "i-a", periodEnd: day(700) }),
        quarterly(),
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(r.result.staleAnnual, 0);
    assert.equal(r.result.written, 1);
  });
});

describe("the exchange interlock — MONEY-1299", () => {
  /* ──────────────────────────────────────────────────────────────────────────
     `stock_ratios` is @@unique([symbol, exchange]) and this job keys its upsert
     on the INSTRUMENT's exchange, while the filings it derives from carry their
     own. On prod those disagree far more often than not: measured 2026-08-31,
     2,169 of the 2,763 selectable instruments are the company's BSE row, while
     `xbrl_filings.exchange` is "NSE" on all 108,022 filings — the unordered
     `findFirst` over an ISIN that 2,155 dual listings share.

     Writing anyway does not collide and does not error. It CREATES A SECOND ROW
     per company, (SYMBOL,"BSE") beside the incumbent (SYMBOL,"NSE"), and every
     reader asking for the NSE listing keeps the stale vendor row forever. With
     no `source` in the key, the gate that would catch it can never again
     produce arming evidence. A one-way door.
     ────────────────────────────────────────────────────────────────────────── */

  it("REFUSES to write when the filing and the instrument name different exchanges", async () => {
    // THE TWO GUARDS ARE DIFFERENT QUESTIONS, and this fixture is what makes
    // that visible — MONEY-1401 F22. `XBRL_ARM_WHERE` is an EXISTENCE test
    // ("does this instrument have ANY filing on its own exchange?"); the
    // write-time interlock is about the NEWEST filing. So the reachable state
    // for the interlock is an instrument that HAS an own-exchange filing and
    // whose newest one names the other exchange — which is precisely the
    // MONEY-1299 mis-resolution, where `resolveInstrumentId`'s unordered
    // `findFirst` over a shared ISIN splits one company's filings across both
    // of its instrument rows over time.
    //
    // Before MONEY-1401's fake honoured `where.OR`, this case reached the
    // interlock with NO own-exchange filing at all — a state the production
    // query has refused to select since MONEY-1396, so the test was exercising
    // the guard through a door that is nailed shut.
    const store = emptyStore({
      // The instrument is the company's BSE row — the mis-resolution.
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "BSE" }],
      filings: [
        // An older filing on its OWN exchange: this is what makes the
        // instrument selectable at all.
        filing({
          instrumentId: "i-a",
          exchange: "BSE",
          periodEnd: utc("2024-03-31"),
        }),
        // …and the NEWEST one landed on the other exchange's row.
        filing({ instrumentId: "i-a", exchange: "NSE" }),
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(
      r.result.selected,
      1,
      "premise: the instrument must be SELECTED, or this proves nothing",
    );
    assert.equal(
      r.result.written,
      0,
      "wrote a ratios row keyed to an exchange the filing does not name",
    );
    assert.equal(r.result.skippedExchangeMismatch, 1);
  });

  it("an instrument with NO filing on its own exchange is never SELECTED", async () => {
    // MONEY-1396's narrowing, asserted against the real query for the first
    // time — MONEY-1401 F22.
    //
    // MUT: delete `XBRL_ARM_WHERE` from the candidate query's `OR` (or spread
    // it into `AND`) -> `selected` becomes 1 and `skippedExchangeMismatch` 1,
    // and this goes red. Verified 2026-09-13 that WITHOUT this case the whole
    // deletion left every xbrl-ratios suite in both workspaces green.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "BSE" }],
      filings: [filing({ instrumentId: "i-a", exchange: "NSE" })],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(
      r.result.selected,
      0,
      "an unstampable instrument must not consume a slot — MONEY-1211 " +
        "through a fourth door",
    );
    assert.equal(r.result.skippedExchangeMismatch, 0);
    assert.equal(r.result.written, 0);
  });

  it("the DOC arm does not re-open the squat the filing arm just closed", async () => {
    // MONEY-1401 F22. `DOC_ARM_WHERE` carries `xbrlFilings: { none: {} }`
    // because `deriveFromExtracts` is reachable ONLY when the instrument has no
    // filing at all. Without it, an instrument with an EXTRACTED annual AND a
    // wrong-exchange filing is selected, refused at the write, and left
    // unstampable — 19 instruments on prod 2026-09-13.
    //
    // MUT: drop `xbrlFilings: { none: {} }` from `DOC_ARM_WHERE` -> `selected`
    // becomes 1 and this goes red.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "BSE" }],
      filings: [filing({ instrumentId: "i-a", exchange: "NSE" })],
      extracts: [
        { instrumentId: "i-a", status: "EXTRACTED", periodType: "ANNUAL" },
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5, docApply: true });
    assert.equal(
      r.result.selected,
      0,
      "the extract clause re-admitted an instrument the filing arm excluded",
    );
  });

  it("the DOC arm still selects an instrument with NO filing at all, AND derives it", async () => {
    // The other half: `xbrlFilings: { none: {} }` must narrow the SQUAT and not
    // the cohort the doc arm exists for (3,371 instruments on prod).
    //
    // MUT: change `none` to `some` -> `selected` becomes 0 and this goes red.
    //
    // THE EXTRACT IS COMPLETE, and that is the point. This case used to seed a
    // three-field extract and assert `selected` alone. The fake had no
    // `documentFinancialExtract` model, so `deriveFromExtracts` threw a
    // TypeError, the derive loop's catch counted it a failed INSTRUMENT, and the
    // assertion passed regardless — measured `selected=1 failed=1 written=0`.
    // Selection was all it could ever observe, so the doc arm's WRITE path was
    // untested here while looking covered.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [],
      extracts: [
        {
          instrumentId: "i-a",
          status: "EXTRACTED",
          periodType: "ANNUAL",
          periodEnd: new Date(Date.UTC(2026, 2, 31)),
          basis: "CONSOLIDATED",
          revenueFromOperations: 1_000,
          otherIncome: 20,
          operatingIncomeExOtherIncome: 150,
          ebitdaBeforeExceptionalItems: 200,
          netIncome: 100,
          totalAssets: 2_000,
          totalLiabilities: 1_200,
          totalEquity: 800,
          totalDebt: 500,
          totalCash: 120,
          eps: 10,
          faceValue: 2,
          paidUpCapital: 20,
        },
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5, docApply: true });
    assert.equal(r.result.selected, 1);

    // NOTHING MAY THROW. A TypeError and a malformed filing land in the SAME
    // bucket here (`failed++`, `cursorUnstampable++`), so a programming error
    // inside the doc arm is indistinguishable from one bad instrument — which
    // is exactly how this gap survived.
    // MUT: delete the `documentFinancialExtract` model from `fakePrisma` -> RED.
    assert.equal(
      r.result.failed,
      0,
      "the doc arm threw; a throw here is counted as a data failure and is " +
        "indistinguishable from a malformed extract",
    );

    // And it must actually WRITE — otherwise this is still a selection test
    // wearing a derive test's name.
    // MUT: make `deriveFromExtracts` return without upserting -> RED.
    assert.equal(
      r.result.written,
      1,
      "the doc arm selected but stored nothing",
    );
    assert.equal(store.upserts.length, 1);
    assert.equal(store.upserts[0]?.create.symbol, "AAA");
  });

  it("WRITES when they agree", async () => {
    // The other half — without this the guard could be satisfied by refusing
    // everything, which is the failure mode of every interlock.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "NSE" }],
      filings: [filing({ instrumentId: "i-a", exchange: "NSE" })],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(r.result.written, 1);
    assert.equal(r.result.skippedExchangeMismatch, 0);
  });

  it("a filing carrying NO exchange cannot compare, and does not block", async () => {
    // Absent is "cannot compare", never "refuse". A caller or fixture that
    // omits the column must degrade to the previous behaviour rather than
    // silently blocking every write in the job.
    const store = emptyStore({
      instruments: [{ id: "i-a", symbol: "AAA", exchange: "BSE" }],
      filings: [
        // Selectable through its own exchange, as above.
        filing({
          instrumentId: "i-a",
          exchange: "BSE",
          periodEnd: utc("2024-03-31"),
        }),
        // The NEWEST one omits the column entirely.
        filing({ instrumentId: "i-a", exchange: undefined }),
      ],
      prices: [...closes("i-a")],
      indexCloses: indexSeries(),
    });

    const r = await run(store, { limit: 5 });
    assert.equal(r.result.selected, 1, "premise: it must be selected");
    assert.equal(r.result.written, 1);
    assert.equal(r.result.skippedExchangeMismatch, 0);
  });
});
