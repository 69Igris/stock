/**
 * Tests for index-constituent-list.ts (MONEY-1100 P4.3).
 *
 * Fixtures are REAL archived bytes (feeds/NSE/index-constituents/…,
 * 2026-08-10 fetch), not invented shapes — the parser must be proven against
 * what NSE actually serves. The Bank Nifty fixture doubles as the reason this
 * module exists: the worker's hand-pinned static list said 12 members while
 * this real file says 14 (no BANDHANBNK; CANBK/UNIONBANK/YESBANK present).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseIndexConstituentList,
  pickLatestConstituentKey,
  constituentKeyDate,
  shouldReplaceMembership,
  CONSTITUENT_SLUG_TO_INDEX_ID,
  INDEX_ID_TO_CONSTITUENT_SLUG,
  MIN_CONSTITUENTS,
} from "../../src/market-data/index-constituent-list";

// Verbatim from 2026-08-10-ind_niftybanklist.csv (full file, 14 members).
const REAL_NIFTYBANK = `Company Name,Industry,Symbol,Series,ISIN Code
AU Small Finance Bank Ltd.,Financial Services,AUBANK,EQ,INE949L01017
Axis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034
Bank of Baroda,Financial Services,BANKBARODA,EQ,INE028A01039
Canara Bank,Financial Services,CANBK,EQ,INE476A01022
Federal Bank Ltd.,Financial Services,FEDERALBNK,EQ,INE171A01029
HDFC Bank Ltd.,Financial Services,HDFCBANK,EQ,INE040A01034
ICICI Bank Ltd.,Financial Services,ICICIBANK,EQ,INE090A01021
IDFC First Bank Ltd.,Financial Services,IDFCFIRSTB,EQ,INE092T01019
IndusInd Bank Ltd.,Financial Services,INDUSINDBK,EQ,INE095A01012
Kotak Mahindra Bank Ltd.,Financial Services,KOTAKBANK,EQ,INE237A01036
Punjab National Bank,Financial Services,PNB,EQ,INE160A01022
State Bank of India,Financial Services,SBIN,EQ,INE062A01020
Union Bank of India,Financial Services,UNIONBANK,EQ,INE692A01016
Yes Bank Ltd.,Financial Services,YESBANK,EQ,INE528G01035
`;

// Verbatim rows from 2026-08-10-ind_nifty50list.csv — the symbol-charset
// edge cases (`M&M`, `BAJAJ-AUTO`) plus an ordinary row.
const REAL_NIFTY50_SLICE = `Company Name,Industry,Symbol,Series,ISIN Code
Bajaj Auto Ltd.,Automobile and Auto Components,BAJAJ-AUTO,EQ,INE917I01010
Mahindra & Mahindra Ltd.,Automobile and Auto Components,M&M,EQ,INE101A01026
Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018
`;

describe("parseIndexConstituentList", () => {
  it("parses the real Bank Nifty file: 14 members, full fields", () => {
    const { rows, reasons } = parseIndexConstituentList(REAL_NIFTYBANK);
    assert.equal(rows.length, 14);
    assert.deepEqual(reasons, {});
    const symbols = rows.map((r) => r.symbol);
    // The three names the stale static list was missing…
    for (const s of ["CANBK", "UNIONBANK", "YESBANK"]) {
      assert.ok(symbols.includes(s), `${s} missing`);
    }
    // …and the one it wrongly kept.
    assert.ok(!symbols.includes("BANDHANBNK"));
    const au = rows[0]!;
    assert.equal(au.symbol, "AUBANK");
    assert.equal(au.companyName, "AU Small Finance Bank Ltd.");
    assert.equal(au.industry, "Financial Services");
    assert.equal(au.series, "EQ");
    assert.equal(au.isin, "INE949L01017");
  });

  it("keeps `&` and `-` symbols intact (M&M, BAJAJ-AUTO)", () => {
    const { rows, reasons } = parseIndexConstituentList(REAL_NIFTY50_SLICE);
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["BAJAJ-AUTO", "M&M", "RELIANCE"],
    );
    assert.deepEqual(reasons, {});
  });

  it("resolves columns by header, not position", () => {
    const shuffled = `Symbol,ISIN Code,Company Name
INFY,INE009A01021,Infosys Ltd.
TCS,INE467B01029,Tata Consultancy Services Ltd.
`;
    const { rows } = parseIndexConstituentList(shuffled);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.symbol, "INFY");
    assert.equal(rows[0]!.isin, "INE009A01021");
    assert.equal(rows[0]!.companyName, "Infosys Ltd.");
    // Columns absent from the header come back null, not misassigned.
    assert.equal(rows[0]!.industry, null);
    assert.equal(rows[0]!.series, null);
  });

  it("finds the header when a preamble line precedes it", () => {
    const withPreamble = `Effective for trading from Aug 11 2026
Company Name,Industry,Symbol,Series,ISIN Code
HDFC Bank Ltd.,Financial Services,HDFCBANK,EQ,INE040A01034
`;
    const { rows, reasons } = parseIndexConstituentList(withPreamble);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.symbol, "HDFCBANK");
    assert.deepEqual(reasons, {});
  });

  it("handles quoted company names containing commas", () => {
    const quoted = `Company Name,Industry,Symbol,Series,ISIN Code
"Foo, Bar and Baz Ltd.",Services,FOOBAR,EQ,INE000A01000
`;
    const { rows } = parseIndexConstituentList(quoted);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.symbol, "FOOBAR");
    assert.equal(rows[0]!.companyName, "Foo, Bar and Baz Ltd.");
  });

  it("rejects an HTML error page with noHeader, zero rows", () => {
    const html = `<!DOCTYPE html><html><head><title>Access Denied</title></head>
<body><h1>Request unsuccessful</h1></body></html>`;
    const { rows, reasons } = parseIndexConstituentList(html);
    assert.equal(rows.length, 0);
    assert.equal(reasons.noHeader, 1);
  });

  it("returns noHeader for empty input", () => {
    const { rows, reasons } = parseIndexConstituentList("");
    assert.equal(rows.length, 0);
    assert.equal(reasons.noHeader, 1);
  });

  it("drops duplicate symbols, keeping the first, and counts them", () => {
    const dupes = `Company Name,Industry,Symbol,Series,ISIN Code
First Ltd.,Services,SAME,EQ,INE000A01001
Second Ltd.,Services,SAME,BE,INE000A01002
`;
    const { rows, reasons } = parseIndexConstituentList(dupes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.series, "EQ");
    assert.equal(reasons.duplicateSymbol, 1);
  });

  it("counts empty and malformed symbol cells without aborting the file", () => {
    const messy = `Company Name,Industry,Symbol,Series,ISIN Code
Good Ltd.,Services,GOOD,EQ,INE000A01003
No Symbol Ltd.,Services,,EQ,INE000A01004
Prose row disclaimer,,not a symbol!,,
`;
    const { rows, reasons } = parseIndexConstituentList(messy);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.symbol, "GOOD");
    assert.equal(reasons.emptySymbol, 1);
    assert.equal(reasons.malformedSymbol, 1);
  });

  it("uppercases symbols on the way in", () => {
    const lower = `Company Name,Industry,Symbol,Series,ISIN Code
Infosys Ltd.,IT,infy,EQ,INE009A01021
`;
    const { rows } = parseIndexConstituentList(lower);
    assert.equal(rows[0]!.symbol, "INFY");
  });
});

describe("pickLatestConstituentKey", () => {
  it("picks the lexicographically latest file, skipping dir markers", () => {
    const keys = [
      "feeds/NSE/index-constituents/nifty50/2026/08/2026-08-07-ind_nifty50list.csv",
      "feeds/NSE/index-constituents/nifty50/2026/08/",
      "feeds/NSE/index-constituents/nifty50/2026/08/2026-08-10-ind_nifty50list.csv",
      "feeds/NSE/index-constituents/nifty50/2026/07/2026-07-31-ind_nifty50list.csv",
    ];
    assert.equal(
      pickLatestConstituentKey(keys),
      "feeds/NSE/index-constituents/nifty50/2026/08/2026-08-10-ind_nifty50list.csv",
    );
  });

  it("orders correctly across year boundaries (YYYY/MM layout)", () => {
    const keys = [
      "feeds/NSE/index-constituents/nifty50/2025/12/2025-12-31-ind_nifty50list.csv",
      "feeds/NSE/index-constituents/nifty50/2026/01/2026-01-02-ind_nifty50list.csv",
    ];
    assert.equal(
      pickLatestConstituentKey(keys),
      "feeds/NSE/index-constituents/nifty50/2026/01/2026-01-02-ind_nifty50list.csv",
    );
  });

  it("returns null for empty or dir-only listings", () => {
    assert.equal(pickLatestConstituentKey([]), null);
    assert.equal(pickLatestConstituentKey(["feeds/NSE/x/"]), null);
  });
});

describe("constituentKeyDate", () => {
  it("extracts the ISO day from a dated basename", () => {
    assert.equal(
      constituentKeyDate(
        "feeds/NSE/index-constituents/niftybank/2026/08/2026-08-10-ind_niftybanklist.csv",
      ),
      "2026-08-10",
    );
  });

  it("returns null when the basename carries no date", () => {
    assert.equal(constituentKeyDate("feeds/NSE/x/ind_nifty50list.csv"), null);
  });
});

describe("shouldReplaceMembership", () => {
  it("refuses below the absolute floor regardless of existing", () => {
    assert.deepEqual(shouldReplaceMembership(MIN_CONSTITUENTS - 1, 0), {
      replace: false,
      reason: "below-floor",
    });
    assert.deepEqual(shouldReplaceMembership(3, 50), {
      replace: false,
      reason: "below-floor",
    });
  });

  it("refuses when the new set is under half the existing one", () => {
    assert.deepEqual(shouldReplaceMembership(20, 50), {
      replace: false,
      reason: "shrank-by-more-than-half",
    });
  });

  it("allows exactly half (boundary is `< half`, not `<= half`)", () => {
    assert.deepEqual(shouldReplaceMembership(25, 50), {
      replace: true,
      reason: null,
    });
  });

  it("allows growth, small shrink, and fresh-table writes", () => {
    assert.equal(shouldReplaceMembership(14, 12).replace, true); // banknifty 12→14
    assert.equal(shouldReplaceMembership(48, 50).replace, true);
    assert.equal(shouldReplaceMembership(50, 0).replace, true);
    assert.equal(shouldReplaceMembership(MIN_CONSTITUENTS, 0).replace, true);
  });
});

describe("slug ↔ indexId mapping", () => {
  it("is a bijection over the eight archived slugs", () => {
    const slugs = Object.keys(CONSTITUENT_SLUG_TO_INDEX_ID);
    assert.equal(slugs.length, 8);
    for (const slug of slugs) {
      const id = CONSTITUENT_SLUG_TO_INDEX_ID[slug]!;
      assert.equal(INDEX_ID_TO_CONSTITUENT_SLUG[id], slug);
    }
  });

  it("maps the one divergent pair: niftybank ↔ banknifty", () => {
    assert.equal(CONSTITUENT_SLUG_TO_INDEX_ID.niftybank, "banknifty");
    assert.equal(INDEX_ID_TO_CONSTITUENT_SLUG.banknifty, "niftybank");
  });
});
