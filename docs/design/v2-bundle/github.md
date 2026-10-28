repo: UseMoney-AI/stockbook-monorepo
branch: main
path: apps/web

## Last sync

date: 2026-09-06T14:40:00Z

### Updated in this project

- Mobile v2.1: global US flag control on the stage; every existing screen carries its US component when on (ticker, search, holdings/trades, markets/screener/news, Sage prompt, brokers, settings, notifications, tax, risk, CSV import, first-run) and is unchanged when off.
- Audited StockSage for US stock selection: agent resolves `market: "IN"` only, @-picker searches NSE/BSE only, preview-plan has no market — recorded as decision 09 and gated the US-page Sage CTA (web + mobile) behind `us-stock-research`.
- Dashboard US deltas now land in all three personas (holdings interleave, US Markets tile, market split, Beginner plain-words card).
- Built `v2 US Launch.dc.html` (8 screens) from the shared US Launch mockups, re-grounded on main: EOD-only quotes (Tiingo ingest, Databento pending), SnapTrade instead of IBKR direct, flag-gated (no pre-GA), spot FX for values + RBI reference rate for cost basis/LRS.
- Applied US deltas to `v2 Screener` (flag state replaces waitlist) and `v2 Dashboard` (dual-currency net worth, US book tile, FLAG toggle).
- Mobile v2.1: 14 new flows in `UseMoney Mobile.html` (US layer + web-v2 parity) targeting `apps/api/src/routes/v1/*`.
- `Decisions - US Launch.dc.html` records the eight decisions and the open engineering items (Databento, RBI fetcher stub, aggregator pick, persona fields).

## Screen map

| Screen in this project | Built from (repo / design-system files) |
|---|---|
| v2 US Launch · Link a brokerage / consent / sync | `app/brokers/client.tsx`, `components/brokers/BrokerConsentModal.tsx`, `lib/types/feature-flags.ts` (`us-*` flags), `packages/core/src/market-data/us-market-access.ts` |
| v2 US Launch · Import a statement | `public/tradebook-template.csv`, `apps/api/src/routes/v1/imports.ts`, `packages/services/src/gst/rbi-fx.ts` (RBI ref) |
| v2 US Launch · US stock detail (Sage CTA gate) | `app/stock/[symbol]/us-client.tsx`, `packages/research/src/agent.ts`, `packages/research/src/data-sources/symbol-resolver.ts`, `components/chat/StockMentionPicker.tsx`, `app/api/research/preview-plan/route.ts` |
| v2 US Launch · Dashboard deltas / Holdings | `packages/core/src/currency/exchange-rates.ts` (spot), `packages/core/src/market-data/tiingo/*` (EOD) |
| v2 US Launch · LRS / TCS, Onboarding fork, Market preferences | no upstream code yet — see Decisions log |
| v2 Screener (US pill) | `lib/market/us-instrument-search.ts`, `lib/types/feature-flags.ts` |
| v2 Dashboard (US deltas) | `packages/core/src/currency/exchange-rates.ts` |
| UseMoney Mobile v2.1 · US layer + parity (`app/s-us.jsx`, `app/s-v2plus.jsx`) | `apps/api/src/routes/v1/{market,strategies,scans,saved-screens,imports,holdings}.ts`, `apps/api/src/lib/us-access.ts` |
| v2 StockSage (US deltas) | `app/stocksage/client.tsx`, `components/chat/ChatPromptArea.tsx`, `components/chat/StockMentionPicker.tsx`, `components/chat/QuickActionChips.tsx`, `components/stocksage/ResearchRunBlock.tsx`, `app/api/research/preview-plan/route.ts`, `packages/research/src/agent.ts` |
| Module D - US Launch | superseded → v2 US Launch |

## Sync history

- 2026-09-06T11:32:11Z — built v2 US Launch, US deltas, mobile v2.1, decisions log.
- 2026-09-06T10:30:32Z — reviewed shared US Launch mockups against main; confirmed web-only repo + mobile REST API.
- 2026-09-06T09:43:32Z — read the US market layer (MONEY-1309, 980/1262, 979, 1138).
- 2026-07-29T13:30:01Z — Scans IA mockups grounded on live shell.
- 2026-07-29T10:52:14Z — first association.
