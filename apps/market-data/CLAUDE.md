# @usemoney/market-data — the UDF datafeed on Cloud Run

Serves the TradingView UDF contract from `asia-south1`, behind an external HTTPS
load balancer with **Cloud CDN enabled**. Created by MONEY-1466 (data-platform
A1); A2/A3/C4 fill the data endpoints.

## Why this service exists

Every UDF call goes through a Vercel function doing Clerk auth + Redis + Mongo +
a live Yahoo fetch. Measured over 14 days (`service:vercel.edge-network`):

| endpoint                                 | p50    | p95    |
| ---------------------------------------- | ------ | ------ |
| `udf/history`                            | 0.75 s | 3.15 s |
| `udf/config`, `udf/time` — **constants** | 0.26 s | —      |

A quarter of a second to return a literal is the argument for an
edge-cacheable origin.

## Endpoints

| Route               | Status        | `Cache-Control`        | Notes                                              |
| ------------------- | ------------- | ---------------------- | -------------------------------------------------- |
| `GET /udf/config`   | **200**       | `public, max-age=3600` | body from `@usemoney/core/market-data/udf/config`  |
| `GET /udf/time`     | **200**       | `public, max-age=1`    | unix **seconds**, `text/plain`                     |
| `GET /udf/symbols`  | **200**       | `public, s-maxage=300` | DB + `INDEX_MAPPINGS`; refusals are 200 `no-store` |
| `GET /udf/search`   | **200**       | `public, s-maxage=300` | array, never an error shape                        |
| `GET /udf/history`  | **200**       | see below              | D1 from tiles (A2); intraday from Redis (A5)       |
| `GET /quotes`       | **200**       | `private, max-age=5`   | batch, Redis only, **token required** (A4)         |
| `GET /udf/marks`    | 501 (C4)      | `no-store`             |                                                    |
| `GET /health/live`  | 200           | `no-store`             | process only — no dependencies                     |
| `GET /health/ready` | 200 / **503** | `no-store`             | Mongo + Redis, 500 ms budget each                  |

## Things that are load-bearing

**`Cache-Control` is set explicitly on every route.** A missing header means the
CDN will not cache, the service becomes a slower Vercel function with an extra
hop, and nothing errors.

**`/udf/symbols` IS THE FIRST CALL THE WIDGET MAKES, and it was a 501 stub
until MONEY-1476.** TradingView's `resolveSymbol` must succeed before the widget
requests a single bar, so when `MARKET_DATA_TILES` went true on prod every chart
read **"Symbol Error · invalid symbol"** while `/udf/history` was serving
correctly — and `market-data-smoke.sh` passed 21/21 throughout, because it
probed config, time and history and never this. It probes it now, and
`routes.test.ts` had been asserting the 501 as the contract. Full RCA — including why the A3 parity harness and a 21/21 smoke run both said go — in `docs/reference/chart-cutover-outage-2026-09-18.md`.

**IT RESOLVES ONLY WHAT `/udf/history` CAN SERVE**, and that is enforced by
asking history's own `resolveListing` plus the tile key builder's own
`canBuildTileKey` — not by a second parser. Refused BY NAME, each for its own
reason:

| refused                                                       | why                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a listing id outside `[A-Za-z0-9._:+&-]` after the space fold | `tileKey5y` THROWS, and `/udf/history` returns `err.message` — the tile store's internal note about GCS prefixes rendered inside the user's chart. A SPACE is folded to `_` now (MONEY-1479, for `NYSE ARCA`/`NYSE MKT`) and `&` is ALLOWED (MONEY-1478 — `M&M` and 9 other Indian tickers were failing the nightly build), so what remains refused is a genuine separator |
| any non-`EQUITY` type (~541 ETFs, 6,172 NSE DEBT rows)        | `tile-build-d1` tiles EQUITY only, so it would chart blank with no message                                                                                                                                                                                                                                                                                                 |
| a US listing WITHOUT the `us` claim                           | a LICENCE, not a data gap — Tiingo COMMERCIAL is internal-use-only (MONEY-1262). Refused with the SAME sentence `/udf/history` uses. **With** the claim it now RESOLVES (MONEY-1478)                                                                                                                                                                                       |
| an unknown `MF:<code>`                                        | funds RESOLVE now (MONEY-1478). An unknown scheme code is refused BEFORE the NAV read, because `getMfNavHistory` enqueues a backfill for a cold scheme and its dedupe is keyed on the code — so `MF:1`, `MF:2`, … would each publish from an anonymous caller                                                                                                              |

A bare symbol defaults to NSE, matching `apps/web`'s `parseSymbolPrefix`.

**MUTUAL FUNDS ARE SERVED (MONEY-1478).** `resolveListing` is a discriminated
union — `{kind:"tile"}` or `{kind:"fund"}` — because a fund is neither an IN nor
a US tile: no exchange, no tile, no intraday, and its series is synthesised from
AMFI NAV. Keeping it in the SAME resolver is the point; two endpoints
disagreeing about what exists is the defect MONEY-1476 was spent closing.

A NAV is ONE number a day, so the bar is FLAT (open = high = low = close) and
`volume: 0` means "this series HAS no volume", never "nothing traded" — which is
why a fund's symbol info sets `has_no_volume`. Verified against prod: 245 bars
for `MF:120503`, ascending, correctly cached. Funds are PUBLIC like India daily:
AMFI NAV is a public disclosure with no vendor redistribution limit.

**SEARCH IS PREFIX-ONLY, DELIBERATELY.** `apps/web` also matches
`name: { contains, mode: "insensitive" }`, which is UNINDEXABLE — every miss
scanned ~24k active rows PER KEYSTROKE, ANONYMOUSLY, on a service built to take
a Mongo read OFF the chart path. The cost is stated rather than hidden: typing a
company NAME no longer finds it unless the TICKER matches, and `apps/web`'s
richer search stays available behind Clerk.

`previousSymbols` is queried on BOTH `/udf/search` and `/udf/symbols` — it is
indexed, and without it ZOMATO (now ETERNAL) and TATAMOTORS (now TMCV/TMPV)
resolve NOWHERE, so a saved chart or an old link reads "unknown symbol" for a
company that exists. A rename resolves to the CURRENT ticker, or the widget
requests bars under a name with no tiles.

The `type` and `exchange` tabs are honoured. Note `computeExchangeFilters`
returns the SAME flag for "NSE" and "BSE" — it only separates equities from
funds — so the exchange narrowing is done in the query here; measured,
`exchange=NSE` had been returning BSE:RELIANCE first.

**Funds and US listings resolve here now (MONEY-1478).** Indices and ETFs are
still refused, so `MARKET_DATA_TILES` remains gated on those two.

**US RESOLVES BEHIND THE LICENCE CLAIM, and both preconditions were MEASURED
before lifting the refusal** — MONEY-1476 refused US by name and named its own
two conditions, "US tiles existing AND the licence gated":

| precondition | measured 2026-09-18                                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US D1 tiles  | `gs://stockbook-lake-prod/tiles/US/d1/` holds **13,978** listing prefixes, `AAPL:NASDAQ:1980-12-12/2016..2025.json` among them. The premise "no US D1 tiles exist" had gone STALE under the comment asserting it |
| licence gate | `/udf/history` gates US on `tokenMayReadUs` (MONEY-1477) — it ships in the SAME branch, so the gate and the lift deploy together                                                                                 |

**The claim is re-checked in `/udf/symbols`, never inherited.** It is a separate
request on a separate CDN-cached route; resolving a symbol whose bars the caller
will then be refused is the resolve-then-fail defect MONEY-1476 was spent
closing, pointed the other way.

**A US symbol's `ticker` is the LISTING ID, not `EXCHANGE:SYMBOL`.** A TICKER IS
NOT A SECURITY: the master holds two `DOW` rows on NYSE (Dow Chemical 1972-2017,
Dow Inc. 2019-). TradingView caches the ticker it is handed and requests every
bar under it, so a 2-part ticker would have the widget ask history for
`NASDAQ:AAPL` — which `resolveListing` reads as an INDIA listing on an exchange
that does not exist, resolving fine and charting blank. `buildUsSymbolInfo` also
declares `has_intraday: false` (the tiles are DAILY) and the venue's own
`0930-1600` / `America/New_York`, because Indian hours draw US bars on the wrong
days with nothing on the chart to reveal it.

**`/udf/search` never returns US rows** — it queries `instrument_mappings`,
which is India-only. US listings live in `us_instruments`. So US is reachable by
exact symbol, not by browsing, which is the conservative direction for a licence
boundary.

**`/udf/search` ranks TICKER matches above name matches**, in two queries. One
query with `OR: [symbol startsWith, name contains]` ordered by `symbol asc`
returned `BSE:NCAPBUILAD` ("RELIANCE MUTUAL FUND- RELIANCE") ahead of
`NSE:RELIANCE`, measured against prod — alphabetical order is not relevance, and
a symbol search that cannot find the symbol it was given is worse than none.

**The 501 routes are `no-store`.** A cached 501 outlives the deploy that
implements the endpoint — A2 would ship and the edge would keep answering "not
implemented" until the TTL expired.

**`/udf/history`'s `Cache-Control` is the "see below" in the table, and it has
three states** (MONEY-1475):

| response                   | value                                               | why                               |
| -------------------------- | --------------------------------------------------- | --------------------------------- |
| daily bars, in-session     | `public, s-maxage=60, stale-while-revalidate=300`   | today's bar is still forming      |
| daily bars, out-of-session | `public, s-maxage=3600, stale-while-revalidate=300` | a settled daily bar does not move |
| `no_data` or any error     | `no-store`                                          | see below                         |

**A `no_data` MUST NOT carry a CDN value**, and it did until MONEY-1475. Two
measured consequences: a newly-listed symbol whose first tile lands at 21:05 IST
answered blank from every POP until 22:05 plus SWR — a blank chart outliving the
backfill that fixed it; and a service whose tile store is unconfigured returns
`no_data` for EVERY symbol, because `readTile` yields `absent` rather than
`failed`, so no error path runs and that platform-wide blank chart was pinned at
the edge for an hour. **The intraday leg carried the identical defect** — its header was set above its `no_data` branches too — and is fixed in the same change; an earlier draft of this section claimed it was already correct.

**The session is keyed to the LISTING's market, not to India.** `resolveListing`
returns market `US` for a 3-part symbol, and the header used to ask
`inIndiaSession` for every listing — exactly inverted for US, where a
still-forming daily bar got `s-maxage=3600` during US regular hours and the
immutable one got `s-maxage=60` at 10:30 IST.

`market-data-smoke.sh` grades this against the IST wall clock rather than
accepting both values, because a check that accepts both cannot see an inverted
session detector; `apps/market-data/__tests__/smoke-cache-agreement.test.ts`
holds the script's literals and their VERDICTS in agreement with this app.

**`/udf/time` returns seconds as text.** Milliseconds put the chart ~55,000
years in the future; JSON makes the widget parse `NaN`. Both render an empty
chart rather than an error.

**Unimplemented endpoints return `{s:"error"}`, never `{s:"no_data"}`.**
`no_data` means "this symbol has no bars in this range", which the widget draws
as a blank chart with no message — indistinguishable from a delisted instrument.

**`/health/ready` returns 503 when a dependency is down — and NOTHING POLLS IT.**
That second half matters and this section used to omit it. Cloud Run offers a
`startupProbe` and a `livenessProbe` and no readiness probe at all, and a
serverless NEG carries no health check, so no 503 from this service can park an
instance anywhere. It is an endpoint an operator curls to ask one revision
whether it can reach Mongo and Redis. Pointing the STARTUP probe at it — which
would genuinely stop a broken revision going live — is deliberately left to A2,
because A1 answers from constants and would then refuse to deploy over
dependencies it does not use. `apps/api`'s 200-with-`"unknown"` is still not
copied: a probe that exists to report a dependency failure must not answer with
the success code. Checks run in **parallel** with a **500 ms budget each** — an
unbudgeted probe against a hung Mongo does not fail, it BLOCKS, and whoever is
waiting on it waits too.

**`/health/live` touches nothing.** A liveness probe that fails when Mongo is
down makes Cloud Run restart every instance during a database incident.

**APM is real here.** Cloud Run with a `datadog-agent` sidecar, so spans have
somewhere to go — unlike `apps/api` on Vercel, whose spans die at the writer.
The Dockerfile's `--import dd-trace/register.js` is what makes ESM
instrumentation work at all; without it the service runs and produces no spans,
with no error.

**The token verifier is LIVE (A4/A5).** HS256, 5-minute TTL, minted by
`apps/web/lib/actions/market-data-token.ts`. It pins the algorithm (accepting
the token's own `alg` is the classic JWT forgery), refuses a token whose own
`exp - iat` exceeds the policy, and refuses everything when the secret is
absent — a fail-open auth check is indistinguishable from a working one until
someone who should not have got through does.

It is applied through `checkMarketToken` INSIDE the handlers rather than as
middleware, because `/udf/history` serves public daily bars and gated intraday
ones from the same route, so the gate has to run after the resolution is parsed.
One verifier, two callers.

**Three separate gates, and they answer three different questions.**

| Question                | Check                                         | Refusal                                       |
| ----------------------- | --------------------------------------------- | --------------------------------------------- |
| Is this caller known?   | `checkMarketToken`                            | `/quotes` 401, `/udf/history` 200 `s:"error"` |
| May they read US data?  | `tokenMayReadUs(claims)` — the **licence**    | 403 / 200 `s:"error"`                         |
| May they read intraday? | `tokenMayReadIntraday(claims)` — the **plan** | 200 `s:"error"`                               |

Every claim is OPTIONAL in the type and FAIL-CLOSED in the check: a token minted
before a claim existed carries none, and `undefined` must mean no.

**The US one is a LICENCE, not a product flag, and is deliberately not derived
from the plan tier.** Tiingo Commercial is internal-use-only; the claim is set
at mint time by `currentUserMaySeeUsMarket`, which defaults to the founder
alone. Folding it into the tier would mean one `PlatformConfig` write meant to
unlock India intraday shipped 45 sessions of US OHLC to every subscriber on that
tier, with no deploy and no diff.

**`/quotes` and intraday are `private`.** A shared cache holding one user's
response would hand it to a caller with no token at all — the gate removed by a
header.

**`exposeHeaders` is required for `X-Bar-Basis` to exist.** Without
`Access-Control-Expose-Headers` the browser strips it cross-origin, the chart
reads `null`, and null means "clear the badge" because a daily response
legitimately carries no header. The failure is byte-identical to correct daily
behaviour and works perfectly in local dev against the same-origin route.

**The app container needs `DD_API_KEY`, not only the sidecar.** The TypeScript
metrics path wraps `datadog-metrics`, which posts to the HTTP API and is gated
on that key alone — it does not use the sidecar's DogStatsD port. Without it
every `stockbook.quote.*` counter no-ops silently, which renders as NO DATA and
is indistinguishable from a healthy idle service (MONEY-1238).

## Shared code, and one thing deliberately not shared

The symbol and search resolvers moved to `@usemoney/core/market-data/udf/` so
this service and `apps/web` run ONE implementation. The web paths remain as
re-export shims because ten `apps/web/__tests__` files import them.

`CONFIG_CACHE_CONTROL` did **not** move. Web's is `private` (it sits behind
Clerk); this service's is `public` (it sits behind a CDN). Same body, opposite
caching semantics — sharing the constant would have made one of them wrong, and
a wrong `Cache-Control` is invisible until something is cached that should not
have been.

## Deploy

```bash
./scripts/ops/setup-market-data-sa.sh qa          # 1. SA + grants
./scripts/ops/setup-infra.sh qa --only market-data # 2. build + deploy
./scripts/ops/setup-market-data-lb.sh qa          # 3. NEG + backend + CDN + cert
```

**The order is load-bearing in both directions.** `services replace` naming a
service account that does not exist fails the deploy, so the SA comes first;
and `setup-market-data-lb.sh` REFUSES to run while the Cloud Run service is
absent, because a serverless NEG pointed at nothing provisions perfectly
cleanly and then 404s every request.

**There is NO push-to-deploy trigger for this service, deliberately.**
`setup-cloudbuild-triggers.sh` manages only `us-fundamentals`; the two
`stockbook-workers` triggers are hand-made and listed there as UNMANAGED. So a
deploy is an explicit `setup-infra.sh` run.

That is also why the specs tag with **`$COMMIT_SHA` and never `$SHORT_SHA`**.
`SHORT_SHA` is populated by a TRIGGER, and there is no trigger — it would
resolve to empty, and `usemoney-market-data:qa-` is not a valid tag. The one
path that deploys this passes `--substitutions=COMMIT_SHA=<short-sha>-<ts>`
(`setup-infra.sh`), and every sibling spec in the repo uses the same
substitution. The trailing timestamp is not noise: re-deploying an identical
commit under an identical tag makes `services replace` a NO-OP, so the freshly
built image is never served.

`setup-market-data-sa.sh` grants `objectViewer` on **`tiles/`**, not the brief's
`bars/` — the lake contract and A2 both say `tiles/`, and
`bucketForPrefix("bars/…")` throws today.

Proof of the CDN, which is the acceptance for A1:

```bash
curl -I https://market-data-qa.usemoney.ai/udf/config   # twice; second shows age>0
```

## The intraday buffer (A5)

A Redis **sorted set** per listing, `ib:{market}:{listing}:{interval}`, scored
by each bar's own timestamp, holding 45 sessions of the market's BASE interval.

It was a LIST, and position only APPROXIMATES time — three separate silent
defects followed. `rollup-logic.ts`'s `BufferMember` header has them in full.

**One basis per SESSION, never per response.** `candle-sink` writes today live
as `quote_mid`; `databento-append` writes the PRIOR session as `trade` hours
later. Choosing one basis for the whole window meant `trade` won permanently and
every live bar was dropped — a chart that flat-lines all session while `dropped`
reads 0.

**India's base is 5m, US's is 1m**, and that is a source fact rather than a
preference — see `docs/reference/india-intraday-activation.md`. `rollUp`
REFUSES a target narrower than the base instead of passing the input through.

**Buckets are phase-shifted to the venue's open.** India opens 09:15 IST =
03:45 UTC, so epoch-aligned hourly buckets start 08:30 IST. 15m survives by
coincidence, which is why it does not show up on the resolution most people
test.
