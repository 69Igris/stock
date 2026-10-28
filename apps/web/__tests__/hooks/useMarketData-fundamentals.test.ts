/**
 * The market-data service serves a STRICTLY SMALLER quote, and the stock page
 * renders the half it does not have. MONEY-1478.
 *
 * ## WHAT BROKE, IN PRODUCTION
 *
 * `StoredQuote` (`packages/core/src/market-data/quotes/quote-logic.ts`) is
 * price / change / OHLC / volume / ts / source. It has NO `pe`, `eps`,
 * `marketCap`, `week52High` or `week52Low` — not null, ABSENT. So flipping
 * `MARKET_DATA_QUOTES` true pointed the poller at an origin that cannot answer
 * five of the eight KEY METRICS tiles, and the stock page rendered "—" in all
 * five while LTP, OPEN, PREV CLOSE and VOLUME kept ticking beside them. A card
 * that is half live and half blank reads as a rendering glitch, not as missing
 * data, which is why it was reported as "data is missing" rather than "the flag
 * is wrong".
 *
 * ## WHY THIS IS A REGRESSION AND NOT A NEW GAP
 *
 * This repo had ALREADY paid for this lesson one layer down.
 * `quote-cache-logic.ts` keeps its `LatestQuote` DB leg OFF by default with the
 * note: those rows "carry no pe/eps/week52High/week52Low, so the result is a
 * strictly smaller quote", and enabling it "blanked four of the eight tiles on
 * every stock page". MONEY-1469 then built a SECOND origin with that same
 * smaller shape on a DIFFERENT code path, where that guard does not reach.
 *
 * So these cases pin the PROPERTY — a caller that renders fundamentals is never
 * served a quote that structurally lacks them — rather than the flag.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  resolveMarketDataOptions,
  transformServiceQuotes,
} from "@/hooks/useMarketData-logic";

/** A service quote exactly as `StoredQuote` serialises: no fundamentals. */
function serviceBody(symbol = "RELIANCE") {
  return {
    s: "ok",
    market: "IN",
    data: {
      [symbol]: {
        price: 1243.9,
        change: 3.9,
        changePct: 0.31,
        open: 1244.8,
        high: 1253.4,
        low: 1238.5,
        prevClose: 1240,
        volume: 7_700_000,
        ts: Date.UTC(2026, 8, 18, 10, 0, 0),
        source: "BHAVCOPY",
      },
    },
    missing: [],
  } as unknown as Parameters<typeof transformServiceQuotes>[0];
}

describe("a fundamentals-rendering caller is never served the smaller shape", () => {
  it("WITHOUT the flag the service quote is accepted (the A4 win is intact)", () => {
    // The control. If this ever flips, the fix has been applied platform-wide
    // and every watchlist poll is paying a legacy round trip it does not need.
    const { quotes, incomplete } = transformServiceQuotes(
      serviceBody(),
      "NSE",
      false
    );
    assert.deepEqual(incomplete, []);
    assert.equal(quotes.RELIANCE?.price, 1243.9);
  });

  it("WITH the flag the same quote is INCOMPLETE and falls back", () => {
    const { quotes, incomplete } = transformServiceQuotes(
      serviceBody(),
      "NSE",
      true
    );
    assert.deepEqual(
      incomplete,
      ["RELIANCE"],
      "a quote with no pe/marketCap/week52High must be named so the caller " +
        "can fetch the full shape from the legacy route"
    );
    assert.equal(
      quotes.RELIANCE,
      undefined,
      "it must NOT also be emitted — `{...fallback, ...quotes}` merges the " +
        "service shape LAST, so emitting it here would overwrite the legacy " +
        "quote that was fetched to replace it and blank the tiles anyway"
    );
  });

  it("a service quote that DOES carry fundamentals is kept, flag or not", () => {
    // The check is on the DATA, not on the flag: if the service ever grows
    // these columns the fallback stops firing on its own. A blanket
    // `if (needsFundamentals) continue` would pin this caller to the legacy
    // route for ever and pass every other case in this file.
    const body = serviceBody();
    Object.assign(
      (body as unknown as { data: Record<string, Record<string, unknown>> })
        .data.RELIANCE!,
      // ALL FIVE. The rule is `||` over every field the caller renders, so a
      // partial rollout — the service shipping `marketCap` alone — must still
      // fall back rather than blank the other four silently.
      {
        marketCap: 1.68e13,
        pe: 22.4,
        eps: 55.4,
        week52High: 1608.8,
        week52Low: 1114.85,
      }
    );
    const { quotes, incomplete } = transformServiceQuotes(body, "NSE", true);
    assert.deepEqual(incomplete, []);
    assert.equal(quotes.RELIANCE?.price, 1243.9);
  });

  it("a PARTIAL rollout still falls back — `||`, not `&&`", () => {
    // The defect the first cut shipped. `&&` meant one field satisfied the
    // guard: the service adds `marketCap` alone -> not incomplete -> no
    // fallback -> pe/eps/week52High/week52Low still undefined -> four tiles
    // blank again, silently, with no code change anywhere.
    const body = serviceBody();
    Object.assign(
      (body as unknown as { data: Record<string, Record<string, unknown>> })
        .data.RELIANCE!,
      { marketCap: 1.68e13 }
    );
    const { incomplete } = transformServiceQuotes(body, "NSE", true);
    assert.deepEqual(
      incomplete,
      ["RELIANCE"],
      "one field present must NOT satisfy a caller that renders five"
    );
  });

  it("the fields are CARRIED THROUGH, or the guard can never stop firing", () => {
    // The second half of the same defect: the built quote never copied these
    // fields, so even a service that supplied all five would lose them here —
    // the guard would go quiet and the tiles would stay empty.
    const body = serviceBody();
    Object.assign(
      (body as unknown as { data: Record<string, Record<string, unknown>> })
        .data.RELIANCE!,
      {
        marketCap: 1.68e13,
        pe: 22.4,
        eps: 55.4,
        week52High: 1608.8,
        week52Low: 1114.85,
      }
    );
    const { quotes } = transformServiceQuotes(body, "NSE", true);
    const q = quotes.RELIANCE as unknown as Record<string, unknown>;
    assert.equal(q.marketCap, 1.68e13);
    assert.equal(q.pe, 22.4);
    assert.equal(q.eps, 55.4);
    assert.equal(q.week52High, 1608.8);
    assert.equal(q.week52Low, 1114.85);
  });

  it("no-change still wins: a quote with neither is incomplete ONCE", () => {
    // The two reasons share one output list, so a quote failing both must not
    // be pushed twice — `needLegacy` dedupes, but a double push would hide a
    // real ordering bug behind that dedupe.
    const body = serviceBody();
    const row = (
      body as unknown as { data: Record<string, Record<string, unknown>> }
    ).data.RELIANCE!;
    delete row.change;
    delete row.changePct;
    delete row.prevClose;
    const { incomplete } = transformServiceQuotes(body, "NSE", true);
    assert.deepEqual(incomplete, ["RELIANCE"]);
  });
});

describe("the option defaults to the CHEAP direction", () => {
  it("unset resolves false", () => {
    // Defaulting true would send every ticker and watchlist poll on the
    // platform to the legacy route and silently undo A4 — a performance
    // regression with no error anywhere, which is the failure mode this whole
    // service exists to end.
    assert.equal(resolveMarketDataOptions({}).needsFundamentals, false);
  });

  it("explicit true is carried through", () => {
    assert.equal(
      resolveMarketDataOptions({ needsFundamentals: true }).needsFundamentals,
      true
    );
  });
});

describe("the option is actually WIRED at the one caller that needs it", () => {
  // A source scan, and named as the weaker instrument it is: it proves a call
  // site EXISTS, never that the value is right. It is here because the whole
  // failure mode of this family is a resolver with no caller — A3 shipped the
  // prop and the resolver and wired NEITHER, so flipping MARKET_DATA_TILES in
  // prod changed nothing at all. Deleting `needsFundamentals: true` from the
  // stock page would restore the blank tiles with every case above still green.
  // READ LAZILY, INSIDE THE TEST — never in the describe body.
  //
  // A `describe` callback runs at COLLECTION time, and anything that throws
  // there does NOT count as a failure: node:test reports the already-registered
  // subtests as CANCELLED and leaves `# fail` at 0. A red build with
  // `# fail 0` names nothing, which is this repo's most expensive reporting
  // shape (see the `# fail 0 hides suite-level errors` note) — and a file read
  // is exactly the kind of thing that works on one machine and not another.
  //
  // Called per test rather than memoised: two reads of a small file cost
  // nothing, and a memo would put the hazard back in module scope.
  const client = () =>
    readFileSync(
      join(
        dirname(new URL(import.meta.url).pathname),
        "..",
        "..",
        "app",
        "stock",
        "[symbol]",
        "client.tsx"
      ),
      "utf8"
    );

  it("the stock page passes needsFundamentals to useQuote", () => {
    const call = /useQuote\(([\s\S]*?)\n  \}\);/.exec(client());
    assert.ok(call, "the useQuote call site was not found — did it move?");
    assert.match(
      call[1]!,
      /needsFundamentals:\s*true/,
      "the KEY METRICS card renders pe/eps/marketCap/week52High/week52Low and " +
        "the market-data service carries none of them"
    );
  });

  it("and it is the page that RENDERS those tiles", () => {
    // Anti-vacuity: if the tiles ever stop reading the quote, the wiring above
    // is dead weight and this says so rather than passing for ever.
    for (const field of ["pe", "eps", "marketCap", "week52High", "week52Low"]) {
      assert.ok(
        client().includes(`quote?.${field}`),
        `the page no longer reads quote.${field} — re-check whether ` +
          `needsFundamentals is still needed`
      );
    }
  });
});
