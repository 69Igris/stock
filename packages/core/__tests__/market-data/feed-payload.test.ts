/**
 * UNIT TEST — per-feed payload sanity checks (MONEY-1157).
 *
 * Exercises the REAL exports from packages/core/src/market-data/feed-payload.ts.
 *
 * The defect these guard against: NSE and BSE answer **200 with an HTML
 * interstitial** when they throttle. `fetchExchangeAsset` only rejects a 404 and
 * a non-2xx, so that HTML used to be archived like any other file — and then
 * replayed by QA indefinitely, parsing to zero rows and logging a COMPLETED
 * sync with recordsProcessed 0 and no error. Indistinguishable from a market
 * holiday.
 *
 * The calibration that matters, asserted below: the check is never STRICTER
 * than the parser it protects. Anything it rejects would have produced zero
 * rows anyway.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  feedShapeFor,
  looksLikeHtml,
  validateFeedPayload,
  type FeedShape,
} from "../../src/market-data/feed-payload";
import type { FeedDescriptor } from "../../src/market-data/feed-archive";
import { parseUdiffBhavcopy } from "../../src/market-data/bhavcopy";
import { parseNseMasterCsv } from "../../src/market-data/instruments/nse-master-logic";

const DAY = new Date(Date.UTC(2026, 6, 27));
const NSE_ZIP = "https://x/BhavCopy_NSE_CM_0_0_0_20260727_F_0000.csv.zip";
const BSE_CSV = "https://x/BhavCopy_BSE_CM_0_0_0_20260727_F_0000.CSV";
const MASTER = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const INDICES = "https://x/ind_close_all_27072026.csv";
const SCRIP_MASTER =
  "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?segment=Debt";

/** The real interstitial shape: a 200 whose body is an HTML page. */
const NSE_THROTTLE_PAGE =
  '<!DOCTYPE html>\n<html lang="en">\n<head><title>Access Denied</title>' +
  '<meta charset="utf-8"></head>\n<body>\n<h1>Resource unavailable</h1>\n' +
  "<p>Your request has been blocked. Please try again later.</p>\n" +
  "</body>\n</html>\n";

const BHAVCOPY_CSV =
  "TckrSymb,ISIN,SctySrs,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol,FinInstrmTp,FinInstrmNm\n" +
  "RELIANCE,INE002A01018,EQ,10,11,9,10.5,10,1000,STK,RELIANCE INDUSTRIES\n";

const MASTER_CSV =
  "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n" +
  "RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995,10,1,INE002A01018,10\n";

const INDICES_CSV =
  '"Index Name","Index Date","Open Index Value","High Index Value",' +
  '"Low Index Value","Closing Index Value","Points Change"\n' +
  '"Nifty 50","27-07-2026",100,110,90,105,5\n';

function zipBytes(payload: string): Buffer {
  const name = Buffer.from("BhavCopy.csv", "utf-8");
  const data = Buffer.from(payload, "utf-8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 8); // STORED
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, data]);
}

const buf = (s: string): Buffer => Buffer.from(s, "utf-8");

describe("BSE legacy cash feeds — the SPA page must never be archived (MONEY-1101)", () => {
  /**
   * BSE's real failure mode. An ABSENT legacy bhavcopy is answered with 200 +
   * this Angular shell (observed 2026-08-13 as a constant 13,850 bytes), never
   * a 404 — which is precisely why P2 could only record the era as
   * INDETERMINATE. An 18-year backfill runs ~4,500 requests per family, so
   * without this guard the archive fills with copies of BSE's homepage and QA
   * replays them forever.
   */
  const BSE_SPA_PAGE =
    '<!DOCTYPE html><html lang="en" data-critters-container=""><head>' +
    '<meta charset="utf-8"><title>LIVE Stock/Share Market</title></head>' +
    "<body><app-root></app-root></body></html>";

  const LEGACY_URL =
    "https://www.bseindia.com/download/BhavCopy/Equity/eq020107_csv.zip";
  const ISIN_URL =
    "https://www.bseindia.com/download/BhavCopy/Equity/EQ_ISINCODE_150323.zip";

  for (const [feed, url] of [
    ["cm-legacy", LEGACY_URL],
    ["cm-isin-legacy", ISIN_URL],
  ] as const) {
    test(`${feed}: expects a ZIP`, () => {
      assert.equal(
        feedShapeFor({ exchange: "BSE", feed, date: DAY }, url).kind,
        "zip",
      );
    });

    test(`${feed}: REJECTS the SPA page served with a 200`, () => {
      const check = validateFeedPayload(
        { exchange: "BSE", feed, date: DAY },
        url,
        buf(BSE_SPA_PAGE),
      );
      assert.equal(check.ok, false);
    });

    test(`${feed}: ACCEPTS a real zip`, () => {
      // Must clear `minBytes` (128 for zip) on its own — a near-empty archive
      // is rejected as implausibly small, which is a separate and correct
      // rule. A real BSE legacy file is 80–180 KB, so this is not a
      // constraint the live walk can trip.
      const payload = zipBytes(
        "SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST," +
          "PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI\n" +
          "500002,ABB LTD.    ,A ,Q,3346.95,3349.35,3288.80,3302.35," +
          "3301.50,3306.45,742,3601,11942570.00,\n",
      );
      assert.ok(payload.length > 128, "fixture must clear minBytes");
      const check = validateFeedPayload(
        { exchange: "BSE", feed, date: DAY },
        url,
        payload,
      );
      assert.equal(check.ok, true);
    });
  }
});

describe("feedShapeFor", () => {
  test("each registered feed gets its OWN expected shape", () => {
    assert.equal(
      feedShapeFor({ exchange: "NSE", feed: "bhavcopy", date: DAY }, NSE_ZIP)
        .kind,
      "zip",
    );
    assert.equal(
      feedShapeFor({ exchange: "BSE", feed: "bhavcopy", date: DAY }, BSE_CSV)
        .kind,
      "csv",
      "the BSE bhavcopy is a plain CSV — the SAME feed slug as NSE's ZIP, so " +
        "one rule for all feeds would be wrong for one of them",
    );
    assert.equal(
      feedShapeFor({ exchange: "BSE", feed: "scrip-master" }, SCRIP_MASTER)
        .kind,
      "json",
    );
    assert.deepEqual(
      feedShapeFor({ exchange: "NSE", feed: "equity-master" }, MASTER)
        .requiredTokens,
      ["SYMBOL", "SERIES"],
    );
  });

  test("an UNREGISTERED feed still gets a guard, inferred from the URL", () => {
    // Precision without a catch-all shrinks coverage: a new feed must not
    // silently opt out of validation just because nobody edited the registry.
    assert.equal(
      feedShapeFor(
        { exchange: "NSE", feed: "brand-new-feed" },
        "https://x/a.zip",
      ).kind,
      "zip",
    );
    assert.equal(
      feedShapeFor(
        { exchange: "NSE", feed: "brand-new-feed" },
        "https://x/a.csv",
      ).kind,
      "csv",
    );
    assert.equal(
      feedShapeFor(
        { exchange: "BSE", feed: "brand-new-feed" },
        "https://x/blob",
      ).kind,
      "unknown",
    );
  });
});

describe("looksLikeHtml", () => {
  test("recognises the interstitial shapes the exchanges actually serve", () => {
    assert.equal(looksLikeHtml(NSE_THROTTLE_PAGE), true);
    assert.equal(looksLikeHtml("  \n<html><body>nope</body></html>"), true);
    assert.equal(looksLikeHtml("<script>location.reload()</script>"), true);
    assert.equal(looksLikeHtml("<HEAD><TITLE>403</TITLE></HEAD>"), true);
  });

  test("does not fire on feed data", () => {
    assert.equal(looksLikeHtml(BHAVCOPY_CSV), false);
    assert.equal(looksLikeHtml(MASTER_CSV), false);
    assert.equal(looksLikeHtml('[{"scrip_id":"ABB"}]'), false);
    assert.equal(looksLikeHtml(""), false);
    // A leading "<" alone is not an HTML page.
    assert.equal(looksLikeHtml("<not-a-tag,1,2\n"), false);
  });
});

describe("validateFeedPayload — rejects what must never be archived", () => {
  test("a MONEY-1169 multipart envelope is rejected AT OFFSET 0, not by scan", () => {
    // The corruption shape stored by the broken upload path: the request's
    // multipart body as object content, with the REAL payload — header tokens
    // and all — sitting inside it. The old header-token scan was satisfied by
    // those inner tokens, which is exactly how 23k corrupt objects passed.
    const boundary = "d027c256-931c-4f0e-99a6-bd37862c443e";
    const enveloped = buf(
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
        `{"cacheControl":"private, max-age=3600","contentType":"text/csv"}\r\n` +
        `--${boundary}\r\nContent-Type: text/csv\r\n\r\n` +
        // A fully valid indices payload INSIDE the envelope — the poison case.
        "Index Name,Index Date,Open Index Value,Closing Index Value\n" +
        "Nifty 50,07-08-2026,24500.1,24601.2\n".repeat(20) +
        `\r\n--${boundary}--`,
    );
    const check = validateFeedPayload(
      { exchange: "NSE", feed: "indices" },
      INDICES,
      enveloped,
    );
    assert.equal(check.ok, false, "an envelope must never validate");
    assert.match(check.ok ? "" : check.reason, /MONEY-1169/);
  });

  test("a payload that merely STARTS with dashes is not mistaken for an envelope", () => {
    // Offset-strict detection must not misfire on dash-leading data: `--` at
    // 0 but no Content-Type after the first CRLF.
    const check = validateFeedPayload(
      { exchange: "NSE", feed: "indices" },
      INDICES,
      buf(
        "--legacy-header--\n" +
          "Index Name,Index Date,Open Index Value,Closing Index Value\n" +
          "Nifty 50,07-08-2026,24500.1,24601.2\n".repeat(20),
      ),
    );
    // It may pass or fail on OTHER grounds, but never with the 1169 reason.
    if (!check.ok) assert.doesNotMatch(check.reason, /MONEY-1169/);
  });

  test("an HTML interstitial is rejected for EVERY text feed", () => {
    const cases = [
      { exchange: "BSE" as const, feed: "bhavcopy", url: BSE_CSV },
      { exchange: "NSE" as const, feed: "indices", url: INDICES },
      { exchange: "NSE" as const, feed: "equity-master", url: MASTER },
      { exchange: "NSE" as const, feed: "sme-master", url: MASTER },
      { exchange: "BSE" as const, feed: "scrip-master", url: SCRIP_MASTER },
    ];
    for (const { exchange, feed, url } of cases) {
      const check = validateFeedPayload(
        { exchange, feed },
        url,
        buf(NSE_THROTTLE_PAGE),
      );
      assert.equal(check.ok, false, `${exchange}/${feed} accepted HTML`);
      assert.match(
        check.ok ? "" : check.reason,
        /HTML/,
        `${exchange}/${feed} must say WHY in the skip log`,
      );
    }
  });

  test("HTML under a .zip key is rejected on the magic bytes", () => {
    // The NSE bhavcopy is binary, so the text heuristics never even run — the
    // missing PK\x03\x04 is the signal.
    const check = validateFeedPayload(
      { exchange: "NSE", feed: "bhavcopy", date: DAY },
      NSE_ZIP,
      buf(NSE_THROTTLE_PAGE),
    );
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /PK/);
  });

  test("a CSV missing the parser's own header tokens is rejected", () => {
    // A renamed/foreign header — the file the parser would silently yield 0
    // rows from. Deliberately well over `minBytes` so the TOKEN check is what
    // rejects it, not the length backstop.
    const truncated =
      "SomeOtherHeader,SecondColumn,ThirdColumn,FourthColumn,FifthColumn,SixthColumn\n" +
      "AAA,1,2,3,4,5\nBBB,1,2,3,4,5\nCCC,1,2,3,4,5\nDDD,1,2,3,4,5\n";
    const check = validateFeedPayload(
      { exchange: "BSE", feed: "bhavcopy", date: DAY },
      BSE_CSV,
      buf(truncated),
    );
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /TckrSymb/);
  });

  test("empty and implausibly small payloads are rejected", () => {
    const d = { exchange: "BSE" as const, feed: "bhavcopy", date: DAY };
    assert.equal(validateFeedPayload(d, BSE_CSV, Buffer.alloc(0)).ok, false);
    assert.equal(validateFeedPayload(d, BSE_CSV, buf("TckrSymb")).ok, false);
  });

  test("a JSON feed answering with something else is rejected", () => {
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    const check = validateFeedPayload(
      d,
      SCRIP_MASTER,
      buf("Service Unavailable. Please retry after some time............"),
    );
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /not JSON/);
  });
});

describe("validateFeedPayload — accepts everything the parsers can use", () => {
  test("real payloads pass, per feed", () => {
    assert.equal(
      validateFeedPayload(
        { exchange: "NSE", feed: "bhavcopy", date: DAY },
        NSE_ZIP,
        zipBytes(BHAVCOPY_CSV),
      ).ok,
      true,
    );
    assert.equal(
      validateFeedPayload(
        { exchange: "BSE", feed: "bhavcopy", date: DAY },
        BSE_CSV,
        buf(BHAVCOPY_CSV),
      ).ok,
      true,
    );
    assert.equal(
      validateFeedPayload(
        { exchange: "NSE", feed: "indices", date: DAY },
        INDICES,
        buf(INDICES_CSV),
      ).ok,
      true,
    );
    assert.equal(
      validateFeedPayload(
        { exchange: "NSE", feed: "equity-master" },
        MASTER,
        buf(MASTER_CSV),
      ).ok,
      true,
    );
    assert.equal(
      validateFeedPayload(
        { exchange: "BSE", feed: "scrip-master" },
        SCRIP_MASTER,
        buf('[{"scrip_id":"ABB","GROUP":"A","ISIN_NUMBER":"INE117A01022"}]'),
      ).ok,
      true,
    );
    // BSE also wraps the array some days — both shapes must pass.
    assert.equal(
      validateFeedPayload(
        { exchange: "BSE", feed: "scrip-master" },
        SCRIP_MASTER,
        buf('{"Table":[{"scrip_id":"ABB","GROUP":"A"}],"Table1":[]}'),
      ).ok,
      true,
    );
  });

  test("SME master's underscore header style passes too", () => {
    // The two NSE master files disagree on separators; only tokens spelled
    // identically in both are required, so neither file can be rejected.
    const sme =
      "SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,\n" +
      "TINYCO,Tiny Company Limited,SM,01-JAN-2024,10,INE000000001,10,\n";
    assert.equal(
      validateFeedPayload(
        { exchange: "NSE", feed: "sme-master" },
        "https://x/SME_EQUITY_L.csv",
        buf(sme),
      ).ok,
      true,
    );
  });

  test("NEVER stricter than the parser: anything accepted yields rows", () => {
    // The one property that makes this guard safe to run in front of prod's
    // ingest. Both directions are checked against the REAL parsers.
    assert.ok(parseUdiffBhavcopy(BHAVCOPY_CSV, "BSE", DAY).length > 0);
    assert.ok(parseNseMasterCsv(MASTER_CSV).length > 0);

    // ...and everything the guard rejects would have parsed to nothing anyway,
    // so refusing to archive it costs no data.
    assert.equal(parseUdiffBhavcopy(NSE_THROTTLE_PAGE, "BSE", DAY).length, 0);
    assert.equal(parseNseMasterCsv(NSE_THROTTLE_PAGE).length, 0);
  });
  test("MONEY-1097: a bare {} / [] is ABSENT, not a payload", () => {
    // P1 hit this on two BSE endpoints: IndexArchDailyAll and
    // AnnSubCategoryGetData both answer 200 with a bare `{}` when the params
    // are wrong. That is 2 bytes of VALID JSON, so the old "starts with {"
    // test passed it — and archiving it would freeze a wrong-param response
    // into the archive for QA to replay forever. Same failure as the HTML
    // interstitial, different clothes.
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    // Unpadded, exactly as the server sends them. The earlier version padded
    // these to 40 bytes to clear `minBytes` — which meant the assertion never
    // exercised the 2-byte payload the comment describes.
    for (const empty of ["{}", "[]", "  {}  ", "\n[]\n"]) {
      const check = validateFeedPayload(
        d,
        SCRIP_MASTER,
        buf(empty.padEnd(40, " ")),
      );
      assert.equal(
        check.ok,
        false,
        `expected ${JSON.stringify(empty)} to be rejected`,
      );
    }
  });

  test("MONEY-1097: a well-formed but row-less payload is still ACCEPTED", () => {
    // Deliberately narrow. `{"data":[]}` genuinely says "no rows today", and
    // whether that is interesting belongs to the parser, not to this guard.
    // Rejecting it here would be a second way to lose a valid file — the one
    // outcome this module must never produce.
    const d = { exchange: "BSE" as const, feed: "scrip-master" };
    // Must clear `minBytes` (32 for scrip-master) on its own — a 12-byte
    // `{"Table":[]}` is rejected as implausibly small, which is a separate and
    // correct rule. This fixture is a realistic row-less BSE answer.
    const rowless = JSON.stringify({
      Table: [],
      Table1: [],
      d: null,
      ok: true,
    });
    assert.ok(rowless.length > 32);
    const check = validateFeedPayload(d, SCRIP_MASTER, buf(rowless));
    assert.equal(check.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1204 (P0.2) — NSE XBRL result filings
// ─────────────────────────────────────────────────────────────────────────────

const XBRL_URL =
  "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_116875_1315808_15112024100348.xml";
const XBRL_DESCRIPTOR = {
  exchange: "NSE",
  feed: "results-xbrl",
  date: new Date(Date.UTC(2024, 8, 30)),
} as const;

/** Every committed filing fixture — both taxonomies, all entry-point families. */
function xbrlFixtures(): Array<{ name: string; body: Buffer }> {
  const dir = join(import.meta.dirname, "..", "fixtures", "xbrl");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".xml"))
    .map((name) => ({ name, body: readFileSync(join(dir, name)) }));
}

describe("NSE/results-xbrl payload shape (MONEY-1204)", () => {
  test("the feed is REGISTERED, not left to the generic fallback", () => {
    // The whole point of a row: `unknown` sniffs for HTML and nothing else, and
    // `looksLikeHtml` does not match `<?xml` — so an unregistered .xml feed
    // could neither confirm an XBRL instance nor reject much of anything.
    const shape = feedShapeFor(XBRL_DESCRIPTOR, XBRL_URL);
    assert.equal(shape.kind, "xml");
    assert.deepEqual(shape.requiredTokens, ["<xbrli:xbrl"]);
  });

  test("accepts EVERY committed filing — both taxonomies, all four families", () => {
    // The calibration rule: the check must never be stricter than the parser.
    // These are the exact bytes `parseXbrlDocument` is tested against, so any
    // rejection here is a file the ingest could have used and now cannot.
    const fixtures = xbrlFixtures();
    assert.ok(fixtures.length >= 12, `only ${fixtures.length} fixtures found`);
    for (const { name, body } of fixtures) {
      const check = validateFeedPayload(XBRL_DESCRIPTOR, XBRL_URL, body);
      assert.equal(check.ok, true, `${name}: ${check.ok ? "" : check.reason}`);
    }
  });

  test("accepts the GOVERNANCE filing, which carries no financials", () => {
    // A run's healthiest non-financial outcome must still be archivable: it is
    // a real filing, and refusing to keep it would make the archive disagree
    // with `xbrl_filings` about what NSE published.
    const gov = xbrlFixtures().find((f) => f.name.includes("governance"));
    assert.ok(gov, "the governance fixture is what pins this");
    assert.equal(
      validateFeedPayload(XBRL_DESCRIPTOR, XBRL_URL, gov.body).ok,
      true,
    );
  });

  test("REJECTS NSE's 200-with-HTML challenge page", () => {
    // The failure the row exists for. Archived, this is replayed as data
    // forever; `xbrl-sync`'s own `<!` guard protects the PARSE, this protects
    // the ARCHIVE, and neither substitutes for the other.
    const challenge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "fixtures",
        "xbrl",
        "nse-missing-xbrl-404.html",
      ),
    );
    const check = validateFeedPayload(XBRL_DESCRIPTOR, XBRL_URL, challenge);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /HTML document/);
  });

  test("REJECTS well-formed XML that is not an XBRL instance", () => {
    // The token, not just the angle bracket. A `<Error>` document served with a
    // 200 is markup and is not a filing.
    const notXbrl = Buffer.from(
      `<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`.padEnd(
        512,
        " ",
      ),
    );
    const check = validateFeedPayload(XBRL_DESCRIPTOR, XBRL_URL, notXbrl);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /<xbrli:xbrl/);
  });

  test("REJECTS a truncated body below the byte floor", () => {
    const check = validateFeedPayload(
      XBRL_DESCRIPTOR,
      XBRL_URL,
      Buffer.from('<?xml version="1.0"?><xbrli:xbrl/>'),
    );
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /implausibly small/);
  });

  test("an UNREGISTERED .xml feed still gets the structural guard", () => {
    // A precise rule with no catch-all shrinks coverage the moment someone adds
    // a feed — the module header's own words.
    const other = { exchange: "NSE", feed: "some-new-xml-feed" } as const;
    const url = "https://nsearchives.nseindia.com/content/whatever/x.xml";
    assert.equal(feedShapeFor(other, url).kind, "xml");
    assert.equal(
      validateFeedPayload(
        other,
        url,
        Buffer.from(
          "<!DOCTYPE html><html><head><title>Denied".padEnd(512, " "),
        ),
      ).ok,
      false,
    );
    // …and does NOT assert anything about a document it has never seen.
    assert.equal(
      validateFeedPayload(
        other,
        url,
        Buffer.from('<?xml version="1.0"?><anything/>'.padEnd(512, " ")),
      ).ok,
      true,
    );
  });

  test("looksLikeHtml still does not match an XML prolog", () => {
    // The premise the branch ordering rests on, pinned so a future tweak to the
    // HTML sniff cannot silently start rejecting every filing.
    assert.equal(looksLikeHtml('<?xml version="1.0"?><xbrli:xbrl'), false);
    assert.equal(looksLikeHtml("<!DOCTYPE html><html>"), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1206 (D3) — the unregistered-CSV fallback could not reject binary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The defect: `shapeFromUrl` hands an unregistered `.csv` feed `minBytes: 32`
 * and NO required tokens, so nothing in that path could reject BINARY. That is
 * how a gzip stream came to be archived under
 * `feeds/NSE/combine-oi-deleq/2025/01/…csv` and was replayed, unparseable, for a
 * year and a half — until MONEY-1205 taught the PARSER to inflate it, which is a
 * year too late to re-ask NSE.
 *
 * Two halves, and the second is the dangerous one:
 *
 *   (a) a generic binary guard, so all 81 fallback families are covered without
 *       per-family knowledge;
 *   (b) a registered shape for `NSE/combine-oi-deleq` — whose `requiredTokens`
 *       REJECT at fetch time, so a token that is merely plausible would silently
 *       reject VALID files, which is worse than the bug. Every token is checked
 *       against all four real header variants below.
 */

/** A `.csv` feed with no FEED_SHAPES row — the fallback path, exactly. */
const UNREGISTERED = {
  exchange: "NSE",
  feed: "sec-bhavdata-full",
  date: DAY,
} as const;
const UNREGISTERED_URL =
  "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_27072026.csv";

const PLAIN_CSV =
  "SYMBOL,SERIES,DATE1,PREV_CLOSE,OPEN_PRICE,CLOSE_PRICE\n" +
  "RELIANCE,EQ,27-Jul-2026,1400.00,1405.00,1412.35\n";

describe("the generic fallback rejects binary under a .csv key (MONEY-1206)", () => {
  test("the subject really is the unguarded fallback", () => {
    // If this feed ever gets its own FEED_SHAPES row the cases below stop
    // testing the fallback and start testing that row — silently. Pin it.
    const shape = feedShapeFor(UNREGISTERED, UNREGISTERED_URL);
    assert.equal(shape.kind, "csv");
    assert.deepEqual(shape.requiredTokens, []);
    assert.equal(shape.minBytes, 32);
  });

  test("REJECTS a gzip stream — the payload that started this", () => {
    // The real object was ~16 KB of gzipped CSV. Rejected at FETCH time is the
    // only useful moment: the exchange can still be asked again.
    const gz = gzipSync(Buffer.from(PLAIN_CSV.repeat(40), "utf-8"));
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    const check = validateFeedPayload(UNREGISTERED, UNREGISTERED_URL, gz);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /gzip stream/);
  });

  test("REJECTS a ZIP served under a .csv key", () => {
    const check = validateFeedPayload(
      UNREGISTERED,
      UNREGISTERED_URL,
      zipBytes(PLAIN_CSV.repeat(10)),
    );
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /ZIP archive/);
  });

  test("REJECTS a BIFF8 workbook", () => {
    const biff8 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(256, 0x20),
    ]);
    const check = validateFeedPayload(UNREGISTERED, UNREGISTERED_URL, biff8);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /BIFF8/);
  });

  test("REJECTS a PDF", () => {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(256, 0x20),
    ]);
    const check = validateFeedPayload(UNREGISTERED, UNREGISTERED_URL, pdf);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /PDF/);
  });

  test("REJECTS a NUL byte in the head — e.g. a UTF-16 CSV", () => {
    // No magic to key on, and this is the general case: every CSV consumer
    // reaches its parser through `decodeFeedText`, which ends in
    // `toString("utf8")`. A payload carrying NUL cannot survive that as
    // anything but replacement characters, so the guard is not stricter than
    // the parser — the module's own calibration rule.
    const utf16 = Buffer.from(`﻿${PLAIN_CSV}`, "utf16le");
    assert.ok(utf16.includes(0x00), "the fixture must actually carry a NUL");
    const check = validateFeedPayload(UNREGISTERED, UNREGISTERED_URL, utf16);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /NUL byte/);
  });

  test("ACCEPTS an ordinary CSV — the guard must cost nothing", () => {
    assert.equal(
      validateFeedPayload(UNREGISTERED, UNREGISTERED_URL, buf(PLAIN_CSV)).ok,
      true,
    );
  });

  test("does NOT apply to `unknown`, where four live families are binary", () => {
    // The precision trap in reverse. `nse-fii-stats` is a BIFF8 `.xls`,
    // `nse-market-pulse` is a PDF, and `nse-cm-security-master` /
    // `nse-fo-contract-master` are `.csv.gz`. Applying the binary rule to the
    // `unknown` catch-all would reject all four outright — a guard that
    // rejects valid feeds is worse than the gap it closes.
    const xls = {
      url: "https://nsearchives.nseindia.com/content/fo/fii_stats_14-Aug-2026.xls",
      body: Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(256, 0x20),
      ]),
      descriptor: { exchange: "NSE", feed: "fii-stats", date: DAY } as const,
    };
    assert.equal(feedShapeFor(xls.descriptor, xls.url).kind, "unknown");
    assert.equal(
      validateFeedPayload(xls.descriptor, xls.url, xls.body).ok,
      true,
      "the BIFF8 FII stats workbook must still be archivable",
    );

    const gzUrl =
      "https://nsearchives.nseindia.com/content/master/NSE_CM_security_14082026.csv.gz";
    const gzDescriptor = {
      exchange: "NSE",
      feed: "cm-security-master",
      date: DAY,
    } as const;
    assert.equal(feedShapeFor(gzDescriptor, gzUrl).kind, "unknown");
    assert.equal(
      validateFeedPayload(
        gzDescriptor,
        gzUrl,
        gzipSync(Buffer.from(PLAIN_CSV.repeat(10), "utf-8")),
      ).ok,
      true,
      "a `.csv.gz` master is gzip BY DESIGN and must not be rejected",
    );
  });
});

// ─── (b) the registered shape, and the tokens that could have broken it ──────

const MWPL_URL =
  "https://nsearchives.nseindia.com/archives/nsccl/mwpl/combineoi_deleq_14082026.csv";
const MWPL_DESCRIPTOR = {
  exchange: "NSE",
  feed: "combine-oi-deleq",
  date: new Date(Date.UTC(2026, 7, 14)),
} as const;

/** Every committed `combineoi_deleq` fixture — all four published layouts. */
function mwplFixtures(): Array<{ name: string; body: Buffer }> {
  const dir = join(import.meta.dirname, "..", "fixtures", "nse-mwpl");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort()
    .map((name) => ({ name, body: readFileSync(join(dir, name)) }));
}

describe("NSE/combine-oi-deleq payload shape (MONEY-1206 / D3b)", () => {
  test("the feed is REGISTERED, not left to the generic fallback", () => {
    const shape = feedShapeFor(MWPL_DESCRIPTOR, MWPL_URL);
    assert.equal(shape.kind, "csv");
    assert.deepEqual(shape.requiredTokens, ["Symbol", "Open Interest"]);
  });

  test("ACCEPTS every committed fixture — all four header variants", () => {
    // THE assertion that stops a bad `requiredTokens` from shipping. NSE has
    // published this report in four layouts and they INTERLEAVE, so there is no
    // changeover date to reason from — only the files. A token present in three
    // of the four would reject a whole era at fetch time and look exactly like
    // the exchange having gone quiet.
    const fixtures = mwplFixtures();
    assert.ok(fixtures.length >= 8, `only ${fixtures.length} fixtures found`);
    const variants = new Set(
      fixtures.map((f) => f.body.toString("utf-8").split(/\r?\n/)[0]!),
    );
    assert.equal(
      variants.size,
      4,
      `expected the 4 documented header layouts, found ${variants.size}`,
    );
    for (const { name, body } of fixtures) {
      const check = validateFeedPayload(MWPL_DESCRIPTOR, MWPL_URL, body);
      assert.equal(check.ok, true, `${name}: ${check.ok ? "" : check.reason}`);
    }
  });

  test("`Notional` would have rejected the entire 7-column era", () => {
    // The token that looks obvious from the modern header and is wrong. Kept as
    // an executable record of WHY it is not in requiredTokens: it matches only
    // 2 of the 4 variants — the 409-file era MONEY-1205 just recovered.
    const heads = [
      ...new Set(
        mwplFixtures().map((f) => f.body.toString("utf-8").split(/\r?\n/)[0]!),
      ),
    ];
    const matched = heads.filter((h) => h.toLowerCase().includes("notional"));
    assert.equal(
      matched.length,
      2,
      "if `Notional` ever spans all four layouts this note is stale",
    );
    for (const token of ["Symbol", "Open Interest"]) {
      assert.equal(
        heads.filter((h) => h.toLowerCase().includes(token.toLowerCase()))
          .length,
        heads.length,
        `\`${token}\` must appear in EVERY layout or it rejects valid files`,
      );
    }
  });

  test("REJECTS the gzip object that is actually in the archive", () => {
    // The exact shape of `feeds/NSE/combine-oi-deleq/2025/01/…csv`: real rows,
    // gzipped, stored under a `.csv` key. Rejecting it means the replay treats
    // it as a MISS and re-fetches from NSE instead of serving bytes no CSV
    // parser can read.
    const real = mwplFixtures()[0]!.body;
    const check = validateFeedPayload(
      MWPL_DESCRIPTOR,
      MWPL_URL,
      gzipSync(real),
    );
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /gzip stream/);
  });

  test("REJECTS NSE's 200-with-HTML interstitial", () => {
    const check = validateFeedPayload(
      MWPL_DESCRIPTOR,
      MWPL_URL,
      buf(NSE_THROTTLE_PAGE),
    );
    assert.equal(check.ok, false);
  });

  test("REJECTS a real CSV that is a DIFFERENT nsccl report", () => {
    // The tokens are what keep a mis-built URL from archiving under this key.
    // `oi_cli_limit` lives on the same host and is `SYMBOL,CLIENT_LIMIT,
    // EXCHANGE` — it carries no open-interest column at all.
    const other =
      "SYMBOL,CLIENT_LIMIT,EXCHANGE\nRELIANCE,3300000,NSE\nINFY,2200000,NSE\n";
    const check = validateFeedPayload(MWPL_DESCRIPTOR, MWPL_URL, buf(other));
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /Open Interest/);
  });
});

/**
 * MONEY-1263 — a `json` feed's `requiredTokens` must actually be enforced.
 *
 * The `kind === "json"` branch used to `return { ok: true }` after checking only
 * that the payload STARTS with a bracket, so `requiredTokens` was inert for
 * every json feed that declared one — and three did: `AMFI/aaum-schemewise`
 * ("AMFI_Code"), `SEC/company-tickers` ("cik_str") and `TIINGO/news`
 * ("publishedDate"). Each was written to catch a well-formed 200 carrying the
 * wrong content, and each asserted nothing at all.
 */
describe("json feeds enforce their required tokens (MONEY-1263)", () => {
  const NEWS = { exchange: "TIINGO", feed: "news" } as const;
  const NEWS_URL =
    "https://api.tiingo.com/tiingo/news?startDate=2026-08-27&endDate=2026-08-27";

  test("REJECTS a JSON ERROR ENVELOPE, which the bracket check alone accepts", () => {
    // `{"detail":"Not found."}` is exactly what these hosts return for a bad
    // route or an unentitled endpoint. It is well-formed JSON, it starts with
    // `{`, and before this fix it archived as if it were the feed.
    const envelope = JSON.stringify({
      detail: "Not found.",
      padding: "x".repeat(64),
    });
    const check = validateFeedPayload(NEWS, NEWS_URL, buf(envelope));
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.reason, /publishedDate/);
  });

  test("REJECTS a JSON array of the WRONG feed's rows", () => {
    // A corporate-actions payload archived under the news key: right shape,
    // right host, wrong content.
    const wrongFeed = JSON.stringify([
      { permaTicker: "US000000000038", ticker: "aapl", exDate: "2026-08-27" },
      { permaTicker: "US000000077649", ticker: "dow", exDate: "2026-08-27" },
    ]);
    const check = validateFeedPayload(NEWS, NEWS_URL, buf(wrongFeed));
    assert.equal(check.ok, false);
  });

  test("ACCEPTS a real news payload", () => {
    const real = JSON.stringify([
      {
        id: 102522818,
        publishedDate: "2026-08-28T02:50:24Z",
        title: "CCTV Script",
        url: "https://www.cnbc.com/x.html",
        source: "cnbc.com",
        tickers: ["aapl"],
      },
    ]);
    const check = validateFeedPayload(NEWS, NEWS_URL, buf(real));
    assert.equal(check.ok, true);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   MONEY-1405 — a registered row nobody reaches is not a guard

   `feedShapeFor` is `FEED_SHAPES[`${exchange}/${feed}`] ?? shapeFromUrl(url)`.
   The fallback is the point of that expression and it is also its hazard: ONE
   character of drift between a descriptor's `feed:` string and the table key
   is not an error, a warning or a type failure. It is a silent downgrade to
   `shapeFromUrl`, and for both AMFI feeds that means `kind: "unknown",
   minBytes: 32, requiredTokens: []` — no 500 KB floor, no header tokens, and
   an AMFI maintenance interstitial served with a 200 archived as if it were
   NAVAll.

   Both AMFI rows shipped with no test reaching them at all, so the drift they
   exist to survive would have been invisible. What makes this a real test
   rather than a second copy of the table is that the descriptor strings are
   READ OUT OF THE CALLING SOURCE — retyping `"AMFI"` / `"navall"` here would
   assert only that two literals in this file match each other.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * The `exchange`/`feed` pairs a source file hands to `getFeedAsset`.
 *
 * `exchange` is CAST to the union rather than validated: the string is read out
 * of the calling source precisely so this test cannot restate it, and a typo'd
 * exchange misses the table exactly like a typo'd feed does — which is the
 * failure the assertion below is looking for, not one to short-circuit here.
 */
function descriptorsIn(
  file: string,
): Array<Pick<FeedDescriptor, "exchange" | "feed">> {
  const src = readFileSync(join(import.meta.dirname, "..", "..", file), "utf8");
  return [...src.matchAll(/exchange:\s*"([^"]+)",\s*feed:\s*"([^"]+)"/g)].map(
    ([, exchange, feed]) => ({
      exchange: exchange as FeedDescriptor["exchange"],
      feed: feed!,
    }),
  );
}

/**
 * A URL that matches NO branch of `shapeFromUrl`.
 *
 * Deliberate: the fallback for it is `unknown / 32 / []`, so an assertion that
 * the resolved shape IS the registered row can only pass on a table HIT. The
 * URL is otherwise irrelevant — `feedShapeFor` consults it only on a miss, so
 * proving there is no miss proves it for every URL these feeds use.
 */
const NO_SHAPE_URL = "https://example.invalid/whatever";

const AMFI_DESCRIPTOR_SITES: ReadonlyArray<{
  file: string;
  shape: FeedShape;
}> = [
  {
    file: "src/market-data/instruments/amfi-mf-provider.ts",
    shape: {
      kind: "csv",
      minBytes: 500_000,
      requiredTokens: ["Scheme Code", "Net Asset Value"],
    },
  },
  {
    file: "src/market-data/amfi-amc-registry-fetch.ts",
    shape: {
      kind: "html",
      minBytes: 65536,
      requiredTokens: ['self.__next_f.push([1,"', '\\"members\\":['],
    },
  },
];

describe("the AMFI descriptors in use resolve to their registered rows", () => {
  for (const site of AMFI_DESCRIPTOR_SITES) {
    test(`${site.file} hits its FEED_SHAPES row, not the fallback`, () => {
      const found = descriptorsIn(site.file);
      // FIRST. A regex that matches nothing makes every assertion below pass on
      // an empty list — the failure mode that matters most for a guard whose
      // job is to notice a MISS.
      assert.equal(
        found.length,
        1,
        `expected exactly one getFeedAsset descriptor in ${site.file}, ` +
          `found ${found.length}. If the fetch moved, retarget this test ` +
          `rather than letting it pass on nothing.`,
      );
      const descriptor = found[0]!;
      assert.deepEqual(
        feedShapeFor(descriptor, NO_SHAPE_URL),
        site.shape,
        `${descriptor.exchange}/${descriptor.feed} fell through to ` +
          `shapeFromUrl. The descriptor and the FEED_SHAPES key have drifted ` +
          `apart, which costs this feed its size floor and its required ` +
          `tokens — silently, because a key miss is not an error.`,
      );
    });
  }

  test("the sentinel URL really has no shape of its own", () => {
    // The anti-vacuous half: if `shapeFromUrl` ever grew a default that looked
    // like a registered row, the assertions above would stop distinguishing a
    // hit from a miss.
    assert.deepEqual(
      feedShapeFor(
        { exchange: "AMFI", feed: "not-a-registered-feed" },
        NO_SHAPE_URL,
      ),
      { kind: "unknown", minBytes: 32, requiredTokens: [] },
    );
  });
});
