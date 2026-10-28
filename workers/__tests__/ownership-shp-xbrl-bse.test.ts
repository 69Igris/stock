/**
 * UNIT TEST — ownership legs 5 (SHP XBRL) and 6 (BSE), MONEY-1205.
 *
 * Exercises the REAL exports (no shadow copies) from
 *   packages/research/src/data-sources/ownership-logic.ts   — selection + policy
 *   packages/core/src/market-data/…                          — the two finished
 *     parsers and the archive-key builder, composed EXACTLY as
 *     workers/src/processors/ownership-sync.ts composes them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS REAL HERE, AND WHY IT MATTERS
 *
 * `BOGUS_SHP` is CAPTURED — the byte shape `api.bseindia.com` returned on
 * 2026-08-18 for BOTH a nonexistent scripcode (999999) and a nonexistent qtrid
 * (99999). Both answered HTTP 200 with an identical 19,386-byte body:
 * `Table: []`, `Table3: []`, and `Table1` carrying SIX fully-populated rows of
 * `0`. Trimmed here to the fields the gate and the summary reader touch; the
 * two empty metadata tables and the six populated zero rows are verbatim
 * structure, because that combination IS the trap.
 *
 * `BSE_QUARTER_LABELS` are likewise captured, from scrip 500325's quarter index
 * (106 rows) on the same day. `SHP_XBRL_URL` is a real prod value out of
 * `shareholding_patterns.raw`, and `SHP_SENTINEL_URL` is the `-` form NSE emits
 * for a filing with no XBRL (31 of a 4,000-row prod sample).
 *
 * A synthetic fixture written to the same guess as the code cannot falsify the
 * guess; it can only agree with it. That is exactly how `public_val` stayed
 * unmapped across 7,953 prod rows while this module's older suite was green.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions and one source-structure read: no Prisma, no fetch, no timers.
 * Nothing here can orphan the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  // Leg 5
  SHP_XBRL_FEED_SLUG,
  SHP_XBRL_REFERER,
  shpXbrlArchiveDay,
  isFetchableXbrlUrl,
  readStoredShpRaw,
  pendingShpFilings,
  decideBreakdownWrite,
  // Leg 6
  bseQuarterLabelToKey,
  buildBseScripIndex,
  buildBseShpQueue,
  pendingBseQuarters,
  // Shared machinery both legs adopt
  decideRunStatus,
  resolveCursorIndex,
  advanceCursor,
  sliceQueue,
  projectedPassDays,
  normalizeQuarter,
  OWNERSHIP_TIER,
  type StoredShareholdingRow,
} from "@usemoney/research/data-sources/ownership-logic";
import {
  buildFeedArchiveKey,
  parseBseShareholding,
  reconcileWithSummary,
  SHAREHOLDING_RECONCILE_TOLERANCE_PCT,
  type BseShpQuarter,
} from "@usemoney/core/market-data";

// ── Captured fixtures ────────────────────────────────────────────────────────

/** A real prod `xbrl` value (RELIANCE-era archive host, `_WEB.xml` suffix). */
const SHP_XBRL_URL =
  "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1694089_16072026031504_WEB.xml";

/**
 * NSE's "this filing has no XBRL" value. It is a URL, it starts with `https`,
 * and it answers **200 with an HTML page** — so nothing downstream of the
 * request can tell it apart from a filing.
 */
const SHP_SENTINEL_URL = "https://nsearchives.nseindia.com/corporate/xbrl/-";

/** One stored summary row, shaped like `shareholding_patterns`. */
function storedRow(
  quarter: string,
  overrides: Partial<StoredShareholdingRow> & { xbrl?: string } = {},
): StoredShareholdingRow {
  const { xbrl, ...rest } = overrides;
  return {
    symbol: "BANKBARODA",
    quarter,
    promoterPct: 63.97,
    publicPct: 36.03,
    raw: JSON.stringify({
      symbol: "BANKBARODA",
      date: `30-JUN-2026`,
      isin: "INE028A01039",
      pr_and_prgrp: "63.97",
      public_val: "36.03",
      xbrl: xbrl ?? SHP_XBRL_URL,
      xbrlFileSize: "146564",
    }),
    ...rest,
  };
}

/** One `Table1` line of BSE's zero skeleton, verbatim in the fields read. */
function zeroLine(code: string, level: string): Record<string, unknown> {
  return {
    Fld_Code: code,
    FLD_LEVEL: level,
    Fld_ShortName: "(A) Promoter & Promoter Group",
    Fld_NoOfShareHolders: 0,
    Fld_TotalNoOfShares: 0,
    Fld_TotalPercentageOf_A_B_C2: 0,
    Fld_PledgeEncumberedPercentage: 0,
    Fld_TotalencumberedPercentage: 0,
  };
}

/**
 * The trap, captured. `Table` (metadata) and `Table3` (scrip) are EMPTY while
 * `Table1` (data) is fully populated with zeros — which is why the gate is the
 * metadata tables and never the data table.
 */
const BOGUS_SHP = {
  summary: {
    Table: [],
    Table1: [
      zeroLine("STA1A2", "A=A1+A2"),
      zeroLine("STB", "B"),
      zeroLine("STC", "C"),
      zeroLine("STC1", "C1"),
      zeroLine("STC2", "C2"),
      zeroLine("STTotal", "A+B+C"),
    ],
    Table2: [{}],
    Table3: [],
    Table4: [],
    Table5: [],
    Table6: [{}],
  },
};

/** Captured labels from scrip 500325's index — both live shapes. */
const BSE_QUARTER_LABELS = [
  "June 2026",
  "March 2026",
  "December 2025",
  "September 2025",
  "29 Oct 2024",
];

function quarter(label: string, qtrId: string, status = "New"): BseShpQuarter {
  return { qtrId, label, status, filedAt: null, xbrlUrl: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// LEG 5 — selection
// ═════════════════════════════════════════════════════════════════════════════

describe("isFetchableXbrlUrl — the sentinel is refused BEFORE any request", () => {
  it("refuses NSE's `-` sentinel, which 200s with HTML and cannot be caught later", () => {
    assert.equal(isFetchableXbrlUrl(SHP_SENTINEL_URL), false);
  });

  it("accepts a real filing url", () => {
    assert.equal(isFetchableXbrlUrl(SHP_XBRL_URL), true);
  });

  it("refuses anything that is not an https .xml document", () => {
    for (const bad of [
      "",
      " ",
      "-",
      "http://nsearchives.nseindia.com/corporate/xbrl/SHP_1.xml", // not https
      "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1.pdf",
      "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1.xml.html",
      null,
      undefined,
      42,
      { url: SHP_XBRL_URL },
    ]) {
      assert.equal(isFetchableXbrlUrl(bad), false, `accepted ${String(bad)}`);
    }
  });
});

describe("readStoredShpRaw — a re-parse of our own audit artifact, never a throw", () => {
  it("pulls the xbrl link and the isin out of a real stored row", () => {
    const read = readStoredShpRaw(storedRow("2026-06").raw);
    assert.equal(read.xbrlUrl, SHP_XBRL_URL);
    assert.equal(read.isin, "INE028A01039");
  });

  it("degrades to nulls on malformed JSON rather than killing a scheduled job", () => {
    for (const bad of ["", "{", "null", "[]", '"a string"', "0"]) {
      assert.deepEqual(readStoredShpRaw(bad), { xbrlUrl: null, isin: null });
    }
  });

  it("treats a blank / sentinel isin as ABSENT, never as an empty-string identity", () => {
    for (const v of ["", "  ", "-", "N/A"]) {
      const raw = JSON.stringify({ xbrl: SHP_XBRL_URL, isin: v });
      assert.equal(
        readStoredShpRaw(raw).isin,
        null,
        `isin ${JSON.stringify(v)}`,
      );
    }
  });
});

describe("pendingShpFilings — what leg 5 will actually fetch", () => {
  it("SKIPS THE SENTINEL ROW ENTIRELY — it never reaches the fetch list", () => {
    const { pending, reasons } = pendingShpFilings(
      [storedRow("2026-06", { xbrl: SHP_SENTINEL_URL }), storedRow("2026-03")],
      new Set(),
      4,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.quarter, "2026-03");
    assert.equal(reasons.noXbrlLink, 1);
    // The loop in `runShpXbrlSymbol` iterates EXACTLY this array, so a URL that
    // is not in it is a URL that is not requested.
    assert.ok(
      pending.every((p) => p.url !== SHP_SENTINEL_URL),
      "the sentinel reached the fetch list",
    );
  });

  it("orders newest quarter first — a truncated run must spend its budget there", () => {
    const { pending } = pendingShpFilings(
      ["2024-09", "2026-06", "2025-03", "2026-03"].map((q) => storedRow(q)),
      new Set(),
      10,
    );
    assert.deepEqual(
      pending.map((p) => p.quarter),
      ["2026-06", "2026-03", "2025-03", "2024-09"],
    );
  });

  it("skips quarters already written, and COUNTS them (the steady state)", () => {
    const { pending, reasons } = pendingShpFilings(
      ["2026-06", "2026-03"].map((q) => storedRow(q)),
      new Set(["2026-06", "2026-03"]),
      4,
    );
    assert.deepEqual(pending, []);
    assert.equal(reasons.alreadyStored, 2);
  });

  it("caps per symbol so one 47-quarter name cannot eat a whole leg", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      storedRow(`2026-${String(12 - i).padStart(2, "0")}`),
    );
    const { pending, reasons } = pendingShpFilings(rows, new Set(), 4);
    assert.equal(pending.length, 4);
    assert.equal(reasons.overCap, 8);
    // Newest four, not an arbitrary four.
    assert.deepEqual(
      pending.map((p) => p.quarter),
      ["2026-12", "2026-11", "2026-10", "2026-09"],
    );
  });

  it("carries the SUMMARY's own promoter/public/isin forward for the reconcile", () => {
    const { pending } = pendingShpFilings([storedRow("2026-06")], new Set(), 4);
    assert.deepEqual(
      {
        symbol: pending[0]!.symbol,
        promoterPct: pending[0]!.promoterPct,
        publicPct: pending[0]!.publicPct,
        isin: pending[0]!.isin,
      },
      {
        symbol: "BANKBARODA",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: "INE028A01039",
      },
    );
  });

  it("never throws on a hostile stored row", () => {
    assert.doesNotThrow(() =>
      pendingShpFilings(
        [
          {
            symbol: "X",
            quarter: "2026-06",
            raw: "{{{",
            promoterPct: null,
            publicPct: null,
          },
          {
            symbol: "",
            quarter: "",
            raw: "null",
            promoterPct: null,
            publicPct: null,
          },
        ],
        new Set(),
        4,
      ),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LEG 5 — the archive key
// ═════════════════════════════════════════════════════════════════════════════

describe("shpXbrlArchiveDay — the key lands on the QUARTER END", () => {
  it("keys 2026-06 under 2026/06, not under the day we fetched it", () => {
    const key = buildFeedArchiveKey(
      {
        exchange: "NSE",
        feed: SHP_XBRL_FEED_SLUG,
        date: shpXbrlArchiveDay("2026-06"),
      },
      SHP_XBRL_URL,
    );
    assert.ok(key.startsWith("feeds/NSE/shp-xbrl/2026/06/"), `key was ${key}`);
  });

  it("A RE-BROADCAST FILING STAYS IN ITS OWN QUARTER'S MONTH", () => {
    // Same quarter (2026-06), two different broadcast timestamps in the URL —
    // the July original and an October restatement. Both MUST land under
    // 2026/06, or one quarter of one symbol occupies two prefixes and neither
    // is findable from the quarter alone.
    const original =
      "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1694089_16072026031504_WEB.xml";
    const rebroadcast =
      "https://nsearchives.nseindia.com/corporate/xbrl/SHP_1801122_09102026114500_WEB.xml";
    const day = shpXbrlArchiveDay("2026-06");
    const a = buildFeedArchiveKey(
      { exchange: "NSE", feed: SHP_XBRL_FEED_SLUG, date: day },
      original,
    );
    const b = buildFeedArchiveKey(
      { exchange: "NSE", feed: SHP_XBRL_FEED_SLUG, date: day },
      rebroadcast,
    );
    assert.ok(a.startsWith("feeds/NSE/shp-xbrl/2026/06/"), a);
    assert.ok(b.startsWith("feeds/NSE/shp-xbrl/2026/06/"), b);
    // Same prefix, DIFFERENT object: the series is preserved, the restatement
    // does not overwrite the original.
    assert.notEqual(a, b);
  });

  it("the +5:30 conversion cannot roll the MONTH, for any month", () => {
    for (let m = 1; m <= 12; m++) {
      const q = `2026-${String(m).padStart(2, "0")}`;
      const key = buildFeedArchiveKey(
        {
          exchange: "NSE",
          feed: SHP_XBRL_FEED_SLUG,
          date: shpXbrlArchiveDay(q),
        },
        SHP_XBRL_URL,
      );
      assert.ok(
        key.startsWith(
          `feeds/NSE/shp-xbrl/2026/${String(m).padStart(2, "0")}/`,
        ),
        `${q} keyed as ${key}`,
      );
    }
  });

  it("two quarters of ONE symbol are two objects — the whole point of dating it", () => {
    const jun = buildFeedArchiveKey(
      {
        exchange: "NSE",
        feed: SHP_XBRL_FEED_SLUG,
        date: shpXbrlArchiveDay("2026-06"),
      },
      SHP_XBRL_URL,
    );
    const mar = buildFeedArchiveKey(
      {
        exchange: "NSE",
        feed: SHP_XBRL_FEED_SLUG,
        date: shpXbrlArchiveDay("2026-03"),
      },
      SHP_XBRL_URL,
    );
    assert.notEqual(jun, mar);
    assert.ok(jun.includes("/2026/06/") && mar.includes("/2026/03/"));
  });

  it("an UNPARSED quarter label yields undefined -> current/, never a guessed month", () => {
    for (const q of ["Q1FY26", "JUNE 2026", "", "2026", "2026-13", "2026-00"]) {
      assert.equal(shpXbrlArchiveDay(q), undefined, `guessed a month for ${q}`);
    }
    const key = buildFeedArchiveKey(
      {
        exchange: "NSE",
        feed: SHP_XBRL_FEED_SLUG,
        date: shpXbrlArchiveDay("Q1FY26"),
      },
      SHP_XBRL_URL,
    );
    assert.ok(key.startsWith("feeds/NSE/shp-xbrl/current/"), key);
  });

  it("the referer is the filings page the archive host answers to", () => {
    assert.match(SHP_XBRL_REFERER, /^https:\/\/www\.nseindia\.com\//);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LEG 5 — the reconcile policy
// ═════════════════════════════════════════════════════════════════════════════

/** The exact composition the processor performs: parse fields -> verdict -> decision. */
function pipeline(
  filing: {
    symbol: string | null;
    quarter: string | null;
    promoterPct: number | null;
    publicPct: number | null;
    isin: string | null;
  },
  summary: {
    symbol: string;
    quarter: string;
    promoterPct: number | null;
    publicPct: number | null;
    isin?: string | null;
  },
) {
  const verdict = reconcileWithSummary(
    filing,
    summary,
    SHAREHOLDING_RECONCILE_TOLERANCE_PCT,
  );
  return { verdict, decision: decideBreakdownWrite(verdict) };
}

describe("the reconcile gate — a disagreement is RECORDED, never overwritten", () => {
  it("writes when the filing and the summary agree", () => {
    const { verdict, decision } = pipeline(
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.9712,
        publicPct: 36.0288,
        isin: "INE028A01039",
      },
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: "INE028A01039",
      },
    );
    assert.equal(verdict.status, "agree");
    assert.deepEqual(decision, { write: true, reason: "agree" });
  });

  it("REFUSES THE WRITE on a value disagreement, and names the field", () => {
    const { verdict, decision } = pipeline(
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 12.5, // another company's filing, served under our url
        publicPct: 87.5,
        isin: "INE028A01039",
      },
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: "INE028A01039",
      },
    );
    assert.equal(verdict.status, "disagree");
    assert.equal(decision.write, false);
    assert.equal(decision.reason, "disagree:promoterPct");
    // The counter key is what lands in the sync log; a bare boolean would make
    // the refusal indistinguishable from "nothing was pending".
    assert.match(decision.reason, /^disagree:/);
  });

  it("REFUSES the write when the filing names a different company", () => {
    const { verdict, decision } = pipeline(
      {
        symbol: "CUB",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: null,
      },
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
      },
    );
    assert.equal(verdict.status, "disagree");
    assert.deepEqual(decision, { write: false, reason: "disagree:symbol" });
  });

  it("REFUSES the write when the filing names a different quarter", () => {
    const { decision } = pipeline(
      {
        symbol: "BANKBARODA",
        quarter: "2026-03",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: null,
      },
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
      },
    );
    assert.deepEqual(decision, { write: false, reason: "disagree:quarter" });
  });

  it("an ISIN mismatch is SURFACED and never fatal — 2 of 5 prod symbols hit it", () => {
    // BANKBARODA: summary IN9028A01011, filing INE028A01039. Same company by
    // symbol, quarter and every percentage. Blocking on ISIN would reject 40%
    // of a healthy sample.
    const { verdict, decision } = pipeline(
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: "INE028A01039",
      },
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
        isin: "IN9028A01011",
      },
    );
    assert.equal(verdict.status, "agree");
    assert.equal(decision.write, true);
    assert.equal(decision.reason, "agreeIsinMismatch");
  });

  it("WRITES a promoter-less company: null vs 0 is incomparable, not a conflict", () => {
    // CUB files no promoter table at all. Refusing this would drop every
    // promoter-less company; calling it `agree` would assert a check we did not
    // make. It is neither, and it gets its own counter.
    const { verdict, decision } = pipeline(
      {
        symbol: "CUB",
        quarter: "2026-06",
        promoterPct: null,
        publicPct: null,
        isin: "INE491A01021",
      },
      { symbol: "CUB", quarter: "2026-06", promoterPct: 0, publicPct: null },
    );
    assert.equal(verdict.status, "incomparable");
    assert.equal(decision.write, true);
    assert.equal(decision.reason, "incomparableNoValue");
  });

  it("REFUSES when identity could not be checked at all — the unverifiable case", () => {
    const { verdict, decision } = pipeline(
      {
        symbol: null,
        quarter: null,
        promoterPct: null,
        publicPct: null,
        isin: null,
      },
      {
        symbol: "BANKBARODA",
        quarter: "2026-06",
        promoterPct: 63.97,
        publicPct: 36.03,
      },
    );
    assert.equal(verdict.status, "incomparable");
    assert.deepEqual(decision, {
      write: false,
      reason: "incomparableNoIdentity",
    });
  });

  it("the tolerance is wider than 2dp rounding and far tighter than a wrong company", () => {
    // 0.5pp. The published summary is 2dp and the filing 4dp ratios, so a real
    // pair differs by <0.005pp; the smallest gap between DISTINCT prod
    // companies in the fixture set is 6.6pp.
    assert.equal(SHAREHOLDING_RECONCILE_TOLERANCE_PCT, 0.5);
    const near = pipeline(
      {
        symbol: "X",
        quarter: "2026-06",
        promoterPct: 63.4,
        publicPct: null,
        isin: null,
      },
      { symbol: "X", quarter: "2026-06", promoterPct: 63.97, publicPct: null },
    );
    assert.equal(near.decision.write, false);
    const inside = pipeline(
      {
        symbol: "X",
        quarter: "2026-06",
        promoterPct: 63.6,
        publicPct: null,
        isin: null,
      },
      { symbol: "X", quarter: "2026-06", promoterPct: 63.97, publicPct: null },
    );
    assert.equal(inside.decision.write, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LEG 6 — the BSE trap, composed exactly as the processor composes it
// ═════════════════════════════════════════════════════════════════════════════

describe("the BSE zero skeleton — a bogus response NEVER yields a written row", () => {
  it("a bogus SCRIPCODE parses to null, so there is nothing to write", () => {
    // Captured: scripcode=999999&qtrid=130 -> HTTP 200, 19,386 bytes.
    const parse = parseBseShareholding(BOGUS_SHP, { normalizeQuarter });
    assert.equal(parse, null);
  });

  it("a bogus QTRID parses to null too — same 200, same bytes", () => {
    // Captured: scripcode=500325&qtrid=99999 -> byte-identical to the above.
    assert.equal(parseBseShareholding(BOGUS_SHP, { normalizeQuarter }), null);
  });

  it("the DATA table is fully populated with zeros — which is why it is not the gate", () => {
    // Pin the fixture's own trap-ness. If someone "simplifies" it to an empty
    // Table1, the two assertions above start passing for the wrong reason.
    assert.equal(BOGUS_SHP.summary.Table1.length, 6);
    assert.equal(BOGUS_SHP.summary.Table.length, 0);
    assert.equal(BOGUS_SHP.summary.Table3.length, 0);
    for (const row of BOGUS_SHP.summary.Table1) {
      assert.equal(row.Fld_TotalPercentageOf_A_B_C2, 0);
      assert.equal(row.Fld_TotalNoOfShares, 0);
    }
  });

  it("a filing with metadata but NO end date is refused rather than keyed from the request", () => {
    const noDate = {
      summary: {
        ...BOGUS_SHP.summary,
        Table: [{ Fld_IsPledge: false }],
        Table3: [{ fld_enddate: "" }],
      },
    };
    assert.equal(parseBseShareholding(noDate, { normalizeQuarter }), null);
  });

  it("passes the REAL normalizeQuarter, so BSE and NSE key identically", () => {
    // The failure this guards is silent: a re-implemented quarter rule would
    // key BSE's "30 Jun 2026" as something other than NSE's "2026-06" and the
    // two tables would never join. Same input, same key, one function.
    assert.equal(normalizeQuarter("30 Jun 2026"), "2026-06");
    assert.equal(normalizeQuarter("30-JUN-2026"), "2026-06");
    assert.equal(normalizeQuarter("2026-06-30"), "2026-06");
  });
});

describe("bseQuarterLabelToKey — a pre-filter with a catch-all, never a guess", () => {
  it("reads the regular month-name form", () => {
    assert.equal(bseQuarterLabelToKey("June 2026"), "2026-06");
    assert.equal(bseQuarterLabelToKey("March 2026"), "2026-03");
    assert.equal(bseQuarterLabelToKey("December 2025"), "2025-12");
    assert.equal(bseQuarterLabelToKey("September 2025"), "2025-09");
  });

  it("reads the OFF-CYCLE dated form BSE also emits", () => {
    assert.equal(bseQuarterLabelToKey("29 Oct 2024"), "2024-10");
  });

  it("covers every captured label from scrip 500325's index", () => {
    for (const label of BSE_QUARTER_LABELS) {
      assert.notEqual(
        bseQuarterLabelToKey(label),
        null,
        `could not key ${label}`,
      );
    }
  });

  it("agrees with normalizeQuarter, which is what the ROW is keyed on", () => {
    // The pre-filter and the authority must not disagree, or every quarter is
    // re-fetched forever.
    assert.equal(
      bseQuarterLabelToKey("29 Oct 2024"),
      normalizeQuarter("29 Oct 2024"),
    );
    assert.equal(
      bseQuarterLabelToKey("June 2026"),
      normalizeQuarter("30 Jun 2026"),
    );
  });

  it("returns NULL rather than a guess for anything else", () => {
    for (const bad of [
      "",
      "  ",
      "Quarter 1",
      "Junk 2026",
      "June",
      "2026",
      42,
      null,
    ]) {
      assert.equal(
        bseQuarterLabelToKey(bad),
        null,
        `guessed for ${String(bad)}`,
      );
    }
  });

  it("rejects an implausible year instead of minting a key from it", () => {
    assert.equal(bseQuarterLabelToKey("June 1899"), null);
    assert.equal(bseQuarterLabelToKey("June 2400"), null);
  });
});

describe("pendingBseQuarters — an unreadable label costs a REQUEST, never a hole", () => {
  it("skips quarters already stored", () => {
    const { pending, reasons } = pendingBseQuarters(
      [quarter("June 2026", "130"), quarter("March 2026", "129")],
      new Set(["2026-06"]),
      2,
    );
    assert.deepEqual(
      pending.map((p) => p.quarter.qtrId),
      ["129"],
    );
    assert.equal(reasons.alreadyStored, 1);
  });

  it("INCLUDES a label it cannot key — precision WITH a catch-all", () => {
    const { pending, reasons } = pendingBseQuarters(
      [quarter("Quarter ending soon", "999")],
      new Set(["2026-06"]),
      2,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.expectedKey, null);
    assert.equal(reasons.unreadableLabel, 1);
  });

  it("caps per scrip and counts the remainder", () => {
    const qs = BSE_QUARTER_LABELS.map((l, i) => quarter(l, String(200 - i)));
    const { pending, reasons } = pendingBseQuarters(qs, new Set(), 2);
    assert.equal(pending.length, 2);
    assert.equal(reasons.overCap, 3);
    // Newest first — BSE serves the index that way and the order is preserved.
    assert.deepEqual(
      pending.map((p) => p.quarter.label),
      ["June 2026", "March 2026"],
    );
  });

  it("keeps the fractional revision qtrId as a STRING, byte-for-byte", () => {
    // `130.01` is a re-filed June 2026; round-tripping it through a JS number
    // yields "130.01" only by luck of formatting.
    const { pending } = pendingBseQuarters(
      [quarter("June 2026", "130.01", "Revised")],
      new Set(),
      2,
    );
    assert.equal(pending[0]!.quarter.qtrId, "130.01");
  });

  it("a scrip with nothing new yields nothing — the steady state, not a failure", () => {
    const { pending } = pendingBseQuarters(
      [quarter("June 2026", "130")],
      new Set(["2026-06"]),
      2,
    );
    assert.deepEqual(pending, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LEG 6 — identity
// ═════════════════════════════════════════════════════════════════════════════

describe("buildBseScripIndex — the lookup is established ONCE, not per symbol", () => {
  const master = [
    { scripId: "RELIANCE", scripCode: "500325", isin: "INE002A01018" },
    { scripId: "ABB", scripCode: "500002", isin: "INE117A01022" },
    { scripId: "ODDNAME", scripCode: "500999", isin: "INE999Z01011" },
    // Two scrips sharing one ISIN — the ambiguous case.
    { scripId: "TWINA", scripCode: "501111", isin: "INE888A01011" },
    { scripId: "TWINB", scripCode: "501112", isin: "INE888A01011" },
  ];

  it("resolves by symbol first (10,254 of 10,604 prod BSE actives do)", () => {
    const idx = buildBseScripIndex(master, [
      { symbol: "RELIANCE" },
      { symbol: "ABB" },
    ]);
    assert.equal(idx.bySymbol.get("RELIANCE"), "500325");
    assert.equal(idx.bySymbol.get("ABB"), "500002");
    assert.equal(idx.resolvedBySymbol, 2);
    assert.equal(idx.resolvedByIsin, 0);
  });

  it("falls back to an UNAMBIGUOUS isin when the symbol does not match", () => {
    const idx = buildBseScripIndex(master, [
      { symbol: "RENAMEDCO", isin: "INE999Z01011" },
    ]);
    assert.equal(idx.bySymbol.get("RENAMEDCO"), "500999");
    assert.equal(idx.resolvedByIsin, 1);
    assert.equal(idx.resolvedBySymbol, 0);
  });

  it("REFUSES an ambiguous isin rather than letting iteration order decide", () => {
    const idx = buildBseScripIndex(master, [
      { symbol: "UNKNOWNCO", isin: "INE888A01011" },
    ]);
    assert.equal(idx.bySymbol.has("UNKNOWNCO"), false);
    assert.equal(idx.ambiguousIsin, 1);
    assert.equal(idx.resolvedByIsin, 0);
  });

  it("counts what it could not place instead of dropping it silently", () => {
    const idx = buildBseScripIndex(master, [
      { symbol: "NOSUCHCO" },
      { symbol: "ALSONONE", isin: "INE000X01019" },
    ]);
    assert.equal(idx.unresolved, 2);
    assert.equal(idx.bySymbol.size, 0);
  });

  it("normalises case and the Yahoo suffix on both sides", () => {
    const idx = buildBseScripIndex(master, [{ symbol: "reliance.BO" }]);
    assert.equal(idx.bySymbol.get("RELIANCE"), "500325");
  });

  it("is order-independent — the master has no guaranteed serialisation", () => {
    const a = buildBseScripIndex(master, [{ symbol: "RELIANCE" }]);
    const b = buildBseScripIndex([...master].reverse(), [
      { symbol: "RELIANCE" },
    ]);
    assert.equal(a.bySymbol.get("RELIANCE"), b.bySymbol.get("RELIANCE"));
  });

  it("survives a master row with no scrip code", () => {
    const idx = buildBseScripIndex(
      [{ scripId: "GHOST", scripCode: "", isin: null }],
      [{ symbol: "GHOST" }],
    );
    assert.equal(idx.bySymbol.size, 0);
    assert.equal(idx.unresolved, 1);
  });
});

describe("buildBseShpQueue — dual listings are IN, unlike the NSE queue", () => {
  const scrip = new Map([
    ["RELIANCE", "500325"],
    ["ABB", "500002"],
    ["TINYCO", "540111"],
  ]);

  it("KEEPS a dual-listed symbol — BSE files its own pattern for it", () => {
    // `buildOwnershipQueue` collapses RELIANCE onto its NSE identity because the
    // NSE endpoints accept no other. This queue must do the opposite, or BSE's
    // statement about the 2,465 largest names is thrown away.
    const q = buildBseShpQueue(
      [
        { symbol: "RELIANCE", exchange: "NSE" },
        { symbol: "RELIANCE", exchange: "BSE" },
        { symbol: "TINYCO", exchange: "BSE" },
      ],
      scrip,
      new Map([["RELIANCE", OWNERSHIP_TIER.NIFTY50]]),
    );
    assert.ok(q.symbols.includes("RELIANCE"));
    assert.equal(q.scripBySymbol.get("RELIANCE"), "500325");
  });

  it("borrows the NSE tier so a Nifty 50 name's BSE listing is fetched first", () => {
    const q = buildBseShpQueue(
      [
        { symbol: "TINYCO", exchange: "BSE" },
        { symbol: "ABB", exchange: "BSE" },
        { symbol: "RELIANCE", exchange: "BSE" },
      ],
      scrip,
      new Map([
        ["RELIANCE", OWNERSHIP_TIER.NIFTY50],
        ["ABB", OWNERSHIP_TIER.NIFTY500],
      ]),
    );
    assert.deepEqual(q.symbols, ["RELIANCE", "ABB", "TINYCO"]);
    assert.deepEqual(q.tierCounts, { nifty50: 1, nifty500: 1, bseOnly: 1 });
  });

  it("EXCLUDES NSE-only rows — this leg cannot address them", () => {
    const q = buildBseShpQueue(
      [{ symbol: "NSEONLY", exchange: "NSE" }],
      scrip,
      new Map(),
    );
    assert.deepEqual(q.symbols, []);
    // Not counted as unresolved either: it was never a BSE listing.
    assert.equal(q.unresolved, 0);
  });

  it("counts a BSE listing whose scrip code the master could not supply", () => {
    const q = buildBseShpQueue(
      [{ symbol: "MISSINGCO", exchange: "BSE" }],
      scrip,
      new Map(),
    );
    assert.deepEqual(q.symbols, []);
    assert.equal(q.unresolved, 1);
  });

  it("is stable under input order — the universe query has no guaranteed order", () => {
    const rows = [
      { symbol: "TINYCO", exchange: "BSE" },
      { symbol: "ABB", exchange: "BSE" },
      { symbol: "RELIANCE", exchange: "BSE" },
    ];
    const tiers = new Map([["RELIANCE", OWNERSHIP_TIER.NIFTY50]]);
    assert.deepEqual(
      buildBseShpQueue(rows, scrip, tiers).symbols,
      buildBseShpQueue([...rows].reverse(), scrip, tiers).symbols,
    );
  });

  it("every queued symbol carries a scrip code — the walk cannot address one without", () => {
    const q = buildBseShpQueue(
      [
        { symbol: "RELIANCE", exchange: "BSE" },
        { symbol: "MISSINGCO", exchange: "BSE" },
      ],
      scrip,
      new Map(),
    );
    for (const s of q.symbols) {
      assert.equal(
        typeof q.scripBySymbol.get(s),
        "string",
        `${s} has no scrip`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The machinery both legs ADOPT rather than reinvent
// ═════════════════════════════════════════════════════════════════════════════

describe("a 0-row leg is NOT COMPLETED — for the new legs too", () => {
  const healthyBase = {
    totalWritten: 100,
    writeFailed: 0,
    symbolsAttempted: 200,
    symbolsFailed: 0,
    missingModels: [] as string[],
  };

  it("REFUSES to call a barren shpXbrl leg COMPLETED", () => {
    const v = decideRunStatus({
      ...healthyBase,
      totalWritten: 0,
      legs: [
        {
          leg: "shpXbrl",
          fetched: 300,
          emptyResponses: 5,
          rows: 0,
          written: 0,
        },
      ],
    });
    assert.notEqual(v.status, "COMPLETED");
    assert.deepEqual(v.barrenLegs, ["shpXbrl"]);
    assert.ok(v.notes.join(" ").includes("parser/shape failure"));
  });

  it("REFUSES to call a barren bse leg COMPLETED", () => {
    const v = decideRunStatus({
      ...healthyBase,
      totalWritten: 0,
      legs: [
        { leg: "bse", fetched: 250, emptyResponses: 0, rows: 0, written: 0 },
      ],
    });
    assert.notEqual(v.status, "COMPLETED");
    assert.deepEqual(v.barrenLegs, ["bse"]);
  });

  it("PARTIAL when the new leg is barren but the old ones worked", () => {
    const v = decideRunStatus({
      ...healthyBase,
      legs: [
        {
          leg: "shareholding",
          fetched: 400,
          emptyResponses: 10,
          rows: 380,
          written: 380,
        },
        {
          leg: "shpXbrl",
          fetched: 300,
          emptyResponses: 0,
          rows: 0,
          written: 0,
        },
      ],
    });
    assert.equal(v.status, "PARTIAL");
  });

  it("a STEADY-STATE bse run — every scrip up to date — IS completed", () => {
    // This is the counter-test for the discoveryFetched/discoveryEmpty split.
    // In the steady state a run is ~700 quarter-index calls finding nothing new
    // and ZERO data fetches. If those index calls were counted in `fetched`,
    // this run would be judged barren and report PARTIAL every quiet day.
    const v = decideRunStatus({
      ...healthyBase,
      totalWritten: 0,
      legs: [
        { leg: "bse", fetched: 0, emptyResponses: 0, rows: 0, written: 0 },
      ],
    });
    assert.equal(v.status, "COMPLETED");
    assert.deepEqual(v.barrenLegs, []);
  });

  it("a quiet handful of filings is NOT barren — below the payload floor", () => {
    const v = decideRunStatus({
      ...healthyBase,
      totalWritten: 0,
      legs: [
        { leg: "shpXbrl", fetched: 6, emptyResponses: 1, rows: 0, written: 0 },
      ],
    });
    assert.equal(v.status, "COMPLETED");
  });

  it("FAILED when ShareholdingBreakdown has not been migrated", () => {
    const v = decideRunStatus({
      ...healthyBase,
      totalWritten: 0,
      legs: [
        {
          leg: "shpXbrl",
          fetched: 30,
          emptyResponses: 0,
          rows: 30,
          written: 0,
        },
      ],
      missingModels: ["ShareholdingBreakdown"],
    });
    assert.equal(v.status, "FAILED");
    assert.ok(v.notes.join(" ").includes("ShareholdingBreakdown"));
  });
});

describe("the new legs reuse the cursor arithmetic on their OWN queue", () => {
  // Leg 5's queue is the symbols that owe a filing; leg 6's is the BSE actives.
  // Neither is the universe queue, and the point of these is that the SAME
  // functions serve all three because the queue is a parameter.
  const shpQueue = ["AAA", "BBB", "CCC", "DDD"];
  const bseQueue = ["500002", "500325", "540111"].map((_, i) => `SYM${i}`);

  it("resumes leg 5 by symbol on a queue that SHRANK as symbols completed", () => {
    // AAA and BBB finished, so they left the pending queue between runs.
    const at = resolveCursorIndex(["CCC", "DDD"], {
      index: 2,
      lastSymbol: "BBB",
    });
    // BBB is gone -> fall back to the index, clamped. Wasteful, never blinding.
    assert.equal(at, 0);
  });

  it("resumes exactly after the last symbol when it is still pending", () => {
    assert.equal(
      resolveCursorIndex(shpQueue, { index: 99, lastSymbol: "BBB" }),
      2,
    );
  });

  it("advances by what the leg CONSUMED, on the leg's own queue length", () => {
    const next = advanceCursor(bseQueue, 0, 2);
    assert.deepEqual(next, { index: 2, lastSymbol: "SYM1" });
  });

  it("wraps a completed leg pass straight into the next one", () => {
    const next = advanceCursor(shpQueue, 2, 2);
    assert.deepEqual(next, { index: 0, lastSymbol: "DDD" });
    assert.equal(resolveCursorIndex(shpQueue, next), 0);
  });

  it("slices without repeating a symbol inside one run", () => {
    const slice = sliceQueue(shpQueue, 3, 2000);
    assert.equal(new Set(slice).size, slice.length);
    assert.equal(slice.length, shpQueue.length);
  });

  it("projects each leg against ITS OWN length, not the universe's", () => {
    // The measured shipped numbers. Both must land inside the 7-day alert.
    const shpXbrl = projectedPassDays(440, 197, 4);
    const bse = projectedPassDays(10_604, 262, 6);
    assert.ok(shpXbrl !== null && shpXbrl < 1, `shpXbrl ${shpXbrl}`);
    assert.ok(bse !== null && bse < 7, `bse ${bse}`);
    // Projected against the UNIVERSE length instead, bse would read as 11.8
    // days and fire a coverage alert it does not deserve.
    const wrong = projectedPassDays(18_576, 262, 6);
    assert.ok(wrong !== null && wrong > 7, `wrong ${wrong}`);
  });

  it("an EMPTY leg-5 queue is 0 days, not unknown — that is the goal state", () => {
    assert.equal(projectedPassDays(0, 0, 4), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The two writers cannot collide — a structural read of the processor
// ═════════════════════════════════════════════════════════════════════════════

describe("BSE rows are stamped BSE and cannot overwrite an NSE row", () => {
  const SRC = readFileSync(
    join(import.meta.dirname, "..", "src", "processors", "ownership-sync.ts"),
    "utf8",
  );

  it("the two provenance constants are DIFFERENT values", () => {
    assert.match(SRC, /const SHAREHOLDING_EXCHANGE = "NSE";/);
    assert.match(SRC, /const BSE_SHAREHOLDING_EXCHANGE = "BSE";/);
  });

  it("every write inside runBseSymbol passes BSE_SHAREHOLDING_EXCHANGE", () => {
    const body = functionBody(SRC, "async function runBseSymbol(");
    assert.ok(body.length > 200, "could not read runBseSymbol");
    assert.ok(
      body.includes("BSE_SHAREHOLDING_EXCHANGE"),
      "runBseSymbol does not stamp the BSE exchange",
    );
    assert.ok(
      !/\bSHAREHOLDING_EXCHANGE\b(?<!BSE_SHAREHOLDING_EXCHANGE)/.test(
        body.replace(/BSE_SHAREHOLDING_EXCHANGE/g, "«bse»"),
      ),
      "runBseSymbol reaches for the NSE exchange constant",
    );
    assert.ok(
      body.includes('"BSE_SHP"'),
      "runBseSymbol does not stamp the BSE source",
    );
  });

  it("a dual-listed symbol produces two DISTINCT unique keys", () => {
    // `ShareholdingPattern` and `ShareholdingBreakdown` are both unique on
    // (symbol, exchange, quarter). Before `exchange` joined that key the first
    // BSE write would have upserted straight over the NSE row for all 2,465
    // dual-listed symbols — an ERASURE, and a silent one.
    const key = (exchange: string) => `RELIANCE|${exchange}|2026-06`;
    assert.notEqual(key("NSE"), key("BSE"));
  });

  it("the parse's null branch returns BEFORE either write, with no second gate", () => {
    const body = functionBody(SRC, "async function runBseSymbol(");
    const nullGate = body.indexOf("if (parse === null)");
    const firstWrite = Math.min(
      ...["writeShareholding(", "writeBreakdown("]
        .map((w) => body.indexOf(w))
        .filter((i) => i >= 0),
    );
    assert.ok(nullGate > 0, "no null gate in runBseSymbol");
    assert.ok(
      nullGate < firstWrite,
      "a write is reachable before the parse-null gate",
    );
    // No second, looser check upstream of the parser. `Table1` has six
    // fully-populated zero rows in the skeleton, so a length test there would
    // PASS the fabrication and read as a corroborating guard.
    assert.ok(
      !/Table1/.test(body),
      "runBseSymbol inspects the data table itself — the gate is the parser's",
    );
  });
});

describe("leg 5 gates the sentinel upstream of the request", () => {
  const SRC = readFileSync(
    join(import.meta.dirname, "..", "src", "processors", "ownership-sync.ts"),
    "utf8",
  );

  it("runShpXbrlSymbol fetches ONLY what pendingShpFilings selected", () => {
    const body = functionBody(SRC, "async function runShpXbrlSymbol(");
    assert.ok(body.length > 200, "could not read runShpXbrlSymbol");
    const gate = body.indexOf("pendingShpFilings(");
    const fetch = body.indexOf("fetchShpXml(");
    assert.ok(gate > 0, "runShpXbrlSymbol does not call pendingShpFilings");
    assert.ok(fetch > 0, "runShpXbrlSymbol does not fetch");
    assert.ok(gate < fetch, "the fetch precedes the selection gate");
    assert.ok(
      body.includes("candidate.url"),
      "the fetch does not read its url from a selected candidate",
    );
  });

  it("the reconcile runs BEFORE the breakdown write, not after", () => {
    const body = functionBody(SRC, "async function runShpXbrlSymbol(");
    const reconcile = body.indexOf("reconcileWithSummary(");
    const decide = body.indexOf("decideBreakdownWrite(");
    const write = body.indexOf("writeBreakdown(");
    assert.ok(reconcile > 0 && decide > reconcile && write > decide);
    assert.ok(
      body.includes("if (!decision.write)"),
      "the decision does not gate the write",
    );
  });

  it("fetchShpXml is the only caller of getFeedAsset for this feed", () => {
    assert.equal(
      (SRC.match(/getFeedAsset\(/g) ?? []).length,
      1,
      "a second getFeedAsset call site would bypass the sentinel gate",
    );
  });
});

describe("the new legs are WIRED into the run verdict, not merely defined", () => {
  const SRC = stripComments(
    readFileSync(
      join(import.meta.dirname, "..", "src", "processors", "ownership-sync.ts"),
      "utf8",
    ),
  );

  it("ALL_LEGS carries both — it is what decideRunStatus is handed", () => {
    // `decideRunStatus` is called with `ALL_LEGS.filter((l) => legs.has(l))`, so
    // a leg missing from that array is a leg whose barren outcome can never be
    // judged: it would fetch, parse nothing, and the run would still report
    // COMPLETED. That is the exact 2026-08-16 shape the verdict exists to
    // refuse, one leg further along.
    const arr = /const ALL_LEGS: OwnershipLeg\[\] = \[([\s\S]*?)\];/.exec(SRC);
    assert.ok(arr, "ALL_LEGS not found");
    assert.ok(arr[1]!.includes('"shpXbrl"'), "shpXbrl missing from ALL_LEGS");
    assert.ok(arr[1]!.includes('"bse"'), "bse missing from ALL_LEGS");
    assert.match(SRC, /legs: ALL_LEGS\.filter\(\(l\) => legs\.has\(l\)\)/);
  });

  it("WALKING_LEGS carries both — it is what the budget is divided by", () => {
    // Out of this array, a leg gets no slice, no cursor and no share of the
    // wall clock; in it but absent from the divisor, the last legs run on
    // whatever the earlier ones left.
    const arr = /const WALKING_LEGS = \[([\s\S]*?)\] as const/.exec(SRC);
    assert.ok(arr, "WALKING_LEGS not found");
    assert.ok(arr[1]!.includes('"shpXbrl"'));
    assert.ok(arr[1]!.includes('"bse"'));
    assert.match(
      SRC,
      /walkLegs\.length > 0 \? Math\.floor\(budgetMs \/ walkLegs\.length\)/,
    );
  });

  it("each leg's pass is projected against ITS OWN queue length", () => {
    assert.match(SRC, /queueLength: legSymbols\.length/);
    assert.match(SRC, /projectedPassDays\(\s*w\.queueLength,/);
  });

  it("ShareholdingBreakdown is probed, so the coverage guard can see the write", () => {
    // packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts reads
    // this exact `probe("…")` form to prove a PROD_ONLY writer's table reaches
    // QA. The literal-delegate regex finds nothing in this file.
    assert.match(SRC, /probe\("shareholdingBreakdown"\)/);
  });
});

/**
 * Read one function's body by brace-matching from its declaration.
 *
 * Anchored on the RETURN-TYPE brace, not on the first `{` after the name: both
 * of these functions take an inline object type for their context parameter, so
 * "first brace" lands inside the parameter list and yields a ~200-char type
 * literal that every `includes()` below would then read as an absence.
 */
function functionBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  if (start < 0) return "";
  const sig = src.indexOf("): Promise<void> {", start);
  if (sig < 0) return "";
  let depth = 0;
  let i = src.indexOf("{", sig);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return stripComments(src.slice(from, i + 1));
    }
  }
  return "";
}

/**
 * Drop WHOLE-LINE comments and block comments, so prose about a thing never
 * counts as the thing.
 *
 * Same rule (and same regex) as
 * packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts, adopted
 * for the same reason it exists there: without it, the comment in
 * `runBseSymbol` explaining WHY there is no `Table1` length check is itself read
 * as a `Table1` length check. A test that agrees with a comment instead of the
 * code is not a test. Whole-line only, so a `https://` inside a string literal
 * survives.
 */
function stripComments(src: string): string {
  return src
    .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
