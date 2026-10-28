# M15 · Module: Discover tab — Markets · Screener (scans) · Sectors + sector page · News & events · Watchlists

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: M00, M10. Related: M16 (rows → instrument pages), M21 (Screener v2 + Strategies), M20 (US card/news).

**Ticket:** `MONEY-{n}` "Mobile — Discover" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/app/s-discover.jsx` (`DiscoverScreenV2`: `PageHead` "The market, in one breath." + tab chips Markets · Screener · Sectors · News · Watchlists (`discover:<tab>` params); **Markets:** US card when flag (S&P 500 · NASDAQ · USDINR, "◷ EOD", "OPENS 19:00 IST · 09:30 ET · SPOT FX HOURLY"), index tiles (value · % · sparkline), "Flows · FII / DII" bars + date, Movers (Gainers | Losers chips, ranked `MoverRow`s), "Sector pulse" chips → sector page; **Screener:** Screener-v2 link row when flag, "Curated scans over 7,000+ instruments. Tap one to see today's matches.", scan cards (name · desc · count) → "Top matches · N of TOTAL" list + "FULL LIST OF N IS A PRO FEATURE.", `GateBanner` "Build custom scans…"; **Sectors:** "By NIFTY weight" rows (weight · tracked · today%) → `SectorScreenV2` (change · weight tag · line · "You hold N names here — ₹x" · tracked stocks · "Ask Sage about {sector}"); **News:** chips All / Your holdings / Macro / [US], rows (SymTile or globe · title · "tag · src · time ago · you hold this"), US rows with SEC EDGAR sources, "This week" events; **Watchlists:** list chips (name · count) + "+ New" (PRO toast in mock — implement real create), rows (symbol · name · LTP · %) → stock, "Add a stock" → search, empty state "Star any stock — from search, a screener, or a stock page — to track it here.").

## Read first
- `apps/api/src/routes/v1/{discover,market,screener,scans,news,watchlist,strategies}.ts`: `GET /v1/discover/markets` (movers/indices?), `/discover/heatmap`, `/discover/flows` (FII/DII), `/discover/sectors`, `/discover/sectors/:sector`, `/discover/sectors/:sector/stocks`, `/discover/indices/:slug`, `/discover/ipos`, `/discover/search`, `GET /v1/market/indices` (sparklines via `/v1/market/sparklines`), `/v1/market/us/quotes`, `GET /v1/scans` + `POST /v1/scans/:id/run` (+ `/v1/strategies/scans/:scanId/status|result` for async), `GET /v1/news/feed`, `/news/events`, `/news/pulse`, `/news/daily-brief`, `GET /v1/watchlists` + items CRUD + `reorder`, `batch`
- Web semantics: `apps/web/app/discover/{markets,sectors,news,scans}/*`, `apps/web/lib/actions/{discover,discover-sectors,discover-heatmap,news,scans,watchlist}.ts` + `*-logic.ts` (mover ranking, sector weights — mirror, don't re-derive on the client)
- Gating: scans founder/PRO gating (`MONEY-1058`) must not leak via the API — respect `gate` fields.

## Build
1. **Tab chips + param routing** (`/discover?tab=markets|screener|sectors|news|watchlist`, aliases from M10).
2. **Markets:** US card (flag + `/v1/market/us/quotes` for index proxies — if no index quotes exist server-side, show only USDINR + "opens at" line, never fake index values); index tiles from `/v1/market/indices` + `/v1/market/sparklines` (delayed provenance shown as "◷ delayed" chip); FII/DII from `/v1/discover/flows` (date tag; empty → "Flows arrive after close"); movers from `/v1/discover/markets` (gainers/losers toggle; ranked rows → stock page); sector pulse chips from `/v1/discover/sectors` (top 8 by |change|).
3. **Screener (v1 scans list):** cards from `/v1/scans` (name, plain description, yesterday's count or `—`, source badge, lock for gated); tap → run (`POST /v1/scans/:id/run`; async → poll status; sync → results) → matches list (top N free; PRO sees all — server-enforced page size); `GateBanner` for custom scans; when `us-stocks-listing` is on, the "Screener v2 · INDIA | US pill, scans library" row → M21.
4. **Sectors:** rows from `/v1/discover/sectors` (weight, tracked count, today %); sector page from `/v1/discover/sectors/:sector` + `/stocks` (+ "You hold N names here" computed from holdings query intersection on the client — counts only, sums from holdings values); "Ask Sage about {sector}" prefill.
5. **News:** feed with filter chips (`/v1/news/feed?filter=all|held|macro`, US chip → `?market=US` when flag; rows with `US` tag + EDGAR source), events (`/v1/news/events?week=1`), tap → stock page or article sheet (title/source/summary/link; open in in-app browser); "you hold this" from holdings intersection.
6. **Watchlists:** lists + create (`POST /v1/watchlists`), rows with quotes (`/v1/market/quotes` batch; US rows `$` + `◷ EOD`), star toggle, reorder (long-press drag → `POST /:id/reorder`), remove (swipe), "Add a stock" → global search in add-mode (M10 overlay with `onPick` → `POST /:id/items`), empty state per design.
7. **States:** skeleton per section; DataGap rows for degraded sources (e.g. Chartink scan degraded → `DataGapBanner` with last-good time); offline snapshot.

## Non-goals
Screener v2 filters/AI input (M21), IPO/circulars/indices detail pages (later — link out to web if requested), news article full text.

## Acceptance
- Every list row navigates somewhere (no dead ends — navigation test over fixtures).
- Movers/sector numbers equal the web discover pages for the same QA snapshot (contract tests on the API responses, not on client math).
- Running a gated scan as FREE shows the gate and never calls `/run` (test); a Chartink-degraded fixture renders the banner.
- Watchlist create/add/reorder/remove round-trip through the API and survive reload.
- Screenshots (5 tabs + sector page; light/dark); `verify:push`; `/code-review`.
