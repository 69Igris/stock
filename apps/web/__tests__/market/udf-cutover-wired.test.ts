/**
 * The A3 cutover must actually be WIRED — MONEY-1468.
 *
 * This exists because the first version of that change shipped the resolver,
 * the prop and the flag, and connected NONE of them: `getUdfBaseUrl` had zero
 * callers and `udfBaseUrl` was never passed, so flipping `MARKET_DATA_TILES` in
 * prod changed nothing — while `TODO.md` had already started the 14-day clock
 * for deleting the fallback routes the flag was silently still using.
 *
 * Nothing about that is visible at runtime: the chart renders, the flag reads
 * "on", and the old route serves. It is the repo's own "wired needs runtime
 * proof" rule, so the wiring is asserted on the real files rather than on a
 * component rendered with a hand-supplied prop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// , not : apps/web transpiles to CJS under
// tsx, where import.meta.dirname is undefined — the idiom the sibling tests use.
const WEB = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

test("the root layout RESOLVES the flag and PROVIDES it", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /getUdfBaseUrl/, "layout never resolves the flag");
  // CALLED, and the spelling of the call is not the assertion.
  //
  // This used to require the literal `await getUdfBaseUrl()`, and MONEY-1469
  // broke it by resolving both flags through one `Promise.all` — which is
  // MORE correct, not less: two sequential Mongo round trips in the root
  // layout are paid by every dynamic render on the site. A guard that fails on
  // a strictly better call shape is a guard that gets loosened under pressure,
  // so it now asserts the two things that actually make the cutover live: the
  // resolver is INVOKED, and its result reaches the provider.
  assert.match(
    layout,
    /getUdfBaseUrl\(\)/,
    "getUdfBaseUrl is imported but never called — the cutover would be inert"
  );
  assert.match(
    layout,
    /\bawait\b/,
    "the layout must await its resolvers, or the provider gets a Promise"
  );
  assert.match(
    layout,
    /<UdfBaseUrlProvider\s+value=\{udfBaseUrl\}>/,
    "the resolved value is never provided to the tree"
  );
});

test("the A4 quote cutover is wired the same way — MONEY-1469", () => {
  // Same guard, same reason, one ticket later. A3 shipped a resolver with zero
  // callers; the only thing that stops that repeating is asserting the wiring
  // for every flag that has one.
  const layout = read("app/layout.tsx");
  assert.match(
    layout,
    /getQuotesBaseUrl\(\)/,
    "layout never resolves the quotes flag"
  );
  assert.match(
    layout,
    /<QuotesBaseUrlProvider\s+value=\{quotesBaseUrl\}>/,
    "the resolved quote origin is never provided to the tree"
  );
  // BOTH resolvers in ONE await. Two sequential Mongo reads in the root layout
  // are paid by every dynamic render on the site.
  assert.match(
    layout,
    /Promise\.all\(\[\s*getUdfBaseUrl\(\),\s*getQuotesBaseUrl\(\),?\s*\]\)/,
    "the two flag reads must be parallel, not chained"
  );

  const hook = read("hooks/useMarketData.ts");
  assert.match(
    hook,
    /useQuotesBaseUrl\(\)/,
    "the poller never reads the provided origin — the flag would be inert"
  );
  assert.match(
    hook,
    /isServiceQuotesUrl\(quotesBaseUrl\)/,
    "the poller must branch on the resolved origin"
  );
  // `brokerStatus` is fetched in PARALLEL with the quotes, never chained —
  // chaining would put the Vercel round trip this ticket removes back in front
  // of the quote read.
  assert.match(
    hook,
    /Promise\.all\(\[[\s\S]{0,400}BROKER_STATUS_URL/,
    "brokerStatus must be fetched alongside the quotes, not after them"
  );
});

test("the market-data TOKEN is minted, attached and consumed — MONEY-1470", () => {
  // `mintMarketDataToken` shipped with ZERO CALLERS. The chart's datafeed is
  // TradingView's vendored `UDFCompatibleDatafeed`, whose requester is built
  // with no headers and which exports no `Requester` to pass one to — so every
  // intraday request reached the service with no Authorization header and was
  // refused. That refusal is a 200 with `{s:"error"}` and a console.warn, so
  // NOTHING alerted: the whole A5 read path, the `intraday` claim, the
  // entitlement flag and the basis badge were unreachable while the writers
  // filled Redis nightly. This is A3's inert-cutover defect, one ticket later.
  const auth = read("lib/market/market-data-auth.ts");
  assert.match(auth, /mintMarketDataToken/, "nothing mints a token");
  assert.match(
    auth,
    /Authorization[\s\S]*Bearer/,
    "the wrapper must actually attach the header"
  );
  // ONLY the service's origin. A token attached to every request would be a
  // credential leak to whatever host that is.
  assert.match(
    auth,
    /url\.startsWith\(serviceOrigin\)/,
    "the token must be scoped to the service origin"
  );

  const chart = read("components/charts/TradingViewAdvancedChart.tsx");
  assert.match(
    chart,
    /installMarketDataFetch\(/,
    "the chart never installs the transport — intraday would 100% refuse"
  );

  const hook = read("hooks/useMarketData.ts");
  assert.match(
    hook,
    /marketDataAuthHeaders\(\)/,
    "the quote poller never sends a token — /quotes is authenticated"
  );
});

test("the service path falls back for what it could NOT answer", () => {
  // `body.missing` was read by nothing, which made a whole class of failure
  // silent: `discover/markets` hands this hook YAHOO symbols (`^NSEI`), the
  // service keys them verbatim and misses 100%, and the response is `s:"ok"`,
  // `hits:0`, no error — every index card simply frozen.
  const hook = read("hooks/useMarketData.ts");
  assert.match(
    hook,
    /body\.missing/,
    "the poller must read `missing`, or a total miss looks like success"
  );
  assert.match(
    hook,
    /fetchFromLegacyRoute\(needLegacy/,
    "and must fall back for exactly those symbols"
  );
  // A fallback FAILURE must not discard the symbols the service did answer.
  assert.match(
    hook,
    /legacy fallback failed/,
    "the fallback is caught, not fatal"
  );
});

test("the quotes resolver never throws, and never reads the flag on the client", () => {
  const src = read("lib/market/quotes-target.ts");
  assert.match(
    src,
    /^import "server-only";/m,
    "PlatformConfig must not reach the client bundle"
  );
  // A FAILURE IS NOT CACHED — caching "we could not determine it" turns one
  // Mongo blip into 30 seconds of the legacy route for every request, and makes
  // the flag look inert to whoever just flipped it.
  const cacheWrites = src.match(/cached = \{/g) ?? [];
  assert.equal(
    cacheWrites.length,
    1,
    "exactly one cache write, on the success path"
  );
  const catchBlock = src.slice(src.indexOf("} catch"));
  assert.doesNotMatch(
    catchBlock,
    /cached = \{/,
    "a failure must never be cached"
  );
  assert.match(
    catchBlock,
    /return LEGACY_QUOTE_URL/,
    "a failure must fall back to the legacy route"
  );
});

test("the chart CONSUMES the context", () => {
  const chart = read("components/charts/TradingViewAdvancedChart.tsx");
  assert.match(
    chart,
    /useUdfBaseUrl\(\)/,
    "the chart never reads the provided origin"
  );
  assert.match(
    chart,
    /udfBaseUrl \|\| contextUdfBaseUrl \|\| UDF_BASE_URL/,
    "the datafeed must prefer the prop, then the context, then the legacy route"
  );
});

test("the legacy route remains the fallback in BOTH the provider and the chart", () => {
  // The two failure directions are not symmetric: falling back costs latency
  // nobody notices, while pointing at a service whose tiles are missing answers
  // no_data for every symbol and renders BLANK with no error.
  const provider = read("components/charts/UdfBaseUrlProvider.tsx");
  assert.match(
    provider,
    /LEGACY_UDF_BASE_URL/,
    "the provider has no safe default"
  );
  assert.match(
    provider,
    /createContext<string>\(LEGACY_UDF_BASE_URL\)/,
    "a tree rendered without the provider must behave exactly as before"
  );
  const chart = read("components/charts/TradingViewAdvancedChart.tsx");
  assert.match(chart, /const UDF_BASE_URL = "\/api\/market\/udf";/);
});

test("the resolver never throws, and never reads the flag on the client", () => {
  const src = read("lib/market/udf-target.ts");
  assert.match(
    src,
    /^import "server-only";/m,
    "PlatformConfig must not reach the client bundle"
  );
  assert.match(
    src,
    /catch\s*\{[\s\S]*LEGACY_UDF_BASE_URL/,
    "Mongo down must not blank every chart"
  );
});

test("the root-layout read is CACHED, and a failure is not", () => {
  // It runs on EVERY dynamic page render, not only chart pages, so an uncached
  // read adds a Mongo round-trip to each one. But the TTL is short on purpose:
  // this value is also the ROLLBACK, and a long TTL is that many minutes of a
  // broken chart after someone has decided to stop it.
  const src = read("lib/market/udf-target.ts");
  assert.match(
    src,
    /FLAG_TTL_MS = 30_000/,
    "the TTL must be short — it is the rollback path"
  );
  assert.match(
    src,
    /if \(cached && now - cached\.at < FLAG_TTL_MS\) return cached\.value/
  );

  // The failure path must NOT write the cache: one Mongo blip would otherwise
  // pin the whole platform to the fallback for the entire TTL.
  // Scoped to the catch BLOCK, not to end-of-file: `__resetUdfTargetCache`
  // legitimately assigns `cached = null`, and a slice that ran past the
  // function end reported it as the defect. The test was wrong, not the code.
  const from = src.indexOf("} catch {");
  const catchBlock = src.slice(from, src.indexOf("\n}", from));
  assert.ok(
    catchBlock.includes("LEGACY_UDF_BASE_URL"),
    "the catch must return the legacy route"
  );
  assert.ok(
    !/cached\s*=/.test(catchBlock),
    "the catch block caches the fallback — one blip would pin every chart to it"
  );
});

test("a PRERENDERED page baking the legacy default is harmless, and is why the root layout is safe", () => {
  // Measured 2026-09-16: qa.usemoney.ai/ answers `x-nextjs-prerender: 1`, so
  // its layout render happened at BUILD time and froze whatever the flag was
  // then. That is fine here and worth writing down rather than rediscovering:
  // prerendered routes are marketing pages that render no chart, while every
  // chart page is behind auth and therefore dynamic, so it reads the live flag.
  //
  // The assertion that matters is the DEFAULT — if a prerender ever did bake a
  // value, it must be the legacy route.
  const provider = read("components/charts/UdfBaseUrlProvider.tsx");
  assert.match(provider, /createContext<string>\(LEGACY_UDF_BASE_URL\)/);
});
