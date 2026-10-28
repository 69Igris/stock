/**
 * Raw exchange fetches must go through the archive seam — MONEY-1085.
 *
 * `getFeedAsset` (market-data/feed-archive.ts) is the one place that knows about
 * `FEED_ARCHIVE_MODE`. A caller that reaches past it to `fetchExchangeAsset`
 * still works — which is exactly the problem: it would silently opt that feed
 * out of the archive, so QA would keep scraping the exchange for it and prod
 * would never archive it. Nothing would fail; the feed would just quietly stop
 * being mirrored.
 *
 * That is the same failure shape as the defect this ticket fixes (a series the
 * price feed kept but the universe didn't source — no error, just missing data),
 * so it gets the same treatment: a scan that fails the suite instead of a
 * comment asking people to remember.
 *
 * ## MONEY-1157 — the scan was blind to the obvious bypass
 *
 * It only grepped for `fetchExchangeAsset(`. A plain `fetch()` straight at an
 * upstream host was invisible to it, and there was a LIVE instance:
 * `instruments/zerodha-instruments.ts` fetched Kite's instrument dump directly,
 * so the guard was green while the feed it was supposed to protect was not
 * covered at all. A guard that only catches the tidy bypass is worse than none,
 * because it is cited as proof.
 *
 * The second scan below closes that: any module that names a known upstream
 * FEED HOST may not make an un-seamed HTTP call. It is deliberately
 * FILE-granular and over-triggers rather than under-triggers — a mixed file
 * lands in `HTTP_EXEMPTIONS` with a written reason, a call count, and the
 * endpoint the exemption is pinned to. That shape is on purpose: a loose
 * `includes()` is accidentally complete, and a clever regex narrow enough to
 * separate "the Kite dump" from "Kite's per-user OAuth" would turn every
 * unrecognised call into a new false pass. Being explicit about the handful of
 * mixed files is the readable version of the same coverage.
 *
 * Mirrors apps/web/__tests__/navigation/no-unguarded-url-writes.test.ts and
 * apps/web/__tests__/ui/no-native-dialogs.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// CWD is packages/core (the package's test script runs from there).
const SCAN_ROOT = "src";
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__"]);
const SOURCE_EXT = /\.ts$/;

/** The archive seam itself — the ONE legitimate caller. */
const SEAM_FILE = join("src", "market-data", "feed-archive.ts");

/** The low-level fetch primitive the seam is built on. */
const FETCH_PRIMITIVE_FILE = join("src", "market-data", "exchange-feed.ts");

const ZERODHA_INSTRUMENTS_FILE = join(
  "src",
  "market-data",
  "instruments",
  "zerodha-instruments.ts",
);

/**
 * Files allowed to call `fetchExchangeAsset` directly, with the reason.
 * Only the seam qualifies today.
 */
const BYPASS_ALLOWLIST: Record<string, string> = {
  [SEAM_FILE]:
    "This IS the seam — getFeedAsset wraps fetchExchangeAsset and owns the " +
    "archive/replay decision.",
};

const DIRECT_CALL = /\bfetchExchangeAsset\s*\(/;

/**
 * Upstream hosts whose raw files the archive exists to mirror.
 *
 * An explicit list, not a pattern. Every entry is asserted to still appear in
 * `src` below, so a stale one is reported rather than quietly matching nothing.
 */
const FEED_HOSTS: readonly string[] = [
  "nsearchives.nseindia.com", // NSE bhavcopy, all-indices close, EQUITY_L / SME_EQUITY_L
  "www.nseindia.com", // NSE referer + the per-index constituents JSON API
  "www.bseindia.com", // BSE bhavcopy download + referer
  "api.bseindia.com", // BSE scrip master (ListofScripData)
  "api.kite.trade", // Zerodha: instrument dump, and the per-user broker API
  // MONEY-1106 — RBI's National Summary Data Page (the macro series). Added
  // WITH the feed rather than after it: the guard's whole lesson (MONEY-1157)
  // is that a host nobody listed is a host nobody protects, and the live
  // instance that proved it — Kite's dump — sat un-covered for months while the
  // scan reported green. `macro-series.ts` names this host and is PURE, so it
  // passes today; the point is that it can never quietly start fetching.
  "www.rbi.org.in",
  // MONEY-980 — Tiingo, the US price backbone. Listed WITH the feed for the
  // reason stated above, and worth noting as the first AUTHENTICATED host in
  // this set: `tiingo-client.ts` routes every call through `getFeedAsset`,
  // deleting the seam's browser-impersonation `Origin`/`Referer` and adding an
  // `Authorization: Token` header via `ExchangeFetchOptions.headers`. Being on
  // this list is what makes that a checked property rather than a claim — a
  // future raw `fetch()` to either host now fails this suite instead of
  // silently spending quota outside the archive.
  "api.tiingo.com", // EOD prices + security metadata
  "apimedia.tiingo.com", // the daily supported_tickers.zip master
  // MONEY-980 — SEC EDGAR ticker->CIK map, joined onto the US instrument rows.
  "www.sec.gov",
  // MONEY-1373 — Databento, the US intraday backbone. BOTH hosts, and that is
  // the point of listing them together: `hist.databento.com` is the API
  // gateway, but the batch downloads are served from `api.databento.com`, and
  // listing only the gateway would leave the host that moves the actual
  // gigabytes unguarded. Listed WITH the feed rather than after it (the
  // MONEY-1157 lesson: a host nobody listed is a host nobody protects).
  "hist.databento.com", // batch.submit_job / list_jobs / list_files / metadata.*
  "api.databento.com", // the batch output downloads themselves
  // MONEY-979 — the other two SEC hosts, and OpenFIGI.
  //
  // Listed here even though the code that calls them is PYTHON
  // (`services/us-fundamentals/`), which none of the scans below can walk. That
  // is deliberate rather than sloppy: this list is also the DECLARATION of
  // which hosts are feed hosts, and the scans that do run — over apps/web,
  // apps/api, packages/* — are exactly the places that must never reach them.
  // A TypeScript file acquiring a `data.sec.gov` fetch is the failure this
  // catches; the Python side is held by its own tests (one `import edgar`, a
  // socket-blocking test over every adapter function, and a client whose
  // egress gate raises before opening a socket when SEC_EGRESS=off).
  //
  // Why each is separate from `www.sec.gov`: `data.sec.gov` serves the JSON
  // APIs (submissions, companyfacts) and, measured, sends NO CORS header,
  // while `efts.sec.gov` (full-text search) sends
  // `access-control-allow-origin: *` — which is precisely the property that
  // would tempt someone to call it from a browser or an edge route. It is on
  // this list so that temptation fails a test.
  "data.sec.gov", // submissions + companyfacts JSON APIs
  "efts.sec.gov", // full-text search (EFTS)
  // Not SEC, and not a feed we archive — a CUSIP->ticker mapping API, and the
  // LAST of four tiers behind three primary sources. It earns a place here for
  // the same reason: a request path that starts calling Bloomberg per page
  // render is a defect, and the only cheap way to keep that true is to make it
  // fail a test.
  "api.openfigi.com",
  // MONEY-1309 — Zerodha's TICK socket, which is a different host from the REST
  // one already on this list. `api.kite.trade` was here from the start;
  // `ws.kite.trade` was not, so `workers/src/connect/ws/zerodha-ws.ts` opening
  // `wss://ws.kite.trade/` was invisible to every scan in this file — the
  // MONEY-1157 lesson ("a host nobody lists is a host nobody protects") arriving
  // a second time, one transport over.
  "ws.kite.trade",
  // MONEY-1404 — the MUTUAL FUND feeds, and the reason they are here is the
  // reason this whole file exists. None of the three was listed, so the scan
  // guarded none of them, and `portal.amfiindia.com/spages/NAVAll.txt` — the
  // PRIMARY NAV feed, ~14,300 schemes a night — was fetched with a bare
  // `fetch()` and archived by nobody. When AMFI moved two columns on
  // 2026-08-19 there was no stored copy of the file to date the change
  // against: MONEY-1403 had to ask AMFI for bytes it no longer serves.
  //
  // `www.amfiindia.com` is listed BESIDE the portal rather than instead of it.
  // It 302s to the portal for NAVAll, and `fetch` follows redirects, so a
  // caller pointed at the www host still works — which is exactly what made
  // the old constant dangerous (MONEY-1198). Both are feed hosts; both are
  // scanned.
  "portal.amfiindia.com", // NAVAll.txt, the scheme master, per-AMC RssNAV
  "www.amfiindia.com", // the AAUM/TER doors + every referer AMFI expects
  // MFAPI.in — the NAV HISTORY upstream, a different vendor for the same
  // quantity. `mf-nav-backfill` reads it per scheme; the one caller is
  // exempted below, and that exemption is what makes a SECOND caller fail.
  "api.mfapi.in",
];

/**
 * Hosts whose only caller lives in TypeScript but OUTSIDE `packages/core/src`.
 *
 * The staleness check below reads `src` — this package's own tree — because
 * that is where every host on the list was first used. `ws.kite.trade` is the
 * first that is not: its one caller is `workers/src/connect/ws/zerodha-ws.ts`.
 *
 * The same reasoning as {@link NON_TS_FEED_HOSTS}: the invariant is "a host
 * that matches NOTHING is stale", and only its SCOPE widens. An entry here is
 * asserted, in the MONEY-1309 suite at the bottom of this file, to still appear
 * somewhere in {@link WS_SCAN_ROOTS} — so this cannot become a place to park a
 * host that no longer exists.
 */
const NON_CORE_FEED_HOSTS: Record<string, string> = {
  "ws.kite.trade":
    "Zerodha Connect's live-tick websocket, opened only by " +
    "workers/src/connect/ws/zerodha-ws.ts. That connector is founder-only and " +
    "dormant — it syncs no data — but the host is listed so a SECOND caller, " +
    "in any workspace, fails a test (MONEY-837, MONEY-1309).",
};

/**
 * HTTP calls that reach the network WITHOUT the archive seam.
 *
 * `fetchWithTimeout` is included because it is exported from `exchange-feed.ts`
 * and would bypass `getFeedAsset` just as completely as a bare `fetch`.
 * `import ky` stands in for the ky client: its calls are written `await ky\n
 * .get(...)` across two lines, and the import is the reliable single-line
 * signal that a file talks HTTP through it.
 */
const UNSEAMED_HTTP: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "fetch()", re: /\bfetch\s*\(/ },
  // MONEY-1373 — CAPTURING the global counts too.
  //
  // `const f = globalThis.fetch; await f(url)` reaches the network exactly as
  // a bare `fetch(url)` does, and matched none of the idioms here: the call
  // site is a plain identifier and the capture is a property read. So a file
  // could name a FEED_HOST, download gigabytes from it, and be scanned as
  // making zero HTTP calls — which is the same blindness `deps.httpGet` caused
  // below, arriving through the language rather than through a seam.
  //
  // Found by adding databento-client.ts to FEED_HOSTS: its exemption claimed
  // two call sites and the scan reported none.
  { label: "globalThis.fetch capture", re: /globalThis\s*\.\s*fetch\b/ },
  { label: "injected fetchImpl()", re: /\bfetchImpl\s*\(/ },
  { label: "fetchWithTimeout()", re: /\bfetchWithTimeout\s*\(/ },
  { label: "import ky", re: /^\s*import\s+ky\b/ },
  // MONEY-1255 — an INJECTED http client counts as un-seamed too.
  //
  // `stock-document-sync.ts` gained `deps.httpGet` (defaulting to `ky.get`) so
  // its per-source WRITE counters could be tested; without the seam, deleting
  // `run.wrote.nse++` passed the whole suite. The seam is good. What was not
  // good is that it made two long-excused downloaders — `storeNSEFiling` and
  // `storeScreenerDoc` — INVISIBLE to this scan, because `deps.httpGet(...)`
  // matches none of the idioms above. The bytes still leave the process; only
  // the guard stopped seeing them.
  //
  // That is the failure mode this whole file exists to prevent, arriving by
  // refactor rather than by intent, so the idiom is added rather than the
  // expectation shrunk. Shrinking the excused list would have made the suite
  // green by agreeing that those fetches no longer happen — and they do.
  { label: "injected httpGet()", re: /\bhttpGet\s*\(/ },
];

interface HttpExemption {
  /** Why this file may reach an upstream host without the archive seam. */
  reason: string;
  /** Exact number of un-seamed HTTP call sites the exemption covers. */
  calls: number;
  /**
   * Substrings that must ALL still appear in the file. Pins the exemption to
   * the endpoint it was granted for, so repointing the file at a different feed
   * trips the guard instead of inheriting the exemption.
   */
  pinnedTo: readonly string[];
}

/**
 * The mixed files: they name a FEED_HOST and legitimately talk HTTP without the
 * seam. Each needs a reason, a call count, and the endpoint it is pinned to.
 */
const DATABENTO_CLIENT_FILE = join(
  "src",
  "market-data",
  "databento",
  "databento-client.ts",
);

const MF_NAV_SERVICE_FILE = join(
  "src",
  "market-data",
  "prices",
  "mf-nav-service.ts",
);

const AMFI_METADATA_FILE = join(
  "src",
  "market-data",
  "instruments",
  "amfi-fund-metadata-provider.ts",
);

const HTTP_EXEMPTIONS: Record<string, HttpExemption> = {
  [FETCH_PRIMITIVE_FILE]: {
    reason:
      "This IS the fetch primitive. fetchWithTimeout wraps fetch, " +
      "fetchExchangeAsset wraps fetchWithTimeout, and getFeedAsset wraps that " +
      "— the archive decision sits one layer above, in feed-archive.ts.",
    calls: 2,
    pinnedTo: ["export async function fetchExchangeAsset", "AbortController"],
  },

  [DATABENTO_CLIENT_FILE]: {
    reason:
      "MONEY-1373 — a DELIBERATE exemption, and for the OPPOSITE reason to " +
      "Kite's. The archive seam is exchange-WEBSITE-shaped: it sends " +
      "browser-impersonation headers, takes a referer positionally, and maps " +
      "404 to null = 'non-trading day'. Databento is an authenticated batch " +
      "API whose 403 body distinguishes a bad key from an unentitled dataset, " +
      "and whose downloads are multi-gigabyte zstd STREAMS that must be " +
      "hashed as they arrive — buffering one into `getFeedAsset`'s " +
      "Uint8Array return would need the whole file in memory. The archive's " +
      "upside is not declined here, it is provided differently: every byte " +
      "this file downloads is written to GCS under `databento/` by " +
      "`downloadToArchive`, checksum-verified, and DELETED on a mismatch — a " +
      "stronger guarantee than the seam's, because these bytes are bought " +
      "once and expire 30 days after submission. Do NOT delete this entry; " +
      "widen the seam to support streaming + caller-chosen error " +
      "classification if a second such vendor arrives.",
    // FOUR: the captured global and the call through it, in each of the two
    // request paths (the JSON API and the batch download). Both idioms are
    // counted deliberately — see UNSEAMED_HTTP.
    calls: 4,
    pinnedTo: [
      "DATABENTO_HIST_BASE",
      "export async function downloadToArchive",
      "DatabentoChecksumError",
    ],
  },

  [ZERODHA_INSTRUMENTS_FILE]: {
    reason:
      "MONEY-1157 — a DELIBERATE exemption, not an oversight. Kite's " +
      "/instruments dump is an authenticated developer REST API, and the seam " +
      "is exchange-WEBSITE-shaped: it sends browser-impersonation headers " +
      "(NSE/BSE 403 bot UAs), takes a referer positionally, and maps 404 to " +
      "null = 'non-trading day', which for Kite would turn a moved endpoint " +
      "into a silent zero-row sync. The archive's upside is also already " +
      "declined for this feed on purpose: the endpoint is public, " +
      "tier-agnostic and unmetered, which is why instrument_mappings is a " +
      "QA-DIRECT collection in scripts/ops/sync-prod-to-qa.sh. If Kite ever " +
      "starts rate-limiting, widen the seam (optional headers + a " +
      "caller-chosen 404 policy) — do NOT delete this entry.",
    calls: 1,
    pinnedTo: [
      'const ZERODHA_INSTRUMENTS_URL = "https://api.kite.trade/instruments"',
      "fetch(ZERODHA_INSTRUMENTS_URL",
    ],
  },

  [join("src", "brokers", "clients", "zerodha.ts")]: {
    reason:
      "Per-USER Kite OAuth token exchange, not a feed file. There is nothing " +
      "to archive: the response is a session token scoped to one user, and " +
      "replaying yesterday's would be a bug.",
    calls: 1,
    pinnedTo: ["https://api.kite.trade/session/token"],
  },

  [join("src", "brokers", "adapters", "zerodha.ts")]: {
    reason:
      "Per-USER portfolio reads (holdings/positions/orders/trades) against " +
      "Kite under the user's own access token. User data, not a market-wide " +
      "file — archiving it would put one user's holdings in a shared bucket.",
    calls: 1,
    pinnedTo: ['private readonly baseUrl = "https://api.kite.trade"'],
  },

  [MF_NAV_SERVICE_FILE]: {
    reason:
      "MONEY-1404 — MFAPI.in NAV HISTORY, per SCHEME. The archive's upside is " +
      "declined here for the same reason as index-constituents.ts, not " +
      "because the seam's shape is wrong: this is one URL per scheme across " +
      "~14,225 schemes, so archiving it means ~14k GCS objects a run to " +
      "mirror rows QA already receives — `mf_nav_history` is in " +
      "REFERENCE_COLLECTIONS (scripts/ops/sync-prod-to-qa.sh) and " +
      "`mf-nav-backfill-daily` is in PROD_ONLY_JOBS, so QA never fetches this " +
      "host at all. The seam also keys its object off the URL, and a " +
      "per-scheme key is a cache, not a feed archive. If MFAPI ever starts " +
      "serving a WHOLE-UNIVERSE file, that file rides getFeedAsset — do not " +
      "widen this entry to cover it.",
    calls: 1,
    pinnedTo: ["https://api.mfapi.in/mf/${schemeCode}", "MFAPI.in returned"],
  },

  [AMFI_METADATA_FILE]: {
    reason:
      "MONEY-1404 — NOT YET MIGRATED, and recorded as that rather than " +
      "argued as a design. The AAUM/TER/scheme-master doors are exactly the " +
      "archivable shape (whole-market files, already carrying FEED_SHAPES " +
      "rows in feed-payload.ts as AMFI/scheme-master, AMFI/aaum-schemewise " +
      "and AMFI/ter), and the file's own header says routing `amfiFetch` " +
      "through getFeedAsset is a one-line change now that FeedDescriptor " +
      "admits AMFI. It was left out of MONEY-1404's diff because that ticket " +
      "moved the NAV feed (amfi-mf-provider.ts) and touching a second " +
      "provider was out of its scope — the hosts are listed now so this file " +
      "is VISIBLE rather than invisible, which is the difference that cost 26 " +
      "nights. `calls: 2` is one real fetch (amfiFetch) plus the " +
      "`async fetch(lookup)` PROVIDER METHOD at :1340, which opens no socket " +
      "and is matched because this scan is file-granular and deliberately " +
      "over-triggers.",
    calls: 2,
    pinnedTo: [
      "async function amfiFetch",
      'const AMFI_PORTAL = "https://portal.amfiindia.com"',
    ],
  },

  [join("src", "screener", "index-constituents.ts")]: {
    reason:
      "NSE's per-index constituents JSON API, not a raw file. It is mirrored " +
      "to QA by the OTHER tier: `index_constituents` is in " +
      "REFERENCE_COLLECTIONS in scripts/ops/sync-prod-to-qa.sh, so " +
      "--tier=reference already copies the parsed rows down. Routing it " +
      "through the feeds archive as well would mirror the same data twice.",
    calls: 1,
    pinnedTo: [
      'const NSE_INDEX_URL = "https://www.nseindia.com/api/equity-stockIndices"',
    ],
  },
};

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(entry)) yield full;
  }
}

function sourceFiles(): string[] {
  return [...walk(SCAN_ROOT)];
}

/**
 * Strip line + block comments so prose mentions don't trip the scan.
 *
 * Comments are blanked LINE-FOR-LINE rather than deleted: every offender below
 * is reported as `file:line`, and this file's own header is 37 lines of block
 * comment, so deleting them outright would print line numbers ~40 short of the
 * real ones in exactly the files people then have to go read.
 *
 * Hence `[^\S\n]` and not `\s` on the line-comment pattern: `\s` matches
 * newlines, so a leading `\s*` starting on a BLANK line swallowed that line's
 * newline too and collapsed the pair into one — 20 lines of drift in
 * nse-filings.ts alone, all of it after the point people would be reading from.
 */
function stripComments(src: string): string {
  return src
    .replace(/^[^\S\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""));
}

/**
 * A declaration or a barrel re-export, not a call site.
 *
 * `export function fetchWithTimeout(` and
 * `export { fetchExchangeAsset } from "./exchange-feed"` both contain a
 * matching token without fetching anything.
 */
function isDeclarationOrReExport(line: string): boolean {
  // A `function` line that ALSO makes a call is a call site, not a
  // declaration. Skipping it wholesale made
  // `export async function ping() { await fetch(url); }` scan as ZERO HTTP
  // calls — the same fetch on its own line was caught, so the blind spot was
  // exactly one line wide and only on the shape a one-liner takes.
  const declaresFunction = /\b(?:async\s+)?function\s+\w+\s*\(/.test(line);
  if (declaresFunction) {
    const afterBrace = line.slice(line.indexOf("{") + 1);
    if (
      line.includes("{") &&
      UNSEAMED_HTTP.some((p) => p.re.test(afterBrace))
    ) {
      return false;
    }
  }
  return /^\s*export\s+(?:\*|type\b|\{)/.test(line) || declaresFunction;
}

/** Un-seamed HTTP call sites in a file, as `file:line  label  source`. */
function unseamedHttpCalls(file: string, src: string): string[] {
  const hits: string[] = [];
  stripComments(src)
    .split("\n")
    .forEach((line, i) => {
      if (isDeclarationOrReExport(line)) return;
      for (const { label, re } of UNSEAMED_HTTP) {
        if (re.test(line)) {
          hits.push(`${file}:${i + 1}  [${label}]  ${line.trim()}`);
          break;
        }
      }
    });
  return hits;
}

/** Feed hosts named anywhere in a file (comments included — a URL is a URL). */
function feedHostsIn(src: string): string[] {
  return FEED_HOSTS.filter((h) => src.includes(h));
}

describe("raw exchange fetches route through the archive seam (MONEY-1085)", () => {
  it("no module outside the seam calls fetchExchangeAsset directly", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (BYPASS_ALLOWLIST[file]) continue;
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        // The re-export in the barrel is fine — it exposes the helper, it
        // doesn't fetch with it.
        if (/^\s*export\s/.test(line)) return;
        if (DIRECT_CALL.test(line))
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }

    assert.deepEqual(
      offenders,
      [],
      "call getFeedAsset() instead — a direct fetchExchangeAsset() silently " +
        "opts that feed out of the GCS archive, so prod stops archiving it and " +
        "QA keeps scraping the exchange for it, with nothing failing:\n" +
        offenders.join("\n"),
    );
  });

  it("the seam still exists and still wraps the fetch (scan is live)", () => {
    // Guards against the scan passing vacuously after a rename.
    const seam = readFileSync(SEAM_FILE, "utf8");
    assert.match(
      seam,
      DIRECT_CALL,
      "feed-archive.ts must still call fetchExchangeAsset — if this moved, " +
        "retarget this scan rather than letting it pass on nothing",
    );
    assert.match(seam, /export async function getFeedAsset/);
  });

  it("every bhavcopy/master fetch actually uses the seam", () => {
    // The complement of the scan above: prove the callers are wired, not just
    // that they aren't bypassing. A feed that fetches through neither path
    // would slip past both assertions.
    const bhavcopy = readFileSync(
      join("src", "market-data", "bhavcopy.ts"),
      "utf8",
    );
    const calls = bhavcopy.match(/getFeedAsset\(/g) ?? [];
    assert.equal(
      calls.length,
      3,
      "expected exactly 3 getFeedAsset calls in bhavcopy.ts (BSE bhavcopy, " +
        "NSE bhavcopy, NSE indices); found " +
        calls.length,
    );

    const master = readFileSync(
      join("src", "market-data", "instruments", "nse-master-instruments.ts"),
      "utf8",
    );
    assert.match(master, /getFeedAsset\(/);

    const bseMaster = readFileSync(
      join("src", "market-data", "instruments", "bse-master-instruments.ts"),
      "utf8",
    );
    assert.match(bseMaster, /getFeedAsset\(/);
  });

  it("the AMFI NAV feed is seamed, DATED, and treats a miss as a failure", () => {
    // MONEY-1404 C6 — the positive half for this feed. The offender scan above
    // catches a REVERSION to `fetch()`, because the file names a FEED_HOST. It
    // cannot catch the two ways a seamed call still loses what the seam is for:
    //
    //   an UNDATED descriptor    every day overwrites one object, so there is
    //                            still no historical copy to date a grammar
    //                            change against — which is the thing
    //                            MONEY-1403 needed and did not have.
    //   `null` read as empty     `getFeedAsset` returns null on a 404, and for
    //                            a feed published every calendar day that is a
    //                            failed fetch. Returning [] here is the exact
    //                            26-night bug one layer up.
    const amfi = readFileSync(
      join("src", "market-data", "instruments", "amfi-mf-provider.ts"),
      "utf8",
    );
    const calls = amfi.match(/getFeedAsset\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      "expected exactly ONE getFeedAsset call in amfi-mf-provider.ts — the " +
        "nightly sync and the ISIN resolver share one fetcher, so a second " +
        "call site means one of them grew its own descriptor and its own " +
        `archive key; found ${calls.length}`,
    );

    const seamed = stripComments(amfi);
    assert.match(
      seamed,
      /feed:\s*"navall"[\s\S]{0,200}?date:/,
      "the NAVAll descriptor must carry a `date` — an undated descriptor keys " +
        "under `current/` and overwrites yesterday's file",
    );
    assert.match(
      seamed,
      /basename:\s*`NAVAll-\$\{toIstDateKey\(/,
      "the URL's basename is the constant `NAVAll.txt`, so a dated descriptor " +
        "alone still resolves every day of a month to ONE key — the basename " +
        "has to carry the day too",
    );
    assert.match(
      seamed,
      /res === null[\s\S]{0,200}?throw new Error/,
      "a null from getFeedAsset (404) must THROW for this feed, never be " +
        "read as an empty publication day",
    );
  });
});

describe("no plain fetch() to an upstream feed host (MONEY-1157)", () => {
  it("every un-seamed HTTP call at a feed host is exempted on purpose", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      const hosts = feedHostsIn(src);
      if (hosts.length === 0) continue;

      const hits = unseamedHttpCalls(file, src);
      if (hits.length === 0) continue;

      const exemption = HTTP_EXEMPTIONS[file];
      if (exemption && hits.length === exemption.calls) continue;

      offenders.push(
        exemption
          ? `${file}: exemption covers ${exemption.calls} call(s) but the ` +
              `file now has ${hits.length}. Re-read the exemption and update ` +
              `its \`calls\` — or route the new one through getFeedAsset:\n` +
              hits.map((h) => `    ${h}`).join("\n")
          : // "references" not "fetches": hosts are detected in the RAW source,
            // comments included, so a URL assembled from parts still forces the
            // file to be looked at. A host may therefore be listed that this
            // particular call does not target — the call sites below are what
            // actually needs a decision.
            `${file} references feed host(s) ${hosts.join(", ")} and makes ` +
              `an HTTP call outside the archive seam:\n` +
              hits.map((h) => `    ${h}`).join("\n"),
      );
    }

    assert.deepEqual(
      offenders,
      [],
      "call getFeedAsset() — a plain fetch() at an exchange host is invisible " +
        "to the archive, so prod never archives that feed and QA keeps " +
        "scraping the exchange for it, with nothing failing. If the call is " +
        "genuinely not an archivable feed file, add it to HTTP_EXEMPTIONS with " +
        "a written reason:\n\n" +
        offenders.join("\n\n"),
    );
  });

  it("the scan actually fires — a synthetic bypass is caught", () => {
    // Without this the whole suite above could pass because the regexes stopped
    // matching, which is precisely how the pre-MONEY-1157 version was green.
    const synthetic = [
      "const KITE = 'https://api.kite.trade/instruments';",
      "const res = await fetch(KITE, { headers: {} });",
    ].join("\n");

    assert.deepEqual(feedHostsIn(synthetic), ["api.kite.trade"]);
    const hits = unseamedHttpCalls("synthetic.ts", synthetic);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!, /^synthetic\.ts:2 {2}\[fetch\(\)\]/);

    // MONEY-1373 — a fetch on the same line as its own `function` keyword.
    // `isDeclarationOrReExport` skipped the whole line, so this scanned as
    // zero HTTP calls while the identical fetch one line down was caught.
    const oneLiner = [
      "const T = 'https://api.tiingo.com/x';",
      "export async function ping() { return fetch(T); }",
    ].join("\n");
    const oneLinerHits = unseamedHttpCalls("synthetic.ts", oneLiner);
    assert.equal(
      oneLinerHits.length,
      1,
      `a fetch on a function declaration line scanned as ${oneLinerHits.length} call(s)`,
    );

    // MONEY-1373 — the CAPTURED global, which used to scan as zero calls.
    const captured = [
      "const DB = 'https://hist.databento.com/v0/batch.list_files';",
      "const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);",
      "const res = await fetchImpl(DB, { headers: {} });",
    ].join("\n");
    assert.deepEqual(feedHostsIn(captured), ["hist.databento.com"]);
    const capturedHits = unseamedHttpCalls("synthetic.ts", captured);
    assert.equal(
      capturedHits.length,
      2,
      `the captured-global idiom scanned as ${capturedHits.length} call(s):\n${capturedHits.join("\n")}`,
    );
  });

  it("the scan does not fire on a seamed caller or a bare constant", () => {
    // The other half: over-triggering would get the guard disabled.
    const seamed = [
      "const URL = 'https://nsearchives.nseindia.com/content/cm/x.zip';",
      "const res = await getFeedAsset(URL, NSE_REFERER, d);",
    ].join("\n");
    assert.deepEqual(unseamedHttpCalls("seamed.ts", seamed), []);

    // brokers/config.ts is the live example: it names api.kite.trade and makes
    // no call at all, so it must not need an exemption.
    const config = readFileSync(join("src", "brokers", "config.ts"), "utf8");
    assert.ok(feedHostsIn(config).length > 0);
    assert.deepEqual(unseamedHttpCalls("config.ts", config), []);
  });

  it("prose in a comment cannot trip the scan", () => {
    const prose = [
      "// We used to fetch(https://api.kite.trade/instruments) here.",
      "/* fetch( */",
      "const x = 1;",
    ].join("\n");
    assert.deepEqual(unseamedHttpCalls("prose.ts", prose), []);
  });

  /**
   * Hosts whose ONLY caller lives outside the TypeScript tree.
   *
   * MONEY-979 introduced the first of these. `api.openfigi.com` is called by
   * `services/us-fundamentals/`, a Python service — so the staleness check
   * below, which reads `packages/core/src`, would call the entry stale and
   * demand it be dropped.
   *
   * Dropping it would be the wrong move, and the reason is the same one that
   * put every other host on the list (MONEY-1157): a host nobody lists is a
   * host nobody protects. Listing OpenFIGI is what makes a FUTURE TypeScript
   * fetch — a request path calling Bloomberg per page render — fail a test
   * instead of shipping.
   *
   * So the invariant is kept and only its SCOPE widens: such a host must still
   * match something, just somewhere else, and this map records where and why.
   * A host that matches in NEITHER place is still stale and still fails.
   */
  const NON_TS_FEED_HOSTS: Record<string, string> = {
    "api.openfigi.com":
      "CUSIP->ticker mapping, called only by services/us-fundamentals (Python) " +
      "as the last of four tiers behind three primary sources (MONEY-979).",
  };

  it("every FEED_HOST still appears in src (no stale entries)", () => {
    const all = sourceFiles()
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const stale = FEED_HOSTS.filter(
      (h) =>
        !all.includes(h) &&
        !(h in NON_TS_FEED_HOSTS) &&
        !(h in NON_CORE_FEED_HOSTS),
    );
    assert.deepEqual(
      stale,
      [],
      `FEED_HOSTS entries no longer present in src: ${stale.join(", ")}. ` +
        `Either the feed moved (retarget the host) or it was removed (drop ` +
        `the entry) — a host that matches nothing makes the scan weaker ` +
        `without saying so.`,
    );
  });

  it("a non-TypeScript feed host still matches SOMETHING, and says where", () => {
    // The exemption above must not become a place to park dead hosts. Each one
    // is checked against the tree that actually calls it, so an entry whose
    // Python caller is deleted fails here rather than quietly weakening the
    // scan — which is the exact failure the staleness check exists to prevent,
    // one directory over.
    // cwd is packages/core, matching WORKER_SCAN_ROOT's spelling above.
    const servicesRoot = join("..", "..", "services");

    // A dedicated walker rather than the shared `walk()`: that one filters on
    // SOURCE_EXT and can only ever yield TypeScript, so reusing it here would
    // have returned nothing and the assertion below would have "passed" on an
    // empty string. Loosening the shared walker instead would widen every
    // other scan in this file, which is the opposite of what any of them want.
    const pythonSources = (dir: string): string[] => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const entry of entries) {
        // `.venv` holds third-party packages — dozens of MB, and none of it
        // ours. `fixtures` holds captured SEC responses, which legitimately
        // contain feed hostnames and would make this check pass for the wrong
        // reason.
        if (entry === ".venv" || entry === "fixtures") continue;
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...pythonSources(full));
        else if (/\.py$/.test(entry)) out.push(full);
      }
      return out;
    };

    const files = pythonSources(servicesRoot);
    const servicesSrc = files.map((f) => readFileSync(f, "utf8")).join("\n");
    assert.ok(
      files.length > 5,
      `walked services/ and found ${files.length} Python file(s) — the tree ` +
        `moved, so this check is no longer reading what it claims to`,
    );

    const missing = Object.keys(NON_TS_FEED_HOSTS).filter(
      (h) => !servicesSrc.includes(h),
    );
    assert.deepEqual(
      missing,
      [],
      `NON_TS_FEED_HOSTS names a host that appears nowhere in services/: ` +
        `${missing.join(", ")}. Drop the entry, or point it at the tree that ` +
        `now calls it.`,
    );

    for (const [host, why] of Object.entries(NON_TS_FEED_HOSTS)) {
      assert.ok(
        why.length > 40,
        `${host} needs a written reason, not a placeholder — an exemption ` +
          `list without them rots into an allowlist`,
      );
    }
  });

  it("every exemption still points at the endpoint it was granted for", () => {
    // An exemption that outlives its reason is a hole. Pinning it to the
    // endpoint means repointing the file trips the guard instead of silently
    // inheriting permission.
    for (const [file, exemption] of Object.entries(HTTP_EXEMPTIONS)) {
      const src = readFileSync(file, "utf8");
      for (const pin of exemption.pinnedTo) {
        assert.ok(
          src.includes(pin),
          `${file} no longer contains ${JSON.stringify(pin)}, which its ` +
            `HTTP_EXEMPTIONS entry is pinned to. The exemption was granted ` +
            `for that specific endpoint — re-justify it or remove it.\n` +
            `Reason on file: ${exemption.reason}`,
        );
      }
      assert.equal(
        unseamedHttpCalls(file, src).length,
        exemption.calls,
        `${file}'s exemption claims ${exemption.calls} un-seamed call(s)`,
      );
    }
  });

  it("every market-data exemption is one of the four argued ones", () => {
    // Everything else under market-data/ must ride the seam, so an entry
    // appearing here is a decision made deliberately rather than by adding a
    // line. There are two KINDS, and the distinction is the point:
    //
    // (a) THE SEAM IS THE WRONG SHAPE — two entries, for opposite reasons:
    //
    //   zerodha-instruments.ts  the seam's SHAPE is wrong — browser
    //                           impersonation, positional referer, 404 as
    //                           "non-trading day" — for an authenticated
    //                           developer REST API, and the archive's upside is
    //                           declined on purpose (public, unmetered,
    //                           QA-DIRECT).
    //   databento-client.ts     the seam's RETURN TYPE is wrong: a Uint8Array
    //                           cannot express a multi-gigabyte zstd stream
    //                           hashed as it arrives. The archive is not
    //                           declined here at all — it is stronger, because
    //                           every byte is written under `databento/`,
    //                           checksum-verified, and deleted on a mismatch.
    //
    // A THIRD entry of THIS kind means the seam has been wrong three times and
    // should be widened instead.
    //
    // (b) THE FILE IS VISIBLE BUT NOT SEAMED — two entries, both MONEY-1404,
    //     both arriving the day their hosts were added to FEED_HOSTS. Neither
    //     claims the seam is wrong:
    //
    //   mf-nav-service.ts       per-SCHEME JSON. ~14k URLs, and QA receives
    //                           the rows instead (PROD_ONLY + a
    //                           REFERENCE_COLLECTION), so there is nothing for
    //                           an archive to give it.
    //   amfi-fund-metadata-     NOT YET MIGRATED. Whole-market files that
    //   provider.ts             SHOULD ride the seam; out of MONEY-1404's
    //                           scope. Listing the host is what turns "nobody
    //                           knows this fetch exists" into "this fetch is
    //                           on a list with a reason".
    //
    // The set is pinned, not the count: a NEW name here is a decision either
    // way, and which kind it is has to be written into its own entry.
    const marketDataExemptions = Object.keys(HTTP_EXEMPTIONS)
      .filter(
        (f) =>
          f.startsWith(join("src", "market-data")) &&
          f !== FETCH_PRIMITIVE_FILE,
      )
      .sort();
    assert.deepEqual(
      marketDataExemptions,
      [
        DATABENTO_CLIENT_FILE,
        ZERODHA_INSTRUMENTS_FILE,
        MF_NAV_SERVICE_FILE,
        AMFI_METADATA_FILE,
      ].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1189 — the NSE JSON seam, per FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
//
// The two scans above are FILE-granular, and both are blind here twice over.
// They only walk `packages/core/src`, and NSE's cookie-gated JSON APIs are read
// from `packages/research/src` — but even pointed at the right tree, file
// granularity could not have caught this: `nse-filings.ts` already called
// `archiveNseJsonResponse` from three functions while `fetchNSEAnnouncements`,
// `fetchNSEFinancialResults` and `fetchNSECorporateActions` fetched NSE and
// threw the bytes away. The file looked compliant because most of it was.
//
// So this scan is per top-level FUNCTION: a block that talks HTTP to NSE must
// hand its raw response to `archiveNseJsonResponse`. What the archive then does
// with it is the ARCHIVE's decision — today `nseJsonArchiveKey` skips anything
// carrying `symbol=`, and these three fetchers are all per-symbol, so nothing is
// written for them yet. That is exactly why the call sites still have to be
// there: the skip has to be a policy that one module applies, not a fetcher that
// never asked. Move the per-symbol rule and every wired fetcher follows.

/** `packages/research/src`, relative to packages/core (the test CWD). */
const NSE_SCAN_ROOT = join("..", "research", "src");

/** Names a NSE endpoint — the module constant or a literal URL. */
const NSE_HOST = /\bNSE_BASE\b|nseindia\.com/;

/** The archive seam every NSE JSON read must pass its raw text through. */
const NSE_ARCHIVE_CALL = /\barchiveNseJsonResponse\s*\(/;

/**
 * HTTP calls, including the two indirections this tree actually uses:
 * `(fetchImpl ?? kyFetchImpl)(url, …)` and ky's two-line `await ky\n.get(…)`.
 * `\s` spans newlines, which is what makes the second one matchable at all.
 */
const NSE_HTTP: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "fetch()", re: /\bfetch\s*\(/ },
  { label: "ky.get()", re: /\bky\s*\.\s*get\s*\(/ },
  { label: "fetchImpl()", re: /[fF]etchImpl\s*\)?\s*\(/ },
  // MONEY-1255 — an INJECTED client is still an HTTP call.
  //
  // `stock-document-sync.ts` gained `deps.httpGet` (defaulting to `ky.get`) so
  // its per-source WRITE counters could be tested — a real improvement: without
  // the seam, deleting `run.wrote.nse++` passed the entire suite. But the
  // rewrite from `ky.get(...)` to `deps.httpGet(...)` matched none of the
  // idioms above, so `storeNSEFiling` and `storeScreenerDoc` — two long-excused
  // binary downloaders — silently DROPPED OUT of this scan. The bytes still
  // leave the process; only the guard stopped seeing them.
  //
  // Which is exactly the blindness this file exists to prevent, arriving by
  // refactor rather than by intent. The idiom is added rather than the excused
  // list shrunk: shrinking it would have made the suite green by agreeing those
  // downloads no longer happen, and they do.
  { label: "injected httpGet()", re: /\bhttpGet\s*\(/ },
];

/**
 * A cookie handshake, not a data read. NSE gates `/api/*` behind cookies from
 * the site root; the fetchers all warm one up first. There is no JSON in the
 * response — the payload is the `set-cookie` header — so there is nothing to
 * archive. Recognised structurally rather than by name because four files
 * implement their own copy of it.
 */
const NSE_HANDSHAKE = /set-cookie/;

/**
 * An attachment download (annual-report PDFs, filing attachments), not a JSON
 * API read. These bytes ARE persisted — the document pipeline uploads them to
 * GCS and records the path — they just don't belong in the JSON feed archive,
 * whose keys and families describe `/api/*` payloads.
 */
const NSE_BINARY = /\barrayBuffer\s*\(\s*\)/;

/** Control-flow lines that look like a declaration to the block splitter. */
const NOT_A_DECLARATION = new Set([
  "for",
  "if",
  "while",
  "switch",
  "catch",
  "do",
  "else",
  "return",
  "try",
]);

const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+(\w+)/;

/** A class method, e.g. `  private async nseFetch<T>(path: string): … {`. */
const CLASS_METHOD =
  /^ {2}(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{]*)?\{\s*$/;

interface SourceBlock {
  name: string;
  /** 1-based line of the declaration that opened the block. */
  line: number;
  body: string;
}

/**
 * Split a module into named blocks at each top-level declaration / class
 * method. Deliberately crude: a signature wrapped across lines does not start a
 * new block, so its body is absorbed by the previous one. That over-attributes
 * rather than under-detects — the call still gets scanned, it is just reported
 * under its neighbour's name.
 */
function sourceBlocks(src: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let current: SourceBlock = { name: "(module)", line: 1, body: "" };

  stripComments(src)
    .split("\n")
    .forEach((rawLine, i) => {
      const declared =
        TOP_LEVEL_DECL.exec(rawLine) ?? CLASS_METHOD.exec(rawLine);
      const name = declared?.[1];
      if (name && !NOT_A_DECLARATION.has(name)) {
        if (current.body) blocks.push(current);
        current = { name, line: i + 1, body: "" };
      }
      current.body += `${rawLine}\n`;
    });

  blocks.push(current);
  return blocks;
}

/** The NSE HTTP call a block makes, or null when it makes none. */
function nseHttpCall(block: SourceBlock): string | null {
  if (!NSE_HOST.test(block.body)) return null;
  return NSE_HTTP.find(({ re }) => re.test(block.body))?.label ?? null;
}

/** Blocks that read NSE JSON — handshakes and binary downloads excluded. */
function nseJsonReaders(
  file: string,
  src: string,
): Array<{ key: string; block: SourceBlock; call: string }> {
  const readers: Array<{ key: string; block: SourceBlock; call: string }> = [];
  for (const block of sourceBlocks(src)) {
    const call = nseHttpCall(block);
    if (!call) continue;
    if (NSE_HANDSHAKE.test(block.body)) continue;
    if (NSE_BINARY.test(block.body)) continue;
    readers.push({ key: `${file}::${block.name}`, block, call });
  }
  return readers;
}

interface NseArchiveExemption {
  /** Why this NSE JSON reader may skip the archive seam. */
  reason: string;
  /**
   * Substrings that must ALL still appear in the FILE, so an exemption cannot
   * outlive the code it was written about. File-scoped, not block-scoped: the
   * endpoint an exemption is really about is often a path built by the caller
   * one function away from the fetch it is pinned to.
   */
  pinnedTo: readonly string[];
}

/** Path of a research data-source, keyed the way offenders are reported. */
const nseFile = (name: string): string =>
  join(NSE_SCAN_ROOT, "data-sources", name);

/**
 * NSE JSON readers that do NOT archive, each a recorded decision.
 *
 * Two of these are gaps, not absolutions: they are listed so the guard has an
 * opinion about them instead of never seeing them, and both name the ticket.
 */
const NSE_ARCHIVE_EXEMPTIONS: Record<string, NseArchiveExemption> = {
  [`${nseFile("nse-client.ts")}::nseFetch`]: {
    reason:
      "KNOWN GAP (MONEY-1189 follow-up), recorded rather than blessed. " +
      "NseClient reads ~9 `/api/*` endpoints for LIVE research-agent runs, " +
      "none through the seam. Every one of them is per-symbol, which the " +
      "archive's own policy skips, except `/api/equity-stockIndices` — and " +
      "that one is already mirrored to QA as `index_constituents` in " +
      "REFERENCE_COLLECTIONS (scripts/ops/sync-prod-to-qa.sh), the same " +
      "reason src/screener/index-constituents.ts is exempted above. Add a " +
      "MARKET-WIDE endpoint here and this entry stops being defensible.",
    pinnedTo: ["private async nseFetch<T>", "MAX_RETRIES"],
  },

  [`${nseFile("nse-fii-dii.ts")}::nseFetch`]: {
    reason:
      "KNOWN GAP (MONEY-1189 follow-up). `/api/fiidiiTradeReact` IS " +
      "market-wide and IS the archivable shape — it just has no row in " +
      "nse-json-archive's FAMILY_BY_PREFIX, and that module archives by " +
      "table, not by guess: wiring the seam without a family would file the " +
      "response nowhere while reporting success. Adding the row is the fix; " +
      "it is a data-retention decision, not a refactor.",
    pinnedTo: ["fiidiiTradeReact", "retryRes"],
  },

  [`${nseFile("screener-client.ts")}::fetchScreenerDocuments`]: {
    reason:
      "Not an NSE call at all. This scrapes screener.in; the nseindia.com " +
      "match is a CSS attribute selector picking out links that point INTO " +
      "NSE. Hosts are matched anywhere in the source on purpose (a URL " +
      "assembled from parts still forces a look), and this is the price.",
    pinnedTo: ["nseindia.com/corporate", "BASE_URL"],
  },
};

/**
 * The NSE JSON fetchers this scan exists to cover, and the archive call each
 * one must keep. Named explicitly so the suite cannot pass because the scan
 * stopped seeing the file — the failure mode of every guard that greps.
 */
const EXPECTED_ARCHIVING_FETCHERS: readonly string[] = [
  "fetchNseApiJson",
  "fetchNSEAnnouncements",
  "fetchNSEFinancialResults",
  "fetchNSECorporateActions",
  "fetchNSECorporateActionsBulk",
  "fetchNseOwnershipJson",
];

function nseSourceFiles(): string[] {
  return [...walk(NSE_SCAN_ROOT)];
}

describe("NSE JSON fetchers archive what they fetch (MONEY-1189 / P5.7)", () => {
  it("the research tree is actually reachable from here", () => {
    // A cross-package scan that silently walks nothing is worse than no scan:
    // every assertion below would pass on an empty list.
    const files = nseSourceFiles();
    assert.ok(
      files.length > 50,
      `expected to walk packages/research/src from packages/core, found ` +
        `${files.length} file(s) under ${NSE_SCAN_ROOT}`,
    );
    assert.ok(files.includes(nseFile("nse-filings.ts")));
  });

  it("every NSE JSON reader hands its raw response to the archive", () => {
    const offenders: string[] = [];

    for (const file of nseSourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const { key, block, call } of nseJsonReaders(file, src)) {
        if (NSE_ARCHIVE_CALL.test(block.body)) continue;
        if (NSE_ARCHIVE_EXEMPTIONS[key]) continue;
        offenders.push(`${file}:${block.line}  ${block.name}()  [${call}]`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "these functions fetch NSE JSON and discard the bytes. Pass the RAW " +
        "response text to archiveNseJsonResponse(path, text) before parsing " +
        "it — a fetcher that never asks the archive is opted out of it " +
        "permanently, so prod archives nothing for that endpoint and a " +
        "parser bug found next month has no response left to re-run against. " +
        "If it genuinely is not an archivable JSON read, add it to " +
        "NSE_ARCHIVE_EXEMPTIONS with a written reason:\n" +
        offenders.join("\n"),
    );
  });

  it("the fetchers it exists to cover are all still detected AND archiving", () => {
    const src = readFileSync(nseFile("nse-filings.ts"), "utf8");
    const readers = nseJsonReaders(nseFile("nse-filings.ts"), src);
    const byName = new Map(readers.map((r) => [r.block.name, r.block]));

    for (const name of EXPECTED_ARCHIVING_FETCHERS) {
      const block = byName.get(name);
      assert.ok(
        block,
        `${name} is no longer detected as an NSE JSON reader. Either it was ` +
          `renamed (update EXPECTED_ARCHIVING_FETCHERS) or the detector ` +
          `stopped matching — do not leave this list stale, it is the only ` +
          `thing standing between this scan and passing on nothing.`,
      );
      assert.match(
        block.body,
        NSE_ARCHIVE_CALL,
        `${name} no longer calls archiveNseJsonResponse`,
      );
    }
  });

  it("the scan fires on the pre-fix shape and not on the fixed one", () => {
    // Literally the MONEY-1189 defect and its fix, side by side. Without this
    // the whole suite could go green because a regex stopped matching, which is
    // how the MONEY-1157 version of the scan above was green for months.
    const preFix = [
      "export async function fetchNSEAnnouncements(symbol: string) {",
      "  const cookie = await getSession();",
      "  const resp = await ky.get(`${NSE_BASE}/api/corporates-announcements`, {",
      "    searchParams: { symbol },",
      "  });",
      "  return parseAnnouncements(symbol, JSON.parse(await resp.text()));",
      "}",
    ].join("\n");

    const preFixOffenders = nseJsonReaders("synthetic.ts", preFix).filter(
      (r) => !NSE_ARCHIVE_CALL.test(r.block.body),
    );
    assert.equal(preFixOffenders.length, 1);
    assert.equal(preFixOffenders[0]!.block.name, "fetchNSEAnnouncements");
    assert.equal(preFixOffenders[0]!.call, "ky.get()");

    const fixed = preFix.replace(
      "  return parseAnnouncements",
      "  await archiveNseJsonResponse(path, text);\n  return parseAnnouncements",
    );
    assert.deepEqual(
      nseJsonReaders("synthetic.ts", fixed).filter(
        (r) => !NSE_ARCHIVE_CALL.test(r.block.body),
      ),
      [],
    );
  });

  it("a handshake, a PDF download and a comment are not JSON reads", () => {
    // The over-trigger side. A guard that flags the cookie warm-up and every
    // attachment download gets exemptions bolted on until it means nothing.
    const handshake = [
      "async function getSession(): Promise<string> {",
      "  const resp = await ky.get(NSE_BASE, { redirect: 'manual' });",
      "  return resp.headers.get('set-cookie') ?? '';",
      "}",
    ].join("\n");
    assert.deepEqual(nseJsonReaders("synthetic.ts", handshake), []);

    const pdf = [
      "async function downloadPdfFromNSE(url: string) {",
      "  const resp = await ky.get(`${NSE_BASE}${url}`);",
      "  return Buffer.from(await resp.arrayBuffer());",
      "}",
    ].join("\n");
    assert.deepEqual(nseJsonReaders("synthetic.ts", pdf), []);

    const prose = [
      "// We used to fetch(`${NSE_BASE}/api/x`) here without archiving.",
      "/* www.nseindia.com — see fetch() above */",
      "export const NOTE = 1;",
    ].join("\n");
    assert.deepEqual(nseJsonReaders("synthetic.ts", prose), []);
  });

  it("block line numbers survive the comment stripping", () => {
    // The offender message is a `file:line` people paste into an editor. This
    // file's own 37-line header is a block comment, and nse-filings.ts is
    // mostly comment by volume — deleting them outright would have every
    // reported line short by dozens.
    const src = readFileSync(nseFile("nse-filings.ts"), "utf8");
    const lines = src.split("\n");
    for (const { block } of nseJsonReaders(nseFile("nse-filings.ts"), src)) {
      assert.match(
        lines[block.line - 1] ?? "",
        new RegExp(`\\b${block.name}\\b`),
        `reported line ${block.line} for ${block.name} does not declare it`,
      );
    }
  });

  it("every exemption still names a live, still-fetching block", () => {
    // Same discipline as HTTP_EXEMPTIONS: an entry that matches nothing is a
    // hole that reads like coverage.
    const readersByKey = new Map(
      nseSourceFiles().flatMap((file) =>
        nseJsonReaders(file, readFileSync(file, "utf8")).map(
          (r) => [r.key, r] as const,
        ),
      ),
    );

    for (const [key, exemption] of Object.entries(NSE_ARCHIVE_EXEMPTIONS)) {
      const reader = readersByKey.get(key);
      assert.ok(
        reader,
        `${key} no longer exists or no longer fetches NSE — drop the ` +
          `exemption.\nReason on file: ${exemption.reason}`,
      );
      assert.ok(
        !NSE_ARCHIVE_CALL.test(reader.block.body),
        `${key} now archives — delete its exemption, it is claiming a gap ` +
          `that has been closed`,
      );
      const src = readFileSync(key.split("::")[0]!, "utf8");
      for (const pin of exemption.pinnedTo) {
        assert.ok(
          src.includes(pin),
          `${key.split("::")[0]} no longer contains ${JSON.stringify(pin)}, ` +
            `which its exemption is pinned to. Re-justify it or remove it.\n` +
            `Reason on file: ${exemption.reason}`,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-1204 (P0.2) — the WORKERS tree
// ─────────────────────────────────────────────────────────────────────────────
//
// Every scan above walks a `packages/*` tree. None of them has ever looked at
// `workers/src/processors/`, which is where the jobs that actually fetch from
// the exchanges live — `report-archive-sync`, `macro-sync`, the announcement
// syncs, and `xbrl-sync`.
//
// The live instance that proves the gap is the one this ticket fixes:
// `xbrl-sync.ts` downloaded up to 1,500 XBRL filings a night from
// `nsearchives.nseindia.com` with a bare `fetch()`. Nothing failed. Prod
// archived none of them, QA had nothing to replay, and NSE prunes that host —
// so the bytes were simply gone. Exactly the MONEY-1157 shape (a feed the guard
// was cited as protecting, that it could not see) one directory over.
//
// ## Detection: FILE-level host, BLOCK-level call
//
// A hybrid of the two scans above, and the hybrid is the point.
//
// MONEY-1189 detects the host inside the BLOCK, because in `nse-filings.ts`
// every fetcher inlines `${NSE_BASE}/api/…`. That rule under-detects here:
// workers hoist their host to a module-level constant, and `xbrl-sync`'s
// pre-fix `fetchXml` block contained no host literal at all — the URL arrived
// as a parameter and the referer lived 100 lines up in `XML_HEADERS`. A
// block-scoped host test scores the real defect as clean.
//
// So the host is matched over the whole FILE (the MONEY-1157 rule, which
// deliberately over-triggers) while the call, the seam and the exclusions are
// judged per block (the MONEY-1189 rule, which is what makes a mixed file
// reportable instead of exempt-or-nothing).
//
// The host pattern is also the BROADER one — `\bNSE_BASE\b` alongside the
// literal hosts. Three workers name only the constant, and a list of literals
// is precisely the "accidentally complete" failure the MONEY-1157 header warns
// about.
//
// ## One predicate instead of five exemptions
//
// Five processors download announcement/annual-report PDFs straight from the
// exchanges. Those bytes ARE persisted — the document pipeline uploads them to
// GCS and records the path — they just do not belong in the feed archive, whose
// keys and payload shapes describe report FILES. `NSE_BINARY`
// (`arrayBuffer()`), reused from MONEY-1189, excuses all five on a property
// they genuinely share, rather than five hand-written entries that each decay
// independently.
//
// A blanket predicate needs its own positive-coverage list or it quietly starts
// excusing things nobody decided about — so `EXPECTED_BINARY_DOWNLOADERS` pins
// the exact set it may cover, and a sixth one fails the suite until somebody
// looks at it.

/** `workers/src/processors`, relative to packages/core (the test CWD). */
const WORKER_SCAN_ROOT = join("..", "..", "workers", "src", "processors");

/**
 * Upstream hosts, matched over the whole FILE.
 *
 * Broader than `FEED_HOSTS` on purpose: `\bNSE_BASE\b` catches the three
 * processors (`annual-reports-sync`, `stock-document-sync`,
 * `document-process`'s siblings) that never write the hostname down.
 *
 * ## MONEY-1405 — `amfiindia.com`, the host added to the wrong scan
 *
 * MONEY-1404 put `portal.amfiindia.com` and `www.amfiindia.com` in
 * {@link FEED_HOSTS}. That list is read by the scan at the top of this file,
 * whose `SCAN_ROOT` is `src` — `packages/core` ONLY. The raw `fetch()` at
 * AMFI's NAVAll feed is not there: it is in
 * `workers/src/processors/mf-portfolio-sync.ts`, which only THIS pattern
 * reaches. So the host was listed in the tree where the fetch is not, and left
 * out of the tree where it is, and the guard read green over a live bypass —
 * MONEY-1157's lesson ("a host nobody lists is a host nobody protects") a third
 * time, one tree over rather than one transport over.
 *
 * Written host-only (`amfiindia\.com`, no subdomain) because the portal and
 * the www door are the same feed: `www.amfiindia.com/spages/NAVAll.txt` 302s to
 * the portal and `fetch` follows redirects, so a caller pointed at either one
 * works and both must be seen.
 */
const WORKER_FEED_HOST =
  /\bNSE_BASE\b|nseindia\.com|bseindia\.com|rbi\.org\.in|api\.kite\.trade|amfiindia\.com/;

/** HTTP calls a processor can make. `ky` is the other client in this tree. */
const WORKER_HTTP: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "fetch()", re: /\bfetch\s*\(/ },
  { label: "fetchWithTimeout()", re: /\bfetchWithTimeout\s*\(/ },
  { label: "ky.get()", re: /\bky\s*\.\s*(?:get|post)\s*\(/ },
  // MONEY-1255 — see the identical note on NSE_HTTP. An injected client is
  // still an HTTP call; `deps.httpGet` matched none of the three idioms above
  // and silently removed two long-excused downloaders from this scan.
  { label: "injected httpGet()", re: /\bhttpGet\s*\(/ },
];

/**
 * The seams a worker may reach the network through.
 *
 * Three, because this tree legitimately has three: `getFeedAsset` for report
 * FILES, `archiveNseJsonResponse` for a raw NSE JSON body, and
 * `fetchNseApiJson` which wraps the second. None of them matches
 * {@link WORKER_HTTP}, so a block using only a seam is not detected at all —
 * this pattern is for the MIXED block that does both, which is the shape a
 * half-migrated fetcher has.
 */
const WORKER_SEAM =
  /\bgetFeedAsset\s*\(|\barchiveNseJsonResponse\s*\(|\bfetchNseApiJson\s*\(/;

interface WorkerHttpBlock {
  key: string;
  file: string;
  block: SourceBlock;
  call: string;
  /** Why it is not an offender, or null when it is one. */
  excusedBy: "seam" | "handshake" | "binary" | null;
}

/** Every HTTP-calling block in a worker file that names an upstream host. */
function workerHttpBlocks(file: string, src: string): WorkerHttpBlock[] {
  if (!WORKER_FEED_HOST.test(src)) return [];
  const out: WorkerHttpBlock[] = [];
  for (const block of sourceBlocks(src)) {
    const call = WORKER_HTTP.find(({ re }) => re.test(block.body))?.label;
    if (!call) continue;
    const excusedBy = WORKER_SEAM.test(block.body)
      ? "seam"
      : NSE_HANDSHAKE.test(block.body)
        ? "handshake"
        : NSE_BINARY.test(block.body)
          ? "binary"
          : null;
    out.push({ key: `${file}::${block.name}`, file, block, call, excusedBy });
  }
  return out;
}

const workerFile = (name: string): string => join(WORKER_SCAN_ROOT, name);

function workerSourceFiles(): string[] {
  return [...walk(WORKER_SCAN_ROOT)];
}

/**
 * The binary downloads `NSE_BINARY` is allowed to excuse.
 *
 * Exhaustive by assertion below, not by hope. FOUR fetch a PDF from an exchange
 * and hand it to the document pipeline, which stores it in GCS under its own
 * key — persisted, just not in `feeds/`.
 *
 * MONEY-1405 — the FIFTH file, `mf-portfolio-sync.ts::download`, does not, and
 * the difference is written down here rather than smoothed over: it pulls an
 * AMC's monthly portfolio workbook, parses it in memory and DISCARDS the bytes.
 * Nothing in that processor uploads to GCS. It became visible only when
 * `amfiindia.com` joined {@link WORKER_FEED_HOST} — the host match is
 * file-scoped, so the whole file entered the scan, not just the AMFI call — and
 * it is recorded as a member of this set instead of hidden by the blanket
 * predicate. It is NOT an endorsement: a SEBI-mandated monthly whole-house file
 * is the archivable shape, and archiving it is the open question this entry
 * exists to keep in view.
 */
const EXPECTED_BINARY_DOWNLOADERS: readonly string[] = [
  `${workerFile("annual-reports-sync.ts")}::storeAnnualReport`,
  // MONEY-1285 — RENAMED, not new. `archivePdf` now takes an injected download
  // seam so the sync's chain/budget/retry behaviour is testable; the raw
  // `fetch` moved into that seam's DEFAULT, which is still the same single BSE
  // attachment download and still stores the bytes itself. Set size unchanged
  // at five, which is the property this list is pinning.
  `${workerFile("bse-announcements-sync.ts")}::defaultDownloadAttachment`,
  `${workerFile("nse-announcements-sync.ts")}::downloadAttachment`,
  `${workerFile("stock-document-sync.ts")}::storeNSEFiling`,
  `${workerFile("stock-document-sync.ts")}::storeScreenerDoc`,
  // MONEY-1405 — the one member that stores nothing; see the note above.
  `${workerFile("mf-portfolio-sync.ts")}::download`,
];

/**
 * Worker fetchers that must route through the archive seam, and the seam call
 * each one keeps.
 *
 * The positive half. Without it, DELETING `fetchXml` would make the offender
 * scan pass — a guard that only checks for a bad shape goes green on no shape
 * at all, which is how the pre-MONEY-1157 scan was green for months.
 */
const EXPECTED_SEAMED_WORKER_FETCHERS: ReadonlyArray<{
  file: string;
  block: string;
  seam: RegExp;
}> = [
  {
    file: workerFile("xbrl-sync.ts"),
    block: "fetchXml",
    seam: /\bgetFeedAsset\s*\(/,
  },
  {
    file: workerFile("report-archive-sync.ts"),
    block: "archiveFamily",
    seam: /\bgetFeedAsset\s*\(/,
  },
];

interface WorkerExemption {
  reason: string;
  /**
   * How many {@link WORKER_HTTP} calls the exempted BLOCK makes.
   *
   * The same discipline as `HTTP_EXEMPTIONS.calls`, at block granularity
   * instead of file granularity: an exemption granted for one endpoint must not
   * silently cover a SECOND fetch added to the same function later. Without it
   * the exemption is a per-function amnesty rather than a per-call decision.
   */
  calls: number;
  pinnedTo: readonly string[];
}

/**
 * Worker blocks that reach an upstream host outside every seam, each a written
 * decision.
 *
 * It was EMPTY until MONEY-1405, and that emptiness was a RESULT for the hosts
 * the pattern then covered: every un-seamed fetch it could see was a binary
 * download, excused by a property they actually share (`arrayBuffer()`) rather
 * than by hand-written entries. Adding `amfiindia.com` to
 * {@link WORKER_FEED_HOST} added a host — and the tree's one un-seamed feed
 * read came with it. Rows here should stay rare enough to argue about.
 */
const WORKER_EXEMPTIONS: Record<string, WorkerExemption> = {
  [`${workerFile("mf-portfolio-sync.ts")}::fetchText`]: {
    reason:
      "MONEY-1401 — NARROWED. This entry used to cover AMFI's NAVAll being " +
      "fetched a SECOND time and un-archived; that is FIXED. " +
      "`buildSchemeIndexOrNull` now calls `fetchNavAllViaArchive`, which goes " +
      "through getFeedAsset under the SAME dated descriptor packages/core " +
      "uses (amfi-mf-provider.ts `fetchNavAllText`, " +
      "feeds/AMFI/navall/{YYYY}/{MM}/NAVAll-{IST date}.txt), so the two jobs " +
      "now address one archive key: prod records the bytes THIS job parsed " +
      "and QA replays them. " +
      "WHAT IS LEFT is `fetchText`'s OTHER caller, and it is a much weaker " +
      "claim: per-AMC landing PAGES (DSP, PPFAS, Tata, Zerodha, …) read by " +
      "`findMonthlyPortfolioLinks` and by `resolveCandidateUrls`' discovery " +
      "step. Those are navigation HTML and a JSON index — read to LOCATE a " +
      "file, never the file itself — so there is nothing in them worth " +
      "keeping a historical copy of, and the workbook they point at is a " +
      "different fetch (`download`, in EXPECTED_BINARY_DOWNLOADERS). " +
      "The entry survives rather than being deleted because the block " +
      "survives: `amfiindia.com` is still in this file (the NAVAll referer " +
      "and URL), the host match is FILE-scoped, and `fetchText` still makes " +
      "one raw call. Do NOT widen this to cover a new FEED fetched through " +
      "the same helper — that is the thing this entry was created for and " +
      "the thing that has just been removed from it.",
    calls: 1,
    pinnedTo: [
      // The landing-page role this exemption now covers...
      "const pageHtml = await fetchText(cfg.pageUrl, cfg.pageRequest);",
      // ...and proof the FEED read is no longer part of it. Reverting
      // `buildSchemeIndexOrNull` to a raw fetch breaks this pin and forces the
      // exemption to be re-argued rather than silently re-widened.
      "const text = await fetchNavAllViaArchive();",
    ],
  },
};

describe("worker processors fetch through the archive seam (MONEY-1204)", () => {
  it("the workers tree is actually reachable from here", () => {
    // FIRST, deliberately. A cross-package scan that silently walks nothing
    // makes every assertion below pass on an empty list — the failure mode that
    // matters most for a guard whose whole job is to notice an absence.
    const files = workerSourceFiles();
    assert.ok(
      files.length > 50,
      `expected to walk workers/src/processors from packages/core, found ` +
        `${files.length} file(s) under ${WORKER_SCAN_ROOT}`,
    );
    assert.ok(
      files.includes(workerFile("xbrl-sync.ts")),
      "xbrl-sync.ts is the file this scan was written for — if it moved, " +
        "retarget the scan rather than letting it pass on nothing",
    );
  });

  it("every un-seamed exchange fetch in a worker is a recorded decision", () => {
    const offenders: string[] = [];

    for (const file of workerSourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const hit of workerHttpBlocks(file, src)) {
        if (hit.excusedBy !== null) continue;
        if (WORKER_EXEMPTIONS[hit.key]) continue;
        offenders.push(
          `${hit.file}:${hit.block.line}  ${hit.block.name}()  [${hit.call}]`,
        );
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "these worker blocks fetch from an exchange host without the archive " +
        "seam. Call getFeedAsset() (report files) or fetchNseApiJson() / " +
        "archiveNseJsonResponse() (NSE JSON) — a raw fetch is invisible to the " +
        "archive, so prod archives nothing for that feed, QA has nothing to " +
        "replay, and the exchange prunes the only remaining copy. Nothing " +
        "fails while this happens. If the call genuinely is not archivable, " +
        "add it to WORKER_EXEMPTIONS with a written reason:\n" +
        offenders.join("\n"),
    );
  });

  it("NSE_BINARY excuses EXACTLY the known binary downloads", () => {
    // The blanket predicate's own guard. A new JSON reader that happens to call
    // arrayBuffer() would otherwise inherit the PDF downloaders' excuse in
    // silence — a hole that reads like coverage, which is the exact thing
    // HTTP_EXEMPTIONS' pinning discipline exists to prevent.
    const excused = workerSourceFiles()
      .flatMap((file) => workerHttpBlocks(file, readFileSync(file, "utf8")))
      .filter((h) => h.excusedBy === "binary")
      .map((h) => h.key)
      .sort();

    assert.deepEqual(
      excused,
      [...EXPECTED_BINARY_DOWNLOADERS].sort(),
      "the set of blocks excused as binary attachment downloads changed. A " +
        "NEW one is a decision: is it really a PDF/attachment the document " +
        "pipeline stores itself, or a feed that should ride getFeedAsset? A " +
        "MISSING one means the downloader was renamed or now archives — " +
        "update this list either way, do not leave it stale.",
    );
  });

  it("the fetchers it exists to cover still exist AND still use the seam", () => {
    for (const expected of EXPECTED_SEAMED_WORKER_FETCHERS) {
      const src = readFileSync(expected.file, "utf8");
      const block = sourceBlocks(src).find((b) => b.name === expected.block);
      assert.ok(
        block,
        `${expected.file} no longer declares ${expected.block}() — either it ` +
          `was renamed (update EXPECTED_SEAMED_WORKER_FETCHERS) or it was ` +
          `deleted. Do not leave this list stale: the offender scan above ` +
          `passes happily when a fetcher is simply gone.`,
      );
      assert.match(
        block.body,
        expected.seam,
        `${expected.file}::${expected.block} no longer routes through the ` +
          `archive seam`,
      );
      assert.ok(
        !WORKER_HTTP.some(({ re }) => re.test(block.body)),
        `${expected.file}::${expected.block} still makes a raw HTTP call ` +
          `beside the seam — the seam has to be the ONLY path, or the ` +
          `un-archived one is still live`,
      );
    }
  });

  it("the scan fires on the pre-fix xbrl-sync shape and not on the fixed one", () => {
    // Literally the MONEY-1204 defect and its fix, side by side, INCLUDING the
    // property that made it invisible: the host literal is in a module-level
    // constant, not in the fetching block.
    const preFix = [
      'const XML_HEADERS = { referer: "https://www.nseindia.com/x" };',
      "",
      "async function fetchXml(url: string): Promise<string | null> {",
      "  const resp = await fetch(url, { headers: XML_HEADERS });",
      "  if (!resp.ok) return null;",
      "  return resp.text();",
      "}",
    ].join("\n");

    const preFixHits = workerHttpBlocks("synthetic.ts", preFix).filter(
      (h) => h.excusedBy === null,
    );
    assert.equal(preFixHits.length, 1);
    assert.equal(preFixHits[0]!.block.name, "fetchXml");
    assert.equal(preFixHits[0]!.call, "fetch()");
    assert.equal(preFixHits[0]!.block.line, 3);

    const fixed = preFix.replace(
      "  const resp = await fetch(url, { headers: XML_HEADERS });",
      "  const resp = await getFeedAsset(url, REF, descriptor, undefined, o);",
    );
    assert.deepEqual(
      workerHttpBlocks("synthetic.ts", fixed).filter(
        (h) => h.excusedBy === null,
      ),
      [],
    );
  });

  it("a block-scoped host test would MISS it — why the host is file-scoped", () => {
    // Pins the design decision itself. If someone later "tidies" the host match
    // down to the block (matching MONEY-1189's rule), this fails and says why.
    const preFixBlockOnly = [
      "async function fetchXml(url: string): Promise<string | null> {",
      "  const resp = await fetch(url, { headers: XML_HEADERS });",
      "  return resp.text();",
      "}",
    ].join("\n");
    const block = sourceBlocks(preFixBlockOnly)[0]!;
    assert.ok(
      !WORKER_FEED_HOST.test(block.body),
      "the fetching block names no host — a block-scoped host test scores the " +
        "real MONEY-1204 defect as clean",
    );
    // File-scoped, with the constant present, it IS caught.
    assert.equal(
      workerHttpBlocks(
        "synthetic.ts",
        `const H = { referer: "https://www.nseindia.com/x" };\n${preFixBlockOnly}`,
      ).filter((h) => h.excusedBy === null).length,
      1,
    );
  });

  it("a handshake, a PDF download, a seamed call and prose are not offenders", () => {
    // The over-trigger side. A guard that flags the cookie warm-up and every
    // attachment download gets exemptions bolted on until it means nothing.
    const host = 'const B = "https://www.nseindia.com";\n';

    const handshake = `${host}async function getSession(): Promise<string> {
  const resp = await fetch(B, { redirect: 'manual' });
  return resp.headers.get('set-cookie') ?? '';
}`;
    assert.deepEqual(
      workerHttpBlocks("synthetic.ts", handshake).map((h) => h.excusedBy),
      ["handshake"],
    );

    const pdf = `${host}async function downloadAttachment(url: string) {
  const res = await fetch(url, { headers: {} });
  return Buffer.from(await res.arrayBuffer());
}`;
    assert.deepEqual(
      workerHttpBlocks("synthetic.ts", pdf).map((h) => h.excusedBy),
      ["binary"],
    );

    const seamed = `${host}async function readJson(path: string) {
  const text = await (await fetch(B + path)).text();
  await archiveNseJsonResponse(path, text);
  return JSON.parse(text);
}`;
    assert.deepEqual(
      workerHttpBlocks("synthetic.ts", seamed).map((h) => h.excusedBy),
      ["seam"],
    );

    const prose = `${host}// We used to fetch(B + '/api/x') here without archiving.
/* www.nseindia.com — see fetch() above */
export const NOTE = 1;`;
    assert.deepEqual(workerHttpBlocks("synthetic.ts", prose), []);
  });

  it("reported line numbers still point at the declaration", () => {
    // The offender message is a `file:line` people paste into an editor, and
    // these files are mostly comment by volume.
    for (const file of workerSourceFiles()) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (const { block } of workerHttpBlocks(file, src)) {
        if (block.name === "(module)") continue;
        assert.match(
          lines[block.line - 1] ?? "",
          new RegExp(`\\b${block.name}\\b`),
          `${file}: reported line ${block.line} for ${block.name} does not ` +
            `declare it`,
        );
      }
    }
  });

  it("every worker exemption still names a live, still-un-seamed block", () => {
    // Same discipline as HTTP_EXEMPTIONS. Vacuous while the table is empty,
    // which is the intended steady state — it exists so the FIRST entry is
    // policed on the day it is added.
    const byKey = new Map(
      workerSourceFiles().flatMap((file) =>
        workerHttpBlocks(file, readFileSync(file, "utf8")).map(
          (h) => [h.key, h] as const,
        ),
      ),
    );

    for (const [key, exemption] of Object.entries(WORKER_EXEMPTIONS)) {
      const hit = byKey.get(key);
      assert.ok(
        hit,
        `${key} no longer exists or no longer fetches — drop the exemption.\n` +
          `Reason on file: ${exemption.reason}`,
      );
      assert.equal(
        hit.excusedBy,
        null,
        `${key} is already excused as ${hit.excusedBy} — delete its ` +
          `exemption, it is claiming a gap that does not exist`,
      );
      const calls = WORKER_HTTP.reduce(
        (n, { re }) =>
          n + (hit.block.body.match(new RegExp(re.source, "g")) ?? []).length,
        0,
      );
      assert.equal(
        calls,
        exemption.calls,
        `${key} makes ${calls} un-seamed HTTP call(s) but its exemption ` +
          `claims ${exemption.calls}. A SECOND fetch added to an exempted ` +
          `block inherits a decision nobody made about it — route the new one ` +
          `through getFeedAsset, or re-argue the exemption and bump \`calls\`.` +
          `\nReason on file: ${exemption.reason}`,
      );
      const src = readFileSync(key.split("::")[0]!, "utf8");
      for (const pin of exemption.pinnedTo) {
        assert.ok(
          src.includes(pin),
          `${key.split("::")[0]} no longer contains ${JSON.stringify(pin)}, ` +
            `which its exemption is pinned to. Re-justify it or remove it.\n` +
            `Reason on file: ${exemption.reason}`,
        );
      }
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   MONEY-1309 — a WEBSOCKET is a feed connection too

   Every scan above looks for `fetch(`. That was complete while every upstream
   in this repo was HTTP, and it stopped being complete the moment a websocket
   arrived: `new WebSocket("wss://api.tiingo.com/equity/intraday")` opens a
   connection to a metered feed host and matches NONE of the patterns above.
   The guard would have kept passing while any file in any workspace held a
   socket open to a vendor we pay per request.

   Two rules, and the second is the one users feel:

     1. exactly ONE file may open a socket to a feed host
     2. NO request path may reach a feed host at all
   ────────────────────────────────────────────────────────────────────────── */

const WS_ALLOWLIST: Record<string, string> = {
  [join("..", "..", "workers", "src", "realtime", "tiingo-socket.ts")]:
    "MONEY-1309 — the single Tiingo realtime socket holder. One process, one " +
    "socket, guarded by a Redis leader lock. Everything else reads the quote " +
    "hash it writes.",
  [join("..", "..", "workers", "src", "connect", "ws", "zerodha-ws.ts")]:
    "MONEY-837 — the DORMANT Zerodha Connect ticker (wss://ws.kite.trade/). " +
    "The paid Connect app is a founder-only connector in apps/web; connecting " +
    "it stores an encrypted token and nothing else, and this class syncs no " +
    "data. It is allow-listed rather than deleted because the code is real and " +
    "a second holder of it would be the defect.",
  [join("..", "..", "scripts", "data", "capture-tiingo-rt-frames.ts")]:
    "MONEY-1309 — the ONE-OFF fixture capture that produced " +
    "__tests__/fixtures/tiingo-realtime/. It is run by hand with a real key to " +
    "re-derive the level-4/level-6 array layouts when the vendor changes them; " +
    "it is not imported by any runtime path, ships in no image, and is on no " +
    "schedule. Allow-listed WITH that reason rather than excluded by keeping " +
    "scripts/ outside the scan, because excluding the root would also hide the " +
    "next socket somebody adds there.",
};

/**
 * Roots that must never hold an unallowed websocket.
 *
 * MONEY-1309 — `scripts`, `apps/admin` and `apps/content` were outside this
 * list. `scripts/data/capture-tiingo-rt-frames.ts` is a real third
 * `new WebSocket(TIINGO_RT_WS_URL)` and the scan could not see it; admin and
 * content are 190 more files that could grow one silently. Every root is
 * asserted below to resolve files, individually — a total-only floor lets one
 * mistyped root hide behind three good ones.
 */
const WS_SCAN_ROOTS = [
  join("..", "..", "workers", "src"),
  join("..", "..", "apps", "web"),
  join("..", "..", "apps", "api", "src"),
  join("..", "..", "apps", "admin"),
  join("..", "..", "apps", "content"),
  join("..", "..", "packages"),
  join("..", "..", "scripts"),
];

/** Roots that must never mention a feed host AT ALL — the request paths. */
const REQUEST_PATH_ROOTS = [
  join("..", "..", "apps", "web"),
  join("..", "..", "apps", "api", "src"),
];

/**
 * What "reaching a feed host" looks like in a request path.
 *
 * Enumerated rather than inferred from the hostname, because a URL STRING is
 * not a request: a citation link, a `sourceUrl` column and a docs reference all
 * name a host legitimately. Only these open a connection.
 */
const REQUEST_SHAPES: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
  /\bky\s*[.(]/,
  /\baxios\s*[.(]/,
  /\bgot\s*[.(]/,
];

const WS_SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__tests__",
  "vendor",
  "fixtures",
]);

function tsSources(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (WS_SKIP.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...tsSources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/* ── the socket detector ────────────────────────────────────────────────────
   HOST-BLIND, and that is the whole fix.

   The first version of this rule required `new WebSocket(` AND a FEED_HOSTS
   literal IN THE SAME FILE after `stripComments`. Measured over the exact
   2,270 files the scan walks: 2 files construct a socket, 40 name a feed host,
   and the INTERSECTION IS EMPTY. `assert.deepEqual(offenders, [])` had never
   evaluated a single candidate.

   It could not have. `tiingo-socket.ts` does `new WebSocket(TIINGO_RT_WS_URL)`
   — it IMPORTS the constant, which is the house idiom and the right design; its
   only `api.tiingo.com` sits in its JSDoc header, which `stripComments` erases.
   Post-strip its host set is `[]`. The rule's own comment defended the AND on
   exactly that ground, so it documented the reason it could never fire.

   A socket construction is RARE — 3 in 2,459 files across every workspace — so
   the host coupling buys nothing and costs everything. The rule is now: ANY
   socket construction outside {@link WS_ALLOWLIST} is an offence, wherever it
   points. A new socket to anywhere is caught whether the host is inlined,
   imported, aliased or concatenated, and none of those four is a special case
   any more because the host is not consulted at all.

   WHAT THE DETECTION CAN SEE, honestly:

     - `new WebSocket(...)` — the global, and `import WebSocket from "ws"`.
     - `new WS(...)` after `import { WebSocket as WS } from "ws"`, or after a
       default/`require` binding under any other name. The local BINDING names
       are read out of the import statements, so an alias is resolved rather
       than guessed.
     - `new ws.WebSocket(...)` after `import * as ws from "ws"`.

   WHAT IT CANNOT SEE, and no comment makes safe:

     - a socket opened by a LIBRARY we call (socket.io's `io()`, a vendor SDK
       that dials out internally). Nothing in the source says "socket".
     - `new (await import("ws")).WebSocket(...)`, or a constructor fetched
       through a variable — `const C = WebSocket; new C(url)`.
     - `EventSource`. It is a real server-push transport and there is one live
       use, `TradingViewAdvancedChart.tsx:234`, but it points at OUR OWN
       `/api/market/udf/stream`, so folding it in here would put a same-origin
       SSE stream under a rule about metered vendors. The request-path rule
       below is where a browser reaching a VENDOR is caught, and `EventSource`
       is in its shapes.

   The allow-list is by PATH with a written reason, one entry per legitimate
   holder, which is the same discipline as HTTP_EXEMPTIONS above.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Modules that export a WebSocket constructor under the NAME `WebSocket`.
 *
 * `undici` is here for `import { WebSocket } from "undici"`, which is a real
 * spelling — but it also exports `Agent`, `Pool` and `fetch`, and the first
 * draft of this treated EVERY named binding from a listed module as a socket
 * constructor. That flagged `ssrf-guard.ts:474`'s `new Agent({…})`, an
 * un-related connection-pool option bag, which is how an over-triggering guard
 * earns itself an exemption list and then a deletion. Named bindings are
 * therefore matched on the IMPORTED name, not the module.
 */
const WS_MODULE =
  /^(?:ws|undici|isomorphic-ws|websocket|reconnecting-websocket|partysocket)(?:\/.*)?$/;

/**
 * Modules whose DEFAULT export is itself the constructor.
 *
 * A strict subset: `import WebSocket from "ws"` (which both live holders use)
 * and `import WS from "reconnecting-websocket"` bind a constructor, while
 * `undici`'s default is a namespace object and `new undici(…)` is not a thing.
 */
const WS_DEFAULT_MODULE =
  /^(?:ws|isomorphic-ws|reconnecting-websocket|partysocket)(?:\/.*)?$/;

/**
 * Local identifiers bound to a WebSocket constructor in this file.
 *
 * `WebSocket` is always in the set — it is the Node 22 / browser global, and
 * the most likely spelling of a new offender. Everything else is read off the
 * import statements, so `import { WebSocket as WS } from "ws"` yields `WS`.
 *
 * TYPE-only imports are skipped: `import type { WebSocket } from "ws"` (which
 * `connect/ws/base-ws.ts` does) binds nothing at runtime and cannot construct.
 */
function websocketBindings(src: string): {
  names: Set<string>;
  namespaces: Set<string>;
} {
  const names = new Set<string>(["WebSocket"]);
  const namespaces = new Set<string>();

  // `[^;]*?` for the clause, NOT `[\s\S]*?`: a side-effect `import "./x";`
  // carries no `from`, so a lazy any-character middle runs forward to the NEXT
  // `from "…"` and reads two statements as one — the same phantom-span bug the
  // comment stripper above is written to avoid, and it cost a real miss in the
  // sibling suite before it was caught by mutation.
  for (const m of src.matchAll(
    /import\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g,
  )) {
    const [, typeOnly, clause, mod] = m;
    if (typeOnly || !WS_MODULE.test(mod!)) continue;
    const c = clause!.trim();

    const star = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(c);
    if (star) {
      namespaces.add(star[1]!);
      continue;
    }
    // `WebSocket, { ... }` or just `WebSocket` — the default binding, under
    // whatever local name, but only from a module whose default IS one.
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(c);
    if (def && WS_DEFAULT_MODULE.test(mod!)) names.add(def[1]!);
    // `{ WebSocket as WS, Agent }` — the LOCAL name of the `WebSocket`
    // specifier only. `Agent` is not a socket and must not become one.
    const braces = /\{([\s\S]*)\}/.exec(c);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const spec = part.trim();
        if (!spec || /^type\s/.test(spec)) continue;
        const aliased = /^WebSocket\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
        if (aliased) names.add(aliased[1]!);
        else if (spec === "WebSocket") names.add("WebSocket");
      }
    }
  }

  // `const WebSocket = require("ws")` / `const { WebSocket } = require("undici")`.
  for (const m of src.matchAll(
    /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const [, binding, mod] = m;
    if (!WS_MODULE.test(mod!)) continue;
    if (binding!.startsWith("{")) {
      for (const part of binding!.slice(1, -1).split(",")) {
        const spec = part.trim();
        const renamed = /^WebSocket\s*:\s*([A-Za-z_$][\w$]*)$/.exec(spec);
        if (renamed) names.add(renamed[1]!);
        else if (spec === "WebSocket") names.add("WebSocket");
      }
    } else if (WS_DEFAULT_MODULE.test(mod!)) names.add(binding!);
  }

  return { names, namespaces };
}

/** Socket constructions in a file, as `file:line  new X(...)`. */
function socketConstructions(file: string, src: string): string[] {
  const stripped = stripComments(src);
  const { names, namespaces } = websocketBindings(stripped);
  const hits: string[] = [];
  stripped.split("\n").forEach((line, i) => {
    for (const name of names) {
      if (new RegExp(String.raw`\bnew\s+${name}\s*\(`).test(line)) {
        hits.push(`${file}:${i + 1}  ${line.trim()}`);
        return;
      }
    }
    for (const ns of namespaces) {
      // `new ws.WebSocket(` only — `new undici.Agent(` is not a socket, and a
      // wildcard member here is exactly the over-trigger that flagged it.
      if (
        new RegExp(String.raw`\bnew\s+${ns}\s*\.\s*WebSocket\s*\(`).test(line)
      ) {
        hits.push(`${file}:${i + 1}  ${line.trim()}`);
        return;
      }
    }
  });
  return hits;
}

/* ── the request-path detector ──────────────────────────────────────────────
   The sibling rule was empty for the SAME reason, measured the same way: of the
   1,225 files under apps/web + apps/api/src, 44 match a REQUEST_SHAPE and 2
   name a feed host (`CitationsRail.tsx` and `research-blocks.ts`, both
   citation links), and the intersection is `[]`.

   That one is NOT vacuous by construction, and the distinction matters: both
   sides have live members, so `fetch("https://api.tiingo.com/…")` pasted into a
   route IS caught today. What it misses is the house idiom — importing the URL
   constant — which is exactly the hole that made the socket rule unfireable.

   It cannot be made host-blind. `fetch(` appears in 44 request-path files, all
   of them legitimately calling our own routes, so "any request is an offence"
   would be pure noise and the guard would be deleted within a week.

   So the fix is one hop of TAINT instead: an exported SCREAMING_SNAKE constant
   whose value contains a feed host is host-bearing, and a request-path file
   that IMPORTS one is treated as naming the host. The set is DERIVED from
   source (22 constants today, e.g. `TIINGO_RT_SNAPSHOT_URL`, `NSE_BASE`,
   `BSE_SCRIP_MASTER_URL`), never hand-listed, so a new URL constant is covered
   the day it is written. Measured cost: ZERO request-path files import one
   today, so this adds coverage and no false positives.

   Still not caught, stated rather than implied: a host reached through a
   FUNCTION (`fetchTiingoEod(sym)`) names neither a host nor a constant. That
   shape is held one directory over, by
   `us-quote-read-no-vendor.test.ts`, which checks the module SPECIFIER of every
   cross-package import on the US read path.
   ────────────────────────────────────────────────────────────────────────── */

/** Roots searched for host-bearing constants. */
const CONST_TAINT_ROOTS = [
  join("..", "..", "packages"),
  join("..", "..", "workers", "src"),
];

/**
 * Exported constants whose VALUE names a feed host, derived from source.
 *
 * SCREAMING_SNAKE only — that is the convention every URL/referer constant in
 * this repo follows, and it keeps the window small enough that the initializer
 * scan below stays honest.
 */
function hostBearingConstants(): Map<
  string,
  { file: string; hosts: string[] }
> {
  const out = new Map<string, { file: string; hosts: string[] }>();
  for (const file of CONST_TAINT_ROOTS.flatMap((r) => tsSources(r))) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/\bexport\s+const\s+([A-Z][A-Z0-9_]*)\b/g)) {
      // The initializer window: from the declaration to the next top-level
      // `export`, capped, so a big object literal is covered without the scan
      // running away into the rest of the file.
      const start = m.index! + m[0].length;
      const nextExport = src.indexOf("\nexport ", start);
      const end = Math.min(
        nextExport === -1 ? src.length : nextExport,
        start + 4000,
      );
      const init = src.slice(start, end);
      const hosts = FEED_HOSTS.filter((h) => init.includes(h));
      if (hosts.length > 0) out.set(m[1]!, { file, hosts });
    }
  }
  return out;
}

const HOST_BEARING_CONSTANTS = hostBearingConstants();

/** Feed hosts a request-path file reaches, directly or through one import. */
function requestPathHosts(src: string): string[] {
  const stripped = stripComments(src);
  if (!REQUEST_SHAPES.some((re) => re.test(stripped))) return [];
  const hosts = new Set(FEED_HOSTS.filter((h) => stripped.includes(h)));
  for (const [name, { hosts: viaHosts }] of HOST_BEARING_CONSTANTS) {
    // An IMPORT of the constant, not a mention: a local variable that happens
    // to share the name is not a connection to anything.
    if (
      new RegExp(String.raw`import[^;]*\b${name}\b[^;]*from`, "s").test(
        stripped,
      )
    ) {
      for (const h of viaHosts) hosts.add(h);
    }
  }
  return [...hosts];
}

describe("no websocket outside an allow-listed holder (MONEY-1309)", () => {
  const files = WS_SCAN_ROOTS.flatMap((r) => tsSources(r));

  it("PREMISE: every root resolves files, and the holders are visible", () => {
    // Without this every assertion below passes over an empty list — the
    // vacuous-guard shape this file exists to prevent, and which it has been
    // caught by before.
    //
    // PER ROOT, not just the total: a mistyped root returns `[]` from
    // `tsSources` (readdirSync throws, it is swallowed) and hides behind the
    // three that still work. Retargeting `apps/web` to `apps/wob` would have
    // left the old total-only floor green.
    for (const root of WS_SCAN_ROOTS) {
      assert.ok(
        tsSources(root).length > 0,
        `WS_SCAN_ROOTS entry ${root} resolved no files — the tree moved, or ` +
          `the path is wrong. A root that walks nothing is a hole that reads ` +
          `like coverage.`,
      );
    }
    assert.ok(files.length > 500, `scan found only ${files.length} files`);

    for (const allowed of Object.keys(WS_ALLOWLIST)) {
      assert.ok(
        files.includes(allowed),
        `${allowed} is allow-listed but the scan cannot see it — retarget the ` +
          "roots, or the allow-list is protecting a file that no longer exists",
      );
      // CEILING for the detector itself, against real code rather than a
      // synthetic string: an allow-listed file is allow-listed BECAUSE it opens
      // a socket, so if the detector stopped matching, this fails here instead
      // of the whole rule quietly passing on zero candidates.
      assert.ok(
        socketConstructions(allowed, readFileSync(allowed, "utf8")).length > 0,
        `${allowed} is allow-listed as a socket holder but the detector finds ` +
          `no construction in it — either it stopped holding a socket (drop ` +
          `the entry) or the detector stopped seeing one (fix it, the rule is ` +
          `blind right now)`,
      );
    }
  });

  it("only an allow-listed holder opens a socket", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file in WS_ALLOWLIST) continue;
      for (const hit of socketConstructions(file, readFileSync(file, "utf8"))) {
        offenders.push(hit);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a websocket opened outside the allow-listed holders:\n  " +
        offenders.join("\n  ") +
        "\nOne process, one socket. A vendor feed is metered and a second " +
        "holder doubles the spend silently; add to WS_ALLOWLIST only with a " +
        "written reason.",
    );
  });

  it("the scan actually fires — four synthetic sockets are caught", () => {
    // The four spellings the host-coupled version let through, all of which
    // this rule catches because it never looks at the host.
    const inlined = [
      "const s = new WebSocket('wss://api.tiingo.com/equity/intraday');",
    ].join("\n");
    assert.equal(socketConstructions("synthetic.ts", inlined).length, 1);
    assert.match(
      socketConstructions("synthetic.ts", inlined)[0]!,
      /^synthetic\.ts:1 {2}/,
    );

    const imported = [
      "import { TIINGO_RT_WS_URL } from '@usemoney/core/market-data/tiingo/tiingo-realtime-logic';",
      "const s = new WebSocket(TIINGO_RT_WS_URL);",
    ].join("\n");
    const importedHits = socketConstructions("synthetic.ts", imported);
    assert.equal(importedHits.length, 1);
    assert.match(importedHits[0]!, /^synthetic\.ts:2 {2}/);

    const aliased = [
      "import { WebSocket as WS } from 'ws';",
      "const s = new WS(url);",
    ].join("\n");
    assert.equal(socketConstructions("synthetic.ts", aliased).length, 1);

    const concatenated = [
      "const s = new WebSocket('wss://api.' + 'tiingo.com/equity/intraday');",
    ].join("\n");
    assert.equal(socketConstructions("synthetic.ts", concatenated).length, 1);

    // And the namespace form, which is the other way `ws` gets imported.
    const namespaced = [
      "import * as ws from 'ws';",
      "const s = new ws.WebSocket(url);",
    ].join("\n");
    assert.equal(socketConstructions("synthetic.ts", namespaced).length, 1);
  });

  it("the scan does not fire on a mention, a type import or prose", () => {
    // The over-trigger side. A guard that flags `WebSocket.OPEN` and every
    // type import gets exemptions bolted on until it means nothing.
    const readyState = [
      "import type { WebSocket } from 'ws';",
      "if (this.ws && this.ws.readyState === WebSocket.OPEN) return;",
      "const url = 'wss://api.tiingo.com/equity/intraday';",
    ].join("\n");
    assert.deepEqual(socketConstructions("synthetic.ts", readyState), []);

    const prose = [
      "// We used to open a new WebSocket('wss://api.tiingo.com/x') here.",
      "/* new WebSocket( */",
      "export const NOTE = 1;",
    ].join("\n");
    assert.deepEqual(socketConstructions("synthetic.ts", prose), []);

    // The live false positive this rule was first written with: `undici`
    // exports `WebSocket`, but it also exports `Agent`, and `ssrf-guard.ts`
    // constructs one.
    const undiciAgent = [
      "import { Agent, fetch as undiciFetch } from 'undici';",
      "return new Agent({ connect: { lookup } });",
    ].join("\n");
    assert.deepEqual(socketConstructions("synthetic.ts", undiciAgent), []);

    // ...while the socket export of the SAME module is still caught.
    const undiciSocket = [
      "import { WebSocket } from 'undici';",
      "const s = new WebSocket(url);",
    ].join("\n");
    assert.equal(socketConstructions("synthetic.ts", undiciSocket).length, 1);

    // A live example: base-ws.ts declares the type and constructs nothing.
    const baseWs = join(
      "..",
      "..",
      "workers",
      "src",
      "connect",
      "ws",
      "base-ws.ts",
    );
    assert.deepEqual(
      socketConstructions(baseWs, readFileSync(baseWs, "utf8")),
      [],
    );
  });

  it("a NON_CORE_FEED_HOST still matches SOMETHING, and says where", () => {
    // The counterpart to the staleness check in the MONEY-1157 suite, which
    // reads `packages/core/src` only. An entry excused there must still be
    // present HERE, or it is stale and is weakening every scan that iterates
    // FEED_HOSTS while looking like coverage.
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const missing = Object.keys(NON_CORE_FEED_HOSTS).filter(
      (h) => !all.includes(h),
    );
    assert.deepEqual(
      missing,
      [],
      `NON_CORE_FEED_HOSTS names a host that appears nowhere in the scanned ` +
        `workspaces: ${missing.join(", ")}. Drop the entry, or point it at ` +
        `the tree that now calls it.`,
    );
    for (const [host, why] of Object.entries(NON_CORE_FEED_HOSTS)) {
      assert.ok(
        why.length > 40,
        `${host} needs a written reason, not a placeholder — an exemption ` +
          `list without them rots into an allowlist`,
      );
    }
  });

  it("NO request path reaches a feed host — zero vendor calls serving a user", () => {
    // The property the whole read path is built around: a page load must never
    // become a vendor request. It reads the Redis quote hash the holder writes,
    // and falls back to a stored EOD close. Anything else spends a metered
    // request per viewer and puts a vendor's latency in front of a user.
    //
    // A CONNECTION, not a mention. A feed host appearing as a citation href is
    // legitimate and common — `research-blocks.ts` renders an NSE link and
    // `CitationsRail.tsx` links a corporate-filings page, and forbidding that
    // would be forbidding a hyperlink. The first draft of this rule did exactly
    // that, which is why the shapes are enumerated rather than the hostname
    // alone being treated as guilt.
    const offenders: string[] = [];
    for (const file of REQUEST_PATH_ROOTS.flatMap((r) => tsSources(r))) {
      for (const host of requestPathHosts(readFileSync(file, "utf8"))) {
        offenders.push(`${file} -> ${host}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a request path reaches a feed host:\n  " + offenders.join("\n  "),
    );
  });

  it("PREMISE: the request-path scan reaches a real tree", () => {
    // A6 — this array had NO floor at all. Retargeting REQUEST_PATH_ROOTS to a
    // nonexistent directory left the rule above green, because `tsSources`
    // swallows the `readdirSync` failure and the assertion is an ABSENCE. The
    // WS premise pinned a DIFFERENT array, which is exactly how it read as
    // covered.
    for (const root of REQUEST_PATH_ROOTS) {
      assert.ok(
        tsSources(root).length > 0,
        `REQUEST_PATH_ROOTS entry ${root} resolved no files`,
      );
    }
    const rp = REQUEST_PATH_ROOTS.flatMap((r) => tsSources(r));
    assert.ok(
      rp.length > 800,
      `request-path scan found only ${rp.length} files`,
    );
    // And both halves of the AND have live members, so the intersection being
    // empty is a measured fact about the tree rather than a scan that stopped
    // matching.
    const shaped = rp.filter((f) =>
      REQUEST_SHAPES.some((re) =>
        re.test(stripComments(readFileSync(f, "utf8"))),
      ),
    );
    assert.ok(
      shaped.length > 10,
      `only ${shaped.length} request-path files match any REQUEST_SHAPE — the ` +
        `shapes stopped matching, so the rule can no longer fire`,
    );
  });

  it("host-bearing constants are derived, not empty", () => {
    // The taint set is the half of the request-path rule that closes the
    // import-the-constant hole. Derived from source, so it cannot rot — but an
    // empty set would silently restore the hole, so it gets a floor and two
    // pins.
    assert.ok(
      HOST_BEARING_CONSTANTS.size > 10,
      `derived only ${HOST_BEARING_CONSTANTS.size} host-bearing constants — ` +
        `the derivation stopped matching`,
    );
    assert.ok(
      HOST_BEARING_CONSTANTS.has("TIINGO_RT_WS_URL"),
      "TIINGO_RT_WS_URL is the constant the socket holder imports — if the " +
        "derivation cannot see it, it cannot see any of them",
    );
    assert.ok(
      HOST_BEARING_CONSTANTS.has("NSE_REFERER"),
      "NSE_REFERER is exported from exchange-feed.ts and names www.nseindia.com",
    );
  });

  it("the request-path scan fires on an inlined host AND on an imported constant", () => {
    // Both halves, because the second is the one that was missing: a route that
    // imports the URL constant names no host at all, which is precisely how the
    // socket rule came to be unfireable.
    const inlined = [
      "const r = await fetch('https://api.tiingo.com/tiingo/daily/AAPL/prices');",
    ].join("\n");
    assert.deepEqual(requestPathHosts(inlined), ["api.tiingo.com"]);

    const viaConstant = [
      "import { TIINGO_RT_SNAPSHOT_URL } from '@usemoney/core/market-data/tiingo/tiingo-realtime-logic';",
      "const r = await fetch(`${TIINGO_RT_SNAPSHOT_URL}?tickers=AAPL`);",
    ].join("\n");
    assert.deepEqual(requestPathHosts(viaConstant), ["api.tiingo.com"]);

    // The over-trigger side: a citation link, and a constant merely NAMED.
    const citation = [
      "export const SOURCE = 'https://www.nseindia.com/companies-listing';",
      "export function Rail() { return <a href={SOURCE}>NSE</a>; }",
    ].join("\n");
    assert.deepEqual(requestPathHosts(citation), []);

    const localName = [
      "const NSE_REFERER = 'internal';",
      "const r = await fetch('/api/market/quote');",
    ].join("\n");
    assert.deepEqual(requestPathHosts(localName), []);
  });
});
