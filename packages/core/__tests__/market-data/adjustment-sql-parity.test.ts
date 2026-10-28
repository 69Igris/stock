/**
 * The SQL adjustment equals the TypeScript one. MONEY-1506 (data-platform B4).
 *
 * ## WHY THIS FILE IS THE WHOLE POINT OF B4
 *
 * The CRSP back-adjustment now has THREE implementations: `computeAdjustedSeries`
 * (TypeScript, validated against Tiingo's own `adjClose` over AAPL's full
 * 11,517-bar series — worst error 0.023%, zero bars off by more than 0.1%),
 * `scripts/quant/read_candles.py` (Python, retired by B7), and
 * `dataform/includes/adjustment.js` (SQL, new here).
 *
 * A SQL adjustment that merely LOOKS right is how a whole price history gets
 * silently restated. Nothing throws: every bar parses, every chart draws, and
 * the series is wrong by a multiple. The only defence is to run both and
 * compare, which is what this does.
 *
 * ## IT EXECUTES SQL, IT DOES NOT READ IT
 *
 * A regex over the SQL text could assert that the words `1 FOLLOWING` appear.
 * It could not tell `ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING` from
 * `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` in the place that matters
 * — this repo's own rule is that a source scan cannot assert a POLICY. So the
 * SQL is executed, in `node:sqlite`: stdlib since Node 22.5, no dependency, no
 * credentials, runs wherever the suite runs.
 *
 * ## WHAT SQLITE PROVES, AND WHAT IT DOES NOT
 *
 * PROVES the algebra — the direction of the walk, that the factors compound,
 * which close a dividend divides by, that volume is scaled by the split alone,
 * that the newest bar keeps its raw price, and that two listings sharing a
 * ticker do not bleed into each other.
 *
 * DOES NOT prove BigQuery's parser accepts the text, nor that its NUMERIC
 * rounding matches. `scripts/ops/adjustment-parity.ts` covers those against the
 * real warehouse using the SAME fixture CSV, the SAME action-path fixture
 * (`fixtures/adjustment-parity-actions.ts`) and the SAME TypeScript reference;
 * it needs credentials, so it is a `verify:push` proof rather than a CI test.
 * That split has a known blind spot, and MONEY-1528 is it: SQLite has no
 * NUMERIC, so BigQuery quantising every factor to nine decimals was invisible
 * here and failed the harness the first time it ran an action row.
 *
 * That split is deliberate: a test that can only run with a service account is
 * a test that does not run.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  computeAdjustedSeries,
  type AdjustedBar,
  type TiingoEodBar,
} from "../../src/market-data/tiingo/tiingo-logic";
import {
  actionFactor,
  buildAdjustmentTimeline,
  factorForDate,
  SOURCE_RANK,
  SOURCE_RANK_DEFAULT,
  type AdjustingAction,
} from "../../src/market-data/price-adjust";
import {
  ACTION_PATH_ACTIONS,
  ACTION_PATH_BARS,
  referenceBars,
} from "./fixtures/adjustment-parity-actions";

/* ─────────────────────────────────────────────────────────────────────────
   The one definition of the SQL
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `dataform/includes/adjustment.js` is loaded by PATH rather than by import
 * specifier.
 *
 * It is a CommonJS file outside every workspace — Dataform requires includes to
 * be plain `.js` with `module.exports`, and the project is not a yarn workspace
 * — so there is no package name to import it under and no `.d.ts` beside it. A
 * dynamic `import()` of a computed path asks TypeScript nothing about
 * resolution and gets the real module at run time, which is exactly the
 * property this test needs: it must load the file Dataform will load, not a
 * copy of it.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const INCLUDE_PATH = join(REPO_ROOT, "dataform/includes/adjustment.js");

interface AdjustmentInclude {
  ADJUSTMENT_POLICY_VERSION: string;
  SOURCE_AUTHORITY: Readonly<Record<string, number>>;
  /** MONEY-1528 — the mirror of `price-adjust.ts`'s `SOURCE_RANK`. */
  ACTION_SOURCE_RANK: Readonly<Record<string, number>>;
  ACTION_SOURCE_RANK_DEFAULT: number;
  PRICE_BASIS_ACTION_TYPES: readonly string[];
  CASH_ACTION_TYPES: readonly string[];
  /** MONEY-1528 (B) — `actionFactor`'s filed-ratio-first types. */
  RATIO_FIRST_ACTION_TYPES: readonly string[];
  sourceAuthoritySql: (column: string) => string;
  typeListSql: (types: readonly string[]) => string;
  adjustedBarD1Sql: (source: string, actionSource: string) => string;
  /** MONEY-1528 (D) — every bar where the view overruled an action. */
  discardedActionSql: (source: string, actionSource: string) => string;
}

const adjustment = (await import(pathToFileURL(INCLUDE_PATH).href)) as {
  default?: AdjustmentInclude;
} & AdjustmentInclude;
/** Node hands CJS back on `default` in some loaders and flat in others. */
const include: AdjustmentInclude = adjustment.default ?? adjustment;

/* ─────────────────────────────────────────────────────────────────────────
   The fixture
   ──────────────────────────────────────────────────────────────────────── */

export interface FixtureRow {
  market: string;
  listing_id: string;
  symbol: string;
  exchange: string;
  session_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  div_cash: number | null;
  split_factor: number | null;
  source: string;
}

const FIXTURE_CSV = join(
  import.meta.dirname,
  "fixtures",
  "adjustment-parity.csv",
);

/**
 * ONE CSV, TWO EXECUTORS.
 *
 * The same file is parsed here and `bq load`-ed by
 * `scripts/ops/adjustment-parity.ts`. A second copy of the fixtures — one for
 * the offline test, one for the BigQuery harness — would let the two agree with
 * their own inputs while disagreeing about the data that matters.
 */
export function loadFixture(
  csv = readFileSync(FIXTURE_CSV, "utf8"),
): FixtureRow[] {
  const lines = csv.trim().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const at = (name: string): string => cells[header.indexOf(name)] ?? "";
    return {
      market: at("market"),
      listing_id: at("listing_id"),
      symbol: at("symbol"),
      exchange: at("exchange"),
      session_date: at("session_date"),
      open: Number(at("open")),
      high: Number(at("high")),
      low: Number(at("low")),
      close: Number(at("close")),
      volume: Number(at("volume")),
      div_cash: Number(at("div_cash")),
      split_factor: Number(at("split_factor")),
      source: at("source"),
    };
  });
}

/** The fixture as `computeAdjustedSeries` wants it, per listing, ascending. */
export function toTiingoBars(rows: readonly FixtureRow[]): TiingoEodBar[] {
  return [...rows]
    .sort((a, b) => a.session_date.localeCompare(b.session_date))
    .map((r) => ({
      date: r.session_date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      // The TypeScript reference has no action-table input: a NULL bar column
      // means "no event on this bar" to it, which is 0 cash and a 1:1 split.
      divCash: r.div_cash ?? 0,
      splitFactor: r.split_factor ?? 1,
    }));
}

function groupByListing(
  rows: readonly FixtureRow[],
): Map<string, FixtureRow[]> {
  const out = new Map<string, FixtureRow[]>();
  for (const r of rows) {
    const list = out.get(r.listing_id) ?? [];
    list.push(r);
    out.set(r.listing_id, list);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   Running the SQL
   ──────────────────────────────────────────────────────────────────────── */

interface SqlRow {
  market: string;
  listing_id: string;
  session_date: string;
  source: string;
  price_factor: number;
  split_factor_cum: number;
  adj_open: number;
  adj_high: number;
  adj_low: number;
  adj_close: number;
  adj_volume: number;
  adjustment_policy_version: string;
}

/** A `lake_silver.corporate_action` row, as the join reads it. MONEY-1516 (b). */
export interface ActionRow {
  market: string;
  listing_id: string;
  action_type: string;
  ex_date: string;
  ratio: number | null;
  /**
   * The gap the price-cliff detector MEASURED (`details.observedRatio` in
   * Mongo), where `ratio` is what it SNAPPED that gap to — MONEY-1528 (B).
   */
  observed_ratio: number | null;
  cash: number | null;
  observed_at: string;
  source_record_key: string;
  /**
   * The PRODUCER. Silver carries it and the fixture did not, so the whole
   * DERIVED-twin rule was untestable here — MONEY-1516 review (#1).
   * "DERIVED" is the price-cliff detector describing an event a feed announced.
   */
  source: string;
}

/** One row of `discardedActionSql`. */
interface DiscardRow {
  market: string;
  listing_id: string;
  session_date: string;
  bar_split_factor: number | null;
  bar_div_cash: number | null;
  bar_source: string;
  action_split: number;
  action_cash: number;
}

/** The SQL under test, both table names as the parity fixture spells them. */
function buildSql(): string {
  return include.adjustedBarD1Sql("price_bar_d1", "corporate_action");
}

/**
 * Execute the gold model's SELECT over an in-memory table of fixture rows.
 *
 * `sql` is passed in rather than built here so the mutation cases below can
 * hand in a DELIBERATELY BROKEN variant and prove the comparison has teeth.
 *
 * `actions` DEFAULTS TO EMPTY, and that default is itself a proof: every case
 * that predates MONEY-1516 (b) runs against an empty `corporate_action` and
 * must produce exactly what it produced before the join existed. A join that
 * changed the US bar-column path would fail those rather than these.
 */
function runSql<Row = SqlRow>(
  rows: readonly FixtureRow[],
  sql: string,
  actions: readonly ActionRow[] = [],
): Row[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE price_bar_d1 (
      market TEXT, listing_id TEXT, symbol TEXT, exchange TEXT,
      session_date TEXT, open REAL, high REAL, low REAL, close REAL,
      volume INTEGER, div_cash REAL, split_factor REAL, source TEXT
    )`);
    db.exec(`CREATE TABLE corporate_action (
      market TEXT, listing_id TEXT, action_type TEXT, ex_date TEXT,
      ratio REAL, observed_ratio REAL, cash REAL, observed_at TEXT,
      source_record_key TEXT, source TEXT
    )`);
    const insert = db.prepare(
      `INSERT INTO price_bar_d1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows) {
      insert.run(
        r.market,
        r.listing_id,
        r.symbol,
        r.exchange,
        r.session_date,
        r.open,
        r.high,
        r.low,
        r.close,
        r.volume,
        r.div_cash,
        r.split_factor,
        r.source,
      );
    }
    const insertAction = db.prepare(
      `INSERT INTO corporate_action VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of actions) {
      insertAction.run(
        a.market,
        a.listing_id,
        a.action_type,
        a.ex_date,
        a.ratio,
        a.observed_ratio,
        a.cash,
        a.observed_at,
        a.source_record_key,
        a.source,
      );
    }
    return db
      .prepare(`${sql} ORDER BY listing_id, session_date`)
      .all() as unknown as Row[];
  } finally {
    db.close();
  }
}

/**
 * Worst RELATIVE disagreement between the SQL and the TypeScript, over every
 * adjusted price of every listing; and the worst ABSOLUTE volume difference.
 *
 * Relative, not absolute, because a back-adjusted price spans six orders of
 * magnitude between a 1980 bar and a 2026 one, and one tolerance cannot be
 * right for both. The denominator is floored at 1 so a near-zero adjusted price
 * cannot manufacture a huge ratio out of a rounding.
 */
function worstDisagreement(
  rows: readonly FixtureRow[],
  sql: string,
  actions: readonly ActionRow[] = [],
): { price: number; volume: number; where: string } {
  const sqlRows = runSql(rows, sql, actions);
  const byListing = groupByListing(rows);
  let price = 0;
  let volume = 0;
  let where = "none";

  for (const [listingId, listingRows] of byListing) {
    // `referenceBars` is `toTiingoBars` plus the action rows, carried onto
    // their ex-date bars wherever the bar states nothing — the shared
    // reference the BigQuery harness compares against too. With no actions it
    // IS `toTiingoBars` for every CSV bar.
    const ts: AdjustedBar[] = computeAdjustedSeries(
      referenceBars(listingRows, actions),
    );
    const mine = sqlRows.filter((r) => r.listing_id === listingId);
    assert.equal(
      mine.length,
      ts.length,
      `${listingId}: SQL returned ${mine.length} rows, TS ${ts.length}`,
    );
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      const s = mine[i]!;
      assert.equal(
        s.session_date,
        t.date,
        `${listingId}: row ${i} is ${s.session_date} in SQL and ${t.date} in TS`,
      );
      const pairs: [string, number, number][] = [
        ["adjOpen", s.adj_open, t.adjOpen],
        ["adjHigh", s.adj_high, t.adjHigh],
        ["adjLow", s.adj_low, t.adjLow],
        ["adjClose", s.adj_close, t.adjClose],
      ];
      for (const [name, got, want] of pairs) {
        const rel = Math.abs(got - want) / Math.max(1, Math.abs(want));
        if (rel > price) {
          price = rel;
          where = `${listingId} ${t.date} ${name}: sql=${got} ts=${want}`;
        }
      }
      const volDiff = Math.abs(s.adj_volume - t.adjVolume);
      if (volDiff > volume) {
        volume = volDiff;
        where = `${listingId} ${t.date} adjVolume: sql=${s.adj_volume} ts=${t.adjVolume}`;
      }
    }
  }
  return { price, volume, where };
}

/**
 * The tolerance, and the reason it is not zero.
 *
 * BigQuery has no cumulative-product window function, so the SQL uses
 * `EXP(SUM(LN(f)))` where the TypeScript multiplies sequentially. Those two
 * differ in the last bits of a double. Measured on this fixture: worst relative
 * disagreement 2.8e-16 — seven orders of magnitude inside this bound, which is
 * the number the B4 brief names.
 *
 * It is also wide enough to absorb BigQuery's NUMERIC(38,9) quantisation of the
 * adjusted prices (≤ 5e-10 absolute), so the BigQuery harness can assert the
 * same bound rather than inventing a second one.
 */
const PARITY_TOLERANCE = 1e-9;

/* ─────────────────────────────────────────────────────────────────────────
   Tests
   ──────────────────────────────────────────────────────────────────────── */

describe("the fixture is real", () => {
  test("five series, a dividend, a split, a coincidence and a recycled ticker", () => {
    const rows = loadFixture();
    // A fixture that silently shrank to nothing would make every assertion
    // below `[] === []`, which is this repo's documented false-green shape.
    assert.ok(rows.length >= 60, `only ${rows.length} fixture rows`);

    const listings = new Set(rows.map((r) => r.listing_id));
    assert.ok(
      listings.size >= 6,
      `only ${listings.size} listings: ${[...listings].join(", ")}`,
    );

    // NON-NULL BY CONSTRUCTION HERE. `FixtureRow` widened to `number | null`
    // for the India cases at the foot of this file (bhavcopy writes NULL in
    // both columns); `loadFixture` reads a CSV and always produces a number, so
    // a NULL in THIS fixture would be a defect in the loader rather than an
    // input the assertions below should tolerate. They say so rather than
    // coalescing, which would make a broken loader read as a fixture with no
    // dividends.
    assert.ok(
      rows.every((r) => r.div_cash !== null && r.split_factor !== null),
      "loadFixture produced a NULL adjustment column from the CSV",
    );
    const cash = (r: FixtureRow): number => r.div_cash as number;
    const split = (r: FixtureRow): number => r.split_factor as number;

    assert.ok(
      rows.some((r) => cash(r) > 0),
      "no dividend in the fixture",
    );
    assert.ok(
      rows.some((r) => split(r) > 1),
      "no forward split in the fixture",
    );
    assert.ok(
      rows.some((r) => split(r) > 0 && split(r) < 1),
      "no REVERSE split in the fixture",
    );
    assert.ok(
      rows.some((r) => split(r) === 0),
      "no zero splitFactor — the 'non-positive means no split' guard is unexercised",
    );
    assert.ok(
      rows.some((r) => cash(r) > 0 && split(r) !== 1),
      "no session carrying BOTH a dividend and a split",
    );

    // The recycled ticker: one symbol, two listing ids, disjoint windows.
    const dow = rows.filter((r) => r.symbol === "DOW");
    const dowListings = new Set(dow.map((r) => r.listing_id));
    assert.equal(
      dowListings.size,
      2,
      "the recycled-ticker case needs exactly two listings for one symbol",
    );
  });
});

describe("SQL == TypeScript", () => {
  test("every adjusted price agrees to 1e-9 and every adjusted volume exactly", (t) => {
    const rows = loadFixture();
    const sql = buildSql();
    const worst = worstDisagreement(rows, sql);

    // REPORTED, not just asserted. The tolerance is 1e-9 and the real
    // disagreement is ~1e-16; printing it means a change that quietly eats the
    // headroom is visible in the run rather than only at the moment it finally
    // crosses the bound.
    t.diagnostic(
      `worst relative price disagreement ${worst.price.toExponential(2)} ` +
        `(tolerance ${PARITY_TOLERANCE.toExponential(0)}), worst volume diff ${worst.volume}`,
    );

    assert.ok(
      worst.price <= PARITY_TOLERANCE,
      `worst relative price disagreement ${worst.price} exceeds ${PARITY_TOLERANCE} at ${worst.where}`,
    );
    assert.equal(
      worst.volume,
      0,
      `adjusted volume disagrees by ${worst.volume} at ${worst.where}`,
    );
  });

  test("the newest bar of every listing keeps its RAW price", () => {
    // The assertion `assert_latest_bar_is_unadjusted.sqlx` makes in BigQuery,
    // made here too: it is the one value that cannot be wrong without the whole
    // series being wrong, and it is what fails first if the walk reverses.
    const rows = loadFixture();
    const sqlRows = runSql(rows, buildSql());
    const newest = new Map<string, SqlRow>();
    for (const r of sqlRows) {
      const seen = newest.get(r.listing_id);
      if (!seen || r.session_date > seen.session_date)
        newest.set(r.listing_id, r);
    }
    assert.ok(newest.size >= 6, `only ${newest.size} listings`);
    for (const [listingId, r] of newest) {
      assert.equal(
        r.price_factor,
        1,
        `${listingId}: newest bar has price_factor ${r.price_factor}, not 1`,
      );
      assert.equal(
        r.split_factor_cum,
        1,
        `${listingId}: newest bar has split_factor_cum ${r.split_factor_cum}, not 1`,
      );
    }
  });

  test("a listing with no corporate action is left completely alone", () => {
    const rows = loadFixture().filter((r) => r.symbol === "CLEAN");
    assert.ok(rows.length >= 10, "the CLEAN series vanished from the fixture");
    for (const r of runSql(rows, buildSql())) {
      assert.equal(r.price_factor, 1);
      assert.equal(r.split_factor_cum, 1);
    }
  });

  test("two listings sharing a ticker do not bleed into each other", () => {
    // `DOW` on NYSE is Dow Chemical (to 2017) AND Dow Inc. (from 2019). A
    // PARTITION BY symbol instead of listing_id would carry Dow Inc.'s 2:1
    // split back across the boundary onto Dow Chemical's prices — a real
    // company's history restated by another company's corporate action, with
    // nothing anywhere reporting it.
    const rows = loadFixture().filter((r) => r.symbol === "DOW");
    const out = runSql(rows, buildSql());

    const chemical = out.filter((r) => r.listing_id === "DOW:NYSE:1972-01-03");
    const inc = out.filter((r) => r.listing_id === "DOW:NYSE:2019-03-20");
    assert.ok(chemical.length > 0 && inc.length > 0);

    // Dow Inc. carries the split; Dow Chemical's window carries only a
    // dividend, so its cumulative SPLIT factor must be exactly 1 throughout.
    for (const r of chemical) {
      assert.equal(
        r.split_factor_cum,
        1,
        `the 1972 listing picked up a split from the 2019 one at ${r.session_date}`,
      );
    }
    assert.ok(
      inc.some((r) => r.split_factor_cum !== 1),
      "the 2019 listing's own split was not applied",
    );
  });
});

describe("the one deliberate divergence from the TypeScript", () => {
  test("a dividend at or above the previous close is REFUSED, not applied", () => {
    // `LN` is undefined at or below zero, so the SQL falls back to a factor of
    // 1 where the TypeScript would compute `1 - divCash/prevClose` <= 0 and
    // multiply the ENTIRE history by it. A >100% single-day yield is a data
    // fault, not a corporate action, and the TypeScript's answer to it is
    // catastrophic rather than merely different.
    //
    // PINNED rather than left to be discovered: this is the one input on which
    // the two implementations are known to disagree, and it must stay a
    // decision rather than becoming a surprise.
    const rows: FixtureRow[] = [
      {
        market: "US",
        listing_id: "BAD:NYSE:2020-01-02",
        symbol: "BAD",
        exchange: "NYSE",
        session_date: "2020-01-02",
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        volume: 100,
        div_cash: 0,
        split_factor: 1,
        source: "TIINGO",
      },
      {
        market: "US",
        listing_id: "BAD:NYSE:2020-01-02",
        symbol: "BAD",
        exchange: "NYSE",
        session_date: "2020-01-03",
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        volume: 100,
        div_cash: 25,
        split_factor: 1,
        source: "TIINGO",
      },
    ];
    const ts = computeAdjustedSeries(toTiingoBars(rows));
    const sql = runSql(rows, buildSql());

    assert.ok(
      ts[0]!.adjClose < 0,
      "the TypeScript no longer produces a negative price here; re-check this divergence",
    );
    assert.equal(
      sql[0]!.price_factor,
      1,
      "the SQL applied a non-positive dividend factor",
    );
    assert.equal(sql[0]!.adj_close, 10);
  });
});

describe("one row per session, chosen by authority", () => {
  test("a YAHOO row beside a BHAVCOPY row for the same session is discarded", () => {
    // `lake_silver.price_bar_d1` is one row per (market, listing_id,
    // session_date, SOURCE) by design — it keeps both witnesses. Without the
    // dedupe, `LAG(close)` takes the OTHER SOURCE'S close for the SAME DAY as
    // "yesterday", which corrupts every dividend factor from that day backward.
    const rows: FixtureRow[] = [
      {
        market: "IN",
        listing_id: "RELIANCE:NSE",
        symbol: "RELIANCE",
        exchange: "NSE",
        session_date: "2024-01-01",
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        div_cash: 0,
        split_factor: 1,
        source: "BHAVCOPY",
      },
      {
        market: "IN",
        listing_id: "RELIANCE:NSE",
        symbol: "RELIANCE",
        exchange: "NSE",
        session_date: "2024-01-01",
        open: 55,
        high: 56,
        low: 54,
        close: 55,
        volume: 10,
        div_cash: 0,
        split_factor: 1,
        source: "YAHOO",
      },
      {
        market: "IN",
        listing_id: "RELIANCE:NSE",
        symbol: "RELIANCE",
        exchange: "NSE",
        session_date: "2024-01-02",
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
        div_cash: 2,
        split_factor: 1,
        source: "BHAVCOPY",
      },
    ];
    const good = buildSql();
    const out = runSql(rows, good);
    assert.equal(out.length, 2, "the duplicate session was not collapsed");
    assert.equal(out[0]!.source, "BHAVCOPY");

    // The dividend on day 2 divides by day 1's BHAVCOPY close (100), not
    // Yahoo's (55). 1 - 2/100 = 0.98.
    assert.ok(
      Math.abs(out[0]!.price_factor - 0.98) < 1e-12,
      `price_factor ${out[0]!.price_factor} — the dividend divided by the wrong close`,
    );

    // MUTATION, aimed at the fixture that exercises the guard. Dropping the
    // authority filter here does two visible things: it returns three rows for
    // two sessions, and it makes `LAG(close)` take the OTHER SOURCE'S close for
    // the SAME DAY as "yesterday" — so the dividend divides by 55 instead of
    // 100 and every earlier price is restated by 2.7%.
    const broken = good.replace("WHERE authority_rank = 1", "WHERE 1 = 1");
    assert.notEqual(broken, good, "the mutation matched nothing");
    const brokenOut = runSql(rows, broken);
    assert.equal(
      brokenOut.length,
      3,
      "the mutation did not reintroduce the duplicate",
    );
    assert.ok(
      brokenOut.every((r) => Math.abs(r.price_factor - 0.98) > 1e-6),
      "the dividend still divided by the right close with the dedupe removed — " +
        "this fixture no longer exercises the guard",
    );
  });

  test("the SQL ranks agree with PRICE_SOURCE_AUTHORITY", async () => {
    // A fourth spelling of the authority order would be the MONEY-1175 defect
    // rebuilt in SQL: two writers deciding precedence locally and disagreeing.
    const { PRICE_SOURCE_AUTHORITY } =
      await import("../../src/market-data/price-source-authority");
    for (const [source, rank] of Object.entries(include.SOURCE_AUTHORITY)) {
      assert.equal(
        PRICE_SOURCE_AUTHORITY[source],
        rank,
        `${source} ranks ${rank} in the SQL and ${String(PRICE_SOURCE_AUTHORITY[source])} in TypeScript`,
      );
    }
    const sql = include.sourceAuthoritySql("source");
    assert.match(sql, /ELSE 1\s*$/m, "an unknown source must rank LAST, not 0");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The comparison has teeth — MUTATION, in the suite rather than by hand
   ──────────────────────────────────────────────────────────────────────── */

describe("a subtly wrong SQL adjustment FAILS this test", () => {
  /**
   * Each case breaks the SQL in a way that produces a complete, plausible,
   * silently-wrong series, and asserts the comparison catches it.
   *
   * IN THE SUITE, NOT IN A COMMIT MESSAGE. "I broke it and it went red" is a
   * claim about a moment; these run on every push, so a later edit that
   * loosens the tolerance or drops an assertion turns them green and is caught
   * by its own absence of failure.
   */
  const mutations: { name: string; mutate: (sql: string) => string }[] = [
    {
      name: "the walk runs FORWARD instead of backward",
      mutate: (sql) =>
        sql.replace(
          "ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING",
          "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING",
        ),
    },
    {
      name: "the factor is not CUMULATIVE — only the next bar contributes",
      mutate: (sql) =>
        sql.replace(
          "ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING",
          "ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING",
        ),
    },
    {
      name: "the frame includes the row's OWN factor",
      mutate: (sql) =>
        sql.replace(
          "ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING",
          "ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING",
        ),
    },
    {
      name: "the split MULTIPLIES where it should divide",
      mutate: (sql) =>
        sql.replace("LN(div_ratio / split_eff)", "LN(div_ratio * split_eff)"),
    },
    {
      name: "the dividend divides by its OWN close, not the previous one",
      mutate: (sql) => sql.replace("/ prev_close", "/ close"),
    },
    {
      name: "volume is scaled by the PRICE factor rather than the split",
      mutate: (sql) =>
        sql.replace(
          "ROUND(volume / split_factor_cum)",
          "ROUND(volume / price_factor)",
        ),
    },
    {
      name: "the series is partitioned by SYMBOL, so a recycled ticker bleeds",
      mutate: (sql) =>
        sql.replaceAll(
          "PARTITION BY market, listing_id\n",
          "PARTITION BY market, symbol\n",
        ),
    },
    // NOT "duplicate sources are not collapsed". That mutation belongs to the
    // dedupe fixture and is asserted there, for a reason worth writing down:
    // run against the CSV it is VACUOUS — the fixture is single-source, so
    // removing `WHERE authority_rank = 1` changes nothing and the case passed
    // by accident of what it was pointed at. A mutation that cannot fail is
    // exactly the "9 assertions passed against BROKEN source" shape, and the
    // honest fix is to aim it at data that exercises the guard rather than to
    // widen the guard until the aimless version goes green.
  ];

  for (const { name, mutate } of mutations) {
    test(name, () => {
      const rows = loadFixture();
      const good = buildSql();
      const broken = mutate(good);
      assert.notEqual(
        broken,
        good,
        `the mutation matched nothing — "${name}" no longer describes this SQL, ` +
          "so it is asserting on an unmutated query and would pass for ever",
      );

      let caught = false;
      try {
        const worst = worstDisagreement(rows, broken);
        caught = worst.price > PARITY_TOLERANCE || worst.volume !== 0;
      } catch {
        // A row-count or date mismatch throws out of `worstDisagreement`;
        // that is a caught mutation too.
        caught = true;
      }
      assert.ok(caught, `the broken SQL ("${name}") went undetected`);
    });
  }
});

describe("the policy version is one string", () => {
  test("the SQL stamps crsp-v3 on every row", () => {
    // BUMPED BY MONEY-1516, and the bump is a ONE-WAY DOOR rather than
    // bookkeeping. `lake-release.ts` stamps this into a release manifest under
    // `releases/{id}/`, written with `overwrite = false` — immutable by
    // BigQuery, not by convention — so a cut carrying the old string can never
    // be relabelled. India factors moved from structurally-1 (every bar had
    // NULL div_cash and split_factor, so every CASE took its ELSE) to a real
    // corporate-action source, and the carrier rule moved `>` to `>=`. A cut
    // before this merge reads TATASTEEL 2022-07-26 adj_close 949.50; one after
    // reads 86.30. Same listing, same session, 11x apart — which is exactly
    // what a policy version exists to tell apart.
    //
    // crsp-v3: MONEY-1528 (observed-gap CAPITAL_ADJUSTMENT, FLOAT64 factors)
    // plus MONEY-1537/1541 (TWIN / COMPOSED / PARTIAL suppression), bumped
    // together with `lake-release-logic.ts` before any release was cut.
    assert.equal(include.ADJUSTMENT_POLICY_VERSION, "crsp-v3");
    const rows = loadFixture();
    const out = runSql(rows, buildSql());
    assert.ok(out.length > 0);
    for (const r of out) {
      assert.equal(r.adjustment_policy_version, "crsp-v3");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   THE CORPORATE-ACTION JOIN — MONEY-1516 (b)

   Everything above runs against an EMPTY `corporate_action`, which is the
   proof that the bar-column path (US) is byte-for-byte what it was. These
   cases exercise the other input, which the TypeScript reference does not
   have: `computeAdjustedSeries` reads a bar's own columns and there is no
   action table to hand it, so the join's proof is MUTATION plus a pinned real
   split in BigQuery (`assert_india_split_is_adjusted.sqlx`), not parity.
   Building a third TypeScript implementation to mirror the join would be the
   one-policy-three-spellings defect this file's own header warns about;
   `price-adjust.ts` is already the action-driven TypeScript one.
   ──────────────────────────────────────────────────────────────────────── */

/** An India bar: NULL in both adjustment columns, as every bhavcopy row is. */
function inBar(session_date: string, close: number): FixtureRow {
  return {
    market: "IN",
    listing_id: "ACME:NSE",
    symbol: "ACME",
    exchange: "NSE",
    session_date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    div_cash: null,
    split_factor: null,
    source: "BHAVCOPY_HIST",
  };
}

/**
 * A bar shaped like a US one: 0 and 1, never NULL.
 *
 * `Candle.divCash` is `Float @default(0)` and `Candle.splitFactor` is
 * `Float @default(1)`, so this is what `lake-replay-us` writes on an ordinary
 * session — and it is the whole reason an action row is UNREACHABLE for a US
 * bar rather than merely out-ranked by one.
 */
function usBar(
  session_date: string,
  close: number,
  splitFactor = 1,
  divCash = 0,
): FixtureRow {
  return {
    ...inBar(session_date, close),
    div_cash: divCash,
    split_factor: splitFactor,
    source: "TIINGO",
  };
}

function action(
  a: Partial<ActionRow> & { action_type: string; ex_date: string },
): ActionRow {
  return {
    market: "IN",
    listing_id: "ACME:NSE",
    ratio: null,
    observed_ratio: null,
    cash: null,
    observed_at: "2026-01-01T00:00:00Z",
    source_record_key: `${a.action_type}:${a.ex_date}`,
    // A FEED by default. A case that wants the detector's row says so.
    source: "NSE",
    ...a,
  };
}

/** Five sessions: 500 before a 5:1 and 100 after. */
const SPLIT_SERIES: FixtureRow[] = [
  inBar("2024-01-01", 500),
  inBar("2024-01-02", 500),
  inBar("2024-01-03", 100),
  inBar("2024-01-04", 100),
  inBar("2024-01-05", 100),
];

/** The same five sessions with US-shaped columns, the split on its ex bar. */
const US_SPLIT_SERIES: FixtureRow[] = [
  usBar("2024-01-01", 500),
  usBar("2024-01-02", 500),
  usBar("2024-01-03", 100, 5),
  usBar("2024-01-04", 100),
  usBar("2024-01-05", 100),
];

/** `session_date -> price_factor`, rounded past the log round-trip's noise. */
function factors(out: readonly SqlRow[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const r of out) by[r.session_date] = Number(r.price_factor.toFixed(9));
  return by;
}

describe("the factors come from corporate_action when the bar has none", () => {
  test("a 5:1 split adjusts every bar STRICTLY BEFORE its ex_date", () => {
    // THE DEFECT MONEY-1516 EXISTS TO CLOSE. Before the join these five bars
    // produced price_factor 1 throughout and adj_close === close, for all
    // 14.3M India rows, and the gold layer reported success.
    const out = runSql(SPLIT_SERIES, buildSql(), [
      action({ action_type: "SPLIT", ex_date: "2024-01-03", ratio: 5 }),
    ]);
    assert.equal(out.length, 5);

    // THE CARRIER IS THE FIRST BAR ON OR AFTER ex_date, and the fixture's own
    // prices say which bar that is: 500, 500, 100 — so 01-03 is the first
    // ex-priced session and 01-03 is the ex_date. Everything strictly before
    // it is divided; the ex bar keeps its raw basis.
    //
    // THIS FIXTURE USED TO SAY 01-02, against a carrier rule of "strictly
    // after". Both halves were one day out and the product was right, which is
    // why the suite stayed green through the defect. MONEY-1516 part (a) fixed
    // the ex_date at the source (48,224 of 59,087 rows moved; prod re-measured
    // at 98.2% of cliffs ON the ex_date bar, 0 Sunday ex-dates), so the
    // compensation came out with it.
    assert.deepEqual(factors(out), {
      "2024-01-01": 0.2,
      "2024-01-02": 0.2,
      "2024-01-03": 1,
      "2024-01-04": 1,
      "2024-01-05": 1,
    });

    // The raw 5x cliff between 01-02 and 01-03 is gone from the adjusted series.
    assert.deepEqual(
      out.map((r) => Number(r.adj_close.toFixed(6))),
      [100, 100, 100, 100, 100],
    );

    // Volume moves the OTHER way: one turnover over five times the shares.
    assert.equal(out[0]!.adj_volume, 5000);
    assert.equal(out[4]!.adj_volume, 1000);
  });

  test("MUTATION: dropping the fallback puts the India adjustment back to 1", () => {
    const good = buildSql();
    const broken = good.replaceAll(
      "COALESCE(bar_split, action_split)",
      "bar_split",
    );
    assert.notEqual(broken, good, "the mutation matched nothing");
    const out = runSql(SPLIT_SERIES, broken, [
      action({ action_type: "SPLIT", ex_date: "2024-01-02", ratio: 5 }),
    ]);
    assert.ok(
      out.every((r) => r.price_factor === 1),
      "the split still applied with the fallback removed — this case proves nothing",
    );
  });

  test("a dividend divides by the PREVIOUS close, from the action table", () => {
    const out = runSql(SPLIT_SERIES.slice(0, 2), buildSql(), [
      action({ action_type: "DIVIDEND", ex_date: "2024-01-02", cash: 10 }),
    ]);
    // Carrier is 01-02, its own ex_date; its prev_close is 01-01's 500, so
    // 1 - 10/500 = 0.98 divides 01-01 and the ex bar keeps its basis. Naming
    // 01-01 here would put the carrier on the FIRST bar of the series, which
    // has no prev_close to divide by — the factor is then 1 and the case
    // proves nothing.
    assert.deepEqual(factors(out), { "2024-01-01": 0.98, "2024-01-02": 1 });
  });

  test("a bar carrying its own factor IGNORES the action row entirely", () => {
    // THE DOUBLE-COUNT HAZARD, in the one shape that will exist the moment
    // MONEY-1513's US bars land beside a US action loader: the bar's own
    // column says 5:1 and a corporate_action row says the same 5:1. Applying
    // both squares it to 25.
    const out = runSql(US_SPLIT_SERIES, buildSql(), [
      action({ action_type: "SPLIT", ex_date: "2024-01-02", ratio: 5 }),
    ]);
    assert.deepEqual(factors(out), {
      "2024-01-01": 0.2,
      "2024-01-02": 0.2,
      "2024-01-03": 1,
      "2024-01-04": 1,
      "2024-01-05": 1,
    });
  });

  test("MUTATION: multiplying the two witnesses squares the adjustment", () => {
    const good = buildSql();
    const broken = good.replaceAll(
      "COALESCE(bar_split, action_split)",
      "(COALESCE(bar_split, 1) * COALESCE(action_split, 1))",
    );
    assert.notEqual(broken, good, "the mutation matched nothing");
    const out = runSql(US_SPLIT_SERIES, broken, [
      action({ action_type: "SPLIT", ex_date: "2024-01-02", ratio: 5 }),
    ]);
    assert.equal(
      factors(out)["2024-01-01"],
      0.04,
      "the naive product no longer squares the adjustment — the guard above is vacuous",
    );
  });

  test("an action for another MARKET never reaches this listing's bars", () => {
    const out = runSql(SPLIT_SERIES, buildSql(), [
      action({
        market: "US",
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 5,
      }),
    ]);
    assert.ok(
      out.every((r) => r.price_factor === 1),
      "a US action row moved an IN bar — `market` is not in the join key",
    );
  });
});

describe("composition, the allowlist, and the append-only key", () => {
  test("a bonus and a split on ONE ex_date MULTIPLY", () => {
    // 167 such pairs on prod. Two share-count changes on one day compose.
    const out = runSql(
      [
        inBar("2024-01-01", 1000),
        inBar("2024-01-02", 1000),
        inBar("2024-01-03", 100),
      ],
      buildSql(),
      [
        action({ action_type: "BONUS", ex_date: "2024-01-02", ratio: 2 }),
        action({ action_type: "SPLIT", ex_date: "2024-01-02", ratio: 5 }),
      ],
    );
    assert.equal(factors(out)["2024-01-01"], 0.1);
  });

  test("a ratio on a non-price-basis type moves nothing", () => {
    // BUYBACK, DEMERGER, MERGER, RIGHTS, REDEMPTION, OTHER, AGM, SUSPENSION,
    // INTEREST_PAYMENT and INCOME_DISTRIBUTION are all real prod values — the
    // vocabulary is 14 wide, not the 6 the Prisma comment lists. An ALLOWLIST
    // ignores a fifteenth type; a denylist would apply it.
    for (const type of ["BUYBACK", "DEMERGER", "MERGER", "RIGHTS", "OTHER"]) {
      const out = runSql(SPLIT_SERIES, buildSql(), [
        action({ action_type: type, ex_date: "2024-01-02", ratio: 5 }),
      ]);
      assert.ok(
        out.every((r) => r.price_factor === 1),
        `${type} moved the price basis`,
      );
    }
  });

  test("cash on a bond distribution is not an equity dividend", () => {
    // Part (a) deliberately does NOT gate `cash` on DIVIDEND, so these rows
    // could start carrying one without any code change here.
    //
    // ON 2024-01-02, NOT 01-01 — MONEY-1528 (E). An ex_date of 01-01 put the
    // carrier on the FIRST bar, which has no prev_close, so div_ratio was 1
    // whatever the allowlist said: widening CASH_ACTION_TYPES to admit
    // INTEREST_PAYMENT left this case byte-identical and green. The sibling
    // DIVIDEND case was moved off 01-01 for exactly that trap; this one was
    // left behind.
    const coupon = (type: string): ActionRow[] => [
      action({ action_type: type, ex_date: "2024-01-02", cash: 10 }),
    ];
    for (const type of [
      "INTEREST_PAYMENT",
      "INCOME_DISTRIBUTION",
      "REDEMPTION",
    ]) {
      const out = runSql(SPLIT_SERIES.slice(0, 2), buildSql(), coupon(type));
      assert.ok(
        out.every((r) => r.price_factor === 1),
        `${type} was applied as a dividend`,
      );
    }

    // MUTATION, in the suite: widen the cash list the way a denylist-minded
    // edit would. Every rendering moves together — the observation filter and
    // the cash CASE are both built from the one constant — so this is the SQL
    // that edit would ship. On 01-02 the coupon now divides 01-01 by 0.98.
    const widened = buildSql().replaceAll(
      "'DIVIDEND'",
      "'DIVIDEND', 'INTEREST_PAYMENT'",
    );
    assert.notEqual(widened, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(
        runSql(SPLIT_SERIES.slice(0, 2), widened, coupon("INTEREST_PAYMENT")),
      )["2024-01-01"],
      0.98,
      "a coupon admitted as a dividend no longer moves the price — this case is vacuous again",
    );
  });

  test("MUTATION: widening the allowlist applies a buyback as a split", () => {
    const good = buildSql();
    const broken = good.replaceAll(
      "'SPLIT', 'BONUS', 'CAPITAL_ADJUSTMENT'",
      "'SPLIT', 'BONUS', 'CAPITAL_ADJUSTMENT', 'BUYBACK'",
    );
    assert.notEqual(broken, good, "the mutation matched nothing");
    const out = runSql(SPLIT_SERIES, broken, [
      action({ action_type: "BUYBACK", ex_date: "2024-01-02", ratio: 5 }),
    ]);
    assert.equal(
      factors(out)["2024-01-01"],
      0.2,
      "widening the allowlist changed nothing — the guard above is vacuous",
    );
  });

  test("APPEND-ONLY: a correction supersedes rather than compounds", () => {
    const out = runSql(SPLIT_SERIES, buildSql(), [
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 5,
        observed_at: "2026-01-01T00:00:00Z",
        source_record_key: "original",
      }),
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 2,
        observed_at: "2026-02-01T00:00:00Z",
        source_record_key: "correction",
      }),
    ]);
    assert.equal(
      factors(out)["2024-01-01"],
      0.5,
      "the corrected 2:1 did not supersede the original 5:1",
    );
  });

  test("the rank table and its default ARE price-adjust.ts's — both directions", () => {
    // The two are declared mirrors and were UNPINNED — `ACTION_SOURCE_RANK`
    // was not exported, so no parity test could be written, while the sibling
    // mirror `SOURCE_AUTHORITY` in the same file is exported and is pinned
    // just below. Same asymmetry the `numeric()` pin closed one package over.
    //
    // TWO-SIDED since MONEY-1537. The first pin compared the SQL table with a
    // LITERAL copied into this file, because `SOURCE_RANK` was not exported:
    // it held the SQL to the copy and let price-adjust.ts drift freely. Now it
    // is the TypeScript table itself, and deepEqual is symmetric — a tier on
    // only one side, or ranked differently, fails.
    assert.deepEqual({ ...include.ACTION_SOURCE_RANK }, { ...SOURCE_RANK });
    assert.equal(include.ACTION_SOURCE_RANK_DEFAULT, SOURCE_RANK_DEFAULT);

    // NSE_HIST must be tested before NSE, or every historical row scores 90.
    const sql = buildSql();
    assert.ok(
      sql.indexOf("'+NSE_HIST+'") < sql.indexOf("'+NSE+'"),
      "tiers must render in descending rank so the first match is the max",
    );
  });

  test("a same-instant tie is broken by SOURCE AUTHORITY, not by an ObjectId", () => {
    // MONEY-1528. `action_latest` ordered by `observed_at DESC,
    // source_record_key DESC` with `source` not consulted, so two producers
    // describing one action in the same load were resolved by whichever
    // Mongo ObjectId string sorted higher. The losing ratio vanished with no
    // counter and every pre-event bar was restated by the wrong multiple.
    //
    // SCREENER (50) against NSE (90), identical ex_date, type and
    // observed_at, and the SCREENER key sorts HIGHER so it would win on the
    // old ordering.
    const disagreeing: readonly ActionRow[] = [
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-03",
        ratio: 5,
        source: "NSE",
        source_record_key: "aaa",
        observed_at: "2026-01-01T00:00:00Z",
      }),
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-03",
        ratio: 2,
        source: "SCREENER",
        source_record_key: "zzz",
        observed_at: "2026-01-01T00:00:00Z",
      }),
    ];
    assert.equal(
      factors(runSql(SPLIT_SERIES, buildSql(), disagreeing))["2024-01-01"],
      0.2,
      "the exchange filing must win — 1/5, not the scraper's 1/2",
    );

    // MUTATION: without the rank the ObjectId decides, and the scraper wins.
    const broken = buildSql().replace(
      /\s*CASE\n\s*WHEN INSTR\('\+' \|\| source[\s\S]*?END DESC,/,
      "",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(runSql(SPLIT_SERIES, broken, disagreeing))["2024-01-01"],
      0.5,
      "the rank is what keeps the scraper from overriding the exchange",
    );

    // A COMPOSITE SOURCE RANKS BY ITS STRONGEST TAG.
    //
    // `mergeCorporateActions` writes a sorted `+`-joined UNION when two feeds
    // describe one event; prod holds `NSE+SCREENER`. An equality test misses
    // every composite and falls to the unknown default of 20 — BELOW a bare
    // SCREENER at 50 — so the MORE corroborated row lost to the less.
    assert.equal(
      factors(
        runSql(SPLIT_SERIES, buildSql(), [
          action({
            action_type: "SPLIT",
            ex_date: "2024-01-03",
            ratio: 5,
            source: "NSE+SCREENER",
            source_record_key: "aaa",
            observed_at: "2026-01-01T00:00:00Z",
          }),
          action({
            action_type: "SPLIT",
            ex_date: "2024-01-03",
            ratio: 2,
            source: "SCREENER",
            source_record_key: "zzz",
            observed_at: "2026-01-01T00:00:00Z",
          }),
        ]),
      )["2024-01-01"],
      0.2,
      "NSE+SCREENER is at least as good as its best tag — it must beat a bare SCREENER",
    );

    // AND A LATER OBSERVATION STILL WINS, whoever filed it — a correction is
    // the whole reason `observed_at` leads the ordering.
    assert.equal(
      factors(
        runSql(SPLIT_SERIES, buildSql(), [
          action({
            action_type: "SPLIT",
            ex_date: "2024-01-03",
            ratio: 5,
            source: "NSE",
            source_record_key: "aaa",
            observed_at: "2026-01-01T00:00:00Z",
          }),
          action({
            action_type: "SPLIT",
            ex_date: "2024-01-03",
            ratio: 2,
            source: "SCREENER",
            source_record_key: "bbb",
            observed_at: "2026-06-01T00:00:00Z",
          }),
        ]),
      )["2024-01-01"],
      0.5,
      "a later observation is a CORRECTION and outranks authority",
    );
  });

  test("MUTATION: dropping the observation filter compounds the correction", () => {
    const good = buildSql();
    const broken = good.replace("WHERE obs_rank = 1", "WHERE obs_rank >= 1");
    assert.notEqual(broken, good, "the mutation matched nothing");
    const out = runSql(SPLIT_SERIES, broken, [
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 5,
        observed_at: "2026-01-01T00:00:00Z",
        source_record_key: "original",
      }),
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 2,
        observed_at: "2026-02-01T00:00:00Z",
        source_record_key: "correction",
      }),
    ]);
    assert.equal(
      factors(out)["2024-01-01"],
      0.1,
      "both observations no longer compound — the append-only guard is vacuous",
    );
  });

  test("the allowlists are EXACTLY the ones the SQL renders — no more, no fewer", () => {
    // A source scan cannot assert a POLICY, but it can stop the exported
    // constants drifting away from the string the SQL is built from.
    //
    // BOTH DIRECTIONS — MONEY-1528 (E). This used to be
    // `assert.match(sql, new RegExp(`'${t}'`))` over the very constants the
    // SQL is rendered FROM: constants ⊆ SQL, never the converse. Appending
    // 'AGM' (a real prod action_type, 14 rows) to the rendered basis list left
    // every case green. So each rendered list is pulled back OUT of the SQL
    // and compared whole — an extra type, a missing one, or a stray unquoted
    // token all fail here.
    const rendered = [...buildSql().matchAll(/action_type IN \(([^)]*)\)/g)]
      .map((m) =>
        m[1]!.split(",").map((t) => t.trim().replace(/^'(.*)'$/, "$1")),
      )
      .map((list) => JSON.stringify(list))
      .sort();
    const basis = include.PRICE_BASIS_ACTION_TYPES;
    const cash = include.CASH_ACTION_TYPES;
    assert.deepEqual(
      rendered,
      [
        [...basis, ...cash], // action_latest: every type the view reads
        [...include.RATIO_FIRST_ACTION_TYPES], // action_latest: factor_ratio
        [...basis], // derived_window: the filings a detection is weighed against
        [...basis], // action_at_bar: the split factor
        [...cash], // action_at_bar: the cash
      ]
        .map((list) => JSON.stringify(list))
        .sort(),
    );
    assert.deepEqual([...include.CASH_ACTION_TYPES], ["DIVIDEND"]);
    assert.ok(
      !include.PRICE_BASIS_ACTION_TYPES.includes("DEMERGER"),
      "DEMERGER would apply twice: the DERIVED twin rule matches on the filed ratio, which no DEMERGER row carries",
    );
  });
});

describe("one event recorded twice is applied ONCE", () => {
  /*
   * WHAT THIS GUARDS, AND WHY IT IS NO LONGER WHAT FOUND IT. The corpus used
   * to MANUFACTURE these: `ex_date` was shifted back one calendar day for part
   * of it (6,857 SUNDAY ex-dates against 4,048 Friday — a UTC round-trip of an
   * IST-midnight Date), so one event written by two producers landed on two
   * adjacent dates. B4 measured 86 ratio pairs and 663 cash pairs. Applying
   * both halves squares the adjustment: 413 of 17,699 India listings, the
   * worst inflated 11x.
   *
   * MONEY-1516 part (a) fixed the rendering and the table was reloaded, and
   * the re-measure on prod says the manufactured pairs are gone: of 26,609
   * factor-bearing candidate pairs, ZERO are now one day apart, and 2,065 of
   * the 2,070 that still collapse are listings `price_bar_d1` holds no bars
   * for at all, where there is nothing to square in either direction.
   *
   * The collapse is KEPT as a net, so these cases are kept too — a rule that
   * squares a factor when it fires is worth one join, and a third date
   * convention arriving from a new producer would reach this table without
   * anyone editing the SQL. What changed is that they now have to state their
   * own preconditions instead of borrowing them from broken data.
   */
  // BOTH SPLIT, and that changed with MONEY-1516 review (#6). This pair used
  // to be SPLIT + BONUS, modelling "two producers filing one event under
  // different type names" — but measured on prod that is not what a cross-type
  // same-date pair IS: 13 of 15 same-source BONUS+SPLIT cliffs measure as
  // ratio SQUARED, i.e. they are two real share-count changes and must both
  // apply. Collapsing them under-divides history by a whole event.
  //
  // The one cross-type duplicate that is real is the DERIVED twin, and it is
  // recognised by SOURCE, not by sharing a date — see the case below.
  const twiceRecorded: readonly ActionRow[] = [
    action({
      action_type: "SPLIT",
      ex_date: "2024-01-03",
      ratio: 5,
      source_record_key: "nse",
    }),
    action({
      action_type: "SPLIT",
      ex_date: "2024-01-04",
      ratio: 5,
      source_record_key: "bse",
    }),
  ];

  test("two records of one split, one session apart, divide by 5 and not 25", () => {
    const out = runSql(SPLIT_SERIES, buildSql(), twiceRecorded);
    assert.equal(factors(out)["2024-01-01"], 0.2);
    // The EARLIEST survives — 01-03, which the fixture's 500/500/100 prices
    // call the real ex bar — so the divide-set ends at 01-02 and the first
    // ex-priced bar keeps its raw basis.
    assert.equal(factors(out)["2024-01-03"], 1);
  });

  test("THE DERIVED TWIN — a detected cliff beside the feed's own filing divides ONCE", () => {
    // THE CRITICAL DEFECT MONEY-1516's REVIEW FOUND, and part (a) is what
    // exposed it. `derive-corporate-actions.ts` runs a price-cliff detector
    // over the bars and files what it sees as a CAPITAL_ADJUSTMENT with source
    // DERIVED; the exchange separately files the SAME event as a BONUS. Mongo's
    // key carries `type`, so both rows exist and describe one corporate action.
    //
    // THE UTC BUG USED TO HIDE IT. DERIVED rows are stored at 00:00Z and feed
    // rows at 18:30Z the previous day, so a UTC render put them on ADJACENT
    // days, where the near-duplicate rule caught them. Rendering in IST — which
    // is correct — lands both on the SAME day, where a rule requiring
    // `later.ex_date > earlier.ex_date` never examines the pair at all.
    //
    // Measured on prod: 31 such groups. INFY carries TWO (2014-12-02 and
    // 2015-06-15), so every INFY bar before 2014 came out divided by 16 where 4
    // is correct; CIPLA 6.25 where 2.5 is right; TCS and LUPIN likewise. The
    // raw cliffs settle which reading is right — they match `ratio` in 27 of 27
    // and `ratio` squared in 0 of 27.
    const twin: readonly ActionRow[] = [
      action({
        action_type: "BONUS",
        ex_date: "2024-01-03",
        ratio: 5,
        source: "NSE",
        source_record_key: "feed",
      }),
      action({
        action_type: "CAPITAL_ADJUSTMENT",
        ex_date: "2024-01-03",
        ratio: 5,
        source: "DERIVED",
        source_record_key: "detector",
      }),
    ];
    assert.equal(
      factors(runSql(SPLIT_SERIES, buildSql(), twin))["2024-01-01"],
      0.2,
      "one event, one division — the detector is describing the cliff the feed announced",
    );

    // MUTATION: without the source rule the two compose and the adjustment
    // SQUARES. This is the INFY number, on a five-bar fixture.
    // Disarm the rule at its SUBJECT, not at its partner predicate: relaxing
    // `f.source <> 'DERIVED'` lets the DERIVED row match ITSELF as the feed
    // witness, so it stays suppressed and the mutation proves nothing.
    // EVERY occurrence: MONEY-1541's `derived_window` names the same subject,
    // and a first-match replace would disarm that and leave this rule armed.
    const broken = buildSql().replaceAll(
      "WHERE d.source = 'DERIVED'",
      "WHERE d.source = 'NO_SUCH_SOURCE'",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(runSql(SPLIT_SERIES, broken, twin))["2024-01-01"],
      0.04,
      "the DERIVED twin no longer squares the adjustment — this case is vacuous",
    );

    // AND IT MUST NOT FIRE THE OTHER WAY. A DERIVED row with NO feed twin is
    // the only witness to a real cliff and has to apply: 156 CAPITAL_ADJUSTMENT
    // cliffs on prod have no feed filing at all.
    assert.equal(
      factors(
        runSql(SPLIT_SERIES, buildSql(), [
          action({
            action_type: "CAPITAL_ADJUSTMENT",
            ex_date: "2024-01-03",
            ratio: 5,
            source: "DERIVED",
          }),
        ]),
      )["2024-01-01"],
      0.2,
      "a lone DERIVED action is the only witness and must still divide",
    );
  });

  test("MUTATION: without the collapse the same split applies twice", () => {
    const good = buildSql();
    const broken = good.replace(
      "cl.carrier_idx - ce.carrier_idx <= 1",
      "cl.carrier_idx - ce.carrier_idx < 0",
    );
    assert.notEqual(broken, good, "the mutation matched nothing");
    const out = runSql(SPLIT_SERIES, broken, twiceRecorded);
    assert.equal(
      factors(out)["2024-01-01"],
      0.04,
      "the duplicate no longer squares the adjustment — the collapse is vacuous",
    );
  });

  test("two GENUINE events with the same ratio are NOT collapsed", () => {
    // INFY declared a 1:1 bonus in 2014 and again in 2015 — same factor, same
    // listing, same source. A rule matching on the factor alone would silently
    // HALVE a real adjustment, which is this defect with the sign flipped.
    // Three sessions separate these (01-02, 01-03, 01-04 lie in the half-open
    // span the collapse counts), so both stand and 01-01 takes both factors.
    const out = runSql(SPLIT_SERIES, buildSql(), [
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 5,
        source_record_key: "a",
      }),
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-05",
        ratio: 5,
        source_record_key: "b",
      }),
    ]);
    assert.equal(factors(out)["2024-01-01"], 0.04);
  });

  test("TWO sessions apart is the closest two GENUINE events may sit — the span's LOWER bound is what says so", () => {
    // THE TIGHTEST STATEMENT OF THE COLLAPSE RULE, and the case that was
    // missing: the test above puts three sessions between its two events, so
    // it passes whether the span counts [earlier, later) or (earlier, later).
    // A mutation loosening that lower bound to exclusive therefore survived it.
    //
    // Here the two ex-dates are the MINIMUM distance apart that must still be
    // treated as two events. Sessions in [01-02, 01-04) are 01-02 and 01-03 —
    // TWO, so the rule's `<= 1` leaves both standing. Drop the lower bound to
    // exclusive and only 01-03 is counted, the pair collapses, and a real 5:1
    // split is silently discarded: the adjustment HALVES rather than squares,
    // which is this defect with the sign flipped and no counter that moves.
    const twoApart: readonly ActionRow[] = [
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-02",
        ratio: 5,
        source_record_key: "a",
      }),
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-04",
        ratio: 5,
        source_record_key: "b",
      }),
    ];
    assert.equal(
      factors(runSql(SPLIT_SERIES, buildSql(), twoApart))["2024-01-01"],
      0.04,
      "both events must apply to the bar before either of them",
    );

    // MUTATION, pinned here rather than described: widening the proximity
    // rule by ONE ordinal swallows a genuine second event. This used to mutate
    // a half-open date span; the span join is gone (it summed across every
    // `earlier` partner — MONEY-1516 review #2) and proximity is now a
    // subtraction of session ordinals, which has exactly one way left to be
    // wrong and this is it.
    const broken = buildSql().replace(
      "cl.carrier_idx - ce.carrier_idx <= 1",
      "cl.carrier_idx - ce.carrier_idx <= 2",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(runSql(SPLIT_SERIES, broken, twoApart))["2024-01-01"],
      0.2,
      "the loosened bound no longer swallows a genuine second event — this case is vacuous",
    );
  });

  test("a duplicate DIVIDEND one session apart pays once", () => {
    // TATASTEEL on prod: two ₹4 rows at 2026-06-11 and 2026-06-12.
    const out = runSql(
      [
        inBar("2024-01-01", 500),
        inBar("2024-01-02", 500),
        inBar("2024-01-03", 500),
      ],
      buildSql(),
      [
        action({
          action_type: "DIVIDEND",
          ex_date: "2024-01-02",
          cash: 10,
          source_record_key: "a",
        }),
        action({
          action_type: "DIVIDEND",
          ex_date: "2024-01-03",
          cash: 10,
          source_record_key: "b",
        }),
      ],
    );
    assert.equal(factors(out)["2024-01-01"], 0.98);
  });

  test("ZERO sessions between also collapses — the two share ONE carrier bar", () => {
    // The rule is `<= 1`, not `= 1`, and this is the half that is easy to get
    // wrong. When NO session falls between two ex-dates they resolve to the
    // SAME carrier, so leaving them uncollapsed multiplies both factors into
    // one bar rather than merely describing an event twice.
    //
    // The bars below have a HOLE: nothing trades between 2024-01-02 and
    // 2024-06-03, which is how an illiquid scrip files a duplicate a day apart
    // over days it did not trade (HIIL:BSE on prod, ~47 sessions in six months,
    // 3:1 bonus on both 2026-07-09 and 2026-07-10 — the strict rule misses it
    // and cubes the adjustment to 9x).
    //
    // The same hole is also how a rule like this MIS-fires, and the cost is
    // written down rather than discovered: CORALFINAC:NSE has no bars between
    // 2001 and 2017, so three genuinely distinct annual dividends look like one
    // repeated. Measured across prod, the whole disagreement between `<= 1` and
    // `= 1` is FIVE listings of 17,699.
    const gapped: FixtureRow[] = [
      inBar("2024-01-01", 500),
      inBar("2024-01-02", 500),
      inBar("2024-06-03", 100),
    ];
    const twice = [
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-03",
        ratio: 5,
        source_record_key: "a",
      }),
      // SAME type — see twiceRecorded above. Cross-type on one carrier is a
      // genuine composition; this case is about one event written twice.
      action({
        action_type: "SPLIT",
        ex_date: "2024-01-04",
        ratio: 5,
        source_record_key: "b",
      }),
    ];
    assert.equal(factors(runSql(gapped, buildSql(), twice))["2024-01-01"], 0.2);

    // MUTATION: `= 1` leaves both on the one carrier and squares it.
    const strict = buildSql().replace(
      "cl.carrier_idx - ce.carrier_idx <= 1",
      "cl.carrier_idx - ce.carrier_idx = 1",
    );
    assert.notEqual(strict, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(runSql(gapped, strict, twice))["2024-01-01"],
      0.04,
      "tightening to exactly-one-session no longer squares a same-carrier duplicate",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1528 — the residue of MONEY-1516
   ──────────────────────────────────────────────────────────────────────── */

describe("the BigQuery harness's action fixture, proven offline — MONEY-1528 (A)", () => {
  test("SQLite equals the shared reference on the composed pair, the observed ratio and a dividend", (t) => {
    // `scripts/ops/adjustment-parity.ts` runs THIS fixture in BigQuery against
    // THIS reference. Proving the pair here first is what makes a red harness
    // a fact about BigQuery rather than a question about the fixture.
    const bars = [...ACTION_PATH_BARS];
    const actions = [...ACTION_PATH_ACTIONS];

    // The fixture is real: a same-ex_date composition, an observed ratio that
    // differs from the filed one on a type that prefers it, and a dividend.
    const basisOn = (d: string): number =>
      actions.filter(
        (a) =>
          include.PRICE_BASIS_ACTION_TYPES.includes(a.action_type) &&
          a.ex_date === d,
      ).length;
    assert.ok(
      actions.some((a) => basisOn(a.ex_date) >= 2),
      "no same-ex_date composed pair — the path the ticket measured is unexercised",
    );
    assert.ok(
      actions.some(
        (a) =>
          !include.RATIO_FIRST_ACTION_TYPES.includes(a.action_type) &&
          a.observed_ratio !== null &&
          a.observed_ratio !== a.ratio,
      ),
      "no observed ratio that differs from the filed one — B is unexercised",
    );
    assert.ok(
      actions.some((a) => include.CASH_ACTION_TYPES.includes(a.action_type)),
      "no dividend",
    );
    assert.ok(
      bars.every((b) => b.div_cash === null && b.split_factor === null),
      "an action-path bar states its own factor, so the COALESCE never falls through",
    );

    const worst = worstDisagreement(bars, buildSql(), actions);
    t.diagnostic(
      `worst relative price disagreement ${worst.price.toExponential(2)}, worst volume diff ${worst.volume}`,
    );
    assert.ok(
      worst.price <= PARITY_TOLERANCE,
      `worst ${worst.price} at ${worst.where}`,
    );
    assert.equal(worst.volume, 0, `volume disagrees at ${worst.where}`);

    // And the actions MOVED something — a join that matched nothing would
    // agree with a reference that applied nothing only if both were 1.
    const pre = runSql(bars, buildSql(), actions).find(
      (r) => r.session_date === "2024-01-01",
    );
    assert.ok(pre && pre.split_factor_cum < 0.02, "the actions did not apply");
  });
});

describe("which ratio divides the price is actionFactor's choice — MONEY-1528 (B)", () => {
  /**
   * (ratio, observed_ratio) pairs covering every branch of `actionFactor`:
   * one usable candidate, both, each one unusable (0, 1, negative, NULL), and
   * neither. The (5, 4.85) cell is the one where the two orderings disagree.
   */
  const CELLS: readonly (readonly [number | null, number | null])[] = [
    [5, null],
    [null, 4.85],
    [5, 4.85],
    [0, 4.85],
    [5, 0],
    [1, 4.85],
    [5, 1],
    [-2, 3],
    [null, null],
    [1, 1],
  ];

  /** What the SQL divides the pre-event bar by, at the columns' scale. */
  function sqlDivisor(
    sql: string,
    type: string,
    ratio: number | null,
    observed: number | null,
  ): number {
    const pre = runSql(SPLIT_SERIES, sql, [
      action({
        action_type: type,
        ex_date: "2024-01-03",
        ratio,
        observed_ratio: observed,
      }),
    ]).find((r) => r.session_date === "2024-01-01");
    assert.ok(pre, "the pre-event bar vanished");
    return Number((1 / pre.price_factor).toFixed(6));
  }

  /** What the chart divides it by. */
  function tsDivisor(
    type: string,
    ratio: number | null,
    observed: number | null,
  ): number {
    const f = actionFactor({
      type,
      exDate: new Date("2024-01-03T00:00:00Z"),
      ratio,
      details: observed === null ? null : { observedRatio: observed },
    });
    return Number((f ?? 1).toFixed(6));
  }

  test("the SQL divides by exactly what actionFactor returns, for every price-basis type", () => {
    // THE PIN, and it is an execution rather than a comparison of two lists,
    // because the ordering lives in a ternary on one side and a CASE on the
    // other. Either moving alone turns a cell red.
    for (const type of include.PRICE_BASIS_ACTION_TYPES) {
      for (const [ratio, observed] of CELLS) {
        assert.equal(
          sqlDivisor(buildSql(), type, ratio, observed),
          tsDivisor(type, ratio, observed),
          `${type} ratio=${String(ratio)} observed=${String(observed)}`,
        );
      }
    }
    // A matrix in which the orderings never disagree pins nothing.
    assert.notEqual(
      tsDivisor("SPLIT", 5, 4.85),
      tsDivisor("CAPITAL_ADJUSTMENT", 5, 4.85),
    );
  });

  test("MUTATION: reading the filed ratio first for a CAPITAL_ADJUSTMENT breaks the pin", () => {
    // The state before MONEY-1528 (B): gold divided a detector cliff by the
    // SNAPPED 2 where the chart divided it by the observed 1.940678.
    const broken = buildSql().replace(
      "action_type IN ('SPLIT', 'BONUS') THEN",
      "action_type IN ('SPLIT', 'BONUS', 'CAPITAL_ADJUSTMENT') THEN",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    assert.equal(sqlDivisor(broken, "CAPITAL_ADJUSTMENT", 2, 1.940678), 2);
    assert.equal(tsDivisor("CAPITAL_ADJUSTMENT", 2, 1.940678), 1.940678);
  });

  test("the DERIVED twin is still recognised by its FILED ratio, whatever it observed", () => {
    // The observed gap carries the ex-session's own market move, so a twin's
    // observation routinely strays from the feed's ratio while its SNAPPED
    // ratio equals it exactly (33 of 33 on prod). Matching twins on the factor
    // instead would miss this one and divide by 5 x 5.2.
    const twin: readonly ActionRow[] = [
      action({
        action_type: "BONUS",
        ex_date: "2024-01-03",
        ratio: 5,
        source: "NSE",
        source_record_key: "feed",
      }),
      action({
        action_type: "CAPITAL_ADJUSTMENT",
        ex_date: "2024-01-03",
        ratio: 5,
        observed_ratio: 5.2,
        source: "DERIVED",
        source_record_key: "detector",
      }),
    ];
    assert.equal(
      factors(runSql(SPLIT_SERIES, buildSql(), twin))["2024-01-01"],
      0.2,
      "one event, one division, by the feed's ratio",
    );

    // MUTATION: recognise the twin by the FACTOR it applies instead.
    const byFactor = buildSql().replace(
      "COALESCE(f.ratio, -1) = COALESCE(d.ratio, -1)",
      "COALESCE(f.factor_ratio, -1) = COALESCE(d.factor_ratio, -1)",
    );
    assert.notEqual(byFactor, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(runSql(SPLIT_SERIES, byFactor, twin))["2024-01-01"],
      Number((1 / (5 * 5.2)).toFixed(9)),
      "matching on the factor no longer misses the twin — this case proves nothing",
    );
  });
});

describe("a witness the bar overrules is REPORTED, never applied — MONEY-1528 (D)", () => {
  const DISCARD_SQL = (): string =>
    include.discardedActionSql("price_bar_d1", "corporate_action");

  /**
   * Five US-shaped sessions stating NO event: a concrete 1 and 0 on every bar,
   * which is what `lake-replay-us` writes on an ordinary day (the Candle layer
   * rewrites an absent value to exactly these before it is stored).
   */
  const US_QUIET: FixtureRow[] = [
    usBar("2024-01-01", 500),
    usBar("2024-01-02", 500),
    usBar("2024-01-03", 100),
    usBar("2024-01-04", 100),
    usBar("2024-01-05", 100),
  ];

  test("a US bar's 1 overrules a split row: the view keeps the bar, the report names it", () => {
    const acts = [
      action({ action_type: "SPLIT", ex_date: "2024-01-03", ratio: 5 }),
    ];
    // THE POLICY, pinned: the bar's statement wins. Letting the action fill a
    // session the vendor declared split-free is how a one-session date
    // disagreement becomes a squared adjustment.
    assert.ok(
      runSql(US_QUIET, buildSql(), acts).every((r) => r.price_factor === 1),
      "the action filled a bar that states no split",
    );
    // …and it is no longer silent.
    const found = runSql<DiscardRow>(US_QUIET, DISCARD_SQL(), acts);
    assert.deepEqual(
      found.map((r) => [
        r.session_date,
        r.bar_split_factor,
        // EXP(LN(5)) is 5 only to the last binary digit.
        Number(r.action_split.toFixed(9)),
      ]),
      [["2024-01-03", 1, 5]],
    );
  });

  test("a US bar's 0 overrules a dividend row, and the report names that too", () => {
    const acts = [
      action({ action_type: "DIVIDEND", ex_date: "2024-01-02", cash: 10 }),
    ];
    assert.ok(
      runSql(US_QUIET, buildSql(), acts).every((r) => r.price_factor === 1),
      "the action filled a bar that states no dividend",
    );
    const found = runSql<DiscardRow>(US_QUIET, DISCARD_SQL(), acts);
    assert.deepEqual(
      found.map((r) => [r.session_date, r.bar_div_cash, r.action_cash]),
      [["2024-01-02", 0, 10]],
    );
  });

  test("an AGREEING witness is not a discard, and neither is a bar that states nothing", () => {
    // Redundant: the bar and the action both say 5:1 on the same session.
    // That is the older half's OVERLAP finding, not a discard.
    assert.deepEqual(
      runSql(US_SPLIT_SERIES, DISCARD_SQL(), [
        action({ action_type: "SPLIT", ex_date: "2024-01-03", ratio: 5 }),
      ]),
      [],
    );
    // India: NULL in both columns, so the action APPLIES — nothing overruled.
    const acts = [
      action({ action_type: "SPLIT", ex_date: "2024-01-03", ratio: 5 }),
      action({ action_type: "DIVIDEND", ex_date: "2024-01-02", cash: 10 }),
    ];
    assert.deepEqual(runSql(SPLIT_SERIES, DISCARD_SQL(), acts), []);
    assert.equal(
      factors(runSql(SPLIT_SERIES, buildSql(), acts))["2024-01-01"],
      0.196,
    );
  });

  test("MUTATION: the older half's value filter makes the report blind again", () => {
    // `split_factor <> 1` and `div_cash > 0` are right for a ±3-day window of
    // ordinary sessions and wrong here: they exclude exactly the values a
    // discarding bar carries.
    const blind = DISCARD_SQL()
      .replace(
        "AND bar_split IS NOT NULL",
        "AND bar_split IS NOT NULL AND bar_split <> 1",
      )
      .replace(
        "AND bar_cash IS NOT NULL",
        "AND bar_cash IS NOT NULL AND bar_cash > 0",
      );
    assert.notEqual(blind, DISCARD_SQL(), "the mutation matched nothing");
    assert.deepEqual(
      runSql(US_QUIET, blind, [
        action({ action_type: "SPLIT", ex_date: "2024-01-03", ratio: 5 }),
        action({ action_type: "DIVIDEND", ex_date: "2024-01-02", cash: 10 }),
      ]),
      [],
      "the value filter no longer hides the discard — this case proves nothing",
    );
  });

  test("a non-positive split factor and a negative dividend STATE NOTHING, so the action fills", () => {
    // MONEY-1516 review #5, closed for both columns. The COALESCE's notion of
    // "has a value" must be the CASE's notion of "is usable as a statement",
    // or a garbage value blocks the action and is then thrown away itself.
    // NULLIF(split_factor, 0) closed it for one value of one column.
    const garbage: FixtureRow[] = [
      usBar("2024-01-01", 500),
      usBar("2024-01-02", 500),
      usBar("2024-01-03", 100, -1, -1),
    ];
    const acts = [
      action({ action_type: "SPLIT", ex_date: "2024-01-03", ratio: 5 }),
      action({ action_type: "DIVIDEND", ex_date: "2024-01-03", cash: 10 }),
    ];
    // 01-02 is divided by the split AND the dividend (1 - 10/500 = 0.98).
    assert.equal(
      factors(runSql(garbage, buildSql(), acts))["2024-01-02"],
      0.196,
    );
    assert.deepEqual(runSql(garbage, DISCARD_SQL(), acts), []);

    // MUTATION: the old "has a value" notion — NOT NULL, with 0 alone
    // excepted for the split — lets both garbage values block their action.
    const old = buildSql()
      .replace(
        "CAST(CASE WHEN b.split_factor > 0 THEN b.split_factor END AS FLOAT64) AS bar_split",
        "CAST(NULLIF(b.split_factor, 0) AS FLOAT64) AS bar_split",
      )
      .replace(
        "CASE WHEN b.div_cash >= 0 THEN b.div_cash END AS bar_cash",
        "b.div_cash AS bar_cash",
      );
    assert.notEqual(old, buildSql(), "the mutation matched nothing");
    assert.equal(
      factors(runSql(garbage, old, acts))["2024-01-02"],
      1,
      "the garbage values no longer block the action — this case proves nothing",
    );
  });
});

describe("a detection beside a feed filing: the chart and gold decide alike — MONEY-1541", () => {
  /*
   * ONE FIXTURE, BOTH IMPLEMENTATIONS. Each case is a listing's action rows in
   * silver's shape; `asStored` turns them into the Mongo rows the chart reads,
   * stamped the way the store stamps them (a feed row at IST midnight of its
   * ex-date = 18:30Z the day before, the detector at 00:00Z). The pre-event
   * divisor is then read from BOTH `buildAdjustmentTimeline` and the gold SQL,
   * and must agree — and equal the expectation, so a case where both sides
   * are wrong the same way still fails.
   *
   * The shapes are the prod rows the ticket named, moved onto a five-session
   * fixture. The TypeScript counts calendar days and gold counts sessions, so
   * every case keeps the two readings of "one event" in agreement: bars on
   * consecutive days, or (VEGA) no bar at all between the filing and the
   * detection.
   */
  function asStored(a: ActionRow): AdjustingAction {
    return {
      type: a.action_type,
      exDate: new Date(
        a.source === "DERIVED"
          ? `${a.ex_date}T00:00:00.000Z`
          : `${a.ex_date}T00:00:00.000+05:30`,
      ),
      ratio: a.ratio,
      source: a.source,
      details:
        a.observed_ratio === null ? null : { observedRatio: a.observed_ratio },
    };
  }
  const feed = (type: string, ex: string, ratio: number | null): ActionRow =>
    action({
      action_type: type,
      ex_date: ex,
      ratio,
      source_record_key: `${type}:${ex}`,
    });
  const detected = (ex: string, ratio: number, observed: number): ActionRow =>
    action({
      action_type: "CAPITAL_ADJUSTMENT",
      ex_date: ex,
      ratio,
      observed_ratio: observed,
      source: "DERIVED",
      source_record_key: "detector",
    });

  /** VEGA's shape: no exchange print between the ex-date and the detection. */
  const ILLIQUID: FixtureRow[] = [
    inBar("2024-01-01", 312.25),
    inBar("2024-01-02", 312.25),
    inBar("2024-01-08", 61.95),
    inBar("2024-01-09", 61.95),
  ];

  /** Seven weekday sessions, Monday 2024-01-01 to Tuesday 01-09. */
  const WEEK: FixtureRow[] = [
    "2024-01-01",
    "2024-01-02",
    "2024-01-03",
    "2024-01-04",
    "2024-01-05",
    "2024-01-08",
    "2024-01-09",
  ].map((d) => inBar(d, 100));

  const CASES: readonly {
    name: string;
    bars: FixtureRow[];
    rows: ActionRow[];
    divisor: number;
  }[] = [
    {
      // SUDARSCHEM 2014: 102.88 on the chart, 10 by the raw cliff.
      name: "COMPOSED — BONUS 2 + SPLIT 5 beside a detected 10 divide by 10",
      bars: SPLIT_SERIES,
      rows: [
        feed("BONUS", "2024-01-03", 2),
        feed("SPLIT", "2024-01-03", 5),
        detected("2024-01-03", 10, 10.28832116788321),
      ],
      divisor: 10,
    },
    {
      // One event filed by two producers a session apart is ONE factor in the
      // product — the chart's NSE + BSE rows, gold's near-duplicate pair.
      name: "COMPOSED, with the split filed twice, still divides by 10",
      bars: SPLIT_SERIES,
      rows: [
        feed("BONUS", "2024-01-03", 2),
        feed("SPLIT", "2024-01-03", 5),
        feed("SPLIT", "2024-01-04", 5),
        detected("2024-01-03", 10, 10.28832116788321),
      ],
      divisor: 10,
    },
    {
      // The detector may date the cliff one session late; gold's reach is one
      // carrier either way, the chart's DERIVED_WITNESS_DAYS.
      name: "COMPOSED, detected the NEXT session, still divides by 10",
      bars: SPLIT_SERIES,
      rows: [
        feed("BONUS", "2024-01-03", 2),
        feed("SPLIT", "2024-01-03", 5),
        detected("2024-01-04", 10, 10.28832116788321),
      ],
      divisor: 10,
    },
    {
      // TORNTPHARM 2006 (chart) and SUDARSCHEM:NSE 2014 (gold): the feed
      // recorded part of the cliff. Both applied: 8.13 and 51.44.
      name: "PARTIAL — BONUS 2 beside a detected 4 divides by the detection alone",
      bars: SPLIT_SERIES,
      rows: [
        feed("BONUS", "2024-01-03", 2),
        detected("2024-01-03", 4, 4.067139282735613),
      ],
      divisor: 4.067139,
    },
    {
      // MAHSEAMLES 2006: the feed filed the SPLIT with no ratio, so there is
      // no product — the detection is the only witness and must survive.
      name: "RATIO-LESS FILING — the detection applies",
      bars: SPLIT_SERIES,
      rows: [
        feed("SPLIT", "2024-01-03", null),
        detected("2024-01-03", 2, 1.969122911694511),
      ],
      divisor: 1.969123,
    },
    {
      // VEGA 2026: BSE BONUS 5 ex 04-24, no BSE print until 04-28. The chart
      // divided by 25.20 because 4.23 days is past SAME_EVENT_DAYS.
      name: "TRAILING TWIN — a detection four days after the filing is the same event",
      bars: ILLIQUID,
      rows: [
        feed("BONUS", "2024-01-04", 5),
        detected("2024-01-08", 5, 5.040355125100888),
      ],
      divisor: 5,
    },
    {
      // ONGC 2011, no detector involved: a bonus and a split of EQUAL ratio
      // are two share-count changes. Gold has always required a matching
      // action_type to collapse; the chart merged on the factor alone.
      name: "BONUS 2 + SPLIT 2 on one ex-date divide by 4",
      bars: SPLIT_SERIES,
      rows: [feed("BONUS", "2024-01-03", 2), feed("SPLIT", "2024-01-03", 2)],
      divisor: 4,
    },
    {
      // Two events a week apart: the feed filed Tuesday's bonus, the detector
      // saw a different cliff the next Monday. Neither is part of the other —
      // PARTIAL must not reach this far, or it drops the bonus.
      name: "A BONUS AND A LATER, DIFFERENT CLIFF — both apply",
      bars: WEEK,
      rows: [feed("BONUS", "2024-01-02", 2), detected("2024-01-08", 5, 5.1)],
      divisor: 10.2,
    },
    {
      // No prod row has this shape. A filing and a cliff disagree the other
      // way and neither is preferred — both apply, exactly as before.
      name: "PRODUCT ABOVE THE DETECTION — left alone",
      bars: SPLIT_SERIES,
      rows: [feed("SPLIT", "2024-01-03", 10), detected("2024-01-03", 5, 5.1)],
      divisor: 51,
    },
  ];

  const caseNamed = (prefix: string): (typeof CASES)[number] => {
    const c = CASES.find((k) => k.name.startsWith(prefix));
    assert.ok(c, `no case named ${prefix}`);
    return c;
  };

  function tsDivisor(rows: readonly ActionRow[], firstBar: string): number {
    const { steps } = buildAdjustmentTimeline(rows.map(asStored));
    return Number(
      factorForDate(steps, new Date(`${firstBar}T00:00:00.000Z`)).toFixed(6),
    );
  }
  function sqlDivisor(
    sql: string,
    bars: readonly FixtureRow[],
    rows: readonly ActionRow[],
  ): number {
    const first = runSql(bars, sql, rows)[0];
    assert.ok(first, "the fixture produced no bars");
    return Number((1 / first.price_factor).toFixed(6));
  }

  for (const c of CASES) {
    test(c.name, () => {
      const first = c.bars[0]!.session_date;
      assert.equal(tsDivisor(c.rows, first), c.divisor, "the chart");
      assert.equal(sqlDivisor(buildSql(), c.bars, c.rows), c.divisor, "gold");
    });
  }

  test("MUTATION: without the composed arm gold divides SUDARSCHEM twice", () => {
    const broken = buildSql().replace(
      "WHERE has_twin = 0 AND feed_product = ROUND(d_ratio, 6)",
      "WHERE 1 = 0",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    const c = caseNamed("COMPOSED — ");
    assert.equal(
      sqlDivisor(broken, c.bars, c.rows),
      Number((10 * 10.28832116788321).toFixed(6)),
    );
  });

  test("MUTATION: without the partial arm gold divides TORNTPHARM twice", () => {
    const broken = buildSql().replace(
      "AND v.feed_product < ROUND(v.d_ratio, 6)",
      "AND 1 = 0",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    const c = caseNamed("PARTIAL");
    assert.equal(
      sqlDivisor(broken, c.bars, c.rows),
      Number((2 * 4.067139282735613).toFixed(6)),
    );
  });

  test("MUTATION: a product ABOVE the detection must not suppress the filing", () => {
    // The bound that makes PARTIAL safe is one-sided; `<>` for `<` would let
    // a detected 5 overrule a filed 10.
    const broken = buildSql().replace(
      "AND v.feed_product < ROUND(v.d_ratio, 6)",
      "AND v.feed_product <> ROUND(v.d_ratio, 6)",
    );
    assert.notEqual(broken, buildSql(), "the mutation matched nothing");
    const c = caseNamed("PRODUCT ABOVE");
    assert.equal(sqlDivisor(broken, c.bars, c.rows), 5.1);
  });
});
