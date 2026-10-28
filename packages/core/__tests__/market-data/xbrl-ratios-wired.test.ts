/**
 * MONEY-1220 — the ratios job's wiring and its two irreversible promises.
 *
 * `stock_ratios` is read by the screener engine, the stock tabs, the sector
 * deep-dive and peers. All 2,135 of its rows came from Tickertape, which now
 * 403s our egress. This job is the replacement, so two things have to hold or
 * the cure is worse than the disease:
 *
 *   1. It must actually RUN (the MONEY-1115 lesson: a perfect engine with no
 *      clock attached writes nothing, forever, silently).
 *   2. It must never REPLACE the row. We own 26 of 28 columns; the other two
 *      are analyst opinion from a source we can no longer re-fetch. A full-row
 *      write would erase them permanently.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bashArrayBody } from "./_bash-array";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const INDEX = read("workers/src/index.ts");
const PUBSUB = read("workers/scripts/setup-pubsub.sh");
const SCHED = read("scripts/ops/setup-scheduler.sh");
const PROC = read("workers/src/processors/xbrl-ratios.ts");
const LOGIC = read("workers/src/processors/xbrl-ratios-logic.ts");

/**
 * Comments stripped, LINE first then BLOCK.
 *
 * Order matters and this file is the reason: the assertions below are about
 * what the CODE does, and this job's defining failure mode is a comment that
 * describes a mechanism the code does not implement. `ratiosDerivedAt` was
 * discussed at length in a comment above a query that never mentioned it.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const PROC_CODE = stripComments(PROC);
const LOGIC_CODE = stripComments(LOGIC);

describe("xbrl-ratios — the clock reaches the code", () => {
  it("the route is mounted", () => {
    assert.match(INDEX, /app\.route\("\/jobs\/xbrl-ratios"/);
    assert.match(INDEX, /from "\.\/routes\/xbrl-ratios"/);
  });

  it("the topic is in BOTH pubsub lists", () => {
    // A name in BASE_TOPICS but not BASE_WORKER_TOPICS creates a topic with no
    // push subscription: the scheduler publishes successfully into a void, and
    // the failure is indistinguishable from a healthy run.
    const listAfter = (decl: string): string => {
      const at = PUBSUB.indexOf(decl);
      assert.ok(at > 0, `${decl} not found`);
      return PUBSUB.slice(at, PUBSUB.indexOf("\n)", at));
    };
    for (const decl of [
      "declare -a BASE_TOPICS=(",
      "declare -a BASE_WORKER_TOPICS=(",
    ]) {
      assert.match(listAfter(decl), /"xbrl-ratios"/, `missing from ${decl}`);
    }
  });

  it("a scheduler definition targets that exact topic", () => {
    const def = SCHED.split("\n").find((l) =>
      l.includes('"xbrl-ratios-daily|'),
    );
    assert.ok(def, "no xbrl-ratios-daily definition");
    assert.equal(def.split("|")[2], "xbrl-ratios");
  });

  it("runs AFTER bhavcopy — the close is half of every valuation ratio", () => {
    // P/E, P/B, market cap, EV, dividend yield and beta all need today's close.
    // Running before bhavcopy lands it means deriving today's ratios from
    // yesterday's price, every day, invisibly.
    const hourOf = (name: string): number => {
      const def = SCHED.split("\n").find((l) => l.includes(`"${name}|`));
      assert.ok(def, `${name} not found`);
      return Number(def.split("|")[1]!.split(" ")[1]);
    };
    assert.ok(
      hourOf("xbrl-ratios-daily") > hourOf("bhavcopy-sync-daily"),
      "ratios must run after bhavcopy",
    );
  });

  it("is PROD_ONLY — QA receives stock_ratios through the sync", () => {
    const block = bashArrayBody(SCHED, "PROD_ONLY_JOBS");
    assert.match(block, /"xbrl-ratios-daily"/);
  });
});

describe("xbrl-ratios — the row is not ours to replace", () => {
  it("never writes targetPrice or recommendation", () => {
    // Sell-side analyst opinion: in no filing, in no price series. The source
    // that produced them is gone, so a write here is a one-way deletion.
    assert.doesNotMatch(PROC_CODE, /targetPrice/);
    assert.doesNotMatch(PROC_CODE, /recommendation/);
  });

  it("spreads only the PLAN's filled keys, never a whole ratio object", () => {
    // `...plan.set` carries exactly the columns this filing supported. A spread
    // of a wider object would send `undefined` for the rest, and one refactor
    // away that becomes a clear.
    assert.match(PROC, /const set = \{ \.\.\.plan\.set \}/);
    assert.match(PROC, /\.\.\.set,/);
  });

  it("stamps BOTH clocks so a change is attributable", () => {
    // Half the row moves on a new filing, half on a new close. One `updatedAt`
    // cannot say which, and "why did this P/E change" is the first question
    // anyone asks of a ratio table.
    // BOTH BRANCHES OF THE UPSERT — MONEY-1401. This was `/ratiosFilingId,/`,
    // which the `create:` occurrence satisfies on its own: deleting the column
    // from `update:` left this green while every re-derive after the first
    // FROZE `ratiosFilingId` on the first night's filing — a row whose ratios
    // move and whose provenance does not, which is the exact lie the F10 fix
    // above was about. The rotation test cannot see it either: it reads
    // `.upserts[0].create`.
    //
    // A COUNT rather than two regexes, because both branches are spelled
    // identically and a positional locator would pin whichever came first.
    assert.equal(
      (PROC.match(/source: "NSE_XBRL",\s+ratiosFilingId,/g) ?? []).length,
      2,
      "create AND update must each re-stamp ratiosFilingId beside the source",
    );
    assert.match(PROC, /ratiosPriceDate:/);
    assert.match(PROC, /ratiosDerivedAt:/);
    // AND IT MUST NAME THE FILING THE RATIOS CAME FROM — MONEY-1401 F10.
    // This scan used to assert `ratiosFilingId: latest.id`, pinning the DEFECT:
    // `latest` is the newest filing of ANY period type, QUARTERLY for 2,504 of
    // 2,607 symbols on prod, while every balance-sheet ratio on the row comes
    // from an annual the column did not mention. A reader joining it found a
    // plausible filing and was told the wrong period.
    assert.doesNotMatch(
      PROC,
      /ratiosFilingId: latest\.id/,
      "`latest` is the newest filing of ANY period type — usually a quarterly " +
        "that contributed only the TTM feed",
    );
    assert.match(
      PROC,
      /derivation\.usedAnnual && latestAnnual \? latestAnnual\.id/,
    );
  });
});

describe("xbrl-ratios — inputs are the right kind of thing", () => {
  it("takes the share count from the filing, not from a TTM sum", () => {
    // A share COUNT is an instant, not a flow. Summing it across four quarters
    // multiplies the float by four and divides every per-share ratio by four.
    assert.match(PROC, /deriveShareCount\(latestFinancials\)/);
    assert.doesNotMatch(PROC, /shares: ttm\?\.shares/);
  });

  it("reads `cumulative` from the stored row for the TTM", () => {
    // A YTD column summed beside three discrete quarters double-counts the
    // year. The flag lives on the filing row, not in the document.
    assert.match(PROC, /cumulative: f\.cumulative === true/);
    assert.match(PROC, /cumulative: true,/);
  });

  it("takes dividends from corporate actions, not from a filing line", () => {
    assert.match(PROC, /corporateAction\.findMany/);
    assert.match(PROC, /ttmDividendPerShare\(/);
  });

  it("computes dividendYield on ONE clock — the price date, not the filing", () => {
    // MONEY-1238. `dividendYield` is `ttmDividendPerShare / price`. This used
    // to read `ttmDividendPerShare(actions, latest.periodEnd)` while the
    // denominator was TODAY'S close, so the two halves of one ratio were
    // measured on clocks that can be a full year apart for an annual-only
    // filer. For a March-year-end company evaluated in August the numerator's
    // window ended on 31 March and EXCLUDED the June final dividend — the
    // largest of the year for most Indian filers.
    //
    // Pinned as a BOUNDED slice of the actual call, not as a free-text search:
    // `latest.periodEnd` appears elsewhere in this file for reasons that are
    // still correct (the corporate-action read floor), so a whole-file
    // `doesNotMatch` would fail on a line nobody should change.
    const at = PROC.indexOf("ttmDividendPerShare(");
    assert.ok(at > 0, "ttmDividendPerShare is not called at all");
    const call = PROC.slice(at, at + 120);
    assert.match(
      call,
      /ttmDividendPerShare\(\s*actions,\s*usablePrice\?\.date \?\? now,?\s*\)/,
      "the dividend window must be anchored at the close the yield divides by",
    );
    assert.doesNotMatch(
      call,
      /latest\.periodEnd/,
      "the filing's period end is the wrong clock for a price-denominated ratio",
    );
  });

  it("reads its OWN env arm, not the projection's — MONEY-1286", () => {
    // The two jobs shared `XBRL_PROJECTION_APPLY` until both gates were run
    // against prod on 2026-08-30 and DISAGREED: `xbrlratios prod` PASS (roe
    // READY 666/697 = 95.6%, nothing BLOCKED) against `xbrlrecon prod` NOT
    // READY (totalLiabilities 17.2%, totalAssets/totalEquity 6.9%, netIncome
    // 5.9%, vs a 5.0% floor). One flag could not express "ratios on,
    // financials off", and both writes are one-way doors.
    assert.match(PROC, /XBRL_RATIOS_APPLY === "true"/);
    // The split has to be REAL, not additive. A processor that still reads the
    // projection flag anywhere re-couples the two jobs while this file's first
    // assertion stays green — which is precisely the shape MONEY-1286 removed.
    assert.doesNotMatch(
      PROC_CODE,
      /XBRL_PROJECTION_APPLY/,
      "the ratios job must not read the projection's arm at all",
    );
    // `Boolean("false")` is true, so a truthiness check arms the one
    // configuration meant to keep the job off (MONEY-1214).
    assert.doesNotMatch(PROC, /Boolean\(\s*\w*\.XBRL_RATIOS_APPLY/);
    // Read PER CALL off the passed env. A module-scope const freezes at import,
    // and on a warm Cloud Run container that turns a redeployed switch into no
    // switch at all.
    assert.match(
      PROC_CODE,
      /export function isRatiosArmed\(\s*env: NodeJS\.ProcessEnv = process\.env,?\s*\): boolean \{\s*return env\.XBRL_RATIOS_APPLY === "true";/,
      "the arm must be read from the argument on every call",
    );
  });
});

/**
 * MONEY-1235 — the stale-first cursor, pinned at the READ.
 *
 * The tests above pinned the WRITE: `ratiosDerivedAt:` appearing somewhere in
 * the processor. That assertion was true for a release during which the column
 * was written every night and read by NOTHING, while the batch never advanced
 * and roughly symbols M-Z were never derived. A write-only assertion cannot
 * tell a cursor from a decoration.
 *
 * The behavioural proof — run the processor twice, assert the third instrument
 * is reached — lives in `workers/__tests__/processors/xbrl-ratios-rotation.test.ts`,
 * and it is the one that would actually go red. These are the structural guards
 * that stop the READ being quietly removed while that test keeps passing on a
 * fake, and they assert on COMMENT-STRIPPED source for the reason this whole
 * ticket exists.
 */
describe("xbrl-ratios — the rotation cursor is READ, not just written", () => {
  it("the processor ranks by the marker instead of by symbol", () => {
    assert.match(
      PROC_CODE,
      /rankRatiosTargets\(candidates, markers, limit\)/,
      "the batch must be decided by the marker cursor",
    );
    // The instrumentMapping read is the CANDIDATE scan, capped for safety. If
    // its `take` ever becomes the per-run limit again, the ordering column
    // silently becomes the rotation again.
    assert.match(PROC_CODE, /take: CANDIDATE_SCAN_CAP/);
    assert.doesNotMatch(
      PROC_CODE,
      /orderBy: \[\{ symbol: "asc" \}\],\s*take: limit/,
      "ordering by a column that is CONSTANT per instrument is MONEY-1211",
    );
  });

  it("the marker is SELECTED, never matched with a null filter", () => {
    // Prisma + MongoDB: `{ field: null }` does not match an ABSENT field, and
    // absent is the shape of all 2,135 Tickertape-era rows. Four tickets here
    // have been that bug.
    assert.match(PROC_CODE, /ratiosDerivedAt: true/, "marker must be selected");
    assert.doesNotMatch(
      PROC_CODE,
      /ratiosDerivedAt: null/,
      "a null-equality filter on this field matches none of the rows it must",
    );
    assert.doesNotMatch(PROC_CODE, /ratiosDerivedAt: \{ lt:/);
  });

  it("the ranking really consults the marker", () => {
    // Guards against a `rankRatiosTargets` that takes the markers and ignores
    // them — which would satisfy every assertion above.
    assert.match(LOGIC_CODE, /markers: readonly RatiosDerivedMarker\[\]/);
    assert.match(LOGIC_CODE, /m\.ratiosDerivedAt/);
  });

  it("a REFUSED instrument is stamped, so it cannot park at the head", () => {
    // Otherwise an instrument that can never produce a worthwhile plan consumes
    // a slot every night forever — the same starvation, by a different door.
    assert.match(PROC_CODE, /stockRatios\.updateMany/);
    assert.match(PROC_CODE, /data: \{ ratiosDerivedAt: now \}/);
  });

  it("the cursor-only stamp sits BEHIND the same authority guard as the write", () => {
    // Both branches write this row — one writes ratios, the other only the
    // rotation cursor — and neither may touch a row a higher-authority source
    // owns. `financials-write-authority.test.ts` scans for exactly this within
    // 400 characters before every write, and it is right to: neither model has
    // `source` in its unique key.
    // Mirrors that scan's own rule — the NEAREST PRECEDING guard within 400
    // characters — rather than the first guard in the file, because "a guard
    // elsewhere in the file protects nothing".
    //
    // Proximity ALONE is not the property, and asserting only proximity is how
    // this test first passed while the adjacent guard was deleted: the
    // dry-run's own `mayOverwriteFinancials` sat close enough to satisfy both
    // this and the real scan. So each write must ALSO have the guard's REFUSAL
    // BRANCH between the guard and itself — that is what makes the call gate
    // the write rather than merely precede it.
    for (const write of ["stockRatios.updateMany", "stockRatios.upsert"]) {
      const writeAt = PROC_CODE.indexOf(write);
      assert.ok(writeAt > 0, `${write} not found`);
      const guardAt = PROC_CODE.lastIndexOf("mayOverwriteFinancials(", writeAt);
      assert.ok(guardAt > 0, `${write} has no guard before it at all`);
      assert.ok(
        writeAt - guardAt < 400,
        `the nearest guard sits ${writeAt - guardAt} chars before ${write}`,
      );
      // Two spellings, one property. `deriveOne` returns a whole
      // `DeriveOutcome` (`cursor: "authority-blocked"`); `stampCursorOnly`
      // returns the bare `CursorOutcome` (`return "authority-blocked"`). Both
      // are a REFUSAL BRANCH between the guard and the write, which is the
      // thing under test — the shape of the returned value is not.
      assert.match(
        PROC_CODE.slice(guardAt, writeAt),
        /return[^;]{0,120}"authority-blocked"/,
        `the guard nearest ${write} does not RETURN on refusal — it precedes ` +
          "the write without gating it",
      );
    }
    // …and the cursor stamp must carry ONLY the cursor.
    const stampAt = PROC_CODE.indexOf("stockRatios.updateMany");
    const stampBlock = PROC_CODE.slice(stampAt, stampAt + 220);
    assert.doesNotMatch(stampBlock, /source:/);
    assert.doesNotMatch(stampBlock, /ratiosFilingId/);
  });
});

describe("xbrl-ratios — basis, history and price bounds reach the queries", () => {
  it("resolves consolidated-vs-standalone before anything reads a filing", () => {
    // 1,486 of 2,108 symbols (70.5%) file both for their newest year, and the
    // word `basis` did not previously appear in this processor at all.
    assert.match(PROC_CODE, /selectPeriodWinners\(/);
    assert.match(
      PROC_CODE,
      /basis: true/,
      "the tie-break chain must be selected",
    );
    assert.match(PROC_CODE, /coverage: true/);
    assert.match(PROC_CODE, /sourceUrl: true/);
  });

  it("feeds the CAGR from an ANNUAL-only query, not from the newest-24 slice", () => {
    assert.match(PROC_CODE, /periodType: "ANNUAL"/);
    assert.match(PROC_CODE, /take: ANNUAL_FILINGS_TAKE/);
  });

  it("bounds the close it prices from", () => {
    // An unbounded `findFirst(orderBy: date desc)` gave a suspended instrument
    // a P/E off an arbitrarily old close under a fresh `ratiosDerivedAt`.
    assert.match(PROC_CODE, /PRICE_MAX_AGE_DAYS/);
    assert.doesNotMatch(PROC_CODE, /dailyPrice\.findFirst/);
  });

  it("fetches the index series ONCE per run, outside the instrument loop", () => {
    // ~1,000 identical Atlas round-trips a night for a series that cannot
    // change mid-run, against a 600s ack deadline.
    assert.equal(
      (PROC_CODE.match(/indexClose\.findMany/g) ?? []).length,
      1,
      "more than one call site means it is back inside the loop",
    );
    assert.match(PROC_CODE, /indexCloses,\s*\}\);/);
  });

  it("reports its own wall clock against the ack deadline", () => {
    // CLAUDE.md asserts "large headroom" for this job. That is an assertion,
    // not a measurement, and a handler that runs past 600s is REDELIVERED —
    // a second copy of the same job runs concurrently.
    assert.match(PROC_CODE, /durationMs/);
    assert.match(PROC_CODE, /ackDeadlineMs=600000/);
  });
});
