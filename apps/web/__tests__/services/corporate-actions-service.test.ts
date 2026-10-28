/**
 * Corporate-actions service — pure persist-logic (MONEY-840/844).
 *
 * Tests the exported pure helpers that drive `upsertCorporateActions`
 * (dedupe/merge keyed on the model's `@@unique([symbol,exchange,type,exDate])`,
 * NSE↔Screener field merge, finite-guarding, and the source-mapping converters)
 * WITHOUT a live DB. The DB write itself is a thin Prisma upsert loop over the
 * already-deduped rows; the correctness that matters — history is kept, sources
 * merge without clobbering good values, non-finite values become null — all
 * lives in these pure functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  corporateActionKey,
  mergeCorporateActions,
  dedupeCorporateActions,
  nseActionToInput,
  screenerActionToInput,
  corporateActionRowKey,
  partitionCorporateActionWrites,
  corporateActionNeedsMerge,
  type CorporateActionInput,
} from "@usemoney/services";
import type { NSECorporateAction } from "@usemoney/research/data-sources/nse-filings-types";
import type { ScreenerCorpAction } from "@usemoney/research/data-sources/screener-full-scraper";

// ── helpers ─────────────────────────────────────────────────────────────────

function input(over: Partial<CorporateActionInput>): CorporateActionInput {
  return {
    symbol: "RELIANCE",
    exchange: "NSE",
    type: "SPLIT",
    exDate: new Date("2024-03-15"),
    ...over,
  };
}

// ── corporateActionKey ──────────────────────────────────────────────────────

describe("corporateActionKey", () => {
  it("matches the @@unique([symbol,exchange,type,exDate]) shape", () => {
    const k = corporateActionKey({
      symbol: "reliance",
      exchange: "NSE",
      type: "SPLIT",
      exDate: new Date("2024-03-15T00:00:00Z"),
    });
    assert.strictEqual(k, "RELIANCE|NSE|SPLIT|2024-03-15T00:00:00.000Z");
  });

  it("differs by type and by exDate (so two distinct actions don't collide)", () => {
    const base = {
      symbol: "TCS",
      exchange: "NSE",
      type: "BONUS" as const,
      exDate: new Date("2023-06-01"),
    };
    assert.notStrictEqual(
      corporateActionKey(base),
      corporateActionKey({ ...base, type: "DIVIDEND" })
    );
    assert.notStrictEqual(
      corporateActionKey(base),
      corporateActionKey({ ...base, exDate: new Date("2023-06-02") })
    );
  });
});

// ── mergeCorporateActions (fill-nulls, never clobber, union sources) ─────────

describe("mergeCorporateActions", () => {
  it("fills a null ratio/recordDate on the base from the incoming row", () => {
    const base = input({ ratio: null, recordDate: null, source: "SCREENER" });
    const next = input({
      ratio: 5,
      recordDate: new Date("2024-03-16"),
      source: "NSE",
    });
    const m = mergeCorporateActions(base, next);
    assert.strictEqual(m.ratio, 5);
    assert.deepStrictEqual(m.recordDate, new Date("2024-03-16"));
  });

  it("does NOT clobber a good base value with an incoming null", () => {
    const base = input({ ratio: 5, dividendPerShare: null, source: "NSE" });
    const next = input({ ratio: null, source: "SCREENER" });
    const m = mergeCorporateActions(base, next);
    assert.strictEqual(m.ratio, 5, "base ratio survives an incoming null");
  });

  it("unions the source tags (NSE + SCREENER) and de-dupes them", () => {
    const m = mergeCorporateActions(
      input({ source: "NSE" }),
      input({ source: "SCREENER" })
    );
    assert.strictEqual(m.source, "NSE+SCREENER");

    const m2 = mergeCorporateActions(
      input({ source: "NSE+SCREENER" }),
      input({ source: "NSE" })
    );
    assert.strictEqual(m2.source, "NSE+SCREENER");
  });

  it("keeps the richer (longer) details string", () => {
    const m = mergeCorporateActions(
      input({ details: "Split" }),
      input({ details: "Face Value Split From Rs 10 To Rs 1" })
    );
    assert.strictEqual(m.details, "Face Value Split From Rs 10 To Rs 1");
  });
});

// ── dedupeCorporateActions (collapse a mixed NSE+Screener batch) ─────────────

describe("dedupeCorporateActions", () => {
  it("collapses the same action from NSE + Screener into one merged row", () => {
    const rows = [
      input({ source: "NSE", ratio: 5, recordDate: new Date("2024-03-16") }),
      input({ source: "SCREENER", ratio: null, dividendPerShare: null }),
    ];
    const out = dedupeCorporateActions(rows);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.ratio, 5);
    assert.strictEqual(out[0]!.source, "NSE+SCREENER");
    assert.deepStrictEqual(out[0]!.recordDate, new Date("2024-03-16"));
  });

  it("KEEPS distinct historical actions — past ex-dates are not dropped", () => {
    const rows = [
      input({ type: "SPLIT", exDate: new Date("2019-08-01"), ratio: 2 }),
      input({ type: "BONUS", exDate: new Date("2021-06-15"), ratio: 2 }),
      input({
        type: "DIVIDEND",
        exDate: new Date("2024-05-30"),
        dividendPerShare: 9,
      }),
    ];
    const out = dedupeCorporateActions(rows);
    assert.strictEqual(
      out.length,
      3,
      "history is preserved, nothing collapsed"
    );
    const years = out.map((r) => r.exDate.getUTCFullYear()).sort();
    assert.deepStrictEqual(years, [2019, 2021, 2024]);
  });

  it("drops rows with a missing / invalid ex-date (can't satisfy the key)", () => {
    const rows = [
      input({ exDate: new Date("invalid") }),
      input({ type: "BONUS", exDate: new Date("2023-06-01") }),
    ];
    const out = dedupeCorporateActions(rows);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.type, "BONUS");
  });
});

// ── nseActionToInput / screenerActionToInput (converters + finite-guard) ─────

describe("nseActionToInput", () => {
  const baseNse = (over: Partial<NSECorporateAction>): NSECorporateAction => ({
    symbol: "RELIANCE",
    actionType: "FACE VALUE SPLIT",
    type: "SPLIT",
    exDate: new Date("2024-03-15"),
    recordDate: new Date("2024-03-16"),
    ratio: 10,
    oldFaceValue: 10,
    newFaceValue: 1,
    dividendPerShare: null,
    details: "Face Value Split From Rs 10 To Rs 1",
    rawData: {},
    ...over,
  });

  it("maps a full NSE action and tags source=NSE", () => {
    const r = nseActionToInput(baseNse({}), "NSE", "INE002A01018");
    assert.ok(r);
    assert.strictEqual(r!.symbol, "RELIANCE");
    assert.strictEqual(r!.type, "SPLIT");
    assert.strictEqual(r!.ratio, 10);
    assert.strictEqual(r!.isin, "INE002A01018");
    assert.strictEqual(r!.source, "NSE");
  });

  it("returns null when the NSE action has no ex-date", () => {
    assert.strictEqual(nseActionToInput(baseNse({ exDate: null })), null);
  });

  it("coerces a non-finite ratio to null (MONEY-620 poison guard)", () => {
    const r = nseActionToInput(baseNse({ ratio: Infinity }));
    assert.strictEqual(r!.ratio, null);
    const r2 = nseActionToInput(baseNse({ ratio: NaN }));
    assert.strictEqual(r2!.ratio, null);
  });

  it("drops an invalid record date but keeps the row", () => {
    const r = nseActionToInput(baseNse({ recordDate: new Date("garbage") }));
    assert.ok(r);
    assert.strictEqual(r!.recordDate, null);
  });
});

describe("screenerActionToInput", () => {
  const baseScr = (over: Partial<ScreenerCorpAction>): ScreenerCorpAction => ({
    symbol: "TCS",
    type: "DIVIDEND",
    exDate: new Date("2024-05-30"),
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: 18,
    details: "Dividend - Rs 18 Per Share",
    ...over,
  });

  it("maps a Screener dividend and tags source=SCREENER", () => {
    const r = screenerActionToInput(baseScr({}));
    assert.ok(r);
    assert.strictEqual(r!.type, "DIVIDEND");
    assert.strictEqual(r!.dividendPerShare, 18);
    assert.strictEqual(r!.source, "SCREENER");
  });

  it("returns null when the Screener action has no parseable ex-date", () => {
    assert.strictEqual(screenerActionToInput(baseScr({ exDate: null })), null);
  });

  it("uppercases the symbol", () => {
    const r = screenerActionToInput(baseScr({ symbol: "tcs" }));
    assert.strictEqual(r!.symbol, "TCS");
  });
});

// ── end-to-end merge through converters (the real worker path) ───────────────

describe("converter → dedupe pipeline (worker path)", () => {
  it("NSE split (ratio) + Screener split (date only) merge into one row", () => {
    const nse: NSECorporateAction = {
      symbol: "RELIANCE",
      actionType: "FACE VALUE SPLIT FROM RS 10 TO RS 1",
      type: "SPLIT",
      exDate: new Date("2024-03-15"),
      recordDate: new Date("2024-03-16"),
      ratio: 10,
      oldFaceValue: 10,
      newFaceValue: 1,
      dividendPerShare: null,
      details: "Face Value Split From Rs 10 To Rs 1",
      rawData: {},
    };
    const scr: ScreenerCorpAction = {
      symbol: "RELIANCE",
      type: "SPLIT",
      exDate: new Date("2024-03-15"),
      ratio: null,
      oldFaceValue: null,
      newFaceValue: null,
      dividendPerShare: null,
      details: "Stock Split 15 Mar 2024",
    };
    const rows = [nseActionToInput(nse)!, screenerActionToInput(scr)!];
    const out = dedupeCorporateActions(rows);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.ratio, 10, "NSE ratio survives the merge");
    assert.strictEqual(out[0]!.source, "NSE+SCREENER");
  });
});

// ── bulk backfill partition (MONEY-1189) ────────────────────────────────────

describe("corporateActionRowKey / partitionCorporateActionWrites", () => {
  const row = (over: Partial<CorporateActionInput>): CorporateActionInput =>
    input(over);

  it("matches DB rows whose symbol case differs from the input's", () => {
    // The bug this exists to prevent: the first bulk writer built the
    // already-present set from raw DB values but looked rows up with
    // `.toUpperCase()`. A legacy mixed-case row then looked NEW, hit the unique
    // constraint, failed createMany and dropped the chunk to the slow path —
    // silently, and only on dirty data.
    const out = partitionCorporateActionWrites(
      [row({ symbol: "reliance" })],
      [
        {
          symbol: "RELIANCE",
          exchange: "NSE",
          type: "SPLIT",
          exDate: new Date("2024-03-15"),
        },
      ]
    );
    assert.equal(out.fresh.length, 0);
    assert.equal(out.collisions.length, 1);
  });

  it("keys on ALL FOUR unique columns, not a subset", () => {
    // Same symbol+exchange+exDate, different type = a genuinely different
    // action (a stock can go ex-dividend and ex-bonus on the same day).
    const existing = [
      {
        symbol: "RELIANCE",
        exchange: "NSE",
        type: "DIVIDEND",
        exDate: new Date("2024-03-15"),
      },
    ];
    const out = partitionCorporateActionWrites(
      [row({ type: "SPLIT" })],
      existing
    );
    assert.equal(out.fresh.length, 1, "SPLIT must not collide with DIVIDEND");

    const sameDayOtherExchange = partitionCorporateActionWrites(
      [row({ exchange: "BSE" })],
      [
        {
          symbol: "RELIANCE",
          exchange: "NSE",
          type: "SPLIT",
          exDate: new Date("2024-03-15"),
        },
      ]
    );
    assert.equal(sameDayOtherExchange.fresh.length, 1, "BSE is its own row");
  });

  it("compares ex-dates by instant, not object identity", () => {
    const out = partitionCorporateActionWrites(
      [row({ exDate: new Date("2024-03-15T00:00:00.000Z") })],
      [
        {
          symbol: "RELIANCE",
          exchange: "NSE",
          type: "SPLIT",
          exDate: new Date(Date.UTC(2024, 2, 15)),
        },
      ]
    );
    assert.equal(out.collisions.length, 1);
  });

  it("treats an empty existing set as all-fresh", () => {
    const out = partitionCorporateActionWrites(
      [row({}), row({ type: "BONUS" })],
      []
    );
    assert.equal(out.fresh.length, 2);
    assert.equal(out.collisions.length, 0);
  });

  it("trims whitespace the way the writer does", () => {
    const out = partitionCorporateActionWrites(
      [row({ symbol: "  RELIANCE " })],
      [
        {
          symbol: "RELIANCE",
          exchange: "NSE",
          type: "SPLIT",
          exDate: new Date("2024-03-15"),
        },
      ]
    );
    assert.equal(out.collisions.length, 1);
  });
});

// ── corporateActionNeedsMerge (MONEY-1189) ──────────────────────────────────

describe("corporateActionNeedsMerge", () => {
  const stored = {
    isin: "INE002A01018",
    recordDate: new Date("2024-03-20"),
    ratio: 2,
    oldFaceValue: 10,
    newFaceValue: 5,
    dividendPerShare: 5,
    source: "NSE",
    details: "Dividend - Rs 5 Per Share",
    gcsPath: null as string | null,
  };

  it("says NO when the incoming row adds nothing", () => {
    // The re-walk case: ~3,800 per chunk. Each avoided is a findUnique AND an
    // update writing data identical to what is already stored.
    assert.strictEqual(
      corporateActionNeedsMerge(
        stored,
        input({ ...stored, symbol: "RELIANCE" })
      ),
      false
    );
  });

  it("says YES for each field the merge would fill from null", () => {
    const fields = [
      ["isin", "INE002A01018"],
      ["recordDate", new Date("2024-03-20")],
      ["ratio", 2],
      ["oldFaceValue", 10],
      ["newFaceValue", 5],
      ["dividendPerShare", 5],
    ] as const;
    for (const [field, value] of fields) {
      const gap = { ...stored, [field]: null };
      assert.strictEqual(
        corporateActionNeedsMerge(gap, input({ ...stored, [field]: value })),
        true,
        `${field} is null in the DB and present incoming — must merge`
      );
    }
  });

  it("says YES when a NEW source tag would be unioned in", () => {
    // "NSE" + "BSE" -> "BSE+NSE". Losing this would silently strand the
    // provenance union the merge exists to build.
    assert.strictEqual(
      corporateActionNeedsMerge(stored, input({ ...stored, source: "BSE" })),
      true
    );
  });

  it("says NO when the source tag is already present", () => {
    assert.strictEqual(
      corporateActionNeedsMerge(
        { ...stored, source: "BSE+NSE" },
        input({ ...stored, source: "NSE" })
      ),
      false
    );
  });

  it("says YES only for STRICTLY richer details", () => {
    assert.strictEqual(
      corporateActionNeedsMerge(stored, input({ ...stored, details: "Div" })),
      false,
      "shorter details must not trigger a write"
    );
    assert.strictEqual(
      corporateActionNeedsMerge(
        stored,
        input({ ...stored, details: "Dividend - Rs 5 Per Share (Final) AGM" })
      ),
      true
    );
  });

  it("says YES when the incoming row carries a new gcsPath", () => {
    assert.strictEqual(
      corporateActionNeedsMerge(
        stored,
        input({ ...stored, gcsPath: "feeds/x.json" })
      ),
      true
    );
  });

  // The guard that matters most: this predicate is a SECOND implementation of
  // the merge's field rules. If the two drift, a row that needed enriching is
  // never written and nothing reports it — so they are checked against each
  // other rather than independently asserted.
  it("agrees with mergeCorporateActions on whether anything changes", () => {
    const cases: Array<Partial<CorporateActionInput>> = [
      {},
      { isin: null },
      { ratio: null },
      { source: "BSE" },
      { source: "SCREENER" },
      { details: "much much longer details string than the stored one" },
      { dividendPerShare: null },
      { recordDate: null },
    ];
    for (const over of cases) {
      const existingRow = { ...stored, ...over };
      const incoming = input({ ...stored, symbol: "RELIANCE" });
      const base = input({ ...existingRow, symbol: "RELIANCE" });
      const merged = mergeCorporateActions(base, incoming);

      const mergeChanges =
        merged.isin !== base.isin ||
        merged.recordDate !== base.recordDate ||
        merged.ratio !== base.ratio ||
        merged.oldFaceValue !== base.oldFaceValue ||
        merged.newFaceValue !== base.newFaceValue ||
        merged.dividendPerShare !== base.dividendPerShare ||
        merged.source !== base.source ||
        merged.details !== base.details;

      assert.strictEqual(
        corporateActionNeedsMerge(existingRow, incoming),
        mergeChanges,
        `disagreement for ${JSON.stringify(over)}`
      );
    }
  });
});
