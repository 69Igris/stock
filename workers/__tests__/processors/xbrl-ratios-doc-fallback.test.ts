/**
 * MONEY-1346 — ratios for the 1,248 symbols that have NO XBRL FILING.
 *
 * ## The defect, measured
 *
 * Prod 2026-09-05: **1,248 Indian symbols hold `EXTRACTED` ANNUAL rows in
 * `document_financial_extracts`, hold no XBRL filing, and hold ZERO
 * `stock_ratios` rows.** The candidate query selected
 * `xbrlFilings: { some: {} }`, so those companies were never WRITTEN and never
 * CONSIDERED — no P/E, no ROE, no margin, and no counter naming the shortfall.
 *
 * ## What these tests hold down
 *
 *   1. **The population.** An instrument reachable ONLY through extracts is
 *      selected, derived and written. The mutation is removing the second arm of
 *      the candidate `OR`.
 *   2. **The ordering.** An XBRL filer must NEVER reach the fallback, so a
 *      model's reading of a PDF can never stand in for the company's own filing.
 *      Asserted by SPYING on the extract query — a source assertion cannot tell
 *      "never called" from "called and ignored".
 *   3. **Authority.** `DOC_PDF` ranks below `NSE_XBRL`, so a fallback write
 *      against an XBRL-derived incumbent is REFUSED and COUNTED.
 *   4. **No TTM.** Extract rows carry no `cumulative` flag, so `deriveTtm`'s
 *      whole refusal reason — a YTD column consuming a quarter's slot — cannot
 *      be checked. The path must therefore read no quarterly rows at all.
 *   5. **The arm.** `DOC_RATIOS_APPLY` gates the write; `XBRL_RATIOS_APPLY` must
 *      not arm it and must not disarm it.
 *
 * The processor runs FOR REAL against an in-memory store, because the failure
 * mode being guarded is a query that returns the wrong rows — which no amount of
 * pure-function testing can see.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { processXbrlRatios } from "../../src/processors/xbrl-ratios";
import { ANNUAL_EXTRACT_ROWS_TAKE } from "../../src/processors/xbrl-ratios-logic";

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-21T00:00:00.000Z");
const day = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

const FY25 = new Date("2025-03-31T00:00:00.000Z");
const FY24 = new Date("2024-03-31T00:00:00.000Z");

/**
 * One ANNUAL extract row, in CRORES exactly as `document_financial_extracts`
 * stores them. Every derived figure below is hand-computed from these:
 *
 *   netMargin   100/1,000                    = 10%
 *   opMargin    150/1,000                    = 15%
 *   ebitdaMgn   200/1,000                    = 20%
 *   shares      ₹100 Cr paid-up / ₹10 face   = 10,00,00,000
 *   marketCap   250 x 1e8                    = ₹2,500 Cr
 *   pe          250 / 10                     = 25
 *   pb          250 / (1,000 Cr / 1e8)       = 2.5
 *   roe         100 / 1,000                  = 10%
 *   roa         100 / 2,000                  = 5%
 */
function extract(over: Partial<Row> = {}): Row {
  return {
    periodEnd: FY25,
    periodType: "ANNUAL",
    status: "EXTRACTED",
    basis: "CONSOLIDATED",
    revenueFromOperations: 1_000,
    otherIncome: 20,
    operatingIncomeExOtherIncome: 150,
    ebitdaBeforeExceptionalItems: 200,
    netIncome: 100,
    totalAssets: 2_000,
    totalLiabilities: 1_000,
    totalEquity: 1_000,
    totalDebt: 300,
    totalCash: 50,
    eps: 10,
    faceValue: 10,
    paidUpCapital: 100,
    ...over,
  };
}

/** The prior fiscal year, same balances so the averaged returns are exact. */
function priorExtract(): Row {
  return extract({
    periodEnd: FY24,
    revenueFromOperations: 900,
    netIncome: 80,
  });
}

/** An XBRL filing rich enough to clear `isPlanWorthWriting` — the ordering case. */
function filing(): Row {
  const revenue = 1_000_000_000;
  return {
    id: "f-1",
    instrumentId: "i-a",
    periodEnd: FY25,
    periodType: "ANNUAL",
    cumulative: false,
    exchange: "BSE",
    basis: "CONSOLIDATED",
    coverage: 0.8,
    filedAt: new Date(FY25.getTime() + 60 * 86_400_000),
    sourceUrl: "https://nse/CONSOLIDATED.xml",
    facts: {
      family: "ind-as",
      basis: "CONSOLIDATED",
      period: { start: "2024-04-01", end: "2025-03-31", days: 365 },
      values: {
        revenueFromOperations: revenue,
        profitForPeriod: revenue * 0.1,
        totalAssets: revenue * 2,
        totalEquity: revenue,
        paidUpEquityShareCapital: revenue / 1_000,
        faceValuePerShare: 10,
      },
    },
  };
}

interface Store {
  ratios: Row[];
  filings: Row[];
  extracts: Row[];
  upserts: Array<{ create: Row; update: Row }>;
  cursorStamps: number;
  /** Every `where` the extract query was issued with — the ordering spy. */
  extractQueries: Row[];
  extractTakes: Array<number | undefined>;
}

function emptyStore(over: Partial<Store> = {}): Store {
  return {
    ratios: [],
    filings: [],
    extracts: [extract(), priorExtract()],
    upserts: [],
    cursorStamps: 0,
    extractQueries: [],
    extractTakes: [],
    ...over,
  };
}

/**
 * A BSE-only instrument — the shape of the cohort. `exchange: "BSE"` is not
 * decoration: the XBRL path's exchange interlock refuses a filing whose
 * exchange disagrees, and the fallback has no filing to disagree with.
 */
function fakePrisma(store: Store) {
  const instrument = { id: "i-a", symbol: "AAA", exchange: "BSE" };
  const prices = Array.from({ length: 501 }, (_, k) => ({
    date: day(1 + (500 - k)),
    close: 250,
  }));
  const indexCloses = prices.map((p) => ({ date: p.date, close: 20_000 }));
  return {
    instrumentMapping: {
      // The `where` is EVALUATED, not ignored.
      //
      // A fake that returns the instrument unconditionally cannot see the one
      // defect this file exists for: dropping the `documentFinancialExtracts`
      // arm from the candidate `OR` leaves every value assertion below green
      // while the 1,248-symbol cohort is unreachable again. Verified by
      // mutation — with a fixed return, that change was invisible.
      findMany: async (args: { where: { OR?: Row[] } }) => {
        const arms = args.where.OR ?? [];
        const hasFilingArm = arms.some((a) => "xbrlFilings" in a);
        const hasExtractArm = arms.some(
          (a) => "documentFinancialExtracts" in a,
        );
        const matches =
          (hasFilingArm && store.filings.length > 0) ||
          (hasExtractArm &&
            store.extracts.some(
              (e) => e.periodType === "ANNUAL" && e.status === "EXTRACTED",
            ));
        return matches ? [instrument] : [];
      },
    },
    stockRatios: {
      findMany: async () =>
        store.ratios.map((r) => ({
          symbol: r.symbol,
          exchange: r.exchange,
          ratiosDerivedAt: (r.ratiosDerivedAt as Date | undefined) ?? null,
        })),
      findUnique: async () => store.ratios[0] ?? null,
      upsert: async (args: { create: Row; update: Row }) => {
        store.upserts.push({ create: args.create, update: args.update });
        return {};
      },
      updateMany: async () => {
        store.cursorStamps++;
        return { count: store.ratios.length > 0 ? 1 : 0 };
      },
    },
    xbrlFiling: { findMany: async () => store.filings },
    documentFinancialExtract: {
      findMany: async (args: { where: Row; take?: number }) => {
        store.extractQueries.push(args.where);
        store.extractTakes.push(args.take);
        return store.extracts;
      },
    },
    dailyPrice: { findMany: async () => prices },
    indexClose: { findMany: async () => indexCloses },
    corporateAction: { findMany: async () => [] },
  } as never;
}

const ENV_KEYS = ["DOC_RATIOS_APPLY", "XBRL_RATIOS_APPLY"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

const run = async (store: Store) =>
  processXbrlRatios({ limit: 1 }, { prisma: fakePrisma(store), now: NOW });

/* -------------------------------------------------------------------------- */
/* 1 — the population that could not previously be reached                    */
/* -------------------------------------------------------------------------- */

describe("a BSE-only instrument with NO filing now gets real ratios", () => {
  it("writes pe, pb, roe, roa and the margins, at the hand-computed values", async () => {
    // MUTATION TARGET: drop the `documentFinancialExtracts` arm from the
    // candidate `OR` and this instrument is not selected at all — selected 0,
    // written 0, and the run reports itself perfectly healthy.
    setEnv({ DOC_RATIOS_APPLY: "true", XBRL_RATIOS_APPLY: "false" });
    const store = emptyStore();
    const result = await run(store);

    assert.equal(result.selected, 1, "the instrument must be a CANDIDATE");
    assert.equal(result.written, 1);
    assert.equal(result.fallbackExtracts, 1);
    assert.equal(result.noInputs, 0, "it must not fall through to no-inputs");

    const set = store.upserts[0]!.create;
    assert.equal(
      set.source,
      "DOC_PDF",
      "provenance is the reading, not a filing",
    );
    assert.equal(set.pe, 25);
    assert.equal(set.pb, 2.5);
    assert.equal(set.roe, 10);
    assert.equal(set.roa, 5);
    assert.equal(set.netMargin, 10);
    assert.equal(set.operatingMargin, 15);
    assert.equal(set.ebitdaMargin, 20);
    assert.equal(set.marketCap, 2_500);
    assert.equal(set.enterpriseValue, 2_750, "2,500 + 300 debt − 50 cash");
    assert.equal(set.returnBasis, "AVERAGE");
  });

  it("does NOT claim a filing id it does not have", async () => {
    // `ratiosFilingId` is `@db.ObjectId` and an extract id would FIT it. A
    // reader joining it to `xbrl_filings` would find nothing while the row
    // looked fully attributed.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore();
    await run(store);
    assert.equal("ratiosFilingId" in store.upserts[0]!.create, false);
    assert.equal("ratiosFilingId" in store.upserts[0]!.update, false);
  });

  it("stamps the rotation cursor, so tomorrow's run moves on", async () => {
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore();
    const result = await run(store);
    assert.equal(result.cursorStamped, 1);
    assert.ok(store.upserts[0]!.create.ratiosDerivedAt instanceof Date);
  });

  it("counts an instrument whose extracts yield no usable period", async () => {
    // Selected by the candidate query (a `status:EXTRACTED, periodType:ANNUAL`
    // row exists) and then unusable at derivation, because the stored
    // `periodEnd` will not parse. A separate counter from an authority block on
    // purpose: this one is a data problem, that one is a provenance decision,
    // and folding them together hides which of the two is growing.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore({
      extracts: [extract({ periodEnd: new Date("not-a-date") })],
    });
    const result = await run(store);
    assert.equal(result.selected, 1, "premise: it must still be a candidate");
    assert.equal(result.fallbackNoAnnualExtract, 1);
    assert.equal(result.fallbackExtracts, 0);
    assert.equal(result.noInputs, 1);
    assert.equal(store.upserts.length, 0);
  });

  it("REFUSES an extract cohort whose newest ANNUAL is years old — F10", async () => {
    // MONEY-1401 F8b review, MEDIUM-6. The F10 recency bound was wired at ONE
    // of TWO write arms: `deriveOne` refuses a filer whose newest ANNUAL is
    // past `ANNUAL_MAX_AGE_DAYS`, while this arm queried
    // `{instrumentId, status:"EXTRACTED", periodType:"ANNUAL"}` with NO
    // `periodEnd` filter and never asked. So a FY2018 balance sheet was derived
    // and stamped with a THIS-WEEK `ratiosPriceDate` — the exact hazard F10
    // names, in the sibling arm its own comment points at.
    //
    // `staleAnnualExclusion` cannot cover it: that predicate reads
    // `xbrlFilings`, and `DOC_ARM_WHERE` requires `xbrlFilings: {none:{}}`, so
    // every instrument reaching here satisfies its "no annual filing at all"
    // arm and is selected whatever its extracts say. 3,371 on prod.
    //
    // MUTATION: delete the `annualRecencyVerdict` branch from
    // `deriveFromExtracts` -> written 1, `staleAnnual` 0, and a seven-year-old
    // balance sheet in `stock_ratios`.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore({
      extracts: [extract({ periodEnd: new Date("2018-03-31T00:00:00.000Z") })],
    });
    const result = await run(store);
    assert.equal(result.selected, 1, "premise: it must still be a candidate");
    assert.equal(result.staleAnnual, 1);
    assert.equal(result.written, 0);
    assert.equal(store.upserts.length, 0, "nothing may be stored");
    // The cursor still advances, so the refusal does not squat at the head of
    // the rotation — the `deriveOne` branch's discipline, applied here too.
    assert.equal(result.fallbackExtracts, 1, "it DID take the extracts arm");
  });

  it("still WRITES an annual inside the bound", async () => {
    // The falsifier. Without it, a refusal that fired unconditionally would
    // satisfy the case above — and the default fixture's FY25 is only ~508 days
    // old at the harness clock, so the boundary is genuinely exercised.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore();
    const result = await run(store);
    assert.equal(result.staleAnnual, 0);
    assert.equal(result.written, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* 2 — an XBRL filer must never reach the fallback                            */
/* -------------------------------------------------------------------------- */

describe("the fallback runs ONLY when there are zero XBRL filings", () => {
  it("an instrument WITH a filing never issues the extract query", async () => {
    // MUTATION TARGET: move the fallback above the `recentFilings.length === 0`
    // guard — or read extracts unconditionally — and this spy goes to 1 while
    // every value assertion in this file still passes.
    setEnv({ DOC_RATIOS_APPLY: "true", XBRL_RATIOS_APPLY: "true" });
    const store = emptyStore({ filings: [filing()] });
    const result = await run(store);

    assert.deepEqual(
      store.extractQueries,
      [],
      "a company that filed XBRL must never be derived from a PDF reading",
    );
    assert.equal(result.fallbackExtracts, 0);
    assert.equal(result.written, 1);
    assert.equal(
      store.upserts[0]!.create.source,
      "NSE_XBRL",
      "the filing path keeps its own provenance",
    );
  });

  it("the query's take is the MEASURED extract constant, not a literal", async () => {
    // MONEY-1346. `take: 8` was a ROW count over a table where the measured
    // worst case is FOUR rows per (instrument, periodEnd) — two bases from two
    // documents, because an annual report reprints the prior year — so it
    // could deliver as few as two distinct periods and put both 5Y CAGR
    // columns out of reach. The arithmetic and the corpus depth that bounds it
    // are on `ANNUAL_EXTRACT_ROWS_TAKE`; this asserts the query USES it.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore();
    await run(store);
    assert.equal(store.extractTakes.length, 1);
    assert.equal(store.extractTakes[0], ANNUAL_EXTRACT_ROWS_TAKE);
  });

  it("the extract query asks for EXTRACTED + ANNUAL only", async () => {
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore();
    await run(store);
    assert.equal(store.extractQueries.length, 1);
    assert.deepEqual(store.extractQueries[0], {
      instrumentId: "i-a",
      status: "EXTRACTED",
      periodType: "ANNUAL",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — authority: a reading of a filing never displaces the filing            */
/* -------------------------------------------------------------------------- */

describe("DOC_PDF may not overwrite an NSE_XBRL row", () => {
  it("refuses the write and COUNTS the refusal", async () => {
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore({
      ratios: [{ symbol: "AAA", exchange: "BSE", source: "NSE_XBRL" }],
    });
    const result = await run(store);

    assert.equal(store.upserts.length, 0, "nothing may be written");
    assert.equal(result.fallbackAuthorityBlocked, 1);
    assert.equal(
      result.cursorUnstampable,
      1,
      "and the cursor does not advance",
    );
    assert.equal(store.cursorStamps, 0);
  });

  it("but DOES displace a lower-ranked vendor row", async () => {
    // The rank table is the whole decision: TICKERTAPE sits BELOW DOC_PDF, so
    // this must proceed. A guard hard-coded to "refuse unless the row is empty"
    // would pass the case above and fail this one.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore({
      ratios: [{ symbol: "AAA", exchange: "BSE", source: "TICKERTAPE" }],
    });
    const result = await run(store);
    assert.equal(result.fallbackAuthorityBlocked, 0);
    assert.equal(store.upserts.length, 1);
    assert.equal(store.upserts[0]!.update.source, "DOC_PDF");
    // MONEY-1346 — and it SAYS SO. The third flag is armed on the measured
    // claim "this cohort has no incumbent row, so every write is a pure
    // CREATE" (0 of 1,241 on prod 2026-09-05). That is a fact about the DATA;
    // the candidate query does not enforce it. This counter is the falsifiable
    // form of the claim, so a displacement can never again be invisible.
    assert.equal(
      result.docDisplacedIncumbent,
      1,
      "displacing a vendor row is allowed and must be COUNTED",
    );
  });

  it("counts NO displacement when the row is genuinely new", async () => {
    // The other half, and the one that makes the counter falsifiable: a
    // mutation hard-coding `docDisplacedIncumbent: true` passes the test above
    // and fails here.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore();
    const result = await run(store);
    assert.equal(store.upserts.length, 1);
    assert.equal(result.docDisplacedIncumbent, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4 — no TTM is attempted on this path                                       */
/* -------------------------------------------------------------------------- */

describe("the fallback forms no TTM", () => {
  it("reports NO ttm refusal, even with a quarterly extract row present", async () => {
    // Extract rows carry no `cumulative` flag, so `deriveTtm`'s refusal — a YTD
    // column summed beside three discrete quarters — is uncheckable here. The
    // path therefore reads no quarterly rows: the query is ANNUAL-only, and the
    // refusal counters stay at zero rather than being filled with a bucket that
    // sizes why the XBRL half's `pe` is null.
    setEnv({ DOC_RATIOS_APPLY: "true" });
    const store = emptyStore({
      extracts: [
        extract(),
        priorExtract(),
        extract({
          periodType: "QUARTERLY",
          periodEnd: new Date("2025-06-30T00:00:00.000Z"),
        }),
      ],
    });
    const result = await run(store);

    for (const [reason, count] of Object.entries(result.ttmRefusals)) {
      assert.equal(count, 0, `no TTM should be attempted, got ${reason}`);
    }
    assert.equal(result.ttmBasisFallback, 0);
    // `pe` still lands — from the ANNUAL row's OWN printed EPS, which is one
    // twelve-month figure rather than a sum of four whose contiguity nobody
    // checked.
    assert.equal(store.upserts[0]!.create.pe, 25);
  });
});

/* -------------------------------------------------------------------------- */
/* 5 — the arm                                                                 */
/* -------------------------------------------------------------------------- */

describe("DOC_RATIOS_APPLY gates the fallback write, and nothing else does", () => {
  it("WITHDRAWS the cohort when XBRL is armed and the doc arm is not", async () => {
    // ── THE STARVATION STATE — MONEY-1346 ─────────────────────────────────
    //
    // This used to assert the opposite: that the cohort was still SELECTED
    // and reported as a rehearsal. It cannot be, and the reason is the
    // rotation rather than the write.
    //
    // The extract-only cohort holds ZERO `stock_ratios` rows (1,241 of 1,241
    // on prod 2026-09-05), so `rankRatiosTargets` puts every one of them in
    // rank 1 — NEVER DERIVED sorts first. Unarmed, every path through
    // `deriveFromExtracts` returns `cursor: "dry-run"`, and the two that would
    // stamp use `updateMany`, which matches nothing when there is no row. So
    // they cannot leave rank 1, and 1,241 exceeds `DEFAULT_RATIOS_LIMIT`
    // (1,000): armed XBRL beside an unarmed doc arm would spend every slot,
    // every night, on rows it refuses to write, and no XBRL instrument would
    // ever be derived again. MONEY-1211's head-of-queue squat, fourth door.
    //
    // MUTATION TARGET: make the candidate `OR` unconditional again and this
    // goes green while the rotation is dead.
    setEnv({ DOC_RATIOS_APPLY: "false", XBRL_RATIOS_APPLY: "true" });
    const store = emptyStore();
    const result = await run(store);
    assert.equal(store.upserts.length, 0, "a dry run must mutate nothing");
    assert.equal(store.cursorStamps, 0);
    assert.equal(
      result.selected,
      0,
      "the cohort must not occupy a slot it can never vacate",
    );
    assert.equal(result.fallbackExtracts, 0);
    assert.equal(result.written, 0);
  });

  it("keeps the whole-population rehearsal, with the XBRL half also unarmed", async () => {
    // The rehearsal the test above used to carry, moved to the state where it
    // costs nothing: with `apply` false there is no live rotation to starve,
    // so the arm can be selected and REPORT what it would write. That is what
    // a pilot runs before anyone arms anything.
    //
    // MUTATION TARGET: gating the arm on `docApply` ALONE (rather than
    // `docApply || !apply`) makes the doc arm unrehearsable and this red.
    setEnv({ DOC_RATIOS_APPLY: "false", XBRL_RATIOS_APPLY: "false" });
    const store = emptyStore();
    const result = await run(store);
    assert.equal(store.upserts.length, 0, "a dry run must mutate nothing");
    assert.equal(store.cursorStamps, 0);
    assert.equal(result.selected, 1);
    assert.equal(result.written, 1, "it still reports what would land");
    assert.equal(result.fallbackExtracts, 1);
  });

  it("WRITES when only the DOC flag is armed", async () => {
    setEnv({ DOC_RATIOS_APPLY: "true", XBRL_RATIOS_APPLY: "false" });
    const store = emptyStore();
    await run(store);
    assert.equal(store.upserts.length, 1);
  });

  it("an ABSENT flag is off", async () => {
    setEnv({ DOC_RATIOS_APPLY: undefined, XBRL_RATIOS_APPLY: undefined });
    const store = emptyStore();
    await run(store);
    assert.equal(store.upserts.length, 0);
  });

  it("a truthy-but-not-'true' value is off", async () => {
    // MUTATION TARGET: `Boolean(env.DOC_RATIOS_APPLY)` arms the job in exactly
    // the configuration that ships today.
    for (const value of ["false", "1", "TRUE", "yes"]) {
      setEnv({ DOC_RATIOS_APPLY: value });
      const store = emptyStore();
      await run(store);
      assert.equal(store.upserts.length, 0, `${value} must not arm the write`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6 — the counters reach the outcome line                                    */
/* -------------------------------------------------------------------------- */

describe("the three fallback counters are reported, not just returned", () => {
  it("rides the reason string as key=value pairs", async () => {
    // `reportJobOutcome` has no extras field, so a counter that never reaches
    // `skippedReason` is a counter nobody can read from a log.
    const src = (await import("node:fs")).readFileSync(
      new URL("../../src/processors/xbrl-ratios.ts", import.meta.url),
      "utf8",
    );
    for (const key of [
      "fallback:extracts=",
      "fallback:noAnnualExtract=",
      "fallback:authorityBlocked=",
    ]) {
      assert.ok(src.includes(key), `${key} must appear in the outcome line`);
    }
  });
});
