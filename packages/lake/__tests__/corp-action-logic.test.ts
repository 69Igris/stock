/**
 * Mongo `corporate_actions` -> `lake_silver.corporate_action`. MONEY-1516 (a).
 *
 * The mapper's keys ARE column names — the sink writes with
 * `INSERT ... SELECT FROM UNNEST(@rows)`, which reads each struct field BY
 * NAME. A camelCase key does not fail; it supplies NULL for its column and the
 * statement reports success. So the row shape is pinned against the DDL TEXT
 * rather than against itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CORP_ACTION_PARSER_VERSION,
  CORP_ACTION_SOURCE_OBJECT_URI,
  CORP_ACTION_UNKNOWN_SOURCE,
  CORP_ACTION_VENUE_MARKET,
  ORPHAN_PRUNE_MIN_READ_RATIO,
  appendThenPrune,
  corpActionSilverKey,
  joinCoverage,
  numKey,
  numWire,
  planCorpActionAppend,
  planOrphanPrune,
  planRestatedPrune,
  RESTATED_KEY_SQL,
  restatedKey,
  toCorpActionSilverRow,
  toCorpActionWireRow,
  type MongoCorporateActionRow,
} from "../src/corp-action-logic";
import type { ListingIdBuilder } from "../src/india-sink-logic";

/**
 * Stands in for core's `buildListingId`, which this package cannot import. It
 * spells its ARGUMENTS back, so these cases pin what the mapper asks for; the
 * real spelling is pinned against prod ids in
 * `packages/core/__tests__/market-data/listing-id.test.ts`.
 */
const ID: ListingIdBuilder = (symbol, exchange, start) =>
  `id(${symbol}|${exchange}|${String(start)})`;

const DDL = readFileSync(
  join(import.meta.dirname, "..", "ddl", "002_silver_price_bars.sql"),
  "utf8",
);

/** Just the `corporate_action` CREATE TABLE block. */
const CORP_ACTION_DDL = (() => {
  const i = DDL.indexOf("`{{DATASET}}.corporate_action`");
  assert.ok(i > 0, "the DDL no longer declares corporate_action");
  return DDL.slice(i);
})();

function mongoAction(
  overrides: Partial<MongoCorporateActionRow> = {},
): MongoCorporateActionRow {
  return {
    id: "6a3506303c889025f47a57e4",
    symbol: "LEMERITE",
    exchange: "NSE",
    type: "SPLIT",
    exDate: new Date("2026-05-29T00:00:00.000Z"),
    recordDate: new Date("2026-05-29T00:00:00.000Z"),
    ratio: 5,
    dividendPerShare: null,
    source: "NSE",
    // An exchange row's `details` is the announcement TEXT — the shape 59,049
    // of prod's 59,224 rows carry (measured 2026-09-23).
    details:
      "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share",
    createdAt: new Date("2026-06-19T09:04:48.387Z"),
    updatedAt: new Date("2026-06-27T23:02:51.853Z"),
    ...overrides,
  };
}

/**
 * A real prod DERIVED row, verbatim (IVZINNIFTY, 2026-07-31) — the only
 * producer whose `details` is an OBJECT, and the only one carrying an observed
 * ratio beside the snapped one.
 */
function derivedAction(
  overrides: Partial<MongoCorporateActionRow> = {},
): MongoCorporateActionRow {
  return mongoAction({
    id: "6a7c4ad3c76486c7e9feada5",
    symbol: "IVZINNIFTY",
    type: "CAPITAL_ADJUSTMENT",
    exDate: new Date("2026-07-31T00:00:00.000Z"),
    recordDate: null,
    ratio: 10,
    source: "DERIVED",
    details: {
      method: "price-derived",
      observedRatio: 9.931249554494263,
      snappedRatio: 10,
      prevClose: 2786.51,
      exClose: 280.58,
      confidence: "high",
      volumeRatio: 13.30544435548439,
    },
    createdAt: new Date("2026-08-12T10:28:35.701Z"),
    updatedAt: new Date("2026-08-12T10:28:35.701Z"),
    ...overrides,
  });
}

function ok(a: MongoCorporateActionRow) {
  const r = toCorpActionSilverRow(a, ID);
  assert.equal(r.ok, true, `expected a mapped row, got ${JSON.stringify(r)}`);
  assert.ok(r.ok);
  return r.row;
}

describe("toCorpActionSilverRow", () => {
  it("asks core's builder for the ONE spelling — (symbol, exchange, no start date)", () => {
    // MONEY-1522. This loader used to emit the BAR's two-part id on purpose,
    // because India's bars and `listing` shared no key. There is one spelling
    // now — `buildListingId(sym, exch, null)`, `{symbol}:{exchange}:unknown` —
    // and the halves reach the builder TRIMMED, as they always did.
    assert.equal(
      ok(mongoAction({ symbol: " LEMERITE ", exchange: "NSE " })).listing_id,
      "id(LEMERITE|NSE|null)",
    );
    assert.ok(
      CORP_ACTION_DDL.includes("listing_id        STRING    NOT NULL"),
      "listing_id is no longer NOT NULL in the DDL",
    );
  });

  it("derives market from the venue rather than defaulting to IN", () => {
    assert.equal(ok(mongoAction({ exchange: "BSE" })).market, "IN");
    assert.deepEqual(Object.keys(CORP_ACTION_VENUE_MARKET).sort(), [
      "BSE",
      "NSE",
    ]);
  });

  it("ROUNDS ratio to the column's scale — prod holds 1.333333333333333", () => {
    // MONEY-1512. NUMERIC(18, 6) REFUSES more decimals than it declares and the
    // load path runs maxBadRecords: 0, so this one row fails the whole job.
    const row = ok(mongoAction({ ratio: 1.333333333333333 }));
    assert.equal(row.ratio, 1.333333);
    assert.equal(toCorpActionWireRow(row).ratio, "1.333333");
    assert.ok(
      CORP_ACTION_DDL.includes("ratio             NUMERIC(18, 6)"),
      "ratio is no longer NUMERIC(18, 6)",
    );
  });

  it("rounds cash to the same scale", () => {
    const row = ok(
      mongoAction({ type: "DIVIDEND", dividendPerShare: 3.62894999 }),
    );
    assert.equal(row.cash, 3.62895);
    assert.equal(toCorpActionWireRow(row).cash, "3.628950");
    assert.ok(CORP_ACTION_DDL.includes("cash              NUMERIC(18, 6)"));
  });

  it("carries cash for a non-DIVIDEND type too", () => {
    // Prod holds dividendPerShare on INTEREST_PAYMENT and INCOME_DISTRIBUTION
    // rows; the DDL calls the column "cash per share", not "dividend".
    const row = ok(
      mongoAction({
        type: "INTEREST_PAYMENT",
        ratio: null,
        dividendPerShare: 4.5,
      }),
    );
    assert.equal(row.cash, 4.5);
  });

  it("leaves ratio and cash NULL rather than 0 when the source states neither", () => {
    const row = ok(mongoAction({ ratio: null, dividendPerShare: null }));
    assert.equal(row.ratio, null);
    assert.equal(row.cash, null);
    assert.equal(toCorpActionWireRow(row).ratio, null);
  });

  it("puts every mapped column on the wire — a dropped one lands NULL silently", () => {
    const row = ok(mongoAction());
    assert.deepEqual(
      Object.keys(toCorpActionWireRow(row)).sort(),
      Object.keys(row).sort(),
    );
  });

  it("names an absent source rather than writing an empty NOT NULL string", () => {
    assert.equal(
      ok(mongoAction({ source: null })).source,
      CORP_ACTION_UNKNOWN_SOURCE,
    );
    assert.equal(
      ok(mongoAction({ source: "   " })).source,
      CORP_ACTION_UNKNOWN_SOURCE,
    );
    assert.ok(CORP_ACTION_DDL.includes("source            STRING    NOT NULL"));
  });

  it("maps published_at from createdAt and observed_at from updatedAt", () => {
    const row = ok(mongoAction());
    assert.equal(row.published_at, "2026-06-19T09:04:48.387Z");
    assert.equal(row.observed_at, "2026-06-27T23:02:51.853Z");
    assert.equal(row.source_object_uri, CORP_ACTION_SOURCE_OBJECT_URI);
    assert.equal(row.source_record_key, "6a3506303c889025f47a57e4");
  });

  it("emits dates as YYYY-MM-DD, not as timestamps", () => {
    const row = ok(mongoAction());
    assert.equal(row.ex_date, "2026-05-29");
    assert.equal(row.record_date, "2026-05-29");
  });

  it("refuses a blank half BY NAME, before the builder can throw on it", () => {
    // The real builder THROWS on a blank half. This table drains 59,000 rows
    // from four scrapers, and one bad row must be a counted refusal rather than
    // the end of the run — so the builder must never see it.
    const throws: ListingIdBuilder = () => {
      throw new Error("builder reached with a blank half");
    };
    for (const bad of [{ symbol: "" }, { symbol: "  " }, { exchange: "" }]) {
      assert.deepEqual(toCorpActionSilverRow(mongoAction(bad), throws), {
        ok: false,
        reason: "UNRESOLVABLE_LISTING",
      });
    }
  });

  it("refuses a venue no bar carries", () => {
    assert.deepEqual(
      toCorpActionSilverRow(mongoAction({ exchange: "MCX" }), ID),
      {
        ok: false,
        reason: "UNKNOWN_VENUE",
      },
    );
  });

  it("carries the OBSERVED ratio a DERIVED row measured, beside the snapped one", () => {
    // MONEY-1528 (B). `actionFactor` divides a capital adjustment by the
    // observed 9.93; silver held only the snapped 10, so gold and the chart
    // disagreed by 0.7% for ever on this real row (up to 2.97% on others).
    const row = ok(derivedAction());
    assert.equal(row.ratio, 10);
    assert.equal(row.observed_ratio, 9.93125, "rounded to NUMERIC(18, 6)");
    assert.equal(toCorpActionWireRow(row).observed_ratio, "9.931250");
  });

  it("leaves observed_ratio NULL wherever the source measured nothing", () => {
    // `details` is the PRODUCER's shape: the announcement STRING on exchange
    // rows, an object only on DERIVED ones.
    for (const details of [
      "Bonus 1:1",
      null,
      undefined,
      {},
      [],
      { method: "price-derived" },
      // NUMBERS ONLY. `actionFactor` coerces with Number(), but Number("") is 0
      // — a factor a SQL COALESCE would take and actionFactor itself skips.
      { observedRatio: "" },
      { observedRatio: "9.93" },
      { observedRatio: Number.NaN },
    ]) {
      assert.equal(
        ok(mongoAction({ details })).observed_ratio,
        null,
        JSON.stringify(details),
      );
    }
    assert.equal(toCorpActionWireRow(ok(mongoAction())).observed_ratio, null);
  });

  it("refuses an unusable required date, and only NULLs the informational one", () => {
    for (const bad of [
      { exDate: null },
      { exDate: new Date("nope") },
      { createdAt: new Date("nope") },
      { updatedAt: new Date("nope") },
    ] as Partial<MongoCorporateActionRow>[]) {
      assert.deepEqual(toCorpActionSilverRow(mongoAction(bad), ID), {
        ok: false,
        reason: "BAD_DATE",
      });
    }
    // recordDate is informational: "the source never stated one" is ordinary.
    assert.equal(ok(mongoAction({ recordDate: null })).record_date, null);
    assert.equal(
      ok(mongoAction({ recordDate: new Date("nope") })).record_date,
      null,
    );
  });

  it("renders ex_date in IST, so both of prod's two exDate conventions land on the same day", async () => {
    // MEASURED on prod across all 59,087 rows: `exDate` carries TWO
    // conventions in one column — 48,224 at 18:30 UTC (IST midnight) and
    // 10,863 at 00:00 UTC. A UTC slice is right for the second and ONE DAY
    // EARLY for the first, which is why the corpus holds 6,857 Sunday ex-dates
    // against 4,048 Friday. Nothing on the row says which producer wrote it,
    // so the fix cannot branch — it has to be right for both at once.
    assert.equal(
      ok(mongoAction({ exDate: new Date("2022-07-26T18:30:00.000Z") })).ex_date,
      "2022-07-27",
      "18:30 UTC is IST midnight of the 27th — a UTC slice reads the 26th",
    );
    assert.equal(
      ok(mongoAction({ exDate: new Date("2022-07-27T00:00:00.000Z") })).ex_date,
      "2022-07-27",
      "00:00 UTC is 05:30 IST the same day — this convention was already right",
    );

    // THE OFFSET IS PINNED TO THE MINUTE, both sides of it. Asserting only the
    // two cases above would survive a +6h or +5h mutation, which is most of
    // the ways this can be got wrong.
    assert.equal(
      ok(mongoAction({ exDate: new Date("2022-07-26T18:29:59.999Z") })).ex_date,
      "2022-07-26",
    );
    assert.equal(
      ok(mongoAction({ exDate: new Date("2022-07-26T18:30:00.000Z") })).ex_date,
      "2022-07-27",
    );

    // The Sunday census, as a property: 6,857 of these were stored as Sunday
    // and every one of them is a Monday ex-date. An Indian ex-date is never a
    // Sunday.
    const sundayIn = new Date("2023-01-01T18:30:00.000Z"); // Sunday in UTC
    assert.equal(sundayIn.getUTCDay(), 0);
    assert.equal(ok(mongoAction({ exDate: sundayIn })).ex_date, "2023-01-02");

    // record_date rides the same column family and the same producers, so it
    // gets the same calendar — a record date one day early is the same defect
    // one column over.
    assert.equal(
      ok(mongoAction({ recordDate: new Date("2022-07-26T18:30:00.000Z") }))
        .record_date,
      "2022-07-27",
    );

    // The agreement pin against core's `toIstDateKey` CANNOT live here:
    // `packages/lake`'s tsconfig sets a rootDir of this package, so a relative
    // import into `packages/core` fails type-check (TS6059) — the boundary the
    // mirror exists to respect, refusing to be routed around from this side.
    // It lives in `packages/core/__tests__/nse-holidays.test.ts` instead,
    // which sets `rootDir: "../.."` and can see both packages.
  });

  it("produces exactly the columns the INSERT names, in the DDL's spelling", () => {
    // snake_case, and no extras: an unknown struct field is rejected by
    // BigQuery, a missing one silently lands NULL.
    assert.deepEqual(Object.keys(ok(mongoAction())).sort(), [
      "action_type",
      "cash",
      "ex_date",
      "listing_id",
      "market",
      "observed_at",
      "observed_ratio",
      "published_at",
      "ratio",
      "record_date",
      "source",
      "source_object_uri",
      "source_record_key",
    ]);
    for (const col of [
      "market",
      "listing_id",
      "action_type",
      "ex_date",
      "record_date",
      "ratio",
      "observed_ratio",
      "cash",
      "source",
      "published_at",
      "source_object_uri",
      "source_record_key",
      "observed_at",
    ]) {
      // A column arrives either in the CREATE or in a later
      // `ADD COLUMN IF NOT EXISTS` — the form an existing table can receive.
      assert.ok(
        new RegExp(`(\\n  |ADD COLUMN IF NOT EXISTS )${col}\\s`).test(
          CORP_ACTION_DDL,
        ),
        `the DDL has no column ${col}`,
      );
    }
  });

  it("declares observed_ratio NUMERIC(18, 6), where an EXISTING table gets it", () => {
    // `CREATE TABLE IF NOT EXISTS` never adds a column to prod's table, so a
    // column only in the CREATE would reach a fresh dataset and nowhere else —
    // and the sink's INSERT, which names it, would fail on prod.
    assert.ok(
      CORP_ACTION_DDL.includes(
        "ADD COLUMN IF NOT EXISTS observed_ratio NUMERIC(18, 6)",
      ),
      "observed_ratio is not added to an existing corporate_action",
    );
  });

  it("passes an action_type the DDL's vocabulary does not enumerate", () => {
    // Prod holds 14 distinct types (INTEREST_PAYMENT, OTHER, RIGHTS,
    // REDEMPTION, CAPITAL_ADJUSTMENT, AGM, SUSPENSION …) against the DDL's
    // "SPLIT | DIVIDEND | BONUS | RIGHTS | …". The list is open; closing it
    // here would drop real actions.
    assert.equal(
      ok(mongoAction({ type: "CAPITAL_ADJUSTMENT" })).action_type,
      "CAPITAL_ADJUSTMENT",
    );
  });
});

describe("numWire / numKey", () => {
  it("keeps NULL as NULL on the wire — CAST('' AS NUMERIC) errors", () => {
    assert.equal(numWire(null), null);
    assert.equal(numWire(undefined), null);
    assert.equal(numWire(Number.NaN), null);
    assert.equal(numKey(null), "");
  });

  it("spells one value one way from either side of the wire", () => {
    // BigQuery hands a NUMERIC back as "5" where we wrote "5.000000".
    assert.equal(numKey(5), numKey(Number("5")));
    assert.equal(numKey(5), "5.000000");
    assert.equal(numKey(1.333333333333333), numKey(Number("1.333333")));
  });
});

describe("corpActionSilverKey", () => {
  it("accepts the mapper's own output unchanged", () => {
    // The JOIN. The sink compares a key built from a Mongo row against one
    // built from a BigQuery row, and the two only agree if this reads the
    // mapper's shape.
    const row = ok(derivedAction());
    assert.equal(
      corpActionSilverKey(row),
      corpActionSilverKey({
        listing_id: row.listing_id,
        action_type: row.action_type,
        ex_date: row.ex_date,
        record_date: row.record_date,
        ratio: row.ratio,
        observed_ratio: row.observed_ratio,
        cash: row.cash,
        source: row.source,
      }),
    );
  });

  it("changes when a CORRECTION changes a value on the same Mongo row", () => {
    // Mongo's own key is (symbol, exchange, type, exDate), so a revised ratio
    // arrives on the SAME row. A key made of those four alone would skip the
    // append and the correction would never reach the lake.
    const before = ok(mongoAction({ ratio: 5 }));
    for (const after of [
      ok(mongoAction({ ratio: 2 })),
      ok(mongoAction({ ratio: 5, dividendPerShare: 1 })),
      ok(
        mongoAction({ ratio: 5, recordDate: new Date("2026-05-30T00:00:00Z") }),
      ),
      ok(mongoAction({ ratio: 5, source: "SCREENER" })),
    ]) {
      assert.notEqual(corpActionSilverKey(before), corpActionSilverKey(after));
    }
  });

  it("changes when the detector re-measures the OBSERVED ratio", () => {
    // A re-run of the price-derived detector rewrites `details.observedRatio`
    // on the SAME Mongo row and leaves the snapped `ratio` alone. For a capital
    // adjustment that value is the factor the chart divides by, so a key blind
    // to it would keep the stale factor in the lake for ever.
    assert.notEqual(
      corpActionSilverKey(ok(derivedAction())),
      corpActionSilverKey(
        ok(
          derivedAction({
            details: { method: "price-derived", observedRatio: 9.87 },
          }),
        ),
      ),
    );
  });

  it("does NOT change when only observed_at moved", () => {
    // `updatedAt` is touched by re-asserts that changed nothing. In the key it
    // would append a duplicate row on every nightly re-scrape.
    assert.equal(
      corpActionSilverKey(ok(mongoAction())),
      corpActionSilverKey(
        ok(mongoAction({ updatedAt: new Date("2026-09-21T23:08:14.253Z") })),
      ),
    );
  });

  it("uses a separator no part can contain", () => {
    // NUL. `listing_id` carries a ":" by construction and a scraped symbol or
    // source can carry anything printable, so a printable separator lets two
    // distinct actions collide onto one key — and in an APPEND-ONLY table a
    // collision is a correction that never arrives.
    const base = {
      ex_date: null,
      record_date: null,
      ratio: null,
      observed_ratio: null,
      cash: null,
      source: "S",
    };
    // The content SHIFTS ACROSS ONE BOUNDARY and the part COUNT is unchanged —
    // the only construction that actually collides. Moving a whole part instead
    // changes the number of separators, so the two strings differ whatever the
    // separator is and the test proves nothing.
    for (const sep of [":", "|", "-", "/", ",", " ", "_", "."]) {
      assert.notEqual(
        corpActionSilverKey({
          ...base,
          listing_id: "TCS:NSE",
          action_type: `SPLIT${sep}X`,
        }),
        corpActionSilverKey({
          ...base,
          listing_id: `TCS:NSE${sep}SPLIT`,
          action_type: "X",
        }),
        `a "${sep}" separator would collide these two`,
      );
    }
  });
});

describe("joinCoverage", () => {
  const rows = [
    { listing_id: "TCS:NSE:unknown" },
    { listing_id: "INFY:NSE:unknown" },
    { listing_id: "815GS2026:NSE:unknown" },
  ];

  it("reports a rate when both sides are non-empty", () => {
    const c = joinCoverage(
      rows,
      new Set(["TCS:NSE:unknown", "INFY:NSE:unknown"]),
    );
    assert.equal(c.state, "MEASURED");
    assert.ok(c.state === "MEASURED");
    assert.equal(c.matched, 2);
    assert.equal(c.total, 3);
    assert.deepEqual(c.sample, ["815GS2026:NSE:unknown"]);
  });

  it("says NONE — never 0% — when nothing matches a non-empty bar set", () => {
    // A spelling mismatch, and it is the state prod is IN until the India bars
    // are replayed under `in-bhavcopy-v2`: three-part rows here, two-part ids
    // in price_bar_d1 (MONEY-1522). The caller throws on it; a rate of 0.00%
    // would read as a coverage figure.
    const c = joinCoverage(rows, new Set(["TCS:NSE", "INFY:NSE"]));
    assert.equal(c.state, "NONE");
  });

  it("says NOT_MEASURED rather than NONE when there is nothing to compare", () => {
    // Not-measured is not not-passed. An empty bar set (a fresh dataset) and an
    // empty candidate set (a quiet incremental night) are both health, and a
    // `matched === 0` test alone cannot tell either from the defect above.
    assert.equal(joinCoverage(rows, new Set()).state, "NOT_MEASURED");
    assert.equal(
      joinCoverage([], new Set(["TCS:NSE:unknown"])).state,
      "NOT_MEASURED",
    );
  });

  it("caps the sample without capping the count", () => {
    // The MATCH sits AFTER the cap is reached. `siftRows` states the rule this
    // is protecting — an under-reported coverage figure is the number an
    // operator would act on — and a run that stopped counting at the sample cap
    // would still satisfy a fixture whose match came first.
    const many = Array.from({ length: 50 }, (_, i) => ({
      listing_id: `X${i}:NSE`,
    }));
    const c = joinCoverage(
      [...many, { listing_id: "TCS:NSE" }],
      new Set(["TCS:NSE"]),
      3,
    );
    assert.ok(c.state === "MEASURED", `expected MEASURED, got ${c.state}`);
    assert.equal(c.total, 51);
    assert.equal(c.matched, 1);
    assert.equal(c.sample.length, 3);
  });
});

describe("--reload: what is appended, and in which order (MONEY-1522 review)", () => {
  const OLDER = "corp-action-lake-sink-v2";
  const row = ok(mongoAction());
  const key = corpActionSilverKey(row);
  const sourceRecordKey = row.source_record_key;

  it("RE-APPENDS a row whose values the new version left unchanged", () => {
    // The loss this closes. The read used to be version-blind, so the older
    // row's identical key made the candidate look already written; the prune
    // then deleted that older row, and the action was gone from silver.
    assert.deepEqual(
      planCorpActionAppend(
        [row],
        [{ key, parserVersion: OLDER, sourceRecordKey }],
        true,
      ),
      [row],
    );
  });

  it("still skips what the CURRENT version already wrote — a reload is re-runnable", () => {
    assert.deepEqual(
      planCorpActionAppend(
        [row],
        [{ key, parserVersion: CORP_ACTION_PARSER_VERSION, sourceRecordKey }],
        true,
      ),
      [],
    );
  });

  it("counts EVERY version as present on a plain run, which prunes nothing", () => {
    // Without --reload the older row stays, so appending beside it would put
    // the same action in the lake twice.
    assert.deepEqual(
      planCorpActionAppend(
        [row],
        [{ key, parserVersion: OLDER, sourceRecordKey }],
        false,
      ),
      [],
    );
  });

  it("appends each Mongo row as ITS OWN row — twins no longer collapse (MONEY-1607 review)", () => {
    // Gold keeps one observation per event, so identical twins never apply
    // twice; silver keeping one per `_id` is what lets the prune arms judge
    // each row by its own. 0 twin groups on prod (2026-09-23).
    const twin = { ...row, source_record_key: "twin" };
    const out = planCorpActionAppend([row, twin], [], true);
    assert.deepEqual(
      out.map((r) => r.source_record_key),
      [row.source_record_key, "twin"],
    );
  });

  it("a twin's row is NOT this row's presence — the gone _id's row is about to be pruned", () => {
    // Silver holds the row of an `_id` Mongo has since deleted; its twin
    // carries identical values. Judged by values alone the twin was skipped,
    // the third arm then deleted the row it matched, and the event left silver.
    const twin = { ...row, source_record_key: "twin" };
    for (const reload of [false, true]) {
      assert.deepEqual(
        planCorpActionAppend(
          [twin],
          [{ key, parserVersion: CORP_ACTION_PARSER_VERSION, sourceRecordKey }],
          reload,
        ),
        [twin],
      );
    }
  });

  it("an UNCHANGED row read back from silver is still present — a re-run appends nothing", () => {
    // The round trip a normal night makes: the keys read back from BigQuery,
    // `_id` included, must name every row this run would write.
    const rows = [row, { ...row, source_record_key: "twin" }];
    const readBack = rows.map((r) => ({
      key: corpActionSilverKey(r),
      parserVersion: CORP_ACTION_PARSER_VERSION,
      sourceRecordKey: r.source_record_key,
    }));
    assert.deepEqual(planCorpActionAppend(rows, readBack, false), []);
    assert.deepEqual(planCorpActionAppend(rows, readBack, true), []);
  });

  async function trace(
    pending: (typeof row)[],
    reload: boolean,
    failAppend = false,
    orphans: string[] = [],
  ) {
    const calls: string[] = [];
    const result = appendThenPrune(pending, reload, orphans, {
      append: async () => {
        calls.push("append");
        if (failAppend) throw new Error("INSERT failed mid-batch");
      },
      pruneSuperseded: async () => {
        calls.push("prune");
        return 7;
      },
      pruneOrphans: async (keys) => {
        calls.push(`orphans:${keys.join(",")}`);
        return keys.length;
      },
    });
    return { calls, result };
  }

  it("APPENDS BEFORE IT PRUNES, so a crash leaves duplicates rather than a gap", async () => {
    const t = await trace([row], true);
    assert.deepEqual(await t.result, {
      appended: 1,
      superseded: 7,
      orphaned: 0,
    });
    assert.deepEqual(t.calls, ["append", "prune"]);

    // The crash itself: an append that dies must leave the older version in
    // place, because it is the only copy until the new one has landed.
    const crashed = await trace([row], true, true);
    await assert.rejects(crashed.result, /INSERT failed/);
    assert.deepEqual(crashed.calls, ["append"]);
  });

  it("prunes on a reload with NOTHING to append — the re-run after that crash", async () => {
    // Everything was appended, then the process died before the prune. The
    // re-run finds every key current, has nothing to append, and must still
    // delete the older rows, or both versions stay live for ever.
    const t = await trace([], true);
    assert.deepEqual(await t.result, {
      appended: 0,
      superseded: 7,
      orphaned: 0,
    });
    assert.deepEqual(t.calls, ["prune"]);
  });

  it("never prunes a plain run — not even orphans it was handed", async () => {
    const t = await trace([row], false, false, ["gone"]);
    assert.deepEqual(await t.result, {
      appended: 1,
      superseded: 0,
      orphaned: 0,
    });
    assert.deepEqual(t.calls, ["append"]);
  });

  it("prunes the orphans LAST, after the append, and counts the two arms apart", async () => {
    const t = await trace([row], true, false, ["loser1", "loser2"]);
    assert.deepEqual(await t.result, {
      appended: 1,
      superseded: 7,
      orphaned: 2,
    });
    assert.deepEqual(t.calls, ["append", "prune", "orphans:loser1,loser2"]);

    // An append that dies must not reach either DELETE.
    const crashed = await trace([row], true, true, ["loser1"]);
    await assert.rejects(crashed.result, /INSERT failed/);
    assert.deepEqual(crashed.calls, ["append"]);
  });
});

describe("planOrphanPrune — older rows whose Mongo row is GONE (MONEY-1522 review)", () => {
  // MONEY-1530's re-anchor DELETES 1,772 loser _ids. Their older-version silver
  // rows carry the retired two-part listing_id, and the scoped arm can never
  // reach them: no current row will ever exist for a key Mongo no longer has.
  const live = Array.from({ length: 30 }, (_, i) => `live${i}`);
  const older = [...live, "loser1", "loser2"];
  const fullRead = { ids: new Set(live), counted: live.length };

  it("names exactly the older keys Mongo no longer holds", () => {
    assert.deepEqual(planOrphanPrune(fullRead, older), {
      orphans: ["loser1", "loser2"],
      refused: null,
    });
  });

  it("de-duplicates the older side", () => {
    const plan = planOrphanPrune(fullRead, [...older, "loser1", "live0"]);
    assert.deepEqual(plan.orphans, ["loser1", "loser2"]);
  });

  it("allows rows inserted DURING the read — they raise the read, never an orphan", () => {
    const grown = { ids: new Set([...live, "new1"]), counted: live.length };
    assert.deepEqual(planOrphanPrune(grown, older).orphans, [
      "loser1",
      "loser2",
    ]);
  });

  it("an EMPTY read prunes nothing — it would make every key look gone", () => {
    const plan = planOrphanPrune({ ids: new Set(), counted: 0 }, older);
    assert.deepEqual(plan.orphans, []);
    assert.match(plan.refused ?? "", /EMPTY/);
  });

  it("a read SHORT of the count taken before it prunes nothing", () => {
    // One row missing from the read would be one live action deleted from
    // silver with nothing to replace it. Short by ONE, so a `<=`/slack
    // mutation of the check has nowhere to hide.
    const plan = planOrphanPrune(
      { ids: new Set(live.slice(1)), counted: live.length },
      older,
    );
    assert.deepEqual(plan.orphans, []);
    assert.match(plan.refused ?? "", /not the full table/);
  });

  it("a read under the ratio floor prunes nothing, even when it matches its own count", () => {
    // The count cannot see a read that is short for a reason the count shares
    // — a `where` added to both, or the wrong database. The older version was
    // written from this same table, so an honest read is about as large.
    assert.equal(ORPHAN_PRUNE_MIN_READ_RATIO, 0.9);
    // 20 older keys: the floor is exactly 18 ids.
    const olderTwenty = [...live.slice(0, 18), "loser1", "loser2"];
    const atFloor = new Set(live.slice(0, 18));
    assert.deepEqual(
      planOrphanPrune({ ids: atFloor, counted: 18 }, olderTwenty),
      { orphans: ["loser1", "loser2"], refused: null },
      "ON the floor is allowed",
    );
    const underFloor = new Set(live.slice(0, 17));
    const plan = planOrphanPrune({ ids: underFloor, counted: 17 }, olderTwenty);
    assert.deepEqual(plan.orphans, [], "one id under the floor prunes nothing");
    assert.match(plan.refused ?? "", /under the 0\.9 floor/);
  });
});

describe("[wiring] the sink's orphan DELETE names its keys (MONEY-1522 review)", () => {
  // Comment lines dropped: the header DESCRIBES the negation it forbids.
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts/jobs/corp-action-lake-sink.ts",
    ),
    "utf8",
  )
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");
  const fn = src.slice(
    src.indexOf("async function deleteOrphanedOlderVersions("),
  );

  it("deletes by EXPLICIT key and can never name a current-version row", () => {
    assert.ok(fn.length > 200, "deleteOrphanedOlderVersions is gone");
    const sql = fn.slice(0, fn.indexOf("});"));
    assert.match(sql, /source_record_key IN UNNEST\(@keys\)/);
    assert.match(sql, /parser_version != @current/);
    assert.doesNotMatch(sql, /NOT IN/, "a DELETE by negation is the defect");
  });

  it("hands the prune only the planner's keys, which are EMPTY when refused", () => {
    assert.match(
      src,
      /appendThenPrune\(pending, reload, orphanPlan\.orphans, \{/,
    );
    assert.match(src, /planOrphanPrune\(\s*\{ ids: mongoIds, counted \}/);
    // The count is taken BEFORE the read, or a row deleted mid-read is missed.
    const count = src.indexOf("prisma.corporateAction.count()");
    assert.ok(count > 0, "the read is no longer counted");
    assert.ok(count < src.indexOf("prisma.corporateAction.findMany("));
  });
});

describe("the CURRENT-version orphan arm (MONEY-1607)", () => {
  // A current-version row whose Mongo row is deleted later is reached by
  // neither reload arm. SAYAJIHOTL:NSE's DERIVED 0.5 (MONEY-1600) is the case:
  // retired in Mongo after the v3 reload, it would adjust gold for ever.
  const live = Array.from({ length: 30 }, (_, i) => `live${i}`);
  const retired = "6a7c4bb5c76486c7e9feadaf";
  const current = [...live, retired];
  const fullRead = { ids: new Set(live), counted: live.length };

  it("names exactly the current keys Mongo no longer holds", () => {
    assert.deepEqual(planOrphanPrune(fullRead, current, "current-version"), {
      orphans: [retired],
      refused: null,
    });
  });

  it("a TRUNCATED read deletes nothing — one row short of its own count", () => {
    const plan = planOrphanPrune(
      { ids: new Set(live.slice(1)), counted: live.length },
      current,
      "current-version",
    );
    assert.deepEqual(plan.orphans, []);
    assert.match(plan.refused ?? "", /not the full table/);
  });

  it("an EMPTY read deletes nothing", () => {
    const plan = planOrphanPrune(
      { ids: new Set(), counted: 0 },
      current,
      "current-version",
    );
    assert.deepEqual(plan.orphans, []);
    assert.match(plan.refused ?? "", /EMPTY/);
  });

  it("a read under the floor deletes nothing, and says WHICH version it judged", () => {
    const plan = planOrphanPrune(
      { ids: new Set(live.slice(0, 20)), counted: 20 },
      current,
      "current-version",
    );
    assert.deepEqual(plan.orphans, []);
    assert.match(
      plan.refused ?? "",
      /31 current-version keys, under the 0\.9 floor/,
    );
  });

  it("the older arm's refusal reads exactly as it did", () => {
    const plan = planOrphanPrune(
      { ids: new Set(live.slice(0, 20)), counted: 20 },
      current,
    );
    assert.equal(
      plan.refused,
      "the Mongo read holds 20 ids against 31 older-version keys, under the " +
        "0.9 floor — a short read, not a smaller table",
    );
  });

  it("today: silver holds no current-version row, so there is nothing to judge", () => {
    // Measured 2026-09-23: 57,316 rows, every one v2.
    assert.deepEqual(planOrphanPrune(fullRead, [], "current-version"), {
      orphans: [],
      refused: null,
    });
  });
});

describe("[wiring] the current-version orphan arm (MONEY-1607)", () => {
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts/jobs/corp-action-lake-sink.ts",
    ),
    "utf8",
  )
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");
  const main = src.slice(src.indexOf("async function main("));

  it("deletes by EXPLICIT key and only ever a CURRENT-version row", () => {
    const fn = src.slice(
      src.indexOf("async function deleteOrphanedCurrentVersion("),
    );
    assert.ok(fn.length > 200, "deleteOrphanedCurrentVersion is gone");
    const sql = fn.slice(0, fn.indexOf("});"));
    assert.match(sql, /source_record_key IN UNNEST\(@keys\)/);
    assert.match(sql, /parser_version = @current/);
    assert.doesNotMatch(sql, /NOT IN|!=/, "a DELETE by negation is the defect");
  });

  it("reads the current keys BEFORE Mongo is counted", () => {
    const keys = main.indexOf("await readCurrentVersionRows(bq, env)");
    assert.ok(keys > 0, "the current keys are no longer read");
    assert.ok(keys < main.indexOf("prisma.corporateAction.count()"));
  });

  it("judges them with the SAME whole-read proof, and deletes only the plan's keys", () => {
    assert.match(
      main,
      /planOrphanPrune\(\s*\{ ids: mongoIds, counted \},\s*currentKeys,\s*"current-version",?\s*\)/,
    );
    assert.match(
      main,
      /deleteOrphanedCurrentVersion\(\s*bq,\s*env,\s*currentOrphanPlan\.orphans,?\s*\)/,
    );
  });

  it("runs LAST, after the append and both reload arms, on every --apply", () => {
    const append = main.indexOf("appendThenPrune(pending, reload,");
    const current = main.indexOf("deleteOrphanedCurrentVersion(");
    assert.ok(append > 0 && current > append);
    // Not gated on --reload, and a plain run with nothing to append still
    // reaches it rather than returning "nothing to append".
    const guard = main.slice(main.lastIndexOf("if (", current), current);
    assert.match(
      guard,
      /^if \(currentOrphanPlan\.orphans\.length > 0\) \{\s*currentOrphaned = await $/,
    );
    assert.match(
      main,
      /pending\.length === 0 &&\s*!reload &&\s*currentOrphanPlan\.orphans\.length === 0/,
    );
  });
});

describe("the RESTATED arm — a Mongo correction that MOVES a row (MONEY-1607 review)", () => {
  // ZEEL's 2024 bonus as the subjects repair would retype it. Its `_id` stays,
  // so the orphan arm never sees it; the OTHER row lands in a new gold
  // partition and the BONUS row, left beside it, keeps dividing ZEEL.
  const zeel = {
    source_record_key: "zeelbonus",
    market: "IN",
    listing_id: "ZEEL:NSE:unknown",
    action_type: "BONUS",
    ex_date: "2024-01-23",
  };
  const live = Array.from({ length: 30 }, (_, i) => ({
    ...zeel,
    source_record_key: `live${i}`,
    ex_date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  const current = [...live, zeel];
  const ids = new Set(current.map((r) => r.source_record_key));
  const read = { ids, counted: ids.size };
  const same = new Map(
    current.map((r) => [r.source_record_key, restatedKey(r)]),
  );

  it("names the row whose Mongo row now maps to another partition — by its OLD key", () => {
    const now = new Map(same).set(
      "zeelbonus",
      restatedKey({ ...zeel, action_type: "OTHER" }),
    );
    assert.deepEqual(planRestatedPrune(read, current, now), {
      stale: ["zeelbonus|IN|ZEEL:NSE:unknown|BONUS|2024-01-23"],
      refused: null,
      unmapped: 0,
    });
  });

  it("an ex-date move is a restatement too", () => {
    const now = new Map(same).set(
      "zeelbonus",
      restatedKey({ ...zeel, ex_date: "2024-01-24" }),
    );
    assert.equal(planRestatedPrune(read, current, now).stale.length, 1);
  });

  it("nothing moved, nothing named — today's state after a reload", () => {
    assert.deepEqual(planRestatedPrune(read, current, same).stale, []);
  });

  it("a TRUNCATED read deletes nothing, even with a real restatement in it", () => {
    const now = new Map(same).set(
      "zeelbonus",
      restatedKey({ ...zeel, action_type: "OTHER" }),
    );
    const plan = planRestatedPrune(
      { ids, counted: ids.size + 1 },
      current,
      now,
    );
    assert.deepEqual(plan.stale, []);
    assert.match(plan.refused ?? "", /not the full table/);
  });

  it("a row whose Mongo row is GONE is left to the orphan arm", () => {
    const gone = new Set([...ids].filter((k) => k !== "zeelbonus"));
    const retyped = new Map(same).set(
      "zeelbonus",
      restatedKey({ ...zeel, action_type: "OTHER" }),
    );
    const plan = planRestatedPrune(
      { ids: gone, counted: gone.size },
      current,
      retyped,
    );
    assert.deepEqual(plan.stale, []);
  });

  it("a row whose Mongo row no longer MAPS is kept and counted — cannot say is not moved", () => {
    const now = new Map(same);
    now.delete("zeelbonus");
    assert.deepEqual(planRestatedPrune(read, current, now), {
      stale: [],
      refused: null,
      unmapped: 1,
    });
  });

  it("the JS key and the SQL key are one spelling, column for column", () => {
    assert.equal(
      restatedKey(zeel),
      "zeelbonus|IN|ZEEL:NSE:unknown|BONUS|2024-01-23",
    );
    assert.equal(
      RESTATED_KEY_SQL,
      "CONCAT(source_record_key, '|', market, '|', listing_id, '|', " +
        "action_type, '|', IFNULL(CAST(ex_date AS STRING), ''))",
    );
  });
});

describe("[wiring] the restated arm (MONEY-1607 review)", () => {
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts/jobs/corp-action-lake-sink.ts",
    ),
    "utf8",
  )
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");
  const main = src.slice(src.indexOf("async function main("));

  it("deletes by EXPLICIT restatedKey, current version only", () => {
    const fn = src.slice(
      src.indexOf("async function deleteRestatedCurrentVersion("),
    );
    assert.ok(fn.length > 200, "deleteRestatedCurrentVersion is gone");
    const sql = fn.slice(0, fn.indexOf("});"));
    assert.match(sql, /\$\{RESTATED_KEY_SQL\} IN UNNEST\(@keys\)/);
    assert.match(sql, /parser_version = @current/);
    assert.doesNotMatch(sql, /NOT IN|!=|source_record_key IN/);
  });

  it("maps every Mongo row's key NOW and judges with the whole-read proof", () => {
    assert.match(main, /mappedNow\.set\(row\.id, restatedKey\(mapped\.row\)\)/);
    assert.match(
      main,
      /planRestatedPrune\(\s*\{ ids: mongoIds, counted \},\s*currentRows,\s*mappedNow,?\s*\)/,
    );
    assert.match(
      main,
      /deleteRestatedCurrentVersion\(\s*bq,\s*env,\s*restatedPlan\.stale,?\s*\)/,
    );
  });

  it("runs LAST, on every --apply, and a plain run with only this to do reaches it", () => {
    const orphans = main.indexOf("deleteOrphanedCurrentVersion(");
    const restated = main.indexOf("deleteRestatedCurrentVersion(");
    assert.ok(orphans > 0 && restated > orphans);
    const guard = main.slice(main.lastIndexOf("if (", restated), restated);
    assert.match(
      guard,
      /^if \(restatedPlan\.stale\.length > 0\) \{\s*currentRestated = await $/,
    );
    assert.match(main, /restatedPlan\.stale\.length === 0\s*\) \{/);
  });
});

describe("[wiring] silver's keys carry the Mongo row that wrote them (MONEY-1607 review)", () => {
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts/jobs/corp-action-lake-sink.ts",
    ),
    "utf8",
  );
  const fn = src.slice(src.indexOf("async function readExisting("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  it("readExisting selects source_record_key and hands it to the planner", () => {
    assert.match(body, /SELECT parser_version,\s*source_record_key,/);
    assert.match(body, /sourceRecordKey: r\.source_record_key,/);
  });
});

describe("the parser version", () => {
  it("is stamped, so a mapping fix can be told apart from the rows it replaced", () => {
    assert.match(CORP_ACTION_PARSER_VERSION, /^corp-action-lake-sink-v\d+$/);
    assert.ok(CORP_ACTION_DDL.includes("parser_version    STRING    NOT NULL"));
  });

  it("moved past v2, the version whose rows carry the two-part id", () => {
    // `--reload` deletes `parser_version != current`. Prod's 57,316 rows are
    // v2 and spell the RETIRED `{symbol}:{exchange}`; left at v2, the reload
    // would delete none of them and the three-part rows would land beside
    // them (MONEY-1522 / MONEY-1528 B).
    assert.notEqual(CORP_ACTION_PARSER_VERSION, "corp-action-lake-sink-v2");
  });
});
