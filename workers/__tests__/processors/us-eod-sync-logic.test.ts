/**
 * `us-eod-sync-logic.ts` — the pure decisions behind the US price backbone.
 *
 * MONEY-980 (tasks 6 + 7). Every case below imports the REAL symbol the
 * processor calls; there are no re-declared copies, so a regression in the
 * source turns these red rather than leaving a shadow test green.
 *
 * The cases are chosen for what they would CATCH, not for coverage: each one
 * corresponds to a defect this repo has already paid for once.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  resolveListingId,
  type UsCorporateActionRow,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions-logic";
import type { TiingoNewsArticle } from "@usemoney/core/market-data/tiingo/tiingo-news-logic";

import {
  ACK_DEADLINE_MS,
  CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE,
  CA_EVICTION_UNAVAILABLE,
  CA_LOOKUP_CHUNK_SIZE,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_US_EOD_BATCH_SIZE,
  EQUITY_LEG_BUDGET_MS,
  MAX_BATCH_SIZE,
  MAX_CHAIN_DEPTH,
  MAX_LOOKBACK_DAYS,
  CA_WRITE_TAIL_MS,
  FX_LEG_TAIL_MS,
  FX_QUOTE_FETCH_CALLS,
  FX_WRITE_MS,
  POST_CALL_TAIL_MS,
  POST_WRITE_TAIL_MS,
  PRICE_LEG_BUDGET_MS,
  SECONDARY_LEG_SLICE_MS,
  TAIL_QUERY_MS,
  TAIL_REPORT_MS,
  RUN_TIME_BUDGET_MS,
  US_EOD_ORDER_BY,
  US_SESSION_CLOSE_HOUR_ET,
  US_MF_ASSET_TYPES,
  US_EQUITY_ASSET_TYPES,
  MF_NAV_NEEDS_PERMATICKER,
  toFundNavRows,
  affectedSecurities,
  buildListingWindowIndex,
  buildUsEodWhere,
  chunkList,
  clampBatchSize,
  clampLookbackDays,
  computeSelected,
  describeSecondaryRefusal,
  detectCorporateActions,
  hasRotationWrapped,
  isCashDistribution,
  isWithinRunBudget,
  judgeCalendarLegVerdict,
  judgeLegVerdict,
  judgeUsEodHealth,
  latestUpstreamCallStartMs,
  legHasMoreWork,
  legIsDark,
  nextTradingDayAfter,
  normalizeChainDepth,
  normalizeChainStartedAt,
  normalizeEtHour,
  requestBudgetForRun,
  requestsSpentByCall,
  resolveCalendarExDate,
  resolveCandleListingId,
  usCalendarHour,
  resolveUsSessionDate,
  resolveWindowStart,
  shiftIsoDate,
  shouldChainAnotherBatch,
  toCandleRows,
  usCalendarDate,
  utcMidnight,
  worstCaseRunMs,
  worstTiingoCallMs,
  type EodBarInput,
  type UsEodChainInput,
  type UsEodHealthInput,
  type UsEodLegVerdict,
} from "../../src/processors/us-eod-sync-logic";

/* --------------------------------------------------------------------------
   Source-scanning helpers.

   Two cases below assert a property of the SOURCE rather than of a value —
   that a fabricated cache namespace is gone, and that a constant restated from
   another package still matches its original. Both read the file off disk, so
   both must first prove they READ something: a scan over an empty string
   passes vacuously, which is the shadow test this repo has a standing rule
   against.
   ------------------------------------------------------------------------ */

/**
 * Read a repo file, or THROW naming the path that was not there.
 *
 * This used to return `""` on a miss, which is the exact vacuous-scan defect
 * the block above warns about — implemented one function below the warning.
 * MONEY-1263 proved the cost: the three Tiingo scripts moved from
 * `scripts/data/` to `scripts/jobs/`, the stale path here silently read the
 * empty string, and the case failed on `seed.length > 1000` — a message about a
 * SHORT file, when the file was ABSENT. Every other scan in this file would
 * have failed differently: `includes()` over `""` is `false`, so a "the source
 * lost X" message accuses the source of a regression it does not have.
 *
 * Throwing makes both the missing path and the resolved root visible.
 *
 * It used to be the ONLY thing catching this file's own `repoRoot()` falling
 * back to `process.cwd()` — one of three copies in this workspace that did,
 * against eight that threw. MONEY-1327 replaced all eleven with the shared
 * `_support/repo-root`, which anchors on this file's location and THROWS rather
 * than guessing, so the compensation below is no longer load-bearing for that.
 * It is kept for what it independently catches: a path that is right about the
 * root and wrong about the file.
 */
/**
 * Resolved ONCE, at MODULE scope — MONEY-1327.
 *
 * `repoRoot()` throws when its anchor stops landing on the workspace root, and
 * a throw from a `describe` body is reported as a dropped suite (`not ok`,
 * `# fail 0`) rather than a failure. At module scope node fails the FILE. See
 * the longer note in `auth-middleware.test.ts`, which measured exit 0.
 */
const REPO_ROOT = repoRoot();

function readRepoFile(...parts: string[]): string {
  const full = join(REPO_ROOT, ...parts);
  if (!existsSync(full)) {
    throw new Error(
      `readRepoFile: no such file ${full} (repo root resolved to ${REPO_ROOT}) — ` +
        `a scan over a missing file passes or fails for the wrong reason`,
    );
  }
  return readFileSync(full, "utf8");
}

/**
 * Drop comment-only lines so a scan tests CODE, not prose.
 *
 * Both files below explain the defect they no longer have, and a naive
 * `includes()` matches the explanation — which would make the fix
 * unrepresentable in its own file. Only whole-line comments are dropped: a
 * pattern minted in code with a trailing `//` note is still caught, because the
 * line does not START with a comment marker.
 */
function codeOnly(src: string): Array<readonly [number, string]> {
  return src
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => {
      const t = line.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    });
}

/**
 * The text between a call's opening `(`/`{` and its matching close.
 *
 * Brace-counted rather than regex'd, because the argument object spans lines
 * and a lazy `[\s\S]*?` would stop at the first `}` - which for a nested
 * object is the wrong one, and would hand every assertion a truncated string
 * that happens to pass. Returns "" when the call is absent, and every caller
 * asserts a non-trivial length first so an absent call fails loudly rather than
 * vacuously.
 */
function callArgs(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return "";
  // Always land on the OBJECT brace, whether the marker ended at `(` or `({`.
  // Counting from the paren instead would make the first line of the returned
  // block a bare `{`, which pushes every key to depth 1 and returns none - a
  // silently empty answer, which is the failure mode this whole file is about.
  const i = src.indexOf("{", at + marker.length - 1);
  if (i < 0) return "";
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i + 1, j);
    }
  }
  return "";
}

/** Top-level object keys inside an extracted argument block. */
function argKeys(args: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const rawLine of args.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//")) continue;
    if (depth === 0) {
      // `name:` AND the shorthand `name,` - `listingId` is passed shorthand,
      // and a colon-only rule silently drops it, which would let a real extra
      // key slip in beside it.
      const m = /^([A-Za-z_$][\w$]*)\s*(?::|,\s*$)/.exec(line);
      if (m) keys.push(m[1]!);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") depth--;
    }
  }
  return keys;
}

/** A chain input that WOULD chain, so each case can break exactly one thing. */
function chainable(over: Partial<UsEodChainInput> = {}): UsEodChainInput {
  return {
    chainDepth: 0,
    equitySelected: 800,
    equityBatchSize: 800,
    mfSelected: 200,
    mfBatchSize: 200,
    stamped: 800,
    rateLimited: false,
    accessRefused: false,
    symbolScoped: false,
    equityRotationWrapped: false,
    mfRotationWrapped: false,
    ...over,
  };
}

/** A healthy run, so each case can break exactly one leg. */
function healthy(over: Partial<UsEodHealthInput> = {}): UsEodHealthInput {
  return {
    equitySelected: 800,
    mfSelected: 200,
    equityAttempted: 800,
    equityBars: 4000,
    mfAttempted: 200,
    mfBars: 1000,
    mfSkippedNoPermaTicker: 0,
    fxAttempted: 1,
    fxWritten: 1,
    transportFailures: 0,
    rateLimited: false,
    accessRefused: false,
    // MONEY-1263. The baseline has leg (e) HEALTHY, so every case below that
    // leaves it alone is testing exactly one thing. These are required rather
    // than optional on `UsEodHealthInput` on purpose: an optional leg input
    // defaults to something, and whatever it defaults to is a verdict nobody
    // asked for.
    //
    // The nine `news*` inputs that stood here went with leg (f) — MONEY-1309
    // retired it, because this job's Tue-Sat market cron could not run at all
    // on a Sunday or Monday IST.
    caAttempted: 2,
    caRows: 214,
    caRefused: false,
    caRefusedDetail: null,
    ...over,
  };
}

/** The three-leg verdict a healthy run produces. Spelled once. */
const ALL_HEALTHY = {
  equity: "healthy",
  mf: "healthy",
  ca: "healthy",
} as const;

/** A run whose every leg was owed nothing and delivered. */
function selectedInput(
  over: Partial<Parameters<typeof computeSelected>[0]> = {},
) {
  return {
    equityOwed: 0,
    equityAttempted: 0,
    equityBars: 0,
    mfOwed: 0,
    mfAttempted: 0,
    mfBars: 0,
    fxAttempted: 0,
    caOwed: 0,
    caAttempted: 0,
    caRows: 0,
    ...over,
  };
}

/** One distribution row as the client's CSV parser produces it. */
function distributionRow(
  over: Partial<{
    permaTicker: string;
    ticker: string;
    exDate: string;
    paymentDate: string | null;
    recordDate: string | null;
    declarationDate: string | null;
    distribution: number | null;
    distributionFrequency: string | null;
  }> = {},
) {
  return {
    permaTicker: "US000000000038",
    ticker: "aapl",
    exDate: "2026-08-28",
    paymentDate: "2026-09-11",
    recordDate: "2026-08-31",
    declarationDate: "2026-08-01",
    distribution: 0.26,
    distributionFrequency: "q",
    ...over,
  };
}

/** One split row as the client's CSV parser produces it. */
function splitRow(
  over: Partial<{
    permaTicker: string;
    ticker: string;
    exDate: string;
    splitFrom: number | null;
    splitTo: number | null;
    splitFactor: number | null;
  }> = {},
) {
  return {
    permaTicker: "US000000086004",
    ticker: "reax",
    exDate: "2026-08-25",
    splitFrom: null,
    splitTo: null,
    splitFactor: 0.1,
    ...over,
  };
}

/** One news article as the client's parser produces it. */
function article(over: Partial<TiingoNewsArticle> = {}): TiingoNewsArticle {
  return {
    id: 1,
    publishedDate: "2026-08-27T00:00:00Z",
    crawlDate: "2026-08-27T00:17:23.981203Z",
    title: "Apple announces something",
    description: "A description.",
    url: "https://example.com/a",
    source: "prnewswire.com",
    tags: ["Technology"],
    tickers: ["aapl"],
    ...over,
  };
}

function bar(over: Partial<EodBarInput> = {}): EodBarInput {
  return {
    date: "2026-08-27",
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1234,
    divCash: 0,
    splitFactor: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("MONEY-1050/1205/1234/1236 — the rotation marker is never in the WHERE", () => {
  it("no leg's where mentions usEodSyncedAt at any depth", () => {
    // On Mongo the attribute is ABSENT, not null, on every pre-existing row, so
    // BOTH `{usEodSyncedAt: null}` and `{usEodSyncedAt: {not: null}}` match
    // ZERO. A where-clause on it makes this job report a clean, healthy,
    // entirely empty run forever — which is why this is asserted structurally
    // over the whole serialised object rather than on one key.
    for (const leg of ["EQUITY", "MF"] as const) {
      const where = JSON.stringify(buildUsEodWhere(leg));
      assert.ok(
        !where.includes("usEodSyncedAt"),
        `${leg} where must not reference the rotation marker: ${where}`,
      );
      assert.ok(
        !where.includes("usEodSyncedAt"),
        "the marker belongs in orderBy only",
      );
    }
  });

  it("selects the US population POSITIVELY", () => {
    // `market` is gone with the table move — `us_instruments` IS the US
    // population, so `listingStatus` is the only positive term left. It stays
    // positive because on Mongo the attribute is ABSENT rather than null on any
    // row predating the column, so a negative test matches zero
    // (MONEY-1050 / 1205 / 1234 / 1236).
    const where = buildUsEodWhere("EQUITY") as Record<string, unknown>;
    assert.equal(where.listingStatus, "ACTIVE");
    assert.equal(where.market, undefined);
  });

  it("carries no `exchange` term — US rows are one per ticker globally", () => {
    // `/tiingo/daily/<ticker>/prices` takes no exchange qualifier, so the
    // instrument master collapses a US security to ONE row. An exchange term
    // here would not de-duplicate anything; it would EXCLUDE rows whose stored
    // venue differs from the one guessed.
    for (const leg of ["EQUITY", "MF"] as const) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(buildUsEodWhere(leg), "exchange"),
      );
    }
  });

  it("the two legs partition the population — disjoint and total", () => {
    const eq = buildUsEodWhere("EQUITY") as { assetType: { in: string[] } };
    const mf = buildUsEodWhere("MF") as { assetType: { in: string[] } };
    assert.deepEqual(mf.assetType.in, [...US_MF_ASSET_TYPES]);
    assert.deepEqual(eq.assetType.in, [...US_EQUITY_ASSET_TYPES]);
    // DISJOINT: nothing may be in both, or a fund would be fetched twice and
    // written to two tables.
    const overlap = US_EQUITY_ASSET_TYPES.filter((t) =>
      (US_MF_ASSET_TYPES as readonly string[]).includes(t),
    );
    assert.deepEqual(overlap, []);
  });

  it("BOTH legs match POSITIVELY — a `notIn` would sweep up ABSENT attributes", () => {
    // The EQUITY term used to be `instrumentType: {notIn: [...funds]}`. That is
    // correct against a column with a bounded vocabulary and a hazard against
    // this one: on Mongo a `notIn` ALSO matches a row where the attribute is
    // ABSENT, so any `us_instruments` row written before `assetType` existed
    // would be handed to leg (a) and asked for equity prices. Two positive
    // lists cannot do that, and a NEW upstream assetType falls out of both —
    // a visible shortfall in `selected` rather than a silent misfile.
    for (const leg of ["EQUITY", "MF"] as const) {
      const where = buildUsEodWhere(leg) as Record<string, unknown>;
      const assetType = where.assetType as Record<string, unknown>;
      assert.ok(
        Object.prototype.hasOwnProperty.call(assetType, "in"),
        `${leg} must select assetType positively`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(assetType, "notIn"),
        false,
        `${leg} must not use notIn — it matches ABSENT attributes on Mongo`,
      );
    }
  });

  it("there is NO `market` term — the TABLE is the discriminator now", () => {
    // US securities moved from `instrument_mappings` to `us_instruments`, so
    // the collection is the discriminator. That is strictly stronger than a
    // column: a reader can forget a column and cannot forget a collection —
    // the same argument that split `us_stock_news` out of `stock_news`.
    for (const leg of ["EQUITY", "MF"] as const) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(buildUsEodWhere(leg), "market"),
        false,
      );
    }
  });

  it("matches the spelling the instrument master actually WRITES", () => {
    // `UsInstrument.assetType` carries TIINGO'S OWN string, straight off
    // `supported_tickers.csv`, whose vocabulary is exactly Stock / ETF /
    // Mutual Fund. Title case with a SPACE: uppercase it and the NAV leg
    // selects 0 forever against a real, populated table of 49,414 funds — the
    // silent shape this file's whole health section exists to catch.
    assert.deepEqual([...US_MF_ASSET_TYPES], ["Mutual Fund"]);
    assert.deepEqual([...US_EQUITY_ASSET_TYPES], ["Stock", "ETF"]);
    // Only the fund spelling is case-and-space-sensitive in a way an
    // "obviously equivalent" edit would break. `ETF` really is all caps
    // upstream, so asserting mixed case on every entry would be asserting a
    // property the data does not have — a test that has to be wrong to pass.
    assert.equal(US_MF_ASSET_TYPES[0], "Mutual Fund");
    assert.notEqual(US_MF_ASSET_TYPES[0], "MUTUAL FUND");
    assert.notEqual(US_MF_ASSET_TYPES[0], "MutualFund");
  });

  it("a scoped run upper-cases and trims the symbols", () => {
    const where = buildUsEodWhere("EQUITY", [" aapl ", "brk-a"]) as {
      symbol: { in: string[] };
    };
    assert.deepEqual(where.symbol.in, ["AAPL", "BRK-A"]);
  });

  it("an empty symbols array is NOT a scope (it would select nothing)", () => {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(
        buildUsEodWhere("EQUITY", []),
        "symbol",
      ),
    );
  });
});

describe("MONEY-1211 — the order-by rotates, ascending, with a tiebreak", () => {
  it("orders by the marker ASC then symbol ASC", () => {
    assert.deepEqual(US_EOD_ORDER_BY, [
      { usEodSyncedAt: "asc" },
      { symbol: "asc" },
    ]);
  });

  it("uses a PLAIN asc, never the Postgres-only {sort,nulls} form", () => {
    // On the Mongo connector the field is absent rather than null, and Mongo
    // already sorts a missing field lowest. A `nulls` modifier would be either
    // rejected or silently ignored — a guard that looks like it works.
    const serialised = JSON.stringify(US_EOD_ORDER_BY);
    assert.ok(!serialised.includes("nulls"), serialised);
    assert.ok(!serialised.includes("sort"), serialised);
  });

  it("has a tiebreak — a chunked stamp gives 100 rows one timestamp", () => {
    assert.equal(US_EOD_ORDER_BY.length, 2);
  });
});

describe("the self-chain terminates (the termination proof)", () => {
  it("stops at MAX_CHAIN_DEPTH against an adversarial 'always more work' world", () => {
    // The environment lies in the direction that would keep the chain alive
    // forever: full pages, progress every run, no failures. Only the depth
    // bound can stop it, which is the property being proved.
    let depth = 0;
    let links = 0;
    while (shouldChainAnotherBatch(chainable({ chainDepth: depth }))) {
      depth += 1;
      links += 1;
      assert.ok(links <= MAX_CHAIN_DEPTH + 1, "chain did not terminate");
    }
    assert.equal(depth, MAX_CHAIN_DEPTH - 1);
  });

  it("refuses once the NEXT depth would REACH the ceiling", () => {
    assert.equal(
      shouldChainAnotherBatch(chainable({ chainDepth: MAX_CHAIN_DEPTH - 2 })),
      true,
    );
    assert.equal(
      shouldChainAnotherBatch(chainable({ chainDepth: MAX_CHAIN_DEPTH - 1 })),
      false,
    );
  });

  it("the baseline input DOES chain (so every negative case below is meaningful)", () => {
    assert.equal(shouldChainAnotherBatch(chainable()), true);
  });

  for (const [name, over] of [
    [
      "rate-limited (a fresh link re-arms the breaker — MONEY-853)",
      { rateLimited: true },
    ],
    [
      "access refused — 401/403, token OR entitlement, deterministic either way",
      { accessRefused: true },
    ],
    ["symbol-scoped (a finite manual target)", { symbolScoped: true }],
    ["nothing stamped (the runaway-poll shape)", { stamped: 0 }],
    [
      "BOTH rotations wrapped (every next page is rows this chain synced)",
      { equityRotationWrapped: true, mfRotationWrapped: true },
    ],
    [
      "both legs short (the whole population fits one page)",
      { equitySelected: 5, mfSelected: 5 },
    ],
    [
      "equity wrapped + MF drained (a full page of rows already done)",
      { equityRotationWrapped: true, mfSelected: 5 },
    ],
    [
      "MF wrapped + equity drained",
      { mfRotationWrapped: true, equitySelected: 5 },
    ],
  ] as Array<[string, Partial<UsEodChainInput>]>) {
    it(`stops on: ${name}`, () => {
      assert.equal(shouldChainAnotherBatch(chainable(over)), false);
    });
  }

  it("one leg still full is enough to keep going", () => {
    // A short MF page must not end the chain while the equity rotation is
    // mid-flight — that is how the smaller partition would silently truncate
    // the larger one.
    assert.equal(shouldChainAnotherBatch(chainable({ mfSelected: 3 })), true);
  });
});

describe("chainDepth / chainStartedAt sanitisation", () => {
  it("anything that is not a finite non-negative number reads as depth 0", () => {
    for (const v of [undefined, null, "3", NaN, Infinity, -1, {}, []]) {
      assert.equal(normalizeChainDepth(v), 0, String(v));
    }
  });

  it("a forged large depth is CLAMPED TO the ceiling, so it ENDS the chain", () => {
    assert.equal(normalizeChainDepth(1e9), MAX_CHAIN_DEPTH);
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ chainDepth: normalizeChainDepth(1e9) }),
      ),
      false,
    );
  });

  it("a fractional depth floors rather than buying a partial link", () => {
    assert.equal(normalizeChainDepth(3.9), 3);
  });

  it("chainStartedAt rejects anything that is not a plausible epoch stamp", () => {
    for (const v of [undefined, null, "1700000000000", 0, -1, NaN, Infinity]) {
      assert.equal(normalizeChainStartedAt(v), null, String(v));
    }
    assert.equal(
      normalizeChainStartedAt(1_700_000_000_123.7),
      1_700_000_000_123,
    );
  });
});

describe("rotation wrap — this job's version of 'the queue drained'", () => {
  it("wrapped when the page's OLDEST row was already stamped by this chain", () => {
    assert.equal(hasRotationWrapped(2_000, 1_000), true);
  });

  it("not wrapped while the page still leads with never-synced rows", () => {
    assert.equal(hasRotationWrapped(null, 1_000), false);
  });

  it("not wrapped when the page predates the chain", () => {
    assert.equal(hasRotationWrapped(500, 1_000), false);
  });

  it("an unusable chainStartedAt reads NOT wrapped — the safe direction", () => {
    // Reading it as wrapped would let a forged payload mute the chain; reading
    // it as not-wrapped can only let the chain run its already-bounded length.
    assert.equal(hasRotationWrapped(2_000, null), false);
    assert.equal(hasRotationWrapped(2_000, Number.NaN), false);
  });
});

describe("budgets — the 600s ack deadline, and the plan", () => {
  it("the equity leg yields before the run budget, so leg (b) is never starved", () => {
    assert.ok(
      EQUITY_LEG_BUDGET_MS < RUN_TIME_BUDGET_MS,
      "leg (a) must leave leg (b) a floor or the NAV leg livelocks",
    );
    assert.ok(RUN_TIME_BUDGET_MS - EQUITY_LEG_BUDGET_MS >= 100_000);
  });

  it("the run budget leaves real headroom inside the 600s ack deadline", () => {
    assert.ok(
      RUN_TIME_BUDGET_MS <= 480_000,
      "overrunning 600s REDELIVERS the run and spends the quota twice",
    );
  });

  it("isWithinRunBudget is a strict elapsed comparison", () => {
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS - 1), true);
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS), false);
  });

  it("the request budget is the plan's hourly rate x the run's share of an hour", () => {
    // COMMERCIAL: 20,000/hr over 420s = 20000 * 7/60 = 2,333.
    assert.equal(
      requestBudgetForRun({
        perHour: 20_000,
        perDay: 150_000,
        bandwidthBytesPerMonth: 1,
      }),
      2_333,
    );
    // REDISTRIBUTION: 80,000/hr over the same window.
    assert.equal(
      requestBudgetForRun({
        perHour: 80_000,
        perDay: 1_200_000,
        bandwidthBytesPerMonth: 1,
      }),
      9_333,
    );
  });

  it("a chain of MAX_CHAIN_DEPTH links stays inside the hourly ceiling", () => {
    // The property that makes the per-run cap compose: N links of `budgetMs`
    // span N*budgetMs, and each is capped at perHour * budgetMs/3.6e6.
    const perHour = 20_000;
    const perRun = requestBudgetForRun({
      perHour,
      perDay: 150_000,
      bandwidthBytesPerMonth: 1,
    });
    const chainHours = (MAX_CHAIN_DEPTH * RUN_TIME_BUDGET_MS) / 3_600_000;
    assert.ok((MAX_CHAIN_DEPTH * perRun) / chainHours <= perHour + 1);
  });

  it("a nonsense plan yields no budget rather than an unbounded one", () => {
    for (const perHour of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        requestBudgetForRun({ perHour, perDay: 1, bandwidthBytesPerMonth: 1 }),
        0,
        String(perHour),
      );
    }
  });
});

describe("page size and window clamps", () => {
  it("falls back on a missing / non-numeric / sub-1 batch", () => {
    for (const v of [undefined, null, "800", 0, -5, NaN]) {
      assert.equal(
        clampBatchSize(v, DEFAULT_US_EOD_BATCH_SIZE),
        DEFAULT_US_EOD_BATCH_SIZE,
      );
    }
  });

  it("caps a fat-fingered page so a findMany cannot exhaust the container", () => {
    assert.equal(
      clampBatchSize(5_000_000, DEFAULT_US_EOD_BATCH_SIZE),
      MAX_BATCH_SIZE,
    );
  });

  it("CLAMPS the lookback — an unbounded window pulls 46 years per symbol", () => {
    assert.equal(clampLookbackDays(9_999), MAX_LOOKBACK_DAYS);
    assert.equal(clampLookbackDays(undefined), DEFAULT_LOOKBACK_DAYS);
    assert.equal(clampLookbackDays(0), DEFAULT_LOOKBACK_DAYS);
    assert.equal(clampLookbackDays(7), 7);
  });

  it("the default window survives a lost Saturday run across the weekend", () => {
    // Cron is Tue-Sat. Sat covers Friday; if Sat is lost, Tuesday's run targets
    // Monday and must still reach back past Sunday and Saturday to Friday.
    const monday = "2026-08-31";
    const start = resolveWindowStart(monday, DEFAULT_LOOKBACK_DAYS);
    assert.ok(start <= "2026-08-28", `window start ${start} misses Friday`);
  });
});

describe("the US session date, in the exchange's own calendar", () => {
  it("the OLD 07:00 IST slot resolves to the session that just closed", () => {
    // 2026-08-28T01:30Z is 07:00 IST on the 28th and 21:30 ET on the 27th.
    assert.equal(
      usCalendarDate(Date.parse("2026-08-28T01:30:00Z")),
      "2026-08-27",
    );
    assert.equal(
      resolveUsSessionDate(Date.parse("2026-08-28T01:30:00Z")),
      "2026-08-27",
    );
  });

  it("11:00 IST names the CLOSED session, not the one about to open", () => {
    // THE REGRESSION TEST FOR THE SCHEDULE MOVE.
    //
    // The trigger moved 07:00 -> 11:00 IST so leg (b) lands after Tiingo
    // publishes fund NAVs at 12:00 AM ET. 11:00 IST is 05:30 UTC, which in New
    // York is 01:30 EDT / 00:30 EST — JUST PAST MIDNIGHT ON THE NEXT CALENDAR
    // DAY. "Today in New York" therefore became Friday the 28th, a session that
    // does not open until 09:30 ET that morning, and leg (d) would have stamped
    // `FxRate.date` with it — shifting every converted portfolio value by a day
    // in the one column whose purpose is to say WHICH day.
    const friday1100Ist = Date.parse("2026-08-28T05:30:00Z");
    assert.equal(
      usCalendarDate(friday1100Ist),
      "2026-08-28",
      "the NY calendar day HAS rolled over — this is the trap",
    );
    assert.equal(
      resolveUsSessionDate(friday1100Ist),
      "2026-08-27",
      "the session being reported is Thursday's close, not Friday's open",
    );
  });

  it("both trigger times agree about the same session", () => {
    // The property that makes the next schedule move safe: the rule is stated
    // in terms of the CLOSE, so it is correct under either clock rather than
    // tuned to one.
    for (const [oldSlot, newSlot] of [
      ["2026-08-28T01:30:00Z", "2026-08-28T05:30:00Z"], // EDT, Fri
      ["2027-01-13T01:30:00Z", "2027-01-13T05:30:00Z"], // EST, Wed
    ] as const) {
      assert.equal(
        resolveUsSessionDate(Date.parse(oldSlot)),
        resolveUsSessionDate(Date.parse(newSlot)),
        `${oldSlot} vs ${newSlot}`,
      );
    }
  });

  it("11:00 IST on a Saturday still names Friday's close", () => {
    // Sat 2026-08-29 05:30Z -> NY 01:30 Sat -> previous day is Sat itself after
    // the shift?  No: the pre-close shift lands on Friday the 28th, which is a
    // weekday, so no weekend walk-back is needed. Asserted because getting the
    // ORDER of the two shifts wrong silently returns Thursday.
    assert.equal(
      resolveUsSessionDate(Date.parse("2026-08-29T05:30:00Z")),
      "2026-08-28",
    );
  });

  it("a Sunday or Monday manual run walks back over the weekend", () => {
    // Sun 11:00 IST -> NY 01:30 Sun -> pre-close shift -> Sat -> Friday.
    assert.equal(
      resolveUsSessionDate(Date.parse("2026-08-30T05:30:00Z")),
      "2026-08-28",
    );
    // Mon 11:00 IST -> NY 01:30 Mon -> pre-close shift -> Sun -> Friday.
    assert.equal(
      resolveUsSessionDate(Date.parse("2026-08-31T05:30:00Z")),
      "2026-08-28",
    );
  });

  it("usCalendarHour reads the NY hour on both sides of midnight", () => {
    assert.equal(usCalendarHour(Date.parse("2027-01-13T05:30:00Z")), 0); // EST
    assert.equal(usCalendarHour(Date.parse("2026-08-28T05:30:00Z")), 1); // EDT
    assert.equal(usCalendarHour(Date.parse("2026-08-28T01:30:00Z")), 21);
    assert.equal(US_SESSION_CLOSE_HOUR_ET, 16);
  });

  it("hour 24 normalises to 0 — `h24` is one letter from `h23`", () => {
    // MEASURED on this runtime (Node 22 / ICU 78): `h23`, `hour12: false` and
    // the default all render midnight "00"; only `hourCycle: "h24"` renders
    // "24". So the format option is NOT what makes this safe — the
    // normalisation is, and it is asserted directly because no instant can
    // produce a 24 through `usCalendarHour` here. A 24 would compare as "after
    // the close" and name a session that has not opened.
    assert.equal(normalizeEtHour(24), 0);
    assert.equal(normalizeEtHour(0), 0);
    assert.equal(normalizeEtHour(16), 16);
    assert.equal(normalizeEtHour(23), 23);
  });

  it("an unparseable hour falls back to the CLOSE, never to midnight", () => {
    // 0 would shift EVERY session date back a day on every run — a silent,
    // permanent off-by-one in the column whose only purpose is to say which
    // day. The close hour reproduces the pre-move "today in New York" reading,
    // which can never name a session that has not happened.
    assert.equal(normalizeEtHour(Number.NaN), US_SESSION_CLOSE_HOUR_ET);
    assert.notEqual(normalizeEtHour(Number.NaN), 0);
  });

  it("holds across the DST boundary (a fixed offset would be wrong half the year)", () => {
    // January: ET is UTC-5, so 01:30Z is 20:30 ET the previous day.
    assert.equal(
      usCalendarDate(Date.parse("2027-01-13T01:30:00Z")),
      "2027-01-12",
    );
    // July: ET is UTC-4, so 01:30Z is 21:30 ET the previous day.
    assert.equal(
      usCalendarDate(Date.parse("2027-07-14T01:30:00Z")),
      "2027-07-13",
    );
  });

  it("a weekend date walks back to Friday", () => {
    // 2026-08-30 is a Sunday in New York at this instant.
    assert.equal(
      resolveUsSessionDate(Date.parse("2026-08-31T01:30:00Z")),
      "2026-08-28",
    );
    // 2026-08-29 is a Saturday.
    assert.equal(
      resolveUsSessionDate(Date.parse("2026-08-30T01:30:00Z")),
      "2026-08-28",
    );
  });

  it("shiftIsoDate walks calendar days across a month boundary", () => {
    assert.equal(shiftIsoDate("2026-09-02", -5), "2026-08-28");
    assert.equal(shiftIsoDate("2026-01-01", -1), "2025-12-31");
  });

  it("utcMidnight is the storage convention, not a local date", () => {
    assert.equal(
      utcMidnight("2026-08-27").toISOString(),
      "2026-08-27T00:00:00.000Z",
    );
  });
});

describe("listing identity — two companies must not become one series", () => {
  it("uses the stored listingId when present", () => {
    const r = resolveCandleListingId({
      symbol: "DOW",
      exchange: "NYSE",
      listingId: "DOW:NYSE:2019-03-20",
    });
    assert.deepEqual(r, {
      listingId: "DOW:NYSE:2019-03-20",
      synthesised: false,
    });
  });

  it("synthesises from the listing start date and REPORTS that it did", () => {
    const r = resolveCandleListingId({
      symbol: "DOW",
      exchange: "NYSE",
      listingId: null,
      listingStartDate: new Date("1972-06-01T00:00:00Z"),
    });
    assert.deepEqual(r, {
      listingId: "DOW:NYSE:1972-06-01",
      synthesised: true,
    });
  });

  it("falls back to `unknown` — matching buildListingId's own null branch", () => {
    const r = resolveCandleListingId({ symbol: "AAPL", exchange: "NASDAQ" });
    assert.equal(r.listingId, "AAPL:NASDAQ:unknown");
    assert.equal(r.synthesised, true);
  });

  it("a blank stored listingId is treated as absent, not written through", () => {
    const r = resolveCandleListingId({
      symbol: "AAPL",
      exchange: "NASDAQ",
      listingId: "   ",
    });
    assert.equal(r.synthesised, true);
  });
});

describe("toCandleRows does NOT pre-sanitise (one sanitizer, and it reports)", () => {
  it("passes a non-finite price straight through to the repository", () => {
    // Pre-filtering here would make CandleWriteResult.droppedNonFinite
    // permanently zero, so a feed that starts emitting garbage becomes
    // INVISIBLE. The repository sanitises AND counts; this must not shadow it.
    const rows = toCandleRows({
      symbol: "AAPL",
      exchange: "NASDAQ",
      listingId: "AAPL:NASDAQ:1980-12-12",
      windows: [],
      bars: [bar({ close: Number.NaN })],
    }).rows;
    assert.equal(rows.length, 1);
    assert.ok(Number.isNaN(rows[0]!.close));
  });

  it("passes a negative volume through as a NUMBER (BigInt(NaN) throws)", () => {
    const rows = toCandleRows({
      symbol: "AAPL",
      exchange: "NASDAQ",
      listingId: "x",
      windows: [],
      bars: [bar({ volume: -5 })],
    }).rows;
    assert.equal(rows[0]!.volume, -5);
  });

  it("drops only a malformed DATE, because `ts` is constructed rather than passed", () => {
    const rows = toCandleRows({
      symbol: "AAPL",
      exchange: "NASDAQ",
      listingId: "x",
      windows: [],
      bars: [bar({ date: "not-a-date" }), bar({ date: "2026-08-27" })],
    }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ts.toISOString(), "2026-08-27T00:00:00.000Z");
  });

  it("stamps the timeframe and the source", () => {
    const rows = toCandleRows({
      symbol: "AAPL",
      exchange: "NASDAQ",
      listingId: "x",
      windows: [],
      bars: [bar()],
    }).rows;
    assert.equal(rows[0]!.timeframe, "D1");
    assert.equal(rows[0]!.source, "TIINGO");
  });
});

describe("MONEY-1617 — toCandleRows files each bar under the window covering it", () => {
  const w = (
    listingId: string,
    start: string,
    end: string | null,
    listingStatus = "ACTIVE",
  ) => ({
    symbol: "RAM",
    exchange: "NASDAQ",
    listingId,
    listingStartDate: new Date(`${start}T00:00:00Z`),
    listingEndDate: end ? new Date(`${end}T00:00:00Z`) : null,
    listingStatus,
  });
  const OLD = w(
    "RAM:NASDAQ:2021-07-09",
    "2021-07-09",
    "2023-03-31",
    "DELISTED",
  );
  const NEW = w("RAM:NASDAQ:2026-06-24", "2026-06-24", null);

  it("a bar in the old window goes to the OLD id with ITS status; a gap bar is dropped and counted", () => {
    const r = toCandleRows({
      symbol: "RAM",
      exchange: "NASDAQ",
      listingId: NEW.listingId,
      listingStatus: "ACTIVE",
      windows: [OLD, NEW],
      bars: [
        bar({ date: "2022-06-01" }),
        bar({ date: "2024-06-03" }),
        bar({ date: "2026-08-27" }),
      ],
    });
    assert.deepEqual(
      r.rows.map((x) => [
        x.ts.toISOString().slice(0, 10),
        x.listingId,
        x.listingStatus,
      ]),
      [
        ["2022-06-01", OLD.listingId, "DELISTED"],
        ["2026-08-27", NEW.listingId, "ACTIVE"],
      ],
    );
    assert.deepEqual(r.dropped, {
      OUTSIDE_EVERY_WINDOW: 1,
      AMBIGUOUS_WINDOW: 0,
    });
  });

  it("no windows at all keeps the pre-MONEY-1617 behaviour: every bar under the fetched id", () => {
    const r = toCandleRows({
      symbol: "RAM",
      exchange: "NASDAQ",
      listingId: NEW.listingId,
      listingStatus: "ACTIVE",
      windows: [],
      bars: [bar({ date: "2022-06-01" })],
    });
    assert.equal(r.rows[0]!.listingId, NEW.listingId);
  });
});

describe("leg (c) — corporate actions derived from bars we already hold", () => {
  it("reads a distribution off divCash", () => {
    const a = detectCorporateActions({
      symbol: "AAPL",
      exchange: "NASDAQ",
      bars: [bar({ divCash: 0.25 })],
    });
    assert.equal(a.length, 1);
    assert.equal(a[0]!.kind, "DIVIDEND");
    assert.equal(a[0]!.date, "2026-08-27");
  });

  it("reads a split off splitFactor, and a split OUTRANKS a same-day dividend", () => {
    const a = detectCorporateActions({
      symbol: "AAPL",
      exchange: "NASDAQ",
      bars: [bar({ splitFactor: 4, divCash: 0.25 })],
    });
    assert.equal(a.length, 1);
    assert.equal(a[0]!.kind, "SPLIT");
    assert.equal(a[0]!.splitFactor, 4);
  });

  it("a reverse split is a split too", () => {
    const a = detectCorporateActions({
      symbol: "X",
      exchange: "NYSE",
      bars: [bar({ splitFactor: 0.1 })],
    });
    assert.equal(a[0]!.kind, "SPLIT");
  });

  it("an ordinary bar produces nothing", () => {
    assert.deepEqual(
      detectCorporateActions({
        symbol: "AAPL",
        exchange: "NASDAQ",
        bars: [bar()],
      }),
      [],
    );
  });

  it("floating-point noise near 1.0 is NOT a nightly split", () => {
    // An exact `!== 1` would invalidate a cache every night forever the first
    // time the feed prints 0.9999999999.
    assert.deepEqual(
      detectCorporateActions({
        symbol: "X",
        exchange: "NYSE",
        bars: [bar({ splitFactor: 1 + 1e-12 })],
      }),
      [],
    );
  });

  it("a non-positive split factor is treated as no split, never a divide-by-zero", () => {
    assert.deepEqual(
      detectCorporateActions({
        symbol: "X",
        exchange: "NYSE",
        bars: [bar({ splitFactor: 0 })],
      }),
      [],
    );
  });

  it("affectedSecurities de-duplicates and preserves order", () => {
    const actions = detectCorporateActions({
      symbol: "AAPL",
      exchange: "NASDAQ",
      bars: [bar({ divCash: 0.2 }), bar({ date: "2026-08-26", divCash: 0.2 })],
    });
    assert.equal(actions.length, 2);
    assert.deepEqual(affectedSecurities(actions), [
      { symbol: "AAPL", exchange: "NASDAQ" },
    ]);
  });
});

describe("MONEY-980 finding 5 — leg (c) invalidated a namespace nothing writes", () => {
  const LOGIC = readRepoFile(
    "workers",
    "src",
    "processors",
    "us-eod-sync-logic.ts",
  );
  const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");

  it("the scan actually read both source files (never a vacuous pass)", () => {
    // A scan over "" passes every `!includes` below while proving nothing. The
    // guard is asserted first so a moved file fails LOUDLY instead of turning
    // the next three cases green for the wrong reason.
    assert.ok(LOGIC.length > 1000, "us-eod-sync-logic.ts not read");
    assert.ok(PROC.length > 1000, "us-eod-sync.ts not read");
  });

  it("no `candles:adj:` key is minted anywhere in this job", () => {
    // The old `adjustedSeriesCachePattern` returned
    // `candles:adj:{exchange}:{symbol}:*`. That string existed in exactly ONE
    // place repo-wide — the function that built it — so `clearCachePattern`
    // deleted 0 keys every night and `caKeysCleared` was structurally 0. The
    // real namespace is the COLD SHARD cache: `candles-cold`, scope `_global`,
    // identifier `candles/{market}/{timeframe}/{symbol}/{year}`.
    for (const [name, src] of [
      ["us-eod-sync-logic.ts", LOGIC],
      ["us-eod-sync.ts", PROC],
    ] as const) {
      const offending = codeOnly(src).filter(([, line]) =>
        line.includes("candles:adj"),
      );
      assert.deepEqual(
        offending,
        [],
        `${name} mints a fabricated candle cache key: ${JSON.stringify(offending)}`,
      );
    }
  });

  it("leg (c) issues no cache eviction at all", () => {
    // Not merely "the pattern is right" — this job cannot address the namespace
    // correctly from here at all: `CandleRepository` exposes no eviction entry
    // point, and two of the four key segments (the `_global` scope and the
    // `:{version}` suffix) are private to `candle-cold-store.ts` and
    // `@usemoney/cache`. Rebuilding the pattern here would be one rule spelled
    // twice, in two packages, free to drift — the defect being fixed, one layer
    // over. So the eviction call is GONE, not corrected.
    for (const [name, src] of [
      ["us-eod-sync.ts", PROC],
      ["us-eod-sync-logic.ts", LOGIC],
    ] as const) {
      const offending = codeOnly(src).filter(([, line]) =>
        line.includes("clearCachePattern"),
      );
      assert.deepEqual(
        offending,
        [],
        `${name} still evicts a namespace it cannot address correctly: ` +
          JSON.stringify(offending),
      );
    }
  });

  it("the reason is a real sentence a run can report, not an empty string", () => {
    // It is written into the job's log line and onto `UsEodSyncResult`, so an
    // operator reading "0 keys cleared" gets WHY instead of inferring drift.
    assert.ok(CA_EVICTION_UNAVAILABLE.length > 80);
    assert.match(CA_EVICTION_UNAVAILABLE, /candles-cold/);
    assert.match(CA_EVICTION_UNAVAILABLE, /CandleRepository/);
  });
});

describe("health is judged PER LEG, on bars RECEIVED", () => {
  it("the baseline is healthy (so every negative case below is meaningful)", () => {
    assert.deepEqual(judgeUsEodHealth(healthy()), {
      ok: true,
      legs: ALL_HEALTHY,
    });
  });

  it("a refusal is named ahead of everything else", () => {
    const v = judgeUsEodHealth(healthy({ accessRefused: true, equityBars: 0 }));
    assert.equal(v.ok, false);
    assert.match(v.reason!, /REFUSED/);
  });

  it("the refusal reason is the CLIENT's text, carried verbatim", () => {
    // `tiingoAuthMessage()` is exported precisely so the wording is one tested
    // declaration. The pure judge cannot call it (this module takes only type
    // imports from core), so the processor carries the string — and the judge
    // must not paraphrase it.
    const detail =
      "Tiingo refused this request with HTTP 403. That is EITHER a rejected " +
      "token OR an endpoint this plan does not cover…";
    const v = judgeUsEodHealth(
      healthy({ accessRefused: true, accessRefusedDetail: detail }),
    );
    assert.equal(v.reason, detail);
  });

  it("never claims to know WHICH 403 it was — finding 1", () => {
    // The two branches this replaces both asserted a fact read off a response
    // BODY the client never had: "403 with a `detail` body" and "403 with an
    // EMPTY body". Every 403 took the second, so a wrong TIINGO_API_KEY_PROD
    // reached the operator as "this is NOT a token problem" — pointing away
    // from the only cause that changes between deploys. The fallback text must
    // name BOTH checks and neither verdict.
    const v = judgeUsEodHealth(healthy({ accessRefused: true }));
    assert.match(v.reason!, /TIINGO_API_KEY/);
    assert.match(v.reason!, /entitlement/i);
    assert.ok(
      !/NOT a token problem/i.test(v.reason!),
      "the client cannot rule the token out, so neither can this",
    );
  });

  it("a rate limit says the chain deliberately did not continue", () => {
    const v = judgeUsEodHealth(healthy({ rateLimited: true }));
    assert.match(v.reason!, /rate-limited/);
  });

  it("an empty US population is NOT reported as an idle night", () => {
    const v = judgeUsEodHealth(
      healthy({
        equitySelected: 0,
        mfSelected: 0,
        equityAttempted: 0,
        equityBars: 0,
        mfAttempted: 0,
        mfBars: 0,
      }),
    );
    assert.equal(v.ok, false);
    assert.match(v.reason!, /NO US INSTRUMENTS SELECTED/);
  });

  it("a BUDGET-TRUNCATED run is not blamed on the instrument sync", () => {
    // `attempted === 0` has three causes and only ONE of them is "the master is
    // empty". Keying the sentence on `attempted` told an operator to go and
    // look at the Tiingo instrument sync when the run had merely run out of
    // clock — a confident, wrong instruction. `selected` separates them.
    const v = judgeUsEodHealth(
      healthy({ equityAttempted: 0, equityBars: 0, mfAttempted: 0, mfBars: 0 }),
    );
    assert.equal(v.legs.equity, "notReached");
    assert.equal(v.legs.mf, "notReached");
    assert.ok(!/NO US INSTRUMENTS SELECTED/.test(v.reason ?? ""));
    assert.match(v.reason!, /wall clock|request budget/);
  });

  it("a dark NAV leg is named even while the EOD leg writes 70,000 bars", () => {
    // The MONEY-1255 lesson: a TOTAL hides a dead leg.
    const v = judgeUsEodHealth(healthy({ mfBars: 0 }));
    assert.equal(v.ok, false);
    assert.match(v.reason!, /NAV leg dark/);
  });

  it("a dark EOD leg is named", () => {
    assert.match(
      judgeUsEodHealth(healthy({ equityBars: 0 })).reason!,
      /EOD leg dark/,
    );
  });

  it("a dark FX leg is named", () => {
    assert.match(
      judgeUsEodHealth(healthy({ fxWritten: 0 })).reason!,
      /FX leg dark/,
    );
  });

  it("a skipped FX leg is not a dark one", () => {
    assert.deepEqual(
      judgeUsEodHealth(healthy({ fxAttempted: 0, fxWritten: 0 })),
      { ok: true, legs: ALL_HEALTHY },
    );
  });

  it("legIsDark keys on RECEIVED, so idempotency is not mistaken for death", () => {
    assert.equal(legIsDark(800, 0), true);
    assert.equal(legIsDark(800, 4000), false);
    assert.equal(legIsDark(0, 0), false);
  });
});

describe("MONEY-1250 — `selected` means WORK OWED A WRITE", () => {
  it("an idempotent re-read reports 0 owed, so the zero-write monitor stays silent", () => {
    // The night after a US market holiday: the whole window is already stored,
    // so `putCandles` PRESERVES every bar and owes nothing. A `selected` that
    // counted the page would read 1000-0 and page somebody ~10 times a year.
    const selected = computeSelected(
      selectedInput({
        equityOwed: 0,
        equityAttempted: 800,
        equityBars: 4000,
        mfOwed: 0,
        mfAttempted: 200,
        mfBars: 1000,
        fxAttempted: 1,
      }),
    );
    assert.equal(selected, 1, "only the FX row was owed a write");
  });

  it("a DARK leg contributes the symbols it asked for, so the monitor DOES fire", () => {
    const selected = computeSelected(
      selectedInput({
        equityOwed: 0,
        equityAttempted: 800,
        equityBars: 0,
        mfOwed: 0,
        mfAttempted: 200,
        mfBars: 1000,
        fxAttempted: 1,
      }),
    );
    assert.equal(selected, 801);
  });

  it("a normal night's owed bars pass through unchanged", () => {
    const selected = computeSelected(
      selectedInput({
        equityOwed: 800,
        equityAttempted: 800,
        equityBars: 4000,
        mfOwed: 200,
        mfAttempted: 200,
        mfBars: 1000,
        fxAttempted: 1,
      }),
    );
    assert.equal(selected, 1001);
  });

  it("both legs dark adds both", () => {
    const selected = computeSelected(
      selectedInput({
        equityOwed: 0,
        equityAttempted: 800,
        equityBars: 0,
        mfOwed: 0,
        mfAttempted: 200,
        mfBars: 0,
        fxAttempted: 0,
      }),
    );
    assert.equal(selected, 1000);
  });
});

describe("MONEY-980 finding 2 — a leg with an EMPTY POPULATION is not healthy", () => {
  it("NEVER reports an empty-population leg as healthy", () => {
    // THE REGRESSION TEST FOR THE DEFECT ITSELF.
    //
    // `buildUsEodWhere("MF")` needs instrumentType in {MF, MUTUAL_FUND} on a
    // `market:"US"` row, and the only writer of US rows filters funds out
    // upstream (TIINGO_US_ASSET_TYPES = {Stock, ETF}, TIINGO_US_EXCHANGES
    // excludes NMFQS, usInstrumentTypeFor returns EQUITY|ETF). So `mfAttempted`
    // is 0 every night — and `legIsDark` requires `attempted > 0`, so the
    // permanently-dead leg read as HEALTHY while being advertised in the topic
    // doc, the scheduler description, the monitor comment and CLAUDE.md.
    const v = judgeUsEodHealth(
      healthy({ mfSelected: 0, mfAttempted: 0, mfBars: 0 }),
    );
    assert.notEqual(
      v.legs.mf,
      "healthy",
      "a leg that selected NOTHING has proved nothing and must never be healthy",
    );
    assert.equal(v.legs.mf, "noPopulation");
  });

  it("says so IN THE OUTCOME — the empty leg is never silence", () => {
    // `reason` is what `processUsEodSync` forwards as `skippedReason` on
    // `reportJobOutcome`, so this is the field an operator actually sees.
    const v = judgeUsEodHealth(
      healthy({ mfSelected: 0, mfAttempted: 0, mfBars: 0 }),
    );
    assert.ok(v.reason, "an empty-population leg must produce a sentence");
    assert.match(v.reason!, /NAV leg/);
    assert.match(v.reason!, /EMPTY POPULATION/);
  });

  it("is a DIFFERENT sentence from 'this leg failed'", () => {
    const empty = judgeUsEodHealth(
      healthy({ mfSelected: 0, mfAttempted: 0, mfBars: 0 }),
    );
    const dark = judgeUsEodHealth(healthy({ mfBars: 0 }));
    assert.ok(!/dark/i.test(empty.reason!), "an empty leg is not a dark leg");
    assert.match(dark.reason!, /NAV leg dark/);
    assert.notEqual(empty.reason, dark.reason);
  });

  it("does not FAIL the run — a nightly page for a known emptiness gets muted", () => {
    const v = judgeUsEodHealth(
      healthy({ mfSelected: 0, mfAttempted: 0, mfBars: 0 }),
    );
    assert.equal(v.ok, true);
    // ...but the equity leg going empty at the same time IS a failure: that is
    // "the instrument sync has never populated market:'US'".
    const both = judgeUsEodHealth(
      healthy({
        equitySelected: 0,
        equityAttempted: 0,
        equityBars: 0,
        mfSelected: 0,
        mfAttempted: 0,
        mfBars: 0,
      }),
    );
    assert.equal(both.ok, false);
  });

  it("the SAME rule keeps working the day the population arrives", () => {
    // The requirement that makes this a fix rather than an exemption: nothing
    // here is special-cased to "MF is empty forever". One fund row and the leg
    // is judged on attempted-vs-received exactly like leg (a).
    const dark = judgeUsEodHealth(
      healthy({ mfSelected: 5, mfAttempted: 5, mfBars: 0 }),
    );
    assert.equal(dark.legs.mf, "dark");
    assert.equal(dark.ok, false);

    const live = judgeUsEodHealth(
      healthy({ mfSelected: 5, mfAttempted: 5, mfBars: 60 }),
    );
    assert.equal(live.legs.mf, "healthy");
    assert.equal(live.ok, true);
    assert.equal(live.reason, undefined);
  });

  it("a leg whose query NEVER RAN is not an empty population", () => {
    // Reading `null` as 0 would assert "no rows of that type exist" from a
    // query nobody issued — a fail-open cached as a fact, the shape this repo
    // has a standing rule against. Leg (b) is skipped outright on a circuit
    // break, so this is the live path, not a hypothetical.
    const v = judgeUsEodHealth(
      healthy({ mfSelected: null, mfAttempted: 0, mfBars: 0 }),
    );
    assert.equal(v.legs.mf, "notQueried");
    assert.notEqual(v.legs.mf, "noPopulation");
    assert.notEqual(v.legs.mf, "healthy");
  });

  it("judgeLegVerdict's five states are exhaustive and distinct", () => {
    const cases: Array<[UsEodLegVerdict, number | null, number, number]> = [
      ["notQueried", null, 0, 0],
      ["noPopulation", 0, 0, 0],
      ["notReached", 800, 0, 0],
      ["dark", 800, 800, 0],
      ["healthy", 800, 800, 4000],
    ];
    for (const [expected, selected, attempted, barsReceived] of cases) {
      assert.equal(
        judgeLegVerdict({ selected, attempted, barsReceived }),
        expected,
        `selected=${selected} attempted=${attempted} bars=${barsReceived}`,
      );
    }
    assert.equal(new Set(cases.map(([v]) => v)).size, cases.length);
  });

  it("`dark` has ONE definition — judgeLegVerdict delegates to legIsDark", () => {
    // Two spellings of "dark" would be free to drift, which is the MONEY-1255
    // shape. Asserted over a grid rather than by inspection.
    for (const attempted of [0, 1, 800]) {
      for (const bars of [0, 1, 4000]) {
        const verdict = judgeLegVerdict({
          selected: 800,
          attempted,
          barsReceived: bars,
        });
        assert.equal(
          verdict === "dark",
          legIsDark(attempted, bars),
          `attempted=${attempted} bars=${bars}`,
        );
      }
    }
  });

  it("the run-level failures still win, and still carry the leg verdicts", () => {
    // Ordering is diagnostic: a rate limit explains the WHOLE run, so it is
    // named first — but the per-leg state must not vanish with it.
    const v = judgeUsEodHealth(
      healthy({
        rateLimited: true,
        mfSelected: null,
        mfAttempted: 0,
        mfBars: 0,
      }),
    );
    assert.equal(v.ok, false);
    assert.match(v.reason!, /rate-limited/);
    assert.equal(v.legs.mf, "notQueried");
    assert.equal(v.legs.equity, "healthy");
  });
});

describe("MONEY-980 finding 8 — the request budget counts requests ISSUED", () => {
  it("a call that THREW is charged the client's whole retry ladder", () => {
    // `state.requestsIssued++` used to sit AFTER `fetchTiingoEod` returned, so
    // the catch charged nothing — while the client had already paced and issued
    // up to MAX_RETRIES requests, every one against the same unobservable
    // quota. A night of 5xx could issue several times `requestBudget` while
    // `stoppedOnQuota` never fired, defeating the one guard whose stated job is
    // "stopping rather than discovering the ceiling as a 429".
    assert.equal(requestsSpentByCall(true, 4), 4);
    assert.equal(requestsSpentByCall(true, 7), 7);
  });

  it("a call that RETURNED is charged its floor of one", () => {
    assert.equal(requestsSpentByCall(false, 4), 1);
  });

  it("no call is ever free, whatever the caller claims about the ladder", () => {
    // 0 is the DEFECT this function exists to remove, so a garbage ladder
    // length must not be able to reintroduce it through the back door.
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.4]) {
      assert.equal(requestsSpentByCall(true, bad), 1, `ladder=${bad}`);
    }
    assert.equal(requestsSpentByCall(false, Number.NaN), 1);
  });

  it("the ladder length is IMPORTED from the client, never restated", () => {
    // `tiingo-client.ts` exports `MAX_RETRIES` for exactly this reason. A copy
    // of that number in the worker would keep passing while the client's ladder
    // moved underneath it — the MONEY-1255 shape — so the processor imports the
    // real symbol and the pure helper takes it as an argument.
    const proc = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");
    assert.ok(proc.length > 1000, "us-eod-sync.ts not read");
    assert.match(
      proc,
      /import \{[\s\S]*?\bMAX_RETRIES\b[\s\S]*?\} from "@usemoney\/core\/market-data\/tiingo\/tiingo-client";/,
      "MAX_RETRIES must come from the client that owns the ladder",
    );
    assert.ok(
      proc.includes("requestsSpentByCall(callThrew, MAX_RETRIES)"),
      "the charge must be sized by the client's own constant",
    );
    const logic = readRepoFile(
      "workers",
      "src",
      "processors",
      "us-eod-sync-logic.ts",
    );
    assert.ok(logic.length > 1000, "us-eod-sync-logic.ts not read");
    assert.ok(
      !/=\s*4;\s*\/\/.*ladder/i.test(logic) &&
        !logic.includes("TIINGO_MAX_ATTEMPTS_PER_CALL"),
      "the worker must not carry its own copy of the ladder length",
    );
  });

  it("the processor charges from a `finally`, never after a successful call", () => {
    const proc = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");
    assert.ok(proc.length > 1000, "us-eod-sync.ts not read");
    assert.ok(
      !/state\.requestsIssued\+\+/.test(proc),
      "a bare increment counts only the calls that SUCCEEDED — the defect",
    );
    assert.ok(
      proc.includes(
        "state.requestsIssued += requestsSpentByCall(callThrew, MAX_RETRIES)",
      ),
      "the charge must be applied once per call, from the finally",
    );
  });
});

// ===========================================================================
// LEG (e) - the forward corporate-actions CALENDAR (MONEY-1263)
// ===========================================================================

describe("MONEY-1263 - leg (c) did NOT move, and leg (e) is a CALENDAR", () => {
  const LOGIC = readRepoFile(
    "workers",
    "src",
    "processors",
    "us-eod-sync-logic.ts",
  );
  const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");

  it("the scan actually read both source files (never a vacuous pass)", () => {
    assert.ok(LOGIC.length > 1000, "us-eod-sync-logic.ts not read");
    assert.ok(PROC.length > 1000, "us-eod-sync.ts not read");
  });

  it("the measurement is stated with its numbers, not as a claim", () => {
    // The old plan was "when beta access lands, switch to the real endpoints".
    // Beta access landed and the measurement says switching buys nothing, so
    // the constant has to carry the EVIDENCE - otherwise the next reader finds
    // a derived path plus a granted entitlement and re-does the switch.
    assert.match(CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE, /504 events/);
    assert.match(CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE, /splitStatus/);
    assert.match(CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE, /67 splits/);
    assert.match(CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE, /2,035 distributions/);
    assert.match(
      CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE,
      /Candle\.divCash\/splitFactor/,
    );
  });

  it("leg (c) still reads bars, and reads NOTHING from leg (e)", () => {
    // THE SEPARATION, checked rather than asserted in prose. The two sources
    // agreed on 504 of 504 events, so a double-count would be invisible: every
    // row leg (e) fetched is already in the bar leg (c) reads.
    //
    // An earlier version of this case counted the call sites and asserted
    // `bars: res.bars` appeared SOMEWHERE in the file. Mutation testing killed
    // it: spreading the calendar's deduped rows into the same call left both
    // assertions true. What has to be checked is the WHOLE argument, so the
    // scan below reads the call's own braces and requires exactly the three
    // keys — and no spread, which is the shape any future merge would take.
    const calls = codeOnly(PROC).filter(([, line]) =>
      line.includes("detectCorporateActions("),
    );
    assert.equal(
      calls.length,
      1,
      `leg (c) must have exactly one call site: ${JSON.stringify(calls)}`,
    );

    const args = callArgs(PROC, "detectCorporateActions(");
    assert.ok(args.length > 10, "the call's arguments were not extracted");
    assert.deepEqual(
      argKeys(args).sort(),
      ["bars", "exchange", "symbol"],
      `leg (c) must be fed exactly symbol/exchange/bars, got: ${args}`,
    );
    assert.match(
      args,
      /bars:\s*res\.bars/,
      "the bars must be the ones this symbol's fetch returned",
    );
    assert.ok(
      !args.includes("..."),
      "nothing may be SPREAD into leg (c)'s input — that is how a calendar " +
        "row reaches the adjustment path while every other assertion still holds",
    );

    // The candle writer gets the same treatment: `toCandleRows` is the other
    // door into the adjusted series.
    const candleArgs = callArgs(PROC, "toCandleRows({");
    assert.ok(candleArgs.length > 10, "toCandleRows arguments not extracted");
    assert.deepEqual(
      argKeys(candleArgs).sort(),
      // MONEY-1617 added `windows` — the symbol's master windows on this venue,
      // which the clip files each bar under.
      ["bars", "exchange", "listingId", "listingStatus", "symbol", "windows"],
      `the candle writer must be fed exactly six keys, got: ${candleArgs}`,
    );
    // The chain is now TWO hops — the per-symbol loop calls
    // `writeEquityCandles(state, row, res.bars)` and that helper calls
    // `toCandleRows({ ..., bars })`. Both are asserted, because checking only
    // the inner one would let a future edit substitute a different array at the
    // call site while this assertion stayed green.
    assert.match(candleArgs, /\bbars,/);
    assert.ok(!candleArgs.includes("..."), "nothing may be spread into it");

    const writerCalls = codeOnly(PROC).filter(([, line]) =>
      line.includes("writeEquityCandles("),
    );
    const invocations = writerCalls.filter(
      ([, line]) => !line.includes("async function"),
    );
    assert.equal(
      invocations.length,
      1,
      `writeEquityCandles must have exactly one call site: ${JSON.stringify(invocations)}`,
    );
    assert.match(
      invocations[0]![1],
      // MONEY-1291 added a fourth argument — the INJECTED `putCandles`, whose
      // default is the real repository. The bars term is what this asserts and
      // it is unchanged; the trailing comma pins that nothing was substituted
      // for `res.bars` by widening the match.
      /writeEquityCandles\(state, row, res\.bars,/,
      "the candle writer must be fed the bars THIS symbol's fetch returned",
    );

    // Leg (b) is now a DIFFERENT table, and the same rule applies to it: a NAV
    // must be shaped from this fund's own response and nothing else.
    const navCalls = codeOnly(PROC).filter(
      ([, line]) =>
        line.includes("writeFundNavs(") && !line.includes("async function"),
    );
    assert.equal(navCalls.length, 1, "writeFundNavs must have one call site");
    assert.match(navCalls[0]![1], /writeFundNavs\(state, row, res\.bars,/);
  });

  it("`us_corporate_actions` is WRITTEN by this job and never READ by it", () => {
    // The falsifiable half of "read by nothing in this job". A read appearing
    // here is the first step of wiring the calendar into the adjustment path,
    // and it would compile perfectly.
    const reads = codeOnly(PROC).filter(([, line]) =>
      /usCorporateAction\.(findMany|findFirst|findUnique|aggregate|count|groupBy)/.test(
        line,
      ),
    );
    assert.deepEqual(
      reads,
      [],
      `leg (e) must not read its own table back: ${JSON.stringify(reads)}`,
    );
    assert.ok(
      PROC.includes("prisma.usCorporateAction.upsert("),
      "leg (e) must actually write the table",
    );
  });

  /**
   * VALUE comparisons on a split factor, excluding PRESENCE checks.
   *
   * `splitFactor !== undefined` is a presence test on an optional field, not a
   * float test, and leg (b) needs one: `UsFundNavRow.splitFactor` is written
   * ONLY for a real split, so the writer has to ask whether the key is there.
   * `undefined` and `null` are the only right-hand sides exempted — everything
   * else, `=== 1` and `!== 1` and `=== 7` included, still fails.
   *
   * Narrowed rather than deleted, and narrowed with a proof: the case below
   * asserts that this regex STILL fires on the four float comparisons it
   * exists for. A loosened guard that quietly matches nothing is the same
   * defect as no guard, and harder to see.
   */
  const SPLIT_VALUE_COMPARISON =
    // TWO backtracking holes had to be closed here, and the ceiling case below
    // is what found both — the first draft of this regex rejected the exact
    // form it was narrowed to allow.
    //
    // `(?!=)` after the operator: without it, `[=!]==?` matches just `!=` of a
    // `!==`, leaving `= undefined` for the rest, so the exemption sees `=`.
    //
    // The whitespace lives INSIDE the exemption lookahead, not before it: a
    // separate greedy `\s*` gives its space back on failure, after which
    // `(?!undefined)` is evaluated against " undefined" — which does not start
    // with `undefined`, so the exemption silently stopped applying.
    /splitFactor\s*[=!]==?(?!=)(?!\s*(?:undefined|null)\b)/;

  it("the narrowed split-factor guard still CATCHES float comparisons", () => {
    // The ceiling for the assertion below. Without it, a typo in the regex
    // would make the real test vacuous and nothing would say so.
    for (const bad of [
      "if (splitFactor === 1) {",
      "if (splitFactor !== 1) return;",
      "const isSeven = bar.splitFactor === 7;",
      "while (splitFactor == 1.0) {",
      // No spaces — a formatter or a minified line must not slip past.
      "if (x.splitFactor!==1){",
    ]) {
      assert.equal(
        SPLIT_VALUE_COMPARISON.test(bad),
        true,
        `the guard must still reject: ${bad}`,
      );
    }
    // And it must NOT reject the two presence forms the sparse column needs.
    for (const ok of [
      "...(splitFactor !== undefined ? { splitFactor } : {}),",
      "nav.splitFactor !== undefined ? { set: nav.splitFactor } : { unset: true },",
      "if (splitFactor === undefined) return;",
      "if (row.splitFactor === null) throw new Error();",
    ]) {
      assert.equal(
        SPLIT_VALUE_COMPARISON.test(ok),
        false,
        `the guard must allow the presence form: ${ok}`,
      );
    }
  });

  it("NOTHING equality-tests a split factor VALUE", () => {
    // AAPL's 2014 7-for-1 is stored upstream as 7.000007000007001 and UNTY's as
    // 1.09999989. `=== 7`, `!== 1` and a toFixed round-trip are all wrong for
    // real rows in the live data. Both legs that ask "is this a split" go
    // through ONE epsilon — `isRealSplit`, which leg (c)'s detector and leg
    // (b)'s shaper now share rather than spelling twice in one file.
    for (const [name, srcText] of [
      ["us-eod-sync-logic.ts", LOGIC],
      ["us-eod-sync.ts", PROC],
    ] as const) {
      const offending = codeOnly(srcText).filter(([, line]) =>
        SPLIT_VALUE_COMPARISON.test(line),
      );
      assert.deepEqual(
        offending,
        [],
        `${name} equality-tests a split factor: ${JSON.stringify(offending)}`,
      );
    }
    // The epsilon is declared ONCE and both consumers reach it through the
    // shared helper — a second `Math.abs(x - 1) >` in this file would be the
    // same rule stated twice, free to drift.
    // The threshold now lives in `@usemoney/core/market-data/candles/candle-logic`
    // and is IMPORTED, because there are TWO writers of the sparse column — this
    // nightly leg and `scripts/jobs/tiingo-us-backfill.ts`. A local re-declaration
    // here would be the same rule stated twice and free to drift, and on a SPARSE
    // column drift is not a rounding difference: it is a disagreement about
    // whether the field exists at all.
    assert.equal(
      (LOGIC.match(/const SPLIT_EPSILON/g) ?? []).length,
      0,
      "the epsilon must NOT be re-declared here — import it from core",
    );
    assert.match(
      LOGIC,
      /import \{ isRealSplit \} from "@usemoney\/core\/market-data\/candles\/candle-logic"/,
      "isRealSplit must come from core, not a local copy",
    );
    assert.equal(
      (LOGIC.match(/Math\.abs\([^)]*- 1\)/g) ?? []).length,
      0,
      "no epsilon comparison may be open-coded in this module",
    );
  });

  it("NOTHING filters a distribution with `!= null`", () => {
    // `distribution` is nullable AND separately zeroable, and the two are
    // different things: AAPL 2022-12-23 is a genuine 0.0 with payment, record
    // and declaration dates - a real announced event carrying no cash. A
    // `!= null` test calls it a dividend.
    for (const [name, srcText] of [
      ["us-eod-sync-logic.ts", LOGIC],
      ["us-eod-sync.ts", PROC],
    ] as const) {
      const offending = codeOnly(srcText).filter(([, line]) =>
        /distribution\s*[!=]==?\s*null/.test(line),
      );
      assert.deepEqual(
        offending,
        [],
        `${name} filters a distribution on nullness: ${JSON.stringify(offending)}`,
      );
    }
    assert.ok(
      PROC.includes("isCashDistribution(row.distribution)"),
      "the cash count must go through the `> 0` predicate",
    );
  });

  it("a genuine 0.0 distribution is NOT cash, and NOT absent either", () => {
    assert.equal(isCashDistribution(0), false, "0.0 carries no cash");
    assert.equal(isCashDistribution(0.26), true);
    assert.equal(isCashDistribution(null), false);
    assert.equal(isCashDistribution(undefined), false);
    // Non-finite is the money poison this repo has a standing rule about.
    assert.equal(isCashDistribution(Number.NaN), false);
    assert.equal(isCashDistribution(Number.POSITIVE_INFINITY), false);
    // A negative distribution is not cash either - it is a feed defect.
    assert.equal(isCashDistribution(-1), false);
  });
});

describe("leg (e) - which ex-date the run asks about", () => {
  it("targets the NEXT trading day, so the calendar is FORWARD-dated", () => {
    // The whole reason the leg exists: a price bar only exists after its
    // session, so leg (c) can never say what is about to happen.
    assert.equal(resolveCalendarExDate("2026-08-27"), "2026-08-28"); // Thu -> Fri
    assert.equal(resolveCalendarExDate("2026-08-25"), "2026-08-26"); // Tue -> Wed
  });

  it("Saturday's run targets MONDAY - the weekend skip is what closes the gap", () => {
    // THE CASE THAT MAKES THE COVERAGE COMPLETE. The cron is `2-6` IST, and
    // `resolveUsSessionDate` walks a weekend back to Friday, so Saturday's run
    // carries session = Friday. Without the weekend skip it would ask about
    // Saturday - a day with no ex-dates, ever - and Monday would never be asked
    // about by anyone.
    assert.equal(resolveCalendarExDate("2026-08-28"), "2026-08-31"); // Fri -> Mon
    assert.equal(nextTradingDayAfter("2026-08-29"), "2026-08-31"); // Sat -> Mon
    assert.equal(nextTradingDayAfter("2026-08-30"), "2026-08-31"); // Sun -> Mon
  });

  it("a week of IST runs covers every trading day EXACTLY once", () => {
    // No gaps and no overlap, without a cursor, a marker or any cross-run
    // state. If this drifts, some trading day's ex-dates are either never
    // fetched or fetched twice - and one of those is silent.
    const sessions = [
      "2026-08-24", // Mon, seen by Tuesday's run
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28", // Fri, seen by Saturday's run
    ];
    const targets = sessions.map(resolveCalendarExDate);
    assert.deepEqual(targets, [
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-31",
    ]);
    assert.equal(
      new Set(targets).size,
      targets.length,
      "no trading day may be asked about twice",
    );
  });

  it("never names a weekend, walked across a whole year", () => {
    let date = "2026-01-01";
    for (let i = 0; i < 365; i++) {
      const next = nextTradingDayAfter(date);
      const dow = new Date(`${next}T00:00:00.000Z`).getUTCDay();
      assert.ok(
        dow !== 0 && dow !== 6,
        `nextTradingDayAfter(${date}) produced the weekend day ${next}`,
      );
      assert.ok(next > date, "the walk must move forward");
      date = shiftIsoDate(date, 1);
    }
  });

  it("crosses a month and a year boundary", () => {
    assert.equal(nextTradingDayAfter("2026-01-30"), "2026-02-02"); // Fri -> Mon
    assert.equal(nextTradingDayAfter("2026-12-31"), "2027-01-01");
  });
});

describe("leg (e) - the listing-window index (never the wrong company)", () => {
  const dow1 = {
    symbol: "DOW",
    listingId: "DOW:NYSE:1972-01-01",
    listingStartDate: new Date("1972-01-01T00:00:00Z"),
    listingEndDate: new Date("2017-08-31T00:00:00Z"),
  };
  const dow2 = {
    symbol: "DOW",
    listingId: "DOW:NYSE:2019-04-02",
    listingStartDate: new Date("2019-04-02T00:00:00Z"),
    listingEndDate: null,
  };

  it("the OCCUPANCY WINDOW disambiguates a recycled ticker", () => {
    // Tiingo's master carries TWO NYSE rows for `DOW` - Dow Chemical to 2017
    // and Dow Inc. from 2019 - and 834 delisted US rows share a ticker with a
    // live one. A forward-dated ex-date falls inside exactly one of them, and
    // that is the whole disambiguation mechanism.
    const index = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [dow1, dow2],
    });
    assert.equal(index.get("DOW")?.listingId, "DOW:NYSE:2019-04-02");
  });

  it("an ex-date inside the DELISTED window picks the delisted one", () => {
    // The mirror image, and the reason the test above is not just "the second
    // row wins". Order is irrelevant; the window decides.
    const index = buildListingWindowIndex({
      exDate: "2005-06-01",
      rows: [dow2, dow1],
    });
    assert.equal(index.get("DOW")?.listingId, "DOW:NYSE:1972-01-01");
  });

  it("an ex-date in NEITHER window omits the symbol entirely", () => {
    // 2018 falls in the gap between the two occupants. `listingId` stays null,
    // which is the schema's own documented state for "a corporate action can
    // arrive for a security we do not carry".
    const index = buildListingWindowIndex({
      exDate: "2018-06-01",
      rows: [dow1, dow2],
    });
    assert.equal(index.has("DOW"), false);
  });

  it("TWO covering windows omit the symbol, never pick by iteration order", () => {
    // THE MUTATION THIS EXISTS TO KILL. Two live windows over one ticker is a
    // master defect, and resolving it by taking the first would splice a
    // corporate action into the wrong company's history - silently, plausibly,
    // and with nothing downstream able to tell.
    const index = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [dow2, { ...dow2, listingId: "DOW:NASDAQ:2019-04-02" }],
    });
    assert.equal(
      index.has("DOW"),
      false,
      "an ambiguous ticker must resolve to NO listing, not to the first one",
    );
  });

  it("a row with no listingId is not a candidate at all", () => {
    // It cannot answer the question, so it must not make the answer ambiguous.
    const index = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [{ ...dow2, listingId: null }, dow2],
    });
    assert.equal(index.get("DOW")?.listingId, "DOW:NYSE:2019-04-02");
    const blank = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [{ ...dow2, listingId: "   " }],
    });
    assert.equal(blank.size, 0);
  });

  it("keys UPPERCASE, because the API returns `aapl` and the master holds `AAPL`", () => {
    // `toUsCorporateActionRows` looks the map up by `ticker.toUpperCase()`. A
    // lowercase key here would miss every row and every `listingId` would be
    // null - with no error, and with the table looking perfectly populated.
    const index = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [
        {
          symbol: "aapl",
          listingId: "AAPL:NASDAQ:1980-12-12",
          listingStartDate: new Date("1980-12-12T00:00:00Z"),
          listingEndDate: null,
        },
      ],
    });
    assert.equal(index.get("AAPL")?.listingId, "AAPL:NASDAQ:1980-12-12");
  });

  it("an OPEN bound narrows nothing, and an Invalid Date reads as open", () => {
    // The master leaves both bounds blank on some rows. An Invalid Date is the
    // hazard: `toISOString()` THROWS on one, and a throw here would cost the
    // whole leg rather than one row.
    const index = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [
        {
          symbol: "OPEN",
          listingId: "OPEN:NASDAQ:unknown",
          listingStartDate: new Date("nonsense"),
          listingEndDate: null,
        },
      ],
    });
    assert.equal(index.get("OPEN")?.listingId, "OPEN:NASDAQ:unknown");
    assert.equal(index.get("OPEN")?.listingStartDate, null);
  });

  it("agrees with the client's own resolveListingId - one rule, one home", () => {
    // The index is only ever right if its containment test IS the one
    // `toUsCorporateActionRows` will apply. Asserted against the real function
    // rather than against a restatement of it.
    const index = buildListingWindowIndex({
      exDate: "2026-08-28",
      rows: [dow1, dow2],
    });
    const window = index.get("DOW")!;
    assert.equal(resolveListingId("2026-08-28", window), "DOW:NYSE:2019-04-02");
    assert.equal(resolveListingId("2018-06-01", window), null);
  });

  it("an empty master produces an empty index rather than throwing", () => {
    assert.equal(
      buildListingWindowIndex({ exDate: "2026-08-28", rows: [] }).size,
      0,
    );
  });
});

describe("leg (e) - health, and the ~9 holiday nights it pays for", () => {
  it("notQueried / notReached / dark / healthy, and nothing else", () => {
    assert.equal(
      judgeCalendarLegVerdict({ attempted: null, rowsReceived: 0 }),
      "notQueried",
    );
    assert.equal(
      judgeCalendarLegVerdict({ attempted: 0, rowsReceived: 0 }),
      "notReached",
    );
    assert.equal(
      judgeCalendarLegVerdict({ attempted: 2, rowsReceived: 0 }),
      "dark",
    );
    assert.equal(
      judgeCalendarLegVerdict({ attempted: 2, rowsReceived: 214 }),
      "healthy",
    );
  });

  it("NEVER returns noPopulation - the state is unreachable, and checked", () => {
    // The claim in the doc, made falsifiable. Leg (e) has no local population
    // to be empty: the routes are market-wide and the table accepts a row for a
    // security we do not carry. A branch returning `noPopulation` would be dead
    // code that reads as coverage.
    const produced = new Set<UsEodLegVerdict>();
    for (const attempted of [null, 0, 1, 2, 99]) {
      for (const rowsReceived of [0, 1, 6482]) {
        produced.add(judgeCalendarLegVerdict({ attempted, rowsReceived }));
      }
    }
    assert.deepEqual(
      [...produced].sort(),
      ["dark", "healthy", "notQueried", "notReached"],
      "leg (e) must produce exactly four verdicts",
    );
  });

  it("a dark calendar FAILS the run and names the holiday FIRST", () => {
    // A whole-market feed allowed to return zero without comment is the reading
    // that hid Tickertape's 403 for five months. It fires on ~9 US market
    // holidays a year, and the alarm has to carry its own explanation or it
    // gets muted - which would remove the only signal on a genuinely dead route.
    const v = judgeUsEodHealth(healthy({ caRows: 0 }));
    assert.equal(v.ok, false);
    assert.equal(v.legs.ca, "dark");
    assert.match(v.reason!, /CA CALENDAR leg dark/);
    assert.match(v.reason!, /HOLIDAY/);
    assert.match(v.reason!, /100-400/);
  });

  it("a calendar leg that never ran is UNKNOWN, not healthy and not empty", () => {
    const v = judgeUsEodHealth(healthy({ caAttempted: null, caRows: 0 }));
    assert.equal(v.legs.ca, "notQueried");
    assert.equal(v.ok, true, "an unknown leg is not itself a run failure");
    assert.match(v.reason!, /CA CALENDAR leg never ran/);
    assert.match(v.reason!, /UNKNOWN, not healthy/);
  });

  it("a budget-truncated calendar leg says the day needs a REPAIR", () => {
    // Unlike the price legs, whose rotation re-offers a skipped row on the next
    // link, this leg asks about a given ex-date only on the night before it.
    const v = judgeUsEodHealth(healthy({ caAttempted: 0, caRows: 0 }));
    assert.equal(v.legs.ca, "notReached");
    assert.match(v.reason!, /does not\s+re-offer|day-walk repair/);
  });

  it("a dark PRICE leg still outranks the calendar - one sentence, the big one", () => {
    const v = judgeUsEodHealth(healthy({ equityBars: 0, caRows: 0 }));
    assert.match(v.reason!, /EOD leg dark/);
    assert.ok(
      !/CA CALENDAR leg dark/.test(v.reason!),
      "the run reports its worst failure, not all four symptoms",
    );
    // ...but the LEG's own verdict is still on the result, so nothing is lost.
    assert.equal(v.legs.ca, "dark");
  });
});

// ===========================================================================
// LEG (f) - US news (MONEY-1264)
// ===========================================================================

// ===========================================================================
// SECONDARY REFUSALS, BUDGETS AND THE JOB-OUTCOME COUNTER
// ===========================================================================

describe("a 403 on a secondary endpoint, with the price legs as a CONTROL", () => {
  it("exonerates the token when /tiingo/daily answered on the same one", () => {
    // MONEY-980 finding 1 established that a 403 in isolation cannot be
    // classified: the two causes differ only in a response body the archive
    // seam throws away. Legs (e) and (f) are NOT in isolation - they run after
    // the price legs, against the same token, on a different endpoint family.
    // That makes "entitlement" an observation rather than a guess.
    const text = describeSecondaryRefusal({
      endpointFamily: "corporate-actions",
      priceLegsSawBars: true,
      detail: null,
    });
    assert.match(text, /ENTITLEMENT refusal/);
    assert.match(text, /not\s+TIINGO_API_KEY/);
    assert.match(text, /same token/i);
  });

  it("claims NOTHING when the price legs received no bars", () => {
    // No control, so the honest answer is the old one: both causes, both
    // checks, neither ruled out. Claiming entitlement here would repeat finding
    // 1 exactly - a confident sentence derived from evidence nobody had.
    const text = describeSecondaryRefusal({
      endpointFamily: "news",
      priceLegsSawBars: false,
      detail: null,
    });
    assert.match(text, /NO\s+control/);
    assert.match(text, /TIINGO_API_KEY/);
    assert.match(text, /entitlement/);
    assert.ok(
      !/ENTITLEMENT refusal/.test(text),
      "without a control the run must not name one cause",
    );
  });

  it("carries the client's own message verbatim when there is one", () => {
    const detail = "Tiingo refused this request with HTTP 403.";
    assert.ok(
      describeSecondaryRefusal({
        endpointFamily: "news",
        priceLegsSawBars: true,
        detail,
      }).includes(detail),
    );
  });

  it("judgeUsEodHealth uses the control, per endpoint family", () => {
    const withBars = judgeUsEodHealth(healthy({ caRefused: true }));
    assert.equal(withBars.ok, false);
    assert.match(withBars.reason!, /corporate-actions/);
    assert.match(withBars.reason!, /ENTITLEMENT refusal/);

    const withoutBars = judgeUsEodHealth(
      healthy({
        caRefused: true,
        equityBars: 0,
        mfBars: 0,
        equityAttempted: 0,
        mfAttempted: 0,
      }),
    );
    assert.match(withoutBars.reason!, /NO\s+control/);
  });

  it("a corporate-actions 403 does NOT stop the price chain", () => {
    // THE REASON THE FLAGS ARE SEPARATE. `state.accessRefused` refuses to chain
    // (`shouldChainAnotherBatch`), so folding a beta endpoint's refusal into it
    // would let a revoked grant halt the US price rotation every night. The
    // chain input has no `caRefused` field at all, which is the structural
    // version of that guarantee.
    assert.equal(shouldChainAnotherBatch(chainable()), true);
    const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");
    assert.ok(PROC.length > 1000, "us-eod-sync.ts not read");
    assert.ok(
      !/state\.accessRefused\s*=\s*true/.test(
        PROC.slice(PROC.indexOf("async function runCorpActionCalendarLeg(")),
      ),
      "a secondary refusal must never set the run-level flag",
    );
    assert.ok(
      PROC.includes("state.caRefused = true"),
      "it must set its own flag instead",
    );
    // The news leg had `state.newsRefused = true` for the same reason. It went
    // with leg (f) (MONEY-1309); `tiingo-news-poll.ts` carries its own
    // `state.refused` flag on its own run state, so the separation survives in
    // a job whose refusals cannot reach this chain at all.
  });

  it("a RATE LIMIT in a secondary leg IS global - the quota is the token's", () => {
    const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");
    const caLeg = PROC.slice(
      PROC.indexOf("async function runCorpActionCalendarLeg("),
      // Bounded by the leg that FOLLOWS it. `runNewsLeg` was the boundary until
      // MONEY-1309 retired it; leg (d) is now the next function in the file, and
      // an unbounded slice would let the whole rest of the file satisfy the
      // `includes` below.
      PROC.indexOf("async function runFxLeg("),
    );
    assert.ok(caLeg.length > 500, "the CA leg body was not isolated");
    assert.ok(
      caLeg.includes("state.rateLimited = true"),
      "a 429 anywhere must circuit-break the run: a fresh link re-arms the " +
        "breaker into the same wall (MONEY-853)",
    );
  });
});

describe("the new legs get a RESERVED slice, or they never run", () => {
  const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");

  it("the price legs stop BEFORE the run budget", () => {
    // Both price legs are rotations over populations far larger than one page,
    // so they spend every millisecond offered. Without a reserved slice legs
    // (e) and (f) read "budget already gone" on their first check - every
    // night, for the life of the job. A structurally dead leg reporting a
    // defensible-looking `notReached` is the MONEY-980 finding-2 shape arrived
    // at by scheduling instead of by a filter.
    assert.ok(
      PRICE_LEG_BUDGET_MS < RUN_TIME_BUDGET_MS,
      "leg (b) must yield before the wall",
    );
    assert.ok(
      PRICE_LEG_BUDGET_MS > EQUITY_LEG_BUDGET_MS,
      "leg (b) must still get more clock than leg (a) leaves it",
    );
    assert.ok(
      RUN_TIME_BUDGET_MS - PRICE_LEG_BUDGET_MS >= 30_000,
      "the reserved slice must be big enough for three market-wide calls",
    );
  });

  it("leg (b) actually USES it - the constant is not decorative", () => {
    assert.ok(PROC.length > 1000, "us-eod-sync.ts not read");
    assert.ok(
      PROC.includes("legBudgetMs: PRICE_LEG_BUDGET_MS"),
      "leg (b) must yield at the price-leg budget",
    );
    assert.ok(
      !PROC.includes("legBudgetMs: RUN_TIME_BUDGET_MS"),
      "no leg may run to the full wall and starve the ones after it",
    );
  });
});

describe("MONEY-1250 - the new legs join `selected` on the same terms", () => {
  it("a healthy quiet run still reports 0 owed", () => {
    assert.equal(computeSelected(selectedInput()), 0);
  });

  it("a DARK calendar leg contributes the CALLS it issued, so the monitor fires", () => {
    // A dark leg has no rows to count, so the only honest measure of what it
    // failed to deliver is what it asked for. The monitor is
    // `clamp(selected) - clamp(written) > 0`; without this the run reports
    // 0 - 0 = 0 and reads exactly like a genuinely idle night.
    const selected = computeSelected(
      selectedInput({ caAttempted: 2, caRows: 0 }),
    );
    assert.equal(selected, 2);
  });

  it("a leg that never ran contributes nothing at all", () => {
    // `caAttempted` reaches `computeSelected` as `?? 0`, and `legIsDark(0, 0)`
    // is false. A leg the run never reached must not inflate the work it owed.
    assert.equal(computeSelected(selectedInput()), 0);
  });
});

describe("chunkList - a query SHAPE limit, not a throughput control", () => {
  it("splits into fixed-size chunks and loses nothing", () => {
    const items = Array.from({ length: 1201 }, (_, i) => i);
    const chunks = chunkList(items, CA_LOOKUP_CHUNK_SIZE);
    assert.equal(chunks.length, 3);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [500, 500, 201],
    );
    assert.deepEqual(chunks.flat(), items);
  });

  it("empty in, empty out", () => {
    assert.deepEqual(chunkList([], 500), []);
  });

  it("a zero or nonsense size does not produce an infinite loop", () => {
    // `for (i += 0)` never terminates. The guard is what stops a fat-fingered
    // constant from hanging a run inside its own ack deadline.
    assert.deepEqual(chunkList([1, 2], 0), [[1], [2]]);
    assert.deepEqual(chunkList([1, 2], Number.NaN), [[1], [2]]);
    assert.deepEqual(chunkList([1, 2], -5), [[1], [2]]);
  });

  it("a fractional size floors rather than producing ragged chunks", () => {
    assert.deepEqual(chunkList([1, 2, 3, 4, 5], 2.9), [[1, 2], [3, 4], [5]]);
  });
});

describe("the four-leg verdict is FLAT and always complete", () => {
  it("every judgement carries all three legs, on every path", () => {
    // A leg with no field to appear in is the defect the whole shape exists to
    // prevent. Checked on the early-return paths too, which is where a
    // hand-built verdict object would be easiest to get wrong.
    const cases: UsEodHealthInput[] = [
      healthy(),
      healthy({ accessRefused: true }),
      healthy({ rateLimited: true }),
      healthy({
        equitySelected: 0,
        mfSelected: 0,
        equityAttempted: 0,
        mfAttempted: 0,
        equityBars: 0,
        mfBars: 0,
      }),
      healthy({ equityBars: 0 }),
      healthy({ mfBars: 0 }),
      healthy({ fxWritten: 0 }),
      healthy({ caRefused: true }),
      healthy({ caRows: 0 }),
      // MONEY-1309: five news cases stood here — a floor rejection, a refusal,
      // zero articles, a null master lookup and a truncated day. Each existed
      // because it took a DIFFERENT return path (an early return, or the notes
      // path), and an early return is exactly where a hand-built verdict object
      // loses a leg. The paths themselves are unchanged and still covered by
      // the CA cases; what went is a second leg exercising them.
    ];
    for (const input of cases) {
      const v = judgeUsEodHealth(input);
      assert.deepEqual(
        Object.keys(v.legs).sort(),
        ["ca", "equity", "mf"],
        `a verdict lost a leg for ${JSON.stringify(Object.keys(v.legs))}`,
      );
    }
  });

  it("the UsCorporateActionRow shape the processor writes is the client's", () => {
    // A structural check that the upsert spreads the client's row rather than
    // re-listing columns: a hand-listed `create` silently drops any column the
    // client adds later, and `source` was exactly that kind of column.
    const row: UsCorporateActionRow = {
      permaTicker: "US000000000038",
      symbol: "AAPL",
      listingId: null,
      type: "DIVIDEND",
      exDate: new Date("2026-08-28T00:00:00Z"),
      distribution: 0,
      distributionFrequency: "q",
      splitFactor: null,
      splitFrom: null,
      splitTo: null,
      paymentDate: null,
      recordDate: null,
      declarationDate: null,
      currency: "USD",
      source: "TIINGO",
    };
    assert.equal(row.distribution, 0, "a 0.0 distribution survives the shape");
    const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");
    assert.ok(PROC.length > 1000, "us-eod-sync.ts not read");
    assert.ok(
      PROC.includes("create: { ...row },"),
      "the create must spread the client's row, not re-list its columns",
    );
  });

  it("the sample rows this file builds match the client's parsers", () => {
    // Guards the fixtures themselves: if `TiingoDistributionRow` or
    // `TiingoSplitRow` gains a required field, these stop compiling rather than
    // quietly testing a shape production no longer produces.
    const d = distributionRow({ distribution: 0 });
    assert.equal(d.distribution, 0);
    assert.equal(d.ticker, "aapl", "the API returns LOWERCASE tickers");
    const s = splitRow();
    assert.equal(s.splitFrom, null, "populated on 2 of 67 live rows");
    // The measured duplicate: two rows, one ticker, two real companies.
    const other = splitRow({ permaTicker: "US000000143755" });
    assert.equal(s.ticker, other.ticker);
    assert.notEqual(s.permaTicker, other.permaTicker);
  });
});

// ===========================================================================
// MONEY-1263 / MONEY-1264 REVIEW — the five defects, and the arithmetic
// ===========================================================================

/* --------------------------------------------------------------------------
   The three constants the budget ladder is derived from live in
   `@usemoney/core` and are READ OFF DISK here rather than imported.

   Importing `tiingo-client.ts` would pull `feed-archive` — and a GCS client —
   into a file whose whole advertised property is that it constructs no client,
   no Prisma and no clock at module load. A scan costs that nothing and buys
   something an import could not: it also proves the processor's local COPY of
   the one constant that is NOT exported still equals the client's declaration.
   ------------------------------------------------------------------------ */

const CLIENT_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "market-data",
  "tiingo",
  "tiingo-client.ts",
);
const FEED_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "market-data",
  "exchange-feed.ts",
);
const PACER_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "market-data",
  "tiingo",
  "tiingo-pacer.ts",
);
const ERRORS_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "market-data",
  "tiingo",
  "tiingo-errors.ts",
);
const PROC_SRC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");
const LOGIC_SRC = readRepoFile(
  "workers",
  "src",
  "processors",
  "us-eod-sync-logic.ts",
);
const MASTER_SRC = readRepoFile(
  "workers",
  "src",
  "processors",
  "us-instrument-master-sync.ts",
);
/**
 * The module that DECLARES the Yahoo quote budget, and the module that SPENDS
 * it twice.
 *
 * Read off disk rather than imported, because the point of the cases below is
 * to derive the FX term of `POST_CALL_TAIL_MS` from something that is not
 * `POST_CALL_TAIL_MS`. Importing `FX_LEG_TAIL_MS` and comparing it to itself is
 * exactly the circularity those cases exist to remove.
 */
const YAHOO_LOGIC_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "market-data",
  "yahoo-api-logic.ts",
);
const FX_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "currency",
  "exchange-rates.ts",
);
const NEWS_LOGIC_SRC = readRepoFile(
  "packages",
  "core",
  "src",
  "market-data",
  "tiingo",
  "tiingo-news-logic.ts",
);

/**
 * The numeric literal a `const NAME = 1_234;` declaration carries.
 *
 * Returns NaN when the declaration is absent, and every caller asserts a real
 * number first — a scan that silently reads NaN would compare NaN to NaN and
 * pass nothing, which is the vacuous-scan trap this file's header is about.
 */
function declaredNumber(src: string, name: string): number {
  const m = new RegExp(
    `\\b(?:export\\s+)?const ${name}(?:\\s*:\\s*number)? = ([0-9_]+)`,
  ).exec(src);
  return m ? Number(m[1]!.replace(/_/g, "")) : Number.NaN;
}

describe("F2 - the 600s arithmetic, re-derived honestly", () => {
  it("every source file this section scans was actually read", () => {
    for (const [name, src] of [
      ["tiingo-client.ts", CLIENT_SRC],
      ["exchange-feed.ts", FEED_SRC],
      ["us-eod-sync.ts", PROC_SRC],
      ["us-eod-sync-logic.ts", LOGIC_SRC],
    ] as const) {
      assert.ok(
        src.length > 1000,
        `${name} not read — every case below would be vacuous`,
      );
    }
  });

  it("reads the client's REAL ladder: 4 attempts, 30s timeout, 5s base", () => {
    // If any of these stops parsing, every arithmetic case below is comparing
    // NaN and would pass without testing anything.
    assert.equal(declaredNumber(CLIENT_SRC, "MAX_RETRIES"), 4);
    assert.equal(declaredNumber(FEED_SRC, "EXCHANGE_FETCH_TIMEOUT_MS"), 30_000);
    assert.equal(declaredNumber(CLIENT_SRC, "BACKOFF_BASE_MS"), 5_000);
  });

  it("the processor's COPY of the un-exported backoff matches the client's", () => {
    // `BACKOFF_BASE_MS` is module-private in `tiingo-client.ts` and MONEY-1263
    // does not own that file, so the worker restates it. A restated constant is
    // only safe while something fails on the day it stops being a copy — this
    // is that something.
    assert.equal(
      declaredNumber(PROC_SRC, "TIINGO_BACKOFF_BASE_MS"),
      declaredNumber(CLIENT_SRC, "BACKOFF_BASE_MS"),
      "the worker's backoff base has drifted from the client's declaration",
    );
    // And the other two must NOT be copies — they are exported, so a copy would
    // be a second spelling with no excuse.
    assert.ok(
      !/const\s+\w*MAX_RETRIES\w*\s*=\s*\d/.test(PROC_SRC),
      "MAX_RETRIES must be imported from the client, never restated",
    );
    assert.ok(
      !/const\s+\w*FETCH_TIMEOUT\w*\s*=\s*\d/.test(PROC_SRC),
      "the fetch timeout must be imported from exchange-feed, never restated",
    );
  });

  it("the worst call is 155s — the number the old headroom said was 45s", () => {
    const worst = worstTiingoCallMs(
      declaredNumber(CLIENT_SRC, "MAX_RETRIES"),
      declaredNumber(FEED_SRC, "EXCHANGE_FETCH_TIMEOUT_MS"),
      declaredNumber(CLIENT_SRC, "BACKOFF_BASE_MS"),
    );
    // 4 x 30s of timeout, plus 5 + 10 + 20 of backoff between the 4 attempts.
    assert.equal(worst, 155_000);
    assert.ok(
      worst > 45_000 * 3,
      "the old estimate was not a rounding error — it was off by ~110s",
    );
  });

  it("counts one FEWER sleep than attempts (the client sleeps BETWEEN them)", () => {
    // A 1-attempt ladder has no backoff at all; a 2-attempt ladder has one
    // sleep. Getting this off by one inflates or deflates every derived wall.
    assert.equal(worstTiingoCallMs(1, 30_000, 5_000), 30_000);
    assert.equal(worstTiingoCallMs(2, 30_000, 5_000), 65_000);
    assert.equal(worstTiingoCallMs(3, 30_000, 5_000), 105_000);
  });

  it("doubles the backoff, matching the client's `base * 2 ** (attempt - 1)`", () => {
    // Mutating the client to a LINEAR backoff must not leave this agreeing by
    // coincidence, so the shape is checked at a second base.
    assert.equal(worstTiingoCallMs(4, 0, 1_000), 7_000);
    assert.equal(worstTiingoCallMs(5, 0, 1_000), 15_000);
  });

  it("nonsense inputs contribute 0 rather than throwing", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.ok(Number.isFinite(worstTiingoCallMs(4, bad, 5_000)), String(bad));
      assert.ok(
        Number.isFinite(worstTiingoCallMs(bad, 30_000, 5_000)),
        String(bad),
      );
      assert.ok(
        Number.isFinite(worstTiingoCallMs(4, 30_000, bad)),
        String(bad),
      );
    }
    assert.equal(
      worstTiingoCallMs(0, 30_000, 5_000),
      30_000,
      "at least one attempt",
    );
  });

  /* ------------------------------------------------------------------------
     THE TAIL, DERIVED FROM SOMEWHERE ELSE.

     The case this replaces read:

         const deadline = latestUpstreamCallStartMs(worst);
         assert.ok(worstCaseRunMs(deadline, worst, POST_CALL_TAIL_MS) <= ACK);

     `latestUpstreamCallStartMs` SUBTRACTS `POST_CALL_TAIL_MS`, so that
     expression is `min(420k, 600k - w - TAIL) + w + TAIL`, which is <= 600k for
     EVERY value of TAIL — including 0, including a wrong one. It passed while
     the tail understated its dominant term by 30s. A check whose ceiling comes
     from the thing it is checking proves nothing; this repo has a written rule
     about exactly that (`feedback_falsifiable_check_needs_verified_ceiling`).

     Everything below derives the tail's terms from the modules that DECLARE
     them — read off disk — and never from the constant under test.
     ---------------------------------------------------------------------- */

  it("every source file the tail derivation scans was actually read", () => {
    for (const [name, src] of [
      ["yahoo-api-logic.ts", YAHOO_LOGIC_SRC],
      ["exchange-rates.ts", FX_SRC],
      ["tiingo-news-logic.ts", NEWS_LOGIC_SRC],
    ] as const) {
      assert.ok(
        src.length > 500,
        `${name} not read — the cases below would be vacuous`,
      );
    }
  });

  it("leg (d) costs TWO quote budgets, not the '~10s' the tail used to claim", () => {
    // Term 1, derived independently: the BOUND comes from the module that
    // enforces it, and the CALL COUNT from the module that spends it.
    const budget = declaredNumber(YAHOO_LOGIC_SRC, "QUOTE_FETCH_BUDGET_MS");
    assert.equal(budget, 20_000, "the Yahoo quote budget stopped parsing");

    // `getExchangeRate` awaits `fetcher(...)` for the pair, then again for the
    // REVERSE pair. Counted in CODE, not prose, so a third rung would show up.
    const fetcherCalls = codeOnly(FX_SRC).filter(([, line]) =>
      /await\s+fetcher\(/.test(line),
    ).length;
    assert.equal(
      fetcherCalls,
      2,
      `getExchangeRate makes ${fetcherCalls} fetcher call(s); FX_QUOTE_FETCH_CALLS says ${FX_QUOTE_FETCH_CALLS}`,
    );
    assert.equal(FX_QUOTE_FETCH_CALLS, fetcherCalls);

    // And the processor passes NO timeout of its own, so the client's budget is
    // the only bound there is. A `withDeadline`/`soft-timeout` wrapper here
    // would make this term smaller — and would have to move the constant too.
    assert.ok(
      /getExchangeRate\("USD",\s*"INR"\)/.test(PROC_SRC),
      "leg (d) no longer calls getExchangeRate with the default fetcher",
    );

    assert.ok(
      FX_LEG_TAIL_MS >= budget * fetcherCalls,
      `FX_LEG_TAIL_MS (${FX_LEG_TAIL_MS}) is under the ${fetcherCalls} x ${budget} it must cover`,
    );
    // The old number, kept as the thing that must never come back.
    assert.ok(
      FX_LEG_TAIL_MS > 10_000 * 3,
      "10s for leg (d) was not a rounding error — it was off by ~30s",
    );
  });

  it("POST_CALL_TAIL_MS is the SUM of its named terms, not a rounded guess", () => {
    // Mutating any one term must move the total. A hand-typed total would not.
    assert.equal(
      POST_CALL_TAIL_MS,
      CA_WRITE_TAIL_MS + FX_LEG_TAIL_MS + TAIL_QUERY_MS + TAIL_REPORT_MS,
    );
    // Renamed from POST_NEWS_WRITE_TAIL_MS by MONEY-1309, with the VALUE
    // deliberately unchanged: every term in it is leg (d), the stamp flush, the
    // report and the chain publish — none of which the retired news leg ever
    // contributed to. Asserting the sum is what stops the retirement from being
    // used as cover to "reclaim" the freed clock into a later call start.
    assert.equal(
      POST_WRITE_TAIL_MS,
      FX_LEG_TAIL_MS + TAIL_QUERY_MS + TAIL_REPORT_MS,
    );
    assert.equal(FX_LEG_TAIL_MS, FX_QUOTE_FETCH_CALLS * 20_000 + FX_WRITE_MS);
    // The number it replaced, which is now smaller than leg (d) alone.
    assert.ok(
      POST_CALL_TAIL_MS > 45_000,
      "the tail is back under the 45s that missed 30s of FX",
    );
  });

  it("the ack-deadline ladder holds against an INDEPENDENTLY derived tail", () => {
    // THE case the old one only appeared to be. Every term on the right comes
    // from a different module's source; nothing here reads POST_CALL_TAIL_MS.
    const worst = worstTiingoCallMs(
      declaredNumber(CLIENT_SRC, "MAX_RETRIES"),
      declaredNumber(FEED_SRC, "EXCHANGE_FETCH_TIMEOUT_MS"),
      declaredNumber(CLIENT_SRC, "BACKOFF_BASE_MS"),
    );
    const fxBound =
      2 * declaredNumber(YAHOO_LOGIC_SRC, "QUOTE_FETCH_BUDGET_MS");
    assert.ok(Number.isFinite(worst) && worst > 0);
    assert.ok(Number.isFinite(fxBound) && fxBound > 0);

    // Leg (e)'s write, the un-gated queries and the report/publish are this
    // job's own measured terms — there is no other module to read them off —
    // so they are restated here as LITERALS on purpose. If the source lowers
    // them, this case still demands the room.
    const independentTail = 15_000 + fxBound + 3_000 + 1_000;

    const deadline = latestUpstreamCallStartMs(worst);
    assert.ok(
      deadline + worst + independentTail <= ACK_DEADLINE_MS,
      `a call started at ${deadline}ms + ${worst}ms + a ${independentTail}ms ` +
        `tail is ${deadline + worst + independentTail}ms, past the ${ACK_DEADLINE_MS}ms ack deadline`,
    );
    assert.equal(deadline, 385_000);
  });

  it("the price legs still leave the secondary legs their reserved slice", () => {
    // The consequence of correcting the tail, pinned so it cannot rot back.
    // At the old 380s wall against the new 385s deadline the slice would be 5s
    // — less than leg (e)'s two calls plus leg (f)'s first page cost on a
    // typical night, which is the structurally-dead-leg outcome
    // PRICE_LEG_BUDGET_MS exists to prevent.
    const worst = worstTiingoCallMs(
      declaredNumber(CLIENT_SRC, "MAX_RETRIES"),
      declaredNumber(FEED_SRC, "EXCHANGE_FETCH_TIMEOUT_MS"),
      declaredNumber(CLIENT_SRC, "BACKOFF_BASE_MS"),
    );
    const deadline = latestUpstreamCallStartMs(worst);
    assert.ok(
      deadline - PRICE_LEG_BUDGET_MS >= SECONDARY_LEG_SLICE_MS,
      `legs (e)+(f) get ${deadline - PRICE_LEG_BUDGET_MS}ms, under the ` +
        `${SECONDARY_LEG_SLICE_MS}ms slice they are promised`,
    );
    assert.ok(
      EQUITY_LEG_BUDGET_MS < PRICE_LEG_BUDGET_MS,
      "leg (b) has no floor at all",
    );
  });

  /* ------------------------------------------------------------------------
     LEG (f)'s WRITE LOOP — the term the tail could never have covered.
     ---------------------------------------------------------------------- */

  it("the 420s wall ALONE does not fit — which is why the second wall exists", () => {
    // This is the falsification of the old comment, kept as a case so that
    // deleting `UPSTREAM_CALL_DEADLINE_MS` as redundant goes red immediately.
    assert.ok(
      worstCaseRunMs(RUN_TIME_BUDGET_MS, 155_000, POST_CALL_TAIL_MS) >
        ACK_DEADLINE_MS,
      "if this passes, the throughput wall would be sufficient on its own",
    );
  });

  it("the price-leg walls sit UNDER the call deadline, so they need no gate", () => {
    // Not decoration: `runPriceLeg` checks `legBudgetMs`, not the deadline, so
    // this is the only thing standing between a raised price-leg wall and an
    // ack-deadline overrun.
    const deadline = latestUpstreamCallStartMs(155_000);
    assert.ok(
      PRICE_LEG_BUDGET_MS <= deadline,
      "leg (b) may start a call past the deadline",
    );
    assert.ok(
      EQUITY_LEG_BUDGET_MS <= deadline,
      "leg (a) may start a call past the deadline",
    );
    assert.ok(
      worstCaseRunMs(PRICE_LEG_BUDGET_MS, 155_000, POST_CALL_TAIL_MS) <=
        ACK_DEADLINE_MS,
      "the price legs' own worst finish must fit the ack deadline",
    );
  });

  it("clamps to RUN_TIME_BUDGET_MS, so a nonsense ladder cannot LOOSEN it", () => {
    // The dangerous direction: an understated worst call would push the
    // deadline later. The clamp caps it at the wall this job had before the
    // deadline existed.
    assert.equal(latestUpstreamCallStartMs(0), RUN_TIME_BUDGET_MS);
    assert.equal(latestUpstreamCallStartMs(Number.NaN), RUN_TIME_BUDGET_MS);
    assert.ok(latestUpstreamCallStartMs(1) <= RUN_TIME_BUDGET_MS);
  });

  it("never returns a negative deadline, however long the ladder gets", () => {
    assert.equal(latestUpstreamCallStartMs(10_000_000), 0);
    assert.ok(latestUpstreamCallStartMs(ACK_DEADLINE_MS) >= 0);
  });

  it("the tail is REAL time, not padding — it must not be zero", () => {
    assert.ok(
      POST_CALL_TAIL_MS > 0,
      "leg (e)'s write, leg (d) and the chain publish all run after the last call",
    );
    assert.ok(POST_CALL_TAIL_MS < ACK_DEADLINE_MS / 4);
  });

  it("the deadline is DERIVED at the call site, never a second literal", () => {
    assert.ok(
      /const UPSTREAM_CALL_DEADLINE_MS =\s*latestUpstreamCallStartMs\(TIINGO_WORST_CALL_MS\)/.test(
        PROC_SRC,
      ),
      "the deadline must come from the pure helper, not from a typed-in number",
    );
    assert.ok(
      /worstTiingoCallMs\(\s*MAX_RETRIES,\s*EXCHANGE_FETCH_TIMEOUT_MS,/.test(
        PROC_SRC,
      ),
      "the worst call must be computed from the client's own constants",
    );
  });
});

describe("F0 - the daily cap is caught by the RATE-LIMIT breakers already here", () => {
  it("the pacer's cap error EXTENDS the rate-limit error", () => {
    assert.ok(PACER_SRC.length > 1000, "tiingo-pacer.ts not read");
    assert.ok(ERRORS_SRC.length > 500, "tiingo-errors.ts not read");
    assert.match(
      PACER_SRC,
      /class TiingoDailyCapError extends TiingoRateLimitError\b/,
      "the daily cap must be a SUBCLASS or this job's breakers stop catching it",
    );
    assert.match(ERRORS_SRC, /class TiingoRateLimitError extends Error\b/);
  });

  it("this job has TWO rate-limit breakers and NO separate cap arm", () => {
    const rateArms = (PROC_SRC.match(/instanceof TiingoRateLimitError/g) ?? [])
      .length;
    // THREE until MONEY-1309 retired the news leg. The count is asserted rather
    // than bounded because it is the falsifiable half: `>= 1` would still pass
    // with a leg's breaker silently deleted, which is the failure this case is
    // for. `tiingo-news-poll.ts` carries the third, and its own test file
    // asserts it there.
    assert.equal(rateArms, 2, "one per upstream leg: prices, calendar");
    assert.equal(
      (PROC_SRC.match(/instanceof TiingoDailyCapError/g) ?? []).length,
      0,
      "a separate cap arm would be a second spelling of one breaker",
    );
  });

  it("the rate-limit arm precedes the auth arm in every catch", () => {
    // Unrelated classes, so neither shadows the other — but the ORDER is what
    // keeps the cap on the circuit-breaking path if either ever gains a
    // relationship. Cheap to assert, and it fails loudly if a catch is
    // reordered.
    const rate = [...PROC_SRC.matchAll(/instanceof TiingoRateLimitError/g)].map(
      (m) => m.index ?? -1,
    );
    const auth = [...PROC_SRC.matchAll(/instanceof TiingoAuthError/g)].map(
      (m) => m.index ?? -1,
    );
    assert.equal(rate.length, auth.length);
    for (let i = 0; i < rate.length; i++) {
      assert.ok(rate[i]! < auth[i]!, `catch ${i}: auth is tested first`);
    }
  });
});

describe("F3 - one leg's rotation must not end the OTHER leg's chain", () => {
  it("legHasMoreWork: a FULL page that has not wrapped is work", () => {
    assert.equal(legHasMoreWork(800, 800, false), true);
    assert.equal(legHasMoreWork(801, 800, false), true);
  });

  it("legHasMoreWork: a SHORT page is the whole partition", () => {
    assert.equal(legHasMoreWork(799, 800, false), false);
    assert.equal(legHasMoreWork(0, 800, false), false);
  });

  it("legHasMoreWork: a WRAPPED page is work this chain already did", () => {
    assert.equal(legHasMoreWork(800, 800, true), false);
  });

  it("legHasMoreWork: a leg that was asked for nothing has nothing pending", () => {
    // Without this term a forged `batchSize: 0` makes `selected >= batchSize`
    // trivially true and chains to the ceiling over an empty page.
    for (const bad of [0, -1, Number.NaN]) {
      assert.equal(legHasMoreWork(0, bad, false), false, String(bad));
      assert.equal(legHasMoreWork(500, bad, false), false, String(bad));
    }
  });

  it("EQUITY wrapping does NOT end the chain while funds are pending", () => {
    // The defect, stated as a case. ~49k MF listings at 200 a link means the
    // NAV rotation advances 200*k rows a night and can never catch up, while
    // leg (b) reads `healthy` every run because the 200 it reached had bars.
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ equityRotationWrapped: true, mfSelected: 200 }),
      ),
      true,
    );
  });

  it("MF wrapping does NOT end the chain while equities are pending", () => {
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ mfRotationWrapped: true, equitySelected: 800 }),
      ),
      true,
    );
  });

  it("BOTH wrapped ends it — that is what 'the queue drained' means here", () => {
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ equityRotationWrapped: true, mfRotationWrapped: true }),
      ),
      false,
    );
  });

  it("a leg asked for NOTHING cannot keep the chain alive", () => {
    // This was a standalone condition (`equityBatchSize <= 0 && mfBatchSize <=
    // 0`) before the per-leg merge, and the merge made it strictly tighter: the
    // old AND-form let a `batchSize: 0` equity leg pass the drain test on
    // `0 < 0` and chain on nothing at all.
    assert.equal(
      shouldChainAnotherBatch(
        chainable({
          equityBatchSize: 0,
          mfBatchSize: 0,
          equitySelected: 0,
          mfSelected: 0,
        }),
      ),
      false,
    );
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ equityBatchSize: 0, equitySelected: 0 }),
      ),
      true,
      "the OTHER leg's full page must still carry the chain",
    );
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ equityBatchSize: 0, equitySelected: 0, mfSelected: 3 }),
      ),
      false,
    );
  });

  it("a wrapped-but-full leg beside a drained one still ends the chain", () => {
    // The mirror-image mistake: per-leg wrap with a GLOBAL drain test would
    // chain to the ceiling here, doing nothing on every link.
    assert.equal(
      shouldChainAnotherBatch(
        chainable({ equityRotationWrapped: true, mfSelected: 3 }),
      ),
      false,
    );
  });

  it("still terminates at MAX_CHAIN_DEPTH with BOTH legs adversarially alive", () => {
    // The termination proof survives the per-leg split: neither wrap flag can
    // extend the chain past the depth bound, which consults nothing external.
    let depth = 0;
    let links = 0;
    while (
      shouldChainAnotherBatch(
        chainable({
          chainDepth: depth,
          equityRotationWrapped: false,
          mfRotationWrapped: false,
        }),
      )
    ) {
      depth += 1;
      links += 1;
      assert.ok(links <= MAX_CHAIN_DEPTH + 1, "chain did not terminate");
    }
    assert.equal(depth, MAX_CHAIN_DEPTH - 1);
  });

  it("the processor records BOTH legs' markers, not just the first page's", () => {
    // ASSIGNMENTS, not mentions. `includes("mfOldestSyncedAtMs")` passed with
    // the assignment deleted, because the field is still declared on `RunState`
    // and initialised in the state literal — a locator that matched the
    // declaration of the thing it was meant to prove was written.
    assert.ok(
      /state\.equityOldestSyncedAtMs = oldestMs;/.test(PROC_SRC),
      "leg (a)'s marker must be ASSIGNED from the page it read",
    );
    assert.ok(
      /state\.mfOldestSyncedAtMs = oldestMs;/.test(PROC_SRC),
      "leg (b)'s marker must be ASSIGNED — it never was, and that was F3",
    );
    // Both assignments live in the same page-reading branch, so neither can be
    // satisfied by a write somewhere the page is not in hand.
    const capture = callArgs(PROC_SRC, "if (rows.length > 0) {");
    assert.ok(capture.length > 40, "the marker-capture branch was not found");
    assert.ok(
      capture.includes("state.equityOldestSyncedAtMs = oldestMs;") &&
        capture.includes("state.mfOldestSyncedAtMs = oldestMs;"),
      "both markers must be recorded from the page this leg actually selected",
    );
    // The flag that caused it is gone rather than merely unused: an
    // `isFirstPage` parameter is exactly how one leg's observation got applied
    // to both.
    assert.ok(
      !codeOnly(PROC_SRC).some(([, line]) => line.includes("isFirstPage")),
      "isFirstPage must be gone, not just ignored",
    );
    assert.ok(
      !codeOnly(PROC_SRC).some(([, line]) =>
        line.includes("pageOldestSyncedAtMs"),
      ),
      "the single shared marker must be gone",
    );
  });

  it("the wrap is derived TWICE, once per leg", () => {
    const calls = (PROC_SRC.match(/hasRotationWrapped\(/g) ?? []).length;
    assert.equal(calls, 2, "one derivation per partition");
  });
});

describe("F5 - the master sync could not fire its own zero-write monitor", () => {
  it("the source files this section scans were read", () => {
    assert.ok(
      MASTER_SRC.length > 1000,
      "us-instrument-master-sync.ts not read",
    );
  });

  it("a provider failure is COUNTED, not merely pushed into `errors`", () => {
    assert.ok(
      /result\.providerTransportFailures = 1;/.test(MASTER_SRC),
      "the provider catch must set a counter a monitor can key on",
    );
    // And in the CATCH, not somewhere it would be set on a healthy run.
    const catchAt = MASTER_SRC.indexOf("provider sync failed");
    const setAt = MASTER_SRC.indexOf("result.providerTransportFailures = 1;");
    assert.ok(setAt > 0 && catchAt > 0);
    assert.ok(
      Math.abs(catchAt - setAt) < 600,
      "the counter must be set by the provider's own failure path",
    );
  });

  it("BOTH legs' upstream failures reach reportJobOutcome", () => {
    const args = callArgs(MASTER_SRC, "reportJobOutcome({");
    assert.ok(args.length > 100, "the reportJobOutcome call was not found");
    assert.ok(
      args.includes("permaTickerTransportFailures") &&
        args.includes("providerTransportFailures"),
      "a dark provider leg must be as visible as a dark search leg",
    );
    assert.ok(
      /transportFailures:\s*\n?\s*result\.permaTickerTransportFailures \+\s*\n?\s*result\.providerTransportFailures/.test(
        args,
      ),
      "the two counts must be summed into the one field the outcome carries",
    );
  });

  it("the field it feeds has a branch that can actually fire", () => {
    // A falsifiable check needs a verified ceiling: this proves the counter
    // reaches a condition that EXISTS, rather than a metric nobody reads.
    const outcome = readRepoFile(
      "packages",
      "datadog",
      "src",
      "job-outcome.ts",
    );
    assert.ok(outcome.length > 1000, "job-outcome.ts not read");
    assert.ok(
      /\(outcome\.transportFailures \?\? 0\) > 0 && written === 0/.test(
        outcome,
      ),
      "the upstream-failure branch this counter targets has moved or gone",
    );
    // And the zero-write MONITOR still cannot fire on 0/0 — which is exactly
    // why the counter is the signal rather than `selected`.
    const monitor = readRepoFile(
      "scripts",
      "ops",
      "datadog",
      "monitor-zero-write.json",
    );
    assert.ok(monitor.length > 500, "monitor-zero-write.json not read");
    assert.ok(
      monitor.includes("clamp_max"),
      "the monitor is a clamped difference; 0 - 0 = 0 reads as genuinely idle",
    );
  });

  it("the completion line names the new counter", () => {
    assert.ok(
      /providerTransportFailures=\$\{result\.providerTransportFailures\}/.test(
        MASTER_SRC,
      ),
      "an operator reading the log must see which leg was dark",
    );
  });
});

describe("the schedule comments name the slot the scheduler actually holds", () => {
  it("index.ts and the master route both say 10:00 / 11:00 IST", () => {
    const index = readRepoFile("workers", "src", "index.ts");
    const route = readRepoFile(
      "workers",
      "src",
      "routes",
      "us-instrument-master-sync.ts",
    );
    assert.ok(index.length > 1000, "workers/src/index.ts not read");
    assert.ok(
      route.length > 500,
      "routes/us-instrument-master-sync.ts not read",
    );
    for (const [name, src] of [
      ["index.ts", index],
      ["routes/us-instrument-master-sync.ts", route],
    ] as const) {
      assert.ok(
        /10:00 IST/.test(src),
        `${name} does not name the master sync's real 10:00 IST slot`,
      );
      assert.ok(
        !/(Runs|scheduled) 06:30 IST/.test(src),
        `${name} still asserts the retired 06:30 IST slot as current`,
      );
    }
  });

  it("and the scheduler is the source of truth for both crons", () => {
    // The comments are only worth checking against something that can fail.
    const sched = readRepoFile("scripts", "ops", "setup-scheduler.sh");
    assert.ok(sched.length > 1000, "setup-scheduler.sh not read");
    assert.ok(
      sched.includes("us-instrument-master-sync-daily|0 10 * * 2-6"),
      "the master sync's prod cron moved",
    );
    assert.ok(
      sched.includes("us-eod-sync-daily|0 11 * * 2-6"),
      "the EOD job's prod cron moved",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LEG (b) — FUND NAVs LEFT `Candle` (MONEY-980 C3)
//
// The measurement behind the split, restated so a future edit has to argue
// with it rather than with a preference. Probed against our live Tiingo token
// on 2026-08-28 over 22,096 fund bars (VFIAX 6,484 rows 2000-2026, FXAIX 3,852
// from 2011, VWELX 11,760 from 1979):
//
//     open == high == low == close     22,096 / 22,096   (0 differ)
//     volume == 0                      22,096 / 22,096
//     splitFactor == 1                 22,096 / 22,096
//     divCash != 0                        320 / 22,096   (102/62/156)
//
// Three of Candle's price columns are copies of the NAV and one is a constant
// zero; funds are 49,414 of 72,685 US listings and 72% of the bars in any
// hot-window depth. `divCash` is the ONE field that carries information and is
// the one `UsFundNav` cannot hold — see the ticket report.
// ───────────────────────────────────────────────────────────────────────────

describe("toFundNavRows", () => {
  // `divCash` is a PARAMETER, not a hardcoded 0. A fixture that is 0 on every
  // row has exactly the shape that let `nav = bar.close -> bar.open` survive
  // the first mutation pass: nothing in it can tell mapping from omission.
  const fundBar = (date: string, nav: number, divCash = 0, over = {}) => ({
    date,
    // The measured fund shape: all four OHLC fields ARE the NAV.
    open: nav,
    high: nav,
    low: nav,
    close: nav,
    volume: 0,
    divCash,
    splitFactor: 1,
    ...over,
  });

  it("takes the NAV from `close`, one row per session", () => {
    // `close` and not an average of the four: they are the same number in every
    // measured row, and if that ever stops being true, `close` is the one that
    // means "the NAV published for this session".
    const out = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "US000000018236",
      bars: [fundBar("2026-08-26", 709.31), fundBar("2026-08-27", 714.42)],
    });
    assert.equal(out.rows.length, 2);
    assert.equal(out.rows[0]?.nav, 709.31);
    assert.equal(out.rows[1]?.nav, 714.42);
    assert.equal(out.rows[0]?.permaTicker, "US000000018236");
    assert.equal(out.rows[0]?.symbol, "VFIAX");
  });

  it("it is the CLOSE specifically, proven on a bar whose fields differ", () => {
    // Every case above uses the measured fund shape, where all four OHLC fields
    // ARE the NAV — which means none of them can tell `close` from `open`, and
    // a mutation swapping the two passed all of them. A synthetic bar with four
    // distinct values is the only thing that pins WHICH field the code names.
    //
    // Real fund bars never look like this (0 of 22,096 measured), and that is
    // the point: the day one does — a shared-class fund, a data change
    // upstream — `close` is the field that means "the NAV published for this
    // session" and the other three are not defined at all.
    const [row] = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "P",
      bars: [
        {
          date: "2026-08-27",
          open: 1,
          high: 2,
          low: 3,
          close: 4,
          volume: 0,
          divCash: 0,
          splitFactor: 1,
        },
      ],
    }).rows;
    assert.equal(row?.nav, 4, "the NAV is `close`, not open/high/low");
  });

  it("the date is UTC MIDNIGHT of the session, matching the unique key", () => {
    // `@@unique([permaTicker, date])`. A date carrying a time-of-day would make
    // every re-read a NEW row rather than an idempotent update, so a nightly
    // job with a 5-day trailing window would multiply the table by five.
    const [row] = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "P",
      bars: [fundBar("2026-08-27", 714.42)],
    }).rows;
    assert.equal(row?.date.toISOString(), "2026-08-27T00:00:00.000Z");
  });

  it("a malformed date is REFUSED and counted, never stored as Invalid Date", () => {
    const out = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "P",
      bars: [
        fundBar("not-a-date", 10),
        fundBar("2026-8-1", 10),
        fundBar("2026-08-27", 10),
      ],
    });
    assert.equal(out.rows.length, 1);
    assert.equal(out.badDate, 2);
  });

  it("a non-positive or non-finite NAV is REFUSED — 0 is a parse failure", () => {
    // `nav` feeds valuation arithmetic. A zero is not a cheap fund, it is a
    // parse failure wearing a number, and a NaN poisons every downstream
    // average and renders as "NaN".
    const out = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "P",
      bars: [
        fundBar("2026-08-24", 0),
        fundBar("2026-08-25", -1),
        fundBar("2026-08-26", NaN),
        fundBar("2026-08-27", 714.42),
      ],
    });
    assert.equal(out.rows.length, 1);
    assert.equal(out.badNav, 3);
    assert.equal(out.rows[0]?.nav, 714.42);
  });

  it("an in-batch duplicate date collapses, FIRST wins, and is counted", () => {
    // The table's own unique applied in memory. Two upserts to one key inside a
    // single run means the second silently overwrites the first while BOTH are
    // counted as written.
    const out = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "P",
      bars: [fundBar("2026-08-27", 1), fundBar("2026-08-27", 2)],
    });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.nav, 1);
    assert.equal(out.dupInBatch, 1);
  });

  it("every refusal is counted — `rows + badDate + badNav + dupInBatch` closes", () => {
    // The arithmetic identity is what makes a silent drop impossible: a bar
    // that vanishes from all four buckets is a bar nobody can find.
    const bars = [
      fundBar("2026-08-27", 714.42),
      fundBar("2026-08-27", 714.42),
      fundBar("bad", 1),
      fundBar("2026-08-26", 0),
    ];
    const out = toFundNavRows({ symbol: "V", permaTicker: "P", bars });
    assert.equal(
      out.rows.length + out.badDate + out.badNav + out.dupInBatch,
      bars.length,
    );
    // `divCashClamped` is NOT a term: a clamped bar is still a written row, so
    // adding it would double-count. Same rule as `clampedVolume` on
    // `CandleWriteResult`.
    const clamped = toFundNavRows({
      symbol: "V",
      permaTicker: "P",
      bars: [fundBar("2026-08-25", 100, NaN), fundBar("2026-08-26", 101, 1)],
    });
    assert.equal(clamped.divCashClamped, 1);
    assert.equal(
      clamped.rows.length +
        clamped.badDate +
        clamped.badNav +
        clamped.dupInBatch,
      2,
    );
  });

  it("an empty response shapes to nothing and refuses nothing", () => {
    const out = toFundNavRows({ symbol: "V", permaTicker: "P", bars: [] });
    assert.deepEqual(
      [out.rows.length, out.badDate, out.badNav, out.dupInBatch],
      [0, 0, 0, 0],
    );
  });

  it("carries the REAL distribution through — the measured VFIAX payout", () => {
    // The row this column exists for. VFIAX 2001-03-16: NAV 106.16, divCash
    // 0.305. Probed with the live key, not invented — a fixture nobody
    // measured is a fixture that agrees with whatever the code does.
    const [row] = toFundNavRows({
      symbol: "VFIAX",
      permaTicker: "US000000018236",
      bars: [fundBar("2001-03-16", 106.16, 0.305)],
    }).rows;
    assert.equal(row?.divCash, 0.305);
    assert.equal(row?.nav, 106.16);
  });

  it("a 10.8%-of-NAV distribution survives intact — RYVYX 2024-12-12", () => {
    // The magnitude is the argument for the column. 63.394418898 against a
    // 585.79 NAV: dropped, the series does not merely understate total return,
    // it draws a one-day CLIFF that never happened. Asserted to full precision
    // so a rounding "tidy-up" fails here.
    const [row] = toFundNavRows({
      symbol: "RYVYX",
      permaTicker: "P",
      bars: [fundBar("2024-12-12", 585.79, 63.394418898)],
    }).rows;
    assert.equal(row?.divCash, 63.394418898);
  });

  it("a zero distribution is written as 0, NEVER as null", () => {
    // The column is nullable so ABSENT can mean "row predates the column".
    // A row this function produced was MEASURED, so its no-distribution state
    // is 0. Emitting null would manufacture the one state the schema reserves
    // for unmeasured rows — and on Mongo `{divCash: null}` matches neither
    // absent nor zero, so the two are unrecoverable from each other after.
    const [row] = toFundNavRows({
      symbol: "V",
      permaTicker: "P",
      bars: [fundBar("2026-08-27", 714.42)],
    }).rows;
    assert.equal(row?.divCash, 0);
    assert.equal(row?.divCash === null, false);
    assert.equal(row?.divCash === undefined, false);
    assert.ok(Object.prototype.hasOwnProperty.call(row!, "divCash"));
  });

  it("divCash is per ROW, not carried across the batch", () => {
    // A single-row fixture cannot tell "maps the field" from "maps the first
    // value onto everything". Three rows, three different distributions.
    const rows = toFundNavRows({
      symbol: "V",
      permaTicker: "P",
      bars: [
        fundBar("2026-08-25", 100, 0),
        fundBar("2026-08-26", 101, 1.25),
        fundBar("2026-08-27", 102, 0),
      ],
    }).rows;
    assert.deepEqual(
      rows.map((r) => r.divCash),
      [0, 1.25, 0],
    );
  });

  it("a non-finite or negative divCash is CLAMPED and counted, never dropped", () => {
    // The NAV is the primary datum: a garbage distribution must not cost a real
    // price point. And a silent repair is invisible by construction, which is
    // why it is counted rather than merely fixed.
    const out = toFundNavRows({
      symbol: "V",
      permaTicker: "P",
      bars: [
        fundBar("2026-08-25", 100, NaN),
        fundBar("2026-08-26", 101, -1),
        fundBar("2026-08-27", 102, Infinity),
        fundBar("2026-08-28", 103, 0.5),
      ],
    });
    assert.equal(out.rows.length, 4, "no NAV may be lost to a bad divCash");
    assert.equal(out.divCashClamped, 3);
    assert.deepEqual(
      out.rows.map((r) => r.divCash),
      [0, 0, 0, 0.5],
    );
  });

  it("carries a REAL split — SWPPX 2025-08-15, factor 6", () => {
    // Measured with the live key. NAV 100.05 -> 16.63 on a 6-for-1. Without the
    // factor the series shows an 83% one-day collapse that never happened.
    const [row] = toFundNavRows({
      symbol: "SWPPX",
      permaTicker: "US000000008443",
      bars: [fundBar("2025-08-15", 16.63, 0, { splitFactor: 6 })],
    }).rows;
    assert.equal(row?.splitFactor, 6);
    assert.equal(row?.nav, 16.63);
  });

  it("carries a factor-10 split — FCNTX 2018-08-10", () => {
    const [row] = toFundNavRows({
      symbol: "FCNTX",
      permaTicker: "US000000005600",
      bars: [fundBar("2018-08-10", 13.73, 0, { splitFactor: 10 })],
    }).rows;
    assert.equal(row?.splitFactor, 10);
  });

  it("a factor of 1 OMITS the key — absent, not 1, and never null", () => {
    // The sparsity contract. Writing 1.0 on every row costs ~1.5 GB across
    // ~73.5M rows to record that nothing happened; writing null invents a third
    // state on a column whose entire design is that ABSENT means "no split".
    const [row] = toFundNavRows({
      symbol: "V",
      permaTicker: "P",
      bars: [fundBar("2026-08-27", 714.42)],
    }).rows;
    assert.equal(
      Object.prototype.hasOwnProperty.call(row!, "splitFactor"),
      false,
      "the key itself must be absent, not present-and-1",
    );
    assert.equal(row?.splitFactor, undefined);
    assert.equal(row?.splitFactor === null, false);
  });

  it("splitFactor is per ROW — a split does not leak onto its neighbours", () => {
    // A single-row fixture cannot tell "maps the field" from "maps one value
    // onto the batch", and the real shape is exactly one split among thousands
    // of ordinary sessions.
    const rows = toFundNavRows({
      symbol: "SWPPX",
      permaTicker: "P",
      bars: [
        fundBar("2025-08-14", 100.05),
        fundBar("2025-08-15", 16.63, 0, { splitFactor: 6 }),
        fundBar("2025-08-18", 16.63),
      ],
    }).rows;
    assert.deepEqual(
      rows.map((r) => r.splitFactor),
      [undefined, 6, undefined],
    );
  });

  it("a non-finite or non-positive factor is recorded as NO SPLIT and counted", () => {
    // Absent means "no split" here, so silently writing that for a garbage
    // value would turn the one state this column can assert into a guess. A 0
    // would divide by zero in any adjustment; a NaN poisons the cumulative
    // product for every bar before it.
    const out = toFundNavRows({
      symbol: "V",
      permaTicker: "P",
      bars: [
        fundBar("2026-08-24", 100, 0, { splitFactor: 0 }),
        fundBar("2026-08-25", 101, 0, { splitFactor: -2 }),
        fundBar("2026-08-26", 102, 0, { splitFactor: NaN }),
        fundBar("2026-08-27", 103, 0, { splitFactor: 6 }),
      ],
    });
    assert.equal(
      out.rows.length,
      4,
      "no NAV may be lost to a bad split factor",
    );
    assert.equal(out.splitFactorRefused, 3);
    assert.deepEqual(
      out.rows.map((r) => r.splitFactor),
      [undefined, undefined, undefined, 6],
    );
  });

  it("MF_NAV_NEEDS_PERMATICKER names the OTHER job, not Tiingo", () => {
    // The whole point of the separate counter: a fund with no permaTicker is
    // not a Tiingo problem, and an operator sent to check the price feed for it
    // finds a healthy feed and no lead.
    assert.match(MF_NAV_NEEDS_PERMATICKER, /permaTicker/);
    assert.match(MF_NAV_NEEDS_PERMATICKER, /us-instrument-master-sync/);
    assert.match(MF_NAV_NEEDS_PERMATICKER, /recycle/i);
  });
});

describe("leg (b) writes UsFundNav, and the processor proves it", () => {
  const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");

  it("NAVs go to `usFundNav` and NEVER through the candle repository", () => {
    // The behaviour change. `writeFundNavs` used to be the same code path as
    // leg (a): `putCandles` with OHLC all set to the NAV.
    const nav = PROC.slice(
      PROC.indexOf("async function writeFundNavs("),
      PROC.indexOf("// LEG (c) — corporate actions"),
    );
    assert.ok(nav.length > 200, "writeFundNavs body not found");
    // MONEY-1291 — `db` is `resolvePriceLegDeps`' handle, whose default IS
    // the module `prisma`; that default is pinned in
    // `us-eod-sync-permaticker-prefetch.test.ts`. The table is the assertion
    // here and it has not moved.
    assert.ok(nav.includes("db.usFundNav.upsert("));
    assert.equal(
      nav.includes("putCandles"),
      false,
      "a NAV is not a candle — three of the four price columns would be copies",
    );
  });

  it("a fund with NO permaTicker is skipped and COUNTED, never key-substituted", () => {
    // `UsFundNav.permaTicker` is REQUIRED and is half the unique key;
    // `UsInstrument.permaTicker` is OPTIONAL. Substituting the symbol would
    // file two recycled funds' NAV histories under one identity, and the rows
    // would look entirely ordinary.
    const nav = PROC.slice(
      PROC.indexOf("async function writeFundNavs("),
      PROC.indexOf("// LEG (c) — corporate actions"),
    );
    assert.ok(nav.includes("state.mfSkippedNoPermaTicker++"));
    assert.ok(nav.includes("MF_NAV_NEEDS_PERMATICKER"));
    assert.ok(nav.includes("return;"), "the skip must RETURN before any write");
    assert.equal(
      /permaTicker:\s*(row\.symbol|nav\.symbol|symbol)\b/.test(nav),
      false,
      "the symbol must never be substituted in the write payload",
    );
    // AND the resolution itself must have no fallback. The payload check alone
    // missed `row.permaTicker?.trim() ?? row.symbol`, which substitutes one
    // line earlier and leaves every other assertion in this file green — the
    // guard passing against broken source, which is the exact thing this repo
    // has a standing rule about.
    //
    // MONEY-1291 — the resolution itself MOVED into `fundNavKey`, shared with
    // the pre-fetch guard in `runPriceLeg` so a `.trim()` cannot be present at
    // one site and absent at the other. The rule follows the code: scanning
    // only `writeFundNavs` from here on would pass against a `fundNavKey` that
    // substituted the symbol, which is the whole failure this case exists for.
    const guardAt = nav.indexOf("if (permaTicker === null)");
    assert.ok(guardAt > 0, "the permaTicker guard was not found");
    const resolve = nav.slice(0, guardAt);
    assert.ok(
      resolve.includes("fundNavKey(row)"),
      "the writer must resolve through the shared key helper, not inline",
    );
    assert.equal(
      /\?\?|\|\|/.test(resolve),
      false,
      "the permaTicker must have NO fallback — a fabricated key merges two " +
        "recycled funds' NAV histories into one identity",
    );

    const keyAt = PROC.indexOf("function fundNavKey(");
    assert.ok(keyAt > 0, "fundNavKey was not found");
    const keyBody = PROC.slice(keyAt, PROC.indexOf("\n}\n", keyAt));
    assert.equal(
      /\?\?|\|\|/.test(keyBody),
      false,
      "`fundNavKey` must have NO fallback either — it is now the only place " +
        "the key is resolved, for BOTH guards",
    );
    assert.equal(
      /\bsymbol\b/.test(keyBody),
      false,
      "the key resolver must not so much as mention the symbol",
    );
  });

  it("divCash is written in BOTH the create AND the update", () => {
    // The update half is the one that is easy to leave out and impossible to
    // notice. Leg (b) runs a trailing window, and Tiingo publishes the NAV
    // before the distribution settles — so the FIRST write of a payout date is
    // routinely `divCash: 0` and the real number arrives on a later run.
    // Create-only freezes that zero, which reads as "measured, no
    // distribution" and is indistinguishable from the truth.
    const nav = PROC.slice(
      PROC.indexOf("async function writeFundNavs("),
      PROC.indexOf("// LEG (c) — corporate actions"),
    );
    const upsert = nav.slice(nav.indexOf("db.usFundNav.upsert("));
    const createAt = upsert.indexOf("create: {");
    const updateAt = upsert.indexOf("update: {");
    assert.ok(createAt > 0 && updateAt > createAt, "both blocks must exist");
    const createBlock = upsert.slice(createAt, updateAt);
    const updateBlock = upsert.slice(updateAt);
    assert.ok(
      createBlock.includes("divCash: nav.divCash"),
      "the create must persist the distribution",
    );
    assert.ok(
      updateBlock.includes("divCash: nav.divCash"),
      "the update must persist the CORRECTION — this is the half that gets dropped",
    );
    // And it must come from the shaped row, never be re-derived at the call
    // site. Comments stripped FIRST: the doc above this very upsert contains
    // the string `divCash: 0` while explaining why the update matters, and a
    // scan that fires on its own documentation is a scan that gets deleted
    // rather than fixed — the same trap as scanning for `listFiles` in a file
    // whose comment explains why there is no `listFiles`.
    // LINE BEFORE BLOCK (MONEY-1143). Reversed, a `//` comment containing a
    // `/*` opens a phantom block running to the next `*` + `/`, swallowing real
    // code — and this assertion is an ABSENCE, so swallowed code reads as a
    // PASS. The scan would go green while the thing it checks had stopped being
    // checked. `apps/web/__tests__/meta/comment-strip-ordering.test.ts` fails
    // the build on the reverse order.
    const upsertCode = upsert
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(
      /divCash:\s*(0|bar\.|\d)/.test(upsertCode),
      false,
      "divCash must come from the shaped row, not a literal or a re-read",
    );
    assert.equal(
      (upsertCode.match(/divCash: nav\.divCash/g) ?? []).length,
      2,
      "exactly two — one in the create, one in the update",
    );
  });

  it("splitFactor is SPARSE in the create and UNSET in the update", () => {
    // Two halves, each with its own failure mode.
    //
    // CREATE: a `?? 1` would store 1.0 on ~73.5M rows to say nothing happened,
    // and would destroy the "absent means no split" contract the column is
    // designed around.
    //
    // UPDATE: merely OMITTING the key leaves whatever is already stored, so a
    // row written when Tiingo reported a split it later corrects to 1 keeps a
    // PHANTOM SPLIT for ever — an 83-94% cliff on a date where nothing
    // happened. `unset: true` is the only spelling that removes the field;
    // `null` would invent a third state.
    const nav = PROC.slice(
      PROC.indexOf("async function writeFundNavs("),
      PROC.indexOf("// LEG (c) — corporate actions"),
    );
    const upsert = nav
      .slice(nav.indexOf("db.usFundNav.upsert("))
      // LINE BEFORE BLOCK — see the divCash scan below for why the order is
      // load-bearing on an ABSENCE assertion.
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const createAt = upsert.indexOf("create: {");
    const updateAt = upsert.indexOf("update: {");
    const createBlock = upsert.slice(createAt, updateAt);
    const updateBlock = upsert.slice(updateAt);

    assert.match(
      createBlock,
      /\.\.\.\(nav\.splitFactor !== undefined\s*\?\s*\{ splitFactor: nav\.splitFactor \}\s*:\s*\{\}\)/,
      "the create must SPREAD, so no-split is an absent key",
    );
    assert.equal(
      /splitFactor:\s*(1|nav\.splitFactor \?\?|null)/.test(createBlock),
      false,
      "no `?? 1`, no literal 1, no null in the create",
    );
    assert.ok(
      updateBlock.includes("unset: true"),
      "the update must UNSET when there is no split, or a phantom split persists",
    );
    assert.equal(
      /splitFactor:\s*null/.test(updateBlock),
      false,
      "null is a third state on a column whose design is absent-means-no-split",
    );
  });

  it("the NAV counter is incremented AFTER the upsert", () => {
    // MONEY-1255. Counted before the call, a table that rejects every write
    // still produces a full-looking number.
    const nav = PROC.slice(
      PROC.indexOf("async function writeFundNavs("),
      PROC.indexOf("// LEG (c) — corporate actions"),
    );
    const upsert = nav.indexOf("db.usFundNav.upsert(");
    const written = nav.indexOf("state.mfWritten++");
    assert.ok(
      upsert > 0 && written > upsert,
      "mfWritten must follow the write",
    );
  });
});

describe("the US population moved to `us_instruments` (MONEY-980 C1)", () => {
  const PROC = readRepoFile("workers", "src", "processors", "us-eod-sync.ts");

  it("NO Prisma call in this job touches instrumentMapping any more", () => {
    // The falsifiable form. Every US field this job used to read
    // (market/listingStatus/listingId/listingStartDate/usEodSyncedAt) was
    // REMOVED from that model, so a survivor would not compile — but a
    // `findMany` re-added later with a narrower select would, and it would
    // select from a table with no US rows and report a clean empty run.
    const hits = codeOnly(PROC).filter(([, line]) =>
      line.includes("prisma.instrumentMapping"),
    );
    assert.deepEqual(
      hits,
      [],
      `still reading instrument_mappings: ${JSON.stringify(hits)}`,
    );
  });

  it("the rotation marker is stamped on `usInstrument`, ASC and orderBy-only", () => {
    assert.ok(PROC.includes("db.usInstrument.updateMany("));
    assert.ok(PROC.includes("usEodSyncedAt: new Date()"));
    // The marker in a WHERE would match zero rows forever — the attribute is
    // ABSENT, not null, on a Mongo db push.
    // Allowed: the row TYPE, the `select`, the stamp, and reading the page's
    // oldest marker to detect a rotation wrap. Forbidden: anything that looks
    // like a Prisma predicate — `{gt/gte/lt/lte/not/in/equals}` or a bare
    // `null`/`{ isSet }` — because on Mongo the attribute is ABSENT rather than
    // null and every one of those matches ZERO rows, forever, silently
    // (MONEY-1050 / 1205 / 1234 / 1236).
    const predicates = codeOnly(PROC).filter(
      ([, line]) =>
        line.includes("usEodSyncedAt") &&
        /usEodSyncedAt\s*:\s*(\{\s*(gt|gte|lt|lte|not|in|notIn|equals|isSet)|null)/.test(
          line,
        ),
    );
    assert.deepEqual(
      predicates,
      [],
      `usEodSyncedAt must never be a predicate: ${JSON.stringify(predicates)}`,
    );
    // And it must not appear inside a `where:` block at all.
    const whereBlocks = [...PROC.matchAll(/where:\s*\{[^}]*\}/gs)]
      .map((m) => m[0])
      .filter((b) => b.includes("usEodSyncedAt"));
    assert.deepEqual(whereBlocks, [], "the marker belongs in orderBy only");
  });

  it("`listingStatus` is READ and forwarded, never hardcoded ACTIVE", () => {
    // It is what routes a bar between Mongo and a GCS shard. `buildUsEodWhere`
    // already narrows to ACTIVE, so a hardcoded literal would be correct
    // today — and would file a delisted security's whole history into the hot
    // store the moment a repair run widened the filter, with nothing saying so.
    assert.ok(PROC.includes("listingStatus: true"), "it must be SELECTED");
    assert.ok(
      PROC.includes("listingStatus: row.listingStatus"),
      "it must be forwarded from the row",
    );
    // A hardcoded literal is only forbidden where it would be FORWARDED to the
    // writer. `buildUsEodWhere` legitimately narrows the QUERY to ACTIVE, and
    // that lives in the logic module; here the check is that the value reaching
    // `toCandleRows` comes off the row.
    const writer = PROC.slice(
      PROC.indexOf("async function writeEquityCandles("),
      PROC.indexOf("async function writeFundNavs("),
    );
    assert.ok(writer.length > 200, "writeEquityCandles body not found");
    assert.equal(
      /listingStatus:\s*"/.test(writer),
      false,
      "a hardcoded status would defeat the cold-tier routing",
    );
  });
});

describe("judgeUsEodHealth — a NAV leg that stored NOTHING", () => {
  // REWRITTEN. Every case here used to be driven with
  // `{mfAttempted: 200, mfSkippedNoPermaTicker: 200}` — a state `runPriceLeg`
  // has been unable to produce since MONEY-1291 made the two counters DISJOINT
  // (a skipped fund issues no request, so it no longer increments
  // `mfAttempted`). They were green, and they were unreachable: no input the
  // producer can emit reached the branch they claimed to pin, and the branch
  // itself had inverted in both directions underneath them.
  it("fails the run when EVERY fund reached is unkeyable", () => {
    // `mfAttempted === 0` with skips recorded: the leg reached rows, asked
    // nothing, stored nothing. Under the old comparison this could not fire at
    // all — `0 >= 0` was excluded by the `mfAttempted > 0` guard — so the run
    // reported OK and blamed the wall clock for a leg that was never blocked.
    const v = judgeUsEodHealth(
      healthy({
        mfSelected: 800,
        mfAttempted: 0,
        mfBars: 0,
        mfSkippedNoPermaTicker: 800,
      }),
    );
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /permaTicker/);
    assert.match(v.reason ?? "", /us-instrument-master-sync/);
    // The funds were skipped BEFORE any request, so a sentence saying they
    // "returned NAVs" would send the operator to Tiingo, which never heard
    // from us.
    assert.match(v.reason ?? "", /skipped before any request/);
    assert.equal(/NAV leg dark/.test(v.reason ?? ""), false);
  });

  it("a MIXED page stays healthy — the ordinary shape on a 94%-unkeyable population", () => {
    // THE REGRESSION CASE. These are the counters this branch's own production
    // fixture emits (`us-eod-sync-permaticker-prefetch.test.ts`): two keyable
    // funds fetched and written, two unkeyable skipped. The old comparison read
    // `skipped >= attempted` and failed it — a run that worked, reported with
    // `legs.mf === "healthy"` and a reason false in every clause.
    //
    // Prod measured 46,908 of 49,846 funds unkeyable, so skipped outnumbering
    // attempted is not an edge case; it is most nights until the enricher
    // converges. Failing them nightly is how a monitor gets muted.
    const v = judgeUsEodHealth(
      healthy({
        mfSelected: 4,
        mfAttempted: 2,
        mfBars: 2,
        mfSkippedNoPermaTicker: 2,
      }),
    );
    assert.equal(v.ok, true);
    assert.equal(v.legs.mf, "healthy");
    assert.equal(/permaTicker/.test(v.reason ?? ""), false);
  });

  it("one keyable fund among a whole unkeyable page is still healthy", () => {
    // The boundary: `skipped` 199x `attempted`. The leg is working.
    const v = judgeUsEodHealth(
      healthy({
        mfSelected: 200,
        mfAttempted: 1,
        mfBars: 5,
        mfSkippedNoPermaTicker: 199,
      }),
    );
    assert.equal(v.ok, true);
  });

  it("zero funds attempted with zero skips cannot trigger it", () => {
    // An EMPTY page must not be blamed on the enrichment job. `skipped > 0` is
    // what separates "we reached rows and could not key them" from "there were
    // no rows"; without it an empty page fails with a permaTicker message.
    const v = judgeUsEodHealth(
      healthy({
        mfSelected: 0,
        mfAttempted: 0,
        mfBars: 0,
        mfSkippedNoPermaTicker: 0,
      }),
    );
    assert.equal(v.legs.mf, "noPopulation");
    assert.equal(/permaTicker/.test(v.reason ?? ""), false);
  });

  it("a genuinely budget-stopped leg keeps the wall-clock explanation", () => {
    // The other half of the split. `attempted === 0` and NO skips means the run
    // really did stop before reaching a symbol, and that sentence is correct —
    // it must not be replaced by the permaTicker one.
    const v = judgeUsEodHealth(
      healthy({
        mfSelected: 800,
        mfAttempted: 0,
        mfBars: 0,
        mfSkippedNoPermaTicker: 0,
      }),
    );
    assert.equal(v.legs.mf, "notReached");
    assert.equal(/permaTicker/.test(v.reason ?? ""), false);
  });

  it("a DARK leg still reports dark, not unkeyable", () => {
    // Ordering. `dark` needs `attempted > 0` and the unkeyable branch needs
    // `attempted === 0`, so they can no longer both hold — but a leg that
    // fetched and received nothing must still point at Tiingo.
    const v = judgeUsEodHealth(
      healthy({
        mfSelected: 250,
        mfAttempted: 200,
        mfBars: 0,
        mfSkippedNoPermaTicker: 50,
      }),
    );
    assert.equal(v.legs.mf, "dark");
    assert.match(v.reason ?? "", /NAV leg dark/);
  });
});
