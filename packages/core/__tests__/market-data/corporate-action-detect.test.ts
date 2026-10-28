/**
 * UNIT TEST — price-derived corporate-action detection (MONEY-1176).
 *
 * The fixtures are the REAL prod gaps measured during MONEY-1175. The detector
 * must find every one of them from raw closes alone, because NSE's API stops
 * serving corporate actions around 2020 while `DailyPrice` reaches 1994.
 *
 * The other half matters just as much: `YESBANK 2020 collapse` and
 * `TMPV demerger` are cases it must NOT claim. A missed split leaves a visible
 * cliff; a FALSE split silently rescales an entire price history.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  snapRatio,
  detectActions,
  reconcileCandidates,
  SNAP_TOLERANCE,
  MIN_PRICE,
  MAX_ACTIONS_PER_INSTRUMENT,
  MAX_CLIFF_GAP_DAYS,
  verifyCliff,
  type DetectBar,
} from "../../src/market-data/corporate-action-detect";

const D = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** Two adjacent days: the close before, and the close on the ex-date. */
const pair = (
  prevIso: string,
  prevClose: number,
  exIso: string,
  exClose: number,
  prevVol = 1000,
  exVol = 1000,
): DetectBar[] => [
  { date: D(prevIso), close: prevClose, volume: prevVol },
  { date: D(exIso), close: exClose, volume: exVol },
];

describe("snapRatio", () => {
  it("snaps the real prod ratios to their exact rationals", () => {
    // Measured gaps: 1/0.489 = 2.045, 1/0.102 = 9.80, 1/0.201 = 4.98,
    // 1/0.010 = 100.
    assert.equal(snapRatio(1 / 0.489), 2, "INFY 1:1 bonus");
    assert.equal(snapRatio(1 / 0.102), 10, "SBIN 1:10 split");
    assert.equal(snapRatio(1 / 0.201), 5, "YESBANK 1:5 split");
    assert.equal(snapRatio(1 / 0.01), 100, "GOLDBEES 1:100 split");
  });

  it("refuses a move that is not arithmetic", () => {
    // A crash lands on an arbitrary number; a split cannot.
    assert.equal(snapRatio(1.37), null);
    assert.equal(snapRatio(7.3), null);
    assert.equal(snapRatio(2.6), null);
  });

  it("refuses RELIANCE's 2006 demerger factor", () => {
    // 1/0.634 = 1.577. A demerger is NOT a clean rational — the parent falls
    // by whatever the market valued the spun-off piece at — so it must not be
    // mistaken for a 1:2 bonus (1.5).
    assert.equal(snapRatio(1 / 0.634), null);
  });

  it("rejects nonsense input instead of throwing", () => {
    for (const bad of [0, -2, NaN, Infinity]) {
      assert.equal(snapRatio(bad), null, `${bad}`);
    }
  });

  it("honours the stated tolerance at its edge", () => {
    assert.equal(snapRatio(10 * (1 + SNAP_TOLERANCE * 0.9)), 10);
    assert.equal(snapRatio(10 * (1 + SNAP_TOLERANCE * 3)), null);
  });
});

describe("detectActions — the real prod events", () => {
  const cases: Array<[string, DetectBar[], number]> = [
    [
      "INFY 1:1 bonus 2014-12-02",
      pair("2014-12-01", 4349.85, "2014-12-02", 2126.6),
      2,
    ],
    [
      "SBIN 1:10 split 2014-11-20",
      pair("2014-11-19", 2910.5, "2014-11-20", 297.1),
      10,
    ],
    [
      "YESBANK 1:5 split 2017-09-21",
      pair("2017-09-20", 1880.1, "2017-09-21", 377.05),
      5,
    ],
    [
      "GOLDBEES 1:100 2019-12-19",
      pair("2019-12-18", 3359.6, "2019-12-19", 33.55),
      100,
    ],
    [
      "NIFTYBEES 1:10 2019-12-19",
      pair("2019-12-18", 1292.54, "2019-12-19", 130.2),
      10,
    ],
    [
      "ITC 1:1 bonus 2010-08-03",
      pair("2010-08-02", 312.8, "2010-08-03", 154.4),
      2,
    ],
  ];

  for (const [name, bars, expected] of cases) {
    it(`finds ${name}`, () => {
      const out = detectActions(bars);
      assert.equal(out.length, 1, "exactly one candidate");
      assert.equal(out[0]!.snappedRatio, expected);
      assert.equal(out[0]!.exDate.getTime(), bars[1]!.date.getTime());
    });
  }
});

describe("detectActions — what it must NOT claim", () => {
  it("ignores a genuine crash that is not a clean ratio", () => {
    // A 40% single-day collapse is real trading, not arithmetic.
    const out = detectActions(pair("2020-03-22", 100, "2020-03-23", 60));
    assert.equal(out.length, 0);
  });

  it("ignores a demerger, whose factor is not rational", () => {
    // TMPV 2025-10-14 x0.598. Writing this as a SPLIT would rescale the whole
    // pre-demerger history by a made-up factor.
    const out = detectActions(pair("2025-10-13", 660.75, "2025-10-14", 395.45));
    assert.equal(out.length, 0);
  });

  it("ignores ordinary daily moves below the jump floor", () => {
    const out = detectActions(pair("2020-01-01", 100, "2020-01-02", 90));
    assert.equal(out.length, 0);
  });

  it("skips non-positive closes rather than producing Infinity", () => {
    const out = detectActions([
      { date: D("2020-01-01"), close: 0, volume: 10 },
      { date: D("2020-01-02"), close: 100, volume: 10 },
    ]);
    assert.equal(out.length, 0);
  });

  it("finds nothing in a quiet series", () => {
    const bars: DetectBar[] = Array.from({ length: 40 }, (_, i) => ({
      date: D(`2020-01-${String((i % 28) + 1).padStart(2, "0")}`),
      close: 100 + (i % 5),
      volume: 1000,
    }));
    assert.deepEqual(detectActions(bars), []);
  });
});

describe("detectActions — volume corroboration", () => {
  it("scores HIGH when volume rises by about the factor", () => {
    // Same turnover over 10x the shares.
    const bars: DetectBar[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        date: D(`2014-11-${String(12 + i).padStart(2, "0")}`),
        close: 2910,
        volume: 1000,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        date: D(`2014-11-${String(20 + i).padStart(2, "0")}`),
        close: 291,
        volume: 10_000,
      })),
    ];
    const out = detectActions(bars);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.confidence, "high");
  });

  it("still REPORTS a split when volume does not corroborate", () => {
    // Illiquid names have noisy volume. Volume is a score, never a gate —
    // gating on it would discard real splits in exactly the thin names where
    // a mis-scaled chart is least likely to be noticed.
    const out = detectActions(
      pair("2014-11-19", 2910.5, "2014-11-20", 297.1, 1000, 900),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.confidence, "low");
  });

  it("carries the raw closes for the audit trail", () => {
    const out = detectActions(pair("2014-11-19", 2910.5, "2014-11-20", 297.1));
    assert.equal(out[0]!.prevClose, 2910.5);
    assert.equal(out[0]!.exClose, 297.1);
    assert.ok(Math.abs(out[0]!.observedRatio - 9.796) < 0.01);
  });
});

describe("reconcileCandidates", () => {
  const candidate = detectActions(
    pair("2014-11-19", 2910.5, "2014-11-20", 297.1),
  );

  it("drops a candidate the feeds already explain", () => {
    // A feed row knows the real TYPE and ratio; a derived row only knows the
    // factor. Where both describe one event, the feed wins.
    const { fresh, alreadyKnown } = reconcileCandidates(candidate, [
      { type: "SPLIT", exDate: D("2014-11-20") },
    ]);
    assert.equal(fresh.length, 0);
    assert.equal(alreadyKnown, 1);
  });

  it("tolerates a small date discrepancy between feed and price", () => {
    // Exchanges report the ex-date a day either side surprisingly often.
    const { fresh } = reconcileCandidates(candidate, [
      { type: "SPLIT", exDate: D("2014-11-22") },
    ]);
    assert.equal(fresh.length, 0);
  });

  it("keeps a candidate no feed covers — the whole point", () => {
    const { fresh, alreadyKnown } = reconcileCandidates(candidate, [
      { type: "SPLIT", exDate: D("2010-01-01") },
    ]);
    assert.equal(fresh.length, 1);
    assert.equal(alreadyKnown, 0);
  });

  it("keeps everything when there are no known actions at all", () => {
    assert.equal(reconcileCandidates(candidate, []).fresh.length, 1);
  });
});

describe("detectActions — penny-stock guards (found by the first prod run)", () => {
  it("declines sub-rupee prices, where a clean ratio is tick arithmetic", () => {
    // 21STCENMGM produced SEVEN "splits" in three years between Rs 0.05 and
    // Rs 4.65. 0.30 and 0.15 are 6 and 3 ticks, so their ratio is EXACTLY 2 by
    // accident — and a 50% day is ordinary volatility for a penny stock.
    assert.deepEqual(
      detectActions(pair("1998-11-09", 0.3, "1998-11-10", 0.15)),
      [],
    );
    assert.deepEqual(
      detectActions(pair("1998-12-03", 0.1, "1998-12-04", 0.05)),
      [],
    );
  });

  it("declines anything below the price floor, however clean the ratio", () => {
    const justUnder = MIN_PRICE - 0.05;
    assert.deepEqual(
      detectActions(
        pair("2020-01-01", justUnder, "2020-01-02", justUnder / 10),
      ),
      [],
    );
  });

  it("still accepts a real split at or above the floor", () => {
    // The floor must not cost us genuine events; every ground-truth fixture
    // above sits far above it.
    const out = detectActions(
      pair("2020-01-01", MIN_PRICE, "2020-01-02", MIN_PRICE / 10),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.snappedRatio, 10);
  });

  it("discards ALL of an instrument's candidates when the count is implausible", () => {
    // ANTGRAPHIC yielded 28 and BLUECHIP 15. That is not a company with 28
    // splits, it is a series whose behaviour defeats the detector — so the
    // individual candidates cannot be trusted either.
    const bars: DetectBar[] = [];
    let price = 1_000_000;
    for (let i = 0; i < MAX_ACTIONS_PER_INSTRUMENT + 3; i++) {
      bars.push({
        date: D(`2010-0${(i % 9) + 1}-01`),
        close: price,
        volume: 1000,
      });
      price /= 2;
      bars.push({
        date: D(`2010-0${(i % 9) + 1}-02`),
        close: price,
        volume: 1000,
      });
    }
    assert.deepEqual(detectActions(bars), []);
  });

  it("keeps a plausible number of real actions", () => {
    // Three 1:1 bonuses, INFY's actual history. Must survive the cap.
    const bars: DetectBar[] = [];
    let price = 8000;
    for (let i = 0; i < 3; i++) {
      bars.push({ date: D(`201${4 + i}-06-01`), close: price, volume: 1000 });
      price /= 2;
      bars.push({ date: D(`201${4 + i}-06-02`), close: price, volume: 1000 });
    }
    assert.equal(detectActions(bars).length, 3);
  });

  it("the guards are overridable for deliberate investigation", () => {
    const out = detectActions(pair("1998-11-09", 0.3, "1998-11-10", 0.15), {
      minPrice: 0,
    });
    assert.equal(out.length, 1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1600 — a cliff is a ONE-DAY move. Real prod closes, 2026-09-23.
   ──────────────────────────────────────────────────────────────────────── */

const bar = (iso: string, close: number): DetectBar => ({
  date: D(iso),
  close,
  volume: 1000,
});

describe("detectActions — never reads a cliff across a trading gap (MONEY-1600)", () => {
  it("SAYAJIHOTL:NSE: 2015 -> 2026 is eleven years of drift, not a 1:2 consolidation", () => {
    // NSE stopped printing SAYAJIHOTL on 2015-01-16 and printed it again on
    // 2026-04-22. The detector wrote CAPITAL_ADJUSTMENT 0.5 from these two
    // closes, and every chart that admits the row doubled its history.
    const bars = [bar("2015-01-16", 138.7), bar("2026-04-22", 276)];
    assert.deepEqual(detectActions(bars), []);
    // The gap is the ONLY thing refusing it: widen the guard and it comes back.
    assert.equal(
      detectActions(bars, { maxGapDays: Infinity })[0]?.snappedRatio,
      0.5,
    );
  });

  it("VEGA:BSE: a 12-day halt across the record date is still a cliff (feed files BONUS 5)", () => {
    const out = detectActions([
      bar("2026-04-16", 312.25),
      bar("2026-04-28", 61.95),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.snappedRatio, 5);
  });

  it("the gap rule never turns a series the COUNT guard refuses into one it accepts", () => {
    // Seven clean 1:2 moves, one of them across a 40-day gap. Before the gap
    // rule the series yielded 7 > MAX_ACTIONS_PER_INSTRUMENT and was thrown
    // out whole; the gap filter must not quietly leave 6 to be written.
    const bars: DetectBar[] = [];
    let price = 1_000_000;
    let t = D("2010-01-01").getTime();
    for (let i = 0; i < MAX_ACTIONS_PER_INSTRUMENT + 1; i++) {
      bars.push({ date: new Date(t), close: price, volume: 1000 });
      t += (i === 0 ? 40 : 1) * 86_400_000;
      price /= 2;
      bars.push({ date: new Date(t), close: price, volume: 1000 });
      t += 30 * 86_400_000;
    }
    assert.deepEqual(detectActions(bars), []);
    // And the gap is what removes one: with the count guard lifted, six remain.
    assert.equal(detectActions(bars, { maxActions: Infinity }).length, 6);
  });

  it("the boundary: a gap of exactly MAX_CLIFF_GAP_DAYS is read, one day more is not", () => {
    const at = (days: number) =>
      detectActions([
        bar("2020-01-01", 200),
        {
          date: new Date(D("2020-01-01").getTime() + days * 86_400_000),
          close: 100,
          volume: 1000,
        },
      ]).length;
    assert.equal(at(MAX_CLIFF_GAP_DAYS), 1);
    assert.equal(at(MAX_CLIFF_GAP_DAYS + 1), 0);
  });
});

describe("verifyCliff — what a listing's own series says about a DERIVED row (MONEY-1600)", () => {
  it("CONFIRMED: ZEEL:BSE 2024-01-23 still divides to 1.5 across a 4-day gap", () => {
    const v = verifyCliff(
      { before: bar("2024-01-19", 235.5), onDay: bar("2024-01-23", 155.9) },
      1.5,
    );
    assert.equal(v.verdict, "CONFIRMED");
    assert.equal(v.gapDays, 4);
  });

  it("GAP: SAYAJIHOTL:NSE — the close before its day is 4,114 days earlier", () => {
    const v = verifyCliff(
      { before: bar("2015-01-16", 138.7), onDay: bar("2026-04-22", 276) },
      0.5,
    );
    assert.equal(v.verdict, "GAP");
    assert.equal(v.gapDays, 4114);
  });

  it("NO_BAR_BEFORE: no earlier close at all is ABSENCE, not a gap — never retires", () => {
    // A truncated series, or history held under another instrumentId. GAP
    // needs a REAL earlier close more than MAX_CLIFF_GAP_DAYS back.
    assert.equal(
      verifyCliff({ before: null, onDay: bar("2026-04-22", 276) }, 0.5).verdict,
      "NO_BAR_BEFORE",
    );
  });

  it("REFUTED: both closes in reach, and the move is not the row's ratio", () => {
    // SAYAJIHOTL:BSE's own print that day, 286.40 -> 278.80: flat.
    const v = verifyCliff(
      { before: bar("2026-04-21", 286.4), onDay: bar("2026-04-22", 278.8) },
      0.5,
    );
    assert.equal(v.verdict, "REFUTED");
  });

  it("the ratio test is the detector's own SNAP_TOLERANCE, at its edge", () => {
    const at = (observed: number) =>
      verifyCliff(
        {
          before: bar("2020-01-01", observed * 100),
          onDay: bar("2020-01-02", 100),
        },
        2,
      ).verdict;
    assert.equal(at(2 * (1 + SNAP_TOLERANCE) - 1e-9), "CONFIRMED");
    assert.equal(at(2 * (1 + SNAP_TOLERANCE) + 1e-6), "REFUTED");
  });

  it("NO_BAR_ON_DAY: a series with no close on the row's day says nothing — never retires", () => {
    // The ZEEL:NSE / DOLPHIN:NSE shape seen from the other side: an absent
    // series must not read as a refuted one.
    assert.equal(
      verifyCliff({ before: bar("2024-01-19", 235.5), onDay: null }, 1.5)
        .verdict,
      "NO_BAR_ON_DAY",
    );
    assert.equal(
      verifyCliff({ before: null, onDay: null }, 1.5).verdict,
      "NO_BAR_ON_DAY",
    );
  });
});
