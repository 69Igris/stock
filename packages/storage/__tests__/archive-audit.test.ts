/**
 * Archive integrity classifier — MONEY-1204 (P14 / 14a.1), corrected by
 * MONEY-1315.
 *
 * The envelope fixtures are built by {@link envelope}, which reproduces the
 * BYTE LAYOUT measured on `stockbook-content-prod`, not a plausible-looking
 * approximation of it: `--<uuid>\r\nContent-Type: application/json\r\n\r\n
 * {"cacheControl":"private, max-age=3600","contentType":"<CT>"}\r\n--<uuid>\r\n
 * Content-Type: <CT>\r\n\r\n<PAYLOAD>\r\n--<uuid>--`. The first test in the
 * file pins the resulting payload OFFSETS against the two values actually
 * observed there (209 for `text/html`, 239 for `text/html; charset=UTF-8`,
 * across 121 objects) so the head-window constant is anchored to bytes rather
 * than to an estimate. MONEY-1201 is the standing reason: a synthetic fixture
 * encodes the same misunderstanding as the code it checks, so it goes green
 * while being wrong.
 *
 * The load-bearing assertions here are the ones that separate REMEDIES:
 *
 *   - `empty` vs `envelope-data` — re-fetch vs repair-in-place. Collapsing
 *     them turns a re-fetchable gap into a permanent one.
 *   - `envelope-html` vs `envelope-data` — MONEY-1315. The old classifier
 *     returned `envelope` from the OUTER bytes and never looked inside, so
 *     1,076 objects were reported REPAIRABLE when ~98% of them wrap a SEBI
 *     landing page and `--apply` correctly refuses every one.
 *   - `envelope-unknown` — "could not determine" is a VALUE, never the
 *     optimistic default. An envelope whose payload the audit cannot see, or
 *     which fails the magic its extension promises, must not be counted as
 *     work `--apply` can do.
 *
 * Synchronous; nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The REAL declaration the classifier consults (MONEY-1320). Imported here so
// the fixtures below are pinned to `FEED_SHAPES` rather than to a transcription
// of it — a test that hardcodes "RBI declares html" would go green on the day
// the row is deleted, which is the failure it exists to catch.
import { feedShapeFor } from "@usemoney/core/market-data";

import {
  ARCHIVE_AUDIT_HEAD_BYTES,
  ENVELOPE_VERDICT_KINDS,
  archiveFamilyOf,
  classifyArchivedObject,
  classifyPayloadBytes,
  emptyFamilyAudit,
  isEnvelopeVerdictKind,
  recordArchiveVerdict,
  type ArchiveVerdictKind,
} from "../src/archive-audit";
import {
  isMultipartEnvelope,
  stripMultipartEnvelope,
} from "../src/multipart-envelope";

/**
 * No `maxRepairBytes`, on purpose: these cases are about the PAYLOAD, and the
 * MONEY-1323 ceiling has its own block below. Omitting it is the documented
 * "this caller does not repair" contract, not a convenience default — so every
 * assertion above stays a statement about bytes.
 */
const classify = (key: string, head: Buffer | string, size?: number) =>
  classifyArchivedObject({
    key,
    size: size ?? (typeof head === "string" ? head.length : head.length),
    head: typeof head === "string" ? Buffer.from(head, "latin1") : head,
  });

/** A UUID-shaped boundary — 36 chars, the shape the SDK actually emits. */
const UUID = "56b61759-0e3c-433a-9036-102a7a0da3fa";

/**
 * Build a MONEY-1169 envelope exactly as prod holds them.
 *
 * `extraMeta` exists because the preamble is NOT a fixed length: `uploadFile`
 * splices arbitrary caller-supplied `metadata` into the same JSON part, which
 * is the mechanism that can push a payload past the head window.
 */
function envelope(opts: {
  contentType: string;
  payload: Buffer | string;
  extraMeta?: string;
  boundary?: string;
}): Buffer {
  const b = `--${opts.boundary ?? UUID}`;
  const meta =
    `{"cacheControl":"private, max-age=3600",` +
    `${opts.extraMeta ?? ""}"contentType":"${opts.contentType}"}`;
  return Buffer.concat([
    Buffer.from(
      `${b}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n` +
        `${b}\r\nContent-Type: ${opts.contentType}\r\n\r\n`,
      "latin1",
    ),
    typeof opts.payload === "string"
      ? Buffer.from(opts.payload, "latin1")
      : opts.payload,
    Buffer.from(`\r\n${b}--`, "latin1"),
  ]);
}

/** The real SEBI page, in the shape prod stores it under a `.txt` DRHP key. */
const SEBI_PAGE =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
  "<title>SEBI | AAA Technologies Limited - Prospectus</title>\n</head>";

const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n", "latin1"),
  Buffer.alloc(200, 0x20),
]);

describe("envelope fixtures reproduce the bytes measured on prod", () => {
  it("payload offsets are the 209 / 239 observed under stocks/", () => {
    // Preamble = 191 + 2 x len(contentType) for the writer's metadata shape.
    // Measured across 121 envelope-bearing objects on stockbook-content-prod:
    // min 209 (`text/html`), p50/p95/max 239 (`text/html; charset=UTF-8`).
    // If this drifts, the head-window arithmetic below is no longer anchored
    // to anything real.
    for (const [contentType, expected] of [
      ["text/html", 209],
      ["text/html; charset=UTF-8", 239],
    ] as const) {
      const buf = envelope({ contentType, payload: SEBI_PAGE });
      const offset = buf.indexOf(Buffer.from(SEBI_PAGE, "latin1"));
      assert.equal(offset, expected, contentType);
      assert.equal(offset, 191 + 2 * contentType.length, contentType);
    }
  });

  it("the fixtures are real envelopes by the production detector", () => {
    // Pinning against the shipped predicate keeps this from becoming a second,
    // drifting implementation of "is it an envelope".
    assert.ok(
      isMultipartEnvelope(
        envelope({ contentType: "text/html", payload: SEBI_PAGE }),
      ),
    );
    assert.ok(
      isMultipartEnvelope(
        envelope({ contentType: "application/pdf", payload: PDF_BYTES }),
      ),
    );
  });
});

describe("classifyArchivedObject — MONEY-1315, the verdict is the PAYLOAD", () => {
  it("an envelope wrapping HTML is `envelope-html` — NOT repairable", () => {
    // The defect this ticket exists for. `feed-repair --apply
    // --prefixes=stocks/` reported repaired=0 clean=29,666 failed=329 because
    // 59 of every 60 envelope-detected objects wrap a SEBI landing page.
    // Reporting these as repairable is what made `repaired=0` read as a
    // broken repairer rather than a wrongly-labelled population.
    const v = classify(
      "stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt",
      envelope({ contentType: "text/html; charset=UTF-8", payload: SEBI_PAGE }),
    );
    assert.equal(v.kind, "envelope-html");
    assert.match(v.why, /NOT repairable/i);
    assert.match(v.why, /re-fetch|quarantine/i);
  });

  it("an envelope wrapping a real PDF is `envelope-data` — repairable", () => {
    // The control that proves the detector can say YES. Without it,
    // "everything is envelope-html" would pass every other case in this block.
    const v = classify(
      "stocks/RELIANCE/annual_report/RELIANCE-2025.pdf",
      envelope({ contentType: "application/pdf", payload: PDF_BYTES }),
    );
    assert.equal(v.kind, "envelope-data");
    assert.match(v.why, /repairable in place/i);
  });

  it("an envelope over an EXTENSIONLESS key still resolves from the payload", () => {
    // `stocks/<SYM>/annual_report/<title>` carries no extension at all, so the
    // key supplies no rule and only the bytes can decide.
    assert.equal(
      classify(
        "stocks/RELIANCE/annual_report/Annual Report 2025",
        envelope({ contentType: "application/pdf", payload: PDF_BYTES }),
      ).kind,
      "envelope-data",
    );
    assert.equal(
      classify(
        "stocks/RELIANCE/annual_report/Annual Report 2025",
        envelope({ contentType: "text/html", payload: SEBI_PAGE }),
      ).kind,
      "envelope-html",
    );
  });

  it("an envelope wrapping a payload that fails its extension is `envelope-unknown`, never `envelope-data`", () => {
    // The 1-in-60 the prod probe found: `pdf without %PDF magic at offset 0`.
    // It is not HTML, so it cannot be `envelope-html`; it is also not
    // repairable, so calling it `envelope-data` would reproduce this ticket's
    // defect at 2% instead of 98%.
    const v = classify(
      "stocks/X/drhp/X.pdf",
      envelope({
        contentType: "application/pdf",
        payload: "GIF89a not a pdf at all",
      }),
    );
    assert.equal(v.kind, "envelope-unknown");
    assert.match(v.why, /%PDF/);
    assert.match(v.why, /refuse/i);
  });

  it("the declared content type can only make the verdict STRICTER", () => {
    // Metadata can lie, so the bytes lead. Here the key has no extension and
    // the envelope claims zip: a payload with no PK magic must NOT pass just
    // because there is no extension rule to fail.
    assert.equal(
      classify(
        "stocks/X/annual_report/no-extension",
        envelope({ contentType: "application/zip", payload: "plain text" }),
      ).kind,
      "envelope-unknown",
    );
    // ...and a payload that satisfies it passes.
    assert.equal(
      classify(
        "stocks/X/annual_report/no-extension",
        envelope({
          contentType: "application/zip",
          payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
        }),
      ).kind,
      "envelope-data",
    );
  });

  it("HTML beats the extension check — the diagnosis, not just the refusal", () => {
    // `verifyPayload` tests the .pdf branch first and reports "pdf without
    // %PDF magic" for an HTML payload under a .pdf key. Same refusal, worse
    // diagnosis: it names a magic byte when the real finding is that the
    // stored DOCUMENT is a challenge page.
    const v = classify(
      "stocks/X/drhp/X.pdf",
      envelope({ contentType: "text/html", payload: SEBI_PAGE }),
    );
    assert.equal(v.kind, "envelope-html");
  });
});

describe("classifyArchivedObject — the head window is a FACT, not an assumption", () => {
  it("an envelope whose payload starts beyond the head is `envelope-unknown`", () => {
    // `uploadFile` splices caller `metadata` into the same JSON part, so the
    // preamble is not structurally bounded. When the payload has not arrived
    // inside the head there is nothing to sniff — and the ONLY safe answer is
    // "undetermined". Defaulting to `envelope-data` here is the MONEY-1315
    // bug one layer down; defaulting to `envelope-html` would be a lie about a
    // document nobody looked at.
    const big = envelope({
      contentType: "text/csv",
      extraMeta: `"pad":"${"x".repeat(ARCHIVE_AUDIT_HEAD_BYTES * 2)}",`,
      payload: "SYMBOL,SERIES\nRELIANCE,EQ",
    });
    const head = big.subarray(0, ARCHIVE_AUDIT_HEAD_BYTES);
    assert.ok(
      isMultipartEnvelope(head),
      "precondition: the truncated head is still detected as an envelope",
    );
    assert.equal(
      stripMultipartEnvelope(head),
      null,
      "precondition: the payload really is unreachable from this head",
    );

    const v = classify("feeds/NSE/x/2026/08/a.csv", head, big.length);
    assert.equal(v.kind, "envelope-unknown");
    assert.match(v.why, new RegExp(String(ARCHIVE_AUDIT_HEAD_BYTES)));
    assert.match(v.why, /NOT counted as\s+repairable/i);
    // It must never be mistaken for work `--apply` can do.
    assert.notEqual(v.kind, "envelope-data");
  });

  it("the budget clears the worst preamble measured on prod with room to sniff", () => {
    // 239 bytes of preamble + enough payload to recognise `<!doctype html`.
    // A classifier that needed more would silently mis-verdict at scale rather
    // than erroring, which is the failure mode with no signal at all.
    assert.ok(
      ARCHIVE_AUDIT_HEAD_BYTES >= 239 + 64,
      `head budget ${ARCHIVE_AUDIT_HEAD_BYTES} cannot reach a prod payload`,
    );
  });

  it("classifies correctly from a head truncated to exactly the budget", () => {
    // This is what the audit actually passes: a ranged read, not the object.
    const html = envelope({
      contentType: "text/html; charset=UTF-8",
      payload: SEBI_PAGE + "x".repeat(8000),
    });
    const pdf = envelope({
      contentType: "application/pdf",
      payload: Buffer.concat([PDF_BYTES, Buffer.alloc(9000, 0x41)]),
    });
    assert.equal(
      classify(
        "stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt",
        html.subarray(0, ARCHIVE_AUDIT_HEAD_BYTES),
        html.length,
      ).kind,
      "envelope-html",
    );
    assert.equal(
      classify(
        "stocks/X/annual_report/X.pdf",
        pdf.subarray(0, ARCHIVE_AUDIT_HEAD_BYTES),
        pdf.length,
      ).kind,
      "envelope-data",
    );
  });

  it("tolerates a head shorter than the budget (a genuinely small object)", () => {
    assert.equal(classify("feeds/NSE/x/2026/08/tiny.csv", "a", 1).kind, "ok");
  });
});

describe("classifyArchivedObject — bare objects are unchanged by MONEY-1315", () => {
  it("a bare HTML page is `html`", () => {
    // NSE/BSE answer a throttled or cookieless request with a 200 carrying
    // HTML. A parser handed this reports zero rows, which reads as a holiday.
    const v = classify(
      "feeds/NSE/fii-stats/2026/08/fii_stats_13-Aug-2026.csv",
      "<!DOCTYPE html><html><head><title>Access Denied</title>",
    );
    assert.equal(v.kind, "html");
  });

  it("flags bare HTML even when the key claims zip", () => {
    assert.equal(
      classify("feeds/NSE/bhavcopy/2026/08/x.csv.zip", "<html><body>nope").kind,
      "html",
    );
  });

  it("a bare valid PDF is `ok` — the control for the whole file", () => {
    assert.equal(
      classify("stocks/X/annual_report/X.pdf", PDF_BYTES).kind,
      "ok",
    );
  });

  it("does NOT mistake real XML for HTML", () => {
    // The XBRL archive (14a.0) stores .xml. `<?xml ...` starts with `<` and
    // must not trip the HTML sniff.
    assert.equal(
      classify(
        "feeds/NSE/results-xbrl/2026/08/INDAS_1.xml",
        '<?xml version="1.0"?><xbrl xmlns="http://www.xbrl.org/2003/instance">',
      ).kind,
      "ok",
    );
  });

  it("a zero-byte object is `empty`, NOT `invalid`", () => {
    // It trivially fails every magic-byte check, so ordering matters: reported
    // as `invalid` it would send a responder to repair bytes that do not exist.
    const v = classify(
      "feeds/NSE/bhavcopy/2026/08/x.csv.zip",
      Buffer.alloc(0),
      0,
    );
    assert.equal(v.kind, "empty");
    assert.match(v.why, /re-fetch/i);
  });

  it("empty and envelope-data are never conflated — opposite remedies", () => {
    const zipEnvelope = envelope({
      contentType: "application/zip",
      payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]),
    });
    assert.equal(
      classify("feeds/NSE/x/2026/08/b.zip", zipEnvelope).kind,
      "envelope-data",
    );
    assert.equal(
      classify("feeds/NSE/x/2026/08/a.zip", Buffer.alloc(0), 0).kind,
      "empty",
    );
    // A nonzero-looking head reported with size 0 must still classify on the
    // SIZE, which is the authoritative signal.
    assert.equal(
      classify("feeds/NSE/x/2026/08/c.zip", zipEnvelope, 0).kind,
      "empty",
    );
  });
});

describe("classifyArchivedObject — per-extension magic", () => {
  it("rejects a zip without PK magic", () => {
    const v = classify(
      "feeds/NSE/bhavcopy/2026/08/x.csv.zip",
      "not a zip at all",
    );
    assert.equal(v.kind, "invalid");
    assert.match(v.why, /PK magic/);
  });

  it("accepts BIFF8/OLE2 for .xls — the form NSE actually serves", () => {
    // fii_stats is a genuine OLE2 compound document (0xD0CF11E0). Accepting
    // only the .xlsx zip form would flag all 1,636 good objects as corrupt.
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64, 0),
    ]);
    assert.equal(
      classify("feeds/NSE/fii-stats/2026/08/fii_stats_13-Aug-2026.xls", ole2)
        .kind,
      "ok",
    );
  });

  it("accepts a zip-form workbook too (.xlsx)", () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64, 0),
    ]);
    assert.equal(classify("feeds/NSE/x/2026/08/book.xlsx", zip).kind, "ok");
  });

  it("rejects a workbook with neither magic", () => {
    assert.equal(
      classify("feeds/NSE/fii-stats/2026/08/x.xls", "Sr no,Security,Series")
        .kind,
      "invalid",
    );
  });

  it("passes csv/dat/lst through without inventing a magic they do not have", () => {
    // A precise rule with no catch-all shrinks coverage the moment a new feed
    // format lands, so the honest verdict for text is "not empty, not an
    // envelope, not HTML".
    for (const key of [
      "feeds/NSE/fii-stats/2026/08/a.csv",
      "feeds/NSE/egr-bhavcopy/2026/08/EG_BC13082026.DAT",
      "feeds/NSE/oi-cli-limit/2026/08/oi_cli_limit_13-AUG-2026.lst",
      "feeds/BSE/scrip-master/current/bse-scrip-master",
    ]) {
      assert.equal(classify(key, "SYMBOL,SERIES\nRELIANCE,EQ").kind, "ok", key);
    }
  });
});

describe("archiveFamilyOf", () => {
  it("derives exchange/feed from a dated key", () => {
    assert.equal(
      archiveFamilyOf("feeds/NSE/fii-stats/2026/08/fii_stats_13-Aug-2026.xls"),
      "NSE/fii-stats",
    );
  });

  it("derives it from an undated `current/` key too", () => {
    assert.equal(
      archiveFamilyOf("feeds/BSE/scrip-master/current/bse-scrip-master.json"),
      "BSE/scrip-master",
    );
  });

  it("derives the DOCUMENT TYPE from a stocks/ key, not the symbol", () => {
    // MONEY-1315. Without this the 99,853 objects under `stocks/` all landed in
    // `(unrecognised)`, so the per-family table collapsed to one row and showed
    // five example keys for the whole tree — correct and unreadable. Keying on
    // the doc type names the scraper leg that needs re-fetching; keying on the
    // symbol would be ~2,400 single-digit rows nobody can scan.
    assert.equal(
      archiveFamilyOf("stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt"),
      "stocks/drhp",
    );
    assert.equal(
      archiveFamilyOf(
        "stocks/AASTHA/credit_rating/AASTHA-credit_rating-May 2023.txt",
      ),
      "stocks/credit_rating",
    );
    assert.equal(
      archiveFamilyOf("stocks/RELIANCE/annual_report/Annual Report 2025"),
      "stocks/annual_report",
    );
  });

  it("buckets a key that does not fit either grammar rather than dropping it", () => {
    // An object that does not match the key grammar IS a finding. Silently
    // skipping it is how the audit reports a clean archive it never looked at.
    assert.equal(archiveFamilyOf("feeds/NSE"), "(unrecognised)");
    assert.equal(archiveFamilyOf("stocks/RELIANCE"), "(unrecognised)");
    assert.equal(archiveFamilyOf("learning/video/x.mp4"), "(unrecognised)");
    assert.equal(archiveFamilyOf(""), "(unrecognised)");
  });
});

describe("MONEY-1320 — HTML is not corruption where HTML is the declared payload", () => {
  /**
   * The audit called six live RBI objects `html`, which read as a dark feed
   * archiving challenge pages. The premise was false — prod archived them on
   * `macro-sync-midweek` at 08:00 IST 2026-09-01, and the production parser
   * reads 90 rows / 15 series (rates), 23/8 (prices) and 10/10 (forex) out of
   * exactly those bytes, all FRESH.
   *
   * The two directions are asserted TOGETHER on purpose. Fixing a false
   * positive by exempting HTML is only correct if a family with no declaration
   * still verdicts `html`; otherwise the fix is a blind spot wearing a fix's
   * clothes.
   */
  const RBI_PAGE = Buffer.from(
    '<!DOCTYPE html>\n<html><head><title>Reserve Bank of India</title></head>\n<body class="rbi">',
    "latin1",
  );
  const DECLARED = ["nsdp-rates", "nsdp-prices", "nsdp-forex"] as const;

  it("the three RBI families really are declared `html` in FEED_SHAPES", () => {
    // The premise of every case below, taken from the source of truth rather
    // than asserted. If a row is renamed or dropped, this fails FIRST and names
    // the reason, instead of the exemption quietly ceasing to apply.
    for (const feed of DECLARED) {
      assert.equal(
        feedShapeFor({ exchange: "RBI", feed }, "").kind,
        "html",
        `RBI/${feed} is no longer declared html`,
      );
    }
  });

  it("a declared-HTML family classifies `ok`, not `html`", () => {
    for (const feed of DECLARED) {
      const v = classify(`feeds/RBI/${feed}/2026/09/${feed}.html`, RBI_PAGE);
      assert.equal(v.kind, "ok", feed);
      assert.equal(v.why, "");
    }
  });

  it("an UNDECLARED feed under the SAME publisher still classifies `html`", () => {
    // The blind-spot direction. The licence is per FAMILY, never per publisher
    // — `RBI/` is not a blanket exemption.
    assert.equal(
      classify("feeds/RBI/nsdp-bogus/2026/09/x.html", RBI_PAGE).kind,
      "html",
    );
  });

  it("an undeclared family cannot acquire the licence from the URL fallback", () => {
    // `feedShapeFor` falls back to `shapeFromUrl`, whose codomain is
    // zip|csv|json|xml|unknown — it can never return `html`. That is what makes
    // passing an empty URL safe by construction rather than by luck, so it is
    // asserted rather than assumed.
    for (const url of ["", "x.html", "x.htm", "x.csv", "x.zip", "x.json"]) {
      assert.notEqual(
        feedShapeFor({ exchange: "NSE", feed: "not-a-real-feed" }, url).kind,
        "html",
        url,
      );
    }
    assert.equal(
      classify("feeds/NSE/not-a-real-feed/2026/09/x.html", RBI_PAGE).kind,
      "html",
    );
  });

  it("the exemption never reaches the stocks/ tree", () => {
    // `stocks/<doc-type>` shares the `X/Y` family shape but is not a feed
    // family. The 1,046 enveloped SEBI landing pages and 527 bare ones under
    // `stocks/` must keep their verdicts.
    assert.equal(
      classify("stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt", SEBI_PAGE).kind,
      "html",
    );
    assert.equal(
      classify(
        "stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt",
        envelope({ contentType: "text/html", payload: SEBI_PAGE }),
      ).kind,
      "envelope-html",
    );
  });

  it("the REPAIR agrees — the exemption lives in the shared predicate", () => {
    // It is applied inside `classifyPayloadBytes`, which `verifyPayload` calls
    // directly. One level up and the census would say `ok` while the repair
    // went on refusing the same bytes — the MONEY-1323 divergence rebuilt.
    assert.equal(
      classifyPayloadBytes(
        "feeds/RBI/nsdp-rates/2026/09/nsdp-rates.html",
        RBI_PAGE,
      ).kind,
      "ok",
    );
    // And an enveloped RBI page is therefore REPAIRABLE, not envelope-html:
    // stripping it yields the right document.
    assert.equal(
      classify(
        "feeds/RBI/nsdp-rates/2026/09/nsdp-rates.html",
        envelope({ contentType: "text/html", payload: RBI_PAGE }),
      ).kind,
      "envelope-data",
    );
  });

  it("says nothing about whether the page is the RIGHT one", () => {
    // `class="tablebg"` sits ~40-49 KB into a live RBI page and the head window
    // is 1,024 bytes, so the token check is structurally out of reach here. It
    // lives at the WRITE (`validateFeedPayload`), which refuses to archive a
    // page without it. This test pins the LIMIT so nobody later reads `ok` as
    // "the audit verified the table".
    const chrome = Buffer.from(
      "<!DOCTYPE html><html><head><title>RBI</title></head><body>nav only</body></html>",
      "latin1",
    );
    assert.ok(!chrome.includes(Buffer.from('class="tablebg"')));
    assert.equal(
      classify("feeds/RBI/nsdp-rates/2026/09/x.html", chrome).kind,
      "ok",
    );
  });
});

describe("MONEY-1323 — the repair CEILING is part of the verdict", () => {
  /**
   * The five real objects, measured 2026-09-02 on `stockbook-content-prod`,
   * that made `--apply` report `repaired=0` against a census promising five
   * repairs. All are intact PDFs inside a MONEY-1169 envelope; all exceed the
   * default 100 MB `--max-bytes`, and the repair tests size and `continue`s
   * BEFORE the download, so it never reaches them.
   */
  const MAX_BYTES_DEFAULT = 100 * 1024 * 1024;
  const OVERSIZED = [
    ["stocks/ARHAM/concall_ppt/ARHAM-concall_ppt-Jun 2026.pdf", 108_318_720],
    ["stocks/BTML/concall_ppt/BTML-concall_ppt-Dec 2022.pdf", 160_113_459],
    ["stocks/HUDCO/annual_report/HUDCO-annual_report-FY2014.pdf", 141_875_609],
    [
      "stocks/SHOPERSTOP/annual_report/SHOPERSTOP-annual_report-FY2014.pdf",
      222_298_112,
    ],
    ["stocks/SKP/announcement/SKP-announcement-2025.pdf", 154_350_387],
  ] as const;

  const enveloped = envelope({
    contentType: "application/pdf",
    payload: PDF_BYTES,
  });

  it("an intact payload ABOVE the ceiling is `envelope-too-large`, never `envelope-data`", () => {
    for (const [key, size] of OVERSIZED) {
      const v = classifyArchivedObject({
        key,
        size,
        head: enveloped,
        maxRepairBytes: MAX_BYTES_DEFAULT,
      });
      assert.equal(v.kind, "envelope-too-large", key);
      // The diagnosis has to carry BOTH numbers, or the reader cannot tell
      // which lever to pull.
      assert.ok(v.why.includes(String(size)), `size missing from why: ${key}`);
      assert.ok(
        v.why.includes(String(MAX_BYTES_DEFAULT)),
        `ceiling missing from why: ${key}`,
      );
    }
  });

  it("the SAME object under a LARGER ceiling is `envelope-data` — the ceiling is what decides", () => {
    // The control for the whole block. The bytes never change; only the
    // caller's budget does. This is the measured `--max-bytes=250000000`
    // re-run, which reported `repaired=3` and dropped `too-large` from the
    // reason tally entirely.
    for (const [key, size] of OVERSIZED) {
      const v = classifyArchivedObject({
        key,
        size,
        head: enveloped,
        maxRepairBytes: 250_000_000,
      });
      assert.equal(
        v.kind,
        size > 250_000_000 ? "envelope-too-large" : "envelope-data",
        key,
      );
    }
  });

  it("an object exactly AT the ceiling is repairable — the repair's test is `>`, not `>=`", () => {
    // Pinned against `feed-repair`'s own `if (size > MAX_BYTES)`. An off-by-one
    // here would relabel a repairable object as unreachable, which is the
    // census lying in the newly-available direction.
    const at = classifyArchivedObject({
      key: "stocks/X/annual_report/X.pdf",
      size: MAX_BYTES_DEFAULT,
      head: enveloped,
      maxRepairBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(at.kind, "envelope-data");
    const over = classifyArchivedObject({
      key: "stocks/X/annual_report/X.pdf",
      size: MAX_BYTES_DEFAULT + 1,
      head: enveloped,
      maxRepairBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(over.kind, "envelope-too-large");
  });

  it("the ceiling NEVER relabels envelope-html or envelope-unknown", () => {
    // Size does not change those remedies: an oversized challenge page still
    // needs a re-fetch and an unjudgeable payload still needs eyes. Relabelling
    // either by size would hide a real diagnosis behind an operational one.
    const html = classifyArchivedObject({
      key: "stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt",
      size: 500_000_000,
      head: envelope({ contentType: "text/html", payload: SEBI_PAGE }),
      maxRepairBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(html.kind, "envelope-html");

    const unknown = classifyArchivedObject({
      key: "stocks/X/annual_report/X.pdf",
      size: 500_000_000,
      head: envelope({
        contentType: "application/pdf",
        payload: Buffer.from("not a pdf at all", "latin1"),
      }),
      maxRepairBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(unknown.kind, "envelope-unknown");
  });

  it("a bare (unwrapped) object is untouched by the ceiling", () => {
    // `--apply` only ever rewrites envelopes, so an oversized healthy zip is
    // `ok` and an oversized challenge page is `html`. Neither is repair work
    // the ceiling can withhold.
    assert.equal(
      classifyArchivedObject({
        key: "feeds/NSE/bhavcopy/2026/08/x.zip",
        size: 500_000_000,
        head: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        maxRepairBytes: MAX_BYTES_DEFAULT,
      }).kind,
      "ok",
    );
    assert.equal(
      classifyArchivedObject({
        key: "feeds/NSE/bhavcopy/2026/08/x.csv",
        size: 500_000_000,
        head: Buffer.from(SEBI_PAGE, "latin1"),
        maxRepairBytes: MAX_BYTES_DEFAULT,
      }).kind,
      "html",
    );
  });

  it("OMITTING the ceiling means the caller does not repair — size is ignored, not assumed infinite", () => {
    // `document-body-guard.ts` in packages/research is that caller: it asks
    // whether a stored body is an HTML landing page, never whether `--apply`
    // could rewrite it. A size-derived verdict there would be noise, and a
    // REQUIRED argument would have forced it to invent a ceiling it has no
    // opinion about.
    const v = classifyArchivedObject({
      key: "stocks/SKP/announcement/SKP-announcement-2025.pdf",
      size: 154_350_387,
      head: enveloped,
    });
    assert.equal(v.kind, "envelope-data");
  });

  it("a non-finite ceiling is ignored rather than swallowing the whole census", () => {
    // NaN is what `Number(arg("max-bytes"))` yields for `--max-bytes=big`.
    // `size > NaN` is false, so an unguarded comparison would silently disable
    // the ceiling; the guard makes it explicit and the verdict honest.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        classifyArchivedObject({
          key: "stocks/SKP/announcement/SKP-announcement-2025.pdf",
          size: 154_350_387,
          head: enveloped,
          maxRepairBytes: bad,
        }).kind,
        "envelope-data",
        String(bad),
      );
    }
  });
});

describe("MONEY-1323 — ONE predicate: `envelope-data` iff the repair accepts it", () => {
  /**
   * The load-bearing invariant of the whole census, asserted as an
   * EQUIVALENCE rather than as two separate expectations:
   *
   *   audit says `envelope-data`  <=>  `--apply` would rewrite the object
   *
   * `feed-repair.ts`'s `verifyPayload` cannot be imported — that file calls
   * `main()` at module scope, so importing it to test it RUNS it against a
   * real bucket. What it CAN do, and now does, is call
   * `classifyPayloadBytes`; so the two sides below are the two CALL PATHS into
   * the one predicate: `classifyArchivedObject` (what the audit reports) and
   * `classifyPayloadBytes` (what the repair asks). The block after this one
   * pins, by source scan, that the repair has no third path of its own.
   *
   * Every row here is a case where the two copies HAD diverged. Before the
   * fix the `<?xml-stylesheet` row read `envelope-html` on the audit side and
   * `accepts` on the repair side — the audit calling something unrepairable
   * that the repair would happily rewrite, and the `.xls` / `.xlsx` / `.xml`
   * rows the same defect in the other direction.
   */
  const CASES: Array<{
    name: string;
    key: string;
    contentType: string;
    payload: Buffer;
    auditKind: ArchiveVerdictKind;
  }> = [
    {
      name: "<?xml-stylesheet page under a .txt key",
      key: "stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt",
      contentType: "text/xml",
      payload: Buffer.from(
        '<?xml-stylesheet type="text/xsl" href="x.xsl"?>\n<Report/>',
        "latin1",
      ),
      auditKind: "envelope-html",
    },
    {
      name: ".xls that is neither OLE2 nor zip",
      key: "feeds/NSE/fii-stats/2026/08/fii_stats.xls",
      contentType: "application/vnd.ms-excel",
      payload: Buffer.from("date,buy,sell\n2026-08-31,1,2\n", "latin1"),
      auditKind: "envelope-unknown",
    },
    {
      name: ".xlsx that is neither OLE2 nor zip",
      key: "feeds/NSE/fii-stats/2026/08/fii_stats.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      payload: Buffer.from("nonsense", "latin1"),
      auditKind: "envelope-unknown",
    },
    {
      name: ".xml that does not start with <",
      key: "feeds/NSE/corp-actions/2026/08/actions.xml",
      contentType: "application/xml",
      payload: Buffer.from("oops not xml", "latin1"),
      auditKind: "envelope-unknown",
    },
    // Controls — populations that must stay on the accepting side, so the
    // equivalence cannot be satisfied by refusing everything.
    {
      name: "a real BIFF8 workbook (the form NSE actually serves)",
      key: "feeds/NSE/fii-stats/2026/08/fii_stats.xls",
      contentType: "application/vnd.ms-excel",
      payload: Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
        Buffer.alloc(64, 0),
      ]),
      auditKind: "envelope-data",
    },
    {
      name: "real XML (which is NOT html, stylesheet or no stylesheet)",
      key: "feeds/NSE/corp-actions/2026/08/actions.xml",
      contentType: "application/xml",
      payload: Buffer.from('<?xml version="1.0"?><Report/>', "latin1"),
      auditKind: "envelope-data",
    },
    {
      name: "a real PDF",
      key: "stocks/X/annual_report/X.pdf",
      contentType: "application/pdf",
      payload: PDF_BYTES,
      auditKind: "envelope-data",
    },
  ];

  for (const c of CASES) {
    it(`agrees on ${c.name}`, () => {
      const head = envelope({
        contentType: c.contentType,
        payload: c.payload,
      });
      const audit = classifyArchivedObject({
        key: c.key,
        size: head.length,
        head,
        maxRepairBytes: 100 * 1024 * 1024,
      });
      assert.equal(audit.kind, c.auditKind, `audit verdict for ${c.name}`);

      // The repair's side: `verifyPayload` strips, then hands the payload to
      // this exact function and accepts iff it says `ok`.
      const stripped = stripMultipartEnvelope(head);
      assert.ok(stripped, "fixture must strip");
      const repairAccepts =
        classifyPayloadBytes(c.key, stripped.payload, stripped.contentType)
          .kind === "ok";

      assert.equal(
        audit.kind === "envelope-data",
        repairAccepts,
        `census and repair disagree on ${c.name}: audit=${audit.kind} ` +
          `repairAccepts=${repairAccepts}`,
      );
    });
  }

  it("every refusal carries a low-cardinality code, because the reason tally buckets on it", () => {
    // `feed-repair` prints `html=253 pdf-magic=1`. A tally keyed on the prose
    // `why` would grow one bucket per sentence, which is the memory leak the
    // MAX_DISTINCT_REASONS cap exists to prevent — and the codes have to
    // survive the delegation or one population silently splits into two rows.
    const seen = new Map<string, string>();
    for (const [key, ct, bytes, code] of [
      ["a.zip", undefined, "not a zip", "zip-magic"],
      ["a.pdf", undefined, "not a pdf", "pdf-magic"],
      ["a.json", undefined, "not json", "json-magic"],
      ["a.xml", undefined, "not xml", "xml-magic"],
      ["a.xlsx", undefined, "not a workbook", "workbook-magic"],
      ["a.csv", undefined, "<!DOCTYPE html>", "html"],
      ["a.txt", "application/pdf", "not a pdf", "pdf-magic"],
      ["a.txt", "application/zip", "not a zip", "zip-magic"],
      ["a.txt", "application/json", "not json", "json-magic"],
    ] as const) {
      const v = classifyPayloadBytes(key, Buffer.from(bytes, "latin1"), ct);
      assert.notEqual(v.kind, "ok", `${key} ${ct ?? ""}`);
      assert.equal(v.code, code, `${key} ${ct ?? ""}`);
      seen.set(v.code, v.why);
    }
    // An `ok` carries no code at all — an empty bucket in the tally would be
    // a reason with no reason.
    assert.equal(
      classifyPayloadBytes("a.csv", Buffer.from("a,b\n1,2")).code,
      "",
    );
    // The vocabulary stays SMALL. It is the tally's key space.
    assert.equal(seen.size, 6);
  });
});

describe("MONEY-1323 — feed-repair carries no second copy of the predicate", () => {
  /**
   * A SOURCE SCAN, and the reason is structural rather than lazy:
   * `scripts/jobs/feed-repair.ts` calls `main()` at module scope, so importing
   * `verifyPayload` to exercise it would start a real walk of a real bucket.
   *
   * What the scan buys is precisely the failure this ticket is about. The two
   * predicates did not diverge by anyone editing both — they diverged because
   * a magic-byte rule was added to ONE of them. A test that only checks
   * behaviour cannot see a second predicate being born; this one goes red the
   * moment a `%PDF` or an HTML regex reappears in that file.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(
    resolve(here, "../../../scripts/jobs/feed-repair.ts"),
    "utf-8",
  );

  it("delegates to classifyPayloadBytes", () => {
    assert.match(SRC, /classifyPayloadBytes/);
    // Inside `verifyPayload`, not merely imported somewhere in the file.
    const body = /function verifyPayload\([\s\S]*?\n}/.exec(SRC)?.[0] ?? "";
    assert.ok(body.length > 0, "verifyPayload not found — did it get renamed?");
    assert.match(body, /classifyPayloadBytes\(/);
  });

  it("holds no magic-byte or HTML predicate of its own", () => {
    // Comments are stripped first: this file documents the rules it used to
    // carry, at length, and a scan that cannot tell prose from code would
    // either fail on the documentation or force the documentation out.
    //
    // LINE BEFORE BLOCK, and the order is load-bearing — MONEY-1143. Stripping
    // BLOCK first means a `//` comment that happens to contain `/*` opens a
    // block that swallows every line up to the next `*/`. This scan asserts an
    // ABSENCE, so swallowed code reads as a PASS: the guard would go quiet
    // exactly when a second predicate had been reintroduced inside the
    // swallowed region. `apps/web/__tests__/meta/comment-strip-ordering.test.ts`
    // enforces this repo-wide and caught this file.
    const code = SRC.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    for (const [what, re] of [
      ["a %PDF magic literal", /%PDF/],
      ["a PK zip magic literal", /0x4b|0x50/i],
      ["an OLE2 magic literal", /0xd0cf11e0|0xcf/i],
      ["an HTML doctype regex", /<!doctype/i],
      ["an <html> regex", /\|html\)/i],
    ] as const) {
      assert.doesNotMatch(code, re, `feed-repair.ts re-grew ${what}`);
    }
  });

  it("passes the repair ceiling into the audit", () => {
    // The other half of MONEY-1323: a census that does not know the ceiling
    // reports work `--apply` will not do. Pinned here because the argument is
    // optional by design (see the classifier's docblock), so its absence is
    // not a compile error at this call site.
    assert.match(SRC, /classifyArchivedObject\(\{[\s\S]*?maxRepairBytes:/);
  });
});

describe("the tally can never silently drop a verdict kind", () => {
  const ALL_KINDS: ArchiveVerdictKind[] = [
    "ok",
    "empty",
    "envelope-data",
    "envelope-html",
    "envelope-unknown",
    "envelope-too-large",
    "html",
    "invalid",
  ];

  it("every kind has a counter that starts at 0 and increments", () => {
    // `ArchiveFamilyAudit extends Record<ArchiveVerdictKind, number>`, so a new
    // kind without a counter is a compile error — this pins the runtime half:
    // a counter that exists but is never reached is the same undercount.
    for (const kind of ALL_KINDS) {
      const t = emptyFamilyAudit("NSE/x");
      assert.equal(t[kind], 0, `${kind} missing from emptyFamilyAudit`);
      recordArchiveVerdict(t, `feeds/NSE/x/2026/08/${kind}`, {
        kind,
        why: "w",
      });
      assert.equal(t[kind], 1, `${kind} not incremented`);
      assert.equal(t.scanned, 1);
    }
  });

  it("tallies by kind and keeps a bounded sample of offenders", () => {
    const t = emptyFamilyAudit("NSE/bhavcopy");
    for (let i = 0; i < 10; i++) {
      recordArchiveVerdict(t, `feeds/NSE/bhavcopy/2026/08/${i}.zip`, {
        kind: "empty",
        why: "zero bytes",
      });
    }
    recordArchiveVerdict(t, "feeds/NSE/bhavcopy/2026/08/good.zip", {
      kind: "ok",
      why: "",
    });
    assert.equal(t.scanned, 11);
    assert.equal(t.empty, 10);
    assert.equal(t.ok, 1);
    // Bounded so a wholly-corrupt family cannot produce an unreadable report.
    assert.equal(t.examples.length, 5);
    assert.ok(t.examples.every((e) => e.kind === "empty"));
  });

  it("never samples an `ok` object", () => {
    const t = emptyFamilyAudit("NSE/x");
    recordArchiveVerdict(t, "k", { kind: "ok", why: "" });
    assert.equal(t.examples.length, 0);
  });

  it("isEnvelopeVerdictKind covers the whole wrapper family and nothing else", () => {
    // "How many envelopes are left, and is the broken writer still running?"
    // is a question about the WRAPPER. An answer that drops the ones we could
    // not judge is the same undercount in the other direction.
    for (const kind of ALL_KINDS) {
      assert.equal(
        isEnvelopeVerdictKind(kind),
        kind.startsWith("envelope-"),
        kind,
      );
    }
    assert.deepEqual([...ENVELOPE_VERDICT_KINDS].sort(), [
      "envelope-data",
      "envelope-html",
      "envelope-too-large",
      "envelope-unknown",
    ]);
  });
});
