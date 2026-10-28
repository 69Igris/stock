/**
 * UNIT TEST — institutional deals + SLB open positions (MONEY-1100 P4.6).
 *
 * Deal fixtures are cut from REAL archived NSE bytes:
 *   bulk_deals.sample.csv   <- feeds/NSE/bulk-deals/…  (rows dated 07-AUG-2026)
 *   block_deals.sample.csv  <- feeds/NSE/block-deals/… (rows dated 10-AUG-2026)
 * so the assertions below are against what NSE actually published, including
 * the two things the published column list in docs/reference/
 * per-file-derivable-map.md §5 gets wrong (see "map contradictions" below).
 *
 * The SLB fixture is real too, as of MONEY-1200:
 *   slb_openpos.sample.csv  <- archives/slbs/open_pos/slb_openpos_13082026.csv
 * It replaces a SYNTHETIC block written while the family's registry URL was
 * wrong (it probed 404 on 2026-08-08 because the path said `openpos` where NSE
 * publishes `open_pos`). That synthetic fixture guessed the header as
 * `Symbol,Series,Open Position,Value` and was wrong on three of four columns
 * while passing green — which is the argument for cutting fixtures from bytes.
 *
 * ## Map contradictions this file pins
 *
 * 1. `block.csv` has NO `Remarks` column. The map lists eight columns for both
 *    families; the archived block file has seven. `remarks` is null for every
 *    block row as a result — absence of a column, not a `-` value.
 * 2. The two rolling snapshots disagree with each other on date (Fri 07-AUG vs
 *    Mon 10-AUG) despite being cut in the same pass, which is the evidence that
 *    `expectedDate` must NOT filter deal rows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseBulkBlockDeals,
  parseSlbOpenPositions,
  exactDealKey,
  type InstitutionalDealRow,
} from "../../src/market-data/deals";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const BULK_CSV = readFileSync(join(FIXTURES, "bulk_deals.sample.csv"), "utf-8");
const BLOCK_CSV = readFileSync(
  join(FIXTURES, "block_deals.sample.csv"),
  "utf-8",
);

const AUG7 = new Date(Date.UTC(2026, 7, 7)); // Friday
const AUG10 = new Date(Date.UTC(2026, 7, 10)); // Monday
const AUG11 = new Date(Date.UTC(2026, 7, 11)); // Tuesday

const DEAL_HEADER =
  "Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks";

// ─── Bulk deals: the real archived file ──────────────────────────────

describe("parseBulkBlockDeals — real NSE bulk.csv rows", () => {
  const out = parseBulkBlockDeals(BULK_CSV, "BULK", AUG7);

  it("parses every fixture row with nothing skipped", () => {
    assert.equal(out.rows.length, 7);
    assert.equal(out.skipped, 0);
    assert.equal(out.dateMismatch, 0);
  });

  it("reads a row exactly as published", () => {
    const r = out.rows[0]!;
    assert.equal(r.date.toISOString().slice(0, 10), "2026-08-07");
    assert.equal(r.symbol, "AASTHA");
    assert.equal(r.securityName, "Aastha Spintex Limited");
    assert.equal(r.clientName, "HRTI PRIVATE LIMITED");
    assert.equal(r.buySell, "BUY");
    assert.equal(r.qty, 523452);
    assert.equal(r.avgPrice, 76.72);
    assert.equal(r.dealType, "BULK");
    assert.equal(r.exchange, "NSE");
    assert.equal(r.remarks, null, "`-` is absence, not the string '-'");
  });

  it("keeps trailing-zero prices as their numeric value", () => {
    const aris = out.rows.find((r) => r.symbol === "ARIS")!;
    assert.equal(aris.avgPrice, 133, "133.00 parses to 133");
    const arv = out.rows.find(
      (r) => r.clientName === "NK SECURITIES RESEARCH PRIVATE LIMITED",
    )!;
    assert.equal(arv.avgPrice, 664.1);
    assert.equal(arv.qty, 309995);
  });

  it("carries the dealType handed in, because the bytes cannot say", () => {
    // bulk.csv and block.csv are shape-identical — nothing in either file
    // identifies which one it is. Parsing the SAME bytes as BLOCK must produce
    // BLOCK rows, which is exactly why the wiring table lives at the call site.
    const asBlock = parseBulkBlockDeals(BULK_CSV, "BLOCK", AUG7);
    assert.equal(asBlock.rows.length, 7);
    assert.ok(asBlock.rows.every((r) => r.dealType === "BLOCK"));
  });
});

// ─── Block deals: the seven-column archived file ─────────────────────

describe("parseBulkBlockDeals — real NSE block.csv rows", () => {
  const out = parseBulkBlockDeals(BLOCK_CSV, "BLOCK", AUG10);

  it("parses a file that has NO Remarks column at all", () => {
    // MAP CONTRADICTION #1: map §5 lists `Remarks` for both families; the
    // archived block file stops at the price column. The archived file wins.
    assert.equal(out.rows.length, 2);
    assert.equal(out.skipped, 0);
    assert.ok(
      out.rows.every((r) => r.remarks === null),
      "an absent column yields null, and must not fail the row",
    );
  });

  it("keeps BOTH legs of one block print as separate rows", () => {
    // Same symbol, same quantity, same price, same day — the buy and the sell
    // side of a single crossed block. A key that ignored client or side would
    // collapse them and halve the reported institutional flow.
    const buy = out.rows.find((r) => r.buySell === "BUY")!;
    const sell = out.rows.find((r) => r.buySell === "SELL")!;

    assert.equal(buy.symbol, "EIDPARRY");
    assert.equal(sell.symbol, "EIDPARRY");
    assert.equal(buy.securityName, "EID Parry Ltd.");
    assert.equal(buy.clientName, "SBI MUTUAL FUND");
    assert.equal(sell.clientName, "SAGEONE INVESTMENT MANAGERS LLP");
    assert.equal(buy.qty, 2215000);
    assert.equal(sell.qty, 2215000);
    assert.equal(buy.avgPrice, 795, "795.00 parses to 795");
    assert.equal(sell.avgPrice, 795);
    assert.notEqual(exactDealKey(buy), exactDealKey(sell));
  });
});

// ─── The rolling-snapshot decision ───────────────────────────────────

describe("parseBulkBlockDeals — expectedDate COUNTS, it does not FILTER", () => {
  it("keeps every row when the snapshot predates the fetch day", () => {
    // MAP CONTRADICTION #2 / the P4.1 rule inverted. `parseSecBhavdataFull`
    // EXCLUDES rows that disagree with expectedDate because its archive key IS
    // the trade date. bulk.csv/block.csv are ROLLING and undated upstream, so
    // report-registry.ts records the key as the FETCH day — every row the
    // snapshot carries from an earlier session would be deleted by a filter.
    const out = parseBulkBlockDeals(BULK_CSV, "BULK", AUG10);
    assert.equal(out.rows.length, 7, "rows are KEPT, not filtered");
    assert.equal(out.dateMismatch, 7, "…and counted, so the lag is visible");
    assert.equal(out.skipped, 0);
    assert.ok(
      out.rows.every((r) => r.date.toISOString().slice(0, 10) === "2026-08-07"),
      "each row keeps its OWN date, never the archive key's",
    );
  });

  it("proves one expectedDate cannot serve both archived snapshots", () => {
    // Cut in the same pass, three days apart. Filtering on either date would
    // parse the other file to zero rows while reporting success.
    const bulk = parseBulkBlockDeals(BULK_CSV, "BULK", AUG7);
    const block = parseBulkBlockDeals(BLOCK_CSV, "BLOCK", AUG7);
    assert.equal(bulk.dateMismatch, 0);
    assert.equal(block.dateMismatch, 2);
    assert.equal(block.rows.length, 2, "still parsed, still stored");
  });

  it("skips a row whose own date is unreadable instead of borrowing one", () => {
    // The trade date is part of the identity key: inventing one would mint a
    // phantom deal that can never dedupe against the real print.
    const csv = `${DEAL_HEADER}
NOT-A-DATE,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
31-FEB-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows.length, 1);
    assert.equal(out.skipped, 2, "rollover dates are unreadable, not February");
  });
});

// ─── The all-fields key ──────────────────────────────────────────────

describe("exactDealKey — all fields, exact duplicates only", () => {
  it("gives DIFFERENT keys to same-client same-symbol rows at different prices", () => {
    // The non-negotiable rule (map §5). The same client can legitimately print
    // the same symbol twice in one day; a narrower key silently under-reports
    // exactly the institutions the feed exists to track.
    const csv = `${DEAL_HEADER}
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.73,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows.length, 2);
    assert.notEqual(
      exactDealKey(out.rows[0]!),
      exactDealKey(out.rows[1]!),
      "a 1-paisa difference is a different deal",
    );
  });

  it("gives DIFFERENT keys when only the quantity differs", () => {
    const csv = `${DEAL_HEADER}
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523453,76.72,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.notEqual(exactDealKey(out.rows[0]!), exactDealKey(out.rows[1]!));
  });

  it("collapses ONLY byte-identical repeats", () => {
    // Row 3 repeats row 1 exactly — the rolling snapshot serving yesterday's
    // print again. Row 2 differs by price and must survive.
    const csv = `${DEAL_HEADER}
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.73,-
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(
      out.rows.length,
      3,
      "the parser does not dedupe; the writer does",
    );
    const keys = new Set(out.rows.map(exactDealKey));
    assert.equal(keys.size, 2);
    assert.equal(exactDealKey(out.rows[0]!), exactDealKey(out.rows[2]!));
  });

  it("separates BULK from BLOCK and BUY from SELL", () => {
    const base: InstitutionalDealRow = {
      date: AUG7,
      symbol: "AASTHA",
      securityName: "Aastha Spintex Limited",
      clientName: "HRTI PRIVATE LIMITED",
      buySell: "BUY",
      qty: 523452,
      avgPrice: 76.72,
      dealType: "BULK",
      exchange: "NSE",
      remarks: null,
    };
    const keys = new Set([
      exactDealKey(base),
      exactDealKey({ ...base, dealType: "BLOCK" }),
      exactDealKey({ ...base, buySell: "SELL" }),
      exactDealKey({ ...base, remarks: "Correction" }),
      exactDealKey({ ...base, date: AUG10 }),
    ]);
    assert.equal(keys.size, 5, "every business field participates in the key");
  });

  it("escapes the separator so free-text names cannot collide", () => {
    // Client and security names are vendor free-text. Under a naive join these
    // two rows both render "…|Y|ACME|X|…" and one real print vanishes as a
    // "duplicate".
    const csv = `${DEAL_HEADER}
07-AUG-2026,AASTHA,Y|ACME,X,BUY,523452,76.72,-
07-AUG-2026,AASTHA,Y,ACME|X,BUY,523452,76.72,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows.length, 2);
    assert.notEqual(exactDealKey(out.rows[0]!), exactDealKey(out.rows[1]!));
  });

  it("treats numerically equal prices as one key", () => {
    // 795.00 and 795 are the same price, so they SHOULD collapse — the key is
    // built from parsed values, not raw text.
    const csv = `${DEAL_HEADER}
10-AUG-2026,EIDPARRY,EID Parry Ltd.,SBI MUTUAL FUND,BUY,2215000,795.00,-
10-AUG-2026,EIDPARRY,EID Parry Ltd.,SBI MUTUAL FUND,BUY,2215000,795,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG10);
    assert.equal(new Set(out.rows.map(exactDealKey)).size, 1);
  });
});

// ─── Tolerated input drift, and refused input ────────────────────────

describe("parseBulkBlockDeals — field-level robustness", () => {
  it("accepts quoted Indian-grouped quantities and prices", () => {
    const csv = `${DEAL_HEADER}
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,"5,23,452","1,076.72",-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows[0]!.qty, 523452);
    assert.equal(out.rows[0]!.avgPrice, 1076.72);
  });

  it("normalizes the side spellings older archives use", () => {
    const csv = `${DEAL_HEADER}
07-AUG-2026,A,A Ltd,C1,Buy,1,10,-
07-AUG-2026,A,A Ltd,C2,sell,1,10,-
07-AUG-2026,A,A Ltd,C3,B,1,10,-
07-AUG-2026,A,A Ltd,C4,S,1,10,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.deepEqual(
      out.rows.map((r) => r.buySell),
      ["BUY", "SELL", "BUY", "SELL"],
    );
  });

  it("refuses rows with an unreadable side or a non-deal quantity/price", () => {
    // Never default the direction of an institutional print, and never let a
    // zero size/price through into downstream flow aggregates.
    const csv = `${DEAL_HEADER}
07-AUG-2026,A,A Ltd,C1,X,1,10,-
07-AUG-2026,A,A Ltd,C2,BUY,0,10,-
07-AUG-2026,A,A Ltd,C3,BUY,1,0,-
07-AUG-2026,A,A Ltd,C4,BUY,abc,10,-
07-AUG-2026,A,A Ltd,,BUY,1,10,-
07-AUG-2026,A,A Ltd,C5,BUY,1,10,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.clientName, "C5");
    assert.equal(out.skipped, 5);
  });

  it("keeps a real remark and nulls the `-` placeholder", () => {
    const csv = `${DEAL_HEADER}
07-AUG-2026,A,A Ltd,C1,BUY,1,10,Market Sale
07-AUG-2026,A,A Ltd,C2,BUY,1,10,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows[0]!.remarks, "Market Sale");
    assert.equal(out.rows[1]!.remarks, null);
  });

  it("survives a renamed descriptive column instead of losing the day", () => {
    // `Security Name` is not identity. If NSE renames it, the prints must
    // still land — with an empty securityName, consistently, for the whole file.
    const csv = `Date,Symbol,Scrip Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks
07-AUG-2026,AASTHA,Aastha Spintex Limited,HRTI PRIVATE LIMITED,BUY,523452,76.72,-
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.securityName, "Aastha Spintex Limited");

    const gone = `Date,Symbol,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price
07-AUG-2026,AASTHA,HRTI PRIVATE LIMITED,BUY,523452,76.72
`;
    const out2 = parseBulkBlockDeals(gone, "BULK", AUG7);
    assert.equal(out2.rows.length, 1);
    assert.equal(out2.rows[0]!.securityName, "");
  });
});

describe("parseBulkBlockDeals — refuses to guess at a broken file", () => {
  it("returns zero rows and COUNTS the lines when no header matches", () => {
    const csv = `Col A,Col B,Col C
1,2,3
4,5,6
`;
    const out = parseBulkBlockDeals(csv, "BULK", AUG7);
    assert.equal(out.rows.length, 0);
    assert.equal(out.skipped, 3, "a loud non-zero, not a quiet empty parse");
  });

  it("never throws on an HTML error page", () => {
    const html = `<!DOCTYPE html>
<html><head><title>NSE - Access Denied</title></head>
<body><h1>Request Rejected</h1></body>
</html>`;
    const out = parseBulkBlockDeals(html, "BULK", AUG7);
    assert.equal(out.rows.length, 0);
    assert.ok(out.skipped > 0);
    assert.equal(out.dateMismatch, 0);
  });

  it("never throws on JSON, binary-ish or empty input", () => {
    assert.equal(
      parseBulkBlockDeals('{"data":[],"error":"no records"}', "BULK", AUG7).rows
        .length,
      0,
    );
    assert.equal(
      parseBulkBlockDeals("\u0000binary", "BULK", AUG7).rows.length,
      0,
    );

    const empty = parseBulkBlockDeals("", "BULK", AUG7);
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.skipped, 0, "no lines means nothing was lost");

    const headerOnly = parseBulkBlockDeals(`${DEAL_HEADER}\n`, "BULK", AUG7);
    assert.equal(headerOnly.rows.length, 0);
    assert.equal(
      headerOnly.skipped,
      0,
      "a holiday snapshot is legitimately empty",
    );
  });
});

// ─── SLB open positions — REAL archived bytes (MONEY-1200) ───────────
//
// `slb_openpos.sample.csv` is cut from the live response for 13-Aug-2026
//   https://nsearchives.nseindia.com/archives/slbs/open_pos/slb_openpos_13082026.csv
// (200, text/csv, 11,577 bytes, 605 data rows) by dropping WHOLE ROWS only —
// six symbols kept verbatim, including their original non-contiguous `Sr no`
// values, which is the tell that nothing inside a row was edited.
//
// These cases replace a synthetic block written when the family's registry URL
// probed 404. The synthetic fixture guessed `Symbol,Series,Open Position,Value`
// and was wrong on three of four columns, which is worth keeping in mind: it
// asserted green for months about a layout that does not exist.

const SLB_CSV = readFileSync(join(FIXTURES, "slb_openpos.sample.csv"), "utf-8");

const AUG13 = new Date(Date.UTC(2026, 7, 13)); // the fixture's trading day

describe("parseSlbOpenPositions — real NSE slb_openpos rows", () => {
  const out = parseSlbOpenPositions(SLB_CSV, AUG13);

  it("parses every fixture row with nothing skipped", () => {
    assert.equal(out.rows.length, 24);
    assert.equal(out.skipped, 0);
  });

  it("reads NSE's actual column names, which are NOT the guessed ones", () => {
    // Header, verbatim and unchanged on every day sampled 2020→2026:
    //   Sr no,Security,Series,Outstanding Quantity at the end of the day
    // `Security` (not Symbol) and `Outstanding Quantity at the end of the day`
    // (not Open Position) are the two aliases that took this family from a
    // permanent zero to real rows.
    const first = out.rows[0]!;
    assert.equal(first.symbol, "360ONE");
    assert.equal(first.series, "X1");
    assert.equal(first.openQty, 2);
  });

  it("dates every row from the filename — the file carries no date column", () => {
    assert.ok(
      out.rows.every((r) => r.date.toISOString().slice(0, 10) === "2026-08-13"),
      "slb_openpos_{DDMMYYYY}.csv is date-addressable: the filename IS the day",
    );
  });

  it("leaves openValue and expiryDate null — the file has neither column", () => {
    // Four columns, and two of the row type's fields have nothing to read.
    // Pinned so a future 'enrichment' has to be a deliberate change, and so the
    // expiry ladder is never silently reconstructed from `series` (the code
    // carries a month but not a year — see the SLB block in deals.ts).
    assert.ok(out.rows.every((r) => r.openValue === null));
    assert.ok(out.rows.every((r) => r.expiryDate === null));
  });

  it("keeps the series ladder rather than collapsing it", () => {
    const cdsl = out.rows.filter((r) => r.symbol === "CDSL");
    assert.equal(cdsl.length, 9, "CDSL is lent across nine expiry months");
    assert.deepEqual(
      cdsl.map((r) => r.series),
      ["X1", "X2", "X4", "X5", "X6", "X7", "X8", "X9", "XO"],
    );
    assert.deepEqual(
      cdsl.map((r) => r.openQty),
      [389, 1732, 13, 276, 7, 84, 50, 5536, 2217],
    );
  });

  it("keeps NSE's numeric-series rows, which are a THIRD namespace", () => {
    // Most rows carry the X-ladder (X1…X9/XO/XN/XD); a handful carry '09'.
    // The eligible-securities file uses '01','02',… for something else again.
    // The parser must not normalise or drop these — it does not know which
    // namespace it is holding, and neither does the file.
    const numeric = out.rows.filter((r) => r.series === "09");
    assert.deepEqual(
      numeric.map((r) => r.symbol),
      ["AXISBANK", "RELIANCE"],
    );
  });

  it("COUNTS the symbols that collide under @@unique([symbol, date])", () => {
    // THE FINDING. The file is one row per (security, SERIES), so FIVE of the
    // six fixture symbols occupy several rows each — 360ONE×4, ABB×5,
    // AXISBANK×2, CDSL×9, RELIANCE×3, and only ZYDUSWELL stands alone. On the
    // full 13-Aug-2026 file that is 116 of 331 symbols across 605 rows, and
    // `writeSlb`'s upsert on `symbol_date` keeps whichever row it saw last:
    // 238,395,729 shares of open interest stored as 37,607,169, i.e. 84.2%
    // dropped while reporting success.
    //
    // A nonzero count is the NORMAL state of this feed, so this must never be
    // asserted to zero. It exists so the writer can be built knowing the shape.
    assert.equal(out.multiSeriesSymbols, 5);
    assert.ok(
      out.multiSeriesSymbols > 0,
      "if this ever reads 0 on the real fixture, the parser stopped reading rows",
    );

    // And the loss is real arithmetic, not a worry: prove it on the fixture.
    const total = out.rows.reduce((s, r) => s + r.openQty, 0);
    const lastWriteWins = new Map<string, number>();
    for (const r of out.rows) lastWriteWins.set(r.symbol, r.openQty);
    const kept = [...lastWriteWins.values()].reduce((s, n) => s + n, 0);
    assert.ok(
      kept < total / 2,
      `symbol-keyed upsert would keep ${kept} of ${total} shares`,
    );
  });

  it("keeps a zero open position — no borrow demand is a fact, not a gap", () => {
    const zeroed = parseSlbOpenPositions(
      `Sr no,Security,Series,Outstanding Quantity at the end of the day\n1,TCS,X9,0\n`,
      AUG13,
    );
    assert.equal(zeroed.rows.length, 1);
    assert.equal(zeroed.rows[0]!.openQty, 0);
    assert.equal(zeroed.multiSeriesSymbols, 0);
  });

  it("still honours an in-file date column if NSE ever adds one", () => {
    const dated = `Date,Security,Series,Outstanding Quantity at the end of the day
11-AUG-2026,INFY,X9,125000
`;
    const res = parseSlbOpenPositions(dated, AUG13);
    assert.equal(res.rows.length, 1);
    assert.equal(
      res.rows[0]!.date.toISOString().slice(0, 10),
      "2026-08-11",
      "the archived file wins over the caller's date (map conflict rule)",
    );
  });

  it("nulls series when the column does not exist", () => {
    const res = parseSlbOpenPositions(
      `Security,Outstanding Quantity at the end of the day\nINFY,125000\n`,
      AUG13,
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.series, null);
    assert.equal(res.rows[0]!.openValue, null);
  });

  it("skips rows with no symbol, an unreadable quantity, or a bad in-file date", () => {
    const res = parseSlbOpenPositions(
      `Date,Security,Outstanding Quantity at the end of the day
11-AUG-2026,,125000
11-AUG-2026,INFY,abc
11-AUG-2026,INFY,-500
NOT-A-DATE,INFY,125000
11-AUG-2026,TCS,7
`,
      AUG13,
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.symbol, "TCS");
    assert.equal(res.skipped, 4);
  });

  it("DEGRADES TO COUNTED SKIPS when the layout drifts", () => {
    // This is not hypothetical any more: it is exactly what the family did
    // against the real file for months, because `Security` and `Outstanding
    // Quantity…` were not in the alias table. A loud zero is what made the
    // miss diagnosable instead of a column of confident wrong numbers.
    const drifted = `Scrip,Lending Series,Open Interest Qty
INFY,X9,125000
TCS,X9,50000
`;
    const res = parseSlbOpenPositions(drifted, AUG13);
    assert.equal(res.rows.length, 0);
    assert.equal(res.skipped, 3);
    assert.equal(res.multiSeriesSymbols, 0);
  });

  it("never throws on HTML, JSON or empty input", () => {
    // NSE's 404 body for a wrong SLB path is ~3.5 KB of HTML served with a
    // 404, so this is the shape a mis-dated fetch actually hands the parser.
    const html = `<html><body><h1>404 Not Found</h1></body></html>`;
    assert.equal(parseSlbOpenPositions(html, AUG13).rows.length, 0);
    assert.equal(parseSlbOpenPositions('{"rows":[]}', AUG13).rows.length, 0);

    const empty = parseSlbOpenPositions("", AUG13);
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.skipped, 0);
    assert.equal(empty.multiSeriesSymbols, 0);
  });
});

/**
 * NSE mislabelled the SLB series column for NINE trading days. MONEY-1483.
 *
 * `Sr no,Security,Scrip Name , Outstanding Quantity…` ran from 25-04-2016 to
 * 05-05-2016 and then reverted to `Series`. The DATA is identical either side
 * of the rename — `1,ABIRLANUVO,06,100`, the SLB month ladder — so nothing
 * about the file is wrong except the label.
 *
 * With one accepted spelling the effect was NOT a parse error. `header.cols.series`
 * came back undefined, `text("")` produced null, the rows were EMITTED, and
 * `SlbPosition`'s `symbol_date_series` unique key rejected the null String in
 * the WRITER — so it surfaced as `PrismaClientValidationError: Argument 'series'
 * must not be null` with no indication that a header was involved, and
 * `feed-parse-prod` refused to report success every night for nine files.
 */
describe("parseSlbOpenPositions — the Apr-May 2016 `Scrip Name` header", () => {
  const APR25 = new Date(Date.UTC(2016, 3, 25));

  // Verbatim shape of the mislabelled cohort, trailing space included.
  const RENAMED =
    "Sr no,Security,Scrip Name , Outstanding Quantity at the end of the day\n" +
    "1,ABIRLANUVO,06,100\n" +
    "2,ACC,06,2500\n";

  const NORMAL =
    "Sr no,Security,Series, Outstanding Quantity at the end of the day\n" +
    "1,ABIRLANUVO,06,100\n" +
    "2,ACC,06,2500\n";

  it("reads the series rather than emitting a row the writer must reject", () => {
    const out = parseSlbOpenPositions(RENAMED, APR25);

    assert.equal(out.unrecognisedFormat, false);
    assert.equal(out.rows.length, 2);
    for (const row of out.rows) {
      assert.ok(
        row.series !== null && row.series !== "",
        "a null series reaches Prisma and throws on the symbol_date_series key",
      );
    }
    assert.equal(out.rows[0]?.series, "06");
  });

  it("produces the SAME rows as the normal header — only the label moved", () => {
    const renamed = parseSlbOpenPositions(RENAMED, APR25);
    const normal = parseSlbOpenPositions(NORMAL, APR25);

    assert.deepEqual(
      renamed.rows,
      normal.rows,
      "if these differ, the alias changed more than the column name",
    );
  });

  it("still refuses a file whose series column is genuinely absent", () => {
    // Anti-vacuity: a catch-all alias list would pass every case above while
    // silently accepting a file that never stated a series at all.
    const out = parseSlbOpenPositions(
      "Sr no,Security, Outstanding Quantity at the end of the day\n" +
        "1,ABIRLANUVO,100\n",
      APR25,
    );
    const seriesValues = out.rows.map((r) => r.series);
    assert.ok(
      out.rows.length === 0 || seriesValues.every((s) => s === null),
      "a missing series column must not be invented from another field",
    );
  });
});
