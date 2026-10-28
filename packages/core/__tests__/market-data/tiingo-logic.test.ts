/**
 * MONEY-980 — Tiingo US price backbone, pure logic.
 *
 * Every fixture here is REAL API OUTPUT captured on 2026-08-28, not a
 * hand-written approximation. That matters most for the CSV column order: the
 * documented order and the emitted order DISAGREE, and a fixture written from
 * the docs would have locked in the bug instead of catching it.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseTiingoMasterCsv,
  parseTiingoEodCsv,
  isUsCoreSecurity,
  buildListingId,
  deriveListingStatus,
  maxEndDate,
  isRecycledResponse,
  computeAdjustedSeries,
  resolveTiingoPlan,
  tiingoLimits,
  TIINGO_PLAN_LIMITS,
  type TiingoMasterRow,
} from "../../src/market-data/tiingo/tiingo-logic";
import {
  classifyTiingoError,
  MAX_RETRIES,
  decideTiingoFailure,
  statusFromFeedFailure,
  tiingoAuthMessage,
  TiingoAuthError,
  TiingoRateLimitError,
  fetchTiingoEod,
  fetchSupportedTickers,
  __resetTiingoThrottle,
} from "../../src/market-data/tiingo/tiingo-client";
import { tiingoRequestsToday } from "../../src/market-data/tiingo/tiingo-pacer";
import {
  edgarBackoffMs,
  fetchEdgarCompanyTickers,
} from "../../src/market-data/instruments/edgar-cik";

const FIXTURE = readFileSync(
  join(import.meta.dirname, "fixtures", "tiingo-aapl-split-2020.csv"),
  "utf8",
);

describe("parseTiingoEodCsv — columns by NAME, never by position", () => {
  test("maps open and close to the right columns despite the live header order", () => {
    // The live header is `date,close,high,low,open,…` — close SECOND, open
    // FIFTH — while the docs say open/high/low/close. A positional parser
    // written from the docs reads these two values swapped, produces plausible
    // bars, throws nothing, and is wrong for every US security we hold.
    const bars = parseTiingoEodCsv(FIXTURE);
    const day = bars.find((b) => b.date === "2020-08-20");
    assert.ok(day, "2020-08-20 present");
    assert.equal(day.close, 473.1);
    assert.equal(day.open, 463.0);
    assert.notEqual(day.open, day.close, "open and close must not be swapped");
  });

  test("every bar satisfies low <= open,close <= high", () => {
    for (const b of parseTiingoEodCsv(FIXTURE)) {
      assert.ok(
        b.low <= b.open && b.open <= b.high,
        `open outside range on ${b.date}`,
      );
      assert.ok(
        b.low <= b.close && b.close <= b.high,
        `close outside range on ${b.date}`,
      );
    }
  });

  test("returns [] when a required column is missing rather than mis-indexing", () => {
    assert.deepEqual(parseTiingoEodCsv("date,close,high\n2020-01-01,1,2"), []);
  });

  test("bars come back ascending by date", () => {
    const bars = parseTiingoEodCsv(FIXTURE);
    for (let i = 1; i < bars.length; i++) {
      assert.ok(bars[i - 1]!.date < bars[i]!.date);
    }
  });

  test("drops a row with a non-finite price instead of storing NaN", () => {
    const csv =
      "date,open,high,low,close,volume\n" +
      "2020-01-02,1,2,0.5,1.5,100\n" +
      "2020-01-03,x,2,0.5,1.5,100\n";
    const bars = parseTiingoEodCsv(csv);
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.date, "2020-01-02");
  });

  test("a zero or negative splitFactor is normalised to 1, never divided by", () => {
    const csv =
      "date,open,high,low,close,volume,splitFactor\n" +
      "2020-01-02,1,2,0.5,1.5,100,0\n";
    assert.equal(parseTiingoEodCsv(csv)[0]!.splitFactor, 1);
  });
});

describe("computeAdjustedSeries — CRSP back-adjustment", () => {
  test("reproduces Tiingo's own adjClose across AAPL's 2020 4:1 split", () => {
    const bars = parseTiingoEodCsv(FIXTURE);
    const adj = computeAdjustedSeries(bars);

    // Oracle: the adjClose column Tiingo shipped in the same response.
    const lines = FIXTURE.trim().split("\n");
    const header = lines[0]!.split(",");
    const iDate = header.indexOf("date");
    const iAdj = header.indexOf("adjClose");
    const oracle = new Map<string, number>();
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      oracle.set(c[iDate]!, Number(c[iAdj]));
    }

    // Tiingo's adjClose is anchored to the CURRENT price; ours is anchored to
    // the last bar of the slice. Compare RATIOS, which is what an adjusted
    // series actually asserts and is invariant to that anchor.
    const last = adj[adj.length - 1]!;
    const oracleLast = oracle.get(last.date)!;

    let worst = 0;
    for (const b of adj) {
      const o = oracle.get(b.date);
      assert.ok(o !== undefined, `oracle has ${b.date}`);
      const mine = b.adjClose / last.adjClose;
      const theirs = o / oracleLast;
      worst = Math.max(worst, Math.abs(mine - theirs) / theirs);
    }
    assert.ok(worst < 0.001, `worst relative error ${worst} must be < 0.1%`);
  });

  test("the split is actually present in the fixture (guards a vacuous pass)", () => {
    // Without this the test above would still pass on a series containing no
    // corporate action at all, asserting nothing about the adjustment.
    const bars = parseTiingoEodCsv(FIXTURE);
    const split = bars.find((b) => b.splitFactor !== 1);
    assert.ok(split, "fixture must span a split");
    assert.equal(split.splitFactor, 4);
    assert.equal(split.date, "2020-08-31");
  });

  test("the latest bar is never adjusted", () => {
    const adj = computeAdjustedSeries(parseTiingoEodCsv(FIXTURE));
    const last = adj[adj.length - 1]!;
    assert.equal(last.adjClose, last.close);
  });

  test("pre-split bars are scaled DOWN and their volume UP", () => {
    const adj = computeAdjustedSeries(parseTiingoEodCsv(FIXTURE));
    const before = adj.find((b) => b.date === "2020-08-28")!;
    assert.ok(
      before.adjClose < before.close / 3.5,
      "a 4:1 split must divide earlier prices by ~4",
    );
    assert.ok(before.adjVolume > before.volume * 3.5);
  });

  test("empty input yields empty output", () => {
    assert.deepEqual(computeAdjustedSeries([]), []);
  });
});

describe("master parsing and US scoping", () => {
  const row = (over: Partial<TiingoMasterRow> = {}): TiingoMasterRow => ({
    ticker: "AAPL",
    exchange: "NASDAQ",
    assetType: "Stock",
    priceCurrency: "USD",
    startDate: "1980-12-12",
    endDate: "2026-08-27",
    ...over,
  });

  test("parses the real column set", () => {
    const csv =
      "ticker,exchange,assetType,priceCurrency,startDate,endDate\n" +
      "AAPL,NASDAQ,Stock,USD,1980-12-12,2026-08-27\n";
    assert.deepEqual(parseTiingoMasterCsv(csv), [row()]);
  });

  test("keeps a row whose exchange is blank (132 such rows exist upstream)", () => {
    const csv =
      "ticker,exchange,assetType,priceCurrency,startDate,endDate\n" +
      "XYZ,,ETF,USD,2020-01-01,2026-08-27\n";
    const rows = parseTiingoMasterCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.exchange, "");
    // Excluded by scope rather than silently dropped by the parser, so the
    // count stays visible.
    assert.equal(isUsCoreSecurity(rows[0]!), false);
  });

  test("excludes non-USD listings — the file is not US-only", () => {
    assert.equal(
      isUsCoreSecurity(row({ priceCurrency: "CNY", exchange: "SHG" })),
      false,
    );
    assert.equal(isUsCoreSecurity(row({ priceCurrency: "CNY" })), false);
  });

  test("excludes the OTC groups and foreign boards", () => {
    for (const ex of ["PINK", "OTCMKTS", "OTCGREY", "OTCBB", "LSE", "SHG"]) {
      assert.equal(isUsCoreSecurity(row({ exchange: ex })), false, ex);
    }
  });

  test("INCLUDES mutual funds on NMFQS — the NAV leg needs a population", () => {
    // This assertion was inverted until MONEY-980 widened the scope. It is not
    // a preference: `us-eod-sync` has a fund-NAV leg, and a leg whose
    // population is empty by construction selects nothing, writes nothing and
    // reports HEALTHY forever — the exact failure the worker's own header is
    // written against. 49,414 fund listings are in scope.
    assert.equal(
      isUsCoreSecurity(row({ exchange: "NMFQS", assetType: "Mutual Fund" })),
      true,
    );
    // Still currency-scoped, though: the venue does not exempt a row from the
    // USD rule, because the master carries CNY/HKD/AUD listings too.
    assert.equal(
      isUsCoreSecurity(
        row({
          exchange: "NMFQS",
          assetType: "Mutual Fund",
          priceCurrency: "CNY",
        }),
      ),
      false,
    );
  });

  test("includes the eight in-scope US venues for every in-scope asset type", () => {
    for (const ex of [
      "NASDAQ",
      "NYSE",
      "AMEX",
      "NYSE ARCA",
      "NYSE MKT",
      "NYSE NAT",
      "BATS",
    ]) {
      assert.equal(isUsCoreSecurity(row({ exchange: ex })), true, ex);
      assert.equal(
        isUsCoreSecurity(row({ exchange: ex, assetType: "ETF" })),
        true,
        ex,
      );
    }
  });
});

describe("listing identity and status", () => {
  test("listingId separates the two DOW occupancy windows", () => {
    const oldDow = buildListingId("DOW", "NYSE", "1972-06-01");
    const newDow = buildListingId("DOW", "NYSE", "2019-03-20");
    assert.notEqual(oldDow, newDow);
    assert.equal(newDow, "DOW:NYSE:2019-03-20");
  });

  test("status is relative to the newest date in the FILE, not today's clock", () => {
    const rows: TiingoMasterRow[] = [
      {
        ticker: "A",
        exchange: "NYSE",
        assetType: "Stock",
        priceCurrency: "USD",
        startDate: "2000-01-01",
        endDate: "2026-08-27",
      },
      {
        ticker: "B",
        exchange: "NYSE",
        assetType: "Stock",
        priceCurrency: "USD",
        startDate: "2000-01-01",
        endDate: "2026-08-26",
      },
      {
        ticker: "C",
        exchange: "NYSE",
        assetType: "Stock",
        priceCurrency: "USD",
        startDate: "1972-06-01",
        endDate: "2017-08-31",
      },
    ];
    const newest = maxEndDate(rows)!;
    assert.equal(newest, "2026-08-27");
    // The equity/mutual-fund NAV lag puts live rows on two adjacent dates; both
    // must read ACTIVE or a whole cohort flips to delisted every night.
    assert.equal(deriveListingStatus(rows[0]!, newest), "ACTIVE");
    assert.equal(deriveListingStatus(rows[1]!, newest), "ACTIVE");
    assert.equal(deriveListingStatus(rows[2]!, newest), "DELISTED");
  });

  test("a stale file does not mark the entire market delisted", () => {
    // Replayed from the archive a week late: still ACTIVE, because the
    // reference point travels with the file.
    const r: TiingoMasterRow = {
      ticker: "A",
      exchange: "NYSE",
      assetType: "Stock",
      priceCurrency: "USD",
      startDate: "2000-01-01",
      endDate: "2026-08-20",
    };
    assert.equal(deriveListingStatus(r, "2026-08-20"), "ACTIVE");
  });

  test("a missing endDate is DELISTED, not ACTIVE", () => {
    const r: TiingoMasterRow = {
      ticker: "A",
      exchange: "NYSE",
      assetType: "Stock",
      priceCurrency: "USD",
      startDate: "2000-01-01",
      endDate: null,
    };
    assert.equal(deriveListingStatus(r, "2026-08-27"), "DELISTED");
  });
});

describe("isRecycledResponse — the DOW case", () => {
  test("flags a response that postdates the listing we asked about", () => {
    // Asked for Dow Chemical (ended 2017-08-31); Tiingo returned bars starting
    // 2019-03-20, which is Dow Inc. Writing those under the old identity would
    // file one company's prices as another's.
    assert.equal(
      isRecycledResponse({
        listingEndDate: "2017-08-31",
        firstBarDate: "2019-03-20",
      }),
      true,
    );
  });

  test("does not flag a normal delisted series", () => {
    assert.equal(
      isRecycledResponse({
        listingEndDate: "2017-08-31",
        firstBarDate: "1972-06-01",
      }),
      false,
    );
  });

  test("cannot decide without both dates, and says so by not flagging", () => {
    assert.equal(
      isRecycledResponse({ listingEndDate: null, firstBarDate: "2019-03-20" }),
      false,
    );
    assert.equal(
      isRecycledResponse({ listingEndDate: "2017-08-31", firstBarDate: null }),
      false,
    );
  });
});

describe("plan switch", () => {
  test("defaults to COMMERCIAL — the LOWER pair", () => {
    assert.equal(resolveTiingoPlan(undefined), "COMMERCIAL");
    assert.equal(resolveTiingoPlan(""), "COMMERCIAL");
  });

  test("an unrecognised value resolves DOWN, never up", () => {
    // A typo must not arm the generous ceilings: guessing high walks into a 429
    // wall mid-backfill, guessing low only runs slower.
    for (const v of ["redistrbution", "true", "enterprise", "STARTUP", "1"]) {
      assert.equal(resolveTiingoPlan(v), "COMMERCIAL", v);
    }
  });

  test("REDISTRIBUTION is honoured, case-insensitively", () => {
    assert.equal(resolveTiingoPlan("REDISTRIBUTION"), "REDISTRIBUTION");
    assert.equal(resolveTiingoPlan(" redistribution "), "REDISTRIBUTION");
  });

  test("the two plans differ in every ceiling", () => {
    const c = TIINGO_PLAN_LIMITS.COMMERCIAL;
    const r = TIINGO_PLAN_LIMITS.REDISTRIBUTION;
    assert.ok(r.perHour > c.perHour);
    assert.ok(r.perDay > c.perDay);
    assert.ok(r.bandwidthBytesPerMonth > c.bandwidthBytesPerMonth);
    assert.equal(c.perHour, 20_000);
    assert.equal(r.perHour, 80_000);
  });

  test("tiingoLimits takes an explicit plan without consulting the env", () => {
    assert.equal(tiingoLimits("REDISTRIBUTION").perDay, 1_200_000);
    assert.equal(tiingoLimits("COMMERCIAL").perDay, 150_000);
  });
});

// ---------------------------------------------------------------------------
// MONEY-980 review, finding 3 — the failure classifier
//
// These live here rather than beside a live client because the whole point of
// the finding is that the interesting inputs are UNREACHABLE at runtime without
// a real refusal from Tiingo. Extracting the decision made them ordinary
// values; what follows asserts the decision, not the plumbing.
// ---------------------------------------------------------------------------

/**
 * The EXACT string `fetchExchangeAsset` throws for a non-OK status
 * (`market-data/exchange-feed.ts`): status, statusText, url — and no body.
 *
 * Written from the source line, not invented, because the whole classifier
 * depends on this shape parsing.
 */
/**
 * How many parameters a function DECLARES, read from its emitted source.
 *
 * Not `Function.length`, which stops counting at the first parameter with a
 * default — so `(attempt, retryAfterSeconds = null)` reports 1, which is
 * exactly the shape a reintroduced dead parameter takes. Measured during the
 * mutation pass for this change: a defaulted `retryAfterSeconds` SURVIVED a
 * `.length` guard, and the guard was rewritten rather than believed.
 *
 * Counts commas, so it would misread a destructured or comma-carrying default;
 * neither function under test has one, and both are asserted at 1.
 */
function declaredParamCount(fn: (...args: never[]) => unknown): number {
  const params = /^[^(]*\(([^)]*)\)/.exec(fn.toString())?.[1] ?? "";
  return params.trim() === "" ? 0 : params.split(",").length;
}

const seamThrow = (status: number, statusText = "Forbidden"): Error =>
  new Error(
    `Exchange fetch failed: ${status} ${statusText} ` +
      `(https://api.tiingo.com/tiingo/daily/AAPL/prices?startDate=1962-01-01)`,
  );

describe("classifyTiingoError — status only, because the body is gone", () => {
  test("a REJECTED TOKEN is never reported as an entitlement failure", () => {
    // THE regression test for finding 3. Tiingo answers a bad token with 403 +
    // `{"detail":"Invalid token."}` and an unentitled endpoint with 403 + ZERO
    // bytes (both measured 2026-08-28). The archive seam throws the status and
    // discards the body, so the old two-argument classifier was called as
    // `classifyTiingoError(status, "")` and sent EVERY 403 — token rejections
    // included — down its `text === ""` -> "entitlement" branch. The operator
    // was then told, in as many words, that it was NOT a token problem.
    //
    // Reintroducing that branch means reintroducing the parameter, and both
    // halves below fail: the verdict stops being the joint one, and the arity
    // guard trips.
    assert.equal(classifyTiingoError(403), "auth-or-entitlement");
    assert.equal(
      declaredParamCount(classifyTiingoError),
      1,
      "no body parameter may exist — there is no body to pass it",
    );

    // The same 403, taken through the path the client actually runs.
    const decision = decideTiingoFailure(seamThrow(403), 1);
    if (decision.action !== "auth") {
      assert.fail(`a 403 must be an auth refusal, got ${decision.action}`);
    }
    assert.equal(decision.status, 403);
    assert.match(decision.message, /token/i);
    assert.doesNotMatch(
      decision.message,
      /NOT a token problem/i,
      "the client cannot know that, and saying it points triage away from the " +
        "one cause that changes between deploys",
    );
  });

  test("401 lands on the same verdict, and nothing else is auth", () => {
    assert.equal(classifyTiingoError(401), "auth-or-entitlement");
    for (const s of [0, 200, 404, 418, 500, 502, 503]) {
      assert.equal(classifyTiingoError(s), "other", `status ${s}`);
    }
  });

  test("429 is the only rate-limit status now that phrases cannot be read", () => {
    assert.equal(classifyTiingoError(429), "rate-limit");
    // The old `/rate limit|too many requests|quota/i` body test could never
    // fire — the body was always "". A status that merely SOUNDS related must
    // not resurrect it.
    assert.equal(classifyTiingoError(420), "other");
  });

  test("the operator message names BOTH causes and BOTH checks, asserting neither", () => {
    const msg = tiingoAuthMessage(403, seamThrow(403).message);

    assert.match(msg, /403/);
    assert.match(msg, /EITHER/);
    assert.match(msg, /token/i, "check 1 — the credential");
    assert.match(msg, /plan/i, "check 2 — the entitlement");
    assert.match(msg, /TIINGO_API_KEY/, "names the variable to look at");
    assert.match(msg, /api\.tiingo\.com/, "carries the failing URL");

    // Neither of the two one-sided sentences this replaced may come back.
    assert.doesNotMatch(msg, /Tiingo rejected the token/i);
    assert.doesNotMatch(msg, /plan does not cover this endpoint/i);
  });

  test("an unknown status still produces a usable message, not 'HTTP 0'", () => {
    // Transport failures (DNS, abort, timeout) carry no status. The message is
    // the operator's whole diagnosis, so it must not read as a bad literal.
    const msg = tiingoAuthMessage(0, "connect ECONNREFUSED");
    assert.doesNotMatch(msg, /HTTP 0\b/);
    assert.match(msg, /unknown status/i);
  });

  test("TiingoAuthError carries the status and refuses to clear the token", () => {
    const err = new TiingoAuthError(tiingoAuthMessage(403, "x"), 403);
    assert.equal(err.status, 403);
    // `true` = "a token problem cannot be ruled out". The old code hardcoded
    // the opposite for every empty-bodied 403, which is every 403 we ever see.
    assert.equal(err.isTokenProblem, true);
    assert.equal(err.name, "TiingoAuthError");
    assert.ok(err instanceof Error);
  });

  test("statusFromFeedFailure reads the seam's shape, and 0 when there is none", () => {
    assert.equal(
      statusFromFeedFailure(seamThrow(503, "Service Unavailable")),
      503,
    );
    assert.equal(statusFromFeedFailure(new Error("fetch failed")), 0);
    assert.equal(statusFromFeedFailure("not an Error at all"), 0);
  });
});

describe("the retry ladder's decision", () => {
  test("our own TiingoRateLimitError is re-thrown, never classified or retried", () => {
    // Finding 3(a). `paceRequest` throws this when the plan's DAILY cap is
    // reached — it never touched the network, so it carries no
    // "failed: {status}" and the classifier reads it as status 0 / "other".
    // These two assertions record exactly what the old code therefore did:
    const capped = new TiingoRateLimitError("daily cap 150000 reached");
    assert.equal(statusFromFeedFailure(capped), 0);
    assert.equal(classifyTiingoError(0), "other");

    // ...and this is what it must do instead: propagate untouched, on EVERY
    // attempt, so `us-eod-sync` and the backfill circuit-break the run instead
    // of sleeping ~35s and re-entering the cap three more times.
    for (const attempt of [1, 2, 3, MAX_RETRIES]) {
      assert.deepEqual(
        decideTiingoFailure(capped, attempt),
        { action: "rethrow" },
        `attempt ${attempt}`,
      );
    }
  });

  test("a 5xx climbs the documented ladder, then gives up", () => {
    assert.deepEqual(decideTiingoFailure(seamThrow(500, "Server Error"), 1), {
      action: "retry",
      delayMs: 5_000,
    });
    assert.deepEqual(decideTiingoFailure(seamThrow(503, "Unavailable"), 2), {
      action: "retry",
      delayMs: 10_000,
    });
    assert.deepEqual(decideTiingoFailure(seamThrow(503, "Unavailable"), 3), {
      action: "retry",
      delayMs: 20_000,
    });
    assert.deepEqual(
      decideTiingoFailure(seamThrow(503, "Unavailable"), MAX_RETRIES),
      { action: "give-up" },
    );
  });

  test("a 429 retries, then ends as a rate-limit STOP rather than a generic failure", () => {
    assert.deepEqual(
      decideTiingoFailure(seamThrow(429, "Too Many Requests"), 1),
      {
        action: "retry",
        delayMs: 5_000,
      },
    );
    assert.deepEqual(
      decideTiingoFailure(seamThrow(429, "Too Many Requests"), MAX_RETRIES),
      { action: "rate-limited" },
    );
  });

  test("an auth refusal never spends the ladder", () => {
    // Permanent by construction: neither a bad key nor a missing entitlement
    // heals in 35 seconds, and retrying only delays the alert.
    for (const attempt of [1, MAX_RETRIES]) {
      assert.equal(
        decideTiingoFailure(seamThrow(403), attempt).action,
        "auth",
        `attempt ${attempt}`,
      );
    }
  });
});

describe("EDGAR fetch ladder", () => {
  test("pure exponential capped at 30s, with NO dead Retry-After parameter", () => {
    // Finding 9. The previous signature took `retryAfterSeconds: number | null`
    // under a comment claiming it had fixed the BSE bug where "the only call
    // site passed `null`, so the parameter was dead" — while its own only call
    // site passed a local that was `null` at every assignment. The seam throws
    // on a non-OK status without surfacing the response, so the header is not
    // readable here at all.
    assert.equal(
      declaredParamCount(edgarBackoffMs),
      1,
      "a second parameter can only be fed `null` from this call site",
    );
    assert.equal(edgarBackoffMs(0), 1_000);
    assert.equal(edgarBackoffMs(1), 2_000);
    assert.equal(edgarBackoffMs(2), 4_000);
    // Capped, so a long ladder cannot outlive the job's ack deadline.
    assert.equal(edgarBackoffMs(10), 30_000);
  });
});

/**
 * MONEY-1264 review, G1 — the auth header must be built OUTSIDE the ladder.
 *
 * `tiingoHeaders()` calls `apiKey()`, which throws when `TIINGO_API_KEY` is
 * unset. Built inside `getArchived`'s `try` — as the argument to `getFeedAsset`
 * — that throw carried no HTTP status, so `statusFromFeedFailure` returned 0,
 * `decideTiingoFailure` said "other", and the ladder RETRIED a misconfiguration
 * that cannot heal: four attempts, four `paceTiingoRequest()` charges against
 * the ACCOUNT-WIDE quota, ~35s of backoff per symbol, then a generic `give-up`
 * that no caller circuit-breaks on.
 *
 * The pacer charge is the assertion that actually bites. A test that only
 * checked "it rejects" passes against the broken source too — it just takes 35
 * seconds to do it. `tiingoRequestsToday()` counts the quota this
 * misconfiguration spent, and that number is 0 only when the key is resolved
 * before the loop.
 */
describe("getArchived — a missing token is ONE loud failure, not four charged ones", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  let savedKey: string | undefined;
  let savedMode: string | undefined;

  function stubFetch(body: string, status = 200): void {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
      fetchCalls.push({ url: String(url), headers });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    fetchCalls = [];
    savedKey = process.env.TIINGO_API_KEY;
    savedMode = process.env.FEED_ARCHIVE_MODE;
    delete process.env.FEED_ARCHIVE_MODE;
    __resetTiingoThrottle();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.TIINGO_API_KEY;
    else process.env.TIINGO_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.FEED_ARCHIVE_MODE;
    else process.env.FEED_ARCHIVE_MODE = savedMode;
    __resetTiingoThrottle();
  });

  test("an unset TIINGO_API_KEY spends NO quota and makes NO request", async () => {
    delete process.env.TIINGO_API_KEY;
    stubFetch(FIXTURE);

    await assert.rejects(
      () => fetchTiingoEod({ symbol: "AAPL" }),
      /TIINGO_API_KEY is not set/,
      "the missing secret must surface as itself, not as a generic give-up",
    );

    // THE assertion. Inside the ladder this is MAX_RETRIES (4): the pacer is
    // charged at the top of every attempt, before the headers are built.
    assert.equal(
      tiingoRequestsToday(),
      0,
      "a misconfiguration must not be charged against the account-wide quota",
    );
    assert.equal(fetchCalls.length, 0, "no HTTP call may be made");
  });

  test("the same holds for the master, which is a different call site", async () => {
    // `fetchSupportedTickers` is the OTHER `getArchived` caller. Both go
    // through the one ladder, so one fix covers both — this pins that.
    delete process.env.TIINGO_API_KEY;
    stubFetch("");

    await assert.rejects(
      () => fetchSupportedTickers(),
      /TIINGO_API_KEY is not set/,
    );
    assert.equal(tiingoRequestsToday(), 0);
    assert.equal(fetchCalls.length, 0);
  });

  test("hoisting did not drop the headers — the happy path still authenticates", async () => {
    // The other half of the mutation: a "fix" that hoisted the call but stopped
    // passing the result would send an UNAUTHENTICATED request and 403 in
    // production. `Origin`/`Referer` must still be DELETED, not blanked — the
    // seam's browser-impersonation defaults are for NSE/BSE, and a lowercase
    // key here would JOIN with a default rather than replace it.
    process.env.TIINGO_API_KEY = "test-token-not-a-real-key";
    stubFetch(FIXTURE);

    const res = await fetchTiingoEod({ symbol: "AAPL" });
    assert.ok(res);
    assert.ok(res.bars.length > 0, "the fixture must actually parse");

    assert.equal(fetchCalls.length, 1);
    const sent = fetchCalls[0]!.headers;
    assert.equal(sent.authorization, "Token test-token-not-a-real-key");
    assert.equal(sent.accept, "text/csv,*/*");
    assert.equal("origin" in sent, false, "Origin must be deleted");
    assert.equal("referer" in sent, false, "Referer must be deleted");
    assert.equal(tiingoRequestsToday(), 1, "exactly one request was charged");
  });
});

/**
 * MONEY-1264 review, G3 — the kill switch must tolerate stray whitespace.
 *
 * `US_NAME_ENRICH` and `US_MASTER_SYNC` trim; `EDGAR_CIK_ENRICH` and
 * `TIINGO_SEARCH_ENRICH` did not. Both cloudbuild specs present the four as one
 * family that behaves identically, so `"off "` — a trailing space is trivially
 * introduced in YAML — disabled two of them and silently ARMED the other two.
 * An operator who turned the feed off would still have been scraping SEC.
 */
describe("EDGAR_CIK_ENRICH — the off switch survives a YAML trailing space", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let savedFlag: string | undefined;
  let savedMode: string | undefined;

  const SEC_PAYLOAD = JSON.stringify({
    "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  });

  beforeEach(() => {
    fetchCalls = 0;
    savedFlag = process.env.EDGAR_CIK_ENRICH;
    savedMode = process.env.FEED_ARCHIVE_MODE;
    delete process.env.FEED_ARCHIVE_MODE;
    // Stubbed so a REGRESSION cannot reach sec.gov from the test suite: without
    // the trim, `"off "` falls through to a real fetch.
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(SEC_PAYLOAD, { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedFlag === undefined) delete process.env.EDGAR_CIK_ENRICH;
    else process.env.EDGAR_CIK_ENRICH = savedFlag;
    if (savedMode === undefined) delete process.env.FEED_ARCHIVE_MODE;
    else process.env.FEED_ARCHIVE_MODE = savedMode;
  });

  for (const raw of ["off", "off ", " off", " OFF ", "\toff\n"]) {
    test(`${JSON.stringify(raw)} disables the fetch`, async () => {
      process.env.EDGAR_CIK_ENRICH = raw;
      assert.deepEqual(await fetchEdgarCompanyTickers(), []);
      assert.equal(fetchCalls, 0, "SEC must not be contacted");
    });
  }

  test("a value that is not `off` still ARMS the fetch", async () => {
    // The catch-all half: a guard that trimmed its way into matching
    // everything would disable the feed permanently, which is the same outage
    // wearing the opposite costume.
    process.env.EDGAR_CIK_ENRICH = "on";
    const rows = await fetchEdgarCompanyTickers();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ticker, "AAPL");
    assert.equal(fetchCalls, 1);
  });
});
