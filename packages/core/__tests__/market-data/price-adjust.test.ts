/**
 * UNIT TEST — corporate-action back-adjustment (MONEY-1176).
 *
 * Ratios here are REAL, measured off prod during MONEY-1175 by reading the
 * one-day price gaps in the raw exchange series:
 *
 *   INFY   2014-12-02  x0.489   1:1 bonus       -> factor 2
 *   SBIN   2014-11-20  x0.102   1:10 split      -> factor 10
 *   GOLDBEES 2019-12-19 x0.010  1:100 split     -> factor 100
 *   RELIANCE 2006 demerger      x0.634          -> factor 1/0.634 = 1.577
 *
 * The demerger is the case that stops this being arithmetic: 0.634 is not a
 * tidy fraction, so nothing but the OBSERVED gap can produce a correct factor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  actionFactor,
  dedupeActions,
  buildAdjustmentTimeline,
  factorForDate,
  applyAdjustment,
  adjustingActionsWhere,
  isinIssuer,
  loadAdjustingActions,
  refuseForeignIssuers,
  SAME_EVENT_DAYS,
  type AdjustingAction,
  type AdjustingActionDb,
  type IssuerCandidate,
  type LoadedAdjustingAction,
  type RawBar,
} from "../../src/market-data/price-adjust";

const D = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

const action = (
  type: string,
  iso: string,
  ratio: number | null = null,
  source: string | null = "NSE",
  details?: unknown,
): AdjustingAction => ({ type, exDate: D(iso), ratio, source, details });

const bar = (iso: string, close: number, volume = 1000): RawBar => ({
  date: D(iso),
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe("actionFactor", () => {
  it("uses the exact rational for a split or bonus", () => {
    assert.equal(actionFactor(action("BONUS", "2014-12-02", 2)), 2);
    assert.equal(actionFactor(action("SPLIT", "2014-11-20", 10)), 10);
    assert.equal(actionFactor(action("SPLIT", "2019-12-19", 100)), 100);
  });

  it("prefers the OBSERVED gap for a demerger — no tidy fraction exists", () => {
    // RELIANCE 2006: the parent fell by whatever the market valued the
    // spun-off ADAG companies at. 1/0.634 = 1.577, which is not 2/3 or 3/2.
    const a = action("DEMERGER", "2006-01-01", 1.5, "NSE", {
      observedRatio: 1.577,
    });
    assert.equal(actionFactor(a), 1.577);
  });

  it("falls back to `ratio` for a demerger with no observation", () => {
    assert.equal(actionFactor(action("DEMERGER", "2006-01-01", 1.5)), 1.5);
  });

  it("falls back to the observed value when a split's ratio is unusable", () => {
    const a = action("SPLIT", "2020-01-01", null, "NSE", { observedRatio: 5 });
    assert.equal(actionFactor(a), 5);
  });

  it("rejects factors that would destroy or no-op the series", () => {
    // 0 would produce Infinity; a negative flips the chart; 1 is a no-op that
    // should be counted as ignored rather than silently applied.
    for (const bad of [0, -2, 1, NaN, Infinity, null]) {
      assert.equal(
        actionFactor(action("SPLIT", "2020-01-01", bad)),
        null,
        `${bad}`,
      );
    }
  });
});

describe("dedupeActions", () => {
  it("collapses the same split reported by NSE, BSE and the detector", () => {
    // Applying all three would divide the history by 10^3.
    const out = dedupeActions([
      action("SPLIT", "2014-11-20", 10, "NSE"),
      action("SPLIT", "2014-11-21", 10, "BSE"),
      action("CAPITAL_ADJUSTMENT", "2014-11-19", 10, "DERIVED"),
    ]);
    assert.equal(out.length, 1);
  });

  it("keeps the highest-authority record of a collapsed event", () => {
    const out = dedupeActions([
      action("CAPITAL_ADJUSTMENT", "2014-11-20", 10, "DERIVED"),
      action("SPLIT", "2014-11-20", 10, "NSE_HIST"),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.source, "NSE_HIST");
    assert.equal(out[0]!.type, "SPLIT");
  });

  it("ranks a `+`-joined composite source by its STRONGEST tag", () => {
    // MONEY-1527 review. `mergeCorporateActions` writes `source` as a sorted
    // `+`-joined UNION when two feeds describe one event — prod holds
    // `NSE+SCREENER`. A whole-string lookup in SOURCE_RANK misses every
    // composite and falls to the unknown default of 20, BELOW a bare SCREENER
    // at 50, so the MORE corroborated row lost. `dedupeActions` uses the rank
    // as its only tiebreak, so the loser's ratio simply vanished and the chart
    // divided the pre-split history by the wrong multiple.
    const out = dedupeActions([
      action("SPLIT", "2014-11-20", 10, "SCREENER"),
      action("SPLIT", "2014-11-20", 10, "NSE+SCREENER"),
    ]);
    assert.equal(out.length, 1);
    assert.equal(
      out[0]!.source,
      "NSE+SCREENER",
      "a union of witnesses is at least as good as its best member",
    );

    // And a composite must not OUTRANK its own strongest tag.
    const tie = dedupeActions([
      action("SPLIT", "2014-11-20", 10, "NSE_HIST"),
      action("SPLIT", "2014-11-20", 10, "NSE+SCREENER"),
    ]);
    assert.equal(tie.length, 1);
    assert.equal(tie[0]!.source, "NSE_HIST", "NSE_HIST (100) beats NSE (90)");
  });

  it("does NOT collapse two nearby events with different factors", () => {
    // A bonus and a split days apart is rare but real; treating them as one
    // would silently drop a factor from the whole series.
    const out = dedupeActions([
      action("BONUS", "2015-06-15", 2, "NSE"),
      action("SPLIT", "2015-06-16", 5, "NSE"),
    ]);
    assert.equal(out.length, 2);
  });

  it("does not collapse events beyond the same-event window", () => {
    const out = dedupeActions([
      action("SPLIT", "2015-06-01", 2),
      action(
        "SPLIT",
        `2015-06-${String(1 + SAME_EVENT_DAYS + 2).padStart(2, "0")}`,
        2,
      ),
    ]);
    assert.equal(out.length, 2);
  });

  it("drops rows with an unusable date instead of throwing", () => {
    const bad: AdjustingAction = {
      type: "SPLIT",
      exDate: new Date("nonsense"),
      ratio: 2,
    };
    assert.deepEqual(dedupeActions([bad]), []);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1537 — REAL prod rows, copied from `corporate_actions` 2026-09-23.
   A feed row is stamped 18:30Z (IST midnight of the ex-date), the detector's
   00:00Z of the same IST day, which is how the store holds them.
   ──────────────────────────────────────────────────────────────────────── */

const at = (
  type: string,
  iso: string,
  ratio: number | null,
  source: string,
  details?: unknown,
): AdjustingAction => ({ type, exDate: new Date(iso), ratio, source, details });

describe("a detected cliff and the feed's filing of it are ONE event — MONEY-1537", () => {
  // SBIN's 1:10 split. BSE filed ratio 10; NSE filed the SPLIT with no ratio;
  // the detector saw a 9.796x cliff and snapped it to 10. On the live chart
  // every SBIN bar before 2014-11-20 was divided by 97.96 — the two witnesses
  // differ by 2.04% on the OBSERVED gap, past nearlyEqual's 2%.
  const bse = at("SPLIT", "2014-11-19T18:30:00.000Z", 10, "BSE");
  const nse = at("SPLIT", "2014-11-19T18:30:00.000Z", null, "NSE");
  const detected = at(
    "CAPITAL_ADJUSTMENT",
    "2014-11-20T00:00:00.000Z",
    10,
    "DERIVED",
    { observedRatio: 9.796364860316391 },
  );
  const before = new Date("2014-11-18T00:00:00.000Z");

  it("SBIN 2014 divides by 10, not 97.96 — in EITHER order the store returns ties", () => {
    // The two 18:30Z rows tie on exDate and the store orders ties however it
    // likes. With the NULL-ratio row between the filing and the detector, a
    // filed-ratio match inside the chain still missed — which is why the twin
    // rule is an EXISTS over every row.
    for (const rows of [
      [bse, nse, detected],
      [nse, bse, detected],
    ]) {
      const { steps } = buildAdjustmentTimeline(rows);
      assert.equal(
        factorForDate(steps, before),
        10,
        `order ${rows.map((r) => r.source).join(",")}`,
      );
      assert.ok(
        !dedupeActions(rows).includes(detected),
        "the detector's row survived beside the filing it describes",
      );
    }
  });

  it("the twin is recognised by its FILED ratio — its observed gap is not identity", () => {
    // The same pair, both sources' ratios equal, the observation 2.96% off:
    // MOTHERSON 2013's BONUS 1.5 beside a detected 1.4555. Still one event.
    const { steps } = buildAdjustmentTimeline([
      at("BONUS", "2013-12-19T18:30:00.000Z", 1.5, "NSE"),
      at("CAPITAL_ADJUSTMENT", "2013-12-20T00:00:00.000Z", 1.5, "DERIVED", {
        observedRatio: 1.455475180843103,
      }),
    ]);
    assert.equal(factorForDate(steps, new Date("2013-12-18T00:00:00Z")), 1.5);
  });

  it("a detector row beside a feed filing with NO ratio is the only witness, and applies", () => {
    // AIAENG 2008: NSE filed the SPLIT without a ratio, so nothing but the
    // detector can price the cliff. Matching twins on type plus proximity
    // would drop it and leave a 4.97x cliff unadjusted; the filed ratios
    // differ (NULL vs 5), so it is not a twin and its observed gap applies.
    const { steps } = buildAdjustmentTimeline([
      at("SPLIT", "2008-10-12T18:30:00.000Z", null, "NSE"),
      at("CAPITAL_ADJUSTMENT", "2008-10-13T00:00:00.000Z", 5, "DERIVED", {
        observedRatio: 4.971055327868853,
      }),
    ]);
    assert.equal(
      factorForDate(steps, new Date("2008-10-10T00:00:00Z")),
      4.971055327868853,
    );
  });

  it("a lone detector row still applies its observed gap", () => {
    assert.equal(
      factorForDate(buildAdjustmentTimeline([detected]).steps, before),
      9.796364860316391,
    );
  });
});

describe("a row with no factor never shields a duplicate — MONEY-1537", () => {
  it("AHLEAST 2022: the NSE and BSE bonus apply ONCE across the ratio-less demergers", () => {
    // All four rows at one instant, in the order the store returned them: a
    // DEMERGER with no ratio between the two exchanges' BONUS 1.5. Compared
    // with the LAST KEPT row, the second bonus met the demerger, not the first
    // bonus, and the chart divided by 2.25.
    const rows = [
      at("BONUS", "2022-10-05T18:30:00.000Z", 1.5, "BSE"),
      at("DEMERGER", "2022-10-05T18:30:00.000Z", null, "BSE"),
      at("BONUS", "2022-10-05T18:30:00.000Z", 1.5, "NSE"),
      at("DEMERGER", "2022-10-05T18:30:00.000Z", null, "NSE"),
    ];
    const { steps, used, ignored } = buildAdjustmentTimeline(rows);
    assert.equal(factorForDate(steps, new Date("2022-10-01T00:00:00Z")), 1.5);
    assert.equal(used, 1);
    // The demerger is COUNTED as unpriceable, not silently lost — once, as the
    // one event both exchanges filed, the way two such filings always counted.
    assert.equal(ignored, 1);
  });

  it("ABB: two filings of one UNPRICEABLE event still count once", () => {
    // The narrow half of the rule. A row with no factor is compared with the
    // last kept row as before; letting every such row through moved the
    // `ignored` count on 324 prod series whose prices never changed — ABB's
    // among them, 2 -> 3. Its 2007 split and its 2019 demerger (filed on BSE
    // and NSE) carry no ratio: two unpriceable EVENTS.
    const { used, ignored } = buildAdjustmentTimeline([
      at("SPLIT", "2007-06-27T18:30:00.000Z", null, "NSE"),
      at("DEMERGER", "2019-12-19T18:30:00.000Z", null, "BSE"),
      at("DEMERGER", "2019-12-19T18:30:00.000Z", null, "NSE"),
    ]);
    assert.equal(used, 0);
    assert.equal(ignored, 2);
  });
});

describe("a detection beside a COMPOSED or PARTIAL filing — MONEY-1541, real prod rows", () => {
  // The single-listing shapes are pinned against gold in
  // adjustment-sql-parity.test.ts. These are the CHART's rows, which span both
  // exchanges — so one event arrives filed by NSE and BSE at the same instant.

  it("SUDARSCHEM 2014: BSE's BONUS 2 + SPLIT 5 and NSE's SPLIT 5 beside a detected 10 divide by 10, not 102.88", () => {
    const rows = [
      at("SPLIT", "2014-09-29T18:30:00.000Z", 5, "NSE"),
      at("BONUS", "2014-09-29T18:30:00.000Z", 2, "BSE"),
      at("SPLIT", "2014-09-29T18:30:00.000Z", 5, "BSE"),
      at("CAPITAL_ADJUSTMENT", "2014-09-30T00:00:00.000Z", 10, "DERIVED", {
        observedRatio: 10.28832116788321,
      }),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const { steps } = buildAdjustmentTimeline(order);
      assert.equal(factorForDate(steps, D("2014-09-26")), 10);
    }
  });

  it("TORNTPHARM 2006: BSE's BONUS 2 beside NSE's own 4.07x cliff divides by the cliff, not 8.13", () => {
    const { steps } = buildAdjustmentTimeline([
      at("BONUS", "2006-02-19T18:30:00.000Z", 2, "BSE"),
      at("CAPITAL_ADJUSTMENT", "2006-02-20T00:00:00.000Z", 4, "DERIVED", {
        observedRatio: 4.067139282735613,
      }),
      at("BONUS", "2013-07-22T18:30:00.000Z", 2, "NSE"),
      at("BONUS", "2013-07-22T18:30:00.000Z", 2, "BSE"),
      at("BONUS", "2022-07-07T18:30:00.000Z", 2, "NSE"),
      at("BONUS", "2022-07-07T18:30:00.000Z", 2, "BSE"),
    ]);
    // The filings of the LATER bonuses are untouched: 4.067 x 2 x 2.
    assert.equal(
      factorForDate(steps, D("2006-02-17")),
      4.067139282735613 * 2 * 2,
    );
  });

  it("VEGA 2026: BSE's BONUS 5 and a detection on the next BSE print, 4.23 days later, divide by 5, not 25.20", () => {
    const { steps } = buildAdjustmentTimeline([
      at("BONUS", "2026-04-23T18:30:00.000Z", 5, "BSE"),
      at("CAPITAL_ADJUSTMENT", "2026-04-28T00:00:00.000Z", 5, "DERIVED", {
        observedRatio: 5.040355125100888,
      }),
    ]);
    assert.equal(factorForDate(steps, D("2026-04-16")), 5);
  });
});

describe("one event filed by both exchanges as a bonus AND a split — MONEY-1541, real prod rows", () => {
  it("BAJFINANCE 2025 divides by 10, not 100, in the order the store returns the rows", () => {
    // BONUS 4:1 (5) + SPLIT 2:1 (2), each filed by BSE and NSE. The raw cliff
    // is 9.95. Compared with the last kept row only, BSE's SPLIT sat between
    // the two BONUS filings and each exchange's pair applied: 5 x 2 x 5 x 2.
    const rows = [
      at("BONUS", "2025-06-15T18:30:00.000Z", 5, "BSE"),
      at("SPLIT", "2025-06-15T18:30:00.000Z", 2, "BSE"),
      at("BONUS", "2025-06-15T18:30:00.000Z", 5, "NSE"),
      at("SPLIT", "2025-06-15T18:30:00.000Z", 2, "NSE"),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const { steps } = buildAdjustmentTimeline(order);
      assert.equal(factorForDate(steps, D("2025-06-13")), 10);
    }
  });

  it("ONGC 2011: a BONUS 2 and a SPLIT 2 on one ex-date are TWO events — 4, not 2", () => {
    // NSE files the split (its text reads "Bonus 1:1 And Face Value Split"),
    // BSE files both. NSE's own print falls 4.24x. Merging on an equal factor
    // regardless of type collapsed the bonus into the split.
    const { steps } = buildAdjustmentTimeline([
      at("SPLIT", "2011-02-07T18:30:00.000Z", 2, "NSE"),
      at("BONUS", "2011-02-07T18:30:00.000Z", 2, "BSE"),
      at("SPLIT", "2011-02-07T18:30:00.000Z", 2, "BSE"),
    ]);
    assert.equal(factorForDate(steps, D("2011-02-04")), 4);
  });
});

describe("adjustingActionsWhere — the chart's scope, for every origin (MONEY-1541)", () => {
  it("matches the COMPANY: current and former symbols and the ISIN, never the exchange", () => {
    // The tile builder asked for `{symbol, exchange}` and missed every bonus
    // the other exchange filed — the chart and its tiles disagreed on which
    // splits exist.
    assert.deepEqual(
      adjustingActionsWhere({
        symbol: "ZOMATO",
        previousSymbols: ["ZOMATOLTD"],
        isin: "INE758T01015",
      }),
      {
        type: { in: ["SPLIT", "BONUS", "DEMERGER", "CAPITAL_ADJUSTMENT"] },
        OR: [
          { symbol: { in: ["ZOMATO", "ZOMATOLTD"] } },
          { isin: "INE758T01015" },
        ],
      },
    );
    // No ISIN is no ISIN clause, not `{ isin: null }` (which would match every
    // ISIN-less row on the platform).
    assert.deepEqual(adjustingActionsWhere({ symbol: "AUGMONT" }).OR, [
      { symbol: { in: ["AUGMONT"] } },
    ]);
  });
});

describe("another company's filing under the same ticker is refused — MONEY-1543, real prod rows", () => {
  // Rows and instruments as prod holds them (2026-09-23, after the MONEY-1530
  // re-anchor: every exDate is 00:00Z of its IST day). Only 213 of 5,072 rows
  // carry an ISIN, so most are named by the instruments that trade, or traded,
  // under the row's (symbol, exchange).
  const row = (
    symbol: string,
    exchange: string,
    type: string,
    iso: string,
    ratio: number | null,
    isin: string | null = null,
    source: string = exchange,
  ): AdjustingAction => ({
    symbol,
    exchange,
    isin,
    type,
    exDate: new Date(`${iso}T00:00:00.000Z`),
    ratio,
    source,
  });
  const inst = (
    symbol: string,
    exchange: string,
    isin: string | null,
    previousSymbols: string[] = [],
  ): IssuerCandidate => ({ symbol, exchange, isin, previousSymbols });
  const kept = (r: { actions: AdjustingAction[] }) =>
    r.actions.map((a) => `${a.symbol}:${a.exchange}:${a.type}:${a.ratio}`);

  // FOCUS is Focus Lighting and Fixtures on NSE and Focus Business Solution on
  // BSE. NSE's own print is flat through both BSE bonuses (1.007 on
  // 2023-08-23, 0.999 on 2025-07-21), yet the chart divided NSE's pre-2023
  // history by 5 x 1.8 x 1.58 = 14.22.
  const focusRows = [
    row("FOCUS", "BSE", "BONUS", "2023-08-23", 1.8),
    row("FOCUS", "NSE", "SPLIT", "2023-10-06", 5),
    row("FOCUS", "BSE", "BONUS", "2025-07-21", 1.58),
  ];
  const focusInst = [
    inst("FOCUS", "NSE", "INE593W01028"),
    inst("FOCUS", "BSE", "INE0DXR01010"),
  ];

  it("FOCUS: each exchange's chart keeps its own company's filings only", () => {
    const nse = refuseForeignIssuers("INE593W01028", focusRows, focusInst);
    assert.deepEqual(kept(nse), ["FOCUS:NSE:SPLIT:5"]);
    assert.equal(nse.refused.length, 2);
    assert.equal(
      factorForDate(
        buildAdjustmentTimeline(nse.actions).steps,
        D("2023-01-02"),
      ),
      5,
    );
    const bse = refuseForeignIssuers("INE0DXR01010", focusRows, focusInst);
    assert.deepEqual(kept(bse), [
      "FOCUS:BSE:BONUS:1.8",
      "FOCUS:BSE:BONUS:1.58",
    ]);
    // A row that carries its OWN ISIN is named by it, with nothing to look up
    // — the detector stamps its instrument's ISIN on all 156 DERIVED rows.
    // (Synthetic: BSE's detector never fired on FOCUS.)
    const derived = refuseForeignIssuers(
      "INE593W01028",
      [
        row(
          "FOCUS",
          "BSE",
          "CAPITAL_ADJUSTMENT",
          "2025-07-21",
          1.58,
          "INE0DXR01010",
          "DERIVED",
        ),
      ],
      [],
    );
    assert.equal(derived.refused.length, 1);
  });

  it("WORTHPERI: its former symbol WORTH is a DIFFERENT company on BSE", () => {
    // Worth Peripherals traded as WORTH on NSE. On BSE, WORTH is Worth
    // Investment & Trading, whose split and bonus divided WORTHPERI's history
    // by 25 across two flat NSE sessions (1.010 and 0.954).
    const r = refuseForeignIssuers(
      "INE196Y01018",
      [
        row("WORTH", "BSE", "SPLIT", "2024-07-03", 10),
        row("WORTH", "BSE", "BONUS", "2024-11-14", 2.5),
      ],
      [
        inst("WORTH", "BSE", "INE114O01020"),
        inst("WORTHPERI", "NSE", "INE196Y01018", ["WORTH"]),
      ],
    );
    assert.deepEqual(kept(r), []);
    assert.equal(r.refused.length, 2);
    assert.equal(r.unknownIssuer, 0);
  });

  it("a renamed company keeps the splits it filed under its OLD ticker", () => {
    // MANBRO became KDGREEN; the retired MANBRO row still exists on BSE with
    // the same ISIN, and KDGREEN carries MANBRO as a former symbol.
    const r = refuseForeignIssuers(
      "INE348N01042",
      [row("MANBRO", "BSE", "SPLIT", "2026-03-25", 10)],
      [
        inst("MANBRO", "BSE", "INE348N01042"),
        inst("KDGREEN", "BSE", "INE348N01042", ["MANBRO"]),
      ],
    );
    assert.deepEqual(kept(r), ["MANBRO:BSE:SPLIT:10"]);
    // And through the former-symbol link alone, with no occupant left.
    const viaFormer = refuseForeignIssuers(
      "INE348N01042",
      [row("MANBRO", "BSE", "SPLIT", "2026-03-25", 10)],
      [inst("KDGREEN", "BSE", "INE348N01042", ["MANBRO"])],
    );
    assert.deepEqual(kept(viaFormer), ["MANBRO:BSE:SPLIT:10"]);
    assert.equal(viaFormer.unknownIssuer, 0);
  });

  it("compares the ISSUER, not the security: a split's new serial is the same company", () => {
    // TDPOWERSYS's BSE listing still reads the pre-split INE419M01027 while
    // NSE, and the 2026 filings themselves, read INE419M01035. A whole-ISIN
    // comparison refuses the company's own splits on the BSE chart — 13 such
    // rows on prod.
    assert.equal(isinIssuer("INE419M01027"), "E419M");
    assert.equal(isinIssuer("INE419M01035"), "E419M");
    assert.equal(isinIssuer("INE419M"), null, "not an ISIN");
    const r = refuseForeignIssuers(
      "INE419M01027",
      [
        row("TDPOWERSYS", "NSE", "SPLIT", "2022-10-31", 5),
        row("TDPOWERSYS", "BSE", "SPLIT", "2026-08-24", 2, "INE419M01035"),
      ],
      [
        inst("TDPOWERSYS", "NSE", "INE419M01035"),
        inst("TDPOWERSYS", "BSE", "INE419M01035"),
      ],
    );
    assert.equal(r.actions.length, 2);
    assert.equal(r.refused.length, 0);
  });

  it("an issuer nobody can name stays admitted, and is counted", () => {
    // HERCULES has no NSE instrument at all; PAEL's retired row has no ISIN
    // while AURIQUE (formerly PAEL) has one. Neither is evidence of another
    // company, and dropping them would erase a real cliff.
    const hercules = refuseForeignIssuers(
      "INE688E01024",
      [row("HERCULES", "NSE", "BONUS", "2012-07-11", 2)],
      [inst("HERCULES", "BSE", "INE688E01024")],
    );
    assert.equal(hercules.actions.length, 1);
    assert.equal(hercules.unknownIssuer, 1);
    const aurique = refuseForeignIssuers(
      "INE766A01026",
      [row("PAEL", "BSE", "BONUS", "2026-05-25", 7)],
      [
        inst("PAEL", "BSE", null),
        inst("AURIQUE", "BSE", "INE766A01026", ["PAEL"]),
      ],
    );
    assert.equal(aurique.actions.length, 1);
    assert.equal(aurique.unknownIssuer, 1);
    // Two companies behind one ticker on one exchange (synthetic — prod has
    // none today): with no DATED history it cannot be told apart, so unknown.
    const reused = refuseForeignIssuers(
      "INE0AAA01011",
      [row("ABC", "NSE", "SPLIT", "2015-01-01", 2)],
      [
        inst("ABC", "NSE", "INE0BBB01012"),
        inst("ABCNEW", "NSE", "INE0AAA01011", ["ABC"]),
      ],
    );
    assert.equal(reused.actions.length, 1);
    assert.equal(reused.unknownIssuer, 1);
    // A listing with no ISIN has no issuer to compare: everything stays.
    const noIsin = refuseForeignIssuers(null, focusRows, focusInst);
    assert.equal(noIsin.actions.length, 3);
    assert.equal(noIsin.unknownIssuer, 3);
  });

  it("SAYAJIHOTL is NOT a collision: NSE's detected 0.5 names the same issuer", () => {
    // The row carries INE318C01014 — the BSE listing's own ISIN — so no
    // issuer rule can refuse it, and none should. What is wrong is the row:
    // its prevClose 138.7 is NSE's close of 2015-01-16, eleven years before —
    // a "cliff" read across a trading gap — and BSE's print is flat that day
    // (1.027). MONEY-1600 retires it.
    const r = refuseForeignIssuers(
      "INE318C01014",
      [
        row(
          "SAYAJIHOTL",
          "NSE",
          "CAPITAL_ADJUSTMENT",
          "2026-04-22",
          0.5,
          "INE318C01014",
          "DERIVED",
        ),
      ],
      [],
    );
    assert.equal(r.actions.length, 1);
    assert.equal(r.refused.length, 0);
  });
});

describe("loadAdjustingActions — the one loader the chart and the tile builder call (MONEY-1543)", () => {
  // A fake store that EVALUATES the where clauses it is handed, so a lookup
  // that asks the wrong question returns the wrong instruments.
  const store = (
    rows: Omit<LoadedAdjustingAction, "updatedAt">[],
    instruments: IssuerCandidate[],
  ) => {
    const calls = { lookups: 0 };
    const db: AdjustingActionDb = {
      corporateAction: {
        findMany: async ({ where }) =>
          rows
            .filter(
              (r) =>
                where.type.in.includes(r.type) &&
                where.OR.some((c) =>
                  "isin" in c
                    ? r.isin === c.isin
                    : c.symbol.in.includes(r.symbol),
                ),
            )
            .map((r) => ({ ...r, updatedAt: D("2026-09-01") })),
      },
      instrumentMapping: {
        findMany: async ({ where }) => {
          calls.lookups++;
          const [bySymbol, byFormer] = where.OR;
          return instruments.filter(
            (i) =>
              where.exchange.in.includes(i.exchange) &&
              (bySymbol.symbol.in.includes(i.symbol) ||
                i.previousSymbols.some((p) =>
                  byFormer.previousSymbols.hasSome.includes(p),
                )),
          );
        },
      },
    };
    return { db, calls };
  };
  const r = (symbol: string, exchange: string, iso: string, ratio: number) => ({
    symbol,
    exchange,
    isin: null,
    type: "BONUS",
    exDate: D(iso),
    ratio,
    source: exchange,
    details: null,
  });

  it("WORTHPERI: finds WORTH:BSE's issuer and refuses its filings", async () => {
    const { db } = store(
      // WORTHPERI's own row is synthetic; WORTH:BSE's split is prod's.
      [
        r("WORTH", "BSE", "2024-07-03", 10),
        r("WORTHPERI", "NSE", "2025-01-01", 2),
      ],
      [
        {
          symbol: "WORTH",
          exchange: "BSE",
          isin: "INE114O01020",
          previousSymbols: [],
        },
        {
          symbol: "WORTHPERI",
          exchange: "NSE",
          isin: "INE196Y01018",
          previousSymbols: ["WORTH"],
        },
      ],
    );
    const out = await loadAdjustingActions(db, {
      symbol: "WORTHPERI",
      previousSymbols: ["WORTH"],
      isin: "INE196Y01018",
    });
    assert.deepEqual(
      out.actions.map((a) => a.symbol),
      ["WORTHPERI"],
    );
    assert.deepEqual(
      out.refused.map((a) => `${a.symbol}:${a.exchange}`),
      ["WORTH:BSE"],
    );
  });

  it("names an old ticker through the instrument that USED to trade it", async () => {
    // No MANBRO row is left to occupy the symbol: only KDGREEN's former-symbol
    // list names the issuer, so the lookup has to ask for it.
    const { db } = store(
      [r("MANBRO", "BSE", "2026-03-25", 10)],
      [
        {
          symbol: "KDGREEN",
          exchange: "BSE",
          isin: "INE348N01042",
          previousSymbols: ["MANBRO"],
        },
      ],
    );
    const out = await loadAdjustingActions(db, {
      symbol: "KDGREEN",
      previousSymbols: ["MANBRO"],
      isin: "INE348N01042",
    });
    assert.equal(out.actions.length, 1);
    assert.equal(out.unknownIssuer, 0);
  });

  it("a listing with no ISIN skips the lookup and admits everything", async () => {
    const { db, calls } = store([r("GDIL", "BSE", "2022-10-07", 5)], []);
    const out = await loadAdjustingActions(db, { symbol: "GDIL", isin: null });
    assert.equal(out.actions.length, 1);
    assert.equal(out.unknownIssuer, 1);
    assert.equal(calls.lookups, 0);
  });
});

describe("buildAdjustmentTimeline", () => {
  it("compounds two 1:1 bonuses into 4x before both, 2x between", () => {
    const { steps, used } = buildAdjustmentTimeline([
      action("BONUS", "2015-06-15", 2),
      action("BONUS", "2018-09-04", 2),
    ]);
    assert.equal(used, 2);
    assert.deepEqual(
      steps.map((s) => s.factor),
      [4, 2],
    );
    assert.equal(factorForDate(steps, D("2015-01-01")), 4, "before both");
    assert.equal(factorForDate(steps, D("2016-01-01")), 2, "between");
    assert.equal(factorForDate(steps, D("2020-01-01")), 1, "after both");
  });

  it("applies the factor from the ex-date onward, not before it", () => {
    // A bar ON the ex-date already trades at the new price and must NOT be
    // divided; an off-by-one here shifts the whole series by a day.
    const { steps } = buildAdjustmentTimeline([
      action("BONUS", "2015-06-15", 2),
    ]);
    assert.equal(factorForDate(steps, D("2015-06-14")), 2);
    assert.equal(factorForDate(steps, D("2015-06-15")), 1);
  });

  it("ignores non-qty-changing actions entirely", () => {
    // A dividend does not change the share count and must never scale prices.
    const { steps, used } = buildAdjustmentTimeline([
      action("DIVIDEND", "2020-01-01", 8),
      action("BUYBACK", "2020-02-01", 2),
      action("AGM", "2020-03-01"),
    ]);
    assert.equal(used, 0);
    assert.equal(steps.length, 0);
  });

  it("counts, rather than applies, an action with no usable factor", () => {
    const { steps, used, ignored } = buildAdjustmentTimeline([
      action("SPLIT", "2020-01-01", 0),
      action("BONUS", "2021-01-01", 2),
    ]);
    assert.equal(ignored, 1);
    assert.equal(used, 1);
    assert.deepEqual(
      steps.map((s) => s.factor),
      [2],
    );
  });

  it("returns an empty timeline for an instrument with no actions", () => {
    assert.deepEqual(buildAdjustmentTimeline([]).steps, []);
  });
});

describe("applyAdjustment", () => {
  it("smooths the SBIN 1:10 split — the raw x0.102 gap disappears", () => {
    const bars = [bar("2014-11-19", 2910.5), bar("2014-11-20", 297.1)];
    const { steps } = buildAdjustmentTimeline([
      action("SPLIT", "2014-11-20", 10),
    ]);
    const out = applyAdjustment(bars, steps);
    assert.equal(out[0]!.close, 291.05);
    assert.equal(out[1]!.close, 297.1, "post-split bar is untouched");
    // The whole point: no impossible one-day move remains.
    const move = Math.abs(out[1]!.close / out[0]!.close - 1);
    assert.ok(move < 0.25, `residual jump ${(move * 100).toFixed(1)}%`);
  });

  it("scales VOLUME the opposite way to price", () => {
    // Same turnover over 10x the shares. Getting this backwards is silent.
    const { steps } = buildAdjustmentTimeline([
      action("SPLIT", "2014-11-20", 10),
    ]);
    const out = applyAdjustment([bar("2014-11-19", 2910.5, 1000)], steps);
    assert.equal(out[0]!.volume, 10_000);
  });

  it("keeps open/high/low coherent after scaling", () => {
    const raw: RawBar = {
      date: D("2014-11-19"),
      open: 2900,
      high: 2950,
      low: 2880,
      close: 2910.5,
      volume: 1000,
    };
    const { steps } = buildAdjustmentTimeline([
      action("SPLIT", "2014-11-20", 10),
    ]);
    const out = applyAdjustment([raw], steps)[0]!;
    assert.equal(out.high, 295);
    assert.equal(out.low, 288);
    assert.ok(out.low <= out.open && out.open <= out.high);
    assert.ok(out.low <= out.close && out.close <= out.high);
  });

  it("handles the GOLDBEES 1:100 split without precision drift", () => {
    const { steps } = buildAdjustmentTimeline([
      action("SPLIT", "2019-12-19", 100),
    ]);
    const out = applyAdjustment([bar("2019-12-18", 3359.6)], steps);
    assert.ok(Math.abs(out[0]!.close - 33.596) < 1e-9);
  });

  it("uses the observed gap for a demerger", () => {
    const { steps } = buildAdjustmentTimeline([
      action("DEMERGER", "2006-02-01", null, "NSE", { observedRatio: 1.577 }),
    ]);
    const out = applyAdjustment([bar("2006-01-31", 1577)], steps);
    assert.ok(Math.abs(out[0]!.close - 1000) < 1);
  });

  it("returns the SAME ARRAY REFERENCE when there is nothing to apply", () => {
    // ~95% of instruments have no corporate actions; the feature must be free
    // for them rather than copying every bar of a 30-year series.
    const bars = [bar("2020-01-01", 100)];
    assert.equal(applyAdjustment(bars, []), bars);
  });

  it("leaves bars after the last action untouched", () => {
    const { steps } = buildAdjustmentTimeline([
      action("SPLIT", "2014-11-20", 10),
    ]);
    const post = bar("2020-01-01", 500);
    const out = applyAdjustment([post], steps);
    assert.equal(out[0], post, "identical object, not a rebuilt copy");
  });

  it("compounds correctly across INFY's three 1:1 bonuses", () => {
    // 2014, 2015, 2018 — a bar before all three must be divided by 8.
    const { steps } = buildAdjustmentTimeline([
      action("BONUS", "2014-12-02", 2),
      action("BONUS", "2015-06-15", 2),
      action("BONUS", "2018-09-04", 2),
    ]);
    const out = applyAdjustment([bar("2014-01-01", 8000)], steps);
    assert.equal(out[0]!.close, 1000);
  });
});
