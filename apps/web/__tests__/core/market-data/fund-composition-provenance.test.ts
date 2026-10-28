/**
 * MONEY-1205 — fund-composition provenance: CONTENT staleness, the persist
 * gate, and the retry/lock brakes. Pure + on the LIVE service.
 *
 * ## The defect this pins
 *
 * The ETF page footer read "StockSage-extracted from public disclosures. Data
 * as of 2024-05. Confidence: 95%." Both numbers were whatever Gemini claimed,
 * written verbatim by `persistComposition` and printed as provenance.
 *
 * Measured on prod 2026-08-18: ALL 111 `fund_composition_meta` rows carry
 * `dataAsOf` in {2024-04 (30), 2024-05 (80), 2024-06 (1)} — 26-28 months behind
 * — while `extractedAt` spans 2026-02-28 to 2026-08-18, and `confidence` sits
 * at 0.95-0.99 on every one of them. Six months of re-extraction moved the
 * clock and never moved the content.
 *
 * Freshness was gated on `extractedAt` (90 days), which is the wrong field and
 * can NEVER fire: each re-extraction re-stamps `extractedAt = now` and re-arms
 * a fresh window around identical stale content.
 *
 * ## Two layers, both NO-SHADOW
 *
 *  A. PURE — the REAL exports from
 *     `packages/core/src/market-data/instruments/fund-composition-logic.ts`
 *     (`isCompositionContentStale`, `decideCompositionPersist`,
 *     `isFailedRetryDue`, `isExtractionLockHeld`, `monthsBehindNow`,
 *     `parseDisclosureMonth`), imported by relative path. The service calls
 *     these same functions.
 *
 *  B. LIVE — the REAL `fund-composition-service.ts` (`getCompositionFromDb`,
 *     `getOrExtractComposition`, and `persistComposition` through it) driven
 *     against a RECORDING `@usemoney/database` + `gemini/models` double
 *     injected at the module boundary via `require.cache`. Same seam as
 *     `__tests__/services/fund-composition-poison-live.test.ts`. No Mongo, no
 *     Gemini, no network; exits clean.
 *
 * Every `dataAsOf` fixture is built RELATIVE to now (`monthsAgo`), so these
 * cases keep meaning the same thing next year — a hard-coded "2025-12" silently
 * ages across the threshold, which is exactly how the demo fixture rotted.
 *
 * Source: packages/core/src/market-data/instruments/fund-composition-{logic,service}.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// ── REAL pure exports (relative path — no I/O at import) ────────────────────
import {
  CONTENT_STALE_THRESHOLD_MONTHS,
  CONTENT_FUTURE_TOLERANCE_MONTHS,
  FAILED_RETRY_COOLDOWN_MS,
  EXTRACTION_LOCK_MS,
  parseDisclosureMonth,
  monthsBehindNow,
  isCompositionContentStale,
  shouldServeComposition,
  contentStaleReason,
  decideCompositionPersist,
  isFailedRetryDue,
  isExtractionLockHeld,
  isCompositionStale,
} from "../../../../../packages/core/src/market-data/instruments/fund-composition-logic";

// ── helpers ────────────────────────────────────────────────────────────────

/** "YYYY-MM" for `n` whole months before now (UTC), so fixtures never age. */
function monthsAgo(n: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ══════════════════════════════════════════════════════════════════════════
// A. PURE — the content gate
// ══════════════════════════════════════════════════════════════════════════

describe("MONEY-1205 parseDisclosureMonth — absence is null, never a date", () => {
  it("parses the YYYY-MM the prompt asks for", () => {
    assert.deepStrictEqual(parseDisclosureMonth("2026-06"), {
      year: 2026,
      month: 6,
    });
    assert.deepStrictEqual(parseDisclosureMonth(" 2024-05 "), {
      year: 2024,
      month: 5,
    });
  });

  it("tolerates a full YYYY-MM-DD", () => {
    assert.deepStrictEqual(parseDisclosureMonth("2026-06-30"), {
      year: 2026,
      month: 6,
    });
  });

  it('"" / "-" / "N/A" / null / undefined are ABSENT, not month zero', () => {
    for (const absent of ["", "   ", "-", "N/A", "n/a", null, undefined]) {
      assert.strictEqual(
        parseDisclosureMonth(absent as string | null | undefined),
        null,
        `expected ${JSON.stringify(absent)} to parse as absent`
      );
    }
  });

  it("rejects an out-of-range or malformed month", () => {
    for (const bad of ["2026-13", "2026-00", "2026", "June 2026", "26-06"]) {
      assert.strictEqual(parseDisclosureMonth(bad), null, bad);
    }
  });

  it("rejects a non-string (a Date, a number) rather than coercing it", () => {
    assert.strictEqual(
      parseDisclosureMonth(new Date() as unknown as string),
      null
    );
    assert.strictEqual(parseDisclosureMonth(202606 as unknown as string), null);
  });
});

describe("MONEY-1205 monthsBehindNow", () => {
  const now = Date.UTC(2026, 7, 18); // 2026-08-18

  it("counts whole calendar months behind", () => {
    assert.strictEqual(monthsBehindNow("2026-08", now), 0);
    assert.strictEqual(monthsBehindNow("2026-07", now), 1);
    assert.strictEqual(monthsBehindNow("2026-02", now), 6);
    assert.strictEqual(monthsBehindNow("2025-08", now), 12);
  });

  it("reproduces the prod histogram: 2024-04/05/06 are 28/27/26 months behind", () => {
    assert.strictEqual(monthsBehindNow("2024-04", now), 28);
    assert.strictEqual(monthsBehindNow("2024-05", now), 27);
    assert.strictEqual(monthsBehindNow("2024-06", now), 26);
  });

  it("is NEGATIVE for a claimed future period", () => {
    assert.strictEqual(monthsBehindNow("2026-09", now), -1);
    assert.strictEqual(monthsBehindNow("2027-08", now), -12);
  });

  it("is null — not 0 — when there is no parseable month", () => {
    assert.strictEqual(monthsBehindNow("", now), null);
    assert.strictEqual(monthsBehindNow(null, now), null);
  });
});

describe("MONEY-1205 isCompositionContentStale — the gate the clock could never be", () => {
  const now = Date.UTC(2026, 7, 18); // 2026-08-18

  it("the threshold is 6 months (SEBI portfolio disclosures are monthly)", () => {
    assert.strictEqual(CONTENT_STALE_THRESHOLD_MONTHS, 6);
    assert.strictEqual(CONTENT_FUTURE_TOLERANCE_MONTHS, 1);
  });

  it("a current or recent disclosure month is FRESH", () => {
    assert.strictEqual(isCompositionContentStale("2026-08", now), false);
    assert.strictEqual(isCompositionContentStale("2026-07", now), false);
    assert.strictEqual(isCompositionContentStale("2026-03", now), false);
  });

  it("exactly N months behind is still fresh; N+1 is stale (boundary)", () => {
    assert.strictEqual(isCompositionContentStale("2026-02", now), false); // 6
    assert.strictEqual(isCompositionContentStale("2026-01", now), true); // 7
  });

  it("[regression] every dataAsOf actually stored on prod is STALE", () => {
    // 111/111 rows, measured 2026-08-18.
    for (const asOf of ["2024-04", "2024-05", "2024-06"]) {
      assert.strictEqual(
        isCompositionContentStale(asOf, now),
        true,
        `${asOf} must not read as fresh`
      );
    }
  });

  it("a missing/undateable period is STALE — an extraction that cannot say which disclosure it read has not read one", () => {
    for (const absent of ["", "-", "N/A", null, undefined]) {
      assert.strictEqual(
        isCompositionContentStale(absent as string | null | undefined, now),
        true,
        `expected ${JSON.stringify(absent)} to be treated as stale`
      );
    }
  });

  it("a period further ahead than the tolerance is STALE (it cannot have been published)", () => {
    assert.strictEqual(isCompositionContentStale("2026-09", now), false); // 1 ahead: month-boundary slop
    assert.strictEqual(isCompositionContentStale("2026-10", now), true); // 2 ahead
    assert.strictEqual(isCompositionContentStale("2030-01", now), true);
  });

  it("[regression] CONTENT staleness is independent of CLOCK staleness — the whole bug", () => {
    // A row extracted 1 second ago, reciting a 2024 portfolio: the clock gate
    // says fresh, the content gate says failed.
    const justExtracted = new Date(now - 1000);
    assert.strictEqual(isCompositionStale(justExtracted, now), false);
    assert.strictEqual(isCompositionContentStale("2024-05", now), true);
  });
});

describe("MONEY-1205 contentStaleReason — the row explains itself", () => {
  const now = Date.UTC(2026, 7, 18);

  it("records the claimed period and the distance", () => {
    const reason = contentStaleReason("2024-05", now);
    assert.match(reason, /2024-05/);
    assert.match(reason, /27 months behind/);
    assert.match(reason, /limit 6/);
  });

  it("names the absent case distinctly", () => {
    assert.match(contentStaleReason("", now), /no usable disclosure period/);
    assert.match(contentStaleReason(null, now), /no usable disclosure period/);
  });

  it("names the future case distinctly", () => {
    assert.match(
      contentStaleReason("2027-01", now),
      /future disclosure period .*5 month/
    );
  });
});

describe("MONEY-1205 decideCompositionPersist — a stale extraction is FAILED, not READY", () => {
  const now = Date.UTC(2026, 7, 18);

  it("a recent period stores READY with no error", () => {
    assert.deepStrictEqual(decideCompositionPersist("2026-07", now), {
      status: "READY",
      errorMessage: null,
    });
  });

  it("[regression] the exact prod payload stores FAILED with a reason", () => {
    const decision = decideCompositionPersist("2024-05", now);
    assert.strictEqual(decision.status, "FAILED");
    assert.ok(decision.errorMessage);
    assert.match(decision.errorMessage!, /2024-05/);
  });

  it("a missing period stores FAILED", () => {
    assert.strictEqual(decideCompositionPersist("", now).status, "FAILED");
    assert.strictEqual(decideCompositionPersist(null, now).status, "FAILED");
  });
});

describe("MONEY-1205 retry cooldown + extraction lock — the brakes on the runaway", () => {
  const now = Date.UTC(2026, 7, 18);

  it("the cooldown is 7 days and the lock is 5 minutes", () => {
    assert.strictEqual(FAILED_RETRY_COOLDOWN_MS, 7 * 24 * 60 * 60 * 1000);
    assert.strictEqual(EXTRACTION_LOCK_MS, 5 * 60 * 1000);
  });

  it("a fresh failure is NOT due for retry; an old one is", () => {
    assert.strictEqual(
      isFailedRetryDue(new Date(now - 60 * 1000), now),
      false,
      "a failure a minute old must not be retried on the next page view"
    );
    assert.strictEqual(
      isFailedRetryDue(new Date(now - 6 * 24 * 60 * 60 * 1000), now),
      false
    );
    assert.strictEqual(
      isFailedRetryDue(new Date(now - 8 * 24 * 60 * 60 * 1000), now),
      true
    );
  });

  it("a row with no recorded attempt time is due (fail-open on absence, not on staleness)", () => {
    assert.strictEqual(isFailedRetryDue(null, now), true);
    assert.strictEqual(isFailedRetryDue(undefined, now), true);
    assert.strictEqual(isFailedRetryDue(new Date(NaN), now), true);
  });

  it("the lock is held while an extraction is plausibly in flight, released after", () => {
    assert.strictEqual(isExtractionLockHeld(new Date(now - 1000), now), true);
    assert.strictEqual(
      isExtractionLockHeld(new Date(now - 10 * 60 * 1000), now),
      false,
      "a crashed EXTRACTING row must unblock itself"
    );
    assert.strictEqual(isExtractionLockHeld(null, now), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. LIVE service — REAL fund-composition-service.ts against a recording
//    @usemoney/database + gemini/models double injected via require.cache.
// ══════════════════════════════════════════════════════════════════════════

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const CORE_SRC = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "src"
);
const SERVICE_PATH = join(
  CORE_SRC,
  "market-data",
  "instruments",
  "fund-composition-service.ts"
);
const GEMINI_MODELS_PATH = join(CORE_SRC, "gemini", "models.ts");

interface MetaRow {
  fundType: string;
  fundId: string;
  totalHoldings: number;
  extractedAt: Date;
  updatedAt: Date;
  source: string;
  status: string;
  sectorBreakdown: unknown;
  capBreakdown: unknown;
  assetBreakdown: unknown;
  confidence: number | null;
  dataAsOf: string | null;
  errorMessage: string | null;
}

interface UpsertCall {
  status: unknown;
  errorMessage: unknown;
  dataAsOf: unknown;
  confidence: unknown;
}

interface DbRecorder {
  meta: MetaRow | null;
  holdings: Array<Record<string, unknown>>;
  metaUpserts: UpsertCall[];
  holdingDeletes: number;
  holdingCreates: number;
}

interface GeminiRecorder {
  calls: number;
  response: string;
  throws?: Error;
}

let db: DbRecorder;
let gemini: GeminiRecorder;

function freshDb(): DbRecorder {
  return {
    meta: null,
    holdings: [],
    metaUpserts: [],
    holdingDeletes: 0,
    holdingCreates: 0,
  };
}
function freshGemini(): GeminiRecorder {
  return { calls: 0, response: "" };
}

function metaRow(overrides: Partial<MetaRow> = {}): MetaRow {
  const at = new Date();
  // `as MetaRow`: spreading a Partial<> under exactOptionalPropertyTypes widens
  // every field to `| undefined`. Callers only ever pass real values.
  const base: MetaRow = {
    fundType: "ETF",
    fundId: "NIFTYBEES",
    totalHoldings: 15,
    extractedAt: at,
    updatedAt: at,
    source: "gemini",
    status: "READY",
    sectorBreakdown: [{ sector: "Financial Services", weight: 30 }],
    capBreakdown: [{ cap: "LARGE", weight: 90 }],
    assetBreakdown: [{ type: "EQUITY", weight: 98 }],
    confidence: 0.95,
    dataAsOf: monthsAgo(1),
    errorMessage: null,
  };
  return { ...base, ...overrides } as MetaRow;
}

/** A well-formed Gemini payload; `dataAsOf` is the variable under test. */
function geminiPayload(dataAsOf: string): string {
  return JSON.stringify({
    holdings: [
      {
        holdingName: "HDFC Bank Ltd",
        holdingSymbol: "HDFCBANK",
        isin: "INE040A01034",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 9.8,
      },
      {
        holdingName: "Reliance Industries Ltd",
        holdingSymbol: "RELIANCE",
        isin: "INE002A01018",
        holdingType: "EQUITY",
        sector: "Energy",
        industry: "Oil & Gas",
        marketCap: "LARGE",
        weightPercent: 8.1,
      },
    ],
    sectorBreakdown: [{ sector: "Financial Services", weight: 9.8 }],
    capBreakdown: [{ cap: "LARGE", weight: 17.9 }],
    assetBreakdown: [{ type: "EQUITY", weight: 17.9 }],
    confidence: 0.95,
    dataAsOf,
  });
}

function makePrismaStub(): Record<string, unknown> {
  return {
    __esModule: true,
    prisma: {
      fundCompositionMeta: {
        findUnique: async () => db.meta,
        upsert: async (args: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const patch = db.meta ? args.update : args.create;
          db.metaUpserts.push({
            status: patch.status,
            errorMessage: patch.errorMessage,
            dataAsOf: patch.dataAsOf,
            confidence: patch.confidence,
          });
          db.meta = { ...metaRow(), ...db.meta, ...patch } as MetaRow;
          return db.meta;
        },
      },
      fundHolding: {
        findMany: async () => db.holdings,
        deleteMany: async () => {
          db.holdingDeletes++;
          db.holdings = [];
          return { count: 0 };
        },
        createMany: async (args: { data: Array<Record<string, unknown>> }) => {
          db.holdingCreates++;
          db.holdings = args.data;
          return { count: args.data.length };
        },
      },
      mutualFundMaster: {
        findFirst: async () => ({
          schemeName: "Demo Flexi Cap Fund",
          amcName: "Demo AMC",
          category: "Equity",
        }),
      },
      instrumentMapping: {
        findFirst: async () => ({ name: "Nippon India ETF Nifty 50 BeES" }),
      },
    },
  };
}

function makeGeminiStub(): Record<string, unknown> {
  return {
    __esModule: true,
    getGeminiModel: () => ({ __model: "stub" }),
    generateWithTimeout: async () => {
      gemini.calls++;
      if (gemini.throws) throw gemini.throws;
      return gemini.response;
    },
    MODEL_CONFIG: {},
  };
}

interface ServiceModule {
  getCompositionFromDb: (
    fundType: "MF" | "ETF" | "INDEX",
    fundId: string
  ) => Promise<unknown>;
  getOrExtractComposition: (
    fundType: "MF" | "ETF" | "INDEX",
    fundId: string
  ) => Promise<unknown>;
}

let serviceSingleton: ServiceModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];
let priorWarn: typeof console.warn;
let priorError: typeof console.error;

function installService(): ServiceModule {
  if (serviceSingleton) return serviceSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), makePrismaStub());
  stub(require.resolve(GEMINI_MODELS_PATH), makeGeminiStub());
  // Force a fresh load so the service binds to the stubbed boundary.
  const servicePath = require.resolve(SERVICE_PATH);
  priorCacheEntries.push([servicePath, cache[servicePath]]);
  delete cache[servicePath];
  // The service logs a warning on every rejected extraction — expected, and
  // noise in the test output.
  priorWarn = console.warn;
  priorError = console.error;
  console.warn = () => {};
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  serviceSingleton = require(SERVICE_PATH) as ServiceModule;
  return serviceSingleton;
}

function uninstallService(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  serviceSingleton = null;
  console.warn = priorWarn;
  console.error = priorError;
}

describe("MONEY-1205 LIVE service — a content-stale row never renders as authoritative", () => {
  let svc: ServiceModule;
  before(() => {
    svc = installService();
  });
  beforeEach(() => {
    db = freshDb();
    gemini = freshGemini();
  });
  after(() => {
    uninstallService();
  });

  it("getCompositionFromDb returns a READY row whose period IS recent", async () => {
    db.meta = metaRow({ dataAsOf: monthsAgo(1) });
    db.holdings = [
      {
        holdingName: "HDFC Bank Ltd",
        holdingSymbol: "HDFCBANK",
        isin: null,
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 9.8,
      },
    ];
    const result = await svc.getCompositionFromDb("ETF", "NIFTYBEES");
    assert.ok(result, "a recent composition must still be served");
    assert.strictEqual(db.metaUpserts.length, 0, "no demotion on a fresh row");
  });

  it("[regression] getCompositionFromDb WITHHOLDS a READY row whose period is 27 months old", async () => {
    db.meta = metaRow({ dataAsOf: monthsAgo(27), status: "READY" });
    db.holdings = [{ holdingName: "HDFC Bank Ltd", weightPercent: 9.8 }];
    const result = await svc.getCompositionFromDb("ETF", "NIFTYBEES");
    assert.strictEqual(
      result,
      null,
      "the footer's 'Data as of 2024-05' must never be reachable again"
    );
  });

  it("[regression] and DEMOTES it to FAILED so the DB stops claiming the extraction succeeded", async () => {
    db.meta = metaRow({ dataAsOf: monthsAgo(27), status: "READY" });
    await svc.getCompositionFromDb("ETF", "NIFTYBEES");
    assert.strictEqual(db.metaUpserts.length, 1);
    assert.strictEqual(db.metaUpserts[0]!.status, "FAILED");
    assert.match(
      String(db.metaUpserts[0]!.errorMessage),
      /months behind/,
      "the reason must record the evidence"
    );
  });

  it("a row with NO dataAsOf at all is withheld too", async () => {
    db.meta = metaRow({ dataAsOf: null });
    assert.strictEqual(
      await svc.getCompositionFromDb("ETF", "NIFTYBEES"),
      null
    );
    assert.strictEqual(db.metaUpserts[0]!.status, "FAILED");
  });
});

describe("MONEY-1205 LIVE service — getOrExtractComposition gates before it spends a call", () => {
  let svc: ServiceModule;
  before(() => {
    svc = installService();
  });
  beforeEach(() => {
    db = freshDb();
    gemini = freshGemini();
  });
  after(() => {
    uninstallService();
  });

  it("[regression] a content-stale READY row is demoted WITHOUT calling Gemini", async () => {
    // The clock gate says this row is 1 second old and perfectly fresh.
    db.meta = metaRow({
      dataAsOf: monthsAgo(27),
      status: "READY",
      extractedAt: new Date(),
    });
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(result, null);
    assert.strictEqual(
      gemini.calls,
      0,
      "demotion must not itself burn an LLM call — we have six months of " +
        "evidence that re-extraction returns the same stale content"
    );
    assert.strictEqual(db.metaUpserts[0]!.status, "FAILED");
  });

  it("[regression] a RECENT failure is left alone — no Gemini call on the next page view", async () => {
    db.meta = metaRow({
      status: "FAILED",
      updatedAt: new Date(Date.now() - 60 * 1000),
    });
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(result, null);
    assert.strictEqual(gemini.calls, 0);
    assert.strictEqual(db.metaUpserts.length, 0, "and no write either");
  });

  it("an OLD failure is retried", async () => {
    db.meta = metaRow({
      status: "FAILED",
      updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    gemini.response = geminiPayload(monthsAgo(1));
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(gemini.calls, 1);
    assert.ok(result);
  });

  it("[regression] a row parked in EXTRACTING is treated as in-flight — no second call", async () => {
    db.meta = metaRow({
      status: "EXTRACTING",
      updatedAt: new Date(Date.now() - 30 * 1000),
    });
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(result, null);
    assert.strictEqual(gemini.calls, 0);
  });

  it("a STUCK EXTRACTING row (crashed run) unblocks itself", async () => {
    db.meta = metaRow({
      status: "EXTRACTING",
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    gemini.response = geminiPayload(monthsAgo(1));
    await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(gemini.calls, 1);
  });
});

describe("MONEY-1205 LIVE service — persistComposition refuses a stale extraction", () => {
  let svc: ServiceModule;
  before(() => {
    svc = installService();
  });
  beforeEach(() => {
    db = freshDb();
    gemini = freshGemini();
  });
  after(() => {
    uninstallService();
  });

  it("a FRESH extraction is stored READY, with its holdings", async () => {
    gemini.response = geminiPayload(monthsAgo(1));
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.ok(result, "a genuinely recent extraction must still be stored");
    const statuses = db.metaUpserts.map((u) => u.status);
    assert.deepStrictEqual(statuses, ["EXTRACTING", "READY"]);
    assert.strictEqual(db.holdingCreates, 1);
    assert.strictEqual(db.holdings.length, 2);
  });

  it("[regression] an extraction claiming 2024-05 is stored FAILED, not READY", async () => {
    // The exact payload 80 of the 111 prod rows were written from.
    gemini.response = geminiPayload(monthsAgo(27));
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(
      result,
      null,
      "a rejected extraction must not be returned to the caller either"
    );
    const statuses = db.metaUpserts.map((u) => u.status);
    assert.deepStrictEqual(
      statuses,
      ["EXTRACTING", "FAILED"],
      "READY here is the defect: a failed extraction recorded as a success"
    );
    assert.match(String(db.metaUpserts[1]!.errorMessage), /months behind/);
  });

  it("[regression] and it does NOT write the stale holdings, nor delete the ones already there", async () => {
    // FundHolding is getMfPortfolioSection's fallback — deleting it starves
    // that panel, and replacing it moves the same lie one table over.
    db.holdings = [{ holdingName: "Pre-existing Ltd", weightPercent: 5 }];
    gemini.response = geminiPayload(monthsAgo(27));
    await svc.getOrExtractComposition("MF", "119598");
    assert.strictEqual(db.holdingCreates, 0, "no stale holdings written");
    assert.strictEqual(db.holdingDeletes, 0, "the fallback is not starved");
    assert.strictEqual(db.holdings.length, 1);
    assert.strictEqual(db.holdings[0]!.holdingName, "Pre-existing Ltd");
  });

  it("[regression] an extraction with NO period is stored FAILED", async () => {
    gemini.response = geminiPayload("");
    const result = await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(result, null);
    assert.strictEqual(db.metaUpserts.at(-1)!.status, "FAILED");
    assert.strictEqual(db.holdingCreates, 0);
  });

  it("a high self-reported confidence does NOT rescue a stale period", async () => {
    // 0.99 was the max observed on prod, on a 26-month-old portfolio.
    gemini.response = JSON.stringify({
      ...JSON.parse(geminiPayload(monthsAgo(26))),
      confidence: 0.99,
    });
    await svc.getOrExtractComposition("ETF", "NIFTYBEES");
    assert.strictEqual(db.metaUpserts.at(-1)!.status, "FAILED");
  });
});

describe("MONEY-1401 shouldServeComposition — the polarity a source scan could not hold", () => {
  /**
   * `FundCompositionSection` used to decide this inline, as
   * `if (!unverifiedAndStale)`, and two assertions in
   * `__tests__/components/fund-composition-auto-trigger.test.ts` scanned the
   * source for `isCompositionContentStale(...)`. MEASURED: flipping that one
   * `!` — so the component serves ONLY stale recollections and withholds every
   * good one — leaves BOTH regexes matching. The two spellings differ by a
   * single character, which is precisely what a regex cannot separate.
   *
   * Executed here, in both directions, against a FROZEN clock.
   */
  const NOW = Date.UTC(2026, 8, 13); // 2026-09-13

  it("a fresh RECOLLECTION is served; a stale one is not", () => {
    // MUTATION: `return !isCompositionContentStale(...)` → drop the `!` →
    //   AssertionError on the first assertion. VERIFIED red — and this is the
    //   exact mutation the source scans could not see.
    assert.strictEqual(
      shouldServeComposition(
        { source: "GEMINI_RECALL", dataAsOf: "2026-08" },
        NOW
      ),
      true
    );
    assert.strictEqual(
      shouldServeComposition(
        { source: "GEMINI_RECALL", dataAsOf: "2024-05" },
        NOW
      ),
      false,
      "the measured prod shape: every stored recollection claims 2024-04/05/06"
    );
  });

  it("a filed DISCLOSURE is served however old its period is", () => {
    // `dataAsOf` here is `MfPortfolioHolding.period` — the month the AMC's own
    // filing describes, not a month a model claimed to have read. There is
    // nothing to disbelieve, and a scheme whose AMC last published seven months
    // ago must keep its real portfolio.
    //
    // MUTATION: delete the `source === "AMC_DISCLOSURE"` early return →
    //   AssertionError: false !== true on the 2024-05 case. VERIFIED red.
    assert.strictEqual(
      shouldServeComposition(
        { source: "AMC_DISCLOSURE", dataAsOf: "2026-01" },
        NOW
      ),
      true
    );
    assert.strictEqual(
      shouldServeComposition(
        { source: "AMC_DISCLOSURE", dataAsOf: "2024-05" },
        NOW
      ),
      true
    );
    assert.strictEqual(
      shouldServeComposition({ source: "AMC_DISCLOSURE", dataAsOf: null }, NOW),
      true
    );
  });

  it("an ABSENT source is treated as a recollection, not as a filing", () => {
    // `source` is optional on `FundCompositionData` (older cache entries carry
    // none), and the fail-safe direction is to disbelieve: a missing provenance
    // must never be promoted to "the AMC filed it".
    //
    // MUTATION: `composition?.source !== "GEMINI_RECALL"` as the early-return
    //   condition (i.e. absent ⇒ trusted) → AssertionError: true !== false.
    //   VERIFIED red.
    assert.strictEqual(
      shouldServeComposition({ dataAsOf: "2024-05" }, NOW),
      false
    );
    assert.strictEqual(
      shouldServeComposition({ dataAsOf: "2026-08" }, NOW),
      true
    );
  });

  it("a null/undefined composition does not throw", () => {
    assert.strictEqual(
      shouldServeComposition(
        null as unknown as { source?: string | null },
        NOW
      ),
      false
    );
  });
});
