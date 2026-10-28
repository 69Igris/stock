/**
 * `/udf/symbols` and `/udf/search` — MONEY-1476.
 *
 * These shipped as 501 stubs and `routes.test.ts` ASSERTED that as the
 * contract. When `MARKET_DATA_TILES` went true on prod every chart read
 * "Symbol Error · invalid symbol", because TradingView's `resolveSymbol` runs
 * BEFORE any bar request.
 *
 * ## THE PROPERTY THESE TESTS EXIST FOR
 *
 * `/udf/symbols` must resolve EXACTLY what `/udf/history` can serve. The first
 * implementation parsed the symbol itself and the two disagreed in BOTH
 * directions — measured against prod:
 *
 *   resolved, then REFUSED by history:
 *     NSE:NIFTY 50  -> history leaked the tile store's internal regex message
 *                      into the user's chart. The 501 had hidden that.
 *     MF:120503     -> "unrecognised symbol"
 *     NSE:NIFTYBEES -> resolves, then blanks forever (not tiled)
 *
 *   REFUSED, but served by history:
 *     nse:reliance           -> the prefix was never uppercased
 *
 * US listings RESOLVE now, behind the licence claim (MONEY-1478). MONEY-1476
 * refused them by name on two stated preconditions — US tiles existing, and
 * `/udf/history` gating the licence — and BOTH are now met and were measured:
 * `gs://stockbook-lake-prod/tiles/US/d1/` holds 13,978 listing prefixes
 * (AAPL:NASDAQ:1980-12-12 among them), and the history gate ships in the same
 * branch as this lift.
 *
 * Both endpoints call `resolveListing` now, so they agree by CONSTRUCTION
 * rather than by review. Every case below runs with NO DATABASE — the shape
 * refusals and the US lane return before any query — because a mock of the row
 * this code reads would only assert the mock. The DB-backed paths are verified
 * against PROD by `market-data-smoke.sh`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bearer, TEST_SECRET } from "./helpers/mint";

process.env.MARKET_DATA_TOKEN_SECRET = TEST_SECRET;

import app from "../src/app";
import { resolveListing } from "../src/routes/history";
import { canBuildTileKey } from "@usemoney/core/market-data/tiles/tile-logic";

import { escapeRegex, isChartable } from "../src/routes/symbols";

test("a 501 is never the answer — that was the outage", async () => {
  for (const path of [
    "/udf/symbols?symbol=NSE:RELIANCE",
    "/udf/search?query=RELIANCE",
  ]) {
    const res = await app.request(path);
    assert.notEqual(res.status, 501, `${path} must not be 501`);
  }
});

test("a US listing is REFUSED without the `us` licence claim", async () => {
  // Tiingo COMMERCIAL is INTERNAL USE ONLY: ingest and storage are fine,
  // SERVING a US price is redistribution and needs the $250/mo plan
  // (MONEY-1262). `US_MARKET_ALLOWED_EMAILS` defaults to the founder alone and
  // the claim is stamped at MINT time by `currentUserMaySeeUsMarket` — it is a
  // LICENCE, never derived from a plan tier.
  //
  // ANONYMOUS is the default caller here: `/udf/symbols` takes no token for
  // India, so "no Authorization header at all" is the shape this must refuse.
  const res = await app.request("/udf/symbols?symbol=AAPL:NASDAQ:1980-12-12");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg ?? "", /not available on this account/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a token WITHOUT the `us` claim is refused just like an anonymous one", async () => {
  // A token is not a licence. `intraday` is a DIFFERENT entitlement, and the
  // two were briefly one field — so this pins that holding any valid token
  // does not reach US.
  const res = await app.request("/udf/symbols?symbol=AAPL:NASDAQ:1980-12-12", {
    headers: bearer({ intraday: true }),
  });
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg ?? "", /not available on this account/);
});

test("a token WITH the `us` claim PASSES the licence gate", async () => {
  // The other polarity: a gate that refuses everything is not a gate, and the
  // point of this ticket is that the licensed lane became REACHABLE.
  //
  // It asserts the gate, not the resolved payload, because there is NO DATABASE
  // here and a US listing needs a `us_instruments` row — the same shape
  // `history.test.ts` uses for this exact gate. What it pins is that the
  // refusal it gets is no longer the LICENCE one: past the gate, the next
  // failure is "unknown symbol", which is a different sentence. Asserting a
  // mocked row would only assert the mock; the resolved payload is verified
  // against PROD by `market-data-smoke.sh`.
  const res = await app.request("/udf/symbols?symbol=AAPL:NASDAQ:1980-12-12", {
    headers: bearer({ us: true }),
  });
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.doesNotMatch(
    body.errmsg ?? "",
    /not available on this account/,
    "a caller holding the licence claim must not be refused for the licence",
  );
});

test("the two endpoints refuse US with the SAME sentence", async () => {
  // THE DEFECT THIS FAMILY KEEPS PRODUCING is two endpoints disagreeing about
  // one symbol. Two different spellings of one refusal read as two different
  // faults to whoever is debugging it, which is how MONEY-1476 was diagnosed
  // as a chart bug for hours. Asserted across the FILES, so a later edit to
  // either message fails here rather than in production.
  const dir = dirname(new URL(import.meta.url).pathname);
  const src = (f: string) =>
    readFileSync(join(dir, "..", "src", "routes", f), "utf8");
  const NEEDLE = "US market data is not available on this account";
  for (const f of ["symbols.ts", "history.ts"]) {
    assert.ok(
      src(f).includes(NEEDLE),
      `${f} must refuse US with the shared sentence`,
    );
  }
});

test("the resolver and the KEY BUILDER agree — asked, never re-derived", async () => {
  // THE LEAK THIS CLOSED: `resolveListing` accepts any 2-part symbol, so
  // `NSE:NIFTY 50` yielded listing id "NIFTY 50:NSE", which `tileKey5y`
  // REJECTED for the space by THROWING — and `/udf/history` returns
  // `err.message`, so the tile store's internal note about GCS prefixes was
  // rendered INSIDE THE USER'S CHART.
  //
  // MONEY-1479 then FOLDED the space to an underscore in the key, because the
  // same shape is the real name of two exchanges: 284 of 14,258 US listings
  // are `NYSE ARCA` (244) or `NYSE MKT` (40). So a space no longer refuses —
  // it is charted under `NIFTY_50:NSE`.
  //
  // What matters here is not WHICH answer, but that both sides give the SAME
  // one. The resolver asks `canBuildTileKey` rather than re-deriving a rule.
  assert.equal(canBuildTileKey("NIFTY 50:NSE"), true, "folded, not refused");
  assert.equal(canBuildTileKey("ESSC:NYSE ARCA:2025-09-30"), true);
  // Still refused: a separator would move the object outside its prefix, and
  // `bucketForPrefix` only inspects the first segment.
  assert.equal(canBuildTileKey("A/B:NSE"), false);
  assert.equal(canBuildTileKey("..:NSE"), false, "traversal, not just charset");

  // And the route agrees with the predicate, in both directions.
  const ok = await app.request("/udf/symbols?symbol=NSE:NIFTY%2050");
  const body = (await ok.json()) as { s?: string; errmsg?: string };
  // No DB here, so it cannot resolve — but it must NOT be refused for the KEY.
  assert.doesNotMatch(body.errmsg ?? "", /cannot be charted/);
});

test("a BARE symbol means NSE, matching apps/web", async () => {
  // `parseSymbolPrefix` defaults a missing prefix to NSE, so apps/web resolves
  // `?symbol=RELIANCE`. `resolveListing` requires an explicit exchange, so
  // without a default the two origins disagree about a symbol form. Latent —
  // `combineSymbol` always prefixes — but a divergence nothing sends today is
  // still one waiting for the first caller that does.
  //
  // Asserted on the source: proving the DEFAULT applies needs a database, but
  // proving the qualification happens before `resolveListing` does not.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  assert.match(
    src,
    /symbolParam\.includes\(":"\)\s*\?\s*symbolParam\s*:\s*`NSE:\$\{symbolParam\}`/,
  );
  assert.match(
    src,
    /resolveListing\(qualified\)/,
    "the default must be applied first",
  );
});

test("a symbol shape history cannot serve is refused BEFORE any query", async () => {
  // Refusing here is the point: resolving something history then refuses is
  // how the tile store's internal message reached a user's chart.
  for (const symbol of ["A:B:C:D", "XSE:FOO"]) {
    const res = await app.request(
      `/udf/symbols?symbol=${encodeURIComponent(symbol)}`,
    );
    assert.equal(res.status, 200, symbol);
    const body = (await res.json()) as { s?: string; errmsg?: string };
    assert.equal(body.s, "error", symbol);
    assert.match(body.errmsg ?? "", /unsupported symbol/, symbol);
  }
});

test("every refusal is a 200 UDF error shape, and is NOT cacheable", async () => {
  // The widget DISPLAYS `{s:"error", errmsg}` and HANGS on a throw or a
  // non-200. A 501 is what rendered as an unexplained "invalid symbol"; a
  // CACHED refusal would outlive the fix.
  const res = await app.request("/udf/symbols");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { s?: string; errmsg?: string };
  assert.equal(body.s, "error");
  assert.match(body.errmsg ?? "", /symbol parameter is required/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("search returns an ARRAY, never an error shape", async () => {
  // `[]` renders as "no results"; an error shape renders as nothing at all.
  const res = await app.request("/udf/search?query=");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("a regex metacharacter in the query cannot reach Mongo unescaped", async () => {
  // MEASURED: `?query=(` threw MongoDB error 51111 ("missing closing
  // parenthesis") on the FIRST query, and the catch turned it into `200 []` —
  // a user typing an open bracket silently got "no results". `[` and a
  // trailing backslash did the same.
  //
  // With no DATABASE_URL this still exercises the escape: an unescaped `(`
  // fails while building the query, an escaped one fails at connect. Either
  // way the response must be the array shape, never an error body.
  for (const q of ["(", "[", "a\\"]) {
    const res = await app.request(`/udf/search?query=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, q);
    assert.ok(Array.isArray(await res.json()), `${q} must yield an array`);
  }
});

test("only types the tile builder writes are chartable", () => {
  // `scripts/jobs/tile-build-d1.ts:220` selects `instrumentType: "EQUITY"`.
  // Anything else resolves to a symbol with no bars, and `{s:"no_data"}`
  // renders as a BLANK CHART WITH NO MESSAGE — indistinguishable from a
  // delisted instrument. Measured scale: ~541 active ETFs, 6,172 NSE DEBT rows.
  assert.equal(isChartable("EQUITY"), true);
  assert.equal(isChartable("equity"), true, "case must not decide it");
  for (const t of ["ETF", "DEBT", "REIT", "INVIT", "INDEX", "MF"]) {
    assert.equal(isChartable(t), false, `${t} has no tiles`);
  }
});

test("a regex metacharacter is escaped before it reaches Mongo", () => {
  // `contains`/`startsWith` compile to `$regex`, so the user string arrives as
  // a PATTERN. MEASURED: `(` threw MongoDB error 51111 on the first query and
  // the catch turned it into `200 []` — typing an open bracket silently gave
  // "no results".
  assert.equal(escapeRegex("("), "\\(");
  assert.equal(escapeRegex("["), "\\[");
  assert.equal(escapeRegex("a\\"), "a\\\\");
  assert.equal(escapeRegex("RELIANCE"), "RELIANCE", "plain text is untouched");
  // Every metacharacter, so a future edit cannot drop one quietly.
  for (const ch of ".*+?^${}()|[]\\") {
    assert.match(escapeRegex(ch), /^\\/, `${ch} must be escaped`);
  }
});

test("the two endpoints share ONE notion of a valid symbol", async () => {
  // The structural guarantee. Asserted on the source because the agreement is
  // the IMPORT: a second parser here is what let the two disagree, and a
  // behavioural test would need a database to show it.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  assert.match(
    src,
    /import \{ resolveListing \} from "\.\/history"/,
    "symbols must ask history's own resolver, not re-derive one",
  );
  // STRIPPED, because this assertion is an ABSENCE and the file's own comments
  // NAME the parser they replaced. A raw scan fails on the prose explaining the
  // fix — the third time in this session a source scan read a comment as a call.
  //
  // LINE comments first, then BLOCK (MONEY-1143): block-first lets a `//`
  // containing an open-block marker swallow every line to the next close, and an
  // eaten file makes every `doesNotMatch` pass vacuously.
  const code = src
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    code,
    /parseSymbolPrefix|isUnsupportedEquityExchange/,
    "a second symbol parser is exactly what let the endpoints disagree",
  );
  // The stripper must not have eaten the file out from under the assertion.
  assert.match(code, /resolveListing\(qualified\)/, "stripper ate the code");
  // Only what `tile-build-d1` writes tiles for may resolve, and the query
  // string must be escaped before it becomes a Mongo `$regex`.
  assert.match(src, /if \(!isChartable\(type\)\)/);
  assert.match(src, /const query = escapeRegex\(raw\)/);
});

test("both handlers LOG before degrading", async () => {
  // A bare catch made an Atlas failover indistinguishable from "unknown
  // symbol": every chart invalid, every search empty, zero log lines, no
  // non-2xx — a service that reads healthy on every dashboard.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(src, /\}\s*catch\s*\{/, "no bare catch may remain");
  assert.equal(
    (src.match(/console\.error\(/g) ?? []).length,
    2,
    "both handlers must log",
  );
});

// ── MONEY-1478: parity with apps/web ───────────────────────────────────────

test("a MUTUAL FUND resolves — the service had no fund path at all", () => {
  // `resolveListing` is a discriminated union now: a fund is NOT a TileMarket
  // (no exchange, no tile, no intraday), and keeping it in the SAME resolver is
  // the point — the two endpoints disagreeing about what exists is the defect
  // MONEY-1476 was spent closing.
  const fund = resolveListing("MF:120503");
  assert.equal(fund?.kind, "fund");
  assert.equal(fund?.kind === "fund" ? fund.schemeCode : null, "120503");

  const equity = resolveListing("NSE:RELIANCE");
  assert.equal(equity?.kind, "tile");

  // An empty scheme code is not a fund.
  assert.equal(resolveListing("MF:"), null);
});

test("the search honours type and exchange — the tabs were ignored", () => {
  // The bundled datafeed always sends them. `computeExchangeFilters` returns
  // the SAME flag for "NSE" and "BSE" (it only separates equities from funds),
  // so the narrowing is done in the query — measured: `exchange=NSE` had been
  // returning BSE:RELIANCE first.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  assert.match(src, /computeTypeFilters\(typeFilter\)/);
  assert.match(src, /wantedExchange \? \{ exchange: wantedExchange \}/);
  assert.match(src, /buildMfResultItem/, "funds must be searchable");
  assert.match(src, /isNumericCode\(raw\)/, "a numeric query is a scheme code");
});

test("a RENAMED ticker still resolves, to its CURRENT name", () => {
  // MONEY-1177 regressed: `findUnique` on symbol_exchange alone means ZOMATO
  // (now ETERNAL) and TATAMOTORS (now TMCV/TMPV) resolve NOWHERE — a saved
  // chart or an old link gets "unknown symbol" for a company that exists.
  // Verified against prod: NSE:ZOMATO -> ticker NSE:ETERNAL.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  // BOTH sites, counted. A single `assert.match` found the SEARCH query's use
  // and passed while the resolver's fallback was deleted — a first-match
  // locator proving the wrong occurrence.
  //
  // The two sites take DIFFERENT needles, and that is the point rather than an
  // inconsistency: `has` is array-element EQUALITY, so the resolver passes the
  // unescaped listing-id half (`upper`) and the SEARCH leg passes the raw query
  // uppercased (`upperLiteral`) — never the regex-escaped `upperRe`, which
  // could only ever match a previous symbol that literally contained a
  // backslash. Matching either spelling keeps the count honest while pinning
  // that neither site regressed to the escaped value.
  const uses = (
    src.match(/previousSymbols: \{ has: (?:upper|upperLiteral) \}/g) ?? []
  ).length;
  assert.equal(
    uses,
    2,
    "both /udf/symbols' rename fallback AND /udf/search must use it",
  );
  assert.doesNotMatch(
    src,
    /previousSymbols: \{ has: upperRe \}/,
    "a regex-ESCAPED needle in an equality match can never hit: searching " +
      "BRK.B would look for the literal BRK\\.B",
  );
  // And specifically the resolver's fallback, which is the one a saved chart
  // or an old link depends on.
  assert.match(
    src,
    /findFirst\(\{[\s\S]*?previousSymbols: \{ has: upper \}/,
    "the /udf/symbols fallback must query previousSymbols",
  );
  // It must resolve to the ROW's symbol, not the query's, or the widget
  // requests bars under a name that has no tiles.
  assert.match(src, /symbol: instrument\.symbol/);
});

test("the unindexed name scan is GONE", () => {
  // `name: { contains, mode: "insensitive" }` is unindexable — schema.prisma
  // records that insensitive mode "cannot take tight prefix bounds" — so every
  // miss scanned ~24k active rows PER KEYSTROKE, ANONYMOUSLY, on a service
  // built to take a Mongo read OFF the chart path.
  const src = readFileSync(
    join(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "src",
      "routes",
      "symbols.ts",
    ),
    "utf8",
  );
  const code = src
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    code,
    /name: \{ contains/,
    "no unindexed equity name scan",
  );
  assert.match(code, /startsWith: upper/, "ticker prefix is indexed");
});
