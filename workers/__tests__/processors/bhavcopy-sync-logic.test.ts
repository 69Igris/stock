/**
 * UNIT TEST — Bhavcopy-sync orchestration logic (MONEY-851).
 *
 * Exercises the REAL exported helpers from
 * workers/src/processors/bhavcopy-sync-logic.ts (no shadow copies, no Prisma /
 * network):
 *   - `parseIsoDay`           — YYYY-MM-DD → UTC-noon Date / null on garbage
 *   - `resolveTargetDay`      — explicit date honored; else most-recent trading
 *                               day (weekend + NSE holiday skipped)
 *   - `resolveBackfillDays`   — inclusive window → ascending trading days,
 *                               weekends/holidays skipped, inverted → []
 *   - `resolveExchanges`      — message exchanges → deduped BSE-then-NSE
 *   - `buildInstrumentIndex` +
 *     `resolveInstrumentId`   — the ISIN + symbol@exchange join keying the
 *                               DailyPrice upsert uses
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Type-only (erased at runtime — this test stays pure and opens no client).
import type { BhavcopyRow } from "@usemoney/core/market-data";
import {
  parseIsoDay,
  resolveTargetDay,
  resolveBackfillDays,
  resolveExchanges,
  buildInstrumentIndex,
  resolveInstrumentId,
  symbolExchangeKey,
  isinExchangeKey,
  selectTrustsToMint,
  toIndexSlug,
} from "../../src/processors/bhavcopy-sync-logic";

describe("parseIsoDay", () => {
  it("parses a valid YYYY-MM-DD to UTC noon", () => {
    const d = parseIsoDay("2026-06-18");
    assert.ok(d);
    assert.equal(d!.toISOString(), "2026-06-18T12:00:00.000Z");
  });

  it("rejects malformed / impossible dates", () => {
    assert.equal(parseIsoDay("2026-6-18"), null);
    assert.equal(parseIsoDay("not-a-date"), null);
    assert.equal(parseIsoDay("2026-02-31"), null); // Feb 31 doesn't exist
    assert.equal(parseIsoDay("2026-13-01"), null);
  });
});

describe("resolveTargetDay", () => {
  it("honors an explicit valid date verbatim", () => {
    const d = resolveTargetDay("2026-06-18");
    assert.equal(d.toISOString().slice(0, 10), "2026-06-18");
  });

  it("falls back to auto-resolution on a malformed date", () => {
    // A Wednesday (trading day). Malformed input → resolves to 'now' day.
    const now = new Date(Date.UTC(2026, 5, 17, 12, 0, 0)); // 2026-06-17 Wed
    const d = resolveTargetDay("garbage", now);
    assert.equal(d.toISOString().slice(0, 10), "2026-06-17");
  });

  it("returns the same day when 'now' is a trading weekday", () => {
    const now = new Date(Date.UTC(2026, 5, 17, 12, 0, 0)); // Wed 2026-06-17
    assert.equal(resolveTargetDay(undefined, now).toISOString().slice(0, 10), "2026-06-17");
  });

  it("walks back over the weekend (Sunday → Friday)", () => {
    const sun = new Date(Date.UTC(2026, 5, 21, 12, 0, 0)); // Sun 2026-06-21
    assert.equal(resolveTargetDay(undefined, sun).toISOString().slice(0, 10), "2026-06-19"); // Fri
  });

  it("skips an NSE holiday (2026-08-15 Independence Day → prior trading day)", () => {
    // 2026-08-15 is a Saturday holiday; 14th is Friday → resolves to the 14th.
    const sat = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
    assert.equal(resolveTargetDay(undefined, sat).toISOString().slice(0, 10), "2026-08-14");
  });
});

describe("resolveBackfillDays", () => {
  it("returns ascending trading days within an inclusive window", () => {
    // Mon 2026-06-15 .. Fri 2026-06-19 → 5 weekdays, no holidays in that week.
    const days = resolveBackfillDays("2026-06-15", "2026-06-19");
    assert.deepEqual(
      days.map((d) => d.toISOString().slice(0, 10)),
      ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"],
    );
  });

  it("skips weekends inside the window", () => {
    // Fri 2026-06-19 .. Mon 2026-06-22 → drops Sat 20 + Sun 21.
    const days = resolveBackfillDays("2026-06-19", "2026-06-22");
    assert.deepEqual(
      days.map((d) => d.toISOString().slice(0, 10)),
      ["2026-06-19", "2026-06-22"],
    );
  });

  it("returns [] for an inverted or partial window", () => {
    assert.deepEqual(resolveBackfillDays("2026-06-19", "2026-06-15"), []);
    assert.deepEqual(resolveBackfillDays("2026-06-19", undefined), []);
    assert.deepEqual(resolveBackfillDays(undefined, undefined), []);
  });

  it("honors the cap", () => {
    const days = resolveBackfillDays("2026-06-01", "2026-06-30", 3);
    assert.equal(days.length, 3);
  });
});

describe("resolveExchanges", () => {
  it("defaults to both in BSE-then-NSE order", () => {
    assert.deepEqual(resolveExchanges(undefined), ["BSE", "NSE"]);
    assert.deepEqual(resolveExchanges([]), ["BSE", "NSE"]);
  });

  it("dedupes and normalizes order", () => {
    assert.deepEqual(resolveExchanges(["NSE", "BSE", "NSE"]), ["BSE", "NSE"]);
    assert.deepEqual(resolveExchanges(["NSE"]), ["NSE"]);
  });
});

describe("buildInstrumentIndex + resolveInstrumentId", () => {
  const instruments = [
    { id: "nse-rel", isin: "INE002A01018", symbol: "RELIANCE", exchange: "NSE" },
    { id: "bse-rel", isin: "INE002A01018", symbol: "500325", exchange: "BSE" },
    { id: "nse-tcs", isin: "INE467B01029", symbol: "TCS", exchange: "NSE" },
    { id: "nolisting", isin: null, symbol: "ONLYSYM", exchange: "NSE" },
  ];

  it("indexes by ISIN@exchange (both listings kept) and symbol@exchange", () => {
    const index = buildInstrumentIndex(instruments);
    // MONEY-1085: one ISIN identifies a SECURITY, not a listing, so both its
    // NSE and BSE rows must survive indexing. The old bare-ISIN key was
    // first-wins, so "bse-rel" was silently unreachable via ISIN.
    assert.equal(
      index.byIsinExchange.get(isinExchangeKey("INE002A01018", "NSE")),
      "nse-rel",
    );
    assert.equal(
      index.byIsinExchange.get(isinExchangeKey("INE002A01018", "BSE")),
      "bse-rel",
    );
    assert.equal(
      index.byIsinExchange.get(isinExchangeKey("INE467B01029", "NSE")),
      "nse-tcs",
    );
    assert.equal(index.bySymbolExchange.get(symbolExchangeKey("500325", "BSE")), "bse-rel");
    assert.equal(index.bySymbolExchange.get(symbolExchangeKey("RELIANCE", "NSE")), "nse-rel");
  });

  it("prefers symbol+exchange over ISIN (pins the exact listing)", () => {
    const index = buildInstrumentIndex(instruments);
    // BSE bhavcopy row: numeric scrip code as symbol, shared ISIN. Must resolve
    // to the BSE listing via symbol@exchange, NOT the NSE listing via ISIN.
    const id = resolveInstrumentId(
      { isin: "INE002A01018", symbol: "500325", exchange: "BSE" },
      index,
    );
    assert.equal(id, "bse-rel");
  });

  it("falls back to ISIN on the SAME exchange when symbol misses", () => {
    const index = buildInstrumentIndex(instruments);
    // A BSE row whose numeric symbol we don't have, but whose ISIN matches a
    // BSE listing → resolves to that BSE listing.
    assert.equal(
      resolveInstrumentId(
        { isin: "INE002A01018", symbol: "999999", exchange: "BSE" },
        index,
      ),
      "bse-rel",
    );
  });

  it("THE CORRUPTION: never resolves an ISIN across exchanges", () => {
    const index = buildInstrumentIndex(instruments);
    // TCS exists ONLY as an NSE row here. A BSE bhavcopy row carrying TCS's
    // ISIN must NOT resolve to the NSE instrument: DailyPrice is keyed
    // [instrumentId, date] with no exchange column, so that would write BSE's
    // close onto NSE's instrument for the same day — silently, no error.
    //
    // This test previously asserted "nse-tcs", i.e. it pinned the corrupting
    // behaviour as intended. 293 real NSE bhavcopy rows/day sit in exactly this
    // shape (present in instrument_mappings only as their BSE listing), so
    // populating InstrumentMapping.isin under the old bare-ISIN key would have
    // started corrupting them instead of dropping them (MONEY-1085).
    assert.equal(
      resolveInstrumentId(
        { isin: "INE467B01029", symbol: "532540", exchange: "BSE" },
        index,
      ),
      null,
    );
  });

  it("returns null when neither symbol+exchange nor ISIN resolves", () => {
    const index = buildInstrumentIndex(instruments);
    assert.equal(
      resolveInstrumentId({ isin: "INE000X01010", symbol: "UNKNOWN", exchange: "NSE" }, index),
      null,
    );
    // Null ISIN + unknown symbol → null.
    assert.equal(
      resolveInstrumentId({ isin: null, symbol: "MISSING", exchange: "BSE" }, index),
      null,
    );
  });

  it("matches case-insensitively on symbol and ISIN", () => {
    const index = buildInstrumentIndex(instruments);
    assert.equal(
      resolveInstrumentId({ isin: "ine002a01018", symbol: "reliance", exchange: "NSE" }, index),
      "nse-rel",
    );
  });

  // The exchange half of that normalisation, asserted where a lowercase
  // exchange can actually ARRIVE. `resolveInstrumentId` takes
  // `Pick<BhavcopyRow, …>` and `BhavcopyRow.exchange` is the union
  // `"NSE" | "BSE"`, so a lowercase value cannot reach it through the type —
  // this test used to pass `exchange: "nse"` there, which only type-checked
  // because nothing ever ran `tsc` over this tree (MONEY-1326). The key
  // BUILDERS take a bare `string`, which is the real seam: they are what a raw
  // CSV field flows through, so that is where the `.toUpperCase()` earns its
  // assertion.
  it("uppercases the exchange when building either key", () => {
    assert.equal(symbolExchangeKey("reliance", "nse"), "RELIANCE@NSE");
    assert.equal(isinExchangeKey("ine002a01018", "bse"), "INE002A01018@BSE");
    // Surrounding whitespace too — a CSV column arrives padded often enough.
    assert.equal(symbolExchangeKey(" reliance ", " nse "), "RELIANCE@NSE");
  });
});

describe("selectTrustsToMint (MONEY-1085 follow-up)", () => {
  const TRUST = { RR: "REIT", IV: "INVIT" };
  const idx = (keys: string[]) => ({ bySymbolExchange: new Map(keys.map((k) => [k, "id"])) });
  // Typed as the real row slice `selectTrustsToMint` is generic over, NOT
  // `as never`. `never` satisfies every constraint, so the old cast inferred
  // `T = never` and made `picked` a `never[]` — every `.map((r) => r.symbol)`
  // below was reading a property off `never`, which the suite could not see
  // because nothing type-checked it (MONEY-1326).
  const row = (
    symbol: string,
    series: string,
    exchange: BhavcopyRow["exchange"] = "NSE",
  ): Pick<BhavcopyRow, "symbol" | "series" | "exchange"> => ({
    symbol,
    series,
    exchange,
  });

  it("selects NSE trust rows we don't already have", () => {
    const picked = selectTrustsToMint(
      [row("EMBASSY", "RR"), row("INDIGRID", "IV")],
      idx([]),
      TRUST,
    );
    assert.deepEqual(picked.map((r) => r.symbol), ["EMBASSY", "INDIGRID"]);
  });

  it("NEVER mints a non-trust series — a price feed must not build the universe", () => {
    // The guard that keeps this from becoming "mint everything the parser
    // emits". EQ/BE/SM all have proper instrument-master sources.
    const picked = selectTrustsToMint(
      [row("RELIANCE", "EQ"), row("SOMESME", "SM"), row("BOOKENTRY", "BE")],
      idx([]),
      TRUST,
    );
    assert.deepEqual(picked, []);
  });

  it("never mints on BSE (Zerodha already supplies that listing)", () => {
    assert.deepEqual(
      selectTrustsToMint([row("EMBASSY", "RR", "BSE")], idx([]), TRUST),
      [],
    );
  });

  it("skips instruments we already resolve — idempotent across daily runs", () => {
    const picked = selectTrustsToMint(
      [row("EMBASSY", "RR"), row("INDIGRID", "IV")],
      idx([symbolExchangeKey("EMBASSY", "NSE")]),
      TRUST,
    );
    assert.deepEqual(picked.map((r) => r.symbol), ["INDIGRID"]);
  });

  it("dedupes repeated symbols so a malformed file can't cause N upserts", () => {
    const picked = selectTrustsToMint(
      [row("EMBASSY", "RR"), row("EMBASSY", "RR")],
      idx([]),
      TRUST,
    );
    assert.equal(picked.length, 1);
  });

  it("returns [] for an empty file", () => {
    assert.deepEqual(selectTrustsToMint([], idx([]), TRUST), []);
  });
});

describe("selectTrustsToMint returns the WHOLE row it was given (MONEY-1157)", () => {
  // REGRESSION GUARD for a type-level defect with a data-level consequence.
  //
  // `selectTrustsToMint` used to declare both its parameter and its return as
  // `Pick<BhavcopyRow, "symbol" | "exchange" | "series">`, but the caller
  // (`mintMissingTrustInstruments` in bhavcopy-sync.ts) passes FULL rows and
  // reads `row.name` and `row.isin` off the results to build the
  // InstrumentMapping. `tsc` flagged those reads; `tsup`/esbuild never
  // type-checks, so the build was green and the runtime was correct.
  //
  // The tempting "fix" was to make the runtime match the declaration — narrow
  // the returned objects to the three declared fields. That would have silently
  // dropped `name` and `isin` from every REIT/InvIT minted from a bhavcopy,
  // with NO test failure: `name` falls back to `row.symbol` and `isin` is
  // spread conditionally (`...(row.isin ? { isin: row.isin } : {})`), so both
  // degrade quietly. This function is a FILTER — the rows it returns must be
  // the rows it was handed, byte for byte.
  const TRUST = { RR: "REIT", IV: "INVIT" };
  const emptyIndex = { bySymbolExchange: new Map<string, string>() };

  const fullRow = (
    symbol: string,
    series: string,
  ): BhavcopyRow => ({
    isin: `INE000${symbol.slice(0, 2)}01011`,
    symbol,
    exchange: "NSE",
    open: 100,
    high: 110,
    low: 99,
    close: 105,
    prevClose: 101,
    volume: 12_345,
    series,
    name: `${symbol} REAL ESTATE INVESTMENT TRUST`,
    date: new Date("2026-06-18T00:00:00.000Z"),
  });

  it("preserves name and isin — the two fields the mint path writes", () => {
    const input = fullRow("EMBASSY", "RR");
    const [picked] = selectTrustsToMint([input], emptyIndex, TRUST);

    assert.ok(picked, "the trust row should have been selected");
    // The exact fields mintMissingTrustInstruments reads. If the return type is
    // ever narrowed back to the 3-field Pick, these go undefined and every
    // minted REIT/InvIT loses its registered name and its ISIN.
    assert.equal(picked.name, "EMBASSY REAL ESTATE INVESTMENT TRUST");
    assert.equal(picked.isin, "INE000EM01011");
  });

  it("returns the SAME object reference, not a projection", () => {
    // The strongest form of the guard: identity can only hold if nothing
    // reshaped the row on the way out.
    const a = fullRow("EMBASSY", "RR");
    const b = fullRow("INDIGRID", "IV");
    const picked = selectTrustsToMint([a, b], emptyIndex, TRUST);
    assert.equal(picked.length, 2);
    assert.equal(picked[0], a);
    assert.equal(picked[1], b);
  });

  it("carries every BhavcopyRow field through untouched", () => {
    const input = fullRow("NXTREIT", "RR");
    const [picked] = selectTrustsToMint([input], emptyIndex, TRUST);
    assert.ok(picked);
    assert.deepEqual(Object.keys(picked).sort(), Object.keys(input).sort());
    assert.deepEqual(picked, input);
  });

  it("a null ISIN survives as null (not dropped) so the mint can skip it", () => {
    // `mintMissingTrustInstruments` spreads ISIN conditionally, so a row whose
    // ISIN is genuinely absent must arrive as `null` rather than as a missing
    // key that looks the same as a stripped one.
    const input: BhavcopyRow = { ...fullRow("NOISIN", "IV"), isin: null };
    const [picked] = selectTrustsToMint([input], emptyIndex, TRUST);
    assert.ok(picked);
    assert.equal(picked.isin, null);
    assert.ok("isin" in picked);
  });
});

describe("toIndexSlug (MONEY-1085 follow-up)", () => {
  it("normalises NSE's cosmetic name variants to ONE key", () => {
    // The bug this prevents: keying IndexClose on the raw display name would
    // fork one index's history into two the day NSE changes capitalisation.
    assert.equal(toIndexSlug("Nifty 50"), "nifty-50");
    assert.equal(toIndexSlug("NIFTY 50"), "nifty-50");
    assert.equal(toIndexSlug("  nifty  50  "), "nifty-50");
  });

  it("handles the punctuated index names NSE actually publishes", () => {
    assert.equal(
      toIndexSlug("Nifty BHARAT Bond Index - April 2033"),
      "nifty-bharat-bond-index-april-2033",
    );
    assert.equal(toIndexSlug("Nifty50 USD"), "nifty50-usd");
    assert.equal(toIndexSlug("Nifty 1D Rate Index"), "nifty-1d-rate-index");
    assert.equal(toIndexSlug("Nifty Midcap 150"), "nifty-midcap-150");
  });

  it("never emits leading/trailing or repeated separators", () => {
    assert.equal(toIndexSlug("--Nifty--Bank--"), "nifty-bank");
    assert.equal(toIndexSlug("Nifty & Co."), "nifty-co");
  });

  it("returns '' for blank input so the caller can skip it", () => {
    // An empty slug must never be written — the row could never be looked up.
    assert.equal(toIndexSlug(""), "");
    assert.equal(toIndexSlug("   "), "");
    assert.equal(toIndexSlug("!!!"), "");
    assert.equal(toIndexSlug(undefined as unknown as string), "");
  });

  it("distinct indices never collide", () => {
    const names = [
      "Nifty 50",
      "Nifty Next 50",
      "Nifty 100",
      "Nifty Bank",
      "Nifty IT",
      "Nifty50 USD",
    ];
    const slugs = names.map(toIndexSlug);
    assert.equal(new Set(slugs).size, names.length, slugs.join(", "));
  });
});
