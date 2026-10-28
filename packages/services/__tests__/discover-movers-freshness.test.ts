/**
 * MONEY-1198 — the Top Movers panel showed the PREVIOUS session as "today", and
 * counted a dual-listed company twice.
 *
 * ## What the user saw
 *
 *   Top movers panel:  LAPL  Rs 128.29  +36.48%   (listed as today's top gainer)
 *   LAPL detail page:  LAPL  Rs 121.88  -5.00% today, PREV CLOSE Rs 128.29
 *
 * Rs 128.29 was YESTERDAY'S CLOSE. Back-solving the percentage confirms it —
 * 128.29 / 1.3648 = 94.0, so 94.0 -> 128.29 was the PREVIOUS day's move. The
 * panel ranked the previous session and captioned it "today", so its headline
 * gainer was in fact down 5.00% on the day.
 *
 * ## Why nothing caught it
 *
 * Every number on that panel was internally consistent; none of them was
 * today's. `fetchTopMovers` ranked `latest_quotes` with NO age predicate, and
 * nothing bulk-refreshes that table intraday — `price-sync` runs at 23:00 IST,
 * so by 11:47 the next morning the whole table was still the prior close. The
 * detail page differed only because opening it goes through the 60s-TTL quote
 * path, which refetches per symbol.
 *
 * The 60s `MOVERS_TTL_LIVE_SECONDS` looks like freshness handling and is not:
 * it governs how often the movers CACHE re-derives, not how old the rows it
 * derives FROM are. A fresh cache over a stale table is still stale, and that
 * gap is exactly where the bug lived.
 *
 * These are pure tests of the two helpers the fix rests on. No DB, no timers,
 * nothing to orphan.
 *
 * Source: packages/services/src/discover-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dedupeDualListings,
  istDayKey,
  istDayStart,
  rankGainers,
} from "../src/discover-logic";

/** Build a mover row with only the fields the helpers read. */
function row(
  over: Partial<{
    symbol: string;
    exchange: string;
    instrumentId: string;
    isin: string | null;
    volume: number | null;
    changePercent: number;
    change: number;
  }> = {},
) {
  return {
    symbol: "ACME",
    exchange: "NSE",
    instrumentId: "i1",
    isin: null as string | null,
    volume: 1_000,
    changePercent: 5,
    change: 5,
    ...over,
  };
}

describe("istDayStart / istDayKey — the trading day is an IST calendar day", () => {
  it("puts an instant just after IST midnight on the NEW day", () => {
    // 2026-08-13 18:31 UTC = 2026-08-14 00:01 IST. A server reasoning in UTC
    // would call this the 13th and reject a genuinely fresh quote.
    assert.equal(istDayKey(new Date("2026-08-13T18:31:00Z")), "2026-08-14");
  });

  it("puts an instant just before IST midnight on the OLD day", () => {
    // 2026-08-13 18:29 UTC = 2026-08-13 23:59 IST.
    assert.equal(istDayKey(new Date("2026-08-13T18:29:00Z")), "2026-08-13");
  });

  it("keeps a mid-session IST instant on its own day", () => {
    // The reported bug happened at 11:47 IST = 06:17 UTC on the 14th.
    assert.equal(istDayKey(new Date("2026-08-14T06:17:00Z")), "2026-08-14");
  });

  it("istDayStart is the 18:30 UTC boundary of the previous date", () => {
    assert.equal(
      istDayStart(new Date("2026-08-14T06:17:00Z")).toISOString(),
      "2026-08-13T18:30:00.000Z",
    );
  });

  it("REGRESSION: yesterday's close and today's quote are DIFFERENT days", () => {
    // The whole bug in one assertion. price-sync writes at 23:00 IST on day D
    // (17:30 UTC); the panel is read at 11:47 IST on day D+1. If these ever
    // compare equal, a stale row can be ranked as today's mover again.
    const writtenByPriceSync = new Date("2026-08-13T17:30:00Z"); // 23:00 IST 13th
    const readAt = new Date("2026-08-14T06:17:00Z"); // 11:47 IST 14th
    assert.notEqual(istDayKey(writtenByPriceSync), istDayKey(readAt));
    assert.equal(istDayKey(writtenByPriceSync), "2026-08-13");
    assert.equal(istDayKey(readAt), "2026-08-14");
  });
});

describe("dedupeDualListings — one company, one row (MONEY-1198)", () => {
  it("REGRESSION: collapses the NSE and BSE legs of one company", () => {
    // Live from the reported screenshot: JUBLCPL appeared at Rs 2,322.60 AND
    // Rs 2,327.25, OMAXE at Rs 98.37 AND Rs 98.26, ATAM at Rs 53.35 AND
    // Rs 54.35. Four of eight visible gainer slots were second copies, so a
    // list claiming the ten biggest movers showed about five companies.
    const rows = [
      row({
        symbol: "JUBLCPL",
        exchange: "NSE",
        instrumentId: "n1",
        isin: "INE111A01011",
        volume: 900,
      }),
      row({
        symbol: "JUBLCPL",
        exchange: "BSE",
        instrumentId: "b1",
        isin: "INE111A01011",
        volume: 100,
      }),
    ];
    const out = dedupeDualListings(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.instrumentId, "n1", "keeps the higher-volume leg");
  });

  it("keys on ISIN, not symbol — the durable identity wins", () => {
    // Same ISIN under two different symbol strings is still ONE company.
    // Symbol-only keying would keep both and re-open the bug.
    const rows = [
      row({
        symbol: "OLDNAME",
        instrumentId: "a",
        isin: "INE999Z01011",
        volume: 10,
      }),
      row({
        symbol: "NEWNAME",
        instrumentId: "b",
        isin: "INE999Z01011",
        volume: 20,
      }),
    ];
    assert.equal(dedupeDualListings(rows).length, 1);
  });

  it("does NOT merge two genuinely different companies", () => {
    // The failure mode in the other direction: over-eager collapsing would
    // silently delete a real mover from the list.
    const rows = [
      row({ symbol: "AAA", instrumentId: "a", isin: "INE001A01011" }),
      row({ symbol: "BBB", instrumentId: "b", isin: "INE002A01011" }),
    ];
    assert.equal(dedupeDualListings(rows).length, 2);
  });

  it("falls back to symbol only when ISIN is absent, and does not group all nulls", () => {
    // Every ISIN-less row sharing one bucket would collapse the whole tail of
    // the market into a single mover.
    const rows = [
      row({ symbol: "AAA", exchange: "NSE", instrumentId: "a", isin: null }),
      row({ symbol: "AAA", exchange: "BSE", instrumentId: "b", isin: null }),
      row({ symbol: "CCC", exchange: "NSE", instrumentId: "c", isin: null }),
    ];
    const out = dedupeDualListings(rows);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((r) => r.symbol).sort(), ["AAA", "CCC"]);
  });

  it("an ABSENT volume loses to a real zero-volume row", () => {
    // null must not be coerced to 0 and tie: "we don't know" is weaker
    // evidence than a measured zero, and a tie here would be broken by
    // exchange, silently preferring BSE on an alphabetical accident.
    const rows = [
      row({
        symbol: "AAA",
        exchange: "BSE",
        instrumentId: "known",
        isin: "INE1",
        volume: 0,
      }),
      row({
        symbol: "AAA",
        exchange: "NSE",
        instrumentId: "unknown",
        isin: "INE1",
        volume: null,
      }),
    ];
    const out = dedupeDualListings(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.instrumentId, "known");
  });

  it("is deterministic when volumes tie — the panel must not flicker", () => {
    // Two near-identical prices swapping on every 60s refresh reads as live
    // data changing when nothing changed.
    const rows = [
      row({
        symbol: "AAA",
        exchange: "NSE",
        instrumentId: "z",
        isin: "INE1",
        volume: 5,
      }),
      row({
        symbol: "AAA",
        exchange: "BSE",
        instrumentId: "a",
        isin: "INE1",
        volume: 5,
      }),
    ];
    const first = dedupeDualListings(rows)[0]!.instrumentId;
    const second = dedupeDualListings([...rows].reverse())[0]!.instrumentId;
    assert.equal(first, second);
  });

  it("preserves the caller's ordering", () => {
    // Applied before `take`, so it must not disturb the %change ranking it is
    // handed — otherwise the top-10 slice would return the wrong ten.
    const rows = [
      row({
        symbol: "AAA",
        instrumentId: "a",
        isin: "INE1",
        changePercent: 9,
        change: 9,
      }),
      row({
        symbol: "BBB",
        instrumentId: "b",
        isin: "INE2",
        changePercent: 7,
        change: 7,
      }),
      row({
        symbol: "CCC",
        instrumentId: "c",
        isin: "INE3",
        changePercent: 3,
        change: 3,
      }),
    ];
    assert.deepEqual(
      dedupeDualListings(rows).map((r) => r.symbol),
      ["AAA", "BBB", "CCC"],
    );
  });

  it("frees the slot a duplicate was consuming, so `take` returns 10 companies", () => {
    // The user-visible consequence, asserted end to end against the real
    // ranking function: with duplicates present a top-10 held only 5 distinct
    // companies.
    const dupes = Array.from({ length: 10 }, (_, i) => [
      row({
        symbol: `S${i}`,
        exchange: "NSE",
        instrumentId: `n${i}`,
        isin: `INE${i}`,
        changePercent: 20 - i,
        change: 1,
        volume: 100,
      }),
      row({
        symbol: `S${i}`,
        exchange: "BSE",
        instrumentId: `b${i}`,
        isin: `INE${i}`,
        changePercent: 20 - i,
        change: 1,
        volume: 50,
      }),
    ]).flat();

    const withDupes = rankGainers(dupes, 10);
    assert.equal(new Set(withDupes.map((r) => r.symbol)).size, 5);

    const collapsed = rankGainers(dedupeDualListings(dupes), 10);
    assert.equal(new Set(collapsed.map((r) => r.symbol)).size, 10);
  });
});
