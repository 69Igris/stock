# W10 · Holdings · Watchlist · Tradebook — mixed-market deltas (by-market grouping, dual-currency totals, source badges, US lots)

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: W00 (DualCurrency, DelayedDataBadge, ProvenanceChip, DataGapBanner), W08 (US holdings/lots exist with `currency`), W12 (persona → primary currency).

**Ticket:** `MONEY-{n}` "Mixed-market holdings, watchlist, tradebook" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/v2 US Launch.dc.html` "Holdings, both markets, one ledger." (status "● 61 INSTRUMENTS · 8 SOURCES · 2 MARKETS"; grouping BY BROKER · BY MARKET · FLAT; group header "United States · ◷ EOD · JUL 18 CLOSE · 4 SYMBOLS · 14 POSITIONS · $58,640"; US table SYMBOL · SOURCE · QTY · AVG · LAST · VALUE (primary + secondary) · P&L; India group "◷ EXCHANGE-DELAYED"; TOTAL · BOTH MARKETS band "VALUES AT SPOT ₹84.00/$ · COST BASIS AT RBI REF OF TRADE DATE") · `v2 Dashboard.dc.html` `holdings` interleave (`mkt` chip IN/US, `holdSrc` "RECONCILED · 3 INDIA BROKERS + 3 US ACCOUNTS · US ◷ EOD") · `app/s-portfolio.jsx` (US lots section in Trades: "US lots · imported & linked · RBI REF ON TRADE", row "AAPL · 4.28 sh · 18 Apr 26 · $204.11 · ₹83.10 · Vested · OPEN LOT"; note "US lots land in the same ledger. ₹ cost basis is frozen at the RBI reference rate of the trade date; US gains are not computed for Indian tax yet.") · `app/s-discover.jsx` watchlist rows with `US` tag + ◷ EOD · Decisions 01, 02, 06.

## Read first
- `apps/web/app/holdings/{page,client,layout}.tsx`, `holdings-research-prefill.ts`, `apps/web/lib/actions/holdings.ts` + `holdings-dedup-logic.ts`, `packages/services/src/holdings{,-logic}.service.ts`, `packages/types/src/holding/*` (grouping modes today: by broker/sector?), `apps/web/components/holdings/*` if present
- `apps/web/app/watchlist/*`, `apps/web/lib/actions/watchlist.ts`, `packages/services/src/watchlist.service.ts`, `apps/web/hooks/useWatchlistMembership.ts`, `useSparklines.ts`, `apps/web/app/api/market/{quote,sparklines,stream}` (India quotes), `apps/api/src/routes/v1/market.ts` (`us/quotes`)
- `apps/web/app/tradebook/*`, `apps/web/lib/actions/trades.ts`, `packages/services/src/trades{,-logic}.service.ts`, `packages/core/src/pairing/*` (FIFO), Prisma `Trade`, `PairedTradeView`, `Holding` (+ `currency`, `market` from W08), `FxRate`
- FX: `packages/core/src/currency/exchange-rates.ts`, `packages/services/src/gst/rbi-fx.ts`
- Demo data: `apps/web/lib/demo/*` (add a mixed-market demo user variant)

## Current state
Holdings/watchlist/tradebook are India-only (`exchange` default NSE, ₹ everywhere). W08 introduces USD holdings and lots; without this prompt they would render as ₹ numbers — **do not ship W08 to users before W10**.

## Build (gated by `us-stocks-listing` + the user having ≥ 1 US holding/account; otherwise pages are byte-identical)
1. **Holdings:** grouping control gains BY MARKET (default when mixed) alongside BY BROKER · FLAT; market group headers with counts + `DelayedDataBadge` (US) / "◷ EXCHANGE-DELAYED" (India); US rows: SOURCE column (broker name via SnapTrade, or "Imported · Apr 26" badge), QTY, AVG (native currency, RBI-ref based ₹ on hover/secondary), LAST (EOD close, `$`), VALUE as `DualCurrency` (primary per persona), P&L (native + %); India rows unchanged; TOTAL · BOTH MARKETS band with the FX rule line and spot stamp; FX stale > 24 h → `DataGapBanner` on totals only (rows keep native values). Row click → `/stock/[symbol]` (W09 for US). Holdings summary tiles (top of page) become dual-currency aware.
2. **Watchlist:** mixed lists — US rows carry `US` chip + `DelayedDataBadge`, price `$` with secondary ₹; quotes for US symbols come from `/v1/market/us/quotes`-equivalent web route (`/api/market/quote?exchange=NASDAQ`); India rows keep the live/delayed provenance; "Add a stock" search includes US symbols when `us-stocks-search` is on.
3. **Tradebook:** US lots appear in the same ledger with a `US` chip and "RBI REF ON TRADE" tag; pair rows show buy/sell in `$` with ₹ cost basis frozen at the trade-date RBI ref; **no STCG/LTCG classification for US lots** (term column shows "—" + tooltip "US gains not computed for Indian tax yet"); FIFO pairing runs per (symbol, exchange, broker, currency) — never pairs across currencies; CSV export includes `currency` and `fx_rate_on_trade` columns; import entry links to the US statement wizard (W08).
4. **Copy:** disclaimer under the ledger: "Imported lots keep the RBI reference rate from their trade date, so your ₹ cost basis doesn't drift with today's rate. Values use the hourly spot rate."

## Data wiring
- `getHoldingsAction` → `holdings.service.ts` returns `{ groups: { market|broker|flat }, totals: { inr, usd, fxRate, fxAsOf, fxStale } }`; conversion in `holdings-fx-logic.ts` (native → INR at spot for values; cost at `fxRateOnTrade`; tested incl. stale-FX and missing-rate paths → `null` never `NaN`).
- `getWatchlistsAction` rows gain `market`, `currency`, quote provenance; `getTradesAction`/paired view gain `currency`, `fxRateOnTrade`, `market`; `trades-logic.ts` excludes US lots from tax term logic (test).
- Pairing: `packages/core/src/pairing` key includes `currency`; regression tests with mixed fixtures prove India pairs unchanged byte-for-byte.
- `apps/api` mirror: `GET /v1/holdings?group=market` + totals; `GET /v1/watchlists` rows with `market`; `GET /v1/trades`/`/v1/paired` with the new fields; `POST /v1/watchlists/:id/items` accepts `market`.
- Demo: mixed-market demo dataset toggled by the demo persona.

## Non-goals
US tax (W11 covers LRS/TCS only), US MF/ETF holdings beyond what SnapTrade/imports provide, live US quotes.

## Acceptance
- India-only users: holdings/watchlist/tradebook unchanged (snapshot/contract tests). Mixed users: BY MARKET grouping default, dual-currency totals with spot stamp, every US price badged EOD.
- Totals never mix FX kinds: values use spot, cost basis uses RBI ref (unit tests on `holdings-fx-logic.ts`); stale FX → banner, rows still render.
- FIFO pairing never pairs across currencies; India pairing output unchanged on the golden fixture.
- US lots show "—" for term/tax; CSV export round-trips `currency`/`fx_rate_on_trade`.
- TEST-COVERAGE.md; `verify:push`; `/code-review ultra` (money paths).
