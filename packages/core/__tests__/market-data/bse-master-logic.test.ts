/**
 * BSE scrip master parsing + enrichment planning (MONEY-1093).
 *
 * The BSE group letter is the only signal that separates a bond from an equity
 * on that exchange, and the daily bhavcopy only carries what TRADED — 4,845
 * rows against ~12,600 active BSE instruments. The scrip master closes that gap
 * in one pass.
 *
 * The load-bearing property is that this is UPDATE-ONLY. `syncInstruments`
 * upserts on symbol_exchange, so a provider whose symbols disagree with ours
 * CREATES rows; against 12,600 rows that is thousands of potential duplicate
 * instruments, and the real overlap could not be measured. The planner can only
 * ever name an id that came out of the stored set — the last describe block
 * pins that.
 *
 * Counts quoted below are measured from the live endpoint on 2026-07-30.
 *
 * Source: packages/core/src/market-data/instruments/bse-master-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseBseFeed,
  parseBseMasterJson,
  classifyBseMasterRow,
  planBseMasterEnrichment,
  BSE_SEGMENT_CLASS,
  type BseMasterRow,
  type StoredBseInstrument,
  namesCorroborate,
  normaliseCompanyName,
} from "../../src/market-data/instruments/bse-master-logic";

function apiRow(over: Record<string, unknown> = {}) {
  return {
    SCRIP_CD: "500002",
    Scrip_Name: "ABB India Ltd",
    Status: "Active",
    GROUP: "A",
    ISIN_NUMBER: "INE117A01022",
    scrip_id: "ABB",
    Segment: "Equity",
    ...over,
  };
}
function row(over: Partial<BseMasterRow> = {}): BseMasterRow {
  return {
    scripId: "ABB",
    scripCode: "500002",
    name: "ABB India Ltd",
    group: "A",
    isin: "INE117A01022",
    segment: "Equity",
    status: "Active",
    ...over,
  };
}
function stored(
  id: string,
  symbol: string,
  isin: string | null = null,
  series: string | null = null,
  // Defaults to the master fixture's name, because a REAL stored row always has
  // one — and the identity check needs it. Before this ticket the planner would
  // write `series` and `isin` on a bare `scrip_id === tradingsymbol` guess with
  // nothing corroborating it, so these fixtures did not need a name; now an
  // uncorroborated match is deliberately withheld, and a nameless fixture would
  // be testing a row shape that does not occur.
  name: string | null = "ABB India Ltd",
): StoredBseInstrument {
  return { id, symbol, isin, series, name };
}

describe("parseBseMasterJson", () => {
  it("normalises a well-formed row", () => {
    const [r] = parseBseMasterJson(JSON.stringify([apiRow()]));
    assert.equal(r!.scripId, "ABB");
    assert.equal(r!.group, "A");
    assert.equal(r!.isin, "INE117A01022");
    assert.equal(r!.segment, "Equity");
  });

  it("upper-cases and trims the match keys", () => {
    // scrip_id and ISIN are join keys — a stray space silently loses the match.
    const [r] = parseBseMasterJson(
      JSON.stringify([
        apiRow({
          scrip_id: " abb ",
          ISIN_NUMBER: " ine117a01022 ",
          GROUP: " a ",
        }),
      ]),
    );
    assert.equal(r!.scripId, "ABB");
    assert.equal(r!.isin, "INE117A01022");
    assert.equal(r!.group, "A");
  });

  it("drops rows with no scrip_id — nothing to match on", () => {
    assert.equal(
      parseBseMasterJson(JSON.stringify([apiRow({ scrip_id: "" })])).length,
      0,
    );
  });

  it("drops rows that are not Active even though we asked for Active", () => {
    // Never trust a filter you did not apply yourself.
    assert.equal(
      parseBseMasterJson(JSON.stringify([apiRow({ Status: "Suspended" })]))
        .length,
      0,
    );
  });

  it("treats a missing ISIN as null rather than an empty string", () => {
    // 1,119 of 12,612 rows have no ISIN. "" would look like a real value to a
    // truthiness check further down.
    const [r] = parseBseMasterJson(
      JSON.stringify([apiRow({ ISIN_NUMBER: null })]),
    );
    assert.equal(r!.isin, null);
  });

  it("returns [] on malformed JSON instead of throwing", () => {
    assert.deepEqual(parseBseMasterJson("<html>404</html>"), []);
  });

  it("returns [] when the payload is not an array", () => {
    assert.deepEqual(parseBseMasterJson('{"Table":[]}'), []);
  });

  it("skips junk entries without losing the good ones", () => {
    const out = parseBseMasterJson(
      JSON.stringify([null, "nope", apiRow({ scrip_id: "TCS" })]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.scripId, "TCS");
  });
});

describe("classifyBseMasterRow — segment is stronger than the group letter", () => {
  it("types the three debt segments as DEBT", () => {
    // Measured: Debentures and Bonds 5,374 · Commercial Papers 847 ·
    // PreferenceShares 13.
    for (const seg of [
      "Debentures and Bonds",
      "Commercial Papers",
      "PreferenceShares",
    ]) {
      const r = classifyBseMasterRow(row({ segment: seg, group: "F" }));
      assert.equal(r.klass, "DEBT", `${seg} should be DEBT`);
    }
  });

  it("reports the segment in the reason so a decision is auditable", () => {
    assert.equal(
      classifyBseMasterRow(row({ segment: "Debentures and Bonds" })).reason,
      "bse-segment-Debentures and Bonds",
    );
  });

  it("types the Equity segment as EQUITY", () => {
    assert.equal(classifyBseMasterRow(row()).klass, "EQUITY");
  });

  it("falls back to the group letter when the segment is blank", () => {
    // 1,119 rows have no segment; F/G still decide those.
    assert.equal(
      classifyBseMasterRow(row({ segment: "", group: "F" })).klass,
      "DEBT",
    );
    assert.equal(
      classifyBseMasterRow(row({ segment: "", group: "B" })).klass,
      "EQUITY",
    );
  });

  it("ABSTAINS when neither the segment nor the group says anything", () => {
    const r = classifyBseMasterRow(row({ segment: "", group: "QQ" }));
    assert.equal(r.klass, "UNKNOWN");
  });

  it("lets a name-identified ETF outrank the Equity segment", () => {
    // BSE files ETFs under Equity, but an ETF compared against operating
    // companies on P/E is the MONEY-1085 bug.
    assert.equal(
      classifyBseMasterRow(
        row({ scripId: "NIFTYBEES", name: "Nippon India ETF Nifty 50 BeES" }),
      ).klass,
      "ETF",
    );
  });

  it("lets a name-identified trust outrank the Equity segment", () => {
    assert.equal(
      classifyBseMasterRow(
        row({ scripId: "NXST", name: "NEXUS SELECT TRUST REIT" }),
      ).klass,
      "REIT",
    );
  });

  it("never maps a segment to EQUITY that BSE calls debt", () => {
    for (const [seg, klass] of Object.entries(BSE_SEGMENT_CLASS)) {
      if (seg === "Equity") continue;
      assert.notEqual(klass, "EQUITY", `${seg} must not be EQUITY`);
    }
  });
});

describe("planBseMasterEnrichment — series", () => {
  it("plans a write when the group differs from the stored series", () => {
    const plan = planBseMasterEnrichment(
      [row({ scripId: "BOND1", group: "F" })],
      [stored("i1", "BOND1", null, "EQ")], // the stamped default
    );
    assert.deepEqual(plan.seriesGroups.get("F"), ["i1"]);
  });

  it("plans nothing when the group already matches", () => {
    // A settled universe must be a no-op, not ~12k writes a night.
    const plan = planBseMasterEnrichment(
      [row({ group: "A" })],
      [stored("i1", "ABB", null, "A")],
    );
    assert.equal(plan.seriesGroups.size, 0);
  });

  it("compares case-insensitively", () => {
    const plan = planBseMasterEnrichment(
      [row({ group: "A" })],
      [stored("i1", "ABB", null, "a")],
    );
    assert.equal(plan.seriesGroups.size, 0);
  });

  it("GROUPS ids by group letter — one updateMany per value", () => {
    const plan = planBseMasterEnrichment(
      [
        row({ scripId: "B1", group: "F" }),
        row({ scripId: "B2", group: "F" }),
        row({ scripId: "E1", group: "A" }),
      ],
      [stored("i1", "B1"), stored("i2", "B2"), stored("i3", "E1")],
    );
    assert.equal(plan.seriesGroups.size, 2);
    assert.deepEqual(plan.seriesGroups.get("F"), ["i1", "i2"]);
    assert.deepEqual(plan.seriesGroups.get("A"), ["i3"]);
  });

  it("ignores a blank group rather than blanking a stored value", () => {
    const plan = planBseMasterEnrichment(
      [row({ group: "" })],
      [stored("i1", "ABB", null, "A")],
    );
    assert.equal(plan.seriesGroups.size, 0);
  });

  it("does not queue the same instrument twice", () => {
    const plan = planBseMasterEnrichment(
      [row({ scripId: "B1", group: "F" }), row({ scripId: "B1", group: "F" })],
      [stored("i1", "B1")],
    );
    assert.deepEqual(plan.seriesGroups.get("F"), ["i1"]);
  });
});

describe("planBseMasterEnrichment — ISIN", () => {
  it("writes an ISIN when the stored row has none", () => {
    const plan = planBseMasterEnrichment([row()], [stored("i1", "ABB", null)]);
    assert.deepEqual(plan.isinUpdates, [{ id: "i1", isin: "INE117A01022" }]);
  });

  it("NEVER overwrites an existing ISIN, even a different one", () => {
    // DailyPrice has no exchange column, so repointing an instrument writes
    // prices onto the wrong listing.
    const plan = planBseMasterEnrichment(
      [row()],
      [stored("i1", "ABB", "INE999Z01099")],
    );
    assert.equal(plan.isinUpdates.length, 0);
  });

  it("treats an empty stored ISIN as absent", () => {
    const plan = planBseMasterEnrichment([row()], [stored("i1", "ABB", "")]);
    assert.equal(plan.isinUpdates.length, 1);
  });

  it("plans nothing when the master has no ISIN either", () => {
    const plan = planBseMasterEnrichment(
      [row({ isin: null })],
      [stored("i1", "ABB", null)],
    );
    assert.equal(plan.isinUpdates.length, 0);
  });
});

describe("planBseMasterEnrichment — matching and the UPDATE-ONLY invariant", () => {
  it("matches by symbol", () => {
    const plan = planBseMasterEnrichment([row()], [stored("i1", "ABB")]);
    assert.equal(plan.matched, 1);
    assert.equal(plan.unmatched, 0);
  });

  it("falls back to ISIN when the symbol does not match", () => {
    // The exact risk this design exists to absorb: BSE's scrip_id and Kite's
    // tradingsymbol do not always agree.
    const plan = planBseMasterEnrichment(
      [row({ scripId: "ABBIND" })],
      [stored("i1", "ABB", "INE117A01022")],
    );
    assert.equal(plan.matched, 1);
    assert.equal(plan.unmatched, 0);
  });

  it("COUNTS an unmatched master row and plans nothing for it", () => {
    const plan = planBseMasterEnrichment(
      [row({ scripId: "GHOST", isin: "INE000X01011" })],
      [],
    );
    assert.equal(plan.unmatched, 1);
    assert.equal(plan.matched, 0);
    assert.equal(plan.seriesGroups.size, 0);
    assert.equal(plan.isinUpdates.length, 0);
  });

  it("can only ever name an id that came from the stored set", () => {
    // THE invariant. If this ever fails, the enricher has become capable of
    // creating rows, which is the 12,600-duplicate-instrument failure mode.
    const storedRows = [stored("i1", "B1"), stored("i2", "B2")];
    const ids = new Set(storedRows.map((s) => s.id));
    const plan = planBseMasterEnrichment(
      [
        row({ scripId: "B1", group: "F", isin: "INE1" }),
        row({ scripId: "B2", group: "G", isin: "INE2" }),
        row({ scripId: "GHOST1", group: "F", isin: "INE9" }),
        row({ scripId: "GHOST2", group: "A", isin: null }),
      ],
      storedRows,
    );
    for (const [, groupIds] of plan.seriesGroups) {
      for (const id of groupIds)
        assert.ok(ids.has(id), `series write named unknown id ${id}`);
    }
    for (const u of plan.isinUpdates) {
      assert.ok(ids.has(u.id), `isin write named unknown id ${u.id}`);
    }
    assert.equal(plan.unmatched, 2);
  });

  it("returns an empty plan for no rows", () => {
    const plan = planBseMasterEnrichment([], [stored("i1", "ABB")]);
    assert.equal(plan.seriesGroups.size, 0);
    assert.equal(plan.isinUpdates.length, 0);
    assert.equal(plan.matched, 0);
  });
});

describe("BSE wraps list payloads inconsistently — all shapes accepted", () => {
  // The endpoint returns a bare array today. The first parser accepted ONLY
  // that, so the day BSE wrapped it the enricher would have reported "0 usable
  // rows" forever behind a console.warn. The repo's own BSE client documents
  // these three shapes.
  it("accepts a bare array", () => {
    assert.equal(parseBseMasterJson(JSON.stringify([apiRow()])).length, 1);
  });

  it("accepts { Table: [...] }", () => {
    assert.equal(
      parseBseMasterJson(JSON.stringify({ Table: [apiRow()] })).length,
      1,
    );
  });

  it("accepts { Table: [...], Table1: [...] } and takes the rows", () => {
    const out = parseBseMasterJson(
      JSON.stringify({
        Table: [apiRow({ scrip_id: "TCS" })],
        Table1: [{ page: 1 }],
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.scripId, "TCS");
  });

  it("skips an EMPTY Table and uses the next non-empty one", () => {
    const out = parseBseMasterJson(
      JSON.stringify({ Table: [], Table1: [apiRow({ scrip_id: "INFY" })] }),
    );
    assert.equal(out[0]?.scripId, "INFY");
  });

  it("still returns [] for a shape with no rows at all", () => {
    assert.deepEqual(parseBseMasterJson(JSON.stringify({ Other: [1] })), []);
    assert.deepEqual(parseBseMasterJson('{"Table":[]}'), []);
  });
});

describe("the group letter is shape-validated before becoming series", () => {
  it("rejects a value that is not 1-2 upper-case letters", () => {
    // `series` is what classifyCashInstrument reads. An encoding change at BSE
    // would otherwise put garbage on ~12,600 rows, after which the classifier
    // abstains on all of them and only the ~4,845 that trade daily are ever
    // repairable.
    for (const bad of ["EQUITY", "A1", "a-b", "123", "ABC"]) {
      const plan = planBseMasterEnrichment(
        [row({ scripId: "X1", group: bad })],
        [stored("i1", "X1", null, "EQ")],
      );
      assert.equal(plan.seriesGroups.size, 0, `"${bad}" must not be written`);
      assert.equal(
        plan.rejectedGroups.get(bad),
        1,
        `"${bad}" must be reported`,
      );
    }
  });

  it("ACCEPTS real groups the allow-list does not know", () => {
    // TS, ZP, IP, Y, R, SE are all present in the live master. They must be
    // stored so the classifier abstains on them VISIBLY — discarding them would
    // hide a real exchange change instead of surfacing it.
    for (const g of ["TS", "ZP", "IP", "Y", "R", "SE"]) {
      const plan = planBseMasterEnrichment(
        [row({ scripId: "X1", group: g })],
        [stored("i1", "X1", null, "EQ")],
      );
      assert.deepEqual(plan.seriesGroups.get(g), ["i1"], `group ${g}`);
    }
  });
});

describe("a symbol match with a DISAGREEING ISIN is not a match", () => {
  it("skips the row and reports the conflict", () => {
    // Both ISINs are already in hand, and this module's header concedes that
    // BSE's scrip_id and Kite's tradingsymbol only "usually" agree. Writing
    // anyway is not minor: a wrong series can type a REAL EQUITY as DEBT, after
    // which the repair script clears its sector/industry irrecoverably.
    const plan = planBseMasterEnrichment(
      [row({ scripId: "ABB", group: "F", isin: "INE999Z01099" })],
      [stored("i1", "ABB", "INE117A01022", "EQ")],
    );
    assert.equal(plan.seriesGroups.size, 0, "must not write a conflicting row");
    assert.equal(plan.isinConflicts.length, 1);
    assert.equal(plan.isinConflicts[0]!.scripId, "ABB");
    // Counted in isinConflicts ONLY. It used to also bump `unmatched`, and the
    // applier reports recordsFailed = unmatched + isinConflicts, so every
    // conflict was reported twice.
    assert.equal(plan.unmatched, 0);
    assert.equal(plan.matched, 0);
  });

  it("still matches when the master has an ISIN and the stored row does not", () => {
    // Absence is not disagreement — that is the case the ISIN backfill exists
    // to fix.
    const plan = planBseMasterEnrichment(
      [row({ scripId: "ABB", group: "A" })],
      [stored("i1", "ABB", null, "EQ")],
    );
    assert.equal(plan.matched, 1);
    assert.equal(plan.isinConflicts.length, 0);
  });

  it("detects two stored rows sharing one ISIN", () => {
    // Same exchange, same ISIN = a stale row left active after a rename, which
    // makes ISIN-fallback resolution ambiguous. Last-wins would hide it.
    const plan = planBseMasterEnrichment(
      [row({ scripId: "ABB", group: "A" })],
      [
        stored("i1", "ABB", "INE117A01022"),
        stored("i2", "ABBOLD", "INE117A01022"),
      ],
    );
    assert.deepEqual(plan.duplicateStoredIsins, ["INE117A01022"]);
  });
});

describe("a rejected group must not cost the row its ISIN", () => {
  it("still writes the ISIN when the group letter fails the shape check", () => {
    // A bare `continue` on a bad group also skipped the ISIN block, so a row
    // with an odd group letter lost a perfectly valid ISIN too. The two
    // decisions are independent.
    const plan = planBseMasterEnrichment(
      [row({ scripId: "X1", group: "EQUITY", isin: "INE117A01022" })],
      [stored("i1", "X1", null, "EQ")],
    );
    assert.equal(plan.seriesGroups.size, 0, "bad group must not be written");
    assert.equal(plan.rejectedGroups.get("EQUITY"), 1, "and must be reported");
    assert.deepEqual(plan.isinUpdates, [{ id: "i1", isin: "INE117A01022" }]);
  });

  it("a BLANK group is not a rejection — it is simply no information", () => {
    const plan = planBseMasterEnrichment(
      [row({ scripId: "X1", group: "", isin: "INE117A01022" })],
      [stored("i1", "X1", null, "EQ")],
    );
    assert.equal(plan.rejectedGroups.size, 0);
    assert.equal(plan.isinUpdates.length, 1);
  });
});

describe("diagnoseBseFeed — a dead feed must be distinguishable from a healthy one", () => {
  const healthy = {
    rowCount: 12612,
    blankGroups: 20,
    rejectedGroups: new Map<string, number>(),
    seriesGroupCount: 0,
    // Rows that MATCHED a stored instrument — the denominator for the rejection
    // share. `rejectedGroups` is only populated for matched rows (the planner
    // `continue`s on a miss before the shape check), so dividing by rowCount
    // measured a numerator and denominator from different populations.
    matched: 12000,
  };

  it("reports NOTHING for a converged universe", () => {
    // THE case two earlier versions got wrong. Once every row has its series
    // and ISIN there is nothing to write — `seriesGroupCount: 0` is SUCCESS,
    // not failure. The previous condition ("matched rows but planned no
    // writes") would have written status FAILED every night for ever after the
    // system started working, with a message reading "not a converged
    // universe".
    assert.equal(diagnoseBseFeed(healthy), null);
  });

  it("reports nothing on a first run with plenty to write", () => {
    assert.equal(diagnoseBseFeed({ ...healthy, seriesGroupCount: 14 }), null);
  });

  it("DETECTS a removed or renamed GROUP column", () => {
    // The real failure: every row comes back with an empty group, so the shape
    // check never even runs and nothing is ever "rejected".
    const msg = diagnoseBseFeed({ ...healthy, blankGroups: 12612 });
    assert.ok(msg, "a fully blank group column must be flagged");
    assert.match(msg!, /renamed or removed/);
  });

  it("detects a MAJORITY-blank group column, not just a fully blank one", () => {
    assert.ok(diagnoseBseFeed({ ...healthy, blankGroups: 6307 }));
    assert.equal(diagnoseBseFeed({ ...healthy, blankGroups: 6306 }), null);
  });

  it("detects a changed group ENCODING", () => {
    const msg = diagnoseBseFeed({
      ...healthy,
      rejectedGroups: new Map([["EQUITY", 9000]]),
      seriesGroupCount: 0,
    });
    assert.ok(msg);
    assert.match(msg!, /encoding/);
  });

  it("is not diluted by a LOW overlap — the denominator is matched rows", () => {
    // The old form divided rejected rows by every FETCHED row. With a small
    // overlap that hides a total failure: 10 fetched, 2 matched, and BOTH
    // rejected is a 100% broken encoding for everything this feed can see, yet
    // it scored 2/10 = 20% — exactly on the threshold, so it returned null.
    const msg = diagnoseBseFeed({
      rowCount: 10,
      blankGroups: 0,
      rejectedGroups: new Map([["EQUITY", 2]]),
      seriesGroupCount: 0,
      matched: 2,
    });
    assert.ok(msg, "a 100% rejection among matched rows must not be silent");
    assert.match(msg!, /encoding/);
  });

  it("catches a SPLIT failure neither threshold sees alone", () => {
    // 50% blank + 20% rejected = 70% of the feed unusable, with each share
    // sitting just inside its own limit. The two checks were independent, so
    // this passed both and reported healthy.
    const msg = diagnoseBseFeed({
      rowCount: 1000,
      blankGroups: 500,
      rejectedGroups: new Map([["EQUITY", 200]]),
      seriesGroupCount: 5,
      matched: 1000,
    });
    assert.ok(msg, "a split failure must still be reported");
    assert.match(msg!, /unusable/);
  });

  it("still says nothing when both shares are genuinely small", () => {
    assert.equal(
      diagnoseBseFeed({
        rowCount: 12612,
        blankGroups: 200,
        rejectedGroups: new Map([["W", 30]]),
        seriesGroupCount: 40,
        matched: 12000,
      }),
      null,
    );
  });

  it("does NOT flag a few odd groups when others still wrote", () => {
    // A handful of unrecognised groups alongside real writes is the normal
    // state — the live master carries TS/ZP/IP/Y/R/SE.
    assert.equal(
      diagnoseBseFeed({
        ...healthy,
        rejectedGroups: new Map([["W", 3]]),
        seriesGroupCount: 12,
      }),
      null,
    );
  });

  it("says nothing for an empty fetch — the caller handles that", () => {
    assert.equal(
      diagnoseBseFeed({ ...healthy, rowCount: 0, blankGroups: 0 }),
      null,
    );
  });
});

describe("namesCorroborate — the identity check that gates every series write", () => {
  /**
   * This decides whether the BSE feed may write `series` on a row matched only
   * by `scrip_id === tradingsymbol`. A false corroboration writes a wrong group
   * letter, which types a REAL EQUITY as DEBT, after which the repair script
   * clears its sector and industry — values that exist nowhere else.
   *
   * It has been wrong twice, in opposite directions, and neither was caught by
   * the existing fixtures because they use the SAME name string on both sides:
   *   1. a raw prefix rule rejected every real same-company pair, because feeds
   *      disagree on LTD vs LIMITED — so nothing was ever corroborated and the
   *      whole enricher went inert;
   *   2. stripping the legal form and keeping the prefix rule then WRONGLY
   *      corroborated "TATA STEEL" with "TATA STEEL LONG PRODUCTS".
   * Hence: real names, both directions, as data.
   */
  const SAME_COMPANY: Array<[string, string]> = [
    ["RELIANCE INDUSTRIES LTD", "Reliance Industries Limited"],
    ["ABB India Ltd", "ABB INDIA LIMITED"],
    ["INFOSYS LIMITED", "Infosys Ltd."],
    ["LARSEN & TOUBRO LTD", "Larsen and Toubro Limited"],
    ["ITC LTD", "ITC Limited"],
    ["HDFC BANK LTD", "HDFC Bank Limited"],
    ["Wipro Ltd", "WIPRO LIMITED"],
    ["BHARTI AIRTEL LTD", "Bharti Airtel Limited"],
  ];

  /** DIFFERENT companies that share a long prefix — the dangerous population. */
  const DIFFERENT_COMPANIES: Array<[string, string]> = [
    ["RELIANCE INDUSTRIES LTD", "RELIANCE POWER LTD"],
    ["RELIANCE INDUSTRIES LTD", "RELIANCE INFRASTRUCTURE LTD"],
    ["TATA STEEL LTD", "TATA STEEL LONG PRODUCTS LTD"],
    ["TATA MOTORS LTD", "TATA MOTORS FINANCE LTD"],
    ["BAJAJ FINANCE LTD", "BAJAJ FINSERV LTD"],
    ["ADANI ENTERPRISES LTD", "ADANI ENERGY SOLUTIONS LTD"],
    ["ADANI PORTS AND SEZ LTD", "ADANI POWER LTD"],
    ["HDFC BANK LTD", "HDFC LIFE INSURANCE CO LTD"],
    ["ICICI BANK LTD", "ICICI PRUDENTIAL LIFE INSURANCE"],
    ["MAHINDRA & MAHINDRA LTD", "MAHINDRA LIFESPACE DEVELOPERS LTD"],
    ["KOTAK MAHINDRA BANK LTD", "KOTAK MAHINDRA CAPITAL CO LTD"],
    ["JSW STEEL LTD", "JSW ENERGY LTD"],
    ["INDIAN OIL CORPORATION LTD", "INDIAN OVERSEAS BANK"],
    ["SUN PHARMACEUTICAL INDS LTD", "SUN TV NETWORK LTD"],
    ["MOTHERSON SUMI WIRING INDIA", "MOTHERSON SUMI SYSTEMS LTD"],
  ];

  it("corroborates the same company spelled two ways", () => {
    const missed = SAME_COMPANY.filter(([a, b]) => !namesCorroborate(a, b));
    assert.deepEqual(
      missed,
      [],
      "these are the SAME company — failing them makes the enricher inert, " +
        "because a first run has no stored ISIN to fall back on either",
    );
  });

  it("does NOT corroborate different companies sharing a prefix", () => {
    const wrong = DIFFERENT_COMPANIES.filter(([a, b]) =>
      namesCorroborate(a, b),
    );
    assert.deepEqual(
      wrong,
      [],
      "a false corroboration writes a wrong series and types a real equity DEBT",
    );
  });

  it("normalises legal form, punctuation and 'and'", () => {
    assert.equal(normaliseCompanyName("Larsen & Toubro Ltd."), "LARSENTOUBRO");
    assert.equal(
      normaliseCompanyName("Larsen and Toubro Limited"),
      "LARSENTOUBRO",
    );
    assert.equal(normaliseCompanyName("Foo Private Limited"), "FOO");
    assert.equal(normaliseCompanyName("Foo Pvt Ltd"), "FOO");
  });

  it("refuses to decide on absent or trivially short names", () => {
    // A blank name must not corroborate ANYTHING — that would make the guard
    // a no-op for exactly the rows with the least information.
    for (const [a, b] of [
      [null, "RELIANCE INDUSTRIES LTD"],
      ["RELIANCE INDUSTRIES LTD", null],
      [undefined, undefined],
      ["", ""],
      ["LTD", "LIMITED"],
      ["A", "A"],
    ] as Array<[string | null | undefined, string | null | undefined]>) {
      assert.equal(namesCorroborate(a, b), false, `${a} / ${b}`);
    }
  });
});

describe("first run against a realistic universe — not inert, still guarded", () => {
  it("writes for corroborated rows and withholds an impostor", () => {
    // The state the corroboration change has to work in: NO stored ISINs
    // anywhere (Kite's dump has no ISIN column, so before this feed runs, every
    // BSE row has a null one), and the two feeds spelling names differently.
    //
    // This is the case a unit test on `namesCorroborate` alone cannot express,
    // and it is the one that went wrong: with a prefix rule, corroboration
    // failed for every row here, so the enricher wrote NOTHING while every test
    // stayed green — an inert guard replaced by an inert feature.
    const master = [
      {
        scripId: "RELIANCE",
        scripCode: "500325",
        name: "RELIANCE INDUSTRIES LTD",
        group: "A",
        isin: "INE002A01018",
        segment: "Equity",
      },
      {
        scripId: "0795GOI32",
        scripCode: "800001",
        name: "7.95% GOI 2032",
        group: "G",
        isin: "IN0020220011",
        segment: "Debt",
      },
      // Same tradingsymbol as a stored row, DIFFERENT company. This is the
      // scrip_id/tradingsymbol collision the whole guard exists for.
      {
        scripId: "IMPOSTOR",
        scripCode: "999999",
        name: "SOME OTHER COMPANY LTD",
        group: "G",
        isin: "INE999Z01099",
        segment: "Debt",
      },
    ];
    const stored = [
      {
        id: "i1",
        symbol: "RELIANCE",
        isin: null,
        series: "EQ",
        name: "Reliance Industries Limited",
      },
      {
        id: "i3",
        symbol: "0795GOI32",
        isin: null,
        series: "EQ",
        name: "7.95% GOI 2032",
      },
      {
        id: "i4",
        symbol: "IMPOSTOR",
        isin: null,
        series: "EQ",
        name: "Totally Unrelated Industries Ltd",
      },
    ];

    const plan = planBseMasterEnrichment(master as never, stored as never);
    const written = [...plan.seriesGroups.values()].flat();

    assert.ok(
      written.length > 0,
      "the feed must write on a first run — CLAUDE.md specifies complete " +
        "coverage after ONE run, not accumulation over ~10 trading days",
    );
    assert.ok(written.includes("i1"), "a corroborated equity gets its group");
    assert.ok(written.includes("i3"), "the real G-Sec gets its DEBT group");
    assert.ok(
      !written.includes("i4"),
      "the impostor must be WITHHELD — a wrong G here types a real equity " +
        "DEBT and the repair script then destroys its sector",
    );
    assert.equal(plan.uncorroborated, 1, "and the withholding is COUNTED");

    // The ISIN half follows the same gate, for the same reason: a wrong ISIN
    // repoints an instrument and writes another security's close onto it.
    const isinIds = plan.isinUpdates.map((u) => u.id);
    assert.ok(isinIds.includes("i1"));
    assert.ok(!isinIds.includes("i4"), "no ISIN for an uncorroborated match");
  });
});
