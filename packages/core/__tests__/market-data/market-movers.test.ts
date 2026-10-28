/**
 * Exchange-published movers + live index snapshot — MONEY-1198.
 *
 * Every fixture under `__tests__/fixtures/nse-movers/` is a REAL response
 * captured from our own egress on 2026-08-14 and trimmed BY WHOLE RECORDS
 * ONLY — no field was edited, added or reshaped, so a payload trap that
 * survives here is a trap that exists in production.
 *
 *   live-analysis-variations-gainers.json    index=gainers,  7 buckets, 28 rows
 *   live-analysis-variations-loosers.json    index=loosers,  7 buckets, 28 rows
 *   live-analysis-variations-losers-misspelled.json
 *                                            index=losers -> HTTP 200 + error body
 *   all-indices.json                         /api/allIndices, 8 index rows
 *
 * The rows kept are deliberately the awkward ones: APOLLOHOSP / HAL /
 * FEDERALBNK (net_price and perChange disagree because a corporate action goes
 * ex today), TECHNOCRAF (they disagree with NO corporate action at all), and
 * the cross-bucket duplicates BHARTIARTL, APOLLOHOSP and GALAXYSURF.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseNseMovers,
  parseNseAllIndices,
  parseNseSnapshotTimestamp,
  parseMoverNumber,
  istSessionDay,
  shouldWriteSnapshot,
  shouldPollMovers,
  dedupeMoversByCompany,
  nseMoversPath,
  NSE_MOVER_INDEX_PARAM,
  NSE_MOVER_BUCKETS,
  type MarketMoverRow,
} from "../../src/market-data/market-movers";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "nse-movers");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const GAINERS = fixture("live-analysis-variations-gainers.json");
const LOOSERS = fixture("live-analysis-variations-loosers.json");
const MISSPELLED = fixture("live-analysis-variations-losers-misspelled.json");
const ALL_INDICES = fixture("all-indices.json");

describe("parseNseSnapshotTimestamp", () => {
  it("parses the movers format, which carries SECONDS", () => {
    const d = parseNseSnapshotTimestamp("14-Aug-2026 11:53:54");
    assert.ok(d);
    // 11:53:54 IST == 06:23:54 UTC.
    assert.equal(d.toISOString(), "2026-08-14T06:23:54.000Z");
  });

  it("parses the allIndices format, which carries NO seconds", () => {
    // The two endpoints in this ONE job disagree on precision. A regex
    // demanding HH:MM:SS rejects every index snapshot.
    const d = parseNseSnapshotTimestamp("14-Aug-2026 11:56");
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-08-14T06:26:00.000Z");
  });

  it("REGRESSION: treats the string as IST wall-clock, not as UTC", () => {
    // Reading "11:53:54" as UTC and storing it would shift every snapshot
    // 5h30 into the future and put late-session polls on the wrong day.
    const d = parseNseSnapshotTimestamp("14-Aug-2026 11:53:54")!;
    assert.equal(
      d.getTime(),
      Date.UTC(2026, 7, 14, 11, 53, 54) - 5.5 * 60 * 60 * 1000,
    );
  });

  it("rejects an impossible calendar day rather than rolling it over", () => {
    assert.equal(parseNseSnapshotTimestamp("31-Feb-2026 10:00:00"), null);
  });

  it("rejects junk, empty and out-of-range clock values", () => {
    for (const bad of [
      "",
      "   ",
      null,
      undefined,
      "not a date",
      "14-Xxx-2026 11:53:54",
      "14-Aug-2026 25:00:00",
      "14-Aug-2026 11:75:00",
      "2026-08-14T11:53:54Z",
    ]) {
      assert.equal(parseNseSnapshotTimestamp(bad), null, `accepted ${bad}`);
    }
  });
});

describe("istSessionDay", () => {
  it("files a mid-session instant under its IST calendar day", () => {
    const snap = parseNseSnapshotTimestamp("14-Aug-2026 11:53:54")!;
    assert.equal(istSessionDay(snap).toISOString(), "2026-08-14T00:00:00.000Z");
  });

  it("REGRESSION: a pre-06:00-IST instant still lands on the IST day", () => {
    // 2026-08-14T00:30:00Z is 06:00 IST on the 14th. Reading the UTC date
    // would be right here but wrong the other way; the case that breaks a
    // naive implementation is an instant whose UTC day differs from its IST
    // day, which is any IST time before 05:30.
    const beforeIstDawn = new Date("2026-08-13T20:00:00.000Z"); // 01:30 IST 14th
    assert.equal(
      istSessionDay(beforeIstDawn).toISOString(),
      "2026-08-14T00:00:00.000Z",
    );
  });
});

describe("parseMoverNumber", () => {
  it("parses numbers, numeric strings and comma-grouped strings", () => {
    assert.equal(parseMoverNumber(3.14), 3.14);
    assert.equal(parseMoverNumber("20.59"), 20.59);
    assert.equal(parseMoverNumber("1,234.56"), 1234.56);
    assert.equal(parseMoverNumber(0), 0);
  });

  it("returns null — never 0 — for absent, dash and non-finite values", () => {
    // A 0 here is a claim (a price of zero, a P/E of zero) that a parse
    // failure has no business making.
    for (const bad of [null, undefined, "", "  ", "-", "abc", NaN, Infinity]) {
      assert.equal(parseMoverNumber(bad), null, `accepted ${String(bad)}`);
    }
  });
});

describe("parseNseMovers — real gainers payload", () => {
  const out = parseNseMovers(GAINERS, "GAINERS");

  it("parses every record in the fixture with nothing rejected", () => {
    assert.equal(out.rejected, null);
    assert.equal(out.rows.length, 28);
    assert.equal(out.skipped, 0);
  });

  it("stamps rows from the payload timestamp, NOT from now", () => {
    // The central claim of the ticket. If this ever reads a clock, the panel
    // goes back to labelling the previous session "today".
    assert.deepEqual(out.snapshots, ["2026-08-14T06:24:57.000Z"]);
    for (const r of out.rows) {
      assert.equal(r.snapshotAt.toISOString(), "2026-08-14T06:24:57.000Z");
      assert.equal(r.date.toISOString(), "2026-08-14T00:00:00.000Z");
    }
  });

  it("covers all seven buckets and keeps NSE's served order as rank", () => {
    const buckets = [...new Set(out.rows.map((r) => r.bucket))];
    assert.deepEqual(buckets.sort(), [...NSE_MOVER_BUCKETS].sort());
    const nifty = out.rows.filter((r) => r.bucket === "NIFTY");
    assert.deepEqual(
      nifty.map((r) => r.symbol),
      ["BHARTIARTL", "APOLLOHOSP", "ADANIENT", "ADANIPORTS"],
    );
    assert.deepEqual(
      nifty.map((r) => r.rank),
      [1, 2, 3, 4],
    );
  });

  it("TRAP: net_price is a PERCENT, not a rupee delta", () => {
    // "net PRICE" reads as a rupee move. BHARTIARTL moved 1939.10 -> 1999.90,
    // i.e. Rs 60.80, and net_price is 3.14. Off by ~20x, plausible on sight.
    const b = out.rows.find(
      (r) => r.symbol === "BHARTIARTL" && r.bucket === "NIFTY",
    )!;
    assert.equal(b.ltp, 1999.9);
    assert.equal(b.prevClose, 1939.1);
    assert.equal(Number(b.rupeeChange.toFixed(2)), 60.8);
    assert.equal(b.adjPercentChange, 3.14);
    // The rupee move lives in its own derived field, correctly signed.
    assert.ok(Math.abs(b.rupeeChange - 60.8) < 1e-9);
  });

  it("TRAP: perChange and net_price are DIFFERENT quantities on an ex-day", () => {
    // APOLLOHOSP goes ex-dividend Rs 10 today. perChange is raw against the
    // unadjusted prev close; net_price re-bases to 8590 = 8600 - 10.
    const a = out.rows.find(
      (r) => r.symbol === "APOLLOHOSP" && r.bucket === "NIFTY",
    )!;
    assert.equal(a.prevClose, 8600);
    assert.equal(a.ltp, 8854.5);
    assert.equal(a.percentChange, 2.96);
    assert.equal(a.adjPercentChange, 3.08);
    assert.equal(a.caPurpose, "Dividend - Rs 10 Per Sh");
    assert.equal(a.caExDate, "14-Aug-2026");
    // raw reconciles with ltp/prevClose; adjusted does not, by construction.
    const raw = ((a.ltp - a.prevClose) / a.prevClose) * 100;
    assert.ok(Math.abs(raw - a.percentChange) < 0.01);
    assert.ok(Math.abs(raw - a.adjPercentChange!) > 0.1);
  });

  it("TRAP: the two percent fields can DISAGREE ON SIGN inside the gainers list", () => {
    // FEDERALBNK: perChange -0.01 (a faller) while NSE served it as a GAINER,
    // because it ranks by net_price (+0.33 against base 351.25 = 352.45 - 1.20).
    // This is why direction comes from the ENDPOINT and never from a sign test.
    const f = out.rows.find((r) => r.symbol === "FEDERALBNK")!;
    assert.equal(f.direction, "GAINERS");
    assert.ok(f.percentChange < 0, "raw perChange is negative");
    assert.ok(f.adjPercentChange! > 0, "adjusted net_price is positive");
    assert.equal(f.percentChange, -0.01);
    assert.equal(f.adjPercentChange, 0.33);
  });

  it("TRAP: the fields diverge even with NO corporate action", () => {
    // TECHNOCRAF has ca_ex_dt "-" yet perChange 46.70 vs net_price 9.51. So
    // "adjusted only when ca_ex_dt is set" is false, and neither field may be
    // reconstructed from the other under any condition.
    const t = out.rows.find(
      (r) => r.symbol === "TECHNOCRAF" && r.bucket === "SecGtr20",
    )!;
    assert.equal(t.caExDate, null);
    assert.equal(t.caPurpose, null);
    assert.equal(t.percentChange, 46.7);
    assert.equal(t.adjPercentChange, 9.51);
  });

  it('TRAP: NSE writes an absent corporate action as "-", not null', () => {
    // Storing the dash would make every ordinary row look like it had an action.
    const withNone = out.rows.filter((r) => r.caExDate === null);
    assert.ok(withNone.length > 0);
    for (const r of out.rows) {
      assert.notEqual(r.caExDate, "-");
      assert.notEqual(r.caPurpose, "-");
    }
  });

  it("TRAP: the same symbol appears in MULTIPLE buckets at one instant", () => {
    // This is why `bucket` must be in the storage unique key — the
    // MarketPositioning lesson, verified on live data rather than assumed.
    const bharti = out.rows.filter((r) => r.symbol === "BHARTIARTL");
    assert.deepEqual(bharti.map((r) => r.bucket).sort(), ["FOSec", "NIFTY"]);
    const apollo = out.rows.filter((r) => r.symbol === "APOLLOHOSP");
    assert.deepEqual(apollo.map((r) => r.bucket).sort(), ["FOSec", "NIFTY"]);
    // Same instant, same symbol, same direction — so (symbol, date, direction)
    // alone would collapse these two rows into one.
    assert.equal(
      bharti[0]!.snapshotAt.getTime(),
      bharti[1]!.snapshotAt.getTime(),
    );
    assert.equal(bharti[0]!.direction, bharti[1]!.direction);
  });

  it("does NOT treat `legends` as a bucket", () => {
    // `legends` sits beside the seven buckets and is a [code,label][] array.
    assert.ok("legends" in (GAINERS as Record<string, unknown>));
    assert.equal(out.rows.filter((r) => r.bucket === "legends").length, 0);
  });
});

describe("parseNseMovers — real loosers payload", () => {
  const out = parseNseMovers(LOOSERS, "LOSERS");

  it("parses the misspelled-but-correct endpoint's payload", () => {
    assert.equal(out.rejected, null);
    assert.equal(out.rows.length, 28);
    assert.equal(out.skipped, 0);
  });

  it("labels every row LOSERS from the caller, not from the payload", () => {
    for (const r of out.rows) assert.equal(r.direction, "LOSERS");
  });

  it("carries genuinely negative moves", () => {
    const tmpv = out.rows.find((r) => r.symbol === "TMPV");
    assert.ok(tmpv, "TMPV should be in the losers fixture");
    assert.ok(tmpv.percentChange < 0);
    assert.ok(tmpv.rupeeChange < 0);
  });
});

describe("the losers/loosers spelling trap", () => {
  it("NSE_MOVER_INDEX_PARAM keeps NSE's misspelling", () => {
    assert.equal(NSE_MOVER_INDEX_PARAM.LOSERS, "loosers");
    assert.equal(NSE_MOVER_INDEX_PARAM.GAINERS, "gainers");
    assert.equal(
      nseMoversPath("LOSERS"),
      "/api/live-analysis-variations?index=loosers",
    );
  });

  it("REGRESSION: the misspelled body is REJECTED, not read as an empty market", () => {
    // `index=losers` returns HTTP 200 with {"data":"Missing index or key."}.
    // Correct English is a 200, so status alone never decides success. If this
    // ever degrades to rows:[] with rejected:null, the job writes "nothing
    // fell today" every single day and no counter says otherwise.
    const out = parseNseMovers(MISSPELLED, "LOSERS");
    assert.equal(out.rows.length, 0);
    assert.ok(out.rejected, "misspelled error body must set `rejected`");
    assert.match(out.rejected, /Missing index or key/);
  });

  it("rejects other non-movers shapes distinctly from an empty market", () => {
    for (const bad of [null, undefined, [], "string", 42, {}, { data: [] }]) {
      const out = parseNseMovers(bad, "GAINERS");
      assert.equal(out.rows.length, 0);
      assert.ok(out.rejected, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("drops a bucket whose timestamp is unusable rather than guessing one", () => {
    const broken = {
      NIFTY: { data: [{ symbol: "X", ltp: 10, prev_price: 9, perChange: 11 }] },
      allSec: {
        data: [{ symbol: "Y", ltp: 10, prev_price: 9, perChange: 11 }],
        timestamp: "14-Aug-2026 11:53:54",
      },
    };
    const out = parseNseMovers(broken, "GAINERS");
    // The dated bucket survives; the undated one is counted as skipped, never
    // stamped with "now".
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.symbol, "Y");
    assert.equal(out.skipped, 1);
  });

  it("drops rows with a zero or missing previous close", () => {
    const out = parseNseMovers(
      {
        allSec: {
          timestamp: "14-Aug-2026 11:53:54",
          data: [
            { symbol: "ZERO", ltp: 10, prev_price: 0, perChange: 5 },
            { symbol: "NOPREV", ltp: 10, perChange: 5 },
            { ltp: 10, prev_price: 9, perChange: 5 }, // no symbol at all
            { symbol: "GOOD", ltp: 10, prev_price: 9, perChange: 11.11 },
          ],
        },
      },
      "GAINERS",
    );
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["GOOD"],
    );
    assert.equal(out.skipped, 3);
    // rank is assigned over ACCEPTED rows, so it stays dense.
    assert.equal(out.rows[0]!.rank, 1);
  });
});

describe("parseNseAllIndices — real payload", () => {
  const out = parseNseAllIndices(ALL_INDICES);

  it("parses every index record in the fixture", () => {
    assert.equal(out.rejected, null);
    assert.equal(out.rows.length, 8);
    assert.equal(out.skipped, 0);
  });

  it("uses the payload's own minute-precision timestamp", () => {
    assert.equal(out.snapshotAt?.toISOString(), "2026-08-14T06:26:00.000Z");
    for (const r of out.rows) {
      assert.equal(r.date.toISOString(), "2026-08-14T00:00:00.000Z");
    }
  });

  it("reads NIFTY 50 with the right sign on a falling session", () => {
    const n = out.rows.find((r) => r.indexSymbol === "NIFTY 50")!;
    assert.equal(n.last, 24329.1);
    assert.equal(n.previousClose, 24395.85);
    assert.equal(n.pointsChange, -66.75);
    assert.equal(n.percentChange, -0.27);
  });

  it("TRAP: pe/pb/dy and advances/declines arrive as STRINGS", () => {
    const n = out.rows.find((r) => r.indexSymbol === "NIFTY 50")!;
    // In the raw payload these are "20.59", "2.98", "1.2", "14", "36", "0".
    assert.equal(n.pe, 20.59);
    assert.equal(n.pb, 2.98);
    assert.equal(n.dividendYield, 1.2);
    assert.equal(n.advances, 14);
    assert.equal(n.declines, 36);
    assert.equal(n.unchanged, 0);
    assert.equal(typeof n.pe, "number");
  });

  it('TRAP: the not-applicable sentinel for ratios is the STRING "0"', () => {
    // NOT "-", NOT null. INDIA VIX is served as pe:"0", pb:"0", dy:"0" — 19 of
    // the 139 live indices are. A volatility index has no P/E, and rendering
    // 0.00 asserts a valuation that does not exist.
    const rawVix = (
      ALL_INDICES as { data: Array<Record<string, unknown>> }
    ).data.find((r) => r.indexSymbol === "INDIA VIX")!;
    assert.equal(rawVix.pe, "0", "fixture must still carry the raw sentinel");

    const vix = out.rows.find((r) => r.indexSymbol === "INDIA VIX")!;
    assert.equal(vix.pe, null);
    assert.equal(vix.pb, null);
    assert.equal(vix.dividendYield, null);
    assert.ok(vix.last > 0, "but it still has a live level");
  });

  it("REGRESSION: a legitimate 0 in the BREADTH counters survives", () => {
    // The sentinel rule is field-specific. NIFTY 50 has unchanged:"0", which
    // genuinely means no constituent was flat — collapsing that to null would
    // lose real breadth, so parseIndexRatio must NOT be applied here.
    const n = out.rows.find((r) => r.indexSymbol === "NIFTY 50")!;
    assert.equal(n.unchanged, 0);
    assert.notEqual(n.unchanged, null);
  });

  it("TRAP: index rows are RAGGED — INDIA VIX omits the breadth keys entirely", () => {
    // Not present-and-zero: the `advances`/`declines`/`unchanged` keys are
    // absent from that record, so a reader indexing them blindly gets
    // undefined rather than a number.
    const rawVix = (
      ALL_INDICES as { data: Array<Record<string, unknown>> }
    ).data.find((r) => r.indexSymbol === "INDIA VIX")!;
    assert.equal("advances" in rawVix, false);

    const vix = out.rows.find((r) => r.indexSymbol === "INDIA VIX")!;
    assert.equal(vix.advances, null);
    assert.equal(vix.declines, null);
    assert.equal(vix.unchanged, null);
  });

  it("exposes whole-market breadth from the payload's TOP level", () => {
    // Per-index advances/declines count that index's constituents; the
    // top-level trio counts the whole market. Conflating them understates
    // breadth by orders of magnitude.
    assert.deepEqual(out.breadth, {
      advances: 3306,
      declines: 6174,
      unchanged: 93,
    });
    const n = out.rows.find((r) => r.indexSymbol === "NIFTY 50")!;
    assert.equal(n.advances, 14);
    assert.notEqual(n.advances, out.breadth!.advances);
  });

  it("rejects a payload with no timestamp rather than stamping now", () => {
    const out2 = parseNseAllIndices({ data: [{ indexSymbol: "X", last: 1 }] });
    assert.equal(out2.rows.length, 0);
    assert.ok(out2.rejected);
    assert.equal(out2.snapshotAt, null);
  });

  it("rejects non-object and data-less payloads", () => {
    for (const bad of [null, undefined, [], "x", 1, {}]) {
      const r = parseNseAllIndices(bad);
      assert.equal(r.rows.length, 0);
      assert.ok(r.rejected, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("shouldWriteSnapshot — the no-change detector", () => {
  const t = (iso: string) => new Date(iso);

  it("writes when nothing is stored yet", () => {
    assert.equal(shouldWriteSnapshot(t("2026-08-14T06:24:57Z"), null), true);
  });

  it("writes when the exchange's snapshot has ADVANCED", () => {
    assert.equal(
      shouldWriteSnapshot(t("2026-08-14T06:27:57Z"), t("2026-08-14T06:24:57Z")),
      true,
    );
  });

  it("REGRESSION: SKIPS an identical snapshot", () => {
    // Rewriting identical rows refreshes updatedAt and hands readers a row
    // that looks freshly confirmed while describing an older session — a
    // smaller version of the exact bug this feature exists to end.
    assert.equal(
      shouldWriteSnapshot(t("2026-08-14T06:24:57Z"), t("2026-08-14T06:24:57Z")),
      false,
    );
  });

  it("REGRESSION: SKIPS a snapshot that went BACKWARDS", () => {
    // Akamai can serve a slightly older cached body than the one just seen,
    // so "not equal" is not the test — only strictly newer may be written.
    assert.equal(
      shouldWriteSnapshot(t("2026-08-14T06:21:57Z"), t("2026-08-14T06:24:57Z")),
      false,
    );
  });
});

describe("dedupeMoversByCompany — dual listings", () => {
  function row(over: Partial<MarketMoverRow>): MarketMoverRow {
    return {
      snapshotAt: new Date("2026-08-14T06:24:57Z"),
      date: new Date("2026-08-14T00:00:00Z"),
      exchange: "NSE",
      direction: "GAINERS",
      bucket: "allSec",
      symbol: "ACME",
      series: "EQ",
      rank: 1,
      open: 100,
      high: 110,
      low: 99,
      ltp: 110,
      prevClose: 100,
      percentChange: 10,
      adjPercentChange: 10,
      rupeeChange: 10,
      tradedQty: 1000,
      turnover: 1,
      caExDate: null,
      caPurpose: null,
      source: "NSE_LIVE_VARIATIONS",
      ...over,
    };
  }

  it("collapses the same company listed on both exchanges via ISIN", () => {
    const isin = new Map([
      ["NSE:ACME", "INE001A01001"],
      ["BSE:ACMELTD", "INE001A01001"],
    ]);
    const out = dedupeMoversByCompany(
      [
        row({ exchange: "NSE", symbol: "ACME", percentChange: 10 }),
        row({ exchange: "BSE", symbol: "ACMELTD", percentChange: 9.4 }),
      ],
      isin,
    );
    assert.equal(out.length, 1);
    // The venue that printed the bigger absolute move wins — the thinner
    // listing routinely shows a stale or wider print.
    assert.equal(out[0]!.exchange, "NSE");
  });

  it("keeps genuinely different companies apart", () => {
    const isin = new Map([
      ["NSE:ACME", "INE001A01001"],
      ["NSE:OTHER", "INE002A01002"],
    ]);
    const out = dedupeMoversByCompany(
      [row({ symbol: "ACME" }), row({ symbol: "OTHER" })],
      isin,
    );
    assert.equal(out.length, 2);
  });

  it("falls back to exchange:symbol when the ISIN is unknown", () => {
    // NSE's movers payload carries NO isin field, so an unresolved row must
    // still be emitted rather than silently merged with an unrelated one.
    const out = dedupeMoversByCompany(
      [
        row({ exchange: "NSE", symbol: "ACME" }),
        row({ exchange: "BSE", symbol: "ACMELTD" }),
      ],
      new Map(),
    );
    assert.equal(out.length, 2);
  });

  it("picks deterministically on an exact tie", () => {
    const isin = new Map([
      ["NSE:ACME", "INE001A01001"],
      ["BSE:ACMELTD", "INE001A01001"],
    ]);
    const a = dedupeMoversByCompany(
      [
        row({ exchange: "NSE", symbol: "ACME", percentChange: 10 }),
        row({ exchange: "BSE", symbol: "ACMELTD", percentChange: 10 }),
      ],
      isin,
    );
    const b = dedupeMoversByCompany(
      [
        row({ exchange: "BSE", symbol: "ACMELTD", percentChange: 10 }),
        row({ exchange: "NSE", symbol: "ACME", percentChange: 10 }),
      ],
      isin,
    );
    assert.equal(a[0]!.exchange, b[0]!.exchange);
    assert.equal(a[0]!.exchange, "BSE"); // "BSE" < "NSE"
  });

  it("compares ABSOLUTE moves so a big faller beats a small riser", () => {
    const isin = new Map([
      ["NSE:ACME", "INE001A01001"],
      ["BSE:ACMELTD", "INE001A01001"],
    ]);
    const out = dedupeMoversByCompany(
      [
        row({ exchange: "NSE", symbol: "ACME", percentChange: 1 }),
        row({
          exchange: "BSE",
          symbol: "ACMELTD",
          percentChange: -8,
          direction: "LOSERS",
        }),
      ],
      isin,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.exchange, "BSE");
  });
});

/**
 * The polling gate — MONEY-1200.
 *
 * The job originally gated on `getNseMarketStatus().isLive`, justified by
 * "outside the session the data cannot change, so a poll is pure risk for no
 * information". The second half was FALSE and was measured false: probed at
 * 16:26 IST on 2026-08-14 — 56 minutes after the close — the gainers payload
 * carried `timestamp "14-Aug-2026 16:00:00"` with real closing prices, and
 * /api/allIndices carried the 15:30 close across 139 indices.
 *
 * The cost of that belief was not abstract. The scheduler went live after 15:30
 * that day, every fire logged POST_CLOSE, and both tables sat EMPTY across a
 * full weekend — while the job existed specifically to stop a panel showing a
 * stale session.
 *
 * These tests pin the window on both edges. The closing snapshot is the most
 * valuable one the job can hold, and the phases with no session behind them
 * must still cost zero requests.
 */
describe("shouldPollMovers — capture the close whenever we lack it (MONEY-1200)", () => {
  /**
   * A UTC instant for a given IST wall-clock time on a weekday (Fri 2026-08-14,
   * the day the defect was observed).
   *
   * Written as total-minutes arithmetic rather than per-field, because the naive
   * `h - 5, m - 30` form silently produces the WRONG hour whenever the minutes
   * need to borrow — which is every time before :30.
   */
  const istAt = (h: number, m: number) => {
    const utcMinutes = h * 60 + m - (5 * 60 + 30);
    return new Date(
      Date.UTC(2026, 7, 14, Math.floor(utcMinutes / 60), utcMinutes % 60),
    );
  };

  it("polls during the open session", () => {
    const d = shouldPollMovers({ phase: "OPEN", isLive: true }, istAt(11, 47));
    assert.equal(d.poll, true);
    assert.equal(d.reason, "OPEN");
  });

  it("REGRESSION: polls just after the close", () => {
    // The first wrong model gated on `isLive` and skipped this entirely, even
    // though NSE stamped the payload 16:00 — thirty minutes past the bell.
    const d = shouldPollMovers(
      { phase: "POST_CLOSE", isLive: false },
      istAt(16, 0),
    );
    assert.equal(d.poll, true);
  });

  it("REGRESSION: still polls HOURS after the close", () => {
    // The second wrong model was a 60-minute settle window. Measured at 17:41 —
    // over two hours out — NSE returned BYTE-IDENTICAL bytes, still stamped
    // 16:00. The payload is frozen at the close and served until the next
    // session, so there is no window to miss; a time bound only manufactures a
    // way to capture nothing.
    for (const [h, m] of [
      [17, 41],
      [20, 0],
      [23, 59],
    ] as const) {
      const d = shouldPollMovers(
        { phase: "POST_CLOSE", isLive: false },
        istAt(h, m),
      );
      assert.equal(d.poll, true, `must still poll at ${h}:${m} IST`);
    }
  });

  it("REGRESSION: polls PRE_OPEN — that is the catch-up for a missed close", () => {
    // NSE serves the PREVIOUS session's close before the open, so the morning
    // poll recovers a close we failed to capture. Refusing it is what would
    // leave a Friday close unrecoverable after a weekend.
    const d = shouldPollMovers(
      { phase: "PRE_OPEN", isLive: false },
      istAt(9, 0),
    );
    assert.equal(d.poll, true);
    assert.equal(d.reason, "PRE_OPEN");
  });

  it("makes ZERO requests on a weekend or holiday", () => {
    // The only phases where a poll cannot inform us: we have had every prior
    // opportunity to capture what NSE is serving, and no new session has begun.
    for (const phase of ["WEEKEND", "HOLIDAY"]) {
      const d = shouldPollMovers({ phase, isLive: false }, istAt(16, 0));
      assert.equal(d.poll, false, `${phase} must not poll`);
      assert.equal(d.reason, phase);
    }
  });

  it("the write brake, not the clock, is what prevents redundant work", () => {
    // Polling widely is only safe because shouldWriteSnapshot refuses a
    // non-advancing timestamp. Pinned here so the two are never decoupled: if
    // this ever returns true for an equal timestamp, the wide gate becomes a
    // rewrite-every-poll bug.
    const t = new Date("2026-08-14T10:30:00Z");
    assert.equal(shouldWriteSnapshot(t, null), true, "first capture writes");
    assert.equal(
      shouldWriteSnapshot(t, t),
      false,
      "same snapshot never rewrites",
    );
    assert.equal(
      shouldWriteSnapshot(new Date(t.getTime() - 1000), t),
      false,
      "a BACKWARDS stamp never rewrites — Akamai can serve a staler cached body",
    );
  });
});
