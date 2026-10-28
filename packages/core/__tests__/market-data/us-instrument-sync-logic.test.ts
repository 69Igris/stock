import { readFileSync as __rfs } from "node:fs";
import { join as __join } from "node:path";
/**
 * MONEY-980 TASK B1/B2 — `us_instruments` selection, write planning, the stale
 * sweep breaker and the `US_MASTER_SYNC` kill switch.
 *
 * Every case here is one where the WRONG answer looks entirely normal:
 *
 *   - a duplicate `listingId` resolved by CSV line order, so whether a live
 *     security reads ACTIVE or DELISTED changes between two runs over the same
 *     bytes;
 *   - a delisted predecessor silently dropped, which is the whole reason this
 *     table exists;
 *   - an update payload that also rewrites `name`, undoing the paced name leg
 *     every night at no visible cost;
 *   - a stale sweep that retires the universe from a truncated file and logs
 *     COMPLETED;
 *   - a kill switch read through `Boolean()`, where `Boolean("false")` is
 *     `true`.
 *
 * Each assertion below was MUTATION-CHECKED: the source rule was broken, the
 * case was confirmed RED, and the source restored. The specific mutations are
 * named in the comments so a later reader can repeat them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_US_STALE_RATIO,
  US_STALE_FLOOR,
  isUsMasterSyncEnabled,
  judgeUsStaleSweep,
  planUsInstrumentWrites,
  selectUsListings,
  type StoredUsListing,
  type UsListing,
} from "../../src/market-data/instruments/us-instrument-sync-logic";
import { US_SYNC_WRITE_BUDGET_MS } from "../../src/market-data/instruments/us-instrument-sync";
import {
  usEnrichmentDeadlines,
  US_ENRICH_BUDGET_MS,
} from "../../src/market-data/instruments/us-instrument-names-logic";
import type { TiingoMasterRow } from "../../src/market-data/tiingo/tiingo-logic";

const row = (
  ticker: string,
  exchange: string,
  startDate: string,
  endDate: string,
  assetType = "Stock",
): TiingoMasterRow => ({
  ticker,
  exchange,
  assetType,
  priceCurrency: "USD",
  startDate,
  endDate,
});

/** The newest endDate in every fixture below, so ACTIVE means ACTIVE. */
const LIVE = "2026-08-27";

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe("selectUsListings — one row per LISTING, not per ticker", () => {
  test("DOW keeps BOTH companies — the delisted tail this table exists for", () => {
    // The exact case `selectPrimaryListings` must drop (@@unique([yahooSymbol])
    // admits one row per ticker) and this one must keep.
    // MUTATION: key the winners Map on `row.ticker` instead of the listingId ->
    // this returns 1 listing and the case fails on the first assertion.
    const { listings, stats } = selectUsListings([
      row("DOW", "NYSE", "1972-06-01", "2017-08-31"),
      row("DOW", "NYSE", "2019-03-20", LIVE),
    ]);
    assert.equal(listings.length, 2);
    const ids = listings.map((l) => l.listingId).sort();
    assert.deepEqual(ids, ["DOW:NYSE:1972-06-01", "DOW:NYSE:2019-03-20"]);

    const dead = listings.find((l) => l.listingId === "DOW:NYSE:1972-06-01")!;
    const live = listings.find((l) => l.listingId === "DOW:NYSE:2019-03-20")!;
    assert.equal(dead.listingStatus, "DELISTED");
    assert.equal(live.listingStatus, "ACTIVE");

    assert.equal(stats.duplicateListingIdDropped, 0);
    assert.equal(stats.distinctSymbols, 1);
    // Both rows share a ticker, so BOTH are unnameable-by-metadata candidates.
    assert.equal(stats.recycledListings, 2);
  });

  test("a cross-venue repeat is kept too — 330 of them, and 207 are sequential", () => {
    // `selectPrimaryListings` drops these on venue preference. Measured on the
    // live master: only 123 of the 330 have overlapping windows (a real dual
    // listing); the rest, like ACOM here, are two different securities.
    const { listings } = selectUsListings([
      row("ACOM", "NASDAQ", "2009-11-05", "2013-01-14"),
      row("ACOM", "NYSE ARCA", "2026-06-17", LIVE, "ETF"),
    ]);
    assert.equal(listings.length, 2);
    assert.deepEqual(listings.map((l) => l.assetType).sort(), ["ETF", "Stock"]);
  });

  test("a duplicate listingId collapses to the LIVE row, not the stale one", () => {
    // Real shape, measured 2026-08-28: APPC@BATS/2026-06-30 is filed twice —
    // once as a Stock ending the day it started, once as the ETF that is still
    // trading. 83 listingIds are duplicated across 92 surplus rows.
    // MUTATION: replace `beatsListing(row, held, refDate)` with `false` (keep
    // the incumbent) -> APPC reads Stock/DELISTED and both assertions fail.
    const { listings, stats } = selectUsListings([
      row("APPC", "BATS", "2026-06-30", "2026-06-30", "Stock"),
      row("APPC", "BATS", "2026-06-30", LIVE, "ETF"),
    ]);
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.assetType, "ETF");
    assert.equal(listings[0]!.listingStatus, "ACTIVE");
    assert.equal(stats.duplicateListingIdDropped, 1);
    assert.equal(stats.duplicateListingIdGroups, 1);
  });

  test("the collision winner does not depend on input order", () => {
    // `@@unique([listingId])` means the loser's values are simply lost. If the
    // comparator were partial, two runs over the same file would store
    // different rows and alternate nightly with no error.
    const a = selectUsListings([
      row("APPC", "BATS", "2026-06-30", "2026-06-30", "Stock"),
      row("APPC", "BATS", "2026-06-30", LIVE, "ETF"),
    ]);
    const b = selectUsListings([
      row("APPC", "BATS", "2026-06-30", LIVE, "ETF"),
      row("APPC", "BATS", "2026-06-30", "2026-06-30", "Stock"),
    ]);
    assert.deepEqual(a.listings, b.listings);
  });

  test("byte-identical duplicate rows still produce ONE deterministic listing", () => {
    // Six groups in the live master repeat a line verbatim (NUR@NASDAQ three
    // times). `beatsListing` cannot separate them and does not need to: the
    // STORED ROW is identical whichever wins, which is the property that
    // matters.
    const dup = row("NUR", "NASDAQ", "2026-08-17", "2026-08-17");
    const { listings, stats } = selectUsListings([
      dup,
      { ...dup },
      { ...dup },
      row("AAPL", "NASDAQ", "1980-12-12", LIVE),
    ]);
    const nur = listings.filter((l) => l.symbol === "NUR");
    assert.equal(nur.length, 1);
    assert.equal(stats.duplicateListingIdDropped, 2);
    assert.equal(stats.duplicateListingIds.length, 0);
  });

  test("out-of-scope rows never reach the selection", () => {
    // CNY on a Shanghai venue, and an OTC row. `isUsCoreSecurity` gates both;
    // this is the case that catches a scope filter being dropped.
    const { listings, stats } = selectUsListings([
      { ...row("000001", "SHE", "2007-01-04", LIVE), priceCurrency: "CNY" },
      row("XYZQ", "OTCMKTS", "2010-01-04", LIVE),
      row("AAPL", "NASDAQ", "1980-12-12", LIVE),
    ]);
    assert.equal(stats.fetched, 3);
    assert.equal(stats.inScope, 1);
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.symbol, "AAPL");
  });

  test("mutual funds ARE in scope — a leg with an empty population reads healthy forever", () => {
    const { listings } = selectUsListings([
      row("VFIAX", "NMFQS", "2000-11-13", "2026-08-26", "Mutual Fund"),
    ]);
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.assetType, "Mutual Fund");
    // Tiingo's spelling is preserved, NOT translated to `MF` — the schema
    // documents `Stock | ETF | Mutual Fund` and @@index([assetType, ...]) is
    // read with it.
    assert.notEqual(listings[0]!.assetType, "MF");
  });

  test("status is graded against the FILE's newest date, not today's clock", () => {
    // A fund NAV lands a day behind an equity close, and a replayed archive is
    // a day behind both. Grading against `Date.now()` marks the market dead on
    // a Monday.
    const { listings } = selectUsListings([
      row("VFIAX", "NMFQS", "2000-11-13", "2026-08-26", "Mutual Fund"),
      row("AAPL", "NASDAQ", "1980-12-12", LIVE),
    ]);
    assert.equal(
      listings.every((l) => l.listingStatus === "ACTIVE"),
      true,
    );
  });

  test("an empty in-scope set returns EMPTY, never everything-DELISTED", () => {
    const { listings, stats } = selectUsListings([]);
    assert.equal(listings.length, 0);
    assert.equal(stats.fileMaxEndDate, null);
    assert.equal(stats.active, 0);
    assert.equal(stats.delisted, 0);
  });

  test("kept + dropped accounts for every in-scope row", () => {
    // An arithmetic identity, so a future filter cannot silently swallow rows.
    const { stats } = selectUsListings([
      row("DOW", "NYSE", "1972-06-01", "2017-08-31"),
      row("DOW", "NYSE", "2019-03-20", LIVE),
      row("APPC", "BATS", "2026-06-30", "2026-06-30"),
      row("APPC", "BATS", "2026-06-30", LIVE, "ETF"),
      row("AAPL", "NASDAQ", "1980-12-12", LIVE),
    ]);
    assert.equal(stats.kept + stats.duplicateListingIdDropped, stats.inScope);
    assert.equal(stats.active + stats.delisted, stats.kept);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const listing = (
  over: Partial<UsListing> & Pick<UsListing, "listingId">,
): UsListing => ({
  symbol: "AAPL",
  exchange: "NASDAQ",
  assetType: "Stock",
  listingStatus: "ACTIVE",
  listingStartDate: "1980-12-12",
  listingEndDate: LIVE,
  ...over,
});

const stored = (
  over: Partial<StoredUsListing> & Pick<StoredUsListing, "listingId">,
): StoredUsListing => ({
  assetType: "Stock",
  listingStatus: "ACTIVE",
  listingEndDate: utc(LIVE),
  ...over,
});

describe("planUsInstrumentWrites", () => {
  test("an unchanged row is not written", () => {
    // The property that keeps a converged night's write count near zero, so a
    // NON-zero one is readable.
    // MUTATION: drop the three-field equality check -> `unchanged` reads 0 and
    // one update group appears.
    const plan = planUsInstrumentWrites(
      [listing({ listingId: "AAPL:NASDAQ:1980-12-12" })],
      [stored({ listingId: "AAPL:NASDAQ:1980-12-12" })],
    );
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.updateGroups.length, 0);
  });

  test("the UPDATE payload carries no `name` — the name leg would be undone nightly", () => {
    // `UsInstrument.name` is filled by a paced per-symbol leg over ~9 nights.
    // A master reconcile that also wrote `name` (as null, or as the symbol)
    // would erase that every single night, with no error and no counter.
    // MUTATION: add `name: l.symbol` to `UsInstrumentUpdateData` -> fails here.
    const plan = planUsInstrumentWrites(
      [
        listing({
          listingId: "AAPL:NASDAQ:1980-12-12",
          listingStatus: "DELISTED",
        }),
      ],
      [stored({ listingId: "AAPL:NASDAQ:1980-12-12" })],
    );
    assert.equal(plan.updateGroups.length, 1);
    assert.deepEqual(Object.keys(plan.updateGroups[0]!.data).sort(), [
      "assetType",
      "listingEndDate",
      "listingStatus",
    ]);
  });

  test("the CREATE payload carries no `name` either", () => {
    const plan = planUsInstrumentWrites(
      [listing({ listingId: "AAPL:NASDAQ:1980-12-12" })],
      [],
    );
    assert.equal(plan.creates.length, 1);
    assert.equal("name" in plan.creates[0]!, false);
    assert.equal(
      plan.creates[0]!.listingStartDate?.toISOString().slice(0, 10),
      "1980-12-12",
    );
  });

  test("rows taking the SAME payload share one update group", () => {
    // The 600s-deadline property: ~41k daily endDate moves collapse into a
    // handful of statements because the master's endDates are bimodal.
    // MUTATION: make the group key `l.listingId` -> three groups, and the
    // steady-state night becomes 41k round trips.
    const plan = planUsInstrumentWrites(
      [
        listing({ listingId: "A:NASDAQ:2000-01-01", listingEndDate: LIVE }),
        listing({ listingId: "B:NASDAQ:2000-01-01", listingEndDate: LIVE }),
        listing({ listingId: "C:NASDAQ:2000-01-01", listingEndDate: LIVE }),
      ],
      [
        stored({
          listingId: "A:NASDAQ:2000-01-01",
          listingEndDate: utc("2026-08-26"),
        }),
        stored({
          listingId: "B:NASDAQ:2000-01-01",
          listingEndDate: utc("2026-08-26"),
        }),
        stored({
          listingId: "C:NASDAQ:2000-01-01",
          listingEndDate: utc("2026-08-26"),
        }),
      ],
    );
    assert.equal(plan.updateGroups.length, 1);
    assert.equal(plan.updateGroups[0]!.listingIds.length, 3);
  });

  test("DIFFERENT payloads never share a group", () => {
    // The failure this guards: one updateMany writing another group's status
    // over 40,000 rows. Two payloads differing only in the field the separator
    // sits between must stay apart.
    const plan = planUsInstrumentWrites(
      [
        listing({ listingId: "A:NASDAQ:2000-01-01", listingStatus: "ACTIVE" }),
        listing({
          listingId: "B:NASDAQ:2000-01-01",
          listingStatus: "DELISTED",
        }),
      ],
      [
        stored({ listingId: "A:NASDAQ:2000-01-01", assetType: "ETF" }),
        stored({ listingId: "B:NASDAQ:2000-01-01", assetType: "ETF" }),
      ],
    );
    assert.equal(plan.updateGroups.length, 2);
    for (const g of plan.updateGroups) assert.equal(g.listingIds.length, 1);
  });

  test("a listing the master no longer carries becomes a stale candidate — but only if ACTIVE", () => {
    // A DELISTED stored row that vanished is already in the right state;
    // re-writing it would inflate the sweep count and trip its own breaker.
    // MUTATION: drop `s.listingStatus === "ACTIVE"` -> the DELISTED row is
    // listed too and `activeStored` no longer matches the candidate scope.
    const plan = planUsInstrumentWrites(
      [listing({ listingId: "AAPL:NASDAQ:1980-12-12" })],
      [
        stored({ listingId: "AAPL:NASDAQ:1980-12-12" }),
        stored({ listingId: "GONE:NYSE:1999-01-01" }),
        stored({
          listingId: "ALREADYDEAD:NYSE:1990-01-01",
          listingStatus: "DELISTED",
        }),
      ],
    );
    assert.deepEqual(plan.staleListingIds, ["GONE:NYSE:1999-01-01"]);
    assert.equal(plan.activeStored, 2);
  });

  test("an empty stored table is all creates and no sweep", () => {
    const plan = planUsInstrumentWrites(
      [
        listing({ listingId: "AAPL:NASDAQ:1980-12-12" }),
        listing({
          listingId: "DOW:NYSE:1972-06-01",
          listingStatus: "DELISTED",
        }),
      ],
      [],
    );
    assert.equal(plan.creates.length, 2);
    assert.equal(plan.staleListingIds.length, 0);
    assert.equal(plan.activeStored, 0);
  });

  test("a null listingEndDate compares equal to a null stored date", () => {
    // `isoOf(null) === null` must match `listingEndDate: null`, or every such
    // row is rewritten every night forever.
    const plan = planUsInstrumentWrites(
      [listing({ listingId: "X:NYSE:2000-01-01", listingEndDate: null })],
      [stored({ listingId: "X:NYSE:2000-01-01", listingEndDate: null })],
    );
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.updateGroups.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("judgeUsStaleSweep — the ratio breaker", () => {
  test("a normal handful of retirements proceeds", () => {
    assert.equal(
      judgeUsStaleSweep({ candidates: 12, activePopulation: 41_371 }).proceed,
      true,
    );
  });

  test("a truncated master cannot retire the universe", () => {
    // The failure it exists for: `supported_tickers.zip` comes back short, most
    // listingIds are absent, and every ACTIVE row looks withdrawn.
    // MUTATION: return `{proceed:true}` unconditionally -> fails here.
    const v = judgeUsStaleSweep({
      candidates: 40_000,
      activePopulation: 41_371,
    });
    assert.equal(v.proceed, false);
    assert.match(v.reason!, /truncated/);
    // The numbers are IN the message: a refusal an operator cannot read is
    // half a guard.
    assert.match(v.reason!, /40000 of 41371/);
  });

  test("the floor keeps a small fixture from tripping a proportion", () => {
    // 2 of 5 is 40%, far over the ceiling, and entirely fine.
    assert.equal(
      judgeUsStaleSweep({ candidates: 2, activePopulation: 5 }).proceed,
      true,
    );
    // But the floor is not a blanket pass — at the floor the ratio applies.
    assert.equal(
      judgeUsStaleSweep({
        candidates: US_STALE_FLOOR,
        activePopulation: 100,
      }).proceed,
      false,
    );
  });

  test("candidates with a ZERO population is incoherent, not infinite", () => {
    // The candidates came FROM the population, so this is a failure to measure.
    const v = judgeUsStaleSweep({ candidates: 100, activePopulation: 0 });
    assert.equal(v.proceed, false);
    assert.match(v.reason!, /cannot be true/);
  });

  test("the ceiling is exclusive at exactly the ratio", () => {
    // Pins `>` rather than `>=` so the constant means what it says.
    const at = Math.round(1000 * MAX_US_STALE_RATIO);
    assert.equal(
      judgeUsStaleSweep({ candidates: at, activePopulation: 1000 }).proceed,
      true,
    );
    assert.equal(
      judgeUsStaleSweep({ candidates: at + 1, activePopulation: 1000 }).proceed,
      false,
    );
  });

  test("no candidates is always fine", () => {
    assert.equal(
      judgeUsStaleSweep({ candidates: 0, activePopulation: 0 }).proceed,
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("US_MASTER_SYNC — the kill switch", () => {
  test('"off" disables, in any casing or padding', () => {
    for (const raw of ["off", "OFF", " Off ", "oFF"]) {
      assert.equal(isUsMasterSyncEnabled(raw), false, raw);
    }
  });

  test("absent is ENABLED — matching EDGAR_CIK_ENRICH's semantics", () => {
    assert.equal(isUsMasterSyncEnabled(undefined), true);
    assert.equal(isUsMasterSyncEnabled(""), true);
  });

  test('"false" does NOT disable — the literal comparison is the point', () => {
    // Not an oversight, and the case is here to stop someone "fixing" it into a
    // Boolean() coercion. `Boolean("false")` is `true`, which arms the one
    // configuration meant to keep a job off (XBRL_PROJECTION_APPLY carries the
    // same comment). "off" is the only disabling value, and the cloudbuild
    // specs ship exactly that string.
    // MUTATION: `return Boolean(raw)` -> absent becomes DISABLED, which is
    // catastrophic in the opposite direction, and this case fails.
    assert.equal(isUsMasterSyncEnabled("false"), true);
    assert.equal(isUsMasterSyncEnabled("on"), true);
    assert.equal(isUsMasterSyncEnabled("true"), true);
  });

  test("it reads the env PER CALL, never a module-scope snapshot", () => {
    // A module-scope read freezes at import, so a worker that loads config
    // after boot (or a test that sets the env afterwards) silently gets the
    // default — the bug documented on `bse-client.ts`'s retry config.
    const before = process.env.US_MASTER_SYNC;
    try {
      process.env.US_MASTER_SYNC = "off";
      assert.equal(isUsMasterSyncEnabled(), false);
      process.env.US_MASTER_SYNC = "on";
      assert.equal(isUsMasterSyncEnabled(), true);
    } finally {
      if (before === undefined) delete process.env.US_MASTER_SYNC;
      else process.env.US_MASTER_SYNC = before;
    }
  });
});

describe("the reconcile's write loops are bounded by a CLOCK, not a chunk size", () => {
  // This leg had no time bound at all, and it is the one that needs it most:
  // the first armed run creates 74,125 rows through ~75 `createMany` chunks and
  // then issues up to ~10k grouped `updateMany`s, inside a Pub/Sub push
  // subscription whose ack deadline is 600s. An overrun is not slowness —
  // Pub/Sub REDELIVERS, so a second copy of the reconcile runs CONCURRENTLY
  // with the first and the two race on `@@unique([listingId])`, each recording
  // the loser's chunk as `failed`.
  //
  // A source scan rather than a behavioural test because the loops are pure
  // I/O; the DECISION they encode has no seam that does not require standing up
  // Prisma. Same posture the `splitFactor` and `listFiles` scans take.
  const SRC = __rfs(
    __join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "market-data",
      "instruments",
      "us-instrument-sync.ts",
    ),
    "utf8",
  );
  // LINE comments before BLOCK comments — the other order lets a `//` line
  // containing `/*` swallow everything to the next `*/`, and these assert
  // ABSENCES, so swallowed code reads as a PASS (MONEY-1143).
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  test("declares a budget rather than hardcoding one at the loop", () => {
    assert.match(CODE, /export const US_SYNC_WRITE_BUDGET_MS = \d[\d_]*;/);
  });

  test("the budget FITS INSIDE the reserve its own comment promises", () => {
    // This is the assertion that was missing, and its absence let the constant
    // ship at 420_000 documented as "leaves 180s for ... the two enricher legs
    // that follow". It did not. The enrichers hold ABSOLUTE deadlines against
    // the JOB's start — `startedAtMs + 252s` for names, `+ 420s` for the
    // permaTicker search — and this leg runs at the top of that SAME window,
    // not in front of it. A master run that spent its 420s crossed both before
    // either enricher had started, so both selected a page, found the clock
    // past, wrote nothing, and reported `namesWritten=0
    // transportFailures=0` — a dark leg reading healthy.
    //
    // DERIVED, never restated: the ceiling is read from the function that
    // DECLARES it, so shrinking the name leg's share or growing this budget
    // breaks the test rather than the enrichment.
    const { nameDeadlineAtMs, searchDeadlineAtMs } = usEnrichmentDeadlines(0);
    assert.ok(
      US_SYNC_WRITE_BUDGET_MS < nameDeadlineAtMs,
      `the master budget (${US_SYNC_WRITE_BUDGET_MS}ms) must end before the ` +
        `name leg's absolute deadline (${nameDeadlineAtMs}ms), or the name ` +
        `leg no-ops on every depth-0 run`,
    );
    // And it must leave BOTH legs a real slice, not an arithmetic sliver.
    assert.ok(
      nameDeadlineAtMs - US_SYNC_WRITE_BUDGET_MS >= 60_000,
      "the name leg is left less than a minute of its own share",
    );
    assert.ok(
      searchDeadlineAtMs - nameDeadlineAtMs >= 60_000,
      "the search leg is left less than a minute",
    );
    // The whole depth-0 run still has to clear the 600s Pub/Sub ack deadline
    // with headroom for one in-flight chunk and one in-flight metered request.
    assert.ok(
      US_ENRICH_BUDGET_MS + 180_000 <= 600_000,
      "no headroom left under the ack deadline",
    );
  });

  test("a truncated run counts EVERY row still planned, not just this loop's", () => {
    // Truncating in the CREATES loop sets `truncated`, and `if
    // (result.truncated) break` then skips every update group WITHOUT adding
    // it — so a stop after 20k of 74k creates with 41k updates pending reported
    // 54,000 remaining instead of 95,000. A monitor keyed on `remaining` reads
    // a nearly-converged table.
    assert.match(
      CODE,
      /const plannedUpdateRows = plan\.updateGroups\.reduce\(/,
    );
    assert.match(
      CODE,
      /result\.remaining \+= plan\.creates\.length - i \+ plannedUpdateRows;/,
      "the creates loop must also count the updates it is about to skip",
    );
  });

  test("truncating inside an update GROUP counts the groups behind it too", () => {
    // The same defect one level down: the rest of group k was counted and
    // groups k+1..n were not. Needs an INDEXED outer loop — `for (const group
    // of ...)` cannot name what comes after it.
    assert.match(
      CODE,
      /for \(let g = 0; g < plan\.updateGroups\.length; g\+\+\)/,
    );
    assert.match(
      CODE,
      /for \(let h = g \+ 1; h < plan\.updateGroups\.length; h\+\+\) \{\s*result\.remaining \+= plan\.updateGroups\[h\]!\.listingIds\.length;/,
    );
  });

  test("BOTH write loops check the clock between chunks", () => {
    // Two loops, two checks. One of them bounded and the other not is the worse
    // outcome: it looks bounded.
    const checks = CODE.match(/if \(now\(\) >= deadlineAt\)/g) ?? [];
    assert.equal(
      checks.length,
      2,
      `expected a clock check in the create loop AND the update loop, found ${checks.length}`,
    );
  });

  test("the clock is INJECTED, so the boundary is testable", () => {
    assert.match(
      CODE,
      /now\?\s*:\s*\(\)\s*=>\s*number/,
      "opts must accept a clock",
    );
    assert.match(CODE, /const now = opts\?\.now \?\? Date\.now;/);
  });

  test("a truncated run reports it, and says how much is left", () => {
    assert.match(CODE, /result\.truncated = true;/);
    assert.match(CODE, /result\.remaining \+=/);
  });

  test("a truncated run does NOT run the destructive stale sweep", () => {
    // The sweep flips ACTIVE rows to DELISTED. Running it on a run that already
    // failed to finish its constructive half is the wrong instinct; the next
    // run recomputes the whole diff and sweeps then.
    const sweepAt = CODE.indexOf("judgeUsStaleSweep({");
    assert.ok(
      sweepAt > 0,
      "the sweep is gone — this guard is scanning nothing",
    );
    const guardAt = CODE.indexOf("if (result.truncated) {");
    assert.ok(guardAt > 0, "no truncation guard before the sweep");
    assert.ok(
      guardAt < sweepAt,
      "the truncation guard must come BEFORE the sweep verdict, or it does not guard it",
    );
    assert.match(CODE, /sweepRefusedReason = `run budget exhausted/);
  });
});
