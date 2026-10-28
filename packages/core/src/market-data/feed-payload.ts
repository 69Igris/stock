/**
 * Raw exchange-feed payload sanity checks (pure) — MONEY-1085 / MONEY-1157.
 *
 * ## The failure this exists to stop
 *
 * `fetchExchangeAsset` only rejects a 404 and a non-2xx. NSE and BSE are both
 * known to answer **200 with an HTML interstitial** when they throttle — this
 * repo already fights that elsewhere (`bse-master-instruments.ts` retries a
 * throttled scrip master; MONEY-840 added typed 429 circuit-breakers). Without a
 * check on the BYTES, that HTML is a perfectly ordinary 200 to the archive:
 *
 *   prod's 21:00 fetch gets 200 HTML
 *     → archived under the day's key (or, worse, OVER a `current/` master,
 *       which is overwritten every run)
 *     → QA replays those bytes indefinitely
 *     → `parseUdiffBhavcopy` finds no `TckrSymb` and returns []
 *     → `ingestExchangeDay` reports `fetched: 0`
 *     → MarketDataSyncLog: COMPLETED, recordsProcessed 0, recordsFailed 0, no
 *       error — indistinguishable from a market holiday in BOTH the database
 *       and the logs.
 *
 * A "couldn't determine" must never be persisted as a value. So the archive is
 * SKIPPED for bytes that fail this check, and a replayed object that fails it is
 * treated as a miss — both fall through to the live fetch, which is the path
 * that already works.
 *
 * ## How the expected shape is derived
 *
 * Per FEED, not one rule for all of them, and each feed's required tokens are
 * exactly **what its parser already needs to produce a single row**:
 *
 *   BSE bhavcopy    `parseUdiffBhavcopy` reads `TckrSymb` + `ClsPric`
 *   NSE indices     `parseNseIndicesCsv` reads `Index Name` + `Closing Index Value`
 *   NSE masters     `parseNseMasterCsv` returns [] without `SYMBOL` + `SERIES`
 *   NSE bhavcopy    `unzipSingleEntry` requires the `PK\x03\x04` local header
 *   BSE scrip master `parseBseMasterJson` needs a JSON array or `{Table:[…]}`
 *
 * That calibration is deliberate: the check can never be STRICTER than the
 * parser, so it cannot reject a file the ingest would have been able to use.
 * A file that fails here was going to yield zero rows anyway — the difference is
 * that it no longer gets frozen into the archive and replayed forever.
 *
 * An unregistered feed still gets the generic guard rather than no guard at all:
 * a precise rule with no catch-all shrinks coverage the moment someone adds a
 * feed. That catch-all is a plausible length, "this is not an HTML error page",
 * and — for `csv` — "these bytes are not BINARY" (MONEY-1206). The third was
 * missing, and it is the one that mattered: only 7 of the 88 registry families
 * carry a row in {@link FEED_SHAPES}, so 81 reach the archive through the
 * fallback, where an unregistered `.csv` had a 32-byte floor and no tokens. A
 * gzip stream was archived under a `.csv` key on that path and replayed,
 * unreadable, for a year and a half.
 */

import type { FeedDescriptor } from "./feed-archive";

/**
 * Broad payload family, which decides WHICH positive signal is checked.
 *
 * `html` is the odd one out and exists only for MONEY-1106's RBI macro pages.
 * Everywhere else HTML means "the exchange served an interstitial" and is a
 * REJECTION; for those three feeds the HTML table IS the data. A feed only gets
 * this treatment by being registered in {@link FEED_SHAPES} with required
 * tokens — the generic fallback still rejects HTML, so nothing becomes
 * html-tolerant by accident.
 */
export type FeedPayloadKind =
  | "zip"
  | "csv"
  | "json"
  // MONEY-1204 — NSE's XBRL result filings. Registered as its own kind rather
  // than left to the `unknown` fallback, which would have been a guard in name
  // only: `unknown` checks a 32-byte floor and then sniffs for HTML, and
  // `looksLikeHtml` does NOT match `<?xml` — so it can neither confirm an XBRL
  // instance nor reject anything an XBRL fetch realistically receives.
  | "xml"
  | "html"
  | "unknown";

/** The shape a given feed's bytes must have to be worth archiving. */
export interface FeedShape {
  kind: FeedPayloadKind;
  /**
   * Smallest byte count that could still be a real file.
   *
   * Deliberately LOW. The discriminating signal is the magic bytes / header
   * tokens below; length is only a backstop against a truncated or near-empty
   * body. A high threshold would be a second way to reject a valid file, which
   * is the one outcome this module must not produce.
   */
  minBytes: number;
  /**
   * Tokens that must ALL appear in the head of a text payload, matched
   * case-insensitively. Empty for binary/unknown kinds.
   */
  requiredTokens: readonly string[];
}

/** Outcome of a payload check. `reason` is written for a log line. */
export type FeedPayloadCheck = { ok: true } | { ok: false; reason: string };

/** How many leading bytes are decoded when looking for header tokens. */
const HEAD_BYTES = 8192;

/**
 * Bound on the `html` kind's full-body token scan (MONEY-1106).
 *
 * The RBI pages bury their table marker ~45 KB in, so `HEAD_BYTES` is far too
 * small for them; 512 KB is ~5x the largest live page and keeps the decode
 * bounded for any payload.
 */
const HTML_SCAN_BYTES = 512 * 1024;

/** ZIP local file header — "PK\x03\x04". */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/** How many leading bytes are scanned for a NUL when deciding "is this text?". */
const BINARY_SNIFF_BYTES = 2048;

/**
 * Leading byte sequences that prove a payload is NOT text.
 *
 * Every one of these is a container this repo has actually met on an exchange
 * fetch, and none can begin a UTF-8 CSV.
 */
const BINARY_MAGICS: ReadonlyArray<{
  readonly bytes: readonly number[];
  readonly what: string;
}> = [
  { bytes: [0x1f, 0x8b], what: "gzip stream" },
  // The three ZIP local/central/data-descriptor signatures. Matched on all FOUR
  // bytes, not on "PK": bytes 3-4 are control characters that cannot appear in a
  // header row, whereas a two-byte `PK` test could in principle reject a CSV
  // whose first column name began with those letters.
  { bytes: [0x50, 0x4b, 0x03, 0x04], what: "ZIP archive" },
  { bytes: [0x50, 0x4b, 0x05, 0x06], what: "empty ZIP archive" },
  { bytes: [0x50, 0x4b, 0x07, 0x08], what: "spanned ZIP archive" },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], what: "OLE2/BIFF8 workbook (.xls)" },
  { bytes: [0x25, 0x50, 0x44, 0x46], what: "PDF document" },
];

/**
 * A payload that cannot be text, and therefore cannot be a CSV.
 *
 * ## Why this exists (MONEY-1206 / D3a)
 *
 * `shapeFromUrl` hands an unregistered `.csv` feed `minBytes: 32` and NO
 * required tokens, so the only thing standing between it and the archive was the
 * HTML sniff — and nothing in that path can reject BINARY. That is how a gzip
 * stream came to be archived under `feeds/NSE/combine-oi-deleq/2025/01/…csv` and
 * sat there for a year and a half, unparseable, until MONEY-1205 taught the
 * PARSER to inflate it. Measured on this branch: 88 registry families, of which
 * only 7 carry a `FEED_SHAPES` row — 81 rely on this fallback. A per-family rule
 * for each is not the fix; a rule that needs no family knowledge is.
 *
 * Rejecting here is the cheap moment: the fetch has just happened, so the
 * exchange can still be re-asked. Rejecting a year later, from the archive,
 * cannot recover the day.
 *
 * ## Why it is scoped to `csv` and NOT to `unknown`
 *
 * `unknown` is where every extensionless and exotic URL lands, and several of
 * those feeds are LEGITIMATELY binary — `nse-fii-stats` is a BIFF8 `.xls`,
 * `nse-market-pulse` is a PDF, and `nse-cm-security-master` /
 * `nse-fo-contract-master` are `.csv.gz`, i.e. gzip by design. Applying this to
 * `unknown` would reject four live families outright. The catch-all must not
 * become a new precision trap of its own.
 *
 * ## Why it is never stricter than the parser
 *
 * Every CSV consumer reaches its parser through `decodeFeedText`, which ends in
 * `buf.toString("utf8")`. A payload carrying a NUL in its first 2 KB cannot
 * survive that as anything but replacement characters, so a file this rejects
 * was going to yield zero rows anyway — the same calibration the module header
 * claims for the per-feed tokens.
 */
function binaryReason(body: Buffer): string | null {
  for (const magic of BINARY_MAGICS) {
    if (body.length < magic.bytes.length) continue;
    if (magic.bytes.every((byte, i) => body[i] === byte)) {
      return `${magic.what} (leading bytes ${magic.bytes
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")})`;
    }
  }
  if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0x00)) {
    return `a NUL byte in the first ${BINARY_SNIFF_BYTES} bytes`;
  }
  return null;
}

/**
 * Per-feed expectations, keyed `${exchange}/${feed}` — the same two descriptor
 * fields that key the archive object itself.
 */
const FEED_SHAPES: Readonly<Record<string, FeedShape>> = {
  // ── AMFI fund metadata (MONEY-1207) ───────────────────────────────────────
  // Registered rather than left to `shapeFromUrl`, because all three doors
  // answer a bad request with a well-formed EMPTY 200 rather than a 404:
  // `DownloadSchemeData_Po.aspx?mf=1` returns 164 bytes with a correct header
  // and zero rows, and the TER export returns a 7.8 KB XLSX with the right
  // sheet name and zero rows for an out-of-range month. `minBytes` is the cheap
  // half of that guard; the parsers throw `AmfiFeedEmptyError` for the rest.
  // NAVAll — the whole-industry NAV file (MONEY-1404 C6 seamed it through
  // `getFeedAsset`; this row is the shape guard that seam needs).
  //
  // Semicolon-delimited, so `csv`. Measured 1,519,203 bytes on 2026-09-13, and
  // 500 KB is a floor with ~3x headroom rather than a close fit: AMFI answers a
  // throttled or maintenance request with a 200 and an HTML interstitial, which
  // is exactly what a byte floor plus a header token catches and a status check
  // does not.
  //
  // The two tokens are header CELLS, and deliberately only two of the eight.
  // AMFI inserted `Plan;Option` between `Scheme Name` and `Net Asset Value`
  // around 2026-08-19 and every positional reader broke silently for 26 nights
  // (MONEY-1403); pinning the full header here would make the NEXT legitimate
  // insertion reject the feed outright. These two have survived every revision
  // and bracket the inserted columns, so the guard proves "this is NAVAll"
  // without claiming to know its column count.
  "AMFI/navall": {
    kind: "csv",
    minBytes: 500_000,
    requiredTokens: ["Scheme Code", "Net Asset Value"],
  },
  "AMFI/scheme-master": {
    kind: "csv",
    minBytes: 4096,
    requiredTokens: ["Scheme NAV Name"],
  },
  "AMFI/aaum-schemewise": {
    kind: "json",
    minBytes: 1024,
    requiredTokens: ["AMFI_Code"],
  },
  // An .xlsx IS a zip; there is no header token to assert through the container.
  "AMFI/ter": { kind: "zip", minBytes: 8192, requiredTokens: [] },
  // AMFI's AMC registry page (MONEY-1405). 240 KB of server-rendered Next.js
  // HTML whose AMC list rides in the RSC payload. Both tokens are pinned in
  // their SERVED, escaped form — `"members":[` reaches the wire as
  // `\"members\":[` inside a JS string literal, so asserting the decoded
  // spelling would reject every real response. The RSC marker is pinned beside
  // it because AMFI's 404 and consent pages are also HTML and also large: a
  // `minBytes` alone would archive either one as a registry.
  "AMFI/amc-registry": {
    kind: "html",
    minBytes: 65536,
    requiredTokens: ['self.__next_f.push([1,"', '\\"members\\":['],
  },
  // SEC EDGAR ticker -> CIK map (MONEY-980). One public static JSON object.
  // Measured 2026-08-28: 795,179 bytes, 10,391 entries. `cik_str` is the field
  // the parser hard-requires, so it is the honest thing to pin — SEC answers a
  // wrong path with an HTML error page, not a 404, and the generic json guard
  // has no token to catch that.
  "SEC/company-tickers": {
    kind: "json",
    minBytes: 100_000,
    requiredTokens: ["cik_str"],
  },
  // ── Tiingo US price backbone (MONEY-980) ─────────────────────────────────
  // The daily security master, a ZIP wrapping one CSV. Measured 2026-08-28:
  // 798,715 bytes zipped / 5,017,961 unzipped, 108,489 rows. The floor is set
  // well under that but far above an error page — this file only ever grows.
  "TIINGO/supported-tickers": {
    kind: "zip",
    minBytes: 100_000,
    requiredTokens: [],
  },
  // Corporate actions, one ex-date across the whole market (MONEY-1263).
  //
  // Registered rather than left to `shapeFromUrl`, which matters more here than
  // usual: the URL path is `/corporate-actions/splits` with the format in the
  // QUERY, so there is no extension to infer from and the generic fallback is
  // `kind:"unknown"` — no binary guard, no header token. An HTML error page or
  // a JSON body of adequate size would archive as if it were the feed.
  //
  // The floor also does real work. A day with NO corporate actions answers 200
  // with the literal 4-byte body `None` — Python's `None` leaking through their
  // CSV serializer, measured on both routes for Sunday 2026-08-23 (the JSON
  // form correctly returns `[]`). At 32 bytes that is rejected and never
  // archived, which is right: there is nothing to replay, and the parser is
  // additionally pinned by a fixture so `None` can never become one junk row.
  // Tokens are the columns the PARSERS hard-require, per this file's own rule
  // that a shape is never stricter than its parser. `distribution` and `ticker`
  // were missing: both parsers demand them, so a rename of either passed
  // archive validation and was caught one layer later, by the parser throwing
  // on an object already written to the archive. Refusing here rejects the
  // object instead of storing a bad one.
  "TIINGO/distributions": {
    kind: "csv",
    minBytes: 32,
    requiredTokens: ["permaTicker", "ticker", "exDate", "distribution"],
  },
  "TIINGO/splits": {
    kind: "csv",
    minBytes: 32,
    requiredTokens: ["permaTicker", "ticker", "exDate", "splitFactor"],
  },
  // News, one day across the whole market (MONEY-1264). JSON only — this route
  // 404s on `format=csv`, unlike EOD and corporate actions. An empty result is
  // `[]` (2 bytes), rejected by the floor for the same reason as above.
  "TIINGO/news": {
    kind: "json",
    minBytes: 32,
    requiredTokens: ["publishedDate"],
  },
  // One symbol's EOD history as CSV. `date` is asserted because the column
  // order is NOT the documented one (close is second, open fifth), so the
  // header is the only thing worth pinning.
  //
  // A delisted-but-recycled symbol legitimately returns an EMPTY series —
  // measured: `LEH` answers 200 with `[]`. That fails this floor and is
  // therefore never archived, which is correct: there is nothing to replay,
  // and `BackfillCheckpoint` records EMPTY so it is never re-fetched.
  "TIINGO/eod": { kind: "csv", minBytes: 8, requiredTokens: ["date"] },
  // ZIP wrapping one UDiFF CSV. `unzipSingleEntry` throws without the magic.
  "NSE/bhavcopy": { kind: "zip", minBytes: 128, requiredTokens: [] },
  // Plain UDiFF CSV.
  "BSE/bhavcopy": {
    kind: "csv",
    minBytes: 64,
    requiredTokens: ["TckrSymb", "ClsPric"],
  },
  "NSE/indices": {
    kind: "csv",
    minBytes: 64,
    requiredTokens: ["Index Name", "Closing Index Value"],
  },
  // Same layout as NSE/indices, different publisher and prefix: the
  // nse-index-snapshot backfill family fetches niftyindices' Daily_Snapshot
  // copy. Registered explicitly because niftyindices answers a MISSING day
  // with 200 + HTML, not a 404 — the generic .csv guard has no header tokens
  // to catch that (MONEY-1100 P4.2).
  "NSE/index-snapshot": {
    kind: "csv",
    minBytes: 64,
    requiredTokens: ["Index Name", "Closing Index Value"],
  },
  // EQUITY_L.csv / SME_EQUITY_L.csv. The two files disagree on separators
  // (`NAME OF COMPANY` vs `NAME_OF_COMPANY`), so only the tokens that are
  // spelled identically in both — and that the parser hard-requires — are used.
  "NSE/equity-master": {
    kind: "csv",
    minBytes: 64,
    requiredTokens: ["SYMBOL", "SERIES"],
  },
  "NSE/sme-master": {
    kind: "csv",
    minBytes: 64,
    requiredTokens: ["SYMBOL", "SERIES"],
  },
  // BSE legacy cash bhavcopies (MONEY-1101 / P7). Both eras are ZIPs, so the
  // magic-byte rule is what rejects BSE's real failure mode: an absent file is
  // answered with **200 + the Angular SPA page** (a constant 13,850-byte
  // `<!DOCTYPE html>` document), never a 404. Registered explicitly rather than
  // left to the generic `.zip` fallback so the guard is greppable and pinned by
  // a test — this is the single check standing between an 18-year backfill and
  // 4,500 archived copies of BSE's homepage.
  "BSE/cm-legacy": { kind: "zip", minBytes: 128, requiredTokens: [] },
  "BSE/cm-isin-legacy": { kind: "zip", minBytes: 128, requiredTokens: [] },
  // api.bseindia.com ListofScripData — a bare JSON array, or `{Table:[…]}`.
  "BSE/scrip-master": { kind: "json", minBytes: 32, requiredTokens: [] },

  // ── NSE market-wide F&O open interest (MONEY-1206 / D3b) ─────────
  //
  // `combineoi_deleq_{DDMMYYYY}.csv`, parsed by `parseCombinedOiDeleq`. Given a
  // row of its own because this is the feed whose ONE gzip-under-a-.csv-key
  // object proved the unregistered `.csv` fallback could not reject binary:
  // 32-byte floor, no tokens, so a gzip stream was archived and replayed for a
  // year and a half.
  //
  // ## The tokens are the dangerous half, so they were measured
  //
  // `requiredTokens` REJECTS at fetch time, and a token that is merely PLAUSIBLE
  // silently rejects valid files — strictly worse than the bug. NSE has
  // published this report in FOUR header layouts and they INTERLEAVE (no
  // changeover date to branch on; see mwpl-logic.ts's table). Verified
  // case-insensitively against all 8 committed fixtures in
  // `__tests__/fixtures/nse-mwpl/`, which cover all four:
  //
  //   1 (11082025, 14072025)          Date,ISIN,Scrip Name,Symbol,NotionalOpen Interest,Portfolio-wiseFutures Equivalent Open Interest
  //   2 (12042023, 18112024, 26102023) fully QUOTED 7-column
  //   3 (14082026, 30062025)          modern 6-column, spaces intact
  //   4 (27062025)                    unquoted 7-column
  //
  //   `Symbol`         4/4 variants
  //   `Open Interest`  4/4 — variant 1 spells it `NotionalOpen Interest`, and
  //                    the SUBSTRING still matches, which is why the token is
  //                    the two words and not the column name.
  //
  // Both are columns `resolveColumns` HARD-REQUIRES (it returns null without a
  // `date`, a `symbol` and both OI measures), so the guard stays no stricter
  // than the parser.
  //
  // Rejected candidates, and why — each would have been a plausible-looking
  // outage: `Notional` matches only variants 1 and 3, so it would have rejected
  // the entire 7-column era (409 of 689 archived objects, the exact set
  // MONEY-1205 just recovered). `ISIN` and `Scrip Name` DO appear in all four,
  // but the parser treats both as OPTIONAL (index underlyings publish `NA` for
  // them), so requiring them would assert more than the parse needs.
  "NSE/combine-oi-deleq": {
    kind: "csv",
    minBytes: 64,
    requiredTokens: ["Symbol", "Open Interest"],
  },

  // ── NSE XBRL result filings (MONEY-1204) ─────────────────────────
  //
  // Fetched per FILING by workers/src/processors/xbrl-sync.ts, never by
  // report-archive-sync — see the `nse-results-xbrl` row in report-registry.ts.
  //
  // Tokens calibrated the same way as every other row: exactly what the parser
  // hard-requires. `parseXbrlDocument` dispatches on the DECLARED namespace of
  // the root element, so a payload without an `xbrli:xbrl` root cannot produce
  // a single fact whatever else it contains. Verified against all 12 committed
  // filings in __tests__/fixtures/xbrl/ — both taxonomies (in-bse-fin 2018-2019
  // and in-capmkt 2024-2026), all four entry-point families, and the governance
  // filing that legitimately carries no financials: 12/12 open with the `<?xml`
  // prolog and 12/12 declare `<xbrli:xbrl`.
  //
  // This is the check standing between the archive and NSE's throttle response,
  // which arrives as a 200 carrying HTML — the same failure `xbrl-sync`'s own
  // `<!` guard catches one layer up, kept in BOTH places because they protect
  // different things: that one protects the PARSE, this one protects the
  // ARCHIVE, and an HTML page frozen into the archive is replayed forever.
  "NSE/results-xbrl": {
    kind: "xml",
    // The smallest committed filing is 16 KB, but the floor stays a backstop
    // rather than a target: an XBRL instance that is merely SMALL is still an
    // instance, and the discriminating signal is the root element below.
    minBytes: 256,
    requiredTokens: ["<xbrli:xbrl"],
  },

  // ── RBI National Summary Data Page (MONEY-1106) ──────────────────
  //
  // The only feeds whose payload is legitimately an HTML document. Tokens are
  // calibrated the same way as every other row — exactly what the parser needs
  // to produce a single observation:
  //
  //   `class="tablebg"`   `extractNsdpRows` returns null without it, so a page
  //                       missing it yields nothing whatever else it contains.
  //                       Probing `param=27..30` on 2026-08-13 returned 200 with
  //                       ~86 KB of chrome and NO `tablebg` — this token is what
  //                       separates that from a real table.
  //   the table caption   pins each key to ITS page. Without it, `param=2`'s
  //                       bytes would validate as `param=4`'s, and since RBI
  //                       serves every one of these from the same .aspx with only
  //                       a query param, a mis-built URL would archive silently
  //                       under the wrong key.
  //
  // `minBytes` is a floor, not a target: the live pages are 96–112 KB, the
  // discontinued shells ~86 KB, and the SPA/error stand-ins seen elsewhere on
  // these hosts are 0.5–1 KB.
  "RBI/nsdp-rates": {
    kind: "html",
    minBytes: 4096,
    requiredTokens: ['class="tablebg"', "Cash Reserve Ratio"],
  },
  "RBI/nsdp-prices": {
    kind: "html",
    minBytes: 4096,
    requiredTokens: ['class="tablebg"', "Wholesale Price Index"],
  },
  "RBI/nsdp-forex": {
    kind: "html",
    minBytes: 4096,
    requiredTokens: ['class="tablebg"', "Foreign Exchange Reserves"],
  },
};

/** Generic shape inferred from the URL when a feed isn't registered above. */
function shapeFromUrl(url: string): FeedShape {
  const path = url.split("?")[0]!.toLowerCase();
  if (path.endsWith(".zip"))
    return { kind: "zip", minBytes: 128, requiredTokens: [] };
  // No tokens — nothing may be asserted about a document this module has never
  // seen — but `kind: "csv"` is itself load-bearing: it is what routes the
  // payload through the generic BINARY guard in `validateFeedPayload`, which is
  // the whole of an unregistered CSV feed's protection (MONEY-1206).
  if (path.endsWith(".csv"))
    return { kind: "csv", minBytes: 32, requiredTokens: [] };
  if (path.endsWith(".json"))
    return { kind: "json", minBytes: 2, requiredTokens: [] };
  // No required tokens: an unregistered `.xml` feed gets the XML PROLOG /
  // root-element structural check below, which is the generic version of the
  // guard — enough to reject an HTML interstitial served as `.xml`, without
  // asserting anything about a document this module has never seen.
  if (path.endsWith(".xml"))
    return { kind: "xml", minBytes: 32, requiredTokens: [] };
  return { kind: "unknown", minBytes: 32, requiredTokens: [] };
}

/**
 * The expected shape for a feed fetch.
 *
 * Registered feeds win; anything else falls back to the URL extension so a NEW
 * feed is still guarded against the HTML interstitial on the day it is added,
 * without anyone having to remember this file.
 */
export function feedShapeFor(
  descriptor: FeedDescriptor,
  url: string,
): FeedShape {
  return (
    FEED_SHAPES[`${descriptor.exchange}/${descriptor.feed}`] ??
    shapeFromUrl(url)
  );
}

/** Whether the head of a payload is an HTML document (a throttle/error page). */
export function looksLikeHtml(head: string): boolean {
  const s = head.trimStart();
  if (!s.startsWith("<")) return false;
  return /<\s*(!doctype\s+html|html|head|body|script|meta|title)\b/i.test(
    s.slice(0, 512),
  );
}

/** First `HEAD_BYTES` decoded as UTF-8 (lossy for binary, which is fine). */
function head(body: Buffer): string {
  return body.subarray(0, HEAD_BYTES).toString("utf-8");
}

function hasZipMagic(body: Buffer): boolean {
  if (body.length < ZIP_MAGIC.length) return false;
  return ZIP_MAGIC.every((byte, i) => body[i] === byte);
}

/**
 * Is this payload plausibly the feed it claims to be?
 *
 * Never throws and never inspects the network — a pure predicate over the
 * bytes, so both the archive write and the replay read can use the same one and
 * cannot drift apart.
 */
export function validateFeedPayload(
  descriptor: FeedDescriptor,
  url: string,
  body: Buffer,
): FeedPayloadCheck {
  const shape = feedShapeFor(descriptor, url);

  if (body.length === 0)
    return { ok: false, reason: "empty payload (0 bytes)" };

  // An EMPTY JSON container is an absence, checked BEFORE anything else —
  // MONEY-1097.
  //
  // This started life inside the `kind === "json"` branch and could not fire
  // there for either endpoint it was written for. A real 2-byte `{}` is caught
  // by the `minBytes` test one line below (32 for json), and BSE's
  // `IndexArchDailyAll/w` URL has no extension at all, so `shapeFromUrl`
  // returns kind "unknown" and the json branch is never entered. The test only
  // passed because the fixture was padded to 40 bytes — a green test over
  // unreachable code, which is exactly the shadow test this repo forbids.
  //
  // Hoisting it makes it independent of `kind` and of `minBytes`, which is
  // right: `{}` means "nothing here" whatever the feed claims to be, and it is
  // ALWAYS shorter than any plausible minimum.
  const trimmedWhole = body.subarray(0, 64).toString("utf-8").trim();
  if (trimmedWhole === "{}" || trimmedWhole === "[]") {
    return {
      ok: false,
      reason:
        `empty JSON container (${trimmedWhole}) — the endpoint answered 200 ` +
        "with no content, which means absent (or wrong params), not data",
    };
  }

  // MONEY-1169: a stored-back multipart upload envelope. For three months the
  // workers image wrote every GCS object with the SDK's multipart request body
  // AS the content, so replayed/archived bytes can begin with
  // `--<uuid>\r\nContent-Type: ...` followed by the real payload. This check
  // exists because the header-TOKEN scan below is satisfied by tokens sitting
  // INSIDE the envelope — which is precisely how 23k corrupt objects passed
  // validation. Checked at fixed offsets, never by scanning.
  if (body[0] === 0x2d && body[1] === 0x2d) {
    const firstCrlf = body.indexOf("\r\n");
    if (
      firstCrlf > 2 &&
      firstCrlf <= 120 &&
      body.subarray(firstCrlf + 2, firstCrlf + 15).toString("latin1") ===
        "Content-Type:"
    ) {
      return {
        ok: false,
        reason:
          "multipart upload envelope stored as content (MONEY-1169) — this is " +
          "storage-layer corruption of an archived object, not exchange data; " +
          "run the feed-repair job rather than re-fetching",
      };
    }
  }

  if (body.length < shape.minBytes) {
    return {
      ok: false,
      reason: `implausibly small: ${body.length} bytes (< ${shape.minBytes} for ${shape.kind})`,
    };
  }

  if (shape.kind === "zip") {
    // Checked BEFORE the HTML sniff: a ZIP's bytes are binary, so any text
    // heuristic over them is meaningless.
    return hasZipMagic(body)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not a ZIP — missing the PK\\x03\\x04 local file header " +
            `(first bytes: ${[...body.subarray(0, 4)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")})`,
        };
  }

  if (shape.kind === "html") {
    // Scanned over the WHOLE body, not `head()`. Measured 2026-08-13: on all
    // three NSDP pages `class="tablebg"` sits at byte ~40,000–49,000, behind
    // RBI's site-wide navigation. A head-only scan could never see it, so the
    // check would have failed for every payload and NOTHING would ever have
    // been archived — a guard that rejects everything is as broken as one that
    // accepts everything, and quieter about it.
    //
    // Bounded so a pathological body cannot cost an unbounded decode; the real
    // pages are ~100 KB and the cap is 5x that.
    const full = body.subarray(0, HTML_SCAN_BYTES).toString("utf-8");
    const absent = shape.requiredTokens.filter(
      (token) => !full.toLowerCase().includes(token.toLowerCase()),
    );
    if (absent.length > 0) {
      return {
        ok: false,
        reason:
          `HTML page is missing required marker(s): ${absent.join(", ")} — ` +
          "this is not the table this feed expects (a discontinued/moved page " +
          "or an error shell served with a 200)",
      };
    }
    return { ok: true };
  }

  // MONEY-1206 (D3a) — binary before text, for the same reason `zip` is checked
  // before the HTML sniff: once bytes are decoded as UTF-8, every text heuristic
  // below is running over replacement characters and means nothing. Scoped to
  // `csv` deliberately — see `binaryReason` for the four live families that make
  // `unknown` the wrong place for it.
  if (shape.kind === "csv") {
    const binary = binaryReason(body);
    if (binary !== null) {
      return {
        ok: false,
        reason:
          `binary payload under a CSV feed — ${binary}. A CSV parser can only ` +
          "produce mojibake from this, so it is not archived: re-ask the " +
          "exchange now rather than freezing bytes nothing can read",
      };
    }
  }

  const text = head(body);

  if (looksLikeHtml(text)) {
    return {
      ok: false,
      reason:
        "HTML document, not feed data — the exchange served an interstitial " +
        "or error page with a 200",
    };
  }

  if (shape.kind === "xml") {
    // Structural first, tokens second — the same order as `zip`.
    //
    // Checked AFTER `looksLikeHtml` on purpose: NSE answers a throttled client
    // with `<!DOCTYPE html>`, which starts with `<` and would satisfy a naive
    // "is it markup" test. The HTML sniff above rejects it; what is left here
    // is the question this branch exists for — is it XML, and is it OURS.
    const start = text.trimStart();
    if (!start.startsWith("<?xml") && !start.startsWith("<")) {
      return {
        ok: false,
        reason: `not XML — payload starts with ${JSON.stringify(
          start.slice(0, 16),
        )}`,
      };
    }

    const absentXml = shape.requiredTokens.filter(
      (token) => !text.toLowerCase().includes(token.toLowerCase()),
    );
    if (absentXml.length > 0) {
      return {
        ok: false,
        reason:
          `XML is missing required element(s): ${absentXml.join(", ")} — ` +
          "well-formed markup, but not this feed's document",
      };
    }
    return { ok: true };
  }

  if (shape.kind === "json") {
    const first = text.trimStart()[0];
    if (first !== "[" && first !== "{") {
      return {
        ok: false,
        reason: `not JSON — payload starts with ${JSON.stringify(first ?? "")}`,
      };
    }
    // FALLS THROUGH to the token scan below, and did not until MONEY-1263.
    //
    // This branch used to `return { ok: true }` here, which made
    // `requiredTokens` INERT for every json feed that declared one — three of
    // them did: `AMFI/aaum-schemewise` ("AMFI_Code"), `SEC/company-tickers`
    // ("cik_str") and `TIINGO/news` ("publishedDate"). Each was written to
    // catch a well-formed 200 carrying the wrong content, and each silently
    // asserted nothing.
    //
    // The bracket check above only proves the payload is SHAPED like JSON. A
    // JSON error envelope — `{"detail":"Not found."}` is what these very hosts
    // return — passes it and would have been archived as the feed.
  }

  const lower = text.toLowerCase();
  const missing = shape.requiredTokens.filter(
    (token) => !lower.includes(token.toLowerCase()),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing required header token(s): ${missing.join(", ")}`,
    };
  }

  return { ok: true };
}
